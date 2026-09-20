// Fase 4A — /internal/telemetry y /internal/health (ingesta desde mitesla-telemetry-bridge).
// Mock D1 mínimo, hecho a medida de las consultas exactas que emite worker.js (no un motor SQL
// genérico): basta para probar de verdad la lógica de firma, idempotencia y no-regresión temporal
// sin depender de una base D1 real.
import workerModule from '../worker.js';
import { crearMockD1 } from './helpers/mock_d1.js';

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
    async delete(k) { store.delete(k); ttls.delete(k); }
  };
}

function mockDB() {
  return crearMockD1();
}

function envBase(db) {
  return {
    ALLOWED_ORIGIN: 'https://chollomaton.github.io',
    ADMIN_TOKEN: 'admin-secreto-123',
    TELEMETRY_BRIDGE_SECRET: 'bridge-secreto-xyz',
    TESLA_TOKENS: kvEnMemoria(),
    DB: db
  };
}

async function firmar(secreto, timestamp, nonce, cuerpoTexto) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(timestamp + '.' + nonce + '.' + cuerpoTexto));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function reqFirmada(path, cuerpoTexto, headersExtra) {
  const headers = new Headers(Object.assign({ 'Content-Type': 'application/json' }, headersExtra || {}));
  return new Request('https://api.laperestronika.com' + path, { method: 'POST', headers, body: cuerpoTexto });
}

async function run() {
  const VIN = '5YJ3E1EA1PF000001';

  // ---- 1) Sin cabeceras de firma -> 401 ----
  {
    const env = envBase(mockDB());
    const cuerpo = JSON.stringify({ vin: VIN, events: [] });
    const res = await workerModule.fetch(reqFirmada('/internal/telemetry', cuerpo), env);
    const body = await res.json();
    assert(res.status === 401 && body.motivo === 'faltan_cabeceras', 'sin cabeceras de firma -> 401 faltan_cabeceras');
  }

  // ---- 2) Timestamp fuera de ventana -> 401 ----
  {
    const env = envBase(mockDB());
    const cuerpo = JSON.stringify({ vin: VIN, events: [] });
    const tsViejo = String(Math.floor(Date.now() / 1000) - 999);
    const nonce = 'nonce-1';
    const firma = await firmar(env.TELEMETRY_BRIDGE_SECRET, tsViejo, nonce, cuerpo);
    const res = await workerModule.fetch(reqFirmada('/internal/telemetry', cuerpo, { 'X-Signature': firma, 'X-Timestamp': tsViejo, 'X-Nonce': nonce }), env);
    const body = await res.json();
    assert(res.status === 401 && body.motivo === 'timestamp_fuera_de_ventana', 'timestamp fuera de ventana (>120s) -> 401');
  }

  // ---- 3) Firma inválida -> 401 ----
  {
    const env = envBase(mockDB());
    const cuerpo = JSON.stringify({ vin: VIN, events: [] });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await workerModule.fetch(reqFirmada('/internal/telemetry', cuerpo, { 'X-Signature': 'firma-falsa', 'X-Timestamp': ts, 'X-Nonce': 'n2' }), env);
    const body = await res.json();
    assert(res.status === 401 && body.motivo === 'firma_invalida', 'firma HMAC incorrecta -> 401 firma_invalida');
  }

  // ---- 4) D1 no configurado -> 501, ni siquiera llega a comprobar la firma ----
  {
    const env = envBase(null);
    const cuerpo = JSON.stringify({ vin: VIN, events: [] });
    const res = await workerModule.fetch(reqFirmada('/internal/telemetry', cuerpo), env);
    const body = await res.json();
    assert(res.status === 501 && body.error === 'd1_no_configurado', 'sin binding D1 -> 501 d1_no_configurado');
  }

  // ---- 5) VIN inválido -> 400 (aun con firma correcta) ----
  {
    const env = envBase(mockDB());
    const cuerpo = JSON.stringify({ vin: 'vin con espacios!!', events: [] });
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = 'n3';
    const firma = await firmar(env.TELEMETRY_BRIDGE_SECRET, ts, nonce, cuerpo);
    const res = await workerModule.fetch(reqFirmada('/internal/telemetry', cuerpo, { 'X-Signature': firma, 'X-Timestamp': ts, 'X-Nonce': nonce }), env);
    const body = await res.json();
    assert(res.status === 400 && body.error === 'vin_invalido', 'VIN con formato inválido -> 400 vin_invalido');
  }

  // ---- 6) Envío válido: eventos + snapshot, inserción real, contador incrementado ----
  let envCompartido;
  {
    envCompartido = envBase(mockDB());
    // FASE A (A14/A10): el VIN debe estar autorizado explícitamente y en modo != 'off' — igual que
    // haría /seleccionar-vehiculo + el panel "Automatización" en la app real (ver infra/README.md §9).
    envCompartido.DB._autorizarYActivar(VIN, 'active');
    const cuerpo = JSON.stringify({
      vin: VIN,
      events: [
        { id: 'evt-1', tipo: 'trip_started', payload: { lat: 43.36, lng: -5.84 }, observado_en: '2026-09-20T08:00:00Z' },
        { id: 'evt-2', tipo: 'trip_finished', payload: { distance_km: 12.4 }, observado_en: '2026-09-20T08:20:00Z' }
      ],
      snapshot: { soc_pct: 72, odometro_km: 15234, estado: 'parked', fuente: 'TESLA_TELEMETRY', observado_en: '2026-09-20T08:20:00Z' }
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = 'n4';
    const firma = await firmar(envCompartido.TELEMETRY_BRIDGE_SECRET, ts, nonce, cuerpo);
    const res = await workerModule.fetch(reqFirmada('/internal/telemetry', cuerpo, { 'X-Signature': firma, 'X-Timestamp': ts, 'X-Nonce': nonce }), envCompartido);
    const body = await res.json();
    assert(res.status === 200 && body.ok === true && body.insertados === 2 && body.duplicados === 0, 'envío válido -> 200, 2 eventos insertados, 0 duplicados');
    const dump = envCompartido.DB._dump();
    assert(dump.snapshots.get(VIN) && dump.snapshots.get(VIN).odometro_km === 15234, 'el snapshot queda guardado con el odómetro recibido');
    assert(dump.syncState.get(VIN) && dump.syncState.get(VIN).eventos_recibidos_mes === 2, 'el contador mensual de eventos sube en 2');
  }

  // ---- 7) Reenvío con los MISMOS IDs de evento (reintento del bridge) -> idempotente, 0 nuevos ----
  {
    const cuerpo = JSON.stringify({
      vin: VIN,
      events: [
        { id: 'evt-1', tipo: 'trip_started', payload: { lat: 43.36, lng: -5.84 }, observado_en: '2026-09-20T08:00:00Z' },
        { id: 'evt-2', tipo: 'trip_finished', payload: { distance_km: 12.4 }, observado_en: '2026-09-20T08:20:00Z' }
      ]
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = 'n5';
    const firma = await firmar(envCompartido.TELEMETRY_BRIDGE_SECRET, ts, nonce, cuerpo);
    const res = await workerModule.fetch(reqFirmada('/internal/telemetry', cuerpo, { 'X-Signature': firma, 'X-Timestamp': ts, 'X-Nonce': nonce }), envCompartido);
    const body = await res.json();
    assert(res.status === 200 && body.insertados === 0 && body.duplicados === 2, 'reintento con los mismos event_id -> 0 insertados, 2 duplicados (idempotente)');
  }

  // ---- 8) Reenvío del MISMO nonce (replay literal de la petición) -> 401 nonce_repetido ----
  {
    const cuerpo = JSON.stringify({ vin: VIN, events: [] });
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = 'nonce-reutilizado';
    const firma = await firmar(envCompartido.TELEMETRY_BRIDGE_SECRET, ts, nonce, cuerpo);
    const headers = { 'X-Signature': firma, 'X-Timestamp': ts, 'X-Nonce': nonce };
    const res1 = await workerModule.fetch(reqFirmada('/internal/telemetry', cuerpo, headers), envCompartido);
    assert(res1.status === 200, 'primera petición con nonce nuevo -> 200');
    const res2 = await workerModule.fetch(reqFirmada('/internal/telemetry', cuerpo, headers), envCompartido);
    const body2 = await res2.json();
    assert(res2.status === 401 && body2.motivo === 'nonce_repetido', 'repetir el mismo nonce -> 401 nonce_repetido (antirreplay)');
  }

  // ---- 9) Snapshot con observado_en más ANTIGUO que el ya guardado -> no lo sobrescribe ----
  {
    const cuerpo = JSON.stringify({
      vin: VIN,
      events: [],
      snapshot: { soc_pct: 10, odometro_km: 1, estado: 'parked', fuente: 'TESLA_TELEMETRY', observado_en: '2020-01-01T00:00:00Z' }
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = 'n6';
    const firma = await firmar(envCompartido.TELEMETRY_BRIDGE_SECRET, ts, nonce, cuerpo);
    await workerModule.fetch(reqFirmada('/internal/telemetry', cuerpo, { 'X-Signature': firma, 'X-Timestamp': ts, 'X-Nonce': nonce }), envCompartido);
    const dump = envCompartido.DB._dump();
    assert(dump.snapshots.get(VIN).odometro_km === 15234, 'un snapshot con fecha más antigua nunca sobrescribe el más reciente ya guardado');
  }

  // ---- 10) /internal/health sin ADMIN_TOKEN -> 401 ----
  {
    const res = await workerModule.fetch(new Request('https://api.laperestronika.com/internal/health?vin=' + VIN), envCompartido);
    assert(res.status === 401, '/internal/health sin autenticar -> 401');
  }

  // ---- 11) /internal/health autenticado -> refleja el estado real guardado ----
  {
    const res = await workerModule.fetch(new Request('https://api.laperestronika.com/internal/health?vin=' + VIN, {
      headers: { Authorization: 'Bearer ' + envCompartido.ADMIN_TOKEN }
    }), envCompartido);
    const body = await res.json();
    assert(res.status === 200 && body.d1_configurado === true && body.secreto_bridge_configurado === true, '/internal/health autenticado -> informa de D1 y secreto configurados');
    assert(body.sync_state && body.sync_state.eventos_recibidos_mes === 2, '/internal/health devuelve el sync_state real (2 eventos), no inventado');
    assert(typeof body.posible_problema === 'boolean' && body.posible_problema === false, 'con eventos recientes, posible_problema es false (nunca alarma sin motivo)');
  }

  // ---- 12) /internal/health para un VIN sin ningún dato -> no inventa sync_state ----
  {
    const res = await workerModule.fetch(new Request('https://api.laperestronika.com/internal/health?vin=VIN-INEXISTENTE', {
      headers: { Authorization: 'Bearer ' + envCompartido.ADMIN_TOKEN }
    }), envCompartido);
    const body = await res.json();
    assert(res.status === 200 && body.sync_state === null, 'VIN sin telemetría todavía -> sync_state null, nunca datos simulados');
  }

  // ---- 13) B9: un evento con energy_remaining_kwh en el payload se guarda en battery_snapshots ----
  {
    const env = envBase(mockDB());
    env.DB._autorizarYActivar(VIN, 'active');
    const cuerpo = JSON.stringify({
      vin: VIN,
      events: [
        { id: 'evt-b9-1', tipo: 'trip_started', payload: { lat: 43.36, lng: -5.84, odometro_km: 15000, soc_pct: 70, energy_remaining_kwh: 52.5 }, observado_en: '2026-09-20T09:00:00Z' }
      ]
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = 'n-b9-1';
    const firma = await firmar(env.TELEMETRY_BRIDGE_SECRET, ts, nonce, cuerpo);
    const res = await workerModule.fetch(reqFirmada('/internal/telemetry', cuerpo, { 'X-Signature': firma, 'X-Timestamp': ts, 'X-Nonce': nonce }), env);
    assert(res.status === 200, 'B9: petición con energy_remaining_kwh en el payload se acepta (200)');
    const fila = env.DB._dump().bateriaSnapshots.find((f) => f.id === 'bat_evt-b9-1');
    assert(!!fila && fila.energy_remaining_kwh === 52.5, 'B9: el snapshot de batería guardado en D1 lleva energy_remaining_kwh real, no null ni 0 inventado');
    assert(fila.soc_pct === 70, 'B9: soc_pct se sigue guardando exactamente igual que antes (B9 es aditivo, no ha tocado el comportamiento existente)');
  }

  // ---- 14) B9: sin energy_remaining_kwh en el payload, el snapshot se guarda igual, con null explícito ----
  {
    const env = envBase(mockDB());
    env.DB._autorizarYActivar(VIN, 'active');
    const cuerpo = JSON.stringify({
      vin: VIN,
      events: [
        { id: 'evt-b9-2', tipo: 'trip_started', payload: { lat: 43.36, lng: -5.84, odometro_km: 15000, soc_pct: 70 }, observado_en: '2026-09-20T09:00:00Z' }
      ]
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = 'n-b9-2';
    const firma = await firmar(env.TELEMETRY_BRIDGE_SECRET, ts, nonce, cuerpo);
    const res = await workerModule.fetch(reqFirmada('/internal/telemetry', cuerpo, { 'X-Signature': firma, 'X-Timestamp': ts, 'X-Nonce': nonce }), env);
    assert(res.status === 200, 'B9: petición SIN energy_remaining_kwh (vehículo/config que no la soporta) también se acepta (200) — campo opcional');
    const fila = env.DB._dump().bateriaSnapshots.find((f) => f.id === 'bat_evt-b9-2');
    assert(!!fila && fila.energy_remaining_kwh === null, 'B9: sin el dato en el payload, se guarda null explícito — nunca 0 ni un valor derivado del SoC en este punto de la ingesta');
  }

  console.log('');
  if (fallos === 0) console.log('TODO OK — Fase 4A: /internal/telemetry y /internal/health');
  else { console.log(fallos + ' fallo(s).'); process.exitCode = 1; }
}

run();
