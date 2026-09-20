'use strict';
/** Firma y envío del lote al Worker. La firma es idéntica byte a byte a `verificarFirmaBridge()`
 *  de worker.js: HMAC-SHA256 de "timestamp.nonce.cuerpo" con el secreto TELEMETRY_BRIDGE_SECRET. */
const crypto = require('crypto');

function firmar(secreto, timestamp, nonce, cuerpoTexto) {
  return crypto.createHmac('sha256', secreto).update(timestamp + '.' + nonce + '.' + cuerpoTexto).digest('hex');
}

function construirPeticion(secreto, cuerpoObjeto) {
  const cuerpoTexto = JSON.stringify(cuerpoObjeto);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const firma = firmar(secreto, timestamp, nonce, cuerpoTexto);
  return {
    cuerpoTexto,
    headers: {
      'Content-Type': 'application/json',
      'X-Signature': firma,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce
    }
  };
}

/** Envía un lote con reintentos y backoff exponencial (sección 53: nunca se pierde el lote por un
 *  fallo de red pasajero). `fetchImpl` se inyecta para poder probarlo sin red real. */
async function enviarLoteConReintentos(url, secreto, cuerpoObjeto, opciones) {
  const fetchImpl = (opciones && opciones.fetchImpl) || fetch;
  const maxIntentos = (opciones && opciones.maxIntentos) || 5;
  const esperaBaseMs = (opciones && opciones.esperaBaseMs) || 2000;
  let ultimoError = null;
  for (let intento = 1; intento <= maxIntentos; intento++) {
    const { cuerpoTexto, headers } = construirPeticion(secreto, cuerpoObjeto);
    try {
      const res = await fetchImpl(url, { method: 'POST', headers, body: cuerpoTexto });
      if (res.ok) return await res.json();
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        // Error del cliente que un reintento con el mismo lote no va a arreglar (VIN inválido,
        // cuerpo mal formado, firma rechazada por reloj desincronizado) — no insistir a ciegas.
        throw new Error('rechazo_no_recuperable_' + res.status);
      }
      ultimoError = new Error('http_' + res.status);
    } catch (e) {
      ultimoError = e;
      if (String(e.message || '').startsWith('rechazo_no_recuperable_')) throw e;
    }
    if (intento < maxIntentos) await new Promise((r) => setTimeout(r, esperaBaseMs * Math.pow(2, intento - 1)));
  }
  throw ultimoError || new Error('fallo_desconocido_enviando_lote');
}

module.exports = { firmar, construirPeticion, enviarLoteConReintentos };
