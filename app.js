/* ---------- Supuestos y constantes de cálculo (punto 28 de la auditoría Fase 2) ----------
 * Todos los "números mágicos" usados en estimaciones (no en datos reales del usuario) viven
 * aquí, con su valor, unidad y para qué sirven — para poder revisarlos o ajustarlos sin tener
 * que rastrear el código. Los datos reales del coche/viajes NUNCA pasan por aquí. */
var ASSUMPTIONS = {
  reservaLlegadaPct: { valor:15, unidad:'%', desc:'Margen mínimo de batería al llegar que usa la calculadora "¿Llego?" antes de recomendar parar a cargar.' },
  consumoReferenciaKwh100km: { valor:16, unidad:'kWh/100km', desc:'Consumo de referencia para "¿Llego?" y autonomía real cuando aún no hay viajes registrados con los que calcular una media propia.' },
  velocidadReferenciaKmh: { valor:60, unidad:'km/h', desc:'Velocidad media de referencia para ajustar el consumo estimado cuando no hay viajes con los que calcular una velocidad media propia.' },
  factorCo2KgPorLitro: { valor:2.31, unidad:'kg CO₂/litro', desc:'Factor de conversión estándar de litros de gasolina a kg de CO₂ evitado, usado en las comparativas de ahorro/impacto.' },
  tiempoParadaCargaMin: { valor:25, unidad:'min', desc:'Duración típica estimada de una parada de carga rápida en supercargador, para el cálculo de "paradas necesarias" en un trayecto largo.' },
  factorRecargaPorParada: { valor:0.6, unidad:'fracción de la capacidad nominal', desc:'Energía típica añadida en una parada de carga rápida (recarga habitual 20%→80%), usada para estimar cuántas paradas hacen falta.' },
  tempSinPerdidaC: { valor:20, unidad:'°C', desc:'Temperatura a partir de la cual no se aplica ninguna penalización de autonomía por frío en la tarjeta de clima.' },
  perdidaMaxFrioPct: { valor:25, unidad:'%', desc:'Pérdida de autonomía estimada máxima por frío extremo (a 0°C), tope superior de la curva lineal de degradación por temperatura.' },
  factorPerdidaFrioPorGrado: { valor:1.25, unidad:'%/°C', desc:'Pendiente de la curva lineal usada para estimar la pérdida de autonomía por cada grado por debajo de tempSinPerdidaC.' },
  factorVelocidadMin: { valor:0.7, unidad:'multiplicador', desc:'Límite inferior del ajuste de consumo por velocidad, para no infravalorar el consumo a baja velocidad de forma poco realista.' },
  factorVelocidadMax: { valor:2, unidad:'multiplicador', desc:'Límite superior del ajuste de consumo por velocidad, para no sobrevalorar el consumo a alta velocidad de forma poco realista.' },
  sohSinLecturasPct: { valor:100, unidad:'%', desc:'Salud de batería (SoH) asumida cuando todavía no hay ninguna lectura registrada: se parte de "batería nueva", nunca se inventa un desgaste.' },
  defaultForecastPriceKwh: { valor:0.18, unidad:'€/kWh', desc:'Precio de referencia usado ÚNICAMENTE en estimaciones/proyecciones cuando todavía no hay ninguna carga registrada con la que calcular un precio medio real (B21, FASE B) — es una hipótesis explícita, nunca un precio medido ni un dato real de carga.' }
};

/* ---------- Fase 3, punto 35: feature flags ----------
 * Funciones que dependen de infraestructura externa no configurada en este entorno (o que el
 * usuario puede no querer activar) se pueden desactivar por completo. Con todas desactivadas
 * (el valor por defecto), la app se comporta exactamente igual que al cerrar la Fase 2 — ninguna
 * de estas funciones se ejecuta ni se muestra. */
var FEATURE_FLAGS_POR_DEFECTO = {
  advanced_routing: { activo:false, nombre:'Routing real (OSRM)', desc:'Calcula distancia/duración de ruta reales entre casa y un favorito usando un servicio de routing público (OSRM), en vez de solo introducir los km a mano. Requiere red; si falla, se usa siempre el cálculo manual existente.' },
  fleet_telemetry: { activo:false, nombre:'Fleet Telemetry (Tesla)', desc:'Ingesta de telemetría en tiempo real del coche (viajes/cargas automáticos). Requiere un servicio de ingesta backend adicional no desplegado en este proyecto — ver informe final.' },
  web_push: { activo:false, nombre:'Notificaciones push', desc:'Avisos push (carga terminada, batería baja, etc.). Requiere claves VAPID y un endpoint backend que las envíe — no configurado.' },
  d1_sync: { activo:false, nombre:'Sincronización con Cloudflare D1', desc:'Sustituye/complementa GitHub como almacén de sincronización por una base de datos D1. Requiere desplegar el binding D1 en el Worker — no configurado.' },
  solar_tracking: { activo:false, nombre:'Atribución solar/batería doméstica', desc:'Permite indicar qué parte de una carga en casa vino de la red, de placas solares o de una batería doméstica, y calcula el ahorro frente a la red.' }
};
function cargarFeatureFlags(){
  var guardado = {};
  try{ guardado = JSON.parse(localStorage.getItem('mitesla-feature-flags')) || {}; }catch(e){}
  var out = {};
  Object.keys(FEATURE_FLAGS_POR_DEFECTO).forEach(function(k){
    out[k] = (typeof guardado[k]==='boolean') ? guardado[k] : FEATURE_FLAGS_POR_DEFECTO[k].activo;
  });
  return out;
}
function guardarFeatureFlags(flags){ localStorage.setItem('mitesla-feature-flags', JSON.stringify(flags)); }
function featureActiva(clave){ return !!cargarFeatureFlags()[clave]; }
function renderFeatureFlags(){
  var cont = document.getElementById('lista-feature-flags');
  if(!cont) return;
  var flags = cargarFeatureFlags();
  cont.innerHTML = Object.keys(FEATURE_FLAGS_POR_DEFECTO).map(function(k){
    var f = FEATURE_FLAGS_POR_DEFECTO[k];
    return '<div class="fila">'+
      '<div class="fila-tx"><div class="t1">'+esc(f.nombre)+'</div><div class="t2">'+esc(f.desc)+'</div></div>'+
      '<label style="flex:none;display:flex;align-items:center;gap:6px"><input type="checkbox" data-flag="'+k+'" '+(flags[k]?'checked':'')+' style="width:20px;height:20px"></label>'+
      '</div>';
  }).join('');
  cont.querySelectorAll('[data-flag]').forEach(function(chk){
    chk.addEventListener('change', function(){
      var actuales = cargarFeatureFlags();
      actuales[chk.dataset.flag] = chk.checked;
      guardarFeatureFlags(actuales);
      aplicarVisibilidadFeatureFlags();
      toast('Fase 3: "'+FEATURE_FLAGS_POR_DEFECTO[chk.dataset.flag].nombre+'" '+(chk.checked?'activada':'desactivada'));
    });
  });
  aplicarVisibilidadFeatureFlags();
  if(typeof renderCategoriasPush==='function') renderCategoriasPush();
}
/** Muestra/oculta en el propio formulario los campos que dependen de un feature flag —
 *  con el flag desactivado, ni siquiera se ofrece rellenarlos (punto 35: la app funciona
 *  correctamente con todos los flags desactivados, igual que al cerrar la Fase 2). */
function aplicarVisibilidadFeatureFlags(){
  var solarOn = featureActiva('solar_tracking');
  ['fc-origen-solar','fc-origen-bateria'].forEach(function(id){
    var campo = document.getElementById(id);
    if(campo && campo.closest('label')) campo.closest('label').style.display = solarOn ? '' : 'none';
  });
  var routingOn = featureActiva('advanced_routing');
  var chkRuta = document.getElementById('llego-usar-ruta-real');
  if(chkRuta && chkRuta.closest('label')) chkRuta.closest('label').style.display = routingOn ? '' : 'none';
  var secD1 = document.getElementById('sec-d1-sync');
  if(secD1) secD1.style.display = featureActiva('d1_sync') ? '' : 'none';
  var secAuto = document.getElementById('sec-automatizacion');
  if(secAuto) secAuto.style.display = featureActiva('fleet_telemetry') ? '' : 'none';
}

/* ==========================================================================================
 * Fase 3, puntos 16-18: Fleet Telemetry — arquitectura y algoritmos de viajes/cargas automáticos
 * ==========================================================================================
 * ESTADO: DISEÑADO/PENDIENTE en conjunto, con una parte real ya implementada y probada.
 *
 * Lo que Tesla llama "Fleet Telemetry" es un flujo continuo que Tesla empuja (push, no polling)
 * hacia un servidor propio que el desarrollador despliega, con requisitos que esta app —
 * estática, sin backend propio de ingesta — no cumple hoy: un endpoint HTTPS público con
 * certificado válido, verificación de firma, y persistencia de las muestras que van llegando.
 * Desplegar ESE servidor está fuera del alcance de "Mi Tesla" tal y como está construida (un
 * Worker de Cloudflare sin estado que solo hace polling puntual a /vehicle_data). Activar
 * fleet_telemetry sin ese servidor no tiene efecto — por eso el flag existe y por qué, aunque
 * se active, no pasa nada todavía: no hay ninguna fuente de muestras real conectada a él.
 *
 * Lo que SÍ se ha construido y probado en esta fase es la parte que no depende de tener ese
 * servidor: el modelo de datos de las señales de telemetría, y los DOS ALGORITMOS de detección
 * (viaje automático y sesión de carga automática) que consumirían esas muestras si existieran.
 * Son funciones puras, alimentables con cualquier lista de muestras — están listas para
 * conectarse el día que exista un backend de ingesta real; hasta entonces no se invoca a ningún
 * sitio del resto de la app ni afecta al comportamiento habitual. */

/** Prioridad de señales a persistir cuando exista telemetría real, de más a menos importante —
 *  documentado aquí para cuando se diseñe el backend de ingesta (punto 16). */
var TELEMETRIA_PRIORIDAD_SENALES = ['movimiento_velocidad','odometro','soc','energia','carga','gps_si_autorizado','temperaturas_utiles'];
/** Tipos de registro que distingue el modelo de telemetría (punto 16). */
var TELEMETRIA_TIPOS = ['snapshot','event','trip','charging_session'];

/* ---------- Punto 17: detección de viaje automático a partir de muestras de telemetría ----------
 * Entrada: array de muestras ordenadas por tiempo { ts (ISO), velocidad_kmh, odometro_km, lat?, lng? }.
 * Salida: array de viajes detectados { inicio, fin, origen:{lat,lng}|null, destino:{lat,lng}|null,
 *         km, duracion_min }.
 * Reglas (siguiendo el punto 17 de la Fase 3):
 *  - el movimiento empieza cuando la velocidad pasa a > 0 tras estar parado;
 *  - una parada de pocos segundos (por defecto <90s) NO corta el viaje — se sigue considerando el
 *    mismo trayecto (evita partir un viaje en 5 por cada semáforo);
 *  - una parada más larga consolida el viaje y, si vuelve a haber movimiento después, empieza uno
 *    nuevo;
 *  - el km del viaje se calcula por diferencia de odómetro real (no por sumar velocidades), para
 *    no arrastrar el error de integrar una señal ruidosa. */
function detectarViajesDesdeTelemetria(muestras, opciones){
  opciones = opciones || {};
  var pausaMaxSeg = (typeof opciones.pausaMaximaSegundos==='number') ? opciones.pausaMaximaSegundos : 90;
  if(!Array.isArray(muestras) || muestras.length<2) return [];
  var viajes = [];
  var enMovimiento = false, inicioViaje = null, ultimaMuestraMovimiento = null, ultimaMuestraParada = null;
  function conCoords(m){ return (m && m.lat!=null && m.lng!=null) ? { lat:m.lat, lng:m.lng } : null; }
  function cerrarViaje(muestraFin){
    if(!inicioViaje || !ultimaMuestraMovimiento) return;
    // Se usa el odómetro de las muestras de PARADA (antes de arrancar / después de detenerse) como
    // los km real de inicio y fin del viaje, no el de la primera/última muestra en movimiento —
    // entre pararse del todo y la primera/última lectura en movimiento el coche ya ha recorrido
    // algunos metros/km que no hay que perder ni contar de más.
    var odoInicial = (inicioViaje._paradaPrevia && typeof inicioViaje._paradaPrevia.odometro_km==='number') ? inicioViaje._paradaPrevia.odometro_km : inicioViaje.odometro_km;
    var odoFinal = (muestraFin && typeof muestraFin.odometro_km==='number') ? muestraFin.odometro_km : ultimaMuestraMovimiento.odometro_km;
    var km = Math.round((odoFinal - odoInicial) * 10) / 10;
    if(km > 0){
      viajes.push({
        inicio: inicioViaje.ts, fin: (muestraFin||ultimaMuestraMovimiento).ts,
        // El coche sigue emitiendo GPS estando parado, así que la posición de origen/destino más
        // fiable es la última muestra parada justo antes/después de moverse (dónde REALMENTE
        // estaba el coche), no la primera/última muestra en movimiento (que puede no traer GPS
        // todavía, o ya estar unos metros dentro del trayecto). Con respaldo a la muestra en
        // movimiento si la parada no trajera coordenadas.
        origen: conCoords(inicioViaje._paradaPrevia) || conCoords(inicioViaje),
        destino: conCoords(muestraFin) || conCoords(ultimaMuestraMovimiento),
        km: km,
        duracion_min: Math.round((new Date((muestraFin||ultimaMuestraMovimiento).ts) - new Date(inicioViaje.ts)) / 60000)
      });
    }
    inicioViaje = null; ultimaMuestraMovimiento = null;
  }
  muestras.forEach(function(m){
    var moviendo = (m.velocidad_kmh||0) > 0;
    if(moviendo){
      if(!enMovimiento){ inicioViaje = m; inicioViaje._paradaPrevia = ultimaMuestraParada; enMovimiento = true; }
      ultimaMuestraMovimiento = m;
    } else {
      ultimaMuestraParada = m;
      if(enMovimiento){
        var pausaSeg = ultimaMuestraMovimiento ? (new Date(m.ts) - new Date(ultimaMuestraMovimiento.ts))/1000 : 0;
        if(pausaSeg > pausaMaxSeg){ cerrarViaje(m); enMovimiento = false; }
        // si la pausa es corta, no se hace nada: se sigue considerando el mismo viaje en curso
      }
    }
  });
  if(enMovimiento) cerrarViaje(ultimaMuestraMovimiento); // el viaje seguía activo en la última muestra disponible
  return viajes;
}

/* ---------- Punto 18: detección de sesión de carga automática a partir de telemetría ----------
 * Entrada: array de muestras { ts, charging_state ('Charging'|'Complete'|'Stopped'|'Disconnected'),
 *          charger_power_kw?, energy_added_kwh? }.
 * Salida: array de sesiones consolidadas { inicio, fin, energia_kwh, potencia_media_kw, pausas }.
 * Reconoce enchufado→inicio→pausa→reanudación→fin→desenchufado como una única sesión, no una por
 * cada cambio de estado — una pausa (p. ej. gestión de potencia del cargador) no abre una sesión
 * nueva mientras el coche siga enchufado. */
function detectarCargasDesdeTelemetria(muestras){
  if(!Array.isArray(muestras) || !muestras.length) return [];
  var sesiones = [];
  var actual = null;
  function abrir(m){ actual = { inicio:m.ts, fin:m.ts, energia_kwh:0, muestras_potencia:[], pausas:0, ultimaEnergia:m.energy_added_kwh||0 }; }
  function cerrar(){
    if(!actual) return;
    var potenciaMedia = actual.muestras_potencia.length ? actual.muestras_potencia.reduce(function(a,b){return a+b;},0)/actual.muestras_potencia.length : null;
    sesiones.push({ inicio:actual.inicio, fin:actual.fin, energia_kwh:Math.round(actual.energia_kwh*100)/100, potencia_media_kw: potenciaMedia!==null?Math.round(potenciaMedia*10)/10:null, pausas:actual.pausas });
    actual = null;
  }
  muestras.forEach(function(m){
    var estado = m.charging_state;
    if(estado==='Charging'){
      if(!actual) abrir(m);
      else actual.fin = m.ts;
      if(typeof m.energy_added_kwh==='number'){
        var delta = m.energy_added_kwh - actual.ultimaEnergia;
        if(delta>0) actual.energia_kwh += delta;
        actual.ultimaEnergia = m.energy_added_kwh;
      }
      if(typeof m.charger_power_kw==='number') actual.muestras_potencia.push(m.charger_power_kw);
    } else if(estado==='Stopped'){
      if(actual){ actual.pausas++; actual.fin = m.ts; } // sigue enchufado, pausa transitoria — no cierra la sesión
    } else if(estado==='Complete' || estado==='Disconnected'){
      if(actual){
        // El total de energía suele llegar en esta última muestra (la de "Complete"), no solo
        // mientras el estado era literalmente "Charging" — hay que contarla también aquí o se
        // pierde el último tramo de energía añadida.
        if(typeof m.energy_added_kwh==='number'){
          var deltaFinal = m.energy_added_kwh - actual.ultimaEnergia;
          if(deltaFinal>0) actual.energia_kwh += deltaFinal;
          actual.ultimaEnergia = m.energy_added_kwh;
        }
        actual.fin = m.ts;
        cerrar();
      }
    }
  });
  if(actual) cerrar(); // sesión que seguía en curso en la última muestra disponible
  return sesiones;
}

/* ---------- Cerrar formularios y el modal de confirmación con Escape ---------- */
document.addEventListener('keydown', function(e){
  if(e.key !== 'Escape') return;
  var modal = document.getElementById('modal-fondo');
  if(modal.classList.contains('on')){ document.getElementById('modal-cancelar').click(); return; }
  ['form-accesorio','form-bateria','form-carga','form-gasto','form-neumatico','form-recordatorio','form-viaje'].forEach(function(id){
    var f = document.getElementById(id);
    if(f && !f.classList.contains('form-oculto')) f.classList.add('form-oculto');
  });
});

/* Nota: ya no hace falta el listener manual de "Enter" que había aquí — ahora estos son
   <form> reales, así que Enter en un campo de texto dispara el submit nativo del navegador,
   que es justo lo que gestionan los listeners 'submit' de cada formulario más abajo. */

/* ---------- Copia de seguridad: exportar / importar ---------- */
function esc(t){ return String(t==null?'':t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); } // evita que un texto libre (origen, concepto, nombre…) con < > rompa el HTML renderizado
function descargarArchivo(contenido, nombre, tipo){
  var blob = new Blob([contenido], { type: tipo });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = nombre; a.click();
  URL.revokeObjectURL(url);
}
function aCSV(filas, columnas){
  var esc = function(v){
    v = String(v==null?'':v);
    if(/^[=+\-@\t\r]/.test(v)) v = "'"+v; // evita que Excel/Sheets interprete el valor como fórmula
    return /[",;\n]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v;
  };
  var lineas = [columnas.map(function(c){return esc(c.titulo);}).join(';')];
  filas.forEach(function(f){ lineas.push(columnas.map(function(c){return esc(c.valor(f));}).join(';')); });
  return lineas.join('\r\n');
}
/* ---------- B26/B27 (FASE B): backup completo (incluye D1) y copia anónima ----------
 * Hasta esta sesión, "Exportar datos" descargaba literalmente JSON.stringify(DATOS) — solo lo que
 * vive en localStorage de ESTE dispositivo. Viajes/cargas detectados automáticamente por telemetría,
 * ubicaciones, reglas, pendientes y alertas viven SOLO en D1 y nunca salían en ningún backup. Estas
 * dos funciones piden ese volcado a /backup/completo (worker.js) y lo añaden al archivo — si el
 * backend no está configurado, el VIN aún no se conoce, o la petición falla, se descarga igual con
 * los datos locales y se deja constancia explícita del motivo en el propio archivo (aviso_d1): la
 * copia que ya funcionaba nunca se bloquea por esto (NORMA: no dar nada por corregido/completo sin
 * comprobarlo — aquí, sin fingir que se incluyó algo que en realidad falló). */
function backendConfigParaBackup(){
  var tcfg = cargarConfigTesla();
  var backendUrl = (tcfg.backendUrl || TESLA_CONFIG_POR_DEFECTO.backendUrl || '').replace(/\/$/,'');
  var vin = DATOS.vehiculo && DATOS.vehiculo.tesla_vin;
  if(!backendUrl || !tcfg.sessionToken || !vin) return null;
  return { backendUrl: backendUrl, sessionToken: tcfg.sessionToken, vin: vin };
}
async function construirBackupParaDescarga(modo, fetchImpl){
  fetchImpl = fetchImpl || fetch;
  var anonimo = modo==='anonimizado';
  var cfg = backendConfigParaBackup();
  var meta = { modo: anonimo?'anonimizado':'privado', generado_en: ahoraISO() };
  var cuerpo;
  if(!anonimo){
    // B26 — CORRECCIÓN: la primera versión de esto metía todo DATOS dentro de una clave
    // "datos_locales", lo que ROMPÍA el importador de siempre ("Importar datos (.json)" lee
    // bruto.viajes/bruto.cargas/... directamente del nivel superior — ver validarFormaDatos/
    // sanearImportacion). Un backup generado con ese formato habría fallado al reimportarse
    // ("El archivo no parece una copia de Mi Tesla"), justo lo que el criterio de B26 exige
    // probar (export → base vacía → import → comparar totales). Corregido: el objeto raíz sigue
    // siendo EXACTAMENTE DATOS, tal cual siempre ha sido; el volcado de D1 va aparte, bajo una
    // clave reservada (_backup_meta) que el importador de siempre simplemente ignora.
    cuerpo = Object.assign({}, DATOS, { _backup_meta: meta });
  } else {
    // B27: la copia anónima NUNCA incluye el blob local tal cual (puede llevar VIN, GPS de casa,
    // notas de texto libre) — solo el volcado D1 ya anonimizado por el propio backend (B14). No
    // tiene la forma que espera "Importar datos" a propósito: no es para restaurar, es para
    // compartir/depurar.
    cuerpo = { _backup_meta: meta, nota: 'Copia anónima: solo datos de vehículo rastreados automáticamente vía D1 (viajes, cargas, ubicaciones, alertas...), sin VIN y con ubicaciones difuminadas u ocultas. NO incluye lo introducido a mano en este dispositivo (gastos, notas, viajes/cargas manuales) — para eso, usa la copia privada. Este archivo no está pensado para "Importar datos".' };
  }
  if(!cfg){
    cuerpo._backup_meta.aviso_d1 = 'Backend de Tesla no configurado (o VIN desconocido todavía) — no se ha podido incluir ningún dato de D1 (viajes/cargas automáticos, ubicaciones, reglas, pendientes, alertas).';
    return cuerpo;
  }
  try{
    var url = cfg.backendUrl+'/backup/completo?vin='+encodeURIComponent(cfg.vin)+(anonimo?'&modo=anonimizado':'');
    var res = await fetchImpl(url, { headers: { 'Authorization': 'Bearer '+cfg.sessionToken } });
    var d1 = await res.json().catch(function(){ return null; });
    if(!res.ok) throw new Error((d1&&d1.error)||('http_'+res.status));
    cuerpo._backup_meta.datos_d1 = d1;
  }catch(e){
    cuerpo._backup_meta.aviso_d1 = 'No se pudo obtener el volcado de D1 ('+String((e&&e.message)||e)+').'+(anonimo?'':' Esta copia solo incluye los datos locales de este dispositivo.');
  }
  return cuerpo;
}
document.getElementById('btn-exportar').addEventListener('click', function(){
  construirBackupParaDescarga('privado').then(function(cuerpo){
    descargarArchivo(JSON.stringify(cuerpo, null, 2), 'mitesla-datos-'+fechaLocalISO()+'.json', 'application/json');
    localStorage.setItem('mitesla-ultima-backup', ahoraISO()); // Fase 3, punto 20: para poder mostrar "última copia" en el centro de calidad de datos
    toast(cuerpo._backup_meta.datos_d1 ? 'Copia descargada (incluye datos de D1)' : 'Copia descargada (solo datos locales)');
  });
});
document.getElementById('btn-exportar-anonimo').addEventListener('click', function(){
  construirBackupParaDescarga('anonimizado').then(function(cuerpo){
    descargarArchivo(JSON.stringify(cuerpo, null, 2), 'mitesla-anonimo-'+fechaLocalISO()+'.json', 'application/json');
    toast(cuerpo._backup_meta.datos_d1 ? 'Copia anónima descargada' : 'Copia anónima descargada (sin datos de D1: revisa la configuración del backend)');
  });
});
document.getElementById('btn-exportar-csv-viajes').addEventListener('click', function(){
  var csv = aCSV(DATOS.viajes, [
    {titulo:'Fecha', valor:function(v){return v.fecha;}},
    {titulo:'Origen', valor:function(v){return v.origen;}},
    {titulo:'Destino', valor:function(v){return v.destino;}},
    {titulo:'Km', valor:function(v){return v.km;}},
    {titulo:'Duración (min)', valor:function(v){return v.duracion_min;}},
    {titulo:'Batería inicial %', valor:function(v){return v.bateria_inicial;}},
    {titulo:'Batería final %', valor:function(v){return v.bateria_final;}},
    {titulo:'Consumo kWh/100km', valor:function(v){var c=consumoViaje(v); return c===null?'':c.toFixed(1);}}
  ]);
  descargarArchivo('\uFEFF'+csv, 'mitesla-viajes.csv', 'text/csv;charset=utf-8');
  toast('CSV de viajes descargado');
});
document.getElementById('btn-exportar-csv-cargas').addEventListener('click', function(){
  var csv = aCSV(DATOS.cargas, [
    {titulo:'Fecha', valor:function(c){return c.fecha;}},
    {titulo:'Lugar', valor:function(c){return c.lugar;}},
    {titulo:'Tipo', valor:function(c){return NOMBRE_TIPO[c.tipo]||c.tipo;}},
    {titulo:'kWh', valor:function(c){return c.kwh;}},
    {titulo:'€/kWh', valor:function(c){return c.precio_kwh;}},
    {titulo:'Coste (€)', valor:function(c){var v=costeCarga(c); return v===null?'':v.toFixed(2);}},
    {titulo:'Batería inicial %', valor:function(c){return c.bateria_inicial;}},
    {titulo:'Batería final %', valor:function(c){return c.bateria_final;}}
  ]);
  descargarArchivo('\uFEFF'+csv, 'mitesla-cargas.csv', 'text/csv;charset=utf-8');
  toast('CSV de cargas descargado');
});

function datosVaciosParaCocheReal(){
  var ahoraFecha = fechaLocalISO();
  return {
    schema_version: SCHEMA_VERSION,
    data_mode: 'real',
    vehiculo: { modelo: DATOS.vehiculo.modelo, capacidad_nominal_kwh: DATOS.vehiculo.capacidad_nominal_kwh, autonomia_wltp_km: DATOS.vehiculo.autonomia_wltp_km, fecha_compra: ahoraFecha, odometro_km: 0, estado: 'aparcado', updated_at: ahoraISO() },
    referencia_gasolina: DATOS.referencia_gasolina,
    bateria_historico: [],
    viajes: [], cargas: [], gastos: [], recordatorios: [],
    neumaticos: { delanteros:{fecha_instalacion:ahoraFecha,km_instalacion:0,vida_util_km:45000}, traseros:{fecha_instalacion:ahoraFecha,km_instalacion:0,vida_util_km:45000} },
    accesorios: [], seguro: { fecha_renovacion:'' }, itv: { fecha:'' }, planes: [], favoritos: [],
    plantillas_viaje: [],
    neumaticos_historico: [], mantenimiento: [], documentos: [],
    _borrados: {}
  };
}
function refrescarTodasLasVistas(){
  renderDashboard(); renderCargas(); renderViajes(); renderBateria(); renderGastos(); renderEstadisticas(); renderAjustes();
  renderLugares(); renderPlanes(); renderNeumaticos(); renderMantenimiento(); renderDocumentos(); renderAccesorios();
  if(typeof renderListaBateria==='function') renderListaBateria();
}

// Reinicio LOCAL: solo afecta a este dispositivo, y pausa la sincronizaci\u00F3n autom\u00E1tica para que,
// al no tener ya el dataset_id anterior, no se limite a rellenarse otra vez con lo que hay en el remoto.
document.getElementById('btn-reiniciar-dispositivo').addEventListener('click', function(){
  confirmarAccion('Reiniciar este dispositivo', 'Esto vac\u00EDa los datos de ejemplo SOLO en este dispositivo y pausa la sincronizaci\u00F3n autom\u00E1tica (no se descargar\u00E1 el remoto por s\u00ED sola). Tu configuraci\u00F3n de GitHub y Tesla no se toca. Esta acci\u00F3n no se puede deshacer aqu\u00ED \u2014 si quieres conservar los datos de ejemplo, descarga antes una copia en .json.', function(){
    DATOS = conservarBusinessCanonical(normalizarDatos(datosVaciosParaCocheReal()));
    DATOS.dataset_id = nuevoId();
    guardarDatos(true);
    localStorage.setItem('mitesla-sync-suspendida', '1');
    refrescarTodasLasVistas();
    toast('Dispositivo reiniciado \u2014 sincronizaci\u00F3n pausada hasta que sincronices a mano');
  }, 'Reiniciar');
});

// Empezar de cero COMPLETAMENTE: nuevo dataset_id (invalida el anterior para que la fusi\u00F3n no
// mezcle el demo viejo), y se sincroniza inmediatamente para que sobrescriba lo que hay en GitHub.
document.getElementById('btn-empezar-cero').addEventListener('click', function(){
  confirmarAccion('Empezar de cero completamente', 'Esto borra todos los viajes, cargas, gastos y el historial de ejemplo, y sobrescribe lo que haya en GitHub \u2014 se borrar\u00E1 tambi\u00E9n en el resto de tus dispositivos la pr\u00F3xima vez que sincronicen. Esta acci\u00F3n no se puede deshacer aqu\u00ED \u2014 si quieres conservar los datos de ejemplo, descarga antes una copia en .json.', function(){
    DATOS = conservarBusinessCanonical(normalizarDatos(datosVaciosParaCocheReal()));
    DATOS.dataset_id = nuevoId(); // invalida el dataset anterior: una fusi\u00F3n con el remoto viejo no lo mezclar\u00E1
    localStorage.removeItem('mitesla-sync-suspendida');
    guardarDatos(true);
    refrescarTodasLasVistas();
    toast('Datos reiniciados por completo \u2014 listo para tu coche real');
    var cfg = cargarConfigGithub();
    if(cfg.repo && cfg.token) sincronizarGithub({ silencioso:false });
  }, 'Empezar de cero');
});

document.getElementById('btn-exportar-csv-gastos').addEventListener('click', function(){
  var csv = aCSV(DATOS.gastos, [
    {titulo:'Fecha', valor:function(g){return g.fecha;}},
    {titulo:'Categor\u00EDa', valor:function(g){return NOMBRE_CAT[g.categoria]||g.categoria;}},
    {titulo:'Concepto', valor:function(g){return g.concepto;}},
    {titulo:'Importe (\u20AC)', valor:function(g){return g.importe.toFixed(2);}}
  ]);
  descargarArchivo('\uFEFF'+csv, 'mitesla-gastos.csv', 'text/csv;charset=utf-8');
  toast('CSV de gastos descargado');
});

document.getElementById('btn-exportar-csv-accesorios').addEventListener('click', function(){
  var csv = aCSV(DATOS.accesorios, [
    {titulo:'Fecha', valor:function(a){return a.fecha;}},
    {titulo:'Nombre', valor:function(a){return a.nombre;}},
    {titulo:'Categor\u00EDa', valor:function(a){return NOMBRE_CAT_ACC[a.categoria]||a.categoria;}},
    {titulo:'Precio (\u20AC)', valor:function(a){return a.precio.toFixed(2);}},
    {titulo:'Garant\u00EDa (meses)', valor:function(a){return a.meses_garantia||'';}}
  ]);
  descargarArchivo('\uFEFF'+csv, 'mitesla-accesorios.csv', 'text/csv;charset=utf-8');
  toast('CSV de accesorios descargado');
});

/* ---------- Informe anual (PDF v\u00EDa ventana imprimible) ---------- */
/* ---------- Informe de kilometraje de trabajo (para justificar ante la organización) ---------- */
function obtenerViajesTrabajoFiltrados(){
  var desdeVal = document.getElementById('informe-desde').value;
  var hastaVal = document.getElementById('informe-hasta').value;
  var tarifa = parseFloat(document.getElementById('informe-tarifa').value);
  var desde = desdeVal ? new Date(desdeVal+'T00:00:00') : null; // hora local, para no excluir viajes de madrugada del primer día
  var hasta = hastaVal ? new Date(hastaVal+'T23:59:59') : null;
  if(desde && hasta && desde > hasta){
    toast('La fecha "Desde" no puede ser posterior a "Hasta".', true);
    return null;
  }
  if(!isNaN(tarifa) && tarifa < 0){
    toast('La tarifa €/km no puede ser negativa.', true);
    return null;
  }
  var viajesTrabajo = DATOS.viajes.filter(function(v){
    if(v.etiqueta !== 'trabajo') return false;
    var d = new Date(v.fecha);
    if(desde && d < desde) return false;
    if(hasta && d > hasta) return false;
    return true;
  }).sort(function(a,b){ return new Date(a.fecha)-new Date(b.fecha); });
  if(!viajesTrabajo.length){
    toast('No hay viajes marcados como "Trabajo" en ese periodo.', true);
    return null;
  }
  return { viajes: viajesTrabajo, tarifa: tarifa, desdeVal: desdeVal, hastaVal: hastaVal };
}
document.getElementById('btn-informe-trabajo-csv').addEventListener('click', function(){
  var r = obtenerViajesTrabajoFiltrados();
  if(!r) return;
  var tarifa = r.tarifa;
  var csv = aCSV(r.viajes, [
    {titulo:'Fecha', valor:function(v){return new Date(v.fecha).toLocaleDateString('es-ES');}},
    {titulo:'Origen', valor:function(v){return v.origen;}},
    {titulo:'Destino', valor:function(v){return v.destino;}},
    {titulo:'Conductor', valor:function(v){return v.conductor||'';}},
    {titulo:'Km', valor:function(v){return fmt1(v.km);}}
  ].concat(!isNaN(tarifa) ? [{titulo:'Importe (€)', valor:function(v){return (v.km*tarifa).toFixed(2);}}] : []));
  var observacionesCsv = (document.getElementById('informe-observaciones').value||'').trim();
  if(observacionesCsv) csv += '\r\n\r\nObservaciones;'+observacionesCsv.replace(/;/g,',');
  descargarArchivo('\uFEFF'+csv, 'mitesla-kilometraje-trabajo.csv', 'text/csv;charset=utf-8');
  toast('CSV del informe de trabajo descargado');
});
document.getElementById('btn-informe-trabajo').addEventListener('click', function(){
  var r = obtenerViajesTrabajoFiltrados();
  if(!r) return;
  var viajesTrabajo = r.viajes, tarifa = r.tarifa, desdeVal = r.desdeVal, hastaVal = r.hastaVal;

  var totalKm = viajesTrabajo.reduce(function(s,v){ return s+v.km; }, 0);
  var totalImporte = !isNaN(tarifa) ? totalKm*tarifa : null;

  var filas = viajesTrabajo.map(function(v){
    return '<tr><td>'+new Date(v.fecha).toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'})+'</td>'+
      '<td>'+esc(v.origen)+' → '+esc(v.destino)+'</td>'+
      '<td>'+esc(v.conductor||'—')+'</td>'+
      '<td style="text-align:right">'+fmt1(v.km)+' km</td>'+
      (totalImporte!==null ? '<td style="text-align:right">'+(v.km*tarifa).toFixed(2)+' €</td>' : '')+
      '</tr>';
  }).join('');

  var rangoTexto = (desdeVal ? new Date(desdeVal+'T00:00:00').toLocaleDateString('es-ES') : 'inicio') + ' — ' + (hastaVal ? new Date(hastaVal+'T00:00:00').toLocaleDateString('es-ES') : 'hoy');
  // Fase 3, punto 26: observaciones opcionales del propio informe, y un hueco de firma real (no
  // solo la línea impresa) para quien lo revise a mano.
  var observaciones = (document.getElementById('informe-observaciones').value||'').trim();

  var html = '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Informe de kilometraje de trabajo</title><style>'+
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a1a1a;max-width:800px;margin:0 auto;padding:40px 24px}'+
    'h1{font-size:22px;margin:0 0 4px}'+
    '.sub{color:#666;font-size:13px;margin-bottom:24px}'+
    'table{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px}'+
    'th{text-align:left;font-size:11px;text-transform:uppercase;color:#777;border-bottom:2px solid #111;padding:6px 4px}'+
    'td{padding:7px 4px;border-bottom:1px solid #eee}'+
    '.totales{margin-top:20px;border-top:2px solid #111;padding-top:12px;font-size:14px}'+
    '.totales b{font-size:17px}'+
    '.firma{margin-top:60px;display:flex;justify-content:space-between}'+
    '.firma div{width:45%;border-top:1px solid #999;padding-top:6px;font-size:12px;color:#666;text-align:center}'+
    '@media print{body{padding:0}}'+
    '</style></head><body>'+
    '<h1>Informe de kilometraje de trabajo</h1>'+
    '<div class="sub">Periodo: '+rangoTexto+' · Vehículo: '+esc(DATOS.vehiculo.modelo||'Model Y')+' · Generado el '+new Date().toLocaleDateString('es-ES',{day:'numeric',month:'long',year:'numeric'})+'</div>'+
    '<table><thead><tr><th>Fecha</th><th>Trayecto</th><th>Conductor</th><th style="text-align:right">Km</th>'+(totalImporte!==null?'<th style="text-align:right">Importe</th>':'')+'</tr></thead><tbody>'+
    filas+'</tbody></table>'+
    '<div class="totales">Total: <b>'+totalKm.toFixed(1)+' km</b> en '+viajesTrabajo.length+' viaje'+(viajesTrabajo.length===1?'':'s')+
    (totalImporte!==null ? ' · Importe a '+tarifa.toFixed(2)+' €/km: <b>'+euros(totalImporte)+'</b>' : '')+
    '</div>'+
    (observaciones ? '<div style="margin-top:16px;font-size:13px"><b>Observaciones:</b> '+esc(observaciones)+'</div>' : '')+
    '<div class="firma"><div>Firma del conductor</div><div>Sello / Visto bueno</div></div>'+
    '<script>window.onload=function(){setTimeout(function(){window.print();},300);};<\/script>'+
    '</body></html>';

  var ventana = window.open('', '_blank');
  if(!ventana){ toast('Permite las ventanas emergentes para generar el informe', true); return; }
  ventana.document.open(); ventana.document.write(html); ventana.document.close();
  toast('Informe generado — usa "Guardar como PDF" en el diálogo de impresión');
});

document.getElementById('btn-exportar-pdf').addEventListener('click', function(){
  var a\u00F1o = new Date().getFullYear();
  var viajesA\u00F1o = DATOS.viajes.filter(function(v){ return new Date(v.fecha).getFullYear()===a\u00F1o; });
  var cargasA\u00F1o = DATOS.cargas.filter(function(c){ return new Date(c.fecha).getFullYear()===a\u00F1o; });
  var km = viajesA\u00F1o.reduce(function(s,v){ return s+v.km; }, 0);
  var kwh = cargasA\u00F1o.reduce(function(s,c){ return s+c.kwh; }, 0);
  var resumenCosteA\u00F1o = resumenCosteCargas(cargasA\u00F1o);
  var costeTesla = resumenCosteA\u00F1o.costeConocido || 0; // B23: nunca cuenta cargas de precio desconocido como 0 \u20AC
  var costeGasolina100 = DATOS.referencia_gasolina.consumo_l_100km*DATOS.referencia_gasolina.precio_litro;
  var ahorro = (costeGasolina100/100*km) - costeTesla;
  var co2 = (km/100*DATOS.referencia_gasolina.consumo_l_100km*ASSUMPTIONS.factorCo2KgPorLitro.valor);
  var consumos = viajesA\u00F1o.map(consumoViaje).filter(function(c){return c>0;});
  var consumoMedio = consumos.length ? (consumos.reduce(function(a,b){return a+b;},0)/consumos.length) : null;
  var mejorConsumo = consumos.length ? Math.min.apply(null,consumos) : null;
  var precioMedioCarga = (resumenCosteA\u00F1o.nConocidas>0 && kwh>0) ? (costeTesla/kwh) : null;
  var bateriaActual = DATOS.bateria_historico.length ? DATOS.bateria_historico[DATOS.bateria_historico.length-1].capacidad_pct : null;
  // Fase 3, punto 26: ampliaci\u00F3n del informe anual \u2014 horas, gastos, \u20AC/100km real, evoluci\u00F3n
  // frente al a\u00F1o anterior (mismo periodo del a\u00F1o, para que la comparaci\u00F3n sea coherente).
  var minutosA\u00F1o = viajesA\u00F1o.reduce(function(s,v){ return s+(v.duracion_min||0); }, 0);
  var gastosA\u00F1o = DATOS.gastos.filter(function(g){ return new Date(g.fecha).getFullYear()===a\u00F1o; }).reduce(function(s,g){ return s+g.importe; }, 0);
  var costeTotalA\u00F1o = costeTesla + gastosA\u00F1o;
  var costePor100km = km>0 ? (costeTotalA\u00F1o/km*100) : null;

  var a\u00F1oAnterior = a\u00F1o-1;
  var viajesA\u00F1oAnterior = DATOS.viajes.filter(function(v){ return new Date(v.fecha).getFullYear()===a\u00F1oAnterior; });
  var kmA\u00F1oAnterior = viajesA\u00F1oAnterior.reduce(function(s,v){ return s+v.km; }, 0);
  var hayA\u00F1oAnterior = viajesA\u00F1oAnterior.length>0;
  var variacionKmPct = (hayA\u00F1oAnterior && kmA\u00F1oAnterior>0) ? Math.round((km-kmA\u00F1oAnterior)/kmA\u00F1oAnterior*100) : null;

  var porMes = {};
  viajesA\u00F1o.forEach(function(v){ var m=new Date(v.fecha).getMonth(); porMes[m]=(porMes[m]||0)+v.km; });
  var filasMes = MESES_LARGO.map(function(nombre,i){
    return '<tr><td>'+nombre+'</td><td style="text-align:right">'+(porMes[i]?porMes[i].toFixed(0):'0')+' km</td></tr>';
  }).join('');

  var top5Viajes = viajesA\u00F1o.slice().sort(function(a,b){return b.km-a.km;}).slice(0,5)
    .map(function(v){ return '<tr><td>'+new Date(v.fecha).toLocaleDateString('es-ES',{day:'numeric',month:'short'})+'</td><td>'+esc(v.origen)+' \u2192 '+esc(v.destino)+'</td><td style="text-align:right">'+fmt0(v.km)+' km</td></tr>'; })
    .join('') || '<tr><td colspan="3" style="color:#888">Sin viajes registrados</td></tr>';

  var html = '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Informe Mi Tesla '+a\u00F1o+'</title><style>'+
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a1a1a;max-width:760px;margin:0 auto;padding:40px 24px}'+
    'h1{font-size:26px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 10px;padding-bottom:6px;border-bottom:2px solid #111}'+
    '.sub{color:#666;font-size:13px;margin-bottom:28px}'+
    '.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}'+
    '.card{border:1px solid #ddd;border-radius:10px;padding:14px 16px}'+
    '.card .l{font-size:11px;color:#777;text-transform:uppercase;letter-spacing:.04em}'+
    '.card .v{font-size:22px;font-weight:700;margin-top:4px}'+
    'table{width:100%;border-collapse:collapse;font-size:13px}'+
    'td{padding:6px 4px;border-bottom:1px solid #eee}'+
    '.pie{margin-top:40px;font-size:11px;color:#999;text-align:center}'+
    '@media print{body{padding:0}}'+
    '</style></head><body>'+
    '<h1>Informe anual \u00B7 '+a\u00F1o+'</h1>'+
    '<div class="sub">Mi Tesla \u2014 '+esc(DATOS.vehiculo.modelo||'Model Y')+' \u00B7 Generado el '+new Date().toLocaleDateString('es-ES',{day:'numeric',month:'long',year:'numeric'})+'</div>'+
    '<h2>Resumen del a\u00F1o</h2>'+
    '<div class="grid">'+
    '<div class="card"><div class="l">Kil\u00F3metros</div><div class="v">'+km.toLocaleString('es-ES')+' km</div></div>'+
    '<div class="card"><div class="l">Viajes registrados</div><div class="v">'+viajesA\u00F1o.length+'</div></div>'+
    '<div class="card"><div class="l">Energ\u00EDa cargada</div><div class="v">'+kwh.toFixed(0)+' kWh</div></div>'+
    '<div class="card"><div class="l">Cargas registradas</div><div class="v">'+cargasA\u00F1o.length+'</div></div>'+
    '<div class="card"><div class="l">Ahorro vs. gasolina</div><div class="v">'+euros(ahorro)+'</div></div>'+
    '<div class="card"><div class="l">CO\u2082 evitado</div><div class="v">'+co2.toFixed(0)+' kg</div></div>'+
    (consumoMedio?'<div class="card"><div class="l">Consumo medio</div><div class="v">'+consumoMedio.toFixed(1)+' kWh/100km</div></div>':'')+
    (mejorConsumo?'<div class="card"><div class="l">Mejor eficiencia</div><div class="v">'+mejorConsumo.toFixed(1)+' kWh/100km</div></div>':'')+
    (precioMedioCarga?'<div class="card"><div class="l">Precio medio carga</div><div class="v">'+precioMedioCarga.toFixed(2)+' \u20AC/kWh</div></div>':'')+
    (bateriaActual?'<div class="card"><div class="l">Salud de bater\u00EDa</div><div class="v">'+bateriaActual+' %</div></div>':'')+
    '<div class="card"><div class="l">Horas conduciendo</div><div class="v">'+Math.floor(minutosA\u00F1o/60)+'h '+(minutosA\u00F1o%60)+'min</div></div>'+
    '<div class="card"><div class="l">Gastos (sin energ\u00EDa)</div><div class="v">'+euros(gastosA\u00F1o)+'</div></div>'+
    (costePor100km!==null?'<div class="card"><div class="l">Coste real por 100 km</div><div class="v">'+euros(costePor100km)+'</div></div>':'')+
    '</div>'+
    (hayA\u00F1oAnterior ? '<h2>Evoluci\u00F3n frente a '+a\u00F1oAnterior+'</h2><table>'+
      '<tr><td>Kil\u00F3metros</td><td style="text-align:right">'+kmA\u00F1oAnterior.toFixed(0)+' km \u2192 '+km.toFixed(0)+' km ('+(variacionKmPct!==null?(variacionKmPct>0?'+':'')+variacionKmPct+' %':'sin datos comparables')+')</td></tr>'+
      '</table>' : '')+
    '<h2>Kil\u00F3metros por mes</h2>'+
    '<table>'+filasMes+'</table>'+
    '<h2>Los 5 viajes m\u00E1s largos</h2>'+
    '<table>'+top5Viajes+'</table>'+
    '<h2>Metodolog\u00EDa del ahorro estimado</h2>'+
    '<p style="font-size:12px;color:#666;line-height:1.6">El ahorro se calcula comparando el coste real de la energ\u00EDa cargada este a\u00F1o con lo que hubiera costado recorrer los mismos kil\u00F3metros en un veh\u00EDculo de gasolina de referencia ('+DATOS.referencia_gasolina.consumo_l_100km+' L/100km a '+DATOS.referencia_gasolina.precio_litro.toFixed(2)+' \u20AC/L, configurable en Ajustes). Es una estimaci\u00F3n de referencia, no una medici\u00F3n del veh\u00EDculo real que se hubiera tenido en su lugar \u2014 igual que el CO\u2082 evitado, calculado con el mismo factor de referencia.</p>'+
    '<div class="pie">Generado por Mi Tesla \u00B7 Datos introducidos manualmente por el usuario \u00B7 Las cifras marcadas como estimaci\u00F3n no son mediciones directas</div>'+
    '<script>window.onload=function(){setTimeout(function(){window.print();},300);};<\/script>'+
    '</body></html>';

  var ventana = window.open('', '_blank');
  if(!ventana){ toast('Permite las ventanas emergentes para generar el informe', true); return; }
  ventana.document.open(); ventana.document.write(html); ventana.document.close();
  toast('Informe generado \u2014 usa "Guardar como PDF" en el di\u00E1logo de impresi\u00F3n');
});

var TAMAÑO_MAX_IMPORTACION = 15*1024*1024; // 15 MB de margen amplio para un JSON de datos personales
document.getElementById('input-importar').addEventListener('change', function(e){
  var file = e.target.files[0];
  if(!file) return;
  if(file.size > TAMAÑO_MAX_IMPORTACION){
    toast('El archivo es demasiado grande ('+Math.round(file.size/1024/1024)+' MB). Máximo 15 MB.', true);
    e.target.value = '';
    return;
  }
  var lector = new FileReader();
  lector.onload = function(){
    var bruto;
    try{ bruto = JSON.parse(lector.result); }
    catch(err){ toast('El archivo no es un JSON válido.', true); e.target.value=''; return; }
    var problemasForma = validarFormaDatos(bruto);
    if(problemasForma.length){
      toast('Formato no reconocido: '+problemasForma[0], true);
      e.target.value=''; return;
    }
    if(!Array.isArray(bruto.viajes) && !Array.isArray(bruto.cargas) && !Array.isArray(bruto.gastos)){
      toast('El archivo no parece una copia de Mi Tesla.', true);
      e.target.value=''; return;
    }
    var r = sanearImportacion(bruto);
    var versionOrigen = bruto.schema_version || 1;
    var resumen = r.validos+' elemento(s) válido(s)'+(r.rechazados?', '+r.rechazados+' descartado(s) por formato no válido':'')+
      '. Versión del archivo: '+versionOrigen+' (se migra a la '+SCHEMA_VERSION+').'+
      (r.avisos.length ? '\n'+r.avisos.join(' ') : '');
    confirmarAccion('Importar datos', 'Se reemplazarán los datos actuales de este dispositivo por los del archivo. '+resumen, function(){
      DATOS = conservarBusinessCanonical(r.datos);
      guardarDatos(true); // se guarda localmente sin disparar la sincronización automática todavía
      renderDashboard(); renderCargas(); renderViajes(); renderBateria(); renderGastos(); renderEstadisticas(); renderAjustes();
      renderLugares(); renderPlanes(); renderNeumaticos(); renderMantenimiento(); renderDocumentos(); renderAccesorios();
      if(mapaLeaflet) pintarFavoritosEnMapa();
      toast('Datos importados en este dispositivo');
      var cfg = cargarConfigGithub();
      if(cfg.repo && cfg.token){
        confirmarAccion('¿Sincronizar con GitHub?', 'Puedes dejar la importación solo en este dispositivo, o sincronizarla ahora para que se propague al resto. "Cancelar" la deja solo aquí.', function(){
          sincronizarGithub({ silencioso:false });
        }, 'Importar y sincronizar');
      }
    }, 'Importar');
    e.target.value = '';
  };
  lector.onerror = function(){
    toast('No se pudo leer el archivo.', true);
    e.target.value = '';
  };
  lector.readAsText(file);
});

/* ---------- Filtros de tipo en Cargas ---------- */
document.getElementById('filtros-cargas').addEventListener('click', function(e){
  var btn = e.target.closest('button[data-filtro]');
  if(!btn) return;
  filtroCargaActivo = btn.dataset.filtro;
  document.querySelectorAll('#filtros-cargas button').forEach(function(b){ b.classList.toggle('on', b===btn); });
  renderCargas();
});
/* Punto 26 de la auditoría: evitar recalcular la lista entera en cada pulsación de tecla al
 * buscar — se agrupan varias pulsaciones seguidas en un único render, 150ms después de la última. */
function debounce(fn, ms){
  var t = null;
  return function(){
    var args = arguments, ctx = this;
    clearTimeout(t);
    t = setTimeout(function(){ fn.apply(ctx, args); }, ms);
  };
}
document.getElementById('buscar-cargas').addEventListener('input', debounce(function(){ renderCargas(); }, 150));

/* ---------- Filtros de periodo en Viajes ---------- */
document.getElementById('filtros-viajes').addEventListener('click', function(e){
  var btn = e.target.closest('button[data-filtro]');
  if(!btn) return;
  filtroViajeActivo = btn.dataset.filtro;
  document.querySelectorAll('#filtros-viajes button').forEach(function(b){ b.classList.toggle('on', b===btn); });
  renderViajes();
});
document.getElementById('buscar-viajes').addEventListener('input', debounce(function(){ renderViajes(); }, 150));
document.getElementById('buscar-accesorios').addEventListener('input', debounce(function(){ renderAccesorios(); }, 150));
document.getElementById('buscar-recordatorios').addEventListener('input', debounce(function(){ renderRecordatorios(); }, 150));
document.getElementById('buscar-gastos').addEventListener('input', debounce(function(){ renderGastos(); }, 150));
document.getElementById('filtros-accesorios').addEventListener('click', function(e){
  var btn = e.target.closest('button[data-filtro]');
  if(!btn) return;
  filtroAccesorioActivo = btn.dataset.filtro;
  document.querySelectorAll('#filtros-accesorios button').forEach(function(b){ b.classList.toggle('on', b===btn); });
  renderAccesorios();
});

/* ---------- Selector manual de estado (hasta tener conexión real con Tesla) ---------- */
document.getElementById('estado-selector').addEventListener('click', function(e){
  var btn = e.target.closest('button[data-estado]');
  if(!btn) return;
  DATOS.vehiculo.estado = btn.dataset.estado;
  guardarDatos();
  renderDashboard();
});

/* ---------- Toast y modal de confirmación propios ---------- */
var toastTimer = null;
function toast(msg, esError){
  var el = document.getElementById('toast');
  document.getElementById('toast-texto').textContent = msg;
  el.classList.toggle('error', !!esError);
  el.classList.remove('con-accion');
  var btnAccion = document.getElementById('toast-accion');
  if(btnAccion) btnAccion.style.display = 'none';
  // Los errores importantes se anuncian como alert (interrumpe), las confirmaciones como status (no interrumpe).
  el.setAttribute('role', esError ? 'alert' : 'status');
  el.setAttribute('aria-live', esError ? 'assertive' : 'polite');
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ el.classList.remove('on'); }, 2600);
}
function confirmarAccion(titulo, texto, onConfirmar, textoBoton, seguro){
  document.getElementById('modal-titulo').textContent = titulo;
  document.getElementById('modal-texto').textContent = texto;
  var fondo = document.getElementById('modal-fondo');
  var caja = document.getElementById('modal-caja');
  var focoAnterior = document.activeElement; // se restaura al cerrar (punto 9: restaurar foco al elemento original)
  fondo.classList.add('on');
  var btnOk = document.getElementById('modal-confirmar');
  var btnNo = document.getElementById('modal-cancelar');
  btnOk.textContent = textoBoton || 'Eliminar';
  btnOk.style.background = seguro ? 'var(--acc2)' : 'var(--acc)'; // rojo salvo que se marque explícitamente como acción no destructiva

  function focosDelModal(){ return [btnNo, btnOk]; } // orden real en el DOM
  function atraparFoco(e){
    if(e.key !== 'Tab') return;
    var f = focosDelModal();
    var primero = f[0], ultimo = f[f.length-1];
    if(e.shiftKey && document.activeElement === primero){ e.preventDefault(); ultimo.focus(); }
    else if(!e.shiftKey && document.activeElement === ultimo){ e.preventDefault(); primero.focus(); }
  }
  function teclado(e){
    if(e.key === 'Escape'){ e.preventDefault(); cerrar(); }
    else atraparFoco(e);
  }
  function cerrar(){
    fondo.classList.remove('on');
    btnOk.removeEventListener('click', ok);
    btnNo.removeEventListener('click', cerrar);
    document.removeEventListener('keydown', teclado, true);
    if(focoAnterior && typeof focoAnterior.focus==='function') focoAnterior.focus();
  }
  function ok(){ cerrar(); onConfirmar(); }
  function clicFuera(e){ if(e.target===fondo) cerrar(); }
  var cerrarBase = cerrar;
  cerrar = function(){ cerrarBase(); fondo.removeEventListener('click', clicFuera); };
  btnOk.addEventListener('click', ok);
  btnNo.addEventListener('click', cerrar);
  fondo.addEventListener('click', clicFuera);
  document.addEventListener('keydown', teclado, true);
  // Foco inicial en Cancelar: es la opción segura por defecto para una acción potencialmente destructiva.
  setTimeout(function(){ btnNo.focus(); }, 0);
}

/* ---------- Versión de la app instalada (para saber si está al día) ---------- */
var APP_VERSION = '2026.10.09-no-car-session';

/* ---------- Modelo de datos (semilla + localStorage) ---------- */
var SCHEMA_VERSION = 2;
function nuevoId(){
  if(typeof crypto!=='undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-'+Date.now()+'-'+Math.random().toString(36).slice(2,10);
}
function ahoraISO(){ return new Date().toISOString(); }
function idDispositivo(){
  var id = localStorage.getItem('mitesla-device-id');
  if(!id){ id = nuevoId(); localStorage.setItem('mitesla-device-id', id); }
  return id;
}
/* Añade/actualiza created_at y updated_at a un objeto que se va a guardar.
   Si "existente" se pasa, es una edición: conserva su created_at original.
   Si no, es un alta nueva: genera id nuevo y created_at = ahora. */
function conTimestamps(datos, existente){
  var ahora = ahoraISO();
  if(existente){ datos.created_at = existente.created_at || ahora; }
  else { datos.id = nuevoId(); datos.created_at = ahora; }
  datos.updated_at = ahora;
  return datos;
}
var SEED = {
  data_mode: 'demo',
  vehiculo: { modelo:'Model Y Premium Dual Motor Long Range', capacidad_nominal_kwh: 75, autonomia_wltp_km: 525, fecha_compra: '2026-01-15', odometro_km: 18240, estado: 'aparcado' },
  referencia_gasolina: { consumo_l_100km: 7.0, precio_litro: 1.55 },
  bateria_historico: [
    { fecha:'2026-01-15', capacidad_pct:100 },
    { fecha:'2026-03-15', capacidad_pct:99.4 },
    { fecha:'2026-05-15', capacidad_pct:98.6 },
    { fecha:'2026-07-15', capacidad_pct:98.0 },
    { fecha:'2026-09-01', capacidad_pct:97.3 }
  ],
  viajes: [
    { id:'v001', fecha:'2026-09-12T09:12', origen:'Gijón', destino:'Oviedo', km:28.4, duracion_min:31, bateria_inicial:82, bateria_final:76 },
    { id:'v002', fecha:'2026-09-11T19:47', origen:'Oviedo', destino:'Gijón', km:28.1, duracion_min:29, bateria_inicial:88, bateria_final:82 },
    { id:'v003', fecha:'2026-09-08T07:20', origen:'Casa', destino:'Aeropuerto de Asturias', km:62.7, duracion_min:46, bateria_inicial:95, bateria_final:82 }
  ],
  cargas: [
    { id:'c001', fecha:'2026-09-10T23:10', lugar:'Casa', tipo:'domestica', kwh:22.4, precio_kwh:0.16, bateria_inicial:32, bateria_final:80 },
    { id:'c002', fecha:'2026-09-06T12:05', lugar:'Supercharger Gijón', tipo:'supercharger', kwh:41.2, precio_kwh:0.35, bateria_inicial:18, bateria_final:90 }
  ],
  gastos: [
    { id:'g001', fecha:'2026-03-01', categoria:'seguro', concepto:'Seguro anual', importe:620 },
    { id:'g002', fecha:'2026-07-15', categoria:'neumaticos', concepto:'4 neumáticos', importe:780 }
  ],
  recordatorios: [
    { id:'r001', concepto:'Rotación / cambio de neumáticos', km_objetivo:40000 },
    { id:'r002', concepto:'Revisión de frenos', km_objetivo:60000 }
  ],
  neumaticos: {
    delanteros: { fecha_instalacion:'2026-01-15', km_instalacion:0, vida_util_km:45000 },
    traseros: { fecha_instalacion:'2026-01-15', km_instalacion:0, vida_util_km:45000 }
  },
  accesorios: [
    { id:'a001', nombre:'Alfombrillas todo tiempo', categoria:'proteccion', fecha:'2026-01-20', precio:89 },
    { id:'a002', nombre:'Cable Type 2 portátil', categoria:'carga', fecha:'2026-02-03', precio:145 }
  ],
  seguro: { fecha_renovacion: '2027-03-01' },
  itv: { fecha: '2027-06-10' },
  planes: [],
  favoritos: []
};
var COLECCIONES_SYNC = ['viajes','cargas','gastos','recordatorios','accesorios','planes','favoritos','bateria_historico','plantillas_viaje','neumaticos_historico','mantenimiento','documentos'];

/* Punto 14.24 de la auditoría Fase 2: un dispositivo nuevo, sin nada guardado todavía, arranca
 * realmente vacío — sin viajes, cargas ni historial de batería de ejemplo, y con el odómetro a 0
 * en vez de aparentar un coche ya usado. Solo se mantiene un modelo/capacidad de batería por
 * defecto razonable (Model Y Long Range, la configuración más común) para que los cálculos no se
 * queden a 0 antes de que el usuario ajuste su vehículo real en Ajustes — no es "actividad" falsa,
 * es una ficha técnica de partida, igual que cualquier app pide una configuración inicial. */
function datosVaciosIniciales(){
  var ahoraFecha = fechaLocalISO();
  return {
    schema_version: SCHEMA_VERSION,
    data_mode: 'real',
    vehiculo: { modelo:'Model Y Long Range', capacidad_nominal_kwh:75, autonomia_wltp_km:525, fecha_compra: ahoraFecha, odometro_km:0, estado:'aparcado', updated_at: ahoraISO() },
    referencia_gasolina: { consumo_l_100km: 7.0, precio_litro: 1.55 },
    bateria_historico: [],
    viajes: [], cargas: [], gastos: [], recordatorios: [],
    neumaticos: { delanteros:{fecha_instalacion:ahoraFecha,km_instalacion:0,vida_util_km:45000}, traseros:{fecha_instalacion:ahoraFecha,km_instalacion:0,vida_util_km:45000} },
    accesorios: [], seguro: { fecha_renovacion:'' }, itv: { fecha:'' }, planes: [], favoritos: [],
    plantillas_viaje: [],
    neumaticos_historico: [], mantenimiento: [], documentos: [],
    _borrados: {}
  };
}

/* Rellena valores por defecto que puedan faltar. IMPORTANTE: una colección
   vacía de verdad (el usuario borró todas sus lecturas/viajes/etc.) se deja
   vacía — nunca se reinyectan aquí los datos de ejemplo (SEED) solo porque
   el array esté a 0; eso resucitaría datos demo sobre datos reales. La
   semilla solo se usa al crear una instalación nueva desde cero, en
   cargarDatos(). */
function normalizarValoresPorDefecto(d){
  if(d.vehiculo && !d.vehiculo.modelo) d.vehiculo.modelo = 'Model Y Premium Dual Motor Long Range';
  // Punto de partida del seguimiento de ahorro/coste por km: se fija UNA sola vez, la primera vez que
  // se ve este dataset, al odómetro que hubiera en ese momento. Así el ahorro estimado solo se calcula
  // sobre los km recorridos desde que se empezó a usar la app, no se extrapola a toda la vida del coche.
  if(d.vehiculo && !d.vehiculo.tracking_started_at){
    d.vehiculo.tracking_started_at = ahoraISO();
    d.vehiculo.odometer_at_tracking_start = d.vehiculo.odometro_km || 0;
  }
  if(!d.recordatorios) d.recordatorios = [];
  // Punto 14.24: estos rellenos son para un dataset REAL al que le falta un campo (p. ej. una
  // importación incompleta o corrupta) — nunca deben inyectar la semilla de demo (SEED) con su
  // historial de ejemplo; se usan los mismos valores neutros que datosVaciosIniciales().
  if(!d.neumaticos) d.neumaticos = JSON.parse(JSON.stringify(datosVaciosIniciales().neumaticos));
  if(!d.accesorios) d.accesorios = [];
  if(!d.seguro) d.seguro = { fecha_renovacion: '' };
  if(!d.itv) d.itv = { fecha: '' };
  if(!d.planes) d.planes = [];
  if(!d.favoritos) d.favoritos = [];
  if(!d.bateria_historico) d.bateria_historico = [];
  if(!d.plantillas_viaje) d.plantillas_viaje = []; // Fase 3, punto 9
  if(!d.neumaticos_historico) d.neumaticos_historico = []; // Fase 3, punto 23
  if(!d.mantenimiento) d.mantenimiento = []; // Fase 3, punto 24
  if(!d.documentos) d.documentos = []; // Fase 3, punto 25 (solo metadatos, nunca el archivo)
  if(!d.vehiculo) d.vehiculo = JSON.parse(JSON.stringify(datosVaciosIniciales().vehiculo));
  if(!d.referencia_gasolina) d.referencia_gasolina = JSON.parse(JSON.stringify(datosVaciosIniciales().referencia_gasolina));
  if(!d.gastos) d.gastos = [];
  if(!d.viajes) d.viajes = [];
  if(!d.cargas) d.cargas = [];
  if(!d._borrados) d._borrados = {};
  COLECCIONES_SYNC.forEach(function(col){
    if(!d._borrados[col]) d._borrados[col] = {};
  });
  if(!d.data_mode) d.data_mode = 'real'; // si no se sabe, se asume real por precaución (no se borra nada solo)
  return d;
}

/** Convierte una fecha (o fecha+hora) en ISO 8601 completo, lo mejor posible,
 *  para usar como created_at/updated_at de respaldo en datos migrados. */
function comoISOAproximado(fechaTexto){
  if(!fechaTexto) return ahoraISO();
  var d = /^\d{4}-\d{2}-\d{2}$/.test(fechaTexto) ? new Date(fechaTexto+'T00:00:00') : new Date(fechaTexto);
  return isNaN(d.getTime()) ? ahoraISO() : d.toISOString();
}

/** Migración de esquema v1 (sin versionar) a v2: añade id/created_at/updated_at
 *  a cada entidad que no los tenga, pasa las tumbas de número (Date.now())
 *  a ISO 8601, y añade schema_version/dataset_id/data_mode al conjunto.
 *  Los backups y JSON antiguos (sin ninguno de estos campos) se migran solos
 *  al cargarlos: no se pierde ningún dato, solo se completan metadatos. */
function migrarV1aV2(d){
  COLECCIONES_SYNC.forEach(function(col){
    (d[col]||[]).forEach(function(x){
      if(!x.id) x.id = nuevoId();
      if(!x.created_at) x.created_at = comoISOAproximado(x.fecha);
      if(!x.updated_at) x.updated_at = x.created_at;
    });
  });
  // Fase 3, punto 6: modelo de cargas ampliado — campos nuevos, todos opcionales, se rellenan con
  // valores neutros (null, nunca inventados) en cargas creadas antes de esta fase. No se sobrescribe
  // ningún campo ya existente ni se pierde ningún dato: es puramente aditivo.
  (d.cargas||[]).forEach(function(c){
    if(c.ac_dc===undefined) c.ac_dc = null;
    if(c.red===undefined) c.red = null;
    if(c.potencia_max_kw===undefined) c.potencia_max_kw = null;
    // B23: si a esta carga (previa a la existencia de total_cost) le faltara kwh o precio_kwh, no
    // se inventa un 0 para poder "completar" el cálculo — se deja total_cost en null (desconocido).
    if(c.total_cost===undefined){
      var kwhNum = typeof c.kwh==='number' && isFinite(c.kwh) ? c.kwh : null;
      var precioNum = typeof c.precio_kwh==='number' && isFinite(c.precio_kwh) ? c.precio_kwh : null;
      c.total_cost = (kwhNum!==null && precioNum!==null) ? Math.round(kwhNum*precioNum*100)/100 : null;
    }
    if(c.cost_source===undefined) c.cost_source = (c.total_cost===null) ? 'desconocido' : 'estimado';
    if(c.data_source===undefined) c.data_source = 'manual';
    if(c.notas===undefined) c.notas = '';
    if(c.vehicle_id===undefined) c.vehicle_id = null;
    if(c.fecha_fin===undefined) c.fecha_fin = null;
    if(c.perdidas_pct===undefined) c.perdidas_pct = null;
    if(c.kwh_red_estimado===undefined) c.kwh_red_estimado = null;
    if(c.origen_energia===undefined) c.origen_energia = null;
  });
  ['vehiculo','referencia_gasolina','neumaticos','seguro','itv'].forEach(function(k){
    if(d[k] && !d[k].updated_at) d[k].updated_at = ahoraISO();
  });
  if(d._borrados){
    Object.keys(d._borrados).forEach(function(col){
      Object.keys(d._borrados[col]).forEach(function(id){
        var v = d._borrados[col][id];
        if(typeof v === 'number') d._borrados[col][id] = new Date(v).toISOString();
      });
    });
  }
  if(!d.dataset_id) d.dataset_id = nuevoId();
  if(!d.data_mode) d.data_mode = 'real';
  d.schema_version = SCHEMA_VERSION;
  return d;
}

/** Comprobación mínima de forma — usada tras cargar y, más estrictamente, al importar un JSON. */
function validarFormaDatos(d){
  var problemas = [];
  if(!d || typeof d!=='object') return ['El contenido no es un objeto JSON válido.'];
  COLECCIONES_SYNC.forEach(function(col){
    if(d[col]!==undefined && !Array.isArray(d[col])) problemas.push('"'+col+'" debería ser una lista.');
  });
  ['vehiculo','referencia_gasolina','neumaticos','seguro','itv'].forEach(function(k){
    if(d[k]!==undefined && (typeof d[k]!=='object' || Array.isArray(d[k]))) problemas.push('"'+k+'" debería ser un objeto.');
  });
  return problemas;
}

var ID_SEGURO = /^[A-Za-z0-9_-]{1,80}$/;
var TIPOS_CARGA_VALIDOS = ['domestica','supercharger','publico','trabajo','otros'];
var CATEGORIAS_GASTO_VALIDAS = ['seguro','neumaticos','mantenimiento','itv','accesorio','otros','multa','limpieza','parking','peaje'];
// B23: 'desconocido' es un cost_source legítimo — una carga importada/automática sin precio
// fiable NUNCA se etiqueta 'estimado' (eso implicaría que hay una estimación real detrás).
var COST_SOURCE_VALIDOS = ['conocido','estimado','facturado','desconocido'];
var CATEGORIAS_MANTENIMIENTO_VALIDAS = ['neumaticos','filtros','frenos','escobillas','reparacion','revision','itv','seguro','otros'];

/** Convierte cualquier valor en un string seguro y acotado (nunca objetos/arrays,
 *  nunca más largo de lo razonable) — así un JSON manipulado no puede colar un
 *  objeto donde se espera texto, ni un texto kilométrico. */
function comoTextoSeguro(v, maxLen){
  if(v===null || v===undefined) return '';
  var s = (typeof v==='object') ? '' : String(v);
  return s.slice(0, maxLen||300);
}
/** Convierte a número finito dentro de un rango; si no es válido, usa el valor por defecto. */
function comoNumeroSeguro(v, min, max, porDefecto){
  var n = typeof v==='number' ? v : parseFloat(v);
  if(!isFinite(n)) return porDefecto;
  if(min!==undefined && n<min) return porDefecto;
  if(max!==undefined && n>max) return porDefecto;
  return n;
}
/** Un id que no tenga un formato seguro (p. ej. viene de un JSON manipulado a mano)
 *  se sustituye por uno nuevo generado aquí — los ids se insertan en atributos
 *  data-* sin escapar en varias vistas, así que esto es lo que evita que un id
 *  con comillas o < > pueda inyectar HTML/atributos. */
function idSeguro(v){
  var s = comoTextoSeguro(v, 80);
  return ID_SEGURO.test(s) ? s : nuevoId();
}
function fechaValidaOFallback(v, fallbackISO){
  var s = comoTextoSeguro(v, 40);
  var d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s+'T00:00:00' : s);
  return isNaN(d.getTime()) ? fallbackISO : s;
}

/* C1 (FASE C, auditoría de seguridad frontend) — saneadores por colección, UNA sola vez.
 * Antes vivían como funciones anónimas solo dentro de sanearImportacion() (usada al importar un
 * .json a mano), así que cualquier dato que entrase por OTRA vía externa —el remoto de GitHub en
 * sincronizarGithub()/fusionarDatos()— se fusionaba SIN pasar por idSeguro()/comoTextoSeguro()/
 * comoNumeroSeguro(). El texto libre (origen, concepto, nombre…) ya se escapaba con esc() al
 * pintarlo, pero el id NO: se usa tal cual en atributos HTML como data-editar-viaje="'+v.id+'" en
 * más de 30 sitios. Un datos.json remoto manipulado (repo comprometido, o simplemente compartido)
 * con un viaje cuyo id fuese, por ejemplo, algo terminado en ">*+ podía romper el atributo e
 * inyectar HTML/JS al renderizar — "no depender únicamente de esc()" (auditoría). LA CORRECCIÓN
 * DE ARQUITECTURA (no un parche): un único saneador por colección, reutilizado tanto al importar
 * como al fusionar el remoto de GitHub (ver fusionarPorId más abajo) — un solo sitio que decide
 * qué es un dato válido, nunca dos copias de la misma validación que puedan divergir. */
var SANEADOR_ITEM = {
  viajes: function(v){
    var km = comoNumeroSeguro(v.km, 0, 5000, null);
    if(km===null) return null;
    return { id: idSeguro(v.id), fecha: comoTextoSeguro(v.fecha,30), origen: comoTextoSeguro(v.origen,150), destino: comoTextoSeguro(v.destino,150),
      km: km, duracion_min: comoNumeroSeguro(v.duracion_min,0,1440,0),
      bateria_inicial: comoNumeroSeguro(v.bateria_inicial,0,100,null), bateria_final: comoNumeroSeguro(v.bateria_final,0,100,null),
      etiqueta: comoTextoSeguro(v.etiqueta,40), conductor: comoTextoSeguro(v.conductor,80),
      created_at: comoTextoSeguro(v.created_at,40)||ahoraISO(), updated_at: comoTextoSeguro(v.updated_at,40)||ahoraISO() };
  },
  cargas: function(c){
    var kwh = comoNumeroSeguro(c.kwh, 0, 500, null);
    if(kwh===null) return null;
    // B23: sin precio válido, NO se inventa 0 €/kWh (antes: comoNumeroSeguro(...,0) fabricaba una
    // carga "gratis" a partir de un dato simplemente ausente — norma "null ≠ 0").
    var precio = comoNumeroSeguro(c.precio_kwh,0,5,null);
    var totalPorDefecto = (precio!==null) ? Math.round(kwh*precio*100)/100 : null;
    var totalCost = comoNumeroSeguro(c.total_cost,0,100000, totalPorDefecto);
    if(typeof c.total_cost==='number' && isFinite(c.total_cost)) totalCost = c.total_cost; // el propio dato manda si es válido, aunque no haya precio_kwh fiable (p.ej. factura real)
    return { id: idSeguro(c.id), fecha: comoTextoSeguro(c.fecha,30), lugar: comoTextoSeguro(c.lugar,150),
      tipo: TIPOS_CARGA_VALIDOS.indexOf(c.tipo)!==-1 ? c.tipo : 'otros',
      kwh: kwh, precio_kwh: precio,
      bateria_inicial: comoNumeroSeguro(c.bateria_inicial,0,100,null), bateria_final: comoNumeroSeguro(c.bateria_final,0,100,null),
      ac_dc: (c.ac_dc==='AC'||c.ac_dc==='DC') ? c.ac_dc : null,
      red: comoTextoSeguro(c.red,150) || null,
      potencia_max_kw: comoNumeroSeguro(c.potencia_max_kw,0,1000,null),
      total_cost: totalCost,
      cost_source: COST_SOURCE_VALIDOS.indexOf(c.cost_source)!==-1 ? c.cost_source : (totalCost===null ? 'desconocido' : 'estimado'),
      // B13: si no se preservan estos 3 campos al importar/fusionar, una carga ya reconciliada con
      // su factura real volvería a aparecer como "sin reconciliar" tras una copia de seguridad o una
      // sincronización — justo la corrección manual que la norma dice que nunca debe perderse.
      factura_reconciliada: c.factura_reconciliada===true,
      factura_numero: comoTextoSeguro(c.factura_numero,80) || null,
      factura_fecha: comoTextoSeguro(c.factura_fecha,30) || null,
      data_source: comoTextoSeguro(c.data_source,40) || 'manual',
      notas: comoTextoSeguro(c.notas,300),
      vehicle_id: comoTextoSeguro(c.vehicle_id,80) || null,
      fecha_fin: comoTextoSeguro(c.fecha_fin,30) || null,
      perdidas_pct: comoNumeroSeguro(c.perdidas_pct,0,99,null),
      kwh_red_estimado: comoNumeroSeguro(c.kwh_red_estimado,0,1000,null),
      origen_energia: (c.origen_energia && typeof c.origen_energia==='object') ? {
        red_pct: comoNumeroSeguro(c.origen_energia.red_pct,0,100,100),
        solar_pct: comoNumeroSeguro(c.origen_energia.solar_pct,0,100,0),
        bateria_pct: comoNumeroSeguro(c.origen_energia.bateria_pct,0,100,0),
        coste_contable: comoNumeroSeguro(c.origen_energia.coste_contable,0,100000,0),
        coste_marginal: comoNumeroSeguro(c.origen_energia.coste_marginal,0,100000,0),
        ahorro_frente_a_red: comoNumeroSeguro(c.origen_energia.ahorro_frente_a_red,0,100000,0)
      } : null,
      created_at: comoTextoSeguro(c.created_at,40)||ahoraISO(), updated_at: comoTextoSeguro(c.updated_at,40)||ahoraISO() };
  },
  gastos: function(g){
    var importe = comoNumeroSeguro(g.importe, -100000, 1000000, null);
    if(importe===null) return null;
    return { id: idSeguro(g.id), fecha: comoTextoSeguro(g.fecha,30),
      categoria: CATEGORIAS_GASTO_VALIDAS.indexOf(g.categoria)!==-1 ? g.categoria : 'otros',
      concepto: comoTextoSeguro(g.concepto,150), importe: importe,
      created_at: comoTextoSeguro(g.created_at,40)||ahoraISO(), updated_at: comoTextoSeguro(g.updated_at,40)||ahoraISO() };
  },
  plantillas_viaje: function(p){
    if(!comoTextoSeguro(p.destino,150)) return null;
    return { id: idSeguro(p.id), origen: comoTextoSeguro(p.origen,150), destino: comoTextoSeguro(p.destino,150),
      etiqueta: ['personal','trabajo','otro'].indexOf(p.etiqueta)!==-1 ? p.etiqueta : 'personal',
      conductor: comoTextoSeguro(p.conductor,80), notas: comoTextoSeguro(p.notas,200),
      km_aprox: comoNumeroSeguro(p.km_aprox,0,5000,null),
      created_at: comoTextoSeguro(p.created_at,40)||ahoraISO(), updated_at: comoTextoSeguro(p.updated_at,40)||ahoraISO() };
  },
  neumaticos_historico: function(h){
    var odoIni = comoNumeroSeguro(h.odometer_install, 0, 2000000, null);
    if(odoIni===null || ['delanteros','traseros'].indexOf(h.eje)===-1) return null;
    return { id: idSeguro(h.id), marca: comoTextoSeguro(h.marca,80), modelo: comoTextoSeguro(h.modelo,80),
      medida: comoTextoSeguro(h.medida,40), eje: h.eje,
      installed_at: comoTextoSeguro(h.installed_at,30), odometer_install: odoIni,
      removed_at: comoTextoSeguro(h.removed_at,30) || null, odometer_remove: comoNumeroSeguro(h.odometer_remove,0,2000000,null),
      purchase_price: comoNumeroSeguro(h.purchase_price,0,100000,null), notes: comoTextoSeguro(h.notes,200),
      created_at: comoTextoSeguro(h.created_at,40)||ahoraISO(), updated_at: comoTextoSeguro(h.updated_at,40)||ahoraISO() };
  },
  mantenimiento: function(m){
    if(!comoTextoSeguro(m.concepto,150)) return null;
    return { id: idSeguro(m.id), categoria: CATEGORIAS_MANTENIMIENTO_VALIDAS.indexOf(m.categoria)!==-1 ? m.categoria : 'otros',
      concepto: comoTextoSeguro(m.concepto,150), fecha: comoTextoSeguro(m.fecha,30), odometro_km: comoNumeroSeguro(m.odometro_km,0,2000000,null),
      coste: comoNumeroSeguro(m.coste,0,100000,0), notas: comoTextoSeguro(m.notas,300),
      recordatorio_fecha: comoTextoSeguro(m.recordatorio_fecha,30) || null, recordatorio_km: comoNumeroSeguro(m.recordatorio_km,0,2000000,null),
      created_at: comoTextoSeguro(m.created_at,40)||ahoraISO(), updated_at: comoTextoSeguro(m.updated_at,40)||ahoraISO() };
  },
  documentos: function(doc){
    if(!comoTextoSeguro(doc.nombre,150)) return null;
    return { id: idSeguro(doc.id), nombre: comoTextoSeguro(doc.nombre,150), tipo: comoTextoSeguro(doc.tipo,40),
      fecha: comoTextoSeguro(doc.fecha,30), tamano_bytes: comoNumeroSeguro(doc.tamano_bytes,0,1000000000,null),
      relacionado_con: comoTextoSeguro(doc.relacionado_con,80) || null, notas: comoTextoSeguro(doc.notas,300),
      created_at: comoTextoSeguro(doc.created_at,40)||ahoraISO(), updated_at: comoTextoSeguro(doc.updated_at,40)||ahoraISO() };
  },
  recordatorios: function(r){
    var km = comoNumeroSeguro(r.km_objetivo, 0, 2000000, null);
    if(km===null || !comoTextoSeguro(r.concepto,150)) return null;
    return { id: idSeguro(r.id), concepto: comoTextoSeguro(r.concepto,150), km_objetivo: km,
      created_at: comoTextoSeguro(r.created_at,40)||ahoraISO(), updated_at: comoTextoSeguro(r.updated_at,40)||ahoraISO() };
  },
  accesorios: function(a){
    if(!comoTextoSeguro(a.nombre,150)) return null;
    return { id: idSeguro(a.id), nombre: comoTextoSeguro(a.nombre,150), categoria: comoTextoSeguro(a.categoria,40)||'otros',
      fecha: comoTextoSeguro(a.fecha,30), precio: comoNumeroSeguro(a.precio,0,1000000,0),
      meses_garantia: comoNumeroSeguro(a.meses_garantia,0,600,null),
      created_at: comoTextoSeguro(a.created_at,40)||ahoraISO(), updated_at: comoTextoSeguro(a.updated_at,40)||ahoraISO() };
  },
  planes: function(p){
    if(!comoTextoSeguro(p.nombre,150)) return null;
    return Object.assign({}, p, { id: idSeguro(p.id), nombre: comoTextoSeguro(p.nombre,150),
      created_at: comoTextoSeguro(p.created_at,40)||ahoraISO(), updated_at: comoTextoSeguro(p.updated_at,40)||ahoraISO() });
  },
  favoritos: function(f){
    var lat = comoNumeroSeguro(f.lat,-90,90,null), lng = comoNumeroSeguro(f.lng,-180,180,null);
    if(lat===null || lng===null) return null;
    return { id: idSeguro(f.id), nombre: comoTextoSeguro(f.nombre,150), lat: lat, lng: lng,
      created_at: comoTextoSeguro(f.created_at,40)||ahoraISO(), updated_at: comoTextoSeguro(f.updated_at,40)||ahoraISO() };
  },
  bateria_historico: function(h){
    var pct = comoNumeroSeguro(h.capacidad_pct, 0, 100, null);
    if(pct===null) return null;
    return { id: idSeguro(h.id), fecha: comoTextoSeguro(h.fecha,30), capacidad_pct: pct,
      created_at: comoTextoSeguro(h.created_at,40)||ahoraISO(), updated_at: comoTextoSeguro(h.updated_at,40)||ahoraISO() };
  }
};

/** Saneado profundo de un JSON importado: recorre cada colección y campo,
 *  fuerza tipos y rangos razonables, sustituye ids con formato inseguro, y
 *  descarta cualquier cosa que no encaje — nunca deja pasar un objeto/array
 *  donde se espera un texto o número. Devuelve { datos, avisos, rechazados }. */
function sanearImportacion(bruto){
  var avisos = [];
  var rechazados = 0;
  var hoy = fechaLocalISO();

  function limpiarLista(lista, limpiarUno, tope){
    if(!Array.isArray(lista)) return [];
    if(lista.length > tope){ avisos.push('Se han ignorado '+(lista.length-tope)+' elementos por superar el máximo de '+tope+'.'); lista = lista.slice(0, tope); }
    var out = [];
    lista.forEach(function(x){
      if(!x || typeof x!=='object'){ rechazados++; return; }
      var limpio = limpiarUno(x);
      if(limpio) out.push(limpio); else rechazados++;
    });
    return out;
  }

  var TOPE = 20000;
  var d = {
    schema_version: SCHEMA_VERSION,
    data_mode: (bruto.data_mode==='demo') ? 'demo' : 'real',
    dataset_id: comoTextoSeguro(bruto.dataset_id,80) && ID_SEGURO.test(comoTextoSeguro(bruto.dataset_id,80)) ? bruto.dataset_id : nuevoId(),
    vehiculo: {
      modelo: comoTextoSeguro(bruto.vehiculo && bruto.vehiculo.modelo, 80) || 'Model Y Premium Dual Motor Long Range',
      capacidad_nominal_kwh: comoNumeroSeguro(bruto.vehiculo && bruto.vehiculo.capacidad_nominal_kwh, 1, 300, 75),
      autonomia_wltp_km: comoNumeroSeguro(bruto.vehiculo && bruto.vehiculo.autonomia_wltp_km, 1, 2000, 525),
      fecha_compra: fechaValidaOFallback(bruto.vehiculo && bruto.vehiculo.fecha_compra, hoy),
      odometro_km: comoNumeroSeguro(bruto.vehiculo && bruto.vehiculo.odometro_km, 0, 2000000, 0),
      estado: ['aparcado','circulando','cargando'].indexOf(bruto.vehiculo && bruto.vehiculo.estado)!==-1 ? bruto.vehiculo.estado : 'aparcado',
      casa: (function(){
        var c = bruto.vehiculo && bruto.vehiculo.casa;
        var lat = c ? comoNumeroSeguro(c.lat,-90,90,null) : null;
        var lng = c ? comoNumeroSeguro(c.lng,-180,180,null) : null;
        return (lat!==null && lng!==null) ? { lat:lat, lng:lng } : null;
      })(),
      updated_at: comoTextoSeguro(bruto.vehiculo && bruto.vehiculo.updated_at,40) || ahoraISO()
    },
    referencia_gasolina: {
      consumo_l_100km: comoNumeroSeguro(bruto.referencia_gasolina && bruto.referencia_gasolina.consumo_l_100km, 0, 50, 7),
      precio_litro: comoNumeroSeguro(bruto.referencia_gasolina && bruto.referencia_gasolina.precio_litro, 0, 10, 1.55),
      updated_at: comoTextoSeguro(bruto.referencia_gasolina && bruto.referencia_gasolina.updated_at,40) || ahoraISO()
    },
    seguro: { fecha_renovacion: fechaValidaOFallback(bruto.seguro && bruto.seguro.fecha_renovacion, '') || '', updated_at: comoTextoSeguro(bruto.seguro && bruto.seguro.updated_at,40) || ahoraISO() },
    itv: { fecha: fechaValidaOFallback(bruto.itv && bruto.itv.fecha, '') || '', updated_at: comoTextoSeguro(bruto.itv && bruto.itv.updated_at,40) || ahoraISO() },
    neumaticos: (function(){
      var n = bruto.neumaticos;
      function eje(x, def){
        if(!x || typeof x!=='object') return def;
        return {
          fecha_instalacion: fechaValidaOFallback(x.fecha_instalacion, def.fecha_instalacion),
          km_instalacion: comoNumeroSeguro(x.km_instalacion, 0, 2000000, def.km_instalacion),
          vida_util_km: comoNumeroSeguro(x.vida_util_km, 1, 500000, def.vida_util_km)
        };
      }
      var base = datosVaciosIniciales().neumaticos;
      return {
        delanteros: eje(n && n.delanteros, base.delanteros),
        traseros: eje(n && n.traseros, base.traseros),
        updated_at: comoTextoSeguro(n && n.updated_at,40) || ahoraISO()
      };
    })(),
    _borrados: {}
  };

  // C1: los 12 saneadores por colección viven en SANEADOR_ITEM (una sola definición, ver arriba),
  // reutilizada también por fusionarPorId() al fusionar el remoto de GitHub — ya no hay dos copias
  // de la misma validación que puedan divergir con el tiempo.
  d.viajes = limpiarLista(bruto.viajes, SANEADOR_ITEM.viajes, TOPE);
  d.cargas = limpiarLista(bruto.cargas, SANEADOR_ITEM.cargas, TOPE);
  d.gastos = limpiarLista(bruto.gastos, SANEADOR_ITEM.gastos, TOPE);
  d.plantillas_viaje = limpiarLista(bruto.plantillas_viaje, SANEADOR_ITEM.plantillas_viaje, 2000);
  d.neumaticos_historico = limpiarLista(bruto.neumaticos_historico, SANEADOR_ITEM.neumaticos_historico, TOPE);
  d.mantenimiento = limpiarLista(bruto.mantenimiento, SANEADOR_ITEM.mantenimiento, TOPE);
  d.documentos = limpiarLista(bruto.documentos, SANEADOR_ITEM.documentos, TOPE);
  d.recordatorios = limpiarLista(bruto.recordatorios, SANEADOR_ITEM.recordatorios, 2000);
  d.accesorios = limpiarLista(bruto.accesorios, SANEADOR_ITEM.accesorios, TOPE);
  d.planes = limpiarLista(bruto.planes, SANEADOR_ITEM.planes, 2000);
  d.favoritos = limpiarLista(bruto.favoritos, SANEADOR_ITEM.favoritos, 2000);
  d.bateria_historico = limpiarLista(bruto.bateria_historico, SANEADOR_ITEM.bateria_historico, TOPE);

  if(rechazados>0) avisos.push(rechazados+' elemento(s) se han descartado por no tener un formato válido.');
  return { datos: normalizarDatos(d), avisos: avisos, validos: d.viajes.length+d.cargas.length+d.gastos.length+d.recordatorios.length+d.accesorios.length+d.planes.length+d.favoritos.length+d.bateria_historico.length, rechazados: rechazados };
}

function normalizarDatos(d){
  d = normalizarValoresPorDefecto(d);
  d = migrarV1aV2(d);
  return d;
}

/* Registro de "tumbas" (ids borrados con su fecha ISO) para que una eliminación en un dispositivo
   no resucite el elemento al fusionar con otro dispositivo que todavía lo tenga en su copia local. */
function marcarBorrado(coleccion, id){
  if(!DATOS._borrados) DATOS._borrados = {};
  if(!DATOS._borrados[coleccion]) DATOS._borrados[coleccion] = {};
  DATOS._borrados[coleccion][id] = ahoraISO();
}
// Necesario cuando se vuelve a crear un elemento con un id que ya se había borrado antes (p. ej. un
// cargador favorito con id determinista), para que la fusión no lo vuelva a eliminar por error.
function desmarcarBorrado(coleccion, id){
  if(DATOS._borrados && DATOS._borrados[coleccion]) delete DATOS._borrados[coleccion][id];
}

/* ---------- Fase 3, punto 29: papelera con deshacer ----------
 * Guardada en localStorage, separada de DATOS (igual que los feature flags): es una conveniencia
 * de ESTE dispositivo — no viaja con la sincronización entre dispositivos ni con el backup JSON.
 * El borrado real sigue registrándose como "tumba" en DATOS._borrados (comportamiento ya existente,
 * sin cambios) para que la sincronización no resucite el elemento en otro dispositivo; restaurar
 * desde la papelera simplemente retira esa tumba además de devolver el elemento a su colección. */
var PAPELERA_LIMITE_DIAS = 30;
var COLECCIONES_CON_PAPELERA = ['viajes','cargas','gastos','recordatorios','accesorios','plantillas_viaje','mantenimiento','documentos','bateria_historico'];
function cargarPapelera(){
  try{ var l = JSON.parse(localStorage.getItem('mitesla-papelera')||'[]'); return Array.isArray(l)?l:[]; }catch(e){ return []; }
}
function guardarPapelera(lista){
  try{ localStorage.setItem('mitesla-papelera', JSON.stringify(lista)); }catch(e){ /* almacenamiento local lleno o no disponible: la papelera es una conveniencia, no crítica */ }
}
function purgarPapeleraCaducada(){
  var ahora = Date.now();
  var vigente = [], caducados = [];
  cargarPapelera().forEach(function(p){
    if((ahora-new Date(p.borrado_en).getTime()) < PAPELERA_LIMITE_DIAS*86400000) vigente.push(p); else caducados.push(p);
  });
  guardarPapelera(vigente);
  // Los documentos guardan el archivo real en IndexedDB, no en esta papelera (solo sus metadatos) —
  // se libera ese archivo cuando la entrada caduca de verdad, nunca antes (mientras está en la
  // papelera, el archivo sigue intacto en IndexedDB por si se restaura).
  caducados.forEach(function(p){
    if(p.coleccion==='documentos' && typeof eliminarDocumentoArchivo==='function') eliminarDocumentoArchivo(p.id).catch(function(){});
  });
  return vigente;
}
// Algunas lecturas de batería antiguas no tienen "id" propio (se identificaban solo por fecha) —
// se usa la fecha como clave de repuesto para que la papelera funcione igual con datos antiguos.
function claveItemColeccion(coleccion, item){
  return item.id || (coleccion==='bateria_historico' ? item.fecha : undefined);
}
function moverAPapelera(coleccion, item){
  if(!item) return;
  var lista = purgarPapeleraCaducada();
  lista.unshift({ id:claveItemColeccion(coleccion,item), coleccion:coleccion, item:item, borrado_en:ahoraISO() });
  guardarPapelera(lista);
}
// B24 (FASE B): antes, el objeto restaurado volvía a la colección con su updated_at ORIGINAL (de
// antes de borrarlo) y solo se retiraba la tumba LOCAL de este dispositivo. Si el borrado ya se
// había sincronizado a otro dispositivo/remoto, ese lado conserva su propia tumba con una marca de
// tiempo posterior a la última edición del elemento — y fusionarPorId() solo revive un elemento
// cuando su marca de tiempo es >= la del borrado más reciente conocido (marcaTiempo(mejor) >=
// borradoMax). Con el updated_at antiguo, la próxima sincronización perdía la restauración en
// silencio: el otro dispositivo volvía a "ganar" con su tumba y el elemento reaparecía borrado.
// LA CORRECCIÓN: al restaurar, el elemento recibe un updated_at = ahora, garantizado posterior a
// cualquier tumba que pudiera existir en cualquier dispositivo — así la restauración se propaga de
// verdad en la siguiente sincronización, sin importar cuántos dispositivos tengan la tumba.
function restaurarDePapelera(coleccion, id){
  if(esBusiness(coleccion) && !legacyBusinessPermitido()){
    return mutacionBusiness(coleccion, 'restore:'+id, null, async function(repo){
      var restored = await repo.restaurar(id);
      guardarPapelera(cargarPapelera().filter(function(p){ return !(p.coleccion===coleccion && p.id===id); }));
      registrarCambio(coleccion, 'restaurar', textoResumenCambio(coleccion, restored));
      return true;
    });
  }
  var lista = cargarPapelera();
  var entrada = lista.find(function(p){ return p.coleccion===coleccion && p.id===id; });
  if(!entrada || !DATOS[coleccion]) return false;
  if(DATOS[coleccion].some(function(x){ return claveItemColeccion(coleccion,x)===id; })) return false; // ya estaba restaurado (doble clic en "Deshacer", por ejemplo)
  entrada.item.updated_at = ahoraISO();
  DATOS[coleccion].push(entrada.item);
  desmarcarBorrado(coleccion, id);
  guardarDatos();
  guardarPapelera(lista.filter(function(p){ return p!==entrada; }));
  registrarCambio(coleccion, 'restaurar', textoResumenCambio(coleccion, entrada.item));
  return true;
}
function eliminarDePapeleraDefinitivo(coleccion, id){
  guardarPapelera(cargarPapelera().filter(function(p){ return !(p.coleccion===coleccion && p.id===id); }));
  if(coleccion==='documentos' && typeof eliminarDocumentoArchivo==='function') eliminarDocumentoArchivo(id).catch(function(){});
}
/** Muestra el toast normal pero con un botón "Deshacer" que restaura el elemento recién borrado
 *  y vuelve a pintar las vistas indicadas. Se cierra solo a los pocos segundos, como el toast normal
 *  (más tiempo que el toast informativo, para dar margen real a deshacer). */
function toastDeshacer(msg, coleccion, id, renderFns){
  var el = document.getElementById('toast');
  var btn = document.getElementById('toast-accion');
  document.getElementById('toast-texto').textContent = msg;
  el.classList.remove('error');
  el.setAttribute('role','status'); el.setAttribute('aria-live','polite');
  el.classList.add('on','con-accion');
  btn.style.display = '';
  btn.onclick = async function(){
    if(await restaurarDePapelera(coleccion, id)){
      (renderFns||[]).forEach(function(fn){ fn(); });
      toast('Restaurado');
    }
  };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ el.classList.remove('on','con-accion'); btn.style.display='none'; }, 6000);
}
function renderPapelera(){
  var cont = document.getElementById('lista-papelera');
  if(!cont) return;
  var lista = purgarPapeleraCaducada();
  cont.innerHTML = lista.length ? lista.map(function(p){
    var diasRestantes = PAPELERA_LIMITE_DIAS - Math.floor((Date.now()-new Date(p.borrado_en).getTime())/86400000);
    return '<div class="fila"><div class="fila-tx"><div class="t1">'+esc(NOMBRE_COLECCION_PAPELERA[p.coleccion]||p.coleccion)+' — '+textoResumenCambio(p.coleccion, p.item)+'</div>'+
      '<div class="t2">Eliminado '+fechaCorta(p.borrado_en)+' · se borra definitivamente en '+Math.max(0,diasRestantes)+' día'+(diasRestantes===1?'':'s')+'</div></div>'+
      '<button type="button" class="ver" style="flex:none" data-restaurar-papelera="'+p.coleccion+'|'+p.id+'">Restaurar</button>'+
      '<button type="button" class="btn-borrar" data-borrar-papelera="'+p.coleccion+'|'+p.id+'" data-icon="papelera" aria-label="Eliminar definitivamente"></button>'+
      '</div>';
  }).join('') : '<div class="vacio"><span class="em">🗑️</span><p>La papelera está vacía. Los elementos eliminados se guardan aquí durante '+PAPELERA_LIMITE_DIAS+' días por si hace falta recuperarlos.</p></div>';
  aplicarIconos();
}
var NOMBRE_COLECCION_PAPELERA = { viajes:'Viaje', cargas:'Carga', gastos:'Gasto', recordatorios:'Recordatorio', accesorios:'Accesorio', plantillas_viaje:'Plantilla de viaje', mantenimiento:'Mantenimiento', documentos:'Documento', bateria_historico:'Lectura de batería' };
var RENDER_TRAS_RESTAURAR = {
  viajes: function(){ renderViajes(); renderDashboard(); },
  cargas: function(){ renderCargas(); renderDashboard(); },
  gastos: function(){ renderGastos(); },
  recordatorios: function(){ renderRecordatorios(); },
  accesorios: function(){ renderAccesorios(); },
  plantillas_viaje: function(){ renderPlantillas(); },
  mantenimiento: function(){ renderMantenimiento(); },
  documentos: function(){ renderDocumentos(); },
  bateria_historico: function(){ renderBateria(); renderDashboard(); }
};
document.addEventListener('click', async function(e){
  var restaurar = e.target.closest('[data-restaurar-papelera]');
  if(restaurar){
    var partes = restaurar.dataset.restaurarPapelera.split('|');
    if(await restaurarDePapelera(partes[0], partes[1])){
      (RENDER_TRAS_RESTAURAR[partes[0]]||function(){})();
      renderPapelera();
      toast('Restaurado');
    }
    return;
  }
  var borrarDef = e.target.closest('[data-borrar-papelera]');
  if(borrarDef){
    var p2 = borrarDef.dataset.borrarPapelera.split('|');
    confirmarAccion('Eliminar definitivamente', 'Ya no se podrá recuperar desde la papelera.', function(){
      eliminarDePapeleraDefinitivo(p2[0], p2[1]);
      renderPapelera();
      toast('Eliminado definitivamente');
    });
  }
});

/* ---------- Fase 3, punto 30: historial de cambios (local, de solo lectura) ----------
 * También en localStorage y no sincronizado, por el mismo motivo que la papelera: es una bitácora
 * de ESTE dispositivo, útil para saber "qué pasó" sin pretender ser un historial multi-dispositivo
 * (eso exigiría un backend con el que registrar cada cambio de forma fiable — fuera del alcance
 * de una app estática). Registra creación, edición, eliminación y restauración de las mismas
 * colecciones que tienen papelera. */
var HISTORIAL_CAMBIOS_LIMITE = 300;
function cargarHistorialCambios(){
  try{ var l = JSON.parse(localStorage.getItem('mitesla-historial-cambios')||'[]'); return Array.isArray(l)?l:[]; }catch(e){ return []; }
}
function registrarCambio(coleccion, accion, resumen){
  var lista = cargarHistorialCambios();
  lista.unshift({ fecha: ahoraISO(), coleccion: coleccion, accion: accion, resumen: resumen });
  if(lista.length > HISTORIAL_CAMBIOS_LIMITE) lista = lista.slice(0, HISTORIAL_CAMBIOS_LIMITE);
  try{ localStorage.setItem('mitesla-historial-cambios', JSON.stringify(lista)); }catch(e){}
}
var NOMBRE_ACCION_HISTORIAL = { crear:'Creado', editar:'Editado', eliminar:'Eliminado', restaurar:'Restaurado' };
function renderHistorialCambios(){
  var cont = document.getElementById('lista-historial-cambios');
  if(!cont) return;
  var lista = cargarHistorialCambios();
  cont.innerHTML = lista.length ? lista.slice(0,50).map(function(h){
    return '<div class="fila"><div class="fila-tx"><div class="t1">'+esc(NOMBRE_ACCION_HISTORIAL[h.accion]||h.accion)+' · '+esc(NOMBRE_COLECCION_PAPELERA[h.coleccion]||h.coleccion)+'</div>'+
      '<div class="t2">'+h.resumen+'</div></div><div class="fila-r"><div class="r2">'+tiempoRelativo(h.fecha)+'</div></div></div>';
  }).join('') : '<div class="vacio"><span class="em">📜</span><p>Sin cambios registrados todavía en este dispositivo.</p></div>';
}
/** Resumen corto y humano de un elemento para la papelera y el historial de cambios. */
function textoResumenCambio(coleccion, item){
  if(!item) return '';
  switch(coleccion){
    case 'viajes': return esc(item.origen)+' → '+esc(item.destino)+' ('+item.km+' km)';
    case 'cargas': return esc(item.lugar)+' ('+item.kwh+' kWh)';
    case 'gastos': return esc(item.concepto)+' ('+euros(item.importe)+')';
    case 'recordatorios': return esc(item.concepto);
    case 'accesorios': return esc(item.nombre);
    case 'plantillas_viaje': return esc(item.nombre||((item.origen||'')+' → '+(item.destino||'')));
    case 'mantenimiento': return esc(item.concepto);
    case 'documentos': return esc(item.nombre);
    case 'bateria_historico': return (item.capacidad_pct!=null?item.capacidad_pct+' %':'')+(item.fecha?' · '+fechaCorta(item.fecha):'');
    default: return item.id||'';
  }
}

/* Si el contenido guardado no se puede interpretar, se conserva aquí en crudo
   (nunca se descarta en silencio) para poder avisar, descargarlo o restaurar
   una copia de seguridad en su lugar — ver aviso-datos-dañados en el Dashboard. */
var DATOS_CORRUPTOS = null;
function cargarDatos(){
  var crudo = null;
  try{
    crudo = localStorage.getItem('mitesla-datos');
    if(crudo){
      var guardado = JSON.parse(crudo);
      if(guardado && typeof guardado==='object' && Array.isArray(guardado.cargas) && Array.isArray(guardado.gastos) && Array.isArray(guardado.viajes)){
        return normalizarDatos(guardado);
      }
      DATOS_CORRUPTOS = crudo; // había algo guardado, pero no tiene la forma mínima esperada
    }
  }catch(e){
    DATOS_CORRUPTOS = crudo;
    console.error('mitesla-datos no se pudo interpretar:', e);
  }
  // Instalación nueva sin nada guardado: arranca vacía de verdad (punto 14.24 de la auditoría
  // Fase 2), no con la semilla de demo — pasada por el mismo normalizado que cualquier otro
  // dataset, para que tenga desde el primer momento schema_version, dataset_id, ids/timestamps
  // en cada entidad y tracking_started_at (puntos 14 y 31 de la auditoría de la Fase 1).
  return normalizarDatos(datosVaciosIniciales());
}
function descargarDatosCorruptos(){
  if(!DATOS_CORRUPTOS) return;
  var blob = new Blob([DATOS_CORRUPTOS], {type:'application/octet-stream'});
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'mitesla-datos-dañados-'+Date.now()+'.txt';
  a.click();
}
var DATOS = cargarDatos();
var frontendAuthority = null;
var frontendReady = false;
var frontendStartupPromise = null;
var businessPendiente = Object.create(null);
function guardarDatos(sinAutoSync){
  if(backendCanonicalConfigurado() && !frontendReady) return;
  try{
    DATOS.device_id = idDispositivo();
    localStorage.setItem('mitesla-datos', JSON.stringify(datosParaPersistenciaLocal(DATOS)));
  }catch(e){
    if(typeof toast==='function') toast('No se pudo guardar: almacenamiento local lleno. Descarga una copia de seguridad.', true);
    return;
  }
  if(!sinAutoSync) programarAutoSync();
}

// B22 (FASE B): antes, euros(null) e incluso euros(NaN) mostraban "0,00 €" — indistinguible de un
// coste real de cero. "null ≠ 0" (norma sobre datos inventados): sin dato, se muestra "—", nunca un
// importe fabricado. euros(0) sigue mostrando "0,00 €" (0 es un dato real, no una ausencia).
function euros(n){
  if(n===null || n===undefined || (typeof n==='number' && isNaN(n))) return '—';
  return Number(n).toLocaleString('es-ES',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';
}
/** Formatea un número que puede ser null (sin datos suficientes) sin inventar un 0. */
function fmt1(v, sufijo){ return (v===null||v===undefined||isNaN(v)) ? '—' : v.toFixed(1)+(sufijo||''); }
function fmt0(v, sufijo){ return (v===null||v===undefined||isNaN(v)) ? '—' : Math.round(v)+(sufijo||''); }
function fmtBateria(v){ return (v===null||v===undefined||isNaN(v)) ? '—' : v+' %'; }

// B23 (FASE B): el coste de una carga puede ser genuinamente desconocido (importado sin precio,
// o — en cuanto B6 conecte las cargas automáticas de D1 — una sesión de Supercharger todavía sin
// reconciliar con factura). "Nunca sumar cargas desconocidas como 0 €" (norma de datos inventados):
// esta función es el único sitio que decide el coste de una carga, y devuelve null cuando no se
// puede calcular — nunca 0 ni NaN. Se usa en todos los sitios que antes hacían `c.kwh*c.precio_kwh`
// a pelo (eso convertía un precio desconocido, NaN, en un coste "0,00 €" indistinguible de una
// carga gratis real).
function costeCarga(c){
  if(typeof c.total_cost==='number' && isFinite(c.total_cost)) return c.total_cost;
  if(typeof c.kwh==='number' && isFinite(c.kwh) && typeof c.precio_kwh==='number' && isFinite(c.precio_kwh)){
    return Math.round(c.kwh*c.precio_kwh*100)/100;
  }
  return null;
}
/** Suma solo las cargas con coste conocido (nunca cuenta las desconocidas como 0) y, además,
 *  informa cuántas se han quedado fuera — la "cobertura" que pide B23, para no mostrar un total
 *  que parece completo cuando en realidad faltan datos. */
function resumenCosteCargas(cargas){
  var conocido = 0, nConocidas = 0, nDesconocidas = 0;
  cargas.forEach(function(c){
    var coste = costeCarga(c);
    if(coste===null){ nDesconocidas++; return; }
    conocido += coste; nConocidas++;
  });
  return {
    costeConocido: (nConocidas>0 || nDesconocidas===0) ? Math.round(conocido*100)/100 : null,
    nConocidas: nConocidas, nDesconocidas: nDesconocidas, total: cargas.length,
    cobertura: cargas.length>0 ? nConocidas/cargas.length : 1
  };
}
/** Suma simple del coste conocido de una lista de cargas (nunca cuenta las desconocidas como 0) —
 *  para los sitios que solo necesitan el número, no todo el desglose de resumenCosteCargas(). */
function sumaCosteConocido(cargas){ return resumenCosteCargas(cargas).costeConocido || 0; }

/* ---------- B13 (FASE B) — Reconciliación de facturas de Supercharger ----------
 * Tesla no expone las facturas de Supercharger por la Fleet API pública (viven en el área de
 * cliente de Tesla, con otro sistema de autenticación) — automatizarlo del todo requeriría un
 * scraping no oficial y fácil de romper, así que en vez de eso esto es una reconciliación MANUAL
 * asistida: el usuario introduce el importe/fecha reales de la factura (PDF/email de Tesla) y esta
 * función busca, entre las cargas ya registradas de tipo "supercharger", cuáles encajan en el
 * tiempo — nunca aplica un emparejamiento sin que el usuario lo confirme explícitamente.
 *
 * NORMA SOBRE CORRECCIONES MANUALES: una vez reconciliada, la carga queda con cost_source
 * "facturado" y factura_reconciliada=true, y conTimestamps() le da un updated_at nuevo — así, en
 * fusionarPorId() (sincronización), esta corrección manual siempre gana sobre cualquier versión más
 * antigua (de otro dispositivo o de un reprocesado automático futuro), tal y como exige la norma.
 */
var VENTANA_RECONCILIACION_FACTURA_HORAS = 48; // Tesla puede tardar en emitir la factura tras la carga

/** Candidatas para una factura: solo cargas tipo "supercharger", todavía sin reconciliar, dentro de
 *  la ventana horaria alrededor de la fecha de la factura. Ordenadas por cercanía en el tiempo (y,
 *  si la factura trae kWh, también por cercanía de energía) — la más probable primero. Nunca decide
 *  sola: siempre devuelve candidatas para que el usuario elija, incluso si solo hay una. */
function candidatosFacturaSupercharger(factura, cargas){
  if(!factura || typeof factura.fecha!=='string' || !factura.fecha) return [];
  var fechaFacturaMs = new Date(factura.fecha).getTime();
  if(isNaN(fechaFacturaMs)) return [];
  var ventanaMs = VENTANA_RECONCILIACION_FACTURA_HORAS*3600*1000;
  var candidatas = (cargas||[]).filter(function(c){
    if(c.tipo!=='supercharger' || c.factura_reconciliada) return false;
    var fc = new Date(c.fecha).getTime();
    if(isNaN(fc)) return false;
    return Math.abs(fc-fechaFacturaMs) <= ventanaMs;
  }).map(function(c){
    var diffHoras = Math.abs(new Date(c.fecha).getTime()-fechaFacturaMs)/3600000;
    var diffKwh = (typeof factura.kwh==='number' && typeof c.kwh==='number') ? Math.abs(c.kwh-factura.kwh) : null;
    return { carga:c, diffHoras: Math.round(diffHoras*100)/100, diffKwh: diffKwh===null?null:Math.round(diffKwh*100)/100 };
  });
  candidatas.sort(function(a,b){
    // Si la factura trae kWh, la cercanía de energía manda (más fiable que la hora, que puede
    // llegar con retraso de facturación); si no, solo queda la cercanía temporal.
    if(a.diffKwh!==null && b.diffKwh!==null && a.diffKwh!==b.diffKwh) return a.diffKwh-b.diffKwh;
    return a.diffHoras-b.diffHoras;
  });
  return candidatas;
}

/** Aplica la reconciliación: el usuario ya ha elegido a mano cuál de las candidatas es la correcta.
 *  Nunca se llama automáticamente. Devuelve {ok:false, motivo} si algo no cuadra (norma de datos
 *  inventados: mejor rechazar que aplicar un coste a la carga equivocada o con un importe inválido). */
function reconciliarFacturaConCarga(datosApp, cargaId, factura){
  var carga = (datosApp.cargas||[]).find(function(c){ return c.id===cargaId; });
  if(!carga) return { ok:false, motivo:'carga_no_encontrada' };
  if(carga.tipo!=='supercharger') return { ok:false, motivo:'no_es_supercharger' };
  if(typeof factura.importe!=='number' || !isFinite(factura.importe) || factura.importe<=0) return { ok:false, motivo:'importe_invalido' };
  carga.total_cost = Math.round(factura.importe*100)/100;
  carga.cost_source = 'facturado';
  carga.factura_reconciliada = true;
  carga.factura_numero = factura.numero || null;
  carga.factura_fecha = factura.fecha || null;
  conTimestamps(carga, carga); // updated_at nuevo: esta corrección manual gana en cualquier fusión futura
  return { ok:true, carga: carga };
}
/** Lee un campo de porcentaje opcional (0-100) de un input de texto: vacío -> null (nunca 0 inventado), fuera de rango -> NaN para que lo rechace la validación. */
function parseOptionalPercentage(texto){
  if(texto===undefined || texto===null || texto==='') return null;
  var n = parseInt(texto,10);
  return isNaN(n) ? NaN : n;
}
/** Km recorridos desde que se empezó a usar el seguimiento de ahorro (tracking_started_at), no desde
 *  la compra del coche: evita extrapolar una muestra parcial de viajes/cargas a todo el histórico del odómetro. */
function kmSeguimiento(){
  var v = DATOS.vehiculo;
  var inicio = (v && typeof v.odometer_at_tracking_start==='number') ? v.odometer_at_tracking_start : 0;
  return Math.max(0, v.odometro_km - inicio);
}
/** Aviso (no bloqueante) si una fecha introducida a mano cae más de un día en el futuro: suele ser un año o mes mal escrito. */
function avisarSiFechaFutura(fechaStr){
  if(!fechaStr) return;
  var d = new Date(fechaStr);
  if(isNaN(d.getTime())) return;
  if(d.getTime() - Date.now() > 24*3600*1000){
    toast('Aviso: has introducido una fecha futura ('+fechaCorta(d.toISOString())+'). Revisa que sea correcta.');
  }
}
function fechaCorta(iso){
  var d = new Date(iso);
  return d.toLocaleDateString('es-ES',{day:'numeric',month:'short'}) + ', ' +
         d.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'});
}
var NOMBRE_TIPO = {domestica:'Casa', supercharger:'Supercharger', publico:'Cargador público', trabajo:'Trabajo', otros:'Otros'};
var NOMBRE_CAT = {seguro:'Seguro', neumaticos:'Neumáticos', mantenimiento:'Mantenimiento', reparaciones:'Reparaciones', accesorios:'Accesorios', lavados:'Lavados', otros:'Otros'};

/* ---------- Cálculos derivados de viajes ---------- */
function diasHasta(fechaISO){
  // Interpreta una fecha "YYYY-MM-DD" en hora local (no UTC) para que el conteo de días no varíe según el huso horario.
  return Math.ceil((new Date(fechaISO+'T00:00:00') - new Date()) / (1000*3600*24));
}
function fechaMasMeses(fechaISO, meses){
  var d = new Date(fechaISO+'T00:00:00'); // hora local, evita el desfase de interpretar fechas "YYYY-MM-DD" como UTC
  d.setMonth(d.getMonth() + meses);
  return d;
}
// B21 (FASE B): antes devolvía 0.18 (un número inventado) cuando no había ninguna carga registrada,
// indistinguible de un precio medio real calculado con datos. Ahora null explícito — "sin datos" no
// es "18 céntimos/kWh". Quien necesite igualmente un número para una proyección/estimación usa
// precioMedioKwhParaEstimaciones(), que aplica el supuesto ETIQUETADO (ASSUMPTIONS.defaultForecastPriceKwh)
// solo en ese punto de uso, nunca disfrazado de dato medido.
function precioMedioKwh(){
  // B23: la media ponderada solo se calcula sobre las cargas con coste conocido — una carga de
  // precio desconocido no debe "diluir" el precio medio real con un 0 fabricado.
  var totalKwh = 0, totalCoste = 0;
  DATOS.cargas.forEach(function(c){
    var coste = costeCarga(c);
    if(coste===null) return;
    totalKwh += c.kwh; totalCoste += coste;
  });
  if(!totalKwh) return null;
  return totalCoste/totalKwh;
}
/** Precio medio de carga (€/kWh) para cálculos de estimación/proyección de coste y ahorro. Usa el
 *  precio medio real cuando hay cargas registradas; si no, cae explícitamente en el supuesto
 *  ETIQUETADO ASSUMPTIONS.defaultForecastPriceKwh (misma convención que consumoReferenciaKwh100km
 *  unas líneas más abajo) — nunca se presenta como un precio medido. */
function precioMedioKwhParaEstimaciones(){
  var real = precioMedioKwh();
  return real!==null ? real : ASSUMPTIONS.defaultForecastPriceKwh.valor;
}
// B10 (FASE B): antes, "50 - null" evaluaba a 50 (null se coacciona a 0 en JS), así que un viaje
// con batería final desconocida producía un consumo FABRICADO en vez de "sin datos". Ahora exige
// explícitamente que ambos porcentajes sean números finitos en [0,100] y que km sea >0 — si no,
// null (nunca un 0 o un número inventado a partir de un campo ausente).
function consumoViaje(v){
  var inicial = v.bateria_inicial, final = v.bateria_final, km = v.km;
  if(typeof inicial!=='number' || !isFinite(inicial) || inicial<0 || inicial>100) return null;
  if(typeof final!=='number' || !isFinite(final) || final<0 || final>100) return null;
  if(typeof km!=='number' || !isFinite(km) || km<=0) return null;
  var pctUsado = inicial - final;
  var kwhUsado = pctUsado/100 * DATOS.vehiculo.capacidad_nominal_kwh;
  return kwhUsado/km*100;
}
function statsViajes(){
  var viajes = DATOS.viajes;
  var km = viajes.reduce(function(s,v){return s+v.km;},0);
  var min = viajes.reduce(function(s,v){return s+v.duracion_min;},0);
  var consumos = viajes.map(consumoViaje).filter(function(c){return c>0;});

  // Consumo medio PONDERADO por energía/km reales (no la media aritmética simple de cada
  // viaje, que da el mismo peso a un trayecto de 2 km que a uno de 300 km). Se usa null,
  // no 0, cuando no hay datos suficientes — 0 kWh/100km sería un dato inventado.
  var viajesConDatos = viajes.filter(function(v){
    return v.km>0 && typeof v.bateria_inicial==='number' && typeof v.bateria_final==='number' && v.bateria_inicial>=v.bateria_final;
  });
  var kmConDatos = viajesConDatos.reduce(function(s,v){return s+v.km;},0);
  var kwhConDatos = viajesConDatos.reduce(function(s,v){return s+(v.bateria_inicial-v.bateria_final)/100*DATOS.vehiculo.capacidad_nominal_kwh;},0);
  var media = kmConDatos>0 ? (kwhConDatos/kmConDatos*100) : null;

  // Velocidad media: solo con los viajes que tienen duración registrada (>0), para no
  // contar los km de un viaje sin duración como si se hubieran hecho "gratis" en el tiempo.
  var viajesConDuracion = viajes.filter(function(v){ return v.duracion_min>0; });
  var kmConDuracion = viajesConDuracion.reduce(function(s,v){return s+v.km;},0);
  var minConDuracion = viajesConDuracion.reduce(function(s,v){return s+v.duracion_min;},0);
  var velMedia = minConDuracion>0 ? kmConDuracion/(minConDuracion/60) : null;

  return {
    n: viajes.length, km: km, min: min, media: media,
    mejor: consumos.length?Math.min.apply(null,consumos):null,
    peor: consumos.length?Math.max.apply(null,consumos):null,
    velMedia: velMedia
  };
}

/* ---------- Render: Viajes ---------- */
var editandoViaje = null;
var MESES_LARGO = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
function agruparPorMes(items, htmlFila){
  var grupos = [], mesActual = null, actual = null;
  items.forEach(function(item){
    var d = new Date(item.fecha);
    var clave = d.getFullYear()+'-'+d.getMonth();
    if(clave !== mesActual){
      mesActual = clave;
      actual = { clave: clave, titulo: MESES_LARGO[d.getMonth()]+' '+d.getFullYear(), filas: [] };
      grupos.push(actual);
    }
    actual.filas.push(htmlFila(item));
  });
  return grupos.map(function(g, i){
    var abierto = i===0; // el mes más reciente empieza desplegado
    return '<div class="grupo-mes" data-toggle-mes="'+g.clave+'">'+
      '<span>'+g.titulo+'</span><span class="chevron">'+(abierto?'—':'+')+'</span></div>'+
      '<div class="grupo-filas" data-mes="'+g.clave+'" style="'+(abierto?'':'display:none')+'">'+g.filas.join('')+'</div>';
  }).join('');
}

var filtroViajeActivo = 'todo';
function renderViajes(){
  renderPlantillas();
  var viajes = DATOS.viajes.slice().sort(function(a,b){ return new Date(b.fecha)-new Date(a.fecha); });
  var s = statsViajes();
  document.getElementById('resumen-viajes').innerHTML =
    '<div class="card"><div class="lbl">Viajes registrados</div><div class="val">'+s.n+'</div><div class="sub">'+s.km.toFixed(1)+' km totales</div></div>'+
    '<div class="card"><div class="lbl">Consumo medio</div><div class="val">'+fmt1(s.media)+' <span style="font-size:14px;font-weight:600;color:var(--txt3)">kWh/100km</span></div><div class="sub">'+(s.media===null?'Datos insuficientes':'Mejor: '+fmt1(s.mejor)+' · Peor: '+fmt1(s.peor))+'</div></div>'+
    '<div class="card"><div class="lbl">Tiempo conduciendo</div><div class="val">'+Math.floor(s.min/60)+'h '+(s.min%60)+'min</div><div class="sub">Registrado</div></div>'+
    '<div class="card"><div class="lbl">Velocidad media</div><div class="val">'+fmt0(s.velMedia,' km/h')+'</div><div class="sub">'+(s.velMedia===null?'Sin viajes con duración':'En trayecto')+'</div></div>';

  var ahora = new Date();
  var qViajes = normalizarTexto(document.getElementById('buscar-viajes').value);
  var filtrados = viajes.filter(function(v){
    var d = new Date(v.fecha);
    if(filtroViajeActivo==='7dias' && (ahora-d) > 7*24*3600*1000) return false;
    if(filtroViajeActivo==='mes' && !(d.getFullYear()===ahora.getFullYear() && d.getMonth()===ahora.getMonth())) return false;
    if(qViajes && normalizarTexto(v.origen+' '+v.destino).indexOf(qViajes)===-1) return false;
    return true;
  });

  document.getElementById('lista-viajes').innerHTML = filtrados.length ? agruparPorMes(filtrados, function(v){
    var c = consumoViaje(v);
    var etiquetaTxt = v.etiqueta==='trabajo' ? ' · 💼 Trabajo' : (v.etiqueta==='otro' ? ' · Otro' : '');
    var conductorTxt = v.conductor ? ' · '+esc(v.conductor) : '';
    return '<div class="fila">'+
      '<div class="ico viaje" data-icon="ruta"></div>'+
      '<div class="fila-tx" data-editar-viaje="'+v.id+'"><div class="t1">'+esc(v.origen)+' → '+esc(v.destino)+'</div>'+
      '<div class="t2">'+fechaCorta(v.fecha)+' · '+v.duracion_min+' min'+conductorTxt+etiquetaTxt+'</div></div>'+
      '<div class="fila-r"><div class="r1">'+fmt1(v.km)+' km</div><div class="r2">'+fmt1(c,' kWh/100km')+'</div></div>'+
      '<button type="button" class="btn-duplicar" data-duplicar-viaje="'+v.id+'" data-icon="duplicar" aria-label="Duplicar"></button>'+
      '<button type="button" class="btn-borrar" data-borrar-viaje="'+v.id+'" data-icon="papelera" aria-label="Eliminar"></button>'+
      '</div>';
  }) : '<div class="vacio"><span class="em">🚗</span><p>'+(qViajes ? 'Sin viajes que coincidan con la búsqueda.' : (filtroViajeActivo==='todo' ? 'Todavía no hay viajes. Añade el primero con "+ Añadir".' : 'Sin viajes en este periodo.'))+'</p></div>';

  aplicarIconos();
}
var editandoViajeRevision = null;
function abrirFormViaje(v){
  editandoViajeRevision = v ? v.revision : null;
  editandoViaje = v ? v.id : null;
  document.getElementById('fv-fecha').value = v ? v.fecha : '';
  document.getElementById('fv-origen').value = v ? v.origen : '';
  document.getElementById('fv-destino').value = v ? v.destino : '';
  document.getElementById('fv-km').value = v ? v.km : '';
  document.getElementById('fv-duracion').value = v ? v.duracion_min : '';
  document.getElementById('fv-bini').value = (v && v.bateria_inicial!=null) ? v.bateria_inicial : '';
  document.getElementById('fv-bfin').value = (v && v.bateria_final!=null) ? v.bateria_final : '';
  document.getElementById('fv-etiqueta').value = v ? (v.etiqueta||'personal') : 'personal';
  document.getElementById('fv-conductor').value = v ? (v.conductor||'') : '';
  document.getElementById('fv-guardar').textContent = v ? 'Guardar cambios' : 'Guardar viaje';
  formViaje.classList.remove('form-oculto');
}

/* ---------- Render: Batería ---------- */
function renderBateria(){
  var hist = DATOS.bateria_historico;
  if(!hist.length){
    document.getElementById('bat-pct').innerHTML = '—<span>%</span>';
    document.getElementById('bat-barra').style.width = '0%';
    document.getElementById('bat-nominal').textContent = DATOS.vehiculo.capacidad_nominal_kwh+' kWh';
    document.getElementById('bat-estimada').textContent = '—';
    document.getElementById('resumen-bateria').innerHTML = '<div class="vacio"><span class="em">🔋</span><p>Todavía no hay ninguna lectura de batería. Añade la primera para ver aquí su evolución.</p></div>';
    dibujarChartBateria();
    renderListaBateria();
    var contProx = document.getElementById('tarjeta-proxima-carga');
    if(contProx) contProx.innerHTML = '';
    return;
  }
  var actual = hist[hist.length-1].capacidad_pct;
  var nominal = DATOS.vehiculo.capacidad_nominal_kwh;
  var estimada = nominal*actual/100;
  var degradacion = actual-100;
  var autonomia = Math.round(DATOS.vehiculo.autonomia_wltp_km * actual/100);

  var totalKwh = DATOS.cargas.reduce(function(s,c){return s+c.kwh;},0);
  var scKwh = DATOS.cargas.filter(function(c){return c.tipo==='supercharger';}).reduce(function(s,c){return s+c.kwh;},0);
  var pctRapida = totalKwh ? Math.round(scKwh/totalKwh*100) : 0;
  var ciclos = Math.round(totalKwh/nominal);

  // Curva de referencia típica publicada para baterías Tesla (aprox.): ~5% el primer año, ~1,5%/año después.
  var meses = Math.max(0, (new Date() - new Date(DATOS.vehiculo.fecha_compra+'T00:00:00')) / (1000*3600*24*30.44));
  var esperado = 100 - (5*Math.min(meses,12)/12) - (1.5*Math.max(meses-12,0)/12);
  var diferencia = actual - esperado;

  document.getElementById('bat-pct').innerHTML = actual.toFixed(1)+'<span>%</span>';
  document.getElementById('bat-barra').style.width = actual+'%';
  document.getElementById('bat-nominal').textContent = nominal+' kWh';
  document.getElementById('bat-estimada').textContent = estimada.toFixed(1).replace('.',',')+' kWh';

  document.getElementById('resumen-bateria').innerHTML =
    '<div class="card"><div class="lbl">'+li('stats')+'Degradación</div><div class="val">'+degradacion.toFixed(1)+' %</div><div class="sub">Desde la compra</div></div>'+
    '<div class="card"><div class="lbl">'+li('ruta')+'Autonomía a 100 %</div><div class="val">'+autonomia+' km</div><div class="sub">WLTP ajustada al histórico</div></div>'+
    '<div class="card"><div class="lbl">'+li('rayo')+'Carga rápida</div><div class="val">'+pctRapida+' %</div><div class="sub">De las cargas totales</div></div>'+
    '<div class="card"><div class="lbl">'+li('bateria')+'Ciclos equivalentes</div><div class="val">'+ciclos+'</div><div class="sub">Estimado por kWh acumulados</div></div>'+
    '<div class="card" style="grid-column:1/-1"><div class="lbl">Frente a la media típica</div>'+
    '<div class="val '+(diferencia>=0?'ok':'')+'">'+(diferencia>=0?'+':'')+diferencia.toFixed(1)+' puntos</div>'+
    '<div class="sub">'+(diferencia>=0 ? 'Tu batería se conserva mejor de lo habitual para su antigüedad' : 'Ligeramente por debajo de la curva típica, dentro de lo normal')+'</div></div>';

  aplicarIconos();
  dibujarChartBateria();
  renderListaBateria();
  renderProximaCarga(autonomia);
}
/* ---------- Próxima carga recomendada (estilo ABRP, con datos propios) ---------- */
function renderProximaCarga(autonomiaAl100){
  var cont = document.getElementById('tarjeta-proxima-carga');
  if(!cont) return;
  var cargaActual = nivelCargaActual();
  if(cargaActual === null){
    cont.innerHTML = '<div class="lbl">'+li('rayo')+'Próxima carga recomendada</div><div class="sub">Registra un viaje o una carga con el % de batería para calcularlo.</div>';
    return;
  }
  var umbral = parseInt(localStorage.getItem('mitesla-umbral-bateria')) || 20;
  var kmRestantes = Math.round(autonomiaAl100 * cargaActual/100);
  var kmHastaUmbral = Math.max(0, Math.round(autonomiaAl100 * (cargaActual-umbral)/100));
  var s = statsViajes();
  var kmDiaMedio = 40; // aprox. si no hay suficiente histórico
  if(DATOS.viajes.length){
    var fechasViajes = DATOS.viajes.map(function(v){ return new Date(v.fecha); });
    var diasHistoricoViajes = Math.max(1, (Math.max.apply(null,fechasViajes) - Math.min.apply(null,fechasViajes)) / (1000*3600*24));
    kmDiaMedio = s.km / diasHistoricoViajes;
  }
  var diasHastaUmbral = kmDiaMedio>0 ? Math.max(0, Math.round(kmHastaUmbral/kmDiaMedio)) : null;

  var mensaje, color;
  if(cargaActual <= umbral){
    mensaje = 'Estás por debajo de tu umbral de aviso ('+umbral+' %) — te recomendamos cargar pronto.';
    color = 'var(--acc)';
  } else if(diasHastaUmbral !== null && diasHastaUmbral <= 2){
    mensaje = 'A tu ritmo medio, llegarás a '+umbral+' % en aproximadamente '+(diasHastaUmbral<=0?'menos de un día':diasHastaUmbral+' día'+(diasHastaUmbral===1?'':'s'))+'.';
    color = 'var(--warn)';
  } else {
    mensaje = 'Margen cómodo: unos '+kmHastaUmbral.toLocaleString('es-ES')+' km antes de llegar a tu umbral de '+umbral+' %.';
    color = 'var(--ok)';
  }
  cont.innerHTML =
    '<div class="lbl">'+li('rayo')+'Próxima carga recomendada</div>'+
    '<div class="val" style="color:'+color+'">'+kmRestantes.toLocaleString('es-ES')+' km disponibles</div>'+
    '<div class="sub">'+mensaje+'</div>';
  aplicarIconos();
}
function renderListaBateria(){
  var cont = document.getElementById('lista-bateria');
  if(!cont) return;
  var hist = DATOS.bateria_historico.slice().sort(function(a,b){ return new Date(b.fecha)-new Date(a.fecha); });
  cont.innerHTML = hist.map(function(h){
    return '<div class="fila"><div class="fila-tx"><div class="t1">'+h.capacidad_pct.toFixed(1)+' %</div>'+
      '<div class="t2">'+new Date(h.fecha+'T00:00:00').toLocaleDateString('es-ES',{day:'numeric',month:'long',year:'numeric'})+'</div></div>'+
      '<button type="button" class="btn-borrar" data-borrar-bateria="'+esc(h.id||h.fecha)+'" data-icon="papelera" aria-label="Eliminar"></button></div>';
  }).join('') || '<div class="vacio"><span class="em">🔋</span><p>Sin lecturas todavía.</p></div>';
  aplicarIconos();
}
document.getElementById('lista-bateria').addEventListener('click', function(e){
  var borrar = e.target.closest('[data-borrar-bateria]');
  if(!borrar) return;
  confirmarAccion('Eliminar lectura', 'Se borrará esta lectura de batería.', function(){
    var idBorrar = borrar.dataset.borrarBateria;
    var item = DATOS.bateria_historico.find(function(h){ return (h.id||h.fecha)===idBorrar; });
    marcarBorrado('bateria_historico', idBorrar);
    DATOS.bateria_historico = DATOS.bateria_historico.filter(function(h){ return (h.id||h.fecha)!==idBorrar; });
    if(item){ moverAPapelera('bateria_historico', item); registrarCambio('bateria_historico', 'eliminar', textoResumenCambio('bateria_historico', item)); }
    guardarDatos(); renderBateria(); renderDashboard();
    toastDeshacer('Lectura eliminada', 'bateria_historico', idBorrar, [renderBateria, renderDashboard]);
  });
});

/* ---------- Render: Estadísticas ---------- */
/* ---------- Render: Ajustes ---------- */
function cargarTarifa(){
  try{ return JSON.parse(localStorage.getItem('mitesla-tarifa')) || { valle:0.11, llano:0.16, punta:0.22 }; }
  catch(e){ return { valle:0.11, llano:0.16, punta:0.22 }; }
}
/* B12 (FASE B): antes precioSegunHora decidía el tramo comparando precios ("if h... return
 * tarifa.valle"), lo que impedía saber POR NOMBRE en qué tramo cae una hora sin arriesgarse a
 * confundir dos tramos que coincidieran de precio. nombreTramoHora aísla esa decisión (misma
 * lógica, ningún comportamiento nuevo) para que desglosarCosteSesionPorTramos pueda usarla
 * directamente en vez de comparar valores numéricos. */
function nombreTramoHora(fechaISO){
  var d = new Date(fechaISO);
  var dia = d.getDay(); // 0=domingo, 6=sábado
  var h = d.getHours();
  if(dia===0 || dia===6) return 'valle'; // fin de semana siempre valle
  if(h>=0 && h<8) return 'valle';
  if((h>=10 && h<14) || (h>=18 && h<22)) return 'punta';
  return 'llano'; // 8-10, 14-18, 22-24
}
function precioSegunHora(fechaISO, tarifa){
  return tarifa[nombreTramoHora(fechaISO)];
}
/* ---------- Fase 3, punto 7: sesiones que atraviesan varios periodos tarifarios ----------
 * Cuando una carga doméstica tiene fecha de inicio Y fin, en vez de aplicar el precio de una sola
 * hora (lo que ignoraría el resto de la sesión si cruza de valle a llano, por ejemplo) se calcula
 * un precio medio ponderado por el tiempo pasado en cada periodo.
 * NOTA (calendario tarifario personalizado, punto 7): los tramos horarios valle/llano/punta siguen
 * siendo los mismos que ya usaba la app (ver precioSegunHora) — un editor para que el usuario
 * redefina esos tramos no está construido todavía; queda como DISEÑADO/PENDIENTE en el informe
 * final. Lo que sí es nuevo aquí es que una sesión larga ya no se factura entera al precio de
 * un único instante. */
function precioMedioSesion(inicioISO, finISO, tarifa){
  var ini = new Date(inicioISO), fin = new Date(finISO);
  if(isNaN(ini.getTime()) || isNaN(fin.getTime()) || fin<=ini) return precioSegunHora(inicioISO, tarifa);
  var totalMin = (fin-ini)/60000;
  if(totalMin > 48*60) return precioSegunHora(inicioISO, tarifa); // sesión disparatadamente larga: no fiable, se usa el precio de inicio
  var costeAcumulado = 0, cursor = new Date(ini);
  while(cursor < fin){
    var siguienteHora = new Date(cursor); siguienteHora.setMinutes(0,0,0); siguienteHora.setHours(siguienteHora.getHours()+1);
    var tramoFin = siguienteHora < fin ? siguienteHora : fin;
    var minutosTramo = (tramoFin - cursor) / 60000;
    costeAcumulado += minutosTramo * precioSegunHora(cursor.toISOString(), tarifa);
    cursor = tramoFin;
  }
  return Math.round((costeAcumulado / totalMin) * 10000) / 10000;
}

/* ---------- B12 (FASE B): reparto de coste por tramo horario (cargas domésticas largas) ----------
 * precioMedioSesion ya calculaba un precio medio ponderado cuando una sesión cruza de tramo, pero
 * solo devolvía ESE número medio — el usuario nunca veía cuánta energía/coste correspondió a cada
 * tramo. Para una carga doméstica larga (varias horas, típicamente durante la noche) eso puede
 * ocultar que, por ejemplo, buena parte de la energía se cargó ya en horario llano/punta. Esta
 * función desglosa la MISMA sesión, tramo a tramo, repartiendo el kWh TOTAL REAL de forma
 * proporcional al tiempo pasado en cada tramo (nunca inventa un consumo distinto al medido) —
 * NORMA SOBRE DATOS INVENTADOS: si no hay fecha de fin o kWh válidos, devuelve null, nunca un
 * desglose con huecos rellenados a ojo. */
function desglosarCosteSesionPorTramos(inicioISO, finISO, tarifa, kwhTotal){
  var ini = new Date(inicioISO), fin = new Date(finISO);
  if(isNaN(ini.getTime()) || isNaN(fin.getTime()) || fin<=ini) return null;
  if(typeof kwhTotal!=='number' || !isFinite(kwhTotal) || kwhTotal<=0) return null;
  var totalMin = (fin-ini)/60000;
  if(totalMin > 48*60) return null; // igual que precioMedioSesion: sesión disparatadamente larga, no fiable
  var tramosPorNombre = {}; // 'valle'|'llano'|'punta' -> {minutos, precio}
  var cursor = new Date(ini);
  while(cursor < fin){
    var siguienteHora = new Date(cursor); siguienteHora.setMinutes(0,0,0); siguienteHora.setHours(siguienteHora.getHours()+1);
    var tramoFin = siguienteHora < fin ? siguienteHora : fin;
    var minutosTramo = (tramoFin - cursor) / 60000;
    var nombre = nombreTramoHora(cursor.toISOString());
    if(!tramosPorNombre[nombre]) tramosPorNombre[nombre] = { minutos:0, precio:tarifa[nombre] };
    tramosPorNombre[nombre].minutos += minutosTramo;
    cursor = tramoFin;
  }
  var resultado = [];
  ['valle','llano','punta'].forEach(function(nombre){
    var t = tramosPorNombre[nombre];
    if(!t) return;
    var kwhTramo = kwhTotal * (t.minutos / totalMin);
    resultado.push({
      tramo: nombre,
      minutos: Math.round(t.minutos * 100) / 100,
      precio_kwh: t.precio,
      kwh: Math.round(kwhTramo * 1000) / 1000,
      coste: Math.round(kwhTramo * t.precio * 100) / 100
    });
  });
  return resultado;
}
var NOMBRE_TRAMO_LARGO = { valle:'Valle', llano:'Llano', punta:'Punta' };
function renderDesgloseTramos(){
  var cont = document.getElementById('fc-desglose-tramos');
  if(!cont) return;
  var tipo = document.getElementById('fc-tipo').value;
  var fecha = document.getElementById('fc-fecha').value;
  var finSesion = document.getElementById('fc-fecha-fin').value;
  var kwh = parseFloat(document.getElementById('fc-kwh').value);
  if(tipo!=='domestica' || !fecha || !finSesion || isNaN(kwh)){ cont.innerHTML=''; return; }
  var desglose = desglosarCosteSesionPorTramos(fecha, finSesion, cargarTarifa(), kwh);
  if(!desglose || desglose.length<2){ cont.innerHTML=''; return; } // con 1 solo tramo no aporta nada nuevo sobre el precio medio
  cont.innerHTML = '<div class="sub" style="margin:4px 0 2px">Desglose por tramo horario</div>' +
    desglose.map(function(t){
      return '<div class="sub">'+NOMBRE_TRAMO_LARGO[t.tramo]+': '+t.kwh.toFixed(2)+' kWh a '+t.precio_kwh.toFixed(2)+' €/kWh = '+t.coste.toFixed(2)+' €</div>';
    }).join('');
}

function renderAjustes(){
  poblarSelectorModelos();
  document.getElementById('ref-consumo').value = DATOS.referencia_gasolina.consumo_l_100km;
  document.getElementById('ref-precio').value = DATOS.referencia_gasolina.precio_litro;
  document.getElementById('veh-modelo').value = DATOS.vehiculo.modelo || 'Model Y Premium Dual Motor Long Range';
  document.getElementById('veh-fecha-compra').value = DATOS.vehiculo.fecha_compra;
  document.getElementById('veh-capacidad').value = DATOS.vehiculo.capacidad_nominal_kwh;
  document.getElementById('veh-autonomia').value = DATOS.vehiculo.autonomia_wltp_km;
  document.getElementById('veh-odometro').value = DATOS.vehiculo.odometro_km;
  document.getElementById('veh-seguro').value = DATOS.seguro.fecha_renovacion;
  document.getElementById('veh-itv').value = DATOS.itv.fecha;
  var casa = DATOS.vehiculo.casa;
  document.getElementById('veh-casa-estado').style.display = casa ? '' : 'none';
  if(casa) document.getElementById('veh-casa-coords').textContent = casa.lat.toFixed(4)+', '+casa.lng.toFixed(4);
  document.getElementById('umbral-bateria').value = localStorage.getItem('mitesla-umbral-bateria') || 20;
  renderFeatureFlags();
  document.getElementById('privacidad-radio').value = localStorage.getItem('mitesla-privacidad-radio') || '0';
  var temaActual = localStorage.getItem('mitesla-tema') || 'auto';
  document.querySelectorAll('#selector-tema button').forEach(function(b){
    b.classList.toggle('on', b.dataset.tema === temaActual);
  });
  var tarifa = cargarTarifa();
  document.getElementById('tarifa-valle').value = tarifa.valle;
  document.getElementById('tarifa-llano').value = tarifa.llano;
  document.getElementById('tarifa-punta').value = tarifa.punta;
  var cfg = cargarConfigGithub();
  document.getElementById('gh-repo').value = cfg.repo || '';
  document.getElementById('gh-path').value = cfg.path || 'datos.json';
  document.getElementById('gh-token').value = cfg.token || '';
  // B25 (FASE B): la sección refleja si GitHub está funcionando como sincronización completa
  // (todavía sin D1 disponible) o solo como copia de seguridad (D1 ya disponible como canónica).
  var ghTitulo = document.getElementById('gh-sec-titulo'), ghSub = document.getElementById('gh-sec-sub');
  var ghSoloBackup = (typeof repositorioD1Disponible === 'function') && repositorioD1Disponible();
  if(ghTitulo) ghTitulo.textContent = ghSoloBackup ? 'Copia de seguridad en GitHub' : 'Sincronización con GitHub';
  if(ghSub) ghSub.textContent = ghSoloBackup ? 'D1 ya es la fuente canónica — GitHub solo guarda una copia' : 'Así comparten datos tus dispositivos';
  var tcfg = cargarConfigTesla();
  document.getElementById('tesla-client-id').value = tcfg.clientId || TESLA_CONFIG_POR_DEFECTO.clientId;
  document.getElementById('tesla-backend-url').value = tcfg.backendUrl || TESLA_CONFIG_POR_DEFECTO.backendUrl;
  document.getElementById('tesla-session-token').value = tcfg.sessionToken || '';
  getTeslaConnectionStatus();
  var ultimaSync = localStorage.getItem('mitesla-ultima-sync');
  var syncPendiente = localStorage.getItem('mitesla-sync-pending')==='1';
  if(syncPendiente){
    estadoSync('Sin sincronizar: '+(localStorage.getItem('mitesla-sync-error')||'conflicto pendiente')+'. Se reintentará.', true, 'err');
  } else if(ultimaSync){
    estadoSync('Última sincronización: '+new Date(ultimaSync).toLocaleString('es-ES'), false, 'ok');
  } else if(cfg.repo && cfg.token){
    estadoSync('Configurado — todavía sin sincronizar.', false, 'pend');
  } else {
    estadoSync('Sin configurar todavía.', false, 'off');
  }
  var avisoPublico = document.getElementById('gh-aviso-publico');
  if(cfg.repo && cfg.token && localStorage.getItem('mitesla-repo-publico')==='1'){
    avisoPublico.style.display = '';
    avisoPublico.innerHTML = '<div class="aviso-banda">'+li('aviso')+'El repositorio "'+esc(cfg.repo)+'" es público — cualquiera puede ver tus datos del coche (viajes, ubicaciones, etc.) en GitHub. Considera hacerlo privado.</div>';
    aplicarIconos();
  } else {
    avisoPublico.style.display = 'none';
  }
  actualizarEstadoNotificaciones();
  var instalada = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  var pie = document.getElementById('ajustes-pie');
  if(pie) pie.textContent = 'Mi Tesla · versión '+APP_VERSION+(instalada ? ' · instalada' : ' · abierta en el navegador');
  renderAvisoBackup();
  renderPapelera();
  renderHistorialCambios();
  if(featureActiva('fleet_telemetry')) cargarAutomatizacion();
}
/* ---------- Fase 3, punto 31: aviso de copia de seguridad desactualizada ----------
 * No hay forma de descargar un backup automático y silencioso en segundo plano desde una PWA
 * estática (exigiría la API de acceso al sistema de archivos, con permiso del usuario en cada
 * sesión, o un backend que no existe aquí) — en vez de fingir un "backup automático" que no lo es,
 * se avisa con claridad cuando la copia manual lleva mucho tiempo sin renovarse. */
var BACKUP_DIAS_AVISO = 30;
function diasDesdeUltimoBackup(){
  var ultima = localStorage.getItem('mitesla-ultima-backup');
  if(!ultima) return null;
  return Math.floor((Date.now()-new Date(ultima).getTime())/86400000);
}
function renderAvisoBackup(){
  var cont = document.getElementById('aviso-backup-antiguo');
  if(!cont) return;
  var dias = diasDesdeUltimoBackup();
  if(dias===null){
    cont.style.display = '';
    cont.innerHTML = '<div class="aviso-banda">'+li('aviso')+'Todavía no has descargado ninguna copia de seguridad. Hazlo desde "Exportar datos (.json)" arriba.</div>';
  } else if(dias > BACKUP_DIAS_AVISO){
    cont.style.display = '';
    cont.innerHTML = '<div class="aviso-banda">'+li('aviso')+'Tu última copia de seguridad es de hace '+dias+' días. Descarga una nueva desde "Exportar datos (.json)" arriba.</div>';
  } else {
    cont.style.display = 'none';
    cont.innerHTML = '';
  }
  aplicarIconos();
}

function renderEstadisticas(){
  var s = statsViajes();
  var totalGastos = DATOS.gastos.reduce(function(s,g){return s+g.importe;},0);
  var totalEnergia = sumaCosteConocido(DATOS.cargas);
  var kmOdometro = DATOS.vehiculo.odometro_km;
  var costeGasolina100 = DATOS.referencia_gasolina.consumo_l_100km*DATOS.referencia_gasolina.precio_litro;
  var costeTesla100 = (s.media!==null?s.media:ASSUMPTIONS.consumoReferenciaKwh100km.valor)/100*precioMedioKwhParaEstimaciones(); // referencia si aún no hay viajes suficientes con datos de batería
  var ahorroTotal = (costeGasolina100-costeTesla100)/100*kmSeguimiento(); // solo sobre los km recorridos desde que se activó el seguimiento, no todo el histórico del coche
  var co2 = (s.km/100*DATOS.referencia_gasolina.consumo_l_100km*ASSUMPTIONS.factorCo2KgPorLitro.valor).toFixed(0);
  var POTENCIA_ESTIMADA = {domestica:7, supercharger:150, publico:50, trabajo:7, otros:11};
  var minCarga = DATOS.cargas.reduce(function(s,c){
    var potencia = POTENCIA_ESTIMADA[c.tipo] || 11;
    return s + (c.kwh/potencia*60);
  }, 0);

  var ahoraStats = new Date();
  var añoActual = ahoraStats.getFullYear();
  var kmEsteAño = DATOS.viajes.filter(function(v){ return new Date(v.fecha).getFullYear()===añoActual; }).reduce(function(s,v){ return s+v.km; }, 0);
  var kmUltimos7Dias = DATOS.viajes.filter(function(v){ return (ahoraStats-new Date(v.fecha)) <= 7*24*3600*1000; }).reduce(function(s,v){ return s+v.km; }, 0);

  document.getElementById('stats-km').innerHTML =
    '<div class="card"><div class="lbl">Totales</div><div class="val">'+kmOdometro.toLocaleString('es-ES')+' km</div><div class="sub">Desde la compra</div></div>'+
    '<div class="card"><div class="lbl">Registrados</div><div class="val">'+s.km.toFixed(0)+' km</div><div class="sub">'+s.n+' viajes</div></div>'+
    '<div class="card"><div class="lbl">Este año</div><div class="val">'+kmEsteAño.toLocaleString('es-ES')+' km</div><div class="sub">'+añoActual+'</div></div>'+
    '<div class="card"><div class="lbl">Media diaria</div><div class="val">'+Math.round(kmUltimos7Dias/7)+' km</div><div class="sub">Últimos 7 días</div></div>';

  document.getElementById('stats-consumo').innerHTML =
    '<div class="card"><div class="lbl">Consumo medio</div><div class="val">'+fmt1(s.media)+' kWh</div><div class="sub">'+(s.media===null?'Datos insuficientes':'por 100 km')+'</div></div>'+
    '<div class="card"><div class="lbl">Mejor viaje</div><div class="val ok">'+fmt1(s.mejor)+' kWh</div><div class="sub">'+(s.mejor===null?'Datos insuficientes':'por 100 km')+'</div></div>'+
    '<div class="card"><div class="lbl">Peor viaje</div><div class="val">'+fmt1(s.peor)+' kWh</div><div class="sub">'+(s.peor===null?'Datos insuficientes':'por 100 km')+'</div></div>'+
    '<div class="card"><div class="lbl">CO₂ evitado</div><div class="val ok">'+co2+' kg</div><div class="sub">vs. referencia gasolina</div></div>';

  document.getElementById('stats-cargas').innerHTML =
    '<div class="card"><div class="lbl">Cargas totales</div><div class="val">'+DATOS.cargas.length+'</div><div class="sub">'+DATOS.cargas.reduce(function(s,c){return s+c.kwh;},0).toFixed(1)+' kWh</div></div>'+
    '<div class="card"><div class="lbl">Tiempo cargando</div><div class="val">~'+Math.round(minCarga/60)+'h</div><div class="sub">Estimado</div></div>'+
    '<div class="card"><div class="lbl">Tiempo conduciendo</div><div class="val">'+Math.floor(s.min/60)+'h '+(s.min%60)+'min</div><div class="sub">Registrado</div></div>'+
    '<div class="card"><div class="lbl">Ahorro total</div><div class="val ok">'+euros(ahorroTotal)+'</div><div class="sub">vs. gasolina</div></div>';

  renderComparadorTemporada();
  renderRecords();
  renderLogros(s, ahorroTotal, kmOdometro, co2);
  dibujarChartKmMes();
  renderPorConductor();
  renderCalidadDatos();
  renderAnaliticaConsumo(analiticaPeriodoActivo);
  renderAnomalias();
}

/* ---------- Fase 3, punto 20: centro de calidad de datos ----------
 * No es un diagnóstico técnico para desarrolladores: son avisos que ayudan al propio usuario a
 * saber qué tan fiables son sus estadísticas ahora mismo (p. ej. "la mitad de tus viajes no tienen
 * % de batería, así que el consumo medio es una foto parcial"). Se separan en tres niveles, del
 * más al menos grave, como pide el punto 20: fallo, aviso, recomendación. */
function calcularCalidadDatos(){
  var fallos = [], avisos = [], recomendaciones = [];

  if(DATOS_CORRUPTOS) fallos.push('Hay una copia de datos dañada sin poder interpretarse guardada en este dispositivo — descárgala desde el aviso del Dashboard antes de que se sobrescriba.');

  var viajesSinSoc = DATOS.viajes.filter(function(v){ return v.bateria_inicial==null || v.bateria_final==null; }).length;
  if(DATOS.viajes.length && viajesSinSoc){
    avisos.push(viajesSinSoc+' de '+DATOS.viajes.length+' viajes no tienen % de batería inicial/final — el consumo medio (kWh/100km) se calcula solo con los que sí lo tienen.');
  }
  var cargasSinPrecio = DATOS.cargas.filter(function(c){ return c.precio_kwh===0; }).length;
  if(cargasSinPrecio) avisos.push(cargasSinPrecio+' carga(s) con precio 0 €/kWh — puede ser una carga gratuita real, o simplemente que no se rellenó el precio.');

  var diasDesdeOdometro = DATOS.vehiculo.updated_at ? Math.floor((Date.now()-new Date(DATOS.vehiculo.updated_at).getTime())/86400000) : null;
  if(diasDesdeOdometro!==null && diasDesdeOdometro>45 && !DATOS.vehiculo.odometro_tesla_actualizado_at){
    avisos.push('El odómetro no se actualiza desde hace '+diasDesdeOdometro+' días — las estimaciones de km/vida útil de neumáticos pueden estar desfasadas.');
  }

  var importados = DATOS.cargas.filter(function(c){ return c.data_source==='importado'; }).length;
  if(importados) recomendaciones.push(importados+' carga(s) proceden de una importación — revisa que el precio/tipo sean correctos si no los rellenaste tú.');

  var ultimaSync = localStorage.getItem('mitesla-ultima-sync');
  recomendaciones.push(ultimaSync ? 'Última sincronización entre dispositivos: '+new Date(ultimaSync).toLocaleString('es-ES') : 'Todavía no se ha sincronizado nunca con otro dispositivo.');
  var ultimaBackup = localStorage.getItem('mitesla-ultima-backup');
  recomendaciones.push(ultimaBackup ? 'Última copia de seguridad descargada: '+new Date(ultimaBackup).toLocaleString('es-ES') : 'Todavía no has descargado ninguna copia de seguridad manual.');
  if(typeof teslaCache!=='undefined' && teslaCache.last_fetch){
    recomendaciones.push('Última consulta a Tesla: '+tiempoRelativo(teslaCache.last_fetch)+(teslaCache.last_error?' — con error: '+teslaCache.last_error:' — con éxito'));
  }

  return { fallos:fallos, avisos:avisos, recomendaciones:recomendaciones };
}
function renderCalidadDatos(){
  var cont = document.getElementById('stats-calidad-datos');
  if(!cont) return;
  var c = calcularCalidadDatos();
  function fila(mensaje, nivel){
    var color = nivel==='fallo' ? 'var(--acc)' : (nivel==='aviso' ? 'var(--warn)' : 'var(--txt3)');
    var etiqueta = nivel==='fallo' ? 'Fallo' : (nivel==='aviso' ? 'Aviso' : 'Recomendación');
    return '<div class="fila"><div class="fila-tx"><div class="t1" style="color:'+color+'">'+etiqueta+'</div><div class="t2">'+esc(mensaje)+'</div></div></div>';
  }
  var filas = c.fallos.map(function(m){return fila(m,'fallo');}).concat(c.avisos.map(function(m){return fila(m,'aviso');})).concat(c.recomendaciones.map(function(m){return fila(m,'recomendacion');}));
  cont.innerHTML = filas.length ? filas.join('') : '<div class="vacio"><span class="em">✅</span><p>Sin avisos de calidad de datos por ahora.</p></div>';
}

/* ---------- Fase 3, punto 21: analítica de consumo (7/30/90 días, por tipo de viaje, tendencia) ---------- */
var analiticaPeriodoActivo = 30;
document.getElementById('filtros-analitica-periodo').addEventListener('click', function(e){
  var btn = e.target.closest('[data-periodo-analitica]');
  if(!btn) return;
  analiticaPeriodoActivo = parseInt(btn.dataset.periodoAnalitica, 10);
  document.querySelectorAll('#filtros-analitica-periodo button').forEach(function(b){ b.classList.toggle('on', b===btn); });
  renderAnaliticaConsumo(analiticaPeriodoActivo);
});
/** Consumo medio (kWh/100km) de los viajes con datos de batería dentro de los últimos N días. */
function consumoMedioUltimosDias(dias, refFecha){
  var limite = (refFecha||new Date()).getTime() - dias*86400000;
  var viajes = DATOS.viajes.filter(function(v){ return new Date(v.fecha).getTime()>=limite && new Date(v.fecha).getTime()<=(refFecha||new Date()).getTime(); });
  var consumos = viajes.map(consumoViaje).filter(function(c){ return c>0; });
  if(!consumos.length) return null;
  return consumos.reduce(function(a,b){return a+b;},0)/consumos.length;
}
function renderAnaliticaConsumo(dias){
  var cont = document.getElementById('stats-analitica-consumo');
  if(!cont) return;
  var actual = consumoMedioUltimosDias(dias);
  var anterior = consumoMedioUltimosDias(dias, new Date(Date.now()-dias*86400000)); // periodo COMPARABLE inmediatamente anterior, misma duración — no se compara con "todo el histórico"
  var filas = [];
  filas.push('<div class="fila"><div class="fila-tx"><div class="t1">Consumo medio, últimos '+dias+' días</div><div class="t2">Solo viajes con % de batería registrado</div></div>'+
    '<div class="fila-r"><div class="r1">'+fmt1(actual,' kWh/100km')+'</div></div></div>');
  if(actual!==null && anterior!==null && anterior>0){
    var variacion = Math.round((actual-anterior)/anterior*100);
    filas.push('<div class="fila"><div class="fila-tx"><div class="t1">Tendencia</div><div class="t2">vs. los '+dias+' días anteriores ('+fmt1(anterior,' kWh/100km')+')</div></div>'+
      '<div class="fila-r"><div class="r1" style="color:'+(variacion<=0?'var(--ok)':'var(--warn)')+'">'+(variacion>0?'+':'')+variacion+' %</div></div></div>');
  }
  // Por tipo de viaje (etiqueta) — solo del periodo elegido, para no mezclar rangos de fecha distintos
  var limite = Date.now() - dias*86400000;
  var porEtiqueta = {};
  DATOS.viajes.filter(function(v){ return new Date(v.fecha).getTime()>=limite; }).forEach(function(v){
    var et = v.etiqueta || 'otro';
    if(!porEtiqueta[et]) porEtiqueta[et] = [];
    var c = consumoViaje(v); if(c>0) porEtiqueta[et].push(c);
  });
  Object.keys(porEtiqueta).forEach(function(et){
    var arr = porEtiqueta[et];
    if(!arr.length) return;
    var media = arr.reduce(function(a,b){return a+b;},0)/arr.length;
    filas.push('<div class="fila"><div class="fila-tx"><div class="t1">Por tipo: '+esc({personal:'Personal',trabajo:'Trabajo',otro:'Otro'}[et]||et)+'</div><div class="t2">'+arr.length+' viaje(s) con datos</div></div>'+
      '<div class="fila-r"><div class="r1">'+fmt1(media,' kWh/100km')+'</div></div></div>');
  });
  cont.innerHTML = filas.join('') || '<div class="vacio"><span class="em">📊</span><p>Sin viajes con datos de batería en este periodo.</p></div>';
}

/* ---------- Fase 3, punto 22: detección de anomalías (correlación, nunca causalidad afirmada) ---------- */
function detectarAnomaliasConsumo(){
  var anomalias = [];
  var reciente30 = consumoMedioUltimosDias(30);
  var referencia90 = consumoMedioUltimosDias(90);
  if(reciente30!==null && referencia90!==null && referencia90>0){
    var variacionPct = Math.round((reciente30-referencia90)/referencia90*100);
    if(Math.abs(variacionPct) >= 10){
      var variables = [];
      if(temperaturaCacheada!=null && temperaturaCacheada<10) variables.push('temperatura fría reciente ('+Math.round(temperaturaCacheada)+' °C)');
      var viajesRecientes = DATOS.viajes.filter(function(v){ return (Date.now()-new Date(v.fecha).getTime())<=30*86400000; });
      var cortosPct = viajesRecientes.length ? Math.round(viajesRecientes.filter(function(v){return v.km<5;}).length/viajesRecientes.length*100) : 0;
      if(cortosPct>=30) variables.push(cortosPct+'% de los viajes recientes son trayectos cortos (<5 km, consumo peor por km en frío de motor/batería)');
      var neumaticosViejos = DATOS.neumaticos && DATOS.neumaticos.delanteros && (DATOS.vehiculo.odometro_km - DATOS.neumaticos.delanteros.km_instalacion) > DATOS.neumaticos.delanteros.vida_util_km;
      if(neumaticosViejos) variables.push('los neumáticos delanteros ya han superado su vida útil estimada');
      anomalias.push({
        mensaje: 'Tu consumo medio de los últimos 30 días ('+fmt1(reciente30,' kWh/100km')+') es un '+Math.abs(variacionPct)+' % '+(variacionPct>0?'superior':'inferior')+' a tu referencia de los últimos 90 días ('+fmt1(referencia90,' kWh/100km')+').',
        variables: variables,
        severidad: Math.abs(variacionPct)>=25 ? 'aviso' : 'info'
      });
    }
  }
  return anomalias;
}
function renderAnomalias(){
  var sec = document.getElementById('sec-anomalias');
  var cont = document.getElementById('stats-anomalias');
  if(!sec || !cont) return;
  var anomalias = detectarAnomaliasConsumo();
  if(!anomalias.length){ sec.style.display = 'none'; return; }
  sec.style.display = '';
  cont.innerHTML = anomalias.map(function(a){
    return '<div class="fila"><div class="fila-tx"><div class="t1">'+esc(a.mensaje)+'</div>'+
      (a.variables.length ? '<div class="t2">Variables relacionadas (no se afirma que sean la causa): '+esc(a.variables.join('; '))+'</div>' : '<div class="t2">Sin variables adicionales que lo expliquen con los datos disponibles.</div>')+
      '</div></div>';
  }).join('');
}

/* ---------- Desglose por conductor (solo si hay más de uno registrado) ---------- */
function renderPorConductor(){
  var sec = document.getElementById('sec-conductores');
  var cont = document.getElementById('stats-conductores');
  if(!sec || !cont) return;
  var porConductor = {};
  DATOS.viajes.forEach(function(v){
    var nombre = (v.conductor||'').trim() || 'Sin especificar';
    if(!porConductor[nombre]) porConductor[nombre] = { km:0, n:0, kwh:0 };
    porConductor[nombre].km += v.km;
    porConductor[nombre].n += 1;
    var c = consumoViaje(v);
    if(c>0) porConductor[nombre].kwh += v.km/100*c;
  });
  var nombres = Object.keys(porConductor);
  var conductoresReales = nombres.filter(function(n){ return n!=='Sin especificar'; });
  if(conductoresReales.length < 2){ sec.style.display = 'none'; return; }
  sec.style.display = '';
  var precioMedioCarga = precioMedioKwhParaEstimaciones();
  nombres.sort(function(a,b){ return porConductor[b].km - porConductor[a].km; });
  cont.innerHTML = nombres.map(function(nombre){
    var d = porConductor[nombre];
    var coste = d.kwh*precioMedioCarga;
    return '<div class="fila"><div class="fila-tx"><div class="t1">'+esc(nombre)+'</div><div class="t2">'+d.n+' viaje'+(d.n===1?'':'s')+' · '+d.kwh.toFixed(1)+' kWh estimados</div></div>'+
      '<div class="fila-r"><div class="r1">'+d.km.toFixed(0)+' km</div><div class="r2">~'+euros(coste)+'</div></div></div>';
  }).join('');
}

/* ---------- Comparador de temporadas: este mes vs. el mismo mes del año pasado ---------- */
function renderComparadorTemporada(){
  var cont = document.getElementById('stats-temporada');
  if(!cont) return;
  var ahora = new Date();
  var mesActual = ahora.getMonth(), añoActual = ahora.getFullYear();

  function statsDelMes(mes, año){
    var viajesMes = DATOS.viajes.filter(function(v){ var d=new Date(v.fecha); return d.getMonth()===mes && d.getFullYear()===año; });
    var cargasMes = DATOS.cargas.filter(function(c){ var d=new Date(c.fecha); return d.getMonth()===mes && d.getFullYear()===año; });
    var km = viajesMes.reduce(function(s,v){return s+v.km;},0);
    var coste = sumaCosteConocido(cargasMes);
    return { km:km, coste:coste, n:viajesMes.length };
  }
  var esteAño = statsDelMes(mesActual, añoActual);
  var añoPasado = statsDelMes(mesActual, añoActual-1);

  if(añoPasado.n===0){
    cont.innerHTML = '<div class="vacio"><span class="em">📅</span><p>Todavía no hay datos de '+MESES_LARGO[mesActual]+' del año pasado para comparar — se irá llenando solo con el tiempo.</p></div>';
    return;
  }
  function filaComparativa(etiqueta, actual, anterior, formatear){
    var dif = anterior ? ((actual-anterior)/anterior*100) : 0;
    var color = dif>0 ? 'var(--acc)' : (dif<0 ? 'var(--ok)' : 'var(--txt3)');
    var signo = dif>0 ? '+' : '';
    return '<div class="fila"><div class="fila-tx"><div class="t1">'+etiqueta+'</div>'+
      '<div class="t2">'+formatear(anterior)+' el año pasado</div></div>'+
      '<div class="fila-r"><div class="r1">'+formatear(actual)+'</div><div class="r2" style="color:'+color+'">'+signo+dif.toFixed(0)+' %</div></div></div>';
  }
  cont.innerHTML =
    filaComparativa('Kilómetros', esteAño.km, añoPasado.km, function(v){return v.toFixed(0)+' km';}) +
    filaComparativa('Coste de energía', esteAño.coste, añoPasado.coste, function(v){return euros(v);});
}

/* ---------- Récords personales ---------- */
/* ---------- Año en resumen (estilo "wrapped") ---------- */
document.getElementById('btn-resumen-anual').addEventListener('click', function(){
  var cont = document.getElementById('tarjeta-resumen-anual');
  if(cont.style.display !== 'none'){ cont.style.display = 'none'; this.classList.remove('on'); return; }
  this.classList.add('on');

  var año = new Date().getFullYear();
  var viajesAño = DATOS.viajes.filter(function(v){ return new Date(v.fecha).getFullYear()===año; });
  var cargasAño = DATOS.cargas.filter(function(c){ return new Date(c.fecha).getFullYear()===año; });
  var km = viajesAño.reduce(function(s,v){ return s+v.km; }, 0);
  var kwh = cargasAño.reduce(function(s,c){ return s+c.kwh; }, 0);
  var costeTesla = sumaCosteConocido(cargasAño);
  var costeGasolina100 = DATOS.referencia_gasolina.consumo_l_100km*DATOS.referencia_gasolina.precio_litro;
  var ahorro = (costeGasolina100/100*km) - costeTesla;
  var co2 = (km/100*DATOS.referencia_gasolina.consumo_l_100km*ASSUMPTIONS.factorCo2KgPorLitro.valor);

  var consumos = viajesAño.map(consumoViaje).filter(function(c){return c>0;});
  var mejorConsumo = consumos.length ? Math.min.apply(null,consumos) : null;

  var porMes = {};
  viajesAño.forEach(function(v){ var m=new Date(v.fecha).getMonth(); porMes[m]=(porMes[m]||0)+v.km; });
  var mesTop = Object.keys(porMes).sort(function(a,b){ return porMes[b]-porMes[a]; })[0];

  // Punto 27: horas conduciendo (solo con duración registrada, no se inventa nada)
  var minutosAñoWrap = viajesAño.reduce(function(s,v){ return s+(v.duracion_min||0); }, 0);
  var horasTxt = minutosAñoWrap>0 ? (Math.floor(minutosAñoWrap/60)+'h '+(minutosAñoWrap%60)+'min') : null;

  // Punto 27: carga más barata del año (solo entre cargas con precio conocido, precio > 0 para evitar destacar un 0€ sin facturar)
  var cargasConPrecio = cargasAño.filter(function(c){ return typeof c.precio_kwh==='number' && c.precio_kwh>0; });
  var cargaBarata = cargasConPrecio.length ? cargasConPrecio.reduce(function(a,b){ return b.precio_kwh<a.precio_kwh ? b : a; }) : null;

  // Punto 27: % de energía en Casa vs. otras
  var kwhCasaWrap = cargasAño.filter(function(c){ return c.tipo==='domestica'; }).reduce(function(s,c){ return s+c.kwh; }, 0);
  var pctCasaWrap = kwh>0 ? Math.round(kwhCasaWrap/kwh*100) : null;

  // Punto 27: % AC vs DC (solo entre cargas con el dato registrado; no se asume nada de las que no lo tienen)
  var cargasConTipoCorriente = cargasAño.filter(function(c){ return c.ac_dc==='AC' || c.ac_dc==='DC'; });
  var kwhAC = cargasConTipoCorriente.filter(function(c){ return c.ac_dc==='AC'; }).reduce(function(s,c){ return s+c.kwh; }, 0);
  var kwhDC = cargasConTipoCorriente.filter(function(c){ return c.ac_dc==='DC'; }).reduce(function(s,c){ return s+c.kwh; }, 0);
  var kwhConTipoCorriente = kwhAC+kwhDC;
  var pctAC = kwhConTipoCorriente>0 ? Math.round(kwhAC/kwhConTipoCorriente*100) : null;

  // Punto 27: comparación con el año anterior (solo si hay datos del año anterior; nunca se compara con "0" inventado)
  var añoAnteriorWrap = año-1;
  var viajesAñoAnteriorWrap = DATOS.viajes.filter(function(v){ return new Date(v.fecha).getFullYear()===añoAnteriorWrap; });
  var kmAñoAnteriorWrap = viajesAñoAnteriorWrap.reduce(function(s,v){ return s+v.km; }, 0);
  var hayComparativaWrap = viajesAñoAnteriorWrap.length>0;
  var variacionKmWrap = hayComparativaWrap && kmAñoAnteriorWrap>0 ? ((km-kmAñoAnteriorWrap)/kmAñoAnteriorWrap*100) : null;

  cont.style.display = '';
  cont.innerHTML =
    '<div style="text-align:center;padding:6px 0 14px">'+
    '<div style="font-size:13px;font-weight:700;color:var(--txt3);text-transform:uppercase;letter-spacing:.04em">Tu '+año+' con el '+esc(DATOS.vehiculo.modelo?DATOS.vehiculo.modelo.split(' ').slice(0,2).join(' '):'Model Y')+'</div>'+
    '</div>'+
    '<div class="grid2">'+
    '<div class="card"><div class="lbl">Kilómetros</div><div class="val">'+km.toLocaleString('es-ES')+' km</div><div class="sub">'+viajesAño.length+' viajes</div></div>'+
    '<div class="card"><div class="lbl">Energía cargada</div><div class="val">'+kwh.toFixed(0)+' kWh</div><div class="sub">'+cargasAño.length+' cargas</div></div>'+
    '<div class="card"><div class="lbl">Ahorro vs. gasolina</div><div class="val ok">'+euros(ahorro)+'</div><div class="sub">Este año</div></div>'+
    '<div class="card"><div class="lbl">CO₂ evitado</div><div class="val ok">'+co2.toFixed(0)+' kg</div><div class="sub">Estimado</div></div>'+
    (horasTxt ? '<div class="card"><div class="lbl">Horas conduciendo</div><div class="val">'+horasTxt+'</div><div class="sub">Viajes con duración registrada</div></div>' : '')+
    (pctCasaWrap!==null ? '<div class="card"><div class="lbl">Carga en casa</div><div class="val">'+pctCasaWrap+' %</div><div class="sub">de la energía cargada</div></div>' : '')+
    '</div>'+
    (mejorConsumo ? '<div class="ahorro" style="margin-top:12px"><div class="lbl">Tu mejor eficiencia</div><div class="val">'+mejorConsumo.toFixed(1)+' kWh/100km</div><div class="sub">Tu récord de '+año+'</div></div>' : '')+
    (cargaBarata ? '<p style="font-size:13px;color:var(--txt3);padding:12px 4px 0;text-align:center">Tu carga más barata: <b style="color:var(--txt)">'+esc(cargaBarata.lugar)+'</b> a '+cargaBarata.precio_kwh.toFixed(2)+' €/kWh</p>' : '')+
    (pctAC!==null ? '<p style="font-size:13px;color:var(--txt3);padding:4px 4px 0;text-align:center">Reparto de carga: <b style="color:var(--txt)">'+pctAC+' % AC</b> / <b style="color:var(--txt)">'+(100-pctAC)+' % DC</b></p>' : '')+
    (mesTop!==undefined ? '<p style="font-size:13px;color:var(--txt3);padding:4px 4px 0;text-align:center">Tu mes con más kilómetros: <b style="color:var(--txt)">'+MESES_LARGO[mesTop]+'</b></p>' : '')+
    (hayComparativaWrap ? '<p style="font-size:13px;color:var(--txt3);padding:4px 4px 0;text-align:center">Frente a '+añoAnteriorWrap+': <b style="color:var(--txt)">'+kmAñoAnteriorWrap.toLocaleString('es-ES')+' km</b>'+(variacionKmWrap!==null ? ' ('+(variacionKmWrap>0?'+':'')+variacionKmWrap.toFixed(0)+' %)' : '')+'</p>' : '');
  // Privacidad: este resumen nunca incluye coordenadas ni direcciones, solo cifras agregadas — nada que proteger con el radio de privacidad.
});

function renderRecords(){
  var cont = document.getElementById('stats-records');
  if(!cont) return;
  var filas = [];

  if(DATOS.viajes.length){
    var viajesConConsumo = DATOS.viajes.map(function(v){ return { v:v, c:consumoViaje(v) }; }).filter(function(x){ return x.c>0; });
    if(viajesConConsumo.length){
      var mejor = viajesConConsumo.reduce(function(a,b){ return b.c<a.c ? b : a; });
      var peor = viajesConConsumo.reduce(function(a,b){ return b.c>a.c ? b : a; });
      filas.push('<div class="fila"><div class="ico viaje" data-icon="ruta"></div><div class="fila-tx"><div class="t1">Viaje más eficiente</div><div class="t2">'+esc(mejor.v.origen)+' → '+esc(mejor.v.destino)+'</div></div><div class="fila-r"><div class="r1 ok" style="color:var(--ok)">'+mejor.c.toFixed(1)+' kWh/100km</div></div></div>');
      filas.push('<div class="fila"><div class="ico viaje" data-icon="ruta"></div><div class="fila-tx"><div class="t1">Viaje menos eficiente</div><div class="t2">'+esc(peor.v.origen)+' → '+esc(peor.v.destino)+'</div></div><div class="fila-r"><div class="r1">'+peor.c.toFixed(1)+' kWh/100km</div></div></div>');
    }
    var masLargo = DATOS.viajes.reduce(function(a,b){ return b.km>a.km ? b : a; });
    filas.push('<div class="fila"><div class="ico viaje" data-icon="ruta"></div><div class="fila-tx"><div class="t1">Viaje más largo</div><div class="t2">'+esc(masLargo.origen)+' → '+esc(masLargo.destino)+'</div></div><div class="fila-r"><div class="r1">'+masLargo.km.toFixed(1)+' km</div></div></div>');
  }
  // A canonical charge may have no unit price; unknown prices are not records.
  var cargasConPrecio = DATOS.cargas.filter(function(c){
    return typeof c.precio_kwh==='number' && isFinite(c.precio_kwh) && c.precio_kwh>=0;
  }).map(function(c){ return { c:c, precio:c.precio_kwh }; });
  if(cargasConPrecio.length){
    var barata = cargasConPrecio.reduce(function(a,b){ return b.precio<a.precio ? b : a; });
    var cara = cargasConPrecio.reduce(function(a,b){ return b.precio>a.precio ? b : a; });
    filas.push('<div class="fila"><div class="ico carga" data-icon="rayo"></div><div class="fila-tx"><div class="t1">Carga más barata</div><div class="t2">'+esc(barata.c.lugar)+'</div></div><div class="fila-r"><div class="r1" style="color:var(--ok)">'+barata.precio.toFixed(2)+' €/kWh</div></div></div>');
    filas.push('<div class="fila"><div class="ico carga" data-icon="rayo"></div><div class="fila-tx"><div class="t1">Carga más cara</div><div class="t2">'+esc(cara.c.lugar)+'</div></div><div class="fila-r"><div class="r1">'+cara.precio.toFixed(2)+' €/kWh</div></div></div>');
  }

  cont.innerHTML = filas.join('') || '<div class="vacio"><span class="em">🏆</span><p>Registra viajes y cargas para ver tus récords.</p></div>';
  aplicarIconos();
}

/* ---------- Logros / insignias ---------- */
var LOGROS = [
  { id:'primer_viaje', em:'🚗', nombre:'Primer viaje', desc:'Registra tu primer trayecto', cumple:function(c){return c.viajes>=1;} },
  { id:'primera_carga', em:'⚡', nombre:'Primera carga', desc:'Registra tu primera carga', cumple:function(c){return c.cargas>=1;} },
  { id:'10_cargas', em:'🔋', nombre:'Habitual del enchufe', desc:'10 cargas registradas', cumple:function(c){return c.cargas>=10;} },
  { id:'100km', em:'🛣️', nombre:'Rodando', desc:'100 km registrados', cumple:function(c){return c.km>=100;} },
  { id:'1000km', em:'🏁', nombre:'Mil kilómetros', desc:'1.000 km registrados', cumple:function(c){return c.km>=1000;} },
  { id:'ahorro100', em:'💶', nombre:'Primeros 100 €', desc:'100 € ahorrados frente a gasolina', cumple:function(c){return c.ahorro>=100;} },
  { id:'ahorro1000', em:'💰', nombre:'Mil euros ahorrados', desc:'1.000 € ahorrados frente a gasolina', cumple:function(c){return c.ahorro>=1000;} },
  { id:'co2_500', em:'🌱', nombre:'Aire limpio', desc:'500 kg de CO₂ evitados', cumple:function(c){return c.co2>=500;} },
  { id:'eficiente', em:'🏆', nombre:'Conducción eficiente', desc:'Un viaje bajo 14 kWh/100km', cumple:function(c){return c.mejorConsumo>0 && c.mejorConsumo<14;} }
];
function renderLogros(s, ahorroTotal, kmOdometro, co2){
  var cont = document.getElementById('stats-logros');
  if(!cont) return;
  var ctx = { viajes:s.n, cargas:DATOS.cargas.length, km:s.km, ahorro:ahorroTotal, co2:Number(co2), mejorConsumo:s.mejor };
  cont.innerHTML = LOGROS.map(function(l){
    var ok = l.cumple(ctx);
    return '<div class="logro'+(ok?' on':'')+'"><span class="em">'+l.em+'</span>'+
      '<div class="nombre">'+l.nombre+'</div><div class="desc">'+l.desc+'</div></div>';
  }).join('');
}

/* ---------- Render: Dashboard ---------- */
function ultimoEvento(){
  var eventos = DATOS.viajes.map(function(v){ return { fecha:v.fecha, pct:v.bateria_final }; })
    .concat(DATOS.cargas.map(function(c){ return { fecha:c.fecha, pct:c.bateria_final }; }))
    .filter(function(e){ return typeof e.pct==='number'; }); // solo eventos con un % de batería real registrado
  if(!eventos.length) return null;
  eventos.sort(function(a,b){ return new Date(b.fecha)-new Date(a.fecha); });
  return eventos[0];
}
function nivelCargaActual(){
  // devuelve null si no hay ningún dato real de batería: no se inventa un 80% de partida
  var ev = ultimoEvento();
  return ev ? ev.pct : null;
}
function tiempoRelativo(fechaStr){
  var diffMs = new Date() - new Date(fechaStr); // fechaStr es de un viaje/carga (datetime-local), ya incluye hora
  var min = Math.floor(diffMs/60000);
  if(min < 1) return 'ahora mismo';
  if(min < 60) return 'hace '+min+' min';
  var horas = Math.floor(min/60);
  if(horas < 24) return 'hace '+horas+' h';
  var dias = Math.floor(horas/24);
  if(dias === 1) return 'ayer';
  if(dias < 30) return 'hace '+dias+' días';
  return new Date(fechaStr).toLocaleDateString('es-ES', {day:'numeric', month:'short'});
}

function renderDashboard(){
  var avisoDanados = document.getElementById('aviso-datos-dañados');
  if(DATOS_CORRUPTOS){
    avisoDanados.style.display = '';
    avisoDanados.innerHTML = '<div class="aviso-banda" style="cursor:pointer" id="btn-descargar-corruptos">'+li('aviso')+
      'No se pudo leer el archivo de datos guardado en este dispositivo — se ha empezado con datos de ejemplo para no perder nada. Toca aquí para descargar el archivo dañado (o restaura una copia de seguridad en Ajustes).</div>';
    aplicarIconos();
    var btnDesc = document.getElementById('btn-descargar-corruptos');
    if(btnDesc) btnDesc.onclick = descargarDatosCorruptos;
  } else {
    avisoDanados.style.display = 'none';
  }
  var s = statsViajes();
  var hist = DATOS.bateria_historico;
  var bateriaActual = hist.length ? hist[hist.length-1].capacidad_pct : null;
  var costeTesla100 = (s.media!==null?s.media:ASSUMPTIONS.consumoReferenciaKwh100km.valor)/100*precioMedioKwhParaEstimaciones(); // referencia si aún no hay viajes suficientes con datos de batería
  var costeGasolina100 = DATOS.referencia_gasolina.consumo_l_100km*DATOS.referencia_gasolina.precio_litro;
  var totalGastos = DATOS.gastos.reduce(function(s,g){return s+g.importe;},0);
  var totalEnergia = sumaCosteConocido(DATOS.cargas);
  var ahorroTotal = (costeGasolina100-costeTesla100)/100*kmSeguimiento(); // solo sobre los km recorridos desde que se activó el seguimiento, no todo el histórico del coche

  var cargaActual = nivelCargaActual();
  var ar = autonomiaRealKm();
  document.getElementById('dash-bateria-num').innerHTML = (cargaActual===null?'—':cargaActual) + '<span>%</span>';
  document.getElementById('dash-barra').style.width = (cargaActual===null?0:cargaActual) + '%';
  document.getElementById('dash-autonomia').textContent = (cargaActual===null?'—':Math.round(ar.km * cargaActual/100).toLocaleString('es-ES')) + ' km';
  var ultEv = ultimoEvento();
  document.getElementById('dash-ultima-act').textContent = ultEv ? tiempoRelativo(ultEv.fecha) : 'sin datos aún';

  var umbral = parseInt(localStorage.getItem('mitesla-umbral-bateria')) || 20;
  var avisoEl = document.getElementById('aviso-bateria-baja');
  if(cargaActual !== null && cargaActual < umbral){
    avisoEl.style.display = '';
    avisoEl.innerHTML = '<div class="aviso-banda" style="cursor:pointer" data-goto="cargas">'+li('bateria')+'Batería al '+cargaActual+' %, por debajo de tu aviso ('+umbral+' %). Puede ser buen momento para cargar.</div>';
    aplicarIconos();
  } else {
    avisoEl.style.display = 'none';
  }
  if(cargaActual !== null) avisarBateriaBajaSiHaceFalta(cargaActual, umbral);

  /* Aviso de mantenimiento más urgente (recordatorio por km o seguro por fecha) */
  var avisoMant = document.getElementById('aviso-mantenimiento');
  var candidatos = [];
  (DATOS.recordatorios||[]).forEach(function(r){
    var restante = r.km_objetivo - DATOS.vehiculo.odometro_km;
    if(restante <= 2000) candidatos.push({ texto: esc(r.concepto)+(restante<=0 ? ' — superado hace '+Math.abs(restante).toLocaleString('es-ES')+' km' : ' — quedan '+restante.toLocaleString('es-ES')+' km'), urgencia: restante, tab:'economia' });
  });
  if(DATOS.seguro && DATOS.seguro.fecha_renovacion){
    var dias = diasHasta(DATOS.seguro.fecha_renovacion);
    if(dias <= 30) candidatos.push({ texto:'Renovación del seguro'+(dias<=0 ? ' — venció hace '+Math.abs(dias)+' días' : ' — quedan '+dias+' días'), urgencia: dias*66, tab:'economia' }); // 66 ≈ km/día equivalente, solo para comparar urgencias distintas
  }
  if(DATOS.itv && DATOS.itv.fecha){
    var diasItv = diasHasta(DATOS.itv.fecha);
    if(diasItv <= 60) candidatos.push({ texto:'ITV'+(diasItv<=0 ? ' — caducada hace '+Math.abs(diasItv)+' días' : ' — quedan '+diasItv+' días'), urgencia: diasItv*66, tab:'economia' });
  }
  if(DATOS.neumaticos){
    ['delanteros','traseros'].forEach(function(eje){
      var n = DATOS.neumaticos[eje];
      if(!n) return;
      var recorridos = Math.max(0, DATOS.vehiculo.odometro_km - n.km_instalacion);
      var restanteNeum = n.vida_util_km - recorridos;
      if(restanteNeum <= 3000){
        var nombreEje = eje === 'delanteros' ? 'Neumáticos delanteros' : 'Neumáticos traseros';
        candidatos.push({ texto: nombreEje+(restanteNeum<=0 ? ' — han superado su vida útil estimada' : ' — quedan ~'+restanteNeum.toLocaleString('es-ES')+' km'), urgencia: restanteNeum, tab:'economia' });
      }
    });
  }
  (DATOS.accesorios||[]).forEach(function(a){
    if(!a.meses_garantia) return;
    var expira = fechaMasMeses(a.fecha, a.meses_garantia);
    var diasRest = Math.ceil((expira-new Date())/(1000*3600*24));
    if(diasRest > 0 && diasRest <= 30){
      candidatos.push({ texto: 'Garantía de "'+esc(a.nombre)+'" caduca'+(diasRest<=0?' hoy':' en '+diasRest+' día'+(diasRest===1?'':'s')), urgencia: diasRest*66, tab:'economia' });
    }
  });
  var ghCfg = cargarConfigGithub();
  if(ghCfg && ghCfg.repo && ghCfg.token){
    var ultimaSync = localStorage.getItem('mitesla-ultima-sync');
    var diasSinSync = ultimaSync ? Math.floor((new Date()-new Date(ultimaSync))/(1000*3600*24)) : null;
    if(diasSinSync === null || diasSinSync >= 7){
      candidatos.push({ texto: diasSinSync===null ? 'Todavía no se ha sincronizado ninguna copia con GitHub' : 'Sin sincronizar con GitHub desde hace '+diasSinSync+' días', urgencia: diasSinSync===null ? -9999 : (30-diasSinSync)*66, tab:'ajustes' });
    }
  }
  if(candidatos.length){
    candidatos.sort(function(a,b){ return a.urgencia-b.urgencia; });
    avisoMant.style.display = '';
    avisoMant.innerHTML = '<div class="aviso-banda" style="background:rgba(232,145,42,.12);color:var(--warn);cursor:pointer" data-goto="'+candidatos[0].tab+'">'+li('ajustes')+candidatos[0].texto+'</div>';
    aplicarIconos();
  } else {
    avisoMant.style.display = 'none';
  }

  var TEXTOS_ESTADO = { aparcado:'Aparcado en casa', cargando:'Cargando en casa', conduciendo:'En marcha' };
  var PILL_ESTADO = { aparcado:'En reposo', cargando:'Cargando', conduciendo:'En marcha' };
  document.getElementById('dash-estado').textContent = TEXTOS_ESTADO[DATOS.vehiculo.estado] || TEXTOS_ESTADO.aparcado;
  document.getElementById('dash-modelo').textContent = DATOS.vehiculo.modelo || 'Model Y · Long Range';
  document.querySelectorAll('#estado-selector button').forEach(function(b){
    b.classList.toggle('on', b.dataset.estado === DATOS.vehiculo.estado);
  });
  var estadoActual = DATOS.vehiculo.estado || 'aparcado';
  document.getElementById('pill-texto').textContent = PILL_ESTADO[estadoActual] || PILL_ESTADO.aparcado;
  document.getElementById('pill-estado').className = 'pill p-'+estadoActual;

  aplicarSnapshotTeslaEnDashboard();

  var odoSub = DATOS.vehiculo.odometro_tesla_actualizado_at
    ? 'Odómetro · Tesla · '+tiempoRelativo(DATOS.vehiculo.odometro_tesla_actualizado_at)
    : 'Desde la compra';
  document.getElementById('dash-metricas').innerHTML =
    '<div class="card"><div class="lbl">'+li('ruta')+'Odómetro</div><div class="val">'+DATOS.vehiculo.odometro_km.toLocaleString('es-ES')+' km</div><div class="sub">'+odoSub+'</div></div>'+
    '<div class="card"><div class="lbl">'+li('rayo')+'Consumo medio</div><div class="val">'+fmt1(s.media)+' <span style="font-size:14px;font-weight:600;color:var(--txt3)">kWh/100km</span></div><div class="sub">'+(s.media===null?'Sin viajes con datos':'Últimos viajes')+'</div></div>'+
    '<div class="card"><div class="lbl">'+li('euro')+'Coste medio</div><div class="val">'+costeTesla100.toFixed(2)+' €<span style="font-size:14px;font-weight:600;color:var(--txt3)">/100km</span></div><div class="sub">Frente a '+costeGasolina100.toFixed(2)+' € gasolina</div></div>'+
    '<div class="card"><div class="lbl">'+li('bateria')+'Batería</div><div class="val'+(bateriaActual===null?'':' ok')+'">'+(bateriaActual===null?'—':bateriaActual.toFixed(1)+' %')+'</div><div class="sub">'+(bateriaActual===null?'Sin lecturas todavía':'Capacidad estimada')+'</div></div>';

  document.getElementById('dash-ahorro').textContent = euros(ahorroTotal);
  document.getElementById('dash-ahorro-sub').textContent = 'sobre '+kmSeguimiento().toLocaleString('es-ES')+' km desde que activaste el seguimiento';

  var viajes = DATOS.viajes.slice().sort(function(a,b){ return new Date(b.fecha)-new Date(a.fecha); }).slice(0,3);
  document.getElementById('dash-viajes').innerHTML = viajes.map(function(v){
    var c = consumoViaje(v);
    return '<div class="fila"><div class="ico viaje" data-icon="ruta"></div>'+
      '<div class="fila-tx"><div class="t1">'+esc(v.origen)+' → '+esc(v.destino)+'</div><div class="t2">'+fechaCorta(v.fecha)+' · '+v.duracion_min+' min</div></div>'+
      '<div class="fila-r"><div class="r1">'+fmt1(v.km)+' km</div><div class="r2">'+fmt1(c,' kWh/100km')+'</div></div></div>';
  }).join('') || '<div class="vacio"><span class="em">🚗</span><p>Todavía no hay viajes registrados.</p></div>';

  var cargas = DATOS.cargas.slice().sort(function(a,b){ return new Date(b.fecha)-new Date(a.fecha); }).slice(0,2);
  document.getElementById('dash-cargas').innerHTML = cargas.map(function(c){
    return '<div class="fila"><div class="ico carga" data-icon="rayo"></div>'+
      '<div class="fila-tx"><div class="t1">'+esc(c.lugar)+'</div><div class="t2">'+fechaCorta(c.fecha)+' · '+fmtBateria(c.bateria_inicial)+' → '+fmtBateria(c.bateria_final)+'</div></div>'+
      '<div class="fila-r"><div class="r1">'+fmt1(c.kwh)+' kWh</div><div class="r2">'+euros(costeCarga(c))+'</div></div></div>';
  }).join('') || '<div class="vacio"><span class="em">⚡</span><p>Todavía no hay cargas registradas.</p></div>';

  aplicarIconos();
}
var editandoCarga = null;
var filtroCargaActivo = 'todo';
function renderCargas(){
  var cargas = DATOS.cargas.slice().sort(function(a,b){ return new Date(b.fecha)-new Date(a.fecha); });
  // B23: cada "*Coste"/"*ConCoste" solo suma cargas de coste conocido (costeCarga()===null se
  // excluye, nunca se cuenta como 0€); "*Kwh" sigue contando la energía real de TODAS las cargas
  // de ese grupo, coste conocido o no — para que "Energía total"/"Casa"/"Supercharger" en kWh no
  // pierdan cargas reales solo porque su precio no se conoce todavía.
  var totalKwh=0, totalCoste=0, kwhConCoste=0, casaKwh=0, casaCoste=0, casaKwhConCoste=0;
  var scKwh=0, scCoste=0, scKwhConCoste=0, nDesconocidas=0;
  cargas.forEach(function(c){
    var coste = costeCarga(c);
    totalKwh += c.kwh;
    if(c.tipo==='domestica') casaKwh += c.kwh;
    if(c.tipo==='supercharger') scKwh += c.kwh;
    if(coste===null){ nDesconocidas++; return; }
    totalCoste += coste; kwhConCoste += c.kwh;
    if(c.tipo==='domestica'){ casaCoste+=coste; casaKwhConCoste+=c.kwh; }
    if(c.tipo==='supercharger'){ scCoste+=coste; scKwhConCoste+=c.kwh; }
  });
  var subCoste = (kwhConCoste?(totalCoste/kwhConCoste).toFixed(2):'—')+' €/kWh medio'+
    (nDesconocidas>0 ? ' · '+nDesconocidas+' carga'+(nDesconocidas===1?'':'s')+' de coste desconocido (no incluida'+(nDesconocidas===1?'':'s')+' en el total)' : '');
  document.getElementById('resumen-cargas').innerHTML =
    '<div class="card"><div class="lbl">'+li('rayo')+'Energía total</div><div class="val">'+totalKwh.toFixed(1)+' kWh</div><div class="sub">'+cargas.length+' cargas registradas</div></div>'+
    '<div class="card"><div class="lbl">'+li('euro')+'Coste conocido</div><div class="val">'+euros(kwhConCoste>0 || cargas.length===0 ? totalCoste : null)+'</div><div class="sub">'+subCoste+'</div></div>'+
    '<div class="card"><div class="lbl">'+li('home')+'Casa</div><div class="val">'+casaKwh.toFixed(1)+' kWh</div><div class="sub">'+euros(casaKwhConCoste>0 ? casaCoste : null)+'</div></div>'+
    '<div class="card"><div class="lbl">'+li('pin')+'Supercharger</div><div class="val">'+scKwh.toFixed(1)+' kWh</div><div class="sub">'+euros(scKwhConCoste>0 ? scCoste : null)+'</div></div>';

  var qCargas = normalizarTexto(document.getElementById('buscar-cargas').value);
  var filtradas = cargas.filter(function(c){
    if(filtroCargaActivo!=='todo' && c.tipo!==filtroCargaActivo) return false;
    if(qCargas && normalizarTexto(c.lugar).indexOf(qCargas)===-1) return false;
    return true;
  });

  document.getElementById('lista-cargas').innerHTML = filtradas.length ? agruparPorMes(filtradas, function(c){
    var coste = costeCarga(c);
    return '<div class="fila">'+
      '<div class="ico carga" data-icon="rayo"></div>'+
      '<div class="fila-tx" data-editar-carga="'+c.id+'"><div class="t1">'+esc(c.lugar)+(c.ac_dc?' · '+c.ac_dc:'')+'</div>'+
      '<div class="t2">'+fechaCorta(c.fecha)+' · '+fmtBateria(c.bateria_inicial)+' → '+fmtBateria(c.bateria_final)+(c.red?' · '+esc(c.red):'')+'</div></div>'+
      '<div class="fila-r"><div class="r1">'+fmt1(c.kwh)+' kWh</div><div class="r2">'+euros(coste)+'</div></div>'+
      '<button type="button" class="btn-duplicar" data-duplicar-carga="'+c.id+'" data-icon="duplicar" aria-label="Duplicar"></button>'+
      '<button type="button" class="btn-borrar" data-borrar-carga="'+c.id+'" data-icon="papelera" aria-label="Eliminar"></button>'+
      '</div>';
  }) : '<div class="vacio"><span class="em">⚡</span><p>'+(qCargas ? 'Sin cargas que coincidan con la búsqueda.' : (filtroCargaActivo==='todo' ? 'Todavía no hay cargas. Añade la primera con "+ Añadir".' : 'Sin cargas de este tipo.'))+'</p></div>';

  aplicarIconos();
}
var editandoCargaRevision = null;
function abrirFormCarga(c){
  editandoCargaRevision = c ? c.revision : null;
  editandoCarga = c ? c.id : null;
  document.getElementById('fc-fecha').value = c ? c.fecha : '';
  document.getElementById('fc-lugar').value = c ? c.lugar : '';
  document.getElementById('fc-tipo').value = c ? c.tipo : 'domestica';
  document.getElementById('fc-kwh').value = c ? c.kwh : '';
  document.getElementById('fc-precio').value = c ? c.precio_kwh : '';
  document.getElementById('fc-bini').value = (c && c.bateria_inicial!=null) ? c.bateria_inicial : '';
  document.getElementById('fc-bfin').value = (c && c.bateria_final!=null) ? c.bateria_final : '';
  document.getElementById('fc-acdc').value = (c && c.ac_dc) ? c.ac_dc : '';
  document.getElementById('fc-red').value = (c && c.red) ? c.red : '';
  document.getElementById('fc-potencia').value = (c && c.potencia_max_kw!=null) ? c.potencia_max_kw : '';
  document.getElementById('fc-coste-origen').value = (c && c.cost_source) ? c.cost_source : 'estimado';
  document.getElementById('fc-notas').value = (c && c.notas) ? c.notas : '';
  document.getElementById('fc-fecha-fin').value = (c && c.fecha_fin) ? c.fecha_fin : '';
  document.getElementById('fc-perdidas').value = (c && c.perdidas_pct!=null) ? c.perdidas_pct : '';
  document.getElementById('fc-origen-solar').value = (c && c.origen_energia && c.origen_energia.solar_pct!=null) ? c.origen_energia.solar_pct : '';
  document.getElementById('fc-origen-bateria').value = (c && c.origen_energia && c.origen_energia.bateria_pct!=null) ? c.origen_energia.bateria_pct : '';
  document.getElementById('fc-guardar').textContent = c ? 'Guardar cambios' : 'Guardar carga';
  formCarga.classList.remove('form-oculto');
  renderDesgloseTramos();
}

/* ---------- Render: Gastos / Economía ---------- */
var editandoGasto = null;
function renderGastos(){
  var totalGastos = DATOS.gastos.reduce(function(s,g){ return s+g.importe; }, 0);
  var gastos = DATOS.gastos.slice().sort(function(a,b){ return new Date(b.fecha)-new Date(a.fecha); });
  var elBuscarGastos = document.getElementById('buscar-gastos');
  if(elBuscarGastos && elBuscarGastos.value.trim()){
    var qg = normalizarTexto(elBuscarGastos.value);
    gastos = gastos.filter(function(g){ return normalizarTexto(g.concepto).indexOf(qg)>=0 || normalizarTexto(NOMBRE_CAT[g.categoria]||'').indexOf(qg)>=0; });
  }
  var totalEnergia = sumaCosteConocido(DATOS.cargas);
  var totalGeneral = totalGastos + totalEnergia;

  var filas = '<div class="fila"><div class="fila-tx"><div class="t1">Energía</div><div class="t2">Cargas registradas</div></div>'+
    '<div class="fila-r"><div class="r1">'+euros(totalEnergia)+'</div></div></div>';
  filas += gastos.map(function(g){
    return '<div class="fila"><div class="fila-tx" data-editar-gasto="'+g.id+'"><div class="t1">'+NOMBRE_CAT[g.categoria]+'</div>'+
      '<div class="t2">'+esc(g.concepto)+' · '+new Date(g.fecha+'T00:00:00').toLocaleDateString('es-ES',{day:'numeric',month:'short',year:'numeric'})+'</div></div>'+
      '<div class="fila-r"><div class="r1">'+euros(g.importe)+'</div></div>'+
      '<button type="button" class="btn-duplicar" data-duplicar-gasto="'+g.id+'" data-icon="duplicar" aria-label="Duplicar"></button>'+
      '<button type="button" class="btn-borrar" data-borrar-gasto="'+g.id+'" data-icon="papelera" aria-label="Eliminar"></button></div>';
  }).join('');
  filas += '<div class="fila"><div class="fila-tx"><div class="t1"><b>Total</b></div><div class="t2">Desde la compra</div></div>'+
    '<div class="fila-r"><div class="r1"><b>'+euros(totalGeneral)+'</b></div></div></div>';
  document.getElementById('lista-gastos').innerHTML = filas;

  var km = DATOS.vehiculo.odometro_km;
  var mesesDesdeCompra = Math.max(1, Math.round((new Date() - new Date(DATOS.vehiculo.fecha_compra+'T00:00:00')) / (1000*3600*24*30.44)));
  document.getElementById('resumen-costes').innerHTML =
    '<div class="card"><div class="lbl">'+li('euro')+'Coste por km</div><div class="val">'+(km>0 ? (totalGeneral/km).toFixed(3) : '—')+' €</div><div class="sub">Total / '+km.toLocaleString('es-ES')+' km</div></div>'+
    '<div class="card"><div class="lbl">'+li('euro')+'Coste mensual</div><div class="val">'+Math.round(totalGeneral/mesesDesdeCompra)+' €</div><div class="sub">Media desde la compra ('+mesesDesdeCompra+' meses)</div></div>';
  aplicarIconos();
  renderRecordatorios();
  renderNeumaticos();
  renderAccesorios();
  renderEconomiaResumen();
}

/* ---------- Resumen de Economía: ahorro y coste energético (datos reales) ---------- */
function renderEconomiaResumen(){
  var cont = document.getElementById('eco-ahorro');
  if(!cont) return;
  var s = statsViajes();
  var costeTesla100 = (s.media!==null?s.media:ASSUMPTIONS.consumoReferenciaKwh100km.valor)/100*precioMedioKwhParaEstimaciones(); // referencia si aún no hay viajes suficientes con datos de batería
  var costeGasolina100 = DATOS.referencia_gasolina.consumo_l_100km*DATOS.referencia_gasolina.precio_litro;
  var ahorroTotal = (costeGasolina100-costeTesla100)/100*kmSeguimiento(); // solo sobre los km recorridos desde que se activó el seguimiento, no todo el histórico del coche
  var precioMedioCarga = precioMedioKwhParaEstimaciones();

  cont.querySelector('.val').textContent = euros(ahorroTotal);
  cont.querySelector('.sub').textContent = DATOS.referencia_gasolina.consumo_l_100km.toFixed(1)+' l/100km · '+DATOS.referencia_gasolina.precio_litro.toFixed(2)+' €/l de referencia';

  var grid = document.getElementById('eco-coste-energetico');
  var cards = grid.querySelectorAll('.card');
  cards[0].querySelector('.val').innerHTML = costeTesla100.toFixed(2)+' €<span style="font-size:14px;font-weight:600;color:var(--txt3)">/100km</span>';
  cards[0].querySelector('.sub').textContent = (s.media!==null?fmt1(s.media)+' kWh/100km · ':'Sin datos de consumo · ')+precioMedioCarga.toFixed(2)+' €/kWh medio';
  cards[1].querySelector('.val').innerHTML = costeGasolina100.toFixed(2)+' €<span style="font-size:14px;font-weight:600;color:var(--txt3)">/100km</span>';
  cards[1].querySelector('.sub').textContent = DATOS.referencia_gasolina.consumo_l_100km.toFixed(1)+' l/100km · '+DATOS.referencia_gasolina.precio_litro.toFixed(2)+' €/l';

  dibujarChartCosteKm();
  renderProyeccionAnual();
}

/* ---------- Proyección de ahorro anual, editable por el usuario ---------- */
function renderProyeccionAnual(){
  var cont = document.getElementById('proyeccion-anual');
  var input = document.getElementById('proy-km');
  if(!cont || !input) return;
  var s = statsViajes();
  var kmAnualPorDefecto = 0;
  if(DATOS.viajes.length){
    var fechas = DATOS.viajes.map(function(v){ return new Date(v.fecha); });
    var diasHistorico = Math.max(1, (Math.max.apply(null,fechas) - Math.min.apply(null,fechas)) / (1000*3600*24));
    kmAnualPorDefecto = Math.round(s.km / diasHistorico * 365);
  }
  var kmAnualEscrito = parseFloat(input.value);
  var kmAnual = (!isNaN(kmAnualEscrito) && kmAnualEscrito>0) ? kmAnualEscrito : (kmAnualPorDefecto || 15000);
  if(!input.value) input.placeholder = 'Ej. '+kmAnual.toLocaleString('es-ES');

  var precioMedioCarga = precioMedioKwhParaEstimaciones();
  var costeTeslaReal100 = (s.media>0 ? s.media : 16)/100*precioMedioCarga;
  var costeGasolina100 = DATOS.referencia_gasolina.consumo_l_100km*DATOS.referencia_gasolina.precio_litro;
  var costeTeslaAnual = costeTeslaReal100/100*kmAnual;
  var costeGasolinaAnual = costeGasolina100/100*kmAnual;
  var ahorroAnual = costeGasolinaAnual - costeTeslaAnual;

  cont.innerHTML =
    '<div class="card"><div class="lbl">Coste Tesla estimado</div><div class="val">'+euros(costeTeslaAnual)+'</div><div class="sub">A tu precio medio de carga</div></div>'+
    '<div class="card"><div class="lbl">Coste gasolina equivalente</div><div class="val">'+euros(costeGasolinaAnual)+'</div><div class="sub">Al mismo kilometraje</div></div>'+
    '<div class="card" style="grid-column:1/-1"><div class="lbl">Ahorro anual estimado</div><div class="val ok">'+euros(ahorroAnual)+'</div><div class="sub">Sobre '+kmAnual.toLocaleString('es-ES')+' km/año'+(!input.value?' (estimado a tu ritmo actual)':'')+'</div></div>';
}
document.getElementById('proy-km').addEventListener('input', function(){
  if(this.value) localStorage.setItem('mitesla-proy-km', this.value);
  else localStorage.removeItem('mitesla-proy-km');
  renderProyeccionAnual();
});
(function(){
  var guardado = localStorage.getItem('mitesla-proy-km');
  if(guardado) document.getElementById('proy-km').value = guardado;
})();

/* ---------- Gráfico: coste medio por km, evolución acumulada mes a mes ---------- */
function dibujarChartCosteKm(){
  var cont = document.getElementById('chart-coste-km');
  if(!cont) return;
  if(!DATOS.viajes.length || !DATOS.cargas.length){
    cont.innerHTML = '<div class="vacio" style="padding:20px 0"><span class="em">📉</span><p>Registra viajes y cargas para ver la evolución del coste por km.</p></div>';
    return;
  }
  var eventos = [];
  DATOS.viajes.forEach(function(v){ eventos.push({ fecha:new Date(v.fecha), km:v.km }); });
  DATOS.cargas.forEach(function(c){ eventos.push({ fecha:new Date(c.fecha), coste:costeCarga(c) }); });
  eventos.sort(function(a,b){ return a.fecha-b.fecha; });

  var MESES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  var kmAcum=0, costeAcum=0, puntosPorMes={};
  eventos.forEach(function(e){
    if(e.km) kmAcum += e.km;
    if(e.coste!==null && e.coste!==undefined) costeAcum += e.coste; // B23: coste desconocido (null) no suma como 0 — pero una carga gratis real (0€) sí
    var clave = e.fecha.getFullYear()+'-'+e.fecha.getMonth();
    if(kmAcum>0) puntosPorMes[clave] = { m:MESES[e.fecha.getMonth()], v: costeAcum/kmAcum };
  });
  var datos = Object.keys(puntosPorMes).map(function(k){ return puntosPorMes[k]; });
  if(datos.length < 2){
    cont.innerHTML = '<div class="vacio" style="padding:20px 0"><span class="em">📉</span><p>Necesitas más historial para ver la evolución.</p></div>';
    return;
  }
  var w=290, h=120, pad=18;
  var valores = datos.map(function(d){return d.v;});
  var min = Math.min.apply(null,valores)*0.9, max = Math.max.apply(null,valores)*1.1;
  if(max===min){ max+=0.01; min-=0.01; }
  var pts = datos.map(function(d,i){
    var x = pad + i*(w-2*pad)/Math.max(datos.length-1,1);
    var y = h-pad - (d.v-min)/(max-min)*(h-2*pad);
    return [x,y];
  });
  var linea = pts.map(function(p,i){ return (i?'L':'M')+p[0].toFixed(1)+','+p[1].toFixed(1); }).join(' ');
  var puntos = pts.map(function(p){ return '<circle cx="'+p[0]+'" cy="'+p[1]+'" r="3.2" fill="var(--ok)"/>'; }).join('');
  var labels = datos.map(function(d,i){
    return '<text x="'+pts[i][0]+'" y="'+(h-2)+'" font-size="10" fill="var(--txt3)" text-anchor="middle">'+d.m+'</text>';
  }).join('');
  cont.innerHTML = '<svg viewBox="0 0 '+w+' '+h+'" width="100%" style="overflow:visible">'+
    '<path d="'+linea+'" fill="none" stroke="var(--ok)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>'+
    puntos + labels + '</svg>';
}

/* ---------- Recordatorios de mantenimiento por km ---------- */
function renderRecordatorios(){
  var cont = document.getElementById('lista-recordatorios');
  if(!cont) return;
  var kmActual = DATOS.vehiculo.odometro_km;
  var q = normalizarTexto(document.getElementById('buscar-recordatorios').value);
  var lista = (DATOS.recordatorios||[]).slice().sort(function(a,b){ return a.km_objetivo-b.km_objetivo; });
  if(q) lista = lista.filter(function(r){ return normalizarTexto(r.concepto).indexOf(q)!==-1; });

  var filaSeguro = '';
  if(!q && DATOS.seguro && DATOS.seguro.fecha_renovacion){
    var diasRestantes = diasHasta(DATOS.seguro.fecha_renovacion);
    var vencidoSeguro = diasRestantes <= 0;
    var cercaSeguro = !vencidoSeguro && diasRestantes <= 30;
    var colorSeguro = vencidoSeguro ? 'var(--acc)' : (cercaSeguro ? 'var(--warn)' : 'var(--txt3)');
    var textoSeguro = vencidoSeguro ? 'Venció hace '+Math.abs(diasRestantes)+' días' : 'Quedan '+diasRestantes+' días';
    filaSeguro = '<div class="fila"><div class="fila-tx"><div class="t1">Renovación del seguro</div>'+
      '<div class="t2">'+new Date(DATOS.seguro.fecha_renovacion+'T00:00:00').toLocaleDateString('es-ES',{day:'numeric',month:'long',year:'numeric'})+'</div></div>'+
      '<div class="fila-r"><div class="r1" style="color:'+colorSeguro+'">'+textoSeguro+'</div></div></div>';
  }

  var filaItv = '';
  if(!q && DATOS.itv && DATOS.itv.fecha){
    var diasItv = diasHasta(DATOS.itv.fecha);
    var vencidaItv = diasItv <= 0;
    var cercaItv = !vencidaItv && diasItv <= 60;
    var colorItv = vencidaItv ? 'var(--acc)' : (cercaItv ? 'var(--warn)' : 'var(--txt3)');
    var textoItv = vencidaItv ? 'Caducada hace '+Math.abs(diasItv)+' días' : 'Quedan '+diasItv+' días';
    filaItv = '<div class="fila"><div class="fila-tx"><div class="t1">Próxima ITV</div>'+
      '<div class="t2">'+new Date(DATOS.itv.fecha+'T00:00:00').toLocaleDateString('es-ES',{day:'numeric',month:'long',year:'numeric'})+'</div></div>'+
      '<div class="fila-r"><div class="r1" style="color:'+colorItv+'">'+textoItv+'</div></div></div>';
  }

  cont.innerHTML = filaSeguro + filaItv + lista.map(function(r){
    var restante = r.km_objetivo - kmActual;
    var vencido = restante <= 0;
    var cerca = !vencido && restante <= 2000;
    var color = vencido ? 'var(--acc)' : (cerca ? 'var(--warn)' : 'var(--txt3)');
    var texto = vencido ? 'Superado hace '+Math.abs(restante).toLocaleString('es-ES')+' km' : 'Faltan '+restante.toLocaleString('es-ES')+' km';
    return '<div class="fila">'+
      '<div class="fila-tx" data-editar-recordatorio="'+r.id+'"><div class="t1">'+esc(r.concepto)+'</div><div class="t2">Objetivo: '+r.km_objetivo.toLocaleString('es-ES')+' km</div></div>'+
      '<div class="fila-r"><div class="r1" style="color:'+color+'">'+texto+'</div></div>'+
      '<button type="button" class="btn-borrar" data-borrar-recordatorio="'+r.id+'" data-icon="papelera" aria-label="Eliminar"></button>'+
      '</div>';
  }).join('') || ((filaSeguro || filaItv) ? '' : '<div class="vacio"><span class="em">🔧</span><p>'+(q ? 'Sin recordatorios que coincidan con la búsqueda.' : 'Sin recordatorios. Añade uno con "+ Añadir".')+'</p></div>');
  aplicarIconos();
}

/* ---------- Neumáticos: km recorridos por eje, desde su fecha de instalación ---------- */
function renderNeumaticos(){
  var cont = document.getElementById('tarjetas-neumaticos');
  if(!cont) return;
  var kmActual = DATOS.vehiculo.odometro_km;
  var ejes = [
    { clave:'delanteros', nombre:'Delanteros' },
    { clave:'traseros', nombre:'Traseros' }
  ];
  cont.innerHTML = ejes.map(function(e){
    var n = DATOS.neumaticos[e.clave];
    var recorridos = Math.max(0, kmActual - n.km_instalacion);
    var pctUso = Math.min(100, Math.round(recorridos/n.vida_util_km*100));
    var color = pctUso>=90 ? 'var(--acc)' : (pctUso>=70 ? 'var(--warn)' : 'var(--ok)');
    var glow = pctUso>=90 ? 'rgba(232,52,42,.5)' : (pctUso>=70 ? 'rgba(232,145,42,.5)' : 'rgba(47,174,96,.5)');
    return '<div class="card" data-editar-neumatico="'+e.clave+'" style="cursor:pointer">'+
      '<div class="lbl">'+e.nombre+'</div>'+
      '<div class="val">'+recorridos.toLocaleString('es-ES')+' km</div>'+
      '<div class="sub">Desde '+new Date(n.fecha_instalacion+'T00:00:00').toLocaleDateString('es-ES',{day:'numeric',month:'short',year:'numeric'})+'</div>'+
      '<div class="barra" style="margin:10px 0 2px"><i style="width:'+pctUso+'%;background:'+color+';--barra-glow:'+glow+'"></i></div>'+
      '<div class="sub">'+pctUso+' % de su vida útil estimada</div>'+
      '</div>';
  }).join('');
  renderHistoricoNeumaticos();
}
/* ---------- Fase 3, punto 23: historial de juegos de neumáticos ----------
 * Cada juego (delantero o trasero) instalado alguna vez queda como una entidad histórica propia,
 * con su €/1000km y consumo medio durante ESE periodo concreto — no una sola cifra global. */
function renderHistoricoNeumaticos(){
  var cont = document.getElementById('lista-neumaticos-historico');
  if(!cont) return;
  var hist = (DATOS.neumaticos_historico||[]).slice().sort(function(a,b){ return new Date(b.installed_at)-new Date(a.installed_at); });
  if(!hist.length){ cont.innerHTML = '<div class="vacio"><span class="em">🛞</span><p>Todavía no hay historial — se empieza a registrar la próxima vez que cambies un juego de neumáticos.</p></div>'; return; }
  cont.innerHTML = hist.map(function(h){
    var kmFin = (h.removed_at!=null && h.odometer_remove!=null) ? h.odometer_remove : DATOS.vehiculo.odometro_km;
    var km = Math.max(0, kmFin - h.odometer_install);
    var costeKm = (h.purchase_price!=null && km>0) ? (h.purchase_price/km*1000) : null;
    var diasDuracion = h.removed_at ? Math.round((new Date(h.removed_at)-new Date(h.installed_at))/86400000) : Math.round((Date.now()-new Date(h.installed_at))/86400000);
    // Consumo medio SOLO de los viajes dentro de ese periodo concreto (por fecha), no el consumo global.
    var viajesPeriodo = DATOS.viajes.filter(function(v){
      var t = new Date(v.fecha).getTime();
      return t >= new Date(h.installed_at).getTime() && (!h.removed_at || t <= new Date(h.removed_at).getTime());
    });
    var consumos = viajesPeriodo.map(consumoViaje).filter(function(c){return c>0;});
    var consumoMedio = consumos.length ? consumos.reduce(function(a,b){return a+b;},0)/consumos.length : null;
    var nombre = [h.marca,h.modelo].filter(Boolean).join(' ') || 'Sin marca/modelo';
    return '<div class="fila"><div class="fila-tx"><div class="t1">'+esc({delanteros:'Delanteros',traseros:'Traseros'}[h.eje]||h.eje)+' · '+esc(nombre)+(h.medida?' · '+esc(h.medida):'')+'</div>'+
      '<div class="t2">'+(h.removed_at?'Del '+fechaCorta(h.installed_at+'T00:00')+' al '+fechaCorta(h.removed_at+'T00:00'):'Instalados el '+fechaCorta(h.installed_at+'T00:00')+' · en uso')+' · '+diasDuracion+' días · '+km.toLocaleString('es-ES')+' km'+
      (consumoMedio!==null?' · '+fmt1(consumoMedio,' kWh/100km'):'')+'</div></div>'+
      '<div class="fila-r"><div class="r1">'+(costeKm!==null?costeKm.toFixed(2)+' €/1000km':'—')+'</div><div class="r2">'+(h.purchase_price!=null?euros(h.purchase_price):'Sin precio')+'</div></div></div>';
  }).join('');
}

/* ---------- Fase 3, punto 24: mantenimiento integral (historial + recordatorios por fecha/km) ---------- */
var NOMBRE_CAT_MANT = { neumaticos:'Neumáticos', filtros:'Filtros', frenos:'Líquido de frenos', escobillas:'Escobillas', reparacion:'Reparación', revision:'Revisión', itv:'ITV', seguro:'Seguro', otros:'Otros' };
var editandoMantenimiento = null;
var formMantenimiento = document.getElementById('form-mantenimiento');
document.getElementById('btn-add-mantenimiento').addEventListener('click', function(){
  editandoMantenimiento = null;
  ['fm-concepto','fm-odometro','fm-coste','fm-recordatorio-fecha','fm-recordatorio-km','fm-notas'].forEach(function(id){ document.getElementById(id).value=''; });
  document.getElementById('fm-categoria').value = 'revision';
  document.getElementById('fm-fecha').value = fechaLocalISO();
  formMantenimiento.classList.toggle('form-oculto');
});
document.getElementById('fm-cancelar').addEventListener('click', function(){ formMantenimiento.classList.add('form-oculto'); });
document.getElementById('form-mantenimiento').addEventListener('submit', function(e){
  e.preventDefault();
  var concepto = document.getElementById('fm-concepto').value.trim();
  var fecha = document.getElementById('fm-fecha').value;
  if(!concepto || !fecha){ toast('Indica al menos el concepto y la fecha.', true); return; }
  var odo = parseInt(document.getElementById('fm-odometro').value);
  var coste = parseFloat(document.getElementById('fm-coste').value);
  var datos = {
    categoria: document.getElementById('fm-categoria').value,
    concepto: concepto, fecha: fecha,
    odometro_km: isFinite(odo) ? odo : null,
    coste: isFinite(coste) && coste>=0 ? coste : 0,
    notas: document.getElementById('fm-notas').value.trim(),
    recordatorio_fecha: document.getElementById('fm-recordatorio-fecha').value || null,
    recordatorio_km: (function(){ var v=parseInt(document.getElementById('fm-recordatorio-km').value); return isFinite(v)?v:null; })()
  };
  if(editandoMantenimiento){
    var m = DATOS.mantenimiento.find(function(x){ return x.id===editandoMantenimiento; });
    Object.assign(m, datos); m.updated_at = ahoraISO();
    registrarCambio('mantenimiento', 'editar', textoResumenCambio('mantenimiento', m));
  } else {
    var nuevoMant = conTimestamps(datos);
    DATOS.mantenimiento.push(nuevoMant);
    registrarCambio('mantenimiento', 'crear', textoResumenCambio('mantenimiento', nuevoMant));
  }
  guardarDatos();
  formMantenimiento.classList.add('form-oculto');
  renderMantenimiento();
  toast('Mantenimiento guardado');
});
document.getElementById('lista-mantenimiento').addEventListener('click', function(e){
  var borrar = e.target.closest('[data-borrar-mantenimiento]');
  if(borrar){
    confirmarAccion('Eliminar registro', 'Se borrará este registro de mantenimiento.', function(){
      var idB = borrar.dataset.borrarMantenimiento;
      var item = DATOS.mantenimiento.find(function(m){ return m.id===idB; });
      marcarBorrado('mantenimiento', idB);
      DATOS.mantenimiento = DATOS.mantenimiento.filter(function(m){ return m.id!==idB; });
      if(item){ moverAPapelera('mantenimiento', item); registrarCambio('mantenimiento', 'eliminar', textoResumenCambio('mantenimiento', item)); }
      guardarDatos(); renderMantenimiento();
      toastDeshacer('Registro eliminado', 'mantenimiento', idB, [renderMantenimiento]);
    });
    return;
  }
  var editar = e.target.closest('[data-editar-mantenimiento]');
  if(editar){
    var m = DATOS.mantenimiento.find(function(x){ return x.id===editar.dataset.editarMantenimiento; });
    if(!m) return;
    editandoMantenimiento = m.id;
    document.getElementById('fm-categoria').value = m.categoria;
    document.getElementById('fm-concepto').value = m.concepto;
    document.getElementById('fm-fecha').value = m.fecha;
    document.getElementById('fm-odometro').value = m.odometro_km!=null?m.odometro_km:'';
    document.getElementById('fm-coste').value = m.coste||'';
    document.getElementById('fm-recordatorio-fecha').value = m.recordatorio_fecha||'';
    document.getElementById('fm-recordatorio-km').value = m.recordatorio_km!=null?m.recordatorio_km:'';
    document.getElementById('fm-notas').value = m.notas||'';
    formMantenimiento.classList.remove('form-oculto');
  }
});
/** Próximo mantenimiento pendiente: "lo que ocurra primero" entre la fecha y el km de recordatorio. */
function proximoMantenimientoPendiente(m){
  if(!m.recordatorio_fecha && m.recordatorio_km==null) return null;
  var diasRestantes = m.recordatorio_fecha ? diasHasta(m.recordatorio_fecha) : null;
  var kmRestantes = (m.recordatorio_km!=null) ? (m.recordatorio_km - DATOS.vehiculo.odometro_km) : null;
  return { diasRestantes:diasRestantes, kmRestantes:kmRestantes };
}
function renderMantenimiento(){
  var cont = document.getElementById('lista-mantenimiento');
  if(!cont) return;
  var lista = DATOS.mantenimiento.slice().sort(function(a,b){ return new Date(b.fecha)-new Date(a.fecha); });
  cont.innerHTML = lista.length ? lista.map(function(m){
    var pend = proximoMantenimientoPendiente(m);
    var pendTxt = '';
    if(pend){
      var partes = [];
      if(pend.diasRestantes!=null) partes.push(pend.diasRestantes<0 ? 'vencido hace '+Math.abs(pend.diasRestantes)+' días' : 'en '+pend.diasRestantes+' días');
      if(pend.kmRestantes!=null) partes.push(pend.kmRestantes<0 ? 'superado por '+Math.abs(pend.kmRestantes)+' km' : 'en '+pend.kmRestantes+' km');
      pendTxt = ' · Próximo: '+partes.join(' o ')+' (lo que ocurra antes)';
    }
    return '<div class="fila"><div class="ico" data-icon="ajustes"></div>'+
      '<div class="fila-tx" data-editar-mantenimiento="'+m.id+'"><div class="t1">'+esc(NOMBRE_CAT_MANT[m.categoria]||m.categoria)+' — '+esc(m.concepto)+'</div>'+
      '<div class="t2">'+fechaCorta(m.fecha+'T00:00')+(m.odometro_km!=null?' · '+m.odometro_km.toLocaleString('es-ES')+' km':'')+pendTxt+'</div></div>'+
      '<div class="fila-r"><div class="r1">'+(m.coste?euros(m.coste):'—')+'</div></div>'+
      '<button type="button" class="btn-borrar" data-borrar-mantenimiento="'+m.id+'" data-icon="papelera" aria-label="Eliminar"></button>'+
      '</div>';
  }).join('') : '<div class="vacio"><span class="em">🔧</span><p>Sin registros de mantenimiento todavía.</p></div>';
  aplicarIconos();
}

/* ---------- Fase 3, punto 25: documentos/facturas — metadatos en DATOS, archivo en IndexedDB ----------
 * DATOS.documentos SOLO guarda metadatos (nombre, tipo, fecha, tamaño, relación, notas) — nunca el
 * archivo en sí. El archivo (PDF/foto de factura) va a IndexedDB, que es almacenamiento local del
 * navegador pensado para blobs — evita el problema real de meter Base64 masivo en datos.json, que
 * hincharía cada copia de seguridad y cada sincronización con GitHub cada vez más. Contrapartida
 * honesta: al vivir solo en IndexedDB, el archivo NO viaja en la sincronización entre dispositivos
 * ni en el backup JSON — solo sus metadatos sí. Documentado también en el informe final. */
var DOCUMENTOS_DB_NOMBRE = 'mitesla-documentos', DOCUMENTOS_DB_STORE = 'archivos';
function abrirDocumentosDB(){
  return new Promise(function(resolve, reject){
    if(!('indexedDB' in window)){ reject(new Error('IndexedDB no disponible en este navegador')); return; }
    var req = indexedDB.open(DOCUMENTOS_DB_NOMBRE, 1);
    req.onupgradeneeded = function(){ req.result.createObjectStore(DOCUMENTOS_DB_STORE); };
    req.onsuccess = function(){ resolve(req.result); };
    req.onerror = function(){ reject(req.error); };
  });
}
async function guardarDocumentoArchivo(id, blob){
  var db = await abrirDocumentosDB();
  return new Promise(function(resolve, reject){
    var tx = db.transaction(DOCUMENTOS_DB_STORE, 'readwrite');
    tx.objectStore(DOCUMENTOS_DB_STORE).put(blob, id);
    tx.oncomplete = function(){ resolve(true); };
    tx.onerror = function(){ reject(tx.error); };
  });
}
async function leerDocumentoArchivo(id){
  var db = await abrirDocumentosDB();
  return new Promise(function(resolve, reject){
    var tx = db.transaction(DOCUMENTOS_DB_STORE, 'readonly');
    var req = tx.objectStore(DOCUMENTOS_DB_STORE).get(id);
    req.onsuccess = function(){ resolve(req.result || null); };
    req.onerror = function(){ reject(req.error); };
  });
}
async function eliminarDocumentoArchivo(id){
  var db = await abrirDocumentosDB();
  return new Promise(function(resolve, reject){
    var tx = db.transaction(DOCUMENTOS_DB_STORE, 'readwrite');
    tx.objectStore(DOCUMENTOS_DB_STORE).delete(id);
    tx.oncomplete = function(){ resolve(true); };
    tx.onerror = function(){ reject(tx.error); };
  });
}
var formDocumento = document.getElementById('form-documento');
document.getElementById('btn-add-documento').addEventListener('click', function(){
  ['fd-nombre','fd-relacionado','fd-notas'].forEach(function(id){ document.getElementById(id).value=''; });
  document.getElementById('fd-archivo').value = '';
  document.getElementById('fd-fecha').value = fechaLocalISO();
  formDocumento.classList.toggle('form-oculto');
});
document.getElementById('fd-cancelar').addEventListener('click', function(){ formDocumento.classList.add('form-oculto'); });
document.getElementById('form-documento').addEventListener('submit', async function(e){
  e.preventDefault();
  var nombre = document.getElementById('fd-nombre').value.trim();
  var fecha = document.getElementById('fd-fecha').value;
  if(!nombre || !fecha){ toast('Indica al menos el nombre y la fecha.', true); return; }
  var archivo = document.getElementById('fd-archivo').files[0] || null;
  var meta = conTimestamps({
    nombre: nombre, tipo: archivo ? archivo.type : '', fecha: fecha,
    tamano_bytes: archivo ? archivo.size : null,
    relacionado_con: document.getElementById('fd-relacionado').value.trim() || null,
    notas: document.getElementById('fd-notas').value.trim(),
    tiene_archivo: !!archivo
  });
  if(archivo){
    try{ await guardarDocumentoArchivo(meta.id, archivo); }
    catch(err){ toast('No se pudo guardar el archivo en este navegador — se guardan solo los datos.', true); meta.tiene_archivo = false; }
  }
  DATOS.documentos.push(meta);
  registrarCambio('documentos', 'crear', textoResumenCambio('documentos', meta));
  guardarDatos();
  formDocumento.classList.add('form-oculto');
  renderDocumentos();
  toast('Documento guardado');
});
document.getElementById('lista-documentos').addEventListener('click', async function(e){
  var borrar = e.target.closest('[data-borrar-documento]');
  if(borrar){
    var id = borrar.dataset.borrarDocumento;
    confirmarAccion('Eliminar documento', 'Se moverá a la papelera; si tiene archivo adjunto, se conserva hasta que se elimine definitivamente o pasen 30 días.', function(){
      var item = DATOS.documentos.find(function(d){ return d.id===id; });
      marcarBorrado('documentos', id);
      DATOS.documentos = DATOS.documentos.filter(function(d){ return d.id!==id; });
      if(item){ moverAPapelera('documentos', item); registrarCambio('documentos', 'eliminar', textoResumenCambio('documentos', item)); }
      guardarDatos(); renderDocumentos();
      toastDeshacer('Documento eliminado', 'documentos', id, [renderDocumentos]);
    });
    return;
  }
  var descargar = e.target.closest('[data-descargar-documento]');
  if(descargar){
    var doc = DATOS.documentos.find(function(d){ return d.id===descargar.dataset.descargarDocumento; });
    if(!doc || !doc.tiene_archivo) return;
    try{
      var blob = await leerDocumentoArchivo(doc.id);
      if(!blob){ toast('El archivo ya no está disponible en este dispositivo (solo se guarda localmente).', true); return; }
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a'); a.href = url; a.download = doc.nombre; a.click();
      URL.revokeObjectURL(url);
    }catch(err){ toast('No se pudo leer el archivo.', true); }
  }
});
function tamanoLegible(bytes){
  if(bytes==null) return '';
  if(bytes < 1024) return bytes+' B';
  if(bytes < 1024*1024) return (bytes/1024).toFixed(0)+' KB';
  return (bytes/1024/1024).toFixed(1)+' MB';
}
function renderDocumentos(){
  var cont = document.getElementById('lista-documentos');
  if(!cont) return;
  var lista = DATOS.documentos.slice().sort(function(a,b){ return new Date(b.fecha)-new Date(a.fecha); });
  cont.innerHTML = lista.length ? lista.map(function(d){
    return '<div class="fila"><div class="ico" data-icon="descarga"></div>'+
      '<div class="fila-tx"><div class="t1">'+esc(d.nombre)+'</div>'+
      '<div class="t2">'+fechaCorta(d.fecha+'T00:00')+(d.relacionado_con?' · '+esc(d.relacionado_con):'')+(d.tamano_bytes?' · '+tamanoLegible(d.tamano_bytes):'')+(d.tiene_archivo?'':' · sin archivo adjunto, solo referencia')+'</div></div>'+
      (d.tiene_archivo ? '<button type="button" class="ver" data-descargar-documento="'+d.id+'" style="flex:none">Descargar</button>' : '')+
      '<button type="button" class="btn-borrar" data-borrar-documento="'+d.id+'" data-icon="papelera" aria-label="Eliminar"></button>'+
      '</div>';
  }).join('') : '<div class="vacio"><span class="em">📄</span><p>Sin documentos guardados todavía.</p></div>';
  aplicarIconos();
}

/* ---------- Inventario de accesorios y extras ---------- */
var NOMBRE_CAT_ACC = { proteccion:'Protección', carga:'Carga', confort:'Confort e interior', estetica:'Estética', tecnologia:'Tecnología', otros:'Otros' };
var filtroAccesorioActivo = 'todo';
function renderAccesorios(){
  var cont = document.getElementById('lista-accesorios');
  if(!cont) return;
  var q = normalizarTexto(document.getElementById('buscar-accesorios').value);
  var lista = DATOS.accesorios.slice().sort(function(a,b){ return new Date(b.fecha)-new Date(a.fecha); });
  if(filtroAccesorioActivo!=='todo') lista = lista.filter(function(a){ return a.categoria===filtroAccesorioActivo; });
  if(q) lista = lista.filter(function(a){ return normalizarTexto(a.nombre).indexOf(q)!==-1; });
  cont.innerHTML = lista.map(function(a){
    var garantiaTxt = '';
    if(a.meses_garantia){
      var expira = fechaMasMeses(a.fecha, a.meses_garantia);
      var diasRest = Math.ceil((expira-new Date())/(1000*3600*24));
      var color = diasRest<=0 ? 'var(--txt3)' : (diasRest<=30 ? 'var(--warn)' : 'var(--ok)');
      garantiaTxt = '<div class="t2" style="color:'+color+'">'+(diasRest<=0 ? 'Garantía expirada' : 'Garantía hasta '+expira.toLocaleDateString('es-ES',{day:'numeric',month:'short',year:'numeric'}))+'</div>';
    }
    return '<div class="fila">'+
      '<div class="fila-tx" data-editar-accesorio="'+a.id+'"><div class="t1">'+esc(a.nombre)+'</div>'+
      '<div class="t2">'+NOMBRE_CAT_ACC[a.categoria]+' · '+new Date(a.fecha+'T00:00:00').toLocaleDateString('es-ES',{day:'numeric',month:'short',year:'numeric'})+'</div>'+garantiaTxt+'</div>'+
      '<div class="fila-r"><div class="r1">'+euros(a.precio)+'</div></div>'+
      '<button type="button" class="btn-duplicar" data-duplicar-accesorio="'+a.id+'" data-icon="duplicar" aria-label="Duplicar"></button>'+
      '<button type="button" class="btn-borrar" data-borrar-accesorio="'+a.id+'" data-icon="papelera" aria-label="Eliminar"></button>'+
      '</div>';
  }).join('') || '<div class="vacio"><span class="em">🎒</span><p>'+(q ? 'Sin accesorios que coincidan con la búsqueda.' : (filtroAccesorioActivo!=='todo' ? 'Sin accesorios en esta categoría.' : 'Sin accesorios registrados todavía.'))+'</p></div>';

  var total = DATOS.accesorios.reduce(function(s,a){ return s+a.precio; }, 0);
  var conGarantiaVigente = DATOS.accesorios.filter(function(a){
    if(!a.meses_garantia) return false;
    return fechaMasMeses(a.fecha, a.meses_garantia) > new Date();
  }).length;
  document.getElementById('total-accesorios').textContent = DATOS.accesorios.length+' accesorios · '+euros(total)+' en total'+(conGarantiaVigente ? ' · '+conGarantiaVigente+' con garantía vigente' : '');
  aplicarIconos();
}
var editandoAccesorio = null;
function abrirFormAccesorio(a){
  editandoAccesorio = a ? a.id : null;
  document.getElementById('fa-nombre').value = a ? a.nombre : '';
  document.getElementById('fa-categoria').value = a ? a.categoria : 'proteccion';
  document.getElementById('fa-fecha').value = a ? a.fecha : '';
  document.getElementById('fa-precio').value = a ? a.precio : '';
  document.getElementById('fa-garantia').value = (a && a.meses_garantia) ? a.meses_garantia : '';
  document.getElementById('fa-guardar').textContent = a ? 'Guardar cambios' : 'Guardar';
  document.getElementById('form-accesorio').classList.remove('form-oculto');
}
document.getElementById('btn-add-accesorio').addEventListener('click', function(){
  var f = document.getElementById('form-accesorio');
  if(f.classList.contains('form-oculto') || editandoAccesorio) abrirFormAccesorio(null);
  else f.classList.add('form-oculto');
});
document.getElementById('fa-cancelar').addEventListener('click', function(){
  document.getElementById('form-accesorio').classList.add('form-oculto');
});
document.getElementById('form-accesorio').addEventListener('submit', function(e){
  e.preventDefault();
  var nombre = document.getElementById('fa-nombre').value.trim();
  var fecha = document.getElementById('fa-fecha').value;
  var precio = parseFloat(document.getElementById('fa-precio').value);
  if(!nombre || !fecha || isNaN(precio)){ toast('Completa nombre, fecha y precio.', true); return; }
  if(precio < 0){ toast('El precio no puede ser negativo.', true); return; }
  var garantiaVal = parseInt(document.getElementById('fa-garantia').value);
  var datos = { nombre:nombre, categoria:document.getElementById('fa-categoria').value, fecha:fecha, precio:precio, meses_garantia: (!isNaN(garantiaVal) && garantiaVal>0) ? garantiaVal : null };
  if(editandoAccesorio){
    var a = DATOS.accesorios.find(function(x){ return x.id===editandoAccesorio; });
    Object.assign(a, datos);
    registrarCambio('accesorios', 'editar', textoResumenCambio('accesorios', a));
  } else {
    datos.id = 'a'+Date.now();
    DATOS.accesorios.push(datos);
    registrarCambio('accesorios', 'crear', textoResumenCambio('accesorios', datos));
  }
  guardarDatos();
  document.getElementById('form-accesorio').classList.add('form-oculto');
  renderAccesorios();
  toast(editandoAccesorio ? 'Accesorio actualizado' : 'Accesorio añadido');
});
document.getElementById('lista-accesorios').addEventListener('click', function(e){
  var borrar = e.target.closest('[data-borrar-accesorio]');
  if(borrar){
    confirmarAccion('Eliminar accesorio', 'Se borrará este accesorio del inventario.', function(){
      var idB = borrar.dataset.borrarAccesorio;
      var item = DATOS.accesorios.find(function(a){ return a.id===idB; });
      marcarBorrado('accesorios', idB);
      DATOS.accesorios = DATOS.accesorios.filter(function(a){ return a.id!==idB; });
      if(item){ moverAPapelera('accesorios', item); registrarCambio('accesorios', 'eliminar', textoResumenCambio('accesorios', item)); }
      guardarDatos(); renderAccesorios();
      toastDeshacer('Accesorio eliminado', 'accesorios', idB, [renderAccesorios]);
    });
    return;
  }
  var editar = e.target.closest('[data-editar-accesorio]');
  if(editar){
    abrirFormAccesorio(DATOS.accesorios.find(function(a){ return a.id===editar.dataset.editarAccesorio; }));
    return;
  }
  var duplicar = e.target.closest('[data-duplicar-accesorio]');
  if(duplicar){
    var original = DATOS.accesorios.find(function(a){ return a.id===duplicar.dataset.duplicarAccesorio; });
    if(original){
      abrirFormAccesorio(original);
      editandoAccesorio = null;
      document.getElementById('fa-fecha').value = fechaLocalISO();
      document.getElementById('fa-guardar').textContent = 'Guardar';
      toast('Accesorio duplicado — ajusta la fecha y guarda');
    }
  }
});

function abrirFormNeumatico(eje){
  var n = DATOS.neumaticos[eje];
  document.getElementById('fn-titulo').textContent = 'Neumáticos '+(eje==='delanteros'?'delanteros':'traseros');
  document.getElementById('fn-fecha').value = n.fecha_instalacion;
  document.getElementById('fn-km').value = n.km_instalacion;
  document.getElementById('fn-vida').value = n.vida_util_km;
  ['fn-marca','fn-modelo','fn-medida','fn-precio','fn-notas'].forEach(function(id){ document.getElementById(id).value=''; });
  document.getElementById('form-neumatico').dataset.eje = eje;
  document.getElementById('form-neumatico').classList.remove('form-oculto');
}
document.getElementById('tarjetas-neumaticos').addEventListener('click', function(e){
  var tarjeta = e.target.closest('[data-editar-neumatico]');
  if(tarjeta) abrirFormNeumatico(tarjeta.dataset.editarNeumatico);
});
document.getElementById('fn-cancelar').addEventListener('click', function(){
  document.getElementById('form-neumatico').classList.add('form-oculto');
});
document.getElementById('form-neumatico').addEventListener('submit', function(e){
  e.preventDefault();
  var eje = document.getElementById('form-neumatico').dataset.eje;
  var fecha = document.getElementById('fn-fecha').value;
  var km = parseInt(document.getElementById('fn-km').value);
  var vida = parseInt(document.getElementById('fn-vida').value) || 45000;
  if(!fecha || isNaN(km)){ toast('Completa la fecha y el kilómetro de instalación.', true); return; }
  if(km < 0 || vida <= 0){ toast('El kilómetro no puede ser negativo y la vida útil debe ser mayor que 0.', true); return; }
  // Fase 3, punto 23: el juego anterior NUNCA se sobrescribe — se cierra en el historial (con el
  // odómetro de hoy como "removed_at"/"odometer_remove") y se abre uno nuevo. DATOS.neumaticos.*
  // sigue siendo el "juego actual" tal y como lo usa el resto de la app (recordatorios, tarjetas),
  // pero ahora es solo un puntero al último elemento del historial, no la única fuente de verdad.
  var anterior = DATOS.neumaticos[eje];
  if(!DATOS.neumaticos_historico) DATOS.neumaticos_historico = [];
  if(anterior && anterior.fecha_instalacion){
    var entradaAnterior = DATOS.neumaticos_historico.find(function(h){ return h.eje===eje && !h.removed_at && h.odometer_install===anterior.km_instalacion; });
    if(entradaAnterior){
      entradaAnterior.removed_at = fecha;
      entradaAnterior.odometer_remove = km;
      entradaAnterior.updated_at = ahoraISO();
    }
  }
  var nuevaEntrada = conTimestamps({
    marca: document.getElementById('fn-marca').value.trim(),
    modelo: document.getElementById('fn-modelo').value.trim(),
    medida: document.getElementById('fn-medida').value.trim(),
    eje: eje,
    installed_at: fecha, odometer_install: km,
    removed_at: null, odometer_remove: null,
    purchase_price: (function(){ var p=parseFloat(document.getElementById('fn-precio').value); return isFinite(p)&&p>=0?p:null; })(),
    notes: document.getElementById('fn-notas').value.trim()
  });
  DATOS.neumaticos_historico.push(nuevaEntrada);
  DATOS.neumaticos[eje] = { fecha_instalacion:fecha, km_instalacion:km, vida_util_km:vida };
  DATOS.neumaticos.updated_at = ahoraISO();
  guardarDatos();
  document.getElementById('form-neumatico').classList.add('form-oculto');
  renderNeumaticos();
  renderHistoricoNeumaticos();
  toast('Neumáticos actualizados — el juego anterior queda guardado en el historial');
});

function abrirFormGasto(g){
  editandoGasto = g ? g.id : null;
  document.getElementById('fg-fecha').value = g ? g.fecha : '';
  document.getElementById('fg-categoria').value = g ? g.categoria : 'seguro';
  document.getElementById('fg-concepto').value = g ? g.concepto : '';
  document.getElementById('fg-importe').value = g ? g.importe : '';
  document.getElementById('fg-guardar').textContent = g ? 'Guardar cambios' : 'Guardar gasto';
  formGasto.classList.remove('form-oculto');
}

/* ---------- Fase 3, punto 10: reglas automáticas de clasificación ----------
 * Propone una etiqueta a partir del historial (p. ej. "siempre que el destino es Oviedo,
 * lo etiquetas como Trabajo"), pero NUNCA la impone: solo rellena el desplegable y avisa con
 * un toast; el usuario ve el cambio en el propio formulario y puede corregirlo antes de guardar. */
var UMBRAL_REGLA_CLASIFICACION = 3; // hacen falta al menos 3 viajes previos coincidentes para sugerir
function sugerirEtiquetaViaje(origen, destino){
  if(!destino) return null;
  var oN = normalizarTexto(origen||''), dN = normalizarTexto(destino);
  var candidatos = DATOS.viajes.filter(function(v){
    var mismoDestino = normalizarTexto(v.destino)===dN;
    var mismoPar = oN ? (mismoDestino && normalizarTexto(v.origen)===oN) : mismoDestino;
    return mismoPar;
  });
  if(candidatos.length < UMBRAL_REGLA_CLASIFICACION) return null;
  var recuento = {};
  candidatos.forEach(function(v){ recuento[v.etiqueta] = (recuento[v.etiqueta]||0)+1; });
  var etiquetas = Object.keys(recuento);
  var dominante = etiquetas.reduce(function(a,b){ return recuento[a]>=recuento[b] ? a : b; });
  // Solo se sugiere si la etiqueta dominante lo es de forma clara (>=80% de los viajes coincidentes),
  // para no proponer con datos ambiguos.
  if(recuento[dominante] / candidatos.length < 0.8) return null;
  return dominante;
}
function aplicarSugerenciaClasificacion(){
  if(editandoViaje) return; // no reclasificar un viaje ya guardado sin que el usuario lo pida explícitamente
  var origen = document.getElementById('fv-origen').value.trim();
  var destino = document.getElementById('fv-destino').value.trim();
  var sugerida = sugerirEtiquetaViaje(origen, destino);
  if(sugerida && document.getElementById('fv-etiqueta').value !== sugerida){
    document.getElementById('fv-etiqueta').value = sugerida;
    toast('Etiqueta sugerida: '+({personal:'Personal',trabajo:'Trabajo',otro:'Otro'}[sugerida])+' (basado en viajes anteriores a este destino) — puedes cambiarla antes de guardar.');
  }
}

/* ---------- Formulario: nuevo/editar viaje ---------- */
var formViaje = document.getElementById('form-viaje');
document.getElementById('btn-add-viaje').addEventListener('click', function(){
  if(formViaje.classList.contains('form-oculto') || editandoViaje) abrirFormViaje(null);
  else formViaje.classList.add('form-oculto');
});
document.getElementById('fv-cancelar').addEventListener('click', function(){
  formViaje.classList.add('form-oculto');
});
document.getElementById('fv-destino').addEventListener('change', aplicarSugerenciaClasificacion);
document.getElementById('form-viaje').addEventListener('submit', async function(e){
  e.preventDefault();
  var km = parseFloat(document.getElementById('fv-km').value);
  var fecha = document.getElementById('fv-fecha').value;
  var origen = document.getElementById('fv-origen').value.trim();
  var destino = document.getElementById('fv-destino').value.trim();
  if(!fecha || !origen || !destino || isNaN(km)){
    toast('Completa al menos fecha, origen, destino y km.', true);
    return;
  }
  if(km <= 0){
    toast('Los km deben ser mayores que 0.', true);
    return;
  }
  var bIni = parseOptionalPercentage(document.getElementById('fv-bini').value);
  var bFin = parseOptionalPercentage(document.getElementById('fv-bfin').value);
  if((bIni!==null && (isNaN(bIni) || bIni<0 || bIni>100)) || (bFin!==null && (isNaN(bFin) || bFin<0 || bFin>100))){
    toast('La batería debe estar entre 0 % y 100 %.', true);
    return;
  }
  var duracionVal = parseInt(document.getElementById('fv-duracion').value);
  if(!isNaN(duracionVal) && duracionVal<0){
    toast('La duración no puede ser negativa.', true);
    return;
  }
  var datos = {
    fecha: fecha, origen: origen, destino: destino, km: km,
    duracion_min: (!isNaN(duracionVal) && duracionVal>0) ? duracionVal : 0,
    bateria_inicial: bIni,
    bateria_final: bFin,
    etiqueta: document.getElementById('fv-etiqueta').value,
    conductor: document.getElementById('fv-conductor').value.trim()
  };
  var guardado = await mutacionBusiness('viajes', 'form', formViaje, async function(repo){
    var anterior = editandoViaje ? repo.obtener(editandoViaje) : null;
    if(editandoViaje && !anterior) throw new Error('El viaje ya no está disponible; tu borrador se conserva.');
    var draft = Object.assign({}, anterior || {}, datos);
    if(!anterior) draft.id = 'v'+Date.now();
    else if(!legacyBusinessPermitido()) draft.revision = editandoViajeRevision;
    if(!legacyBusinessPermitido() && draft.manual_override===null) draft.manual_override={};
    return await repo.guardar(draft);
  });
  if(!guardado) return; // Keep every input and editing id on 409/network failure.
  avisarSiFechaFutura(fecha);
  if(legacyBusinessPermitido()) guardarDatos();
  ['fv-fecha','fv-origen','fv-destino','fv-km','fv-duracion','fv-bini','fv-bfin'].forEach(function(id){ document.getElementById(id).value=''; });
  formViaje.classList.add('form-oculto');
  renderViajes();
  renderDashboard();
  renderEstadisticas();
  toast(editandoViaje ? 'Viaje actualizado' : 'Viaje añadido');
});
function manejarToggleMes(e){
  var cab = e.target.closest('[data-toggle-mes]');
  if(!cab) return false;
  var clave = cab.dataset.toggleMes;
  var filas = cab.parentElement.querySelector('[data-mes="'+clave+'"]');
  var abrir = filas.style.display === 'none';
  filas.style.display = abrir ? '' : 'none';
  cab.querySelector('.chevron').textContent = abrir ? '—' : '+';
  return true;
}
document.getElementById('lista-viajes').addEventListener('click', function(e){
  if(manejarToggleMes(e)) return;
  var borrar = e.target.closest('[data-borrar-viaje]');
  if(borrar){
    confirmarAccion('Eliminar viaje', 'Se borrará este viaje del historial.', async function(){
      var idB = borrar.dataset.borrarViaje;
      var eliminado = await mutacionBusiness('viajes', 'delete:'+idB, borrar, async function(repo){
        var item = repo.obtener(idB);
        await repo.eliminar(idB);
        if(item) moverAPapelera('viajes', item);
        return true;
      });
      if(!eliminado) return;
      if(legacyBusinessPermitido()) guardarDatos(); renderViajes(); renderDashboard(); renderEstadisticas();
      toastDeshacer('Viaje eliminado', 'viajes', idB, [renderViajes, renderDashboard, renderEstadisticas]);
    });
    return;
  }
  var editar = e.target.closest('[data-editar-viaje]');
  if(editar){
    abrirFormViaje(DATOS.viajes.find(function(v){ return v.id===editar.dataset.editarViaje; }));
    return;
  }
  var duplicar = e.target.closest('[data-duplicar-viaje]');
  if(duplicar){
    var original = DATOS.viajes.find(function(v){ return v.id===duplicar.dataset.duplicarViaje; });
    if(original){
      abrirFormViaje(original);
      editandoViaje = null;
      document.getElementById('fv-fecha').value = fechaLocalISO(true);
      document.getElementById('fv-guardar').textContent = 'Guardar viaje';
      toast('Viaje duplicado — ajusta la fecha/hora y guarda');
    }
  }
});

/* ---------- Fase 3, punto 9: plantillas de viajes ----------
 * Favoritos de trayecto habitual (origen/destino/etiqueta/conductor/notas/km aproximados) para
 * poder iniciar un viaje nuevo con un solo toque en vez de rellenar el formulario cada vez. */
function renderPlantillas(){
  var cont = document.getElementById('lista-plantillas');
  var plantillas = (DATOS.plantillas_viaje||[]).slice().sort(function(a,b){ return normalizarTexto(a.destino).localeCompare(normalizarTexto(b.destino)); });
  cont.innerHTML = plantillas.length ? plantillas.map(function(p){
    return '<div class="fila">'+
      '<div class="ico" data-icon="ruta"></div>'+
      '<div class="fila-tx"><div class="t1">'+esc(p.origen?p.origen+' → ':'')+esc(p.destino)+'</div>'+
      '<div class="t2">'+esc({personal:'Personal',trabajo:'Trabajo',otro:'Otro'}[p.etiqueta]||p.etiqueta)+(p.km_aprox?' · ~'+p.km_aprox+' km':'')+(p.conductor?' · '+esc(p.conductor):'')+'</div></div>'+
      '<button type="button" class="btn-secundario" data-usar-plantilla="'+p.id+'" style="flex:none">Iniciar viaje</button>'+
      '<button type="button" class="btn-borrar" data-borrar-plantilla="'+p.id+'" data-icon="papelera" aria-label="Eliminar"></button>'+
      '</div>';
  }).join('') : '<div class="vacio"><span class="em">🗺️</span><p>Sin plantillas todavía. Crea una con "+ Nueva" para trayectos que repitas a menudo.</p></div>';
  aplicarIconos();
}
var formPlantilla = document.getElementById('form-plantilla');
var editandoPlantilla = null;
document.getElementById('btn-add-plantilla').addEventListener('click', function(){
  editandoPlantilla = null;
  ['fp-origen','fp-destino','fp-conductor','fp-km','fp-notas'].forEach(function(id){ document.getElementById(id).value=''; });
  document.getElementById('fp-etiqueta').value = 'personal';
  formPlantilla.classList.toggle('form-oculto');
});
document.getElementById('fp-cancelar').addEventListener('click', function(){ formPlantilla.classList.add('form-oculto'); });
document.getElementById('form-plantilla').addEventListener('submit', function(e){
  e.preventDefault();
  var destino = document.getElementById('fp-destino').value.trim();
  if(!destino){ toast('Indica al menos el destino.', true); return; }
  var km = parseFloat(document.getElementById('fp-km').value);
  var datos = {
    origen: document.getElementById('fp-origen').value.trim(),
    destino: destino,
    etiqueta: document.getElementById('fp-etiqueta').value,
    conductor: document.getElementById('fp-conductor').value.trim(),
    notas: document.getElementById('fp-notas').value.trim(),
    km_aprox: isFinite(km) && km>0 ? km : null
  };
  if(editandoPlantilla){
    var existente = DATOS.plantillas_viaje.find(function(p){ return p.id===editandoPlantilla; });
    Object.assign(existente, datos);
    existente.updated_at = ahoraISO();
    registrarCambio('plantillas_viaje', 'editar', textoResumenCambio('plantillas_viaje', existente));
  } else {
    var nuevaPlantilla = conTimestamps(datos);
    DATOS.plantillas_viaje.push(nuevaPlantilla);
    registrarCambio('plantillas_viaje', 'crear', textoResumenCambio('plantillas_viaje', nuevaPlantilla));
  }
  guardarDatos();
  formPlantilla.classList.add('form-oculto');
  renderPlantillas();
  toast('Plantilla guardada');
});
document.getElementById('lista-plantillas').addEventListener('click', function(e){
  var usar = e.target.closest('[data-usar-plantilla]');
  if(usar){
    var p = DATOS.plantillas_viaje.find(function(x){ return x.id===usar.dataset.usarPlantilla; });
    if(p){
      abrirFormViaje({ fecha:'', origen:p.origen, destino:p.destino, km:p.km_aprox||'', duracion_min:'', bateria_inicial:null, bateria_final:null, etiqueta:p.etiqueta, conductor:p.conductor });
      document.getElementById('fv-fecha').value = fechaLocalISO(true);
      document.getElementById('fv-km').value = p.km_aprox || '';
      document.getElementById('fv-guardar').textContent = 'Guardar viaje';
      editandoViaje = null;
      formViaje.scrollIntoView({behavior:'smooth', block:'start'});
      toast('Plantilla aplicada — revisa los km/hora y guarda el viaje');
    }
    return;
  }
  var borrar = e.target.closest('[data-borrar-plantilla]');
  if(borrar){
    confirmarAccion('Eliminar plantilla', 'Se borrará esta plantilla de viaje.', function(){
      var idB = borrar.dataset.borrarPlantilla;
      var item = DATOS.plantillas_viaje.find(function(p){ return p.id===idB; });
      marcarBorrado('plantillas_viaje', idB);
      DATOS.plantillas_viaje = DATOS.plantillas_viaje.filter(function(p){ return p.id!==idB; });
      if(item){ moverAPapelera('plantillas_viaje', item); registrarCambio('plantillas_viaje', 'eliminar', textoResumenCambio('plantillas_viaje', item)); }
      guardarDatos(); renderPlantillas();
      toastDeshacer('Plantilla eliminada', 'plantillas_viaje', idB, [renderPlantillas]);
    });
  }
});

/* ---------- B13: UI de reconciliación de facturas de Supercharger ---------- */
var formFactura = document.getElementById('form-factura');
var listaCandidatasFactura = document.getElementById('lista-candidatas-factura');
document.getElementById('btn-factura-toggle').addEventListener('click', function(){
  formFactura.classList.toggle('form-oculto');
  if(formFactura.classList.contains('form-oculto')) listaCandidatasFactura.style.display = 'none';
});
document.getElementById('fac-cancelar').addEventListener('click', function(){
  formFactura.classList.add('form-oculto');
  listaCandidatasFactura.style.display = 'none';
});
formFactura.addEventListener('submit', function(e){
  e.preventDefault();
  var fecha = document.getElementById('fac-fecha').value;
  var importe = parseFloat(document.getElementById('fac-importe').value);
  var kwhTexto = document.getElementById('fac-kwh').value;
  var numero = document.getElementById('fac-numero').value.trim();
  if(!fecha || !isFinite(importe) || importe<=0){ toast('Falta la fecha o el importe de la factura.', true); return; }
  var factura = { fecha: fecha, importe: importe, numero: numero||null, kwh: kwhTexto!=='' ? parseFloat(kwhTexto) : null };
  var candidatas = candidatosFacturaSupercharger(factura, DATOS.cargas);
  if(candidatas.length===0){
    listaCandidatasFactura.style.display = '';
    listaCandidatasFactura.innerHTML = '<div class="vacio"><span class="em">🔌</span><p>Ninguna carga de Supercharger sin reconciliar en las '+VENTANA_RECONCILIACION_FACTURA_HORAS+' horas alrededor de esa fecha. Comprueba la fecha o registra antes la carga en el Historial.</p></div>';
    return;
  }
  listaCandidatasFactura.style.display = '';
  listaCandidatasFactura.innerHTML = candidatas.map(function(cand){
    var c = cand.carga;
    return '<div class="fila"><div class="fila-tx"><div class="t1">'+esc(c.lugar)+' · '+c.kwh+' kWh · '+fechaCorta(c.fecha)+'</div>'+
      '<div class="t2">Coste actual: '+euros(costeCarga(c))+' · a '+cand.diffHoras+' h de la factura'+(cand.diffKwh!==null?(' · Δ'+cand.diffKwh+' kWh'):'')+'</div></div>'+
      '<div class="fila-r"><button type="button" class="ver" data-vincular-factura="'+c.id+'">Vincular · '+euros(importe)+'</button></div></div>';
  }).join('');
  listaCandidatasFactura.querySelectorAll('[data-vincular-factura]').forEach(function(btn){
    btn.addEventListener('click', async function(){
      var copia = JSON.parse(JSON.stringify(DATOS));
      var r = reconciliarFacturaConCarga(copia, btn.dataset.vincularFactura, factura);
      if(!r.ok){ toast('No se pudo reconciliar: '+r.motivo, true); return; }
      var confirmado = await mutacionBusiness('cargas', 'invoice:'+btn.dataset.vincularFactura, btn, async function(repo){
        if(!legacyBusinessPermitido() && r.carga.manual_override===null) r.carga.manual_override={};
        // total_cost is authoritative for invoice reconciliation; avoid an old display alias.
        delete r.carga.coste_total;
        return await repo.guardar(r.carga);
      });
      if(!confirmado) return;
      registrarCambio('cargas', 'editar', 'Factura reconciliada: '+textoResumenCambio('cargas', r.carga));
      guardarDatos();
      renderCargas(); renderDashboard(); renderEstadisticas();
      toast('Factura vinculada a la carga de '+esc(r.carga.lugar));
      formFactura.reset();
      formFactura.classList.add('form-oculto');
      listaCandidatasFactura.style.display = 'none';
    });
  });
});

/* ---------- Formulario: nueva/editar carga ---------- */
var formCarga = document.getElementById('form-carga');
document.getElementById('btn-add-carga').addEventListener('click', function(){
  if(formCarga.classList.contains('form-oculto') || editandoCarga) abrirFormCarga(null);
  else formCarga.classList.add('form-oculto');
});
document.getElementById('fc-cancelar').addEventListener('click', function(){
  formCarga.classList.add('form-oculto');
});
function sugerirPrecioCasa(){
  var tipo = document.getElementById('fc-tipo').value;
  var fecha = document.getElementById('fc-fecha').value;
  if(tipo!=='domestica' || !fecha || editandoCarga) return; // no pisar un valor ya guardado al editar
  var finSesion = document.getElementById('fc-fecha-fin').value;
  var precio = finSesion ? precioMedioSesion(fecha, finSesion, cargarTarifa()) : precioSegunHora(fecha, cargarTarifa());
  document.getElementById('fc-precio').value = precio;
}
document.getElementById('fc-tipo').addEventListener('change', sugerirPrecioCasa);
document.getElementById('fc-fecha').addEventListener('change', sugerirPrecioCasa);
document.getElementById('fc-fecha-fin').addEventListener('change', sugerirPrecioCasa);
// B12 (FASE B): el desglose por tramo horario se recalcula con los mismos disparadores que la
// sugerencia de precio, más el propio kWh (que sugerirPrecioCasa no necesita pero el desglose sí).
['fc-tipo','fc-fecha','fc-fecha-fin','fc-kwh'].forEach(function(id){
  document.getElementById(id).addEventListener('change', renderDesgloseTramos);
  document.getElementById(id).addEventListener('input', renderDesgloseTramos);
});
document.getElementById('form-carga').addEventListener('submit', async function(e){
  e.preventDefault();
  var kwh = parseFloat(document.getElementById('fc-kwh').value);
  var precio = parseFloat(document.getElementById('fc-precio').value);
  var fecha = document.getElementById('fc-fecha').value;
  var lugar = document.getElementById('fc-lugar').value.trim();
  if(!fecha || !lugar || isNaN(kwh) || isNaN(precio)){
    toast('Completa al menos fecha, lugar, kWh y €/kWh.', true);
    return;
  }
  if(kwh <= 0 || precio < 0){
    toast('Los kWh deben ser mayores que 0 y el precio no puede ser negativo.', true);
    return;
  }
  var cbIni = parseOptionalPercentage(document.getElementById('fc-bini').value);
  var cbFin = parseOptionalPercentage(document.getElementById('fc-bfin').value);
  if((cbIni!==null && (isNaN(cbIni) || cbIni<0 || cbIni>100)) || (cbFin!==null && (isNaN(cbFin) || cbFin<0 || cbFin>100))){
    toast('La batería debe estar entre 0 % y 100 %.', true);
    return;
  }
  if(cbIni!==null && cbFin!==null && cbFin<=cbIni){
    toast('Aviso: la batería final ('+cbFin+' %) no es mayor que la inicial ('+cbIni+' %) en una carga.'); // advertencia, no bloquea el guardado
  }
  var acdc = document.getElementById('fc-acdc').value || null;
  var red = document.getElementById('fc-red').value.trim() || null;
  var potencia = parseFloat(document.getElementById('fc-potencia').value);
  var costeOrigen = document.getElementById('fc-coste-origen').value || 'estimado';
  var notas = document.getElementById('fc-notas').value.trim() || '';
  var fechaFin = document.getElementById('fc-fecha-fin').value || null;
  if(fechaFin && new Date(fechaFin) <= new Date(fecha)){
    toast('El fin de la sesión debe ser posterior al inicio.', true);
    return;
  }
  // Punto 7 (Fase 3): pérdidas de carga opcionales — si se conocen, el coste real es sobre la
  // energía tomada de la red (mayor que la que llega a la batería), no sobre los kWh del coche.
  var perdidasPct = parseFloat(document.getElementById('fc-perdidas').value);
  var conPerdidas = isFinite(perdidasPct) && perdidasPct>0 && perdidasPct<100;
  var kwhRed = conPerdidas ? Math.round((kwh/(1-perdidasPct/100))*1000)/1000 : null;
  var costeTotal = Math.round((conPerdidas ? kwhRed : kwh) * precio * 100) / 100;
  // Punto 8 (Fase 3): atribución opcional de la energía a red/solar/batería doméstica. Sin dato del
  // usuario no se inventa procedencia — origen_energia queda null. Modelo simplificado y documentado:
  // se asume coste marginal 0 para solar/batería propia (no hay datos de tarifa de excedentes en esta
  // app), así que "ahorro frente a red" es lo que habría costado esa parte si viniera 100% de red.
  var solarPct = featureActiva('solar_tracking') ? parseFloat(document.getElementById('fc-origen-solar').value) : NaN;
  var bateriaPct = featureActiva('solar_tracking') ? parseFloat(document.getElementById('fc-origen-bateria').value) : NaN;
  var origenEnergia = null;
  if((isFinite(solarPct) && solarPct>0) || (isFinite(bateriaPct) && bateriaPct>0)){
    solarPct = isFinite(solarPct) && solarPct>0 ? Math.min(100,solarPct) : 0;
    bateriaPct = isFinite(bateriaPct) && bateriaPct>0 ? Math.min(100,bateriaPct) : 0;
    if(solarPct+bateriaPct > 100){ toast('Solar % + Batería % no pueden superar el 100 %.', true); return; }
    var redPct = 100 - solarPct - bateriaPct;
    var kwhBase = conPerdidas ? kwhRed : kwh;
    origenEnergia = {
      red_pct: redPct, solar_pct: solarPct, bateria_pct: bateriaPct,
      coste_contable: Math.round(kwhBase*(redPct/100)*precio*100)/100,
      coste_marginal: Math.round(kwhBase*(redPct/100)*precio*100)/100, // supuesto: marginal solar/batería = 0 (ver nota arriba)
      ahorro_frente_a_red: Math.round(kwhBase*((solarPct+bateriaPct)/100)*precio*100)/100
    };
  }
  // Punto 6 (Fase 3): una carga gratuita (precio 0 €/kWh) es un coste total real de 0 €, no
  // "sin dato" — se calcula siempre a partir de kwh*precio salvo que el usuario marque el coste
  // como "facturado" (import futuro con factura real distinta al cálculo).
  var datos = {
    fecha: fecha, fecha_fin: fechaFin, lugar: lugar, tipo: document.getElementById('fc-tipo').value,
    kwh: kwh, precio_kwh: precio,
    bateria_inicial: cbIni,
    bateria_final: cbFin,
    ac_dc: (acdc==='AC'||acdc==='DC') ? acdc : null,
    red: red,
    potencia_max_kw: (isFinite(potencia) && potencia>0) ? potencia : null,
    perdidas_pct: conPerdidas ? perdidasPct : null,
    kwh_red_estimado: kwhRed,
    total_cost: costeTotal,
    cost_source: ['conocido','estimado','facturado'].indexOf(costeOrigen)!==-1 ? costeOrigen : 'estimado',
    data_source: (editandoCarga && DATOS.cargas.find(function(x){return x.id===editandoCarga;}) || {}).data_source || 'manual',
    notas: notas,
    vehicle_id: DATOS.vehiculo && DATOS.vehiculo.tesla_vin ? DATOS.vehiculo.tesla_vin : null,
    origen_energia: origenEnergia
  };
  var guardado = await mutacionBusiness('cargas', 'form', formCarga, async function(repo){
    var anterior = editandoCarga ? repo.obtener(editandoCarga) : null;
    if(editandoCarga && !anterior) throw new Error('La carga ya no está disponible; tu borrador se conserva.');
    var draft = Object.assign({}, anterior || {}, datos);
    if(!anterior) draft.id = 'c'+Date.now();
    else if(!legacyBusinessPermitido()) draft.revision = editandoCargaRevision;
    delete draft.coste_total; // The form calculated a fresh total_cost.
    if(!legacyBusinessPermitido() && draft.manual_override===null) draft.manual_override={};
    return await repo.guardar(draft);
  });
  if(!guardado) return; // Keep every input and editing id on 409/network failure.
  avisarSiFechaFutura(fecha);
  if(legacyBusinessPermitido()) guardarDatos();
  ['fc-fecha','fc-lugar','fc-kwh','fc-precio','fc-bini','fc-bfin','fc-red','fc-potencia','fc-notas','fc-fecha-fin','fc-perdidas','fc-origen-solar','fc-origen-bateria'].forEach(function(id){ document.getElementById(id).value=''; });
  document.getElementById('fc-acdc').value = '';
  document.getElementById('fc-coste-origen').value = 'estimado';
  formCarga.classList.add('form-oculto');
  renderCargas();
  renderDashboard();
  renderBateria();
  renderGastos();
  renderEstadisticas();
  toast(editandoCarga ? 'Carga actualizada' : 'Carga añadida');
});
document.getElementById('lista-cargas').addEventListener('click', function(e){
  if(manejarToggleMes(e)) return;
  var borrar = e.target.closest('[data-borrar-carga]');
  if(borrar){
    confirmarAccion('Eliminar carga', 'Se borrará esta carga del historial.', async function(){
      var idB = borrar.dataset.borrarCarga;
      var eliminado = await mutacionBusiness('cargas', 'delete:'+idB, borrar, async function(repo){
        var item = repo.obtener(idB);
        await repo.eliminar(idB);
        if(item) moverAPapelera('cargas', item);
        return true;
      });
      if(!eliminado) return;
      if(legacyBusinessPermitido()) guardarDatos(); renderCargas(); renderDashboard(); renderBateria(); renderGastos(); renderEstadisticas();
      toastDeshacer('Carga eliminada', 'cargas', idB, [renderCargas, renderDashboard, renderBateria, renderGastos, renderEstadisticas]);
    });
    return;
  }
  var editar = e.target.closest('[data-editar-carga]');
  if(editar){
    abrirFormCarga(DATOS.cargas.find(function(c){ return c.id===editar.dataset.editarCarga; }));
    return;
  }
  var duplicar = e.target.closest('[data-duplicar-carga]');
  if(duplicar){
    var original = DATOS.cargas.find(function(c){ return c.id===duplicar.dataset.duplicarCarga; });
    if(original){
      abrirFormCarga(original);
      editandoCarga = null;
      document.getElementById('fc-fecha').value = fechaLocalISO(true);
      document.getElementById('fc-guardar').textContent = 'Guardar carga';
      toast('Carga duplicada — ajusta la fecha/hora y guarda');
    }
  }
});

/* ---------- Formulario: nuevo/editar gasto ---------- */
var formGasto = document.getElementById('form-gasto');
document.getElementById('btn-add-gasto').addEventListener('click', function(){
  if(formGasto.classList.contains('form-oculto') || editandoGasto) abrirFormGasto(null);
  else formGasto.classList.add('form-oculto');
});
document.getElementById('fg-cancelar').addEventListener('click', function(){
  formGasto.classList.add('form-oculto');
});
document.getElementById('form-gasto').addEventListener('submit', function(e){
  e.preventDefault();
  var importe = parseFloat(document.getElementById('fg-importe').value);
  var fecha = document.getElementById('fg-fecha').value;
  var concepto = document.getElementById('fg-concepto').value.trim();
  if(!fecha || !concepto || isNaN(importe)){
    toast('Completa al menos fecha, concepto e importe.', true);
    return;
  }
  if(importe < 0){
    toast('El importe no puede ser negativo.', true);
    return;
  }
  // B3 (FASE B): usa el repository layer (expenseRepository) en vez de tocar DATOS.gastos a mano —
  // esta vista ya no necesita saber cómo se guarda/actualiza un gasto. De paso corrige un hueco real
  // que tenía este formulario en concreto: los gastos nunca habían pasado por conTimestamps, así que
  // no llevaban created_at/updated_at (a diferencia del resto de colecciones) y siempre "perdían" en
  // una fusión multi-dispositivo por el fallback de marcaTiempo a la fecha mínima.
  var datos = { fecha: fecha, categoria: document.getElementById('fg-categoria').value, concepto: concepto, importe: importe };
  if(editandoGasto) datos.id = editandoGasto;
  expenseRepository.guardar(datos);
  avisarSiFechaFutura(fecha);
  ['fg-fecha','fg-concepto','fg-importe'].forEach(function(id){ document.getElementById(id).value=''; });
  formGasto.classList.add('form-oculto');
  renderGastos();
  renderDashboard();
  toast(editandoGasto ? 'Gasto actualizado' : 'Gasto añadido');
});
document.getElementById('lista-gastos').addEventListener('click', function(e){
  var borrar = e.target.closest('[data-borrar-gasto]');
  if(borrar){
    confirmarAccion('Eliminar gasto', 'Se borrará este gasto del registro.', function(){
      var idB = borrar.dataset.borrarGasto;
      expenseRepository.eliminar(idB);
      renderGastos(); renderDashboard();
      toastDeshacer('Gasto eliminado', 'gastos', idB, [renderGastos, renderDashboard]);
    });
    return;
  }
  var editar = e.target.closest('[data-editar-gasto]');
  if(editar){
    abrirFormGasto(DATOS.gastos.find(function(g){ return g.id===editar.dataset.editarGasto; }));
    return;
  }
  var duplicar = e.target.closest('[data-duplicar-gasto]');
  if(duplicar){
    var original = DATOS.gastos.find(function(g){ return g.id===duplicar.dataset.duplicarGasto; });
    if(original){
      abrirFormGasto(original);
      editandoGasto = null;
      document.getElementById('fg-fecha').value = fechaLocalISO();
      document.getElementById('fg-guardar').textContent = 'Guardar gasto';
      toast('Gasto duplicado — ajusta la fecha y guarda');
    }
  }
});

/* ---------- Formulario: nuevo recordatorio de mantenimiento ---------- */
var formRecordatorio = document.getElementById('form-recordatorio');
document.getElementById('btn-add-recordatorio').addEventListener('click', function(){
  if(formRecordatorio.classList.contains('form-oculto') || editandoRecordatorio) abrirFormRecordatorio(null);
  else formRecordatorio.classList.add('form-oculto');
});
var editandoRecordatorio = null;
function abrirFormRecordatorio(r){
  editandoRecordatorio = r ? r.id : null;
  document.getElementById('fr-concepto').value = r ? r.concepto : '';
  document.getElementById('fr-km').value = r ? r.km_objetivo : '';
  document.getElementById('fr-guardar').textContent = r ? 'Guardar cambios' : 'Guardar';
  formRecordatorio.classList.remove('form-oculto');
}
document.getElementById('form-recordatorio').addEventListener('submit', function(e){
  e.preventDefault();
  var concepto = document.getElementById('fr-concepto').value.trim();
  var km = parseInt(document.getElementById('fr-km').value);
  if(!concepto || !km){ toast('Completa concepto y kilómetro objetivo.', true); return; }
  if(km <= 0){ toast('El kilómetro objetivo debe ser mayor que 0.', true); return; }
  if(!DATOS.recordatorios) DATOS.recordatorios = [];
  var eraEdicion = !!editandoRecordatorio;
  if(editandoRecordatorio){
    var r = DATOS.recordatorios.find(function(x){ return x.id===editandoRecordatorio; });
    if(r){ r.concepto = concepto; r.km_objetivo = km; registrarCambio('recordatorios', 'editar', textoResumenCambio('recordatorios', r)); }
  } else {
    var nuevoRec = { id:'r'+Date.now(), concepto:concepto, km_objetivo:km };
    DATOS.recordatorios.push(nuevoRec);
    registrarCambio('recordatorios', 'crear', textoResumenCambio('recordatorios', nuevoRec));
  }
  guardarDatos();
  document.getElementById('fr-concepto').value = '';
  document.getElementById('fr-km').value = '';
  document.getElementById('fr-guardar').textContent = 'Guardar';
  editandoRecordatorio = null;
  formRecordatorio.classList.add('form-oculto');
  renderRecordatorios();
  toast(eraEdicion ? 'Recordatorio actualizado' : 'Recordatorio añadido');
});
document.getElementById('fr-cancelar').addEventListener('click', function(){
  editandoRecordatorio = null;
  formRecordatorio.classList.add('form-oculto');
});
document.getElementById('lista-recordatorios').addEventListener('click', function(e){
  var borrar = e.target.closest('[data-borrar-recordatorio]');
  if(borrar){
    confirmarAccion('Eliminar recordatorio', 'Se borrará este recordatorio.', function(){
      var idB = borrar.dataset.borrarRecordatorio;
      var item = DATOS.recordatorios.find(function(r){ return r.id===idB; });
      marcarBorrado('recordatorios', idB);
      DATOS.recordatorios = DATOS.recordatorios.filter(function(r){ return r.id!==idB; });
      if(item){ moverAPapelera('recordatorios', item); registrarCambio('recordatorios', 'eliminar', textoResumenCambio('recordatorios', item)); }
      guardarDatos(); renderRecordatorios();
      toastDeshacer('Recordatorio eliminado', 'recordatorios', idB, [renderRecordatorios]);
    });
    return;
  }
  var editar = e.target.closest('[data-editar-recordatorio]');
  if(editar){
    abrirFormRecordatorio(DATOS.recordatorios.find(function(r){ return r.id===editar.dataset.editarRecordatorio; }));
  }
});

/* ---------- Iconos SVG (trazo, estilo SF Symbols) ---------- */
var ICONOS = {
  home: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9h5v-5h2v5h5v-9"/>',
  rayo: '<path d="M13 3 5 14h5l-1 8 9-12h-5l1-7z" stroke-linejoin="round"/>',
  ruta: '<circle cx="6" cy="7" r="2.4"/><circle cx="18" cy="17" r="2.4"/><path d="M6 9.4V13a4 4 0 0 0 4 4h4"/>',
  bateria: '<rect x="3" y="8" width="16" height="8" rx="2"/><path d="M21 10.5v3"/><rect x="5.5" y="10" width="4" height="4" fill="currentColor" stroke="none"/>',
  euro: '<path d="M17 6.5A6.5 6.5 0 1 0 17 17.5"/><path d="M6 10h9M6 14h7"/>',
  stats: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  ajustes: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5A7 7 0 0 0 5 12a7 7 0 0 0 .1 1.2l-2 1.5 2 3.4 2.3-.9c.6.5 1.3.9 2 1.2L10 21h4l.4-2.6c.7-.3 1.4-.7 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z"/>',
  pin: '<path d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.4"/>',
  papelera: '<path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M10 11v6M14 11v6"/>',
  estrella: '<path d="M12 3.5 14.7 9 21 9.8l-4.5 4.2 1.2 6.2L12 17.2 6.3 20.2l1.2-6.2L3 9.8 9.3 9Z" stroke-linejoin="round" fill="currentColor"/>',
  termometro: '<path d="M14 14.76V5a2 2 0 0 0-4 0v9.76a4 4 0 1 0 4 0Z"/><path d="M12 9v5"/>',
  duplicar: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  coche: '<path d="M4 16v-3.5L6 8h12l2 4.5V16"/><path d="M4 16h16"/><circle cx="7.5" cy="17.5" r="1.6"/><circle cx="16.5" cy="17.5" r="1.6"/>',
  gota: '<path d="M12 3c3 4 6 7.5 6 11a6 6 0 0 1-12 0c0-3.5 3-7 6-11Z"/>',
  reloj: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  tema: '<circle cx="12" cy="12" r="7"/><path d="M12 5a7 7 0 0 0 0 14Z" fill="currentColor" stroke="none"/>',
  campana: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2.5h-15L6 16Z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  nube: '<path d="M7 18a4 4 0 1 1 .7-7.94A5 5 0 0 1 17.5 12H18a3 3 0 0 1 0 6H7Z"/>',
  descarga: '<path d="M12 4v11"/><path d="M8 11l4 4 4-4"/><path d="M5 19h14"/>',
  aviso: '<path d="M12 3 22 20H2Z" stroke-linejoin="round"/><path d="M12 9.5v5"/><circle cx="12" cy="17.3" r="0.9" fill="currentColor" stroke="none"/>',
  candado: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'
};
var TITULOS_ICONO = { papelera:'Eliminar', duplicar:'Duplicar' };
function aplicarIconos(){
  document.querySelectorAll('[data-icon]').forEach(function(el){
    var d = ICONOS[el.dataset.icon];
    if(TITULOS_ICONO[el.dataset.icon] && !el.title) el.title = TITULOS_ICONO[el.dataset.icon];
    if(!d || el.dataset.pintado) return;
    el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">'+d+'</svg>';
    el.dataset.pintado = '1';
  });
}
function li(nombre){
  return '<span class="ic-lbl" data-icon="'+nombre+'"></span>';
}
aplicarIconos();

/* ---------- Navegación ---------- */
var btns = document.querySelectorAll('.nav button, .nav-escritorio button');
var vistas = {
  dashboard: document.getElementById('vista-dashboard'),
  cargas: document.getElementById('vista-cargas'),
  viajes: document.getElementById('vista-viajes'),
  mapa: document.getElementById('vista-mapa'),
  bateria: document.getElementById('vista-bateria'),
  economia: document.getElementById('vista-economia'),
  estadisticas: document.getElementById('vista-estadisticas'),
  ajustes: document.getElementById('vista-ajustes'),
  mas: document.getElementById('vista-mas'),
  proximamente: document.getElementById('vista-proximamente')
};
// Vistas que viven dentro de "Más" en la barra inferior: al navegar a cualquiera de ellas
// (desde un data-goto, un enlace directo, etc.) el botón que debe quedar marcado como activo
// es "Más", no un botón inexistente en la barra.
var VISTAS_EN_MAS = ['bateria','economia','estadisticas','ajustes'];
function mostrar(nombre){
  var clave = vistas[nombre] ? nombre : 'proximamente';
  Object.keys(vistas).forEach(function(k){ vistas[k].style.display = (k === clave) ? '' : 'none'; });
  var claveNav = VISTAS_EN_MAS.indexOf(clave)!==-1 ? 'mas' : clave;
  btns.forEach(function(x){
    // El nav inferior (móvil) agrupa batería/economía/estadísticas/ajustes bajo "Más" (claveNav);
    // la barra lateral de escritorio los muestra como botones propios, así que también se
    // comparan contra la vista real (clave) para resaltar el correcto en ambos layouts a la vez.
    var activo = x.dataset.vista === claveNav || x.dataset.vista === clave;
    x.classList.toggle('on', activo);
    if(activo) x.setAttribute('aria-current','page'); else x.removeAttribute('aria-current');
  });
  window.scrollTo(0,0);
  if(clave === 'mapa'){
    iniciarMapa();
    renderLugares();
    renderPlanes();
    cargarClimaYAjustarAutonomia();
    setTimeout(function(){ if(mapaLeaflet) mapaLeaflet.invalidateSize(); }, 80);
    // B7 (FASE B): lugares D1 (geofences), carga perezosa igual que el resto del mapa.
    if(typeof cargarLugaresD1==='function') cargarLugaresD1();
  }
  // B5/B6 (FASE B): se cargan al entrar en la pantalla (no en cada render de la lista manual,
  // que se repinta mucho más a menudo) — misma idea de carga perezosa que ya usa "mapa" arriba.
  if(clave === 'viajes' && typeof cargarViajesAutomaticos==='function') cargarViajesAutomaticos();
  if(clave === 'cargas' && typeof cargarCargasAutomaticas==='function') cargarCargasAutomaticas();
}
btns.forEach(function(b){ b.addEventListener('click', function(){ mostrar(b.dataset.vista); }); });
document.getElementById('lista-mas').addEventListener('click', function(e){
  var b = e.target.closest('[data-vista]');
  if(b) mostrar(b.dataset.vista);
});
/* Delegado en document.body: también funciona con avisos u otros elementos con [data-goto]
   insertados dinámicamente después de este punto (p. ej. los banners del Dashboard). */
document.body.addEventListener('click', function(e){
  var el = e.target.closest('[data-goto]');
  if(el) mostrar(el.dataset.goto);
});
document.getElementById('btn-rapido-viaje').addEventListener('click', function(){
  mostrar('viajes');
  setTimeout(function(){ document.getElementById('btn-add-viaje').click(); }, 60);
});
document.getElementById('btn-rapido-carga').addEventListener('click', function(){
  mostrar('cargas');
  setTimeout(function(){ document.getElementById('btn-add-carga').click(); }, 60);
});

/* ---------- Fase 3, punto 28: búsqueda global ----------
 * Busca en las colecciones con contenido que el usuario redacta él mismo (no en ajustes/config).
 * Los resultados navegan a la vista correspondiente y resaltan la fila encontrada — no abren
 * el formulario de edición directamente, para no dar por hecho que "buscar" significa "editar". */
var BUSQUEDA_GLOBAL_FUENTES = [
  { coleccion:'viajes', vista:'viajes', texto:function(v){ return esc(v.origen)+' → '+esc(v.destino)+(v.conductor?' · '+esc(v.conductor):''); },
    campo:function(v){ return [v.origen,v.destino,v.conductor,v.etiqueta].join(' '); },
    selector:function(v){ return '[data-editar-viaje="'+v.id+'"]'; }, fecha:function(v){return v.fecha;} },
  { coleccion:'cargas', vista:'cargas', texto:function(c){ return esc(c.lugar)+(c.ac_dc?' · '+c.ac_dc:''); },
    campo:function(c){ return [c.lugar,c.tipo,c.notas].join(' '); },
    selector:function(c){ return '[data-editar-carga="'+c.id+'"]'; }, fecha:function(c){return c.fecha;} },
  { coleccion:'gastos', vista:'gastos', texto:function(g){ return esc(g.concepto); },
    campo:function(g){ return [g.concepto,g.categoria].join(' '); },
    selector:function(g){ return '[data-editar-gasto="'+g.id+'"]'; }, fecha:function(g){return g.fecha;} },
  { coleccion:'recordatorios', vista:'economia', texto:function(r){ return esc(r.concepto); },
    campo:function(r){ return r.concepto; },
    selector:function(r){ return '[data-editar-recordatorio="'+r.id+'"]'; } },
  { coleccion:'accesorios', vista:'economia', texto:function(a){ return esc(a.nombre); },
    campo:function(a){ return [a.nombre,a.categoria].join(' '); },
    selector:function(a){ return '[data-editar-accesorio="'+a.id+'"]'; }, fecha:function(a){return a.fecha;} },
  { coleccion:'mantenimiento', vista:'economia', texto:function(m){ return esc(NOMBRE_CAT_MANT[m.categoria]||m.categoria)+' — '+esc(m.concepto); },
    campo:function(m){ return [m.concepto,m.categoria,m.notas].join(' '); },
    selector:function(m){ return '[data-editar-mantenimiento="'+m.id+'"]'; }, fecha:function(m){return m.fecha;} },
  { coleccion:'documentos', vista:'economia', texto:function(d){ return esc(d.nombre); },
    campo:function(d){ return [d.nombre,d.relacionado_con,d.notas].join(' '); },
    selector:function(d){ return '[data-borrar-documento="'+d.id+'"]'; }, fecha:function(d){return d.fecha;} },
  { coleccion:'plantillas_viaje', vista:'viajes', texto:function(p){ return esc(p.nombre||((p.origen||'')+' → '+(p.destino||''))); },
    campo:function(p){ return [p.nombre,p.origen,p.destino].join(' '); },
    selector:function(p){ return '[data-borrar-plantilla="'+p.id+'"]'; } }
];
/** Busca `query` (insensible a acentos/mayúsculas) en las colecciones de BUSQUEDA_GLOBAL_FUENTES.
 *  Devuelve como máximo 30 resultados, priorizando los más recientes cuando hay fecha. */
function buscarGlobal(query){
  var q = normalizarTexto(query.trim());
  if(!q) return [];
  var resultados = [];
  BUSQUEDA_GLOBAL_FUENTES.forEach(function(fuente){
    var lista = DATOS[fuente.coleccion] || [];
    lista.forEach(function(item){
      if(normalizarTexto(fuente.campo(item)).indexOf(q)!==-1){
        resultados.push({
          coleccion: fuente.coleccion, vista: fuente.vista, id: item.id,
          texto: fuente.texto(item), selector: fuente.selector(item),
          fecha: fuente.fecha ? fuente.fecha(item) : null,
          etiqueta: NOMBRE_COLECCION_PAPELERA[fuente.coleccion] || fuente.coleccion
        });
      }
    });
  });
  resultados.sort(function(a,b){
    if(a.fecha && b.fecha) return new Date(b.fecha)-new Date(a.fecha);
    return a.fecha ? -1 : (b.fecha ? 1 : 0);
  });
  return resultados.slice(0,30);
}
/** Resalta brevemente una fila ya visible (tras cambiar de vista) para que el usuario la localice
 *  sin tener que buscarla de nuevo entre el resto del listado. */
function resaltarFila(selector){
  setTimeout(function(){
    var el = document.querySelector(selector);
    if(!el) return;
    var fila = el.closest('.fila') || el;
    fila.scrollIntoView({behavior:'smooth', block:'center'});
    fila.classList.add('fila-resaltada');
    setTimeout(function(){ fila.classList.remove('fila-resaltada'); }, 1800);
  }, 120); // pequeño margen para que la vista termine de pintarse antes de buscar el elemento
}
var busquedaGlobalFocoAnterior = null;
function abrirBusquedaGlobal(){
  busquedaGlobalFocoAnterior = document.activeElement;
  document.getElementById('busqueda-global-fondo').classList.add('on');
  document.getElementById('busqueda-global-input').value = '';
  document.getElementById('busqueda-global-resultados').innerHTML = '';
  document.getElementById('busqueda-global-input').focus();
}
function cerrarBusquedaGlobal(){
  document.getElementById('busqueda-global-fondo').classList.remove('on');
  if(busquedaGlobalFocoAnterior && busquedaGlobalFocoAnterior.focus) busquedaGlobalFocoAnterior.focus();
}
function renderResultadosBusqueda(query){
  var cont = document.getElementById('busqueda-global-resultados');
  if(!query.trim()){ cont.innerHTML = ''; return; }
  var resultados = buscarGlobal(query);
  cont.innerHTML = resultados.length ? resultados.map(function(r,i){
    return '<button type="button" class="fila fila-btn" style="width:100%;text-align:left" data-resultado-busqueda="'+i+'">'+
      '<div class="fila-tx"><div class="t1">'+r.texto+'</div><div class="t2">'+esc(r.etiqueta)+(r.fecha?' · '+fechaCorta(r.fecha):'')+'</div></div>'+
      '</button>';
  }).join('') : '<div class="vacio"><span class="em">🔍</span><p>Sin resultados para "'+esc(query)+'".</p></div>';
  cont.dataset.resultados = JSON.stringify(resultados.map(function(r){ return {vista:r.vista, selector:r.selector}; }));
}
document.getElementById('btn-busqueda-global').addEventListener('click', abrirBusquedaGlobal);
document.getElementById('busqueda-global-fondo').addEventListener('click', function(e){
  if(e.target.id==='busqueda-global-fondo') cerrarBusquedaGlobal();
});
document.getElementById('busqueda-global-input').addEventListener('input', function(){
  renderResultadosBusqueda(this.value);
});
document.getElementById('busqueda-global-resultados').addEventListener('click', function(e){
  var btn = e.target.closest('[data-resultado-busqueda]');
  if(!btn) return;
  var resultados = JSON.parse(document.getElementById('busqueda-global-resultados').dataset.resultados || '[]');
  var r = resultados[parseInt(btn.dataset.resultadoBusqueda,10)];
  if(!r) return;
  cerrarBusquedaGlobal();
  mostrar(r.vista);
  resaltarFila(r.selector);
});
document.addEventListener('keydown', function(e){
  if(e.key==='Escape' && document.getElementById('busqueda-global-fondo').classList.contains('on')) cerrarBusquedaGlobal();
  // Atajo de teclado en escritorio (no interfiere con el móvil, que no tiene teclado físico habitual).
  if((e.metaKey||e.ctrlKey) && e.key==='k'){ e.preventDefault(); abrirBusquedaGlobal(); }
});

/* ---------- Gráfico: evolución de batería (línea), leído de DATOS ---------- */
/* ---------- Formulario: nueva lectura de salud de batería ---------- */
var formBateria = document.getElementById('form-bateria');
document.getElementById('btn-add-bateria').addEventListener('click', function(){
  formBateria.classList.toggle('form-oculto');
  if(!formBateria.classList.contains('form-oculto')){
    document.getElementById('fb-fecha').value = fechaLocalISO();
  }
});
document.getElementById('fb-cancelar').addEventListener('click', function(){
  formBateria.classList.add('form-oculto');
});
document.getElementById('form-bateria').addEventListener('submit', function(e){
  e.preventDefault();
  var fecha = document.getElementById('fb-fecha').value;
  var pct = parseFloat(document.getElementById('fb-pct').value);
  if(!fecha || isNaN(pct) || pct<=0 || pct>100){ toast('Indica una fecha y un % válido (0-100).', true); return; }
  var existente = DATOS.bateria_historico.find(function(h){ return h.fecha === fecha; });
  if(existente){
    existente.capacidad_pct = pct;
    conTimestamps(existente, existente);
  } else {
    var nueva = { fecha: fecha, capacidad_pct: pct };
    conTimestamps(nueva, null);
    DATOS.bateria_historico.push(nueva);
  }
  DATOS.bateria_historico.sort(function(a,b){ return new Date(a.fecha)-new Date(b.fecha); });
  guardarDatos();
  document.getElementById('fb-pct').value = '';
  formBateria.classList.add('form-oculto');
  renderBateria();
  renderDashboard();
  toast('Lectura de batería guardada');
});

function dibujarChartBateria(){
  var MESES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  var datos = DATOS.bateria_historico.map(function(h){
    var d = new Date(h.fecha+'T00:00:00');
    return { m: MESES[d.getMonth()], v: h.capacidad_pct };
  });
  var cont = document.getElementById('chart-bateria');
  if(!datos.length){ cont.innerHTML = '<div class="vacio" style="padding:20px 0"><p>Sin datos suficientes para el gráfico.</p></div>'; return; }
  var w=290, h=120, pad=18;
  var valores = datos.map(function(d){return d.v;});
  var min = Math.min.apply(null,valores)-1, max = Math.max.apply(null,valores)+0.5;
  var pts = datos.map(function(d,i){
    var x = pad + i*(w-2*pad)/Math.max(datos.length-1,1);
    var y = h-pad - (d.v-min)/(max-min)*(h-2*pad);
    return [x,y];
  });
  var linea = pts.map(function(p,i){ return (i?'L':'M')+p[0].toFixed(1)+','+p[1].toFixed(1); }).join(' ');
  var area = linea + ' L'+pts[pts.length-1][0]+','+(h-pad)+' L'+pts[0][0]+','+(h-pad)+' Z';
  var puntos = pts.map(function(p){
    return '<circle cx="'+p[0]+'" cy="'+p[1]+'" r="3.2" fill="#0a84ff"/>';
  }).join('');
  var labels = datos.map(function(d,i){
    return '<text x="'+pts[i][0]+'" y="'+(h-2)+'" font-size="10" fill="var(--txt3)" text-anchor="middle">'+d.m+'</text>';
  }).join('');
  document.getElementById('chart-bateria').innerHTML =
    '<svg viewBox="0 0 '+w+' '+h+'" width="100%" style="overflow:visible">' +
    '<defs><linearGradient id="gb" x1="0" y1="0" x2="0" y2="1">'+
    '<stop offset="0" stop-color="#0a84ff" stop-opacity=".22"/>'+
    '<stop offset="1" stop-color="#0a84ff" stop-opacity="0"/></linearGradient></defs>'+
    '<path d="'+area+'" fill="url(#gb)"/>'+
    '<path d="'+linea+'" fill="none" stroke="#0a84ff" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>'+
    puntos + labels + '</svg>';
}

/* ---------- Gráfico: kilómetros por mes (barras, últimos 6 meses con datos reales) ---------- */
function dibujarChartKmMes(){
  var cont = document.getElementById('chart-km-mes');
  if(!cont) return;
  var MESES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  var ahora = new Date();
  var meses = [];
  for(var i=5; i>=0; i--){
    var d = new Date(ahora.getFullYear(), ahora.getMonth()-i, 1);
    meses.push({ mes:d.getMonth(), año:d.getFullYear(), m:MESES[d.getMonth()], v:0 });
  }
  DATOS.viajes.forEach(function(v){
    var d = new Date(v.fecha);
    var slot = meses.find(function(x){ return x.mes===d.getMonth() && x.año===d.getFullYear(); });
    if(slot) slot.v += v.km;
  });
  var datos = meses;
  var w=290, h=130, pad=20, bw=28, gap=(w-2*pad-bw*datos.length)/(datos.length-1);
  var max = Math.max.apply(null, datos.map(function(d){return d.v;})) || 1;
  var barras = datos.map(function(d,i){
    var x = pad + i*(bw+gap);
    var bh = (d.v/max)*(h-pad-24);
    var y = h-24-bh;
    return '<rect x="'+x+'" y="'+y+'" width="'+bw+'" height="'+bh+'" rx="6" fill="'+(i===datos.length-1?'#e8342a':'rgba(10,132,255,.55)')+'"/>'+
      '<text x="'+(x+bw/2)+'" y="'+(h-8)+'" font-size="10" fill="var(--txt3)" text-anchor="middle">'+d.m+'</text>';
  }).join('');
  cont.innerHTML = datos.some(function(d){return d.v>0;})
    ? '<svg viewBox="0 0 '+w+' '+h+'" width="100%" style="overflow:visible">'+barras+'</svg>'
    : '<div class="vacio" style="padding:20px 0"><span class="em">📊</span><p>Registra viajes para ver tus kilómetros por mes.</p></div>';
}

/* ---------- Catálogo de modelos Tesla (estilo ABRP) — capacidad y autonomía WLTP aproximadas por versión ---------- */
var TESLA_MODELOS = [
  { grupo:'Model S', id:'mods-2012-70', label:'Model S 70 (2012–2016)', capacidad:70, autonomia:390 },
  { grupo:'Model S', id:'mods-2012-85', label:'Model S 85 (2012–2016)', capacidad:85, autonomia:502 },
  { grupo:'Model S', id:'mods-2016-75d', label:'Model S 75D (2016–2019)', capacidad:75, autonomia:417 },
  { grupo:'Model S', id:'mods-2016-100d', label:'Model S 100D (2016–2019)', capacidad:100, autonomia:632 },
  { grupo:'Model S', id:'mods-2016-p100d', label:'Model S P100D (2016–2019)', capacidad:100, autonomia:507 },
  { grupo:'Model S', id:'mods-2021-lr', label:'Model S Long Range (2021– )', capacidad:100, autonomia:634 },
  { grupo:'Model S', id:'mods-2021-plaid', label:'Model S Plaid (2021– )', capacidad:100, autonomia:600 },
  { grupo:'Model X', id:'modx-2015-90d', label:'Model X 90D (2015–2016)', capacidad:90, autonomia:417 },
  { grupo:'Model X', id:'modx-2016-75d', label:'Model X 75D (2016–2019)', capacidad:75, autonomia:381 },
  { grupo:'Model X', id:'modx-2016-100d', label:'Model X 100D (2016–2019)', capacidad:100, autonomia:565 },
  { grupo:'Model X', id:'modx-2021-lr', label:'Model X Long Range (2021– )', capacidad:100, autonomia:560 },
  { grupo:'Model X', id:'modx-2021-plaid', label:'Model X Plaid (2021– )', capacidad:100, autonomia:530 },
  { grupo:'Model 3', id:'mod3-2017-lr', label:'Model 3 Long Range (2017–2020)', capacidad:75, autonomia:560 },
  { grupo:'Model 3', id:'mod3-2019-sr', label:'Model 3 Standard Range Plus (2019–2021)', capacidad:54, autonomia:409 },
  { grupo:'Model 3', id:'mod3-2018-perf', label:'Model 3 Performance (2018–2020)', capacidad:75, autonomia:530 },
  { grupo:'Model 3', id:'mod3-2021-sr', label:'Model 3 Standard Range Plus (2021)', capacidad:55, autonomia:448 },
  { grupo:'Model 3', id:'mod3-2021-lr', label:'Model 3 Long Range (2021–2023)', capacidad:82, autonomia:614 },
  { grupo:'Model 3', id:'mod3-2021-perf', label:'Model 3 Performance (2021–2023)', capacidad:82, autonomia:547 },
  { grupo:'Model 3', id:'mod3-2023-rwd', label:'Model 3 "Highland" Propulsión Trasera (2023– )', capacidad:60, autonomia:513 },
  { grupo:'Model 3', id:'mod3-2023-lr', label:'Model 3 "Highland" Long Range (2023– )', capacidad:75, autonomia:629 },
  { grupo:'Model 3', id:'mod3-2024-perf', label:'Model 3 "Highland" Performance (2024– )', capacidad:75, autonomia:528 },
  { grupo:'Model Y', id:'mody-2020-lr', label:'Model Y Long Range (2020–2022)', capacidad:75, autonomia:505 },
  { grupo:'Model Y', id:'mody-2020-perf', label:'Model Y Performance (2020–2022)', capacidad:75, autonomia:480 },
  { grupo:'Model Y', id:'mody-2022-rwd', label:'Model Y Propulsión Trasera (2022– )', capacidad:60, autonomia:455 },
  { grupo:'Model Y', id:'mody-2022-lr', label:'Model Y Tracción Total / Long Range (2022– )', capacidad:75, autonomia:533 },
  { grupo:'Model Y', id:'mody-2022-perf', label:'Model Y Performance (2022–2024)', capacidad:75, autonomia:514 },
  { grupo:'Model Y', id:'mody-2025-rwd', label:'Model Y "Juniper" Propulsión Trasera (2025– )', capacidad:62.5, autonomia:534 },
  { grupo:'Model Y', id:'mody-2025-lr', label:'Model Y "Juniper" Tracción Total / Long Range (2025– )', capacidad:75, autonomia:586 },
  { grupo:'Model Y', id:'mody-2025-perf', label:'Model Y "Juniper" Performance (2025– )', capacidad:75, autonomia:555 },
  { grupo:'Cybertruck', id:'cbt-2024-awd', label:'Cybertruck All-Wheel Drive (2024– )', capacidad:123, autonomia:515 },
  { grupo:'Cybertruck', id:'cbt-2024-beast', label:'Cybertruck Cyberbeast (2024– )', capacidad:123, autonomia:463 },
  { grupo:'Roadster', id:'rdst-2008', label:'Roadster (2008–2012)', capacidad:53, autonomia:393 }
]; // Valores aproximados de referencia (capacidad nominal y autonomía WLTP); siempre editables a mano tras elegir.

function poblarSelectorModelos(){
  var sel = document.getElementById('veh-modelo-select');
  if(!sel || sel.options.length) return; // ya poblado
  var html = '<option value="">— Elegir tu modelo exacto —</option>';
  var grupoActual = null;
  TESLA_MODELOS.forEach(function(m){
    if(m.grupo !== grupoActual){
      if(grupoActual !== null) html += '</optgroup>';
      html += '<optgroup label="'+esc(m.grupo)+'">';
      grupoActual = m.grupo;
    }
    html += '<option value="'+m.id+'">'+esc(m.label)+'</option>';
  });
  html += '</optgroup>';
  sel.innerHTML = html;
}
document.getElementById('veh-modelo-select').addEventListener('change', function(){
  var m = TESLA_MODELOS.find(function(x){ return x.id===this.value; }, this);
  this.value = '';
  if(!m) return;
  document.getElementById('veh-modelo').value = m.label;
  document.getElementById('veh-capacidad').value = m.capacidad;
  document.getElementById('veh-autonomia').value = m.autonomia;
  guardarCambiosVehiculo();
  toast('Modelo aplicado: batería '+m.capacidad+' kWh · autonomía '+m.autonomia+' km');
});

/* ---------- Conexión Tesla (OAuth vía backend propio) ---------- */
// Client ID: dato público de la app "MiEV" ya registrada ante Tesla, no es secreto.
var TESLA_CONFIG_POR_DEFECTO = { clientId:'3b8ae070-eec0-4768-8838-edbd897f869d', backendUrl:'https://api.laperestronika.com' };
function cargarConfigTesla(){
  try{ var raw=JSON.parse(localStorage.getItem('mitesla-tesla-config'))||{};
    return {clientId:raw.clientId||'',backendUrl:raw.backendUrl||'',sessionToken:sessionStorage.getItem('mitesla-session:'+String(raw.backendUrl||'').replace(/\/$/,''))||''};
  }catch(e){return {};}
}
function guardarConfigTesla(cfg){
 localStorage.setItem('mitesla-tesla-config',JSON.stringify({clientId:cfg.clientId||'',backendUrl:cfg.backendUrl||''}));
 var key='mitesla-session:'+String(cfg.backendUrl||'').replace(/\/$/,'');
 if(cfg.sessionToken)sessionStorage.setItem(key,cfg.sessionToken);else sessionStorage.removeItem(key);
}

var TESLA_ERRORES = {
  not_connected: 'No hay ninguna sesión de Tesla activa. Pulsa "Conectar con Tesla".',
  tesla_auth_failed: 'Tesla ha rechazado la sesión — puede que haya que reconectar.',
  tesla_scope_missing: 'Faltan permisos concedidos en Tesla para leer estos datos.',
  tesla_rate_limited: 'Tesla está limitando las peticiones ahora mismo — se ha usado el último dato disponible.',
  tesla_unavailable: 'Tesla no responde ahora mismo. Se reintentará más tarde.',
  not_found: 'El coche no aparece en tu cuenta de Tesla.',
  sin_vehiculos: 'No hay ningún vehículo en tu cuenta de Tesla.',
  unauthorized: 'La token de sesión del backend no es correcta.',
  config_incompleta: 'Falta configuración en el backend (revisa las variables de entorno en Cloudflare).',
  respuesta_invalida: 'Tesla ha devuelto una respuesta que no se pudo interpretar.'
};

var CACHE_TESLA_TTL_MS = 45000; // evita golpear el backend/coche en cada visita a Ajustes
// Fase 3, punto 3: además del snapshot en sí, se registra cuándo se intentó la última consulta,
// cuándo fue el último éxito y cuál fue el último error — para poder mostrarlo en Ajustes y para
// que un fallo puntual no borre el último dato bueno conocido (se conserva hasta el siguiente éxito).
var teslaCache = { en:0, estado:null, vehiculo:null, snapshot:null, last_fetch:null, last_success:null, last_error:null, enCurso:null };

/* ---------- Fase 3, punto 1: adaptador estable de datos Tesla ----------
 * Transforma la respuesta cruda de Tesla (r.body.response de /vehiculo) en un modelo interno
 * estable (VehicleSnapshot) del que sí pueden depender las vistas, en vez de que cada sitio que
 * necesite un dato del coche tenga que conocer la forma exacta del JSON de Tesla. Un campo que
 * Tesla no ha devuelto queda en null — nunca se inventa un 0 (punto 34: null ≠ 0).
 * NOTA: mapeo construido contra la documentación pública de la Fleet API de Tesla; no se ha
 * podido probar contra una cuenta Tesla real en este entorno (no hay ningún vehículo disponible
 * para probar), así que los nombres de campo están verificados por documentación, no por una
 * respuesta real observada — queda marcado como tal en el informe final. */
function mapearSnapshotTesla(raw, fetchedAtISO){
  if(!raw || typeof raw!=='object') return null;
  var cs = raw.charge_state || {};
  var ds = raw.drive_state || {};
  var vs = raw.vehicle_state || {};
  var clima = raw.climate_state || {};
  // Tesla devuelve distancias en las unidades configuradas en la cuenta del usuario (gui_settings).
  // Solo se convierte de millas a km cuando consta explícitamente que la cuenta está en millas;
  // si no consta, se deja tal cual antes que arriesgarse a una conversión equivocada.
  var enMillas = !!(raw.gui_settings && raw.gui_settings.gui_distance_units === 'mi/hr');
  function distKm(v){
    if(typeof v!=='number' || !isFinite(v)) return null;
    return Math.round((enMillas ? v*1.60934 : v) * 10) / 10;
  }
  function num(v){ return (typeof v==='number' && isFinite(v)) ? v : null; }
  return {
    vin: raw.vin || null,
    fetched_at: fetchedAtISO,
    online_state: raw.state || null, // 'online' | 'asleep' | 'offline'
    soc: num(cs.battery_level),
    estimated_range: distKm(cs.battery_range),
    odometer: distKm(vs.odometer),
    charging_state: cs.charging_state || null, // 'Charging' | 'Complete' | 'Disconnected' | 'Stopped' | ...
    charging_power: num(cs.charger_power),
    charge_energy_added: num(cs.charge_energy_added),
    minutes_to_full: num(cs.minutes_to_full_charge),
    charge_limit: num(cs.charge_limit_soc),
    shift_state: ds.shift_state || null, // 'P' | 'R' | 'N' | 'D' | null
    latitude: num(ds.latitude),
    longitude: num(ds.longitude),
    outside_temp: num(clima.outside_temp),
    inside_temp: num(clima.inside_temp),
    locked: typeof vs.locked==='boolean' ? vs.locked : null,
    sentry: typeof vs.sentry_mode==='boolean' ? vs.sentry_mode : null,
    software_version: vs.car_version || null,
    source: 'tesla'
  };
}

/* ---------- Fase 3, punto 5: odómetro Tesla ----------
 * Cuando llega un odómetro válido desde Tesla se usa para mantener actualizado el odómetro local
 * (DATOS.vehiculo.odometro_km), que hasta ahora solo se actualizaba a mano. Reglas:
 *  - nunca se reduce el odómetro por una respuesta vieja/fuera de orden (se ignora si es menor
 *    que el valor ya guardado);
 *  - un salto grande (>500 km desde la última lectura Tesla) se marca como anomalía en vez de
 *    aplicarse a ciegas — puede ser un cambio de coche, un error de la API, o un vehículo
 *    equivocado tras cambiar de VIN;
 *  - se guarda un historial acotado (últimas 50 lecturas) de los cambios de odómetro con origen
 *    Tesla, para poder auditar la evolución sin hacerlo crecer sin límite. */
var ODOMETRO_TESLA_SALTO_SOSPECHOSO_KM = 500;
function sincronizarOdometroTesla(snap){
  if(!snap || snap.odometer===null || typeof snap.odometer!=='number') return;
  var v = DATOS.vehiculo;
  var anterior = (typeof v.odometro_km==='number') ? v.odometro_km : null;
  if(anterior!==null && snap.odometer < anterior) return; // nunca reducir por una lectura vieja/desordenada
  var salto = (anterior!==null) ? (snap.odometer - anterior) : 0;
  var esAnomalia = salto > ODOMETRO_TESLA_SALTO_SOSPECHOSO_KM;
  if(!v.odometro_historico_tesla) v.odometro_historico_tesla = [];
  v.odometro_historico_tesla.push({ km: snap.odometer, fecha: snap.fetched_at, salto_km: Math.round(salto*10)/10, anomalia: esAnomalia });
  if(v.odometro_historico_tesla.length > 50) v.odometro_historico_tesla = v.odometro_historico_tesla.slice(-50);
  if(esAnomalia){
    v.odometro_tesla_anomalia = { km_anterior: anterior, km_nuevo: snap.odometer, fecha: snap.fetched_at };
    if(typeof toast==='function') toast('Aviso: el odómetro de Tesla ha saltado '+Math.round(salto)+' km de golpe — revisa el vehículo seleccionado antes de confiar en el dato.', true);
    return; // no se aplica automáticamente un salto sospechoso; queda registrado para revisión manual
  }
  v.odometro_km = snap.odometer;
  v.odometro_tesla_actualizado_at = snap.fetched_at;
  v.odometro_tesla_anomalia = null;
  v.updated_at = ahoraISO();
}

/* ---------- Fase 3, punto 2: Dashboard "Ahora" con datos Tesla en vivo ----------
 * Si hay un snapshot Tesla útil (SoC conocido), sustituye en el hero del dashboard el cálculo
 * derivado de los registros manuales por el dato en vivo, con su fuente y antigüedad visibles.
 * Si no hay snapshot (Tesla no configurado, o todavía sin ninguna consulta con éxito), no toca
 * nada: el dashboard se comporta exactamente como antes de la Fase 3, calculado a partir de
 * viajes/cargas/batería registrados a mano. */
function aplicarSnapshotTeslaEnDashboard(){
  var snap = teslaCache.snapshot;
  var fuenteFila = document.getElementById('dash-fuente-dato');
  var fuenteTxt = document.getElementById('dash-fuente-texto');
  if(!snap || snap.soc===null){
    if(fuenteFila) fuenteFila.style.display = 'none';
    return;
  }
  document.getElementById('dash-bateria-num').innerHTML = Math.round(snap.soc) + '<span>%</span>';
  document.getElementById('dash-barra').style.width = Math.round(snap.soc) + '%';
  if(snap.estimated_range !== null){
    document.getElementById('dash-autonomia').textContent = Math.round(snap.estimated_range).toLocaleString('es-ES') + ' km';
  }
  document.getElementById('dash-ultima-act').textContent = tiempoRelativo(snap.fetched_at);

  var estadoTxt, pillClave;
  if(snap.charging_state === 'Charging'){ estadoTxt = 'Cargando'; pillClave = 'cargando'; }
  else if(snap.shift_state && snap.shift_state !== 'P'){ estadoTxt = 'En marcha'; pillClave = 'conduciendo'; }
  else if(snap.online_state === 'asleep'){ estadoTxt = 'Aparcado · coche dormido'; pillClave = 'aparcado'; }
  else { estadoTxt = 'Aparcado'; pillClave = 'aparcado'; }
  document.getElementById('dash-estado').textContent = estadoTxt;
  document.getElementById('pill-texto').textContent = estadoTxt;
  document.getElementById('pill-estado').className = 'pill p-'+pillClave;

  if(fuenteFila){
    fuenteFila.style.display = '';
    fuenteTxt.textContent = 'Tesla · ' + tiempoRelativo(snap.fetched_at);
  }
}
document.getElementById('dash-fuente-actualizar').addEventListener('click', function(){
  var cfg = cargarConfigTesla();
  if(cfg.backendUrl && cfg.sessionToken) fetchTeslaVehicle(cfg, true);
});

function teslaHeaders(cfg){ return { 'Authorization': 'Bearer ' + (cfg.sessionToken||'') }; }

async function teslaFetch(cfg, ruta, opciones){
  opciones = opciones || {};
  opciones.headers = Object.assign({}, opciones.headers||{}, teslaHeaders(cfg));
  var res = await fetch(cfg.backendUrl + ruta, opciones);
  var body = null;
  try{ body = await res.json(); }catch(e){}
  return { ok: res.ok, status: res.status, body: body };
}

function pintarEstadoTesla(texto, sub, estadoDot, accionesVisibles){
  document.getElementById('tesla-estado').textContent = texto;
  document.getElementById('tesla-estado-sub').textContent = sub || '';
  var dot = document.getElementById('tesla-estado-dot');
  if(dot) dot.className = 'epunto ' + estadoDot;
  document.getElementById('tesla-acciones').style.display = accionesVisibles ? 'flex' : 'none';
}

async function getTeslaConnectionStatus(forzar){
  var cfg = cargarConfigTesla();
  if(!cfg.backendUrl || !cfg.sessionToken){
    pintarEstadoTesla('Sin Tesla conectado', 'Puedes utilizar Mi Tesla sin vehículo vinculado.', 'off', false);
    document.getElementById('tesla-selector-vehiculo').style.display = 'none';
    return null;
  }
  if(!forzar && teslaCache.estado && (Date.now()-teslaCache.en) < CACHE_TESLA_TTL_MS){
    return teslaCache.estado;
  }
  pintarEstadoTesla('Comprobando conexión…', '', 'busy', false);
  try{
    var r = await teslaFetch(cfg, '/estado');
    if(!r.ok){
      pintarEstadoTesla(TESLA_ERRORES[r.body && r.body.error] || 'No se pudo comprobar el estado.', '', 'err', false);
      return null;
    }
    teslaCache.en = Date.now();
    teslaCache.estado = r.body;
    if(r.body.conectado){
      await fetchTeslaVehicle(cfg, forzar);
    } else {
      pintarEstadoTesla('Sin Tesla conectado', 'Sin vehículo vinculado. Conecta Tesla cuando tengas el coche.', 'off', false);
      document.getElementById('tesla-selector-vehiculo').style.display = 'none';
    }
    return r.body;
  }catch(e){
    pintarEstadoTesla('Sin conexión con el backend.', '', 'err', false);
    return null;
  }
}

async function fetchTeslaVehicle(cfg, forzar){
  if(!forzar && teslaCache.vehiculo && (Date.now()-teslaCache.en) < CACHE_TESLA_TTL_MS){
    return teslaCache.vehiculo;
  }
  // Punto 3: evita llamadas simultáneas — si ya hay una petición en curso, todo el mundo espera
  // a esa misma promesa en vez de disparar otra petición en paralelo al backend/coche.
  if(teslaCache.enCurso) return teslaCache.enCurso;
  var promesa = (async function(){
  teslaCache.last_fetch = ahoraISO();
  try{
    var r = await teslaFetch(cfg, '/vehiculo');
    if(r.status === 300 && r.body && r.body.vehiculos){
      pintarEstadoTesla('Conectado', 'Elige qué vehículo usar.', 'pend', true);
      mostrarSelectorVehiculoTesla(cfg, r.body.vehiculos);
      return null;
    }
    document.getElementById('tesla-selector-vehiculo').style.display = 'none';
    if(!r.ok){
      teslaCache.last_error = (TESLA_ERRORES[r.body && r.body.error] || 'No se pudieron leer los datos del coche.');
      pintarEstadoTesla('Conectado', teslaCache.last_error, 'pend', true);
      return null; // se conserva teslaCache.snapshot anterior: un fallo puntual no borra el último dato bueno
    }
    teslaCache.vehiculo = r.body;
    var v = (r.body && r.body.response) || {};
    teslaCache.snapshot = mapearSnapshotTesla(v, teslaCache.last_fetch);
    teslaCache.last_success = teslaCache.last_fetch;
    teslaCache.last_error = null;
    sincronizarOdometroTesla(teslaCache.snapshot);
    // Fase 3, punto 4 (preparación multi-vehículo): se etiqueta el vehículo local con el VIN Tesla
    // seleccionado. Las cargas/viajes registrados a mano ya llevan vehicle_id (ver abrirFormCarga/
    // form-carga), pero separar estadísticas por vehículo en TODAS las vistas es un cambio de
    // modelo de datos mayor que queda fuera de este bloque — ver informe final (DISEÑADO/PENDIENTE).
    if(teslaCache.snapshot && teslaCache.snapshot.vin && DATOS.vehiculo.tesla_vin !== teslaCache.snapshot.vin){
      DATOS.vehiculo.tesla_vin = teslaCache.snapshot.vin;
      guardarDatos(true);
    }
    var nombre = v.vehicle_state && v.vehicle_state.vehicle_name || v.display_name || DATOS.vehiculo.modelo || 'Tesla';
    var vinMasc = teslaCache.estado && teslaCache.estado.vin_seleccionado ? ' · VIN '+teslaCache.estado.vin_seleccionado : '';
    var actualizado = new Date().toLocaleTimeString('es-ES');
    // Punto 18: un coche "dormido" no es un error — la API de Tesla responde bien pero con datos
    // limitados/desactualizados porque el coche está en reposo. Se distingue de "Conectado" normal
    // en vez de mostrarse como si los datos fueran una lectura en vivo.
    if(v.state === 'asleep'){
      pintarEstadoTesla('Conectado — '+nombre, 'El coche está dormido; los datos son de la última vez que estuvo despierto ('+actualizado+')'+vinMasc, 'pend', true);
    } else if(v.state === 'offline'){
      pintarEstadoTesla('Conectado — '+nombre, 'El coche aparece desconectado de la red ahora mismo. Datos de la última conexión.'+vinMasc, 'pend', true);
    } else {
      pintarEstadoTesla('Conectado — '+nombre, 'Actualizado a las '+actualizado+vinMasc, 'ok', true);
    }
    if(typeof renderDashboard==='function') renderDashboard(); // refleja el snapshot nuevo en el dashboard sin esperar a que el usuario recargue
    return r.body;
  }catch(e){
    teslaCache.last_error = 'No se pudo contactar con el backend para leer el coche.';
    pintarEstadoTesla('Conectado', teslaCache.last_error, 'err', true);
    return null;
  } finally {
    teslaCache.enCurso = null;
  }
  })();
  teslaCache.enCurso = promesa;
  return promesa;
}

function mostrarSelectorVehiculoTesla(cfg, vehiculos){
  var cont = document.getElementById('tesla-selector-vehiculo');
  cont.style.display = '';
  cont.innerHTML = '<div class="lista"><div style="padding:14px 16px" class="form-grid">'+
    '<div class="t1" style="margin-bottom:8px">Tienes varios vehículos en tu cuenta Tesla — elige cuál usar en Mi Tesla:</div>'+
    vehiculos.map(function(v){ return '<button type="button" class="btn-secundario" data-vin="'+esc(v.vin)+'" style="margin:0 8px 8px 0">'+esc(v.nombre)+'</button>'; }).join('')+
    '</div></div>';
  cont.querySelectorAll('[data-vin]').forEach(function(b){
    b.addEventListener('click', async function(){
      await teslaFetch(cfg, '/seleccionar-vehiculo', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ vin:b.dataset.vin }) });
      toast('Vehículo seleccionado');
      teslaCache.en = 0;
      getTeslaConnectionStatus(true);
    });
  });
}

async function selectTeslaVehicle(vin){
  var cfg = cargarConfigTesla();
  return teslaFetch(cfg, '/seleccionar-vehiculo', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ vin:vin }) });
}

async function connectTesla(){
  var cfg = cargarConfigTesla();
  if(!cfg.clientId || !cfg.backendUrl || !cfg.sessionToken){
    pintarEstadoTesla('Falta el Client ID, la URL del backend o la token de sesión.', '', 'err', false);
    return;
  }
  // FASE A (A11, auditoría externa 2026-09-20): el token de sesión no viaja en la URL de
  // navegación (quedaba en el historial del navegador y en logs de acceso del backend). Primero
  // se pide un token de un solo uso y corta vida por una petición autenticada normal (cabecera
  // Authorization), y solo ESE token va en la URL a la que se navega.
  try{
    var r = await teslaFetch(cfg, '/oauth/start-token', { method:'POST' });
    if(!r.ok || !r.body || !r.body.token){
      pintarEstadoTesla('No se pudo iniciar la conexión con Tesla (token de un solo uso).', '', 'err', false);
      return;
    }
    // El state OAuth se genera y valida en el backend (Web Crypto), no aquí.
    window.location.href = cfg.backendUrl + '/oauth/start?token=' + encodeURIComponent(r.body.token);
  }catch(e){
    pintarEstadoTesla('No se pudo contactar con el backend para iniciar la conexión.', '', 'err', false);
  }
}

async function disconnectTesla(){
  var cfg = cargarConfigTesla();
  if(!cfg.backendUrl || !cfg.sessionToken) return;
  confirmarAccion('Desconectar Tesla', 'Se olvidará la sesión guardada en el backend. Podrás volver a conectar cuando quieras.', async function(){
    try{
      await teslaFetch(cfg, '/desconectar', { method:'POST' });
      teslaCache = { en:0, estado:null, vehiculo:null, snapshot:null, last_fetch:null, last_success:null, last_error:null, enCurso:null };
      toast('Tesla desconectado');
      getTeslaConnectionStatus(true);
    }catch(e){ toast('No se pudo desconectar — inténtalo de nuevo'); }
  }, 'Desconectar', true);
}

// Alta propia: ADMIN_TOKEN se usa solo durante bootstrap y nunca se persiste.
function configSesionFormulario(){
  var backend=document.getElementById('tesla-backend-url').value.trim().replace(/\/$/,'');
  var url=new URL(backend);
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.pathname!=='/') throw Error('Usa una URL HTTPS del backend sin ruta.');
  return {backendUrl:backend,clientId:document.getElementById('tesla-client-id').value.trim(),sessionToken:document.getElementById('tesla-session-token').value.trim()};
}
async function crearSesionMiTesla(){
  var input=document.getElementById('mitesla-bootstrap-key'), key=input.value;
  input.value='';
  var status=document.getElementById('mitesla-session-status');
  var button=document.getElementById('mitesla-session-create');button.disabled=true;
  try{
    var cfg=configSesionFormulario();
    if(!key) throw Error('Introduce la clave de alta Mi Tesla. No uses credenciales Tesla.');
    var res=await fetch(cfg.backendUrl+'/auth/bootstrap',{method:'POST',cache:'no-store',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({device_label:'Mi Tesla navegador'})});
    key='';
    var body=await res.json();
    if(!res.ok || !/^[A-Za-z0-9_-]{43}$/.test(body.session_token||'')) throw Error('No se pudo crear la sesión Mi Tesla. Revisa la clave de alta y el backend.');
    cfg.sessionToken=body.session_token;guardarConfigTesla(cfg);
    document.getElementById('tesla-session-token').value=cfg.sessionToken;
    status.textContent='Sesión Mi Tesla activa. No necesitas conectar Tesla para usar la app.';
  }catch(e){status.textContent=e.message;}
  finally{key='';input.value='';button.disabled=false;}
}
async function cerrarSesionMiTesla(){
  var cfg=cargarConfigTesla(), status=document.getElementById('mitesla-session-status');
  try{
    if(cfg.sessionToken){var res=await teslaFetch(cfg,'/auth/session/revoke',{method:'POST'});if(!res.ok && res.status!==401)throw Error('No se pudo revocar la sesión. Reintenta antes de cerrar la pestaña.');}
    cfg.sessionToken='';guardarConfigTesla(cfg);document.getElementById('tesla-session-token').value='';
    status.textContent='Sesión Mi Tesla cerrada y revocada.';
  }catch(e){status.textContent=e.message;}
}
document.getElementById('mitesla-session-create').addEventListener('click',crearSesionMiTesla);
document.getElementById('mitesla-session-logout').addEventListener('click',cerrarSesionMiTesla);

document.getElementById('tesla-guardar-config').addEventListener('click', function(){
  var cfg = {
    clientId: document.getElementById('tesla-client-id').value.trim(),
    backendUrl: document.getElementById('tesla-backend-url').value.trim().replace(/\/$/,''),
    sessionToken: document.getElementById('tesla-session-token').value.trim()
  };
  guardarConfigTesla(cfg);
  teslaCache = { en:0, estado:null, vehiculo:null, snapshot:null, last_fetch:null, last_success:null, last_error:null, enCurso:null };
  toast('Configuración de Tesla guardada en este dispositivo');
  getTeslaConnectionStatus(true);
});

document.getElementById('tesla-conectar').addEventListener('click', function(){
  var cfg = {
    clientId: document.getElementById('tesla-client-id').value.trim(),
    backendUrl: document.getElementById('tesla-backend-url').value.trim().replace(/\/$/,''),
    sessionToken: document.getElementById('tesla-session-token').value.trim()
  };
  guardarConfigTesla(cfg);
  connectTesla();
});

document.getElementById('tesla-actualizar').addEventListener('click', function(){ getTeslaConnectionStatus(true); });
document.getElementById('tesla-desconectar').addEventListener('click', disconnectTesla);

/* ---------- Mapa real (Leaflet + OpenStreetMap, sin clave de API) ---------- */
// No se hardcodea ninguna ubicación real: "casa" solo existe si el usuario la fija en Ajustes,
// y los demás puntos del mapa salen de sus propios favoritos (DATOS.favoritos). Nada de esto va
// en el código fuente público de la app.
function lugarCasa(){
  var c = DATOS.vehiculo && DATOS.vehiculo.casa;
  return (c && typeof c.lat==='number' && typeof c.lng==='number') ? { nombre:'Casa', tipo:'casa', lat:c.lat, lng:c.lng, info:'Tu ubicación de casa' } : null;
}
function lugares(){
  // Los favoritos del usuario ya se pintan aparte con pintarFavoritosEnMapa(); aquí solo va "casa" si existe.
  var casa = lugarCasa();
  return casa ? [casa] : [];
}
// Alias de "casa" -> sus coordenadas, solo si el usuario la ha fijado. Los favoritos se resuelven
// aparte en coordDeLugar(). Sin casa configurada, no hay ningún alias.
function coordsLugarPorNombre(){
  var map = {};
  var casa = lugarCasa();
  if(casa){ map['casa'] = casa; }
  return map;
}
function normalizarTexto(t){
  return (t||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
}
/* Fecha/hora local en formato ISO (sin el desfase de toISOString, que usa UTC) */
function fechaLocalISO(conHora){
  var d = new Date();
  var off = d.getTimezoneOffset()*60000;
  var local = new Date(d.getTime()-off);
  return conHora ? local.toISOString().slice(0,16) : local.toISOString().slice(0,10);
}
function coordDeLugar(nombre){
  var clave = normalizarTexto(nombre);
  var conocidos = coordsLugarPorNombre();
  if(conocidos[clave]) return conocidos[clave];
  var fav = (DATOS.favoritos||[]).find(function(f){ return normalizarTexto(f.nombre)===clave; });
  if(fav) return { lat:fav.lat, lng:fav.lng, nombre:fav.nombre };
  return null;
}
var mapaLeaflet = null;
function renderLugares(){
  var cont = document.getElementById('lista-lugares');
  if(!cont) return;

  var cargasCasa = DATOS.cargas.filter(function(c){ return c.tipo==='domestica'; });
  var kwhCasa = cargasCasa.reduce(function(s,c){ return s+c.kwh; }, 0);

  var cargasSC = DATOS.cargas.filter(function(c){ return c.tipo==='supercharger'; });

  // destino más frecuente por número de viajes
  var conteoDestinos = {};
  DATOS.viajes.forEach(function(v){
    if(!conteoDestinos[v.destino]) conteoDestinos[v.destino] = { n:0, kmTotal:0 };
    conteoDestinos[v.destino].n++;
    conteoDestinos[v.destino].kmTotal += v.km;
  });
  var destinos = Object.keys(conteoDestinos).sort(function(a,b){ return conteoDestinos[b].n - conteoDestinos[a].n; });
  var destinoTop = destinos[0];

  var filas = [];
  if(cargasCasa.length){
    filas.push('<div class="fila">'+
      '<div class="ico" style="background:rgba(10,132,255,.12);color:var(--acc2)" data-icon="pin"></div>'+
      '<div class="fila-tx"><div class="t1">Casa</div><div class="t2">'+cargasCasa.length+' cargas · '+kwhCasa.toFixed(1)+' kWh</div></div>'+
      '<div class="fila-r"><div class="r1">'+cargasCasa.length+' cargas</div></div></div>');
  }
  if(cargasSC.length){
    filas.push('<div class="fila">'+
      '<div class="ico carga" data-icon="rayo"></div>'+
      '<div class="fila-tx"><div class="t1">Supercharger</div><div class="t2">Cargas rápidas registradas</div></div>'+
      '<div class="fila-r"><div class="r1">'+cargasSC.length+' cargas</div></div></div>');
  }
  if(destinoTop){
    filas.push('<div class="fila">'+
      '<div class="ico" style="background:rgba(232,52,42,.12);color:var(--acc)" data-icon="pin"></div>'+
      '<div class="fila-tx"><div class="t1">'+esc(destinoTop)+'</div><div class="t2">Destino más frecuente · '+conteoDestinos[destinoTop].n+' viajes</div></div>'+
      '<div class="fila-r"><div class="r1">'+(conteoDestinos[destinoTop].kmTotal/conteoDestinos[destinoTop].n).toFixed(1)+' km med.</div></div></div>');
  }
  (DATOS.favoritos||[]).forEach(function(f){
    filas.push('<div class="fila">'+
      '<div class="ico" style="background:rgba(142,68,236,.12);color:#8e44ec" data-icon="estrella"></div>'+
      '<div class="fila-tx"><div class="t1">'+esc(f.nombre)+'</div><div class="t2">Cargador favorito</div></div>'+
      '<button type="button" class="btn-borrar" data-quitar-favorito="'+f.id+'" data-icon="papelera" aria-label="Eliminar"></button></div>');
  });
  cont.innerHTML = filas.join('');
  aplicarIconos();
}
document.getElementById('lista-lugares').addEventListener('click', function(e){
  var btn = e.target.closest('[data-quitar-favorito]');
  if(!btn) return;
  marcarBorrado('favoritos', btn.dataset.quitarFavorito);
  DATOS.favoritos = DATOS.favoritos.filter(function(f){ return f.id!==btn.dataset.quitarFavorito; });
  guardarDatos();
  renderLugares();
  if(mapaLeaflet) pintarFavoritosEnMapa();
  toast('Quitado de favoritos');
});

var leafletCargando = null;
function cargarLeafletSiHaceFalta(){
  if(window.L) return Promise.resolve();
  if(leafletCargando) return leafletCargando;
  leafletCargando = new Promise(function(resolve, reject){
    // Autoalojado (punto 5 de la auditoría): sin dependencias JS remotas de un CDN externo,
    // compatible con una CSP con script-src 'self'.
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'vendor/leaflet/leaflet.css';
    document.head.appendChild(link);

    var script = document.createElement('script');
    script.src = 'vendor/leaflet/leaflet.js';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  }).catch(function(e){ leafletCargando = null; throw e; }); // permite reintentar si falló por falta de red
  return leafletCargando;
}

var mapaIniciando = false;
async function iniciarMapa(){
  if(mapaLeaflet || mapaIniciando || !document.getElementById('leaflet-map')) return;
  mapaIniciando = true; // guarda síncrona: evita crear el mapa dos veces si se cambia de pestaña dos veces seguidas antes de que cargue Leaflet
  var mapaEl = document.getElementById('leaflet-map');
  mapaEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--txt3);font-size:13px">Cargando mapa…</div>';
  try{
    await cargarLeafletSiHaceFalta();
  }catch(e){
    mapaEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--txt3);font-size:13px">No se pudo cargar el mapa. Revisa tu conexión.</div>';
    mapaIniciando = false;
    return;
  }
  mapaEl.innerHTML = '';

  var vistaInicial = lugarCasa();
  mapaLeaflet = vistaInicial
    ? L.map('leaflet-map', { zoomControl:false }).setView([vistaInicial.lat, vistaInicial.lng], 12)
    : L.map('leaflet-map', { zoomControl:false }).setView([40.4, -3.7], 6); // sin casa configurada: vista amplia de España, no identificable
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 18
  }).addTo(mapaLeaflet);

  var colores = { casa:'#0a84ff', supercharger:'#2fae60', destino:'#e8342a' };
  lugares().forEach(function(l){
    L.circleMarker([l.lat,l.lng], {
      radius:8, color:'#fff', weight:2, fillColor:colores[l.tipo], fillOpacity:1
    }).addTo(mapaLeaflet).bindPopup('<b>'+l.nombre+'</b><br>'+l.info);
  });

  dibujarRutas('mes');
  pintarFavoritosEnMapa();
  mapaLeaflet.invalidateSize();
}

var capaFavoritos = null;
function pintarFavoritosEnMapa(){
  if(capaFavoritos){ mapaLeaflet.removeLayer(capaFavoritos); capaFavoritos = null; }
  capaFavoritos = L.layerGroup();
  (DATOS.favoritos||[]).forEach(function(f){
    L.circleMarker([f.lat,f.lng], {
      radius:7, color:'#fff', weight:2, fillColor:'#8e44ec', fillOpacity:1
    }).bindPopup('<b>★ '+esc(f.nombre)+'</b><br>Cargador favorito').addTo(capaFavoritos);
  });
  capaFavoritos.addTo(mapaLeaflet);
}

/* ---------- Mis rutas: mapa de calor de viajes por periodo (estilo Strava) ---------- */
var capaRutas = null;
function dibujarRutas(periodo){
  if(capaRutas){ mapaLeaflet.removeLayer(capaRutas); capaRutas = null; }
  var estado = document.getElementById('rutas-estado');
  if(periodo === 'ninguno'){ estado.textContent = 'Rutas ocultas.'; return; }

  var ahora = new Date();
  var viajesPeriodo = DATOS.viajes.filter(function(v){
    var d = new Date(v.fecha);
    if(periodo==='semana') return (ahora-d) <= 7*24*3600*1000;
    if(periodo==='mes') return d.getFullYear()===ahora.getFullYear() && d.getMonth()===ahora.getMonth();
    if(periodo==='año') return d.getFullYear()===ahora.getFullYear();
    return true; // todo
  });

  var conteoTramos = {}; // para dar más intensidad a las rutas repetidas
  var trazables = [];
  viajesPeriodo.forEach(function(v){
    var o = coordDeLugar(v.origen), d = coordDeLugar(v.destino);
    if(!o || !d) return;
    var clave = [o.nombre, d.nombre].sort().join('|');
    conteoTramos[clave] = (conteoTramos[clave]||0) + 1;
    trazables.push({ o:o, d:d, clave:clave });
  });

  capaRutas = L.layerGroup();
  trazables.forEach(function(t){
    var veces = conteoTramos[t.clave];
    L.polyline([[t.o.lat,t.o.lng],[t.d.lat,t.d.lng]], {
      color:'#0a84ff', weight: Math.min(2+veces*1.5, 10), opacity: Math.min(0.18+veces*0.12, 0.85)
    }).addTo(capaRutas);
  });
  capaRutas.addTo(mapaLeaflet);

  var sinCoords = viajesPeriodo.length - trazables.length;
  estado.textContent = trazables.length+' de '+viajesPeriodo.length+' viajes trazados en el mapa'+
    (sinCoords>0 ? ' ('+sinCoords+' con lugares no reconocidos)' : '') + '.';
}
document.getElementById('filtros-rutas').addEventListener('click', function(e){
  var btn = e.target.closest('button[data-periodo]');
  if(!btn || !mapaLeaflet) return;
  document.querySelectorAll('#filtros-rutas button').forEach(function(b){ b.classList.toggle('on', b===btn); });
  dibujarRutas(btn.dataset.periodo);
});

/* ---------- Autonomía real (a partir del consumo medio de tus viajes, no solo WLTP) ---------- */
function autonomiaRealKm(){
  var s = statsViajes();
  var hist = DATOS.bateria_historico;
  var bateriaActual = hist.length ? hist[hist.length-1].capacidad_pct : ASSUMPTIONS.sohSinLecturasPct.valor; // sin lecturas: se asume batería nueva como referencia, no se inventa un desgaste
  var capacidadKwh = DATOS.vehiculo.capacidad_nominal_kwh * bateriaActual/100;
  var consumo = s.media>0 ? s.media : ASSUMPTIONS.consumoReferenciaKwh100km.valor; // referencia si aún no hay viajes
  return { km: Math.round(capacidadKwh/consumo*100), consumo: consumo, capacidadKwh: capacidadKwh, velRef: s.velMedia>0?s.velMedia:ASSUMPTIONS.velocidadReferenciaKmh.valor };
}
// Ajusta el consumo a otra velocidad media, por el peso creciente de la resistencia aerodinámica (estilo ABRP/Reve).
function consumoAVelocidad(consumoBase, velRef, velObjetivo){
  if(!velObjetivo || velObjetivo<=0) return consumoBase;
  var factor = Math.pow(velObjetivo/velRef, 2);
  factor = Math.max(ASSUMPTIONS.factorVelocidadMin.valor, Math.min(ASSUMPTIONS.factorVelocidadMax.valor, factor)); // límites razonables
  return consumoBase * factor;
}

/* ---------- Clima real y su efecto en la autonomía (estilo ABRP, con Open-Meteo, gratis y sin clave) ---------- */
var climaCargado = false;
var temperaturaCacheada = null;
function pintarTarjetaClima(temp){
  // Pérdida de autonomía por frío: aprox. lineal por debajo de 20°C, hasta ~25% a 0°C (guía habitual EV/ABRP).
  var perdidaPct = temp<ASSUMPTIONS.tempSinPerdidaC.valor ? Math.min(ASSUMPTIONS.perdidaMaxFrioPct.valor, (ASSUMPTIONS.tempSinPerdidaC.valor-temp)*ASSUMPTIONS.factorPerdidaFrioPorGrado.valor) : 0;
  var ar = autonomiaRealKm(); // recalculado siempre con la batería/consumo actuales, no cacheado
  var kmAjustado = Math.round(ar.km * (1-perdidaPct/100));
  var cont = document.getElementById('tarjeta-clima');
  if(!cont) return;
  cont.style.display = '';
  cont.innerHTML =
    '<div class="lbl">'+li('termometro')+'Hoy en tu zona: '+Math.round(temp)+' °C</div>'+
    '<div class="val">'+kmAjustado+' km<span style="font-size:14px;font-weight:600;color:var(--txt3)"> reales estimados</span></div>'+
    '<div class="sub">'+(perdidaPct>0 ? 'Autonomía de '+ar.km+' km ajustada un '+Math.round(perdidaPct)+' % por el frío' : 'Sin pérdida relevante por temperatura hoy')+'</div>';
  aplicarIconos();
}
function pintarErrorClima(){
  var cont = document.getElementById('tarjeta-clima');
  if(!cont) return;
  cont.style.display = '';
  cont.innerHTML =
    '<div class="lbl">'+li('termometro')+'Clima</div>'+
    '<div class="sub" style="margin-top:2px">No se pudo obtener la temperatura de tu zona ahora mismo.</div>'+
    '<button type="button" class="ver" id="btn-reintentar-clima" style="margin-top:6px;padding-left:0">Reintentar</button>';
  var btn = document.getElementById('btn-reintentar-clima');
  if(btn) btn.addEventListener('click', function(){ cargarClimaYAjustarAutonomia(); });
  aplicarIconos();
}
async function cargarClimaYAjustarAutonomia(){
  if(climaCargado){ if(temperaturaCacheada!=null) pintarTarjetaClima(temperaturaCacheada); return; }
  var casa = lugarCasa();
  if(!casa){ var cont = document.getElementById('tarjeta-clima'); if(cont) cont.style.display = 'none'; return; } // sin casa configurada no se pide el clima (evita mandar cualquier ubicación a terceros)
  climaCargado = true;
  // Punto 18 de la auditoría: la tarjeta nunca debe quedarse simplemente oculta/en blanco si algo
  // falla — se muestra un estado de "cargando" explícito y, si falla, un error visible con reintento.
  var cont = document.getElementById('tarjeta-clima');
  if(cont){ cont.style.display = ''; cont.innerHTML = '<div class="lbl">'+li('termometro')+'Cargando el clima de tu zona…</div>'; }
  try{
    var url = 'https://api.open-meteo.com/v1/forecast?latitude='+casa.lat+'&longitude='+casa.lng+
      '&current=temperature_2m&timezone=Europe%2FMadrid';
    var res = await fetch(url);
    if(!res.ok) throw new Error('HTTP '+res.status);
    var json = await res.json();
    var temp = json.current && json.current.temperature_2m;
    if(typeof temp !== 'number') throw new Error('respuesta sin temperatura');
    temperaturaCacheada = temp;
    pintarTarjetaClima(temp);
  }catch(e){
    climaCargado = false; // permitir reintentar (automáticamente la próxima vez que se entre al dashboard, o con el botón "Reintentar")
    pintarErrorClima();
  }
}

/* ---------- Círculo de alcance (estilo ABRP) ---------- */
var capaAlcance = null;
document.getElementById('btn-alcance').addEventListener('click', function(){
  var btn = this;
  if(!mapaLeaflet) return; // el mapa todavía está cargando
  if(capaAlcance){
    mapaLeaflet.removeLayer(capaAlcance);
    capaAlcance = null;
    btn.classList.remove('on');
    return;
  }
  var ar = autonomiaRealKm();
  var cargaActual = nivelCargaActual();
  if(cargaActual === null){ toast('Registra primero un viaje o una carga con % de batería.', true); return; }
  var kmActual = Math.round(ar.km * cargaActual/100);
  var margen = kmActual * 0.85; // margen de seguridad del 15%, como recomienda ABRP
  var casa = lugarCasa();
  if(!casa){ toast('Configura tu ubicación de casa en Ajustes para ver el círculo de alcance.', true); return; }
  capaAlcance = L.layerGroup([
    L.circle([casa.lat, casa.lng], { radius: margen*1000, color:'#0a84ff', weight:2, fillColor:'#0a84ff', fillOpacity:.08, dashArray:'6 6' })
      .bindPopup('<b>Alcance con margen de seguridad</b><br>'+Math.round(margen)+' km, a tu consumo medio real ('+ar.consumo.toFixed(1)+' kWh/100km)'),
    L.circle([casa.lat, casa.lng], { radius: kmActual*1000, color:'#0a84ff', weight:1, fillColor:'#0a84ff', fillOpacity:.04, dashArray:'2 6' })
      .bindPopup('<b>Alcance con tu carga actual</b><br>'+kmActual+' km al '+cargaActual+' % de batería, sin margen'),
    L.circle([casa.lat, casa.lng], { radius: ar.km*1000, color:'#2fae60', weight:1, fillColor:'#2fae60', fillOpacity:.05, dashArray:'2 6' })
      .bindPopup('<b>Alcance teórico al 100%</b><br>'+ar.km+' km sin margen')
  ]).addTo(mapaLeaflet);
  btn.classList.add('on');
  mapaLeaflet.fitBounds(capaAlcance.getLayers()[2].getBounds());
});

/* ---------- Fase 3, punto 11: abstracción de proveedor de rutas (RouteProvider) ----------
 * Interfaz estable para pedir una ruta real: { distancia_km, duracion_min, geometria, desnivel_m }.
 * Implementación con OSRM (servicio público y sin clave: router.project-osrm.org) — se elige por
 * no requerir ninguna clave de API para que la función se pueda probar en este entorno, pero la
 * app no queda atada a él: cualquier otro proveedor solo tiene que devolver la misma forma. OSRM
 * no da desnivel, así que desnivel_m queda en null (no se inventa). Si la petición falla (sin red,
 * servicio caído, límite de uso del servidor público), se lanza un error y quien llama debe usar
 * el cálculo manual existente como respaldo — nunca se bloquea la calculadora "¿Llego?" por esto. */
var RouteProviderOSRM = {
  nombre: 'OSRM (público, sin clave)',
  async obtenerRuta(origen, destino){
    var url = 'https://router.project-osrm.org/route/v1/driving/'+origen.lng+','+origen.lat+';'+destino.lng+','+destino.lat+'?overview=false';
    var res = await fetch(url);
    if(!res.ok) throw new Error('OSRM HTTP '+res.status);
    var json = await res.json();
    var ruta = json.routes && json.routes[0];
    if(!ruta) throw new Error('OSRM no encontró ruta');
    return {
      distancia_km: Math.round(ruta.distance/100)/10,
      duracion_min: Math.round(ruta.duration/60),
      geometria: null, // no se pide geometría completa (overview=false) para minimizar datos transferidos; no hace falta para "¿Llego?"
      desnivel_m: null, // OSRM no proporciona desnivel
      source: 'osrm'
    };
  }
};
/** Busca un favorito (o "casa") por nombre normalizado — usado para resolver el destino
 *  escrito a mano en "¿Llego?" a unas coordenadas reales, sin necesitar geocodificación. */
function buscarLugarPorNombre(nombre){
  var n = normalizarTexto(nombre||'');
  if(!n) return null;
  if(n==='casa' || n==='home'){ var c = lugarCasa(); return c ? { lat:c.lat, lng:c.lng, nombre:'Casa' } : null; }
  var fav = (DATOS.favoritos||[]).find(function(f){ return normalizarTexto(f.nombre)===n; });
  return fav ? { lat:fav.lat, lng:fav.lng, nombre:fav.nombre } : null;
}

/* ---------- Calculadora "¿Llego?" (estilo ABRP, con respaldo manual siempre disponible) ---------- */
document.getElementById('llego-calcular').addEventListener('click', async function(){
  var km = parseFloat(document.getElementById('llego-km').value);
  var cont = document.getElementById('llego-resultado');
  var origenReal = 'A', duracionRutaMin = null, desnivelM = null, fuenteDistancia = 'Distancia introducida a mano';

  // Punto 11: si el flag está activo y hay casa + un favorito que coincide con el destino escrito,
  // se intenta obtener la distancia real por carretera. Si falla por lo que sea, se seguirá usando
  // el km introducido a mano — la calculadora nunca se queda bloqueada por esto.
  if(featureActiva('advanced_routing') && document.getElementById('llego-usar-ruta-real').checked){
    var casaPt = lugarCasa();
    var destinoPt = buscarLugarPorNombre(document.getElementById('llego-destino').value);
    if(casaPt && destinoPt){
      try{
        var ruta = await RouteProviderOSRM.obtenerRuta(casaPt, destinoPt);
        km = ruta.distancia_km;
        duracionRutaMin = ruta.duracion_min;
        desnivelM = ruta.desnivel_m;
        fuenteDistancia = 'Ruta real por carretera (' + RouteProviderOSRM.nombre + ')';
        document.getElementById('llego-km').value = km;
      }catch(e){
        toast('No se pudo calcular la ruta real ahora mismo — se usa el km introducido a mano.', true);
      }
    } else {
      toast('No se encontró un favorito (o "Casa") con ese nombre de destino — se usa el km a mano.');
    }
  }

  if(!km || km<=0){ toast('Indica la distancia en km.', true); return; }

  var hist = DATOS.bateria_historico;
  var soh = hist.length ? hist[hist.length-1].capacidad_pct : ASSUMPTIONS.sohSinLecturasPct.valor; // salud de la batería (degradación); sin lecturas se asume batería nueva, no se inventa desgaste
  var cargaActual = nivelCargaActual(); // nivel de carga actual (%), este sí es el punto de partida del viaje
  if(cargaActual === null){ toast('Registra primero un viaje o una carga con % de batería para poder calcularlo.', true); return; }
  var nominal = DATOS.vehiculo.capacidad_nominal_kwh;
  var capacidadKwh = nominal*soh/100; // capacidad real utilizable teniendo en cuenta la degradación
  var ar = autonomiaRealKm();
  var velocidad = parseFloat(document.getElementById('llego-velocidad').value);
  var consumoUsado = consumoAVelocidad(ar.consumo, ar.velRef, velocidad);
  // Punto 12: penalización por frío, reutilizando el mismo modelo ya usado en la tarjeta de clima
  // del Dashboard (misma curva/ASSUMPTIONS) — solo se aplica si hay una temperatura ya consultada;
  // sin ella no se inventa ninguna corrección.
  var factoresUsados = [velocidad ? 'velocidad ajustada a '+velocidad+' km/h' : 'tu consumo medio real'];
  if(temperaturaCacheada!=null){
    var perdidaFrioPct = temperaturaCacheada<ASSUMPTIONS.tempSinPerdidaC.valor
      ? Math.min(ASSUMPTIONS.perdidaMaxFrioPct.valor, (ASSUMPTIONS.tempSinPerdidaC.valor-temperaturaCacheada)*ASSUMPTIONS.factorPerdidaFrioPorGrado.valor) : 0;
    if(perdidaFrioPct>0){ consumoUsado = consumoUsado * (1+perdidaFrioPct/100); factoresUsados.push('frío ('+Math.round(temperaturaCacheada)+' °C, +'+Math.round(perdidaFrioPct)+ '% consumo)'); }
  }
  if(soh<100) factoresUsados.push('degradación de batería (SoH '+soh+' %)');
  if(desnivelM!=null) factoresUsados.push('desnivel de la ruta');
  factoresUsados.push('reserva de llegada del '+ASSUMPTIONS.reservaLlegadaPct.valor+' %');
  var kwhNecesario = km/100*consumoUsado;
  var energiaUsableInicial = capacidadKwh * (cargaActual-ASSUMPTIONS.reservaLlegadaPct.valor)/100;
  var pctLlegada = cargaActual - (kwhNecesario/capacidadKwh*100);
  var ok = pctLlegada >= ASSUMPTIONS.reservaLlegadaPct.valor;
  var numParadas = 0, minutosParada = ASSUMPTIONS.tiempoParadaCargaMin.valor;

  // Punto 12: no se presenta un único porcentaje como si fuera exacto — se muestra un rango
  // (±5 puntos, incertidumbre razonable de un modelo estimado) y se listan los factores usados.
  var pctMin = Math.max(0, Math.round(pctLlegada-5)), pctMax = Math.min(100, Math.round(pctLlegada+5));

  var htmlParadas = '';
  if(!ok){
    var energiaFaltante = kwhNecesario - energiaUsableInicial;
    var energiaPorParada = nominal*ASSUMPTIONS.factorRecargaPorParada.valor; // recarga típica 20%→80%
    numParadas = Math.max(1, Math.ceil(energiaFaltante/energiaPorParada));
    htmlParadas =
      '<div class="fila"><div class="fila-tx"><div class="t1">Paradas de carga necesarias (estimación)</div><div class="t2">Recargando 20 %→80 % cada vez — sin datos de cargadores reales en la ruta (punto 13, pendiente)</div></div>'+
      '<div class="fila-r"><div class="r1">'+numParadas+'</div></div></div>'+
      '<div class="fila"><div class="fila-tx"><div class="t1">Tiempo añadido estimado</div><div class="t2">~'+minutosParada+' min por parada en supercargador</div></div>'+
      '<div class="fila-r"><div class="r1">+'+(numParadas*minutosParada)+' min</div></div></div>';
  }

  cont.innerHTML =
    '<div class="fila"><div class="fila-tx"><div class="t1">Distancia</div><div class="t2">'+fuenteDistancia+(duracionRutaMin?' · ~'+Math.round(duracionRutaMin/60)+'h '+Math.round(duracionRutaMin%60)+'min de ruta':'')+'</div></div>'+
    '<div class="fila-r"><div class="r1">'+km+' km</div></div></div>'+
    '<div class="fila"><div class="fila-tx"><div class="t1">Energía necesaria</div><div class="t2">'+consumoUsado.toFixed(1)+' kWh/100km</div></div>'+
    '<div class="fila-r"><div class="r1">'+kwhNecesario.toFixed(1)+' kWh</div></div></div>'+
    '<div class="fila"><div class="fila-tx"><div class="t1">Batería estimada de llegada</div><div class="t2">Partiendo del '+cargaActual.toFixed(0)+' % actual · factores: '+esc(factoresUsados.join(', '))+'</div></div>'+
    '<div class="fila-r"><div class="r1" style="color:'+(ok?'var(--ok)':'var(--acc)')+'">'+pctMin+'–'+pctMax+' %</div></div></div>'+
    htmlParadas+
    '<div class="vacio" style="padding:14px 4px 4px">'+
    (ok ? '<p>✅ Llegas sin necesidad de cargar, con margen de seguridad.</p>' : '<p>⚠️ Llegarías por debajo del '+ASSUMPTIONS.reservaLlegadaPct.valor+' % recomendado — necesitas cargar por el camino.</p>')+
    '</div>'+
    '<div class="form-acciones" style="padding:0 16px 16px"><button class="btn-secundario" id="llego-guardar-plan" style="flex:none;padding:10px 18px">Guardar este plan</button></div>';

  document.getElementById('llego-guardar-plan').addEventListener('click', function(){
    DATOS.planes.push({
      id:'p'+Date.now(),
      fecha_creacion: new Date().toISOString(),
      destino: document.getElementById('llego-destino').value.trim() || 'Sin nombre',
      km: km, kwh: kwhNecesario, pct_llegada: Math.round(pctLlegada), paradas: numParadas
    });
    guardarDatos();
    renderPlanes();
    toast('Plan guardado');
  });
});

/* ---------- Planes de viaje guardados ---------- */
function renderPlanes(){
  var cont = document.getElementById('lista-planes');
  if(!cont) return;
  var planes = (DATOS.planes||[]).slice().sort(function(a,b){ return new Date(b.fecha_creacion)-new Date(a.fecha_creacion); });
  cont.innerHTML = planes.map(function(p){
    return '<div class="fila"><div class="fila-tx" data-reusar-plan="'+p.id+'"><div class="t1">'+esc(p.destino)+'</div>'+
      '<div class="t2">'+p.km+' km · '+p.kwh.toFixed(1)+' kWh · llegada al '+p.pct_llegada+' %'+(p.paradas?' · '+p.paradas+' parada(s)':'')+'</div></div>'+
      '<button type="button" class="btn-borrar" data-borrar-plan="'+p.id+'" data-icon="papelera" aria-label="Eliminar"></button></div>';
  }).join('') || '<div class="vacio"><span class="em">🗺️</span><p>Sin planes guardados. Calcula un trayecto en "¿Llego?" y guárdalo.</p></div>';
  aplicarIconos();
}
document.getElementById('lista-planes').addEventListener('click', function(e){
  var borrar = e.target.closest('[data-borrar-plan]');
  if(borrar){
    confirmarAccion('Eliminar plan', 'Se borrará este plan guardado.', function(){
      marcarBorrado('planes', borrar.dataset.borrarPlan);
      DATOS.planes = DATOS.planes.filter(function(p){ return p.id!==borrar.dataset.borrarPlan; });
      guardarDatos(); renderPlanes();
      toast('Plan eliminado');
    });
    return;
  }
  var reusar = e.target.closest('[data-reusar-plan]');
  if(reusar){
    var plan = (DATOS.planes||[]).find(function(p){ return p.id===reusar.dataset.reusarPlan; });
    if(!plan) return;
    document.getElementById('llego-destino').value = plan.destino==='Sin nombre' ? '' : plan.destino;
    document.getElementById('llego-km').value = plan.km;
    document.getElementById('llego-calcular').click();
    document.getElementById('llego-km').scrollIntoView({ behavior:'smooth', block:'center' });
    toast('Plan recalculado con tus datos actuales');
  }
});

/* ---------- Cargadores públicos reales (Open Charge Map, gratis, sin clave) ---------- */
var capaCargadoresPublicos = null;
var puntosCargadoresCache = null;
var potenciaMinActiva = 0;

function popupCargador(p, potenciaMax){
  var idFav = 'ocm-'+Math.round(p.AddressInfo.Latitude*1e5)+'-'+Math.round(p.AddressInfo.Longitude*1e5);
  var esFavorito = (DATOS.favoritos||[]).some(function(f){ return f.id===idFav; });
  return '<b>'+esc(p.AddressInfo.Title||'Cargador público')+'</b><br>'+
    (potenciaMax? potenciaMax+' kW · ' : '') + esc(p.AddressInfo.AddressLine1||'') +
    '<br><button class="ver" style="margin-top:6px;display:inline-block" data-fav-ocm="'+idFav+'" '+
    'data-fav-nombre="'+esc(p.AddressInfo.Title||'Cargador público')+'" '+
    'data-fav-lat="'+p.AddressInfo.Latitude+'" data-fav-lng="'+p.AddressInfo.Longitude+'">'+
    (esFavorito ? '★ En favoritos' : '☆ Guardar en favoritos')+'</button>';
}

function pintarCargadoresPublicos(){
  if(capaCargadoresPublicos){ mapaLeaflet.removeLayer(capaCargadoresPublicos); }
  capaCargadoresPublicos = L.layerGroup();
  var visibles = 0;
  puntosCargadoresCache.forEach(function(p){
    if(!p.AddressInfo || !p.AddressInfo.Latitude) return;
    var potenciaMax = (p.Connections||[]).reduce(function(m,c){ return Math.max(m, c.PowerKW||0); }, 0);
    if(potenciaMax < potenciaMinActiva) return;
    visibles++;
    L.circleMarker([p.AddressInfo.Latitude, p.AddressInfo.Longitude], {
      radius:6, color:'#fff', weight:1.5, fillColor:'#8e44ec', fillOpacity:.9
    }).bindPopup(popupCargador(p, potenciaMax)).addTo(capaCargadoresPublicos);
  });
  capaCargadoresPublicos.addTo(mapaLeaflet);
  document.getElementById('cargadores-estado').textContent = visibles+' de '+puntosCargadoresCache.length+' cargadores cumplen el filtro (radio de 25 km).';
}

var cargadoresPublicosPeticionId = 0;
document.getElementById('btn-cargadores-publicos').addEventListener('click', async function(){
  if(!mapaLeaflet) return; // el mapa todavía está cargando
  var btn = this;
  var estado = document.getElementById('cargadores-estado');
  var filtroPot = document.getElementById('filtro-potencia');
  if(btn.classList.contains('on')){
    cargadoresPublicosPeticionId++; // invalida cualquier petición en curso, para que no reactive el panel al terminar
    if(capaCargadoresPublicos){ mapaLeaflet.removeLayer(capaCargadoresPublicos); capaCargadoresPublicos = null; }
    puntosCargadoresCache = null;
    btn.classList.remove('on');
    filtroPot.style.display = 'none';
    estado.textContent = 'Datos de Open Charge Map, comunidad abierta de cargadores.';
    return;
  }
  var casa = lugarCasa();
  if(!casa){ toast('Configura tu ubicación de casa en Ajustes para buscar cargadores cercanos.', true); return; }
  var miPeticionId = ++cargadoresPublicosPeticionId;
  btn.classList.add('on');
  estado.textContent = 'Buscando cargadores cercanos…';
  try{
    var url = 'https://api.openchargemap.io/v3/poi/?output=json&latitude='+casa.lat+'&longitude='+casa.lng+
      '&distance=25&distanceunit=KM&maxresults=60&compact=true&verbose=false';
    var res = await fetch(url);
    if(!res.ok) throw new Error('HTTP '+res.status);
    var datos = await res.json();
    if(miPeticionId !== cargadoresPublicosPeticionId) return; // el usuario ya desactivó el panel mientras cargaba
    puntosCargadoresCache = datos;
    filtroPot.style.display = '';
    pintarCargadoresPublicos();
  }catch(e){
    if(miPeticionId !== cargadoresPublicosPeticionId) return;
    btn.classList.remove('on');
    estado.textContent = 'No se pudieron cargar los cargadores públicos ahora mismo.';
  }
});

document.getElementById('filtro-potencia').addEventListener('click', function(e){
  var btn = e.target.closest('button[data-potencia]');
  if(!btn || !puntosCargadoresCache) return;
  potenciaMinActiva = parseInt(btn.dataset.potencia);
  document.querySelectorAll('#filtro-potencia button').forEach(function(b){ b.classList.toggle('on', b===btn); });
  pintarCargadoresPublicos();
});

/* Guardar/quitar cargador de favoritos desde el popup del mapa */
document.getElementById('leaflet-map').addEventListener('click', function(e){
  var btn = e.target.closest('[data-fav-ocm]');
  if(!btn) return;
  if(!DATOS.favoritos) DATOS.favoritos = [];
  var id = btn.dataset.favOcm;
  var existe = DATOS.favoritos.some(function(f){ return f.id===id; });
  if(existe){
    marcarBorrado('favoritos', id);
    DATOS.favoritos = DATOS.favoritos.filter(function(f){ return f.id!==id; });
    btn.textContent = '☆ Guardar en favoritos';
    toast('Quitado de favoritos');
  } else {
    desmarcarBorrado('favoritos', id);
    DATOS.favoritos.push({ id:id, nombre:btn.dataset.favNombre, lat:parseFloat(btn.dataset.favLat), lng:parseFloat(btn.dataset.favLng) });
    btn.textContent = '★ En favoritos';
    toast('Guardado en favoritos');
  }
  guardarDatos();
  renderLugares();
  pintarFavoritosEnMapa();
});

/* ---------- Referencia gasolina editable ---------- */
document.getElementById('ref-consumo').addEventListener('change', function(){
  var v = parseFloat(this.value);
  DATOS.referencia_gasolina.consumo_l_100km = (!isNaN(v) && v>=0) ? v : DATOS.referencia_gasolina.consumo_l_100km;
  this.value = DATOS.referencia_gasolina.consumo_l_100km;
  DATOS.referencia_gasolina.updated_at = ahoraISO();
  guardarDatos(); renderDashboard(); renderEstadisticas(); renderGastos();
});
document.getElementById('ref-precio').addEventListener('change', function(){
  var v = parseFloat(this.value);
  DATOS.referencia_gasolina.precio_litro = (!isNaN(v) && v>=0) ? v : DATOS.referencia_gasolina.precio_litro;
  this.value = DATOS.referencia_gasolina.precio_litro;
  DATOS.referencia_gasolina.updated_at = ahoraISO();
  guardarDatos(); renderDashboard(); renderEstadisticas(); renderGastos();
});
function guardarCambiosVehiculo(){
  var nuevaCapacidad = parseFloat(document.getElementById('veh-capacidad').value);
  var nuevaAutonomia = parseFloat(document.getElementById('veh-autonomia').value);
  var nuevoOdometro = parseInt(document.getElementById('veh-odometro').value);
  DATOS.vehiculo.fecha_compra = document.getElementById('veh-fecha-compra').value || DATOS.vehiculo.fecha_compra;
  var nuevoModelo = document.getElementById('veh-modelo').value.trim();
  DATOS.vehiculo.modelo = nuevoModelo || DATOS.vehiculo.modelo;
  if(!isNaN(nuevaCapacidad) && nuevaCapacidad > 0) DATOS.vehiculo.capacidad_nominal_kwh = nuevaCapacidad;
  else document.getElementById('veh-capacidad').value = DATOS.vehiculo.capacidad_nominal_kwh;
  if(!isNaN(nuevaAutonomia) && nuevaAutonomia > 0) DATOS.vehiculo.autonomia_wltp_km = nuevaAutonomia;
  else document.getElementById('veh-autonomia').value = DATOS.vehiculo.autonomia_wltp_km;
  if(!isNaN(nuevoOdometro) && nuevoOdometro >= 0) DATOS.vehiculo.odometro_km = nuevoOdometro;
  else document.getElementById('veh-odometro').value = DATOS.vehiculo.odometro_km;
  DATOS.seguro.fecha_renovacion = document.getElementById('veh-seguro').value;
  DATOS.itv.fecha = document.getElementById('veh-itv').value;
  DATOS.vehiculo.updated_at = ahoraISO();
  DATOS.seguro.updated_at = ahoraISO();
  DATOS.itv.updated_at = ahoraISO();
  guardarDatos();
  renderDashboard(); renderBateria(); renderEstadisticas(); renderGastos();
}
['veh-modelo','veh-fecha-compra','veh-capacidad','veh-autonomia','veh-seguro','veh-itv'].forEach(function(id){
  document.getElementById(id).addEventListener('change', guardarCambiosVehiculo);
});
document.getElementById('veh-odometro').addEventListener('change', function(){
  var campo = this;
  var nuevo = parseInt(campo.value);
  var anterior = DATOS.vehiculo.odometro_km;
  if(!isNaN(nuevo) && nuevo < anterior){
    campo.value = anterior; // se restaura hasta confirmar, para no dejar un valor a medio guardar
    confirmarAccion('¿Odómetro más bajo que antes?', 'Vas a cambiar el odómetro de '+anterior.toLocaleString('es-ES')+' km a '+nuevo.toLocaleString('es-ES')+' km, un valor inferior al actual. Confirma solo si es una corrección intencionada.', function(){
      campo.value = nuevo;
      guardarCambiosVehiculo();
    }, 'Confirmar', true);
    return;
  }
  guardarCambiosVehiculo();
});

document.getElementById('veh-usar-ubicacion').addEventListener('click', function(){
  if(!navigator.geolocation){ toast('Este navegador no permite obtener la ubicación.', true); return; }
  var btn = this;
  btn.disabled = true; btn.textContent = 'Obteniendo ubicación…';
  navigator.geolocation.getCurrentPosition(function(pos){
    DATOS.vehiculo.casa = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    DATOS.vehiculo.updated_at = ahoraISO();
    guardarDatos();
    renderAjustes();
    if(mapaLeaflet){ mapaLeaflet.setView([pos.coords.latitude, pos.coords.longitude], 12); pintarFavoritosEnMapa(); }
    toast('Ubicación de casa guardada.');
    btn.disabled = false; btn.textContent = '📍 Usar mi ubicación';
  }, function(){
    toast('No se pudo obtener tu ubicación. Revisa los permisos del navegador.', true);
    btn.disabled = false; btn.textContent = '📍 Usar mi ubicación';
  }, { timeout: 10000 });
});
document.getElementById('veh-borrar-casa').addEventListener('click', function(){
  DATOS.vehiculo.casa = null;
  DATOS.vehiculo.updated_at = ahoraISO();
  guardarDatos();
  renderAjustes();
  toast('Ubicación de casa eliminada.');
});

document.getElementById('umbral-bateria').addEventListener('change', function(){
  var v = parseInt(this.value);
  if(isNaN(v) || v<0 || v>100){ v = parseInt(localStorage.getItem('mitesla-umbral-bateria'))||20; }
  this.value = v;
  localStorage.setItem('mitesla-umbral-bateria', v);
  renderDashboard();
});

/* ---------- Notificaciones del sistema (batería baja) ---------- */
function actualizarEstadoNotificaciones(){
  var el = document.getElementById('notif-estado');
  var btn = document.getElementById('notif-activar');
  if(!('Notification' in window)){
    el.textContent = 'No disponibles en este navegador';
    btn.style.display = 'none';
    return;
  }
  if(Notification.permission === 'granted' && localStorage.getItem('mitesla-notif-desactivadas')){
    el.textContent = 'Desactivadas (puedes reactivarlas aquí)';
    btn.textContent = 'Activar';
  } else if(Notification.permission === 'granted'){
    el.textContent = 'Activadas';
    btn.textContent = 'Desactivar';
  } else if(Notification.permission === 'denied'){
    el.textContent = 'Bloqueadas por el navegador — actívalas en los ajustes de Safari/Chrome para este sitio';
    btn.style.display = 'none';
  } else {
    el.textContent = 'Toca para activarlas';
    btn.textContent = 'Activar';
  }
}
/* Punto 19: función única para mostrar notificaciones. En una PWA móvil, `new Notification()`
 * directamente puede no estar disponible o lanzar (iOS/Android en modo instalado); hay que pasar
 * siempre por el Service Worker cuando existe. Nunca debe romper el render de la app si falla. */
async function showAppNotification(title, options){
  try{
    if(!('Notification' in window) || Notification.permission !== 'granted') return false;
    if('serviceWorker' in navigator){
      var reg = await navigator.serviceWorker.ready.catch(function(){ return null; });
      if(reg && reg.showNotification){
        await reg.showNotification(title, options);
        return true;
      }
    }
    // Fallback de escritorio sin Service Worker activo todavía.
    new Notification(title, options);
    return true;
  }catch(e){
    console.error('No se pudo mostrar la notificación:', e);
    return false;
  }
}
document.getElementById('notif-activar').addEventListener('click', async function(){
  if(Notification.permission === 'granted' && localStorage.getItem('mitesla-notif-desactivadas')){
    localStorage.removeItem('mitesla-notif-desactivadas');
    showAppNotification('Mi Tesla', { body:'Notificaciones reactivadas. Te avisaré aquí si la batería baja del umbral que fijes.' });
    actualizarEstadoNotificaciones();
    return;
  }
  if(Notification.permission === 'granted'){
    localStorage.setItem('mitesla-notif-desactivadas', '1');
    actualizarEstadoNotificaciones();
    return;
  }
  var permiso = await Notification.requestPermission();
  if(permiso === 'granted'){
    localStorage.removeItem('mitesla-notif-desactivadas');
    showAppNotification('Mi Tesla', { body:'Notificaciones activadas. Te avisaré aquí si la batería baja del umbral que fijes.' });
  }
  actualizarEstadoNotificaciones();
});
/* Fase 3 / B16: Web Push — categorías, dedupe/cooldown y suscripción real (envío real desde el
 * backend, ver worker.js: enviarPushesAlertasPendientes). tpms_baja se añadió en B16 — el motor de
 * alertas del Worker (Fase 4E) ya generaba avisos de presión de neumáticos, pero no tenían todavía
 * su propia categoría en este catálogo para poder desactivarlos sin desactivar Web Push entero. */
var PUSH_CATEGORIAS = {
  carga_umbral: 'Carga alcanza un % objetivo', carga_termina: 'Carga terminada', carga_interrumpida: 'Carga interrumpida',
  bateria_baja: 'Batería baja', seguro: 'Renovación de seguro', itv: 'ITV próxima', mantenimiento: 'Mantenimiento pendiente',
  sync_fallida: 'Sincronización fallida', anomalia: 'Anomalía importante', tpms_baja: 'Presión de neumático baja'
};
function cargarCategoriasPush(){
  try{ return Object.assign({}, Object.fromEntries(Object.keys(PUSH_CATEGORIAS).map(function(k){return [k,true];})), JSON.parse(localStorage.getItem('mitesla-push-categorias'))||{}); }
  catch(e){ var d={}; Object.keys(PUSH_CATEGORIAS).forEach(function(k){d[k]=true;}); return d; }
}
function guardarCategoriasPush(cat){ localStorage.setItem('mitesla-push-categorias', JSON.stringify(cat)); }
/** Evita mandar la misma alerta una y otra vez (dedupe) y limita la frecuencia por categoría+clave
 *  (cooldown) — p. ej. no avisar de "batería baja" 5 veces en una hora. Devuelve true SOLO si debe
 *  notificarse ahora, y en ese caso ya deja registrado el momento (efecto colateral intencionado,
 *  para no tener que hacer dos llamadas separadas de "puedo" y "he notificado"). */
function debeNotificarConCooldown(clave, cooldownMin){
  var almacenKey = 'mitesla-push-cooldown-'+clave;
  var anterior = localStorage.getItem(almacenKey);
  if(anterior && (Date.now() - new Date(anterior).getTime()) < cooldownMin*60000) return false;
  localStorage.setItem(almacenKey, ahoraISO());
  return true;
}
/** Punto 19 / B16 (FASE B): suscribe el dispositivo a Web Push real y guarda la suscripción en el
 *  backend (POST /push/suscribir, worker.js), incluyendo las categorías activas del dispositivo.
 *  Requiere (a) el flag web_push activo, (b) una clave pública VAPID (desde B16 se trae sola desde
 *  el backend — ver sincronizarClaveVapid — pero se puede seguir pegando a mano en "Ajustes" si se
 *  prefiere), y (c) el backend/sessionToken ya configurados en "Conexión Tesla" (mismos que usa
 *  probarConexionD1). Desde B16 el ENVÍO real de un push (firma VAPID + cifrado RFC 8291) también
 *  es real: lo hace el Worker por Cron Trigger (enviarPushesAlertasPendientes, worker.js) en cuanto
 *  el motor de alertas (Fase 4E) genera un aviso nuevo. */
function vapidPublicKeyConfigurada(){
  var el = document.getElementById('push-vapid-key');
  return (el && el.value.trim()) || '';
}
/** B16: trae la clave pública VAPID del backend (GET /push/vapid-clave-publica) y la deja escrita
 *  en el campo de "Ajustes → Notificaciones" SOLO si estaba vacío — nunca pisa una clave que el
 *  usuario haya pegado a mano. Silencioso ante cualquier fallo (sin backend configurado todavía,
 *  sin red, etc.): el campo simplemente se queda vacío y el flujo manual de siempre sigue intacto. */
async function sincronizarClaveVapid(){
  var el = document.getElementById('push-vapid-key');
  if(!el || el.value.trim()) return; // ya hay una clave (manual o ya sincronizada antes): nunca se sobrescribe
  var tcfg = cargarConfigTesla();
  var backendUrl = tcfg.backendUrl || TESLA_CONFIG_POR_DEFECTO.backendUrl;
  if(!backendUrl || !tcfg.sessionToken) return;
  try{
    var res = await fetch(backendUrl.replace(/\/$/,'')+'/push/vapid-clave-publica', {
      headers:{ 'Authorization':'Bearer '+tcfg.sessionToken }
    });
    if(!res.ok) return;
    var body = await res.json().catch(function(){ return null; });
    if(body && typeof body.public_key==='string' && body.public_key && !el.value.trim()){
      el.value = body.public_key;
      var estadoEl = document.getElementById('push-estado');
      if(estadoEl && estadoEl.textContent.indexOf('Pega antes')!==-1) estadoEl.textContent = 'Toca para activarlas';
    }
  }catch(e){ /* sin red, o backend caído: el campo se queda vacío, no rompe el resto de Ajustes */ }
}
/** B16: sincroniza las preferencias de categoría del dispositivo con el backend (POST
 *  /push/categorias), sin tener que volver a suscribirse. Best-effort y silencioso: si el
 *  dispositivo todavía no estaba suscrito, el backend simplemente no actualiza nada (0 filas) y
 *  aquí no se muestra ningún error — las categorías locales (localStorage) son la fuente de verdad
 *  para el propio dispositivo en cualquier caso. */
async function sincronizarCategoriasPushConBackend(categorias){
  var tcfg = cargarConfigTesla();
  var backendUrl = tcfg.backendUrl || TESLA_CONFIG_POR_DEFECTO.backendUrl;
  if(!backendUrl || !tcfg.sessionToken) return;
  try{
    await fetch(backendUrl.replace(/\/$/,'')+'/push/categorias', {
      method:'POST',
      headers:{ 'Authorization':'Bearer '+tcfg.sessionToken, 'Content-Type':'application/json' },
      body: JSON.stringify({ device_id: idDispositivo(), categorias: categorias })
    });
  }catch(e){ /* best-effort: sin red o backend caído, se reintentará solo la próxima vez que cambie algo */ }
}
async function activarWebPush(){
  if(!featureActiva('web_push')) return { ok:false, motivo:'flag_desactivado' };
  var vapidKey = vapidPublicKeyConfigurada();
  if(!vapidKey){ return { ok:false, motivo:'sin_vapid_key' }; }
  if(!('serviceWorker' in navigator) || !('PushManager' in window)) return { ok:false, motivo:'sin_soporte_navegador' };
  var permiso = Notification.permission==='granted' ? 'granted' : await Notification.requestPermission();
  if(permiso!=='granted') return { ok:false, motivo:'permiso_denegado' };
  try{
    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey: vapidKey });
    var tcfg = cargarConfigTesla();
    var backendUrl = tcfg.backendUrl || TESLA_CONFIG_POR_DEFECTO.backendUrl;
    if(backendUrl && tcfg.sessionToken){
      var sj = sub.toJSON ? sub.toJSON() : sub;
      try{
        var res = await fetch(backendUrl.replace(/\/$/,'')+'/push/suscribir', {
          method:'PUT',
          headers:{ 'Authorization':'Bearer '+tcfg.sessionToken, 'Content-Type':'application/json' },
          body: JSON.stringify({ device_id: idDispositivo(), endpoint: sj.endpoint, keys: sj.keys, categorias: cargarCategoriasPush() })
        });
        if(!res.ok) return { ok:true, suscripcion: sub, avisoBackend:'El navegador se suscribió, pero el backend no pudo guardar la suscripción (HTTP '+res.status+').' };
      }catch(e){
        return { ok:true, suscripcion: sub, avisoBackend:'El navegador se suscribió, pero no se pudo contactar con el backend para guardarla: '+e.message };
      }
    } else {
      return { ok:true, suscripcion: sub, avisoBackend:'El navegador se suscribió, pero falta configurar la URL del backend y la token de sesión en "Conexión Tesla" para guardar la suscripción.' };
    }
    return { ok:true, suscripcion: sub };
  }catch(e){
    return { ok:false, motivo:'error_suscripcion', detalle:String(e) };
  }
}
if('serviceWorker' in navigator){
  navigator.serviceWorker.addEventListener('message', function(e){
    if(e.data && e.data.tipo==='ABRIR_SECCION' && vistas[e.data.seccion]) mostrar(e.data.seccion);
  });
}
function renderCategoriasPush(){
  var filaPush = document.getElementById('fila-web-push');
  var filaVapid = document.getElementById('fila-web-push-vapid');
  var cont = document.getElementById('lista-categorias-push');
  var activo = featureActiva('web_push');
  if(filaPush) filaPush.style.display = activo ? '' : 'none';
  if(filaVapid) filaVapid.style.display = activo ? '' : 'none';
  if(cont) cont.style.display = activo ? '' : 'none';
  if(!activo || !cont) return;
  if(!vapidPublicKeyConfigurada()) sincronizarClaveVapid().then(function(){ /* si trae una clave, la deja escrita en el campo; no hace falta re-render aquí */ });
  var cat = cargarCategoriasPush();
  cont.innerHTML = Object.keys(PUSH_CATEGORIAS).map(function(k){
    return '<div class="fila"><div class="fila-tx"><div class="t1">'+esc(PUSH_CATEGORIAS[k])+'</div></div>'+
      '<div class="fila-r"><input type="checkbox" data-cat-push="'+k+'" '+(cat[k]?'checked':'')+' style="width:20px;height:20px"></div></div>';
  }).join('');
  cont.querySelectorAll('[data-cat-push]').forEach(function(chk){
    chk.addEventListener('change', function(){
      var actuales = cargarCategoriasPush();
      actuales[chk.dataset.catPush] = chk.checked;
      guardarCategoriasPush(actuales);
      sincronizarCategoriasPushConBackend(actuales); // B16: refleja el cambio en el backend sin re-suscribirse
    });
  });
  var estadoEl = document.getElementById('push-estado');
  if(estadoEl){
    estadoEl.textContent = vapidPublicKeyConfigurada()
      ? (Notification.permission==='granted' ? 'Activadas' : 'Toca para activarlas')
      : 'Pega la clave pública VAPID arriba, o configura backend+clave en "Conexión Tesla" para traerla sola';
  }
}
document.getElementById('push-activar').addEventListener('click', async function(){
  var r = await activarWebPush();
  if(r.ok){ toast(r.avisoBackend ? r.avisoBackend : 'Notificaciones push activadas', !!r.avisoBackend); }
  else if(r.motivo==='sin_vapid_key'){ toast('Falta la clave pública VAPID — configura backend+clave en "Conexión Tesla" para traerla sola, o pégala a mano arriba.', true); }
  else if(r.motivo==='permiso_denegado'){ toast('Permiso de notificaciones denegado.', true); }
  else { toast('No se pudo activar Web Push ahora mismo.', true); }
  renderCategoriasPush();
});

function avisarBateriaBajaSiHaceFalta(cargaActual, umbral){
  if(!('Notification' in window)) return;
  if(Notification.permission !== 'granted') return;
  if(localStorage.getItem('mitesla-notif-desactivadas')) return;
  if(cargaActual >= umbral) return;
  var yaAvisadoHoy = localStorage.getItem('mitesla-notif-bateria-fecha') === new Date().toDateString();
  if(yaAvisadoHoy) return;
  showAppNotification('Batería baja 🔋', { body:'Tu Tesla está al '+cargaActual+' %, por debajo de tu aviso ('+umbral+' %).' });
  localStorage.setItem('mitesla-notif-bateria-fecha', new Date().toDateString());
}

/* ---------- Compartir resumen ---------- */
document.getElementById('btn-compartir-resumen').addEventListener('click', async function(){
  var s = statsViajes();
  var costeTesla100 = (s.media!==null?s.media:ASSUMPTIONS.consumoReferenciaKwh100km.valor)/100*precioMedioKwhParaEstimaciones(); // referencia si aún no hay viajes suficientes con datos de batería
  var costeGasolina100 = DATOS.referencia_gasolina.consumo_l_100km*DATOS.referencia_gasolina.precio_litro;
  var ahorroTotal = (costeGasolina100-costeTesla100)/100*kmSeguimiento(); // solo sobre los km recorridos desde que se activó el seguimiento, no todo el histórico del coche
  var cargaActual = nivelCargaActual();
  var texto = '🚗 Mi Tesla — resumen rápido\n'+
    '🔋 Batería: '+(cargaActual!==null?cargaActual+' %':'sin datos')+'\n'+
    '🛣️ Odómetro: '+DATOS.vehiculo.odometro_km.toLocaleString('es-ES')+' km\n'+
    '⚡ Consumo medio: '+(s.media!==null?fmt1(s.media)+' kWh/100km':'sin datos suficientes')+'\n'+
    '💶 Ahorro vs. gasolina: '+euros(ahorroTotal);
  if(navigator.share){
    try{ await navigator.share({ title:'Mi Tesla', text:texto }); }
    catch(e){ /* el usuario canceló, no hacemos nada */ }
  } else {
    try{
      await navigator.clipboard.writeText(texto);
      toast('Resumen copiado al portapapeles');
    }catch(e){
      toast('No se pudo compartir en este navegador', true);
    }
  }
});

document.getElementById('selector-tema').addEventListener('click', function(e){
  var btn = e.target.closest('button[data-tema]');
  if(!btn) return;
  var tema = btn.dataset.tema;
  localStorage.setItem('mitesla-tema', tema);
  if(tema==='auto') document.documentElement.removeAttribute('data-tema');
  else document.documentElement.setAttribute('data-tema', tema);
  document.querySelectorAll('#selector-tema button').forEach(function(b){ b.classList.toggle('on', b===btn); });
  var oscuro = tema==='oscuro' || (tema==='auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', oscuro ? '#000000' : '#f5f5f7');
});
// Si el tema está en "Automático", sigue los cambios de claro/oscuro del sistema sin recargar la página.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e){
  if((localStorage.getItem('mitesla-tema')||'auto') !== 'auto') return;
  document.querySelector('meta[name="theme-color"]').setAttribute('content', e.matches ? '#000000' : '#f5f5f7');
});

function valorTarifaValido(id, anterior){
  var v = parseFloat(document.getElementById(id).value);
  if(isNaN(v) || v<0){ document.getElementById(id).value = anterior; return anterior; }
  return v;
}
['tarifa-valle','tarifa-llano','tarifa-punta'].forEach(function(id){
  document.getElementById(id).addEventListener('change', function(){
    var actual = cargarTarifa();
    localStorage.setItem('mitesla-tarifa', JSON.stringify({
      valle: valorTarifaValido('tarifa-valle', actual.valle),
      llano: valorTarifaValido('tarifa-llano', actual.llano),
      punta: valorTarifaValido('tarifa-punta', actual.punta)
    }));
  });
});

/* ---------- Fase 3, punto 15: privacidad de rutas ---------- */
document.getElementById('privacidad-radio').addEventListener('change', function(){
  localStorage.setItem('mitesla-privacidad-radio', this.value);
  toast(this.value==='0' ? 'Privacidad de rutas desactivada' : 'Ocultando puntos a menos de '+this.value+' m de casa en exportaciones');
});
function radioPrivacidadM(){ return parseInt(localStorage.getItem('mitesla-privacidad-radio')||'0', 10) || 0; }
/** Distancia aproximada en metros entre dos coordenadas (fórmula de Haversine, suficiente para
 *  decidir si un punto cae dentro del radio de privacidad — no se necesita precisión de rutas). */
function distanciaMetros(lat1, lng1, lat2, lng2){
  var R = 6371000;
  var dLat = (lat2-lat1) * Math.PI/180, dLng = (lng2-lng1) * Math.PI/180;
  var a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)*Math.sin(dLng/2);
  return R * 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
/** true si una coordenada debe OCULTARSE en una exportación/resumen compartido por caer dentro
 *  del radio de privacidad configurado alrededor de casa. Sin casa configurada o con el radio a
 *  0 (desactivado), nunca oculta nada — el comportamiento por defecto es idéntico al anterior a
 *  la Fase 3. */
function coordenadaEsPrivada(lat, lng){
  var radio = radioPrivacidadM();
  if(!radio) return false;
  var casa = DATOS.vehiculo && DATOS.vehiculo.casa;
  if(!casa) return false;
  return distanciaMetros(lat, lng, casa.lat, casa.lng) <= radio;
}

/* ---------- Sincronización con GitHub (sin backend) ---------- */
function cargarConfigGithub(){
  try{ return JSON.parse(localStorage.getItem('mitesla-github-config')) || {}; }
  catch(e){ return {}; }
}
function guardarConfigGithub(cfg){ localStorage.setItem('mitesla-github-config', JSON.stringify(cfg)); }

function b64EncodeUnicode(str){
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function(m,p){ return String.fromCharCode('0x'+p); }));
}
function b64DecodeUnicode(b64){
  return decodeURIComponent(atob(b64).split('').map(function(c){
    return '%' + ('00'+c.charCodeAt(0).toString(16)).slice(-2);
  }).join(''));
}

function marcaTiempo(x){ return (x && (x.updated_at||x.created_at)) || '0000-00-00T00:00:00.000Z'; }

/** Fusiona una colección de entidades con id entre lo remoto y lo local.
 *  Regla determinista: para cada id, se compara la marca de tiempo de la
 *  MEJOR edición disponible (la de updated_at más reciente entre remoto y
 *  local) contra la fecha de borrado más reciente que exista para ese id
 *  (en cualquiera de los dos lados). Gana quien tenga la marca de tiempo
 *  mayor — así una edición posterior a un borrado antiguo "revive" el
 *  elemento, y un borrado posterior a la última edición prevalece, tanto si
 *  vino de este dispositivo como del remoto. En empate exacto, gana la
 *  edición (nunca se pierde un dato por un empate de reloj). */
// C1 (FASE C): `saneador`, cuando se pasa, se aplica a cada entidad REMOTA antes de considerarla
// para la fusión — el mismo saneador por colección que usa sanearImportacion() (SANEADOR_ITEM,
// definido junto a idSeguro()/comoTextoSeguro()). Lo local NUNCA se sanea aquí: ya es de confianza
// (nace de los propios formularios de esta app, o ya pasó por este mismo saneador si llegó por
// importación) y algunas colecciones (p. ej. "planes") conservan campos libres con Object.assign
// que un saneado agresivo del lado local podría recortar sin necesidad. Lo remoto SÍ es un límite
// de confianza real: un datos.json de GitHub puede venir de un repositorio comprometido, compartido
// con otra persona, o simplemente editado a mano — antes se fusionaba tal cual, y su `id` se usaba
// sin escapar en decenas de atributos HTML (data-editar-viaje="'+v.id+'", etc.), lo que abría una
// inyección de HTML/atributo real si ese id contenía comillas/ángulos. idSeguro() ya se ocupaba de
// esto al IMPORTAR un .json a mano; aquí se cierra el mismo hueco para la sincronización con GitHub.
function fusionarPorId(remotoArr, localArr, borradosRemoto, borradosLocal, saneador){
  var remotoPorId = {};
  (remotoArr||[]).forEach(function(x){
    if(!x || typeof x!=='object') return;
    var limpio = saneador ? saneador(x) : x;
    if(limpio && limpio.id) remotoPorId[limpio.id]=limpio;
  });
  var localPorId = {}; (localArr||[]).forEach(function(x){ if(x && x.id) localPorId[x.id]=x; });
  var todosIds = {};
  Object.keys(remotoPorId).forEach(function(id){ todosIds[id]=true; });
  Object.keys(localPorId).forEach(function(id){ todosIds[id]=true; });
  Object.keys(borradosRemoto||{}).forEach(function(id){ todosIds[id]=true; });
  Object.keys(borradosLocal||{}).forEach(function(id){ todosIds[id]=true; });

  var resultado = [];
  var tombstonesFusion = {};
  Object.keys(todosIds).forEach(function(id){
    var eR = remotoPorId[id], eL = localPorId[id];
    var tR = (borradosRemoto||{})[id], tL = (borradosLocal||{})[id];
    var borradoMax = [tR,tL].filter(Boolean).sort().pop() || null;

    var mejor = null;
    if(eR) mejor = eR;
    if(eL && (!mejor || marcaTiempo(eL) > marcaTiempo(mejor))) mejor = eL;

    if(mejor && (!borradoMax || marcaTiempo(mejor) >= borradoMax)){
      resultado.push(mejor); // la edición es igual o más reciente que cualquier borrado: gana la edición
    } else if(borradoMax){
      tombstonesFusion[id] = borradoMax; // el borrado es más reciente que cualquier edición conocida: gana el borrado
    }
  });
  return { lista: resultado, borrados: tombstonesFusion };
}

/** Para los objetos únicos (no colecciones): gana el que tenga updated_at más
 *  reciente; en empate o si falta el campo en ambos, gana el local (el
 *  dispositivo donde se está aplicando la fusión), igual que antes pero
 *  ahora basado en una comparación real, no en "local siempre gana". */
function fusionarObjetoVersionado(remotoObj, localObj){
  if(!remotoObj) return localObj;
  if(!localObj) return remotoObj;
  var tR = remotoObj.updated_at || '0000-00-00T00:00:00.000Z';
  var tL = localObj.updated_at || '0000-00-00T00:00:00.000Z';
  return tL >= tR ? localObj : remotoObj;
}

function fusionarDatos(remotoOriginal, local){
  // Lo remoto puede venir de una versión antigua sin ids/timestamps: se migra
  // igual que se migraría al cargarlo, sin tocar el objeto original del llamador.
  var remoto = normalizarDatos(JSON.parse(JSON.stringify(remotoOriginal||{})));
  var bR = remoto._borrados || {};
  var bL = local._borrados || {};

  var colecciones = {};
  var borrados = {};
  COLECCIONES_SYNC.forEach(function(col){
    var f = fusionarPorId(remoto[col], local[col], bR[col], bL[col], SANEADOR_ITEM[col]);
    colecciones[col] = f.lista;
    borrados[col] = f.borrados;
  });
  colecciones.bateria_historico.sort(function(a,b){ return new Date(a.fecha)-new Date(b.fecha); });

  return normalizarDatos({
    schema_version: SCHEMA_VERSION,
    dataset_id: local.dataset_id || remoto.dataset_id,
    data_mode: local.data_mode || remoto.data_mode,
    device_id: idDispositivo(),
    vehiculo: fusionarObjetoVersionado(remoto.vehiculo, local.vehiculo),
    referencia_gasolina: fusionarObjetoVersionado(remoto.referencia_gasolina, local.referencia_gasolina),
    bateria_historico: colecciones.bateria_historico,
    viajes: colecciones.viajes,
    cargas: colecciones.cargas,
    gastos: colecciones.gastos,
    recordatorios: colecciones.recordatorios,
    neumaticos: fusionarObjetoVersionado(remoto.neumaticos, local.neumaticos),
    accesorios: colecciones.accesorios,
    planes: colecciones.planes,
    favoritos: colecciones.favoritos,
    _borrados: borrados,
    seguro: fusionarObjetoVersionado(remoto.seguro, local.seguro),
    itv: fusionarObjetoVersionado(remoto.itv, local.itv)
  });
}

function estadoSync(msg, error, estadoForzado){
  var el = document.getElementById('gh-estado');
  var dot = document.getElementById('gh-estado-dot');
  el.textContent = msg;
  el.style.color = error ? 'var(--acc)' : 'var(--txt)';
  if(dot){
    var cls = estadoForzado || (error ? 'err'
      : (msg.indexOf('Sincronizando')===0 ? 'busy'
      : (msg.indexOf('Sincronizado correctamente')===0 ? 'ok' : 'pend')));
    dot.className = 'epunto '+cls;
  }
}

/* ---------- Fase 3, punto 32: sincronización con Cloudflare D1 (DISEÑADO/PENDIENTE) ----------
 * Cliente real para los endpoints /d1/sync y /d1/datos del Worker (ver worker.js) — no hace nada
 * simulado: si el Worker todavía no tiene el binding D1 desplegado, esta llamada falla con el
 * error real que devuelve el propio Worker (d1_no_configurado), nunca un "éxito" fingido. Gateada
 * por el feature flag "d1_sync" (desactivado por defecto), igual que el resto de funciones de
 * esta fase que dependen de infraestructura todavía no desplegada. */
function estadoD1(msg, estadoForzado){
  var el = document.getElementById('d1-estado');
  var dot = document.getElementById('d1-estado-dot');
  if(el) el.textContent = msg;
  if(dot) dot.className = 'epunto '+(estadoForzado||'pend');
}
async function probarConexionD1(){
  if(!featureActiva('d1_sync')){ estadoD1('Activa primero el flag "d1_sync" en Funciones avanzadas.', 'off'); return; }
  var tcfg = cargarConfigTesla();
  var backendUrl = tcfg.backendUrl || TESLA_CONFIG_POR_DEFECTO.backendUrl;
  if(!backendUrl){ estadoD1('Configura antes la URL del backend en "Conexión Tesla".', 'off'); return; }
  if(!tcfg.sessionToken){ estadoD1('Falta la token de sesión (misma que usa "Conexión Tesla").', 'off'); return; }
  estadoD1('Probando conexión…', 'busy');
  try{
    var res = await fetch(backendUrl.replace(/\/$/,'')+'/d1/datos?device_id='+encodeURIComponent(idDispositivo()), {
      headers: { 'Authorization': 'Bearer '+tcfg.sessionToken }
    });
    var cuerpo = await res.json().catch(function(){ return null; });
    if(res.status===501 && cuerpo && cuerpo.error==='d1_no_configurado'){
      estadoD1('El Worker todavía no tiene el binding D1 desplegado — ver instrucciones en Ajustes.', 'err');
      return;
    }
    if(!res.ok){
      estadoD1('Error del servidor ('+res.status+'): '+(cuerpo&&cuerpo.error?cuerpo.error:'desconocido'), 'err');
      return;
    }
    estadoD1(cuerpo.contenido ? 'Conexión correcta — hay datos guardados de '+new Date(cuerpo.actualizado_en).toLocaleString('es-ES') : 'Conexión correcta — todavía sin datos guardados para este dispositivo.', 'ok');
  }catch(e){
    estadoD1('No se pudo contactar con el backend: '+e.message, 'err');
  }
}
document.getElementById('btn-probar-d1').addEventListener('click', probarConexionD1);

/* ---------- FASE B1 — Capa base de repositorio (DISEÑO + CAPA BASE, sin migrar pantallas) ----------
 * Encargo B1 completo: "D1 como fuente canónica, PWA como caché/offline, GitHub como backup
 * opcional" — un rediseño total de dónde vive cada dato. Ese rediseño es demasiado grande y
 * arriesgado para cerrarlo de golpe sin verificar cada pantalla (Dashboard/Viajes/Stats/Economía/
 * búsqueda/Informe/Wrapped/Backup dependen hoy todas de DATOS/localStorage directamente). Con el
 * usuario se acordó este alcance para este incremento: "Diseño + capa base, sin migrar todavía" —
 * construir y probar de verdad una capa de acceso a datos (RepositorioDatos) que lee/escribe en D1
 * cuando está disponible y si no cae a localStorage, DETRÁS del flag "d1_sync", SIN tocar ninguna
 * pantalla existente todavía. cargarDatos()/guardarDatos() siguen exactamente igual que antes —
 * cero cambio de comportamiento visible en esta entrega. Migrar las pantallas a usar este
 * repositorio, y sustituir el blob único por almacenamiento granular por colección en D1, queda
 * PENDIENTE explícitamente para una sesión futura (no es una simulación de estar "hecho").
 *
 * Reutiliza los mismos endpoints /d1/datos (GET) y /d1/sync (PUT) que ya usa probarConexionD1 —
 * no se inventan rutas de backend nuevas para este incremento.
 */
function repositorioD1Disponible(){
  if(!featureActiva('d1_sync')) return false;
  var tcfg = cargarConfigTesla();
  var backendUrl = tcfg.backendUrl || TESLA_CONFIG_POR_DEFECTO.backendUrl;
  return !!(backendUrl && tcfg.sessionToken);
}
function repositorioD1BackendUrl(){
  var tcfg = cargarConfigTesla();
  return (tcfg.backendUrl || TESLA_CONFIG_POR_DEFECTO.backendUrl || '').replace(/\/$/,'');
}
/* Lee el blob completo de datos desde D1 para este dispositivo. Devuelve null si D1 responde
 * correctamente pero todavía no hay nada guardado (nunca inventa un objeto de datos vacío como si
 * fuera lo que hay en D1: null="no hay dato ahí" es distinto de un dataset vacío real). Lanza si
 * hay un error real (D1 no configurado, red caída, credenciales inválidas, timeout) — quien llame
 * decide si eso significa "usa localStorage en su lugar" o "avisa al usuario", nunca se traga el
 * error en silencio aquí. */
async function repositorioD1Leer(fetchImpl){
  fetchImpl = fetchImpl || fetch;
  var tcfg = cargarConfigTesla();
  var res = await fetchImpl(repositorioD1BackendUrl()+'/d1/datos?device_id='+encodeURIComponent(idDispositivo()), {
    headers: { 'Authorization': 'Bearer '+tcfg.sessionToken }
  });
  var cuerpo = await res.json().catch(function(){ return null; });
  if(!res.ok){
    var err = new Error('repositorioD1Leer: '+res.status+' '+(cuerpo&&cuerpo.error?cuerpo.error:'error_desconocido'));
    err.status = res.status;
    throw err;
  }
  return (cuerpo && cuerpo.contenido) ? cuerpo.contenido : null;
}
/* Escribe el blob completo de datos en D1 para este dispositivo. Igual que arriba: nunca oculta un
 * fallo real, lanza para que quien llame decida (ver RepositorioDatos.guardar más abajo, que SÍ
 * decide seguir adelante con localStorage como red de seguridad). */
async function repositorioD1Guardar(datos, fetchImpl){
  fetchImpl = fetchImpl || fetch;
  var authority = await leerAuthorityFrontend(fetchImpl);
  if(authority==='IMPORTING' || authority==='VERIFYING') throw new Error('migration_locked');
  if(authority==='CANONICAL') datos = sinBusinessLegacy(datos);
  var tcfg = cargarConfigTesla();
  var res = await fetchImpl(repositorioD1BackendUrl()+'/d1/sync', {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer '+tcfg.sessionToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: idDispositivo(), datos: datos })
  });
  var cuerpo = await res.json().catch(function(){ return null; });
  if(!res.ok){
    var err = new Error('repositorioD1Guardar: '+res.status+' '+(cuerpo&&cuerpo.error?cuerpo.error:'error_desconocido'));
    err.status = res.status;
    throw err;
  }
  return cuerpo;
}
/* API pública de la capa base — todavía sin usar por ninguna pantalla (ver comentario de cabecera).
 * leer(): intenta D1 si está disponible; si D1 falla (no configurado, red, error del servidor) o
 * está desactivado, cae a localStorage sin más — igual que hace hoy cargarDatos(), nunca lanza.
 * guardar(datos): SIEMPRE escribe en localStorage primero (la fuente que ya funciona hoy no se
 * debilita nunca por este incremento) y, si D1 está disponible, intenta también escribir ahí;
 * un fallo de D1 al guardar se reporta en el resultado (d1Error) pero nunca impide ni deshace el
 * guardado en localStorage — perder el guardado local por un problema de red sería peor que el
 * problema que se intenta resolver. */
var RepositorioDatos = {
  d1Disponible: repositorioD1Disponible,
  async leer(fetchImpl){
    if(repositorioD1Disponible()){
      try{
        var datosD1 = await repositorioD1Leer(fetchImpl);
        if(datosD1) return { datos: datosD1, fuente: 'd1' };
      }catch(e){ /* cae a localStorage abajo: D1 no es la fuente canónica todavía en esta entrega */ }
    }
    var crudo = null;
    try{ crudo = localStorage.getItem('mitesla-datos'); }catch(e){}
    return { datos: crudo ? JSON.parse(crudo) : null, fuente: 'localStorage' };
  },
  async guardar(datos, fetchImpl){
    var resultado = { localStorage: false, d1: false, d1Error: null };
    try{
      localStorage.setItem('mitesla-datos', JSON.stringify(datosParaPersistenciaLocal(datos)));
      resultado.localStorage = true;
    }catch(e){
      resultado.localStorageError = e.message;
    }
    if(repositorioD1Disponible()){
      try{
        await repositorioD1Guardar(datos, fetchImpl);
        resultado.d1 = true;
      }catch(e){
        resultado.d1Error = e.message;
        // B4 (FASE B): el guardado en D1 ha fallado (típicamente, sin conexión) — se encola en el
        // outbox de IndexedDB para reintentarlo solo en cuanto vuelva la red, en vez de perder el
        // intento silenciosamente hasta que alguien vuelva a guardar algo a mano.
        if(typeof outboxEncolarGuardadoD1==='function') await outboxEncolarGuardadoD1(datos);
      }
    }
    return resultado;
  }
};

/* ---------- B2 (FASE B): migración segura a D1, con dry-run obligatorio ----------
 * Antes de escribir nada en D1, analiza lo que la migración REAL haría — reutilizando el mismo
 * motor de fusión determinista (fusionarPorId/marcaTiempo, el mismo que ya usa GitHub: NORMA de no
 * duplicar arquitectura) — y lo muestra por colección: insertar/actualizar/conflicto/id inválido
 * (rechazar)/posible duplicado. Solo tras pulsar "Confirmar migración" se escribe algo, y esa
 * escritura es literalmente fusionarDatos() + repositorioD1Guardar() — el mismo camino ya probado
 * del backup a D1 (RepositorioDatos), nunca un segundo algoritmo de fusión nuevo e independiente.
 * "No perder nada": fusionarDatos() nunca sobrescribe sin fusionar, y en un empate exacto de
 * timestamp gana la edición sobre el borrado (ver comentario de fusionarPorId).
 */
var CLAVE_NATURAL_POR_COLECCION_MIGRACION = {
  // Solo colecciones donde un duplicado accidental (misma carga/viaje/gasto introducido dos veces
  // con id distinto, p.ej. por una importación repetida) es detectable de forma fiable por un par
  // de campos característicos — el resto se omite a propósito para no generar falsos positivos.
  viajes: function(x){ return (x.fecha||'')+'|'+(x.origen||'')+'|'+(x.destino||'')+'|'+(x.km||''); },
  cargas: function(x){ return (x.fecha||'')+'|'+(x.lugar||'')+'|'+(x.kwh||''); },
  gastos: function(x){ return (x.fecha||'')+'|'+(x.concepto||'')+'|'+(x.importe||''); },
  bateria_historico: function(x){ return (x.fecha||'')+'|'+(x.soc_pct!=null?x.soc_pct:''); }
};
function analizarMigracionD1(remoto, local){
  var r = remoto ? normalizarDatos(JSON.parse(JSON.stringify(remoto))) : null;
  var bR = (r && r._borrados) || {};
  var bL = (local && local._borrados) || {};
  var porColeccion = {};
  var totales = { insertar:0, actualizar:0, conflicto:0, rechazar:0, duplicar:0 };

  COLECCIONES_SYNC.forEach(function(col){
    var remotoArr = r ? (r[col]||[]) : [];
    var localArr = local[col]||[];
    var remotoPorId = {}; remotoArr.forEach(function(x){ if(x&&x.id) remotoPorId[x.id]=x; });
    var borradosRemoto = bR[col]||{};

    var detalle = { insertar:[], actualizar:[], conflicto:[], rechazar:[], duplicar:[] };

    localArr.forEach(function(x){
      if(!x || typeof x!=='object') return;
      if(!x.id || !ID_SEGURO.test(String(x.id))){ detalle.rechazar.push(x); return; }
      var enRemoto = remotoPorId[x.id];
      if(!enRemoto){
        if(borradosRemoto[x.id] && borradosRemoto[x.id] >= marcaTiempo(x)) return; // ya se borró en remoto después de esta edición local: no aplica
        detalle.insertar.push(x);
        return;
      }
      if(JSON.stringify(enRemoto)===JSON.stringify(x)) return; // sin cambios, no se cuenta
      var tLocal = marcaTiempo(x), tRemoto = marcaTiempo(enRemoto);
      if(tLocal === tRemoto){ detalle.conflicto.push(x); }
      else if(tLocal > tRemoto){ detalle.actualizar.push(x); }
      // si lo remoto es más reciente, no hace falta escribir nada para este id: tras fusionar, gana lo remoto.
    });

    var claveFn = CLAVE_NATURAL_POR_COLECCION_MIGRACION[col];
    if(claveFn){
      var vistos = {};
      localArr.forEach(function(x){
        if(!x || !x.id) return;
        var k = claveFn(x);
        if(!k || /^\|+$/.test(k)) return; // clave vacía (sin campos rellenos): no es una señal fiable de duplicado
        if(vistos[k]) detalle.duplicar.push(x); else vistos[k]=x;
      });
    }

    porColeccion[col] = {
      insertar: detalle.insertar.length, actualizar: detalle.actualizar.length,
      conflicto: detalle.conflicto.length, rechazar: detalle.rechazar.length, duplicar: detalle.duplicar.length
    };
    Object.keys(totales).forEach(function(k){ totales[k] += porColeccion[col][k]; });
  });

  return { porColeccion: porColeccion, totales: totales };
}
var NOMBRE_COLECCION_MIGRACION = { viajes:'Viajes', cargas:'Cargas', gastos:'Gastos', recordatorios:'Recordatorios', accesorios:'Accesorios', planes:'Planes', favoritos:'Favoritos', bateria_historico:'Batería', plantillas_viaje:'Plantillas de viaje', neumaticos_historico:'Neumáticos', mantenimiento:'Mantenimiento', documentos:'Documentos' };
var ultimoAnalisisMigracionD1 = null;
async function analizarYRenderizarMigracionD1(fetchImpl){
  var cont = document.getElementById('migracion-d1-resultado');
  var det = document.getElementById('migracion-d1-detalle');
  var tcfg = cargarConfigTesla();
  var backendUrl = tcfg.backendUrl || TESLA_CONFIG_POR_DEFECTO.backendUrl;
  if(!backendUrl || !tcfg.sessionToken){ toast('Configura primero la URL del backend y la token de sesión en "Conexión Tesla".', true); return; }
  cont.style.display=''; det.innerHTML = '<div class="sub">Analizando…</div>';
  try{
    var remoto = await repositorioD1Leer(fetchImpl);
    var analisis = analizarMigracionD1(remoto, DATOS);
    ultimoAnalisisMigracionD1 = { remoto: remoto, analisis: analisis };
    var filas = COLECCIONES_SYNC.filter(function(col){
      var c = analisis.porColeccion[col];
      return c.insertar||c.actualizar||c.conflicto||c.rechazar||c.duplicar;
    }).map(function(col){
      var c = analisis.porColeccion[col];
      var partes = [];
      if(c.insertar) partes.push(c.insertar+' nuevo(s)');
      if(c.actualizar) partes.push(c.actualizar+' se actualizará(n)');
      if(c.conflicto) partes.push(c.conflicto+' en conflicto');
      if(c.rechazar) partes.push(c.rechazar+' con id inválido (no se migran)');
      if(c.duplicar) partes.push(c.duplicar+' posible(s) duplicado(s) (revisar)');
      return '<div class="sub">'+esc(NOMBRE_COLECCION_MIGRACION[col]||col)+': '+partes.join(', ')+'</div>';
    }).join('');
    var t = analisis.totales;
    det.innerHTML = (filas || '<div class="sub">No hay cambios que migrar: local y D1 ya coinciden.</div>') +
      (t.conflicto ? '<div class="sub">⚠️ '+t.conflicto+' conflicto(s): mismo registro editado en ambos sitios al mismo tiempo — al confirmar, gana la edición sobre cualquier borrado, pero conviene revisar cuál versión es la correcta.</div>' : '') +
      (t.rechazar ? '<div class="sub">⚠️ '+t.rechazar+' registro(s) con id no válido no se migrarán tal cual.</div>' : '');
  }catch(e){
    det.innerHTML = '<div class="sub">No se pudo leer D1 para analizar: '+esc((e&&e.message)||String(e))+'</div>';
    ultimoAnalisisMigracionD1 = null;
  }
}
document.getElementById('btn-analizar-migracion-d1').addEventListener('click', function(){ analizarYRenderizarMigracionD1(); });
document.getElementById('btn-cancelar-migracion-d1').addEventListener('click', function(){
  document.getElementById('migracion-d1-resultado').style.display='none';
});
document.getElementById('btn-confirmar-migracion-d1').addEventListener('click', function(){
  if(!legacyBusinessPermitido()){ toast('La importación legacy está bloqueada por authority.', true); return; }
  if(!ultimoAnalisisMigracionD1){ toast('Analiza primero, antes de confirmar.', true); return; }
  confirmarAccion('Confirmar migración a D1', 'Se fusionarán tus datos locales con lo que ya haya en D1 (nunca se sobrescribe sin fusionar antes) usando el mismo motor de sincronización que ya usa GitHub. ¿Continuar?', function(){
    var remoto = ultimoAnalisisMigracionD1.remoto || {};
    var fusion = fusionarDatos(remoto, DATOS);
    repositorioD1Guardar(fusion).then(function(){
      DATOS = conservarBusinessCanonical(fusion); guardarDatos(true);
      document.getElementById('migracion-d1-resultado').style.display='none';
      toast('Migración a D1 completada');
      renderDashboard(); renderCargas(); renderViajes(); renderBateria(); renderGastos(); renderEstadisticas(); renderAjustes();
    }).catch(function(e){
      toast('Error migrando a D1: '+((e&&e.message)||String(e)), true);
    });
  }, 'Confirmar migración');
});

/* ---------- B3 (FASE B): repository layer en el frontend ----------
 * "Las vistas no deben saber dónde vive el dato" — un módulo por tipo de entidad con una API CRUD
 * uniforme (listar/obtener/guardar/eliminar), en vez de que cada pantalla manipule DATOS.viajes con
 * .push/.filter a mano. Reutiliza EXACTAMENTE los mecanismos ya probados (conTimestamps, papelera,
 * historial de cambios, guardarDatos) — nunca una segunda forma de guardar un dato.
 *
 * ALCANCE HONESTO de este incremento (mismo criterio ya acordado en B1): se entrega la capa base,
 * real y probada, y se migra un punto de uso real (el formulario de Gastos, ver más abajo) como
 * demostración de que funciona de extremo a extremo. Migrar TODAS las pantallas existentes (decenas
 * de puntos que hoy tocan DATOS.viajes/.cargas/... directamente) es un cambio mecánico grande que
 * merece su propio pase con regresión completa sobre cada pantalla, y queda EXPLÍCITAMENTE
 * PENDIENTE — no se simula como terminado.
 * `ruleRepository` (reglas de automatización) y un repositorio de lugares respaldado por D1
 * (`locations`) quedan fuera a propósito: hoy esos datos viven solo en D1 y ninguna pantalla los
 * consume todavía (eso es B7/B8, sin empezar) — un repositorio sin ningún dato real detrás sería
 * decorativo, no una capa de acceso a datos de verdad.
 */
function crearRepositorio(coleccion){
  return {
    coleccion: coleccion,
    listar: function(){
      return (DATOS[coleccion]||[]).slice();
    },
    obtener: function(id){
      return (DATOS[coleccion]||[]).find(function(x){ return claveItemColeccion(coleccion,x)===id; }) || null;
    },
    /** Crea (sin id) o actualiza (con id existente) una entidad y devuelve la versión guardada, ya
     *  con id/timestamps reales. Un único camino de escritura, el mismo que ya usaba cada formulario
     *  a mano — nunca dos formas distintas de persistir lo mismo. */
    guardar: function(datos){
      if(esBusiness(coleccion) && !legacyBusinessPermitido()) throw new Error('canonical_repository_required');
      if(!DATOS[coleccion]) DATOS[coleccion] = [];
      var existente = datos.id ? this.obtener(datos.id) : null;
      var limpio = Object.assign({}, existente, datos);
      conTimestamps(limpio, existente);
      desmarcarBorrado(coleccion, limpio.id); // por si se reutiliza un id que había estado borrado
      if(existente){
        DATOS[coleccion][DATOS[coleccion].indexOf(existente)] = limpio;
      } else {
        DATOS[coleccion].push(limpio);
      }
      guardarDatos();
      registrarCambio(coleccion, existente?'editar':'crear', textoResumenCambio(coleccion, limpio));
      return limpio;
    },
    /** Elimina por id: quita de la colección, deja tumba y manda a la papelera — el mismo camino de
     *  siempre (nunca un borrado que se salte la papelera o la sincronización). */
    eliminar: function(id){
      if(esBusiness(coleccion) && !legacyBusinessPermitido()) throw new Error('canonical_repository_required');
      var item = this.obtener(id);
      if(!item) return false;
      DATOS[coleccion] = DATOS[coleccion].filter(function(x){ return claveItemColeccion(coleccion,x)!==id; });
      marcarBorrado(coleccion, id);
      moverAPapelera(coleccion, item);
      guardarDatos();
      registrarCambio(coleccion, 'eliminar', textoResumenCambio(coleccion, item));
      return true;
    }
  };
}
/* ---------- Micro-Work B: Bridge frontend canónico ----------
 * API async para viajes/cargas. DATOS es una proyección confirmada; no hay fallback de
 * escritura local, reintento automático ni outbox ante 409/red. Las pantallas legacy
 * usan el boundary async de Micro-Work D. No llamar guardarDatos() desde el Bridge.
 */
var CAMPOS_BRIDGE = {"viajes": ["started_at", "ended_at", "start_odometer_km", "end_odometer_km", "distance_km", "duration_min", "start_soc_pct", "end_soc_pct", "start_energy_remaining_kwh", "end_energy_remaining_kwh", "energy_used_kwh", "energy_source", "consumption_is_estimated", "start_lat", "start_lng", "end_lat", "end_lng", "start_location_id", "end_location_id", "start_location_raw", "end_location_raw", "outside_temp_start", "outside_temp_end", "classification", "classification_source", "classification_rule_id", "manual_override", "data_quality", "source", "is_shadow", "route_simplified", "weather"], "cargas": ["started_at", "ended_at", "start_soc_pct", "end_soc_pct", "start_odometer_km", "energy_kwh", "energy_source", "charging_current_type", "charger_type", "fast_charger_present", "fast_charger_type", "max_power_kw", "average_power_kw", "power_samples_count", "duration_min", "lat", "lng", "location_id", "total_cost", "cost_source", "price_rule_id", "tesla_invoice_id", "manual_override", "data_quality", "source", "is_shadow"]};
var MAPA_BRIDGE = {
  viajes: { fecha:'started_at', km:'distance_km', duracion_min:'duration_min', origen:'start_location_raw', destino:'end_location_raw', bateria_inicial:'start_soc_pct', bateria_final:'end_soc_pct', kwh:'energy_used_kwh' },
  cargas: { fecha:'started_at', kwh:'energy_kwh', duracion_min:'duration_min', bateria_inicial:'start_soc_pct', bateria_final:'end_soc_pct', odometro_km:'start_odometer_km', coste_total:'total_cost', tipo:'charger_type' }
};
function bridgeACanonical(coleccion, datos){
  var out = {}, mapa = MAPA_BRIDGE[coleccion];
  CAMPOS_BRIDGE[coleccion].forEach(function(k){
    if(Object.prototype.hasOwnProperty.call(datos,k)) out[k] = datos[k];
  });
  Object.keys(mapa).forEach(function(k){
    if(Object.prototype.hasOwnProperty.call(datos,k)) out[mapa[k]] = datos[k];
  });
  // Campos de presentación sin columna propia: conservarlos en el override manual.
  var extras = coleccion==='cargas' ? ['lugar','precio_kwh','origen_solar','origen_bateria','fecha_fin','ac_dc','red','potencia_max_kw','perdidas_pct','kwh_red_estimado','data_source','notas','vehicle_id','origen_energia','factura_reconciliada','factura_numero','factura_fecha'] : ['notas','etiqueta','conductor'];
  extras.forEach(function(k){
    if(Object.prototype.hasOwnProperty.call(datos,k)){
      if(out.manual_override === null) throw new Error('manual_override_null_with_legacy_fields');
      out.manual_override = Object.assign({}, datos.manual_override || {}, out.manual_override || {});
      out.manual_override[k] = datos[k];
    }
  });
  var tecnicos = ['id','vin','revision','deleted_at','created_at','updated_at'];
  Object.keys(datos).forEach(function(k){
    if(!Object.prototype.hasOwnProperty.call(mapa,k) && CAMPOS_BRIDGE[coleccion].indexOf(k)===-1 && extras.indexOf(k)===-1 && tecnicos.indexOf(k)===-1){
      throw new Error('canonical_unsupported_field: '+k);
    }
  });
  return out;
}
function bridgeAProyeccion(coleccion, entity){
  if(!entity || !entity.id || !Number.isInteger(entity.revision) || entity.revision<1 || !Object.prototype.hasOwnProperty.call(entity,'deleted_at')) throw new Error('invalid_canonical_response');
  var out = Object.assign({}, entity), mapa = MAPA_BRIDGE[coleccion];
  Object.keys(mapa).forEach(function(k){
    if(Object.prototype.hasOwnProperty.call(entity,mapa[k])) out[k] = entity[mapa[k]];
  });
  var extras = coleccion==='cargas' ? ['lugar','precio_kwh','origen_solar','origen_bateria','fecha_fin','ac_dc','red','potencia_max_kw','perdidas_pct','kwh_red_estimado','data_source','notas','vehicle_id','origen_energia','factura_reconciliada','factura_numero','factura_fecha'] : ['notas','etiqueta','conductor'];
  extras.forEach(function(k){
    if(entity.manual_override && Object.prototype.hasOwnProperty.call(entity.manual_override,k)) out[k] = entity.manual_override[k];
  });
  return out;
}
function crearRepositorioCanonical(coleccion){
  var generation = 0;
  var confirmadas = Object.create(null); // incluye tombstones para rechazar respuestas tardías
  async function solicitar(sufijo, method, body, fetchImpl){
    var cfg = cargarConfigTesla(), backend = repositorioD1BackendUrl();
    if(!backend || !cfg.sessionToken) throw new Error('canonical_not_configured');
    var res = await (fetchImpl || fetch)(backend+'/canonical/'+coleccion+sufijo, {
      method:method, cache:'no-store', headers:{ Authorization:'Bearer '+cfg.sessionToken, 'Content-Type':'application/json' },
      body:body===undefined ? undefined : JSON.stringify(body)
    });
    var result = await res.json();
    if(!res.ok){
      var error = new Error(result.error || 'canonical_http_error');
      error.status = res.status; error.code = result.error; error.currentRevision = result.currentRevision; error.current = result.current;
      throw error;
    }
    return result;
  }
  function confirmar(entity){
    var item = bridgeAProyeccion(coleccion, entity), lista = DATOS[coleccion] || [];
    var anterior = confirmadas[item.id] || lista.find(function(x){ return x.id===item.id; });
    if(anterior && anterior.revision>item.revision) return JSON.parse(JSON.stringify(anterior));
    generation++;
    confirmadas[item.id] = item;
    DATOS[coleccion] = lista.filter(function(x){ return x.id!==item.id; });
    if(!item.deleted_at) DATOS[coleccion].push(item);
    if(typeof guardarCacheCanonical==='function') guardarCacheCanonical();
    // Cache solamente: no disparar backup, blob sync ni cambios legacy de papelera.
    if(typeof frontendAuthority==='undefined' || frontendAuthority!=='CANONICAL'){
      try{ localStorage.setItem('mitesla-datos', JSON.stringify(DATOS)); }catch(e){}
    }
    return JSON.parse(JSON.stringify(item));
  }
  function revision(id, explicit){
    var item = (DATOS[coleccion] || []).find(function(x){ return x.id===id; });
    var value = explicit===undefined ? (confirmadas[id] || item || {}).revision : explicit;
    if(!Number.isInteger(value) || value<1) throw new Error('canonical_revision_required');
    return value;
  }
  return {
    coleccion:coleccion,
    listar:function(){ return JSON.parse(JSON.stringify(DATOS[coleccion] || [])); },
    obtener:function(id){ return this.listar().find(function(x){ return x.id===id; }) || null; },
    cargar:async function(vin, fetchImpl){
      if(!vin) throw new Error('canonical_identity_required');
      var result = await solicitar('?vin='+encodeURIComponent(vin), 'GET', undefined, fetchImpl);
      if(!Array.isArray(result[coleccion])) throw new Error('invalid_canonical_response');
      // Lista limitada por el backend: no interpretar ausencias como borrados.
      result[coleccion].forEach(function(entity){ bridgeAProyeccion(coleccion, entity); });
      return result[coleccion].map(confirmar);
    },
    refreshAll:async function(vin, fetchImpl, preparar){
      if(!vin) throw new Error('canonical_identity_required');
      var startGeneration = generation;
      var cursor = null, staged = [], seen = Object.create(null), cursors = Object.create(null);
      do {
        var result = await solicitar('?vin='+encodeURIComponent(vin)+(cursor ? '&cursor='+encodeURIComponent(cursor) : ''), 'GET', undefined, fetchImpl);
        if(!Array.isArray(result.items) || !Object.prototype.hasOwnProperty.call(result,'nextCursor')) throw new Error('invalid_canonical_response');
        result.items.forEach(function(entity){
          bridgeAProyeccion(coleccion,entity);
          if(entity.deleted_at || seen[entity.id]) throw new Error('invalid_canonical_page');
          seen[entity.id] = true; staged.push(entity);
        });
        cursor = result.nextCursor;
        if(cursor !== null && (typeof cursor !== 'string' || !cursor || cursors[cursor])) throw new Error('invalid_canonical_cursor');
        if(cursor) cursors[cursor] = true;
      } while(cursor !== null);
      // Atomic publication: a failed page leaves cache/projection entirely intact.
      if(generation !== startGeneration) throw new Error('canonical_refresh_superseded');
      var publicar = function(){
      if(generation !== startGeneration) throw new Error('canonical_refresh_superseded');
      generation++;
      var prior = confirmadas;
      var next = staged.map(function(entity){
        var cached = prior[entity.id];
        return cached && cached.revision>entity.revision ? cached : bridgeAProyeccion(coleccion,entity);
      }).filter(function(item){ return !item.deleted_at; });
      confirmadas = Object.create(null);
      Object.keys(prior).forEach(function(id){ if(prior[id].deleted_at) confirmadas[id]=prior[id]; });
      next.forEach(function(item){ confirmadas[item.id]=item; });
      DATOS[coleccion] = next;
      if(!preparar && (typeof frontendAuthority==='undefined' || frontendAuthority!=='CANONICAL')){ try{ localStorage.setItem('mitesla-datos',JSON.stringify(DATOS)); }catch(e){} }
      return JSON.parse(JSON.stringify(next));
      };
      if(preparar) return { validar:function(){ if(generation !== startGeneration) throw new Error('canonical_refresh_superseded'); }, publicar:publicar };
      var resultado = publicar();
      if(typeof guardarCacheCanonical==='function') guardarCacheCanonical();
      return resultado;
    },
    refrescar:async function(id, fetchImpl){
      var result = await solicitar('/'+encodeURIComponent(id), 'GET', undefined, fetchImpl);
      return confirmar(result.entity);
    },
    guardar:async function(datos, fetchImpl){
      var existente = datos.id && this.obtener(datos.id);
      var patch = bridgeACanonical(coleccion, datos), result;
      if(existente || datos.revision!==undefined){
        // No completar el patch con la proyección: solo enviar campos editados.
        if(patch.manual_override && datos.manual_override===undefined && existente && existente.manual_override){
          patch.manual_override = Object.assign({}, existente.manual_override, patch.manual_override);
        }
        result = await solicitar('/'+encodeURIComponent(datos.id), 'PATCH', { expectedRevision:revision(datos.id,datos.revision), patch:patch }, fetchImpl);
      }else{
        patch.id = datos.id || nuevoId(); patch.vin = datos.vin || vinAutomatizacion();
        if(!patch.vin || !patch.started_at) throw new Error('canonical_identity_required');
        if(patch.source===undefined) patch.source = 'manual';
        result = await solicitar('', 'POST', patch, fetchImpl);
      }
      return confirmar(result.entity);
    },
    eliminar:async function(id, expectedRevision, fetchImpl){
      var result = await solicitar('/'+encodeURIComponent(id), 'DELETE', { expectedRevision:revision(id,expectedRevision) }, fetchImpl);
      return confirmar(result.entity);
    },
    restaurar:async function(id, expectedRevision, fetchImpl){
      if(expectedRevision===undefined && !confirmadas[id] && !this.obtener(id)){
        var deleted = await solicitar('/'+encodeURIComponent(id)+'?includeDeleted=true','GET',undefined,fetchImpl);
        confirmar(deleted.entity);
      }
      var result = await solicitar('/'+encodeURIComponent(id)+'/restore', 'POST', { expectedRevision:revision(id,expectedRevision) }, fetchImpl);
      return confirmar(result.entity);
    }
  };
}
var tripRepository = crearRepositorioCanonical('viajes');
var chargeRepository = crearRepositorioCanonical('cargas');

/* ---------- Micro-Work D: authority, startup and UI mutation boundary ---------- */
function esBusiness(col){ return col==='viajes' || col==='cargas'; }
function backendCanonicalConfigurado(){
  var cfg = cargarConfigTesla();
  return !!(cfg.sessionToken && repositorioD1BackendUrl());
}
function legacyBusinessPermitido(){
  if(frontendAuthority==='CANONICAL') return false;
  return !backendCanonicalConfigurado() || frontendAuthority==='LEGACY' || frontendAuthority==='PREPARED';
}
function conservarBusinessCanonical(datos){
  if(!legacyBusinessPermitido()){
    datos.viajes = DATOS.viajes;
    datos.cargas = DATOS.cargas;
    datos._borrados = Object.assign({}, datos._borrados);
    ['viajes','cargas'].forEach(function(col){
      if(DATOS._borrados && DATOS._borrados[col]) datos._borrados[col] = DATOS._borrados[col];
      else delete datos._borrados[col];
    });
  }
  return datos;
}
function datosParaPersistenciaLocal(datos){
  if(frontendAuthority!=='CANONICAL') return datos;
  var persistido;
  try{ persistido = JSON.parse(localStorage.getItem('mitesla-datos')) || {}; }catch(e){ persistido={}; }
  var copia = JSON.parse(JSON.stringify(datos));
  ['viajes','cargas'].forEach(function(col){
    if(Object.prototype.hasOwnProperty.call(persistido,col)) copia[col]=persistido[col];
    else delete copia[col];
  });
  copia._borrados = Object.assign({}, copia._borrados);
  ['viajes','cargas'].forEach(function(col){
    if(persistido._borrados && persistido._borrados[col]) copia._borrados[col]=persistido._borrados[col];
    else delete copia._borrados[col];
  });
  return copia;
}
function sinBusinessLegacy(datos){
  var copia = JSON.parse(JSON.stringify(datos));
  delete copia.viajes; delete copia.cargas;
  if(copia._borrados){ delete copia._borrados.viajes; delete copia._borrados.cargas; }
  return copia;
}
async function leerAuthorityFrontend(fetchImpl){
  var cfg = cargarConfigTesla();
  var res = await (fetchImpl || fetch)(repositorioD1BackendUrl()+'/canonical/system/authority', {
    cache:'no-store', headers:{Authorization:'Bearer '+cfg.sessionToken}
  });
  var body = await res.json();
  if(!res.ok || ['LEGACY','PREPARED','IMPORTING','VERIFYING','CANONICAL'].indexOf(body.authority)===-1) throw new Error('authority_unavailable');
  if(frontendAuthority!==body.authority) frontendReady=false;
  frontendAuthority = body.authority;
  return frontendAuthority;
}
function identidadCacheCanonical(){ return repositorioD1BackendUrl()+'|'+vinAutomatizacion(); }
function guardarCacheCanonical(){
  if(typeof frontendAuthority==='undefined' || frontendAuthority!=='CANONICAL' || !frontendReady) return;
  try{ localStorage.setItem('mitesla-canonical-confirmed', JSON.stringify({identity:identidadCacheCanonical(), viajes:DATOS.viajes, cargas:DATOS.cargas})); }catch(e){}
}
async function iniciarFrontendCanonical(fetchImpl){
  frontendReady = false;
  var canonicalPrevio=false;
  try{
    var cache = JSON.parse(localStorage.getItem('mitesla-canonical-confirmed'));
    canonicalPrevio=!!(cache && typeof cache.identity==='string' && Array.isArray(cache.viajes) && Array.isArray(cache.cargas));
    if(cache && cache.identity===identidadCacheCanonical() && Array.isArray(cache.viajes) && Array.isArray(cache.cargas)){
      cache.viajes.forEach(function(x){ bridgeAProyeccion('viajes',x); });
      cache.cargas.forEach(function(x){ bridgeAProyeccion('cargas',x); });
      DATOS.viajes=cache.viajes.map(function(x){ return bridgeAProyeccion('viajes',x); });
      DATOS.cargas=cache.cargas.map(function(x){ return bridgeAProyeccion('cargas',x); });
    }
  }catch(e){}
  if(!backendCanonicalConfigurado()){
    if(canonicalPrevio){ frontendAuthority='CANONICAL'; throw new Error('canonical_not_configured'); }
    frontendReady=true; return;
  }
  var authority = await leerAuthorityFrontend(fetchImpl);
  if(authority==='CANONICAL'){
    var vin = vinAutomatizacion();
    if(!vin && typeof teslaStartupPromise!=='undefined'){
      await teslaStartupPromise;
      vin = vinAutomatizacion();
    }
    if(!vin) throw new Error('canonical_identity_required');
    // Both stage without writing DATOS or storage. Validate both before either publishes.
    var staged = await Promise.all([
      tripRepository.refreshAll(vin,fetchImpl,true), chargeRepository.refreshAll(vin,fetchImpl,true)
    ]);
    if(vin!==vinAutomatizacion()) throw new Error('canonical_identity_changed');
    staged.forEach(function(x){ x.validar(); });
    staged.forEach(function(x){ x.publicar(); });
  }else if(authority!=='LEGACY' && authority!=='PREPARED') throw new Error('migration_locked');
  frontendReady=true;
  guardarCacheCanonical();
}
async function mutacionBusiness(col, key, control, operacion){
  var lock = col+':'+key;
  if(businessPendiente[lock]) return false;
  if(backendCanonicalConfigurado() && (!frontendReady || !legacyBusinessPermitido() && frontendAuthority!=='CANONICAL')){
    toast('Espera a completar la lectura canónica antes de guardar.',true); return false;
  }
  businessPendiente[lock]=true;
  var botones = control ? (control.querySelectorAll ? Array.from(control.querySelectorAll('button, input[type=submit]')) : []) : [];
  if(control && control.tagName==='BUTTON') botones.push(control);
  var estados = botones.map(function(b){ return b.disabled; });
  botones.forEach(function(b){ b.disabled=true; });
  try{
    if(backendCanonicalConfigurado()){
      var previous = frontendAuthority;
      await leerAuthorityFrontend();
      if(frontendAuthority!==previous){
        frontendReady=false;
        throw new Error('authority_changed_reload_required');
      }
      if(frontendAuthority!=='CANONICAL' && !legacyBusinessPermitido()) throw new Error('migration_locked');
    }
    var repo = legacyBusinessPermitido() ? crearRepositorio(col) : (col==='viajes' ? tripRepository : chargeRepository);
    return await operacion(repo);
  }catch(e){
    toast(e.code==='revision_conflict' ? 'Otro dispositivo modificó este registro. Tu borrador se conserva; vuelve a cargar antes de reintentar.' : 'No se guardó el cambio: '+e.message,true);
    return false;
  }finally{
    delete businessPendiente[lock];
    botones.forEach(function(b,i){ b.disabled=estados[i]; });
  }
}

var expenseRepository = crearRepositorio('gastos');
var favoriteRepository = crearRepositorio('favoritos'); // favoritos/lugares LOCALES — distinto de "locations" en D1 (B7, sin UI todavía)
/* Vehículo: no es una colección con id, es un objeto único — mismo estilo de API (obtener/guardar)
 * para que una vista que solo sepa hablar con "un repositorio" también pueda leer/escribir el
 * vehículo sin tocar DATOS.vehiculo directamente. */
var vehicleRepository = {
  obtener: function(){ return DATOS.vehiculo; },
  guardar: function(cambios){
    DATOS.vehiculo = conTimestamps(Object.assign({}, DATOS.vehiculo, cambios), DATOS.vehiculo);
    guardarDatos();
    return DATOS.vehiculo;
  }
};

/* ---------- B4 (FASE B): offline — outbox en IndexedDB + sync automática al volver online ----------
 * ALCANCE HONESTO: el encargo pide "IndexedDB preferentemente para datos", es decir, mover el
 * almacén PRINCIPAL de DATOS de localStorage a IndexedDB. Ese es un cambio de mucho más alcance
 * (decenas de puntos que hoy llaman a localStorage.getItem/setItem('mitesla-datos') directamente,
 * incluida la ruta de arranque síncrona) y queda EXPLÍCITAMENTE PENDIENTE para un pase dedicado con
 * su propia regresión completa — no se simula como hecho aquí.
 * Lo que SÍ es nuevo y real en este incremento es la otra mitad del punto: un "outbox" que SÍ vive
 * en IndexedDB (sobrevive a cerrar la pestaña, a diferencia de un simple flag en localStorage) y
 * encola un guardado en D1 que falló por estar offline, reintentándolo solo — sin que el usuario
 * tenga que tocar nada — en cuanto el dispositivo recupera conexión.
 * La sincronización con GitHub YA tenía su propio mecanismo de reintento (mitesla-sync-pending + el
 * listener 'online' existente, más arriba en este archivo) y no se toca aquí: sigue funcionando
 * exactamente igual (NO ELIMINES FUNCIONES). Este outbox es aditivo, solo para D1.
 */
var OUTBOX_DB_NOMBRE = 'mitesla-outbox';
var OUTBOX_STORE = 'pendientes';
function outboxAbrir(){
  return new Promise(function(resolve, reject){
    if(!('indexedDB' in window)){ reject(new Error('IndexedDB no disponible en este navegador')); return; }
    var req = indexedDB.open(OUTBOX_DB_NOMBRE, 1);
    req.onupgradeneeded = function(){
      var db = req.result;
      if(!db.objectStoreNames.contains(OUTBOX_STORE)) db.createObjectStore(OUTBOX_STORE, { keyPath:'id' });
    };
    req.onsuccess = function(){ resolve(req.result); };
    req.onerror = function(){ reject(req.error||new Error('outboxAbrir: error desconocido')); };
  });
}
async function outboxEncolar(entrada){
  if(entrada.tipo==='d1_guardar'){
    if(!legacyBusinessPermitido()) return {preservado:true};
    try{
      var authority = await leerAuthorityFrontend();
      if(authority!=='LEGACY' && authority!=='PREPARED') return {preservado:true};
    }catch(e){ return {preservado:true}; }
  }
  return outboxAbrir().then(function(db){
    return new Promise(function(resolve, reject){
      var tx = db.transaction(OUTBOX_STORE,'readwrite');
      tx.objectStore(OUTBOX_STORE).put(entrada);
      tx.oncomplete = function(){ resolve(); };
      tx.onerror = function(){ reject(tx.error); };
    });
  });
}
function outboxListar(){
  return outboxAbrir().then(function(db){
    return new Promise(function(resolve, reject){
      var tx = db.transaction(OUTBOX_STORE,'readonly');
      var req = tx.objectStore(OUTBOX_STORE).getAll();
      req.onsuccess = function(){ resolve(req.result||[]); };
      req.onerror = function(){ reject(req.error); };
    });
  });
}
function outboxQuitar(id){
  return outboxAbrir().then(function(db){
    return new Promise(function(resolve, reject){
      var tx = db.transaction(OUTBOX_STORE,'readwrite');
      tx.objectStore(OUTBOX_STORE).delete(id);
      tx.oncomplete = function(){ resolve(); };
      tx.onerror = function(){ reject(tx.error); };
    });
  });
}
/** Encola un intento de guardado en D1 que falló (offline o error de red) — SIEMPRE con los datos
 *  completos en ese momento, nunca un delta parcial, para que un vaciado posterior nunca deje el
 *  remoto a medias. Una entrada nueva sustituye a la anterior del mismo dispositivo (solo interesa
 *  el ÚLTIMO estado a reintentar, no un histórico). Best-effort: si el propio outbox falla (p.ej.
 *  IndexedDB no disponible), se registra el error pero nunca rompe el flujo de guardado normal. */
function outboxEncolarGuardadoD1(datos){
  return outboxEncolar({ id:'d1_guardar_'+idDispositivo(), tipo:'d1_guardar', datos:datos, encolado_en:ahoraISO() })
    .catch(function(e){ console.error('No se pudo encolar el guardado offline en D1', e); });
}
/** Vacía el outbox: reintenta cada entrada pendiente contra D1; si tiene éxito, la retira; si sigue
 *  fallando, se deja para el próximo intento (nunca se descarta un cambio real por un reintento
 *  fallido). Se llama al recuperar conexión — nunca en el arranque en frío sin red todavía. */
async function outboxVaciar(fetchImpl){
  try{
    if(await leerAuthorityFrontend(fetchImpl)!=='LEGACY' && frontendAuthority!=='PREPARED') return {procesados:0, preservado:true};
  }catch(e){ return {procesados:0, preservado:true, error:e.message}; }
  var pendientes;
  try{ pendientes = await outboxListar(); }catch(e){ return { procesados:0, quedan:0, error:e.message }; }
  var procesados = 0;
  for(var i=0;i<pendientes.length;i++){
    var entrada = pendientes[i];
    if(entrada.tipo!=='d1_guardar') continue;
    try{
      await repositorioD1Guardar(entrada.datos, fetchImpl);
      await outboxQuitar(entrada.id);
      procesados++;
    }catch(e){ /* sigue sin conexión o D1 sigue fallando: se queda en el outbox para el próximo intento */ }
  }
  return { procesados: procesados, quedan: (pendientes.length-procesados) };
}
window.addEventListener('online', function(){
  outboxVaciar().then(function(r){
    if(r && r.procesados) toast('Sincronizado con D1 tras recuperar conexión');
  }).catch(function(){ /* best-effort */ });
});

/* ---------- B5/B6 (FASE B) — viajes y cargas AUTOMÁTICOS (telemetría), visibles en la app ----------
 * El Worker (Fase 4B/4C) ya detecta viajes y sesiones de carga a partir de la telemetría y los
 * guarda en D1 (`trips`/`charging_sessions`) — hasta ahora nadie los mostraba en ningún sitio de la
 * app, solo se veían indirectamente vía /pendientes (los que necesitan clasificación o precio).
 * ALCANCE: se listan en su propia sección "Detectados automáticamente" en Viajes/Cargas, de solo
 * lectura. NO QUIERO SOLO PARCHES: se ha valorado deliberadamente NO meterlos dentro de
 * DATOS.viajes/DATOS.cargas (el array editable que alimenta statsViajes/consumoViaje/costeCarga y
 * la sincronización con GitHub) — históricamente eran dos fuentes de datos distintas (MANUAL vs TESLA_TELEMETRY,
 * norma "datos Tesla"): forzarlos dentro rompería esas funciones con campos que pueden venir null
 * (un viaje sin distance_km reventaría fmt1(v.km) en las estadísticas) y arriesgaría duplicar
 * un viaje que el usuario ya introdujo a mano. Reconciliar/importar uno de estos hacia el historial
 * editable es una decisión de arquitectura mayor (qué pasa si el usuario lo edita, cómo se detecta
 * el duplicado…) que este punto no pide — solo pide que sean VISIBLES, y eso es lo que hace este
 * bloque, con su propio formateo tolerante a datos incompletos (nunca fabrica un "0" o un "—" con
 * apariencia de dato real). Se excluyen explícitamente los "is_shadow" (modo sombra) — eso ya lo
 * hace el propio endpoint del Worker. Gateado por el mismo flag "fleet_telemetry" y la misma
 * configuración (URL + clave) que el resto del panel de Automatización — reutiliza vinAutomatizacion()
 * y cargarConfigTesla(), nunca duplica esa lógica.
 */
var VIAJES_AUTO = { lista: [], cargado: false, error: null };
var CARGAS_AUTO = { lista: [], cargado: false, error: null };
var NOMBRE_TIPO_CARGA_AUTO = { supercharger:'Supercharger', domestica:'Casa', publico:'Cargador público', trabajo:'Trabajo', otro:'Otro' };
function fmtKmAuto(km){ return (typeof km==='number' && isFinite(km)) ? km.toFixed(1)+' km' : '— km'; }
function fmtMinAuto(min){ return (typeof min==='number' && isFinite(min)) ? Math.round(min)+' min' : '— min'; }
function fmtKwhAuto(kwh){ return (typeof kwh==='number' && isFinite(kwh)) ? kwh.toFixed(1)+' kWh' : '— kWh'; }
/** Backend/VIN/flag necesarios para cualquiera de los dos — el mismo criterio que ya usa
 *  cargarAutomatizacion(), factorizado aquí para no duplicarlo entre viajes y cargas. */
function contextoTelemetriaAuto(){
  if(!featureActiva('fleet_telemetry')) return { ok:false, motivo:'Activa "Fleet Telemetry" en Ajustes → Funciones para ver aquí los datos detectados automáticamente.' };
  var vin = vinAutomatizacion();
  var tcfg = cargarConfigTesla();
  var backendUrl = (tcfg.backendUrl || TESLA_CONFIG_POR_DEFECTO.backendUrl || '').replace(/\/$/,'');
  if(!vin || !backendUrl || !tcfg.sessionToken) return { ok:false, motivo:'Conecta tu Tesla y configura el backend (Ajustes → Conexión Tesla) para ver aquí los datos detectados automáticamente.' };
  return { ok:true, vin:vin, backendUrl:backendUrl, sessionToken:tcfg.sessionToken };
}
async function cargarViajesAutomaticos(fetchImpl){
  var cont = document.getElementById('lista-viajes-auto');
  var estado = document.getElementById('viajes-auto-estado');
  var ctx = contextoTelemetriaAuto();
  if(!ctx.ok){ if(cont) cont.innerHTML=''; if(estado) estado.textContent = ctx.motivo; return; }
  try{
    var res = await (fetchImpl||fetch)(ctx.backendUrl+'/telemetria/viajes?vin='+encodeURIComponent(ctx.vin), { headers:{ 'Authorization':'Bearer '+ctx.sessionToken } });
    if(res.status===501){ if(estado) estado.textContent = 'El Worker todavía no tiene el binding D1 desplegado.'; return; }
    if(!res.ok){ VIAJES_AUTO.error = 'HTTP '+res.status; if(estado) estado.textContent = 'No se pudieron cargar los viajes automáticos ('+VIAJES_AUTO.error+').'; return; }
    var body = await res.json();
    VIAJES_AUTO.lista = (body && body.viajes) || [];
    VIAJES_AUTO.cargado = true; VIAJES_AUTO.error = null;
  }catch(e){ VIAJES_AUTO.error = e.message; if(estado) estado.textContent = 'No se pudo contactar con el backend: '+e.message; return; }
  renderViajesAutomaticos();
}
function renderViajesAutomaticos(){
  var cont = document.getElementById('lista-viajes-auto');
  var estado = document.getElementById('viajes-auto-estado');
  if(!cont) return;
  var lista = VIAJES_AUTO.lista;
  if(estado) estado.textContent = lista.length
    ? lista.length+' viaje'+(lista.length===1?'':'s')+' detectado'+(lista.length===1?'':'s')+' por telemetría, todavía no importado'+(lista.length===1?'':'s')+' al historial de abajo'
    : 'Sin viajes detectados automáticamente todavía.';
  cont.innerHTML = lista.map(function(t){
    var origen = t.start_location_raw || 'Origen sin geocodificar';
    var destino = t.end_location_raw || 'Destino sin geocodificar';
    return '<div class="fila">'+
      '<div class="ico viaje" data-icon="ruta"></div>'+
      '<div class="fila-tx"><div class="t1">'+esc(origen)+' → '+esc(destino)+'</div>'+
      '<div class="t2">'+fechaCorta(t.started_at)+' · '+fmtMinAuto(t.duration_min)+' · Tesla'+(t.classification?' · '+esc(t.classification):'')+'</div></div>'+
      '<div class="fila-r"><div class="r1">'+fmtKmAuto(t.distance_km)+'</div><div class="r2">'+(t.data_quality==='estimated'?'estimado':'')+'</div></div>'+
      '</div>';
  }).join('');
}
async function cargarCargasAutomaticas(fetchImpl){
  var cont = document.getElementById('lista-cargas-auto');
  var estado = document.getElementById('cargas-auto-estado');
  var ctx = contextoTelemetriaAuto();
  if(!ctx.ok){ if(cont) cont.innerHTML=''; if(estado) estado.textContent = ctx.motivo; return; }
  try{
    var res = await (fetchImpl||fetch)(ctx.backendUrl+'/telemetria/cargas?vin='+encodeURIComponent(ctx.vin), { headers:{ 'Authorization':'Bearer '+ctx.sessionToken } });
    if(res.status===501){ if(estado) estado.textContent = 'El Worker todavía no tiene el binding D1 desplegado.'; return; }
    if(!res.ok){ CARGAS_AUTO.error = 'HTTP '+res.status; if(estado) estado.textContent = 'No se pudieron cargar las cargas automáticas ('+CARGAS_AUTO.error+').'; return; }
    var body = await res.json();
    CARGAS_AUTO.lista = (body && body.cargas) || [];
    CARGAS_AUTO.cargado = true; CARGAS_AUTO.error = null;
  }catch(e){ CARGAS_AUTO.error = e.message; if(estado) estado.textContent = 'No se pudo contactar con el backend: '+e.message; return; }
  renderCargasAutomaticas();
}
function renderCargasAutomaticas(){
  var cont = document.getElementById('lista-cargas-auto');
  var estado = document.getElementById('cargas-auto-estado');
  if(!cont) return;
  var lista = CARGAS_AUTO.lista;
  if(estado) estado.textContent = lista.length
    ? lista.length+' carga'+(lista.length===1?'':'s')+' detectada'+(lista.length===1?'':'s')+' por telemetría, todavía no importada'+(lista.length===1?'':'s')+' al historial de abajo'
    : 'Sin cargas detectadas automáticamente todavía.';
  cont.innerHTML = lista.map(function(c){
    var lugar = NOMBRE_TIPO_CARGA_AUTO[c.charger_type] || 'Carga';
    // Reutiliza costeCarga() tal cual (mismo criterio en toda la app: nunca inventa un coste de 0€).
    var coste = costeCarga({ total_cost: c.total_cost, kwh: c.energy_kwh });
    return '<div class="fila">'+
      '<div class="ico carga" data-icon="rayo"></div>'+
      '<div class="fila-tx"><div class="t1">'+esc(lugar)+(c.charging_current_type?' · '+esc(c.charging_current_type):'')+'</div>'+
      '<div class="t2">'+fechaCorta(c.started_at)+' · '+fmtBateria(c.start_soc_pct)+' → '+fmtBateria(c.end_soc_pct)+' · Tesla</div></div>'+
      '<div class="fila-r"><div class="r1">'+fmtKwhAuto(c.energy_kwh)+'</div><div class="r2">'+euros(coste)+'</div></div>'+
      '</div>';
  }).join('');
}

/* ---------- B7 (FASE B) — administración completa de lugares (geofences en D1) ----------
 * Hasta ahora `locations` (D1) solo se LEÍA del lado del servidor para clasificar viajes/cargas —
 * no había ningún sitio en la app donde el usuario pudiera dar de alta, editar o borrar un lugar:
 * solo existía "Lugares" (sección más arriba), que son estadísticas + favoritos LOCALES
 * (DATOS.favoritos, otra colección totalmente distinta). Este bloque es el CRUD real contra
 * /lugares (Worker) — reutiliza contextoTelemetriaAuto() (mismo gateo por flag/VIN/backend que
 * B5/B6) para no duplicar esa comprobación por tercera vez.
 * NORMA SOBRE DATOS INVENTADOS: el radio por defecto (150 m) y la categoría/privacidad "sin
 * marcar" los decide el propio Worker al guardar (ver worker.js) — aquí solo se envía lo que el
 * usuario ha escrito, nunca se rellena un valor a ciegas del lado del cliente.
 */
var LUGARES_D1 = { lista: [], cargado: false, error: null };
var editandoLugarD1 = null;
async function cargarLugaresD1(fetchImpl){
  var cont = document.getElementById('lista-lugares-d1');
  var estado = document.getElementById('lugares-d1-estado');
  var ctx = contextoTelemetriaAuto();
  if(!ctx.ok){ if(cont) cont.innerHTML=''; if(estado) estado.textContent = ctx.motivo; return; }
  try{
    var res = await (fetchImpl||fetch)(ctx.backendUrl+'/lugares?vin='+encodeURIComponent(ctx.vin), { headers:{ 'Authorization':'Bearer '+ctx.sessionToken } });
    if(res.status===501){ if(estado) estado.textContent = 'El Worker todavía no tiene el binding D1 desplegado.'; return; }
    if(!res.ok){ LUGARES_D1.error = 'HTTP '+res.status; if(estado) estado.textContent = 'No se pudieron cargar los lugares ('+LUGARES_D1.error+').'; return; }
    var body = await res.json();
    LUGARES_D1.lista = (body && body.lugares) || [];
    LUGARES_D1.cargado = true; LUGARES_D1.error = null;
  }catch(e){ LUGARES_D1.error = e.message; if(estado) estado.textContent = 'No se pudo contactar con el backend: '+e.message; return; }
  renderLugaresD1();
}
var NOMBRE_CATEGORIA_LUGAR = { casa:'Casa', trabajo:'Trabajo', otro:'Otro' };
function renderLugaresD1(){
  var cont = document.getElementById('lista-lugares-d1');
  var estado = document.getElementById('lugares-d1-estado');
  if(!cont) return;
  var lista = LUGARES_D1.lista;
  if(estado) estado.textContent = lista.length
    ? lista.length+' lugar'+(lista.length===1?'':'es')+' guardado'+(lista.length===1?'':'s')+' — se usan para clasificar viajes/cargas automáticamente'
    : 'Sin lugares guardados todavía. Añade "Casa" o "Trabajo" para que la clasificación automática los reconozca.';
  cont.innerHTML = lista.map(function(l){
    var cat = NOMBRE_CATEGORIA_LUGAR[l.category] || 'Sin categoría';
    var oculto = l.privacy_level==='oculta_en_exportaciones' ? ' · oculto en exportaciones' : '';
    return '<div class="fila">'+
      '<div class="ico" style="background:rgba(142,68,236,.12);color:#8e44ec" data-icon="pin"></div>'+
      '<div class="fila-tx" data-editar-lugar-d1="'+l.id+'"><div class="t1">'+esc(l.name)+'</div>'+
      '<div class="t2">'+cat+' · '+l.lat.toFixed(5)+', '+l.lng.toFixed(5)+' · '+Math.round(l.radius_m)+' m'+oculto+'</div></div>'+
      '<button type="button" class="btn-borrar" data-borrar-lugar-d1="'+l.id+'" data-icon="papelera" aria-label="Eliminar"></button>'+
      '</div>';
  }).join('');
  aplicarIconos();
}
function abrirFormLugarD1(l){
  editandoLugarD1 = l ? l.id : null;
  document.getElementById('fl-nombre').value = l ? l.name : '';
  document.getElementById('fl-categoria').value = l ? (l.category||'') : '';
  document.getElementById('fl-lat').value = l ? l.lat : '';
  document.getElementById('fl-lng').value = l ? l.lng : '';
  document.getElementById('fl-radio').value = (l && l.radius_m!=null) ? l.radius_m : '';
  document.getElementById('fl-oculto').checked = !!(l && l.privacy_level==='oculta_en_exportaciones');
  document.getElementById('fl-guardar').textContent = l ? 'Guardar cambios' : 'Guardar lugar';
  document.getElementById('form-lugar-d1').classList.remove('form-oculto');
}
document.getElementById('btn-add-lugar-d1').addEventListener('click', function(){ abrirFormLugarD1(null); });
document.getElementById('fl-cancelar').addEventListener('click', function(){
  editandoLugarD1 = null;
  document.getElementById('form-lugar-d1').classList.add('form-oculto');
});
document.getElementById('form-lugar-d1').addEventListener('submit', async function(e){
  e.preventDefault();
  var ctx = contextoTelemetriaAuto();
  if(!ctx.ok){ toast(ctx.motivo, true); return; }
  var lat = parseFloat(document.getElementById('fl-lat').value);
  var lng = parseFloat(document.getElementById('fl-lng').value);
  var nombre = document.getElementById('fl-nombre').value.trim();
  if(!nombre || !isFinite(lat) || !isFinite(lng)){ toast('Completa al menos nombre, latitud y longitud.', true); return; }
  var radioTexto = document.getElementById('fl-radio').value;
  var cuerpo = {
    vin: ctx.vin, name: nombre, lat: lat, lng: lng,
    category: document.getElementById('fl-categoria').value || null,
    privacy_level: document.getElementById('fl-oculto').checked ? 'oculta_en_exportaciones' : 'normal'
  };
  if(radioTexto !== '') cuerpo.radius_m = parseFloat(radioTexto);
  if(editandoLugarD1) cuerpo.id = editandoLugarD1;
  try{
    var res = await fetch(ctx.backendUrl+'/lugares', {
      method:'POST', headers:{ 'Authorization':'Bearer '+ctx.sessionToken, 'Content-Type':'application/json' }, body: JSON.stringify(cuerpo)
    });
    if(!res.ok){
      var err = await res.json().catch(function(){ return null; });
      toast('No se pudo guardar el lugar'+(err&&err.error?' ('+err.error+')':''), true);
      return;
    }
    editandoLugarD1 = null;
    document.getElementById('form-lugar-d1').classList.add('form-oculto');
    toast('Lugar guardado');
    cargarLugaresD1();
  }catch(e){ toast('No se pudo contactar con el backend: '+e.message, true); }
});
document.getElementById('lista-lugares-d1').addEventListener('click', function(e){
  var editar = e.target.closest('[data-editar-lugar-d1]');
  if(editar){
    var l = LUGARES_D1.lista.find(function(x){ return x.id===editar.dataset.editarLugarD1; });
    if(l) abrirFormLugarD1(l);
    return;
  }
  var borrar = e.target.closest('[data-borrar-lugar-d1]');
  if(!borrar) return;
  var idB = borrar.dataset.borrarLugarD1;
  var l = LUGARES_D1.lista.find(function(x){ return x.id===idB; });
  confirmarAccion('Eliminar lugar', '¿Eliminar "'+(l?l.name:'')+'"? Dejará de usarse para clasificar viajes/cargas automáticamente.', async function(){
    var ctx = contextoTelemetriaAuto();
    if(!ctx.ok){ toast(ctx.motivo, true); return; }
    try{
      var res = await fetch(ctx.backendUrl+'/lugares?id='+encodeURIComponent(idB)+'&vin='+encodeURIComponent(ctx.vin), {
        method:'DELETE', headers:{ 'Authorization':'Bearer '+ctx.sessionToken }
      });
      if(!res.ok){ toast('No se pudo eliminar el lugar.', true); return; }
      toast('Lugar eliminado');
      cargarLugaresD1();
    }catch(e){ toast('No se pudo contactar con el backend: '+e.message, true); }
  }, 'Eliminar');
});

/* ---------- B8 (FASE B) — UI completa de reglas de automatización (clasificación/precio) ----------
 * `automation_rules` (D1) ya se LEÍA y se APLICABA de verdad por el motor de Fase 4B/4C
 * (clasificarViajeConReglas/calcularCosteConReglas, en worker.js) — solo faltaba una forma de
 * administrarlas desde la app, exactamente el mismo hueco que tenía "locations" antes de B7. Los
 * desplegables de origen/destino/lugar reutilizan LUGARES_D1 (B7) — nunca una segunda fuente de
 * "lugares" del lado del cliente.
 */
var REGLAS_VIAJE = [];
var REGLAS_CARGA = [];
var editandoReglaViaje = null;
var editandoReglaCarga = null;
async function cargarReglas(fetchImpl){
  var ctx = contextoTelemetriaAuto();
  if(!ctx.ok) return; // el resto del panel de Automatización ya explica el motivo (mismo mensaje)
  try{
    var resLugares = await (fetchImpl||fetch)(ctx.backendUrl+'/lugares?vin='+encodeURIComponent(ctx.vin), { headers:{ 'Authorization':'Bearer '+ctx.sessionToken } });
    if(resLugares.ok){ var bl = await resLugares.json().catch(function(){ return null; }); if(bl) LUGARES_D1.lista = bl.lugares||[]; }
  }catch(e){ /* los desplegables de origen/destino quedarán sin opciones; las reglas ya guardadas se siguen mostrando igual */ }
  try{
    var res = await (fetchImpl||fetch)(ctx.backendUrl+'/reglas?vin='+encodeURIComponent(ctx.vin), { headers:{ 'Authorization':'Bearer '+ctx.sessionToken } });
    if(!res.ok) return;
    var body = await res.json();
    var reglas = (body && body.reglas) || [];
    REGLAS_VIAJE = reglas.filter(function(r){ return r.tipo==='clasificacion_viaje'; });
    REGLAS_CARGA = reglas.filter(function(r){ return r.tipo==='precio_carga'; });
  }catch(e){ return; }
  renderReglas();
}
function opcionesLugarSelect(seleccionId){
  return '<option value="">Cualquiera</option>'+LUGARES_D1.lista.map(function(l){
    return '<option value="'+l.id+'"'+(l.id===seleccionId?' selected':'')+'>'+esc(l.name)+'</option>';
  }).join('');
}
function nombreLugar(id){
  if(!id) return 'cualquiera';
  var l = LUGARES_D1.lista.find(function(x){ return x.id===id; });
  return l ? l.name : id;
}
var ETIQUETA_CLASIFICACION_REGLA = { trabajo:'Trabajo', personal:'Personal', otro:'Otro' };
function renderReglas(){
  var contViaje = document.getElementById('lista-reglas-viaje');
  if(contViaje){
    contViaje.innerHTML = REGLAS_VIAJE.length ? REGLAS_VIAJE.map(function(r){
      return '<div class="fila">'+
        '<div class="ico" style="background:rgba(10,132,255,.12);color:var(--acc2)" data-icon="ruta"></div>'+
        '<div class="fila-tx" data-editar-regla-viaje="'+r.id+'"><div class="t1">'+esc(nombreLugar(r.condicion.origen_location_id))+' → '+esc(nombreLugar(r.condicion.destino_location_id))+'</div>'+
        '<div class="t2">Clasifica como '+(ETIQUETA_CLASIFICACION_REGLA[r.accion.classification]||r.accion.classification)+(r.activa?'':' · inactiva')+(r.veces_usada?' · usada '+r.veces_usada+' veces':'')+'</div></div>'+
        '<button type="button" class="btn-borrar" data-borrar-regla-viaje="'+r.id+'" data-icon="papelera" aria-label="Eliminar"></button>'+
        '</div>';
    }).join('') : '<p class="txt-secundario">Sin reglas de clasificación todavía.</p>';
  }
  var contCarga = document.getElementById('lista-reglas-carga');
  if(contCarga){
    contCarga.innerHTML = REGLAS_CARGA.length ? REGLAS_CARGA.map(function(r){
      var precioTxt = r.accion.free ? 'Gratuita' : (typeof r.accion.price_kwh==='number' ? r.accion.price_kwh.toFixed(2)+' €/kWh' : (typeof r.accion.price_total==='number' ? r.accion.price_total.toFixed(2)+' € total' : '—'));
      return '<div class="fila">'+
        '<div class="ico carga" data-icon="rayo"></div>'+
        '<div class="fila-tx" data-editar-regla-carga="'+r.id+'"><div class="t1">'+esc(nombreLugar(r.condicion.location_id))+'</div>'+
        '<div class="t2">'+precioTxt+(r.activa?'':' · inactiva')+(r.veces_usada?' · usada '+r.veces_usada+' veces':'')+'</div></div>'+
        '<button type="button" class="btn-borrar" data-borrar-regla-carga="'+r.id+'" data-icon="papelera" aria-label="Eliminar"></button>'+
        '</div>';
    }).join('') : '<p class="txt-secundario">Sin reglas de precio todavía.</p>';
  }
  aplicarIconos();
}
function abrirFormReglaViaje(r){
  editandoReglaViaje = r ? r.id : null;
  document.getElementById('fr-viaje-origen').innerHTML = opcionesLugarSelect(r ? r.condicion.origen_location_id : '');
  document.getElementById('fr-viaje-destino').innerHTML = opcionesLugarSelect(r ? r.condicion.destino_location_id : '');
  document.getElementById('fr-viaje-clasificacion').value = r ? r.accion.classification : 'trabajo';
  document.getElementById('fr-viaje-activa').checked = r ? !!r.activa : true;
  document.getElementById('fr-viaje-guardar').textContent = r ? 'Guardar cambios' : 'Guardar regla';
  document.getElementById('form-regla-viaje').classList.remove('form-oculto');
}
function abrirFormReglaCarga(r){
  editandoReglaCarga = r ? r.id : null;
  document.getElementById('fr-carga-lugar').innerHTML = opcionesLugarSelect(r ? r.condicion.location_id : '');
  var tipoPrecio = r ? (r.accion.free ? 'gratuita' : (typeof r.accion.price_kwh==='number' ? 'kwh' : 'total')) : 'kwh';
  document.getElementById('fr-carga-tipo-precio').value = tipoPrecio;
  document.getElementById('fr-carga-valor').value = r ? (r.accion.price_kwh!=null?r.accion.price_kwh:(r.accion.price_total!=null?r.accion.price_total:'')) : '';
  document.getElementById('fr-carga-activa').checked = r ? !!r.activa : true;
  document.getElementById('fr-carga-guardar').textContent = r ? 'Guardar cambios' : 'Guardar regla';
  document.getElementById('form-regla-carga').classList.remove('form-oculto');
}
document.getElementById('btn-add-regla-viaje').addEventListener('click', function(){ abrirFormReglaViaje(null); });
document.getElementById('fr-viaje-cancelar').addEventListener('click', function(){ editandoReglaViaje=null; document.getElementById('form-regla-viaje').classList.add('form-oculto'); });
document.getElementById('form-regla-viaje').addEventListener('submit', async function(e){
  e.preventDefault();
  var ctx = contextoTelemetriaAuto();
  if(!ctx.ok){ toast(ctx.motivo, true); return; }
  var cuerpo = {
    vin: ctx.vin, tipo: 'clasificacion_viaje',
    condicion: {
      origen_location_id: document.getElementById('fr-viaje-origen').value || undefined,
      destino_location_id: document.getElementById('fr-viaje-destino').value || undefined
    },
    accion: { classification: document.getElementById('fr-viaje-clasificacion').value },
    activa: document.getElementById('fr-viaje-activa').checked
  };
  if(editandoReglaViaje) cuerpo.id = editandoReglaViaje;
  try{
    var res = await fetch(ctx.backendUrl+'/reglas', { method:'POST', headers:{ 'Authorization':'Bearer '+ctx.sessionToken, 'Content-Type':'application/json' }, body: JSON.stringify(cuerpo) });
    if(!res.ok){ toast('No se pudo guardar la regla.', true); return; }
    editandoReglaViaje = null;
    document.getElementById('form-regla-viaje').classList.add('form-oculto');
    toast('Regla guardada');
    cargarReglas();
  }catch(e){ toast('No se pudo contactar con el backend: '+e.message, true); }
});
document.getElementById('lista-reglas-viaje').addEventListener('click', function(e){
  var editar = e.target.closest('[data-editar-regla-viaje]');
  if(editar){ var r = REGLAS_VIAJE.find(function(x){ return x.id===editar.dataset.editarReglaViaje; }); if(r) abrirFormReglaViaje(r); return; }
  var borrar = e.target.closest('[data-borrar-regla-viaje]');
  if(!borrar) return;
  var idB = borrar.dataset.borrarReglaViaje;
  confirmarAccion('Eliminar regla', '¿Eliminar esta regla de clasificación?', async function(){
    var ctx = contextoTelemetriaAuto();
    if(!ctx.ok){ toast(ctx.motivo, true); return; }
    try{
      var res = await fetch(ctx.backendUrl+'/reglas?id='+encodeURIComponent(idB)+'&vin='+encodeURIComponent(ctx.vin), { method:'DELETE', headers:{ 'Authorization':'Bearer '+ctx.sessionToken } });
      if(!res.ok){ toast('No se pudo eliminar la regla.', true); return; }
      toast('Regla eliminada');
      cargarReglas();
    }catch(e){ toast('No se pudo contactar con el backend: '+e.message, true); }
  }, 'Eliminar');
});
document.getElementById('btn-add-regla-carga').addEventListener('click', function(){ abrirFormReglaCarga(null); });
document.getElementById('fr-carga-cancelar').addEventListener('click', function(){ editandoReglaCarga=null; document.getElementById('form-regla-carga').classList.add('form-oculto'); });
document.getElementById('form-regla-carga').addEventListener('submit', async function(e){
  e.preventDefault();
  var ctx = contextoTelemetriaAuto();
  if(!ctx.ok){ toast(ctx.motivo, true); return; }
  var tipoPrecio = document.getElementById('fr-carga-tipo-precio').value;
  var valor = parseFloat(document.getElementById('fr-carga-valor').value);
  var accion = {};
  if(tipoPrecio==='gratuita') accion.free = true;
  else if(tipoPrecio==='kwh'){ if(!isFinite(valor) || valor<=0){ toast('Introduce un €/kWh válido.', true); return; } accion.price_kwh = valor; }
  else { if(!isFinite(valor) || valor<=0){ toast('Introduce un importe total válido.', true); return; } accion.price_total = valor; }
  var cuerpo = {
    vin: ctx.vin, tipo: 'precio_carga',
    condicion: { location_id: document.getElementById('fr-carga-lugar').value || undefined },
    accion: accion,
    activa: document.getElementById('fr-carga-activa').checked
  };
  if(editandoReglaCarga) cuerpo.id = editandoReglaCarga;
  try{
    var res = await fetch(ctx.backendUrl+'/reglas', { method:'POST', headers:{ 'Authorization':'Bearer '+ctx.sessionToken, 'Content-Type':'application/json' }, body: JSON.stringify(cuerpo) });
    if(!res.ok){ toast('No se pudo guardar la regla.', true); return; }
    editandoReglaCarga = null;
    document.getElementById('form-regla-carga').classList.add('form-oculto');
    toast('Regla guardada');
    cargarReglas();
  }catch(e){ toast('No se pudo contactar con el backend: '+e.message, true); }
});
document.getElementById('lista-reglas-carga').addEventListener('click', function(e){
  var editar = e.target.closest('[data-editar-regla-carga]');
  if(editar){ var r = REGLAS_CARGA.find(function(x){ return x.id===editar.dataset.editarReglaCarga; }); if(r) abrirFormReglaCarga(r); return; }
  var borrar = e.target.closest('[data-borrar-regla-carga]');
  if(!borrar) return;
  var idB = borrar.dataset.borrarReglaCarga;
  confirmarAccion('Eliminar regla', '¿Eliminar esta regla de precio?', async function(){
    var ctx = contextoTelemetriaAuto();
    if(!ctx.ok){ toast(ctx.motivo, true); return; }
    try{
      var res = await fetch(ctx.backendUrl+'/reglas?id='+encodeURIComponent(idB)+'&vin='+encodeURIComponent(ctx.vin), { method:'DELETE', headers:{ 'Authorization':'Bearer '+ctx.sessionToken } });
      if(!res.ok){ toast('No se pudo eliminar la regla.', true); return; }
      toast('Regla eliminada');
      cargarReglas();
    }catch(e){ toast('No se pudo contactar con el backend: '+e.message, true); }
  }, 'Eliminar');
});

/* ---------- Fase 4E: panel "Automatización" (Ajustes) — pendientes, alertas y salud real ----------
 * Cliente de los endpoints reales /internal/health, /pendientes(/resolver) y /alertas(/resolver)
 * del Worker (Fase 4A-4E) — nunca simula datos. Gateado por el flag "fleet_telemetry" (desactivado
 * por defecto). Sin VIN conocido (Tesla todavía no conectada) se lo dice al usuario en vez de
 * fingir que todo está en orden. Reutiliza la misma configuración (URL + clave) que "Conexión Tesla". */
function vinAutomatizacion(){
  return (DATOS.vehiculo && DATOS.vehiculo.tesla_vin) || null;
}
function estadoAutomatizacion(msg, estadoForzado){
  var el = document.getElementById('auto-estado');
  var dot = document.getElementById('auto-estado-dot');
  if(el) el.textContent = msg;
  if(dot) dot.className = 'epunto '+(estadoForzado||'pend');
}
async function cargarAutomatizacion(){
  var vin = vinAutomatizacion();
  var contPend = document.getElementById('lista-pendientes-auto');
  var contAlert = document.getElementById('lista-alertas-auto');
  if(!vin){
    estadoAutomatizacion('Conecta primero tu Tesla (Ajustes → Conexión Tesla) para ver el estado de la automatización.', 'off');
    if(contPend) contPend.innerHTML = '<p class="txt-secundario">Sin vehículo conectado todavía.</p>';
    if(contAlert) contAlert.innerHTML = '';
    return;
  }
  var tcfg = cargarConfigTesla();
  var backendUrl = (tcfg.backendUrl || TESLA_CONFIG_POR_DEFECTO.backendUrl || '').replace(/\/$/,'');
  if(!backendUrl || !tcfg.sessionToken){
    estadoAutomatizacion('Configura antes la URL del backend y la token de sesión en "Conexión Tesla".', 'off');
    return;
  }
  estadoAutomatizacion('Comprobando…', 'busy');
  try{
    var headers = { 'Authorization': 'Bearer '+tcfg.sessionToken };
    var respuestas = await Promise.all([
      fetch(backendUrl+'/internal/health?vin='+encodeURIComponent(vin), { headers: headers }),
      fetch(backendUrl+'/pendientes?vin='+encodeURIComponent(vin), { headers: headers }),
      fetch(backendUrl+'/alertas?vin='+encodeURIComponent(vin), { headers: headers })
    ]);
    var resSalud = respuestas[0], resPend = respuestas[1], resAlertas = respuestas[2];
    if(resSalud.status===501){
      estadoAutomatizacion('El Worker todavía no tiene el binding D1 desplegado — ver infra/README.md.', 'err');
      return;
    }
    var salud = resSalud.ok ? await resSalud.json().catch(function(){ return null; }) : null;
    if(salud){
      if(!salud.sync_state){
        estadoAutomatizacion('Todavía no ha llegado ningún dato de telemetría de este vehículo.', 'off');
      } else if(salud.posible_problema){
        estadoAutomatizacion('Sin datos desde hace '+(salud.minutos_desde_ultimo_evento!=null?salud.minutos_desde_ultimo_evento+' min':'un tiempo')+' — revisa el bridge/la VM.', 'err');
      } else {
        estadoAutomatizacion('Funcionando — último dato hace '+(salud.minutos_desde_ultimo_evento!=null?salud.minutos_desde_ultimo_evento+' min':'—')+'.', 'ok');
      }
    } else {
      estadoAutomatizacion('No se pudo leer el estado del backend.', 'err');
    }
    var pendData = resPend.ok ? await resPend.json().catch(function(){ return null; }) : null;
    renderPendientesAutomatizacion(pendData && pendData.pendientes ? pendData.pendientes : []);
    var alertData = resAlertas.ok ? await resAlertas.json().catch(function(){ return null; }) : null;
    renderAlertasAutomatizacion(alertData && alertData.alertas ? alertData.alertas : []);
    // FASE A (A10): el modo real viene de /internal/health (salud.automation_mode) — se pinta el
    // botón activo y se explica en texto llano qué implica, nunca se asume "active" por defecto.
    renderModoAutomatizacion(salud && salud.automation_mode ? salud.automation_mode : 'off');
    // B15: umbral TPMS real guardado en D1 — se rellena el input con lo que ya hay configurado,
    // nunca con un valor de fábrica (si no hay nada guardado, el input queda vacío a propósito).
    try{
      var resTpms = await fetch(backendUrl+'/automatizacion/tpms-umbral?vin='+encodeURIComponent(vin), { headers: headers });
      if(resTpms.ok){
        var tpmsData = await resTpms.json().catch(function(){ return null; });
        var inputTpms = document.getElementById('tpms-umbral');
        var estadoTpms = document.getElementById('tpms-estado');
        if(tpmsData && typeof tpmsData.tpms_umbral_bar==='number'){
          if(inputTpms) inputTpms.value = tpmsData.tpms_umbral_bar;
          if(estadoTpms) estadoTpms.textContent = 'Activo: avisa si baja de '+tpmsData.tpms_umbral_bar+' bar';
        } else if(estadoTpms){
          estadoTpms.textContent = 'Sin configurar — sin umbral, nunca se avisa (no se asume un valor "seguro" por ti)';
        }
      }
    }catch(e){ /* no crítico: el resto del panel ya se ha cargado */ }
    // B8 (FASE B): reglas de clasificación/precio — no crítico para el resto del panel si falla.
    if(typeof cargarReglas==='function') cargarReglas();
  }catch(e){
    estadoAutomatizacion('No se pudo contactar con el backend: '+e.message, 'err');
  }
}
async function guardarUmbralTpms(){
  var vin = vinAutomatizacion();
  var tcfg = cargarConfigTesla();
  var backendUrl = (tcfg.backendUrl || TESLA_CONFIG_POR_DEFECTO.backendUrl || '').replace(/\/$/,'');
  var umbral = parseFloat(document.getElementById('tpms-umbral').value);
  if(!vin || !backendUrl || !tcfg.sessionToken){ toast('Conecta primero tu Tesla y configura el backend.', true); return; }
  if(!isFinite(umbral) || umbral<=0 || umbral>6){ toast('Introduce un umbral válido en bar (p.ej. 2.5).', true); return; }
  try{
    var res = await fetch(backendUrl+'/automatizacion/tpms-umbral', {
      method:'POST', headers:{ 'Authorization':'Bearer '+tcfg.sessionToken, 'Content-Type':'application/json' },
      body: JSON.stringify({ vin: vin, tpms_umbral_bar: umbral })
    });
    if(res.ok){ toast('Umbral TPMS guardado: '+umbral+' bar'); cargarAutomatizacion(); }
    else { toast('No se pudo guardar el umbral.', true); }
  }catch(e){ toast('No se pudo contactar con el backend.', true); }
}
document.getElementById('btn-guardar-tpms').addEventListener('click', guardarUmbralTpms);
function renderModoAutomatizacion(modo){
  var etiquetas = { off:'Off (nada se procesa)', shadow:'Shadow (probando, sin afectar a nada real)', active:'Active (viajes/cargas reales)' };
  var el = document.getElementById('auto-modo-actual');
  if(el) el.textContent = 'Modo actual: '+(etiquetas[modo]||modo);
  ['off','shadow','active'].forEach(function(m){
    var b = document.getElementById('btn-modo-'+m);
    if(b) b.classList.toggle('activo', m===modo);
  });
}
async function fijarModoAutomatizacion(modo){
  var vin = vinAutomatizacion();
  var tcfg = cargarConfigTesla();
  var backendUrl = (tcfg.backendUrl || TESLA_CONFIG_POR_DEFECTO.backendUrl || '').replace(/\/$/,'');
  if(!vin || !backendUrl || !tcfg.sessionToken) return;
  if(modo==='active'){
    var ok = await new Promise(function(resolve){ confirmarAccion('Activar automatización real', 'A partir de ahora los viajes y cargas detectados se guardarán como reales. Se recomienda haber probado antes varios días en modo Shadow (ver infra/README.md §9).', function(){ resolve(true); }, 'Activar', true); });
    if(!ok) return;
  }
  try{
    var res = await fetch(backendUrl+'/automatizacion/modo', {
      method:'POST', headers:{ 'Authorization':'Bearer '+tcfg.sessionToken, 'Content-Type':'application/json' },
      body: JSON.stringify({ vin: vin, modo: modo })
    });
    if(res.ok){ toast('Modo de automatización: '+modo); cargarAutomatizacion(); }
    else { toast('No se pudo cambiar el modo'); }
  }catch(e){ toast('No se pudo contactar con el backend'); }
}
(function(){
  ['off','shadow','active'].forEach(function(m){
    var b = document.getElementById('btn-modo-'+m);
    if(b) b.addEventListener('click', function(){ fijarModoAutomatizacion(m); });
  });
})();
function renderPendientesAutomatizacion(pendientes){
  var cont = document.getElementById('lista-pendientes-auto');
  if(!cont) return;
  if(!pendientes.length){ cont.innerHTML = '<p class="txt-secundario">0 pendientes — todo lo detectado se ha podido resolver solo.</p>'; return; }
  cont.innerHTML = pendientes.map(function(p){
    if(p.tipo==='clasificar_viaje'){
      var d = p.detalle||{};
      return '<div class="fila-pendiente" data-id="'+esc(p.id)+'">'
        +'<p>Viaje del '+esc(d.started_at?new Date(d.started_at).toLocaleString('es-ES'):'?')+(d.distance_km!=null?' ('+d.distance_km+' km)':'')+' sin clasificar.</p>'
        +'<div class="acciones-pendiente">'
          +'<button type="button" class="btn-secundario btn-resolver-viaje" data-id="'+esc(p.id)+'" data-clase="trabajo">Trabajo</button>'
          +'<button type="button" class="btn-secundario btn-resolver-viaje" data-id="'+esc(p.id)+'" data-clase="personal">Personal</button>'
          +'<button type="button" class="btn-secundario btn-resolver-viaje" data-id="'+esc(p.id)+'" data-clase="otro">Otro</button>'
        +'</div></div>';
    }
    if(p.tipo==='precio_carga'){
      var d2 = p.detalle||{};
      var sinEnergia = d2.energy_kwh==null;
      return '<div class="fila-pendiente" data-id="'+esc(p.id)+'">'
        +'<p>Carga del '+esc(d2.started_at?new Date(d2.started_at).toLocaleString('es-ES'):'?')+(sinEnergia?' — sin energía conocida (requiere entrada manual completa).':' ('+d2.energy_kwh+' kWh) sin precio.')+'</p>'
        +(sinEnergia?'':'<div class="acciones-pendiente">'
          +'<button type="button" class="btn-secundario btn-resolver-carga-gratis" data-id="'+esc(p.id)+'">Fue gratis</button>'
          +'<input type="number" step="0.01" min="0" class="input-precio-carga" placeholder="€ total" style="width:90px" data-id="'+esc(p.id)+'">'
          +'<button type="button" class="btn-secundario btn-resolver-carga-precio" data-id="'+esc(p.id)+'">Guardar €</button>'
        +'</div>')
        +'</div>';
    }
    return '<div class="fila-pendiente"><p>'+esc(p.tipo)+'</p></div>';
  }).join('');
}
function renderAlertasAutomatizacion(alertas){
  var cont = document.getElementById('lista-alertas-auto');
  if(!cont) return;
  if(!alertas.length){ cont.innerHTML = '<p class="txt-secundario">Sin alertas abiertas.</p>'; return; }
  cont.innerHTML = alertas.map(function(a){
    return '<div class="fila-alerta sev-'+esc(a.severity)+'" data-id="'+esc(a.id)+'">'
      +'<p>'+esc(a.mensaje)+'</p>'
      +'<button type="button" class="btn-secundario btn-descartar-alerta" data-id="'+esc(a.id)+'">Descartar</button>'
    +'</div>';
  }).join('');
}
async function resolverPendienteAutomatizacion(id, resueltoCon){
  var tcfg = cargarConfigTesla();
  var backendUrl = (tcfg.backendUrl || TESLA_CONFIG_POR_DEFECTO.backendUrl || '').replace(/\/$/,'');
  try{
    var res = await fetch(backendUrl+'/pendientes/resolver', {
      method:'POST', headers: { 'Authorization':'Bearer '+tcfg.sessionToken, 'Content-Type':'application/json' },
      body: JSON.stringify({ id: id, resuelto_con: resueltoCon })
    });
    if(!res.ok){ toast('No se pudo guardar la respuesta.'); return; }
    toast('Guardado');
    cargarAutomatizacion();
  }catch(e){ toast('No se pudo contactar con el backend: '+e.message); }
}
async function resolverAlertaAutomatizacion(id){
  var tcfg = cargarConfigTesla();
  var backendUrl = (tcfg.backendUrl || TESLA_CONFIG_POR_DEFECTO.backendUrl || '').replace(/\/$/,'');
  try{
    var res = await fetch(backendUrl+'/alertas/resolver', {
      method:'POST', headers: { 'Authorization':'Bearer '+tcfg.sessionToken, 'Content-Type':'application/json' },
      body: JSON.stringify({ id: id })
    });
    if(!res.ok){ toast('No se pudo descartar la alerta.'); return; }
    cargarAutomatizacion();
  }catch(e){ toast('No se pudo contactar con el backend: '+e.message); }
}
(function(){
  var contPend = document.getElementById('lista-pendientes-auto');
  if(contPend) contPend.addEventListener('click', function(e){
    var btnViaje = e.target.closest('.btn-resolver-viaje');
    if(btnViaje){ resolverPendienteAutomatizacion(btnViaje.dataset.id, { classification: btnViaje.dataset.clase }); return; }
    var btnGratis = e.target.closest('.btn-resolver-carga-gratis');
    if(btnGratis){ resolverPendienteAutomatizacion(btnGratis.dataset.id, { free:true }); return; }
    var btnPrecio = e.target.closest('.btn-resolver-carga-precio');
    if(btnPrecio){
      var input = document.querySelector('.input-precio-carga[data-id="'+btnPrecio.dataset.id+'"]');
      var valor = input ? parseFloat(input.value) : NaN;
      if(!isFinite(valor) || valor<0){ toast('Introduce un importe válido.'); return; }
      resolverPendienteAutomatizacion(btnPrecio.dataset.id, { total_cost: valor });
    }
  });
  var contAlert = document.getElementById('lista-alertas-auto');
  if(contAlert) contAlert.addEventListener('click', function(e){
    var btn = e.target.closest('.btn-descartar-alerta');
    if(btn) resolverAlertaAutomatizacion(btn.dataset.id);
  });
  var btnRefrescar = document.getElementById('btn-refrescar-automatizacion');
  if(btnRefrescar) btnRefrescar.addEventListener('click', cargarAutomatizacion);
})();

document.getElementById('gh-guardar-config').addEventListener('click', function(){
  var cfg = {
    repo: document.getElementById('gh-repo').value.trim(),
    path: document.getElementById('gh-path').value.trim() || 'datos.json',
    token: document.getElementById('gh-token').value.trim()
  };
  guardarConfigGithub(cfg);
  estadoSync('Configuración guardada en este dispositivo.');
});

var syncGithubEnCurso = false;
async function sincronizarGithub(opciones){
  // Legacy blob sync is suspended after cutover; keep existing credentials/pending data.
  if(!legacyBusinessPermitido()) return;
  opciones = opciones || {};
  var silencioso = !!opciones.silencioso;
  if(syncGithubEnCurso){ if(!silencioso) estadoSync('Ya hay una sincronización en curso…'); return; }
  syncGithubEnCurso = true;
  var btnSync = document.getElementById('gh-sync');
  if(btnSync){ btnSync.disabled = true; btnSync.style.opacity = '0.6'; }
  try{
    return await sincronizarGithubInterno(opciones, silencioso);
  } finally {
    syncGithubEnCurso = false;
    if(btnSync){ btnSync.disabled = false; btnSync.style.opacity = ''; }
  }
}
async function sincronizarGithubInterno(opciones, silencioso){
  var cfg = silencioso ? cargarConfigGithub() : {
    repo: document.getElementById('gh-repo').value.trim(),
    path: document.getElementById('gh-path').value.trim() || 'datos.json',
    token: document.getElementById('gh-token').value.trim()
  };
  if(!silencioso) guardarConfigGithub(cfg);
  if(!cfg.repo || !cfg.token){
    if(!silencioso) estadoSync('Falta el repositorio o el token.', true);
    return;
  }
  if(!/^[^\/\s]+\/[^\/\s]+$/.test(cfg.repo)){
    if(!silencioso) estadoSync('El repositorio debe tener el formato usuario/repo.', true);
    return;
  }
  if(typeof navigator!=='undefined' && navigator.onLine===false){
    estadoSync('Sin conexión — se sincronizará cuando vuelva la red.', true);
    return;
  }
  await comprobarPrivacidadRepo(cfg);
  var url = 'https://api.github.com/repos/'+cfg.repo+'/contents/'+cfg.path;
  if(!silencioso) estadoSync('Sincronizando…');
  var MAX_REINTENTOS_409 = 3;
  try{
    for(var intento=0; intento<=MAX_REINTENTOS_409; intento++){
      var sha = null, remoto = null;
      var resGet = await fetch(url, { headers: { Authorization: 'token '+cfg.token, Accept:'application/vnd.github+json' } });
      if(resGet.status === 200){
        var json = await resGet.json();
        sha = json.sha;
        localStorage.setItem('mitesla-last-remote-sha', sha);
        remoto = JSON.parse(b64DecodeUnicode(json.content.replace(/\n/g,'')));
      } else if(resGet.status !== 404){
        var errTxt = await resGet.text();
        throw new Error('Error al leer ('+resGet.status+'): '+errTxt.slice(0,120));
      }
      // B25 (FASE B): mientras D1 no esté disponible como fuente canónica (RepositorioDatos, B1),
      // GitHub sigue funcionando EXACTAMENTE igual que siempre — fusión de verdad en ambos
      // sentidos — porque hoy es el único mecanismo real que tiene el usuario para compartir datos
      // entre dispositivos (quitárselo sin sustituto sería NO ELIMINES FUNCIONES). En cuanto D1 sí
      // está disponible, GitHub pasa a ser solo copia de seguridad: se sigue subiendo el estado
      // actual en cada sincronización (para no perder esa función), pero nunca se vuelve a fusionar
      // lo que haya en GitHub contra los datos locales — evita que una copia de seguridad antigua o
      // de otro dispositivo pise silenciosamente los datos que D1 ya considera canónicos.
      var soloBackup = (typeof repositorioD1Disponible === 'function') && repositorioD1Disponible();
      var mismoDataset = remoto && DATOS.dataset_id && remoto.dataset_id && remoto.dataset_id === DATOS.dataset_id;
      var fusionado = (!soloBackup && remoto && (mismoDataset || !remoto.dataset_id)) ? fusionarDatos(remoto, DATOS) : DATOS;
      DATOS = conservarBusinessCanonical(fusionado);
      guardarDatos(true); // true = no relanzar autosync mientras ya estamos sincronizando
      // Reflejamos el resultado de la fusión en la UI de inmediato, aunque el PUT de abajo falle luego
      renderDashboard(); renderCargas(); renderViajes(); renderBateria(); renderGastos(); renderEstadisticas(); renderAjustes();
      renderLugares(); renderPlanes(); renderNeumaticos(); renderMantenimiento(); renderDocumentos(); renderAccesorios();
      if(mapaLeaflet) pintarFavoritosEnMapa();

      var contenido = b64EncodeUnicode(JSON.stringify(DATOS, null, 2));
      var etiquetaAccion = soloBackup ? 'Copia de seguridad' : (silencioso ? 'Sincronización automática' : 'Sincronización manual');
      var body = { message: etiquetaAccion+' desde Mi Tesla · '+new Date().toISOString(), content: contenido };
      if(sha) body.sha = sha;
      var resPut = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: 'token '+cfg.token, Accept:'application/vnd.github+json', 'Content-Type':'application/json' },
        body: JSON.stringify(body)
      });
      if(resPut.ok){
        var putJson = await resPut.json();
        if(putJson && putJson.content && putJson.content.sha) localStorage.setItem('mitesla-last-remote-sha', putJson.content.sha);
        localStorage.setItem('mitesla-ultima-sync', new Date().toISOString());
        localStorage.removeItem('mitesla-sync-pending');
        localStorage.removeItem('mitesla-sync-error');
        estadoSync(soloBackup ? ('Copia de seguridad guardada · '+new Date().toLocaleTimeString('es-ES')) : ('Sincronizado correctamente · '+new Date().toLocaleTimeString('es-ES')));
        if(!silencioso) toast(soloBackup ? 'Copia de seguridad guardada en GitHub' : 'Sincronizado con GitHub');
        return;
      }
      if(resPut.status === 409 && intento < MAX_REINTENTOS_409){
        continue; // alguien más escribió mientras tanto: se relee, se refusiona y se reintenta
      }
      var errTxt2 = await resPut.text();
      throw new Error(resPut.status===409
        ? 'Conflicto al guardar tras '+MAX_REINTENTOS_409+' reintentos — otro dispositivo está sincronizando a la vez.'
        : 'Error al guardar ('+resPut.status+'): '+errTxt2.slice(0,120));
    }
  }catch(e){
    localStorage.setItem('mitesla-sync-pending', '1');
    localStorage.setItem('mitesla-sync-error', e.message);
    estadoSync('Fallo al sincronizar: '+e.message, true);
    if(!silencioso) { /* el error ya se muestra en estadoSync */ }
  }
}

/** Avisa (una vez por hora, para no llamar a la API constantemente) si el repositorio
 *  configurado es público — los datos del coche no deberían sincronizarse sin más a un
 *  repositorio que cualquiera puede leer. */
async function comprobarPrivacidadRepo(cfg){
  try{
    var ultima = parseInt(localStorage.getItem('mitesla-privacidad-check')||'0');
    if(Date.now()-ultima < 3600000) return;
    var res = await fetch('https://api.github.com/repos/'+cfg.repo, { headers: { Authorization:'token '+cfg.token, Accept:'application/vnd.github+json' } });
    if(!res.ok) return;
    var info = await res.json();
    localStorage.setItem('mitesla-privacidad-check', String(Date.now()));
    localStorage.setItem('mitesla-repo-publico', info.private ? '0' : '1');
  }catch(e){ /* comprobación best-effort: si falla, no bloquea la sincronización */ }
}

/* ---------- Auto-sincronización: se dispara sola unos segundos después de cualquier cambio ---------- */
var autoSyncTimer = null;
function programarAutoSync(){
  if(!legacyBusinessPermitido()) return;
  var cfg = cargarConfigGithub();
  if(!cfg.repo || !cfg.token) return; // sin configurar todavía, no hacemos nada
  if(localStorage.getItem('mitesla-sync-suspendida')==='1') return; // reinicio local en curso: no descargar el remoto solo
  clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(function(){ sincronizarGithub({ silencioso:true }); }, 4000);
}
window.addEventListener('online', function(){
  var cfg = cargarConfigGithub();
  if(cfg.repo && cfg.token) sincronizarGithub({ silencioso:true });
});

document.getElementById('gh-sync').addEventListener('click', function(){
  clearTimeout(autoSyncTimer); // evita que se pisen una sincronización manual y una automática pendiente
  localStorage.removeItem('mitesla-sync-suspendida'); // sincronizar a mano reactiva la sincronización automática
  sincronizarGithub({ silencioso:false });
});

// B25 resto (FASE B): "eliminar PAT de GitHub cuando ya no sea necesario". El token nunca se
// borraba solo — se quedaba para siempre en localStorage (mitesla-github-config) aunque D1 ya
// fuese la fuente canónica y GitHub solo sirviese de copia de seguridad, o aunque el usuario
// dejase de querer sincronizar. NO se elimina la función de backup (NO ELIMINES FUNCIONES): esto
// solo da al usuario una forma explícita de borrar la credencial del navegador cuando él decida
// que ya no hace falta. Se conserva repo/path (no son secretos) para no obligar a re-teclearlos
// si vuelve a pegar el token más adelante. Patrón de doble pulsación (armar → confirmar, con
// timeout) en vez de window.confirm(): el resto de la app tampoco usa diálogos nativos del
// navegador (bloquean la extensión de Chrome/automatización y no son estilizables), y así es
// testeable sin gestionar diálogos.
(function(){
  var btn = document.getElementById('gh-eliminar-token');
  if(!btn) return;
  var TEXTO_INICIAL = btn.textContent;
  var armado = false, timeoutArmado = null;
  function desarmar(){
    armado = false;
    clearTimeout(timeoutArmado);
    btn.textContent = TEXTO_INICIAL;
    btn.classList.remove('btn-confirmar-peligro');
  }
  btn.addEventListener('click', function(){
    if(!armado){
      var cfgActual = cargarConfigGithub();
      if(!cfgActual.token){ estadoSync('No hay ninguna credencial de GitHub guardada.'); return; }
      armado = true;
      btn.textContent = '¿Seguro? Pulsa otra vez para borrar';
      btn.classList.add('btn-confirmar-peligro');
      timeoutArmado = setTimeout(desarmar, 4000);
      return;
    }
    desarmar();
    var cfg = cargarConfigGithub();
    cfg.token = ''; // se conserva repo/path: no son el secreto, y así no hay que re-teclearlos
    guardarConfigGithub(cfg);
    document.getElementById('gh-token').value = '';
    localStorage.removeItem('mitesla-sync-pending');
    localStorage.removeItem('mitesla-sync-error');
    clearTimeout(autoSyncTimer); // sin token no hay nada que auto-sincronizar
    estadoSync('Credencial de GitHub eliminada de este dispositivo. La sincronización/copia de seguridad se detiene hasta que pegues un token nuevo.');
    toast('Token de GitHub eliminado de este dispositivo');
  });
})();

/* ---------- Service Worker: registro + UX de nueva versión (punto 22) ---------- */
// A21 (FASE A, auditoría externa 2026-09-20): bug encontrado y corregido durante la verificación
// real del ciclo de vida del SW (ver tests/test_sw_actualizacion.js). EL BUG: el evento
// 'controllerchange' se dispara SIEMPRE que cambia el SW que controla la pestaña — y eso incluye
// la PRIMERÍSIMA instalación (self.clients.claim() en el activate de sw.js reclama la pestaña que
// aún no tenía ningún controlador). El código anterior escuchaba 'controllerchange' de forma
// incondicional y recargaba la página, así que cualquier usuario nuevo sufría una recarga
// automática no solicitada justo después de su primera visita — nunca se había demostrado con un
// test real que solo debía recargar en una actualización genuina (cuando YA había un controlador
// antes). LA CORRECCIÓN: se guarda si la pestaña ya estaba controlada por un SW antes de
// registrar/actualizar, y solo se recarga cuando eso era cierto — exactamente la misma condición
// que ya se usaba (correctamente) para decidir si mostrar la banda "nueva versión".
if('serviceWorker' in navigator){
  window.addEventListener('load', function(){
    var yaHabiaControladorAlCargar = !!navigator.serviceWorker.controller;

    navigator.serviceWorker.register('sw.js').then(function(reg){
      // Ya había un SW controlando la página y se detecta uno nuevo instalado: es una actualización real,
      // no la primera instalación (en la primera instalación no hay 'controller' todavía).
      reg.addEventListener('updatefound', function(){
        var nuevo = reg.installing;
        if(!nuevo) return;
        nuevo.addEventListener('statechange', function(){
          if(nuevo.state === 'installed' && navigator.serviceWorker.controller){
            document.getElementById('banda-nueva-version').style.display = 'flex';
          }
        });
      });
    }).catch(function(e){ /* PWA offline no disponible; el resto de la app funciona igual */ });

    var recargandoPorActualizacion = false; // evita el bucle de recarga si controllerchange se dispara más de una vez
    navigator.serviceWorker.addEventListener('controllerchange', function(){
      // A21: nunca recargar por el controllerchange de la primerísima instalación — solo cuando la
      // pestaña YA estaba controlada por un SW anterior (actualización real, típicamente tras
      // pulsar "Actualizar" -> SKIP_WAITING).
      if(!yaHabiaControladorAlCargar) return;
      if(recargandoPorActualizacion) return;
      recargandoPorActualizacion = true;
      window.location.reload();
    });
  });
  document.getElementById('btn-actualizar-version').addEventListener('click', function(){
    navigator.serviceWorker.getRegistration().then(function(reg){
      if(reg && reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
    });
  });
}

/* ---------- Offline real (punto 23) ---------- */
function actualizarBandaOffline(){
  document.getElementById('banda-offline').style.display = navigator.onLine ? 'none' : 'flex';
}
window.addEventListener('online', function(){
  actualizarBandaOffline();
  // al recuperar conexión, si había cambios pendientes se intenta sincronizar de forma controlada
  if(localStorage.getItem('mitesla-sync-pending') === '1' && localStorage.getItem('mitesla-sync-suspendida') !== '1'){
    sincronizarGithub({ silencioso:true });
  }
});
window.addEventListener('offline', actualizarBandaOffline);
// Micro-Work D: expose readiness for local/browser verification.
frontendStartupPromise = iniciarFrontendCanonical().then(function(){ refrescarTodasLasVistas(); }).catch(function(e){
  toast('No se pudo completar la lectura canónica. Se conserva la caché confirmada: '+e.message, true);
});
actualizarBandaOffline();
renderDashboard();
renderCargas();
renderViajes();
renderBateria();
renderGastos();
renderEstadisticas();
renderAjustes();
renderLugares();
renderPlanes();

/* Prellenar el informe de kilometraje de trabajo con el mes en curso y recordar la última tarifa usada */
(function(){
  var hoy = new Date();
  var inicioMesStr = hoy.getFullYear()+'-'+String(hoy.getMonth()+1).padStart(2,'0')+'-01';
  document.getElementById('informe-desde').value = inicioMesStr;
  document.getElementById('informe-hasta').value = fechaLocalISO();
  var tarifaGuardada = localStorage.getItem('mitesla-informe-tarifa');
  if(tarifaGuardada) document.getElementById('informe-tarifa').value = tarifaGuardada;
  document.getElementById('informe-tarifa').addEventListener('change', function(){
    if(this.value) localStorage.setItem('mitesla-informe-tarifa', this.value);
    else localStorage.removeItem('mitesla-informe-tarifa');
  });
})();

/* Fase 3, punto 2: consulta Tesla también al arrancar (antes solo se pedía al entrar en
 * Ajustes), para que el Dashboard pueda mostrar datos en vivo desde el primer momento — respeta
 * la caché de 45s de siempre, así que no añade tráfico extra si ya se acaba de consultar. */
var teslaStartupPromise = (function(){
  var cfgInicial = cargarConfigTesla();
  // No consultar vehículos automáticamente: la conexión real es un paso explícito futuro.
  if(cfgInicial.backendUrl && cfgInicial.sessionToken) return getTeslaConnectionStatus(false);
  return Promise.resolve();
})();



window.addEventListener('online', function(){
  if(backendCanonicalConfigurado() && !frontendReady){
    frontendStartupPromise = iniciarFrontendCanonical().then(refrescarTodasLasVistas).catch(function(e){
      toast('No se pudo completar la lectura canónica: '+e.message,true);
    });
  }
});
