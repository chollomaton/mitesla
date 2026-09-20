const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await page.goto(urlIndexHtml());

  const out = await page.evaluate(() => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }
    DATOS.viajes = [];
    var s = statsViajes();
    assert(s.media === null && s.mejor === null && s.peor === null && s.velMedia === null, 'statsViajes con 0 viajes devuelve null en todos los campos');
    try {
      renderEstadisticas();
      assert(true, 'renderEstadisticas() no lanza excepción con 0 viajes');
    } catch(e) {
      assert(false, 'renderEstadisticas() lanzó: '+e.message);
    }
    try {
      renderDashboard();
      assert(true, 'renderDashboard() no lanza excepción con 0 viajes');
    } catch(e) {
      assert(false, 'renderDashboard() lanzó: '+e.message);
    }
    var consumoTxt = document.getElementById('stats-consumo').innerHTML;
    assert(consumoTxt.indexOf('Datos insuficientes')!==-1, 'la tarjeta de consumo muestra "Datos insuficientes" en vez de NaN');
    assert(consumoTxt.indexOf('NaN')===-1, 'no aparece NaN en la tarjeta de consumo');
    var dashTxt = document.getElementById('dash-metricas').innerHTML;
    assert(dashTxt.indexOf('NaN')===-1, 'no aparece NaN en dash-metricas');
    return res;
  });
  out.forEach(l => console.log(l));
  const fallos = out.filter(l => l.indexOf('FALLO')!==-1).length;
  console.log('\nTotal fallos:', fallos);
  console.log('PAGE ERRORS:', JSON.stringify(errors));
  await browser.close();
  process.exit(fallos===0 && errors.length===0 ? 0 : 1);
})();
