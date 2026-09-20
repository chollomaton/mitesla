const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await page.goto(urlIndexHtml());

  async function irA(vista){
    if(['bateria','economia','estadisticas','ajustes'].includes(vista)){
      await page.evaluate(() => mostrar('mas'));
      await page.waitForTimeout(80);
    }
    await page.evaluate((v) => mostrar(v), vista);
    await page.waitForTimeout(150);
  }

  // Carga
  await irA('cargas');
  await page.click('#btn-add-carga');
  await page.waitForTimeout(100);
  const antesC = await page.evaluate(() => DATOS.cargas.length);
  await page.fill('#fc-fecha', '2026-09-19T10:00');
  await page.fill('#fc-lugar', 'Test lugar');
  await page.fill('#fc-kwh', '20');
  await page.fill('#fc-precio', '0.2');
  await page.click('#fc-guardar');
  await page.waitForTimeout(150);
  const trasC = await page.evaluate(() => DATOS.cargas.length);
  console.log('carga guardada con clic:', trasC === antesC+1 ? '✅' : '❌ FALLO');

  // Gasto
  await irA('cargas'); // gastos view id vista-cargas? comprobar
  const out = await page.evaluate(() => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }
    // localizar la vista de gastos real
    var idVistaGastos = document.querySelector('#form-gasto') ? document.getElementById('form-gasto').closest('.wrap').id : null;
    res.push('vista de gastos: ' + idVistaGastos);
    return res;
  });
  out.forEach(l => console.log(l));

  console.log('ERRORS:', JSON.stringify(errors));
  await browser.close();
  process.exit(errors.length===0 && trasC===antesC+1 ? 0 : 1);
})();
