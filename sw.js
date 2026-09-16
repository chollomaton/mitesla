var CACHE = 'mitesla-v1';
var SHELL = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(SHELL); }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(ks){
    return Promise.all(ks.map(function(k){ return k === CACHE ? null : caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener('fetch', function(e){
  var url = new URL(e.request.url);
  if(e.request.method !== 'GET') return;
  if(url.origin !== location.origin || /datos\.json/.test(url.pathname)) return;
  e.respondWith(
    fetch(e.request).then(function(r){
      var copia = r.clone();
      caches.open(CACHE).then(function(c){ c.put(e.request, copia); });
      return r;
    }).catch(function(){
      return caches.match(e.request).then(function(m){ return m || caches.match('./index.html'); });
    })
  );
});
