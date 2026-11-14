// Optional semantic search: a small sentence-embedding model (all-MiniLM-L6-v2,
// ~23 MB, runs on CPU via WebAssembly so it doesn't compete with the chat model for the
// GPU). It runs in a worker (embed-worker.js) that is terminated after a short idle
// time, since that's the only way to give its WebAssembly memory back (roughly
// 100 MB with ONNX Runtime): phones only hold it while a search runs. The next search
// starts it again (from the browser's cache). If it can't load, search falls back to
// keywords only.
const PHONE = typeof navigator !== 'undefined' && (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));
export const IDLE_MS = PHONE ? 15000 : 180000;

let enabled = false;     // loaded once without failing: later searches may restart it
let failed = false;
let worker = null, starting = null, idle = null, nextId = 1;
const pending = new Map();
const cache = new Map(); // text -> Float32Array

/** True once the model has loaded on this device (it may be asleep; embed() wakes it). */
export const embedReady = () => enabled;
/** Is the worker (and its memory) alive right now? */
export const embedAwake = () => Boolean(worker);

function stop() {
  clearTimeout(idle);
  if (worker) { try { worker.terminate(); } catch {} }
  worker = null; starting = null;
  for (const p of pending.values()) p.reject(new Error('the search model stopped'));
  pending.clear();
}
function rest() {
  clearTimeout(idle);
  idle = setTimeout(() => { if (!pending.size) stop(); }, IDLE_MS);
}

function wake() {
  if (starting) return starting;
  starting = new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(new URL('./embed-worker.js', import.meta.url), { type: 'module', name: 'squiggle-search' }); } catch (e) { reject(e); return; }
    worker = w;
    w.onerror = (e) => { try { e.preventDefault(); } catch {} const err = new Error(e && e.message || 'the search model stopped'); stop(); reject(err); };
    w.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'ready') { resolve(); return; }
      if (m.id == null) { stop(); reject(new Error(m.message || 'the search model failed')); return; }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.type === 'vectors') p.resolve(m.vectors); else p.reject(new Error(m.message));
      if (!pending.size) rest();
    };
    w.postMessage({ type: 'load' });
  });
  return starting;
}

export function loadEmbedder() {
  if (enabled || failed) return Promise.resolve(enabled);
  return wake().then(() => { enabled = true; rest(); return true; }, (e) => {
    console.warn('Semantic search unavailable; using keyword search only.', e);
    failed = true;
    return false;
  });
}

// Returns embeddings for texts (or null when the model isn't available). Wakes the worker when needed.
export async function embed(texts) {
  if (!enabled) return null;
  const todo = [...new Set(texts.filter(t => !cache.has(t)))].map(t => [t, t.slice(0, 2000)]);
  if (todo.length) {
    clearTimeout(idle);
    await wake();
    const id = nextId++;
    const vectors = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'embed', id, texts: todo.map(([, t]) => t) });
    });
    todo.forEach(([t], i) => cache.set(t, vectors[i]));
  }
  if (cache.size > 5000) { // bound memory: drop the oldest entries
    for (const k of [...cache.keys()].slice(0, cache.size - 4000)) cache.delete(k);
  }
  return texts.map(t => cache.get(t));
}
