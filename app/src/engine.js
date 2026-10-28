// Models. Gemma 4 E2B/E4B run on this device through LiteRT-LM on WebGPU;
// Gemma 3 270M runs on the CPU through wllama (engine-wllama.js) and is the
// phone default; the cloud model (Gemma 4 26B) runs on the relay (engine-cloud.js). Handles
// the one-time resumable download into IndexedDB, engine startup, and
// streaming generation with tools.
import { kv, mutex } from './util.js';

const LITERT = 'https://cdn.jsdelivr.net/npm/@litert-lm/core@0.14.0/+esm';
const HF = 'https://huggingface.co/';

// phone: small enough for a phone's per-tab memory. size: download size.
export const MODELS = {
  E4B: { label: 'Gemma 4 E4B', size: '3.0 GB', note: 'smartest on-device model, best with tools', phone: false, runtime: 'litert',
    url: HF + 'litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm' },
  E2B: { label: 'Gemma 4 E2B', size: '2.0 GB', note: 'faster, still good with tools', phone: false, runtime: 'litert',
    url: HF + 'litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm' },
  G3: { label: 'Gemma 3 270M', size: '242 MB', note: 'tiny and fast; runs on a phone\'s CPU, no WebGPU needed. Chat only: no tools or web lookups, and it often gets facts wrong', phone: true, runtime: 'wllama',
    url: HF + 'unsloth/gemma-3-270m-it-GGUF/resolve/main/gemma-3-270m-it-Q4_0.gguf', bytes: 241574944 },
  // Not on this device: runs on the relay (only listed when the relay offers it).
  cloud: { label: 'Gemma 4 26B (Cloudflare)', size: 'no download', note: 'bigger and smarter, runs on your Cloudflare relay; chats leave this device. Free daily limit, then it pauses until midnight UTC.', phone: true, runtime: 'cloud', needsRelay: true },
};

// Every file a model needs (none for the cloud model).
export function modelFiles(id) {
  const m = MODELS[id];
  if (!m) throw new Error(`Unknown model "${id}".`);
  return m.runtime === 'litert' ? [{ url: m.url }] : [];
}

const FLUSH_BYTES = 16 * 1024 * 1024;
const STALL_MS = 45000;

let lib = null;
let engine = null;
let loadedModel = null;
let engineContext = 0;
const genLock = mutex();          // one generation at a time
let activeConv = null;
let bgBusy = false;

export const engineReady = () => Boolean(engine);
export const currentModel = () => loadedModel;
// The small CPU model (prompt-based tools, short system prompt).
export const isLite = (id = loadedModel) => Boolean(MODELS[id] && MODELS[id].runtime === 'wllama');
// A small model with no tool training (stock Gemma 3 270M) can't follow the
// harness: any system prompt makes it answer the instructions instead of the
// person ("Okay, I'm ready to be Squiggle!"). It runs as plain chat: no system
// prompt, no tools, no background summaries. A fine-tuned build sets `tools: true`.
export const chatOnly = (id = loadedModel) => isLite(id) && !(MODELS[id] && MODELS[id].tools);

export async function webgpuStatus() {
  if (!('gpu' in navigator)) return { ok: false, reason: 'This browser has no WebGPU. Use a recent Chrome, Edge, or Safari (iOS/macOS 26+).' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: 'WebGPU is present but no GPU adapter is available.' };
    return { ok: true, adapter };
  } catch (e) {
    return { ok: false, reason: 'WebGPU failed to start: ' + e.message };
  }
}

// A short description of the GPU, for crash reports.
export async function gpuSummary() {
  try {
    const a = await navigator.gpu?.requestAdapter();
    if (!a) return 'no WebGPU adapter';
    const i = a.info || {};
    return [i.vendor, i.architecture].filter(Boolean).join(' ') + (a.features.has('shader-f16') ? ', f16' : ', no f16') + `, max buffer ${Math.round(a.limits.maxBufferSize / 1048576)} MB`;
  } catch (e) { return 'WebGPU error: ' + (e.message || e); }
}

// Phones and tablets: tighter per-tab memory limits (iOS Safari kills a tab
// that goes over), so they get lighter defaults. iPadOS reports as a Mac.
export function isMobile() {
  const ua = navigator.userAgent;
  return /Android|iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

// The model for this device: computers run E4B; phones run Gemma 3 270M on
// the CPU, because Gemma 4 doesn't fit a phone browser tab's memory (iOS
// Safari kills the tab). Phones can still pick the cloud model.
export function deviceModel() {
  return isMobile() ? 'G3' : 'E4B';
}
// Runs without WebGPU (CPU only).
export const needsGpu = (id) => Boolean(MODELS[id] && MODELS[id].runtime === 'litert');
export const suggestModel = deviceModel;
export const modelFitsDevice = (id) => !isMobile() || Boolean(MODELS[id] && MODELS[id].phone);

// ── Download (resumable, chunked into IndexedDB) ──────────────────────────

const metaKey = (url) => 'model-meta:' + url;
const recSize = (r) => (r == null ? 0 : r.size ?? r.byteLength);

export async function downloadInfo(id) {
  const wm = MODELS[id];
  if (wm && wm.runtime === 'wllama') {
    const done = await (await import('./engine-wllama.js')).isDownloaded(wm.url);
    return { total: wm.bytes, stored: done ? wm.bytes : 0, complete: done };
  }
  let total = 0, stored = 0, complete = true;
  for (const f of modelFiles(id)) {
    const m = (await kv.get(metaKey(f.url))) || { total: 0, stored: 0, complete: false };
    total += m.total || f.size; stored += m.stored || 0; complete = complete && m.complete;
  }
  return { total, stored, complete };
}

// One download at a time per device: a lock shared by every tab and window,
// so extra taps, reloads or a second tab never start a parallel download
// (which would interleave writes and corrupt the stored model). A tab that
// finds the lock taken calls onWaiting, then waits its turn; by then the
// model is usually complete and it returns immediately.
const DOWNLOAD_LOCK = 'squiggle-model-download';

export async function download(id, onProgress, signal, { onWaiting } = {}) {
  if (!navigator.locks) return downloadUnlocked(id, onProgress, signal);
  const done = await navigator.locks.request(DOWNLOAD_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) return false;
    await downloadUnlocked(id, onProgress, signal);
    return true;
  });
  if (done) return;
  onWaiting && onWaiting();
  await navigator.locks.request(DOWNLOAD_LOCK, signal ? { signal } : {}, () => downloadUnlocked(id, onProgress, signal));
}

async function downloadUnlocked(id, onProgress, signal) {
  if ((await downloadInfo(id)).complete) return;
  if (MODELS[id].runtime === 'wllama') {
    try { await navigator.storage?.persist?.(); } catch {}
    return (await import('./engine-wllama.js')).downloadModel(MODELS[id].url, onProgress, signal);
  }
  const files = modelFiles(id);
  const metas = await Promise.all(files.map(f => kv.get(metaKey(f.url))));
  const sizes = files.map((f, i) => (metas[i] && metas[i].total) || f.size);
  const grand = sizes.every(Boolean) ? sizes.reduce((a, b) => a + b, 0) : 0;
  let before = 0;
  for (let i = 0; i < files.length; i++) {
    const base = before;
    await downloadFile(files[i], (got, total) => onProgress && onProgress(base + got, grand || total), signal);
    before += (await kv.get(metaKey(files[i].url)))?.total || sizes[i];
  }
}

async function downloadFile({ url }, onProgress, signal) {
  const meta = (await kv.get(metaKey(url))) || { total: 0, stored: 0, complete: false };
  if (meta.complete) { onProgress && onProgress(meta.total, meta.total); return; }
  try { await navigator.storage?.persist?.(); } catch {}

  let offset = 0;
  const offsets = await chunkOffsets(url);
  for (const off of offsets) {
    const rec = await kv.get([url, off], 'model');
    if (!rec || off !== offset) break;
    offset += recSize(rec);
  }
  // Drop anything after a gap (shouldn't happen, but keeps resume correct).
  for (const off of offsets) if (off >= offset) await kv.del([url, off], 'model');
  onProgress && onProgress(offset, meta.total || 0);

  const ctrl = new AbortController();
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  let watchdog;
  const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => ctrl.abort(), STALL_MS); };

  arm();
  const resp = await fetch(url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: ctrl.signal })
    .finally(() => clearTimeout(watchdog));
  let total;
  if (resp.status === 416) {
    total = offset;
  } else {
    if (!resp.ok) throw new Error(`Model download failed (HTTP ${resp.status}).`);
    if (offset && resp.status === 200) { // server ignored Range: start over
      for (const off of await chunkOffsets(url)) await kv.del([url, off], 'model');
      offset = 0;
    }
    const cr = resp.headers.get('content-range');
    const m = cr && cr.match(/\/(\d+)\s*$/);
    total = m ? +m[1] : offset + +(resp.headers.get('content-length') || 0);
    const reader = resp.body.getReader();
    let pending = [], pendingBytes = 0, batchStart = offset, got = offset;
    const flush = async () => {
      if (!pending.length) return;
      const batch = new Uint8Array(pendingBytes);
      let o = 0;
      for (const c of pending) { batch.set(c, o); o += c.byteLength; }
      pending = []; pendingBytes = 0;
      await kv.set([url, batchStart], batch, 'model');
      batchStart += batch.byteLength;
      await kv.set(metaKey(url), { total, stored: batchStart, complete: false });
    };
    try {
      arm();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        pending.push(value); pendingBytes += value.byteLength; got += value.byteLength;
        onProgress && onProgress(got, total);
        if (pendingBytes >= FLUSH_BYTES) await flush();
      }
      clearTimeout(watchdog);
      await flush();
    } catch (e) {
      clearTimeout(watchdog);
      await flush().catch(() => {});
      if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) throw new Error('This device ran out of storage space for the model. Free up some space (or pick a smaller model in Settings), then tap Resume.');
      throw new Error(e && e.name === 'AbortError' ? 'Download paused. Tap Resume to continue where it stopped.' : (e.message || String(e)));
    }
  }
  const stored = await storedBytes(url);
  if (total && stored !== total) throw new Error('Download incomplete. Tap Resume to continue.');
  await kv.set(metaKey(url), { total, stored, complete: true });
}

async function chunkOffsets(url) {
  const keys = await kv.keys(IDBKeyRange.bound([url, 0], [url, Infinity]), 'model');
  return keys.map(k => k[1]).sort((a, b) => a - b);
}

async function storedBytes(url) {
  let n = 0;
  for (const off of await chunkOffsets(url)) n += recSize(await kv.get([url, off], 'model'));
  return n;
}

export async function deleteModel(id) {
  if (MODELS[id] && MODELS[id].runtime === 'wllama') return (await import('./engine-wllama.js')).removeModel(MODELS[id].url);
  for (const { url } of modelFiles(id)) {
    for (const off of await chunkOffsets(url)) await kv.del([url, off], 'model');
    await kv.del(metaKey(url));
  }
}

const asBytes = async (rec) => (rec instanceof Blob ? new Uint8Array(await rec.arrayBuffer()) : rec);

function modelStream(url, offsets) {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= offsets.length) { controller.close(); return; }
      const rec = await kv.get([url, offsets[i++]], 'model');
      if (!rec) { controller.error(new Error('Model data is missing; download it again.')); return; }
      controller.enqueue(await asBytes(rec));
    },
  }, new CountQueuingStrategy({ highWaterMark: 1 }));
}

// Frees space taken by downloads of models Squiggle no longer offers (and,
// on phones, ones that can't run there). Returns the bytes freed.
export async function cleanupStorage({ keep = null } = {}) {
  const wanted = new Set(Object.keys(MODELS).filter(id => !keep || keep(id)).flatMap(id => modelFiles(id).map(f => f.url)));
  let freed = 0;
  for (const key of await kv.keys()) {
    if (typeof key === 'string' && key.startsWith('model-meta:') && !wanted.has(key.slice(11))) {
      freed += ((await kv.get(key)) || {}).stored || 0;
      await kv.del(key);
    }
  }
  for (const key of await kv.keys(undefined, 'model')) {
    if (Array.isArray(key) && !wanted.has(key[0])) await kv.del(key, 'model');
  }
  return freed;
}

// ── Engine ────────────────────────────────────────────────────────────────

// fast: multi-token prediction (Gemma 4's speculative drafter). Noticeably
// faster replies, but it loads an extra small model, so it costs memory.
let engineFast = null;
// onStage(text) reports each loading step (the UI keeps the last one, so a
// tab that dies mid-load can say where).
// While a reply is generated on this device, progress('writing the reply')
// is reported, then null when done, so a tab killed mid-reply can say so.
let progress = () => {};
export const setProgress = (fn) => { progress = fn || (() => {}); };
export async function load(id, contextSize, { fast = true, onStage = () => {} } = {}) {
  if (engine && loadedModel === id && engineContext === contextSize && engineFast === fast) return;
  await unload();
  if (MODELS[id].runtime === 'cloud') {
    engine = (await import('./engine-cloud.js')).createEngine();
    loadedModel = id; engineContext = contextSize; engineFast = fast;
    return;
  }
  if (MODELS[id].runtime === 'wllama') {
    engine = await (await import('./engine-wllama.js')).createEngine(MODELS[id].url, contextSize, onStage);
    loadedModel = id; engineContext = contextSize; engineFast = fast;
    return;
  }
  onStage('starting the runtime');
  lib = lib || await import(LITERT);
  onStage('loading the model onto the GPU');
  const url = MODELS[id].url;
  const offsets = await chunkOffsets(url);
  if (!offsets.length) throw new Error('Model is not downloaded yet.');
  const base = { maxNumTokens: contextSize };
  engineFast = fast;
  if (!fast) {
    engine = await lib.Engine.create({ model: modelStream(url, offsets), mainExecutorSettings: base });
    loadedModel = id; engineContext = contextSize;
    return;
  }
  try {
    // Multi-token prediction (Gemma 4's speculative drafter) is notably faster;
    // fall back to a plain config if the GPU rejects it.
    engine = await lib.Engine.create({
      model: modelStream(url, offsets),
      backend: lib.Backend.GPU_ARTISAN,
      mainExecutorSettings: { ...base, backendConfig: {
        num_output_candidates: 1, wait_for_weight_uploads: true, num_decode_steps_per_sync: 1,
        sequence_batch_size: 0, supported_lora_ranks: [], max_top_k: 64,
        enable_decode_logits: false, enable_external_embeddings: false, use_submodel: true,
      } },
    });
  } catch (e) {
    console.warn('Fast (MTP) engine config failed; retrying plain:', e);
    engine = await lib.Engine.create({ model: modelStream(url, offsets), mainExecutorSettings: base });
  }
  loadedModel = id;
  engineContext = contextSize;
}

export async function unload() {
  if (!engine) return;
  try { await engine.delete(); } catch {}
  engine = null; loadedModel = null;
}

const SAMPLER = { type: 2, p: 0.95, k: 64, temperature: 0.7 };
const GREEDY = { type: 3 };

// Starts a conversation from a preface: system text, prior turns, tools.
export async function conversation({ system, messages = [], tools = [], thinking = false, maxOutputTokens = 2048, greedy = false, known = [] }) {
  if (!engine) throw new Error('Model not loaded.');
  const preface = {
    messages: [{ role: 'system', content: system }, ...messages],
    extra_context: { enable_thinking: thinking },
  };
  if (tools.length) preface.tools = tools.map(t => ({ type: 'function', function: t }));
  // The small model only sees details of tools it has looked up (engine-wllama.js).
  if (isLite() && known.length) preface.known = known;
  const cfg = { preface, sessionConfig: { maxOutputTokens, samplerParams: greedy ? GREEDY : SAMPLER } };
  try {
    return await engine.createConversation(cfg);
  } catch (e) {
    if (!preface.tools) throw e;
    console.warn('Conversation with tools failed; retrying without tools:', e);
    delete preface.tools;
    return engine.createConversation(cfg);
  }
}

// Streams one model response. Returns { text, thinking, toolCalls }.
export async function respond(conv, input, { onText, onThinking, signal } = {}) {
  activeConv = conv;
  const local = MODELS[loadedModel] && MODELS[loadedModel].runtime !== 'cloud';
  if (local) progress('writing the reply');
  const out = { text: '', thinking: '', toolCalls: [] };
  const abort = () => { try { conv.cancel(); } catch {} };
  if (signal) signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of conv.sendMessageStreaming(input)) {
      const th = thinkingOf(chunk);
      if (th) { out.thinking += th; onThinking && onThinking(out.thinking); }
      if (Array.isArray(chunk.tool_calls)) out.toolCalls.push(...chunk.tool_calls);
      let t = '';
      if (typeof chunk.content === 'string') t = chunk.content;
      else if (Array.isArray(chunk.content)) for (const p of chunk.content) if (p.type === 'text') t += p.text;
      if (t) { out.text += t; onText && onText(out.text); }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', abort);
    if (activeConv === conv) activeConv = null;
    if (local) progress(null);
  }
  return out;
}

function thinkingOf(chunk) {
  let s = '';
  for (const k of ['thinking', 'reasoning', 'reasoning_content', 'thought']) {
    const v = chunk[k];
    if (typeof v === 'string') s += v;
  }
  if (chunk.channels) for (const [k, v] of Object.entries(chunk.channels)) if (typeof v === 'string' && /think|thought|reason/i.test(k)) s += v;
  if (Array.isArray(chunk.content)) for (const p of chunk.content) if (p && p.type && p.type !== 'text' && /think|thought|reason/i.test(p.type) && typeof p.text === 'string') s += p.text;
  return s;
}

// Foreground work (the person's turn) — waits for, and pre-empts, background jobs.
export function foreground(fn) {
  if (bgBusy && activeConv) { try { activeConv.cancel(); } catch {} }
  return genLock(fn);
}

// Background work (summaries, memory) — skipped when anything else is queued.
export async function background(fn) {
  if (bgBusy) return null;
  bgBusy = true;
  try { return await genLock(fn); } finally { bgBusy = false; }
}

// One-off text generation with no tools, e.g. "summarize this".
export async function complete(system, prompt, { maxOutputTokens = 400 } = {}) {
  const conv = await conversation({ system, maxOutputTokens, greedy: true });
  try {
    const r = await respond(conv, prompt);
    return r.text.trim();
  } finally {
    try { await conv.delete(); } catch {}
  }
}
