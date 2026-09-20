// Mock de Cloudflare D1 hecho a medida de las consultas EXACTAS que emite worker.js (no un motor
// SQL genérico). Se comparte entre test_fase4a_telemetria_bridge.js y test_fase4b_viajes.js para
// no mantener dos copias divergentes de la misma lógica de prueba.
'use strict';

function crearMockD1() {
  const vehicles = new Map();
  const events = new Map(); // id -> {id, vin, tipo, payload, observado_en, recibido_en, procesado_en}
  const snapshots = new Map(); // vehicle_snapshots: vin -> fila
  const syncState = new Map();
  const odometroSnapshots = []; // odometer_snapshots: array de filas
  const bateriaSnapshots = []; // battery_snapshots: array de filas
  const locations = new Map(); // id -> fila
  const automationRules = new Map(); // id -> fila
  const trips = new Map(); // id -> fila
  const chargingSessions = new Map(); // id -> fila
  const pendingActions = new Map(); // id -> fila
  const alerts = new Map(); // id -> fila
  const mitesla_datos = new Map();
  // FASE A (auditoría externa 2026-09-20) — tablas nuevas:
  const telemetryNonces = new Map(); // nonce -> creado_en (A13)
  const vinAllowlist = new Map(); // vin -> {vin, activo} (A14)
  const vehicleSettings = new Map(); // vin -> {automation_mode} (A10)
  const bridgeHeartbeats = new Map(); // vin -> fila (A9)
  const usageCounters = new Map(); // vin -> fila (A25)
  const oauthStartTokens = new Map(); // token -> {creado_en, usado_en} (A11)
  const oauthRefreshLock = new Map(); // id -> {locked_at, expires_at} (A12)
  const quarantinedEvents = []; // A15

  function entreFechas(valor, desde, hasta) {
    return valor >= desde && valor <= hasta;
  }

  const db = {
    async exec() {},
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (sql.includes('INSERT INTO vehicles')) {
                const [vin, , actualizado] = args;
                if (!vehicles.has(vin)) vehicles.set(vin, { vin, actualizado_en: actualizado });
                else vehicles.get(vin).actualizado_en = actualizado;
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT OR IGNORE INTO telemetry_events_short_retention')) {
                const [id, vin, tipo, payload, observado_en, recibido_en] = args;
                if (events.has(id)) return { meta: { changes: 0 } };
                events.set(id, { id, vin, tipo, payload, observado_en, recibido_en, procesado_en: null });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE telemetry_events_short_retention SET procesado_en')) {
                const [procesadoEn, id1, id2] = args;
                for (const id of [id1, id2]) { const f = events.get(id); if (f) f.procesado_en = procesadoEn; }
                return { meta: { changes: 2 } };
              }
              if (sql.includes('INSERT OR IGNORE INTO odometer_snapshots')) {
                const [id, vin, odometro_km, observado_en, source, created_at] = args;
                if (odometroSnapshots.some((f) => f.id === id)) return { meta: { changes: 0 } };
                odometroSnapshots.push({ id, vin, odometro_km, observado_en, source, created_at });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT OR IGNORE INTO battery_snapshots')) {
                // B9: la versión nueva de la consulta añade energy_remaining_kwh entre soc_pct y
                // odometro_km; se detecta por el número de columnas para no romper otras llamadas
                // (p.ej. tests) que todavía usaran la forma antigua de 7 columnas.
                const conEnergia = sql.includes('energy_remaining_kwh');
                const [id, vin, fecha, soc_pct, energy_remaining_kwh, odometro_km, source, created_at] = conEnergia
                  ? args
                  : [args[0], args[1], args[2], args[3], null, args[4], args[5], args[6]];
                if (bateriaSnapshots.some((f) => f.id === id)) return { meta: { changes: 0 } };
                bateriaSnapshots.push({ id, vin, fecha, soc_pct, energy_remaining_kwh, odometro_km, source, created_at });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO vehicle_snapshots')) {
                const [vin, soc_pct, autonomia_km, odometro_km, estado, lat, lng, ubicacion_nombre,
                  temperatura_exterior, potencia_carga_kw, tiempo_restante_carga_min, fuente, observado_en, recibido_en] = args;
                const existente = snapshots.get(vin);
                if (!existente || observado_en >= existente.observado_en) {
                  snapshots.set(vin, {
                    vin, soc_pct, autonomia_km, odometro_km, estado, lat, lng, ubicacion_nombre,
                    temperatura_exterior, potencia_carga_kw, tiempo_restante_carga_min, fuente, observado_en, recibido_en
                  });
                }
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO sync_state')) {
                const [vin, ev, vdc, wakes, err, mes, actualizado, ultimo] = args;
                syncState.set(vin, {
                  vin, telemetria_activa: 1, eventos_recibidos_mes: ev, vehicle_data_calls_mes: vdc,
                  wakes_mes: wakes, errores_mes: err, mes_referencia: mes, actualizado_en: actualizado, ultimo_evento_en: ultimo
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE sync_state SET')) {
                const [mesActual, incremento, incrementoInicial, mesActual2, ahoraIso, ahoraIso2, vin] = args;
                const fila = syncState.get(vin);
                if (fila) {
                  const m = sql.match(/UPDATE sync_state SET (\w+) =/);
                  const columna = m[1];
                  if (fila.mes_referencia === mesActual) fila[columna] += incremento;
                  else fila[columna] = incrementoInicial;
                  fila.mes_referencia = mesActual2;
                  fila.telemetria_activa = 1;
                  fila.ultimo_evento_en = ahoraIso;
                  fila.actualizado_en = ahoraIso2;
                }
                return { meta: { changes: fila ? 1 : 0 } };
              }
              if (sql.includes('INSERT INTO trips')) {
                // B9: la versión nueva de la consulta añade start/end_energy_remaining_kwh,
                // energy_used_kwh, energy_source y consumption_is_estimated entre soc y lat/lng.
                const conEnergia = sql.includes('energy_used_kwh');
                const [id, vin, started_at, ended_at, start_odometer_km, end_odometer_km, distance_km, duration_min,
                  start_soc_pct, end_soc_pct, start_energy_remaining_kwh, end_energy_remaining_kwh, energy_used_kwh, energy_source, consumption_is_estimated,
                  start_lat, start_lng, end_lat, end_lng, start_location_id, end_location_id,
                  classification, classification_source, classification_rule_id, data_quality, source, is_shadow, created_at, updated_at] = conEnergia
                  ? args
                  : [args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7], args[8], args[9],
                     null, null, null, null, 0,
                     args[10], args[11], args[12], args[13], args[14], args[15], args[16], args[17], args[18], args[19], args[20], args[21], args[22], args[23]];
                if (trips.has(id)) return { meta: { changes: 0 } }; // ON CONFLICT DO NOTHING
                trips.set(id, {
                  id, vin, started_at, ended_at, start_odometer_km, end_odometer_km, distance_km, duration_min,
                  start_soc_pct, end_soc_pct, start_energy_remaining_kwh, end_energy_remaining_kwh, energy_used_kwh, energy_source, consumption_is_estimated,
                  start_lat, start_lng, end_lat, end_lng, start_location_id, end_location_id,
                  classification, classification_source, classification_rule_id, data_quality, source, is_shadow, created_at, updated_at
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO charging_sessions')) {
                const [id, vin, started_at, ended_at, start_soc_pct, end_soc_pct, start_odometer_km,
                  energy_kwh, energy_source, charging_current_type, duration_min, lat, lng, location_id,
                  total_cost, cost_source, price_rule_id, data_quality, source, is_shadow, created_at, updated_at] = args;
                if (chargingSessions.has(id)) return { meta: { changes: 0 } };
                chargingSessions.set(id, {
                  id, vin, started_at, ended_at, start_soc_pct, end_soc_pct, start_odometer_km,
                  energy_kwh, energy_source, charging_current_type, duration_min, lat, lng, location_id,
                  total_cost, cost_source, price_rule_id, data_quality, source, is_shadow, created_at, updated_at
                });
                return { meta: { changes: 1 } };
              }
              // FASE A — tablas nuevas
              if (sql.includes('INSERT INTO telemetry_nonces')) {
                const [nonce, creado_en] = args;
                if (telemetryNonces.has(nonce)) throw new Error('UNIQUE constraint failed: telemetry_nonces.nonce');
                telemetryNonces.set(nonce, creado_en);
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO vehicle_vin_allowlist')) {
                const [vin, creado_en] = args;
                vinAllowlist.set(vin, { vin, activo: 1, creado_en });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO vehicle_settings')) {
                const [vin, automation_mode, updated_at] = args;
                vehicleSettings.set(vin, { vin, automation_mode, updated_at });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO bridge_heartbeats')) {
                const [vin, last_bridge_heartbeat_at, last_mqtt_message_at, last_tesla_message_at, last_vehicle_metric_at, last_connectivity_at, connectivity_status, updated_at] = args;
                bridgeHeartbeats.set(vin, { vin, last_bridge_heartbeat_at, last_mqtt_message_at, last_tesla_message_at, last_vehicle_metric_at, last_connectivity_at, connectivity_status, updated_at });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO usage_counters')) {
                const [vin, telemetry_signals_received, derived_events, vehicle_data_calls, wakes, commands, errores_mes, mes_referencia, actualizado_en] = args;
                usageCounters.set(vin, { vin, telemetry_signals_received, derived_events, vehicle_data_calls, wakes, commands, errores_mes, mes_referencia, actualizado_en });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE usage_counters SET')) {
                const vin = args[args.length - 1];
                const mesActual = args[args.length - 3];
                const ahoraIso = args[args.length - 2];
                const fila = usageCounters.get(vin);
                if (fila) {
                  const asignaciones = sql.match(/UPDATE usage_counters SET (.+) WHERE vin = \?/)[1].split(', ').filter((s) => !s.startsWith('mes_referencia') && !s.startsWith('actualizado_en'));
                  for (const asign of asignaciones) {
                    const m = asign.match(/^(\w+) = (?:(\w+) \+ (-?\d+)|(-?\d+))$/);
                    if (!m) continue;
                    const col = m[1];
                    if (m[2]) fila[col] = (fila[col] || 0) + Number(m[3]);
                    else fila[col] = Number(m[4]);
                  }
                  fila.mes_referencia = mesActual;
                  fila.actualizado_en = ahoraIso;
                }
                return { meta: { changes: fila ? 1 : 0 } };
              }
              if (sql.includes('INSERT INTO quarantined_events')) {
                const [id, vin, motivo, payload_recortado, recibido_en] = args;
                quarantinedEvents.push({ id, vin, motivo, payload_recortado, recibido_en });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO oauth_start_tokens')) {
                const [token, creado_en] = args;
                oauthStartTokens.set(token, { token, creado_en, usado_en: null });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE oauth_start_tokens SET usado_en')) {
                const [usado_en, token] = args;
                const fila = oauthStartTokens.get(token);
                if (fila && !fila.usado_en) { fila.usado_en = usado_en; return { meta: { changes: 1 } }; }
                return { meta: { changes: 0 } };
              }
              if (sql.includes('INSERT INTO oauth_refresh_lock')) {
                const [id, locked_at, expires_at] = args;
                if (oauthRefreshLock.has(id)) throw new Error('UNIQUE constraint failed: oauth_refresh_lock.id');
                oauthRefreshLock.set(id, { id, locked_at, expires_at });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE oauth_refresh_lock SET')) {
                const [locked_at, expires_at, id, ahoraIso] = args;
                const fila = oauthRefreshLock.get(id);
                if (fila && fila.expires_at < ahoraIso) { fila.locked_at = locked_at; fila.expires_at = expires_at; return { meta: { changes: 1 } }; }
                return { meta: { changes: 0 } };
              }
              if (sql.includes('DELETE FROM oauth_refresh_lock')) {
                oauthRefreshLock.delete(args[0]);
                return { meta: { changes: 1 } };
              }
              // B17 (FASE B): purga de telemetría cruda ya procesada — nunca las filas sin procesar.
              if (sql.includes('DELETE FROM telemetry_events_short_retention WHERE procesado_en IS NOT NULL')) {
                const limite = args[0];
                let borradas = 0;
                for (const [id, ev] of events) {
                  if (ev.procesado_en != null && ev.observado_en < limite) { events.delete(id); borradas++; }
                }
                return { meta: { changes: borradas } };
              }
              if (sql.includes('UPDATE charging_sessions SET total_cost')) {
                const [total_cost, cost_source, updated_at, id] = args;
                const c = chargingSessions.get(id);
                if (c) { c.total_cost = total_cost; c.cost_source = cost_source; c.price_rule_id = null; c.updated_at = updated_at; }
                return { meta: { changes: c ? 1 : 0 } };
              }
              if (sql.includes('INSERT OR IGNORE INTO pending_actions')) {
                const [id, vin, tipo, referencia_tabla, referencia_id, detalle, created_at] = args;
                if (pendingActions.has(id)) return { meta: { changes: 0 } };
                pendingActions.set(id, { id, vin, tipo, referencia_tabla, referencia_id, detalle, created_at, resuelto_en: null });
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith('UPDATE trips SET') && !sql.includes('classification')) {
                // Firma genérica: 'UPDATE trips SET col1 = ?, col2 = ?, updated_at = ? WHERE id = ?'
                const columnas = sql.match(/UPDATE trips SET (.+) WHERE id = \?/)[1].split(',').map((s) => s.trim().split(' = ')[0]);
                const id = args[args.length - 1];
                const t = trips.get(id);
                if (t) columnas.forEach((col, i) => { t[col] = args[i]; });
                return { meta: { changes: t ? 1 : 0 } };
              }
              if (sql.includes('UPDATE automation_rules SET veces_usada')) {
                const [ultimaVez, id] = args;
                const regla = automationRules.get(id);
                if (regla) { regla.veces_usada = (regla.veces_usada || 0) + 1; regla.ultima_vez_usada = ultimaVez; }
                return { meta: { changes: regla ? 1 : 0 } };
              }
              if (sql.includes('INSERT INTO mitesla_datos')) {
                const [device_id, contenido, actualizado_en] = args;
                mitesla_datos.set(device_id, { contenido, actualizado_en });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE trips SET classification')) {
                const [classification, updated_at, id] = args;
                const t = trips.get(id);
                if (t) { t.classification = classification; t.classification_source = 'manual'; t.classification_rule_id = null; t.updated_at = updated_at; }
                return { meta: { changes: t ? 1 : 0 } };
              }
              if (sql.includes('UPDATE pending_actions SET resuelto_en')) {
                const [resuelto_en, resuelto_con, id] = args;
                const p = pendingActions.get(id);
                if (p) { p.resuelto_en = resuelto_en; p.resuelto_con = resuelto_con; }
                return { meta: { changes: p ? 1 : 0 } };
              }
              if (sql.includes('INSERT INTO alerts')) {
                const [id, vin, rule, dedupe_key, severity, mensaje, created_at] = args;
                alerts.set(id, { id, vin, rule, dedupe_key, severity, mensaje, created_at, resolved_at: null });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE alerts SET resolved_at')) {
                const [resolved_at, id] = args;
                const a = alerts.get(id);
                if (a) a.resolved_at = resolved_at;
                return { meta: { changes: a ? 1 : 0 } };
              }
              return { meta: { changes: 0 } };
            },
            async first() {
              if (sql.includes('SELECT mes_referencia FROM sync_state')) {
                const fila = syncState.get(args[0]);
                return fila ? { mes_referencia: fila.mes_referencia } : null;
              }
              if (sql.includes('SELECT * FROM sync_state')) {
                return syncState.get(args[0]) || null;
              }
              if (sql.includes('SELECT contenido, actualizado_en FROM mitesla_datos')) {
                const fila = mitesla_datos.get(args[0]);
                return fila ? { contenido: fila.contenido, actualizado_en: fila.actualizado_en } : null;
              }
              if (sql.includes('SELECT * FROM pending_actions WHERE id')) {
                return pendingActions.get(args[0]) || null;
              }
              if (sql.includes('SELECT odometro_km, observado_en FROM vehicle_snapshots')) {
                const s = snapshots.get(args[0]);
                return s ? { odometro_km: s.odometro_km, observado_en: s.observado_en } : null;
              }
              if (sql.includes('SELECT odometro_km FROM odometer_snapshots')) {
                const vin = args[0];
                const filas = odometroSnapshots.filter((f) => f.vin === vin).sort((a, b) => a.observado_en.localeCompare(b.observado_en));
                return filas.length ? { odometro_km: filas[0].odometro_km } : null;
              }
              if (sql.includes('SELECT COALESCE(SUM(distance_km), 0) AS total FROM trips')) {
                const vin = args[0];
                const total = Array.from(trips.values()).filter((t) => t.vin === vin && t.distance_km != null).reduce((acc, t) => acc + t.distance_km, 0);
                return { total };
              }
              if (sql.includes('SELECT ultimo_evento_en FROM sync_state')) {
                const s = syncState.get(args[0]);
                return s ? { ultimo_evento_en: s.ultimo_evento_en } : null;
              }
              // B9: capacidad nominal real del vehículo (null si no se ha fijado nunca).
              if (sql.includes('SELECT capacidad_nominal_kwh FROM vehicles')) {
                const v = vehicles.get(args[0]);
                return { capacidad_nominal_kwh: (v && typeof v.capacidad_nominal_kwh === 'number') ? v.capacidad_nominal_kwh : null };
              }
              if (sql.includes('SELECT id, created_at, resolved_at FROM alerts')) {
                const [vin, dedupeKey] = args;
                const filas = Array.from(alerts.values()).filter((a) => a.vin === vin && a.dedupe_key === dedupeKey).sort((a, b) => b.created_at.localeCompare(a.created_at));
                return filas[0] || null;
              }
              // FASE A
              if (sql.includes('SELECT activo FROM vehicle_vin_allowlist')) {
                return vinAllowlist.get(args[0]) || null;
              }
              if (sql.includes('SELECT automation_mode FROM vehicle_settings')) {
                const f = vehicleSettings.get(args[0]);
                return f ? { automation_mode: f.automation_mode } : null;
              }
              if (sql.includes('SELECT * FROM bridge_heartbeats')) {
                return bridgeHeartbeats.get(args[0]) || null;
              }
              if (sql.includes('SELECT mes_referencia FROM usage_counters')) {
                const f = usageCounters.get(args[0]);
                return f ? { mes_referencia: f.mes_referencia } : null;
              }
              if (sql.includes('SELECT * FROM usage_counters')) {
                return usageCounters.get(args[0]) || null;
              }
              if (sql.includes('SELECT creado_en, usado_en FROM oauth_start_tokens')) {
                const f = oauthStartTokens.get(args[0]);
                return f ? { creado_en: f.creado_en, usado_en: f.usado_en } : null;
              }
              return null;
            },
            async all() {
              if (sql.includes('SELECT id, tipo, payload, observado_en FROM telemetry_events_short_retention')) {
                const vin = args[0];
                const tiposBuscados = sql.includes('charge_started') ? ['charge_started', 'charge_stopped'] : ['trip_started', 'trip_finished'];
                const resultados = Array.from(events.values())
                  .filter((e) => e.vin === vin && tiposBuscados.includes(e.tipo) && !e.procesado_en)
                  .sort((a, b) => a.observado_en.localeCompare(b.observado_en))
                  .slice(0, 200)
                  .map((e) => ({ id: e.id, tipo: e.tipo, payload: e.payload, observado_en: e.observado_en }));
                return { results: resultados };
              }
              if (sql.includes('FROM locations WHERE vin')) {
                const vin = args[0];
                return { results: Array.from(locations.values()).filter((l) => l.vin === vin) };
              }
              if (sql.includes('SELECT * FROM automation_rules WHERE vin')) {
                const vin = args[0];
                const tipoBuscado = sql.includes('precio_carga') ? 'precio_carga' : 'clasificacion_viaje';
                return { results: Array.from(automationRules.values()).filter((r) => r.vin === vin && r.tipo === tipoBuscado) };
              }
              if (sql.includes('SELECT odometro_km AS valor, observado_en FROM odometer_snapshots')) {
                const [vin, desde, hasta] = args;
                return { results: odometroSnapshots.filter((f) => f.vin === vin && entreFechas(f.observado_en, desde, hasta)).map((f) => ({ valor: f.odometro_km, observado_en: f.observado_en })) };
              }
              if (sql.includes('FROM battery_snapshots WHERE vin')) {
                // B9: la consulta real ahora también pide energy_remaining_kwh — se incluye siempre
                // en el resultado del mock (null si esa fila no lo tenía) para que
                // construirViajeDesdeEventos() pueda leerlo igual que soc_pct.
                const [vin, desde, hasta] = args;
                return { results: bateriaSnapshots.filter((f) => f.vin === vin && entreFechas(f.fecha, desde, hasta)).map((f) => ({ valor: f.soc_pct, energy_remaining_kwh: (typeof f.energy_remaining_kwh === 'number' ? f.energy_remaining_kwh : null), observado_en: f.fecha })) };
              }
              if (sql.includes('FROM trips WHERE (start_location_raw IS NULL')) {
                const limite = args[0];
                const resultados = Array.from(trips.values())
                  .filter((t) => (!t.start_location_raw && t.start_lat != null) || (!t.end_location_raw && t.end_lat != null) || (!t.weather && t.start_lat != null))
                  .sort((a, b) => a.created_at.localeCompare(b.created_at))
                  .slice(0, limite)
                  .map((t) => ({
                    id: t.id, vin: t.vin, start_lat: t.start_lat, start_lng: t.start_lng, end_lat: t.end_lat, end_lng: t.end_lng,
                    start_location_id: t.start_location_id || null, end_location_id: t.end_location_id || null,
                    start_location_raw: t.start_location_raw || null, end_location_raw: t.end_location_raw || null,
                    started_at: t.started_at, weather: t.weather || null
                  }));
                return { results: resultados };
              }
              if (sql.includes('SELECT vin FROM vehicles')) {
                return { results: Array.from(vehicles.keys()).map((vin) => ({ vin })) };
              }
              if (sql.includes('SELECT id, rule, severity, mensaje, created_at FROM alerts')) {
                const vin = args[0];
                return { results: Array.from(alerts.values()).filter((a) => a.vin === vin && !a.resolved_at).sort((a, b) => b.created_at.localeCompare(a.created_at)) };
              }
              if (sql.includes('FROM pending_actions WHERE vin')) {
                const vin = args[0];
                return { results: Array.from(pendingActions.values()).filter((p) => p.vin === vin && !p.resuelto_en).sort((a, b) => a.created_at.localeCompare(b.created_at)) };
              }
              return { results: [] };
            }
          };
        }
      };
    },
    // Helpers de siembra directa para los tests (nunca los usa worker.js, solo los tests).
    _sembrarLocation(fila) { locations.set(fila.id, fila); },
    // B9: fija la capacidad nominal de un vehículo ya existente (o lo crea si hiciera falta), para
    // poder probar la estimación de consumo por SoC sin pasar por el endpoint /vehiculo real.
    _fijarCapacidadVehiculo(vin, kwh) {
      const v = vehicles.get(vin) || { vin, actualizado_en: new Date().toISOString() };
      v.capacidad_nominal_kwh = kwh;
      vehicles.set(vin, v);
    },
    // B17: siembra directa de un evento de telemetry_events_short_retention con control total sobre
    // observado_en/procesado_en, para poder probar el corte de fecha de la purga sin pasar por el
    // INSERT real (que siempre deja procesado_en en null).
    _sembrarEvento(fila) { events.set(fila.id, Object.assign({ procesado_en: null }, fila)); },
    _sembrarRegla(fila) { automationRules.set(fila.id, Object.assign({ veces_usada: 0, ultima_vez_usada: null, activa: 1 }, fila)); },
    // FASE A: un vehículo debe estar autorizado (A14) y en modo distinto de 'off' (A10, por
    // defecto 'off') para que procesarViajesPendientes/procesarCargasPendientes hagan algo — los
    // tests que ejercitan el motor de viajes/cargas llaman a esto para dejar el escenario listo,
    // igual que haría /seleccionar-vehiculo + el panel "Automatización" en la app real.
    _autorizarYActivar(vin, modo) {
      vinAllowlist.set(vin, { vin, activo: 1, creado_en: new Date().toISOString() });
      vehicleSettings.set(vin, { vin, automation_mode: modo || 'active', updated_at: new Date().toISOString() });
    },
    _dump() {
      return {
        vehicles, events, snapshots, syncState, odometroSnapshots, bateriaSnapshots, locations, automationRules,
        trips, chargingSessions, pendingActions, alerts, telemetryNonces, vinAllowlist, vehicleSettings,
        bridgeHeartbeats, usageCounters, oauthStartTokens, oauthRefreshLock, quarantinedEvents
      };
    }
  };
  return db;
}

module.exports = { crearMockD1 };
