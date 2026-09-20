'use strict';
/**
 * A18 (FASE A, auditoría externa 2026-09-20): helper compartido para lanzar Chromium desde los
 * tests, sin rutas absolutas fijas al entorno de un desarrollador concreto. Antes cada test tenía
 * `executablePath: '/opt/pw-browsers/chromium'` hardcodeado (una ruta que solo existe en el
 * contenedor donde se escribió esto) — desde un checkout limpio en cualquier otra máquina, tras
 * `npm ci && npx playwright install chromium`, Playwright ya sabe encontrar su propio navegador
 * sin necesidad de indicarle la ruta. Si PLAYWRIGHT_CHROMIUM_PATH está definida (como en este
 * entorno concreto, donde el navegador viene preinstalado en una ruta fija), se usa esa ruta —
 * así los tests siguen funcionando aquí Y en un checkout limpio en otra máquina, sin tener que
 * elegir una de las dos rutas a ciegas.
 */
const { chromium } = require('playwright');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

function opcionesLanzamiento(extra) {
  const opciones = Object.assign({}, extra || {});
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    opciones.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  return opciones;
}

async function lanzarChromium(extra) {
  return chromium.launch(opcionesLanzamiento(extra));
}

/** URL file:// al index.html real del proyecto — nunca una ruta absoluta hardcodeada. */
function urlIndexHtml() {
  return 'file://' + path.join(PROJECT_ROOT, 'index.html');
}

module.exports = { lanzarChromium, opcionesLanzamiento, urlIndexHtml, PROJECT_ROOT };
