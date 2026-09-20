const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await page.goto(urlIndexHtml());
  await page.waitForTimeout(200);

  const out = await page.evaluate(async () => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }

    // 1) Adaptador: mapea una respuesta realista de la Fleet API de Tesla
    var raw = {
      vin: '5YJ3TEST000000001',
      state: 'online',
      gui_settings: { gui_distance_units: 'km/hr' },
      charge_state: { battery_level: 68, battery_range: 310.4, charging_state: 'Charging', charger_power: 11, charge_energy_added: 12.3, minutes_to_full_charge: 45, charge_limit_soc: 90 },
      drive_state: { shift_state: null, latitude: 43.5, longitude: -5.6 },
      vehicle_state: { odometer: 18500, locked: true, sentry_mode: false, car_version: '2026.32', vehicle_name: 'Mi Model Y' },
      climate_state: { outside_temp: 18, inside_temp: 21 }
    };
    var snap = mapearSnapshotTesla(raw, '2026-09-19T10:00:00.000Z');
    assert(snap.soc === 68, 'SoC mapeado correctamente');
    assert(snap.estimated_range === 310.4, 'autonomía en km sin convertir (cuenta ya en km)');
    assert(snap.odometer === 18500, 'odómetro en km sin convertir');
    assert(snap.charging_state === 'Charging', 'estado de carga mapeado');
    assert(snap.latitude === 43.5 && snap.longitude === -5.6, 'coordenadas mapeadas');
    assert(snap.source === 'tesla', 'source = tesla');

    // conversión de millas: gui en mi/hr
    var rawMillas = Object.assign({}, raw, { gui_settings: { gui_distance_units: 'mi/hr' } });
    var snapMillas = mapearSnapshotTesla(rawMillas, '2026-09-19T10:00:00.000Z');
    assert(Math.abs(snapMillas.estimated_range - 310.4*1.60934) < 0.5, 'autonomía convertida de millas a km cuando la cuenta está en millas');

    // campo ausente -> null, nunca 0 inventado
    var rawIncompleto = { state:'online', charge_state:{}, drive_state:{}, vehicle_state:{}, climate_state:{} };
    var snapIncompleto = mapearSnapshotTesla(rawIncompleto, '2026-09-19T10:00:00.000Z');
    assert(snapIncompleto.soc === null, 'SoC ausente se mapea a null, no a 0');
    assert(snapIncompleto.estimated_range === null, 'autonomía ausente se mapea a null, no a 0');

    // 2) Aplicar al dashboard
    teslaCache.snapshot = snap;
    aplicarSnapshotTeslaEnDashboard();
    var bateriaHtml = document.getElementById('dash-bateria-num').innerHTML;
    assert(bateriaHtml.indexOf('68') !== -1, 'el dashboard muestra el SoC de Tesla (68%)');
    assert(document.getElementById('dash-autonomia').textContent.indexOf('310') !== -1, 'el dashboard muestra la autonomía de Tesla');
    assert(document.getElementById('dash-estado').textContent === 'Cargando', 'el estado del dashboard refleja "Cargando" desde Tesla');
    assert(document.getElementById('dash-fuente-dato').style.display !== 'none', 'se muestra la fuente del dato');
    assert(/Tesla/.test(document.getElementById('dash-fuente-texto').textContent), 'la fuente indica "Tesla"');

    // 3) Sin snapshot: no debe tocar nada (oculta la fila de fuente)
    teslaCache.snapshot = null;
    aplicarSnapshotTeslaEnDashboard();
    assert(document.getElementById('dash-fuente-dato').style.display === 'none', 'sin snapshot, la fila de fuente queda oculta (comportamiento manual intacto)');

    return res;
  });
  out.forEach(l => console.log(l));
  await browser.close();
  process.exit(out.some(l => l.indexOf('FALLO')!==-1) ? 1 : 0);
})();
