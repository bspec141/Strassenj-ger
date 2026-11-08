// Netzwerk zuerst (mit Timeout), sonst Cache – damit die App auch bei schlechtem Empfang startet.
const CACHE = 'strassenjaeger-v5';
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const cacheable = url.origin === location.origin || url.hostname === 'unpkg.com';
  if (!cacheable) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const timeout = url.pathname.endsWith('roads.json') ? 15000 : 4000;
    try {
      const res = await Promise.race([
        // eigene Dateien immer beim Server nachfragen (ETag), nicht 10 Min alten HTTP-Cache nehmen
        fetch(req, url.origin === location.origin ? { cache: 'no-cache' } : undefined),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeout)),
      ]);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
