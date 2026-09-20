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

    assert(typeof DATOS.vehiculo.tracking_started_at === 'string', 'tracking_started_at se rellena automáticamente al normalizar datos');
    assert(typeof DATOS.vehiculo.odometer_at_tracking_start === 'number', 'odometer_at_tracking_start se rellena automáticamente');

    // Simular un coche con muchos km históricos pero seguimiento activado recientemente
    DATOS.vehiculo.odometro_km = 100000;
    DATOS.vehiculo.odometer_at_tracking_start = 99000; // el seguimiento empezó con el coche ya a 99.000 km
    assert(kmSeguimiento() === 1000, 'kmSeguimiento() solo cuenta los km desde que se activó el seguimiento, no los 100.000 históricos (obtenido: '+kmSeguimiento()+')');

    // Migración de un dataset viejo (v1, sin el campo) no debe fallar ni inventar un tracking_started_at absurdo
    var viejo = { vehiculo: { modelo:'Model 3', capacidad_nominal_kwh:60, autonomia_wltp_km:400, odometro_km: 50000, estado:'aparcado' }, viajes:[], cargas:[], gastos:[] };
    var migrado = normalizarDatos(viejo);
    assert(migrado.vehiculo.odometer_at_tracking_start === 50000, 'al migrar un dataset viejo, el punto de partida del seguimiento se fija al odómetro actual en ese momento (no a 0)');

    return res;
  });
  out.forEach(l => console.log(l));
  const fallos = out.filter(l => l.indexOf('FALLO')!==-1).length;
  console.log('\nTotal fallos:', fallos);
  console.log('PAGE ERRORS:', JSON.stringify(errors));
  await browser.close();
  process.exit(fallos===0 && errors.length===0 ? 0 : 1);
})();
