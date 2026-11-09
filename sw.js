// Service worker: aplikasi tetap bisa dibuka offline; modul OCR disimpan di cache setelah unduhan pertama.
const CACHE = 'qc-v0.1.0';
const SHELL = ['./', './index.html', './src/app.js', './src/qc-core.js', './src/db.js', './src/ocr.js', './manifest.webmanifest', './icon.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.origin === location.origin) {
    // network-first: selalu ambil versi terbaru bila online
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
  } else if (/jsdelivr\.net$|tessdata|projectnaptha/.test(u.hostname)) {
    // cache-first untuk modul OCR & data bahasa
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; })));
  }
});
