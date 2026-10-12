/**
 * Service worker: precaches the app shell and every ES module so the app starts
 * fully offline.
 *
 * Versioning: the app's ES modules import each other, so a page must never mix
 * files from two releases. Each release lives in its own cache (CACHE_VERSION)
 * and every request is answered from the active release's cache only. A new
 * release installs in the background and WAITS; it takes over only when the
 * user taps "تحديث الآن" (SKIP_WAITING) or every tab of the app is closed.
 * Bump CACHE_VERSION with every change to a cached file.
 */

const CACHE_VERSION = 'v2.9.0';
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
  './src/core/daily.js',
  './src/core/daily-print.js',
  './src/js/storage-adapter.js',
  './src/js/license-storage.js',
  './src/js/daily-storage.js',
  './src/views/shared.js',
  './src/views/dashboard.js',
  './src/views/ledger.js',
  './src/views/accounts.js',
  './src/views/reports.js',
  './src/views/settings.js',
  './src/views/license.js',
  './src/views/daily.js'
];

self.addEventListener('install', event => {
  // No skipWaiting here: open tabs keep running the release they started with.
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_FILES.map(url => new Request(url, { cache: 'reload' })))));
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

const OFFLINE_RESPONSE = () => new Response('التطبيق غير متاح دون اتصال بعد. افتحه مرة واحدة أثناء الاتصال.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

/**
 * Cache-first from this release's cache; files outside the precache list are
 * fetched once and kept in the same release cache.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function fromRelease(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
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
    const scopePath = new URL(self.registration.scope).pathname;
    const isShell = url.pathname === scopePath || url.pathname === `${scopePath}index.html`;
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      // The app shell comes from this release so it always matches its modules.
      if (isShell) {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      try {
        return await fetch(request);
      } catch {
        return (await cache.match('./index.html')) || OFFLINE_RESPONSE();
      }
    })());
    return;
  }

  event.respondWith(fromRelease(request));
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
