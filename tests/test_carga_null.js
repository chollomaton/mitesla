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
    DATOS.cargas = [];
    assert(nivelCargaActual() === null, 'nivelCargaActual() es null cuando no hay ningún viaje/carga con % de batería');

    try { renderDashboard(); assert(true, 'renderDashboard() no lanza excepción con carga actual desconocida'); }
    catch(e){ assert(false, 'renderDashboard() lanzó: '+e.message); }

    var dashBat = document.getElementById('dash-bateria-num').innerHTML;
    assert(dashBat.indexOf('null')===-1, 'dash-bateria-num no muestra "null"');
    assert(dashBat.indexOf('—')!==-1, 'dash-bateria-num muestra el guion de "sin datos"');

    var dashAuto = document.getElementById('dash-autonomia').textContent;
    assert(dashAuto.indexOf('NaN')===-1, 'dash-autonomia no muestra NaN');

    // simular un viaje con bateria_final=null (dejado en blanco por el usuario) igualmente no debe ser tomado como 0
    DATOS.viajes = [{ id:'vtest', fecha:'2026-01-01T10:00', origen:'A', destino:'B', km:10, bateria_inicial:null, bateria_final:null }];
    assert(nivelCargaActual() === null, 'un viaje sin datos de batería no cuenta como evento de carga (no se confunde con 0%)');

    // Un viaje con datos reales sí debe funcionar
    DATOS.viajes = [{ id:'vtest2', fecha:'2026-01-01T10:00', origen:'A', destino:'B', km:10, bateria_inicial:80, bateria_final:70 }];
    assert(nivelCargaActual() === 70, 'un viaje con datos reales de batería sí se usa como nivel de carga actual');

    return res;
  });
  out.forEach(l => console.log(l));
  const fallos = out.filter(l => l.indexOf('FALLO')!==-1).length;
  console.log('\nTotal fallos:', fallos);
  console.log('PAGE ERRORS:', JSON.stringify(errors));
  await browser.close();
  process.exit(fallos===0 && errors.length===0 ? 0 : 1);
})();
