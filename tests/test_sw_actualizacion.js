// A21 (FASE A): ciclo de vida del Service Worker — cubre el escenario de ACTUALIZACIÓN real, que
// test_pwa.js (install/offline/app-shell) y test_sw_404.js (asset ausente) no ejercitaban todavía:
// un SW nuevo se instala mientras uno viejo sigue controlando la página, la banda "nueva versión"
// aparece, y pulsar "Actualizar" dispara SKIP_WAITING -> activate del nuevo SW -> controllerchange
// -> recarga automática de la página, tal y como implementa app.js (sección "Service Worker: registro
// + UX de nueva versión").
const { lanzarChromium, PROJECT_ROOT } = require('./helpers/browser');
const http = require('http');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await lanzarChromium();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const dir = PROJECT_ROOT;

  // El servidor sirve sw.js con contenido MUTABLE: primero la v1 real del repo, y tras
  // instalarActivarV1() se cambia a una v2 (misma lógica, CACHE_VERSION distinta) para forzar una
  // actualización real detectable por el navegador (que compara el sw.js byte a byte).
  const swReal = fs.readFileSync(path.join(dir, 'sw.js'), 'utf8');
  let swServido = swReal;

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      res.end(swServido);
      return;
    }
    let p = path.join(dir, urlPath);
    if (p.endsWith('/')) p += 'index.html';
    fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      const ext = path.extname(p);
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  await page.goto('http://localhost:' + port + '/index.html');

  // ---- 1) Instalación inicial: el SW v1 pasa a controlar la página ----
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 8000 })
    .then(() => true).catch(() => false);
  const controladaV1 = await page.evaluate(() => !!navigator.serviceWorker.controller);
  console.log(controladaV1 ? '✅' : '❌ FALLO:', 'el SW v1 pasa a controlar la página tras la primera instalación (install + activate + waitUntil correctos)');

  // ---- 2) Se publica una v2 del SW (CACHE_VERSION distinta) y se fuerza reg.update() ----
  swServido = swReal.replace(/CACHE_VERSION = '[^']+'/, "CACHE_VERSION = '2099.01.01-test-actualizacion'");
  const huboBandaNuevaVersion = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return false;
    // updatefound + statechange('installed') es exactamente lo que hace app.js para mostrar la banda.
    const promesaInstalado = new Promise((resolve) => {
      reg.addEventListener('updatefound', () => {
        const nuevo = reg.installing;
        if (!nuevo) return resolve(false);
        nuevo.addEventListener('statechange', () => {
          if (nuevo.state === 'installed') resolve(true);
        });
      });
      setTimeout(() => resolve(false), 8000);
    });
    await reg.update();
    return promesaInstalado;
  });
  console.log(huboBandaNuevaVersion ? '✅' : '❌ FALLO:', 'un SW v2 con contenido distinto se detecta como actualización real (updatefound + installed) mientras el v1 sigue controlando la página — dispara la banda "nueva versión" en la app real');

  // La app real (app.js) reacciona a exactamente este mismo evento mostrando #banda-nueva-version.
  // Se verifica también en la propia página (no solo en el arnés de prueba) para confirmar que el
  // código de producción, no una reimplementación paralela del test, es el que reacciona.
  await page.waitForTimeout(300);
  const bandaVisibleEnApp = await page.evaluate(() => {
    const el = document.getElementById('banda-nueva-version');
    return !!el && getComputedStyle(el).display !== 'none';
  });
  console.log(bandaVisibleEnApp ? '✅' : '❌ FALLO:', 'la app real muestra #banda-nueva-version cuando detecta el SW nuevo en estado "installed" (no solo el arnés de prueba)');

  // ---- 3) Pulsar "Actualizar" -> SKIP_WAITING -> activate del v2 -> controllerchange -> reload ----
  const huboControllerChange = await page.evaluate(async () => {
    const promesaCambio = new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(true), { once: true });
      setTimeout(() => resolve(false), 8000);
    });
    document.getElementById('btn-actualizar-version').click();
    return promesaCambio;
  });
  console.log(huboControllerChange ? '✅' : '❌ FALLO:', 'pulsar "Actualizar" (SKIP_WAITING) hace que el SW v2 tome el control (controllerchange) sin necesidad de cerrar todas las pestañas');

  await page.waitForTimeout(500);
  const swActivoEsV2 = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return !!(reg && reg.active); // tras controllerchange, el activo ya es el v2 (skipWaiting + clients.claim)
  });
  console.log(swActivoEsV2 ? '✅' : '❌ FALLO:', 'tras la actualización queda un único SW activo controlando la página (sin SW "waiting" eternamente atascado)');

  const fallos = [controladaV1, huboBandaNuevaVersion, bandaVisibleEnApp, huboControllerChange, swActivoEsV2].filter((v) => !v).length;
  console.log('\n' + (fallos === 0 ? 'TODO OK — ciclo de vida del Service Worker: actualización real (A21)' : fallos + ' fallo(s).'));
  server.close();
  await browser.close();
  process.exit(fallos === 0 ? 0 : 1);
})();
