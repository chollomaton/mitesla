/**
 * Mi Tesla — backend mínimo (Cloudflare Worker)
 * ------------------------------------------------
 * Gestiona el intercambio OAuth con Tesla y sirve como proxy de solo
 * lectura hacia la Fleet API. El client_secret vive únicamente aquí
 * (variable de entorno), nunca en el frontend público.
 *
 * Variables de entorno necesarias (Cloudflare > Worker > Settings > Variables):
 *   TESLA_CLIENT_ID      El Client ID de tu app registrada en developer.tesla.com
 *   TESLA_CLIENT_SECRET  El Client Secret de esa misma app (marcar como "Secret")
 *   TESLA_REDIRECT_URI   Debe coincidir EXACTO con el registrado en Tesla,
 *                        normalmente https://tu-worker-o-dominio/callback
 *   TESLA_DOMAIN         Tu dominio raíz tal cual lo diste de alta en Tesla,
 *                        p.ej. tudominio.com (sin https://)
 *   TESLA_PUBLIC_KEY_PEM El contenido completo del archivo public-key.pem
 *                        (con las líneas -----BEGIN/END EC PUBLIC KEY-----)
 *   ALLOWED_ORIGIN       El origen de tu frontend en GitHub Pages,
 *                        p.ej. https://tuusuario.github.io
 *
 * Almacenamiento de tokens: usa Cloudflare KV (namespace "TESLA_TOKENS")
 * para guardar el refresh_token de forma persistente entre invocaciones.
 * Crea el namespace y enlázalo en wrangler.toml o desde el dashboard.
 *
 * Rutas:
 *   GET  /.well-known/appspecific/com.tesla.3p.public-key.pem
 *                             Sirve tu clave pública (Tesla la lee de aquí).
 *   GET  /setup               Registra tu dominio ante Tesla. Visítala UNA
 *                             sola vez desde el navegador tras desplegar.
 *   GET  /callback?code=...   Recibe el código de Tesla, lo canjea por
 *                             tokens y los guarda en KV.
 *   GET  /vehiculo            Devuelve el estado actual del vehículo
 *                             (usa el refresh_token guardado; lo renueva
 *                             automáticamente si ha caducado).
 */

const TESLA_AUTH_TOKEN_URL = 'https://auth.tesla.com/oauth2/v3/token';
// Región de la Fleet API: usa 'https://fleet-api.prd.eu.vn.cloud.tesla.com'
// para vehículos con cuenta europea (España incluida).
const FLEET_API_BASE = 'https://fleet-api.prd.eu.vn.cloud.tesla.com';

function withCors(resp, env) {
  const headers = new Headers(resp.headers);
  headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN || '*');
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(resp.body, { status: resp.status, headers });
}

async function obtenerTokenDePartner(env) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.TESLA_CLIENT_ID,
    client_secret: env.TESLA_CLIENT_SECRET,
    scope: 'openid vehicle_device_data vehicle_location offline_access',
    audience: FLEET_API_BASE
  });
  const res = await fetch(TESLA_AUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error('Fallo al pedir el token de partner: ' + (await res.text()));
  return (await res.json()).access_token;
}

async function intercambiarCodigoPorTokens(code, env) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: env.TESLA_CLIENT_ID,
    client_secret: env.TESLA_CLIENT_SECRET,
    code,
    redirect_uri: env.TESLA_REDIRECT_URI
  });
  const res = await fetch(TESLA_AUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error('Fallo al canjear el código: ' + (await res.text()));
  return res.json(); // { access_token, refresh_token, expires_in, ... }
}

async function renovarAccessToken(refreshToken, env) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.TESLA_CLIENT_ID,
    refresh_token: refreshToken
  });
  const res = await fetch(TESLA_AUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error('Fallo al renovar el token: ' + (await res.text()));
  return res.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), env);
    }

    // 0a) Clave pública: Tesla y tú mismo podéis comprobarla en cualquier momento aquí.
    if (url.pathname === '/.well-known/appspecific/com.tesla.3p.public-key.pem') {
      return new Response(env.TESLA_PUBLIC_KEY_PEM, {
        headers: { 'Content-Type': 'application/x-pem-file' }
      });
    }

    // 0b) Registro del dominio ante Tesla — visitar UNA vez tras desplegar.
    if (url.pathname === '/setup') {
      try {
        const partnerToken = await obtenerTokenDePartner(env);
        const res = await fetch(FLEET_API_BASE + '/api/1/partner_accounts', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + partnerToken,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ domain: env.TESLA_DOMAIN })
        });
        const texto = await res.text();
        if (!res.ok) {
          return new Response('<h1>Fallo al registrar el dominio ❌</h1><pre>' + texto + '</pre>', {
            status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }
        return new Response(
          '<h1>Dominio registrado ✅</h1><p>Ya puedes volver a Mi Tesla y pulsar "Conectar con Tesla".</p><pre>' + texto + '</pre>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      } catch (e) {
        return new Response('<h1>Error</h1><p>' + e.message + '</p>', {
          status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
    }

    // 1) Callback de OAuth: Tesla redirige aquí tras el login del usuario.
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      if (!code) return withCors(new Response('Falta el parámetro code', { status: 400 }), env);
      try {
        const tokens = await intercambiarCodigoPorTokens(code, env);
        await env.TESLA_TOKENS.put('refresh_token', tokens.refresh_token);
        await env.TESLA_TOKENS.put('access_token', tokens.access_token);
        await env.TESLA_TOKENS.put('access_token_exp', String(Date.now() + tokens.expires_in * 1000));
        return withCors(new Response(
          '<h1>Tesla conectado ✅</h1><p>Ya puedes cerrar esta pestaña y volver a Mi Tesla.</p>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        ), env);
      } catch (e) {
        return withCors(new Response('Error: ' + e.message, { status: 500 }), env);
      }
    }

    // 2) Endpoint de datos: el frontend llama aquí, nunca a Tesla directamente.
    if (url.pathname === '/vehiculo') {
      try {
        let accessToken = await env.TESLA_TOKENS.get('access_token');
        const exp = Number(await env.TESLA_TOKENS.get('access_token_exp') || 0);
        if (!accessToken || Date.now() > exp - 60000) {
          const refreshToken = await env.TESLA_TOKENS.get('refresh_token');
          if (!refreshToken) return withCors(new Response('No hay sesión Tesla. Conecta primero.', { status: 401 }), env);
          const tokens = await renovarAccessToken(refreshToken, env);
          accessToken = tokens.access_token;
          await env.TESLA_TOKENS.put('access_token', accessToken);
          await env.TESLA_TOKENS.put('access_token_exp', String(Date.now() + tokens.expires_in * 1000));
          if (tokens.refresh_token) await env.TESLA_TOKENS.put('refresh_token', tokens.refresh_token);
        }

        // Lista de vehículos de la cuenta (para obtener el vehicle_tag/id).
        const vehiculosRes = await fetch(FLEET_API_BASE + '/api/1/vehicles', {
          headers: { Authorization: 'Bearer ' + accessToken }
        });
        const vehiculosJson = await vehiculosRes.json();
        const vehiculo = vehiculosJson.response && vehiculosJson.response[0];
        if (!vehiculo) return withCors(new Response('Sin vehículos en la cuenta.', { status: 404 }), env);

        const datosRes = await fetch(FLEET_API_BASE + '/api/1/vehicles/' + vehiculo.id + '/vehicle_data', {
          headers: { Authorization: 'Bearer ' + accessToken }
        });
        const datosJson = await datosRes.json();
        return withCors(new Response(JSON.stringify(datosJson), {
          headers: { 'Content-Type': 'application/json' }
        }), env);
      } catch (e) {
        return withCors(new Response('Error: ' + e.message, { status: 500 }), env);
      }
    }

    return withCors(new Response('Mi Tesla backend activo.', { status: 200 }), env);
  }
};
