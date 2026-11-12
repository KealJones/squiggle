// The sentence-embedding model (embed.js) in its own worker, so the page can give its memory back: WebAssembly
// memory never shrinks, and terminating the worker is the only way to free it (phones need that room for the
// chat model). Messages: { type: 'load' } → { type: 'ready' } | { type: 'error', message };
// { type: 'embed', id, texts } → { type: 'vectors', id, vectors } | { type: 'error', id, message }.
const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';
const MODEL = 'Xenova/all-MiniLM-L6-v2';

let extractor = null;
let loading = null;

function load() {
  loading = loading || (async () => {
    const { pipeline, env } = await import(LIB);
    // transformers.js caches the ONNX runtime's JS and loads it from a blob: URL; load it straight from the
    // CDN instead (the browser caches it anyway).
    try { env.useWasmCache = false; } catch {}
    extractor = await pipeline('feature-extraction', MODEL, { dtype: 'q8', device: 'wasm' });
  })();
  return loading;
}

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    await load();
    if (m.type === 'load') { self.postMessage({ type: 'ready' }); return; }
    if (m.type === 'embed') {
      const vectors = [];
      for (let i = 0; i < m.texts.length; i += 16) {
        const out = await extractor(m.texts.slice(i, i + 16), { pooling: 'mean', normalize: true });
        for (const row of out.tolist()) vectors.push(Float32Array.from(row));
      }
      self.postMessage({ type: 'vectors', id: m.id, vectors }, vectors.map(v => v.buffer));
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
  }
};
