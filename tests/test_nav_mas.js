const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push('CONSOLE: ' + msg.text()); });
  await page.goto(urlIndexHtml());

  const navCount = await page.$$eval('.nav button', els => els.length);
  console.log('botones en nav inferior:', navCount, '(esperado 5)');

  await page.click('button[data-vista="mas"]');
  await page.waitForTimeout(200);
  const masVisible = await page.evaluate(() => document.getElementById('vista-mas').style.display !== 'none');
  console.log('vista "Más" visible tras click:', masVisible);
  const masActivo = await page.evaluate(() => document.querySelector('.nav button[data-vista="mas"]').classList.contains('on'));
  console.log('botón "Más" marcado como activo:', masActivo);

  await page.click('#lista-mas button[data-vista="bateria"]');
  await page.waitForTimeout(200);
  const bateriaVisible = await page.evaluate(() => document.getElementById('vista-bateria').style.display !== 'none');
  const masSigueActivo = await page.evaluate(() => document.querySelector('.nav button[data-vista="mas"]').getAttribute('aria-current') === 'page');
  console.log('vista batería visible tras entrar desde Más:', bateriaVisible);
  console.log('nav "Más" sigue marcado activo (aria-current) al estar en Batería:', masSigueActivo);

  await page.click('button[data-vista="dashboard"]');
  await page.waitForTimeout(200);
  const dashActivo = await page.evaluate(() => document.querySelector('.nav button[data-vista="dashboard"]').getAttribute('aria-current') === 'page');
  const masInactivo = await page.evaluate(() => document.querySelector('.nav button[data-vista="mas"]').getAttribute('aria-current'));
  console.log('dashboard activo tras volver:', dashActivo, '| Más sin aria-current:', masInactivo);

  console.log('ERRORS:', JSON.stringify(errors));
  await browser.close();
  process.exit(errors.length===0 && navCount===5 && masVisible && masActivo && bateriaVisible && masSigueActivo && dashActivo && !masInactivo ? 0 : 1);
})();
