const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  // servir el directorio por http (los SW no funcionan en file://)
  const http = require('http');
  const fs = require('fs');
  const path = require('path');
  const dir = PROJECT_ROOT;
  const server = http.createServer((req, res) => {
    let p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
    if(p.endsWith('/')) p += 'index.html';
    fs.readFile(p, (err, data) => {
      if(err){ res.writeHead(404); res.end('not found'); return; }
      const ext = path.extname(p);
      const types = {'.html':'text/html','.js':'application/javascript','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png'};
      res.writeHead(200, {'Content-Type': types[ext] || 'application/octet-stream'});
      res.end(data);
    });
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  await page.goto('http://localhost:'+port+'/index.html');
  await page.waitForTimeout(500);

  const out = await page.evaluate(async () => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }
    await new Promise(r => setTimeout(r, 800));
    var reg = await navigator.serviceWorker.getRegistration();
    assert(!!reg, 'el service worker se registra correctamente');
    assert(typeof showAppNotification === 'function', 'showAppNotification existe');
    return res;
  });
  out.forEach(l => console.log(l));

  // offline
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.waitForTimeout(150);
  const bandaVisible = await page.evaluate(() => document.getElementById('banda-offline').style.display !== 'none');
  console.log('banda offline visible al perder conexión:', bandaVisible ? '✅' : '❌ FALLO');
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(150);
  const bandaOculta = await page.evaluate(() => document.getElementById('banda-offline').style.display === 'none');
  console.log('banda offline se oculta al recuperar conexión:', bandaOculta ? '✅' : '❌ FALLO');

  // recarga offline: la app sigue cargando desde caché (app shell)
  await page.close();
  const page2 = await context.newPage();
  await context.setOffline(true);
  let cargoOffline = true;
  try{
    await page2.goto('http://localhost:'+port+'/index.html', { timeout: 5000 });
    const titulo = await page2.title();
    cargoOffline = titulo.length > 0;
  }catch(e){ cargoOffline = false; console.log('error al cargar offline:', e.message); }
  console.log('segunda carga offline funciona (app shell cacheada):', cargoOffline ? '✅' : '❌ FALLO');

  console.log('ERRORS:', JSON.stringify(errors));
  const fallos = out.filter(l => l.indexOf('FALLO')!==-1).length;
  server.close();
  await browser.close();
  process.exit(fallos===0 && bandaVisible && bandaOculta && cargoOffline ? 0 : 1);
})();
