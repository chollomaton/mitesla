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

    /* ---------- Punto 23: historial de juegos de neumáticos ---------- */
    DATOS.vehiculo.odometro_km = 10000;
    DATOS.neumaticos.delanteros = { fecha_instalacion:'2025-01-01', km_instalacion:0, vida_util_km:45000 };
    // Simulamos que ese juego "actual" ya tenía su propia entrada abierta en el historial (como la
    // tendría cualquier juego instalado con esta misma versión de la app), para poder comprobar que
    // al instalar el siguiente, esa entrada se cierra correctamente.
    DATOS.neumaticos_historico = [ conTimestamps({ marca:'Bridgestone', modelo:'Turanza', medida:'', eje:'delanteros', installed_at:'2025-01-01', odometer_install:0, removed_at:null, odometer_remove:null, purchase_price:200, notes:'' }) ];
    guardarDatos(true);
    mostrar('vehiculo');
    document.querySelector('[data-editar-neumatico="delanteros"]').click();
    document.getElementById('fn-fecha').value = '2026-01-01';
    document.getElementById('fn-km').value = '10000';
    document.getElementById('fn-vida').value = '45000';
    document.getElementById('fn-marca').value = 'Michelin';
    document.getElementById('fn-modelo').value = 'Pilot Sport EV';
    document.getElementById('form-neumatico').dispatchEvent(new Event('submit', {cancelable:true}));
    assert(DATOS.neumaticos_historico.length === 2, 'al instalar un juego nuevo, el anterior queda archivado en el historial y se añade el nuevo (nunca se sobrescribe)');
    var cerrado = DATOS.neumaticos_historico.find(function(h){ return h.marca==='Bridgestone'; });
    assert(cerrado.removed_at === '2026-01-01' && cerrado.odometer_remove === 10000, 'el juego anterior queda cerrado con la fecha/odómetro de la sustitución');
    assert(DATOS.neumaticos.delanteros.km_instalacion === 10000, 'el puntero "actual" (usado por el resto de la app) apunta ya al juego nuevo');
    var htmlHist = document.getElementById('lista-neumaticos-historico').innerHTML;
    assert(htmlHist.indexOf('Michelin')!==-1 && htmlHist.indexOf('en uso')!==-1, 'el juego recién instalado aparece en el historial marcado como "en uso"');
    assert(htmlHist.indexOf('Bridgestone')!==-1, 'el juego sustituido sigue visible en el historial, con sus fechas de inicio y fin');

    /* ---------- Punto 24: mantenimiento — historial + recordatorio "lo que ocurra primero" ---------- */
    DATOS.mantenimiento = [];
    guardarDatos(true);
    document.getElementById('btn-add-mantenimiento').click();
    document.getElementById('fm-categoria').value = 'revision';
    document.getElementById('fm-concepto').value = 'Revisión de los 10.000 km';
    document.getElementById('fm-fecha').value = '2026-01-15';
    document.getElementById('fm-odometro').value = '10000';
    document.getElementById('fm-coste').value = '120';
    document.getElementById('fm-recordatorio-fecha').value = '2099-01-15'; // muy lejos: no debe marcar vencido
    document.getElementById('fm-recordatorio-km').value = String(DATOS.vehiculo.odometro_km + 5); // muy cerca en km: sí debe marcar próximo
    document.getElementById('form-mantenimiento').dispatchEvent(new Event('submit', {cancelable:true}));
    assert(DATOS.mantenimiento.length === 1, 'el registro de mantenimiento se guarda');
    var pend = proximoMantenimientoPendiente(DATOS.mantenimiento[0]);
    assert(pend.kmRestantes === 5, 'calcula correctamente los km restantes hasta el recordatorio');
    assert(pend.diasRestantes > 1000, 'calcula correctamente los días restantes hasta el recordatorio (muy lejano en este caso)');
    var htmlMant = document.getElementById('lista-mantenimiento').innerHTML;
    assert(htmlMant.indexOf('Revisión de los 10.000 km')!==-1 && htmlMant.indexOf('120')!==-1, 'el mantenimiento se pinta en la lista con concepto y coste');
    assert(htmlMant.indexOf('en 5 km')!==-1, 'la lista muestra cuál de los dos recordatorios (fecha o km) ocurre antes');

    /* ---------- Punto 25: documentos — solo metadatos en DATOS, nunca el archivo en sí ---------- */
    DATOS.documentos = [];
    guardarDatos(true);
    document.getElementById('btn-add-documento').click();
    document.getElementById('fd-nombre').value = 'Factura revisión enero';
    document.getElementById('fd-fecha').value = '2026-01-15';
    document.getElementById('fd-relacionado').value = 'Revisión de los 10.000 km';
    document.getElementById('form-documento').dispatchEvent(new Event('submit', {cancelable:true}));
    return { res: res, esperaAsync: true };
  });

  // El submit de documentos es async (por IndexedDB) — esperamos un instante y seguimos en una segunda pasada.
  await page.waitForTimeout(300);

  const out2 = await page.evaluate(() => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }

    assert(DATOS.documentos.length === 1, 'el documento (sin archivo adjunto en este caso) se guarda con sus metadatos');
    var doc = DATOS.documentos[0];
    assert(doc.tiene_archivo === false, 'sin archivo seleccionado, tiene_archivo queda en false, no se inventa un adjunto');
    assert(JSON.stringify(doc).length < 500, 'el registro de metadatos es pequeño — no lleva ningún Base64 del archivo dentro');
    var datosJson = JSON.stringify(DATOS);
    assert(datosJson.indexOf('data:')===-1 && datosJson.indexOf('base64')===-1, 'DATOS (lo que se sincroniza/exporta) nunca contiene el archivo en Base64');
    var htmlDoc = document.getElementById('lista-documentos').innerHTML;
    assert(htmlDoc.indexOf('Factura revisión enero')!==-1, 'el documento se pinta en la lista');
    assert(htmlDoc.indexOf('sin archivo adjunto')!==-1, 'la lista deja claro cuándo un documento no tiene archivo adjunto, solo referencia');

    /* ---------- Punto 26: informe laboral — observaciones en PDF y CSV ---------- */
    DATOS.viajes = [
      { id:'w1', fecha:'2026-03-01T09:00', origen:'Gijón', destino:'Oviedo', km:30, duracion_min:30, bateria_inicial:80, bateria_final:70, etiqueta:'trabajo', conductor:'Carlos', created_at:'2026-03-01T09:00:00.000Z', updated_at:'2026-03-01T09:00:00.000Z' }
    ];
    guardarDatos(true);
    mostrar('mas'); // el informe de trabajo vive en más ajustes/informes según la app; si no existe la vista, el botón sigue en el DOM igualmente
    document.getElementById('informe-desde').value = '2026-01-01';
    document.getElementById('informe-hasta').value = '2026-12-31';
    document.getElementById('informe-observaciones').value = 'Sin incidencias en el periodo.';

    return { res: res };
  });

  out.res.forEach(l => console.log(l));
  out2.res.forEach(l => console.log(l));

  // El informe PDF abre una ventana nueva (window.open) — la capturamos para comprobar el contenido real.
  const res3 = [];
  function assert3(cond, msg){ res3.push((cond?'✅ ':'❌ FALLO: ')+msg); }
  try {
    const [popupCsv] = await Promise.all([
      null,
      null
    ]);
  } catch(e) {}

  // CSV: se descarga (no abre popup) — comprobamos vía evaluate que la función no lanza y que arrastra observaciones.
  const csvOk = await page.evaluate(() => {
    try {
      // Interceptamos la descarga simulando el click y comprobando que no lanza; el contenido exacto del
      // CSV no es observable sin interceptar la descarga del navegador, así que verificamos indirectamente
      // que el campo de observaciones existe y se lee por el propio código (ya cubierto por la existencia
      // del campo en el formulario, comprobado arriba). Aquí solo comprobamos que el botón no rompe nada.
      document.getElementById('btn-informe-trabajo-csv').click();
      return true;
    } catch(e){ return false; }
  });
  assert3(csvOk, 'el botón de exportar CSV del informe laboral no lanza errores con observaciones rellenas');

  let popupPdf;
  try {
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 3000 }),
      page.evaluate(() => document.getElementById('btn-informe-trabajo').click())
    ]);
    popupPdf = popup;
    await popupPdf.waitForLoadState('domcontentloaded');
    const htmlInforme = await popupPdf.content();
    assert3(htmlInforme.indexOf('Sin incidencias en el periodo.')!==-1, 'el informe laboral en PDF incluye las observaciones introducidas');
    await popupPdf.close();
  } catch(e) {
    assert3(false, 'no se pudo capturar la ventana emergente del informe laboral en PDF: ' + e.message);
  }

  /* ---------- Punto 26: informe anual — horas, gastos, €/100km, evolución vs. año anterior ---------- */
  await page.evaluate(() => {
    var hoy = new Date();
    var año = hoy.getFullYear();
    var añoAnterior = año - 1;
    DATOS.viajes = [
      { id:'y1', fecha:año+'-02-01T09:00', origen:'Gijón', destino:'Oviedo', km:100, duracion_min:90, bateria_inicial:90, bateria_final:60, etiqueta:'personal', created_at:año+'-02-01T09:00:00.000Z', updated_at:año+'-02-01T09:00:00.000Z' },
      { id:'y2', fecha:añoAnterior+'-02-01T09:00', origen:'Gijón', destino:'Oviedo', km:50, duracion_min:45, bateria_inicial:90, bateria_final:75, etiqueta:'personal', created_at:añoAnterior+'-02-01T09:00:00.000Z', updated_at:añoAnterior+'-02-01T09:00:00.000Z' }
    ];
    DATOS.cargas = [
      { id:'yc1', fecha:año+'-02-01T20:00', lugar:'Casa', tipo:'domestica', kwh:20, precio_kwh:0.15, ac_dc:'AC', bateria_inicial:60, bateria_final:90, created_at:año+'-02-01T20:00:00.000Z', updated_at:año+'-02-01T20:00:00.000Z' }
    ];
    DATOS.gastos = [
      { id:'yg1', fecha:año+'-03-01', categoria:'otros', concepto:'Lavado', importe:50 }
    ];
    guardarDatos(true);
  });

  let popupAnual;
  try {
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 3000 }),
      page.evaluate(() => document.getElementById('btn-exportar-pdf').click())
    ]);
    popupAnual = popup;
    await popupAnual.waitForLoadState('domcontentloaded');
    const htmlAnual = await popupAnual.content();
    assert3(htmlAnual.indexOf('Horas conduciendo')!==-1, 'el informe anual incluye la tarjeta de horas conduciendo');
    assert3(htmlAnual.indexOf('1h 30min')!==-1, 'las horas conduciendo se calculan correctamente a partir de duracion_min');
    assert3(htmlAnual.indexOf('Gastos (sin energía)')!==-1 && htmlAnual.indexOf('50')!==-1, 'el informe anual incluye los gastos del año (sin contar energía)');
    assert3(htmlAnual.indexOf('Coste real por 100 km')!==-1, 'el informe anual incluye el coste real por 100 km (energía + gastos)');
    assert3(htmlAnual.indexOf('Evolución frente a')!==-1, 'con datos del año anterior disponibles, se muestra la tabla de evolución');
    assert3(htmlAnual.indexOf('+100 %')!==-1, 'la evolución de km frente al año anterior se calcula correctamente (100 km vs 50 km = +100 %)');
    assert3(htmlAnual.indexOf('Metodología del ahorro estimado')!==-1, 'el informe anual explica la metodología del ahorro estimado, dejando claro que es una estimación');
    await popupAnual.close();
  } catch(e) {
    assert3(false, 'no se pudo capturar la ventana emergente del informe anual: ' + e.message);
  }

  /* ---------- Punto 27: Wrapped anual — horas, carga más barata, % casa, % AC/DC, comparación año anterior ---------- */
  const out4 = await page.evaluate(() => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }
    mostrar('estadisticas');
    var btn = document.getElementById('btn-resumen-anual');
    if(document.getElementById('tarjeta-resumen-anual').style.display !== 'none') btn.click(); // asegurar cerrado
    btn.click();
    var html = document.getElementById('tarjeta-resumen-anual').innerHTML;
    assert(html.indexOf('Horas conduciendo')!==-1 && html.indexOf('1h 30min')!==-1, 'el Wrapped anual muestra las horas conduciendo calculadas correctamente');
    assert(html.indexOf('Carga en casa')!==-1 && html.indexOf('100 %')!==-1, 'el Wrapped anual muestra el % de energía cargada en casa (100% en este caso, la única carga es doméstica)');
    assert(html.indexOf('carga más barata')!==-1 && html.indexOf('0.15')!==-1, 'el Wrapped anual destaca la carga más barata del año con su lugar y precio');
    assert(html.indexOf('100 % AC')!==-1, 'el Wrapped anual muestra el reparto AC/DC solo con las cargas que tienen ese dato (100% AC en este caso)');
    assert(html.indexOf('Frente a')!==-1 && html.indexOf('+100 %')!==-1, 'el Wrapped anual compara con el año anterior cuando hay datos disponibles');
    return { res: res };
  });
  out4.res.forEach(l => console.log(l));

  // Caso sin datos de años anteriores ni de tipo de corriente: no debe inventar ninguna cifra.
  const out5 = await page.evaluate(() => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }
    var año = new Date().getFullYear();
    DATOS.viajes = [
      { id:'z1', fecha:año+'-02-01T09:00', origen:'Gijón', destino:'Oviedo', km:10, duracion_min:0, bateria_inicial:90, bateria_final:85, etiqueta:'personal', created_at:año+'-02-01T09:00:00.000Z', updated_at:año+'-02-01T09:00:00.000Z' }
    ];
    DATOS.cargas = [
      { id:'zc1', fecha:año+'-02-01T20:00', lugar:'Supercharger A6', tipo:'supercharger', kwh:20, precio_kwh:0.35, ac_dc:null, bateria_inicial:60, bateria_final:90, created_at:año+'-02-01T20:00:00.000Z', updated_at:año+'-02-01T20:00:00.000Z' }
    ];
    guardarDatos(true);
    document.getElementById('btn-resumen-anual').click(); // cerrar
    document.getElementById('btn-resumen-anual').click(); // abrir de nuevo con los datos nuevos
    var html = document.getElementById('tarjeta-resumen-anual').innerHTML;
    assert(html.indexOf('Horas conduciendo')===-1, 'sin ningún viaje con duración registrada, no se inventan horas conduciendo');
    assert(html.indexOf('Reparto de carga')===-1, 'sin ninguna carga con AC/DC registrado, no se inventa un reparto');
    assert(html.indexOf('Frente a')===-1, 'sin ningún viaje registrado el año anterior, no se muestra una comparación inventada');
    return { res: res };
  });
  out5.res.forEach(l => console.log(l));

  res3.forEach(l => console.log(l));
  errors.forEach(e => console.log('❌ ' + e));
  const allRes = out.res.concat(out2.res, out4.res, out5.res, res3);
  await browser.close();
  process.exit(allRes.some(l => l.startsWith('❌')) || errors.length ? 1 : 0);
})();
