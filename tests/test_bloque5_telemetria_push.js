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

    /* ---------- Punto 17: detección de viaje automático ---------- */
    var muestrasViaje = [
      { ts:'2026-01-01T10:00:00Z', velocidad_kmh:0,  odometro_km:1000, lat:43.53, lng:-5.66 },
      { ts:'2026-01-01T10:00:05Z', velocidad_kmh:20, odometro_km:1000.1 },
      { ts:'2026-01-01T10:05:00Z', velocidad_kmh:50, odometro_km:1005 },
      { ts:'2026-01-01T10:05:30Z', velocidad_kmh:0,  odometro_km:1005 }, // semáforo, parada de 30s
      { ts:'2026-01-01T10:05:50Z', velocidad_kmh:40, odometro_km:1006 },
      { ts:'2026-01-01T10:10:00Z', velocidad_kmh:0,  odometro_km:1010, lat:43.55, lng:-5.70 }, // parada larga -> fin de viaje
      { ts:'2026-01-01T10:15:00Z', velocidad_kmh:0,  odometro_km:1010 }
    ];
    var viajes = detectarViajesDesdeTelemetria(muestrasViaje);
    assert(viajes.length === 1, 'una parada corta (30s, de semáforo) NO divide el viaje en dos (dio '+viajes.length+')');
    assert(viajes[0].km === 10, 'el km del viaje se calcula por diferencia real de odómetro (1010-1000=10)');
    assert(viajes[0].origen.lat === 43.53, 'se registra el origen con coordenadas de la primera muestra en movimiento');
    assert(viajes[0].destino.lat === 43.55, 'se registra el destino con las coordenadas de la última muestra en movimiento');

    var muestrasDosViajes = muestrasViaje.concat([
      { ts:'2026-01-01T11:00:00Z', velocidad_kmh:30, odometro_km:1011 },
      { ts:'2026-01-01T11:05:00Z', velocidad_kmh:0,  odometro_km:1015 }
    ]);
    var dosViajes = detectarViajesDesdeTelemetria(muestrasDosViajes);
    assert(dosViajes.length === 2, 'una parada larga (>90s) SÍ separa dos viajes distintos (dio '+dosViajes.length+')');

    assert(detectarViajesDesdeTelemetria([]).length === 0, 'sin muestras, no se inventa ningún viaje');
    assert(detectarViajesDesdeTelemetria([{ts:'2026-01-01T10:00:00Z',velocidad_kmh:0,odometro_km:0}]).length === 0, 'una sola muestra sin movimiento no genera ningún viaje');

    /* ---------- Punto 18: detección de sesión de carga automática ---------- */
    var muestrasCarga = [
      { ts:'2026-01-01T22:00:00Z', charging_state:'Charging', charger_power_kw:7, energy_added_kwh:0 },
      { ts:'2026-01-01T22:30:00Z', charging_state:'Charging', charger_power_kw:7, energy_added_kwh:3.5 },
      { ts:'2026-01-01T22:45:00Z', charging_state:'Stopped',  charger_power_kw:0, energy_added_kwh:3.5 }, // pausa breve, sigue enchufado
      { ts:'2026-01-01T23:00:00Z', charging_state:'Charging', charger_power_kw:7, energy_added_kwh:5.25 },
      { ts:'2026-01-01T23:30:00Z', charging_state:'Complete', charger_power_kw:0, energy_added_kwh:8.75 }
    ];
    var sesiones = detectarCargasDesdeTelemetria(muestrasCarga);
    assert(sesiones.length === 1, 'plug-in → carga → pausa → reanudación → fin es UNA sola sesión, no varias (dio '+sesiones.length+')');
    assert(sesiones[0].pausas === 1, 'se cuenta la pausa transitoria sin cerrar la sesión');
    assert(Math.abs(sesiones[0].energia_kwh - 8.75) < 0.01, 'la energía de la sesión es el total acumulado (8.75 kWh)');

    var muestrasDosSesiones = muestrasCarga.concat([
      { ts:'2026-01-02T08:00:00Z', charging_state:'Charging', charger_power_kw:11, energy_added_kwh:0 },
      { ts:'2026-01-02T09:00:00Z', charging_state:'Disconnected', charger_power_kw:0, energy_added_kwh:11 }
    ]);
    var dosSesiones = detectarCargasDesdeTelemetria(muestrasDosSesiones);
    assert(dosSesiones.length === 2, 'un unplug/nuevo plug-in sí abre una sesión de carga nueva y separada');

    assert(detectarCargasDesdeTelemetria([]).length === 0, 'sin muestras, no se inventa ninguna sesión de carga');

    /* ---------- Punto 19: dedupe/cooldown de avisos ---------- */
    localStorage.removeItem('mitesla-push-cooldown-test1');
    assert(debeNotificarConCooldown('test1', 30) === true, 'la primera vez, si debe notificar');
    assert(debeNotificarConCooldown('test1', 30) === false, 'una segunda alerta inmediata de la misma categoría se deduplica (cooldown)');
    localStorage.setItem('mitesla-push-cooldown-test1', new Date(Date.now() - 31*60000).toISOString());
    assert(debeNotificarConCooldown('test1', 30) === true, 'pasado el cooldown, sí se permite notificar de nuevo');

    /* ---------- Punto 19: activarWebPush() respeta el flag y la ausencia de clave VAPID ---------- */
    guardarFeatureFlags(Object.assign(cargarFeatureFlags(), { web_push:false }));
    var rSinFlag = await activarWebPush();
    assert(rSinFlag.ok === false && rSinFlag.motivo==='flag_desactivado', 'con el flag web_push desactivado, activarWebPush() no intenta nada');

    guardarFeatureFlags(Object.assign(cargarFeatureFlags(), { web_push:true }));
    var rSinVapid = await activarWebPush();
    assert(rSinVapid.ok === false && rSinVapid.motivo==='sin_vapid_key', 'con el flag activo pero sin clave VAPID configurada, se detiene con un motivo claro (no intenta suscribir con una clave inexistente)');
    guardarFeatureFlags(Object.assign(cargarFeatureFlags(), { web_push:false }));

    /* ---------- Categorías de push: visibilidad ligada al flag ---------- */
    mostrar('ajustes');
    assert(document.getElementById('lista-categorias-push').style.display === 'none', 'con web_push desactivado, la lista de categorías de avisos queda oculta');
    guardarFeatureFlags(Object.assign(cargarFeatureFlags(), { web_push:true }));
    renderAjustes();
    assert(document.getElementById('lista-categorias-push').style.display !== 'none', 'al activar web_push, se muestra la configuración de categorías de avisos');
    assert(document.querySelectorAll('[data-cat-push]').length === Object.keys(PUSH_CATEGORIAS).length, 'se listan todas las categorías de avisos definidas');
    guardarFeatureFlags(Object.assign(cargarFeatureFlags(), { web_push:false }));
    renderAjustes();

    return { res: res };
  });

  out.res.forEach(l => console.log(l));
  errors.forEach(e => console.log('❌ ' + e));
  await browser.close();
  process.exit(out.res.some(l => l.startsWith('❌')) || errors.length ? 1 : 0);
})();
