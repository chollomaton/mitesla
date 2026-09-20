const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
const http = require('http');
const fs = require('fs');
const path = require('path');
(async () => {
  const browser = await lanzarChromium();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const cspViolations = [];
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));

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
  await page.waitForTimeout(1500);

  // navegar a mapa para forzar carga de leaflet (posible violación CSP)
  await page.evaluate(() => mostrar('mapa'));
  await page.waitForTimeout(1500);

  const violaciones = consoleErrors.filter(e => /Content Security Policy|CSP|Refused to/i.test(e));
  console.log('errores de consola totales:', consoleErrors.length);
  consoleErrors.forEach(e => console.log('  -', e));
  console.log('violaciones CSP:', violaciones.length === 0 ? '✅ ninguna' : '❌ ' + JSON.stringify(violaciones));

  server.close();
  await browser.close();
  process.exit(violaciones.length === 0 ? 0 : 1);
})();
