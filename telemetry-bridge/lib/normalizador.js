'use strict';
/**
 * mitesla-telemetry-bridge — lógica pura (sin red, sin MQTT, sin reloj real)
 * ----------------------------------------------------------------------------
 * Todo lo que se puede probar sin un vehículo físico vive aquí, separado de index.js
 * (que sí abre sockets MQTT/HTTPS reales). Así el test.js de este paquete ejercita
 * código de producción de verdad, no una reimplementación paralela.
 *
 * Formato de mensajes MQTT de teslamotors/fleet-telemetry (verificado en la documentación
 * oficial del propio proyecto):
 *   Topic:   <topic_base>/<VIN>/v/<nombre_de_campo>      (un mensaje por campo, JSON)
 *   Topic:   <topic_base>/<VIN>/alerts/<nombre>/current   { Name, StartedAt, EndedAt, Audiences }
 *   Topic:   <topic_base>/<VIN>/errors/<nombre>           { Name, Body, Tags, CreatedAt }
 *   Topic:   <topic_base>/<VIN>/connectivity              { ConnectionId, Status, CreatedAt }
 * https://github.com/teslamotors/fleet-telemetry/blob/main/datastore/mqtt/README.md
 *
 * REVISIÓN FASE A (auditoría externa, 2026-09-20): este módulo se ha reescrito para corregir
 * bugs críticos encontrados por una auditoría independiente. Ver A1-A9 abajo, cada bloque de
 * código indica a qué punto de la auditoría corresponde.
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------------------------------
// Topics y payload crudo
// ---------------------------------------------------------------------------------------------

/** Extrae {vin, seccion, resto} de un topic MQTT, o null si no encaja con el patrón esperado. */
function parsearTopic(topicBase, topic) {
  if (!topic.startsWith(topicBase + '/')) return null;
  const partes = topic.slice(topicBase.length + 1).split('/');
  if (partes.length < 2) return null;
  const vin = partes[0];
  const seccion = partes[1]; // 'v' | 'alerts' | 'errors' | 'connectivity'
  const resto = partes.slice(2).join('/');
  return { vin, seccion, resto };
}

/**
 * A8 — Timestamps correctos: el payload de /v/<campo> puede llegar como valor "pelado" (algunos
 * firmwares/versiones antiguas de fleet-telemetry) o como objeto {value, createdAt} (versiones
 * que sí incluyen el instante de origen). Nunca se asume un formato fijo: se detectan ambos y se
 * devuelve siempre la MISMA forma {valor, invalido, timestampVehiculo} para que el resto del
 * código no tenga que volver a mirar el payload crudo.
 *   - timestampVehiculo es el instante que Tesla/fleet-telemetry dice que se observó el dato en
 *     el vehículo. Si el payload no lo trae, queda explícitamente null (nunca se sustituye por la
 *     hora de recepción del bridge — eso se llama received_at_bridge y se calcula aparte, ver A8).
 */
function parsearValorMetrica(payloadTexto) {
  let crudo;
  try {
    crudo = JSON.parse(payloadTexto);
  } catch (e) {
    crudo = payloadTexto; // algunos firmwares mandan el valor sin comillas ni JSON válido
  }
  if (crudo && typeof crudo === 'object' && !Array.isArray(crudo)) {
    // A6 — invalid:true: fleet-telemetry puede marcar una métrica como no disponible/errónea.
    if (crudo.invalid === true || crudo.Invalid === true) {
      return { valor: undefined, invalido: true, timestampVehiculo: extraerTimestamp(crudo) };
    }
    if ('value' in crudo || 'Value' in crudo) {
      return { valor: ('value' in crudo) ? crudo.value : crudo.Value, invalido: false, timestampVehiculo: extraerTimestamp(crudo) };
    }
    // Objeto sin 'value' ni 'invalid' reconocibles (p.ej. el propio Location, ver A4): se
    // devuelve el objeto completo, quien llama decide cómo interpretarlo.
    return { valor: crudo, invalido: false, timestampVehiculo: extraerTimestamp(crudo) };
  }
  return { valor: crudo, invalido: false, timestampVehiculo: null };
}

function extraerTimestamp(obj) {
  const c = obj.createdAt || obj.CreatedAt || obj.timestamp || obj.Timestamp || null;
  if (!c) return null;
  const d = new Date(c);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------------------------------------
// A3 — Unidades: Fleet Telemetry documenta Odometer en millas y VehicleSpeed en mph. Todo lo que
// se guarda internamente (y todo lo que ve el Worker/la app) está en km / km/h / kWh. La
// conversión se hace en la frontera, aquí, una sola vez — nunca más abajo en el pipeline.
// ---------------------------------------------------------------------------------------------
const MILLAS_A_KM = 1.609344;
const CAMPOS_EN_MILLAS = new Set(['Odometer']);
const CAMPOS_EN_MPH = new Set(['VehicleSpeed', 'Speed']);

function normalizarUnidad(campo, valor) {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return valor;
  if (CAMPOS_EN_MILLAS.has(campo) || CAMPOS_EN_MPH.has(campo)) return valor * MILLAS_A_KM;
  return valor;
}

// ---------------------------------------------------------------------------------------------
// A4 — Location: las versiones actuales de Fleet Telemetry envían un único campo "Location" con
// un valor estructurado (latitud/longitud juntas) en vez de "Latitude"/"Longitude" sueltos. Se
// soportan ambos formatos: si llega "Location", se descompone en Latitude/Longitude internamente
// para que el resto del código (que ya sabe leer esos dos campos) no tenga que cambiar.
// ---------------------------------------------------------------------------------------------
function extraerLocation(valorLocation) {
  if (!valorLocation || typeof valorLocation !== 'object') return null;
  const lat = valorLocation.latitude ?? valorLocation.Latitude ?? valorLocation.lat;
  const lng = valorLocation.longitude ?? valorLocation.Longitude ?? valorLocation.lng ?? valorLocation.lon;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  return { lat, lng };
}

// ---------------------------------------------------------------------------------------------
// Estado en memoria por campo
// ---------------------------------------------------------------------------------------------

/**
 * Aplica una actualización de campo al estado en memoria de un VIN. Devuelve un NUEVO objeto de
 * estado (no muta el de entrada). `metrica` es SIEMPRE el resultado de parsearValorMetrica().
 *
 * A6: si la métrica llega marcada como inválida, el valor anterior NUNCA se sobrescribe (se
 * "conserva el último valor válido como contexto" tal y como exige la auditoría) — solo se anota
 * que se recibió un aviso de invalidez, para diagnóstico, sin tocar valor/observado_en.
 * A8: se guardan por separado observado_en_vehiculo (si Tesla lo dio) y recibido_en_bridge
 * (siempre, hora local del bridge al procesar el mensaje) — nunca se llama "observado_en" a la
 * hora de recepción del bridge.
 */
function actualizarEstado(estadoPrevio, campo, metrica, recibidoEnBridgeIso) {
  const estado = Object.assign({}, estadoPrevio);

  if (metrica.invalido) {
    if (estado[campo]) {
      estado[campo] = Object.assign({}, estado[campo], {
        ultimo_invalido_en: recibidoEnBridgeIso
      });
    }
    return estado;
  }

  if (campo === 'Location') {
    const partes = extraerLocation(metrica.valor);
    if (!partes) return estado; // Location mal formado: no se inventa lat/lng
    const observadoEnVehiculo = metrica.timestampVehiculo || null;
    const entrada = { observado_en_vehiculo: observadoEnVehiculo, recibido_en_bridge: recibidoEnBridgeIso, observado_en: observadoEnVehiculo || recibidoEnBridgeIso };
    estado.Latitude = Object.assign({}, entrada, { valor: partes.lat });
    estado.Longitude = Object.assign({}, entrada, { valor: partes.lng });
    return estado;
  }

  const valor = normalizarUnidad(campo, metrica.valor);
  const observadoEnVehiculo = metrica.timestampVehiculo || null;
  estado[campo] = {
    valor,
    observado_en_vehiculo: observadoEnVehiculo,
    recibido_en_bridge: recibidoEnBridgeIso,
    // observado_en: mejor timestamp disponible para este campo — el del vehículo si Tesla lo dio,
    // si no la hora de recepción del bridge (documentado explícitamente, nunca silencioso, A8).
    observado_en: observadoEnVehiculo || recibidoEnBridgeIso
  };
  return estado;
}

function valorDe(estado, campo) {
  return estado && estado[campo] ? estado[campo].valor : undefined;
}
function fechaDe(estado, campo) {
  return estado && estado[campo] ? estado[campo].observado_en : undefined;
}

/** Id determinista y corto para un evento discreto — mismo vin+tipo+instante => mismo id, así
 *  el Worker puede hacer INSERT OR IGNORE y un reintento de red nunca duplica nada. */
function idEvento(vin, tipo, observadoEnIso) {
  return crypto.createHash('sha256').update(vin + '|' + tipo + '|' + observadoEnIso).digest('hex').slice(0, 24);
}

const CAMPOS_ESTADO_CONDUCCION = ['Gear', 'ShiftState', 'shift_state'];
const CAMPOS_ESTADO_CARGA = ['DetailedChargeState', 'ChargeState', 'detailed_charge_state'];
const ESTADOS_CARGANDO = new Set(['Charging', 'CHARGING', 'DetailedChargeStateCharging']);
const ESTADOS_CARGA_TERMINADA = new Set(['Complete', 'Disconnected', 'Stopped', 'DetailedChargeStateComplete', 'DetailedChargeStateDisconnected', 'DetailedChargeStateStopped']);

function primerCampoPresente(estado, nombres) {
  for (const n of nombres) if (estado[n] !== undefined) return n;
  return null;
}

// ---------------------------------------------------------------------------------------------
// A1 — Máquina de estados candidato/confirmado.
//
// EL BUG ORIGINAL: se comparaba "estadoUltimoEnvio" (una foto tomada en el ciclo de envío
// anterior) contra "estadoActual" (el estado en vivo), y al final de CADA ciclo —incluso si no
// se detectaba ninguna transición— se hacía `estadoUltimoEnvio = estadoActual`. Eso "confirmaba"
// silenciosamente un cambio de estado que todavía no había cumplido el debounce, así que en el
// siguiente ciclo anterior===actual y la transición desaparecía para siempre sin generar evento.
//
// LA CORRECCIÓN: se separa explícitamente candidato (último valor visto, con el instante en que
// se vio POR PRIMERA VEZ) de confirmado (el valor que ya generó/generaría un evento). Un valor
// nunca pasa a confirmado hasta que ha permanecido como candidato ≥ debounceMs. Mientras no se
// confirma, el candidato anterior NUNCA se pierde ni se sobreescribe con uno intermedio: solo se
// actualiza cuando llega un valor distinto del candidato actual (para no reiniciar el cronómetro
// por reenvíos del mismo valor).
// ---------------------------------------------------------------------------------------------

function crearSeguimientoTransiciones() {
  return {
    conduccion: { confirmado: undefined, candidato: undefined, candidatoDesdeMs: null },
    carga: { confirmado: undefined, candidato: undefined, candidatoDesdeMs: null }
  };
}

/** Se llama en CADA mensaje MQTT relevante (no solo en el ciclo de envío) para que el cronómetro
 *  de estabilidad se mida desde el instante real de observación, no desde la cadencia de envío. */
function actualizarSeguimientoTransiciones(seguimiento, estado, ahoraMs) {
  const s = {
    conduccion: Object.assign({}, seguimiento.conduccion),
    carga: Object.assign({}, seguimiento.carga)
  };

  const campoConduccion = primerCampoPresente(estado, CAMPOS_ESTADO_CONDUCCION);
  if (campoConduccion) {
    const actual = valorDe(estado, campoConduccion);
    if (actual !== s.conduccion.candidato) {
      s.conduccion.candidato = actual;
      s.conduccion.candidatoDesdeMs = ahoraMs;
      s.conduccion.campoOrigen = campoConduccion;
    }
  }

  const campoCarga = primerCampoPresente(estado, CAMPOS_ESTADO_CARGA);
  if (campoCarga) {
    const actual = valorDe(estado, campoCarga);
    if (actual !== s.carga.candidato) {
      s.carga.candidato = actual;
      s.carga.candidatoDesdeMs = ahoraMs;
      s.carga.campoOrigen = campoCarga;
    }
  }

  return s;
}

const MAX_CONTEXT_AGE_MS_POR_DEFECTO = 5 * 60 * 1000; // A7: 5 minutos

/**
 * Revisa si algún candidato ya lleva suficiente tiempo estable como para confirmarse, y si la
 * confirmación implica una transición real (P→D, Charging→Complete, etc.) genera el evento
 * correspondiente. Se puede llamar tan a menudo como se quiera (en cada ciclo, o en cada
 * mensaje) — es idempotente: si nada cambió desde la última llamada, no emite nada.
 */
function confirmarTransiciones(vin, seguimiento, estado, ahoraMs, opciones) {
  const debounceMs = (opciones && opciones.debounceMs) || 60000;
  const maxContextAgeMs = (opciones && opciones.maxContextAgeMs) || MAX_CONTEXT_AGE_MS_POR_DEFECTO;
  const eventos = [];
  const s = {
    conduccion: Object.assign({}, seguimiento.conduccion),
    carga: Object.assign({}, seguimiento.carga)
  };

  // --- Conducción ---
  const c = s.conduccion;
  if (c.candidato !== undefined && c.candidato !== c.confirmado && (ahoraMs - c.candidatoDesdeMs) >= debounceMs) {
    const confirmadoAntes = c.confirmado;
    const conduciendoAntes = confirmadoAntes === 'D' || confirmadoAntes === 'R';
    const conduciendoAhora = c.candidato === 'D' || c.candidato === 'R';
    const observadoEn = new Date(ahoraMs).toISOString();
    if (!conduciendoAntes && conduciendoAhora) {
      const ctx = contextoPosicionOdometro(estado, ahoraMs, maxContextAgeMs);
      eventos.push({ id: idEvento(vin, 'trip_started', observadoEn), tipo: 'trip_started', observado_en: observadoEn, payload: Object.assign({ shift_state: c.candidato }, ctx) });
    } else if (conduciendoAntes && !conduciendoAhora) {
      const ctx = contextoPosicionOdometro(estado, ahoraMs, maxContextAgeMs);
      eventos.push({ id: idEvento(vin, 'trip_finished', observadoEn), tipo: 'trip_finished', observado_en: observadoEn, payload: Object.assign({ shift_state: c.candidato }, ctx) });
    }
    c.confirmado = c.candidato;
  }

  // --- Carga ---
  const g = s.carga;
  if (g.candidato !== undefined && g.candidato !== g.confirmado && (ahoraMs - g.candidatoDesdeMs) >= debounceMs) {
    const confirmadoAntes = g.confirmado;
    const cargandoAntes = ESTADOS_CARGANDO.has(confirmadoAntes);
    const cargandoAhora = ESTADOS_CARGANDO.has(g.candidato);
    const terminadaAhora = ESTADOS_CARGA_TERMINADA.has(g.candidato);
    const observadoEn = new Date(ahoraMs).toISOString();
    if (!cargandoAntes && cargandoAhora) {
      const ctx = contextoCarga(estado, ahoraMs, maxContextAgeMs);
      eventos.push({ id: idEvento(vin, 'charge_started', observadoEn), tipo: 'charge_started', observado_en: observadoEn, payload: Object.assign({ estado_carga: g.candidato }, ctx) });
      g.confirmado = g.candidato;
    } else if (cargandoAntes && terminadaAhora) {
      const ctx = contextoCarga(estado, ahoraMs, maxContextAgeMs);
      eventos.push({ id: idEvento(vin, 'charge_stopped', observadoEn), tipo: 'charge_stopped', observado_en: observadoEn, payload: Object.assign({ estado_carga: g.candidato }, ctx) });
      g.confirmado = g.candidato;
    } else if (!cargandoAntes && !cargandoAhora) {
      // Transición entre dos estados "no cargando" (p.ej. Disconnected → Stopped): se confirma
      // sin emitir evento de negocio, para no quedar reintentando esta rama en cada ciclo.
      g.confirmado = g.candidato;
    }
    // Si cargandoAntes && cargandoAhora-no-terminada (p.ej. flapping entre sub-estados de carga
    // activa) no se confirma como transición de negocio, pero tampoco se deja el candidato mudo:
    // se confirma igualmente para no reevaluar indefinidamente el mismo valor.
    if (!eventos.some((e) => e.tipo.startsWith('charge_')) && g.candidato !== g.confirmado) {
      g.confirmado = g.candidato;
    }
  }

  return { seguimiento: s, eventos };
}

// ---------------------------------------------------------------------------------------------
// Snapshot / contexto
// ---------------------------------------------------------------------------------------------

/** Construye el snapshot en el formato exacto que espera POST /internal/telemetry del Worker.
 *  Un campo ausente en el estado se manda como null explícito — nunca 0 ni un valor inventado. */
function construirSnapshot(estado) {
  const camposObservados = Object.keys(estado).map((c) => fechaDe(estado, c)).filter(Boolean).sort();
  const observadoMasReciente = camposObservados.length ? camposObservados[camposObservados.length - 1] : new Date().toISOString();
  return {
    soc_pct: primerValorNumerico(estado, ['Soc', 'soc']),
    autonomia_km: primerValorNumerico(estado, ['EstBatteryRange', 'RatedRange']),
    odometro_km: primerValorNumerico(estado, ['Odometer', 'odometer']),
    estado: derivarEstadoVehiculo(estado),
    lat: primerValorNumerico(estado, ['Latitude', 'latitude']),
    lng: primerValorNumerico(estado, ['Longitude', 'longitude']),
    ubicacion_nombre: null, // se resuelve por geofence en el Worker/4B, el bridge nunca decide nombres
    temperatura_exterior: primerValorNumerico(estado, ['OutsideTemp', 'outside_temp']),
    potencia_carga_kw: primerValorNumerico(estado, ['ACChargingPower', 'DCChargingPower', 'charge_power']),
    tiempo_restante_carga_min: primerValorNumerico(estado, ['MinutesToFullCharge', 'time_to_full_charge']),
    fuente: 'TESLA_TELEMETRY',
    observado_en: observadoMasReciente
  };
}

/** A7: adjunta lat/lng/odómetro/SoC conocidos en el momento de un evento — pero SOLO si el dato
 *  es lo bastante reciente (maxAgeMs). Si un campo existe pero está obsoleto, se manda null y
 *  data_quality baja a 'partial' — nunca se usa un valor de hace minutos como si fuera actual. */
function contextoPosicionOdometro(estado, ahoraMs, maxAgeMs) {
  const edad = maxAgeMs || MAX_CONTEXT_AGE_MS_POR_DEFECTO;
  const lat = valorFrescoONulo(estado, ['Latitude', 'latitude'], ahoraMs, edad);
  const lng = valorFrescoONulo(estado, ['Longitude', 'longitude'], ahoraMs, edad);
  const odometro_km = valorFrescoONulo(estado, ['Odometer', 'odometer'], ahoraMs, edad);
  const soc_pct = valorFrescoONulo(estado, ['Soc', 'soc'], ahoraMs, edad);
  // B9 (FASE B): EnergyRemaining no está en todos los vehículos/configuraciones de streaming
  // ("cuando esté soportada", según el encargo) — por eso NO entra en el cálculo de "incompleto":
  // un vehículo sin esta señal suscrita sigue teniendo data_quality 'full' igual que antes de B9,
  // simplemente energy_remaining_kwh queda en null (ausencia real, no un fallo de calidad).
  const energy_remaining_kwh = valorFrescoONulo(estado, ['EnergyRemaining'], ahoraMs, edad);
  const incompleto = [lat, lng, odometro_km, soc_pct].some((v) => v === null);
  return { lat, lng, odometro_km, soc_pct, energy_remaining_kwh, data_quality: incompleto ? 'partial' : 'full' };
}

/** A7, misma lógica que contextoPosicionOdometro, aplicada a los campos de carga. */
function contextoCarga(estado, ahoraMs, maxAgeMs) {
  const edad = maxAgeMs || MAX_CONTEXT_AGE_MS_POR_DEFECTO;
  const base = contextoPosicionOdometro(estado, ahoraMs, edad);
  const ac_energy_kwh = valorFrescoONulo(estado, ['ACChargingEnergyIn'], ahoraMs, edad);
  const dc_energy_kwh = valorFrescoONulo(estado, ['DCChargingEnergyIn'], ahoraMs, edad);
  const ac_power_kw = valorFrescoONulo(estado, ['ACChargingPower'], ahoraMs, edad);
  const dc_power_kw = valorFrescoONulo(estado, ['DCChargingPower'], ahoraMs, edad);
  const incompleto = base.data_quality === 'partial' || [ac_energy_kwh, dc_energy_kwh].every((v) => v === null);
  return Object.assign({}, base, { ac_energy_kwh, dc_energy_kwh, ac_power_kw, dc_power_kw, data_quality: incompleto ? 'partial' : 'full' });
}

function primerValorNumerico(estado, nombres) {
  for (const n of nombres) {
    const v = valorDe(estado, n);
    if (v !== undefined && v !== null && !Number.isNaN(Number(v))) return Number(v);
  }
  return null;
}

function campoFresco(estado, campo, ahoraMs, maxAgeMs) {
  const info = estado[campo];
  if (!info) return false;
  if (typeof ahoraMs !== 'number') return true; // sin reloj de referencia (llamado sin contexto de tiempo), no se filtra por edad
  const observado = info.observado_en;
  if (!observado) return false;
  const edad = ahoraMs - new Date(observado).getTime();
  return Number.isFinite(edad) && edad <= maxAgeMs;
}

function valorFrescoONulo(estado, nombres, ahoraMs, maxAgeMs) {
  for (const n of nombres) {
    if (estado[n] !== undefined && campoFresco(estado, n, ahoraMs, maxAgeMs)) {
      const v = valorDe(estado, n);
      if (v !== undefined && v !== null && !Number.isNaN(Number(v))) return Number(v);
    }
  }
  return null;
}

function derivarEstadoVehiculo(estado) {
  const campoCarga = primerCampoPresente(estado, CAMPOS_ESTADO_CARGA);
  if (campoCarga && ESTADOS_CARGANDO.has(valorDe(estado, campoCarga))) return 'charging';
  const campoConduccion = primerCampoPresente(estado, CAMPOS_ESTADO_CONDUCCION);
  if (campoConduccion) {
    const v = valorDe(estado, campoConduccion);
    if (v === 'D' || v === 'R') return 'driving';
    if (v === 'P') return 'parked';
  }
  return 'desconocido';
}

module.exports = {
  parsearTopic,
  parsearValorMetrica,
  actualizarEstado,
  idEvento,
  crearSeguimientoTransiciones,
  actualizarSeguimientoTransiciones,
  confirmarTransiciones,
  construirSnapshot,
  contextoPosicionOdometro,
  contextoCarga,
  normalizarUnidad,
  extraerLocation,
  MILLAS_A_KM,
  MAX_CONTEXT_AGE_MS_POR_DEFECTO
};
