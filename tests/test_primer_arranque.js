const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await page.goto(urlIndexHtml());
  await page.waitForTimeout(200);
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload();
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/screenshots/primer-arranque-vacio.png' });
  const out = await page.evaluate(() => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }
    var t = document.body.innerText;
    assert(!/NaN/.test(t), 'sin NaN visible en el arranque vacío');
    assert(DATOS.vehiculo.odometro_km === 0, 'odómetro a 0');
    assert(DATOS.viajes.length===0 && DATOS.cargas.length===0 && DATOS.bateria_historico.length===0, 'sin viajes/cargas/batería de ejemplo');
    return res;
  });
  out.forEach(l => console.log(l));
  await browser.close();
  process.exit(out.some(l => l.indexOf('FALLO')!==-1) ? 1 : 0);
})();
