// Models. Gemma 4 E4B runs on computers through LiteRT-LM on WebGPU; phones run LFM2.5 1.2B on
// WebLLM (WebGPU) or Squiggle Small on the CPU through wllama (engine-wllama.js); the cloud model
// (Gemma 4 26B) runs on the relay (engine-cloud.js). Handles the one-time resumable download into
// IndexedDB, engine startup, and streaming generation with tools.
//
// `experimental: true` folds a listed model under "Experimental models" in the pickers.
import { failedCallText, repairCalls, unreadableNote } from './toolcall-repair.js';
import { kv, mutex } from './util.js';

const LITERT = 'https://cdn.jsdelivr.net/npm/@litert-lm/core@0.14.0/+esm';
const HF = 'https://huggingface.co/';

// phone: small enough for a phone's per-tab memory. size: download size.
export const MODELS = {
  // LFM3 1.7B, the model (Keal, 2026-11-10): one model, two builds (GROUPS). Liquid's first small model post-trained
  // for agent harnesses; on Squiggle's prompt and tools it greets without tools, writes code itself and picks the right
  // tool. Thinking on by default (its card).
  // The WebLLM build (lm-experiments experiments/lfm3-mlc): our own MLC port, TVM built from source at WebLLM 0.2.87's
  // commit, 4K window, prefill chunks of 256 (five layers attend over a 256-token window), tools in LFM3's own format
  // (toolformats/lfm3.js). Liquid's quantization-aware-trained 4-bit weights copied in exactly (job lfm3-mlc-8,
  // qad_to_mlc.py: Q4_0 (k-8)*d = MLC (q-7)*s with q = 15-k, s = -d) and a one-sequence model library (~17 MB of
  // scratch instead of ~163). On an iPhone 16 in Squiggle: first word in 15 s, 13.7 tok/s (2026-11-10).
  WLF3QAD: { label: 'LFM3 1.7B', size: '~990 MB', group: 'LFM3', note: 'Liquid\'s LFM3 1.7B on WebGPU with tools in its own format, thinking first: the first small model trained for agent harnesses, about 14 words a second on an iPhone. Liquid\'s own 4-bit weights. 4K context at most', phone: true, runtime: 'wllama', backend: 'webllm', tools: true, native: true, toolFormat: 'lfm3', family: 'lfm3', maxContext: 4096,
    mlc: 'LFM3-1.7B-QAD-q4f16_1-MLC', bytes: 990000000,
    mlcRecord: {
      model: HF + 'kealjones/LFM3-1.7B-QAD-q4f16_1-MLC/resolve/main/',
      model_lib: HF + 'kealjones/LFM3-1.7B-QAD-q4f16_1-MLC/resolve/main/LFM3-1.7B-q4f16_1-b1-webgpu.wasm',
      overrides: { context_window_size: 4096 },
    },
    // GPUs without 16-bit floats (shader-f16): the same QAD weights in q4f32_1 (job lfm3-mlc-9: the 4-bit integers
    // exact, scales widened to fp32 and stored as bf16 like every MLC q4f32 build). More GPU memory than q4f16.
    mlcRecordF32: {
      model: HF + 'kealjones/LFM3-1.7B-QAD-q4f32_1-MLC/resolve/main/',
      model_lib: HF + 'kealjones/LFM3-1.7B-QAD-q4f32_1-MLC/resolve/main/LFM3-1.7B-q4f32_1-b1-webgpu.wasm',
      overrides: { context_window_size: 4096 },
    } },
  // The CPU build, for devices without WebGPU: Liquid's QAD GGUF on wllama (llama.cpp WASM, ≥ 3.13), tools through
  // the GGUF's own template. Slow on a phone CPU (1 GB, thinks first).
  LF3: { label: 'LFM3 1.7B', size: '1.0 GB', maxContext: 4096, group: 'LFM3', note: 'Liquid\'s LFM3 1.7B with tools in its own format, thinking first: the first small model trained for agent harnesses. On this device it runs on the CPU (no WebGPU here), so replies are slower than on a GPU', phone: true, runtime: 'wllama', tools: true, native: true, family: 'lfm3',
    url: HF + 'LiquidAI/LFM3-1.7B-GGUF/resolve/main/LFM3-1.7B-QAD-Q4_0.gguf', bytes: 1049615680 },
  // Keal's own models, kept as experiments. Squiggle Small: LFM2.5-350M fine-tuned on Squiggle's harness format
  // (lm-experiments experiments/squiggle-ft): the fenced find-first prompt and separate tools are its training text.
  SQ: { label: 'Squiggle Small', size: '219 MB', maxContext: 4096, experimental: true, note: 'Keal\'s own fine-tune: LFM2.5 350M trained on Squiggle\'s tools and habits (plan, find, done). Uses tools and looks things up; still often wrong; runs on a phone\'s CPU, no WebGPU needed', phone: true, runtime: 'wllama', tools: true, family: 'fenced',
    url: HF + 'kealjones/squiggle-small/resolve/main/squiggle-small-lfm25-Q4_0.gguf', bytes: 219312160 },
  // Tiny Gemma 4: Gemma 4 E2B pruned (80K vocab, hidden 1024, FFN 42%, 31 layers) and healed by distillation on E2B's
  // own answers and tool calls, then on Toucan's multi-turn tool conversations with real results (lm-experiments
  // experiments/tiny-gemma4, heal 4 pilot A, 2026-11-03): answers from tool results, handles a failed search.
  TG4A: { label: 'Tiny Gemma 4', size: '778 MB', maxContext: 4096, experimental: true, note: 'Keal\'s own build: Gemma 4 E2B pruned to a 0.6B core, healed by distillation, then trained on tool conversations with real results. Answers from what a search returns; still often wrong; runs on a phone\'s CPU', phone: true, runtime: 'wllama', tools: true, native: true, family: 'gemma4', thinking: false,
    url: HF + 'kealjones/tiny-gemma4-test/resolve/main/tiny-gemma4-heal4a-Q4_0.gguf', bytes: 778158496 },
  // Not on this device: runs on the relay (only listed when the relay offers it).
  cloud: { label: 'Gemma 4 26B (Cloudflare)', size: 'no download', note: 'bigger and smarter, runs on your Cloudflare relay; chats leave this device. Free daily limit, then it pauses until midnight UTC.', phone: true, runtime: 'cloud', needsRelay: true, family: 'gemma4' },
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
// Gemma 4's own tool format through llama.cpp's chat template (engine-wllama.js NativeConversation), not
// Squiggle Small's ```tool_call blocks: for small builds distilled from E2B (tiny Gemma 4).
export const nativeTools = (id = loadedModel) => isLite(id) && Boolean(MODELS[id] && MODELS[id].native);
// Small by runtime, but trained for agent harnesses (LFM3): it can take the harness's own notes (the tool calls it
// made earlier, with what they returned) without mistaking them for the user's words, which earlier small models did.
export const agentTrained = (id = loadedModel) => Boolean(MODELS[id] && MODELS[id].family === 'lfm3');
// Can a conversation start with a tool call already made and its result (Fresh context's lookup)? Models that
// call tools in their own format (OpenAI-shaped history: wllama, WebLLM) and the cloud model can; LiteRT and the
// fenced small-model format can't, so they get the lookup in the system prompt.
export const seedsToolHistory = (id = loadedModel) => nativeTools(id) || Boolean(MODELS[id] && MODELS[id].runtime === 'cloud');
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

export const hasWebGpu = () => typeof navigator !== 'undefined' && Boolean(navigator.gpu);
// The defaults in one place. Since 2026-11-10 it's LFM3 1.7B everywhere (Keal: "we only need LFM3"): our WebLLM build
// on WebGPU, Liquid's GGUF on the CPU without it. Gemma 4 E4B, LFM2.5 1.2B and the rest are lab-mode options.
export const DEFAULTS = { computer: 'WLF3QAD', phoneGpu: 'WLF3QAD', phoneCpu: 'LF3' };
export function deviceModel() {
  return forDevice(isMobile() ? DEFAULTS.phoneGpu : DEFAULTS.computer);
}

// The context window a model gets: the most it was built for (maxContext: LFM3's builds and Keal's two small models,
// 4K), else 16K (the cloud model: bigger windows cost more of the relay's free daily budget per request). There's no
// setting (Keal, 2026-11-10: "give them the biggest context").
export const contextFor = (id) => (MODELS[id] && MODELS[id].maxContext) || 16384;

// One model, several builds (Keal, 2026-11-10: "a user should only have to pick LFM3 1.7B, not the GGUF vs GPU
// version for their device"). Each build stays its own MODELS entry (its download, runtime, tool format) with
// `group` naming the model it's a build of; GROUPS lists the builds in order of preference, and the first one
// that can run on this device is the one listed, loaded and resolved to when a chat from another device names
// a different build.
export const GROUPS = { LFM3: { label: 'LFM3 1.7B', builds: ['WLF3QAD', 'LF3'] } };
export const groupOf = (id) => (MODELS[id] && MODELS[id].group) || null;
// Whether the GPU has 16-bit floats (shader-f16): null until probeGpu() has asked the adapter. A build marked f16Only
// (no q4f32 twin) takes the next build on a GPU without them; LFM3's WebLLM build has its twin (mlcRecordF32).
let gpuF16 = null;
export async function probeGpu() {
  if (gpuF16 !== null || !hasWebGpu()) return gpuF16;
  try { const a = await navigator.gpu.requestAdapter(); gpuF16 = Boolean(a && a.features.has('shader-f16')); } catch { gpuF16 = false; }
  return gpuF16;
}
// Could this build run here: WebGPU for the GPU runtimes (and 16-bit floats for an f16-only build), and the
// phone limits.
// Builds that crashed this device's tab and were stepped down from (settings.avoidBuilds, set by the crash banner):
// skipped, so the next open doesn't go straight back to the build that crashed.
let avoid = new Set();
export const setAvoided = (ids) => { avoid = new Set(ids || []); };
export function runsHere(id) {
  const m = MODELS[id];
  if (!m || !modelFitsDevice(id) || avoid.has(id)) return false;
  if (m.backend === 'webllm' || m.runtime === 'litert') {
    if (!hasWebGpu()) return false;
    if (m.f16Only && gpuF16 === false) return false;
  }
  return true;
}
// The build of this model for this device; a model without a group is itself.
export function forDevice(id) {
  const g = GROUPS[groupOf(id)];
  return g ? (g.builds.find(runsHere) || id) : id;
}
// How it runs, in words, for Settings and the sidebar: "on your GPU (WebGPU)" / "on the CPU".
export function runnerLabel(id) {
  const m = MODELS[id];
  if (!m) return '';
  if (m.runtime === 'cloud') return 'in the cloud, through the relay';
  if (m.backend === 'webllm' || m.runtime === 'litert') return 'on your GPU (WebGPU)';
  return 'on the CPU' + (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated ? ', all cores' : '');
}

export const listed = (id, { cloudOffered = false } = {}) => {
  const m = MODELS[id];
  if (m && m.group) return forDevice(id) === id && (!m.needsRelay || cloudOffered);
  return Boolean(m) && modelFitsDevice(id) && (!m.needsRelay || cloudOffered);
};
export const listedModels = (opts) => Object.keys(MODELS).filter(id => listed(id, opts));
// Runs without WebGPU (CPU only).
export const needsGpu = (id) => Boolean(MODELS[id] && MODELS[id].runtime === 'litert');
export const suggestModel = deviceModel;
export const modelFitsDevice = (id) => !isMobile() || Boolean(MODELS[id] && MODELS[id].phone);

// ── Download (resumable, chunked into IndexedDB) ──────────────────────────

// WebLLM, with our own MLC builds (a model's `mlcRecord`) registered so its calls can find them.
async function webllm() {
  const w = await import('./engine-webllm.js');
  for (const m of Object.values(MODELS)) {
    if (m.mlcRecord) w.registerModel({ model_id: m.mlc, ...m.mlcRecord }, { version: m.webllm });
    // Its 32-bit-float twin (q4f32_1), for GPUs without shader-f16: engine-webllm picks one per GPU.
    if (m.mlcRecordF32) w.registerModel({ model_id: m.mlc.replace('q4f16_1', 'q4f32_1'), ...m.mlcRecordF32 }, { version: m.webllm });
    else if (m.mlc && m.webllm) w.setVersion(m.mlc, m.webllm);
  }
  return w;
}
const metaKey = (url) => 'model-meta:' + url;
const recSize = (r) => (r == null ? 0 : r.size ?? r.byteLength);

export async function downloadInfo(id) {
  const wm = MODELS[id];
  if (wm && wm.backend === 'webllm') {
    const done = await (await webllm()).isDownloaded(wm.mlc);
    return { total: wm.bytes, stored: done ? wm.bytes : 0, complete: done };
  }
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
  if (MODELS[id].backend === 'webllm') {
    try { await navigator.storage?.persist?.(); } catch {}
    const total = MODELS[id].bytes;
    return (await webllm()).downloadModel(MODELS[id].mlc, (done, all) => onProgress && onProgress(Math.round(total * done / all), total), signal);
  }
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
  if (MODELS[id] && MODELS[id].backend === 'webllm') return (await webllm()).removeModel(MODELS[id].mlc);
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
let engineSmall = '';
// Small models (wllama): how the last load ran ({ gpu, threads, compat }) and the last reply's speed.
export const smallInfo = () => (engine && engine.info) || null;
export const smallSpeed = async () => (isLite() ? (await import('./engine-wllama.js')).lastSpeed() : null);
export async function load(id, contextSize, { fast = true, onStage = () => {}, small = {} } = {}) {
  const smallKey = JSON.stringify({ gpu: Boolean(small.gpu), threads: Boolean(small.threads) });
  if (engine && loadedModel === id && engineContext === contextSize && engineFast === fast && (MODELS[id].runtime !== 'wllama' || engineSmall === smallKey)) return;
  await unload();
  if (MODELS[id].runtime === 'cloud') {
    engine = (await import('./engine-cloud.js')).createEngine();
    loadedModel = id; engineContext = contextSize; engineFast = fast;
    return;
  }
  if (MODELS[id].runtime === 'wllama') {
    const m = MODELS[id];
    engine = m.backend === 'webllm'
      ? await (await webllm()).createEngine(m.mlc, contextSize, onStage, { native: Boolean(m.native), toolFormat: m.toolFormat || null })
      : await (await import('./engine-wllama.js')).createEngine(m.url, contextSize, onStage, { ...small, native: Boolean(m.native) });
    loadedModel = id; engineContext = contextSize; engineFast = fast; engineSmall = smallKey;
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

// ── Generation settings per model (docs/harness.md, "Per-model generation settings") ──
//
// Sampling follows each model's own card; one setting for every model was wrong for most of them
// (Qwen's cards want no repeat penalty, Gemma 4's wants temperature 1.0). A family is the card the
// numbers come from; `fenced` is Squiggle Small's family and must stay as it is: its eval
// (lm-experiments backends.py HFStudent) runs with exactly these numbers.
//   temperature, top_k, top_p, min_p: the usual samplers (WebLLM has no top_k or min_p).
//   repeat: llama.cpp's repeat penalty over the last 64 tokens (1 = off). presence: presence penalty (0 = off).
const SAMPLING = {
  fenced: { temperature: 0.7, top_k: 64, top_p: 0.95, min_p: 0, repeat: 1.15, presence: 0 },
  gemma4: { temperature: 1.0, top_k: 64, top_p: 0.95, min_p: 0, repeat: 1.0, presence: 0 },      // Gemma 4 model card: one setting for all uses
  qwen3: { temperature: 0.6, top_k: 20, top_p: 0.95, min_p: 0, repeat: 1.0, presence: 1.5 },     // Qwen3 card, thinking mode; presence penalty against repetition, not repeat penalty
  qwen35: { temperature: 1.0, top_k: 20, top_p: 1.0, min_p: 0, repeat: 1.0, presence: 2.0 },     // Qwen3.5-0.8B card, non-thinking text (how it runs here)
  lfm2: { temperature: 0.1, top_k: 50, top_p: 1.0, min_p: 0, repeat: 1.05, presence: 0 },       // LFM2.5-1.2B-Instruct card (no top_p given)
  lfm3: { temperature: 0.1, top_k: 50, top_p: 1.0, min_p: 0, repeat: 1.1, presence: 0 },        // LFM3-1.7B card, "general" (chat, tools, agents)
  default: { temperature: 0.7, top_k: 64, top_p: 0.95, min_p: 0, repeat: 1.15, presence: 0 },    // stock models with no card guidance here (Llama 3.2)
};
// A model's generation profile: its sampling, whether it thinks, and how much (docs/harness.md).
//   thinking: false means the model never gets thinking turned on (trained without it, or its card says so for this size).
//   thinkBudget: reasoning tokens a reply may spend before the engine stops the thinking and asks for the
//   answer (engine-wllama.js). 0 = no cap. Small models default to 400 of a 1,024-token reply: past that, the
//   thinking was eating the whole reply (a 0.6B model thought until the output cap and never answered).
export function generationFor(id = loadedModel) {
  const m = MODELS[id] || {};
  const sampling = { ...(SAMPLING[m.family] || SAMPLING.default), ...(m.sampling || {}) };
  const small = Boolean(m.runtime === 'wllama');
  return { sampling, thinking: m.thinking !== false, thinkBudget: m.thinkBudget !== undefined ? m.thinkBudget : (small ? 400 : 0) };
}
const GREEDY = { type: 3 };
// LiteRT's sampler from a sampling profile (top-k/top-p sampling; the engine has no penalties).
const litertSampler = (s) => ({ type: 2, p: s.top_p, k: s.top_k, temperature: s.temperature });

// Starts a conversation from a preface: system text, prior turns, tools.
// `sampling` overrides parts of the model card's profile for this conversation (brainstorm.js runs hotter).
// `strictThinking`: also tell the cloud model thinking is on or off (it otherwise decides for itself).
export async function conversation({ system, messages = [], tools = [], thinking = false, maxOutputTokens = 2048, greedy = false, known = [], gate = null, sampling = null, strictThinking = false }) {
  if (!engine) throw new Error('Model not loaded.');
  const card = generationFor();
  const gen = sampling ? { ...card, sampling: { ...card.sampling, ...sampling } } : card;
  const preface = {
    messages: [{ role: 'system', content: system }, ...messages],
    // A model trained without thinking (thinking: false in MODELS) gets the prompt it was trained on.
    extra_context: { enable_thinking: thinking && gen.thinking, ...(strictThinking ? { strict: true } : {}) },
  };
  if (tools.length) preface.tools = tools.map(t => ({ type: 'function', function: t }));
  // The small model only sees details of tools it has looked up (engine-wllama.js).
  if (isLite() && known.length) preface.known = known;
  // Small native models: only these (plus tools looked up) are declared; the rest are names in the prompt.
  if (isLite() && gate) preface.gate = gate;
  const cfg = { preface, sessionConfig: { maxOutputTokens, samplerParams: greedy ? GREEDY : litertSampler(gen.sampling), sampling: gen.sampling, thinkBudget: gen.thinkBudget } };
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
export async function respond(conv, input, opts = {}) {
  try {
    return await respondOnce(conv, input, opts);
  } catch (e) {
    // Gemma 4 wrote a tool call LiteRT couldn't parse (e.g. "plain quotes" instead
    // of <|"|>). Read it leniently and carry on; if it can't be read, ask once more.
    const raw = failedCallText(e && e.message);
    if (raw === null) throw e;
    const calls = repairCalls(raw);
    if (calls.length) return { text: '', thinking: '', toolCalls: calls, repaired: raw };
    if (opts.retried) throw e;
    return respondOnce(conv, unreadableNote(raw), { ...opts, retried: true });
  }
}

async function respondOnce(conv, input, { onText, onThinking, signal } = {}) {
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
