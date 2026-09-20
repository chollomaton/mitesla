const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await page.goto(urlIndexHtml());
  await page.waitForTimeout(300);
  const out = await page.evaluate(async () => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }
    DATOS.vehiculo.casa = { lat: 43.5, lng: -5.6 };
    // forzar que fetch falle para simular API caída
    var origFetch = window.fetch;
    window.fetch = function(){ return Promise.reject(new Error('network down')); };
    climaCargado = false;
    await cargarClimaYAjustarAutonomia();
    var cont = document.getElementById('tarjeta-clima');
    assert(cont.style.display !== 'none', 'la tarjeta de clima sigue visible tras el fallo (no se oculta en silencio)');
    assert(/No se pudo obtener/.test(cont.innerHTML), 'muestra un mensaje de error explícito');
    assert(!!document.getElementById('btn-reintentar-clima'), 'ofrece un botón de reintentar');
    window.fetch = origFetch;
    return res;
  });
  out.forEach(l => console.log(l));
  await browser.close();
  process.exit(out.some(l=>l.indexOf('FALLO')!==-1) ? 1 : 0);
})();
