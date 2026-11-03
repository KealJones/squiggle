// Optional semantic search: a small sentence-embedding model (all-MiniLM-L6-v2,
// ~23 MB, runs on CPU via WebAssembly so it doesn't compete with Gemma for the
// GPU). Loaded lazily; if it can't load, smart context falls back to keyword
// search only.
const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';
const MODEL = 'Xenova/all-MiniLM-L6-v2';

let extractor = null;
let loading = null;
let failed = false;
const cache = new Map(); // text -> Float32Array

export const embedReady = () => Boolean(extractor);

export function loadEmbedder() {
  if (extractor || failed) return Promise.resolve(Boolean(extractor));
  loading = loading || (async () => {
    try {
      const { pipeline, env } = await import(LIB);
      // transformers.js caches the ONNX runtime's JS and loads it from a blob:
      // URL, which the page CSP blocks (semantic search then never loaded).
      // Load it straight from the CDN instead; the browser caches it anyway.
      try { env.useWasmCache = false; } catch {}
      extractor = await pipeline('feature-extraction', MODEL, { dtype: 'q8', device: 'wasm' });
      return true;
    } catch (e) {
      console.warn('Semantic search unavailable; using keyword search only.', e);
      failed = true;
      return false;
    }
  })();
  return loading;
}

// Returns embeddings for texts (or null when the model isn't available).
export async function embed(texts) {
  if (!extractor) return null;
  const todo = [...new Set(texts.filter(t => !cache.has(t)))];
  for (let i = 0; i < todo.length; i += 16) {
    const batch = todo.slice(i, i + 16).map(t => t.slice(0, 2000));
    const out = await extractor(batch, { pooling: 'mean', normalize: true });
    const rows = out.tolist();
    batch.forEach((_, j) => cache.set(todo[i + j], Float32Array.from(rows[j])));
  }
  if (cache.size > 5000) { // bound memory: drop the oldest entries
    for (const k of [...cache.keys()].slice(0, cache.size - 4000)) cache.delete(k);
  }
  return texts.map(t => cache.get(t));
}
