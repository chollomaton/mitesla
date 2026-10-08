// Arnés de pruebas para worker.js: KV en memoria + fetch de Tesla simulado.
import workerModule from '../worker.js';
import { createHash } from 'node:crypto';
import { crearMockD1 } from './helpers/sqlite_d1.js';

let fallos = 0;
function assert(cond, msg) {
  if (!cond) { console.log('❌ FALLO:', msg); fallos++; }
  else console.log('✅', msg);
}

function kvEnMemoria() {
  const store = new Map();
  const ttls = new Map();
  return {
    async get(k) {
      if (ttls.has(k) && Date.now() > ttls.get(k)) { store.delete(k); ttls.delete(k); }
      return store.has(k) ? store.get(k) : null;
    },
    async put(k, v, opts) {
      store.set(k, v);
      if (opts && opts.expirationTtl) ttls.set(k, Date.now() + opts.expirationTtl * 1000);
    },
    async delete(k) { store.delete(k); ttls.delete(k); },
    _dump() { return Object.fromEntries(store); }
  };
}

function envBase() {
  const DB=crearMockD1();
  const SESSION_TOKEN='s'.repeat(43);
  DB._sql.prepare('INSERT INTO sessions(id,token_hash,created_at,expires_at) VALUES(?,?,?,?)').run('test-session',createHash('sha256').update(SESSION_TOKEN).digest('hex'),Date.now(),Date.now()+86400000);
  return {
    SESSION_TOKEN,
    TESLA_CLIENT_ID: 'cid',
    TESLA_CLIENT_SECRET: 'secret',
    TESLA_REDIRECT_URI: 'https://api.laperestronika.com/callback',
    TESLA_DOMAIN: 'laperestronika.com',
    TESLA_PUBLIC_KEY_PEM: '-----BEGIN EC PUBLIC KEY-----\nABC\n-----END EC PUBLIC KEY-----',
    ALLOWED_ORIGIN: 'https://chollomaton.github.io',
    ADMIN_TOKEN: 'admin-secreto-123',
    TESLA_TOKENS: kvEnMemoria(),
    DB
  };
}

// A11 (FASE A): /oauth/start ya no acepta ?key=ADMIN_TOKEN — el flujo real es
// POST /oauth/start-token (autenticado por cabecera) -> GET /oauth/start?token=<token de un solo uso>.
async function iniciarOauthStart(env) {
  const resToken = await workerModule.fetch(req('/oauth/start-token', { method: 'POST', headers: { Authorization: 'Bearer ' + env.SESSION_TOKEN } }), env);
  const bodyToken = await resToken.json();
  return workerModule.fetch(req('/oauth/start?token=' + bodyToken.token), env);
}

function req(path, opts) {
  opts = opts || {};
  const headers = new Headers(opts.headers || {});
  return new Request('https://api.laperestronika.com' + path, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body
  });
}

async function run() {
  // ---- 1) Config incompleta ----
  {
    const env = envBase(); delete env.ADMIN_TOKEN;
    const res = await workerModule.fetch(req('/estado'), env);
    const body = await res.json();
    assert(res.status === 500 && body.error === 'config_incompleta', 'config incompleta -> 500 config_incompleta');
  }

  // ---- 2) Endpoint privado sin token -> 401 ----
  {
    const env = envBase();
    const res = await workerModule.fetch(req('/estado'), env);
    assert(res.status === 401, '/estado sin token -> 401');
  }

  // ---- 3) Endpoint privado con token correcto -> 200 ----
  {
    const env = envBase();
    const res = await workerModule.fetch(req('/estado', { headers: { Authorization: 'Bearer ' + env.SESSION_TOKEN } }), env);
    assert(res.status === 200, '/estado con token correcto -> 200');
  }

  // ---- 4) CORS: origen permitido refleja Origin; origen no permitido no manda ACAO ----
  {
    const env = envBase();
    const res1 = await workerModule.fetch(req('/estado', { headers: { Authorization: 'Bearer ' + env.SESSION_TOKEN, Origin: 'https://chollomaton.github.io' } }), env);
    assert(res1.headers.get('Access-Control-Allow-Origin') === 'https://chollomaton.github.io', 'CORS refleja origen permitido');
    const res2 = await workerModule.fetch(req('/estado', { headers: { Authorization: 'Bearer ' + env.SESSION_TOKEN, Origin: 'https://malicioso.com' } }), env);
    assert(!res2.headers.get('Access-Control-Allow-Origin'), 'CORS no manda ACAO para origen no permitido (nunca "*")');
  }

  // ---- 5) .well-known sigue público, sin auth ----
  {
    const env = envBase();
    const res = await workerModule.fetch(req('/.well-known/appspecific/com.tesla.3p.public-key.pem'), env);
    assert(res.status === 200, '.well-known accesible sin autenticación');
  }

  // ---- 6) /oauth/start sin token -> 401; con token de un solo uso -> redirect 302 a auth.tesla.com
  //         y guarda state; ese mismo token de un solo uso no sirve una segunda vez (A11) ----
  {
    const env = envBase();
    const resNo = await workerModule.fetch(req('/oauth/start'), env);
    assert(resNo.status === 401, '/oauth/start sin token -> 401');

    const resTokenSinAuth = await workerModule.fetch(req('/oauth/start-token', { method: 'POST' }), env);
    assert(resTokenSinAuth.status === 401, '/oauth/start-token sin ADMIN_TOKEN -> 401 (no emite tokens a cualquiera)');

    const resOk = await iniciarOauthStart(env);
    assert(resOk.status === 302, '/oauth/start con token de un solo uso -> 302');
    const loc = resOk.headers.get('Location') || '';
    assert(loc.indexOf('https://auth.tesla.com/oauth2/v3/authorize') === 0, 'redirige a auth.tesla.com/oauth2/v3/authorize');
    assert(/state=[a-f0-9-]+/.test(loc), 'la URL de Tesla incluye un state');
    const state = decodeURIComponent(loc.match(/state=([^&]+)/)[1]);
    const guardado = await env.TESLA_TOKENS.get('oauth_state:' + state);
    assert(guardado === '1', 'el state generado se guarda en KV');

    const resTokenViejo = await workerModule.fetch(req('/oauth/start-token', { method: 'POST', headers: { Authorization: 'Bearer ' + env.SESSION_TOKEN } }), env);
    const tokenNuevo = (await resTokenViejo.json()).token;
    const resSegundoUso = await workerModule.fetch(req('/oauth/start?token=' + tokenNuevo), env);
    assert(resSegundoUso.status === 302, 'un token de un solo uso recién emitido y sin usar sí funciona');
    const resReuso = await workerModule.fetch(req('/oauth/start?token=' + tokenNuevo), env);
    assert(resReuso.status === 401, 'reutilizar el mismo token de un solo uso una 2ª vez -> 401 (token_ya_usado)');
  }

  // ---- 7) /callback sin state válido -> mensaje de error, no intercambia código ----
  {
    const env = envBase();
    let fetchLlamado = false;
    global.fetch = async () => { fetchLlamado = true; return new Response('{}', { status: 200 }); };
    const res = await workerModule.fetch(req('/callback?code=abc&state=noexiste'), env);
    const txt = await res.text();
    assert(txt.indexOf('no válido') !== -1 || txt.indexOf('caducado') !== -1, '/callback con state inexistente -> mensaje de error');
    assert(!fetchLlamado, '/callback con state inválido NO llama a Tesla para canjear código');
  }

  // ---- 8) /callback con state válido -> canjea código, guarda tokens; reutilizar el mismo state falla ----
  {
    const env = envBase();
    const startRes = await iniciarOauthStart(env);
    const loc = startRes.headers.get('Location');
    const state = decodeURIComponent(loc.match(/state=([^&]+)/)[1]);

    global.fetch = async (url, opts) => {
      if (String(url).indexOf('fleet-auth.prd.vn.cloud.tesla.com') !== -1) {
        const params = new URLSearchParams(opts.body);
        assert(params.get('audience') === 'https://fleet-api.prd.eu.vn.cloud.tesla.com', 'el intercambio de code incluye audience correcto');
        return new Response(JSON.stringify({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 }), { status: 200 });
      }
      throw new Error('URL no esperada en test: ' + url);
    };
    const res1 = await workerModule.fetch(req('/callback?code=abc&state=' + state), env);
    const txt1 = await res1.text();
    assert(txt1.indexOf('conectado ✅') !== -1, 'primer /callback con state válido conecta correctamente');
    assert((await env.TESLA_TOKENS.get('refresh_token')) === 'RT1', 'refresh_token guardado en KV');

    const res2 = await workerModule.fetch(req('/callback?code=abc&state=' + state), env);
    const txt2 = await res2.text();
    assert(txt2.indexOf('no válido') !== -1 || txt2.indexOf('caducado') !== -1, 'reutilizar el mismo state una 2ª vez falla (de un solo uso)');
  }

  // ---- 9) /vehiculo sin conexión -> not_connected 401 ----
  {
    const env = envBase();
    const res = await workerModule.fetch(req('/vehiculo', { headers: { Authorization: 'Bearer ' + env.SESSION_TOKEN } }), env);
    const body = await res.json();
    assert(res.status === 401 && body.error === 'not_connected', '/vehiculo sin conexión -> 401 not_connected (no expone detalle interno)');
  }

  // ---- 10) /vehiculo con un solo vehículo -> autoselecciona y devuelve datos ----
  {
    const env = envBase();
    await env.TESLA_TOKENS.put('refresh_token', 'RT1');
    await env.TESLA_TOKENS.put('access_token', 'AT1');
    await env.TESLA_TOKENS.put('access_token_exp', String(Date.now() + 3600000));
    global.fetch = async (url) => {
      const u = String(url);
      if (u.indexOf('/api/1/vehicles') !== -1 && u.indexOf('vehicle_data') === -1) {
        return new Response(JSON.stringify({ response: [{ vin: 'VIN12345678901234', display_name: 'Mi Model Y' }] }), { status: 200 });
      }
      if (u.indexOf('vehicle_data') !== -1) {
        assert(u.indexOf('VIN12345678901234') !== -1, 'la petición vehicle_data usa el VIN, no un id interno');
        return new Response(JSON.stringify({ response: { vin: 'VIN12345678901234', charge_state: { battery_level: 80 } } }), { status: 200 });
      }
      throw new Error('URL no esperada: ' + u);
    };
    const res = await workerModule.fetch(req('/vehiculo', { headers: { Authorization: 'Bearer ' + env.SESSION_TOKEN } }), env);
    assert(res.status === 200, '/vehiculo con 1 coche -> 200');
    const vinGuardado = await env.TESLA_TOKENS.get('selected_vin');
    assert(vinGuardado === 'VIN12345678901234', 'selected_vin se guarda automáticamente con un solo vehículo');
  }

  // ---- 11) /vehiculo con varios vehículos y ninguno seleccionado -> pide selección ----
  {
    const env = envBase();
    await env.TESLA_TOKENS.put('refresh_token', 'RT1');
    await env.TESLA_TOKENS.put('access_token', 'AT1');
    await env.TESLA_TOKENS.put('access_token_exp', String(Date.now() + 3600000));
    global.fetch = async (url) => {
      const u = String(url);
      if (u.indexOf('/api/1/vehicles') !== -1 && u.indexOf('vehicle_data') === -1) {
        return new Response(JSON.stringify({ response: [{ vin: 'VINAAA', display_name: 'Model Y' }, { vin: 'VINBBB', display_name: 'Model 3' }] }), { status: 200 });
      }
      throw new Error('no debería llamar a vehicle_data sin selección');
    };
    const res = await workerModule.fetch(req('/vehiculo', { headers: { Authorization: 'Bearer ' + env.SESSION_TOKEN } }), env);
    const body = await res.json();
    assert(res.status === 300 && body.error === 'seleccion_requerida' && body.vehiculos.length === 2, 'varios vehículos sin selección -> 300 seleccion_requerida con la lista');
  }

  // ---- 12) Errores de Tesla mapeados, sin filtrar cuerpo interno ----
  {
    const casos = [[401, 'tesla_auth_failed'], [403, 'tesla_scope_missing'], [404, 'not_found'], [429, 'tesla_rate_limited'], [500, 'tesla_unavailable']];
    for (const [status, esperado] of casos) {
      const env = envBase();
      await env.TESLA_TOKENS.put('refresh_token', 'RT1');
      await env.TESLA_TOKENS.put('access_token', 'AT1');
      await env.TESLA_TOKENS.put('access_token_exp', String(Date.now() + 3600000));
      global.fetch = async () => new Response('SECRETO_INTERNO_DE_TESLA_QUE_NO_DEBE_VERSE', { status });
      const res = await workerModule.fetch(req('/vehiculos', { headers: { Authorization: 'Bearer ' + env.SESSION_TOKEN } }), env);
      const txt = await res.text();
      assert(txt.indexOf('SECRETO_INTERNO_DE_TESLA_QUE_NO_DEBE_VERSE') === -1, 'error ' + status + ': no filtra el cuerpo real de Tesla');
      const body = JSON.parse(txt);
      assert(body.error === esperado, 'error ' + status + ' -> código ' + esperado + ' (obtenido: ' + body.error + ')');
    }
  }

  // ---- 13) refresh concurrente: dos llamadas simultáneas solo llaman a Tesla una vez ----
  {
    const env = envBase();
    await env.TESLA_TOKENS.put('refresh_token', 'RT1');
    // sin access_token -> fuerza refresh
    let llamadasRefresh = 0;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.indexOf('fleet-auth') !== -1) {
        llamadasRefresh++;
        await new Promise((r) => setTimeout(r, 50));
        return new Response(JSON.stringify({ access_token: 'AT-nuevo', refresh_token: 'RT-nuevo', expires_in: 3600 }), { status: 200 });
      }
      if (u.indexOf('/api/1/vehicles') !== -1 && u.indexOf('vehicle_data') === -1) {
        return new Response(JSON.stringify({ response: [{ vin: 'VIN1', display_name: 'X' }] }), { status: 200 });
      }
      if (u.indexOf('vehicle_data') !== -1) {
        return new Response(JSON.stringify({ response: {} }), { status: 200 });
      }
      throw new Error('inesperado ' + u);
    };
    await Promise.all([
      workerModule.fetch(req('/vehiculo', { headers: { Authorization: 'Bearer ' + env.SESSION_TOKEN } }), env),
      workerModule.fetch(req('/vehiculo', { headers: { Authorization: 'Bearer ' + env.SESSION_TOKEN } }), env)
    ]);
    assert(llamadasRefresh === 1, 'dos peticiones simultáneas sin token válido -> un único refresh contra Tesla (lock funciona), fue: ' + llamadasRefresh);
  }

  // ---- 14) /desconectar borra todo ----
  {
    const env = envBase();
    await env.TESLA_TOKENS.put('refresh_token', 'RT1');
    await env.TESLA_TOKENS.put('access_token', 'AT1');
    const res = await workerModule.fetch(req('/desconectar', { method: 'POST', headers: { Authorization: 'Bearer ' + env.SESSION_TOKEN } }), env);
    assert(res.status === 200, '/desconectar -> 200');
    assert(!(await env.TESLA_TOKENS.get('refresh_token')), '/desconectar borra refresh_token');
  }

  // ---- 15) /setup protegido, POST, no repetible sin force ----
  {
    const env = envBase();
    const resGet = await workerModule.fetch(req('/setup', { headers: { Authorization: 'Bearer admin-secreto-123' } }), env);
    assert(resGet.status === 405, '/setup por GET -> 405 (solo POST)');

    global.fetch = async (url) => {
      const u = String(url);
      if (u.indexOf('fleet-auth') !== -1) return new Response(JSON.stringify({ access_token: 'PT' }), { status: 200 });
      if (u.indexOf('partner_accounts') !== -1) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      throw new Error('inesperado ' + u);
    };
    const res1 = await workerModule.fetch(req('/setup', { method: 'POST', headers: { Authorization: 'Bearer admin-secreto-123' } }), env);
    assert(res1.status === 200, '/setup por POST autenticado -> 200');
    const res2 = await workerModule.fetch(req('/setup', { method: 'POST', headers: { Authorization: 'Bearer admin-secreto-123' } }), env);
    assert(res2.status === 409, '/setup repetido sin ?force=1 -> 409');
    const res3 = await workerModule.fetch(req('/setup?force=1', { method: 'POST', headers: { Authorization: 'Bearer admin-secreto-123' } }), env);
    assert(res3.status === 200, '/setup con ?force=1 sí se repite');
  }

  console.log('\n' + (fallos === 0 ? '✅ TODO OK' : '❌ ' + fallos + ' fallo(s)'));
  process.exit(fallos === 0 ? 0 : 1);
}

run().catch((e) => { console.error('EXCEPCIÓN EN TESTS:', e); process.exit(1); });
