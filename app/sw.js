// Offline support: the app's own files are served network-first and cached,
// so Squiggle opens without a connection once it has loaded before. The model
// lives in IndexedDB (not here), and /api/* is never cached.
const CACHE = 'squiggle-app-v1';
// The natural voice's model files (tts-worker.js); kept across updates.
const KEEP = new Set([CACHE, 'squiggle-tts-v1', 'squiggle-flags']);
// "Use all CPU cores" (settings): the page has to be cross-origin isolated for
// wllama's threads (SharedArrayBuffer). When the flag is set, the app's own
// responses get COOP/COEP; everything cross-origin it loads already uses CORS
// (pinned jsDelivr files, Hugging Face downloads, the relay).
const FLAGS = 'squiggle-flags';
const ISOLATE = '/__flags/isolate';
let isolate = null;
async function isolated() {
  if (isolate === null) {
    try { isolate = Boolean(await (await caches.open(FLAGS)).match(ISOLATE)); } catch { isolate = false; }
  }
  return isolate;
}
self.addEventListener('message', (e) => { if (e.data && e.data.type === 'isolate') isolate = Boolean(e.data.on); });
function withIsolation(res) {
  if (!res || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

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
    const iso = await isolated();
    try {
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return iso ? withIsolation(res) : res;
    } catch {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      if (hit) return iso ? withIsolation(hit) : hit;
      throw new Error('offline');
    }
  })());
});
