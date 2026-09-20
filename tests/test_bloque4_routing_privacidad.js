const { lanzarChromium, urlIndexHtml, PROJECT_ROOT } = require('./helpers/browser');
(async () => {
  const browser = await lanzarChromium();
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await page.goto(urlIndexHtml());

  const out = await page.evaluate(async () => {
    var res = [];
    function assert(cond, msg){ res.push((cond?'✅ ':'❌ FALLO: ')+msg); }

    /* ---------- Punto 15: privacidad de rutas — primitiva de distancia/ocultación ---------- */
    var dCorta = distanciaMetros(43.5322, -5.6611, 43.5330, -5.6611); // ~89 m
    assert(dCorta > 50 && dCorta < 150, 'distanciaMetros() da un valor razonable en metros (~89 m, dio '+Math.round(dCorta)+')');

    DATOS.vehiculo.casa = { lat: 43.5322, lng: -5.6611 };
    localStorage.setItem('mitesla-privacidad-radio', '0');
    assert(coordenadaEsPrivada(43.5330, -5.6611) === false, 'con el radio de privacidad a 0 (desactivado), ningún punto se considera privado');

    localStorage.setItem('mitesla-privacidad-radio', '300');
    assert(coordenadaEsPrivada(43.5330, -5.6611) === true, 'un punto a ~89 m de casa cae dentro de un radio de privacidad de 300 m');
    assert(coordenadaEsPrivada(43.60, -5.60) === false, 'un punto lejano de casa no se considera privado');
    localStorage.setItem('mitesla-privacidad-radio', '0');

    /* ---------- Punto 9 bis / auxiliar de routing: buscarLugarPorNombre ---------- */
    assert(buscarLugarPorNombre('Casa').lat === 43.5322, '"Casa" se resuelve a las coordenadas de DATOS.vehiculo.casa');
    DATOS.favoritos = [{ id:'f1', nombre:'Oficina FFPA', lat:43.36, lng:-5.85 }];
    var fav = buscarLugarPorNombre('oficina ffpa'); // normalizado, sin importar mayúsculas/acentos
    assert(!!fav && Math.abs(fav.lat-43.36)<0.001, 'un favorito se encuentra por nombre normalizado (mayúsculas/tildes)');
    assert(buscarLugarPorNombre('Sitio que no existe') === null, 'un nombre sin favorito coincidente no se inventa una ubicación');

    /* ---------- Punto 11: RouteProvider (OSRM) — con fetch simulado, sin red real ---------- */
    var fetchOriginal = window.fetch;
    window.fetch = async function(url){
      assert(url.indexOf('router.project-osrm.org')!==-1, 'RouteProviderOSRM llama al endpoint de OSRM');
      return { ok:true, json: async function(){ return { routes:[{ distance:45000, duration:2400 }] }; } };
    };
    var ruta = await RouteProviderOSRM.obtenerRuta({lat:43.5322,lng:-5.6611}, {lat:43.36,lng:-5.85});
    assert(ruta.distancia_km === 45, 'la ruta OSRM convierte metros a km (45000 m -> 45 km)');
    assert(ruta.duracion_min === 40, 'la ruta OSRM convierte segundos a minutos (2400 s -> 40 min)');
    assert(ruta.desnivel_m === null, 'OSRM no da desnivel — se deja en null, no se inventa (punto 34)');
    window.fetch = fetchOriginal;

    /* ---------- Feature flags (punto 35): la app funciona igual con todo desactivado ---------- */
    var flagsPorDefecto = cargarFeatureFlags();
    assert(flagsPorDefecto.advanced_routing === false, 'advanced_routing está desactivado por defecto');
    assert(flagsPorDefecto.fleet_telemetry === false, 'fleet_telemetry está desactivado por defecto');
    assert(flagsPorDefecto.web_push === false, 'web_push está desactivado por defecto');
    assert(flagsPorDefecto.d1_sync === false, 'd1_sync está desactivado por defecto');
    assert(flagsPorDefecto.solar_tracking === false, 'solar_tracking está desactivado por defecto');

    mostrar('ajustes');
    var chkRuta = document.getElementById('llego-usar-ruta-real');
    assert(chkRuta.closest('label').style.display === 'none', 'con advanced_routing desactivado, la casilla "usar ruta real" queda oculta en "¿Llego?"');
    guardarFeatureFlags(Object.assign(cargarFeatureFlags(), { advanced_routing:true }));
    renderAjustes();
    assert(chkRuta.closest('label').style.display !== 'none', 'al activar advanced_routing, la casilla "usar ruta real" se muestra');
    var chkFlagDom = document.querySelector('[data-flag="advanced_routing"]');
    assert(!!chkFlagDom && chkFlagDom.checked === true, 'el interruptor de Ajustes refleja el flag activo');
    guardarFeatureFlags(Object.assign(cargarFeatureFlags(), { advanced_routing:false }));
    renderAjustes();

    /* ---------- Punto 12: "¿Llego?" da un rango, no un único % falsamente preciso ---------- */
    DATOS.bateria_historico = [{id:'b1', fecha:'2026-01-01', capacidad_pct:95}];
    DATOS.cargas.push({id:'ct1', fecha:'2026-01-02', lugar:'Casa', kwh:10, precio_kwh:0.15, bateria_inicial:50, bateria_final:90, tipo:'domestica'});
    mostrar('estadisticas');
    document.getElementById('llego-km').value = '200';
    document.getElementById('llego-calcular').click();
    var html = document.getElementById('llego-resultado').innerHTML;
    assert(/\d+[–-]\d+\s*%/.test(html), 'el resultado de "¿Llego?" muestra un RANGO de % de llegada, no un único valor');
    assert(html.indexOf('factores')!==-1 || html.indexOf('reserva de llegada')!==-1, 'el resultado indica los factores usados en la estimación');

    return { res: res };
  });

  out.res.forEach(l => console.log(l));
  errors.forEach(e => console.log('❌ ' + e));
  await browser.close();
  process.exit(out.res.some(l => l.startsWith('❌')) || errors.length ? 1 : 0);
})();
