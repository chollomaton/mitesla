const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push('CONSOLE: ' + msg.text()); });
  await page.goto(urlIndexHtml());
  await page.waitForTimeout(500);
  const tabs = ['dashboard','viajes','cargas','mapa','mas','bateria','economia','estadisticas','ajustes'];
  for(const t of tabs){
    await page.evaluate((v) => mostrar(v), t);
    await page.waitForTimeout(300);
  }
  const datosOk = await page.evaluate(() => {
    // La app arranca vacía de verdad (punto 14.24 de la Fase 2): se añade un viaje de prueba
    // con la misma función real (conTimestamps) que usa el formulario, para comprobar que a
    // cualquier alta nueva se le asignan id/created_at automáticamente.
    DATOS.viajes.push(conTimestamps({ fecha:'2026-01-01', origen:'A', destino:'B', km:10, duracion_min:10 }));
    return {
      schema: DATOS.schema_version, dataset: !!DATOS.dataset_id, device: !!DATOS.device_id,
      tracking: !!DATOS.vehiculo.tracking_started_at, viajeTieneId: !!DATOS.viajes[0].id,
      viajeTieneCreated: !!DATOS.viajes[0].created_at
    };
  });
  console.log(JSON.stringify(datosOk, null, 2));
  console.log('ERRORS:', JSON.stringify(errors));
  await browser.close();
  process.exit(errors.length===0 ? 0 : 1);
})();
