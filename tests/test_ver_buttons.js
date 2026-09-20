const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await page.goto(urlIndexHtml());
  await page.click('button[data-vista="viajes"]');
  await page.waitForTimeout(150);
  const tag = await page.$eval('#btn-add-viaje', el => el.tagName);
  console.log('#btn-add-viaje es', tag, tag==='BUTTON'?'✅':'❌ FALLO');
  await page.click('#btn-add-viaje');
  await page.waitForTimeout(150);
  const visible = await page.evaluate(() => !document.getElementById('form-viaje').classList.contains('form-oculto'));
  console.log('el formulario se abre al pulsar "+ Añadir":', visible ? '✅' : '❌ FALLO');

  // Dashboard "Ver todos"
  await page.click('button[data-vista="dashboard"]');
  await page.waitForTimeout(150);
  await page.click('[data-goto="viajes"]');
  await page.waitForTimeout(150);
  const enViajes = await page.evaluate(() => document.getElementById('vista-viajes').style.display !== 'none');
  console.log('"Ver todos" navega a Viajes:', enViajes ? '✅' : '❌ FALLO');

  console.log('ERRORS:', JSON.stringify(errors));
  await browser.close();
  process.exit(errors.length===0 && tag==='BUTTON' && visible && enViajes ? 0 : 1);
})();
