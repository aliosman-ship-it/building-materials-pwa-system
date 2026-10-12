/**
 * Service worker: precaches the app shell and every ES module so the app starts
 * fully offline. Same-origin GETs use stale-while-revalidate (instant load, silent
 * update); navigations fall back to the cached shell when offline.
 */

const CACHE_VERSION = 'v2.7.0';
const CACHE_PREFIX = 'ali-othman-transport-';
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
/** Cache prefixes used by earlier builds; their caches are removed on activate. */
const OBSOLETE_PREFIXES = ['saad-alqahtani-app-'];

const CORE_FILES = [
  './',
  './index.html',
  './manifest.json',
  './assets/icons/favicon.ico',
  './assets/icons/favicon-32.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './src/css/style.css',
  './src/app.js',
  './src/core/id.js',
  './src/core/format.js',
  './src/core/dom.js',
  './src/core/icons.js',
  './src/core/ui.js',
  './src/core/view.js',
  './src/core/router.js',
  './src/core/domain.js',
  './src/core/security.js',
  './src/core/export.js',
  './src/core/license.js',
  './src/js/storage-adapter.js',
  './src/js/license-storage.js',
  './src/views/shared.js',
  './src/views/dashboard.js',
  './src/views/ledger.js',
  './src/views/accounts.js',
  './src/views/reports.js',
  './src/views/settings.js',
  './src/views/license.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CORE_FILES.map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names
        .filter(name => name !== CACHE_NAME && [CACHE_PREFIX, ...OBSOLETE_PREFIXES].some(prefix => name.startsWith(prefix)))
        .map(name => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

/**
 * Fetches from network and refreshes the cache entry.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function fetchAndCache(request) {
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone()).catch(error => console.warn('SW cache put failed:', request.url, error));
  }
  return response;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetchAndCache(request).catch(async () =>
        (await caches.match(request, { ignoreSearch: true })) ||
        (await caches.match('./index.html')) ||
        new Response('التطبيق غير متاح دون اتصال بعد. افتحه مرة واحدة أثناء الاتصال.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))
    );
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    const network = fetchAndCache(request);
    if (cached) {
      event.waitUntil(network.catch(() => undefined));
      return cached;
    }
    return network;
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
