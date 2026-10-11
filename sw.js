/* Wick and the Dark Station: offline support */
const V = 'wick-v1';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', function(e){
  e.waitUntil(caches.open(V).then(function(c){ return c.addAll(SHELL); }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(ks){
    return Promise.all(ks.filter(function(k){ return k !== V && k !== 'wick-fonts'; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener('fetch', function(e){
  const r = e.request;
  if(r.method !== 'GET') return;
  const u = new URL(r.url);
  if(u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com'){
    e.respondWith(caches.open('wick-fonts').then(function(c){
      return c.match(r).then(function(hit){
        const net = fetch(r).then(function(res){ if(res && (res.ok || res.type === 'opaque')) c.put(r, res.clone()); return res; }).catch(function(){ return hit; });
        return hit || net;
      });
    }));
    return;
  }
  if(u.origin !== location.origin) return;   /* leaderboard and other APIs always go to the network */
  if(r.mode === 'navigate'){
    e.respondWith(fetch(r).then(function(res){
      const copy = res.clone(); caches.open(V).then(function(c){ c.put('index.html', copy); }); return res;
    }).catch(function(){ return caches.match('index.html'); }));
    return;
  }
  e.respondWith(caches.match(r).then(function(hit){ return hit || fetch(r); }));
});
