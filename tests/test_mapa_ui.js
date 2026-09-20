const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push('CONSOLE: ' + msg.text()); });
  await page.goto(urlIndexHtml());
  await page.click('button[data-vista="mapa"]');
  await page.waitForTimeout(1500);
  const casaEnMapa = await page.evaluate(() => typeof mapaLeaflet !== 'undefined' && mapaLeaflet !== null);
  console.log('mapa inicializado sin casa configurada:', casaEnMapa);
  console.log('ERRORS:', JSON.stringify(errors));
  await browser.close();
  process.exit(errors.length===0 ? 0 : 1);
})();
