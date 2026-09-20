const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await page.goto(urlIndexHtml());
  await page.waitForTimeout(300);
  const out = await page.evaluate(() => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }
    assert(typeof ASSUMPTIONS === 'object' && ASSUMPTIONS.reservaLlegadaPct.valor === 15, 'ASSUMPTIONS existe y reservaLlegadaPct=15');
    // registrar un viaje con datos de batería para tener carga actual
    document.getElementById('fv-fecha') && (document.getElementById('fv-fecha').value = '2026-01-01');
    // simular carga actual conocida a través de nivelCargaActual() forzando un registro directo
    DATOS.bateria_historico.push({id:'t1', fecha:'2026-01-01', capacidad_pct:98});
    DATOS.cargas.push({id:'t2', fecha:'2026-01-02', lugar:'Casa', kwh:10, precio_kwh:0.15, bateria_inicial:50, bateria_final:80, tipo:'domestica'});
    mostrar('estadisticas'); // fuerza a estar en un DOM con la calculadora "¿Llego?"
    document.getElementById('llego-km').value = '300';
    document.getElementById('llego-calcular').click();
    var html = document.getElementById('llego-resultado').innerHTML;
    assert(html.length > 0, 'la calculadora produce un resultado con datos reales');
    assert(/%/.test(html), 'el resultado incluye un porcentaje de llegada');
    return res;
  });
  out.forEach(l => console.log(l));
  await browser.close();
  process.exit(out.some(l=>l.indexOf('FALLO')!==-1) ? 1 : 0);
})();
