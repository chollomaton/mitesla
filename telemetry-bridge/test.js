'use strict';
// Pruebas de la lógica pura del bridge (sin MQTT ni red reales). Ejecutar: node test.js
//
// REVISIÓN FASE A (auditoría externa, 2026-09-20): normalizador.js se reescribió por completo
// (A1, A3, A4, A6, A7, A8) y cola.js también (A2). Este archivo se ha actualizado para ejercitar
// las nuevas firmas reales — nunca se ha dejado un test "desactualizado pero en verde" apuntando
// a una API que ya no existe.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parsearTopic, parsearValorMetrica, actualizarEstado, idEvento,
  crearSeguimientoTransiciones, actualizarSeguimientoTransiciones, confirmarTransiciones,
  construirSnapshot, contextoCarga, contextoPosicionOdometro,
  normalizarUnidad, extraerLocation, MILLAS_A_KM
} = require('./lib/normalizador');
const { firmar, enviarLoteConReintentos } = require('./lib/envio');
const { ColaPersistente } = require('./lib/cola');

let fallos = 0;
function check(cond, msg) {
  if (!cond) { console.log('❌ FALLO:', msg); fallos++; }
  else console.log('✅', msg);
}

const VIN = '5YJ3E1EA1PF000001';
const TOPIC_BASE = 'mitesla_telemetry';

// Helper: construye el objeto {valor, invalido, timestampVehiculo} que actualizarEstado() espera
// como 3er argumento (el que produciría parsearValorMetrica() para un valor ya decodificado).
function metricaValor(valor, timestampVehiculo) {
  return { valor, invalido: false, timestampVehiculo: timestampVehiculo || null };
}
function metricaInvalida(timestampVehiculo) {
  return { valor: undefined, invalido: true, timestampVehiculo: timestampVehiculo || null };
}

// ---- parsearTopic ----
{
  const info = parsearTopic(TOPIC_BASE, TOPIC_BASE + '/' + VIN + '/v/Soc');
  check(info && info.vin === VIN && info.seccion === 'v' && info.resto === 'Soc', 'parsearTopic reconoce un topic de métrica /v/<campo>');
  check(parsearTopic(TOPIC_BASE, 'otro_base/x/v/Soc') === null, 'parsearTopic ignora topics de otra base');
}

// ---- parsearValorMetrica: A8, ahora devuelve siempre {valor, invalido, timestampVehiculo} ----
{
  const r1 = parsearValorMetrica('72.5');
  check(r1.valor === 72.5 && r1.invalido === false, 'parsearValorMetrica decodifica un número JSON');
  const r2 = parsearValorMetrica('"D"');
  check(r2.valor === 'D' && r2.invalido === false, 'parsearValorMetrica decodifica un string JSON con comillas');
  const r3 = parsearValorMetrica('D');
  check(r3.valor === 'D' && r3.invalido === false, 'parsearValorMetrica no revienta con un valor sin comillas (fallback al texto plano)');
  // A6: invalid:true nunca se coerciona a un valor utilizable.
  const r4 = parsearValorMetrica(JSON.stringify({ value: 'D', invalid: true, createdAt: '2026-09-20T08:00:00Z' }));
  check(r4.invalido === true && r4.valor === undefined, 'un payload con invalid:true se marca como inválido, nunca se coacciona su valor');
  // A8: objeto {value, createdAt} conserva el timestamp de origen del vehículo.
  const r5 = parsearValorMetrica(JSON.stringify({ value: 68, createdAt: '2026-09-20T08:00:00Z' }));
  check(r5.valor === 68 && r5.timestampVehiculo === '2026-09-20T08:00:00.000Z', 'un payload {value, createdAt} conserva el timestamp real del vehículo (A8)');
  // Payload "pelado" (sin objeto envolvente): nunca se inventa un timestampVehiculo.
  const r6 = parsearValorMetrica('68');
  check(r6.timestampVehiculo === null, 'un valor pelado (sin createdAt) nunca inventa un timestamp de vehículo');
}

// ---- A3: normalización de unidades (millas/mph -> km/km-h), en la frontera, sin redondeo interno ----
{
  check(Math.abs(normalizarUnidad('Odometer', 100) - 160.9344) < 1e-9, '100 millas de Odometer -> 160.9344 km exactos');
  check(Math.abs(normalizarUnidad('VehicleSpeed', 60) - 96.56064) < 1e-9, '60 mph de VehicleSpeed -> 96.56064 km/h exactos');
  check(normalizarUnidad('Soc', 68) === 68, 'un campo que no está en millas/mph (Soc) se deja intacto');
  check(Math.abs(MILLAS_A_KM - 1.609344) < 1e-12, 'la constante de conversión es exactamente 1.609344');
  // Delta de 10 millas -> 16.09344 km, para verificar que la conversión también es correcta sobre diferencias.
  const deltaKm = normalizarUnidad('Odometer', 110) - normalizarUnidad('Odometer', 100);
  check(Math.abs(deltaKm - 16.09344) < 1e-9, 'un delta de 10 millas de Odometer equivale a 16.09344 km');
}

// ---- A4: campo Location combinado se descompone en Latitude/Longitude ----
{
  check(JSON.stringify(extraerLocation({ latitude: 43.36, longitude: -5.84 })) === JSON.stringify({ lat: 43.36, lng: -5.84 }), 'extraerLocation decodifica {latitude,longitude}');
  check(extraerLocation({ lat: 1, lng: 2 }) !== null, 'extraerLocation también acepta las claves cortas lat/lng');
  check(extraerLocation({}) === null, 'extraerLocation con un objeto sin coordenadas nunca inventa lat/lng, devuelve null');
  check(extraerLocation(null) === null, 'extraerLocation con valor nulo no revienta, devuelve null');

  let estado = actualizarEstado({}, 'Location', metricaValor({ latitude: 43.36, longitude: -5.84 }, '2026-09-20T08:00:00Z'), '2026-09-20T08:00:01.000Z');
  check(estado.Latitude && estado.Latitude.valor === 43.36 && estado.Longitude && estado.Longitude.valor === -5.84, 'actualizarEstado descompone un campo Location en Latitude/Longitude internamente (A4)');
}

// ---- A6: invalid:true nunca abre/cierra nada ni sobreescribe el último valor válido ----
{
  let estado = actualizarEstado({}, 'ShiftState', metricaValor('D', '2026-09-20T08:00:00Z'), '2026-09-20T08:00:01.000Z');
  const estadoInvalido = actualizarEstado(estado, 'ShiftState', metricaInvalida('2026-09-20T08:00:05Z'), '2026-09-20T08:00:06.000Z');
  check(estadoInvalido.ShiftState.valor === 'D', 'una métrica invalid:true NUNCA sobreescribe el último valor válido conocido');
  check(estadoInvalido.ShiftState.ultimo_invalido_en === '2026-09-20T08:00:06.000Z', 'se deja constancia de que se recibió un aviso de invalidez, para diagnóstico');
}

// ---- A1: máquina de estados candidato/confirmado — el bug original escenario a escenario ----
{
  const t0 = '2026-09-20T08:00:00.000Z';
  let estado = actualizarEstado({}, 'ShiftState', metricaValor('P', t0), t0);
  let seguimiento = crearSeguimientoTransiciones();
  seguimiento = actualizarSeguimientoTransiciones(seguimiento, estado, new Date(t0).getTime());
  let r = confirmarTransiciones(VIN, seguimiento, estado, new Date(t0).getTime() + 120000, { debounceMs: 60000 });
  check(r.eventos.length === 0, 'estado inicial "P" sin transición previa no genera ningún evento falso');
  seguimiento = r.seguimiento;

  // P -> D en t=30s: candidato cambia, pero aún no ha pasado el debounce (60s) -> NO se confirma todavía.
  const t30 = new Date(t0).getTime() + 30000;
  estado = actualizarEstado(estado, 'ShiftState', metricaValor('D', new Date(t30).toISOString()), new Date(t30).toISOString());
  seguimiento = actualizarSeguimientoTransiciones(seguimiento, estado, t30);
  r = confirmarTransiciones(VIN, seguimiento, estado, t30, { debounceMs: 60000 });
  check(r.eventos.length === 0, 'un cambio P->D con menos de debounceMs de antigüedad no se confirma aún (evita flapping)');
  seguimiento = r.seguimiento;

  // EL BUG ORIGINAL exacto: el candidato "D" nace en t=30s. El ciclo de envío de t=60s (solo 30s
  // después, TODAVÍA dentro de la ventana de debounce de 60s) no debe confirmar nada — y con el
  // código viejo, ese ciclo de t=60s ya habría hecho "estadoUltimoEnvio = estadoActual" igualmente,
  // así que cuando el debounce SÍ se cumple de verdad (t=90s, 60s después de que naciera el
  // candidato en t=30s) la transición ya habría quedado silenciosamente "vista" y jamás se
  // generaba el evento. Con la máquina candidato/confirmado, el candidato "D" sigue vivo desde
  // t=30s pase lo que pase en el ciclo de t=60s, y SÍ se confirma en cuanto se cumplen 60s reales.
  const t60 = new Date(t0).getTime() + 60000;
  const rIntermedio = confirmarTransiciones(VIN, seguimiento, estado, t60, { debounceMs: 60000 });
  check(rIntermedio.eventos.length === 0, 'en t=60s (solo 30s desde que nació el candidato en t30) todavía NO se confirma — el debounce se mide desde la observación real, no desde la cadencia de envío');
  seguimiento = rIntermedio.seguimiento;

  const t90 = new Date(t0).getTime() + 90000; // 60s justos desde que el candidato "D" nació en t30
  r = confirmarTransiciones(VIN, seguimiento, estado, t90, { debounceMs: 60000 });
  check(r.eventos.length === 1 && r.eventos[0].tipo === 'trip_started', 'el escenario exacto reportado por la auditoría (P->D en t30, ciclos de envío en t60/t90) SÍ genera trip_started en cuanto se cumplen los 60s reales — bug A1 corregido');
  seguimiento = r.seguimiento;

  // Llamar confirmarTransiciones otra vez sin que nada cambie no debe duplicar el evento (idempotente).
  const rRepetido = confirmarTransiciones(VIN, seguimiento, estado, t90 + 1000, { debounceMs: 60000 });
  check(rRepetido.eventos.length === 0, 'confirmarTransiciones es idempotente: llamarlo de nuevo sin cambios no reemite el mismo evento');

  // D -> P tras 20 minutos, confirmado también tras el debounce.
  const t2 = new Date(t0).getTime() + 20 * 60000;
  estado = actualizarEstado(estado, 'ShiftState', metricaValor('P', new Date(t2).toISOString()), new Date(t2).toISOString());
  seguimiento = actualizarSeguimientoTransiciones(seguimiento, estado, t2);
  r = confirmarTransiciones(VIN, seguimiento, estado, t2 + 60000, { debounceMs: 60000 });
  check(r.eventos.length === 1 && r.eventos[0].tipo === 'trip_finished', 'D -> P genera exactamente un evento trip_finished tras el debounce');

  // Flapping: P -> D -> P dentro de la ventana de debounce nunca genera trip_started.
  let estadoFlap = actualizarEstado({}, 'ShiftState', metricaValor('P', t0), t0);
  let segFlap = crearSeguimientoTransiciones();
  segFlap = actualizarSeguimientoTransiciones(segFlap, estadoFlap, new Date(t0).getTime());
  const tFlap1 = new Date(t0).getTime() + 5000;
  estadoFlap = actualizarEstado(estadoFlap, 'ShiftState', metricaValor('D', new Date(tFlap1).toISOString()), new Date(tFlap1).toISOString());
  segFlap = actualizarSeguimientoTransiciones(segFlap, estadoFlap, tFlap1);
  const tFlap2 = new Date(t0).getTime() + 10000; // 5s después, todavía dentro del debounce de 60s
  estadoFlap = actualizarEstado(estadoFlap, 'ShiftState', metricaValor('P', new Date(tFlap2).toISOString()), new Date(tFlap2).toISOString());
  segFlap = actualizarSeguimientoTransiciones(segFlap, estadoFlap, tFlap2);
  const rFlap = confirmarTransiciones(VIN, segFlap, estadoFlap, tFlap2 + 60000, { debounceMs: 60000 });
  check(rFlap.eventos.length === 0, 'un flapping P->D->P dentro de la ventana de debounce no genera ningún evento de viaje falso');
}

// ---- A1: reinicio del bridge a mitad de una transición pendiente — el seguimiento se reconstruye
//          desde el estado real, así que no hace falta persistir "seguimiento" para no perder nada
//          (el candidato se recalcula al recibir el siguiente mensaje MQTT tras el reinicio). ----
{
  const t0 = '2026-09-20T08:00:00.000Z';
  let estado = actualizarEstado({}, 'ShiftState', metricaValor('D', t0), t0);
  // "Reinicio": un seguimiento nuevo, vacío, como si el proceso hubiera arrancado de cero.
  let seguimientoTrasReinicio = crearSeguimientoTransiciones();
  const ahoraTrasReinicio = new Date(t0).getTime() + 90000; // 90s después, el mensaje llega tarde tras el reinicio
  seguimientoTrasReinicio = actualizarSeguimientoTransiciones(seguimientoTrasReinicio, estado, ahoraTrasReinicio);
  const r = confirmarTransiciones(VIN, seguimientoTrasReinicio, estado, ahoraTrasReinicio + 60000, { debounceMs: 60000 });
  check(r.eventos.length === 1 && r.eventos[0].tipo === 'trip_started', 'tras un reinicio del bridge, el candidato se reconstruye desde el primer mensaje MQTT recibido y el viaje sigue detectándose');
}

// ---- A1: transiciones de carga con la misma máquina candidato/confirmado ----
{
  const t0 = '2026-09-20T22:00:00.000Z';
  let estado = actualizarEstado({}, 'DetailedChargeState', metricaValor('Disconnected', t0), t0);
  let seguimiento = crearSeguimientoTransiciones();
  seguimiento = actualizarSeguimientoTransiciones(seguimiento, estado, new Date(t0).getTime());
  let r = confirmarTransiciones(VIN, seguimiento, estado, new Date(t0).getTime() + 30000, { debounceMs: 30000 });
  seguimiento = r.seguimiento;

  const t1 = new Date(t0).getTime() + 60000;
  estado = actualizarEstado(estado, 'DetailedChargeState', metricaValor('Charging', new Date(t1).toISOString()), new Date(t1).toISOString());
  seguimiento = actualizarSeguimientoTransiciones(seguimiento, estado, t1);
  r = confirmarTransiciones(VIN, seguimiento, estado, t1 + 30000, { debounceMs: 30000 });
  check(r.eventos.length === 1 && r.eventos[0].tipo === 'charge_started', 'Disconnected -> Charging genera charge_started tras el debounce');
  seguimiento = r.seguimiento;

  const t2 = new Date(t0).getTime() + 4 * 3600000;
  estado = actualizarEstado(estado, 'DetailedChargeState', metricaValor('Complete', new Date(t2).toISOString()), new Date(t2).toISOString());
  seguimiento = actualizarSeguimientoTransiciones(seguimiento, estado, t2);
  r = confirmarTransiciones(VIN, seguimiento, estado, t2 + 30000, { debounceMs: 30000 });
  check(r.eventos.length === 1 && r.eventos[0].tipo === 'charge_stopped', 'Charging -> Complete genera charge_stopped tras el debounce');
}

// ---- A7: contexto (lat/lng/odómetro/SoC) caduca — nunca se presenta un dato viejo como actual ----
{
  const t0 = '2026-09-20T08:00:00.000Z';
  let estado = actualizarEstado({}, 'Latitude', metricaValor(43.36, t0), t0);
  estado = actualizarEstado(estado, 'Longitude', metricaValor(-5.84, t0), t0);
  estado = actualizarEstado(estado, 'Odometer', metricaValor(15000, t0), t0);
  estado = actualizarEstado(estado, 'Soc', metricaValor(68, t0), t0);

  const ahoraFresco = new Date(t0).getTime() + 60000; // 1 min después: dentro de los 5 min por defecto
  const ctxFresco = contextoPosicionOdometro(estado, ahoraFresco, 5 * 60000);
  check(ctxFresco.lat === 43.36 && ctxFresco.data_quality === 'full', 'con datos recientes, el contexto trae lat/lng/odómetro/SoC reales y data_quality "full"');

  const ahoraCaducado = new Date(t0).getTime() + 10 * 60000; // 10 min después: fuera de los 5 min
  const ctxCaducado = contextoPosicionOdometro(estado, ahoraCaducado, 5 * 60000);
  check(ctxCaducado.lat === null && ctxCaducado.data_quality === 'partial', 'con datos caducados (>maxAgeMs), el contexto pone null explícito y data_quality "partial", nunca presenta el dato viejo como actual (A7)');
}

// ---- B9: EnergyRemaining — se adjunta cuando el vehículo/config la manda, pero un vehículo SIN
// esta señal suscrita sigue teniendo data_quality "full" igual que antes de B9 (campo opcional,
// "cuando esté soportada" según el encargo) ----
{
  const t0 = '2026-09-20T08:00:00.000Z';
  let estadoConEnergia = actualizarEstado({}, 'Latitude', metricaValor(43.36, t0), t0);
  estadoConEnergia = actualizarEstado(estadoConEnergia, 'Longitude', metricaValor(-5.84, t0), t0);
  estadoConEnergia = actualizarEstado(estadoConEnergia, 'Odometer', metricaValor(15000, t0), t0);
  estadoConEnergia = actualizarEstado(estadoConEnergia, 'Soc', metricaValor(68, t0), t0);
  estadoConEnergia = actualizarEstado(estadoConEnergia, 'EnergyRemaining', metricaValor(51.2, t0), t0);
  const ahora = new Date(t0).getTime() + 60000;
  const ctxConEnergia = contextoPosicionOdometro(estadoConEnergia, ahora, 5 * 60000);
  check(ctxConEnergia.energy_remaining_kwh === 51.2, 'B9: con EnergyRemaining reciente en el estado, el contexto la adjunta como energy_remaining_kwh real');
  check(ctxConEnergia.data_quality === 'full', 'B9: EnergyRemaining presente no cambia data_quality "full" (sigue dependiendo solo de lat/lng/odómetro/SoC, como antes de B9)');

  let estadoSinEnergia = actualizarEstado({}, 'Latitude', metricaValor(43.36, t0), t0);
  estadoSinEnergia = actualizarEstado(estadoSinEnergia, 'Longitude', metricaValor(-5.84, t0), t0);
  estadoSinEnergia = actualizarEstado(estadoSinEnergia, 'Odometer', metricaValor(15000, t0), t0);
  estadoSinEnergia = actualizarEstado(estadoSinEnergia, 'Soc', metricaValor(68, t0), t0);
  const ctxSinEnergia = contextoPosicionOdometro(estadoSinEnergia, ahora, 5 * 60000);
  check(ctxSinEnergia.energy_remaining_kwh === null, 'B9: un vehículo/config sin EnergyRemaining suscrita da energy_remaining_kwh=null (ausencia real, nunca 0 ni un valor derivado del SoC aquí)');
  check(ctxSinEnergia.data_quality === 'full', 'B9: la AUSENCIA de EnergyRemaining tampoco degrada data_quality a "partial" — es un campo opcional, no obligatorio para considerar el contexto completo');

  const ctxCaducadaEnergia = contextoPosicionOdometro(estadoConEnergia, new Date(t0).getTime() + 10 * 60000, 5 * 60000);
  check(ctxCaducadaEnergia.energy_remaining_kwh === null, 'B9: EnergyRemaining caducada (>maxAgeMs) también da null, con la misma lógica de frescura que el resto de campos (A7)');
}

// ---- A8: observado_en_vehiculo / recibido_en_bridge nunca se confunden ----
{
  const tsVehiculo = '2026-09-20T08:00:00.000Z';
  const tsBridge = '2026-09-20T08:00:03.500Z'; // el bridge lo procesa 3.5s más tarde
  const estado = actualizarEstado({}, 'Soc', metricaValor(68, tsVehiculo), tsBridge);
  check(estado.Soc.observado_en_vehiculo === tsVehiculo, 'observado_en_vehiculo guarda el instante real de origen que mandó Tesla');
  check(estado.Soc.recibido_en_bridge === tsBridge, 'recibido_en_bridge guarda el instante de procesamiento del bridge, nunca etiquetado como "observado_en" del vehículo');
  check(estado.Soc.observado_en === tsVehiculo, 'observado_en usa el timestamp del vehículo cuando está disponible, no el de recepción del bridge');

  // Cuando Tesla no manda createdAt, observado_en cae de forma explícita (documentada) al de recepción del bridge.
  const estadoSinTsVehiculo = actualizarEstado({}, 'Soc', metricaValor(70, null), tsBridge);
  check(estadoSinTsVehiculo.Soc.observado_en_vehiculo === null && estadoSinTsVehiculo.Soc.observado_en === tsBridge, 'sin timestamp de vehículo, observado_en cae al de recepción del bridge de forma explícita, nunca silenciosa');
}

// ---- idEvento determinista ----
{
  const a = idEvento(VIN, 'trip_started', '2026-09-20T08:00:00Z');
  const b = idEvento(VIN, 'trip_started', '2026-09-20T08:00:00Z');
  const c = idEvento(VIN, 'trip_finished', '2026-09-20T08:00:00Z');
  check(a === b, 'idEvento es determinista para los mismos vin+tipo+instante (idempotencia real)');
  check(a !== c, 'idEvento cambia si cambia el tipo de evento');
}

// ---- contextoCarga: energía AC/DC solo si Tesla la ha enviado, nunca inventada ----
{
  const t0 = '2026-09-20T22:00:00.000Z';
  let estado = actualizarEstado({}, 'ACChargingEnergyIn', metricaValor(7.4, t0), t0);
  estado = actualizarEstado(estado, 'Soc', metricaValor(55, t0), t0);
  const ctx = contextoCarga(estado, new Date(t0).getTime() + 1000, 5 * 60000);
  check(ctx.ac_energy_kwh === 7.4 && ctx.soc_pct === 55, 'contextoCarga recoge ACChargingEnergyIn y Soc cuando están presentes y frescos');
  check(ctx.dc_energy_kwh === null, 'contextoCarga deja dc_energy_kwh en null si Tesla no ha mandado ese campo (nunca 0 por defecto)');
}

// ---- construirSnapshot: nunca inventa datos que no ha recibido ----
{
  const t0 = '2026-09-20T08:00:00.000Z';
  let estado = actualizarEstado({}, 'Soc', metricaValor(68, t0), t0);
  estado = actualizarEstado(estado, 'Odometer', metricaValor(15234.7 / MILLAS_A_KM, t0), t0); // ya viene normalizado a km por actualizarEstado
  const snap = construirSnapshot(estado);
  check(snap.soc_pct === 68, 'construirSnapshot mapea Soc al campo del Worker');
  check(Math.abs(snap.odometro_km - 15234.7) < 1e-6, 'construirSnapshot expone el odómetro ya normalizado a km (A3), no en millas');
  check(snap.autonomia_km === null && snap.lat === null, 'construirSnapshot pone null explícito para campos no recibidos, nunca 0 inventado');
  check(snap.fuente === 'TESLA_TELEMETRY', 'construirSnapshot marca siempre la fuente como TESLA_TELEMETRY');
}

// ---- firma HMAC: coincide con el algoritmo esperado por verificarFirmaBridge en worker.js ----
{
  const secreto = 'secreto-de-prueba';
  const firma = firmar(secreto, '1700000000', 'nonce-x', '{"a":1}');
  check(typeof firma === 'string' && firma.length === 64, 'firmar produce un hex SHA-256 de 64 caracteres');
  const otraFirma = firmar(secreto, '1700000000', 'nonce-x', '{"a":2}');
  check(firma !== otraFirma, 'un cuerpo distinto produce una firma distinta (protege integridad del payload)');
}

// ---- A2: ColaPersistente — sobrevive a un "reinicio" del proceso, y un evento encolado durante un
//          envío en curso nunca se pierde (peekBatch/ack en vez de todos()/vaciar()) ----
{
  const rutaTmp = path.join(os.tmpdir(), 'mitesla-cola-test-' + Date.now() + '.jsonl');
  let cola = new ColaPersistente(rutaTmp);
  check(cola.tamano === 0, 'una cola nueva (sin archivo previo) arranca vacía, sin fallar');
  cola.encolar({ id: 'e1', tipo: 'trip_started' });
  cola.encolar({ id: 'e2', tipo: 'trip_finished' });
  const colaTrasReinicio = new ColaPersistente(rutaTmp); // simula un proceso nuevo leyendo el mismo archivo
  check(colaTrasReinicio.tamano === 2, 'los eventos encolados sobreviven a un "reinicio" (releídos del disco)');

  // EL BUG ORIGINAL (A2): peekBatch() + ack() en vez de todos()+vaciar(). Un evento "e3" que llega
  // DURANTE el envío en curso de e1/e2 debe sobrevivir intacto tras el ack de solo e1/e2.
  const lote = colaTrasReinicio.peekBatch(10);
  check(lote.length === 2, 'peekBatch() devuelve los eventos pendientes sin eliminarlos todavía');
  colaTrasReinicio.encolar({ id: 'e3', tipo: 'charge_started' }); // llega "en vuelo", mientras el lote anterior viaja
  check(colaTrasReinicio.tamano === 3, 'un evento encolado mientras un envío está en curso se añade con normalidad');
  colaTrasReinicio.ack(lote.map((e) => e.id)); // el servidor solo confirmó e1/e2
  check(colaTrasReinicio.tamano === 1 && colaTrasReinicio.peekBatch()[0].id === 'e3', 'ack() elimina SOLO los ids confirmados — e3 (llegado en vuelo) nunca se pierde: bug A2 corregido');

  const colaTrasSegundoReinicio = new ColaPersistente(rutaTmp);
  check(colaTrasSegundoReinicio.tamano === 1 && colaTrasSegundoReinicio.peekBatch()[0].id === 'e3', 'el estado tras ack() persiste de verdad en disco, no solo en memoria');

  // Single-flight: un segundo intento de envío mientras el primero está en curso se rechaza.
  check(colaTrasSegundoReinicio.intentarIniciarEnvio() === true, 'el primer intentarIniciarEnvio() concede el turno de envío');
  check(colaTrasSegundoReinicio.intentarIniciarEnvio() === false, 'un segundo intentarIniciarEnvio() mientras el primero sigue en curso se rechaza (single-flight, A2)');
  colaTrasSegundoReinicio.finalizarEnvio();
  check(colaTrasSegundoReinicio.intentarIniciarEnvio() === true, 'tras finalizarEnvio(), un nuevo intentarIniciarEnvio() vuelve a concederse');
  colaTrasSegundoReinicio.finalizarEnvio();

  colaTrasSegundoReinicio.vaciar();
  const colaVacia = new ColaPersistente(rutaTmp);
  check(colaVacia.tamano === 0, 'vaciar() (solo para tests/reseteo deliberado) persiste de verdad, no solo en memoria');
  fs.unlinkSync(rutaTmp);
}

// ---- A2: fichero de cola corrupto nunca se trata como "cola vacía" — se aparta y se avisa ----
{
  const rutaTmp = path.join(os.tmpdir(), 'mitesla-cola-corrupta-' + Date.now() + '.jsonl');
  fs.writeFileSync(rutaTmp, '{"id":"bueno1","tipo":"trip_started"}\nesto no es json\n{"sin_id":true}\n{"id":"bueno2","tipo":"trip_finished"}\n', 'utf8');
  const colaLogOriginal = console.error;
  console.error = () => {}; // silenciar el aviso esperado durante el test
  const cola = new ColaPersistente(rutaTmp);
  console.error = colaLogOriginal;
  check(cola.corrupcionDetectada === true && cola.lineasCorruptasDescartadas === 2, 'un fichero de cola con líneas corruptas se detecta explícitamente (2 líneas descartadas), nunca en silencio');
  check(cola.tamano === 2, 'las líneas válidas SÍ se conservan y se siguen procesando, pese a la corrupción parcial');
  check(cola.rutaCuarentena && fs.existsSync(cola.rutaCuarentena), 'las líneas corruptas se apartan a un fichero de cuarentena en vez de perderse sin más');
  fs.unlinkSync(rutaTmp);
  if (cola.rutaCuarentena) fs.unlinkSync(cola.rutaCuarentena);
}

// ---- enviarLoteConReintentos: reintenta ante fallo 500, no reintenta ante 400 ----
async function pruebasAsincronas() {
  {
    let llamadas = 0;
    const fetchFalso = async () => { llamadas++; return { ok: true, status: 200, json: async () => ({ ok: true, insertados: 1, duplicados: 0 }) }; };
    const resultado = await enviarLoteConReintentos('https://x/internal/telemetry', 's', { vin: VIN, events: [] }, { fetchImpl: fetchFalso, maxIntentos: 3, esperaBaseMs: 1 });
    check(llamadas === 1 && resultado.insertados === 1, 'una respuesta 200 se acepta a la primera, sin reintentos de más');
  }
  {
    let llamadas = 0;
    const fetchFalso = async () => { llamadas++; return { ok: false, status: 500, json: async () => ({}) }; };
    let error = null;
    try {
      await enviarLoteConReintentos('https://x/internal/telemetry', 's', { vin: VIN, events: [] }, { fetchImpl: fetchFalso, maxIntentos: 3, esperaBaseMs: 1 });
    } catch (e) { error = e; }
    check(llamadas === 3 && error, 'un 500 persistente se reintenta hasta maxIntentos y luego lanza el error (nada se envía por perdido en silencio)');
  }
  {
    let llamadas = 0;
    const fetchFalso = async () => { llamadas++; return { ok: false, status: 400, json: async () => ({ error: 'vin_invalido' }) }; };
    let error = null;
    try {
      await enviarLoteConReintentos('https://x/internal/telemetry', 's', { vin: 'x', events: [] }, { fetchImpl: fetchFalso, maxIntentos: 5, esperaBaseMs: 1 });
    } catch (e) { error = e; }
    check(llamadas === 1 && error, 'un 400 (rechazo del servidor, no un fallo de red) NO se reintenta a ciegas — falla rápido');
  }

  console.log('');
  if (fallos === 0) console.log('TODO OK — mitesla-telemetry-bridge (lógica pura, sin hardware real)');
  else { console.log(fallos + ' fallo(s).'); process.exitCode = 1; }
}

pruebasAsincronas();
