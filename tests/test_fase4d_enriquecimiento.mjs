// Fase 4D — enriquecimiento en background: geocodificación inversa y clima histórico de viajes ya
// cerrados, sin bloquear nunca el cierre en sí (eso ya pasó en la Fase 4B, síncrono y sin red
// externa). Aquí se prueba con un `fetchImpl` simulado — nunca contra Nominatim/Open-Meteo reales.
import workerModule, {
  extraerNombreLugar, extraerResumenClima, construirUrlNominatim, construirUrlOpenMeteo, enriquecerViajesPendientes
} from '../worker.js';
import { crearMockD1 } from './helpers/mock_d1.js';

let fallos = 0;
function assert(cond, msg) {
  if (!cond) { console.log('❌ FALLO:', msg); fallos++; }
  else console.log('✅', msg);
}

// ---- extraerNombreLugar: nunca inventa, prefiere vía+localidad, cae a localidad o display_name ----
{
  assert(extraerNombreLugar({ address: { road: 'Calle Corrida', city: 'Gijón' } }) === 'Calle Corrida, Gijón', 'prioriza "vía, localidad" cuando ambas están presentes');
  assert(extraerNombreLugar({ address: { town: 'Gijón' } }) === 'Gijón', 'cae a solo la localidad si no hay vía');
  assert(extraerNombreLugar({ address: {}, display_name: 'Algo, Asturias, España' }) === 'Algo, Asturias, España', 'sin vía ni localidad, usa el display_name como último recurso');
  assert(extraerNombreLugar({ address: {} }) === null, 'sin absolutamente nada aprovechable, devuelve null (nunca "ubicación desconocida" inventado)');
  assert(extraerNombreLugar(null) === null, 'una respuesta nula nunca revienta esta función');
}

// ---- extraerResumenClima: solo si hay una hora razonablemente cercana ----
{
  const respuesta = { hourly: { time: ['2026-09-20T07:00', '2026-09-20T08:00', '2026-09-20T09:00'], temperature_2m: [15, 17, 19], precipitation: [0, 0.2, 0] } };
  const clima = extraerResumenClima(respuesta, '2026-09-20T08:10:00.000Z');
  assert(clima && clima.temperatura === 17, 'elige la hora más cercana al instante del viaje (08:00, no 07:00 ni 09:00)');
  const climaLejano = extraerResumenClima(respuesta, '2026-09-25T08:00:00.000Z');
  assert(climaLejano === null, 'si la hora más cercana está a días de diferencia (sin datos de ese día), no inventa un clima aproximado');
  assert(extraerResumenClima({}, '2026-09-20T08:00:00.000Z') === null, 'una respuesta sin "hourly" nunca revienta, devuelve null');
}

// ---- construirUrlNominatim / construirUrlOpenMeteo: URLs correctas, sin claves hardcodeadas ----
{
  assert(construirUrlNominatim(43.36, -5.84).includes('lat=43.36') && construirUrlNominatim(43.36, -5.84).includes('lon=-5.84'), 'la URL de Nominatim lleva las coordenadas correctas');
  assert(construirUrlOpenMeteo(43.36, -5.84, '2026-09-20T08:00:00.000Z').includes('start_date=2026-09-20'), 'la URL de Open-Meteo usa solo la fecha (YYYY-MM-DD), no la hora completa');
}

// ---- enriquecerViajesPendientes: orquestación completa con red simulada ----
async function pruebasAsincronas() {
  const db = crearMockD1();
  const env = { DB: db };

  // Sembramos dos viajes ya cerrados directamente en D1 (como los dejaría la Fase 4B).
  // Coordenadas de inicio y fin DISTINTAS entre sí (y entre ambos viajes) para poder distinguir,
  // con la caché por coordenada de B19 activa, cuántas llamadas reales a Nominatim se hacen.
  const VIN = '5YJ3E1EA1PF000001';
  function sembrarViaje(id, latIni, lngIni, latFin, lngFin, startedAt, startLocId, endLocId) {
    return db.prepare(
      'INSERT INTO trips (id, vin, started_at, ended_at, start_odometer_km, end_odometer_km, distance_km, duration_min, ' +
      'start_soc_pct, end_soc_pct, start_lat, start_lng, end_lat, end_lng, start_location_id, end_location_id, ' +
      'classification, classification_source, classification_rule_id, data_quality, source, created_at, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(id, VIN, startedAt, startedAt, 100, 110, 10, 15, 80, 70, latIni, lngIni, latFin, lngFin, startLocId || null, endLocId || null, null, null, null, 'complete', 'TESLA_TELEMETRY', startedAt, startedAt).run();
  }
  await sembrarViaje('trip-1', 43.3619, -5.8494, 43.3625, -5.8500, '2026-09-20T08:00:00.000Z');
  await sembrarViaje('trip-2', 43.3700, -5.8300, 43.3710, -5.8310, '2026-09-20T18:00:00.000Z');

  let llamadasNominatim = 0, llamadasOpenMeteo = 0;
  const fetchSimulado = async (url) => {
    if (url.includes('nominatim')) {
      llamadasNominatim++;
      return { ok: true, json: async () => ({ address: { road: 'Calle de Prueba', city: 'Gijón' } }) };
    }
    if (url.includes('open-meteo')) {
      llamadasOpenMeteo++;
      return { ok: true, json: async () => ({ hourly: { time: ['2026-09-20T08:00', '2026-09-20T18:00'], temperature_2m: [16, 22], precipitation: [0, 0] } }) };
    }
    return { ok: false };
  };

  const procesados = await enriquecerViajesPendientes(env, { fetchImpl: fetchSimulado, esperaMs: 0 });
  assert(procesados === 2, 'los dos viajes sembrados se enriquecen en esta pasada');
  assert(llamadasNominatim === 4, 'con coordenadas todas distintas, se pide geocodificación de origen Y destino para cada viaje (2 viajes x 2 = 4 llamadas)');
  assert(llamadasOpenMeteo === 2, 'se pide el clima histórico una vez por viaje (usa el mismo punto/día para origen)');

  const dump = db._dump();
  const trip1 = dump.trips.get('trip-1');
  assert(trip1.start_location_raw === 'Calle de Prueba, Gijón' && trip1.end_location_raw === 'Calle de Prueba, Gijón', 'el viaje queda enriquecido con el nombre de lugar real devuelto por Nominatim');
  assert(trip1.weather && JSON.parse(trip1.weather).temperatura === 16, 'el viaje queda con el clima histórico real de Open-Meteo para su hora');

  // Segunda pasada: como ya están enriquecidos, no debería volver a llamar a ninguna API.
  llamadasNominatim = 0; llamadasOpenMeteo = 0;
  const procesadosSegundaPasada = await enriquecerViajesPendientes(env, { fetchImpl: fetchSimulado, esperaMs: 0 });
  assert(procesadosSegundaPasada === 0 && llamadasNominatim === 0 && llamadasOpenMeteo === 0, 'un viaje ya enriquecido no se vuelve a consultar en la siguiente pasada (no desperdicia llamadas gratuitas)');

  // Un fallo de red en un viaje no debe tirar el resto del lote.
  const db2 = crearMockD1();
  const env2 = { DB: db2 };
  await db2.prepare(
    'INSERT INTO trips (id, vin, started_at, ended_at, start_odometer_km, end_odometer_km, distance_km, duration_min, ' +
    'start_soc_pct, end_soc_pct, start_lat, start_lng, end_lat, end_lng, start_location_id, end_location_id, ' +
    'classification, classification_source, classification_rule_id, data_quality, source, created_at, updated_at) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind('trip-fallo', VIN, '2026-09-20T08:00:00.000Z', '2026-09-20T08:00:00.000Z', 100, 110, 10, 15, 80, 70, 1, 1, 1, 1, null, null, null, null, null, 'complete', 'TESLA_TELEMETRY', '2026-09-20T08:00:00.000Z', '2026-09-20T08:00:00.000Z').run();
  const fetchQueSiempreFalla = async () => { throw new Error('red caída (simulado)'); };
  const procesadosConFallo = await enriquecerViajesPendientes(env2, { fetchImpl: fetchQueSiempreFalla, esperaMs: 0 });
  assert(procesadosConFallo === 0, 'si la API externa falla, el viaje queda sin enriquecer (se reintentará en la próxima pasada programada), sin lanzar una excepción que tire todo el job');

  // ---- B19: geofence antes que geocoder — un viaje con start_location_id/end_location_id ya
  // resuelto (por emparejamiento con un lugar conocido al cerrar el viaje) NUNCA debe llamar a
  // Nominatim para ese punto: usa directamente el nombre del lugar guardado en D1. ----
  {
    const db3 = crearMockD1();
    const env3 = { DB: db3 };
    db3._sembrarLocation({ id: 'loc-casa', vin: VIN, name: 'Casa', lat: 43.3619, lng: -5.8494, radius_m: 100, created_at: '2026-01-01', updated_at: '2026-01-01' });
    db3._sembrarLocation({ id: 'loc-trabajo', vin: VIN, name: 'Federación (Trabajo)', lat: 43.3700, lng: -5.8300, radius_m: 100, created_at: '2026-01-01', updated_at: '2026-01-01' });
    await db3.prepare(
      'INSERT INTO trips (id, vin, started_at, ended_at, start_odometer_km, end_odometer_km, distance_km, duration_min, ' +
      'start_soc_pct, end_soc_pct, start_lat, start_lng, end_lat, end_lng, start_location_id, end_location_id, ' +
      'classification, classification_source, classification_rule_id, data_quality, source, created_at, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind('trip-geofence', VIN, '2026-09-20T08:00:00.000Z', '2026-09-20T08:00:00.000Z', 100, 110, 10, 15, 80, 70, 43.3619, -5.8494, 43.3700, -5.8300, 'loc-casa', 'loc-trabajo', null, null, null, 'complete', 'TESLA_TELEMETRY', '2026-09-20T08:00:00.000Z', '2026-09-20T08:00:00.000Z').run();
    let llamadasNominatimGeofence = 0, llamadasOpenMeteoGeofence = 0;
    const fetchGeofence = async (url) => {
      if (url.includes('nominatim')) { llamadasNominatimGeofence++; return { ok: true, json: async () => ({ address: { road: 'No debería usarse', city: 'X' } }) }; }
      if (url.includes('open-meteo')) { llamadasOpenMeteoGeofence++; return { ok: true, json: async () => ({ hourly: { time: ['2026-09-20T08:00'], temperature_2m: [16], precipitation: [0] } }) }; }
      return { ok: false };
    };
    await enriquecerViajesPendientes(env3, { fetchImpl: fetchGeofence, esperaMs: 0 });
    assert(llamadasNominatimGeofence === 0, 'B19: un viaje con start_location_id/end_location_id ya resueltos NUNCA llama a Nominatim (geofence antes que geocoder)');
    const tripGeofence = db3._dump().trips.get('trip-geofence');
    assert(tripGeofence.start_location_raw === 'Casa' && tripGeofence.end_location_raw === 'Federación (Trabajo)', 'B19: se usa directamente el nombre del lugar conocido (D1 "locations"), no un valor de Nominatim');
  }

  // ---- B19: caché por lote — dos viajes que comparten coordenadas (redondeadas a 4 decimales)
  // solo deben generar UNA llamada real a Nominatim entre ambos, no una por cada punto. ----
  {
    const db4 = crearMockD1();
    const env4 = { DB: db4 };
    function sembrar(id, lat, lng, startedAt) {
      return db4.prepare(
        'INSERT INTO trips (id, vin, started_at, ended_at, start_odometer_km, end_odometer_km, distance_km, duration_min, ' +
        'start_soc_pct, end_soc_pct, start_lat, start_lng, end_lat, end_lng, start_location_id, end_location_id, ' +
        'classification, classification_source, classification_rule_id, data_quality, source, created_at, updated_at) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(id, VIN, startedAt, startedAt, 100, 110, 10, 15, 80, 70, lat, lng, lat, lng, null, null, null, null, null, 'complete', 'TESLA_TELEMETRY', startedAt, startedAt).run();
    }
    // Mismo punto exacto para inicio y fin de AMBOS viajes -> con caché, 1 sola llamada real.
    await sembrar('trip-cache-1', 43.4000, -5.9000, '2026-09-20T08:00:00.000Z');
    await sembrar('trip-cache-2', 43.4000, -5.9000, '2026-09-20T09:00:00.000Z');
    let llamadasNominatimCache = 0;
    const fetchCache = async (url) => {
      if (url.includes('nominatim')) { llamadasNominatimCache++; return { ok: true, json: async () => ({ address: { road: 'Calle Repetida', city: 'Gijón' } }) }; }
      if (url.includes('open-meteo')) { return { ok: true, json: async () => ({ hourly: { time: ['2026-09-20T08:00', '2026-09-20T09:00'], temperature_2m: [16, 17], precipitation: [0, 0] } }) }; }
      return { ok: false };
    };
    await enriquecerViajesPendientes(env4, { fetchImpl: fetchCache, esperaMs: 0 });
    assert(llamadasNominatimCache === 1, 'B19: coordenadas idénticas (inicio y fin de dos viajes) reutilizan la caché del lote — 1 sola llamada real a Nominatim, no 4 ("no hacer 16 llamadas cada 1.1 segundos")');
  }

  // ---- B19/B20: timeout por petición — una respuesta que nunca llega no debe colgar el job. ----
  {
    const db5 = crearMockD1();
    const env5 = { DB: db5 };
    await db5.prepare(
      'INSERT INTO trips (id, vin, started_at, ended_at, start_odometer_km, end_odometer_km, distance_km, duration_min, ' +
      'start_soc_pct, end_soc_pct, start_lat, start_lng, end_lat, end_lng, start_location_id, end_location_id, ' +
      'classification, classification_source, classification_rule_id, data_quality, source, created_at, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind('trip-timeout', VIN, '2026-09-20T08:00:00.000Z', '2026-09-20T08:00:00.000Z', 100, 110, 10, 15, 80, 70, 43.5, -6.0, 43.5, -6.0, null, null, null, null, null, 'complete', 'TESLA_TELEMETRY', '2026-09-20T08:00:00.000Z', '2026-09-20T08:00:00.000Z').run();
    // fetchImpl que respeta AbortSignal: nunca resuelve por sí mismo, solo rechaza cuando se aborta.
    const fetchQueNuncaResponde = (url, opciones) => new Promise((resolve, reject) => {
      if (opciones && opciones.signal) {
        opciones.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }
    });
    const inicio = Date.now();
    const procesadosTimeout = await enriquecerViajesPendientes(env5, { fetchImpl: fetchQueNuncaResponde, esperaMs: 0, timeoutMs: 50 });
    const duracion = Date.now() - inicio;
    assert(procesadosTimeout === 0, 'B20: una petición que nunca responde no deja el viaje enriquecido (se reintentará en la próxima pasada)');
    assert(duracion < 2000, 'B20: el timeout inyectado (50ms) corta la espera — el job no se queda colgado indefinidamente');
  }

  console.log('');
  if (fallos === 0) console.log('TODO OK — Fase 4D: enriquecimiento en background');
  else { console.log(fallos + ' fallo(s).'); process.exitCode = 1; }
}

pruebasAsincronas();
