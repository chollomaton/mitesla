// Fase 4B — motor de viajes 100% automáticos: emparejamiento de eventos, cálculo de distancia
// por odómetro, geofences, clasificación por reglas (con pendiente cuando no hay una respuesta
// clara), e idempotencia del cierre automático a través del endpoint real /internal/telemetry.
import workerModule, {
  distanciaMetros, emparejarUbicacion, snapshotMasCercano, emparejarEventosEnViajes,
  construirViajeDesdeEventos, clasificarViajeConReglas, procesarViajesPendientes
} from '../worker.js';
import { createHash } from 'node:crypto';
import { crearMockD1 } from './helpers/sqlite_d1.js';

let fallos = 0;
function assert(cond, msg) {
  if (!cond) { console.log('❌ FALLO:', msg); fallos++; }
  else console.log('✅', msg);
}

const VIN = '5YJ3E1EA1PF000001';

// ---- distanciaMetros / emparejarUbicacion ----
{
  const casa = { id: 'loc-casa', lat: 43.3619, lng: -5.8494, radius_m: 150 };
  const trabajo = { id: 'loc-trabajo', lat: 43.3700, lng: -5.8300, radius_m: 100 };
  assert(distanciaMetros(43.3619, -5.8494, 43.3619, -5.8494) === 0, 'distanciaMetros del mismo punto consigo mismo es 0');
  assert(emparejarUbicacion(43.3619, -5.8494, [casa, trabajo]).id === 'loc-casa', 'emparejarUbicacion reconoce un punto dentro del radio de "casa"');
  assert(emparejarUbicacion(40.0, -3.0, [casa, trabajo]) === null, 'emparejarUbicacion no inventa un lugar para un punto lejano de cualquier geofence');
  assert(emparejarUbicacion(null, null, [casa]) === null, 'emparejarUbicacion sin coordenadas nunca revienta, devuelve null');
}

// ---- snapshotMasCercano ----
{
  const lista = [
    { valor: 100, observado_en: '2026-09-20T08:00:00.000Z' },
    { valor: 112, observado_en: '2026-09-20T08:20:00.000Z' }
  ];
  const cercano = snapshotMasCercano(lista, '2026-09-20T08:19:00.000Z', 10 * 60 * 1000);
  assert(cercano && cercano.valor === 112, 'snapshotMasCercano elige la lectura más próxima en el tiempo, no la primera de la lista');
  const fueraDeVentana = snapshotMasCercano(lista, '2026-09-20T10:00:00.000Z', 10 * 60 * 1000);
  assert(fueraDeVentana === null, 'snapshotMasCercano devuelve null si nada cae dentro de la ventana (nunca un dato de hace horas)');
}

// ---- emparejarEventosEnViajes: defensivo ante datos imperfectos ----
{
  const eventos = [
    { id: 'e1', tipo: 'trip_started', observado_en: '2026-09-20T08:00:00.000Z' },
    { id: 'e2', tipo: 'trip_started', observado_en: '2026-09-20T08:01:00.000Z' }, // falsa apertura, se descarta
    { id: 'e3', tipo: 'trip_finished', observado_en: '2026-09-20T08:20:00.000Z' },
    { id: 'e4', tipo: 'trip_finished', observado_en: '2026-09-20T09:00:00.000Z' }, // sin apertura, se ignora
    { id: 'e5', tipo: 'trip_started', observado_en: '2026-09-20T10:00:00.000Z' } // viaje abierto, sin cerrar todavía
  ];
  const { pares, abiertoSinCerrar } = emparejarEventosEnViajes(eventos);
  assert(pares.length === 1 && pares[0].inicio.id === 'e2' && pares[0].fin.id === 'e3', 'dos "started" seguidos: se queda con el segundo como el inicio real del viaje cerrado por e3');
  assert(abiertoSinCerrar && abiertoSinCerrar.id === 'e5', 'el último "started" sin "finished" queda como viaje abierto, no se fuerza su cierre');
}

// ---- clasificarViajeConReglas ----
{
  const trip = { start_location_id: 'loc-casa', end_location_id: 'loc-trabajo' };
  const reglaUnica = [{ id: 'r1', activa: 1, condicion: JSON.stringify({ origen_location_id: 'loc-casa', destino_location_id: 'loc-trabajo' }), accion: JSON.stringify({ classification: 'trabajo' }) }];
  assert(clasificarViajeConReglas(trip, reglaUnica).tipo === 'aplicada', 'una única regla que coincide se aplica automáticamente');

  const sinReglas = clasificarViajeConReglas(trip, []);
  assert(sinReglas.tipo === 'sin_reglas', 'sin ninguna regla configurada, nunca se inventa una clasificación');

  const reglasContradictorias = [
    { id: 'r1', activa: 1, condicion: JSON.stringify({ origen_location_id: 'loc-casa' }), accion: JSON.stringify({ classification: 'trabajo' }) },
    { id: 'r2', activa: 1, condicion: JSON.stringify({ destino_location_id: 'loc-trabajo' }), accion: JSON.stringify({ classification: 'personal' }) }
  ];
  assert(clasificarViajeConReglas(trip, reglasContradictorias).tipo === 'ambiguo', 'dos reglas que coinciden con resultados distintos -> ambiguo, nunca se elige una al azar');

  const reglaInactiva = [{ id: 'r3', activa: 0, condicion: JSON.stringify({}), accion: JSON.stringify({ classification: 'trabajo' }) }];
  assert(clasificarViajeConReglas(trip, reglaInactiva).tipo === 'sin_reglas', 'una regla desactivada nunca se aplica');
}

// ---- construirViajeDesdeEventos: nunca inventa datos que no tiene ----
{
  const inicio = { id: 'ei', observado_en: '2026-09-20T08:00:00.000Z', payload: { lat: 43.3619, lng: -5.8494, odometro_km: 15000 } };
  const fin = { id: 'ef', observado_en: '2026-09-20T08:20:00.000Z', payload: { lat: 43.3700, lng: -5.8300, odometro_km: 15012 } };
  const { trip, pendiente } = construirViajeDesdeEventos(VIN, inicio, fin, {
    odometroSnapshots: [], bateriaSnapshots: [], ubicaciones: [], reglas: [], ahoraIso: '2026-09-20T08:21:00.000Z'
  });
  assert(trip.distance_km === 12, 'la distancia sale del odómetro del propio evento cuando no hay snapshot de historial más preciso (15012-15000=12)');
  assert(trip.duration_min === 20, 'la duración se calcula a partir de los timestamps de inicio/fin');
  assert(trip.start_location_id === null && trip.end_location_id === null, 'sin geofences configurados, la ubicación queda null, nunca inventada');
  assert(trip.data_quality === 'partial', 'sin ubicación resuelta, la calidad del dato es "partial", nunca "complete" con huecos ocultos');
  assert(pendiente && pendiente.tipo === 'clasificar_viaje', 'sin reglas de clasificación, el viaje queda como pendiente para el usuario');
}

// ---- B9: energy_used_kwh — medido (EnergyRemaining) siempre se prefiere sobre estimado (SoC) ----
{
  const inicio = { id: 'ei9', observado_en: '2026-09-20T08:00:00.000Z', payload: { lat: 43.3619, lng: -5.8494, odometro_km: 15000 } };
  const fin = { id: 'ef9', observado_en: '2026-09-20T08:20:00.000Z', payload: { lat: 43.3700, lng: -5.8300, odometro_km: 15012 } };

  // Caso 1: hay EnergyRemaining fiable en ambos extremos -> medido, nunca estimado, aunque también
  // haya capacidad nominal disponible (la medida real siempre gana a la estimación).
  const bateriaConEnergia = [
    { valor: 80, energy_remaining_kwh: 60, observado_en: '2026-09-20T08:00:00.000Z' },
    { valor: 76, energy_remaining_kwh: 57, observado_en: '2026-09-20T08:20:00.000Z' }
  ];
  const r1 = construirViajeDesdeEventos(VIN, inicio, fin, {
    odometroSnapshots: [], bateriaSnapshots: bateriaConEnergia, ubicaciones: [], reglas: [], ahoraIso: '2026-09-20T08:21:00.000Z', capacidadNominalKwh: 75
  });
  assert(r1.trip.start_energy_remaining_kwh === 60 && r1.trip.end_energy_remaining_kwh === 57, 'B9: start/end_energy_remaining_kwh se rellenan con las lecturas reales más cercanas');
  assert(r1.trip.energy_used_kwh === 3, 'B9: con EnergyRemaining fiable, energy_used_kwh es la medida real (60-57=3), no una estimación');
  assert(r1.trip.energy_source === 'energy_remaining_delta', 'B9: energy_source se etiqueta "energy_remaining_delta" cuando el dato es medido');
  assert(r1.trip.consumption_is_estimated === 0, 'B9: consumption_is_estimated=0 para un valor medido');

  // Caso 2: sin EnergyRemaining pero SÍ con SoC y capacidad nominal conocida -> estimado, etiquetado
  // como tal, nunca disfrazado de medida real.
  const bateriaSoloSoc = [
    { valor: 80, energy_remaining_kwh: null, observado_en: '2026-09-20T08:00:00.000Z' },
    { valor: 76, energy_remaining_kwh: null, observado_en: '2026-09-20T08:20:00.000Z' }
  ];
  const r2 = construirViajeDesdeEventos(VIN, inicio, fin, {
    odometroSnapshots: [], bateriaSnapshots: bateriaSoloSoc, ubicaciones: [], reglas: [], ahoraIso: '2026-09-20T08:21:00.000Z', capacidadNominalKwh: 75
  });
  assert(Math.abs(r2.trip.energy_used_kwh - 3) < 0.001, 'B9: sin EnergyRemaining, se estima por caída de SoC ((80-76)/100*75=3)');
  assert(r2.trip.energy_source === 'soc_delta_estimado', 'B9: energy_source se etiqueta "soc_delta_estimado" para dejar claro que NO es una medida real');
  assert(r2.trip.consumption_is_estimated === 1, 'B9: consumption_is_estimated=1 marca explícitamente que es una estimación');

  // Caso 3: sin EnergyRemaining y sin capacidad nominal conocida -> null, nunca un número inventado
  // a partir de una capacidad genérica supuesta.
  const r3 = construirViajeDesdeEventos(VIN, inicio, fin, {
    odometroSnapshots: [], bateriaSnapshots: bateriaSoloSoc, ubicaciones: [], reglas: [], ahoraIso: '2026-09-20T08:21:00.000Z', capacidadNominalKwh: null
  });
  assert(r3.trip.energy_used_kwh === null && r3.trip.energy_source === null && r3.trip.consumption_is_estimated === 0, 'B9: sin EnergyRemaining NI capacidad nominal conocida, energy_used_kwh queda en null — nunca se asume una capacidad genérica (p.ej. "75 kWh por defecto")');

  // Caso 4: EnergyRemaining presente pero incoherente (aumenta, p.ej. por una recarga a mitad de
  // trayecto o un dato corrupto) -> no se usa como medida, cae al fallback de SoC si es posible.
  const bateriaIncoherente = [
    { valor: 80, energy_remaining_kwh: 55, observado_en: '2026-09-20T08:00:00.000Z' },
    { valor: 76, energy_remaining_kwh: 57, observado_en: '2026-09-20T08:20:00.000Z' } // energy_remaining SUBE: incoherente para un viaje
  ];
  const r4 = construirViajeDesdeEventos(VIN, inicio, fin, {
    odometroSnapshots: [], bateriaSnapshots: bateriaIncoherente, ubicaciones: [], reglas: [], ahoraIso: '2026-09-20T08:21:00.000Z', capacidadNominalKwh: 75
  });
  assert(r4.trip.energy_source === 'soc_delta_estimado', 'B9: un EnergyRemaining incoherente (sube en vez de bajar) no se usa como medida — se cae al fallback de SoC en vez de reportar un consumo negativo sin sentido');
}

// ---- Fin a fin, a través del endpoint real /internal/telemetry ----
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
  db._sembrarLocation({ id: 'loc-trabajo', vin: VIN, lat: 43.3700, lng: -5.8300, radius_m: 100 });
  db._sembrarRegla({ id: 'r1', vin: VIN, tipo: 'clasificacion_viaje', condicion: JSON.stringify({ origen_location_id: 'loc-casa', destino_location_id: 'loc-trabajo' }), accion: JSON.stringify({ classification: 'trabajo' }) });

  const env = { ALLOWED_ORIGIN: 'https://chollomaton.github.io', ADMIN_TOKEN: 'admin-secreto-123', TELEMETRY_BRIDGE_SECRET: 'bridge-secreto', TESLA_TOKENS: kvEnMemoria(), DB: db };
  env.SESSION_TOKEN='s'.repeat(43);
  db._sql.prepare('INSERT INTO sessions(id,token_hash,created_at,expires_at) VALUES(?,?,?,?)').run('test-session',createHash('sha256').update(env.SESSION_TOKEN).digest('hex'),Date.now(),Date.now()+86400000);
  // FASE A (A14/A10): el VIN debe estar autorizado y en modo != 'off' para que /internal/telemetry
  // procese viajes reales — igual que haría /seleccionar-vehiculo + el panel "Automatización".
  db._autorizarYActivar(VIN, 'active');

  // 1) Llega el evento de inicio: no hay viaje que cerrar todavía.
  let res = await enviar(env, {
    vin: VIN,
    events: [{ id: 'ev-start-1', tipo: 'trip_started', observado_en: '2026-09-20T08:00:00.000Z', payload: { shift_state: 'D', lat: 43.3619, lng: -5.8494, odometro_km: 15000 } }]
  });
  let body = await res.json();
  assert(res.status === 200 && body.viajes_cerrados === 0, 'con solo el evento de inicio, todavía no se cierra ningún viaje');

  // 2) Llega el evento de fin: el viaje se cierra automáticamente EN ESTA MISMA PETICIÓN.
  res = await enviar(env, {
    vin: VIN,
    events: [{ id: 'ev-finish-1', tipo: 'trip_finished', observado_en: '2026-09-20T08:20:00.000Z', payload: { shift_state: 'P', lat: 43.3700, lng: -5.8300, odometro_km: 15012 } }]
  });
  body = await res.json();
  assert(res.status === 200 && body.viajes_cerrados === 1, 'al llegar el evento de fin, el viaje se cierra automáticamente en la misma petición (funciona con la PWA cerrada)');

  const dump = db._dump();
  const viajesGuardados = Array.from(dump.trips.values());
  assert(viajesGuardados.length === 1, 'se ha guardado exactamente un viaje en D1');
  const viaje = viajesGuardados[0];
  assert(viaje.distance_km === 12, 'el viaje guardado en D1 tiene la distancia correcta calculada por odómetro');
  assert(viaje.start_location_id === 'loc-casa' && viaje.end_location_id === 'loc-trabajo', 'el viaje reconoce "casa" y "trabajo" por geofence');
  assert(viaje.classification === 'trabajo' && viaje.classification_source === 'rule', 'la regla configurada clasifica el viaje automáticamente, sin preguntar al usuario');
  assert(dump.pendingActions.size === 0, 'con una regla aplicable sin ambigüedad, NO se crea ningún pendiente');
  const reglaActualizada = dump.automationRules.get('r1');
  assert(reglaActualizada.veces_usada === 1, 'la regla usada incrementa su contador de uso (para la futura UI de "Automatizaciones")');

  const eventosMarcados = Array.from(dump.events.values()).filter((e) => e.id === 'ev-start-1' || e.id === 'ev-finish-1');
  assert(eventosMarcados.every((e) => e.procesado_en), 'los dos eventos del viaje quedan marcados como procesados (no se reprocesarán en el siguiente ciclo)');

  // 3) Reenviar el bridge (reintento de red) con los MISMOS event_id -> no duplica el viaje ni el pendiente.
  res = await enviar(env, {
    vin: VIN,
    events: [{ id: 'ev-finish-1', tipo: 'trip_finished', observado_en: '2026-09-20T08:20:00.000Z', payload: { shift_state: 'P', lat: 43.3700, lng: -5.8300, odometro_km: 15012 } }]
  });
  body = await res.json();
  const dump2 = db._dump();
  assert(dump2.trips.size === 1, 'reenviar el mismo evento (reintento del bridge) nunca duplica el viaje ya cerrado');

  // 4) Un segundo viaje SIN regla aplicable -> se guarda como pendiente, nunca se inventa una clasificación.
  await enviar(env, { vin: VIN, events: [{ id: 'ev-start-2', tipo: 'trip_started', observado_en: '2026-09-20T18:00:00.000Z', payload: { shift_state: 'D', lat: 43.3700, lng: -5.8300, odometro_km: 15012 } }] });
  res = await enviar(env, { vin: VIN, events: [{ id: 'ev-finish-2', tipo: 'trip_finished', observado_en: '2026-09-20T18:15:00.000Z', payload: { shift_state: 'P', lat: 43.3619, lng: -5.8494, odometro_km: 15020 } }] });
  body = await res.json();
  const dump3 = db._dump();
  assert(body.viajes_cerrados === 1 && dump3.trips.size === 2, 'el viaje de vuelta (trabajo->casa) también se cierra automáticamente');
  const viajeVuelta = Array.from(dump3.trips.values()).find((t) => t.start_location_id === 'loc-trabajo');
  assert(viajeVuelta && viajeVuelta.classification === null, 'sin una regla para el sentido "trabajo->casa", el viaje NO se clasifica solo (la regla sembrada era específica de casa->trabajo)');
  assert(dump3.pendingActions.size === 1, 'ese viaje sin regla aplicable genera exactamente un pendiente para que el usuario lo clasifique');

  // 5) /pendientes lista el viaje sin clasificar, y /pendientes/resolver lo cierra a mano.
  let resPend = await workerModule.fetch(new Request('https://api.laperestronika.com/pendientes?vin=' + VIN, {
    headers: { Authorization: 'Bearer ' + env.SESSION_TOKEN }
  }), env);
  let bodyPend = await resPend.json();
  assert(resPend.status === 200 && bodyPend.pendientes.length === 1, 'GET /pendientes devuelve exactamente el pendiente real (viaje trabajo->casa)');
  const idPendiente = bodyPend.pendientes[0].id;
  assert(bodyPend.pendientes[0].detalle && bodyPend.pendientes[0].detalle.distance_km === 8, 'el detalle del pendiente trae datos reales del viaje (distancia), no un texto genérico');

  resPend = await workerModule.fetch(new Request('https://api.laperestronika.com/pendientes?vin=' + VIN), env); // sin Authorization
  assert(resPend.status === 401, 'GET /pendientes sin autenticar -> 401');

  let resResolver = await workerModule.fetch(new Request('https://api.laperestronika.com/pendientes/resolver', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.SESSION_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: idPendiente, resuelto_con: { classification: 'personal' } })
  }), env);
  const bodyResolver = await resResolver.json();
  assert(resResolver.status === 200 && bodyResolver.ok === true, 'POST /pendientes/resolver acepta la respuesta del usuario');

  const dump4 = db._dump();
  const viajeResuelto = dump4.trips.get(viajeVuelta.id);
  assert(viajeResuelto.classification === 'personal' && viajeResuelto.classification_source === 'manual', 'el viaje queda clasificado como "personal" con fuente "manual" tras la respuesta del usuario');
  assert(dump4.pendingActions.get(idPendiente).resuelto_en, 'el pendiente queda marcado como resuelto');

  resResolver = await workerModule.fetch(new Request('https://api.laperestronika.com/pendientes/resolver', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.SESSION_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: idPendiente, resuelto_con: { classification: 'trabajo' } })
  }), env);
  assert(resResolver.status === 409, 'resolver un pendiente ya resuelto una segunda vez -> 409, no lo vuelve a aplicar');

  resPend = await workerModule.fetch(new Request('https://api.laperestronika.com/pendientes?vin=' + VIN, {
    headers: { Authorization: 'Bearer ' + env.SESSION_TOKEN }
  }), env);
  bodyPend = await resPend.json();
  assert(bodyPend.pendientes.length === 0, 'una vez resuelto, el pendiente ya no aparece en la lista de abiertos');

  console.log('');
  if (fallos === 0) console.log('TODO OK — Fase 4B: motor de viajes 100% automáticos');
  else { console.log(fallos + ' fallo(s).'); process.exitCode = 1; }
}

pruebasAsincronas();
