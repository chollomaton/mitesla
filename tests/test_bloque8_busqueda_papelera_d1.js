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

    /* ---------- Punto 28: búsqueda global ---------- */
    DATOS.viajes = [
      { id:'bv1', fecha:'2026-05-01T09:00', origen:'Gijón', destino:'Oviedo', km:30, duracion_min:30, bateria_inicial:80, bateria_final:70, etiqueta:'trabajo', conductor:'Carlos', created_at:'2026-05-01T09:00:00.000Z', updated_at:'2026-05-01T09:00:00.000Z' }
    ];
    DATOS.cargas = [
      { id:'bc1', fecha:'2026-05-01T20:00', lugar:'Supercharger Avilés', tipo:'supercharger', kwh:20, precio_kwh:0.35, bateria_inicial:60, bateria_final:90, created_at:'2026-05-01T20:00:00.000Z', updated_at:'2026-05-01T20:00:00.000Z' }
    ];
    DATOS.gastos = [ { id:'bg1', fecha:'2026-05-02', categoria:'otros', concepto:'Lavado exprés', importe:12 } ];
    DATOS.accesorios = [ { id:'ba1', nombre:'Alfombrillas WeatherTech', categoria:'proteccion', fecha:'2026-01-01', precio:80, meses_garantia:null } ];
    guardarDatos(true);
    renderViajes(); renderCargas(); renderGastos(); renderAccesorios();

    var resultadosOviedo = buscarGlobal('oviedo'); // minúsculas, sin acento -> debe encontrar "Oviedo"
    assert(resultadosOviedo.length === 1 && resultadosOviedo[0].coleccion==='viajes', 'la búsqueda es insensible a mayúsculas y encuentra el viaje por destino');
    var resultadosAvi = buscarGlobal('Aviles'); // sin acento -> debe encontrar "Avilés"
    assert(resultadosAvi.length === 1 && resultadosAvi[0].coleccion==='cargas', 'la búsqueda es insensible a acentos y encuentra la carga por lugar');
    var resultadosLavado = buscarGlobal('lavado');
    assert(resultadosLavado.length === 1 && resultadosLavado[0].coleccion==='gastos', 'la búsqueda encuentra gastos por concepto');
    var resultadosAlfombrillas = buscarGlobal('weathertech');
    assert(resultadosAlfombrillas.length === 1 && resultadosAlfombrillas[0].coleccion==='accesorios', 'la búsqueda encuentra accesorios por nombre');
    assert(buscarGlobal('xyznoexiste123').length === 0, 'una búsqueda sin coincidencias no inventa resultados');
    assert(buscarGlobal('   ').length === 0, 'una búsqueda vacía (solo espacios) no devuelve todo el contenido');

    return { res: res };
  });
  out.res.forEach(l => console.log(l));

  // Interacción real: abrir el modal, escribir, pulsar un resultado y comprobar que navega y resalta la fila.
  await page.click('#btn-busqueda-global');
  await page.fill('#busqueda-global-input', 'Oviedo');
  await page.waitForTimeout(200);
  const count = await page.locator('[data-resultado-busqueda]').count();
  const res2 = [];
  function log2(cond, msg){ res2.push((cond?'✅ ':'❌ FALLO: ')+msg); }
  log2(count === 1, 'el modal de búsqueda muestra exactamente el resultado esperado para "Oviedo"');
  await page.click('[data-resultado-busqueda="0"]');
  await page.waitForTimeout(400);
  const modalCerrado = await page.evaluate(() => !document.getElementById('busqueda-global-fondo').classList.contains('on'));
  log2(modalCerrado, 'seleccionar un resultado cierra el modal de búsqueda');
  const vistaViajesVisible = await page.locator('#vista-viajes').isVisible();
  log2(vistaViajesVisible, 'seleccionar un resultado de un viaje navega a la vista de Viajes');
  const resaltado = await page.locator('.fila-resaltada').count();
  log2(resaltado === 1, 'la fila encontrada se resalta brevemente para localizarla');

  // Escape cierra el modal y devuelve el foco.
  await page.click('#btn-busqueda-global');
  await page.keyboard.press('Escape');
  const cerradoEscape = await page.evaluate(() => !document.getElementById('busqueda-global-fondo').classList.contains('on'));
  log2(cerradoEscape, 'Escape cierra el modal de búsqueda global');
  res2.forEach(l => console.log(l));

  /* ---------- Punto 29: papelera con deshacer ---------- */
  const out3 = await page.evaluate(() => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }

    DATOS.gastos = [ { id:'pg1', fecha:'2026-05-02', categoria:'otros', concepto:'Test papelera', importe:33 } ];
    guardarDatos(true);
    mostrar('economia');
    renderGastos();
    var fila = document.querySelector('[data-borrar-gasto="pg1"]').closest('.fila');
    fila.querySelector('[data-borrar-gasto]').click();
    // confirmarAccion abre un modal — confirmamos.
    document.getElementById('modal-confirmar').click();
    assert(DATOS.gastos.length === 0, 'al confirmar la eliminación, el gasto desaparece de la colección activa');
    var papelera = cargarPapelera();
    assert(papelera.some(function(p){ return p.coleccion==='gastos' && p.id==='pg1'; }), 'el gasto eliminado queda guardado en la papelera, no se pierde');
    assert(DATOS._borrados && DATOS._borrados.gastos && DATOS._borrados.gastos.pg1, 'se sigue registrando la tumba para la sincronización, como antes de esta fase');

    // Deshacer desde el toast.
    var restaurado = restaurarDePapelera('gastos', 'pg1');
    assert(restaurado === true, 'restaurarDePapelera() devuelve true cuando restaura correctamente');
    assert(DATOS.gastos.length === 1 && DATOS.gastos[0].concepto==='Test papelera', 'el gasto vuelve a la colección activa con sus datos intactos');
    assert(!(DATOS._borrados.gastos && DATOS._borrados.gastos.pg1), 'al restaurar, se retira la tumba (para no perderlo de nuevo al sincronizar)');
    assert(!cargarPapelera().some(function(p){ return p.coleccion==='gastos' && p.id==='pg1'; }), 'tras restaurar, ya no queda en la papelera');
    var restauradoDeNuevo = restaurarDePapelera('gastos', 'pg1');
    assert(restauradoDeNuevo === false, 'restaurar un elemento que ya no está en la papelera no hace nada (evita duplicados)');

    // Purga por caducidad: una entrada de hace 40 días debe desaparecer sola.
    guardarPapelera([{ id:'viejo1', coleccion:'gastos', item:{id:'viejo1', concepto:'Antiguo', importe:1}, borrado_en: new Date(Date.now()-40*86400000).toISOString() }]);
    var trasPurga = purgarPapeleraCaducada();
    assert(trasPurga.length === 0, 'una entrada de la papelera con más de 30 días se purga automáticamente');

    // Documentos: el archivo en IndexedDB no se borra mientras esté en la papelera (solo al purgar o eliminar definitivamente).
    return { res: res };
  });
  out3.res.forEach(l => console.log(l));

  // Papelera + Deshacer real desde la UI (toast).
  const out4 = await page.evaluate(() => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }
    DATOS.gastos = [ { id:'ug1', fecha:'2026-05-03', categoria:'otros', concepto:'Deshacer desde toast', importe:9 } ];
    guardarDatos(true);
    renderGastos();
    document.querySelector('[data-borrar-gasto="ug1"]').click();
    document.getElementById('modal-confirmar').click();
    assert(DATOS.gastos.length === 0, 'el gasto se elimina de la colección tras confirmar');
    var btnDeshacer = document.getElementById('toast-accion');
    assert(btnDeshacer.style.display !== 'none', 'tras eliminar, el toast muestra el botón "Deshacer"');
    btnDeshacer.click();
    assert(DATOS.gastos.length === 1 && DATOS.gastos[0].id==='ug1', 'pulsar "Deshacer" en el toast restaura el elemento eliminado');
    return { res: res };
  });
  out4.res.forEach(l => console.log(l));

  // Vista de Papelera en Ajustes.
  const out5 = await page.evaluate(() => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }
    DATOS.gastos = [];
    var item = { id:'vp1', fecha:'2026-05-04', categoria:'otros', concepto:'Visible en papelera', importe:5 };
    marcarBorrado('gastos', 'vp1');
    moverAPapelera('gastos', item);
    registrarCambio('gastos', 'eliminar', textoResumenCambio('gastos', item));
    guardarDatos();
    mostrar('ajustes');
    renderPapelera();
    var html = document.getElementById('lista-papelera').innerHTML;
    assert(html.indexOf('Visible en papelera')!==-1, 'la papelera de Ajustes muestra los elementos eliminados recientes');
    assert(html.indexOf('Restaurar')!==-1, 'cada elemento de la papelera tiene un botón para restaurarlo');
    document.querySelector('[data-restaurar-papelera="gastos|vp1"]').click();
    assert(DATOS.gastos.some(function(g){ return g.id==='vp1'; }), 'restaurar desde la vista de Papelera devuelve el elemento a su colección');

    /* ---------- Punto 30: historial de cambios ---------- */
    var historial = cargarHistorialCambios();
    assert(historial.length > 0, 'las creaciones/ediciones/eliminaciones/restauraciones quedan en el historial de cambios');
    assert(historial[0].accion === 'restaurar', 'la restauración que se acaba de hacer aparece como el cambio más reciente');
    renderHistorialCambios();
    var htmlHist = document.getElementById('lista-historial-cambios').innerHTML;
    assert(htmlHist.indexOf('Restaurado')!==-1, 'el historial de cambios se pinta en Ajustes con la acción realizada');

    /* ---------- Punto 31: aviso de copia de seguridad desactualizada ---------- */
    localStorage.removeItem('mitesla-ultima-backup');
    renderAvisoBackup();
    var avisoNunca = document.getElementById('aviso-backup-antiguo').innerHTML;
    assert(avisoNunca.indexOf('Todavía no has descargado')!==-1, 'sin ninguna copia de seguridad descargada, se avisa con claridad');
    localStorage.setItem('mitesla-ultima-backup', new Date(Date.now()-40*86400000).toISOString());
    renderAvisoBackup();
    var avisoAntiguo = document.getElementById('aviso-backup-antiguo').innerHTML;
    assert(avisoAntiguo.indexOf('hace 40 días')!==-1, 'con una copia de más de 30 días, se avisa con el número de días exacto');
    localStorage.setItem('mitesla-ultima-backup', new Date().toISOString());
    renderAvisoBackup();
    var avisoReciente = document.getElementById('aviso-backup-antiguo').innerHTML;
    assert(avisoReciente === '', 'con una copia reciente (hoy), no se muestra ningún aviso');

    return { res: res };
  });
  out5.res.forEach(l => console.log(l));

  /* ---------- Punto 32: D1 — feature flag apagado por defecto, sin infraestructura simulada ---------- */
  const out6 = await page.evaluate(() => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }
    var flags = cargarFeatureFlags();
    assert(flags.d1_sync === false, 'el flag "d1_sync" está desactivado por defecto');
    mostrar('ajustes');
    renderAjustes();
    var secD1 = document.getElementById('sec-d1-sync');
    assert(secD1.style.display === 'none', 'con el flag desactivado, la sección de sincronización D1 no se muestra en Ajustes');
    guardarFeatureFlags(Object.assign(cargarFeatureFlags(), { d1_sync: true }));
    aplicarVisibilidadFeatureFlags();
    assert(secD1.style.display !== 'none', 'al activar el flag, la sección de sincronización D1 aparece en Ajustes');
    return { res: res };
  });
  out6.res.forEach(l => console.log(l));

  // probarConexionD1() con el flag activo pero sin backend real accesible desde este test (file://):
  // debe fallar con un mensaje claro, nunca simular una conexión correcta.
  const out7 = await page.evaluate(async () => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }
    await probarConexionD1();
    var texto = document.getElementById('d1-estado').textContent;
    assert(texto.indexOf('No se pudo contactar')!==-1 || texto.indexOf('Error del servidor')!==-1 || texto.indexOf('binding D1')!==-1 || texto.indexOf('clave de administración')!==-1, 'sin un backend D1 real desplegado ni clave configurada, "Probar conexión" informa de un fallo real, nunca de un éxito simulado: "'+texto+'"');
    return { res: res };
  });
  out7.res.forEach(l => console.log(l));

  errors.forEach(e => console.log('❌ ' + e));
  const allRes = out.res.concat(res2, out3.res, out4.res, out5.res, out6.res, out7.res);
  await browser.close();
  process.exit(allRes.some(l => l.startsWith('❌')) || errors.length ? 1 : 0);
})();
