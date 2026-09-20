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

    // referencia_gasolina: edición más reciente gana el merge, no "local siempre gana"
    var local = JSON.parse(JSON.stringify(DATOS));
    local.referencia_gasolina = { consumo_l_100km: 8, precio_litro: 1.9, updated_at: '2020-01-01T00:00:00.000Z' };
    var remoto = JSON.parse(JSON.stringify(DATOS));
    remoto.referencia_gasolina = { consumo_l_100km: 6, precio_litro: 1.4, updated_at: '2030-01-01T00:00:00.000Z' };
    var fusion = fusionarDatos(remoto, local);
    assert(fusion.referencia_gasolina.consumo_l_100km === 6, 'referencia_gasolina: gana la versión con updated_at más reciente, no la local por defecto');

    // seguro / itv / neumaticos: idem
    local.seguro = { fecha_renovacion:'2027-01-01', updated_at:'2020-01-01T00:00:00.000Z' };
    remoto.seguro = { fecha_renovacion:'2028-06-01', updated_at:'2030-01-01T00:00:00.000Z' };
    var fusion2 = fusionarDatos(remoto, local);
    assert(fusion2.seguro.fecha_renovacion === '2028-06-01', 'seguro: gana la versión remota más reciente');

    // el guardado real desde el formulario estampa updated_at (no se queda a 0000-00-00)
    document.getElementById('veh-modelo') && (function(){})();
    var antes = DATOS.referencia_gasolina.updated_at;
    document.getElementById('ref-consumo').value = '6.5';
    document.getElementById('ref-consumo').dispatchEvent(new Event('change'));
    assert(DATOS.referencia_gasolina.updated_at && DATOS.referencia_gasolina.updated_at !== antes, 'guardar la referencia de gasolina actualiza su updated_at');

    // importación de neumáticos reales no se descarta silenciosamente
    var bruto = { neumaticos: { delanteros:{fecha_instalacion:'2026-01-01',km_instalacion:1000,vida_util_km:50000}, traseros:{fecha_instalacion:'2026-01-01',km_instalacion:1000,vida_util_km:48000} } };
    var r = sanearImportacion(bruto);
    assert(r.datos.neumaticos.delanteros.vida_util_km === 50000, 'importar neumáticos reales conserva sus datos (antes se descartaban y se sustituían por el SEED)');

    return res;
  });
  out.forEach(l => console.log(l));
  const fallos = out.filter(l => l.indexOf('FALLO')!==-1).length;
  console.log('\nTotal fallos:', fallos);
  console.log('PAGE ERRORS:', JSON.stringify(errors));
  await browser.close();
  process.exit(fallos===0 && errors.length===0 ? 0 : 1);
})();
