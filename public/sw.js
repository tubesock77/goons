/* Service worker: lets the app open with no signal and serves map tiles saved for offline use. */
'use strict';

const SHELL = 'shell-v3';
const API = 'api-v1';
const OFFLINE_PREFIX = 'offline-'; // one cache per saved map area, created by the page

const SHELL_FILES = [
  '/',
  '/static/app.js',
  '/static/app.css',
  '/static/data/us-states.json',
  '/static/icons/icon-192.png',
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/leaflet.css',
  '/vendor/geoman/leaflet-geoman.min.js',
  '/vendor/geoman/leaflet-geoman.css',
  '/vendor/togeojson/togeojson.umd.js',
  '/manifest.webmanifest',
];

// Map servers whose tiles may have been saved for offline use
const OFFLINE_TILE_HOSTS = ['basemap.nationalmap.gov'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    for (const url of SHELL_FILES) {
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (res.ok && !res.redirected) await cache.put(url, res);
      } catch { /* skip; it will be cached on first use */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('shell-') && name !== SHELL) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'clear-private') event.waitUntil(caches.delete(API));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Saved offline map tiles: use the saved copy first, otherwise the network
  if (OFFLINE_TILE_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const hit = await caches.match(req.url, { ignoreVary: true });
      if (hit) return hit;
      return fetch(req);
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/tiles/') || url.pathname === '/sw.js') return;
  if (url.pathname.startsWith('/api/export')) return;

  // Data: network first so everyone sees fresh changes; last saved copy when offline
  if (url.pathname.startsWith('/api/')) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(API)).put(req, res.clone());
        return res;
      } catch {
        const hit = await caches.match(req);
        if (hit) return hit;
        return new Response(JSON.stringify({ error: "You're offline and this hasn't been saved on this device yet." }),
          { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // Pages: network first, fall back to the saved app
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && !res.redirected && url.pathname === '/') (await caches.open(SHELL)).put('/', res.clone());
        return res;
      } catch {
        return (await caches.match('/')) || (await caches.match(url.pathname)) || Response.error();
      }
    })());
    return;
  }

  // App files: network first (so updates show up right away), saved copy when offline
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      return (await cache.match(req)) || Response.error();
    }
  })());
});
