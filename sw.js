const CACHE_NAME = 'saad-alqahtani-app-v10';
const CORE_FILES = [
  './',
  './index.html',
  './manifest.json',
  './CSS/style.css',
  './JS/script.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CORE_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names
          .filter(name => name.startsWith('saad-alqahtani-app-') && name !== CACHE_NAME)
          .map(name => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  if (requestUrl.protocol !== 'http:' && requestUrl.protocol !== 'https:') return;

  event.respondWith(
    caches.match(request).then(cachedResponse => {
      if (cachedResponse) return cachedResponse;

      return fetch(request).then(networkResponse => {
        if (networkResponse.ok || networkResponse.type === 'opaque') {
          const responseCopy = networkResponse.clone();
          return caches.open(CACHE_NAME)
            .then(cache => cache.put(request, responseCopy))
            .then(() => networkResponse, cacheError => {
              console.warn('تعذر تخزين مورد مؤقتاً:', request.url, cacheError);
              return networkResponse;
            });
        }
        return networkResponse;
      }).catch(error => {
        if (request.mode === 'navigate') {
          return caches.match('./index.html').then(offlinePage => {
            if (offlinePage) return offlinePage;
            throw error;
          });
        }
        throw error;
      });
    })
  );
});
