// Neural text-to-speech in a Web Worker, so synthesis never blocks the page
// and terminating the worker gives all of its memory back.
//
// ONNX Runtime Web (CPU/WASM build, single thread) runs the voice model;
// eSpeak NG (the phonemizer package, plain JS) turns text into phonemes. Both
// load from version-pinned jsDelivr URLs; model and voice files come from
// Hugging Face at a pinned commit and are kept in Cache Storage.
//
// Messages in:  {type:'load', model, voice}   {type:'speak', id, text, speed, voice}   {type:'cancel'}
// Messages out: {type:'stage', stage}  {type:'progress', loaded, total}  {type:'ready', ms, cached}
//               {type:'audio', id, samples, sampleRate, ms}  {type:'error', id?, message}  {type:'cancelled', id}
import { TTS_MODELS, TTS_CACHE as CACHE, modelUrl, voiceUrl, validVoice, toPhonemes, tokenize, styleFor, readNpz, tidyAudio, halve, normalizeText, MAX_TOKENS, STYLE_DIM } from './tts-text.js';

const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const PHONEMIZER = 'https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/dist/phonemizer.js';

let ort = null, espeak = null, session = null, modelId = null;
const voices = new Map(); // voice id -> Float32Array (rows × 256)
const queue = [];
let busy = false;

const post = (m, transfer) => self.postMessage(m, transfer || []);
const stage = (s) => post({ type: 'stage', stage: s });
const message = (e) => String(e && e.message || e || 'unknown error');

// Downloads into one preallocated buffer (no chunk list + concat copy: memory
// is the constraint on phones), then stores it for next time.
async function fetchCached(url, onProgress) {
  let cache = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) return { bytes: new Uint8Array(await hit.arrayBuffer()), cached: true };
  } catch { cache = null; }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  let bytes;
  if (res.body && total) {
    bytes = new Uint8Array(total);
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > bytes.length) { const b = new Uint8Array(Math.ceil((got + value.length) * 1.25)); b.set(bytes.subarray(0, got)); bytes = b; }
      bytes.set(value, got);
      got += value.length;
      onProgress && onProgress(got, total);
    }
    if (got !== bytes.length) bytes = bytes.slice(0, got);
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
    onProgress && onProgress(bytes.length, bytes.length);
  }
  if (cache) { try { await cache.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })); } catch {} }
  return { bytes, cached: false };
}

async function loadVoice(voice) {
  voice = validVoice(modelId, voice);
  if (voices.has(voice)) return voices.get(voice);
  const { bytes } = await fetchCached(voiceUrl(modelId, voice));
  let table;
  if (modelId === 'kokoro') {
    table = new Float32Array(bytes.length / 4);
    new Uint8Array(table.buffer).set(bytes);
  } else {
    table = readNpz(bytes, voice);
  }
  if (table.length < STYLE_DIM) throw new Error('voice file is empty');
  voices.set(voice, table);
  return table;
}

async function load({ model = 'kokoro', voice } = {}) {
  const t0 = performance.now();
  if (!TTS_MODELS[model]) throw new Error(`unknown voice model ${model}`);
  if (typeof WebAssembly !== 'object') throw new Error('this browser has no WebAssembly');
  modelId = model;
  stage('starting the voice runtime');
  const [o, ph] = await Promise.all([import(ORT_BASE + 'ort.wasm.min.mjs'), import(PHONEMIZER)]);
  ort = o.default && o.default.InferenceSession ? o.default : o;
  espeak = ph.phonemize;
  // One thread (no SharedArrayBuffer without cross-origin isolation) and no
  // proxy worker; the runtime's .mjs/.wasm load straight from the CDN, never
  // through a blob: URL.
  ort.env.wasm.wasmPaths = ORT_BASE;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  stage('downloading the voice model');
  let { bytes, cached } = await fetchCached(modelUrl(model), (loaded, total) => post({ type: 'progress', loaded, total }));
  await loadVoice(voice);
  stage('loading the voice model');
  // No memory arena: inputs change size every sentence, and the arena would
  // keep the largest allocation around for the life of the session.
  session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', enableCpuMemArena: false });
  bytes = null; // the runtime has its own copy now
  stage('warming up');
  await speak('Hi.', 1, voice);
  post({ type: 'ready', ms: Math.round(performance.now() - t0), cached });
}

// KittenTTS's own inference splits at sentence ends (dropping the mark) and
// ends every chunk with punctuation, adding a comma if needed.
function kittenChunks(text) {
  const out = [];
  for (let s of normalizeText(text).split(/[.!?]+/)) {
    s = s.trim();
    if (!s) continue;
    out.push(/[.!?,;:]$/.test(s) ? s : s + ',');
  }
  return out;
}

async function run(text, speed, voice) {
  const ph = await toPhonemes(text, { espeak, model: modelId, voice });
  const ids = tokenize(ph, modelId);
  if (ids.length - 2 > MAX_TOKENS - 10 && text.length > 16) {
    const parts = [];
    for (const half of halve(text)) parts.push(await run(half, speed, voice));
    return concat(parts);
  }
  const table = await loadVoice(voice);
  const style = styleFor(table, modelId, { ids, text });
  const m = TTS_MODELS[modelId];
  const pace = modelId === 'kitten' ? (m.speedPriors[validVoice(modelId, voice)] || m.speedPrior) : 1;
  const feeds = {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    style: new ort.Tensor('float32', style, [1, STYLE_DIM]),
    speed: new ort.Tensor('float32', new Float32Array([Math.min(2, Math.max(0.5, speed || 1)) * pace]), [1]),
  };
  const out = await session.run(feeds);
  const wave = out[session.outputNames[0]];
  let samples = wave.data;
  if (modelId === 'kitten') samples = samples.subarray(0, Math.max(0, samples.length - 5000));
  samples = tidyAudio(samples, m.sampleRate);
  for (const t of Object.values(out)) { try { t.dispose(); } catch {} }
  return samples;
}

function concat(parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function speak(text, speed, voice) {
  if (modelId === 'kitten') {
    const parts = [];
    for (const chunk of kittenChunks(text)) parts.push(await run(chunk, speed, voice));
    return concat(parts);
  }
  return run(text, speed, voice);
}

async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const job = queue.shift();
    const t0 = performance.now();
    try {
      const samples = await speak(job.text, job.speed, job.voice);
      post({ type: 'audio', id: job.id, samples, sampleRate: TTS_MODELS[modelId].sampleRate, ms: Math.round(performance.now() - t0) }, [samples.buffer]);
    } catch (e) {
      post({ type: 'error', id: job.id, message: message(e) });
    }
  }
  busy = false;
}

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === 'load') {
    try { await load(m); } catch (err) { post({ type: 'error', message: message(err) }); }
  } else if (m.type === 'speak') {
    if (!session) { post({ type: 'error', id: m.id, message: 'the voice model is not loaded' }); return; }
    queue.push(m);
    drain();
  } else if (m.type === 'cancel') {
    for (const job of queue.splice(0)) post({ type: 'cancelled', id: job.id });
  }
};
