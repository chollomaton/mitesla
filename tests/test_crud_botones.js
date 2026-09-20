const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('dialog', d => d.dismiss()); // por si algo dispara un confirm nativo, no debería
  await page.goto(urlIndexHtml());
  await page.waitForTimeout(200);
  // La app arranca vacía de verdad (punto 14.24): se siembra un viaje real para poder
  // duplicarlo/borrarlo.
  await page.evaluate(() => {
    DATOS.viajes.push(conTimestamps({ fecha:'2026-01-01', origen:'A', destino:'B', km:10, duracion_min:10 }));
    guardarDatos(true);
    renderViajes();
  });
  await page.click('button[data-vista="viajes"]');
  await page.waitForTimeout(200);

  const antes = await page.evaluate(() => DATOS.viajes.length);
  await page.click('.btn-duplicar[data-duplicar-viaje]');
  await page.waitForTimeout(150);
  await page.click('#fv-guardar'); // duplicar abre el formulario relleno; hay que guardar para crear la copia
  await page.waitForTimeout(150);
  const tras = await page.evaluate(() => DATOS.viajes.length);
  console.log('viajes antes/después de duplicar:', antes, tras, tras === antes+1 ? '✅' : '❌ FALLO');

  await page.click('.btn-borrar[data-borrar-viaje]');
  await page.waitForTimeout(150);
  await page.click('#modal-confirmar');
  await page.waitForTimeout(150);
  const final = await page.evaluate(() => DATOS.viajes.length);
  console.log('viajes tras borrar:', final, final === tras-1 ? '✅' : '❌ FALLO');

  console.log('ERRORS:', JSON.stringify(errors));
  await browser.close();
  process.exit(errors.length===0 && tras===antes+1 && final===tras-1 ? 0 : 1);
})();
