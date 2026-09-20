const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
const http = require('http');
const fs = require('fs');
const path = require('path');
(async () => {
  const browser = await lanzarChromium();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const failed404 = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));
  page.on('response', r => { if (r.status() === 404) failed404.push(r.url()); });

  const dir = PROJECT_ROOT;
  const server = http.createServer((req, res) => {
    let p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
    if (p.endsWith('/')) p += 'index.html';
    fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      const ext = path.extname(p);
      const types = {'.html':'text/html','.js':'application/javascript','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.css':'text/css'};
      res.writeHead(200, {'Content-Type': types[ext] || 'application/octet-stream'});
      res.end(data);
    });
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  await page.goto('http://localhost:' + port + '/index.html');
  await page.waitForTimeout(500);

  const vistas = ['dashboard','viajes','cargas','mapa','mas','bateria','economia','estadisticas','ajustes'];
  for (const v of vistas) {
    await page.evaluate((t) => mostrar(t), v);
    await page.waitForTimeout(300);
  }

  // instalar PWA: comprobar manifest válido
  const manifestOk = await page.evaluate(async () => {
    try { const r = await fetch('manifest.webmanifest'); const j = await r.json(); return !!(j.name && j.icons && j.icons.length); }
    catch(e){ return false; }
  });

  console.log('errores de consola tras recorrer todas las vistas:', consoleErrors.length);
  consoleErrors.forEach(e => console.log('  -', e));
  console.log('peticiones 404 propias (excluyendo mapa externo):', failed404.filter(u => !u.includes('tile.openstreetmap')).length);
  failed404.forEach(u => console.log('  -', u));
  console.log('manifest válido:', manifestOk ? '✅' : '❌');

  server.close();
  await browser.close();
  const propios404 = failed404.filter(u => !u.includes('tile.openstreetmap'));
  process.exit(consoleErrors.length===0 && propios404.length===0 && manifestOk ? 0 : 1);
})();
