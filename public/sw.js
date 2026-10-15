// Minimal service worker: makes the app installable (and a share target).
// Everything is fetched live; streams and sync must never come from a cache.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
