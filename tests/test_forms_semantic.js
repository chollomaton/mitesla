const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await page.goto(urlIndexHtml());

  const out = await page.evaluate(() => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }
    ['form-viaje','form-carga','form-gasto','form-bateria','form-recordatorio','form-neumatico','form-accesorio'].forEach(function(id){
      var f = document.getElementById(id);
      assert(f.tagName === 'FORM', id+' es un <form> real');
    });
    return res;
  });
  out.forEach(l => console.log(l));

  // Enter nativo en el formulario de viajes: crea el viaje sin recargar la página
  await page.click('button[data-vista="viajes"]');
  await page.waitForTimeout(150);
  await page.click('#btn-add-viaje');
  await page.waitForTimeout(150);
  const antes = await page.evaluate(() => DATOS.viajes.length);
  await page.fill('#fv-fecha', '2026-09-19T10:00');
  await page.fill('#fv-origen', 'Test Origen');
  await page.fill('#fv-destino', 'Test Destino');
  await page.fill('#fv-km', '12.5');
  await page.focus('#fv-km');
  await page.keyboard.press('Enter'); // submit nativo del <form>, no clic
  await page.waitForTimeout(200);
  const tras = await page.evaluate(() => DATOS.viajes.length);
  console.log('Enter nativo crea el viaje:', tras === antes+1 ? '✅' : '❌ FALLO ('+antes+' -> '+tras+')');
  const urlIntacta = page.url().indexOf('index.html') !== -1 && page.url().indexOf('?') === -1;
  console.log('la página no se recargó / no cambió de URL con el submit:', urlIntacta ? '✅' : '❌ FALLO');

  // Enter con campos obligatorios vacíos: no debe crear un viaje corrupto ni petar
  await page.click('#btn-add-viaje');
  await page.waitForTimeout(150);
  const antes2 = await page.evaluate(() => DATOS.viajes.length);
  await page.fill('#fv-km', '5');
  await page.focus('#fv-km');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const tras2 = await page.evaluate(() => DATOS.viajes.length);
  console.log('Enter con fecha/origen/destino vacíos NO crea el viaje (validación JS sigue aplicando):', tras2 === antes2 ? '✅' : '❌ FALLO');

  console.log('ERRORS:', JSON.stringify(errors));
  const fallos = out.filter(l => l.indexOf('FALLO')!==-1).length;
  await browser.close();
  process.exit(fallos===0 && errors.length===0 && tras===antes+1 && urlIntacta && tras2===antes2 ? 0 : 1);
})();
