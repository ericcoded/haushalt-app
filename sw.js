// v4 – push handler + offline cache + Android background fix
const CACHE_NAME = 'haushalt-v4';
const OFFLINE_URLS = ['/app.html', '/manifest.json', '/icons/icon-192x192.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(OFFLINE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Network-first für API-Calls, Cache-first für App-Shell
  if (e.request.url.includes('supabase') || e.request.url.includes('googleapis')) {
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// ── Push Notifications ─────────────────────────────────────────────────────
self.addEventListener('push', e => {
  // Wichtig: e.waitUntil verlängert die Service Worker Lifetime
  // Das ist der Key-Fix für Android-Hintergrund-Problem
  e.waitUntil(handlePush(e.data));
});

async function handlePush(data) {
  let payload = {};
  try {
    payload = data?.json() ?? {};
  } catch (_) {
    try { payload = { body: data?.text() }; } catch (_) {}
  }

  const title = payload.title || 'HaushaltsPRO';
  const options = {
    body: payload.body || 'Du hast eine neue Erinnerung',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-96x96.png',
    data: { url: payload.url || '/app.html' },
    tag: payload.tag || 'haushalt-reminder',
    renotify: true,
    // requireInteraction verhindert auto-dismiss auf Android
    requireInteraction: false,
    // vibrate Pattern für Android
    vibrate: [200, 100, 200],
    // actions für Android (Wisch-Aktionen)
    actions: [
      { action: 'open', title: 'Öffnen' },
      { action: 'dismiss', title: 'Schließen' }
    ]
  };

  // Zeige Notification – wichtig: return das Promise!
  return self.registration.showNotification(title, options);
}

// ── Notification Click ─────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();

  if (e.action === 'dismiss') return;

  const url = e.notification.data?.url || '/app.html';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Wenn App bereits offen → fokussieren statt neues Fenster
      for (const client of clientList) {
        if (client.url.includes('/app') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});

// ── Push Subscription Change ───────────────────────────────────────────────
// Wichtig: Wenn Browser die Subscription erneuert (z.B. nach langer Pause)
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: e.oldSubscription?.options?.applicationServerKey
    }).then(sub => {
      // Neue Subscription an Server schicken
      return fetch('/api/push-resubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          old_endpoint: e.oldSubscription?.endpoint,
          subscription: sub.toJSON()
        })
      }).catch(() => {}); // Fehler ignorieren – besser als gar nicht
    }).catch(() => {})
  );
});
