// Offline support: the app's own files are served network-first and cached,
// so Squiggle opens without a connection once it has loaded before. The model
// lives in IndexedDB (not here), and /api/* is never cached.
const CACHE = 'squiggle-app-v1';
// The natural voice's model files (tts-worker.js); kept across updates.
const KEEP = new Set([CACHE, 'squiggle-tts-v1']);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const name of await caches.keys()) if (!KEEP.has(name)) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const sameOrigin = url.origin === self.location.origin;
  const pinnedCdn = url.hostname === 'cdn.jsdelivr.net' && /@\d+\.\d+\.\d+/.test(url.pathname);
  if (sameOrigin && url.pathname.startsWith('/api/')) return;
  if (!sameOrigin && !pinnedCdn) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Version-pinned CDN files never change: cache-first.
    if (pinnedCdn) {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }
    try {
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw new Error('offline');
    }
  })());
});
