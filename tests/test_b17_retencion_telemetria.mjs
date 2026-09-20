// B17 (FASE B): retención — purga solo telemetría cruda YA PROCESADA y suficientemente antigua.
// Nunca purga: (a) eventos sin procesar, por antiguos que sean (se perdería un dato real que
// todavía no ha servido para construir ningún viaje/carga), (b) eventos procesados pero recientes
// (dentro de la ventana de retención). Los datos canónicos (trips, charging_sessions) no los toca
// esta función en absoluto — purgarTelemetriaCruda solo opera sobre telemetry_events_short_retention.
import workerModule, { purgarTelemetriaCruda } from '../worker.js';
import { crearMockD1 } from './helpers/mock_d1.js';

let fallos = 0;
function assert(cond, msg) {
  if (!cond) { console.log('❌ FALLO:', msg); fallos++; }
  else console.log('✅', msg);
}

const VIN = '5YJ3E1EA1PF000001';
const AHORA = Date.now();
function haceDias(n) { return new Date(AHORA - n * 86400000).toISOString(); }

async function pruebas() {
  const db = crearMockD1();
  const env = { DB: db };

  // Evento procesado, MUY antiguo (20 días) -> debe purgarse (procesado + fuera de la ventana de 7 días).
  db._sembrarEvento({ id: 'ev-procesado-viejo', vin: VIN, tipo: 'trip_finished', payload: '{}', observado_en: haceDias(20), recibido_en: haceDias(20), procesado_en: haceDias(19) });
  // Evento procesado, RECIENTE (1 día) -> NO debe purgarse (dentro de la ventana).
  db._sembrarEvento({ id: 'ev-procesado-reciente', vin: VIN, tipo: 'trip_finished', payload: '{}', observado_en: haceDias(1), recibido_en: haceDias(1), procesado_en: haceDias(1) });
  // Evento SIN PROCESAR, MUY antiguo (30 días) -> NUNCA debe purgarse, por viejo que sea: perderlo
  // sin haberlo usado para construir un viaje/carga sería perder un dato real.
  db._sembrarEvento({ id: 'ev-sin-procesar-viejo', vin: VIN, tipo: 'trip_started', payload: '{}', observado_en: haceDias(30), recibido_en: haceDias(30), procesado_en: null });
  // Evento procesado, EXACTAMENTE en el borde (8 días, retención=7) -> debe purgarse.
  db._sembrarEvento({ id: 'ev-procesado-borde', vin: VIN, tipo: 'charge_stopped', payload: '{}', observado_en: haceDias(8), recibido_en: haceDias(8), procesado_en: haceDias(7) });

  const purgados = await purgarTelemetriaCruda(env, { diasRetencion: 7 });
  assert(purgados === 2, 'purgarTelemetriaCruda() borra exactamente las 2 filas procesadas y fuera de la ventana de retención (viejo + borde), obtenido: ' + purgados);

  const dump = db._dump();
  assert(!dump.events.has('ev-procesado-viejo'), 'el evento procesado y muy antiguo ha desaparecido');
  assert(!dump.events.has('ev-procesado-borde'), 'el evento procesado justo en el borde de la ventana también se purga (>= corta, no solo >)');
  assert(dump.events.has('ev-procesado-reciente'), 'B17: el evento procesado pero RECIENTE se conserva (todavía dentro de la ventana de retención)');
  assert(dump.events.has('ev-sin-procesar-viejo'), 'B17: el evento SIN PROCESAR se conserva SIEMPRE, por antiguo que sea — nunca se pierde un dato real que aún no se ha usado');

  // Una segunda pasada sobre el mismo estado no debe volver a "purgar" nada (idempotente).
  const purgadosSegundaPasada = await purgarTelemetriaCruda(env, { diasRetencion: 7 });
  assert(purgadosSegundaPasada === 0, 'una segunda ejecución sobre el mismo estado no purga nada más (ya no queda nada purgable)');

  // El Cron Trigger real (scheduled) debe invocar la purga junto al resto de tareas programadas —
  // se comprueba llamando al handler exportado por defecto directamente, con un DB mínimo.
  const db2 = crearMockD1();
  db2._sembrarEvento({ id: 'ev-cron', vin: VIN, tipo: 'trip_finished', payload: '{}', observado_en: haceDias(20), recibido_en: haceDias(20), procesado_en: haceDias(19) });
  await workerModule.scheduled({}, { DB: db2 }, {});
  assert(!db2._dump().events.has('ev-cron'), 'B17: el Cron Trigger real (export default.scheduled) invoca purgarTelemetriaCruda() como parte de su ejecución programada');

  console.log('');
  if (fallos === 0) console.log('TODO OK — B17: retención de telemetría cruda');
  else { console.log(fallos + ' fallo(s).'); process.exitCode = 1; }
}

pruebas();
