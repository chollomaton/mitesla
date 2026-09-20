// B24 (FASE B): al restaurar un elemento de la papelera, su updated_at debe quedar posterior a
// CUALQUIER tumba (tombstone) de borrado que pudiera existir en otro dispositivo ya sincronizado —
// si no, la restauración se pierde en silencio en la siguiente sincronización (el otro dispositivo
// "gana" con su tumba más reciente y el elemento reaparece borrado). Se reproduce el escenario
// multi-dispositivo real usando fusionarDatos(), la misma función que usa la sincronización real.
const { lanzarChromium, urlIndexHtml } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  await page.goto(urlIndexHtml());

  const out = await page.evaluate(async () => {
    var res = [];
    function assert(cond, msg) { res.push((cond ? '✅ ' : '❌ FALLO: ') + msg); }
    function esperar(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

    var estadoOriginal = JSON.parse(JSON.stringify(DATOS));

    try {
      // ---- Escenario ----
      // t0: el viaje X existe en ambos dispositivos (A y B), ya sincronizado.
      var idViaje = 'viaje-multidispositivo-test';
      var viajeOriginal = { id: idViaje, fecha: '2026-09-01T10:00', origen: 'Gijón', destino: 'Oviedo', km: 28, duracion_min: 30, bateria_inicial: 80, bateria_final: 74, created_at: '2026-09-01T10:00:00.000Z', updated_at: '2026-09-01T10:00:00.000Z' };

      // Dispositivo B: nunca se entera de nada más — se queda con el viaje intacto para simular
      // el estado "antes del borrado" que compararemos, y luego con la tumba tras enterarse del borrado.
      var datosDispositivoB_tras_borrado = JSON.parse(JSON.stringify(estadoOriginal));
      datosDispositivoB_tras_borrado.viajes = [];
      datosDispositivoB_tras_borrado.cargas = []; datosDispositivoB_tras_borrado.gastos = []; datosDispositivoB_tras_borrado.recordatorios = [];
      datosDispositivoB_tras_borrado.accesorios = []; datosDispositivoB_tras_borrado.planes = []; datosDispositivoB_tras_borrado.favoritos = [];
      datosDispositivoB_tras_borrado.bateria_historico = []; datosDispositivoB_tras_borrado.plantillas_viaje = [];
      datosDispositivoB_tras_borrado.neumaticos_historico = []; datosDispositivoB_tras_borrado.mantenimiento = []; datosDispositivoB_tras_borrado.documentos = [];

      // Dispositivo A: crea el viaje, luego lo borra (tumba con timestamp t1), simulando que ya
      // sincronizó ese borrado con B (por eso B también lo tiene marcado como borrado).
      DATOS.viajes = [viajeOriginal];
      DATOS._borrados = DATOS._borrados || {};
      DATOS._borrados.viajes = {};
      marcarBorrado('viajes', idViaje); // tumba = ahora (t1), posterior a viajeOriginal.updated_at (2026-09-01)
      var tumbaT1 = DATOS._borrados.viajes[idViaje];
      assert(tumbaT1 > viajeOriginal.updated_at, 'la tumba de borrado (t1) es posterior a la última edición del viaje (t0) — condición necesaria para reproducir el bug');

      // B ya conoce esa misma tumba (se sincronizó antes de que A restaurara nada).
      datosDispositivoB_tras_borrado._borrados = datosDispositivoB_tras_borrado._borrados || {};
      datosDispositivoB_tras_borrado._borrados.viajes = {};
      datosDispositivoB_tras_borrado._borrados.viajes[idViaje] = tumbaT1;

      // A mueve el viaje a su papelera local y lo quita de su colección viva (como hace moverAPapelera/el flujo real de borrado).
      moverAPapelera('viajes', viajeOriginal);
      DATOS.viajes = DATOS.viajes.filter(function(v) { return v.id !== idViaje; });

      // Pasa algo de tiempo real (aunque sea poco) antes de restaurar, para que t2 > t1 de verdad.
      await esperar(20);

      // A restaura el viaje desde su papelera (t2).
      var restaurado = restaurarDePapelera('viajes', idViaje);
      assert(restaurado === true, 'restaurarDePapelera() devuelve true tras restaurar el viaje');
      var viajeRestaurado = DATOS.viajes.find(function(v) { return v.id === idViaje; });
      assert(!!viajeRestaurado, 'el viaje vuelve a estar en DATOS.viajes tras restaurarlo');
      assert(viajeRestaurado.updated_at > tumbaT1, 'B24: tras restaurar, updated_at queda estrictamente posterior a la tumba (t2 > t1) — antes se quedaba en el updated_at original (t0 < t1) y la restauración se perdía en la siguiente sincronización');

      // ---- La prueba real: fusionar con B, que todavía tiene la tumba y NUNCA vio la restauración ----
      var datosA_tras_restaurar = JSON.parse(JSON.stringify(DATOS));
      var fusionado = fusionarDatos(datosDispositivoB_tras_borrado, datosA_tras_restaurar);
      var viajeTrasFusion = fusionado.viajes.find(function(v) { return v.id === idViaje; });
      assert(!!viajeTrasFusion, 'B24: tras fusionar con un dispositivo B que todavía tiene la tumba del borrado, el viaje restaurado SIGUE presente (antes desaparecía de nuevo — la tumba de B "ganaba")');
      assert(!(fusionado._borrados && fusionado._borrados.viajes && fusionado._borrados.viajes[idViaje]), 'tras la fusión, la tumba del viaje ya no existe en el resultado fusionado — el borrado quedó correctamente revertido en todos los dispositivos');

      // ---- Contraprueba: SIN el fix (updated_at original, anterior a la tumba), la fusión pierde la restauración ----
      var viajeSinFix = Object.assign({}, viajeOriginal); // updated_at = t0, ANTERIOR a la tumba t1 (el comportamiento del bug)
      var datosA_bug = JSON.parse(JSON.stringify(estadoOriginal));
      datosA_bug.viajes = [viajeSinFix];
      datosA_bug._borrados = { viajes: {} }; // A ya retiró su propia tumba local al "restaurar" (como hacía el código viejo)
      var fusionConBug = fusionarDatos(datosDispositivoB_tras_borrado, datosA_bug);
      var viajeConBug = fusionConBug.viajes.find(function(v) { return v.id === idViaje; });
      assert(!viajeConBug, 'contraprueba: CON el updated_at antiguo (el comportamiento previo al fix), la fusión SÍ pierde la restauración — confirma que el fix corrige un bug real, no uno inventado');
    } finally {
      DATOS = estadoOriginal;
    }

    return res;
  });
  out.forEach((l) => console.log(l));
  const fallos = out.filter((l) => l.indexOf('FALLO') !== -1).length;
  console.log('\nTotal fallos:', fallos);
  console.log('PAGE ERRORS:', JSON.stringify(errors));
  await browser.close();
  process.exit(fallos === 0 && errors.length === 0 ? 0 : 1);
})();
