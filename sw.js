/* =============================================================
 * Service Worker — Itinerary Planner
 * Cache-first for app shell, network-first fallback
 * Bumped for new files (map.js, weather.js, firebase-config.js)
 * ============================================================= */

const CACHE_NAME = 'itinerary-v17';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './map.js',
  './weather.js',
  './firebase-config.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => console.warn('SW: failed to cache', url, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache Firebase / Firestore / Nominatim / Open-Meteo / OSM tiles —
  // they need to hit the network for real-time data.
  const bypassHosts = [
    'firestore.googleapis.com', 'firebaseinstallations.googleapis.com',
    'identitytoolkit.googleapis.com', 'securetoken.googleapis.com',
    'apis.google.com', 'accounts.google.com',
    'nominatim.openstreetmap.org', 'api.open-meteo.com',
    'tile.openstreetmap.org',
  ];
  if (bypassHosts.some(h => url.hostname.endsWith(h) || url.hostname === h)) return;

  // Only handle same-origin GETs from here
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            caches.open(CACHE_NAME).then((cache) => cache.put(req, res));
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => {
        if (req.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});
