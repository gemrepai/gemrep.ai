// GemRep Service Worker
const CACHE = 'gemrep-v1';
const STATIC = [
  '/',
  '/app',
  '/login',
  '/',
  '/manifest.json',
];

// Install — cache static assets
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(STATIC);
    })
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// Fetch — network first, cache fallback
self.addEventListener('fetch', function(e) {
  // Never cache API calls
  if (e.request.url.includes('/api/')) return;

  e.respondWith(
    fetch(e.request)
      .then(function(res) {
        // Cache fresh responses for static files
        if (res.ok && e.request.method === 'GET') {
          var clone = res.clone();
          caches.open(CACHE).then(function(cache) {
            cache.put(e.request, clone);
          });
        }
        return res;
      })
      .catch(function() {
        return caches.match(e.request);
      })
  );
});
