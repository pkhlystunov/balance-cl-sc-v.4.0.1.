const CACHE_NAME = 'otipb-v77';
const ASSETS = ['./', './index.html', './app.js', './style.css', './manifest.json'];
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS))); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => { if (k !== CACHE_NAME) return caches.delete(k); }))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => { if (e.request.url.includes('://google.com')) return; e.respondWith(caches.match(e.request).then(res => res || fetch(e.request))); });
