const CACHE_NAME = 'madar-shell-v1';
const APP_SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png'];
const SENSITIVE_PATH_PREFIXES = ['/api/', '/s/', '/auth/'];

function isSensitiveRequest(request) {
  const url = new URL(request.url);
  return (
    url.origin === self.location.origin &&
    SENSITIVE_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET' || isSensitiveRequest(request)) {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/')));
    return;
  }

  const isStaticAsset =
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest';

  if (!isStaticAsset) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
