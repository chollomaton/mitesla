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

    /* ---------- Punto 20: centro de calidad de datos ---------- */
    DATOS.viajes = [
      { id:'v1', fecha:'2026-01-01T10:00', origen:'A', destino:'B', km:10, bateria_inicial:80, bateria_final:70, etiqueta:'personal', created_at:'2026-01-01T10:00:00.000Z', updated_at:'2026-01-01T10:00:00.000Z' },
      { id:'v2', fecha:'2026-01-02T10:00', origen:'A', destino:'B', km:10, bateria_inicial:null, bateria_final:null, etiqueta:'personal', created_at:'2026-01-02T10:00:00.000Z', updated_at:'2026-01-02T10:00:00.000Z' }
    ];
    DATOS.cargas = [
      { id:'c1', fecha:'2026-01-01T10:00', lugar:'Supercharger', tipo:'supercharger', kwh:20, precio_kwh:0, bateria_inicial:50, bateria_final:80, created_at:'2026-01-01T10:00:00.000Z', updated_at:'2026-01-01T10:00:00.000Z' }
    ];
    guardarDatos(true);
    var calidad = calcularCalidadDatos();
    assert(calidad.avisos.some(function(m){ return m.indexOf('1 de 2 viajes')!==-1; }), 'detecta viajes sin % de batería y los cuenta correctamente');
    assert(calidad.avisos.some(function(m){ return m.indexOf('carga(s) con precio 0')!==-1; }), 'detecta cargas con precio 0 €/kWh');
    assert(calidad.recomendaciones.length > 0, 'incluye recomendaciones (sync/backup/Tesla) aunque no haya fallos ni avisos graves');

    mostrar('estadisticas');
    renderEstadisticas();
    var htmlCalidad = document.getElementById('stats-calidad-datos').innerHTML;
    assert(htmlCalidad.indexOf('Aviso')!==-1, 'el centro de calidad de datos se pinta en la vista de Estadísticas');

    /* ---------- Punto 21: analítica de consumo por periodo, sin mezclar rangos ---------- */
    var hoy = new Date();
    function hace(dias){ var d = new Date(hoy.getTime()-dias*86400000); return d.toISOString().slice(0,16); }
    DATOS.viajes = [
      { id:'r1', fecha:hace(3),  origen:'A', destino:'B', km:20, bateria_inicial:80, bateria_final:70, etiqueta:'trabajo', created_at:hace(3)+':00.000Z', updated_at:hace(3)+':00.000Z' },
      { id:'r2', fecha:hace(5),  origen:'A', destino:'B', km:20, bateria_inicial:80, bateria_final:68, etiqueta:'trabajo', created_at:hace(5)+':00.000Z', updated_at:hace(5)+':00.000Z' },
      { id:'r3', fecha:hace(50), origen:'A', destino:'B', km:20, bateria_inicial:80, bateria_final:75, etiqueta:'personal', created_at:hace(50)+':00.000Z', updated_at:hace(50)+':00.000Z' }
    ];
    guardarDatos(true);
    var c7 = consumoMedioUltimosDias(7);
    var c90 = consumoMedioUltimosDias(90);
    assert(c7 !== null && c90 !== null, 'consumoMedioUltimosDias() calcula un valor con viajes en el rango');
    assert(c7 !== c90, 'un periodo de 7 días y uno de 90 días dan resultados distintos cuando hay viajes fuera de los 7 días (no se mezclan rangos)');

    document.querySelector('[data-periodo-analitica="7"]').click();
    var htmlAnalitica = document.getElementById('stats-analitica-consumo').innerHTML;
    assert(htmlAnalitica.indexOf('7 días')!==-1, 'la analítica de consumo respeta el periodo seleccionado (7 días)');
    assert(htmlAnalitica.indexOf('Trabajo')!==-1, 'la analítica desglosa por tipo de viaje (etiqueta)');
    document.querySelector('[data-periodo-analitica="30"]').click();

    /* ---------- Punto 22: detección de anomalías — correlación, nunca causalidad afirmada ---------- */
    // Sin diferencia real entre periodos: no debe reportar ninguna anomalía.
    DATOS.viajes = [
      { id:'a1', fecha:hace(2), origen:'A', destino:'B', km:20, bateria_inicial:80, bateria_final:70, etiqueta:'personal', created_at:hace(2)+':00.000Z', updated_at:hace(2)+':00.000Z' },
      { id:'a2', fecha:hace(60), origen:'A', destino:'B', km:20, bateria_inicial:80, bateria_final:70, etiqueta:'personal', created_at:hace(60)+':00.000Z', updated_at:hace(60)+':00.000Z' }
    ];
    guardarDatos(true);
    var sinAnomalia = detectarAnomaliasConsumo();
    assert(sinAnomalia.length === 0, 'sin variación real de consumo, no se reporta ninguna anomalía');

    // Con una diferencia grande y consistente entre el periodo reciente y el de referencia, sí debe detectarla.
    DATOS.viajes = [
      { id:'b1', fecha:hace(2), origen:'A', destino:'B', km:20, bateria_inicial:90, bateria_final:60, etiqueta:'personal', created_at:hace(2)+':00.000Z', updated_at:hace(2)+':00.000Z' }, // consumo alto reciente
      { id:'b2', fecha:hace(60), origen:'A', destino:'B', km:20, bateria_inicial:90, bateria_final:85, etiqueta:'personal', created_at:hace(60)+':00.000Z', updated_at:hace(60)+':00.000Z' } // consumo bajo de referencia
    ];
    guardarDatos(true);
    var conAnomalia = detectarAnomaliasConsumo();
    assert(conAnomalia.length === 1, 'con una diferencia grande y sostenida de consumo, sí se detecta una anomalía');
    assert(conAnomalia[0].mensaje.indexOf('%')!==-1, 'el mensaje de la anomalía incluye el porcentaje de variación');
    assert(conAnomalia[0].mensaje.indexOf(' es la causa')===-1 && conAnomalia[0].mensaje.toLowerCase().indexOf('porque')===-1, 'el mensaje no afirma una causa, solo describe la variación');

    mostrar('estadisticas');
    renderEstadisticas();
    var seccionAnomalias = document.getElementById('sec-anomalias');
    assert(seccionAnomalias.style.display !== 'none', 'con anomalías detectadas, la sección se muestra en Estadísticas');
    var htmlAnom = document.getElementById('stats-anomalias').innerHTML;
    assert(htmlAnom.indexOf('no se afirma que sean la causa')!==-1 || htmlAnom.indexOf('Sin variables adicionales')!==-1, 'la UI nunca afirma una causa: o lista variables relacionadas aclarando que no son necesariamente la causa, o dice que no hay variables adicionales que lo expliquen');

    return { res: res };
  });

  out.res.forEach(l => console.log(l));
  errors.forEach(e => console.log('❌ ' + e));
  await browser.close();
  process.exit(out.res.some(l => l.startsWith('❌')) || errors.length ? 1 : 0);
})();
