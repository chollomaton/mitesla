const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
const http = require('http');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await lanzarChromium();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const dir = PROJECT_ROOT;
  const server = http.createServer((req, res) => {
    let p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
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
  await page.waitForTimeout(1000); // esperar a que el SW controle la página

  await page.reload();
  await page.waitForTimeout(500);

  const resp = await page.evaluate(async () => {
    var r = await fetch('/no-existe-esta-imagen.png');
    return { status: r.status, texto: (await r.text()).slice(0,50) };
  });
  console.log('respuesta a un asset inexistente:', JSON.stringify(resp));
  const esHtml = resp.texto.indexOf('<!DOCTYPE') !== -1 || resp.texto.indexOf('<html') !== -1;
  console.log('NO se sirvió el HTML de la app para un asset ausente:', !esHtml ? '✅' : '❌ FALLO');

  server.close();
  await browser.close();
  process.exit(!esHtml ? 0 : 1);
})();
