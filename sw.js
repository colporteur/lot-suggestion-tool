/*
 * Service worker for Lot Suggestion Tool.
 *
 * Two jobs:
 *   1. Exist — Chrome on Android requires an active SW before it will offer
 *      "Install app".
 *   2. Force fresh fetches for our own JS/HTML/manifest, so when we push a
 *      change to GitHub the phone sees it on the very next pull-to-refresh
 *      (instead of waiting for GitHub Pages' 10-minute HTTP cache to expire).
 *
 * Bump SW_VERSION whenever you want to force every existing install to
 * activate this new SW immediately.
 */

const SW_VERSION = '0.3.0';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Files we want to never serve from cache. Anything else (images, fonts, CDN
// scripts) goes through the normal browser cache.
const NEVER_CACHE = ['/app.js', '/index.html', '/manifest.webmanifest'];

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // For our own app shell, force a fresh network fetch every time. The
  // `cache: 'no-store'` option tells the browser to ignore its HTTP cache
  // and not store the response either.
  const isAppShell =
    url.origin === self.location.origin &&
    (NEVER_CACHE.some((p) => url.pathname.endsWith(p)) ||
     url.pathname === '/' ||
     url.pathname.endsWith('/lot-suggestion-tool/'));

  if (isAppShell) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(() => fetch(event.request))
    );
    return;
  }

  // Pass-through for everything else.
  event.respondWith(fetch(event.request));
});
