// FASE B — "NORMA SOBRE DATOS INVENTADOS": null ≠ 0, desconocido ≠ estimado, estimado ≠ medido.
// Cubre B10 (consumoViaje), B21 (precioMedioKwh) y B22 (euros), los tres bugs concretos señalados
// explícitamente en el encargo donde una ausencia de dato se convertía en un número fabricado.
const { lanzarChromium, urlIndexHtml } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  await page.goto(urlIndexHtml());

  const out = await page.evaluate(() => {
    var res = [];
    function assert(cond, msg) { res.push((cond ? '✅ ' : '❌ FALLO: ') + msg); }

    // ---- B22: euros() ----
    assert(euros(null) === '—', 'euros(null) -> "—" (nunca "0,00 €", null no es lo mismo que un coste real de cero)');
    assert(euros(undefined) === '—', 'euros(undefined) -> "—"');
    assert(euros(NaN) === '—', 'euros(NaN) -> "—" (un cálculo inválido tampoco es un coste real de cero)');
    assert(euros(0) === '0,00 €', 'euros(0) -> "0,00 €" (un cero real SÍ se muestra como cero, se distingue de null)');
    assert(euros(12.5) === '12,50 €', 'euros(12.5) -> "12,50 €" (un importe real se formatea igual que siempre)');

    // ---- B10: consumoViaje() ----
    var vSinFinal = { bateria_inicial: 80, bateria_final: null, km: 50 };
    assert(consumoViaje(vSinFinal) === null, 'consumoViaje con bateria_final=null -> null (antes "80 - null" se evaluaba a 80, un consumo FABRICADO)');

    var vSinInicial = { bateria_inicial: undefined, bateria_final: 40, km: 50 };
    assert(consumoViaje(vSinInicial) === null, 'consumoViaje con bateria_inicial=undefined -> null');

    var vKmCero = { bateria_inicial: 80, bateria_final: 40, km: 0 };
    assert(consumoViaje(vKmCero) === null, 'consumoViaje con km=0 -> null (no un 0 kWh/100km inventado)');

    var vFueraDeRango = { bateria_inicial: 150, bateria_final: 40, km: 50 };
    assert(consumoViaje(vFueraDeRango) === null, 'consumoViaje con bateria_inicial fuera de 0..100 -> null');

    var vValido = { bateria_inicial: 80, bateria_final: 40, km: 100 };
    var capacidadOriginal = DATOS.vehiculo.capacidad_nominal_kwh;
    DATOS.vehiculo.capacidad_nominal_kwh = 75;
    var c = consumoViaje(vValido);
    assert(Math.abs(c - 30) < 0.001, 'consumoViaje con datos completos calcula el consumo real: (80-40)/100*75kWh / 100km * 100 = 30 kWh/100km, obtenido: ' + c);
    DATOS.vehiculo.capacidad_nominal_kwh = capacidadOriginal;

    // ---- B21: precioMedioKwh() / precioMedioKwhParaEstimaciones() ----
    var cargasOriginales = DATOS.cargas;
    DATOS.cargas = [];
    assert(precioMedioKwh() === null, 'precioMedioKwh() sin ninguna carga registrada -> null (antes devolvía 0.18 como si fuera un precio medido real)');
    assert(precioMedioKwhParaEstimaciones() === ASSUMPTIONS.defaultForecastPriceKwh.valor, 'precioMedioKwhParaEstimaciones() sin cargas cae en el supuesto ETIQUETADO ASSUMPTIONS.defaultForecastPriceKwh, nunca en un número sin explicar');

    DATOS.cargas = [
      { kwh: 10, precio_kwh: 0.20 },
      { kwh: 30, precio_kwh: 0.10 }
    ];
    var precioReal = precioMedioKwh();
    assert(Math.abs(precioReal - 0.125) < 0.0001, 'precioMedioKwh() con cargas reales calcula la media ponderada real (10*0.20+30*0.10)/40=0.125, obtenido: ' + precioReal);
    assert(Math.abs(precioMedioKwhParaEstimaciones() - precioReal) < 0.0001, 'con cargas reales, precioMedioKwhParaEstimaciones() usa el precio real medido, no el supuesto');
    DATOS.cargas = cargasOriginales;

    // ---- B23: costeCarga() / resumenCosteCargas() / sumaCosteConocido() — nunca sumar cargas de
    // coste desconocido como 0 € ----
    assert(costeCarga({ kwh: 10, precio_kwh: 0.20 }) === 2, 'costeCarga: con kwh y precio_kwh válidos, calcula el coste real (10*0.20=2)');
    assert(costeCarga({ kwh: 10, precio_kwh: 0.20, total_cost: 3.5 }) === 3.5, 'costeCarga: si total_cost ya es un número válido, manda sobre kwh*precio_kwh (p.ej. una factura real distinta al cálculo)');
    assert(costeCarga({ kwh: 10, precio_kwh: null }) === null, 'costeCarga: sin precio_kwh conocido y sin total_cost, devuelve null (nunca 0€ fabricado) — este es el caso de una carga importada sin precio, o (cuando B6 conecte D1) una sesión de Supercharger sin factura reconciliada');
    assert(costeCarga({ kwh: 10, precio_kwh: undefined, total_cost: null }) === null, 'costeCarga: total_cost=null explícito tampoco se confunde con "sin definir" — sigue siendo null');
    assert(costeCarga({ kwh: 5, precio_kwh: 0 }) === 0, 'costeCarga: un precio real de 0 €/kWh (carga gratis) SÍ da un coste de 0, se distingue de "desconocido"');

    var cargasCoste = [
      { kwh: 10, precio_kwh: 0.20 },     // coste conocido: 2€
      { kwh: 20, precio_kwh: null },      // coste DESCONOCIDO — no debe sumar como 0€
      { kwh: 5,  precio_kwh: 0.10 }       // coste conocido: 0.5€
    ];
    var resumen = resumenCosteCargas(cargasCoste);
    assert(Math.abs(resumen.costeConocido - 2.5) < 0.0001, 'resumenCosteCargas: suma SOLO las cargas de coste conocido (2 + 0.5 = 2.5), la de coste desconocido queda fuera del total en vez de contar como 0€, obtenido: ' + resumen.costeConocido);
    assert(resumen.nConocidas === 2 && resumen.nDesconocidas === 1 && resumen.total === 3, 'resumenCosteCargas: informa la cobertura real (2 conocidas, 1 desconocida, 3 en total) para poder mostrarla en vez de un total que parece completo sin estarlo');
    assert(Math.abs(sumaCosteConocido(cargasCoste) - 2.5) < 0.0001, 'sumaCosteConocido: atajo equivalente a resumenCosteCargas(...).costeConocido');

    var resumenTodoDesconocido = resumenCosteCargas([{ kwh: 10, precio_kwh: null }]);
    assert(resumenTodoDesconocido.costeConocido === null, 'resumenCosteCargas: si TODAS las cargas tienen coste desconocido, el total es null (nunca "0,00 €", que parecería un coste real de cero)');

    var resumenSinCargas = resumenCosteCargas([]);
    assert(resumenSinCargas.costeConocido === 0, 'resumenCosteCargas: sin ninguna carga en absoluto, el total SÍ es un 0 real (no hay nada que sumar, no es un dato ausente)');

    // ---- B23: sanearImportacion() (el saneado real de "Importar datos (.json)") no fabrica un
    // precio de 0 €/kWh para una carga importada sin precio ----
    var resultadoImport = sanearImportacion({ cargas: [
      { id: 'c-import-1', fecha: '2026-09-01', lugar: 'Importada sin precio', kwh: 15 } // sin precio_kwh en absoluto
    ] });
    var cargaImportada = resultadoImport.datos.cargas[0];
    assert(cargaImportada.precio_kwh === null, 'sanearImportacion: una carga importada sin precio_kwh se queda en null (antes: comoNumeroSeguro(...,0) fabricaba un precio de 0 €/kWh)');
    assert(cargaImportada.total_cost === null, 'sanearImportacion: sin precio conocido, total_cost también queda en null, no en un 0€ calculado a partir del precio fabricado');
    assert(cargaImportada.cost_source === 'desconocido', 'sanearImportacion: cost_source se etiqueta "desconocido" (no "estimado", que implicaría que hay una estimación real detrás) cuando no hay coste calculable');
    assert(costeCarga(cargaImportada) === null, 'costeCarga() sobre la carga importada real confirma que no hay ningún coste fabricado');

    return res;
  });
  out.forEach((l) => console.log(l));
  const fallos = out.filter((l) => l.indexOf('FALLO') !== -1).length;
  console.log('\nTotal fallos:', fallos);
  console.log('PAGE ERRORS:', JSON.stringify(errors));
  await browser.close();
  process.exit(fallos === 0 && errors.length === 0 ? 0 : 1);
})();
