'use strict';
/**
 * Cola de eventos pendientes de enviar, persistida en disco (una línea JSON por evento) para que
 * un reinicio de la VM o un corte de red no pierda telemetría ya recibida de Tesla.
 *
 * REVISIÓN FASE A (A2 — pérdida de eventos, auditoría externa 2026-09-20):
 *
 * EL BUG ORIGINAL: `todos()` devolvía una copia del array, se enviaba, y al confirmar el envío se
 * llamaba `vaciar()`, que borraba TODO lo que hubiera en la cola en ese instante — incluidos
 * eventos que hubieran llegado (`encolar()`) mientras la petición HTTP estaba en vuelo. Ejemplo:
 * cola=[A], se envía [A], llega B (cola=[A,B]), el servidor confirma A, `vaciar()` borra [A,B]
 * entero → B desaparece sin haberse enviado nunca.
 *
 * LA CORRECCIÓN: cada evento tiene `id` (ya lo tenía, vía idEvento()). La cola es un Map por id.
 * `peekBatch()` NUNCA elimina nada — solo `ack(ids)` elimina, y solo los ids que de verdad
 * confirmó el servidor. Un evento añadido durante un envío en curso simplemente no está en los
 * `ids` que se van a confirmar, así que sobrevive intacto para el siguiente ciclo.
 *
 * Persistencia atómica: cada escritura se hace a un fichero temporal y se renombra (rename es
 * atómico en el mismo sistema de ficheros) — nunca se deja el fichero de cola a medio escribir.
 *
 * Fichero corrupto: nunca se interpreta como "cola vacía". Las líneas que no son JSON válido (o
 * que no tienen `id`) se apartan a un fichero `.corrupto-<timestamp>` al lado, se cuentan, y se
 * deja constancia explícita (log de error + propiedad `corrupcionDetectada`) para que el health
 * check y el operador humano se enteren — nunca se descartan en silencio.
 */
const fs = require('fs');

class ColaPersistente {
  constructor(rutaArchivo) {
    this.rutaArchivo = rutaArchivo;
    this.corrupcionDetectada = false;
    this.lineasCorruptasDescartadas = 0;
    this.rutaCuarentena = null;
    this._porId = new Map(); // Map<id, evento> — preserva orden de inserción
    this._enviando = false; // A2: single-flight, ver index.js
    this._cargar();
  }

  _cargar() {
    let texto;
    try {
      texto = fs.readFileSync(this.rutaArchivo, 'utf8');
    } catch (e) {
      return; // primer arranque: no hay archivo todavía, cola vacía — nunca un error fatal
    }
    const lineas = texto.split('\n').filter((l) => l.trim().length);
    const validas = [];
    const corruptas = [];
    for (const linea of lineas) {
      try {
        const ev = JSON.parse(linea);
        if (!ev || typeof ev.id !== 'string' || !ev.id) throw new Error('evento sin id');
        validas.push(ev);
      } catch (e) {
        corruptas.push(linea);
      }
    }
    for (const ev of validas) this._porId.set(ev.id, ev);
    if (corruptas.length) {
      this.corrupcionDetectada = true;
      this.lineasCorruptasDescartadas = corruptas.length;
      try {
        this.rutaCuarentena = this.rutaArchivo + '.corrupto-' + Date.now();
        fs.writeFileSync(this.rutaCuarentena, corruptas.join('\n') + '\n', 'utf8');
      } catch (e2) {
        this.rutaCuarentena = null;
      }
      console.error(
        '[cola-pendiente] %d línea(s) corrupta(s) detectada(s) en %s%s — la cola sigue operando ' +
        'con los %d eventos válidos leídos, pero esto requiere revisión manual (ver /internal/health).',
        corruptas.length, this.rutaArchivo,
        this.rutaCuarentena ? (' (conservadas en ' + this.rutaCuarentena + ')') : ' (NO se pudieron conservar aparte)',
        validas.length
      );
    }
  }

  /** Escritura atómica: nunca se deja el fichero de cola a medias (write temporal + rename). */
  _guardar() {
    const eventos = Array.from(this._porId.values());
    const texto = eventos.map((e) => JSON.stringify(e)).join('\n') + (eventos.length ? '\n' : '');
    const rutaTmp = this.rutaArchivo + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    fs.writeFileSync(rutaTmp, texto, 'utf8');
    fs.renameSync(rutaTmp, this.rutaArchivo);
  }

  /** Encola un evento por id — si el id ya existe (reintento/duplicado local), no lo duplica. */
  encolar(evento) {
    if (!evento || typeof evento.id !== 'string' || !evento.id) {
      throw new Error('encolar() requiere un evento con id (idEvento())');
    }
    if (this._porId.has(evento.id)) return false;
    this._porId.set(evento.id, evento);
    this._guardar();
    return true;
  }

  /** Devuelve hasta `maxSize` eventos SIN eliminarlos. Solo ack(ids) elimina. */
  peekBatch(maxSize) {
    const todos = Array.from(this._porId.values());
    return typeof maxSize === 'number' ? todos.slice(0, maxSize) : todos;
  }

  /** Alias legado, usado por código/tests anteriores a A2 — equivale a peekBatch() sin límite. */
  todos() {
    return this.peekBatch();
  }

  /** Elimina SOLO los eventos confirmados por el servidor. Cualquier evento encolado después de
   *  que empezara el envío (id distinto) permanece intacto para el siguiente ciclo. */
  ack(ids) {
    let cambiado = false;
    for (const id of ids || []) {
      if (this._porId.delete(id)) cambiado = true;
    }
    if (cambiado) this._guardar();
    return cambiado;
  }

  /** A2 — single-flight: evita que dos ciclos de envío corran a la vez si uno tarda más que el
   *  intervalo. Devuelve false si ya hay un envío en curso (el llamador debe saltarse ese ciclo). */
  intentarIniciarEnvio() {
    if (this._enviando) return false;
    this._enviando = true;
    return true;
  }
  finalizarEnvio() {
    this._enviando = false;
  }
  get enviando() {
    return this._enviando;
  }

  /** Se mantiene por compatibilidad, pero index.js ya NO la usa tras A2 (vaciar sin ack()
   *  explícito reintroduce el bug que corrige esta fase). Solo para tests / reseteo deliberado. */
  vaciar() {
    this._porId.clear();
    this._guardar();
  }

  get tamano() {
    return this._porId.size;
  }
}

module.exports = { ColaPersistente };
