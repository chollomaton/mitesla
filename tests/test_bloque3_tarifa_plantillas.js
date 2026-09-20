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
    var tarifa = { valle:0.10, llano:0.20, punta:0.30 };

    /* ---------- Punto 7: precio medio de una sesión que cruza periodos ---------- */
    // 00:30 a 02:00, íntegramente dentro del tramo valle (00-08h) -> debe ser valle puro
    var pValle = precioMedioSesion('2026-03-02T00:30', '2026-03-02T02:00', tarifa);
    assert(Math.abs(pValle - 0.10) < 0.0001, 'sesión íntegramente en valle da el precio de valle');

    // 07:00 a 09:00 entre semana: 1h valle (0.10) + 1h llano (0.20) -> media 0.15
    var pMixta = precioMedioSesion('2026-03-02T07:00', '2026-03-02T09:00', tarifa); // 2026-03-02 es lunes
    assert(Math.abs(pMixta - 0.15) < 0.0001, 'una sesión que cruza de valle a llano da el precio medio ponderado por tiempo ('+pMixta+')');

    // Sin fin de sesión (o fin <= inicio) cae al precio de una hora concreta, como antes de la Fase 3
    var pSinFin = precioMedioSesion('2026-03-02T07:00', '2026-03-02T07:00', tarifa);
    assert(Math.abs(pSinFin - precioSegunHora('2026-03-02T07:00', tarifa)) < 0.0001, 'sin sesión válida, cae al precio de la hora de inicio (compatibilidad con el comportamiento previo)');

    /* ---------- Punto 6/7/8: guardar una carga con pérdidas y atribución solar ---------- */
    // El flag "solar_tracking" está desactivado por defecto (punto 35) — se activa aquí para
    // poder probar la atribución de origen de energía.
    guardarFeatureFlags(Object.assign(cargarFeatureFlags(), { solar_tracking: true }));

    DATOS.cargas = [];
    guardarDatos(true);
    mostrar('cargas');
    document.getElementById('btn-add-carga').click();
    document.getElementById('fc-fecha').value = '2026-03-02T23:00';
    document.getElementById('fc-lugar').value = 'Casa';
    document.getElementById('fc-tipo').value = 'domestica';
    document.getElementById('fc-kwh').value = '20';
    document.getElementById('fc-precio').value = '0.20';
    document.getElementById('fc-perdidas').value = '10'; // 10% de pérdidas
    document.getElementById('fc-origen-solar').value = '30';
    document.getElementById('fc-origen-bateria').value = '20';
    document.getElementById('form-carga').dispatchEvent(new Event('submit', {cancelable:true}));

    var c = DATOS.cargas[0];
    assert(!!c, 'la carga con pérdidas y origen de energía se ha guardado');
    assert(Math.abs(c.kwh_red_estimado - (20/0.9)) < 0.01, 'con 10% de pérdidas, la energía tomada de la red es mayor que la entregada al coche (22,22 kWh)');
    assert(Math.abs(c.total_cost - (20/0.9)*0.20) < 0.01, 'el coste total se calcula sobre la energía de red (con pérdidas), no sobre la del coche');
    assert(!!c.origen_energia, 'se guarda la atribución de origen de energía');
    assert(c.origen_energia.red_pct === 50, 'red % se deduce de 100 - solar - batería (50%)');
    assert(c.origen_energia.ahorro_frente_a_red > 0, 'se calcula un ahorro frente a red cuando hay solar/batería');

    // Sin pérdidas ni atribución: comportamiento igual que antes de la Fase 3 (no se inventa nada)
    DATOS.cargas = [];
    guardarDatos(true);
    document.getElementById('btn-add-carga').click();
    document.getElementById('fc-fecha').value = '2026-03-02T23:00';
    document.getElementById('fc-lugar').value = 'Casa';
    document.getElementById('fc-tipo').value = 'domestica';
    document.getElementById('fc-kwh').value = '10';
    document.getElementById('fc-precio').value = '0.15';
    document.getElementById('form-carga').dispatchEvent(new Event('submit', {cancelable:true}));
    var c2 = DATOS.cargas[0];
    assert(c2.perdidas_pct === null, 'sin pérdidas indicadas, perdidas_pct queda en null, no en 0 inventado');
    assert(c2.origen_energia === null, 'sin datos de origen, origen_energia queda en null — no se inventa procedencia (punto 8)');
    assert(Math.abs(c2.total_cost - 1.5) < 0.001, 'sin pérdidas, el coste es kwh*precio como antes');

    // Con el flag desactivado de nuevo, aunque los campos del formulario tuvieran algo escrito,
    // no se guarda atribución de origen (punto 35: la función deja de ejecutarse con el flag off).
    guardarFeatureFlags(Object.assign(cargarFeatureFlags(), { solar_tracking: false }));
    DATOS.cargas = [];
    guardarDatos(true);
    document.getElementById('btn-add-carga').click();
    document.getElementById('fc-fecha').value = '2026-03-02T23:00';
    document.getElementById('fc-lugar').value = 'Casa';
    document.getElementById('fc-tipo').value = 'domestica';
    document.getElementById('fc-kwh').value = '10';
    document.getElementById('fc-precio').value = '0.15';
    document.getElementById('fc-origen-solar').value = '50';
    document.getElementById('form-carga').dispatchEvent(new Event('submit', {cancelable:true}));
    assert(DATOS.cargas[0].origen_energia === null, 'con el flag solar_tracking desactivado, no se guarda atribución de origen aunque el campo tuviera un valor');

    /* ---------- Punto 9: plantillas de viajes ---------- */
    DATOS.plantillas_viaje = [];
    DATOS.viajes = [];
    guardarDatos(true);
    mostrar('viajes');
    document.getElementById('btn-add-plantilla').click();
    document.getElementById('fp-origen').value = 'Gijón';
    document.getElementById('fp-destino').value = 'Oviedo FFPA';
    document.getElementById('fp-etiqueta').value = 'trabajo';
    document.getElementById('fp-km').value = '30';
    document.getElementById('form-plantilla').dispatchEvent(new Event('submit', {cancelable:true}));
    assert(DATOS.plantillas_viaje.length === 1, 'la plantilla de viaje se ha guardado');

    var btnUsar = document.querySelector('[data-usar-plantilla]');
    assert(!!btnUsar, 'aparece el botón "Iniciar viaje" para la plantilla');
    btnUsar.click();
    assert(document.getElementById('fv-destino').value === 'Oviedo FFPA', 'usar la plantilla rellena el destino en el formulario de viaje');
    assert(document.getElementById('fv-etiqueta').value === 'trabajo', 'usar la plantilla rellena la etiqueta');
    assert(document.getElementById('fv-km').value === '30', 'usar la plantilla rellena los km aproximados');
    document.getElementById('fv-cancelar').click();

    /* ---------- Punto 10: regla automática de clasificación (propone, no impone) ---------- */
    DATOS.viajes = [
      {id:'r1', fecha:'2026-01-01T08:00', origen:'Gijón', destino:'Oviedo FFPA', km:30, etiqueta:'trabajo', created_at:'2026-01-01T08:00:00.000Z', updated_at:'2026-01-01T08:00:00.000Z'},
      {id:'r2', fecha:'2026-01-02T08:00', origen:'Gijón', destino:'Oviedo FFPA', km:30, etiqueta:'trabajo', created_at:'2026-01-02T08:00:00.000Z', updated_at:'2026-01-02T08:00:00.000Z'},
      {id:'r3', fecha:'2026-01-03T08:00', origen:'Gijón', destino:'Oviedo FFPA', km:30, etiqueta:'trabajo', created_at:'2026-01-03T08:00:00.000Z', updated_at:'2026-01-03T08:00:00.000Z'}
    ];
    guardarDatos(true);
    var sugerida = sugerirEtiquetaViaje('Gijón', 'Oviedo FFPA');
    assert(sugerida === 'trabajo', 'con 3 viajes previos idénticos en etiqueta, se sugiere esa etiqueta');
    var sinDatos = sugerirEtiquetaViaje('Gijón', 'Un sitio nuevo nunca visitado');
    assert(sinDatos === null, 'sin historial suficiente, no se sugiere nada (no se impone una clasificación sin base)');

    editandoViaje = null;
    document.getElementById('btn-add-viaje').click();
    document.getElementById('fv-origen').value = 'Gijón';
    document.getElementById('fv-destino').value = 'Oviedo FFPA';
    document.getElementById('fv-etiqueta').value = 'personal';
    document.getElementById('fv-destino').dispatchEvent(new Event('change'));
    assert(document.getElementById('fv-etiqueta').value === 'trabajo', 'al escribir un destino con historial claro, se rellena la etiqueta sugerida en el propio formulario');
    document.getElementById('fv-cancelar').click();

    return { res: res };
  });

  out.res.forEach(l => console.log(l));
  errors.forEach(e => console.log('❌ ' + e));
  await browser.close();
  process.exit(out.res.some(l => l.startsWith('❌')) || errors.length ? 1 : 0);
})();
