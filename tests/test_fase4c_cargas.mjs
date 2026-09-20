// Fase 4C — cargas 100% automáticas: emparejamiento charge_started/charge_stopped, energía real
// (AC/DC, nunca inventada), ubicación por geofence, precio por reglas (o pendiente si no hay una
// respuesta fiable), y el flujo completo a través del endpoint real /internal/telemetry.
import workerModule, {
  emparejarEventosEnCargas, calcularCosteConReglas, construirCargaDesdeEventos
} from '../worker.js';
import { crearMockD1 } from './helpers/mock_d1.js';

let fallos = 0;
function assert(cond, msg) {
  if (!cond) { console.log('❌ FALLO:', msg); fallos++; }
  else console.log('✅', msg);
}

const VIN = '5YJ3E1EA1PF000001';

// ---- emparejarEventosEnCargas ----
{
  const eventos = [
    { id: 'c1', tipo: 'charge_started', observado_en: '2026-09-20T22:00:00.000Z' },
    { id: 'c2', tipo: 'charge_stopped', observado_en: '2026-09-21T02:00:00.000Z' },
    { id: 'c3', tipo: 'charge_started', observado_en: '2026-09-21T20:00:00.000Z' } // abierta, sin cerrar
  ];
  const { pares, abiertoSinCerrar } = emparejarEventosEnCargas(eventos);
  assert(pares.length === 1 && pares[0].inicio.id === 'c1' && pares[0].fin.id === 'c2', 'una sesión de carga completa se empareja correctamente');
  assert(abiertoSinCerrar && abiertoSinCerrar.id === 'c3', 'una carga sin evento de fin todavía queda abierta, no se fuerza su cierre');
}

// ---- calcularCosteConReglas ----
{
  const carga = { location_id: 'loc-casa', energy_kwh: 20 };
  const reglaGratuita = [{ id: 'rp1', activa: 1, condicion: JSON.stringify({ location_id: 'loc-casa' }), accion: JSON.stringify({ free: true }) }];
  const gratuita = calcularCosteConReglas(carga, reglaGratuita);
  assert(gratuita.tipo === 'aplicada' && gratuita.resultado.total_cost === 0 && gratuita.resultado.cost_source === 'gratuita', 'una regla "free" da coste 0€ REAL, distinto de null (nunca "sin dato")');

  const reglaPorKwh = [{ id: 'rp2', activa: 1, condicion: JSON.stringify({ location_id: 'loc-casa' }), accion: JSON.stringify({ price_kwh: 0.15 }) }];
  const conPrecio = calcularCosteConReglas(carga, reglaPorKwh);
  assert(conPrecio.tipo === 'aplicada' && conPrecio.resultado.total_cost === 3, '20 kWh a 0.15€/kWh = 3€ exactos');

  assert(calcularCosteConReglas(carga, []).tipo === 'sin_reglas', 'sin ninguna regla de precio, nunca se inventa un coste');

  const contradictorias = [
    { id: 'rp3', activa: 1, condicion: JSON.stringify({ location_id: 'loc-casa' }), accion: JSON.stringify({ price_kwh: 0.15 }) },
    { id: 'rp4', activa: 1, condicion: JSON.stringify({ location_id: 'loc-casa' }), accion: JSON.stringify({ price_kwh: 0.30 }) }
  ];
  assert(calcularCosteConReglas(carga, contradictorias).tipo === 'ambiguo', 'dos reglas de precio distintas para el mismo lugar -> ambiguo, nunca se elige una al azar');
}

// ---- construirCargaDesdeEventos: energía real por delta, nunca inventada ----
{
  const inicio = { id: 'ci', observado_en: '2026-09-20T22:00:00.000Z', payload: { lat: 43.3619, lng: -5.8494, soc_pct: 40, ac_energy_kwh: 0 } };
  const fin = { id: 'cf', observado_en: '2026-09-21T02:00:00.000Z', payload: { lat: 43.3619, lng: -5.8494, soc_pct: 78, ac_energy_kwh: 14.2 } };
  const { carga, pendiente } = construirCargaDesdeEventos(VIN, inicio, fin, { ubicaciones: [], reglas: [], ahoraIso: '2026-09-21T02:01:00.000Z' });
  assert(carga.energy_kwh === 14.2 && carga.energy_source === 'ac_energy_in' && carga.charging_current_type === 'AC', 'la energía sale del delta real de ACChargingEnergyIn (14.2 kWh)');
  assert(carga.start_soc_pct === 40 && carga.end_soc_pct === 78, 'el SoC de inicio/fin se guarda tal cual lo mandó Tesla');
  assert(pendiente && pendiente.tipo === 'precio_carga', 'sin ninguna regla de precio configurada, la sesión queda pendiente de precio (nunca inventa un coste)');

  const sinEnergia = construirCargaDesdeEventos(VIN, { id: 'ci2', observado_en: '2026-09-20T10:00:00.000Z', payload: {} }, { id: 'cf2', observado_en: '2026-09-20T11:00:00.000Z', payload: {} }, { ubicaciones: [], reglas: [], ahoraIso: '2026-09-20T11:01:00.000Z' });
  assert(sinEnergia.carga.energy_kwh === null && sinEnergia.carga.data_quality === 'partial', 'sin ningún dato de energía en los eventos, el campo queda null y la calidad baja a "partial"');
}

// ---- Fin a fin: /internal/telemetry cierra la sesión, aplica la regla de precio y crea pendiente cuando no hay regla ----
async function firmar(secreto, timestamp, nonce, cuerpoTexto) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(timestamp + '.' + nonce + '.' + cuerpoTexto));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function kvEnMemoria() {
  const store = new Map();
  return { async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } };
}
async function enviar(env, cuerpoObjeto) {
  const cuerpoTexto = JSON.stringify(cuerpoObjeto);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = 'n-' + Math.random().toString(36).slice(2);
  const firma = await firmar(env.TELEMETRY_BRIDGE_SECRET, ts, nonce, cuerpoTexto);
  const headers = new Headers({ 'Content-Type': 'application/json', 'X-Signature': firma, 'X-Timestamp': ts, 'X-Nonce': nonce });
  const req = new Request('https://api.laperestronika.com/internal/telemetry', { method: 'POST', headers, body: cuerpoTexto });
  return workerModule.fetch(req, env);
}

async function pruebasAsincronas() {
  const db = crearMockD1();
  db._sembrarLocation({ id: 'loc-casa', vin: VIN, lat: 43.3619, lng: -5.8494, radius_m: 150 });
  db._sembrarRegla({ id: 'rp-casa', vin: VIN, tipo: 'precio_carga', condicion: JSON.stringify({ location_id: 'loc-casa' }), accion: JSON.stringify({ price_kwh: 0.15 }) });
  const env = { ALLOWED_ORIGIN: 'https://chollomaton.github.io', ADMIN_TOKEN: 'admin-secreto-123', TELEMETRY_BRIDGE_SECRET: 'bridge-secreto', TESLA_TOKENS: kvEnMemoria(), DB: db };
  // FASE A (A14/A10): el VIN debe estar autorizado y en modo != 'off' para que /internal/telemetry
  // procese cargas reales — igual que haría /seleccionar-vehiculo + el panel "Automatización".
  db._autorizarYActivar(VIN, 'active');

  await enviar(env, { vin: VIN, events: [{ id: 'ev-c-start', tipo: 'charge_started', observado_en: '2026-09-20T22:00:00.000Z', payload: { estado_carga: 'Charging', lat: 43.3619, lng: -5.8494, soc_pct: 40, ac_energy_kwh: 0 } }] });
  let res = await enviar(env, { vin: VIN, events: [{ id: 'ev-c-stop', tipo: 'charge_stopped', observado_en: '2026-09-21T02:00:00.000Z', payload: { estado_carga: 'Complete', lat: 43.3619, lng: -5.8494, soc_pct: 78, ac_energy_kwh: 14.2 } }] });
  let body = await res.json();
  assert(res.status === 200 && body.cargas_cerradas === 1, 'al llegar charge_stopped, la sesión se cierra automáticamente en la misma petición');

  const dump = db._dump();
  const cargas = Array.from(dump.chargingSessions.values());
  assert(cargas.length === 1, 'se ha guardado exactamente una sesión de carga en D1');
  const carga = cargas[0];
  assert(Math.abs(carga.energy_kwh - 14.2) < 0.001, 'la energía guardada coincide con el delta real recibido');
  assert(carga.location_id === 'loc-casa', 'la sesión reconoce "casa" por geofence');
  assert(Math.abs(carga.total_cost - 2.13) < 0.001 && carga.cost_source === 'estimado', '14.2 kWh a 0.15€/kWh se calculan solos: 2.13€, con la regla de precio de casa');
  assert(dump.pendingActions.size === 0, 'con una regla de precio aplicable, NO se crea ningún pendiente');

  // Reintento del bridge -> idempotente, no duplica la sesión.
  res = await enviar(env, { vin: VIN, events: [{ id: 'ev-c-stop', tipo: 'charge_stopped', observado_en: '2026-09-21T02:00:00.000Z', payload: { estado_carga: 'Complete', lat: 43.3619, lng: -5.8494, soc_pct: 78, ac_energy_kwh: 14.2 } }] });
  const dump2 = db._dump();
  assert(dump2.chargingSessions.size === 1, 'reenviar el mismo evento nunca duplica la sesión de carga ya cerrada');

  // Una carga en un lugar SIN regla de precio -> pendiente, coste nunca inventado.
  await enviar(env, { vin: VIN, events: [{ id: 'ev-c2-start', tipo: 'charge_started', observado_en: '2026-09-22T10:00:00.000Z', payload: { estado_carga: 'Charging', lat: 10.0, lng: 10.0, soc_pct: 50, dc_energy_kwh: 0 } }] });
  res = await enviar(env, { vin: VIN, events: [{ id: 'ev-c2-stop', tipo: 'charge_stopped', observado_en: '2026-09-22T10:30:00.000Z', payload: { estado_carga: 'Complete', lat: 10.0, lng: 10.0, soc_pct: 80, dc_energy_kwh: 25 } }] });
  body = await res.json();
  const dump3 = db._dump();
  assert(body.cargas_cerradas === 1 && dump3.chargingSessions.size === 2, 'una carga de superchargador (DC, lugar desconocido) también se cierra automáticamente');
  const cargaSuper = Array.from(dump3.chargingSessions.values()).find((c) => c.charging_current_type === 'DC');
  assert(cargaSuper.energy_kwh === 25 && cargaSuper.total_cost === null, 'la energía DC se calcula igual, pero sin regla de precio para ese lugar el coste queda null (nunca inventado)');
  assert(dump3.pendingActions.size === 1, 'esa carga sin precio conocido genera exactamente un pendiente de tipo precio_carga');

  // Resolver el pendiente de precio a mano.
  const pendienteCarga = Array.from(dump3.pendingActions.values())[0];
  res = await workerModule.fetch(new Request('https://api.laperestronika.com/pendientes/resolver', {
    method: 'POST', headers: { Authorization: 'Bearer ' + env.ADMIN_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: pendienteCarga.id, resuelto_con: { total_cost: 9.5 } })
  }), env);
  body = await res.json();
  assert(res.status === 200 && body.ok === true, 'resolver el pendiente de precio de carga funciona');
  const dump4 = db._dump();
  assert(dump4.chargingSessions.get(cargaSuper.id).total_cost === 9.5 && dump4.chargingSessions.get(cargaSuper.id).cost_source === 'conocido', 'tras la respuesta manual, la sesión queda con el coste indicado por el usuario y fuente "conocido"');

  console.log('');
  if (fallos === 0) console.log('TODO OK — Fase 4C: cargas 100% automáticas');
  else { console.log(fallos + ' fallo(s).'); process.exitCode = 1; }
}

pruebasAsincronas();
