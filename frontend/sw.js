/**
 * Service Worker for Notes (Google Keep Alternative)
 * Provides offline shell caching and network fallback
 */

const CACHE_NAME = 'notes-v1';
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon.svg',
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
  '/js/keep-quick-capture.js',
  '/js/keep-modal.js',
  '/js/keep-selection.js',
  '/js/keep-lightbox.js',
  '/js/keep-labels-modal.js',
  '/js/keep-reminders.js',
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
