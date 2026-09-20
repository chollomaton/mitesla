const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push('CONSOLE: ' + msg.text()); });
  await page.goto(urlIndexHtml());
  await page.click('button[data-vista="mas"]');
  await page.waitForTimeout(100);
  await page.click('#lista-mas button[data-vista="ajustes"]');
  await page.waitForTimeout(200);
  await page.click('.zona-peligro summary');
  await page.waitForTimeout(150);
  await page.click('#btn-reiniciar-dispositivo');
  await page.waitForTimeout(200);
  await page.click('#modal-confirmar');
  await page.waitForTimeout(300);
  const viajes = await page.evaluate(() => DATOS.viajes.length);
  const suspendida = await page.evaluate(() => localStorage.getItem('mitesla-sync-suspendida'));
  const datasetId1 = await page.evaluate(() => DATOS.dataset_id);
  console.log('viajes tras reiniciar dispositivo:', viajes, '(esperado 0)');
  console.log('sync suspendida:', suspendida, '(esperado 1)');

  // Ahora probamos "Empezar de cero completamente"
  await page.click('#btn-empezar-cero');
  await page.waitForTimeout(200);
  await page.click('#modal-confirmar');
  await page.waitForTimeout(300);
  const suspendida2 = await page.evaluate(() => localStorage.getItem('mitesla-sync-suspendida'));
  const datasetId2 = await page.evaluate(() => DATOS.dataset_id);
  console.log('sync suspendida tras empezar de cero (esperado null):', suspendida2);
  console.log('dataset_id cambió:', datasetId1 !== datasetId2);

  console.log('ERRORS:', JSON.stringify(errors));
  await browser.close();
})();
