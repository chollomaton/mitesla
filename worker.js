/**
 * Mi Tesla — backend (Cloudflare Worker) — v2, revisión de seguridad
 * ------------------------------------------------------------------
 * Gestiona el intercambio OAuth con Tesla (Fleet API) y sirve como proxy
 * de solo lectura. El client_secret y la clave de administración viven
 * únicamente aquí (variables de entorno), nunca en el frontend público.
 *
 * VARIABLES DE ENTORNO NECESARIAS (Cloudflare > Worker > Settings > Variables):
 *   TESLA_CLIENT_ID       Client ID de la app registrada en developer.tesla.com
 *   TESLA_CLIENT_SECRET   Client Secret de esa misma app (marcar como "Secret")
 *   TESLA_REDIRECT_URI    Debe coincidir EXACTO con el registrado en Tesla,
 *                         normalmente https://tu-worker-o-dominio/callback
 *   TESLA_DOMAIN          Tu dominio raíz tal cual lo diste de alta en Tesla,
 *                         p.ej. tudominio.com (sin https://)
 *   TESLA_PUBLIC_KEY_PEM  Contenido completo del archivo public-key.pem
 *   ALLOWED_ORIGIN        Origen(es) permitidos de tu frontend, separados por
 *                         coma si hay más de uno. P.ej.:
 *                         https://tuusuario.github.io
 *   ADMIN_TOKEN           Clave secreta que tú inventas (larga y aleatoria,
 *                         p.ej. generada con `openssl rand -hex 32`). Protege
 *                         todos los endpoints privados. Se pega también en
 *                         Ajustes > Conexión con Tesla, en el propio frontend,
 *                         y se guarda solo en ese dispositivo (igual que el
 *                         token de GitHub). Márcala como "Secret" en Cloudflare.
 *
 * KV NECESARIO: namespace enlazado como TESLA_TOKENS. Ahí se guardan:
 *   refresh_token, access_token, access_token_exp,
 *   oauth_state:<state> (temporal, con TTL, para validar /callback),
 *   selected_vin, setup_completed, refresh_lock (temporal).
 *
 * RUTAS:
 *   GET  /.well-known/appspecific/com.tesla.3p.public-key.pem   (pública)
 *   POST /setup                     Registra el dominio ante Tesla (protegida,
 *                                   solo una vez salvo ?force=1)
 *   POST /oauth/start-token         Emite un token de un solo uso (120s) para poder navegar a
 *                                   /oauth/start sin exponer ADMIN_TOKEN en la URL (protegida
 *                                   por cabecera Authorization) — A11 (FASE A)
 *   GET  /oauth/start?token=...     Inicia el flujo OAuth (protegida por el token de un solo uso
 *                                   emitido por /oauth/start-token, nunca por ADMIN_TOKEN directo)
 *   GET  /callback?code=&state=     Recibe la vuelta de Tesla, valida state,
 *                                   canjea el código y guarda tokens (pública,
 *                                   la protección real es el state de un solo uso)
 *   GET  /estado                    Estado de conexión actual (protegida)
 *   GET  /vehiculos                 Lista de vehículos de la cuenta (protegida)
 *   POST /seleccionar-vehiculo      Fija el VIN activo (protegida)
 *   GET  /vehiculo                  Datos del vehículo seleccionado (protegida)
 *   POST /desconectar               Borra los tokens guardados (protegida)
 */

const TESLA_AUTHORIZE_URL = 'https://auth.tesla.com/oauth2/v3/authorize';
// El intercambio de tokens (code/refresh/partner) va contra el dominio de
// autenticación de la Fleet API, NO contra auth.tesla.com.
const TESLA_FLEET_AUTH_TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
// Región de la Fleet API: cuentas europeas (España incluida).
const FLEET_API_BASE = 'https://fleet-api.prd.eu.vn.cloud.tesla.com';
// A17 (FASE A, auditoría externa 2026-09-20): mínimo privilegio. El Worker solo llama a
// GET /api/1/vehicles y GET /api/1/vehicles/{vin}/vehicle_data (lectura), más el registro de
// configuración de Fleet Telemetry (misma familia de permiso que vehicle_device_data) — nunca
// envía comandos al vehículo ni lee el perfil de usuario. Se retiraron 'user_data' (no se llama a
// /api/1/users/me en ningún sitio de este archivo) y 'vehicle_charging_cmds' (no existe ningún
// endpoint de comandos de carga) — si en el futuro se añade un comando real, el scope
// correspondiente se añade entonces, nunca por adelantado "por si acaso".
const OAUTH_SCOPE = 'openid offline_access vehicle_device_data vehicle_location';
// A dónde volver tras el callback de Tesla (la PWA, pestaña de Ajustes).
const FRONTEND_RETURN_URL = 'https://chollomaton.github.io/mitesla/#ajustes';
const TIMEOUT_MS = 10000;
const STATE_TTL_S = 600; // 10 minutos para completar el login en Tesla
const REFRESH_LOCK_TTL_S = 15;

/* ---------- Utilidades básicas ---------- */

function nuevoId() {
  return crypto.randomUUID();
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

/* ---------- Fase 4: ingesta de telemetría desde mitesla-telemetry-bridge ---------- */
/** Verifica la firma HMAC-SHA256 del bridge (VM) sobre "timestamp.nonce.cuerpo", con protección
 *  antirreplay (ventana de 2 min + nonce de un solo uso guardado en el KV ya existente). El
 *  secreto (TELEMETRY_BRIDGE_SECRET) vive SOLO en la VM y en este Worker — nunca en el frontend. */
/**
 * A13 (FASE A, auditoría externa 2026-09-20): el antirreplay original comprobaba el nonce con un
 * GET seguido de un PUT sobre KV — dos operaciones separadas, sin atomicidad garantizada entre
 * isolates/regiones concurrentes de Cloudflare (KV es de consistencia eventual). Dos peticiones
 * con el MISMO nonce llegadas casi a la vez podían pasar las dos el GET antes de que cualquiera
 * hiciera el PUT. Ahora el nonce se inserta en D1 (SQLite transaccional) sobre una PRIMARY KEY sin
 * "OR IGNORE": si el nonce ya existe, D1 lanza un error de restricción de forma atómica y la
 * petición se rechaza — no hay ventana de carrera posible. Si D1 no está disponible se rechaza
 * (nunca se degrada silenciosamente a "sin protección antirreplay").
 */
async function verificarFirmaBridge(request, env, cuerpoTexto) {
  const firma = request.headers.get('X-Signature') || '';
  const timestamp = request.headers.get('X-Timestamp') || '';
  const nonce = request.headers.get('X-Nonce') || '';
  if (!firma || !timestamp || !nonce) return { ok: false, motivo: 'faltan_cabeceras' };
  if (nonce.length > 200) return { ok: false, motivo: 'nonce_invalido' };
  const tsNum = parseInt(timestamp, 10);
  const ahoraS = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(tsNum) || Math.abs(ahoraS - tsNum) > 120) return { ok: false, motivo: 'timestamp_fuera_de_ventana' };
  if (!env.TELEMETRY_BRIDGE_SECRET) return { ok: false, motivo: 'secreto_no_configurado' };
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.TELEMETRY_BRIDGE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const firmaBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(timestamp + '.' + nonce + '.' + cuerpoTexto));
  const firmaCalculada = Array.from(new Uint8Array(firmaBuf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  if (!timingSafeEqual(firma, firmaCalculada)) return { ok: false, motivo: 'firma_invalida' };
  if (!env.DB) return { ok: false, motivo: 'd1_no_disponible_para_antireplay' };
  try {
    await env.DB.prepare('INSERT INTO telemetry_nonces (nonce, creado_en) VALUES (?, ?)')
      .bind(nonce, new Date().toISOString()).run();
  } catch (e) {
    // La única razón esperada de fallo aquí es la restricción UNIQUE de la PRIMARY KEY → nonce repetido.
    return { ok: false, motivo: 'nonce_repetido' };
  }
  return { ok: true };
}

/**
 * A14 (FASE A): el VIN de telemetría debe pertenecer a un vehículo dado de alta explícitamente
 * (vehicle_vin_allowlist), nunca aceptarse "porque tiene 17 caracteres". La allowlist se rellena a
 * mano (o desde /seleccionar-vehiculo, ver más abajo) — nunca automáticamente a partir de un
 * payload de /internal/telemetry entrante, para que un VIN ajeno no pueda auto-registrarse.
 */
function vinFormatoValido(vin) {
  return typeof vin === 'string' && /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin);
}
async function vinAutorizado(env, vin) {
  if (!vinFormatoValido(vin)) return false;
  if (!env.DB) return false;
  const fila = await env.DB.prepare('SELECT activo FROM vehicle_vin_allowlist WHERE vin = ?').bind(vin).first();
  return Boolean(fila && fila.activo);
}
async function autorizarVinEnAllowlist(env, vin) {
  if (!vinFormatoValido(vin) || !env.DB) return;
  await env.DB.prepare(
    'INSERT INTO vehicle_vin_allowlist (vin, activo, creado_en) VALUES (?,1,?) ON CONFLICT(vin) DO UPDATE SET activo=1'
  ).bind(vin, new Date().toISOString()).run();
}
async function asegurarVehiculoD1(env, vin) {
  const ahoraIso = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO vehicles (vin, creado_en, actualizado_en) VALUES (?, ?, ?) ON CONFLICT(vin) DO UPDATE SET actualizado_en=excluded.actualizado_en'
  ).bind(vin, ahoraIso, ahoraIso).run();
}

const MODOS_AUTOMATIZACION_VALIDOS = new Set(['off', 'shadow', 'active']);

/** A10: por defecto 'off' — un vehículo recién dado de alta NUNCA empieza creando viajes/cargas
 *  reales solo. Hay que pasarlo a mano por shadow y validarlo (Modo Sombra, infra/README.md §9)
 *  antes de pasar a 'active'. */
async function obtenerAutomationMode(env, vin) {
  if (!env.DB) return 'off';
  const fila = await env.DB.prepare('SELECT automation_mode FROM vehicle_settings WHERE vin = ?').bind(vin).first();
  return (fila && MODOS_AUTOMATIZACION_VALIDOS.has(fila.automation_mode)) ? fila.automation_mode : 'off';
}
async function fijarAutomationMode(env, vin, modo) {
  if (!MODOS_AUTOMATIZACION_VALIDOS.has(modo)) throw new Error('modo_invalido');
  const ahoraIso = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO vehicle_settings (vin, automation_mode, updated_at) VALUES (?,?,?) ' +
    'ON CONFLICT(vin) DO UPDATE SET automation_mode=excluded.automation_mode, updated_at=excluded.updated_at'
  ).bind(vin, modo, ahoraIso).run();
}

/**
 * A9 (FASE A, auditoría externa 2026-09-20): health check real. El bug original es que un
 * snapshot reenviado sin cambios (o cualquier POST a /internal/telemetry, aunque no trajera
 * datos nuevos de verdad) podía aparentar actividad indefinidamente porque solo se miraba
 * "¿cuándo llegó la última petición?". Ahora se registran POR SEPARADO cinco señales distintas,
 * cada una solo cuando de verdad ocurre lo que dice: el bridge sigue vivo, ha llegado CUALQUIER
 * mensaje MQTT, ha llegado un valor de campo válido de Tesla, y el estado de connectivity.
 */
async function actualizarHeartbeat(env, vin, señales) {
  if (!env.DB) return;
  const ahoraIso = new Date().toISOString();
  const actuales = await env.DB.prepare('SELECT * FROM bridge_heartbeats WHERE vin = ?').bind(vin).first();
  const siguiente = {
    last_bridge_heartbeat_at: señales.bridgeVivo ? ahoraIso : (actuales && actuales.last_bridge_heartbeat_at) || null,
    last_mqtt_message_at: señales.mqttMensaje ? ahoraIso : (actuales && actuales.last_mqtt_message_at) || null,
    last_tesla_message_at: señales.teslaMetricaValida ? ahoraIso : (actuales && actuales.last_tesla_message_at) || null,
    last_connectivity_at: señales.connectivity ? ahoraIso : (actuales && actuales.last_connectivity_at) || null,
    connectivity_status: (señales.connectivity && señales.connectivityStatus) || (actuales && actuales.connectivity_status) || null
  };
  await env.DB.prepare(
    'INSERT INTO bridge_heartbeats (vin, last_bridge_heartbeat_at, last_mqtt_message_at, last_tesla_message_at, last_vehicle_metric_at, last_connectivity_at, connectivity_status, updated_at) ' +
    'VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(vin) DO UPDATE SET ' +
    'last_bridge_heartbeat_at=excluded.last_bridge_heartbeat_at, last_mqtt_message_at=excluded.last_mqtt_message_at, ' +
    'last_tesla_message_at=excluded.last_tesla_message_at, last_vehicle_metric_at=excluded.last_vehicle_metric_at, ' +
    'last_connectivity_at=excluded.last_connectivity_at, connectivity_status=excluded.connectivity_status, updated_at=excluded.updated_at'
  ).bind(
    vin, siguiente.last_bridge_heartbeat_at, siguiente.last_mqtt_message_at, siguiente.last_tesla_message_at,
    siguiente.last_tesla_message_at, siguiente.last_connectivity_at, siguiente.connectivity_status, ahoraIso
  ).run();
}

/**
 * A15 (FASE A): validación exhaustiva del cuerpo de /internal/telemetry ANTES de tocar D1. Nunca
 * se confía en que el bridge (aunque sea "nuestro") mande siempre datos bien formados — un bug ahí,
 * un firmware raro de Tesla, o un payload corrupto no deben poder colar NaN/Infinity/strings
 * gigantes en la base de datos. Devuelve {ok:true} o {ok:false, motivo, detalle}.
 */
function validarPayloadTelemetria(cuerpo) {
  if (!cuerpo || typeof cuerpo !== 'object') return { ok: false, motivo: 'cuerpo_no_es_objeto' };
  if (typeof cuerpo.vin !== 'string' || !vinFormatoValido(cuerpo.vin)) return { ok: false, motivo: 'vin_invalido' };
  if (cuerpo.events !== undefined && !Array.isArray(cuerpo.events)) return { ok: false, motivo: 'events_no_es_array' };
  const eventos = cuerpo.events || [];
  if (eventos.length > 500) return { ok: false, motivo: 'demasiados_eventos' };
  const numeroFinitoOk = (v) => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v));
  for (let i = 0; i < eventos.length; i++) {
    const ev = eventos[i];
    if (!ev || typeof ev !== 'object') return { ok: false, motivo: 'evento_invalido', detalle: { indice: i } };
    if (typeof ev.id !== 'string' || ev.id.length === 0 || ev.id.length > 128) return { ok: false, motivo: 'evento_id_invalido', detalle: { indice: i } };
    if (typeof ev.tipo !== 'string' || ev.tipo.length > 64) return { ok: false, motivo: 'evento_tipo_invalido', detalle: { indice: i } };
    if (typeof ev.observado_en !== 'string' || Number.isNaN(new Date(ev.observado_en).getTime())) {
      return { ok: false, motivo: 'evento_timestamp_invalido', detalle: { indice: i } };
    }
    const p = (ev.payload && typeof ev.payload === 'object') ? ev.payload : {};
    if (JSON.stringify(p).length > 8192) return { ok: false, motivo: 'evento_payload_demasiado_grande', detalle: { indice: i } };
    if (!numeroFinitoOk(p.lat) || (typeof p.lat === 'number' && Math.abs(p.lat) > 90)) return { ok: false, motivo: 'lat_invalida', detalle: { indice: i } };
    if (!numeroFinitoOk(p.lng) || (typeof p.lng === 'number' && Math.abs(p.lng) > 180)) return { ok: false, motivo: 'lng_invalida', detalle: { indice: i } };
    if (!numeroFinitoOk(p.soc_pct) || (typeof p.soc_pct === 'number' && (p.soc_pct < 0 || p.soc_pct > 100))) return { ok: false, motivo: 'soc_invalido', detalle: { indice: i } };
    if (!numeroFinitoOk(p.odometro_km) || (typeof p.odometro_km === 'number' && p.odometro_km < 0)) return { ok: false, motivo: 'odometro_invalido', detalle: { indice: i } };
    for (const campo of ['ac_energy_kwh', 'dc_energy_kwh', 'ac_power_kw', 'dc_power_kw']) {
      if (!numeroFinitoOk(p[campo])) return { ok: false, motivo: campo + '_invalido', detalle: { indice: i } };
    }
  }
  if (cuerpo.snapshot !== undefined && cuerpo.snapshot !== null) {
    if (typeof cuerpo.snapshot !== 'object') return { ok: false, motivo: 'snapshot_no_es_objeto' };
    const s = cuerpo.snapshot;
    if (!numeroFinitoOk(s.lat) || (typeof s.lat === 'number' && Math.abs(s.lat) > 90)) return { ok: false, motivo: 'snapshot_lat_invalida' };
    if (!numeroFinitoOk(s.lng) || (typeof s.lng === 'number' && Math.abs(s.lng) > 180)) return { ok: false, motivo: 'snapshot_lng_invalida' };
    if (!numeroFinitoOk(s.soc_pct) || (typeof s.soc_pct === 'number' && (s.soc_pct < 0 || s.soc_pct > 100))) return { ok: false, motivo: 'snapshot_soc_invalido' };
    if (!numeroFinitoOk(s.odometro_km) || (typeof s.odometro_km === 'number' && s.odometro_km < 0)) return { ok: false, motivo: 'snapshot_odometro_invalido' };
    if (typeof s.ubicacion_nombre === 'string' && s.ubicacion_nombre.length > 256) return { ok: false, motivo: 'snapshot_ubicacion_nombre_demasiado_larga' };
  }
  if (cuerpo.heartbeat !== undefined && cuerpo.heartbeat !== null && typeof cuerpo.heartbeat !== 'object') {
    return { ok: false, motivo: 'heartbeat_no_es_objeto' };
  }
  if (cuerpo.senales_recibidas !== undefined && !numeroFinitoOk(cuerpo.senales_recibidas)) {
    return { ok: false, motivo: 'senales_recibidas_invalido' };
  }
  return { ok: true };
}

/** A15: guarda (recortado) un cuerpo rechazado para poder inspeccionarlo — nunca desaparece en
 *  silencio. Nunca lanza: un fallo guardando en cuarentena no debe tirar el rechazo ya decidido. */
async function ponerEnCuarentena(env, vin, motivo, cuerpoTexto) {
  if (!env.DB) return;
  try {
    await env.DB.prepare('INSERT INTO quarantined_events (id, vin, motivo, payload_recortado, recibido_en) VALUES (?,?,?,?,?)')
      .bind(nuevoId(), vin || null, motivo, String(cuerpoTexto).slice(0, 2000), new Date().toISOString()).run();
  } catch (e) { /* la cuarentena es diagnóstico best-effort, nunca debe ocultar el motivo original del rechazo */ }
}
/** Contadores mensuales para el diagnóstico de consumo Tesla (sección 63) — se reinician solos
 *  al cambiar de mes (mes_referencia), sin necesidad de un cron aparte. */
async function incrementarContadorSyncState(env, vin, columna, incremento) {
  const mesActual = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  const ahoraIso = new Date().toISOString();
  const fila = await env.DB.prepare('SELECT mes_referencia FROM sync_state WHERE vin = ?').bind(vin).first();
  if (!fila) {
    const inicial = { eventos_recibidos_mes: 0, vehicle_data_calls_mes: 0, wakes_mes: 0, errores_mes: 0 };
    inicial[columna] = incremento;
    await env.DB.prepare(
      'INSERT INTO sync_state (vin, telemetria_activa, eventos_recibidos_mes, vehicle_data_calls_mes, wakes_mes, errores_mes, mes_referencia, actualizado_en, ultimo_evento_en) VALUES (?,1,?,?,?,?,?,?,?)'
    ).bind(vin, inicial.eventos_recibidos_mes, inicial.vehicle_data_calls_mes, inicial.wakes_mes, inicial.errores_mes, mesActual, ahoraIso, ahoraIso).run();
    return;
  }
  const reiniciar = fila.mes_referencia !== mesActual;
  await env.DB.prepare(
    'UPDATE sync_state SET ' + columna + ' = CASE WHEN mes_referencia = ? THEN ' + columna + ' + ? ELSE ? END, ' +
    'mes_referencia = ?, telemetria_activa = 1, ultimo_evento_en = ?, actualizado_en = ? WHERE vin = ?'
  ).bind(mesActual, incremento, incremento, mesActual, ahoraIso, ahoraIso, vin).run();
}

/**
 * A25 (FASE A, auditoría externa 2026-09-20): antes se contaban trip_started/trip_finished (que
 * no tienen NINGÚN coste real en la Fleet API, son puramente cómputo local del bridge) como si
 * fueran "señales Tesla" facturables, mezclando dos conceptos muy distintos en el mismo contador
 * (sync_state.eventos_recibidos_mes). Esta tabla nueva (usage_counters) separa explícitamente lo
 * que SÍ cuesta dinero (telemetry_signals_received, vehicle_data_calls, wakes, commands) de lo que
 * es gratis (derived_events) — igual que sync_state, se reinicia sola al cambiar de mes.
 */
async function actualizarUsageCounters(env, vin, incrementos) {
  if (!env.DB) return;
  const mesActual = new Date().toISOString().slice(0, 7);
  const ahoraIso = new Date().toISOString();
  const columnas = ['telemetry_signals_received', 'derived_events', 'vehicle_data_calls', 'wakes', 'commands', 'errores_mes'];
  const fila = await env.DB.prepare('SELECT mes_referencia FROM usage_counters WHERE vin = ?').bind(vin).first();
  if (!fila) {
    const valores = columnas.map((c) => incrementos[c] || 0);
    await env.DB.prepare(
      'INSERT INTO usage_counters (vin, ' + columnas.join(', ') + ', mes_referencia, actualizado_en) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(vin, ...valores, mesActual, ahoraIso).run();
    return;
  }
  const mismoMes = fila.mes_referencia === mesActual;
  const sets = columnas.map((c) => {
    const inc = incrementos[c] || 0;
    return mismoMes ? (c + ' = ' + c + ' + ' + inc) : (c + ' = ' + inc);
  });
  await env.DB.prepare(
    'UPDATE usage_counters SET ' + sets.join(', ') + ', mes_referencia = ?, actualizado_en = ? WHERE vin = ?'
  ).bind(mesActual, ahoraIso, vin).run();
}

/* ---------- Fase 4B: motor de viajes 100% automáticos (puro, sin D1 — fácil de probar) ---------- */

/** Distancia entre dos coordenadas en metros (fórmula de Haversine). Copia deliberada de la misma
 *  fórmula que ya usa app.js en cliente (`distanciaMetros`, Fase 3 Bloque 4): mismo resultado,
 *  pero el Worker no puede importar código de app.js (entornos distintos), así que se repite aquí
 *  a propósito en vez de intentar compartir un módulo entre navegador y Worker. */
function distanciaMetros(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => typeof v !== 'number' || Number.isNaN(v))) return null;
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Encuentra el geofence (tabla locations) más cercano que contiene el punto dado, o null si el
 *  punto no cae dentro del radio de ninguno — nunca "adivina" un lugar aproximado. */
function emparejarUbicacion(lat, lng, ubicaciones) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  let mejor = null;
  let mejorDistancia = Infinity;
  for (const u of ubicaciones || []) {
    const d = distanciaMetros(lat, lng, u.lat, u.lng);
    if (d !== null && d <= (u.radius_m || 150) && d < mejorDistancia) {
      mejor = u;
      mejorDistancia = d;
    }
  }
  return mejor;
}

/** De una lista de snapshots {valor, observado_en} (ya ordenada o no), busca el más cercano en el
 *  tiempo a `objetivoIso` dentro de una ventana de `ventanaMs` — nunca devuelve un dato de hace
 *  horas como si fuera "el de ese instante". Sin coincidencia dentro de la ventana => null. */
function snapshotMasCercano(lista, objetivoIso, ventanaMs) {
  const objetivoMs = new Date(objetivoIso).getTime();
  let mejor = null;
  let mejorDiferencia = Infinity;
  for (const s of lista || []) {
    const diff = Math.abs(new Date(s.observado_en).getTime() - objetivoMs);
    if (diff <= ventanaMs && diff < mejorDiferencia) {
      mejor = s;
      mejorDiferencia = diff;
    }
  }
  return mejor;
}

/**
 * Empareja una lista CRONOLÓGICA de eventos trip_started/trip_finished en viajes. Defensivo ante
 * datos reales imperfectos (sección 8-9 de la Fase 4): dos "started" seguidos sin un "finished" de
 * por medio -> se descarta el primero (el segundo es el de verdad, el primero fue una falsa
 * apertura); un "finished" sin un "started" abierto antes -> se ignora (no se puede cerrar lo que
 * no se sabe que empezó). El último "started" sin "finished" queda como viaje abierto (no se
 * devuelve todavía; el llamador lo deja sin procesar para la siguiente pasada).
 */
function emparejarEventosEnViajes(eventos) {
  const pares = [];
  let abierto = null;
  for (const ev of eventos) {
    if (ev.tipo === 'trip_started') {
      abierto = ev; // sustituye cualquier apertura previa sin cerrar — nunca dos viajes abiertos a la vez
    } else if (ev.tipo === 'trip_finished') {
      if (abierto) {
        pares.push({ inicio: abierto, fin: ev });
        abierto = null;
      }
      // "finished" sin apertura conocida: se ignora, no es un viaje que este motor pueda reconstruir.
    }
  }
  return { pares, abiertoSinCerrar: abierto };
}

/**
 * Construye la fila de `trips` a partir de un par inicio/fin ya emparejado. Nunca inventa un dato
 * que no tiene: si no hay lectura de odómetro/batería dentro de la ventana, el campo queda null y
 * `data_quality` baja a 'partial' (nunca 'complete' con huecos silenciados).
 */
function construirViajeDesdeEventos(vin, eventoInicio, eventoFin, contexto) {
  const VENTANA_MS = 10 * 60 * 1000; // 10 min: una lectura más lejana no se considera "de ese instante"
  const odoInicio = snapshotMasCercano(contexto.odometroSnapshots, eventoInicio.observado_en, VENTANA_MS);
  const odoFin = snapshotMasCercano(contexto.odometroSnapshots, eventoFin.observado_en, VENTANA_MS);
  const socInicio = snapshotMasCercano(contexto.bateriaSnapshots, eventoInicio.observado_en, VENTANA_MS);
  const socFin = snapshotMasCercano(contexto.bateriaSnapshots, eventoFin.observado_en, VENTANA_MS);

  // B9: energy_used_kwh — se PREFIERE siempre la medida real (diff de EnergyRemaining al inicio y
  // al final, cuando el bridge la manda: ver B9 en telemetry-bridge/lib/normalizador.js). Solo si
  // esa medida no está disponible se cae a una ESTIMACIÓN por caída de SoC, y solo si se conoce la
  // capacidad nominal real del vehículo (contexto.capacidadNominalKwh) — nunca se asume una
  // capacidad genérica. Sin ninguna de las dos cosas, energy_used_kwh queda en null: "no se sabe"
  // es un resultado legítimo, no un fallo que haya que rellenar con un número inventado.
  const startEnergyRemainingKwh = (socInicio && typeof socInicio.energy_remaining_kwh === 'number') ? socInicio.energy_remaining_kwh : null;
  const endEnergyRemainingKwh = (socFin && typeof socFin.energy_remaining_kwh === 'number') ? socFin.energy_remaining_kwh : null;
  let energyUsedKwh = null, energySource = null, consumptionIsEstimated = 0;
  if (startEnergyRemainingKwh !== null && endEnergyRemainingKwh !== null && endEnergyRemainingKwh <= startEnergyRemainingKwh) {
    energyUsedKwh = Math.round((startEnergyRemainingKwh - endEnergyRemainingKwh) * 1000) / 1000;
    energySource = 'energy_remaining_delta';
    consumptionIsEstimated = 0;
  } else {
    const socInicioValor = socInicio ? socInicio.valor : null;
    const socFinValor = socFin ? socFin.valor : null;
    const capacidad = typeof contexto.capacidadNominalKwh === 'number' ? contexto.capacidadNominalKwh : null;
    if (capacidad !== null && typeof socInicioValor === 'number' && typeof socFinValor === 'number' && socFinValor <= socInicioValor) {
      energyUsedKwh = Math.round(((socInicioValor - socFinValor) / 100 * capacidad) * 1000) / 1000;
      energySource = 'soc_delta_estimado';
      consumptionIsEstimated = 1;
    }
  }

  const payloadInicio = eventoInicio.payload || {};
  const payloadFin = eventoFin.payload || {};
  const startLat = typeof payloadInicio.lat === 'number' ? payloadInicio.lat : null;
  const startLng = typeof payloadInicio.lng === 'number' ? payloadInicio.lng : null;
  const endLat = typeof payloadFin.lat === 'number' ? payloadFin.lat : null;
  const endLng = typeof payloadFin.lng === 'number' ? payloadFin.lng : null;

  const startLocation = emparejarUbicacion(startLat, startLng, contexto.ubicaciones);
  const endLocation = emparejarUbicacion(endLat, endLng, contexto.ubicaciones);

  const startOdometroKm = odoInicio ? odoInicio.valor : (typeof payloadInicio.odometro_km === 'number' ? payloadInicio.odometro_km : null);
  const endOdometroKm = odoFin ? odoFin.valor : (typeof payloadFin.odometro_km === 'number' ? payloadFin.odometro_km : null);
  let distanciaKm = null;
  if (typeof startOdometroKm === 'number' && typeof endOdometroKm === 'number' && endOdometroKm >= startOdometroKm) {
    distanciaKm = Math.round((endOdometroKm - startOdometroKm) * 100) / 100;
  }

  const duracionMin = Math.round((new Date(eventoFin.observado_en).getTime() - new Date(eventoInicio.observado_en).getTime()) / 60000);

  const datosCompletos = startOdometroKm !== null && endOdometroKm !== null && distanciaKm !== null
    && startLocation !== null && endLocation !== null;

  const ahoraIso = contexto.ahoraIso || new Date().toISOString();
  const trip = {
    id: idDeterministico(vin, 'trip', eventoInicio.id + ':' + eventoFin.id),
    vin,
    started_at: eventoInicio.observado_en,
    ended_at: eventoFin.observado_en,
    start_odometer_km: startOdometroKm,
    end_odometer_km: endOdometroKm,
    distance_km: distanciaKm,
    duration_min: duracionMin,
    start_soc_pct: socInicio ? socInicio.valor : null,
    end_soc_pct: socFin ? socFin.valor : null,
    start_energy_remaining_kwh: startEnergyRemainingKwh,
    end_energy_remaining_kwh: endEnergyRemainingKwh,
    energy_used_kwh: energyUsedKwh,
    energy_source: energySource,
    consumption_is_estimated: consumptionIsEstimated,
    start_lat: startLat, start_lng: startLng, end_lat: endLat, end_lng: endLng,
    start_location_id: startLocation ? startLocation.id : null,
    end_location_id: endLocation ? endLocation.id : null,
    classification: null,
    classification_source: null,
    classification_rule_id: null,
    data_quality: datosCompletos ? 'complete' : 'partial',
    source: 'TESLA_TELEMETRY',
    // A10 — Shadow Mode real: un viaje detectado en modo 'shadow' se guarda igualmente (nunca se
    // descarta el dato), pero marcado is_shadow=1 para que nunca alimente Economía/Stats/pendientes
    // reales hasta que el usuario pase el vehículo a modo 'active' tras validar el Modo Sombra.
    is_shadow: contexto.esSombra ? 1 : 0,
    created_at: ahoraIso,
    updated_at: ahoraIso
  };

  // A10: en Shadow Mode no se generan "pendientes productivos" (el usuario no debe tener que
  // decidir nada todavía) — el viaje se guarda igual, sin clasificar, para poder compararlo luego.
  if (contexto.esSombra) {
    return { trip, pendiente: null, reglaUsada: null };
  }

  const clasificacion = clasificarViajeConReglas(trip, contexto.reglas || []);
  let pendiente = null;
  if (clasificacion.tipo === 'aplicada') {
    trip.classification = clasificacion.classification;
    trip.classification_source = 'rule';
    trip.classification_rule_id = clasificacion.regla.id;
  } else {
    // Sin regla aplicable (ninguna coincide, o coinciden varias con resultados distintos): nunca
    // se impone una clasificación a ciegas — se deja como pendiente para que el usuario decida.
    pendiente = {
      id: idDeterministico(vin, 'pendiente_clasificar_viaje', trip.id),
      vin,
      tipo: 'clasificar_viaje',
      referencia_tabla: 'trips',
      referencia_id: trip.id,
      detalle: JSON.stringify({
        motivo: clasificacion.tipo, // 'sin_reglas' | 'ambiguo'
        start_location_id: trip.start_location_id,
        end_location_id: trip.end_location_id,
        distance_km: trip.distance_km,
        started_at: trip.started_at
      }),
      created_at: ahoraIso
    };
  }

  return { trip, pendiente, reglaUsada: clasificacion.tipo === 'aplicada' ? clasificacion.regla : null };
}

/** Id determinista y corto (sha256 recortado) para cualquier fila derivada — mismo material de
 *  entrada => mismo id, así reprocesar eventos ya vistos nunca duplica trips/pendientes (sección 41). */
function idDeterministico(vin, prefijo, material) {
  return prefijo + '_' + vin + '_' + hashCorto(material);
}
function hashCorto(texto) {
  // FNV-1a de 32 bits: suficiente para deduplicar (no es criptográfico, no hace falta serlo aquí),
  // y evita depender de crypto.subtle (async) en una función que debe seguir siendo síncrona y pura.
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Aplica las automation_rules de tipo 'clasificacion_viaje' a un viaje ya construido. Una regla
 * sin origen/destino en su condición actúa como comodín ("aplica siempre"). Si ninguna regla
 * coincide -> 'sin_reglas'. Si coinciden varias con classification distinta -> 'ambiguo' (nunca se
 * elige una al azar). Si coinciden una o varias pero todas con la MISMA classification -> 'aplicada'.
 */
function clasificarViajeConReglas(trip, reglas) {
  const coincidentes = [];
  for (const regla of reglas) {
    if (!regla.activa) continue;
    let condicion;
    try { condicion = JSON.parse(regla.condicion); } catch (e) { continue; }
    const origenOk = !condicion.origen_location_id || condicion.origen_location_id === trip.start_location_id;
    const destinoOk = !condicion.destino_location_id || condicion.destino_location_id === trip.end_location_id;
    if (!origenOk || !destinoOk) continue;
    let accion;
    try { accion = JSON.parse(regla.accion); } catch (e) { continue; }
    if (!accion.classification) continue;
    coincidentes.push({ regla, classification: accion.classification });
  }
  if (coincidentes.length === 0) return { tipo: 'sin_reglas' };
  const clasificacionesDistintas = new Set(coincidentes.map((c) => c.classification));
  if (clasificacionesDistintas.size > 1) return { tipo: 'ambiguo', candidatas: coincidentes };
  return { tipo: 'aplicada', classification: coincidentes[0].classification, regla: coincidentes[0].regla };
}

/**
 * Orquestador D1 del motor de viajes (Fase 4B) — la única función de este bloque que toca la base
 * de datos; todo lo demás arriba es puro y se prueba sin D1. Se llama automáticamente al final de
 * cada ingesta de telemetría, para el VIN que acaba de recibir datos. Devuelve cuántos viajes cerró.
 */
async function procesarViajesPendientes(env, vin, modo) {
  // A10 — 'off' (o sin configurar todavía, por defecto) significa "no crear sesiones": los
  // eventos quedan sin procesar (procesado_en sigue NULL) y se procesarán solos en cuanto el
  // vehículo pase a shadow/active — ningún dato se pierde, simplemente se deja de consolidar.
  if (modo === 'off' || !modo) return 0;
  const esSombra = modo === 'shadow';
  const filas = await env.DB.prepare(
    "SELECT id, tipo, payload, observado_en FROM telemetry_events_short_retention " +
    "WHERE vin = ? AND tipo IN ('trip_started','trip_finished') AND procesado_en IS NULL " +
    'ORDER BY observado_en ASC LIMIT 200'
  ).bind(vin).all();
  const eventos = (filas.results || []).map(function (f) {
    let payload = {};
    try { payload = JSON.parse(f.payload); } catch (e) { /* payload corrupto: se trata como vacío, nunca se rompe el proceso */ }
    return { id: f.id, tipo: f.tipo, observado_en: f.observado_en, payload };
  });
  const { pares } = emparejarEventosEnViajes(eventos);
  if (pares.length === 0) return 0;

  const ubicacionesRes = await env.DB.prepare('SELECT * FROM locations WHERE vin = ?').bind(vin).all();
  const ubicaciones = ubicacionesRes.results || [];
  const reglasRes = await env.DB.prepare("SELECT * FROM automation_rules WHERE vin = ? AND tipo = 'clasificacion_viaje'").bind(vin).all();
  const reglas = reglasRes.results || [];

  const inicioVentana = new Date(new Date(pares[0].inicio.observado_en).getTime() - 20 * 60 * 1000).toISOString();
  const finVentana = new Date(new Date(pares[pares.length - 1].fin.observado_en).getTime() + 20 * 60 * 1000).toISOString();
  const odoRes = await env.DB.prepare(
    'SELECT odometro_km AS valor, observado_en FROM odometer_snapshots WHERE vin = ? AND observado_en BETWEEN ? AND ?'
  ).bind(vin, inicioVentana, finVentana).all();
  const odometroSnapshots = odoRes.results || [];
  // B9: energy_remaining_kwh viaja en la misma consulta que soc_pct (mismo snapshot, mismo
  // instante) — snapshotMasCercano() sigue devolviendo "valor" (soc_pct, compatibilidad con el
  // resto del código) y además ahora trae energy_remaining_kwh en la misma fila para quien lo
  // necesite (construirViajeDesdeEventos).
  const batRes = await env.DB.prepare(
    'SELECT soc_pct AS valor, energy_remaining_kwh, fecha AS observado_en FROM battery_snapshots WHERE vin = ? AND fecha BETWEEN ? AND ?'
  ).bind(vin, inicioVentana, finVentana).all();
  const bateriaSnapshots = batRes.results || [];
  // B9: capacidad nominal real del vehículo (si se conoce) para poder estimar consumo por SoC
  // cuando no hay EnergyRemaining fiable — nunca se asume un valor genérico si no está en D1.
  const vehiculoRes = await env.DB.prepare('SELECT capacidad_nominal_kwh FROM vehicles WHERE vin = ?').bind(vin).first();
  const capacidadNominalKwh = (vehiculoRes && typeof vehiculoRes.capacidad_nominal_kwh === 'number') ? vehiculoRes.capacidad_nominal_kwh : null;

  const ahoraIso = new Date().toISOString();
  let cerrados = 0;
  for (const par of pares) {
    const { trip, pendiente, reglaUsada } = construirViajeDesdeEventos(vin, par.inicio, par.fin, {
      odometroSnapshots, bateriaSnapshots, ubicaciones, reglas, ahoraIso, esSombra, capacidadNominalKwh
    });
    await env.DB.prepare(
      'INSERT INTO trips (id, vin, started_at, ended_at, start_odometer_km, end_odometer_km, distance_km, duration_min, ' +
      'start_soc_pct, end_soc_pct, start_energy_remaining_kwh, end_energy_remaining_kwh, energy_used_kwh, energy_source, consumption_is_estimated, ' +
      'start_lat, start_lng, end_lat, end_lng, start_location_id, end_location_id, ' +
      'classification, classification_source, classification_rule_id, data_quality, source, is_shadow, created_at, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ' +
      'ON CONFLICT(id) DO NOTHING' // reprocesar los mismos eventos nunca duplica ni pisa una corrección manual
    ).bind(
      trip.id, trip.vin, trip.started_at, trip.ended_at, trip.start_odometer_km, trip.end_odometer_km,
      trip.distance_km, trip.duration_min, trip.start_soc_pct, trip.end_soc_pct,
      trip.start_energy_remaining_kwh, trip.end_energy_remaining_kwh, trip.energy_used_kwh, trip.energy_source, trip.consumption_is_estimated,
      trip.start_lat, trip.start_lng,
      trip.end_lat, trip.end_lng, trip.start_location_id, trip.end_location_id, trip.classification,
      trip.classification_source, trip.classification_rule_id, trip.data_quality, trip.source, trip.is_shadow, trip.created_at, trip.updated_at
    ).run();
    if (pendiente) {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO pending_actions (id, vin, tipo, referencia_tabla, referencia_id, detalle, created_at) VALUES (?,?,?,?,?,?,?)'
      ).bind(pendiente.id, pendiente.vin, pendiente.tipo, pendiente.referencia_tabla, pendiente.referencia_id, pendiente.detalle, pendiente.created_at).run();
    }
    if (reglaUsada) {
      await env.DB.prepare('UPDATE automation_rules SET veces_usada = veces_usada + 1, ultima_vez_usada = ? WHERE id = ?')
        .bind(ahoraIso, reglaUsada.id).run();
    }
    await env.DB.prepare('UPDATE telemetry_events_short_retention SET procesado_en = ? WHERE id IN (?, ?)')
      .bind(ahoraIso, par.inicio.id, par.fin.id).run();
    cerrados++;
  }
  return cerrados;
}

/* ---------- Fase 4C: motor de cargas 100% automáticas (puro, sin D1) ---------- */

/** Empareja eventos charge_started/charge_finished igual que emparejarEventosEnViajes, con la
 *  misma filosofía defensiva (doble apertura -> se queda con la segunda; cierre sin apertura
 *  conocida -> se ignora; apertura final sin cierre -> queda abierta para la próxima pasada). */
function emparejarEventosEnCargas(eventos) {
  const pares = [];
  let abierto = null;
  for (const ev of eventos) {
    if (ev.tipo === 'charge_started') {
      abierto = ev;
    } else if (ev.tipo === 'charge_stopped') {
      if (abierto) { pares.push({ inicio: abierto, fin: ev }); abierto = null; }
    }
  }
  return { pares, abiertoSinCerrar: abierto };
}

/**
 * Igual que clasificarViajeConReglas pero para reglas de precio ('precio_carga'): la condición
 * puede filtrar por `location_id`; la acción es {price_kwh}, {price_total} o {free:true}. Varias
 * reglas con resultados distintos -> 'ambiguo' (nunca se elige una al azar); ninguna -> 'sin_reglas'.
 */
function calcularCosteConReglas(carga, reglas) {
  const coincidentes = [];
  for (const regla of reglas) {
    if (!regla.activa) continue;
    let condicion; try { condicion = JSON.parse(regla.condicion); } catch (e) { continue; }
    if (condicion.location_id && condicion.location_id !== carga.location_id) continue;
    let accion; try { accion = JSON.parse(regla.accion); } catch (e) { continue; }
    if (accion.free === true) coincidentes.push({ regla, resultado: { total_cost: 0, cost_source: 'gratuita' } });
    else if (typeof accion.price_kwh === 'number' && typeof carga.energy_kwh === 'number') {
      coincidentes.push({ regla, resultado: { total_cost: Math.round(accion.price_kwh * carga.energy_kwh * 100) / 100, cost_source: 'estimado' } });
    } else if (typeof accion.price_total === 'number') {
      coincidentes.push({ regla, resultado: { total_cost: accion.price_total, cost_source: 'estimado' } });
    }
  }
  if (coincidentes.length === 0) return { tipo: 'sin_reglas' };
  const distintos = new Set(coincidentes.map((c) => c.resultado.total_cost));
  if (distintos.size > 1) return { tipo: 'ambiguo', candidatas: coincidentes };
  return { tipo: 'aplicada', resultado: coincidentes[0].resultado, regla: coincidentes[0].regla };
}

/**
 * Construye la fila de `charging_sessions` a partir de un par inicio/fin. La energía sale de la
 * diferencia AC/DC entre los dos eventos (nunca negativa: si el contador se ha reiniciado o el
 * dato es incoherente, se deja en null en vez de inventar un número). Ubicación por geofence igual
 * que en viajes. El precio se resuelve con automation_rules de tipo 'precio_carga'; si no hay
 * forma fiable de saberlo, se deja pendiente — nunca se asume un precio por defecto.
 */
function construirCargaDesdeEventos(vin, eventoInicio, eventoFin, contexto) {
  const payloadInicio = eventoInicio.payload || {};
  const payloadFin = eventoFin.payload || {};
  const ahoraIso = contexto.ahoraIso || new Date().toISOString();

  const lat = typeof payloadInicio.lat === 'number' ? payloadInicio.lat : null;
  const lng = typeof payloadInicio.lng === 'number' ? payloadInicio.lng : null;
  const location = emparejarUbicacion(lat, lng, contexto.ubicaciones);

  function delta(campo) {
    const a = payloadInicio[campo];
    const b = payloadFin[campo];
    if (typeof a === 'number' && typeof b === 'number' && b >= a) return Math.round((b - a) * 100) / 100;
    return null;
  }
  const acKwh = delta('ac_energy_kwh');
  const dcKwh = delta('dc_energy_kwh');
  let energyKwh = null, energySource = null, chargingCurrentType = null;
  if (typeof acKwh === 'number' && acKwh > 0) { energyKwh = acKwh; energySource = 'ac_energy_in'; chargingCurrentType = 'AC'; }
  else if (typeof dcKwh === 'number' && dcKwh > 0) { energyKwh = dcKwh; energySource = 'dc_energy_added'; chargingCurrentType = 'DC'; }

  const duracionMin = Math.round((new Date(eventoFin.observado_en).getTime() - new Date(eventoInicio.observado_en).getTime()) / 60000);

  const carga = {
    id: idDeterministico(vin, 'carga', eventoInicio.id + ':' + eventoFin.id),
    vin,
    started_at: eventoInicio.observado_en,
    ended_at: eventoFin.observado_en,
    start_soc_pct: typeof payloadInicio.soc_pct === 'number' ? payloadInicio.soc_pct : null,
    end_soc_pct: typeof payloadFin.soc_pct === 'number' ? payloadFin.soc_pct : null,
    start_odometer_km: typeof payloadInicio.odometro_km === 'number' ? payloadInicio.odometro_km : null,
    energy_kwh: energyKwh,
    energy_source: energySource,
    charging_current_type: chargingCurrentType,
    duration_min: duracionMin,
    lat, lng,
    location_id: location ? location.id : null,
    total_cost: null,
    cost_source: null,
    price_rule_id: null,
    data_quality: (energyKwh !== null && location !== null) ? 'complete' : 'partial',
    source: 'TESLA_TELEMETRY',
    is_shadow: contexto.esSombra ? 1 : 0, // A10
    created_at: ahoraIso,
    updated_at: ahoraIso
  };

  if (contexto.esSombra) {
    return { carga, pendiente: null, reglaUsada: null };
  }

  const coste = calcularCosteConReglas(carga, contexto.reglas || []);
  let pendiente = null;
  let reglaUsada = null;
  if (coste.tipo === 'aplicada') {
    carga.total_cost = coste.resultado.total_cost;
    carga.cost_source = coste.resultado.cost_source;
    carga.price_rule_id = coste.regla.id;
    reglaUsada = coste.regla;
  } else {
    pendiente = {
      id: idDeterministico(vin, 'pendiente_precio_carga', carga.id),
      vin,
      tipo: 'precio_carga',
      referencia_tabla: 'charging_sessions',
      referencia_id: carga.id,
      detalle: JSON.stringify({
        motivo: energyKwh === null ? 'sin_energia_conocida' : coste.tipo, // 'sin_energia_conocida' | 'sin_reglas' | 'ambiguo'
        location_id: carga.location_id,
        energy_kwh: carga.energy_kwh,
        started_at: carga.started_at
      }),
      created_at: ahoraIso
    };
  }

  return { carga, pendiente, reglaUsada };
}

/** Orquestador D1 del motor de cargas — mismo patrón que procesarViajesPendientes (A10: mismo
 *  tratamiento de automation_mode: 'off' no procesa nada, 'shadow' guarda con is_shadow=1). */
async function procesarCargasPendientes(env, vin, modo) {
  if (modo === 'off' || !modo) return 0;
  const esSombra = modo === 'shadow';
  const filas = await env.DB.prepare(
    "SELECT id, tipo, payload, observado_en FROM telemetry_events_short_retention " +
    "WHERE vin = ? AND tipo IN ('charge_started','charge_stopped') AND procesado_en IS NULL " +
    'ORDER BY observado_en ASC LIMIT 200'
  ).bind(vin).all();
  const eventos = (filas.results || []).map(function (f) {
    let payload = {};
    try { payload = JSON.parse(f.payload); } catch (e) { /* payload corrupto: se trata como vacío */ }
    return { id: f.id, tipo: f.tipo, observado_en: f.observado_en, payload };
  });
  const { pares } = emparejarEventosEnCargas(eventos);
  if (pares.length === 0) return 0;

  const ubicacionesRes = await env.DB.prepare('SELECT * FROM locations WHERE vin = ?').bind(vin).all();
  const ubicaciones = ubicacionesRes.results || [];
  const reglasRes = await env.DB.prepare("SELECT * FROM automation_rules WHERE vin = ? AND tipo = 'precio_carga'").bind(vin).all();
  const reglas = reglasRes.results || [];

  const ahoraIso = new Date().toISOString();
  let cerradas = 0;
  for (const par of pares) {
    const { carga, pendiente, reglaUsada } = construirCargaDesdeEventos(vin, par.inicio, par.fin, { ubicaciones, reglas, ahoraIso, esSombra });
    await env.DB.prepare(
      'INSERT INTO charging_sessions (id, vin, started_at, ended_at, start_soc_pct, end_soc_pct, start_odometer_km, ' +
      'energy_kwh, energy_source, charging_current_type, duration_min, lat, lng, location_id, total_cost, cost_source, ' +
      'price_rule_id, data_quality, source, is_shadow, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ' +
      'ON CONFLICT(id) DO NOTHING'
    ).bind(
      carga.id, carga.vin, carga.started_at, carga.ended_at, carga.start_soc_pct, carga.end_soc_pct, carga.start_odometer_km,
      carga.energy_kwh, carga.energy_source, carga.charging_current_type, carga.duration_min, carga.lat, carga.lng,
      carga.location_id, carga.total_cost, carga.cost_source, carga.price_rule_id, carga.data_quality, carga.source,
      carga.is_shadow, carga.created_at, carga.updated_at
    ).run();
    if (pendiente) {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO pending_actions (id, vin, tipo, referencia_tabla, referencia_id, detalle, created_at) VALUES (?,?,?,?,?,?,?)'
      ).bind(pendiente.id, pendiente.vin, pendiente.tipo, pendiente.referencia_tabla, pendiente.referencia_id, pendiente.detalle, pendiente.created_at).run();
    }
    if (reglaUsada) {
      await env.DB.prepare('UPDATE automation_rules SET veces_usada = veces_usada + 1, ultima_vez_usada = ? WHERE id = ?')
        .bind(ahoraIso, reglaUsada.id).run();
    }
    await env.DB.prepare('UPDATE telemetry_events_short_retention SET procesado_en = ? WHERE id IN (?, ?)')
      .bind(ahoraIso, par.inicio.id, par.fin.id).run();
    cerradas++;
  }
  return cerradas;
}

/* ---------- Fase 4D: enriquecimiento en background (nunca bloquea el cierre de viaje/carga) ---------- */

// Nominatim (OpenStreetMap) — geocodificación inversa gratuita. Su política de uso exige un
// User-Agent identificable y como máximo 1 petición/segundo — se respeta con ESPERA_ENTRE_PETICIONES_MS
// y un lote pequeño por ejecución (ver enriquecerViajesPendientes). https://operations.osmfoundation.org/policies/nominatim/
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
const NOMINATIM_USER_AGENT = 'mitesla-app/1.0 (uso personal, un unico vehiculo)';
// Open-Meteo Archive — clima histórico gratuito, sin necesidad de clave de API.
// https://open-meteo.com/en/docs/historical-weather-api
const OPEN_METEO_URL = 'https://archive-api.open-meteo.com/v1/archive';
const ESPERA_ENTRE_PETICIONES_MS = 1100;
const LOTE_ENRIQUECIMIENTO = 8; // pequeño a propósito: un vehículo personal no necesita más por pasada

function construirUrlNominatim(lat, lng) {
  return NOMINATIM_URL + '?format=jsonv2&lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lng) + '&zoom=16&addressdetails=1';
}

/** De la respuesta de Nominatim, un nombre corto y humano — nunca el `display_name` completo (una
 *  dirección postal entera es demasiado ruido para una fila de la tabla de viajes). Si la respuesta
 *  no trae nada aprovechable, null — nunca "Ubicación desconocida" ni similar inventado. */
function extraerNombreLugar(respuesta) {
  if (!respuesta || typeof respuesta !== 'object') return null;
  const a = respuesta.address || {};
  const via = a.road || a.pedestrian || a.footway || null;
  const localidad = a.city || a.town || a.village || a.municipality || null;
  if (via && localidad) return via + ', ' + localidad;
  if (localidad) return localidad;
  if (via) return via;
  return respuesta.display_name || null;
}

function construirUrlOpenMeteo(lat, lng, fechaISO) {
  const fecha = fechaISO.slice(0, 10); // YYYY-MM-DD
  return OPEN_METEO_URL + '?latitude=' + encodeURIComponent(lat) + '&longitude=' + encodeURIComponent(lng)
    + '&start_date=' + fecha + '&end_date=' + fecha + '&hourly=temperature_2m,precipitation&timezone=UTC';
}

/** De la respuesta horaria de Open-Meteo, la lectura más cercana al instante del viaje/carga.
 *  Nunca interpola ni inventa: si la hora exacta no está en el array (día sin datos, respuesta
 *  incompleta), devuelve null. */
function extraerResumenClima(respuesta, instanteISO) {
  if (!respuesta || !respuesta.hourly || !Array.isArray(respuesta.hourly.time)) return null;
  const horas = respuesta.hourly.time;
  const objetivo = new Date(instanteISO).getTime();
  let mejorIdx = -1, mejorDiferencia = Infinity;
  for (let i = 0; i < horas.length; i++) {
    const diff = Math.abs(new Date(horas[i] + ':00Z').getTime() - objetivo);
    if (diff < mejorDiferencia) { mejorDiferencia = diff; mejorIdx = i; }
  }
  if (mejorIdx === -1 || mejorDiferencia > 2 * 60 * 60 * 1000) return null; // más de 2h de diferencia: no es fiable
  const temp = respuesta.hourly.temperature_2m ? respuesta.hourly.temperature_2m[mejorIdx] : null;
  const precip = respuesta.hourly.precipitation ? respuesta.hourly.precipitation[mejorIdx] : null;
  if (typeof temp !== 'number' && typeof precip !== 'number') return null;
  return { temperatura: typeof temp === 'number' ? temp : null, precipitacion_mm: typeof precip === 'number' ? precip : null, fuente: 'open-meteo' };
}

/** Timeout por petición para las llamadas de enriquecimiento (B19/B20). No reutiliza
 *  fetchConTimeout() porque esa función tiene el `fetch` global fijado y aquí necesitamos poder
 *  inyectar `fetchImpl` en los tests (sin red real, sin esperar de verdad). */
async function fetchConTimeoutInyectable(fetchImpl, url, opciones, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  try {
    return await fetchImpl(url, Object.assign({}, opciones, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/** Redondeo de coordenadas para la caché de geocodificación por lote (B19): ~11m de precisión a 4
 *  decimales, más que suficiente para no repetir una llamada a Nominatim por el mismo punto (p. ej.
 *  origen de un viaje y destino del siguiente, en la misma plaza de garaje). */
function claveCacheCoordenada(lat, lng) {
  return lat.toFixed(4) + ',' + lng.toFixed(4);
}

/**
 * Job reintentable de enriquecimiento (sección 29-30, 53): geocodifica origen/destino y añade el
 * clima histórico de los viajes que ya están cerrados pero les falta ese dato — nunca al cerrar el
 * viaje en sí (eso ya pasó antes, en procesarViajesPendientes, sin depender de estas llamadas
 * externas). Se ejecuta por Cron Trigger (ver `scheduled` más abajo), no en cada petición HTTP.
 * Un fallo de red en un viaje no aborta el lote: se reintentará solo en la siguiente ejecución
 * programada, sin marcar nada como "definitivamente fallido" (nunca se deja de intentar).
 *
 * B19 (política de uso de Nominatim — "no hacer 16 llamadas cada 1.1 segundos"):
 *  - Geofence antes que geocoder: si el viaje ya tiene start_location_id/end_location_id resuelto
 *    (emparejado contra un lugar conocido al cerrar el viaje), se usa el nombre de ese lugar y
 *    Nominatim NUNCA se llama para ese punto.
 *  - Caché por lote: coordenadas iguales (redondeadas a 4 decimales) dentro de la misma ejecución
 *    solo generan una llamada real a Nominatim; el resto reutiliza el resultado.
 *  - Timeout por petición, para no dejar un cron colgado indefinidamente por una respuesta que no
 *    llega (B19/B20).
 *
 * `fetchImpl`, `esperaMs` y `timeoutMs` se inyectan para que los tests puedan probar esto sin red
 * real ni esperar de verdad el segundo entre peticiones que exige la política de uso de Nominatim.
 */
async function enriquecerViajesPendientes(env, opciones) {
  const fetchImpl = (opciones && opciones.fetchImpl) || fetch;
  const esperaMs = (opciones && opciones.esperaMs) != null ? opciones.esperaMs : ESPERA_ENTRE_PETICIONES_MS;
  const timeoutMs = (opciones && opciones.timeoutMs) != null ? opciones.timeoutMs : TIMEOUT_MS;
  const filas = await env.DB.prepare(
    'SELECT id, vin, start_lat, start_lng, end_lat, end_lng, start_location_id, end_location_id, ' +
    'start_location_raw, end_location_raw, started_at, weather ' +
    'FROM trips WHERE (start_location_raw IS NULL AND start_lat IS NOT NULL) ' +
    'OR (end_location_raw IS NULL AND end_lat IS NOT NULL) OR (weather IS NULL AND start_lat IS NOT NULL) ' +
    'ORDER BY created_at ASC LIMIT ?'
  ).bind(LOTE_ENRIQUECIMIENTO).all();

  const trips = filas.results || [];

  // ---- Geofence antes que geocoder: precargar los lugares conocidos de cada VIN presente en el lote ----
  const lugaresPorVin = new Map(); // vin -> Map(location_id -> name)
  const vinsDelLote = Array.from(new Set(trips.map((t) => t.vin).filter(Boolean)));
  for (const vin of vinsDelLote) {
    const lg = await env.DB.prepare('SELECT id, name FROM locations WHERE vin = ?').bind(vin).all();
    const mapa = new Map();
    for (const l of (lg.results || [])) mapa.set(l.id, l.name);
    lugaresPorVin.set(vin, mapa);
  }

  // ---- Caché de geocodificación inversa por coordenada, compartida entre todos los viajes del lote ----
  const cacheGeocoder = new Map(); // "lat,lng" -> nombre (string) | null

  async function nombreParaCoordenada(lat, lng) {
    const clave = claveCacheCoordenada(lat, lng);
    if (cacheGeocoder.has(clave)) return cacheGeocoder.get(clave);
    let nombre = null;
    const r = await fetchConTimeoutInyectable(fetchImpl, construirUrlNominatim(lat, lng), { headers: { 'User-Agent': NOMINATIM_USER_AGENT } }, timeoutMs);
    if (r.ok) { const j = await r.json(); nombre = extraerNombreLugar(j); }
    cacheGeocoder.set(clave, nombre);
    await new Promise((res) => setTimeout(res, esperaMs));
    return nombre;
  }

  let procesados = 0;
  for (const trip of trips) {
    let cambios = {};
    const lugares = lugaresPorVin.get(trip.vin) || new Map();
    try {
      if (!trip.start_location_raw && typeof trip.start_lat === 'number') {
        if (trip.start_location_id && lugares.has(trip.start_location_id)) {
          cambios.start_location_raw = lugares.get(trip.start_location_id);
        } else {
          const nombre = await nombreParaCoordenada(trip.start_lat, trip.start_lng);
          if (nombre) cambios.start_location_raw = nombre;
        }
      }
      if (!trip.end_location_raw && typeof trip.end_lat === 'number') {
        if (trip.end_location_id && lugares.has(trip.end_location_id)) {
          cambios.end_location_raw = lugares.get(trip.end_location_id);
        } else {
          const nombre = await nombreParaCoordenada(trip.end_lat, trip.end_lng);
          if (nombre) cambios.end_location_raw = nombre;
        }
      }
      if (!trip.weather && typeof trip.start_lat === 'number' && trip.started_at) {
        const r = await fetchConTimeoutInyectable(fetchImpl, construirUrlOpenMeteo(trip.start_lat, trip.start_lng, trip.started_at), {}, timeoutMs);
        if (r.ok) { const j = await r.json(); const clima = extraerResumenClima(j, trip.started_at); if (clima) cambios.weather = JSON.stringify(clima); }
      }
    } catch (e) {
      console.error('enriquecimiento_viaje_exception', trip.id, String(e));
      // Se sigue con el resto del lote — un fallo de red (o timeout) en un viaje no debe tirar los demás.
    }
    if (Object.keys(cambios).length > 0) {
      const set = Object.keys(cambios).map((c) => c + ' = ?').join(', ');
      await env.DB.prepare('UPDATE trips SET ' + set + ', updated_at = ? WHERE id = ?')
        .bind(...Object.values(cambios), new Date().toISOString(), trip.id).run();
      procesados++;
    }
  }
  return procesados;
}

/* ---------- Fase 4E: motor de alertas (dedupe/cooldown) + monitorización de huecos ---------- */

/**
 * Crea una alerta SOLO si no hay ya una abierta (resolved_at IS NULL) con la misma dedupe_key, o
 * si la última con esa clave se creó hace más de `cooldownHoras` — así un problema persistente
 * (p. ej. "sin telemetría desde hace horas") no genera una alerta nueva cada 15 minutos que corre
 * el Cron Trigger, pero tampoco se queda callado para siempre una vez resuelto y vuelto a fallar.
 * Devuelve true si se ha creado una alerta nueva, false si se ha omitido por dedupe/cooldown.
 */
async function generarAlertaSiProcede(env, vin, regla, dedupeKey, severity, mensaje, cooldownHoras) {
  const ahoraIso = new Date().toISOString();
  const ultima = await env.DB.prepare(
    'SELECT id, created_at, resolved_at FROM alerts WHERE vin = ? AND dedupe_key = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(vin, dedupeKey).first();
  if (ultima && !ultima.resolved_at) {
    const horasDesde = (Date.now() - new Date(ultima.created_at).getTime()) / 3600000;
    if (horasDesde < (cooldownHoras || 24)) return false; // ya hay una abierta y reciente: no duplicar
  }
  await env.DB.prepare(
    'INSERT INTO alerts (id, vin, rule, dedupe_key, severity, mensaje, created_at) VALUES (?,?,?,?,?,?,?)'
  ).bind(idDeterministico(vin, 'alerta', dedupeKey + '|' + ahoraIso.slice(0, 13)), vin, regla, dedupeKey, severity, mensaje, ahoraIso).run();
  return true;
}

/**
 * Compara el odómetro más reciente conocido (vehicle_snapshots) con la suma de distancias de los
 * viajes ya registrados desde el primer dato que tenemos, para detectar un hueco real: kilómetros
 * que el coche ha hecho pero que no están en ningún viaje (telemetría caída, Virtual Key revocada,
 * VM apagada...). Umbral deliberadamente generoso (30 km) para no avisar por el margen normal de
 * redondeo/ventanas de emparejamiento — esto es una señal de "algo puede estar roto", no un cálculo
 * exacto de kilómetros perdidos.
 */
async function comprobarHuecoOdometro(env, vin) {
  const snapshot = await env.DB.prepare('SELECT odometro_km, observado_en FROM vehicle_snapshots WHERE vin = ?').bind(vin).first();
  if (!snapshot || typeof snapshot.odometro_km !== 'number') return false;
  const primerOdometro = await env.DB.prepare(
    'SELECT odometro_km FROM odometer_snapshots WHERE vin = ? ORDER BY observado_en ASC LIMIT 1'
  ).bind(vin).first();
  if (!primerOdometro) return false;
  const sumaDistancias = await env.DB.prepare(
    'SELECT COALESCE(SUM(distance_km), 0) AS total FROM trips WHERE vin = ? AND distance_km IS NOT NULL'
  ).bind(vin).first();
  const esperado = primerOdometro.odometro_km + (sumaDistancias ? sumaDistancias.total : 0);
  const hueco = snapshot.odometro_km - esperado;
  if (hueco > 30) {
    return generarAlertaSiProcede(
      env, vin, 'hueco_odometro', 'hueco_odometro', 'accion',
      'El odómetro ha avanzado ' + Math.round(hueco) + ' km más de lo que suman los viajes registrados — puede haber un tramo sin telemetría.',
      24
    );
  }
  return false;
}

/** Si no llega nada de un vehículo que debería estar emitiendo desde hace demasiado tiempo, es la
 *  misma señal que ya calcula /internal/health — pero aquí se convierte en una alerta real que el
 *  usuario ve sin tener que ir a consultar el diagnóstico, y con dedupe para no repetirla sin fin. */
async function comprobarSilencioTelemetria(env, vin) {
  const estado = await env.DB.prepare('SELECT ultimo_evento_en FROM sync_state WHERE vin = ?').bind(vin).first();
  if (!estado || !estado.ultimo_evento_en) return false;
  const horas = (Date.now() - new Date(estado.ultimo_evento_en).getTime()) / 3600000;
  if (horas > 6) {
    return generarAlertaSiProcede(
      env, vin, 'silencio_telemetria', 'silencio_telemetria', 'accion',
      'Sin datos de telemetría desde hace ' + Math.round(horas) + ' horas — revisa el bridge/la VM.',
      12
    );
  }
  return false;
}

/* ---------- B17 (FASE B): retención — purga solo telemetría cruda YA PROCESADA ---------- */

// telemetry_events_short_retention es, por diseño (ver cabecera de d1/schema.sql), de retención
// corta: una vez que un evento ha servido para construir un viaje/carga (procesado_en no es null),
// no hace falta conservarlo para siempre — eso es lo que ya vive, de forma duradera, en trips/
// charging_sessions (los datos canónicos). Un evento SIN procesar (procesado_en IS NULL) NUNCA se
// purga aquí, tenga la edad que tenga — perderlo sin haberlo usado sería perder datos reales, no
// limpiar basura. quarantined_events (A15, eventos con payload inválido) tampoco se toca en esta
// purga: son la evidencia de un error real y se conservan aparte, como pide la norma "guardar los
// errores sin procesar" — su propia limpieza, si algún día hace falta, es una decisión aparte.
const RETENCION_TELEMETRIA_DIAS = 7; // ya documentado como objetivo en d1/schema.sql (cabecera)

/**
 * Borra de telemetry_events_short_retention las filas YA PROCESADAS (procesado_en NOT NULL) cuyo
 * observado_en sea más antiguo que RETENCION_TELEMETRIA_DIAS. Se ejecuta por Cron Trigger (ver
 * `scheduled` más abajo), nunca en el camino síncrono de una petición HTTP. `diasRetencion` se
 * inyecta para que los tests puedan probar el corte de fecha sin esperar días de verdad.
 */
async function purgarTelemetriaCruda(env, opciones) {
  const diasRetencion = (opciones && opciones.diasRetencion) != null ? opciones.diasRetencion : RETENCION_TELEMETRIA_DIAS;
  const limite = new Date(Date.now() - diasRetencion * 86400000).toISOString();
  const resultado = await env.DB.prepare(
    'DELETE FROM telemetry_events_short_retention WHERE procesado_en IS NOT NULL AND observado_en < ?'
  ).bind(limite).run();
  return (resultado && resultado.meta && typeof resultado.meta.changes === 'number') ? resultado.meta.changes : 0;
}

/** Recorre todos los vehículos conocidos y ejecuta las comprobaciones de huecos/silencio para cada
 *  uno — se llama desde el Cron Trigger junto al enriquecimiento (Fase 4D). */
async function ejecutarComprobacionesDeSalud(env) {
  const vehiculosRes = await env.DB.prepare('SELECT vin FROM vehicles').bind().all();
  let alertasCreadas = 0;
  for (const v of (vehiculosRes.results || [])) {
    try {
      if (await comprobarHuecoOdometro(env, v.vin)) alertasCreadas++;
      if (await comprobarSilencioTelemetria(env, v.vin)) alertasCreadas++;
    } catch (e) {
      console.error('comprobacion_salud_exception', v.vin, String(e));
    }
  }
  return alertasCreadas;
}

function origenesPermitidos(env) {
  return (env.ALLOWED_ORIGIN || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function withCors(resp, request, env) {
  const permitidos = origenesPermitidos(env);
  const origen = request.headers.get('Origin') || '';
  const headers = new Headers(resp.headers);
  headers.set('Vary', 'Origin');
  if (permitidos.length && permitidos.indexOf(origen) !== -1) {
    headers.set('Access-Control-Allow-Origin', origen);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  // Si el origen no está en la lista, no se añade ninguna cabecera CORS:
  // el navegador bloqueará la lectura de la respuesta desde ese origen.
  return new Response(resp.body, { status: resp.status, headers: headers });
}

function jsonError(codigo, status, requestId, extra) {
  const cuerpo = Object.assign({ error: codigo, request_id: requestId }, extra || {});
  return new Response(JSON.stringify(cuerpo), {
    status: status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Config incompleta = error explícito, nunca un CORS "*" automático ni un
 * arranque silencioso a medias.
 */
function comprobarConfig(env) {
  const faltan = [];
  ['TESLA_CLIENT_ID', 'TESLA_CLIENT_SECRET', 'TESLA_REDIRECT_URI', 'TESLA_DOMAIN', 'ADMIN_TOKEN'].forEach(function (k) {
    if (!env[k]) faltan.push(k);
  });
  if (!origenesPermitidos(env).length) faltan.push('ALLOWED_ORIGIN');
  if (!env.TESLA_TOKENS) faltan.push('TESLA_TOKENS (KV binding)');
  return faltan;
}

function autenticado(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/.exec(auth);
  const token = m ? m[1] : (new URL(request.url)).searchParams.get('key') || '';
  return timingSafeEqual(token, env.ADMIN_TOKEN || '');
}

async function fetchConTimeout(url, opciones) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, opciones, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/** Traduce una respuesta no-OK de Tesla a un código de error propio, sin
 *  filtrar el cuerpo real de la respuesta de Tesla al navegador. */
function codigoDeError(status) {
  if (status === 401) return { codigo: 'tesla_auth_failed', http: 401 };
  if (status === 403) return { codigo: 'tesla_scope_missing', http: 403 };
  if (status === 404) return { codigo: 'not_found', http: 404 };
  if (status === 408) return { codigo: 'tesla_unavailable', http: 504 };
  if (status === 429) return { codigo: 'tesla_rate_limited', http: 429 };
  if (status >= 500) return { codigo: 'tesla_unavailable', http: 502 };
  return { codigo: 'tesla_unknown_error', http: 502 };
}

/* ---------- OAuth: tokens ---------- */

async function obtenerTokenDePartner(env) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.TESLA_CLIENT_ID,
    client_secret: env.TESLA_CLIENT_SECRET,
    scope: 'openid vehicle_device_data vehicle_location offline_access',
    audience: FLEET_API_BASE
  });
  const res = await fetchConTimeout(TESLA_FLEET_AUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body
  });
  if (!res.ok) throw new Error('partner_token_failed:' + res.status);
  return (await res.json()).access_token;
}

async function intercambiarCodigoPorTokens(code, env) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: env.TESLA_CLIENT_ID,
    client_secret: env.TESLA_CLIENT_SECRET,
    code: code,
    redirect_uri: env.TESLA_REDIRECT_URI,
    audience: FLEET_API_BASE
  });
  const res = await fetchConTimeout(TESLA_FLEET_AUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body
  });
  if (!res.ok) throw new Error('code_exchange_failed:' + res.status);
  return res.json(); // { access_token, refresh_token, expires_in, ... }
}

async function renovarAccessToken(refreshToken, env) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.TESLA_CLIENT_ID,
    refresh_token: refreshToken
  });
  const res = await fetchConTimeout(TESLA_FLEET_AUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body
  });
  if (!res.ok) throw new Error('refresh_failed:' + res.status);
  return res.json();
}

/** Promesa compartida DENTRO de este isolate: si dos peticiones concurrentes llegan al mismo
 *  Worker en ejecución y ambas necesitan renovar el token, la segunda espera el resultado de la
 *  primera en vez de disparar un segundo refresh. Cubre el caso común de una sola persona con
 *  varias pestañas/dispositivos golpeando el mismo Worker casi a la vez. */
let refreshEnCurso = null;

/**
 * A12 (FASE A, auditoría externa 2026-09-20): el lock entre isolates DISTINTOS (el caso más raro,
 * pero el único que de verdad importa aquí: Tesla rota el refresh_token en cada uso, así que dos
 * refrescos simultáneos desde isolates distintos podían dejar un refresh_token inválido y
 * desconectar la cuenta) usaba KV (get+put separados). KV es de consistencia EVENTUAL entre
 * regiones — no da una garantía dura de exclusión mutua. D1 es una única base SQLite (no
 * replicada como KV): un INSERT sobre una PRIMARY KEY sin "OR IGNORE" es atómico de verdad, igual
 * que el antirreplay de A13. Se usa como lock fuerte aquí. Si D1 no está configurado (instalación
 * sin Fase 4), se cae al lock KV anterior — best-effort, pero documentado como tal, nunca oculto.
 */
async function adquirirLockRefresh(env) {
  const ahoraIso = new Date().toISOString();
  const expiraEn = new Date(Date.now() + REFRESH_LOCK_TTL_S * 1000).toISOString();
  if (!env.DB) {
    // Fallback KV, solo si no hay D1 — best-effort, documentado en el propio código (ver arriba).
    const lock = await env.TESLA_TOKENS.get('refresh_lock');
    if (lock) return false;
    await env.TESLA_TOKENS.put('refresh_lock', '1', { expirationTtl: REFRESH_LOCK_TTL_S });
    return true;
  }
  try {
    await env.DB.prepare('INSERT INTO oauth_refresh_lock (id, locked_at, expires_at) VALUES (?,?,?)')
      .bind('global', ahoraIso, expiraEn).run();
    return true;
  } catch (e) {
    // Ya existe una fila — comprobamos si el lock anterior caducó (p.ej. el isolate murió sin
    // liberar) y, si es así, lo "robamos" atómicamente con un UPDATE condicionado.
    const robo = await env.DB.prepare('UPDATE oauth_refresh_lock SET locked_at = ?, expires_at = ? WHERE id = ? AND expires_at < ?')
      .bind(ahoraIso, expiraEn, 'global', ahoraIso).run();
    return Boolean(robo && robo.meta && robo.meta.changes === 1);
  }
}
async function liberarLockRefresh(env) {
  if (!env.DB) { await env.TESLA_TOKENS.delete('refresh_lock'); return; }
  await env.DB.prepare('DELETE FROM oauth_refresh_lock WHERE id = ?').bind('global').run();
}

async function asegurarAccessToken(env) {
  const accessToken0 = await env.TESLA_TOKENS.get('access_token');
  const exp0 = Number((await env.TESLA_TOKENS.get('access_token_exp')) || 0);
  if (accessToken0 && Date.now() < exp0 - 60000) return accessToken0;

  if (refreshEnCurso) return refreshEnCurso;

  refreshEnCurso = (async function () {
    try {
      // doble comprobación: otra invocación pudo haber renovado ya.
      let accessToken = await env.TESLA_TOKENS.get('access_token');
      let exp = Number((await env.TESLA_TOKENS.get('access_token_exp')) || 0);
      if (accessToken && Date.now() < exp - 60000) return accessToken;

      let tengoLock = await adquirirLockRefresh(env);
      if (!tengoLock) {
        for (let i = 0; i < 5; i++) {
          await new Promise(function (r) { setTimeout(r, 400); });
          accessToken = await env.TESLA_TOKENS.get('access_token');
          exp = Number((await env.TESLA_TOKENS.get('access_token_exp')) || 0);
          if (accessToken && Date.now() < exp - 60000) return accessToken;
        }
        // Nadie más terminó a tiempo: se reintenta adquirir (el lock anterior pudo caducar).
        tengoLock = await adquirirLockRefresh(env);
        if (!tengoLock) throw new Error('refresh_lock_no_disponible');
      }
      try {
        const refreshToken = await env.TESLA_TOKENS.get('refresh_token');
        if (!refreshToken) throw new Error('not_connected');
        const tokens = await renovarAccessToken(refreshToken, env);
        accessToken = tokens.access_token;
        await env.TESLA_TOKENS.put('access_token', accessToken);
        await env.TESLA_TOKENS.put('access_token_exp', String(Date.now() + tokens.expires_in * 1000));
        if (tokens.refresh_token) await env.TESLA_TOKENS.put('refresh_token', tokens.refresh_token);
        await env.TESLA_TOKENS.put('conectado_desde', (await env.TESLA_TOKENS.get('conectado_desde')) || new Date().toISOString());
        return accessToken;
      } finally {
        await liberarLockRefresh(env);
      }
    } finally {
      refreshEnCurso = null;
    }
  })();
  return refreshEnCurso;
}

/* ---------- Worker ---------- */

// Exportadas con nombre solo para que los tests puedan probar la lógica pura del motor de viajes
// (Fase 4B) sin montar una base D1 real. El propio Worker sigue usando únicamente el export default.
export {
  distanciaMetros, emparejarUbicacion, snapshotMasCercano, emparejarEventosEnViajes,
  construirViajeDesdeEventos, clasificarViajeConReglas, idDeterministico, procesarViajesPendientes,
  emparejarEventosEnCargas, calcularCosteConReglas, construirCargaDesdeEventos, procesarCargasPendientes,
  construirUrlNominatim, extraerNombreLugar, construirUrlOpenMeteo, extraerResumenClima, enriquecerViajesPendientes,
  generarAlertaSiProcede, comprobarHuecoOdometro, comprobarSilencioTelemetria, ejecutarComprobacionesDeSalud,
  purgarTelemetriaCruda,
  // FASE A (auditoría externa 2026-09-20) — funciones puras añadidas/revisadas, exportadas para tests:
  vinFormatoValido, validarPayloadTelemetria, obtenerAutomationMode, fijarAutomationMode,
  actualizarUsageCounters, actualizarHeartbeat, vinAutorizado, autorizarVinEnAllowlist,
  adquirirLockRefresh, liberarLockRefresh
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const requestId = nuevoId();

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), request, env);
    }

    // Clave pública: Tesla necesita poder leerla sin autenticación, desde la raíz del dominio.
    if (url.pathname === '/.well-known/appspecific/com.tesla.3p.public-key.pem') {
      if (!env.TESLA_PUBLIC_KEY_PEM) return jsonError('missing_public_key', 500, requestId);
      return new Response(env.TESLA_PUBLIC_KEY_PEM, { headers: { 'Content-Type': 'application/x-pem-file' } });
    }

    // ---- Fase 3, punto 32 — Sincronización con Cloudflare D1 (DISEÑADO/PENDIENTE) ----
    // Alternativa/complemento a la sincronización vía GitHub, detrás del feature flag "d1_sync"
    // (desactivado por defecto en el frontend). Estas dos rutas están implementadas y listas para
    // funcionar de verdad en cuanto el Worker tenga el binding D1 configurado — hasta entonces,
    // devuelven un error explícito, nunca datos simulados. Configuración exacta pendiente por
    // parte del usuario (ver README/informe final de la Fase 3):
    //   1. `wrangler d1 create mitesla-datos` (crea la base de datos D1 en la cuenta de Cloudflare).
    //   2. Añadir a wrangler.toml el binding resultante con el nombre exacto "DB":
    //        [[d1_databases]]
    //        binding = "DB"
    //        database_name = "mitesla-datos"
    //        database_id = "<el id que devuelve el comando anterior>"
    //   3. Volver a desplegar el Worker (`wrangler deploy`). La tabla se crea sola en el primer uso.
    //   4. Activar el flag "d1_sync" en Ajustes → Funciones avanzadas de la app.
    // Primera etapa deliberadamente simple (tal y como pide la propia auditoría): un blob JSON
    // completo por dispositivo, sin fusión multi-dispositivo en el propio D1 — la fusión sigue
    // haciéndose en el cliente con la misma lógica que ya usa la sincronización con GitHub. Une
    // fusión real dentro de D1 (por colección/campo, no por blob) queda fuera de esta primera
    // etapa y explícitamente pendiente si en el futuro se usa D1 como reemplazo completo de GitHub.
    if (url.pathname === '/d1/sync' || url.pathname === '/d1/datos') {
      if (!env.DB) {
        return withCors(jsonError('d1_no_configurado', 501, requestId, {
          motivo: 'Falta el binding D1 "DB" en este Worker — añade [[d1_databases]] a wrangler.toml y vuelve a desplegar.'
        }), request, env);
      }
      if (!autenticado(request, env)) return withCors(jsonError('unauthorized', 401, requestId), request, env);
      try {
        await env.DB.exec(
          'CREATE TABLE IF NOT EXISTS mitesla_datos (device_id TEXT PRIMARY KEY, contenido TEXT NOT NULL, actualizado_en TEXT NOT NULL)'
        );
        if (url.pathname === '/d1/datos' && request.method === 'GET') {
          const deviceId = url.searchParams.get('device_id');
          if (!deviceId) return withCors(jsonError('falta_device_id', 400, requestId), request, env);
          const fila = await env.DB.prepare('SELECT contenido, actualizado_en FROM mitesla_datos WHERE device_id = ?').bind(deviceId).first();
          const cuerpo = fila ? { contenido: JSON.parse(fila.contenido), actualizado_en: fila.actualizado_en } : { contenido: null, actualizado_en: null };
          return withCors(new Response(JSON.stringify(cuerpo), { headers: { 'Content-Type': 'application/json' } }), request, env);
        }
        if (url.pathname === '/d1/sync' && request.method === 'PUT') {
          const cuerpo = await request.json();
          if (!cuerpo || !cuerpo.device_id || !cuerpo.datos) return withCors(jsonError('cuerpo_invalido', 400, requestId), request, env);
          const ahoraIso = new Date().toISOString();
          await env.DB.prepare(
            'INSERT INTO mitesla_datos (device_id, contenido, actualizado_en) VALUES (?, ?, ?) ' +
            'ON CONFLICT(device_id) DO UPDATE SET contenido=excluded.contenido, actualizado_en=excluded.actualizado_en'
          ).bind(cuerpo.device_id, JSON.stringify(cuerpo.datos), ahoraIso).run();
          return withCors(new Response(JSON.stringify({ ok: true, actualizado_en: ahoraIso }), { headers: { 'Content-Type': 'application/json' } }), request, env);
        }
        return withCors(jsonError('method_not_allowed', 405, requestId), request, env);
      } catch (e) {
        console.error('d1_exception', requestId, String(e));
        return withCors(jsonError('d1_error', 502, requestId), request, env);
      }
    }

    // ---- Fase 4A — Ingesta de telemetría desde mitesla-telemetry-bridge (VM propia) ----
    // No requiere las variables OAuth de Tesla (va antes de comprobarConfig): es un canal
    // totalmente aparte, autenticado por HMAC (verificarFirmaBridge), no por ADMIN_TOKEN.
    // Cuerpo esperado (JSON), ya normalizado y deduplicado por el bridge en la VM:
    //   { vin, events:[{id,tipo,payload,observado_en}], snapshot:{...}|null, heartbeat:{...}|null,
    //     senales_recibidas: number }
    // - "events": van a telemetry_events_short_retention, id determinista => idempotente
    //   (INSERT OR IGNORE, un reintento del bridge nunca duplica).
    // - "snapshot": si viene, hace UPSERT de vehicle_snapshots (una sola fila "viva").
    // Nunca se acepta telemetría cruda sin agregar aquí: eso ya lo hace el bridge antes de enviar.
    if (url.pathname === '/internal/telemetry' && request.method === 'POST') {
      if (!env.DB) {
        return withCors(jsonError('d1_no_configurado', 501, requestId, {
          motivo: 'Falta el binding D1 "DB" — configura d1/schema.sql y despliega antes de activar el bridge.'
        }), request, env);
      }
      // A15: se rechaza por tamaño ANTES de leer el cuerpo entero a memoria, cuando el cliente
      // manda Content-Length (nunca se confía ciegamente en la cabecera, pero si está y es enorme,
      // no hace falta ni empezar a leer).
      const declaredLength = Number(request.headers.get('Content-Length') || 0);
      if (declaredLength > 262144) {
        return withCors(jsonError('cuerpo_demasiado_grande', 413, requestId), request, env);
      }
      const cuerpoTexto = await request.text();
      if (cuerpoTexto.length > 262144) {
        return withCors(jsonError('cuerpo_demasiado_grande', 413, requestId), request, env);
      }
      const firmaOk = await verificarFirmaBridge(request, env, cuerpoTexto);
      if (!firmaOk.ok) {
        console.error('telemetry_firma_invalida', requestId, firmaOk.motivo);
        return withCors(jsonError('unauthorized', 401, requestId, { motivo: firmaOk.motivo }), request, env);
      }
      let cuerpo;
      try { cuerpo = JSON.parse(cuerpoTexto); } catch (e) {
        await ponerEnCuarentena(env, null, 'json_invalido', cuerpoTexto);
        return withCors(jsonError('cuerpo_invalido', 400, requestId), request, env);
      }
      // A15: validación exhaustiva (tipos, rangos, tamaños) antes de tocar D1.
      const validacion = validarPayloadTelemetria(cuerpo);
      if (!validacion.ok) {
        console.error('telemetry_validacion_fallida', requestId, validacion.motivo, JSON.stringify(validacion.detalle || {}));
        await ponerEnCuarentena(env, cuerpo && cuerpo.vin, validacion.motivo, cuerpoTexto);
        return withCors(jsonError(validacion.motivo, 400, requestId, validacion.detalle), request, env);
      }
      // A14: el VIN debe pertenecer a un vehículo autorizado explícitamente — nunca se acepta
      // "porque tiene forma de VIN". Un VIN ajeno (o un bridge mal configurado) se rechaza aquí,
      // antes de escribir nada en D1.
      const autorizado = await vinAutorizado(env, cuerpo.vin);
      if (!autorizado) {
        console.error('telemetry_vin_no_autorizado', requestId, cuerpo.vin);
        await ponerEnCuarentena(env, cuerpo.vin, 'vin_no_autorizado', cuerpoTexto);
        return withCors(jsonError('vin_no_autorizado', 403, requestId), request, env);
      }
      const eventos = Array.isArray(cuerpo.events) ? cuerpo.events : [];
      try {
        await asegurarVehiculoD1(env, cuerpo.vin);
        const ahoraIso = new Date().toISOString();
        // A9: cada POST recibido con firma válida demuestra que el bridge está vivo. El resto de
        // señales (mensajes MQTT, métricas válidas de Tesla, connectivity) solo se marcan si el
        // propio cuerpo trae indicios reales de ellas — nunca se infieren del mero hecho de POST.
        const huboEventosOSnapshot = eventos.length > 0 || Boolean(cuerpo.snapshot);
        await actualizarHeartbeat(env, cuerpo.vin, {
          bridgeVivo: true,
          mqttMensaje: huboEventosOSnapshot || Number(cuerpo.senales_recibidas) > 0,
          teslaMetricaValida: huboEventosOSnapshot,
          connectivity: Boolean(cuerpo.heartbeat && cuerpo.heartbeat.connectivity_status),
          connectivityStatus: cuerpo.heartbeat ? cuerpo.heartbeat.connectivity_status : null
        }).catch(function (e) { console.error('heartbeat_exception', requestId, String(e)); });
        let insertados = 0;
        let duplicados = 0;
        for (const ev of eventos) {
          if (!ev || typeof ev.id !== 'string' || typeof ev.tipo !== 'string' || typeof ev.observado_en !== 'string') continue;
          const payloadObjeto = typeof ev.payload === 'object' && ev.payload ? ev.payload : {};
          const payloadTexto = JSON.stringify(payloadObjeto);
          if (payloadTexto.length > 8192) continue; // payload defendido: nunca rutas completas ni logs verbosos aquí
          const res = await env.DB.prepare(
            'INSERT OR IGNORE INTO telemetry_events_short_retention (id, vin, tipo, payload, observado_en, recibido_en) VALUES (?,?,?,?,?,?)'
          ).bind(ev.id, cuerpo.vin, ev.tipo, payloadTexto, ev.observado_en, ahoraIso).run();
          if (res && res.meta && res.meta.changes > 0) insertados++; else duplicados++;
          // Los eventos trip_started/trip_finished llevan odómetro/SoC del instante exacto (más
          // preciso que el snapshot periódico) — se guardan también como historial permanente
          // (tablas C) para que el motor de viajes de la Fase 4B pueda calcular distancia real.
          if (typeof payloadObjeto.odometro_km === 'number') {
            await env.DB.prepare(
              'INSERT OR IGNORE INTO odometer_snapshots (id, vin, odometro_km, observado_en, source, created_at) VALUES (?,?,?,?,?,?)'
            ).bind('odo_' + ev.id, cuerpo.vin, payloadObjeto.odometro_km, ev.observado_en, 'TESLA_TELEMETRY', ahoraIso).run();
          }
          if (typeof payloadObjeto.soc_pct === 'number') {
            // B9: energy_remaining_kwh se guarda cuando el bridge la manda (vehículo/config con
            // EnergyRemaining suscrita) — si no, null explícito, nunca un valor derivado del SoC
            // aquí (esa derivación, cuando haga falta, es una estimación aparte y etiquetada, no
            // un dato "medido" disfrazado).
            const energiaRestante = typeof payloadObjeto.energy_remaining_kwh === 'number' ? payloadObjeto.energy_remaining_kwh : null;
            await env.DB.prepare(
              'INSERT OR IGNORE INTO battery_snapshots (id, vin, fecha, soc_pct, energy_remaining_kwh, odometro_km, source, created_at) VALUES (?,?,?,?,?,?,?,?)'
            ).bind('bat_' + ev.id, cuerpo.vin, ev.observado_en, payloadObjeto.soc_pct, energiaRestante, payloadObjeto.odometro_km ?? null, 'TESLA_TELEMETRY', ahoraIso).run();
          }
        }
        if (cuerpo.snapshot && typeof cuerpo.snapshot === 'object') {
          const s = cuerpo.snapshot;
          await env.DB.prepare(
            'INSERT INTO vehicle_snapshots (vin, soc_pct, autonomia_km, odometro_km, estado, lat, lng, ubicacion_nombre, temperatura_exterior, potencia_carga_kw, tiempo_restante_carga_min, fuente, observado_en, recibido_en) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ' +
            'ON CONFLICT(vin) DO UPDATE SET soc_pct=excluded.soc_pct, autonomia_km=excluded.autonomia_km, odometro_km=excluded.odometro_km, ' +
            'estado=excluded.estado, lat=excluded.lat, lng=excluded.lng, ubicacion_nombre=excluded.ubicacion_nombre, ' +
            'temperatura_exterior=excluded.temperatura_exterior, potencia_carga_kw=excluded.potencia_carga_kw, ' +
            'tiempo_restante_carga_min=excluded.tiempo_restante_carga_min, fuente=excluded.fuente, ' +
            'observado_en=excluded.observado_en, recibido_en=excluded.recibido_en ' +
            'WHERE excluded.observado_en >= vehicle_snapshots.observado_en' // nunca sobrescribe con un dato más antiguo (llegadas fuera de orden)
          ).bind(
            cuerpo.vin, s.soc_pct ?? null, s.autonomia_km ?? null, s.odometro_km ?? null, s.estado ?? null,
            s.lat ?? null, s.lng ?? null, s.ubicacion_nombre ?? null, s.temperatura_exterior ?? null,
            s.potencia_carga_kw ?? null, s.tiempo_restante_carga_min ?? null, s.fuente || 'TESLA_TELEMETRY',
            s.observado_en || ahoraIso, ahoraIso
          ).run();
        }
        await incrementarContadorSyncState(env, cuerpo.vin, 'eventos_recibidos_mes', insertados);
        // A25: contadores de coste reales — separados de "eventos derivados" (trip_started, etc.,
        // gratis) de las señales de streaming en bruto que sí tienen coste en la Fleet API. El
        // bridge reporta cuántas señales MQTT vio este ciclo en `senales_recibidas`; si no lo
        // manda (bridge antiguo), se usa 0 en vez de inventar un número.
        await actualizarUsageCounters(env, cuerpo.vin, {
          telemetry_signals_received: Number.isFinite(Number(cuerpo.senales_recibidas)) ? Number(cuerpo.senales_recibidas) : 0,
          derived_events: eventos.length
        }).catch(function (e) { console.error('usage_counters_exception', requestId, String(e)); });

        // A10: el modo (off/shadow/active) decide si se consolidan viajes/cargas y si se marcan
        // como reales o como sombra — nunca se procesa en 'active' por defecto sin que el usuario
        // lo haya decidido explícitamente (ver obtenerAutomationMode).
        const modo = await obtenerAutomationMode(env, cuerpo.vin);
        // Fase 4B: cerrar viajes automáticamente en cuanto llega el evento que los completa —
        // así funciona aunque la PWA esté cerrada (sección 43/44). Un fallo aquí no debe tirar la
        // ingesta ya confirmada (los eventos ya están guardados; se reprocesarán en el próximo envío).
        let viajesCerrados = 0;
        try {
          viajesCerrados = await procesarViajesPendientes(env, cuerpo.vin, modo);
        } catch (e) {
          console.error('procesar_viajes_exception', requestId, String(e));
        }
        let cargasCerradas = 0;
        try {
          cargasCerradas = await procesarCargasPendientes(env, cuerpo.vin, modo);
        } catch (e) {
          console.error('procesar_cargas_exception', requestId, String(e));
        }
        return withCors(new Response(JSON.stringify({
          ok: true, insertados, duplicados, viajes_cerrados: viajesCerrados, cargas_cerradas: cargasCerradas, automation_mode: modo
        }), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        console.error('telemetry_exception', requestId, String(e));
        await incrementarContadorSyncState(env, cuerpo.vin, 'errores_mes', 1).catch(function () {});
        return withCors(jsonError('telemetry_error', 502, requestId), request, env);
      }
    }

    // ---- Fase 4A — /internal/health: diagnóstico del pipeline de telemetría (sección 59, 63) ----
    // Protegida con el mismo ADMIN_TOKEN que el resto de rutas privadas (la consulta el propio
    // frontend en Ajustes → Automatización, no el bridge). Nunca inventa "todo ok" si falta algo:
    // cada pieza se comprueba de verdad (binding D1, secreto configurado, última recepción real).
    if (url.pathname === '/internal/health') {
      if (!autenticado(request, env)) return withCors(jsonError('unauthorized', 401, requestId), request, env);
      const vin = url.searchParams.get('vin');
      const salud = {
        d1_configurado: Boolean(env.DB),
        secreto_bridge_configurado: Boolean(env.TELEMETRY_BRIDGE_SECRET),
        vin_consultado: vin || null,
        sync_state: null,
        // A9: señales separadas, nunca una sola "última actividad" genérica — ver actualizarHeartbeat.
        heartbeat: null,
        automation_mode: null,
        usage_counters: null
      };
      if (env.DB && vin) {
        try {
          const fila = await env.DB.prepare('SELECT * FROM sync_state WHERE vin = ?').bind(vin).first();
          salud.sync_state = fila || null;
          if (fila && fila.ultimo_evento_en) {
            const minutosDesdeUltimo = (Date.now() - new Date(fila.ultimo_evento_en).getTime()) / 60000;
            salud.minutos_desde_ultimo_evento = Math.round(minutosDesdeUltimo);
            // Umbral orientativo: si el coche debería estar emitiendo y no hay nada en 6h, hay algo roto.
            salud.posible_problema = minutosDesdeUltimo > 360;
          }
          const heartbeat = await env.DB.prepare('SELECT * FROM bridge_heartbeats WHERE vin = ?').bind(vin).first();
          salud.heartbeat = heartbeat || null;
          if (heartbeat) {
            // A9: cada señal se evalúa por SEPARADO — "Tesla enviando métricas" puede llevar horas
            // caído aunque el bridge (proceso Node) siga vivo y MQTT siga conectado a Mosquitto.
            const minutosDesde = (campo) => heartbeat[campo] ? Math.round((Date.now() - new Date(heartbeat[campo]).getTime()) / 60000) : null;
            salud.minutos_desde_bridge_vivo = minutosDesde('last_bridge_heartbeat_at');
            salud.minutos_desde_mqtt = minutosDesde('last_mqtt_message_at');
            salud.minutos_desde_metrica_tesla = minutosDesde('last_tesla_message_at');
            salud.minutos_desde_connectivity = minutosDesde('last_connectivity_at');
          }
          salud.automation_mode = await obtenerAutomationMode(env, vin);
          salud.usage_counters = await env.DB.prepare('SELECT * FROM usage_counters WHERE vin = ?').bind(vin).first() || null;
        } catch (e) {
          console.error('health_exception', requestId, String(e));
          salud.error_consulta_d1 = true;
        }
      }
      return withCors(new Response(JSON.stringify(salud), { headers: { 'Content-Type': 'application/json' } }), request, env);
    }

    // ---- Fase 4B — /pendientes: la cola de lo que de verdad no se pudo decidir solo (sección 36) ----
    // GET  /pendientes?vin=...            -> lista lo abierto (resuelto_en IS NULL), detalle ya parseado
    // POST /pendientes/resolver           -> { id, resuelto_con:{classification} } y aplica la respuesta
    // Ambas protegidas con el mismo ADMIN_TOKEN que el resto de rutas privadas del frontend.
    // ---- A10 (FASE A): /automatizacion/modo — leer/fijar el modo real (off/shadow/active) ----
    if (url.pathname === '/automatizacion/modo' && request.method === 'GET') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!autenticado(request, env)) return withCors(jsonError('unauthorized', 401, requestId), request, env);
      const vin = url.searchParams.get('vin');
      if (!vin) return withCors(jsonError('falta_vin', 400, requestId), request, env);
      const modo = await obtenerAutomationMode(env, vin);
      return withCors(new Response(JSON.stringify({ vin, automation_mode: modo }), { headers: { 'Content-Type': 'application/json' } }), request, env);
    }
    if (url.pathname === '/automatizacion/modo' && request.method === 'POST') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!autenticado(request, env)) return withCors(jsonError('unauthorized', 401, requestId), request, env);
      let cuerpo;
      try { cuerpo = await request.json(); } catch (e) { return withCors(jsonError('cuerpo_invalido', 400, requestId), request, env); }
      if (!cuerpo || typeof cuerpo.vin !== 'string' || !cuerpo.vin || !MODOS_AUTOMATIZACION_VALIDOS.has(cuerpo.modo)) {
        return withCors(jsonError('cuerpo_invalido', 400, requestId, { motivo: 'vin y modo (off|shadow|active) requeridos' }), request, env);
      }
      try {
        await fijarAutomationMode(env, cuerpo.vin, cuerpo.modo);
        return withCors(new Response(JSON.stringify({ ok: true, vin: cuerpo.vin, automation_mode: cuerpo.modo }), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        console.error('automatizacion_modo_exception', requestId, String(e));
        return withCors(jsonError('d1_error', 502, requestId), request, env);
      }
    }

    if (url.pathname === '/pendientes' && request.method === 'GET') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!autenticado(request, env)) return withCors(jsonError('unauthorized', 401, requestId), request, env);
      const vin = url.searchParams.get('vin');
      if (!vin) return withCors(jsonError('falta_vin', 400, requestId), request, env);
      try {
        const filas = await env.DB.prepare(
          'SELECT id, tipo, referencia_tabla, referencia_id, detalle, created_at FROM pending_actions WHERE vin = ? AND resuelto_en IS NULL AND is_shadow = 0 ORDER BY created_at ASC'
        ).bind(vin).all();
        const pendientes = (filas.results || []).map(function (f) {
          let detalle = {};
          try { detalle = JSON.parse(f.detalle); } catch (e) { /* detalle corrupto: se muestra vacío, nunca rompe el listado */ }
          return { id: f.id, tipo: f.tipo, referencia_tabla: f.referencia_tabla, referencia_id: f.referencia_id, detalle, created_at: f.created_at };
        });
        return withCors(new Response(JSON.stringify({ pendientes }), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        console.error('pendientes_exception', requestId, String(e));
        return withCors(jsonError('d1_error', 502, requestId), request, env);
      }
    }
    if (url.pathname === '/pendientes/resolver' && request.method === 'POST') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!autenticado(request, env)) return withCors(jsonError('unauthorized', 401, requestId), request, env);
      let cuerpo;
      try { cuerpo = await request.json(); } catch (e) { return withCors(jsonError('cuerpo_invalido', 400, requestId), request, env); }
      if (!cuerpo || typeof cuerpo.id !== 'string' || !cuerpo.resuelto_con || typeof cuerpo.resuelto_con !== 'object') {
        return withCors(jsonError('cuerpo_invalido', 400, requestId), request, env);
      }
      try {
        const pendiente = await env.DB.prepare('SELECT * FROM pending_actions WHERE id = ?').bind(cuerpo.id).first();
        if (!pendiente) return withCors(jsonError('pendiente_no_encontrado', 404, requestId), request, env);
        if (pendiente.resuelto_en) return withCors(jsonError('pendiente_ya_resuelto', 409, requestId), request, env);
        const ahoraIso = new Date().toISOString();
        if (pendiente.tipo === 'clasificar_viaje' && pendiente.referencia_tabla === 'trips' && typeof cuerpo.resuelto_con.classification === 'string') {
          // La corrección manual del usuario SIEMPRE gana — nunca la pisará un reprocesamiento
          // posterior de los mismos eventos (esos eventos ya quedaron marcados como procesados).
          await env.DB.prepare(
            "UPDATE trips SET classification = ?, classification_source = 'manual', classification_rule_id = NULL, updated_at = ? WHERE id = ?"
          ).bind(cuerpo.resuelto_con.classification, ahoraIso, pendiente.referencia_id).run();
        }
        if (pendiente.tipo === 'precio_carga' && pendiente.referencia_tabla === 'charging_sessions') {
          const r = cuerpo.resuelto_con;
          const totalCost = r.free === true ? 0 : (typeof r.total_cost === 'number' ? r.total_cost : null);
          const costSource = r.free === true ? 'gratuita' : (totalCost !== null ? 'conocido' : null);
          if (totalCost !== null) {
            await env.DB.prepare(
              "UPDATE charging_sessions SET total_cost = ?, cost_source = ?, price_rule_id = NULL, updated_at = ? WHERE id = ?"
            ).bind(totalCost, costSource, ahoraIso, pendiente.referencia_id).run();
          }
        }
        await env.DB.prepare('UPDATE pending_actions SET resuelto_en = ?, resuelto_con = ? WHERE id = ?')
          .bind(ahoraIso, JSON.stringify(cuerpo.resuelto_con), cuerpo.id).run();
        return withCors(new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        console.error('resolver_pendiente_exception', requestId, String(e));
        return withCors(jsonError('d1_error', 502, requestId), request, env);
      }
    }

    // ---- Fase 4E — /alertas: motor de alertas con dedupe/cooldown (sección 34-35) ----
    // GET  /alertas?vin=...        -> lista lo abierto (resolved_at IS NULL)
    // POST /alertas/resolver       -> { id } marca una alerta como resuelta (el usuario ya la vio/actuó)
    if (url.pathname === '/alertas' && request.method === 'GET') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!autenticado(request, env)) return withCors(jsonError('unauthorized', 401, requestId), request, env);
      const vin = url.searchParams.get('vin');
      if (!vin) return withCors(jsonError('falta_vin', 400, requestId), request, env);
      try {
        const filas = await env.DB.prepare(
          'SELECT id, rule, severity, mensaje, created_at FROM alerts WHERE vin = ? AND resolved_at IS NULL ORDER BY created_at DESC'
        ).bind(vin).all();
        return withCors(new Response(JSON.stringify({ alertas: filas.results || [] }), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        console.error('alertas_exception', requestId, String(e));
        return withCors(jsonError('d1_error', 502, requestId), request, env);
      }
    }
    if (url.pathname === '/alertas/resolver' && request.method === 'POST') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!autenticado(request, env)) return withCors(jsonError('unauthorized', 401, requestId), request, env);
      let cuerpo;
      try { cuerpo = await request.json(); } catch (e) { return withCors(jsonError('cuerpo_invalido', 400, requestId), request, env); }
      if (!cuerpo || typeof cuerpo.id !== 'string') return withCors(jsonError('cuerpo_invalido', 400, requestId), request, env);
      try {
        await env.DB.prepare('UPDATE alerts SET resolved_at = ? WHERE id = ?').bind(new Date().toISOString(), cuerpo.id).run();
        return withCors(new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        console.error('resolver_alerta_exception', requestId, String(e));
        return withCors(jsonError('d1_error', 502, requestId), request, env);
      }
    }

    const faltanVars = comprobarConfig(env);
    if (faltanVars.length) {
      return withCors(jsonError('config_incompleta', 500, requestId, { faltan: faltanVars }), request, env);
    }

    // ---- /setup: registrar el dominio ante Tesla. Protegida, POST, no repetible sin ?force=1 ----
    if (url.pathname === '/setup') {
      if (request.method !== 'POST') return withCors(jsonError('method_not_allowed', 405, requestId), request, env);
      if (!autenticado(request, env)) return withCors(jsonError('unauthorized', 401, requestId), request, env);
      const yaHecho = await env.TESLA_TOKENS.get('setup_completed');
      if (yaHecho && url.searchParams.get('force') !== '1') {
        return withCors(jsonError('setup_ya_realizado', 409, requestId, { hecho_en: yaHecho }), request, env);
      }
      try {
        const partnerToken = await obtenerTokenDePartner(env);
        const res = await fetchConTimeout(FLEET_API_BASE + '/api/1/partner_accounts', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + partnerToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: env.TESLA_DOMAIN })
        });
        if (!res.ok) {
          const e = codigoDeError(res.status);
          console.error('setup_failed', requestId, res.status);
          return withCors(jsonError(e.codigo, e.http, requestId), request, env);
        }
        await env.TESLA_TOKENS.put('setup_completed', new Date().toISOString());
        return withCors(new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        console.error('setup_exception', requestId, String(e));
        return withCors(jsonError('tesla_unavailable', 502, requestId), request, env);
      }
    }

    // ---- A11 (FASE A): /oauth/start-token — emite un token de un solo uso y corta vida (120s)
    // para poder navegar a /oauth/start SIN llevar el ADMIN_TOKEN permanente en la URL. Esta ruta
    // sí exige el ADMIN_TOKEN real, pero por cabecera Authorization (fetch autenticado normal),
    // nunca por query string — así el secreto permanente nunca llega a aparecer en un historial de
    // navegación, en logs de acceso ni en el Referer de la navegación siguiente.
    if (url.pathname === '/oauth/start-token' && request.method === 'POST') {
      if (!autenticado(request, env)) return withCors(jsonError('unauthorized', 401, requestId), request, env);
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      const token = nuevoId() + nuevoId();
      await env.DB.prepare('INSERT INTO oauth_start_tokens (token, creado_en) VALUES (?, ?)')
        .bind(token, new Date().toISOString()).run();
      return withCors(new Response(JSON.stringify({ ok: true, token }), { headers: { 'Content-Type': 'application/json' } }), request, env);
    }

    // ---- /oauth/start: genera state seguro, lo guarda en KV y redirige a Tesla ----
    // A11: ya NO acepta ?key=ADMIN_TOKEN (secreto permanente expuesto en la URL/navegación/logs).
    // Solo acepta ?token=<token de un solo uso de /oauth/start-token>, con vida máxima de 120s y
    // consumo atómico (UPDATE ... WHERE usado_en IS NULL, se comprueba changes>0) para que un
    // enlace reutilizado o compartido por error no sirva dos veces.
    if (url.pathname === '/oauth/start') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      const token = url.searchParams.get('token') || '';
      if (!token) return withCors(jsonError('unauthorized', 401, requestId, { motivo: 'falta_token' }), request, env);
      const fila = await env.DB.prepare('SELECT creado_en, usado_en FROM oauth_start_tokens WHERE token = ?').bind(token).first();
      if (!fila) return withCors(jsonError('unauthorized', 401, requestId, { motivo: 'token_desconocido' }), request, env);
      if (fila.usado_en) return withCors(jsonError('unauthorized', 401, requestId, { motivo: 'token_ya_usado' }), request, env);
      const edadMs = Date.now() - new Date(fila.creado_en).getTime();
      if (!Number.isFinite(edadMs) || edadMs > 120000) return withCors(jsonError('unauthorized', 401, requestId, { motivo: 'token_caducado' }), request, env);
      const consumo = await env.DB.prepare('UPDATE oauth_start_tokens SET usado_en = ? WHERE token = ? AND usado_en IS NULL')
        .bind(new Date().toISOString(), token).run();
      if (!consumo || !consumo.meta || consumo.meta.changes !== 1) {
        return withCors(jsonError('unauthorized', 401, requestId, { motivo: 'token_ya_usado' }), request, env);
      }
      const state = nuevoId() + nuevoId(); // 2x UUID v4 aleatorio (crypto), suficiente entropía
      await env.TESLA_TOKENS.put('oauth_state:' + state, '1', { expirationTtl: STATE_TTL_S });
      const authUrl = TESLA_AUTHORIZE_URL
        + '?client_id=' + encodeURIComponent(env.TESLA_CLIENT_ID)
        + '&redirect_uri=' + encodeURIComponent(env.TESLA_REDIRECT_URI)
        + '&response_type=code'
        + '&scope=' + encodeURIComponent(OAUTH_SCOPE)
        + '&state=' + encodeURIComponent(state);
      return Response.redirect(authUrl, 302);
    }

    // ---- /callback: Tesla redirige aquí. Se protege validando el state de un solo uso ----
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      // A16 (FASE A): FRONTEND_RETURN_URL es una constante fija del código (nunca viene de query
      // string ni de ningún input), pero se valida igualmente su forma al vuelo — defensa en
      // profundidad si en el futuro pasara a ser configurable por variable de entorno.
      const retornoValido = /^https:\/\/[a-z0-9.-]+\.github\.io\//i.test(FRONTEND_RETURN_URL) || /^https:\/\//i.test(FRONTEND_RETURN_URL);
      const retorno = retornoValido ? FRONTEND_RETURN_URL : 'about:blank';
      const html = function (titulo, cuerpo) {
        return new Response(
          '<meta http-equiv="refresh" content="2;url=' + retorno + '">'
          + '<h1>' + titulo + '</h1><p>' + cuerpo + '</p>'
          + '<p><a href="' + retorno + '">Volver a Mi Tesla ahora</a> (o espera 2 segundos)</p>',
          {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              // A16: esta página muestra el resultado de un intercambio de código OAuth — nunca
              // debe quedar cacheada (por el navegador ni por un proxy intermedio), nunca debe
              // filtrar esta URL como Referer al navegar fuera, y se sirve con una CSP mínima
              // (no ejecuta ni carga nada más que el propio texto y el meta-refresh).
              'Cache-Control': 'no-store',
              'Referrer-Policy': 'no-referrer',
              'X-Content-Type-Options': 'nosniff',
              'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'"
            }
          }
        );
      };
      if (!code || !state) return html('Faltan parámetros ❌', 'La respuesta de Tesla no incluye code o state.');
      const clave = 'oauth_state:' + state;
      const existia = await env.TESLA_TOKENS.get(clave);
      if (!existia) {
        return html('Enlace no válido o caducado ❌', 'Este enlace de conexión con Tesla ya se usó, ha caducado (10 min) o no se inició desde la app. Vuelve a pulsar "Conectar con Tesla".');
      }
      // Consumir el state de un solo uso ANTES de canjear el código.
      await env.TESLA_TOKENS.delete(clave);
      try {
        const tokens = await intercambiarCodigoPorTokens(code, env);
        await env.TESLA_TOKENS.put('refresh_token', tokens.refresh_token);
        await env.TESLA_TOKENS.put('access_token', tokens.access_token);
        await env.TESLA_TOKENS.put('access_token_exp', String(Date.now() + tokens.expires_in * 1000));
        await env.TESLA_TOKENS.put('conectado_desde', new Date().toISOString());
        return html('Tesla conectado ✅', 'Ya puedes cerrar esta pestaña y volver a Mi Tesla.');
      } catch (e) {
        console.error('callback_exception', requestId, String(e));
        return html('No se pudo completar la conexión ❌', 'Vuelve a intentarlo desde Mi Tesla. (ref: ' + requestId + ')');
      }
    }

    // A partir de aquí, todos los endpoints son privados.
    if (!autenticado(request, env)) {
      return withCors(jsonError('unauthorized', 401, requestId), request, env);
    }

    // ---- /estado: estado de conexión actual ----
    if (url.pathname === '/estado') {
      const refreshToken = await env.TESLA_TOKENS.get('refresh_token');
      const conectadoDesde = await env.TESLA_TOKENS.get('conectado_desde');
      const selectedVin = await env.TESLA_TOKENS.get('selected_vin');
      return withCors(new Response(JSON.stringify({
        conectado: !!refreshToken,
        conectado_desde: conectadoDesde || null,
        vin_seleccionado: selectedVin ? ('…' + selectedVin.slice(-6)) : null
      }), { headers: { 'Content-Type': 'application/json' } }), request, env);
    }

    // ---- /desconectar: borra los tokens guardados ----
    if (url.pathname === '/desconectar' && request.method === 'POST') {
      await Promise.all(['refresh_token', 'access_token', 'access_token_exp', 'conectado_desde', 'selected_vin']
        .map(function (k) { return env.TESLA_TOKENS.delete(k); }));
      return withCors(new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }), request, env);
    }

    // ---- /vehiculos: lista de vehículos de la cuenta ----
    if (url.pathname === '/vehiculos') {
      try {
        const accessToken = await asegurarAccessToken(env);
        const res = await fetchConTimeout(FLEET_API_BASE + '/api/1/vehicles', { headers: { Authorization: 'Bearer ' + accessToken } });
        if (!res.ok) {
          const e = codigoDeError(res.status);
          return withCors(jsonError(e.codigo, e.http, requestId), request, env);
        }
        const json = await res.json();
        const lista = (json.response || []).map(function (v) {
          return { vin: v.vin, nombre: v.display_name || v.vin, estado: v.state };
        });
        return withCors(new Response(JSON.stringify({ vehiculos: lista }), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        const codigo = String(e.message || '').indexOf('not_connected') === 0 ? 'not_connected' : 'tesla_unavailable';
        console.error('vehiculos_exception', requestId, String(e));
        return withCors(jsonError(codigo, codigo === 'not_connected' ? 401 : 502, requestId), request, env);
      }
    }

    // ---- /seleccionar-vehiculo: fija el VIN activo cuando hay varios ----
    if (url.pathname === '/seleccionar-vehiculo' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return withCors(jsonError('json_invalido', 400, requestId), request, env); }
      if (!body || typeof body.vin !== 'string' || !body.vin) {
        return withCors(jsonError('vin_requerido', 400, requestId), request, env);
      }
      await env.TESLA_TOKENS.put('selected_vin', body.vin);
      // A14: este es el único sitio donde un VIN entra en la allowlist de telemetría — el usuario
      // lo ha elegido explícitamente entre SUS propios vehículos (ya autenticado contra la Fleet
      // API arriba, en /vehiculos). /internal/telemetry nunca puede auto-registrar un VIN nuevo.
      if (env.DB) {
        await autorizarVinEnAllowlist(env, body.vin).catch(function (e) { console.error('allowlist_exception', requestId, String(e)); });
      }
      return withCors(new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }), request, env);
    }

    // ---- /vehiculo: datos del vehículo seleccionado (o el único disponible) ----
    if (url.pathname === '/vehiculo') {
      try {
        const accessToken = await asegurarAccessToken(env);
        const vehiculosRes = await fetchConTimeout(FLEET_API_BASE + '/api/1/vehicles', { headers: { Authorization: 'Bearer ' + accessToken } });
        if (!vehiculosRes.ok) {
          const e = codigoDeError(vehiculosRes.status);
          return withCors(jsonError(e.codigo, e.http, requestId), request, env);
        }
        const vehiculosJson = await vehiculosRes.json();
        const vehiculos = vehiculosJson.response || [];
        if (!vehiculos.length) return withCors(jsonError('sin_vehiculos', 404, requestId), request, env);

        let seleccionado = null;
        const vinGuardado = await env.TESLA_TOKENS.get('selected_vin');
        if (vinGuardado) seleccionado = vehiculos.filter(function (v) { return v.vin === vinGuardado; })[0] || null;
        if (!seleccionado) {
          if (vehiculos.length === 1) {
            seleccionado = vehiculos[0];
            await env.TESLA_TOKENS.put('selected_vin', seleccionado.vin);
          } else {
            return withCors(jsonError('seleccion_requerida', 300, requestId, {
              vehiculos: vehiculos.map(function (v) { return { vin: v.vin, nombre: v.display_name || v.vin }; })
            }), request, env);
          }
        }

        const datosRes = await fetchConTimeout(FLEET_API_BASE + '/api/1/vehicles/' + encodeURIComponent(seleccionado.vin) + '/vehicle_data', {
          headers: { Authorization: 'Bearer ' + accessToken }
        });
        if (!datosRes.ok) {
          const e = codigoDeError(datosRes.status);
          console.error('vehicle_data_failed', requestId, datosRes.status);
          return withCors(jsonError(e.codigo, e.http, requestId), request, env);
        }
        let datosJson;
        try { datosJson = await datosRes.json(); }
        catch (e) { return withCors(jsonError('respuesta_invalida', 502, requestId), request, env); }
        return withCors(new Response(JSON.stringify(datosJson), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        const msg = String(e && e.message || e);
        if (msg.indexOf('not_connected') === 0) return withCors(jsonError('not_connected', 401, requestId), request, env);
        if (e && e.name === 'AbortError') return withCors(jsonError('tesla_unavailable', 504, requestId), request, env);
        console.error('vehiculo_exception', requestId, msg);
        return withCors(jsonError('tesla_unavailable', 502, requestId), request, env);
      }
    }

    return withCors(jsonError('not_found', 404, requestId), request, env);
  },

  // ---- Fase 4D: Cron Trigger — enriquecimiento en background, nunca disparado por una visita ----
  // Gratuito dentro del plan Free de Cloudflare Workers (los Cron Triggers no consumen peticiones
  // HTTP). Se configura en wrangler.toml, ver infra/README.md — sin esto configurado, este código
  // simplemente no se ejecuta nunca (no hace falta desactivar nada a mano si no se quiere usar).
  async scheduled(event, env, ctx) {
    if (!env.DB) { console.error('scheduled_sin_d1'); return; }
    try {
      const n = await enriquecerViajesPendientes(env);
      console.log('enriquecimiento_completado', n);
    } catch (e) {
      console.error('scheduled_exception_enriquecimiento', String(e));
    }
    try {
      const a = await ejecutarComprobacionesDeSalud(env);
      console.log('comprobaciones_salud_completadas', a);
    } catch (e) {
      console.error('scheduled_exception_salud', String(e));
    }
    try {
      const p = await purgarTelemetriaCruda(env);
      console.log('purga_telemetria_completada', p);
    } catch (e) {
      console.error('scheduled_exception_purga', String(e));
    }
  }
};
