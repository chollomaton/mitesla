const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(urlIndexHtml());
  await page.waitForTimeout(300);

  const out = [];
  function assert(cond, msg){ out.push((cond?'✅ ':'❌ FALLO: ')+msg); }

  const navOculto = await page.evaluate(() => getComputedStyle(document.querySelector('.nav')).display === 'none');
  assert(navOculto, 'el nav inferior móvil está oculto en escritorio');
  const sidebarVisible = await page.evaluate(() => getComputedStyle(document.querySelector('.nav-escritorio')).display !== 'none');
  assert(sidebarVisible, 'la barra lateral de escritorio está visible');

  await page.click('.nav-escritorio button[data-vista="bateria"]');
  await page.waitForTimeout(100);
  const bateriaVisible = await page.evaluate(() => getComputedStyle(document.getElementById('vista-bateria')).display !== 'none');
  assert(bateriaVisible, 'clic en "Batería" de la barra lateral muestra la vista de batería');
  const bateriaActiva = await page.evaluate(() => document.querySelector('.nav-escritorio button[data-vista="bateria"]').classList.contains('on'));
  assert(bateriaActiva, 'el botón "Batería" de la barra lateral queda resaltado como activo');

  await page.click('.nav-escritorio button[data-vista="viajes"]');
  await page.waitForTimeout(100);
  const viajesVisible = await page.evaluate(() => getComputedStyle(document.getElementById('vista-viajes')).display !== 'none');
  assert(viajesVisible, 'clic en "Viajes" de la barra lateral muestra la vista de viajes');

  out.forEach(l => console.log(l));
  console.log('ERRORS:', JSON.stringify(errors));
  await browser.close();
  process.exit(out.some(l=>l.indexOf('FALLO')!==-1) || errors.length ? 1 : 0);
})();
