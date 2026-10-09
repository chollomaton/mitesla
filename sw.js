/* Service Worker de Mi Tesla — Fase 2 (punto 20-23 de la auditoría).
 *
 * IMPORTANTE: CACHE_VERSION debe subirse a la vez que APP_VERSION en app.js
 * en cada despliegue con cambios de assets. Vincula el nombre de la caché a la
 * versión real de la app en vez de dejar un 'mitesla-v1' eterno (punto 21).
 */
var CACHE_VERSION = '2026.10.09-no-car-ready';
var CACHE_ESTATICA = 'mitesla-estatica-' + CACHE_VERSION;

/* App shell mínimo: solo lo verdaderamente estático. datos.json (si existiera) y
 * cualquier API (Tesla, GitHub) NUNCA se precachean aquí — punto 20. */
var APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE_ESTATICA)
      .then(function(c){ return c.addAll(APP_SHELL); })
      // No se llama a skipWaiting() aquí: se espera a que la propia página lo pida
      // (mensaje SKIP_WAITING) tras mostrar "Nueva versión disponible" — punto 22.
  );
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(claves){
      // Se eliminan TODAS las cachés de versiones anteriores, no solo si no coincide el nombre exacto:
      // así nunca queda una caché obsoleta eternamente (punto 21).
      return Promise.all(claves.map(function(k){
        return k === CACHE_ESTATICA ? null : caches.delete(k);
      }));
    }).then(function(){ return self.clients.claim(); })
  );
});

/* Punto 22: la página envía este mensaje cuando el usuario pulsa "Actualizar"
 * tras detectar un SW nuevo en estado "waiting". */
self.addEventListener('message', function(e){
  if(e.data === 'SKIP_WAITING' || (e.data && e.data.type === 'SKIP_WAITING')) self.skipWaiting();
});

function esNavegacion(request){
  return request.mode === 'navigate' ||
    (request.method === 'GET' && request.headers.get('accept') && request.headers.get('accept').indexOf('text/html') !== -1);
}
function esApi(url){
  // Cualquier origen distinto al de la propia app (Tesla, GitHub, Open-Meteo, Open Charge Map, etc.)
  // y cualquier ruta local que sea claramente datos privados del usuario: nunca se cachean (punto 20).
  var shellBase = new URL('./', self.location.href || self.location.origin+'/sw.js').pathname;
  return url.origin !== self.location.origin || /datos\.json$/.test(url.pathname) ||
    /^\/(canonical|d1|auth|internal|pendientes|alertas|telemetry|telemetria|estado|vehicle_data|vehiculo|vehiculos|oauth|callback|push|lugares|reglas|automatizacion|backup|seleccionar-vehiculo|setup|desconectar)(?:\/|$)/.test(url.pathname) ||
    (!esAssetEstatico(url) && url.pathname !== shellBase && url.pathname !== shellBase+'index.html');
}
function esAssetEstatico(url){
  return url.origin === self.location.origin && /\.(png|jpg|jpeg|svg|webp|ico|css|js|webmanifest|woff2?)$/i.test(url.pathname);
}

self.addEventListener('fetch', function(e){
  var request = e.request;
  if(request.method !== 'GET') return; // solo GET se gestiona/cachea

  var url = new URL(request.url);

  // 1) APIs y datos privados: siempre red, nunca caché (punto 20 — "Tesla/GitHub separados,
  //    no cachearlas indiscriminadamente, no guardar datos privados en Cache Storage").
  if(esApi(url)) return; // se deja pasar sin intervenir: comportamiento normal del navegador

  // 2) Navegaciones (abrir/recargar la app): network-first con fallback offline al shell.
  //    Punto 20: "solo navigations reciben fallback HTML".
  if(esNavegacion(request)){
    e.respondWith(
      fetch(request).then(function(r){
        if(r && r.ok){
          var copia = r.clone();
          caches.open(CACHE_ESTATICA).then(function(c){ c.put('./index.html', copia); });
        }
        return r;
      }).catch(function(){
        return caches.match('./index.html').then(function(m){
          return m || new Response('<h1>Sin conexión</h1><p>Mi Tesla no se pudo cargar y no hay copia local disponible todavía.</p>', { headers:{'Content-Type':'text/html; charset=utf-8'}, status:503 });
        });
      })
    );
    return;
  }

  // 3) Assets estáticos propios (iconos, manifest, futuros css/js): stale-while-revalidate.
  //    Punto 20: "una imagen/JS/CSS ausente no recibe HTML" — si falla y no hay copia en caché,
  //    se deja que el error de red normal llegue al navegador, nunca se sirve index.html.
  if(esAssetEstatico(url)){
    e.respondWith(
      caches.open(CACHE_ESTATICA).then(function(c){
        return c.match(request).then(function(cacheado){
          var redFetch = fetch(request).then(function(r){
            if(r && r.ok) c.put(request, r.clone()); // solo se cachean respuestas correctas
            return r;
          }).catch(function(){ return null; });
          return cacheado || redFetch;
        });
      })
    );
    return;
  }

  // 4) Cualquier otra petición GET same-origin no reconocida: se deja pasar sin intervenir.
});

/* Punto 19: notificaciones mostradas a través del Service Worker (showAppNotification en index.html
 * llama a registration.showNotification, que dispara este evento al pulsarlas). La sección a abrir
 * viaja en notification.data.seccion — si la app ya está abierta en una pestaña, se le pide que
 * navegue ahí sin recargar; si no, se abre una pestaña nueva directamente en esa sección. */
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  var seccion = (e.notification.data && e.notification.data.seccion) || '';
  e.waitUntil(
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(function(lista){
      for(var i=0;i<lista.length;i++){
        if('focus' in lista[i]){
          if(seccion) lista[i].postMessage({ tipo:'ABRIR_SECCION', seccion:seccion });
          return lista[i].focus();
        }
      }
      if(self.clients.openWindow) return self.clients.openWindow('./index.html' + (seccion ? '#'+seccion : ''));
    })
  );
});

/* Fase 3 / B16, punto 19: Web Push real — backend → Push API → Service Worker. Desde B16 el
 * backend (worker.js: enviarPushesAlertasPendientes, por Cron Trigger) firma cada push con VAPID
 * real y cifra el payload (RFC 8291), así que este listener ya recibe pushes de verdad en cuanto
 * el dispositivo está suscrito (ver activarWebPush en app.js) y hay una alerta que avisar. payload
 * lleva {title, body, seccion, categoria} — seccion es a dónde navega notificationclick (más abajo)
 * al pulsar la notificación, y categoria es el tag con el que el propio navegador deduplica. */
self.addEventListener('push', function(e){
  var payload = { title:'Mi Tesla', body:'' };
  try{ if(e.data) payload = Object.assign(payload, e.data.json()); }catch(err){}
  e.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      data: { seccion: payload.seccion || '', categoria: payload.categoria || '' },
      tag: payload.categoria || undefined // el propio navegador deduplica notificaciones con el mismo tag (punto 19: dedupe)
    })
  );
});
