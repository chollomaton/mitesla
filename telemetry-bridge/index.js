'use strict';
/**
 * mitesla-telemetry-bridge
 * ------------------------------------------------------------------------------------------
 * Proceso Node que se ejecuta en la VM Always Free, junto a Mosquitto y al servidor oficial
 * teslamotors/fleet-telemetry (ver ../infra/). Se suscribe al broker MQTT LOCAL (nunca expuesto
 * a Internet), agrega los mensajes por-campo que publica fleet-telemetry, detecta transiciones
 * de viaje/carga con debounce, construye lotes y snapshots, y los envía firmados (HMAC) al
 * Worker de Cloudflare por HTTPS. Ver README.md de esta carpeta para la puesta en marcha exacta.
 *
 * IMPORTANTE (honestidad): este archivo NO se ha podido probar de extremo a extremo contra un
 * vehículo real ni contra una instancia real de fleet-telemetry, porque en el momento de
 * escribirlo el usuario todavía no dispone del vehículo. Lo que SÍ está probado (test.js, mismo
 * directorio) es toda la lógica pura que no depende de una conexión real. La parte de conexión
 * MQTT/HTTPS en sí (este archivo) sigue el patrón oficial de la librería `mqtt` y del propio
 * README de fleet-telemetry, pero su verificación real solo puede completarse en Modo Sombra
 * (infra/README.md §9) una vez el coche esté disponible.
 *
 * REVISIÓN FASE A (auditoría externa, 2026-09-20): reescrito para usar la máquina de estados
 * candidato/confirmado (A1) y la cola peekBatch/ack con single-flight (A2) — ver comentarios en
 * lib/normalizador.js y lib/cola.js para el detalle de cada bug corregido.
 */
const mqtt = require('mqtt');
const {
  parsearTopic, parsearValorMetrica, actualizarEstado,
  crearSeguimientoTransiciones, actualizarSeguimientoTransiciones, confirmarTransiciones,
  construirSnapshot
} = require('./lib/normalizador');
const { enviarLoteConReintentos } = require('./lib/envio');
const { ColaPersistente } = require('./lib/cola');

const CONFIG = {
  mqttUrl: process.env.MQTT_URL || 'mqtt://127.0.0.1:1883',
  topicBase: process.env.MQTT_TOPIC_BASE || 'mitesla_telemetry',
  vin: process.env.TESLA_VIN,
  workerUrl: process.env.WORKER_TELEMETRY_URL, // p.ej. https://api.tudominio.com/internal/telemetry
  secreto: process.env.TELEMETRY_BRIDGE_SECRET,
  intervaloEnvioMs: Number(process.env.INTERVALO_ENVIO_MS || 30000),
  debounceTransicionMs: Number(process.env.DEBOUNCE_TRANSICION_MS || 60000),
  // A7: contexto (lat/lng/odómetro/SoC) más viejo que esto en el momento de confirmar una
  // transición se manda como null (data_quality=partial) en vez de como un dato "actual" caducado.
  maxContextAgeMs: Number(process.env.MAX_CONTEXT_AGE_MS || 5 * 60 * 1000),
  rutaColaPendiente: process.env.RUTA_COLA_PENDIENTE || './cola-pendiente.jsonl'
};

function comprobarConfigObligatoria() {
  const faltan = ['vin', 'workerUrl', 'secreto'].filter((k) => !CONFIG[k]);
  if (faltan.length) {
    console.error('[mitesla-telemetry-bridge] Faltan variables de entorno obligatorias:', faltan.map((k) => ({
      vin: 'TESLA_VIN', workerUrl: 'WORKER_TELEMETRY_URL', secreto: 'TELEMETRY_BRIDGE_SECRET'
    }[k])));
    process.exit(1);
  }
}

function iniciar() {
  comprobarConfigObligatoria();

  const cola = new ColaPersistente(CONFIG.rutaColaPendiente);
  if (cola.corrupcionDetectada) throw Error('durable_state_corrupted_review_required');
  const recovered=cola.checkpoint;
  if (recovered && recovered.vin !== CONFIG.vin) throw Error('checkpoint_vin_conflict');
  if (!recovered && cola.tamano) throw Error('legacy_pending_queue_requires_checkpoint_review');
  let estadoActual=recovered?.estadoActual || {};
  let seguimiento=recovered?.seguimiento || crearSeguimientoTransiciones();


  // A9: contadores/heartbeat locales, reportados al Worker en cada ciclo para el health check real.
  let señalesDesdeUltimoEnvio = 0;
  let ultimoConnectivityStatus = null;
  let huboConnectivityDesdeUltimoEnvio = false;

  console.log('[mitesla-telemetry-bridge] arrancando — VIN=%s broker=%s worker=%s (cola pendiente al iniciar: %d)',
    CONFIG.vin, CONFIG.mqttUrl, CONFIG.workerUrl, cola.tamano);

  const client = mqtt.connect(CONFIG.mqttUrl, { reconnectPeriod: 5000 });

  client.on('connect', function () {
    console.log('[mitesla-telemetry-bridge] conectado a Mosquitto, suscribiendo a %s/#', CONFIG.topicBase);
    client.subscribe(CONFIG.topicBase + '/#', function (err) {
      if (err) console.error('[mitesla-telemetry-bridge] error al suscribir:', err.message);
    });
  });

  client.on('reconnect', function () { console.log('[mitesla-telemetry-bridge] reconectando a Mosquitto...'); });
  client.on('error', function (err) { console.error('[mitesla-telemetry-bridge] error MQTT:', err.message); });

  client.on('message', function (topic, payloadBuf) {
    const info = parsearTopic(CONFIG.topicBase, topic);
    if (!info || info.vin !== CONFIG.vin) return; // un solo vehículo por bridge — nunca mezcla VINs
    señalesDesdeUltimoEnvio++;
    const ahoraMs = Date.now();
    const ahoraIso = new Date(ahoraMs).toISOString();
    if (info.seccion === 'v' && info.resto) {
      const metrica = parsearValorMetrica(payloadBuf.toString('utf8'));
      const nuevoEstado = actualizarEstado(estadoActual, info.resto, metrica, ahoraIso);
      // A1: el candidato se actualiza EN CADA MENSAJE (no en el ciclo de envío) para que el
      // cronómetro de estabilidad se mida desde el instante real de observación.
      const nuevoSeguimiento = actualizarSeguimientoTransiciones(seguimiento, nuevoEstado, ahoraMs);
      cola.confirmarEstado({vin:CONFIG.vin,estadoActual:nuevoEstado,seguimiento:nuevoSeguimiento});
      estadoActual=nuevoEstado;seguimiento=nuevoSeguimiento;
    } else if (info.seccion === 'connectivity') {
      huboConnectivityDesdeUltimoEnvio = true;
      try {
        const cuerpo = JSON.parse(payloadBuf.toString('utf8'));
        ultimoConnectivityStatus = cuerpo && (cuerpo.Status || cuerpo.status) || ultimoConnectivityStatus;
      } catch (e) { /* connectivity con payload no-JSON: se ignora el detalle, no rompe nada */ }
    }
    // 'alerts'/'errors' se registran solo en el log local por ahora (diagnóstico) — su volcado a
    // D1 como alertas de verdad lo hace el motor de alertas del propio Worker (Fase 4E), a partir
    // de lo que SÍ llega (huecos de odómetro, silencio de telemetría), no de este topic.
  });

  async function ciclo() {
    // A2: single-flight — si un ciclo anterior sigue en vuelo (p.ej. red lenta), este ciclo se
    // salta entero en vez de arrancar un segundo envío solapado.
    if (!cola.intentarIniciarEnvio()) {
      console.log('[mitesla-telemetry-bridge] ciclo anterior todavía en curso, se salta este tick');
      return;
    }
    try {
      const ahoraMs = Date.now();
      // A1: confirmarTransiciones es idempotente — se puede llamar en cada ciclo sin riesgo de
      // "perder" el candidato si todavía no lleva bastante tiempo estable (a diferencia del bug
      // original, aquí NUNCA se sobreescribe estadoUltimoEnvio con un valor todavía no confirmado).
      const resultado = confirmarTransiciones(CONFIG.vin, seguimiento, estadoActual, ahoraMs, {
        debounceMs: CONFIG.debounceTransicionMs,
        maxContextAgeMs: CONFIG.maxContextAgeMs
      });
      cola.confirmarEstado({vin:CONFIG.vin,estadoActual,seguimiento:resultado.seguimiento},resultado.eventos);
      seguimiento = resultado.seguimiento;

      const eventosAEnviar = cola.peekBatch(500); // A15: el Worker también limita a 500/petición
      const snapshot = Object.keys(estadoActual).length ? construirSnapshot(estadoActual) : null;
      if (eventosAEnviar.length === 0 && !snapshot) return; // nada que enviar todavía

      const cuerpo = {
        vin: CONFIG.vin,
        events: eventosAEnviar,
        snapshot,
        senales_recibidas: señalesDesdeUltimoEnvio,
        heartbeat: huboConnectivityDesdeUltimoEnvio ? { connectivity_status: ultimoConnectivityStatus } : null
      };
      const respuesta = await enviarLoteConReintentos(CONFIG.workerUrl, CONFIG.secreto, cuerpo);
      console.log('[mitesla-telemetry-bridge] lote enviado: %d eventos (%d nuevos, %d duplicados según el servidor, modo=%s)',
        eventosAEnviar.length, respuesta.insertados, respuesta.duplicados, respuesta.automation_mode || '?');
      // A2: SOLO se eliminan de la cola los eventos que el propio lote llevaba y que el servidor
      // ya tiene guardados (id determinista => "insertados" o "duplicados" cuentan igual como ya
      // persistidos). Cualquier evento encolado DURANTE este envío (id distinto, no estaba en
      // eventosAEnviar) sigue en la cola intacto para el siguiente ciclo.
      cola.ack(eventosAEnviar.map((e) => e.id));
      señalesDesdeUltimoEnvio = 0;
      huboConnectivityDesdeUltimoEnvio = false;
    } catch (e) {
      if(e.persistenceCommitUncertain) process.exit(1);
      console.error('[mitesla-telemetry-bridge] fallo enviando el lote, se reintentará en el próximo ciclo (nada se pierde, sigue en la cola):', e.message);
    } finally {
      cola.finalizarEnvio();
    }
  }

  setInterval(function () { ciclo().catch((e) => console.error('[mitesla-telemetry-bridge] error inesperado en el ciclo:', e)); }, CONFIG.intervaloEnvioMs);

  process.on('SIGTERM', function () { console.log('[mitesla-telemetry-bridge] SIGTERM recibido, cerrando (la cola en disco conserva lo pendiente)'); client.end(); process.exit(0); });
  process.on('SIGINT', function () { client.end(); process.exit(0); });
}

if (require.main === module) iniciar();

module.exports = { CONFIG, iniciar };
