// v3 – push handler aktiv
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request));
});

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data?.json() || {}; } catch(_) {}
  const title = data.title || 'Haushalt Erinnerung';
  const options = {
    body: data.body || '',
    icon: '/icons/icon.svg',
    badge: '/icons/icon.svg',
    data: { url: data.url || '/app' },
    tag: data.tag || 'haushalt-reminder',
    renotify: true,
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/app';
  e.waitUntil(clients.openWindow(url));
});
