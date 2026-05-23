const CACHE='repsrecord-v2';
const STATIC=['icon-192x192.png','icon-512x512.png','apple-touch-icon.png','manifest.json'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(STATIC)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});

self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);

  // Auth & API calls — always network, never cache
  if(url.hostname.includes('supabase')||url.hostname.includes('stripe')||url.hostname.includes('formspree')){
    e.respondWith(fetch(e.request));
    return;
  }

  // HTML pages — network first, fall back to cache
  if(e.request.destination==='document'||url.pathname.endsWith('.html')||url.pathname==='/'){
    e.respondWith(
      fetch(e.request).then(res=>{
        const clone=res.clone();
        caches.open(CACHE).then(c=>c.put(e.request,clone));
        return res;
      }).catch(()=>caches.match(e.request))
    );
    return;
  }

  // Static icons & manifest — cache first
  if(STATIC.some(s=>url.pathname.includes(s))){
    e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request)));
    return;
  }

  // Everything else — network first
  e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)));
});
