// Fase 4E — panel "Automatización" en Ajustes: visibilidad por flag, mensaje honesto sin VIN
// conectado, carga real de salud/pendientes/alertas (con fetch simulado, sin red real) y las
// acciones de resolver un pendiente / descartar una alerta actualizando la UI de verdad.
const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await page.goto(urlIndexHtml());

  /* ---------- Visibilidad por flag ---------- */
  const out1 = await page.evaluate(() => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }
    mostrar('ajustes');
    renderAjustes();
    var sec = document.getElementById('sec-automatizacion');
    assert(sec.style.display === 'none', 'con "fleet_telemetry" desactivado (por defecto), la sección Automatización no se muestra');
    guardarFeatureFlags(Object.assign(cargarFeatureFlags(), { fleet_telemetry: true }));
    aplicarVisibilidadFeatureFlags();
    assert(sec.style.display !== 'none', 'al activar el flag, la sección Automatización aparece en Ajustes');
    return { res: res };
  });
  out1.res.forEach(l => console.log(l));

  /* ---------- Sin VIN conocido: mensaje honesto, ninguna llamada de red ---------- */
  const out2 = await page.evaluate(async () => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }
    var llamadas = 0;
    var fetchOriginal = window.fetch;
    window.fetch = function(){ llamadas++; return fetchOriginal.apply(window, arguments); };
    DATOS.vehiculo = DATOS.vehiculo || {};
    DATOS.vehiculo.tesla_vin = null;
    await cargarAutomatizacion();
    window.fetch = fetchOriginal;
    assert(llamadas === 0, 'sin VIN conocido, no se hace ninguna llamada de red (nunca finge comprobar algo que no puede)');
    assert(document.getElementById('auto-estado').textContent.indexOf('Conecta primero tu Tesla') !== -1, 'el mensaje explica exactamente qué falta, en vez de un error genérico');
    return { res: res };
  });
  out2.res.forEach(l => console.log(l));

  /* ---------- Con VIN y backend simulado: salud, pendientes y alertas reales en la UI ---------- */
  const out3 = await page.evaluate(async () => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }

    DATOS.vehiculo.tesla_vin = '5YJ3E1EA1PF000001';
    guardarConfigTesla({ backendUrl: 'https://api.prueba.local', adminKey: 'clave-de-prueba' });

    var pendientesSimulados = [
      { id: 'pend-1', tipo: 'clasificar_viaje', referencia_tabla: 'trips', referencia_id: 'trip-1', detalle: { started_at: '2026-09-20T08:00:00.000Z', distance_km: 12 } },
      { id: 'pend-2', tipo: 'precio_carga', referencia_tabla: 'charging_sessions', referencia_id: 'carga-1', detalle: { started_at: '2026-09-20T22:00:00.000Z', energy_kwh: 14.2 } }
    ];
    var alertasSimuladas = [ { id: 'alert-1', rule: 'silencio_telemetria', severity: 'accion', mensaje: 'Sin datos desde hace 8 horas.' } ];
    var llamadasResolver = [];

    var fetchOriginal = window.fetch;
    window.fetch = function(url, opts){
      if(String(url).indexOf('/internal/health')!==-1) return Promise.resolve({ ok:true, status:200, json: async () => ({ d1_configurado:true, secreto_bridge_configurado:true, sync_state:{eventos_recibidos_mes:5}, minutos_desde_ultimo_evento:3, posible_problema:false }) });
      if(String(url).indexOf('/pendientes/resolver')!==-1){ llamadasResolver.push(JSON.parse(opts.body)); return Promise.resolve({ ok:true, status:200, json: async () => ({ ok:true }) }); }
      if(String(url).indexOf('/pendientes')!==-1) return Promise.resolve({ ok:true, status:200, json: async () => ({ pendientes: llamadasResolver.length ? pendientesSimulados.filter(p=>p.id!==llamadasResolver[0].id) : pendientesSimulados }) });
      if(String(url).indexOf('/alertas')!==-1) return Promise.resolve({ ok:true, status:200, json: async () => ({ alertas: alertasSimuladas }) });
      return fetchOriginal.apply(window, arguments);
    };

    await cargarAutomatizacion();
    assert(document.getElementById('auto-estado').textContent.indexOf('Funcionando') !== -1, 'con telemetría reciente y sin problemas, el estado dice "Funcionando"');
    var listaPend = document.getElementById('lista-pendientes-auto').textContent;
    assert(listaPend.indexOf('sin clasificar') !== -1 && listaPend.indexOf('sin precio') !== -1, 'los dos pendientes simulados (viaje y carga) se muestran de verdad en la UI');
    var listaAlert = document.getElementById('lista-alertas-auto').textContent;
    assert(listaAlert.indexOf('Sin datos desde hace 8 horas') !== -1, 'la alerta simulada se muestra con su mensaje real');

    // Resolver el pendiente de clasificar viaje pulsando "Trabajo" -> debe llamar a /pendientes/resolver con el id y la clasificación correctos.
    var btn = document.querySelector('.btn-resolver-viaje[data-clase="trabajo"]');
    assert(!!btn, 'el botón "Trabajo" del pendiente de clasificar viaje existe en el DOM');
    btn.click();
    await new Promise(r => setTimeout(r, 50));
    assert(llamadasResolver.length === 1 && llamadasResolver[0].id === 'pend-1' && llamadasResolver[0].resuelto_con.classification === 'trabajo', 'pulsar "Trabajo" llama a /pendientes/resolver con el id correcto y classification:"trabajo"');

    window.fetch = fetchOriginal;
    return { res: res };
  });
  out3.res.forEach(l => console.log(l));

  errors.forEach(e => console.log('❌ ' + e));
  const allRes = out1.res.concat(out2.res, out3.res);
  await browser.close();
  process.exit(allRes.some(l => l.startsWith('❌')) || errors.length ? 1 : 0);
})();
