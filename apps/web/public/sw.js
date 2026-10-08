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

function safeNotificationPath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

function readPushPayload(event) {
  if (!event.data) return { title: 'مدار', body: 'اعلان جدیدی از مدار دارید.', url: '/' };
  try {
    const value = event.data.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { title: 'مدار', body: 'اعلان جدیدی از مدار دارید.', url: '/' };
    }
    return {
      title: typeof value.title === 'string' && value.title.trim() ? value.title.trim() : 'مدار',
      body: typeof value.body === 'string' ? value.body : '',
      url: safeNotificationPath(value.url),
    };
  } catch {
    return { title: 'مدار', body: 'اعلان جدیدی از مدار دارید.', url: '/' };
  }
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

self.addEventListener('push', (event) => {
  const payload = readPushPayload(event);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: payload.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetPath = safeNotificationPath(event.notification.data?.url);
  const targetUrl = new URL(targetPath, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        if (client.url === targetUrl && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(targetPath);
    }),
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
