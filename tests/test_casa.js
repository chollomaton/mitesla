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

    assert(lugarCasa() === null, 'sin configurar, lugarCasa() es null (no hay coordenadas por defecto)');
    assert(lugares().length === 0, 'sin casa configurada, lugares() está vacío');

    DATOS.vehiculo.casa = { lat: 40.4, lng: -3.7 };
    assert(lugarCasa() !== null && lugarCasa().lat === 40.4, 'tras configurar casa, lugarCasa() la devuelve');
    assert(lugares().length === 1, 'lugares() incluye la casa configurada');

    // importación maliciosa de vehiculo.casa
    var bruto = { vehiculo: { casa: { lat: 'algo raro', lng: 999 } } };
    var r = sanearImportacion(bruto);
    assert(r.datos.vehiculo.casa === null, 'una casa con lat/lng inválidos en una importación se descarta (no se guarda un valor imposible)');

    var bruto2 = { vehiculo: { casa: { lat: 41.5, lng: 2.1 } } };
    var r2 = sanearImportacion(bruto2);
    assert(r2.datos.vehiculo.casa && r2.datos.vehiculo.casa.lat === 41.5, 'una casa con coordenadas válidas en una importación se conserva');

    return res;
  });
  out.forEach(l => console.log(l));
  const fallos = out.filter(l => l.indexOf('FALLO')!==-1).length;
  console.log('\nTotal fallos:', fallos);
  console.log('PAGE ERRORS:', JSON.stringify(errors));
  await browser.close();
  process.exit(fallos===0 && errors.length===0 ? 0 : 1);
})();
