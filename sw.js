/*
 * Minimal service worker. Its only job here is to exist — Chrome on Android
 * requires an active service worker before it will offer "Install app".
 * We pass through every network request untouched; no caching, no offline magic.
 * We can add proper caching later once the app is stable.
 */

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass-through: just let the browser handle every request normally.
  event.respondWith(fetch(event.request));
});
