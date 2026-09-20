// Fase 4E — motor de alertas con dedupe/cooldown, monitorización de huecos de odómetro y de
// silencio de telemetría, y los endpoints /alertas (listar) y /alertas/resolver.
import workerModule, {
  generarAlertaSiProcede, comprobarHuecoOdometro, comprobarSilencioTelemetria, ejecutarComprobacionesDeSalud
} from '../worker.js';
import { crearMockD1 } from './helpers/mock_d1.js';

let fallos = 0;
function assert(cond, msg) {
  if (!cond) { console.log('❌ FALLO:', msg); fallos++; }
  else console.log('✅', msg);
}

const VIN = '5YJ3E1EA1PF000001';

async function pruebasAsincronas() {
  // ---- generarAlertaSiProcede: dedupe/cooldown real ----
  {
    const db = crearMockD1();
    const env = { DB: db };
    const creada1 = await generarAlertaSiProcede(env, VIN, 'regla_x', 'clave_x', 'accion', 'primer aviso', 24);
    assert(creada1 === true, 'la primera vez que salta una condición, se crea la alerta');
    const creada2 = await generarAlertaSiProcede(env, VIN, 'regla_x', 'clave_x', 'accion', 'segundo aviso (debería omitirse)', 24);
    assert(creada2 === false, 'una segunda alerta con la MISMA dedupe_key mientras la anterior sigue abierta y reciente se omite (no duplica)');
    const dump = db._dump();
    assert(dump.alerts.size === 1, 'solo hay una alerta guardada en D1, no dos');
  }

  // ---- comprobarHuecoOdometro: solo alerta si el hueco es real y significativo ----
  {
    const db = crearMockD1();
    const env = { DB: db };
    await db.prepare('INSERT INTO vehicles (vin, creado_en, actualizado_en) VALUES (?, ?, ?) ON CONFLICT(vin) DO UPDATE SET actualizado_en=excluded.actualizado_en').bind(VIN, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z').run();
    await db.prepare('INSERT INTO vehicle_snapshots (vin, soc_pct, autonomia_km, odometro_km, estado, lat, lng, ubicacion_nombre, temperatura_exterior, potencia_carga_kw, tiempo_restante_carga_min, fuente, observado_en, recibido_en) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(VIN, 60, 300, 15100, 'parked', null, null, null, null, null, null, 'TESLA_TELEMETRY', '2026-09-20T10:00:00.000Z', '2026-09-20T10:00:00.000Z').run();
    await db.prepare('INSERT OR IGNORE INTO odometer_snapshots (id, vin, odometro_km, observado_en, source, created_at) VALUES (?,?,?,?,?,?)')
      .bind('odo-1', VIN, 15000, '2026-09-01T00:00:00.000Z', 'TESLA_TELEMETRY', '2026-09-01T00:00:00.000Z').run();

    // Sin ningún viaje registrado todavía: 100 km de hueco -> debe alertar.
    const alertoSinViajes = await comprobarHuecoOdometro(env, VIN);
    assert(alertoSinViajes === true, '100 km de diferencia entre el odómetro y los viajes registrados (0) genera una alerta');

    // Añadimos un viaje que explica casi todo el hueco -> ya no debería alertar de nuevo (y ni siquiera hace falta, por cooldown).
    const db2 = crearMockD1();
    const env2 = { DB: db2 };
    await db2.prepare('INSERT INTO vehicles (vin, creado_en, actualizado_en) VALUES (?, ?, ?) ON CONFLICT(vin) DO UPDATE SET actualizado_en=excluded.actualizado_en').bind(VIN, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z').run();
    await db2.prepare('INSERT INTO vehicle_snapshots (vin, soc_pct, autonomia_km, odometro_km, estado, lat, lng, ubicacion_nombre, temperatura_exterior, potencia_carga_kw, tiempo_restante_carga_min, fuente, observado_en, recibido_en) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(VIN, 60, 300, 15020, 'parked', null, null, null, null, null, null, 'TESLA_TELEMETRY', '2026-09-20T10:00:00.000Z', '2026-09-20T10:00:00.000Z').run();
    await db2.prepare('INSERT OR IGNORE INTO odometer_snapshots (id, vin, odometro_km, observado_en, source, created_at) VALUES (?,?,?,?,?,?)')
      .bind('odo-2', VIN, 15000, '2026-09-01T00:00:00.000Z', 'TESLA_TELEMETRY', '2026-09-01T00:00:00.000Z').run();
    await db2.prepare(
      'INSERT INTO trips (id, vin, started_at, ended_at, start_odometer_km, end_odometer_km, distance_km, duration_min, start_soc_pct, end_soc_pct, start_lat, start_lng, end_lat, end_lng, start_location_id, end_location_id, classification, classification_source, classification_rule_id, data_quality, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind('t1', VIN, '2026-09-10T08:00:00.000Z', '2026-09-10T08:20:00.000Z', 15000, 15018, 18, 20, 60, 55, null, null, null, null, null, null, null, null, null, 'complete', 'TESLA_TELEMETRY', '2026-09-10T08:20:00.000Z', '2026-09-10T08:20:00.000Z').run();
    const alertoConViajeCubriendoElHueco = await comprobarHuecoOdometro(env2, VIN);
    assert(alertoConViajeCubriendoElHueco === false, 'cuando los viajes registrados explican el kilometraje (18 km de 20 de diferencia real), no se genera una alerta falsa');
  }

  // ---- comprobarSilencioTelemetria ----
  {
    const db = crearMockD1();
    const env = { DB: db };
    await db.prepare('INSERT INTO vehicles (vin, creado_en, actualizado_en) VALUES (?, ?, ?) ON CONFLICT(vin) DO UPDATE SET actualizado_en=excluded.actualizado_en').bind(VIN, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z').run();
    await db.prepare('INSERT INTO sync_state (vin, telemetria_activa, eventos_recibidos_mes, vehicle_data_calls_mes, wakes_mes, errores_mes, mes_referencia, actualizado_en, ultimo_evento_en) VALUES (?,1,?,?,?,?,?,?,?)')
      .bind(VIN, 5, 0, 0, 0, '2026-09', '2026-09-20T00:00:00.000Z', new Date(Date.now() - 10 * 3600000).toISOString()).run();
    const alerto = await comprobarSilencioTelemetria(env, VIN);
    assert(alerto === true, 'más de 6 horas sin telemetría genera una alerta real');

    const db2 = crearMockD1();
    const env2 = { DB: db2 };
    await db2.prepare('INSERT INTO vehicles (vin, creado_en, actualizado_en) VALUES (?, ?, ?) ON CONFLICT(vin) DO UPDATE SET actualizado_en=excluded.actualizado_en').bind(VIN, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z').run();
    await db2.prepare('INSERT INTO sync_state (vin, telemetria_activa, eventos_recibidos_mes, vehicle_data_calls_mes, wakes_mes, errores_mes, mes_referencia, actualizado_en, ultimo_evento_en) VALUES (?,1,?,?,?,?,?,?,?)')
      .bind(VIN, 5, 0, 0, 0, '2026-09', '2026-09-20T00:00:00.000Z', new Date(Date.now() - 30 * 60000).toISOString()).run();
    const noAlerto = await comprobarSilencioTelemetria(env2, VIN);
    assert(noAlerto === false, 'con telemetría reciente (30 min), no se genera ninguna alerta');
  }

  // ---- ejecutarComprobacionesDeSalud: recorre todos los vehículos conocidos ----
  {
    const db = crearMockD1();
    const env = { DB: db };
    await db.prepare('INSERT INTO vehicles (vin, creado_en, actualizado_en) VALUES (?, ?, ?) ON CONFLICT(vin) DO UPDATE SET actualizado_en=excluded.actualizado_en').bind(VIN, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z').run();
    await db.prepare('INSERT INTO sync_state (vin, telemetria_activa, eventos_recibidos_mes, vehicle_data_calls_mes, wakes_mes, errores_mes, mes_referencia, actualizado_en, ultimo_evento_en) VALUES (?,1,?,?,?,?,?,?,?)')
      .bind(VIN, 5, 0, 0, 0, '2026-09', '2026-09-20T00:00:00.000Z', new Date(Date.now() - 20 * 3600000).toISOString()).run();
    const total = await ejecutarComprobacionesDeSalud(env);
    assert(total === 1, 'con un único vehículo silencioso, se genera exactamente una alerta en la pasada de salud');
  }

  // ---- /alertas GET y /alertas/resolver, end-to-end a través del Worker real ----
  {
    const db = crearMockD1();
    const env = { ALLOWED_ORIGIN: 'https://chollomaton.github.io', ADMIN_TOKEN: 'admin-secreto-123', DB: db };
    await generarAlertaSiProcede(env, VIN, 'regla_y', 'clave_y', 'critica', 'algo importante', 24);

    let res = await workerModule.fetch(new Request('https://api.laperestronika.com/alertas?vin=' + VIN), env); // sin auth
    assert(res.status === 401, 'GET /alertas sin autenticar -> 401');

    res = await workerModule.fetch(new Request('https://api.laperestronika.com/alertas?vin=' + VIN, { headers: { Authorization: 'Bearer admin-secreto-123' } }), env);
    let body = await res.json();
    assert(res.status === 200 && body.alertas.length === 1 && body.alertas[0].severity === 'critica', 'GET /alertas devuelve la alerta real, con su severidad');

    const idAlerta = body.alertas[0].id;
    res = await workerModule.fetch(new Request('https://api.laperestronika.com/alertas/resolver', {
      method: 'POST', headers: { Authorization: 'Bearer admin-secreto-123', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: idAlerta })
    }), env);
    assert(res.status === 200, 'POST /alertas/resolver marca la alerta como resuelta');

    res = await workerModule.fetch(new Request('https://api.laperestronika.com/alertas?vin=' + VIN, { headers: { Authorization: 'Bearer admin-secreto-123' } }), env);
    body = await res.json();
    assert(body.alertas.length === 0, 'una vez resuelta, la alerta ya no aparece en la lista de abiertas');
  }

  console.log('');
  if (fallos === 0) console.log('TODO OK — Fase 4E: motor de alertas y monitorización de salud');
  else { console.log(fallos + ' fallo(s).'); process.exitCode = 1; }
}

pruebasAsincronas();
