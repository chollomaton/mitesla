import { admitObservations, stableJSON, reconcileCanonical, containsSecretFields, assertUnambiguousLifecycle } from './telemetry-integrity.mjs';
import {sessionAuthentication,bootstrap,revoke} from './session-auth.mjs';
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
  const tsNum = /^\d+$/.test(timestamp) ? Number(timestamp) : NaN;
  const ahoraS = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(tsNum) || Math.abs(ahoraS - tsNum) > 120) return { ok: false, motivo: 'timestamp_fuera_de_ventana' };
  if (typeof env.TELEMETRY_BRIDGE_SECRET !== 'string' || !env.TELEMETRY_BRIDGE_SECRET.trim()) return { ok: false, motivo: 'secreto_no_configurado' };
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

// B15: umbral de aviso de presión de neumáticos (bar). Nullable a propósito — sin que el usuario lo
// fije explícitamente, NUNCA se avisa (norma de datos inventados: la presión "segura" depende del
// neumático/versión del coche, no hay un valor genérico correcto para todo el mundo).
async function obtenerUmbralTpms(env, vin) {
  if (!env.DB) return null;
  const fila = await env.DB.prepare('SELECT tpms_umbral_bar FROM vehicle_settings WHERE vin = ?').bind(vin).first();
  return (fila && typeof fila.tpms_umbral_bar === 'number') ? fila.tpms_umbral_bar : null;
}
async function fijarUmbralTpms(env, vin, umbralBar) {
  if (typeof umbralBar !== 'number' || !Number.isFinite(umbralBar) || umbralBar <= 0 || umbralBar > 6) throw new Error('umbral_invalido');
  const ahoraIso = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO vehicle_settings (vin, automation_mode, tpms_umbral_bar, updated_at) VALUES (?, \'off\', ?, ?) ' +
    'ON CONFLICT(vin) DO UPDATE SET tpms_umbral_bar=excluded.tpms_umbral_bar, updated_at=excluded.updated_at'
  ).bind(vin, umbralBar, ahoraIso).run();
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
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) return { ok: false, motivo: 'cuerpo_no_es_objeto' };
  if (containsSecretFields(cuerpo)) return {ok:false,motivo:'secret_fields_forbidden'};
  if (typeof cuerpo.vin !== 'string' || !vinFormatoValido(cuerpo.vin)) return { ok: false, motivo: 'vin_invalido' };
  if (cuerpo.events !== undefined && !Array.isArray(cuerpo.events)) return { ok: false, motivo: 'events_no_es_array' };
  const eventos = cuerpo.events || [];
  if (eventos.length > 500) return { ok: false, motivo: 'demasiados_eventos' };
  const numeroFinitoOk = (v) => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v));
  for (let i = 0; i < eventos.length; i++) {
    const ev = eventos[i];
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return { ok: false, motivo: 'evento_invalido', detalle: { indice: i } };
    if (typeof ev.id !== 'string' || ev.id.length === 0 || ev.id.length > 128) return { ok: false, motivo: 'evento_id_invalido', detalle: { indice: i } };
    if (typeof ev.tipo !== 'string' || ev.tipo.length > 64) return { ok: false, motivo: 'evento_tipo_invalido', detalle: { indice: i } };
    if (typeof ev.observado_en !== 'string' || Number.isNaN(new Date(ev.observado_en).getTime())) {
      return { ok: false, motivo: 'evento_timestamp_invalido', detalle: { indice: i } };
    }
    if (!ev.payload || typeof ev.payload !== 'object' || Array.isArray(ev.payload)) return {ok:false,motivo:'evento_payload_invalido'};
    ev.observado_en = new Date(ev.observado_en).toISOString();
    const p = ev.payload;
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
    if (typeof cuerpo.snapshot !== 'object' || Array.isArray(cuerpo.snapshot)) return { ok: false, motivo: 'snapshot_no_es_objeto' };
    const s = cuerpo.snapshot;
    for (const campo of ['autonomia_km','temperatura_exterior','potencia_carga_kw','tiempo_restante_carga_min']) if (!numeroFinitoOk(s[campo])) return {ok:false,motivo:'snapshot_'+campo+'_invalido'};
    if (s.fuente !== undefined && s.fuente !== 'TESLA_TELEMETRY') return {ok:false,motivo:'snapshot_fuente_invalida'};
    if (typeof s.observado_en !== 'string' || !Number.isFinite(Date.parse(s.observado_en))) return {ok:false,motivo:'snapshot_timestamp_invalido'};
    s.observado_en = new Date(s.observado_en).toISOString();
    if (!numeroFinitoOk(s.lat) || (typeof s.lat === 'number' && Math.abs(s.lat) > 90)) return { ok: false, motivo: 'snapshot_lat_invalida' };
    if (!numeroFinitoOk(s.lng) || (typeof s.lng === 'number' && Math.abs(s.lng) > 180)) return { ok: false, motivo: 'snapshot_lng_invalida' };
    if (!numeroFinitoOk(s.soc_pct) || (typeof s.soc_pct === 'number' && (s.soc_pct < 0 || s.soc_pct > 100))) return { ok: false, motivo: 'snapshot_soc_invalido' };
    if (!numeroFinitoOk(s.odometro_km) || (typeof s.odometro_km === 'number' && s.odometro_km < 0)) return { ok: false, motivo: 'snapshot_odometro_invalido' };
    if (typeof s.ubicacion_nombre === 'string' && s.ubicacion_nombre.length > 256) return { ok: false, motivo: 'snapshot_ubicacion_nombre_demasiado_larga' };
    // B15: presión de los 4 neumáticos (TpmsPressureFl/Fr/Rl/Rr, en bar) — rango generoso (0-6 bar)
    // solo para descartar basura evidente, nunca para decidir qué es "seguro" (eso lo fija el
    // usuario con su propio umbral, ver comprobarPresionNeumaticos).
    for (const campo of ['tpms_fl_bar', 'tpms_fr_bar', 'tpms_rl_bar', 'tpms_rr_bar']) {
      if (!numeroFinitoOk(s[campo]) || (typeof s[campo] === 'number' && (s[campo] < 0 || s[campo] > 6))) return { ok: false, motivo: campo + '_invalido' };
    }
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
      .bind(nuevoId(), vin || null, motivo, (env.TELEMETRY_BRIDGE_SECRET && String(cuerpoTexto).includes(env.TELEMETRY_BRIDGE_SECRET) ? '[redacted]' : String(cuerpoTexto).slice(0, 2000)), new Date().toISOString()).run();
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

/**
 * B14 — Privacidad de la ruta GPS: recorta del PRINCIPIO y del FINAL de una ruta ya simplificada
 * ({lat,lng}[]) los puntos que caen dentro de un geofence "Casa" (category==='casa') o marcado
 * como privado (privacy_level==='oculta_en_exportaciones'). Nunca toca el tramo intermedio (ahí sí
 * importa conservar la forma real del trayecto) — solo los extremos, que son los que revelan dónde
 * vive o dónde para el usuario en un sitio que ha marcado como privado. Reutiliza el mismo criterio
 * de "dentro del geofence" que emparejarUbicacion (radius_m de cada lugar), para no duplicar reglas
 * de distancia con matices distintos. Puro y determinista — no toca D1 ni red.
 */
function esLugarPrivado(lugar) {
  return !!lugar && (lugar.category === 'casa' || lugar.privacy_level === 'oculta_en_exportaciones');
}
function dentroDeAlgunLugarPrivado(punto, ubicaciones) {
  const lugar = emparejarUbicacion(punto.lat, punto.lng, ubicaciones);
  return esLugarPrivado(lugar);
}
function recortarRutaPrivada(puntos, ubicaciones) {
  if (!Array.isArray(puntos) || puntos.length === 0) return [];
  if (!ubicaciones || ubicaciones.length === 0) return puntos.slice();
  const privadas = ubicaciones.filter(esLugarPrivado);
  if (privadas.length === 0) return puntos.slice();

  let inicio = 0;
  while (inicio < puntos.length && dentroDeAlgunLugarPrivado(puntos[inicio], privadas)) inicio++;
  let fin = puntos.length - 1;
  while (fin >= inicio && dentroDeAlgunLugarPrivado(puntos[fin], privadas)) fin--;
  if (inicio > fin) return []; // toda la ruta caía dentro de zona(s) privada(s): no queda nada que mostrar
  return puntos.slice(inicio, fin + 1);
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
 * B11 (FASE B): de una lista de muestras de potencia {power_kw, observado_en}, agrega las que
 * caen DENTRO del intervalo [inicioIso, finIso] (ambos incluidos) de una sesión de carga y
 * devuelve {max_power_kw, average_power_kw, power_samples_count}. Sin ninguna muestra en la
 * ventana -> los dos valores quedan en null (NORMA SOBRE DATOS INVENTADOS: un max/promedio
 * calculado solo con los 2 puntos de inicio/fin no sería un dato real, así que directamente no
 * se calcula si no hay muestras periódicas de verdad dentro del intervalo).
 */
function agregarPotenciaEnVentana(muestras, inicioIso, finIso) {
  const inicioMs = new Date(inicioIso).getTime();
  const finMs = new Date(finIso).getTime();
  const dentro = (muestras || []).filter(function (m) {
    if (typeof m.power_kw !== 'number' || !Number.isFinite(m.power_kw)) return false;
    const t = new Date(m.observado_en).getTime();
    return t >= inicioMs && t <= finMs;
  });
  if (dentro.length === 0) return { max_power_kw: null, average_power_kw: null, power_samples_count: 0 };
  const max = Math.max.apply(null, dentro.map(function (m) { return m.power_kw; }));
  const suma = dentro.reduce(function (acc, m) { return acc + m.power_kw; }, 0);
  return {
    max_power_kw: Math.round(max * 100) / 100,
    average_power_kw: Math.round((suma / dentro.length) * 100) / 100,
    power_samples_count: dentro.length
  };
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

  // B14 — Ruta GPS: route_points ya viene simplificada por el bridge (Douglas-Peucker, en la VM —
  // ver telemetry-bridge/lib/normalizador.js); aquí solo se recortan los extremos que caigan en
  // "Casa" o en un lugar marcado como privado (recortarRutaPrivada), y se guarda como JSON. Sin
  // route_points en el payload (bridge antiguo, o viaje sin puntos suficientes) -> null, nunca un
  // array inventado.
  const routePointsCrudos = Array.isArray(payloadFin.route_points) ? payloadFin.route_points : null;
  const routeSimplified = routePointsCrudos
    ? JSON.stringify(recortarRutaPrivada(routePointsCrudos, contexto.ubicaciones))
    : null;

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
    route_simplified: routeSimplified,
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
  if (!(await businessWritesAllowed(env))) return 0;
  // A10 — 'off' (o sin configurar todavía, por defecto) significa "no crear sesiones": los
  // eventos quedan sin procesar (procesado_en sigue NULL) y se procesarán solos en cuanto el
  // vehículo pase a shadow/active — ningún dato se pierde, simplemente se deja de consolidar.
  if (modo === 'off' || !modo) return 0;
  const esSombra = modo === 'shadow';
  const filas = await env.DB.prepare(
    "SELECT id, tipo, payload, observado_en FROM telemetry_events_short_retention " +
    "WHERE vin = ? AND tipo IN ('trip_started','trip_finished') AND procesado_en IS NULL " +
    'ORDER BY observado_en ASC, id ASC LIMIT 200'
  ).bind(vin).all();
  const eventos = (filas.results || []).map(function (f) {
    let payload = {};
    try { payload = JSON.parse(f.payload); } catch (e) { /* payload corrupto: se trata como vacío, nunca se rompe el proceso */ }
    return { id: f.id, tipo: f.tipo, observado_en: f.observado_en, payload };
  });
  assertUnambiguousLifecycle(eventos, 'trip_started', 'trip_finished');
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
    const existingCanonical = await env.DB.prepare('SELECT * FROM trips WHERE id=?').bind(trip.id).first();
    const decision = reconcileCanonical(existingCanonical, trip);
    const inserted = decision.status === 'create' ? await env.DB.prepare(
      'INSERT INTO trips (id, vin, started_at, ended_at, start_odometer_km, end_odometer_km, distance_km, duration_min, ' +
      'start_soc_pct, end_soc_pct, start_energy_remaining_kwh, end_energy_remaining_kwh, energy_used_kwh, energy_source, consumption_is_estimated, ' +
      'start_lat, start_lng, end_lat, end_lng, start_location_id, end_location_id, route_simplified, ' +
      'classification, classification_source, classification_rule_id, data_quality, source, is_shadow, created_at, updated_at) ' +
      'SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE 1=1' + BUSINESS_WRITE_GUARD + ' ' +
      'ON CONFLICT(id) DO NOTHING' // reprocesar los mismos eventos nunca duplica ni pisa una corrección manual
    ).bind(
      trip.id, trip.vin, trip.started_at, trip.ended_at, trip.start_odometer_km, trip.end_odometer_km,
      trip.distance_km, trip.duration_min, trip.start_soc_pct, trip.end_soc_pct,
      trip.start_energy_remaining_kwh, trip.end_energy_remaining_kwh, trip.energy_used_kwh, trip.energy_source, trip.consumption_is_estimated,
      trip.start_lat, trip.start_lng,
      trip.end_lat, trip.end_lng, trip.start_location_id, trip.end_location_id, trip.route_simplified, trip.classification,
      trip.classification_source, trip.classification_rule_id, trip.data_quality, trip.source, trip.is_shadow, trip.created_at, trip.updated_at
    ).run() : {meta:{changes:0}};
    if (inserted.meta?.changes !== 1 && !(await businessWritesAllowed(env))) return 0;
    if (decision.status !== 'tombstone' && existingCanonical?.manual_override == null && pendiente) {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO pending_actions (id, vin, tipo, referencia_tabla, referencia_id, detalle, created_at) VALUES (?,?,?,?,?,?,?)'
      ).bind(pendiente.id, pendiente.vin, pendiente.tipo, pendiente.referencia_tabla, pendiente.referencia_id, pendiente.detalle, pendiente.created_at).run();
    }
    if (inserted.meta?.changes === 1 && reglaUsada) {
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
  else if (acKwh === 0) { energyKwh = 0; energySource = 'ac_energy_in'; chargingCurrentType = 'AC'; }
  else if (dcKwh === 0) { energyKwh = 0; energySource = 'dc_energy_added'; chargingCurrentType = 'DC'; }

  const duracionMin = Math.round((new Date(eventoFin.observado_en).getTime() - new Date(eventoInicio.observado_en).getTime()) / 60000);

  // B11: max_power_kw/average_power_kw a partir del HISTORIAL real de muestras de potencia
  // (power_snapshots) dentro de [started_at, ended_at] — nunca a partir de solo los 2 puntos de
  // inicio/fin (ver agregarPotenciaEnVentana). contexto.potenciaSnapshots es opcional: si no se
  // pasa (p.ej. tests antiguos que no lo necesitan), se trata como "sin muestras" -> ambos null.
  const potencia = agregarPotenciaEnVentana(contexto.potenciaSnapshots || [], eventoInicio.observado_en, eventoFin.observado_en);

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
    max_power_kw: potencia.max_power_kw,
    average_power_kw: potencia.average_power_kw,
    power_samples_count: potencia.power_samples_count,
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
  if (!(await businessWritesAllowed(env))) return 0;
  if (modo === 'off' || !modo) return 0;
  const esSombra = modo === 'shadow';
  const filas = await env.DB.prepare(
    "SELECT id, tipo, payload, observado_en FROM telemetry_events_short_retention " +
    "WHERE vin = ? AND tipo IN ('charge_started','charge_stopped') AND procesado_en IS NULL " +
    'ORDER BY observado_en ASC, id ASC LIMIT 200'
  ).bind(vin).all();
  const eventos = (filas.results || []).map(function (f) {
    let payload = {};
    try { payload = JSON.parse(f.payload); } catch (e) { /* payload corrupto: se trata como vacío */ }
    return { id: f.id, tipo: f.tipo, observado_en: f.observado_en, payload };
  });
  assertUnambiguousLifecycle(eventos, 'charge_started', 'charge_stopped');
  const { pares } = emparejarEventosEnCargas(eventos);
  if (pares.length === 0) return 0;

  const ubicacionesRes = await env.DB.prepare('SELECT * FROM locations WHERE vin = ?').bind(vin).all();
  const ubicaciones = ubicacionesRes.results || [];
  const reglasRes = await env.DB.prepare("SELECT * FROM automation_rules WHERE vin = ? AND tipo = 'precio_carga'").bind(vin).all();
  const reglas = reglasRes.results || [];

  // B11: historial de muestras de potencia dentro de la ventana de las sesiones a cerrar (mismo
  // margen de 20 min que usa el motor de viajes para odómetro/batería).
  const inicioVentana = new Date(new Date(pares[0].inicio.observado_en).getTime() - 20 * 60 * 1000).toISOString();
  const finVentana = new Date(new Date(pares[pares.length - 1].fin.observado_en).getTime() + 20 * 60 * 1000).toISOString();
  const potRes = await env.DB.prepare(
    'SELECT power_kw, observado_en FROM power_snapshots WHERE vin = ? AND observado_en BETWEEN ? AND ?'
  ).bind(vin, inicioVentana, finVentana).all();
  const potenciaSnapshots = potRes.results || [];

  const ahoraIso = new Date().toISOString();
  let cerradas = 0;
  for (const par of pares) {
    const { carga, pendiente, reglaUsada } = construirCargaDesdeEventos(vin, par.inicio, par.fin, { ubicaciones, reglas, ahoraIso, esSombra, potenciaSnapshots });
    const existingCanonical = await env.DB.prepare('SELECT * FROM charging_sessions WHERE id=?').bind(carga.id).first();
    const decision = reconcileCanonical(existingCanonical, carga);
    const inserted = decision.status === 'create' ? await env.DB.prepare(
      'INSERT INTO charging_sessions (id, vin, started_at, ended_at, start_soc_pct, end_soc_pct, start_odometer_km, ' +
      'energy_kwh, energy_source, charging_current_type, duration_min, max_power_kw, average_power_kw, power_samples_count, ' +
      'lat, lng, location_id, total_cost, cost_source, ' +
      'price_rule_id, data_quality, source, is_shadow, created_at, updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE 1=1' + BUSINESS_WRITE_GUARD + ' ' +
      'ON CONFLICT(id) DO NOTHING'
    ).bind(
      carga.id, carga.vin, carga.started_at, carga.ended_at, carga.start_soc_pct, carga.end_soc_pct, carga.start_odometer_km,
      carga.energy_kwh, carga.energy_source, carga.charging_current_type, carga.duration_min,
      carga.max_power_kw, carga.average_power_kw, carga.power_samples_count,
      carga.lat, carga.lng, carga.location_id, carga.total_cost, carga.cost_source, carga.price_rule_id, carga.data_quality, carga.source,
      carga.is_shadow, carga.created_at, carga.updated_at
    ).run() : {meta:{changes:0}};
    if (inserted.meta?.changes !== 1 && !(await businessWritesAllowed(env))) return 0;
    if (decision.status !== 'tombstone' && existingCanonical?.manual_override == null && pendiente) {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO pending_actions (id, vin, tipo, referencia_tabla, referencia_id, detalle, created_at) VALUES (?,?,?,?,?,?,?)'
      ).bind(pendiente.id, pendiente.vin, pendiente.tipo, pendiente.referencia_tabla, pendiente.referencia_id, pendiente.detalle, pendiente.created_at).run();
    }
    if (inserted.meta?.changes === 1 && reglaUsada) {
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
  if (!(await businessWritesAllowed(env))) return 0;
  const fetchImpl = (opciones && opciones.fetchImpl) || fetch;
  const esperaMs = (opciones && opciones.esperaMs) != null ? opciones.esperaMs : ESPERA_ENTRE_PETICIONES_MS;
  const timeoutMs = (opciones && opciones.timeoutMs) != null ? opciones.timeoutMs : TIMEOUT_MS;
  const filas = await env.DB.prepare(
    'SELECT id, vin, start_lat, start_lng, end_lat, end_lng, start_location_id, end_location_id, ' +
    'start_location_raw, end_location_raw, started_at, weather, revision, deleted_at, manual_override ' +
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
    if (trip.deleted_at != null || trip.manual_override != null) continue;
    let cambios = {};
    const lugares = lugaresPorVin.get(trip.vin) || new Map();
    try {
      if (trip.start_location_raw == null && typeof trip.start_lat === 'number') {
        if (trip.start_location_id && lugares.has(trip.start_location_id)) {
          cambios.start_location_raw = lugares.get(trip.start_location_id);
        } else {
          const nombre = await nombreParaCoordenada(trip.start_lat, trip.start_lng);
          if (nombre) cambios.start_location_raw = nombre;
        }
      }
      if (trip.end_location_raw == null && typeof trip.end_lat === 'number') {
        if (trip.end_location_id && lugares.has(trip.end_location_id)) {
          cambios.end_location_raw = lugares.get(trip.end_location_id);
        } else {
          const nombre = await nombreParaCoordenada(trip.end_lat, trip.end_lng);
          if (nombre) cambios.end_location_raw = nombre;
        }
      }
      if (trip.weather == null && typeof trip.start_lat === 'number' && trip.started_at) {
        const r = await fetchConTimeoutInyectable(fetchImpl, construirUrlOpenMeteo(trip.start_lat, trip.start_lng, trip.started_at), {}, timeoutMs);
        if (r.ok) { const j = await r.json(); const clima = extraerResumenClima(j, trip.started_at); if (clima) cambios.weather = JSON.stringify(clima); }
      }
    } catch (e) {
      console.error('enriquecimiento_viaje_exception', trip.id, String(e));
      // Se sigue con el resto del lote — un fallo de red (o timeout) en un viaje no debe tirar los demás.
    }
    if (Object.keys(cambios).length > 0) {
      const set = Object.keys(cambios).map((c) => c + ' = ?').join(', ');
      await env.DB.prepare('UPDATE trips SET ' + set + ', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL AND manual_override IS NULL' + BUSINESS_WRITE_GUARD)
        .bind(...Object.values(cambios), new Date().toISOString(), trip.id, trip.revision).run();
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
/** B16: añade push_sent_at/categoria a `alerts` si todavía no existen — igual de defensivo que el
 *  CREATE TABLE IF NOT EXISTS que ya usaba /push/suscribir, para que esto funcione en cuanto D1 esté
 *  configurado SIN depender de que se haya aplicado la migración 0005 primero (mismo criterio que
 *  el resto de columnas "capa base" de esta app). Ignora en silencio el único error esperado
 *  ("la columna ya existe" — se comprueba antes de nada más). */
async function asegurarColumnasPushEnAlerts(env) {
  for (const alterSql of ['ALTER TABLE alerts ADD COLUMN push_sent_at TEXT', 'ALTER TABLE alerts ADD COLUMN categoria TEXT']) {
    try { await env.DB.exec(alterSql); } catch (e) { /* ya existe (migración 0005 aplicada, o llamada anterior en esta misma sesión) */ }
  }
}

async function generarAlertaSiProcede(env, vin, regla, dedupeKey, severity, mensaje, cooldownHoras, categoria) {
  await asegurarColumnasPushEnAlerts(env);
  const ahoraIso = new Date().toISOString();
  const ultima = await env.DB.prepare(
    'SELECT id, created_at, resolved_at FROM alerts WHERE vin = ? AND dedupe_key = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(vin, dedupeKey).first();
  if (ultima && !ultima.resolved_at) {
    const horasDesde = (Date.now() - new Date(ultima.created_at).getTime()) / 3600000;
    if (horasDesde < (cooldownHoras || 24)) return false; // ya hay una abierta y reciente: no duplicar
  }
  // B16: `categoria` es opcional (retrocompatible con las llamadas de 7 argumentos ya existentes,
  // p.ej. en los tests de la Fase 4E) — sin categoría explícita, enviarPushesAlertasPendientes()
  // la deriva de CATEGORIA_POR_REGLA[regla] al enviar el push, así que nunca queda sin categoría.
  await env.DB.prepare(
    'INSERT INTO alerts (id, vin, rule, dedupe_key, severity, mensaje, created_at, categoria) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(idDeterministico(vin, 'alerta', dedupeKey + '|' + ahoraIso.slice(0, 13)), vin, regla, dedupeKey, severity, mensaje, ahoraIso, categoria || null).run();
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
      24, 'anomalia'
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
      12, 'sync_fallida'
    );
  }
  return false;
}

/** B15: compara la última presión conocida de cada neumático (vehicle_snapshots, TPMS real vía
 *  Fleet Telemetry) contra el umbral que el usuario haya fijado para ese vehículo. Sin umbral
 *  configurado, no comprueba nada — nunca asume un valor "seguro" genérico (la presión de placard
 *  varía por versión/neumático). Una sola alerta combinada (no una por rueda) para no saturar de
 *  notificaciones cuando varias ruedas bajan a la vez (p. ej. frío repentino). */
async function comprobarPresionNeumaticos(env, vin) {
  const umbral = await obtenerUmbralTpms(env, vin);
  if (umbral === null) return false;
  const snapshot = await env.DB.prepare('SELECT tpms_fl_bar, tpms_fr_bar, tpms_rl_bar, tpms_rr_bar, observado_en FROM vehicle_snapshots WHERE vin = ?').bind(vin).first();
  if (!snapshot) return false;
  const RUEDAS = { tpms_fl_bar: 'delantera izquierda', tpms_fr_bar: 'delantera derecha', tpms_rl_bar: 'trasera izquierda', tpms_rr_bar: 'trasera derecha' };
  const bajas = Object.keys(RUEDAS).filter((campo) => typeof snapshot[campo] === 'number' && snapshot[campo] < umbral);
  if (bajas.length === 0) return false;
  const detalle = bajas.map((campo) => RUEDAS[campo] + ' (' + snapshot[campo].toFixed(2) + ' bar)').join(', ');
  return generarAlertaSiProcede(
    env, vin, 'tpms_baja', 'tpms_baja', 'accion',
    'Presión de neumático baja (umbral ' + umbral + ' bar): ' + detalle + '.',
    12, 'tpms_baja'
  );
}

/* ---------- B16 (FASE B): Web Push REAL — VAPID, cifrado del payload (RFC 8291), envío, dedupe,
 * categorías y click. Antes de esta sesión solo existía la "capa base" (guardar/borrar la
 * PushSubscription en D1, ver /push/suscribir más abajo) — nunca se firmaba un JWT VAPID de verdad
 * ni se cifraba ni se mandaba ningún push. Todo lo de aquí abajo es Web Crypto API puro (disponible
 * nativamente en el runtime de Cloudflare Workers, sin dependencias/npm — cumple la norma de "no
 * introduzcas frameworks" y el objetivo de 0€/mes) y se puede probar sin red real ni un servicio de
 * push de verdad: el propio test cifra con esta misma función y luego DESCIFRA con una
 * reimplementación independiente del lado "navegador" del RFC, y verifica el JWT con la clave
 * pública — es una comprobación real de la criptografía, no solo "no lanza una excepción".
 * ---------------------------------------------------------------------------------------------- */

function base64UrlAUint8Array(b64url) {
  const b64 = String(b64url).replace(/-/g, '+').replace(/_/g, '/');
  const relleno = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const crudo = atob(b64 + relleno);
  const arr = new Uint8Array(crudo.length);
  for (let i = 0; i < crudo.length; i++) arr[i] = crudo.charCodeAt(i);
  return arr;
}
function uint8ArrayABase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrs) { out.set(a, offset); offset += a.length; }
  return out;
}
async function hmacSha256(claveBytes, datosBytes) {
  const clave = await crypto.subtle.importKey('raw', claveBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', clave, datosBytes));
}
// HKDF (RFC 5869), Extract y Expand por separado — aquí nunca hace falta más de un bloque HMAC de
// salida (todas las longitudes pedidas son ≤32 bytes), así que Expand se simplifica a T1 = HMAC(PRK,
// info || 0x01), sin necesidad de encadenar T1..Tn (mismo enfoque que usan las librerías de
// referencia de Web Push, p. ej. el paquete npm "web-push").
async function hkdfExtract(salt, ikm) { return hmacSha256(salt, ikm); }
async function hkdfExpand(prk, info, longitud) {
  const t1 = await hmacSha256(prk, concatBytes(info, new Uint8Array([1])));
  return t1.slice(0, longitud);
}

/** Genera un par de claves VAPID (ECDSA P-256) nuevo. Nunca se llama si ya existe una configuración
 *  guardada (ver asegurarConfigPush) — regenerar las claves invalidaría TODAS las suscripciones ya
 *  guardadas (el navegador las firma contra la clave pública con la que se suscribió). */
async function generarClavesVapid() {
  const par = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwkPrivada = await crypto.subtle.exportKey('jwk', par.privateKey);
  const rawPublica = new Uint8Array(await crypto.subtle.exportKey('raw', par.publicKey)); // punto sin comprimir, 65 bytes
  return { publicKeyB64: uint8ArrayABase64Url(rawPublica), privateKeyJwk: jwkPrivada };
}

/** Lee la configuración VAPID ya guardada (fila única, id='default'), o null si nunca se generó. */
async function obtenerConfigPush(env) {
  if (!env.DB) return null;
  await env.DB.exec(
    'CREATE TABLE IF NOT EXISTS push_config (id TEXT PRIMARY KEY, public_key_b64 TEXT NOT NULL, private_key_jwk TEXT NOT NULL, subject TEXT NOT NULL, created_at TEXT NOT NULL)'
  );
  return await env.DB.prepare('SELECT public_key_b64, private_key_jwk, subject FROM push_config WHERE id = ?').bind('default').first();
}
/** Idempotente: crea las claves VAPID SOLO si no existen todavía, y devuelve siempre la MISMA
 *  configuración en llamadas repetidas (incluso concurrentes: el INSERT usa ON CONFLICT DO NOTHING
 *  y se relee después, así dos peticiones simultáneas nunca acaban con dos pares de claves distintos
 *  compitiendo por las mismas suscripciones ya guardadas). */
async function asegurarConfigPush(env, subject) {
  const existente = await obtenerConfigPush(env);
  if (existente) return existente;
  const { publicKeyB64, privateKeyJwk } = await generarClavesVapid();
  await env.DB.prepare(
    'INSERT INTO push_config (id, public_key_b64, private_key_jwk, subject, created_at) VALUES (?,?,?,?,?) ' +
    'ON CONFLICT(id) DO NOTHING'
  ).bind('default', publicKeyB64, JSON.stringify(privateKeyJwk), subject, new Date().toISOString()).run();
  return await obtenerConfigPush(env);
}

/** Firma un JWT VAPID (RFC 8292, ES256) para el `audience` (origen del servicio de push del
 *  navegador — Firefox/Chrome/etc., NO el nuestro) — válido 12h, muy por encima de lo que tarda en
 *  procesarse un envío, pero corto para que una clave privada filtrada deje de servir pronto. */
async function firmarJwtVapid(privateKeyJwk, audience, subject) {
  const clavePrivada = await crypto.subtle.importKey('jwk', privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const cabecera = { typ: 'JWT', alg: 'ES256' };
  const ahoraS = Math.floor(Date.now() / 1000);
  const claims = { aud: audience, exp: ahoraS + 12 * 3600, sub: subject };
  const cabeceraB64 = uint8ArrayABase64Url(new TextEncoder().encode(JSON.stringify(cabecera)));
  const claimsB64 = uint8ArrayABase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const firmante = cabeceraB64 + '.' + claimsB64;
  // Web Crypto devuelve la firma ECDSA ya en formato IEEE P1363 (r||s concatenados), que es
  // exactamente lo que exige JWS/ES256 — a diferencia de OpenSSL/Node "crypto" (DER), aquí NO hace
  // falta ninguna conversión de formato.
  const firma = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, clavePrivada, new TextEncoder().encode(firmante));
  return firmante + '.' + uint8ArrayABase64Url(new Uint8Array(firma));
}

/** Cifra `payloadObjeto` (se serializa a JSON) según RFC 8291 (Message Encryption for Web Push),
 *  formato "aes128gcm" (RFC 8188) — el único que exigen hoy los navegadores modernos. `p256dhB64` y
 *  `authB64` son las claves que da el propio navegador al suscribirse (PushSubscription.getKey).
 *  Genera un par de claves ECDH efímero NUEVO en cada llamada (nunca se reutiliza entre mensajes,
 *  tal y como exige el RFC) y devuelve el cuerpo binario listo para el POST al endpoint de push. */
async function cifrarPayloadWebPush(payloadObjeto, p256dhB64, authB64) {
  const uaPublicRaw = base64UrlAUint8Array(p256dhB64); // 65 bytes: punto público sin comprimir del suscriptor
  const authSecret = base64UrlAUint8Array(authB64); // 16 bytes

  const parEfimero = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', parEfimero.publicKey));

  const clavePublicaSuscriptor = await crypto.subtle.importKey('raw', uaPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secretoCompartido = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clavePublicaSuscriptor }, parEfimero.privateKey, 256));

  // RFC 8291 §3.4 — IKM combina el secreto ECDH con el "auth secret" que solo conoce el navegador
  // (evita que un tercero que solo vea las claves públicas pueda fabricar un push válido).
  const prkKey = await hkdfExtract(authSecret, secretoCompartido);
  const infoIkm = concatBytes(new TextEncoder().encode('WebPush: info\0'), uaPublicRaw, asPublicRaw);
  const ikm = await hkdfExpand(prkKey, infoIkm, 32);

  // RFC 8188 (aes128gcm): salt aleatorio por mensaje, clave de contenido (CEK) y nonce derivados del IKM.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  const payloadBytes = new TextEncoder().encode(JSON.stringify(payloadObjeto));
  // 0x02: delimitador de "este es el último (y único) registro" — RFC 8188 §2. Un solo push nunca
  // necesita más de un registro (el límite de tamaño de un push es ~4KB, muy por encima de lo que
  // manda esta app).
  const registro = concatBytes(payloadBytes, new Uint8Array([2]));

  const claveAes = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, claveAes, registro));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false); // record size (RFC8188): un único registro, valor arbitrario >= su longitud real
  const cabeceraCifrado = concatBytes(salt, rs, new Uint8Array([asPublicRaw.length]), asPublicRaw);
  return concatBytes(cabeceraCifrado, cifrado);
}

/** Manda un único push cifrado a una suscripción concreta. `fetchImpl` se inyecta para poder
 *  probarlo sin red real. Devuelve {ok, status} — nunca lanza por un push individual fallido (un
 *  dispositivo con el endpoint caducado no debe tirar el envío a los demás). */
async function enviarWebPush(fetchImpl, subscripcion, payloadObjeto, config, opciones) {
  const cuerpoCifrado = await cifrarPayloadWebPush(payloadObjeto, subscripcion.p256dh, subscripcion.auth);
  const audience = new URL(subscripcion.endpoint).origin;
  const jwt = await firmarJwtVapid(JSON.parse(config.private_key_jwk), audience, config.subject);
  const cabeceras = {
    Authorization: 'vapid t=' + jwt + ', k=' + config.public_key_b64,
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: String((opciones && opciones.ttlSegundos) || 86400)
  };
  const f = fetchImpl || fetch;
  const res = await f(subscripcion.endpoint, { method: 'POST', headers: cabeceras, body: cuerpoCifrado });
  return { ok: res.ok, status: res.status };
}

// B16: mismo catálogo de categorías que PUSH_CATEGORIAS en app.js — cada regla de alerta del motor
// server-side (Fase 4E) se etiqueta con UNA categoría, para que el usuario pueda desactivar por
// categoría sin desactivar Web Push entero. `seccion` es a dónde navega la PWA al pulsar la
// notificación (click, ver notificationclick en sw.js — ya leía payload/data.seccion desde antes
// de esta sesión, sin cambios necesarios ahí).
const CATEGORIA_POR_REGLA = { hueco_odometro: 'anomalia', silencio_telemetria: 'sync_fallida', tpms_baja: 'tpms_baja' };
const SECCION_POR_REGLA = { hueco_odometro: 'dashboard', silencio_telemetria: 'ajustes', tpms_baja: 'ajustes' };

/** B16 — categorías: sin preferencia guardada para el dispositivo, TODAS las categorías están
 *  activas (mismo criterio por defecto que cargarCategoriasPush() en el cliente); con preferencia
 *  guardada, se respeta explícitamente (false = esa categoría no se manda a ese dispositivo). */
function dispositivoQuierePush(subscripcion, categoria) {
  if (!subscripcion.categorias) return true;
  try {
    const prefs = JSON.parse(subscripcion.categorias);
    return prefs[categoria] !== false;
  } catch (e) {
    return true; // preferencia corrupta/ilegible: nunca silencia al usuario por un dato guardado mal
  }
}

/**
 * B16 — envío real: recorre las alertas SIN push mandado todavía (push_sent_at IS NULL) y SIN
 * resolver, y manda un push cifrado a cada dispositivo suscrito que quiera esa categoría. Dedupe de
 * ENVÍO: cada alerta se marca con push_sent_at nada más procesarla (se intente o no cada envío
 * individual con éxito) — así una alerta nunca genera un segundo push aunque este job se ejecute
 * dos veces sobre la misma fila (p.ej. un Cron Trigger solapado); el dedupe de CREACIÓN de la
 * alerta en sí ya lo hacía generarAlertaSiProcede desde la Fase 4E — son dos dedupes complementarios,
 * uno por "problema detectado" y otro por "aviso ya mandado". Un endpoint de suscripción caducado
 * (404/410 — el navegador ya no lo reconoce) borra esa suscripción, igual que recomienda el propio
 * estándar Web Push, para no seguir intentando enviarle nada.
 */
async function enviarPushesAlertasPendientes(env, opciones) {
  const fetchImpl = (opciones && opciones.fetchImpl) || fetch;
  await asegurarColumnasPushEnAlerts(env);
  const config = await obtenerConfigPush(env);
  if (!config) return { enviados: 0, alertas_procesadas: 0, motivo: 'vapid_no_configurado' }; // nunca se manda nada a medias sin claves VAPID reales
  const pendientes = await env.DB.prepare(
    'SELECT id, vin, rule, categoria, severity, mensaje FROM alerts WHERE push_sent_at IS NULL AND resolved_at IS NULL ORDER BY created_at ASC LIMIT 100'
  ).bind().all();
  const filasAlertas = pendientes.results || [];
  if (filasAlertas.length === 0) return { enviados: 0, alertas_procesadas: 0 };

  const subsRes = await env.DB.prepare('SELECT device_id, endpoint, p256dh, auth, categorias FROM push_subscriptions').bind().all();
  const suscripciones = subsRes.results || [];

  let enviados = 0;
  const ahoraIso = new Date().toISOString();
  for (const alerta of filasAlertas) {
    const categoria = alerta.categoria || CATEGORIA_POR_REGLA[alerta.rule] || 'anomalia';
    const seccion = SECCION_POR_REGLA[alerta.rule] || 'dashboard';
    const destinatarios = suscripciones.filter((s) => dispositivoQuierePush(s, categoria));
    for (const sub of destinatarios) {
      try {
        const r = await enviarWebPush(fetchImpl, sub, { title: 'Mi Tesla', body: alerta.mensaje, seccion, categoria }, config);
        if (r.status === 404 || r.status === 410) {
          await env.DB.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').bind(sub.device_id).run();
        } else if (r.ok) {
          enviados++;
        }
      } catch (e) {
        console.error('push_envio_exception', alerta.id, sub.device_id, String(e));
        // Un fallo de red/cifrado en UN dispositivo no debe impedir que se marque la alerta como
        // procesada para los demás, ni bloquear el resto del lote — se sigue con el siguiente.
      }
    }
    await env.DB.prepare('UPDATE alerts SET push_sent_at = ? WHERE id = ?').bind(ahoraIso, alerta.id).run();
  }
  return { enviados, alertas_procesadas: filasAlertas.length };
}

/* ---------- B14/B26/B27 (FASE B): backup completo (incluye D1) y variante anonimizada ----------
 * B26: hasta esta sesión, "Exportar datos" en Ajustes (btn-exportar) solo volcaba el localStorage
 * `DATOS` del propio navegador — nunca los datos que SOLO viven en D1 (viajes, cargas, ubicaciones,
 * reglas, pendientes, alertas, ajustes del vehículo, el último snapshot). Esta sección construye ese
 * volcado para que app.js lo fusione con el backup local, cayendo siempre a "solo local" si D1 no
 * está configurado o no responde (nunca bloquea la copia que ya funcionaba).
 * B14: `locations.privacy_level` existe en el esquema desde la Fase 4 ('oculta_en_exportaciones')
 * pero, hasta esta sesión, ningún código lo leía — era una columna inerte. `ubicacionEsPrivada`
 * la aplica de verdad, en CUALQUIER backup (también el privado): una ubicación así marcada, o de
 * categoría 'casa'/'trabajo', nunca sale con coordenadas precisas, y lo mismo para cualquier viaje/
 * carga enlazado a ella por *_location_id. El resto de la telemetría GPS ya tenía política de
 * retención documentada en la cabecera de d1/schema.sql (eventos crudos: purgarTelemetriaCruda, 7
 * días; trips/charging_sessions/odometer_snapshots: consolidados, para siempre) — no cambia aquí.
 * B27: modo 'anonimizado' extiende lo anterior a TODAS las ubicaciones (coordenadas difuminadas a
 * ~11 km, nunca exactas) y quita el VIN y cualquier texto libre que pueda llevar una dirección o
 * nota personal (start_location_raw/end_location_raw, manual_override, ubicacion_nombre).
 */
function ubicacionEsPrivada(location) {
  return !!location && (location.privacy_level === 'oculta_en_exportaciones' || location.category === 'casa' || location.category === 'trabajo');
}

function coordenadaCoarsen(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return { lat: lat, lng: lng };
  return { lat: Math.round(lat * 10) / 10, lng: Math.round(lng * 10) / 10 }; // ~11 km de resolución
}

function aplicarPrivacidadFilas(filas, camposLatLng, ubicacionesPorId, modo) {
  return filas.map(function (fila) {
    const copia = Object.assign({}, fila);
    camposLatLng.forEach(function (par) {
      const loc = par.idCampo ? ubicacionesPorId[copia[par.idCampo]] : null;
      if (ubicacionEsPrivada(loc)) {
        copia[par.lat] = null; copia[par.lng] = null;
      } else if (modo === 'anonimizado' && typeof copia[par.lat] === 'number') {
        const c = coordenadaCoarsen(copia[par.lat], copia[par.lng]);
        copia[par.lat] = c.lat; copia[par.lng] = c.lng;
      }
    });
    if (modo === 'anonimizado') {
      delete copia.vin;
      if ('start_location_raw' in copia) copia.start_location_raw = null;
      if ('end_location_raw' in copia) copia.end_location_raw = null;
      if ('manual_override' in copia) copia.manual_override = null;
    }
    return copia;
  });
}

async function construirBackupCompleto(env, vin, modo) {
  const modoReal = modo === 'anonimizado' ? 'anonimizado' : 'privado';
  const [locationsRes, tripsRes, cargasRes, reglasRes, pendientesRes, alertasRes, ajustesFila, snapshotFila] = await Promise.all([
    env.DB.prepare('SELECT * FROM locations WHERE vin = ?').bind(vin).all(),
    env.DB.prepare('SELECT * FROM trips WHERE vin = ?').bind(vin).all(),
    env.DB.prepare('SELECT * FROM charging_sessions WHERE vin = ?').bind(vin).all(),
    env.DB.prepare('SELECT * FROM automation_rules WHERE vin = ?').bind(vin).all(),
    env.DB.prepare('SELECT * FROM pending_actions WHERE vin = ?').bind(vin).all(),
    env.DB.prepare('SELECT * FROM alerts WHERE vin = ?').bind(vin).all(),
    env.DB.prepare('SELECT * FROM vehicle_settings WHERE vin = ?').bind(vin).first(),
    env.DB.prepare('SELECT * FROM vehicle_snapshots WHERE vin = ?').bind(vin).first()
  ]);

  const ubicacionesBrutas = locationsRes.results || [];
  const ubicacionesPorId = {};
  ubicacionesBrutas.forEach(function (l) { ubicacionesPorId[l.id] = l; });

  const locations = ubicacionesBrutas.map(function (l) {
    const copia = Object.assign({}, l);
    const privada = ubicacionEsPrivada(l);
    if (privada) { copia.lat = null; copia.lng = null; }
    else if (modoReal === 'anonimizado') { const c = coordenadaCoarsen(l.lat, l.lng); copia.lat = c.lat; copia.lng = c.lng; }
    if (modoReal === 'anonimizado') { delete copia.vin; if (privada) copia.name = '(oculto)'; }
    return copia;
  });

  const trips = aplicarPrivacidadFilas(tripsRes.results || [], [
    { idCampo: 'start_location_id', lat: 'start_lat', lng: 'start_lng' },
    { idCampo: 'end_location_id', lat: 'end_lat', lng: 'end_lng' }
  ], ubicacionesPorId, modoReal);

  const charging_sessions = aplicarPrivacidadFilas(cargasRes.results || [], [
    { idCampo: 'location_id', lat: 'lat', lng: 'lng' }
  ], ubicacionesPorId, modoReal);

  let vehicle_snapshot = snapshotFila ? Object.assign({}, snapshotFila) : null;
  if (vehicle_snapshot && modoReal === 'anonimizado') {
    delete vehicle_snapshot.vin;
    if (typeof vehicle_snapshot.lat === 'number') {
      const c = coordenadaCoarsen(vehicle_snapshot.lat, vehicle_snapshot.lng);
      vehicle_snapshot.lat = c.lat; vehicle_snapshot.lng = c.lng;
    }
    vehicle_snapshot.ubicacion_nombre = null;
  }

  let vehicle_settings = ajustesFila ? Object.assign({}, ajustesFila) : null;
  let automation_rules = (reglasRes.results || []).map(function (r) { return Object.assign({}, r); });
  let pending_actions = (pendientesRes.results || []).map(function (p) { return Object.assign({}, p); });
  let alerts = (alertasRes.results || []).map(function (a) { return Object.assign({}, a); });
  if (modoReal === 'anonimizado') {
    if (vehicle_settings) delete vehicle_settings.vin;
    automation_rules.forEach(function (r) { delete r.vin; });
    pending_actions.forEach(function (p) { delete p.vin; });
    alerts.forEach(function (a) { delete a.vin; });
  }

  const resultado = {
    modo: modoReal,
    generado_en: new Date().toISOString(),
    locations: locations,
    trips: trips,
    charging_sessions: charging_sessions,
    automation_rules: automation_rules,
    pending_actions: pending_actions,
    alerts: alerts,
    vehicle_settings: vehicle_settings,
    vehicle_snapshot: vehicle_snapshot
  };
  if (modoReal !== 'anonimizado') resultado.vin = vin;
  return resultado;
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
      if (await comprobarPresionNeumaticos(env, v.vin)) alertasCreadas++;
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
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
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
    if (k === 'ADMIN_TOKEN' ? (typeof env[k] !== 'string' || !env[k].trim()) : !env[k]) faltan.push(k);
  });
  if (!origenesPermitidos(env).length) faltan.push('ALLOWED_ORIGIN');
  if (!env.TESLA_TOKENS) faltan.push('TESLA_TOKENS (KV binding)');
  return faltan;
}

// Shared fail-closed admin policy; permanent secrets are never accepted in URLs.
export function adminAuthentication(request, env) {
  const secret = env.ADMIN_TOKEN;
  if (typeof secret !== 'string' || secret.trim().length === 0) {
    return { ok: false, status: 503, error: 'admin_config_invalid' };
  }
  const header = request.headers.get('Authorization');
  // Exact case-sensitive scheme, one space, nonempty RFC6750 token alphabet.
  const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/.exec(header) : null;
  if (!match || !timingSafeEqual(match[1], secret)) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true, status: 200 };
}
async function autenticado(request, env) { return (await sessionAuthentication(request, env)).ok; }
async function adminFailureStatus(request, env) { return (await sessionAuthentication(request, env)).status; }
async function adminFailureError(request, env) { return (await sessionAuthentication(request, env)).error; }

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
  recortarRutaPrivada,
  emparejarEventosEnCargas, calcularCosteConReglas, construirCargaDesdeEventos, procesarCargasPendientes, agregarPotenciaEnVentana,
  construirUrlNominatim, extraerNombreLugar, construirUrlOpenMeteo, extraerResumenClima, enriquecerViajesPendientes,
  generarAlertaSiProcede, comprobarHuecoOdometro, comprobarSilencioTelemetria, ejecutarComprobacionesDeSalud,
  comprobarPresionNeumaticos, obtenerUmbralTpms, fijarUmbralTpms,
  purgarTelemetriaCruda,
  ubicacionEsPrivada, coordenadaCoarsen, construirBackupCompleto,
  // FASE A (auditoría externa 2026-09-20) — funciones puras añadidas/revisadas, exportadas para tests:
  vinFormatoValido, validarPayloadTelemetria, obtenerAutomationMode, fijarAutomationMode,
  actualizarUsageCounters, actualizarHeartbeat, vinAutorizado, autorizarVinEnAllowlist,
  adquirirLockRefresh, liberarLockRefresh,
  // B16 (FASE B) — Web Push real: funciones exportadas para tests
  base64UrlAUint8Array, uint8ArrayABase64Url, generarClavesVapid, firmarJwtVapid, cifrarPayloadWebPush,
  enviarWebPush, dispositivoQuierePush, enviarPushesAlertasPendientes, obtenerConfigPush, asegurarConfigPush,
  CATEGORIA_POR_REGLA, SECCION_POR_REGLA
};


/* ---------- DATA_CANONICAL: CRUD con lifecycle/revision sobre sesiones consolidadas ---------- */

const CANONICAL_CONFIG = {
  viajes: {
    table: 'trips',
    responseKey: 'viajes',
    mutable: new Set([
      'started_at', 'ended_at', 'start_odometer_km', 'end_odometer_km', 'distance_km', 'duration_min',
      'start_soc_pct', 'end_soc_pct', 'start_energy_remaining_kwh', 'end_energy_remaining_kwh',
      'energy_used_kwh', 'energy_source', 'consumption_is_estimated',
      'start_lat', 'start_lng', 'end_lat', 'end_lng', 'start_location_id', 'end_location_id',
      'start_location_raw', 'end_location_raw', 'outside_temp_start', 'outside_temp_end',
      'classification', 'classification_source', 'classification_rule_id', 'manual_override',
      'data_quality', 'source', 'is_shadow', 'route_simplified', 'weather'
    ]),
    requiredCreate: ['id', 'vin', 'started_at', 'source']
  },
  cargas: {
    table: 'charging_sessions',
    responseKey: 'cargas',
    mutable: new Set([
      'started_at', 'ended_at', 'start_soc_pct', 'end_soc_pct', 'start_odometer_km',
      'energy_kwh', 'energy_source', 'charging_current_type', 'charger_type',
      'fast_charger_present', 'fast_charger_type', 'max_power_kw', 'average_power_kw',
      'power_samples_count', 'duration_min', 'lat', 'lng', 'location_id', 'total_cost',
      'cost_source', 'price_rule_id', 'tesla_invoice_id', 'manual_override', 'data_quality',
      'source', 'is_shadow'
    ]),
    requiredCreate: ['id', 'vin', 'started_at', 'source']
  }
};

// C1: server authority. Transitions are internal operations, never an HTTP PATCH.
const AUTHORITIES = ['LEGACY','PREPARED','IMPORTING','VERIFYING','CANONICAL'];
export async function readAuthority(env) {
  const row = await env.DB.prepare("SELECT value, updated_at FROM system_state WHERE key = 'data_authority'").first();
  if (!row || !AUTHORITIES.includes(row.value)) throw new Error('invalid_authority_state');
  return { authority: row.value, updatedAt: row.updated_at };
}
export async function transitionAuthority(env, from, to) {
  const edges = { LEGACY:['PREPARED'], PREPARED:['IMPORTING'], IMPORTING:['VERIFYING','PREPARED'], VERIFYING:['CANONICAL','PREPARED'], CANONICAL:[] };
  if (!edges[from]?.includes(to)) throw new Error('invalid_authority_transition');
  const r = await env.DB.prepare("UPDATE system_state SET value=?, updated_at=? WHERE key='data_authority' AND value=?").bind(to,new Date().toISOString(),from).run();
  if (r.meta?.changes !== 1) throw new Error('authority_conflict');
  return readAuthority(env);
}
// Only explicit non-trip/charge branches from datosVaciosIniciales are allowed after freeze.
export const LEGACY_SYNC_ALLOWED_KEYS = ['schema_version','data_mode','vehiculo','referencia_gasolina','bateria_historico','gastos','recordatorios','neumaticos','accesorios','seguro','itv','planes','favoritos','plantillas_viaje','neumaticos_historico','mantenimiento','documentos'];
export function filterLegacySyncPayload(datos, authority) {
  if (!AUTHORITIES.includes(authority)) throw new Error('invalid_authority_state');
  if (authority==='LEGACY' || authority==='PREPARED') return {datos,ignoredBusinessKeys:[]};
  const out = {}, ignoredBusinessKeys = [];
  for (const key of Object.keys(datos)) {
    if (LEGACY_SYNC_ALLOWED_KEYS.includes(key)) out[key] = datos[key];
    else ignoredBusinessKeys.push(key);
  }
  // Nested deletion metadata must not smuggle trip/charge tombstones.
  if (datos._borrados && typeof datos._borrados==='object') {
    out._borrados = {};
    for (const key of Object.keys(datos._borrados)) {
      if (LEGACY_SYNC_ALLOWED_KEYS.includes(key)) out._borrados[key] = datos._borrados[key];
      else ignoredBusinessKeys.push('_borrados.'+key);
    }
  }
  return {datos:out,ignoredBusinessKeys};
}

function canonicalJsonValue(field, value) {
  if ((field === 'manual_override' || field === 'route_simplified' || field === 'weather') && value !== null && typeof value !== 'string') {
    return JSON.stringify(value);
  }
  return value;
}

function canonicalPublicRow(row) {
  if (!row) return row;
  const out = Object.assign({}, row);
  for (const field of ['manual_override', 'route_simplified', 'weather']) {
    if (typeof out[field] === 'string') {
      try { out[field] = JSON.parse(out[field]); } catch (e) { /* conservar texto legacy */ }
    }
  }
  return out;
}

function canonicalError(code, status, requestId, extra) {
  return jsonError(code, status, requestId, extra);
}

async function canonicalExistingById(env, cfg, id) {
  return await env.DB.prepare('SELECT * FROM ' + cfg.table + ' WHERE id = ?').bind(id).first();
}

async function canonicalList(env, cfg, vin, limite, cursor) {
  const res = await env.DB.prepare(
    'SELECT * FROM ' + cfg.table + ' WHERE vin = ? AND deleted_at IS NULL AND is_shadow = 0 AND id > ? ORDER BY id ASC LIMIT ?'
  ).bind(vin, cursor || '', limite + 1).all();
  const rows = res.results || [], more = rows.length > limite;
  const items = rows.slice(0,limite).map(canonicalPublicRow);
  return {items,nextCursor:more ? items[items.length-1].id : null};
}

export const BUSINESS_WRITE_GUARD = " AND EXISTS (SELECT 1 FROM system_state WHERE key='data_authority' AND value IN ('LEGACY','PREPARED','CANONICAL'))";
const CANONICAL_WRITE_GUARD = BUSINESS_WRITE_GUARD;
export async function businessWritesAllowed(env) {
  return ['LEGACY','PREPARED','CANONICAL'].includes((await readAuthority(env)).authority);
}
async function canonicalWriteFailure(env,requestId) {
  const state = await readAuthority(env);
  return {error:canonicalError(['IMPORTING','VERIFYING'].includes(state.authority)?'migration_locked':'revision_conflict',['IMPORTING','VERIFYING'].includes(state.authority)?423:409,requestId,state)};
}
async function canonicalCreate(env, cfg, body, requestId) {
  if (!body || typeof body !== 'object') return { error: canonicalError('invalid_request', 400, requestId) };
  for (const field of cfg.requiredCreate) {
    if (!Object.prototype.hasOwnProperty.call(body, field) || body[field] === null || body[field] === '') {
      return { error: canonicalError('invalid_entity', 422, requestId, { field }) };
    }
  }
  const existing = await canonicalExistingById(env, cfg, body.id);
  if (existing) {
    return { error: canonicalError(existing.deleted_at ? 'tombstoned_id' : 'id_collision', 409, requestId, { currentRevision: existing.revision }) };
  }
  const now = new Date().toISOString();
  const fields = ['id', 'vin'];
  const values = [body.id, body.vin];
  for (const field of cfg.mutable) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      fields.push(field);
      values.push(canonicalJsonValue(field, body[field]));
    }
  }
  fields.push('revision', 'deleted_at', 'created_at', 'updated_at');
  values.push(1, null, now, now);
  const placeholders = fields.map(function () { return '?'; }).join(',');
  const inserted = await env.DB.prepare('INSERT INTO ' + cfg.table + ' (' + fields.join(',') + ') SELECT ' + placeholders + ' WHERE 1=1' + CANONICAL_WRITE_GUARD).bind(...values).run();
  if(inserted.meta?.changes !== 1) return canonicalWriteFailure(env,requestId);
  return { entity: canonicalPublicRow(await canonicalExistingById(env, cfg, body.id)) };
}

async function canonicalPatch(env, cfg, id, body, requestId) {
  if (!body || typeof body !== 'object' || !Number.isInteger(body.expectedRevision) || !body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) {
    return { error: canonicalError('invalid_request', 400, requestId) };
  }
  const current = await canonicalExistingById(env, cfg, id);
  if (!current) return { error: canonicalError('not_found', 404, requestId) };
  if (current.deleted_at) return { error: canonicalError('entity_deleted', 409, requestId, { currentRevision: current.revision }) };
  if (current.revision !== body.expectedRevision) {
    return { error: canonicalError('revision_conflict', 409, requestId, { currentRevision: current.revision, current: canonicalPublicRow(current) }) };
  }
  const sets = [];
  const values = [];
  for (const [field, rawValue] of Object.entries(body.patch)) {
    if (!cfg.mutable.has(field)) return { error: canonicalError('invalid_entity', 422, requestId, { field }) };
    sets.push(field + ' = ?');
    values.push(canonicalJsonValue(field, rawValue));
  }
  if (sets.length === 0) return { entity: canonicalPublicRow(current) };
  const now = new Date().toISOString();
  sets.push('revision = revision + 1', 'updated_at = ?');
  values.push(now, id, body.expectedRevision);
  const result = await env.DB.prepare(
    'UPDATE ' + cfg.table + ' SET ' + sets.join(', ') + ' WHERE id = ? AND revision = ? AND deleted_at IS NULL' + CANONICAL_WRITE_GUARD
  ).bind(...values).run();
  if (!result.meta || result.meta.changes !== 1) {
    if(['IMPORTING','VERIFYING'].includes((await readAuthority(env)).authority)) return canonicalWriteFailure(env,requestId);
    const latest = await canonicalExistingById(env, cfg, id);
    if (!latest) return { error: canonicalError('not_found', 404, requestId) };
    if (latest.deleted_at) return { error: canonicalError('entity_deleted', 409, requestId, { currentRevision: latest.revision }) };
    return { error: canonicalError('revision_conflict', 409, requestId, { currentRevision: latest.revision, current: canonicalPublicRow(latest) }) };
  }
  return { entity: canonicalPublicRow(await canonicalExistingById(env, cfg, id)) };
}

async function canonicalDelete(env, cfg, id, body, requestId) {
  if (!body || typeof body !== 'object' || !Number.isInteger(body.expectedRevision)) return { error: canonicalError('invalid_request', 400, requestId) };
  const current = await canonicalExistingById(env, cfg, id);
  if (!current) return { error: canonicalError('not_found', 404, requestId) };
  if (current.deleted_at) return { error: canonicalError('entity_deleted', 409, requestId, { currentRevision: current.revision }) };
  if (current.revision !== body.expectedRevision) return { error: canonicalError('revision_conflict', 409, requestId, { currentRevision: current.revision, current: canonicalPublicRow(current) }) };
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    'UPDATE ' + cfg.table + ' SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL' + CANONICAL_WRITE_GUARD
  ).bind(now, now, id, body.expectedRevision).run();
  if (!result.meta || result.meta.changes !== 1) return canonicalWriteFailure(env,requestId);
  return { entity: canonicalPublicRow(await canonicalExistingById(env, cfg, id)) };
}

async function canonicalRestore(env, cfg, id, body, requestId) {
  if (!body || typeof body !== 'object' || !Number.isInteger(body.expectedRevision)) return { error: canonicalError('invalid_request', 400, requestId) };
  const current = await canonicalExistingById(env, cfg, id);
  if (!current) return { error: canonicalError('not_found', 404, requestId) };
  if (!current.deleted_at) return { error: canonicalError('invalid_entity', 422, requestId, { reason: 'entity_not_deleted' }) };
  if (current.revision !== body.expectedRevision) return { error: canonicalError('revision_conflict', 409, requestId, { currentRevision: current.revision, current: canonicalPublicRow(current) }) };
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    'UPDATE ' + cfg.table + ' SET deleted_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NOT NULL' + CANONICAL_WRITE_GUARD
  ).bind(now, id, body.expectedRevision).run();
  if (!result.meta || result.meta.changes !== 1) return canonicalWriteFailure(env,requestId);
  return { entity: canonicalPublicRow(await canonicalExistingById(env, cfg, id)) };
}

async function handleCanonicalRequest(request, env, url, requestId) {
  const m = /^\/canonical\/(viajes|cargas)(?:\/([^/]+))?(?:\/(restore))?$/.exec(url.pathname);
  if (!m) return null;
  if (!env.DB) return withCors(canonicalError('session_backend_invalid', 503, requestId), request, env);
  if (!await autenticado(request, env)) return withCors(canonicalError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
  const cfg = CANONICAL_CONFIG[m[1]];
  const id = m[2] ? decodeURIComponent(m[2]) : null;
  const action = m[3] || null;
  try {
    if (!id && request.method === 'GET') {
      const vin = url.searchParams.get('vin');
      if (!vin) return withCors(canonicalError('invalid_request', 400, requestId, { field: 'vin' }), request, env);
      const limite = Math.min(Math.max(parseInt(url.searchParams.get('limite'), 10) || 200, 1), 500);
      const rows = await canonicalList(env, cfg, vin, limite, url.searchParams.get('cursor'));
      return withCors(new Response(JSON.stringify({ ...rows, [cfg.responseKey]: rows.items }), { headers: { 'Content-Type': 'application/json' } }), request, env);
    }
    if (id && !action && request.method === 'GET') {
      const row = await canonicalExistingById(env, cfg, id);
      if (!row || (row.deleted_at && url.searchParams.get('includeDeleted') !== 'true') || row.is_shadow) return withCors(canonicalError('not_found', 404, requestId), request, env);
      return withCors(new Response(JSON.stringify({ entity: canonicalPublicRow(row) }), { headers: { 'Content-Type': 'application/json' } }), request, env);
    }
    const state = await readAuthority(env);
    if (request.method !== 'GET' && ['IMPORTING','VERIFYING'].includes(state.authority)) return withCors(canonicalError('migration_locked',423,requestId,state),request,env);
    let body = null;
    if (request.method === 'POST' || request.method === 'PATCH' || request.method === 'DELETE') {
      try { body = await request.json(); } catch (e) { return withCors(canonicalError('invalid_request', 400, requestId), request, env); }
    }
    let outcome = null;
    if (!id && request.method === 'POST') outcome = await canonicalCreate(env, cfg, body, requestId);
    else if (id && !action && request.method === 'PATCH') outcome = await canonicalPatch(env, cfg, id, body, requestId);
    else if (id && !action && request.method === 'DELETE') outcome = await canonicalDelete(env, cfg, id, body, requestId);
    else if (id && action === 'restore' && request.method === 'POST') outcome = await canonicalRestore(env, cfg, id, body, requestId);
    else return withCors(canonicalError('not_found', 404, requestId), request, env);
    if (outcome.error) return withCors(outcome.error, request, env);
    return withCors(new Response(JSON.stringify({ ok: true, entity: outcome.entity }), { headers: { 'Content-Type': 'application/json' } }), request, env);
  } catch (e) {
    console.error('canonical_crud_exception', requestId, String(e));
    return withCors(canonicalError('internal_error', 500, requestId), request, env);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const requestId = nuevoId();

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), request, env);
    }

    if(url.pathname==='/auth/bootstrap')return withCors(await bootstrap(request,env,adminAuthentication),request,env);
    if(url.pathname==='/auth/session/revoke')return withCors(await revoke(request,env),request,env);

    // Clave pública: Tesla necesita poder leerla sin autenticación, desde la raíz del dominio.
    if (url.pathname === '/.well-known/appspecific/com.tesla.3p.public-key.pem') {
      if (!env.TESLA_PUBLIC_KEY_PEM) return jsonError('missing_public_key', 500, requestId);
      return new Response(env.TESLA_PUBLIC_KEY_PEM, { headers: { 'Content-Type': 'application/x-pem-file' } });
    }

    if (url.pathname === '/canonical/system/authority') {
      if (!env.DB) return withCors(jsonError('session_backend_invalid',503,requestId),request,env);
      if (!await autenticado(request,env)) return withCors(jsonError('unauthorized',await adminFailureStatus(request, env),requestId),request,env);
      if (request.method !== 'GET') return withCors(jsonError('method_not_allowed',405,requestId),request,env);
      try { return withCors(new Response(JSON.stringify(await readAuthority(env)),{headers:{'Content-Type':'application/json'}}),request,env); }
      catch { return withCors(jsonError('authority_unavailable',503,requestId),request,env); }
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
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
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
          const state = await readAuthority(env);
          const filtered = filterLegacySyncPayload(cuerpo.datos,state.authority);
          if (['IMPORTING','VERIFYING'].includes(state.authority)) {
            const old = await env.DB.prepare('SELECT contenido FROM mitesla_datos WHERE device_id = ?').bind(cuerpo.device_id).first();
            const stored = old ? JSON.parse(old.contenido) : {};
            for (const key of ['viajes','cargas']) if (Object.hasOwn(stored,key)) filtered.datos[key] = stored[key];
            for (const key of ['viajes','cargas']) if (stored._borrados?.[key]) {
              filtered.datos._borrados ||= {}; filtered.datos._borrados[key] = stored._borrados[key];
            }
          }
          const ahoraIso = new Date().toISOString();
          const synced = await env.DB.prepare(
            "INSERT INTO mitesla_datos (device_id, contenido, actualizado_en) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM system_state WHERE key='data_authority' AND value=?) " +
            'ON CONFLICT(device_id) DO UPDATE SET contenido=excluded.contenido, actualizado_en=excluded.actualizado_en'
          ).bind(cuerpo.device_id, JSON.stringify(filtered.datos), ahoraIso, state.authority).run();
          if(synced.meta?.changes !== 1) return withCors(jsonError('migration_locked',423,requestId),request,env);
          return withCors(new Response(JSON.stringify({ ok: true, actualizado_en: ahoraIso, ...state, ignoredBusinessKeys:filtered.ignoredBusinessKeys }), { headers: { 'Content-Type': 'application/json' } }), request, env);
        }
        return withCors(jsonError('method_not_allowed', 405, requestId), request, env);
      } catch (e) {
        console.error('d1_exception', requestId, String(e));
        return withCors(jsonError('d1_error', 502, requestId), request, env);
      }
    }

    // ---- B16 (FASE B) — Suscripción a Web Push, YA CON ENVÍO REAL (ver enviarPushesAlertasPendientes
    // más arriba, y el Cron Trigger en `scheduled` más abajo). Guarda/borra la suscripción
    // PushSubscription del dispositivo (endpoint + claves p256dh/auth que da el propio navegador al
    // llamar a pushManager.subscribe en app.js), y desde esta sesión también sus preferencias de
    // categoría (`categorias`, JSON — null = todas activas, ver PUSH_CATEGORIAS en app.js).
    if (url.pathname === '/push/suscribir') {
      if (!env.DB) {
        return withCors(jsonError('d1_no_configurado', 501, requestId, {
          motivo: 'Falta el binding D1 "DB" en este Worker — añade [[d1_databases]] a wrangler.toml y vuelve a desplegar.'
        }), request, env);
      }
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
      try {
        await env.DB.exec(
          'CREATE TABLE IF NOT EXISTS push_subscriptions (device_id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, categorias TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)'
        );
        try { await env.DB.exec('ALTER TABLE push_subscriptions ADD COLUMN categorias TEXT'); } catch (e) { /* ya existe (migración 0005, o tabla creada por esta misma ruta en una sesión anterior a B16) */ }
        if (request.method === 'PUT') {
          const cuerpo = await request.json();
          const claves = cuerpo && cuerpo.keys;
          if (!cuerpo || !cuerpo.device_id || !cuerpo.endpoint || !claves || !claves.p256dh || !claves.auth) {
            return withCors(jsonError('cuerpo_invalido', 400, requestId, {
              motivo: 'Se espera { device_id, endpoint, keys: { p256dh, auth } } — el mismo objeto que devuelve pushManager.subscribe().'
            }), request, env);
          }
          // categorias es opcional: si no se manda (p.ej. clientes/tests anteriores a B16), se
          // guarda null -> "todas activas", igual que el valor por defecto del propio cliente.
          const categoriasTexto = (cuerpo.categorias && typeof cuerpo.categorias === 'object') ? JSON.stringify(cuerpo.categorias) : null;
          const ahoraIso = new Date().toISOString();
          await env.DB.prepare(
            'INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, categorias, created_at, updated_at) VALUES (?,?,?,?,?,?,?) ' +
            'ON CONFLICT(device_id) DO UPDATE SET endpoint=excluded.endpoint, p256dh=excluded.p256dh, auth=excluded.auth, categorias=excluded.categorias, updated_at=excluded.updated_at'
          ).bind(cuerpo.device_id, cuerpo.endpoint, claves.p256dh, claves.auth, categoriasTexto, ahoraIso, ahoraIso).run();
          return withCors(new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }), request, env);
        }
        if (request.method === 'DELETE') {
          const deviceId = url.searchParams.get('device_id');
          if (!deviceId) return withCors(jsonError('falta_device_id', 400, requestId), request, env);
          await env.DB.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').bind(deviceId).run();
          return withCors(new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }), request, env);
        }
        return withCors(jsonError('method_not_allowed', 405, requestId), request, env);
      } catch (e) {
        console.error('push_suscribir_exception', requestId, String(e));
        return withCors(jsonError('push_suscribir_error', 502, requestId), request, env);
      }
    }

    // ---- B16 (FASE B) — actualizar SOLO las preferencias de categoría de una suscripción ya
    // guardada, sin tener que volver a llamar a pushManager.subscribe() (que el navegador no deja
    // repetir a voluntad sin motivo). Si el device_id no existe todavía, no hace nada (0 filas) —
    // nunca crea una suscripción a medias sin endpoint/claves reales. ----
    if (url.pathname === '/push/categorias' && request.method === 'POST') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
      try {
        const cuerpo = await request.json();
        if (!cuerpo || !cuerpo.device_id || !cuerpo.categorias || typeof cuerpo.categorias !== 'object') {
          return withCors(jsonError('cuerpo_invalido', 400, requestId, {
            motivo: 'Se espera { device_id, categorias: {clave: boolean, ...} }.'
          }), request, env);
        }
        await env.DB.exec('CREATE TABLE IF NOT EXISTS push_subscriptions (device_id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, categorias TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
        const res = await env.DB.prepare('UPDATE push_subscriptions SET categorias = ?, updated_at = ? WHERE device_id = ?')
          .bind(JSON.stringify(cuerpo.categorias), new Date().toISOString(), cuerpo.device_id).run();
        return withCors(new Response(JSON.stringify({ ok: true, actualizado: !!(res.meta && res.meta.changes) }), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        console.error('push_categorias_exception', requestId, String(e));
        return withCors(jsonError('push_categorias_error', 502, requestId), request, env);
      }
    }

    // ---- B16 (FASE B) — clave pública VAPID: la genera el backend (una sola vez, ver
    // asegurarConfigPush) y el cliente la usa para pushManager.subscribe({applicationServerKey}).
    // Sigue siendo posible pegarla a mano en "Ajustes" (no se ha quitado esa opción), pero ya no
    // hace falta: app.js la trae sola en cuanto backend/sessionToken están configurados. ----
    if (url.pathname === '/push/vapid-clave-publica' && request.method === 'GET') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
      try {
        const config = await asegurarConfigPush(env, env.VAPID_SUBJECT || 'mailto:mitesla-app@localhost');
        return withCors(new Response(JSON.stringify({ public_key: config.public_key_b64 }), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        console.error('push_vapid_clave_exception', requestId, String(e));
        return withCors(jsonError('push_vapid_clave_error', 502, requestId), request, env);
      }
    }

    // ---- B26/B27 (FASE B) — backup completo incluyendo D1, en modo privado o anonimizado ----
    // Ver comentario largo junto a construirBackupCompleto más arriba. `modo=anonimizado` aplica
    // B14 (privacidad de ubicaciones) a TODAS las ubicaciones y quita VIN/texto libre; sin ese
    // parámetro (o con `modo=privado`), solo se ocultan las ubicaciones marcadas explícitamente
    // (categoría casa/trabajo o `oculta_en_exportaciones`) — igual que ya hacía el resto de la app
    // con `coordenadaEsPrivada` del lado del cliente, pero ahora también para los datos que solo
    // existen en D1.
    if (url.pathname === '/backup/completo' && request.method === 'GET') {
      if (!env.DB) {
        return withCors(jsonError('d1_no_configurado', 501, requestId, {
          motivo: 'Falta el binding D1 "DB" en este Worker — añade [[d1_databases]] a wrangler.toml y vuelve a desplegar.'
        }), request, env);
      }
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
      const vin = url.searchParams.get('vin');
      if (!vin) return withCors(jsonError('falta_vin', 400, requestId), request, env);
      const modo = url.searchParams.get('modo') === 'anonimizado' ? 'anonimizado' : 'privado';
      try {
        const backup = await construirBackupCompleto(env, vin, modo);
        return withCors(new Response(JSON.stringify(backup), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        console.error('backup_completo_exception', requestId, String(e));
        return withCors(jsonError('backup_completo_error', 502, requestId), request, env);
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
      if (typeof env.TELEMETRY_BRIDGE_SECRET !== 'string' || !env.TELEMETRY_BRIDGE_SECRET.trim()) return withCors(jsonError('telemetry_secret_unconfigured', 503, requestId), request, env);
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
        await ponerEnCuarentena(env, cuerpo && cuerpo.vin, validacion.motivo, validacion.motivo === 'secret_fields_forbidden' ? '[redacted]' : cuerpoTexto);
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
      let eventos = Array.isArray(cuerpo.events) ? cuerpo.events : [];
      try {
        const admitted = await admitObservations(env.DB, cuerpo);
        eventos = admitted.events;
        if (!admitted.snapshot) cuerpo.snapshot = null;
      } catch (e) {
        return withCors(jsonError(e.message === 'observation_conflict' ? 'observation_conflict' : 'observation_store_unavailable', e.message === 'observation_conflict' ? 409 : 503, requestId), request, env);
      }
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
          const payloadTexto = stableJSON(payloadObjeto);
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
            'INSERT INTO vehicle_snapshots (vin, soc_pct, autonomia_km, odometro_km, estado, lat, lng, ubicacion_nombre, temperatura_exterior, potencia_carga_kw, tiempo_restante_carga_min, tpms_fl_bar, tpms_fr_bar, tpms_rl_bar, tpms_rr_bar, fuente, observado_en, recibido_en) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ' +
            'ON CONFLICT(vin) DO UPDATE SET soc_pct=excluded.soc_pct, autonomia_km=excluded.autonomia_km, odometro_km=excluded.odometro_km, ' +
            'estado=excluded.estado, lat=excluded.lat, lng=excluded.lng, ubicacion_nombre=excluded.ubicacion_nombre, ' +
            'temperatura_exterior=excluded.temperatura_exterior, potencia_carga_kw=excluded.potencia_carga_kw, ' +
            'tiempo_restante_carga_min=excluded.tiempo_restante_carga_min, ' +
            'tpms_fl_bar=excluded.tpms_fl_bar, tpms_fr_bar=excluded.tpms_fr_bar, tpms_rl_bar=excluded.tpms_rl_bar, tpms_rr_bar=excluded.tpms_rr_bar, ' +
            'fuente=excluded.fuente, observado_en=excluded.observado_en, recibido_en=excluded.recibido_en ' +
            'WHERE julianday(excluded.observado_en) > julianday(vehicle_snapshots.observado_en)' // nunca sobrescribe con un dato más antiguo (llegadas fuera de orden)
          ).bind(
            cuerpo.vin, s.soc_pct ?? null, s.autonomia_km ?? null, s.odometro_km ?? null, s.estado ?? null,
            s.lat ?? null, s.lng ?? null, s.ubicacion_nombre ?? null, s.temperatura_exterior ?? null,
            s.potencia_carga_kw ?? null, s.tiempo_restante_carga_min ?? null,
            s.tpms_fl_bar ?? null, s.tpms_fr_bar ?? null, s.tpms_rl_bar ?? null, s.tpms_rr_bar ?? null,
            s.fuente || 'TESLA_TELEMETRY', s.observado_en || ahoraIso, ahoraIso
          ).run();
          // B11 (FASE B): vehicle_snapshots solo guarda la última potencia conocida (se sobrescribe
          // en cada ciclo) — para poder calcular max_power_kw/average_power_kw REALES de una sesión
          // de carga hace falta el HISTORIAL de muestras, no solo la última. Se guarda aquí, una fila
          // por cada snapshot periódico que traiga potencia_carga_kw numérica; si no hay ninguna
          // muestra durante una carga (bridge antiguo, o carga muy corta entre dos polls), el motor
          // de cargas deja max/average en null en vez de inventarlos a partir de solo 2 puntos.
          if (typeof s.potencia_carga_kw === 'number') {
            await env.DB.prepare(
              'INSERT OR IGNORE INTO power_snapshots (id, vin, power_kw, observado_en, source, created_at) VALUES (?,?,?,?,?,?)'
            ).bind('pow_' + cuerpo.vin + '_' + (s.observado_en || ahoraIso), cuerpo.vin, s.potencia_carga_kw, s.observado_en || ahoraIso, s.fuente || 'TESLA_TELEMETRY', ahoraIso).run();
          }
        }
        await incrementarContadorSyncState(env, cuerpo.vin, 'eventos_recibidos_mes', insertados);
        // A25: contadores de coste reales — separados de "eventos derivados" (trip_started, etc.,
        // gratis) de las señales de streaming en bruto que sí tienen coste en la Fleet API. El
        // bridge reporta cuántas señales MQTT vio este ciclo en `senales_recibidas`; si no lo
        // manda (bridge antiguo), se usa 0 en vez de inventar un número.
        await actualizarUsageCounters(env, cuerpo.vin, {
          telemetry_signals_received: Number.isFinite(Number(cuerpo.senales_recibidas)) ? Number(cuerpo.senales_recibidas) : 0,
          derived_events: insertados
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
          throw e;
        }
        let cargasCerradas = 0;
        try {
          cargasCerradas = await procesarCargasPendientes(env, cuerpo.vin, modo);
        } catch (e) {
          console.error('procesar_cargas_exception', requestId, String(e));
          throw e;
        }
        return withCors(new Response(JSON.stringify({
          ok: true, insertados, duplicados, viajes_cerrados: viajesCerrados, cargas_cerradas: cargasCerradas, automation_mode: modo
        }), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        console.error('telemetry_exception', requestId, String(e));
        await incrementarContadorSyncState(env, cuerpo.vin, 'errores_mes', 1).catch(function () {});
        return withCors(jsonError(e.message === 'lifecycle_conflict' ? 'lifecycle_conflict' : String(e).includes('UNIQUE constraint failed') ? 'canonical_identity_conflict' : 'telemetry_error', e.message === 'lifecycle_conflict' || String(e).includes('UNIQUE constraint failed') ? 409 : 502, requestId), request, env);
      }
    }

    // ---- Fase 4A — /internal/health: diagnóstico del pipeline de telemetría (sección 59, 63) ----
    // Protegida con el mismo token de sesión que el resto de rutas privadas (la consulta el propio
    // frontend en Ajustes → Automatización, no el bridge). Nunca inventa "todo ok" si falta algo:
    // cada pieza se comprueba de verdad (binding D1, secreto configurado, última recepción real).
    if (url.pathname === '/internal/health') {
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
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
    // Ambas protegidas con el mismo token de sesión que el resto de rutas privadas del frontend.
    // ---- A10 (FASE A): /automatizacion/modo — leer/fijar el modo real (off/shadow/active) ----
    if (url.pathname === '/automatizacion/modo' && request.method === 'GET') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
      const vin = url.searchParams.get('vin');
      if (!vin) return withCors(jsonError('falta_vin', 400, requestId), request, env);
      const modo = await obtenerAutomationMode(env, vin);
      return withCors(new Response(JSON.stringify({ vin, automation_mode: modo }), { headers: { 'Content-Type': 'application/json' } }), request, env);
    }
    if (url.pathname === '/automatizacion/modo' && request.method === 'POST') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
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

    // ---- B15 (FASE B): /automatizacion/tpms-umbral — leer/fijar el umbral de aviso TPMS ----
    if (url.pathname === '/automatizacion/tpms-umbral' && request.method === 'GET') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
      const vin = url.searchParams.get('vin');
      if (!vin) return withCors(jsonError('falta_vin', 400, requestId), request, env);
      const umbral = await obtenerUmbralTpms(env, vin);
      return withCors(new Response(JSON.stringify({ vin, tpms_umbral_bar: umbral }), { headers: { 'Content-Type': 'application/json' } }), request, env);
    }
    if (url.pathname === '/automatizacion/tpms-umbral' && request.method === 'POST') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
      let cuerpo;
      try { cuerpo = await request.json(); } catch (e) { return withCors(jsonError('cuerpo_invalido', 400, requestId), request, env); }
      if (!cuerpo || typeof cuerpo.vin !== 'string' || !cuerpo.vin || typeof cuerpo.tpms_umbral_bar !== 'number') {
        return withCors(jsonError('cuerpo_invalido', 400, requestId, { motivo: 'vin y tpms_umbral_bar (número, bar) requeridos' }), request, env);
      }
      try {
        await fijarUmbralTpms(env, cuerpo.vin, cuerpo.tpms_umbral_bar);
        return withCors(new Response(JSON.stringify({ ok: true, vin: cuerpo.vin, tpms_umbral_bar: cuerpo.tpms_umbral_bar }), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        if (String(e).indexOf('umbral_invalido') !== -1) return withCors(jsonError('umbral_invalido', 400, requestId, { motivo: 'debe estar entre 0 y 6 bar' }), request, env);
        console.error('tpms_umbral_exception', requestId, String(e));
        return withCors(jsonError('d1_error', 502, requestId), request, env);
      }
    }

    if (url.pathname === '/pendientes' && request.method === 'GET') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
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
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
      let cuerpo;
      try { cuerpo = await request.json(); } catch (e) { return withCors(jsonError('cuerpo_invalido', 400, requestId), request, env); }
      if (!cuerpo || typeof cuerpo.id !== 'string' || !cuerpo.resuelto_con || typeof cuerpo.resuelto_con !== 'object') {
        return withCors(jsonError('cuerpo_invalido', 400, requestId), request, env);
      }
      try {
        if (!(await businessWritesAllowed(env))) return withCors(jsonError('migration_locked',423,requestId),request,env);
        const pendiente = await env.DB.prepare('SELECT * FROM pending_actions WHERE id = ?').bind(cuerpo.id).first();
        if (!pendiente) return withCors(jsonError('pendiente_no_encontrado', 404, requestId), request, env);
        if (pendiente.resuelto_en) return withCors(jsonError('pendiente_ya_resuelto', 409, requestId), request, env);
        const ahoraIso = new Date().toISOString();
        if (pendiente.tipo === 'clasificar_viaje' && pendiente.referencia_tabla === 'trips' && typeof cuerpo.resuelto_con.classification === 'string') {
          // La corrección manual del usuario SIEMPRE gana — nunca la pisará un reprocesamiento
          // posterior de los mismos eventos (esos eventos ya quedaron marcados como procesados).
          await env.DB.prepare(
            "UPDATE trips SET classification = ?, classification_source = 'manual', classification_rule_id = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL" + BUSINESS_WRITE_GUARD
          ).bind(cuerpo.resuelto_con.classification, ahoraIso, pendiente.referencia_id).run();
        }
        if (pendiente.tipo === 'precio_carga' && pendiente.referencia_tabla === 'charging_sessions') {
          const r = cuerpo.resuelto_con;
          const totalCost = r.free === true ? 0 : (typeof r.total_cost === 'number' ? r.total_cost : null);
          const costSource = r.free === true ? 'gratuita' : (totalCost !== null ? 'conocido' : null);
          if (totalCost !== null) {
            await env.DB.prepare(
              "UPDATE charging_sessions SET total_cost = ?, cost_source = ?, price_rule_id = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL" + BUSINESS_WRITE_GUARD
            ).bind(totalCost, costSource, ahoraIso, pendiente.referencia_id).run();
          }
        }
        if (!(await businessWritesAllowed(env))) return withCors(jsonError('migration_locked',423,requestId),request,env);
        const resolved = await env.DB.prepare('UPDATE pending_actions SET resuelto_en = ?, resuelto_con = ? WHERE id = ?' + BUSINESS_WRITE_GUARD)
          .bind(ahoraIso, JSON.stringify(cuerpo.resuelto_con), cuerpo.id).run();
        if (resolved.meta?.changes !== 1) return withCors(jsonError('migration_locked',423,requestId),request,env);
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
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
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
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
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

    const canonicalResponse = await handleCanonicalRequest(request, env, url, requestId);
    if (canonicalResponse) return canonicalResponse;

    // ---- B5/B6 (FASE B) — viajes y cargas AUTOMÁTICOS (detectados por telemetría) visibles ----
    // Hasta ahora, `trips`/`charging_sessions` (Fase 4A-4D) solo se leían del lado del servidor
    // (pendientes/alertas/backup). No existía ningún endpoint para que la propia app los mostrara.
    // Estos dos son de solo lectura y deliberadamente NO se mezclan con /d1/sync (el blob de
    // DATOS.viajes/DATOS.cargas manuales): son dos fuentes de datos distintas (MANUAL vs
    // TESLA_TELEMETRY, sección 67 de la auditoría) y unificarlas en un único array editable es una
    // decisión de arquitectura mayor (reconciliar duplicados, decidir qué pasa si el usuario edita
    // un viaje detectado, etc.) que no pide este punto — solo pide que sean VISIBLES. Se filtran
    // explícitamente is_shadow=1 (modo sombra, sección A10): esos registros existen solo para
    // validar la detección sin que el usuario los vea todavía, nunca deben alimentar ninguna
    // pantalla real (misma norma que ya protegía a pendientes/alertas: `AND is_shadow = 0`).
    if (url.pathname === '/telemetria/viajes' && request.method === 'GET') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
      const vin = url.searchParams.get('vin');
      if (!vin) return withCors(jsonError('falta_vin', 400, requestId), request, env);
      const limite = Math.min(Math.max(parseInt(url.searchParams.get('limite'), 10) || 200, 1), 500);
      try {
        const filas = await env.DB.prepare(
          'SELECT id, started_at, ended_at, distance_km, duration_min, start_soc_pct, end_soc_pct, ' +
          'energy_used_kwh, start_location_raw, end_location_raw, classification, classification_source, ' +
          'manual_override, data_quality, source, revision, deleted_at, created_at, updated_at FROM trips ' +
          'WHERE vin = ? AND is_shadow = 0 AND deleted_at IS NULL ORDER BY started_at DESC LIMIT ?'
        ).bind(vin, limite).all();
        return withCors(new Response(JSON.stringify({ viajes: filas.results || [] }), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        console.error('telemetria_viajes_exception', requestId, String(e));
        return withCors(jsonError('d1_error', 502, requestId), request, env);
      }
    }
    if (url.pathname === '/telemetria/cargas' && request.method === 'GET') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
      const vin = url.searchParams.get('vin');
      if (!vin) return withCors(jsonError('falta_vin', 400, requestId), request, env);
      const limite = Math.min(Math.max(parseInt(url.searchParams.get('limite'), 10) || 200, 1), 500);
      try {
        const filas = await env.DB.prepare(
          'SELECT id, started_at, ended_at, start_soc_pct, end_soc_pct, energy_kwh, charger_type, ' +
          'charging_current_type, max_power_kw, average_power_kw, duration_min, total_cost, cost_source, ' +
          'manual_override, data_quality, source, revision, deleted_at, created_at, updated_at FROM charging_sessions ' +
          'WHERE vin = ? AND is_shadow = 0 AND deleted_at IS NULL ORDER BY started_at DESC LIMIT ?'
        ).bind(vin, limite).all();
        return withCors(new Response(JSON.stringify({ cargas: filas.results || [] }), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        console.error('telemetria_cargas_exception', requestId, String(e));
        return withCors(jsonError('d1_error', 502, requestId), request, env);
      }
    }

    // ---- B7 (FASE B) — administración completa de lugares (geofences en D1) ----
    // Hasta ahora `locations` solo se LEÍA (clasificación de viajes/cargas, sección 12; el mapa de
    // /lugares no existía). No había ningún endpoint para que el usuario diera de alta, editara o
    // borrara un lugar desde la app — solo se podía insertar a mano directamente en D1, algo que la
    // app nunca ha permitido hacer. CRUD completo, protegido igual que el resto (Bearer session token).
    // Un lugar mal dado de alta (coordenadas inválidas, radio absurdo) puede desclasificar viajes
    // reales más adelante, así que se valida con el mismo rigor que cualquier dato que alimenta
    // Economía/Stats — nunca se guarda "lo que sea" solo porque el tipo coincide.
    const CATEGORIAS_LUGAR_VALIDAS = new Set(['casa', 'trabajo', 'otro']);
    const PRIVACIDAD_LUGAR_VALIDAS = new Set(['normal', 'oculta_en_exportaciones']);
    function validarLugar(cuerpo) {
      if (!cuerpo || typeof cuerpo.name !== 'string' || !cuerpo.name.trim()) return 'falta_name';
      if (typeof cuerpo.lat !== 'number' || !isFinite(cuerpo.lat) || cuerpo.lat < -90 || cuerpo.lat > 90) return 'lat_invalida';
      if (typeof cuerpo.lng !== 'number' || !isFinite(cuerpo.lng) || cuerpo.lng < -180 || cuerpo.lng > 180) return 'lng_invalida';
      if (cuerpo.radius_m != null && (typeof cuerpo.radius_m !== 'number' || !isFinite(cuerpo.radius_m) || cuerpo.radius_m <= 0 || cuerpo.radius_m > 5000)) return 'radio_invalido';
      if (cuerpo.category != null && !CATEGORIAS_LUGAR_VALIDAS.has(cuerpo.category)) return 'category_invalida';
      if (cuerpo.privacy_level != null && !PRIVACIDAD_LUGAR_VALIDAS.has(cuerpo.privacy_level)) return 'privacy_level_invalido';
      return null;
    }
    if (url.pathname === '/lugares' && request.method === 'GET') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
      const vin = url.searchParams.get('vin');
      if (!vin) return withCors(jsonError('falta_vin', 400, requestId), request, env);
      try {
        const filas = await env.DB.prepare('SELECT * FROM locations WHERE vin = ?').bind(vin).all();
        const lugares = (filas.results || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return withCors(new Response(JSON.stringify({ lugares }), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        console.error('lugares_get_exception', requestId, String(e));
        return withCors(jsonError('d1_error', 502, requestId), request, env);
      }
    }
    if (url.pathname === '/lugares' && request.method === 'POST') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
      let cuerpo;
      try { cuerpo = await request.json(); } catch (e) { return withCors(jsonError('cuerpo_invalido', 400, requestId), request, env); }
      if (!cuerpo || typeof cuerpo.vin !== 'string' || !cuerpo.vin) return withCors(jsonError('falta_vin', 400, requestId), request, env);
      const motivoInvalido = validarLugar(cuerpo);
      if (motivoInvalido) return withCors(jsonError(motivoInvalido, 400, requestId), request, env);
      const ahoraIso = new Date().toISOString();
      const radius_m = (typeof cuerpo.radius_m === 'number') ? cuerpo.radius_m : 150;
      const category = cuerpo.category || null;
      const privacy_level = cuerpo.privacy_level || 'normal';
      try {
        if (cuerpo.id) {
          const existente = await env.DB.prepare('SELECT id FROM locations WHERE id = ? AND vin = ?').bind(cuerpo.id, cuerpo.vin).first();
          if (!existente) return withCors(jsonError('lugar_no_encontrado', 404, requestId), request, env);
          await env.DB.prepare(
            'UPDATE locations SET name = ?, lat = ?, lng = ?, radius_m = ?, category = ?, privacy_level = ?, updated_at = ? WHERE id = ? AND vin = ?'
          ).bind(cuerpo.name.trim(), cuerpo.lat, cuerpo.lng, radius_m, category, privacy_level, ahoraIso, cuerpo.id, cuerpo.vin).run();
          return withCors(new Response(JSON.stringify({ ok: true, id: cuerpo.id }), { headers: { 'Content-Type': 'application/json' } }), request, env);
        }
        const id = nuevoId();
        await env.DB.prepare(
          'INSERT INTO locations (id, vin, name, lat, lng, radius_m, category, privacy_level, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
        ).bind(id, cuerpo.vin, cuerpo.name.trim(), cuerpo.lat, cuerpo.lng, radius_m, category, privacy_level, ahoraIso, ahoraIso).run();
        return withCors(new Response(JSON.stringify({ ok: true, id }), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        console.error('lugares_post_exception', requestId, String(e));
        return withCors(jsonError('d1_error', 502, requestId), request, env);
      }
    }
    if (url.pathname === '/lugares' && request.method === 'DELETE') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
      const id = url.searchParams.get('id');
      const vin = url.searchParams.get('vin');
      if (!id || !vin) return withCors(jsonError('falta_id_o_vin', 400, requestId), request, env);
      try {
        await env.DB.prepare('DELETE FROM locations WHERE id = ? AND vin = ?').bind(id, vin).run();
        return withCors(new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        console.error('lugares_delete_exception', requestId, String(e));
        return withCors(jsonError('d1_error', 502, requestId), request, env);
      }
    }

    // ---- B8 (FASE B) — UI completa de reglas de automatización (automation_rules en D1) ----
    // `automation_rules` ya se LEÍA y se APLICABA de verdad (clasificarViajeConReglas /
    // calcularCosteConReglas, más arriba) — pero, igual que pasaba con `locations` antes de B7, no
    // existía ningún endpoint para que el usuario diera de alta/editara/borrara una regla: solo se
    // podían insertar a mano directamente en D1. CRUD completo, con la MISMA validación de forma que
    // ya aplican clasificarViajeConReglas/calcularCosteConReglas al leer (clasificación de una lista
    // cerrada, precio con al menos un campo de coste válido) — así nunca se puede guardar, desde la
    // app, una regla que esas funciones no sepan interpretar más tarde.
    const TIPOS_REGLA_VALIDOS = new Set(['clasificacion_viaje', 'precio_carga']);
    const CLASIFICACIONES_VIAJE_VALIDAS = new Set(['trabajo', 'personal', 'otro']);
    function validarRegla(cuerpo) {
      if (!cuerpo || !TIPOS_REGLA_VALIDOS.has(cuerpo.tipo)) return 'tipo_invalido';
      if (!cuerpo.condicion || typeof cuerpo.condicion !== 'object' || Array.isArray(cuerpo.condicion)) return 'condicion_invalida';
      if (!cuerpo.accion || typeof cuerpo.accion !== 'object' || Array.isArray(cuerpo.accion)) return 'accion_invalida';
      if (cuerpo.tipo === 'clasificacion_viaje') {
        if (!CLASIFICACIONES_VIAJE_VALIDAS.has(cuerpo.accion.classification)) return 'accion_classification_invalida';
      } else {
        const a = cuerpo.accion;
        const tieneFree = a.free === true;
        const tienePriceKwh = typeof a.price_kwh === 'number' && isFinite(a.price_kwh) && a.price_kwh > 0;
        const tienePriceTotal = typeof a.price_total === 'number' && isFinite(a.price_total) && a.price_total > 0;
        if (!tieneFree && !tienePriceKwh && !tienePriceTotal) return 'accion_precio_invalida';
      }
      return null;
    }
    if (url.pathname === '/reglas' && request.method === 'GET') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
      const vin = url.searchParams.get('vin');
      if (!vin) return withCors(jsonError('falta_vin', 400, requestId), request, env);
      try {
        const filas = await env.DB.prepare('SELECT * FROM automation_rules WHERE vin = ?').bind(vin).all();
        const reglas = (filas.results || []).map(function (r) {
          return Object.assign({}, r, { condicion: JSON.parse(r.condicion), accion: JSON.parse(r.accion), activa: !!r.activa });
        });
        return withCors(new Response(JSON.stringify({ reglas }), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        console.error('reglas_get_exception', requestId, String(e));
        return withCors(jsonError('d1_error', 502, requestId), request, env);
      }
    }
    if (url.pathname === '/reglas' && request.method === 'POST') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
      let cuerpo;
      try { cuerpo = await request.json(); } catch (e) { return withCors(jsonError('cuerpo_invalido', 400, requestId), request, env); }
      if (!cuerpo || typeof cuerpo.vin !== 'string' || !cuerpo.vin) return withCors(jsonError('falta_vin', 400, requestId), request, env);
      const motivoInvalido = validarRegla(cuerpo);
      if (motivoInvalido) return withCors(jsonError(motivoInvalido, 400, requestId), request, env);
      const ahoraIso = new Date().toISOString();
      const activa = cuerpo.activa === false ? 0 : 1;
      const condicionJson = JSON.stringify(cuerpo.condicion);
      const accionJson = JSON.stringify(cuerpo.accion);
      try {
        if (cuerpo.id) {
          const existente = await env.DB.prepare('SELECT id FROM automation_rules WHERE id = ? AND vin = ?').bind(cuerpo.id, cuerpo.vin).first();
          if (!existente) return withCors(jsonError('regla_no_encontrada', 404, requestId), request, env);
          await env.DB.prepare(
            'UPDATE automation_rules SET tipo = ?, condicion = ?, accion = ?, activa = ?, updated_at = ? WHERE id = ? AND vin = ?'
          ).bind(cuerpo.tipo, condicionJson, accionJson, activa, ahoraIso, cuerpo.id, cuerpo.vin).run();
          return withCors(new Response(JSON.stringify({ ok: true, id: cuerpo.id }), { headers: { 'Content-Type': 'application/json' } }), request, env);
        }
        const id = nuevoId();
        await env.DB.prepare(
          'INSERT INTO automation_rules (id, vin, tipo, condicion, accion, activa, veces_usada, created_at, updated_at) VALUES (?,?,?,?,?,?,0,?,?)'
        ).bind(id, cuerpo.vin, cuerpo.tipo, condicionJson, accionJson, activa, ahoraIso, ahoraIso).run();
        return withCors(new Response(JSON.stringify({ ok: true, id }), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        console.error('reglas_post_exception', requestId, String(e));
        return withCors(jsonError('d1_error', 502, requestId), request, env);
      }
    }
    if (url.pathname === '/reglas' && request.method === 'DELETE') {
      if (!env.DB) return withCors(jsonError('d1_no_configurado', 501, requestId), request, env);
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
      const id = url.searchParams.get('id');
      const vin = url.searchParams.get('vin');
      if (!id || !vin) return withCors(jsonError('falta_id_o_vin', 400, requestId), request, env);
      try {
        await env.DB.prepare('DELETE FROM automation_rules WHERE id = ? AND vin = ?').bind(id, vin).run();
        return withCors(new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }), request, env);
      } catch (e) {
        console.error('reglas_delete_exception', requestId, String(e));
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
      const auth=adminAuthentication(request,env);
      if (!auth.ok) return withCors(jsonError(auth.error,auth.status,requestId),request,env);
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
    // sí exige el token de sesión, pero por cabecera Authorization (fetch autenticado normal),
    // nunca por query string — así el secreto permanente nunca llega a aparecer en un historial de
    // navegación, en logs de acceso ni en el Referer de la navegación siguiente.
    if (url.pathname === '/oauth/start-token' && request.method === 'POST') {
      if (!await autenticado(request, env)) return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
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
    if (!await autenticado(request, env)) {
      return withCors(jsonError(await adminFailureError(request, env), await adminFailureStatus(request, env), requestId), request, env);
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
      // B16: envío real de Web Push — se ejecuta DESPUÉS de ejecutarComprobacionesDeSalud (arriba),
      // en el mismo ciclo del Cron Trigger, así que una alerta nueva manda su push en cuanto se crea,
      // sin esperar a la siguiente ejecución programada.
      const r = await enviarPushesAlertasPendientes(env);
      console.log('push_alertas_completado', r.enviados, r.alertas_procesadas);
    } catch (e) {
      console.error('scheduled_exception_push', String(e));
    }
    try {
      const p = await purgarTelemetriaCruda(env);
      console.log('purga_telemetria_completada', p);
    } catch (e) {
      console.error('scheduled_exception_purga', String(e));
    }
  }
};
