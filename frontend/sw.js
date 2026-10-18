/**
 * Service Worker for Notes (Google Keep Alternative)
 * Provides offline shell caching and network fallback
 *
 * CACHE_NAME (audit L-12): bump the version whenever PRECACHE_ASSETS changes
 * — old caches are purged on activate, so a stale offline shell can never
 * outlive the assets it references.
 */

const CACHE_NAME = 'notes-v2';
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/logo-192.png',
  '/icons/logo-512.png',
  '/icons/logo-96.png',
  '/icons/logo-32.png',
  '/css/tokens.css',
  '/css/layout.css',
  '/css/components.css',
  '/css/landing.css',
  '/css/auth.css',
  '/css/editor.css',
  '/css/attachments.css',
  '/js/app.js',
  '/js/api.js',
  '/js/state.js',
  '/js/utils.js',
  '/js/markdown.js',
  // Audit L-12: voice-notes.js and md-import.js are statically imported by
  // keep-modal/app-events and keep-import/migration respectively — the cold
  // offline shell previously failed to load because they were never cached.
  '/js/voice-notes.js',
  '/js/md-import.js',
  '/js/keep-quick-capture.js',
  '/js/keep-modal.js',
  '/js/keep-selection.js',
  '/js/keep-lightbox.js',
  '/js/keep-labels-modal.js',
  '/js/notifications.js',
  '/js/keep-import.js',
  '/js/keep-shortcuts.js',
  '/js/keep-popovers.js',
  '/js/keep-drawing.js',
  '/js/keep-dnd.js',
  '/js/keep-sync.js',
  '/js/calendar.js',
  '/js/editor.js',
  '/js/migration.js',
  '/js/navigation.js',
  '/js/auth.js',
  '/js/workspace-data.js',
  '/js/search-filter.js',
  '/js/memo-renderer.js',
  '/js/sidebar.js',
  '/js/app-events.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('Pre-cache asset warning:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Bypass API requests from cache to ensure live database data
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Network-First with Cache fallback for static assets
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && event.request.method === 'GET') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(async () => {
        const cachedResponse = await caches.match(event.request);
        if (cachedResponse) {
          return cachedResponse;
        }
        if (event.request.mode === 'navigate') {
          return caches.match('/');
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      })
  );
});

// ==========================================================================
// Web Push: show server reminder notifications, focus the app on click
// ==========================================================================

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Notes reminder', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'Notes reminder';
  const options = {
    body: payload.body || 'You have a note reminder.',
    icon: '/icons/icon.svg',
    badge: '/icons/icon.svg',
    tag: payload.notificationId ? `note-reminder-${payload.notificationId}` : undefined,
    data: {
      memoId: payload.memoId || null,
      url: payload.url || '/',
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  const memoId = event.notification.data?.memoId;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if (memoId) {
            client.postMessage({ type: 'open-notification', memoId });
          }
          return;
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
