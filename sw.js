const CACHE_NAME = 'otipb-v82';
const ASSETS = ['./', './index.html', './app.js', './style.css', './manifest.json'];
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS))); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => { if (k !== CACHE_NAME) return caches.delete(k); }))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  // Не перехватываем запросы к API (functions.yandexcloud.net) и к google.com
  if (e.request.url.includes('functions.yandexcloud.net')) return;
  if (e.request.url.includes('://google.com')) return;
  // Стратегия stale-while-revalidate: сначала отдаём из кеша (мгновенно),
  // затем обновляем кеш из сети в фоне (актуальные файлы при следующем открытии).
  e.respondWith(caches.match(e.request).then(cached => {
    const fetchPromise = fetch(e.request).then(response => {
      if (response && response.ok && (e.request.method === 'GET')) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      }
      return response;
    }).catch(() => cached);
    return cached || fetchPromise;
  }));
});
