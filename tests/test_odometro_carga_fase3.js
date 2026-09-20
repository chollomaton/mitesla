const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await page.goto(urlIndexHtml());

  const out = await page.evaluate(() => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }

    /* ---------- Fase 3, punto 5: sincronización de odómetro Tesla ---------- */
    DATOS.vehiculo.odometro_km = 10000;
    delete DATOS.vehiculo.odometro_tesla_actualizado_at;
    delete DATOS.vehiculo.odometro_tesla_anomalia;
    DATOS.vehiculo.odometro_historico_tesla = [];

    sincronizarOdometroTesla({ odometer: 10025, fetched_at: '2026-01-01T10:00:00.000Z' });
    assert(DATOS.vehiculo.odometro_km === 10025, 'un odómetro Tesla mayor se aplica');
    assert(DATOS.vehiculo.odometro_tesla_actualizado_at === '2026-01-01T10:00:00.000Z', 'se guarda la fecha de la lectura Tesla');

    sincronizarOdometroTesla({ odometer: 10010, fetched_at: '2026-01-01T11:00:00.000Z' });
    assert(DATOS.vehiculo.odometro_km === 10025, 'un odómetro Tesla MENOR que el guardado se ignora (nunca se reduce)');

    sincronizarOdometroTesla({ odometer: 10600, fetched_at: '2026-01-01T12:00:00.000Z' });
    assert(DATOS.vehiculo.odometro_km === 10025, 'un salto sospechoso (>500 km) no se aplica automáticamente');
    assert(!!DATOS.vehiculo.odometro_tesla_anomalia, 'el salto sospechoso queda registrado como anomalía');

    sincronizarOdometroTesla({ odometer: 10040, fetched_at: '2026-01-01T13:00:00.000Z' });
    assert(DATOS.vehiculo.odometro_km === 10040, 'una lectura posterior normal sí se aplica');
    assert(DATOS.vehiculo.odometro_tesla_anomalia === null, 'una lectura normal limpia la anomalía anterior');

    sincronizarOdometroTesla({ odometer: null, fetched_at: '2026-01-01T14:00:00.000Z' });
    assert(DATOS.vehiculo.odometro_km === 10040, 'un odómetro null (dato ausente) no toca el valor guardado — null ≠ 0');

    assert(Array.isArray(DATOS.vehiculo.odometro_historico_tesla) && DATOS.vehiculo.odometro_historico_tesla.length >= 3, 'se guarda historial de lecturas Tesla');

    /* ---------- Fase 3, punto 6: modelo de cargas ampliado ---------- */
    DATOS.cargas = [];
    guardarDatos(true);
    mostrar('cargas');
    document.getElementById('btn-add-carga').click();
    document.getElementById('fc-fecha').value = '2026-01-02T10:00';
    document.getElementById('fc-lugar').value = 'Supercharger Oviedo';
    document.getElementById('fc-tipo').value = 'supercharger';
    document.getElementById('fc-kwh').value = '40';
    document.getElementById('fc-precio').value = '0';
    document.getElementById('fc-acdc').value = 'DC';
    document.getElementById('fc-red').value = 'Tesla';
    document.getElementById('fc-potencia').value = '150';
    document.getElementById('fc-coste-origen').value = 'conocido';
    document.getElementById('fc-notas').value = 'Carga de prueba gratuita';
    document.getElementById('form-carga').dispatchEvent(new Event('submit', {cancelable:true}));

    var c = DATOS.cargas[0];
    assert(!!c, 'la carga se ha guardado');
    assert(c.ac_dc === 'DC', 'se guarda el tipo de corriente (AC/DC)');
    assert(c.red === 'Tesla', 'se guarda la red/operador');
    assert(c.potencia_max_kw === 150, 'se guarda la potencia máxima');
    assert(c.total_cost === 0, 'una carga gratuita (0 €/kWh) tiene coste total 0 € real, no un dato ausente');
    assert(c.cost_source === 'conocido', 'se guarda el origen del coste elegido');
    assert(c.data_source === 'manual', 'una carga añadida a mano lleva data_source=manual');
    assert(c.notas === 'Carga de prueba gratuita', 'se guardan las notas');
    assert('vehicle_id' in c, 'la carga lleva el campo vehicle_id (preparación multi-vehículo), aunque sea null sin Tesla conectado');

    // Migración de cargas antiguas sin los campos nuevos: deben rellenarse sin perder nada.
    var cargaVieja = { id:'cold1', fecha:'2020-01-01T10:00', lugar:'Casa', tipo:'domestica', kwh:10, precio_kwh:0.15,
      bateria_inicial:50, bateria_final:70, created_at:'2020-01-01T10:00:00.000Z', updated_at:'2020-01-01T10:00:00.000Z' };
    var migrada = normalizarDatos({ schema_version:1, viajes:[], cargas:[cargaVieja], gastos:[], vehiculo:{odometro_km:0} }).cargas[0];
    assert(migrada.kwh === 10 && migrada.lugar === 'Casa', 'la migración conserva los datos originales de una carga antigua');
    assert(migrada.ac_dc === null, 'una carga antigua sin AC/DC queda en null, no en un valor inventado');
    assert(Math.abs(migrada.total_cost - 1.5) < 0.001, 'a una carga antigua se le calcula total_cost a partir de kwh*precio');
    assert(migrada.cost_source === 'estimado', 'una carga antigua migrada se marca como origen de coste "estimado"');
    assert(migrada.data_source === 'manual', 'una carga antigua migrada se marca como data_source "manual"');

    return { res: res };
  });

  out.res.forEach(l => console.log(l));
  errors.forEach(e => console.log('❌ ' + e));
  await browser.close();
  process.exit(out.res.some(l => l.startsWith('❌')) || errors.length ? 1 : 0);
})();
