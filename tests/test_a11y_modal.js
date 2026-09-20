const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await page.goto(urlIndexHtml());
  await page.waitForTimeout(200);

  // La app arranca vacía de verdad (punto 14.24): se siembra un viaje real para tener un botón
  // "Eliminar" con el que probar el modal.
  await page.evaluate(() => {
    DATOS.viajes.push(conTimestamps({ fecha:'2026-01-01', origen:'A', destino:'B', km:10, duracion_min:10 }));
    guardarDatos(true);
    renderViajes();
  });

  // ir a viajes, añadir botón de foco de referencia
  await page.click('button[data-vista="viajes"]');
  await page.waitForTimeout(200);

  const out1 = await page.evaluate(() => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }
    var btn = document.querySelector('.btn-borrar[data-borrar-viaje]');
    assert(btn && btn.tagName === 'BUTTON', 'el botón de eliminar viaje es un <button> real, no un <div>');
    assert(btn && btn.getAttribute('aria-label') === 'Eliminar', 'tiene aria-label="Eliminar"');
    btn.focus();
    confirmarAccion('Prueba', 'Texto de prueba', function(){});
    var caja = document.getElementById('modal-caja');
    assert(caja.getAttribute('role') === 'dialog', 'el modal tiene role="dialog"');
    assert(caja.getAttribute('aria-modal') === 'true', 'aria-modal="true"');
    assert(caja.getAttribute('aria-labelledby') === 'modal-titulo', 'aria-labelledby apunta al título');
    return res;
  });
  out1.forEach(l => console.log(l));
  await page.waitForTimeout(50);
  const outFoco = await page.evaluate(() => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }
    assert(document.activeElement.id === 'modal-cancelar', 'el foco inicial cae en Cancelar (obtenido: '+document.activeElement.id+')');
    return res;
  });
  outFoco.forEach(l => console.log(l));

  // Escape cierra y restaura el foco al botón que abrió el modal
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const out2 = await page.evaluate(() => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }
    assert(!document.getElementById('modal-fondo').classList.contains('on'), 'Escape cierra el modal');
    assert(document.activeElement.classList.contains('btn-borrar'), 'el foco se restaura al botón que abrió el modal');
    return res;
  });
  out2.forEach(l => console.log(l));

  // Focus trap: Tab desde el último elemento vuelve al primero
  await page.evaluate(() => { confirmarAccion('Prueba 2', 'Texto', function(){}); });
  await page.waitForTimeout(50);
  await page.evaluate(() => document.getElementById('modal-confirmar').focus());
  await page.keyboard.press('Tab');
  const out3 = await page.evaluate(() => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }
    assert(document.activeElement.id === 'modal-cancelar', 'Tab desde el último botón (Confirmar) vuelve al primero (Cancelar) — focus trap (obtenido: '+document.activeElement.id+')');
    return res;
  });
  out3.forEach(l => console.log(l));
  await page.keyboard.press('Escape');

  console.log('ERRORS:', JSON.stringify(errors));
  const fallos = [...out1, ...outFoco, ...out2, ...out3].filter(l => l.indexOf('FALLO')!==-1).length;
  console.log('\nTotal fallos:', fallos);
  await browser.close();
  process.exit(fallos===0 && errors.length===0 ? 0 : 1);
})();
