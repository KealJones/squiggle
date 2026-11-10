// Models. Gemma 4 E2B/E4B run on this device through LiteRT-LM on WebGPU;
// Gemma 3 270M runs on the CPU through wllama (engine-wllama.js) and is the
// phone default; the cloud model (Gemma 4 26B) runs on the relay (engine-cloud.js). Handles
// the one-time resumable download into IndexedDB, engine startup, and
// streaming generation with tools.
import { failedCallText, repairCalls, unreadableNote } from './toolcall-repair.js';
import { kv, mutex } from './util.js';

const LITERT = 'https://cdn.jsdelivr.net/npm/@litert-lm/core@0.14.0/+esm';
const HF = 'https://huggingface.co/';

// phone: small enough for a phone's per-tab memory. size: download size.
export const MODELS = {
  E4B: { label: 'Gemma 4 E4B', size: '3.0 GB', note: 'smartest on-device model, best with tools', phone: false, runtime: 'litert', family: 'gemma4',
    url: HF + 'litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm' },
  E2B: { label: 'Gemma 4 E2B', size: '2.0 GB', note: 'faster, still good with tools', phone: false, runtime: 'litert', family: 'gemma4',
    url: HF + 'litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm' },
  G3: { label: 'Gemma 3 270M', size: '242 MB', note: 'tiny and fast; runs on a phone\'s CPU, no WebGPU needed. Chat only: no tools or web lookups, and it often gets facts wrong', phone: true, runtime: 'wllama', family: 'fenced',
    url: HF + 'unsloth/gemma-3-270m-it-GGUF/resolve/main/gemma-3-270m-it-Q4_0.gguf', bytes: 241574944 },
  // Experimental: LFM2.5-350M fine-tuned on Squiggle's harness format (lm-experiments
  // experiments/squiggle-ft). Same runtime and prompt format as G3.
  SQ: { label: 'Squiggle Small (experimental)', size: '219 MB', note: 'LFM2.5 350M trained on Squiggle\'s own tools and habits (plan, find, done). Uses tools and looks things up; still often wrong; runs on a phone\'s CPU', phone: true, runtime: 'wllama', tools: true, family: 'fenced',
    url: HF + 'kealjones/squiggle-small/resolve/main/squiggle-small-lfm25-Q4_0.gguf', bytes: 219312160 },
  // Size tests for phones (Keal, 2026-10-28): how big a model an iPhone tab survives on wllama.
  // Plain chat only (stock models: no harness), smallest to largest.
  // Qwen3 0.6B with its own tool format (as WQ06 on WebLLM). The smallest stock model here that can use tools,
  // and the one that stays under 1 GB on the CPU: 0.82 GB loaded, 0.88 GB at peak in a 4K window with the lean
  // KV settings (docs/measurements-2026-11-04.md; 1.2 GB with llama.cpp's defaults). Thinking is budgeted (generationFor).
  Q06: { label: 'Qwen3 0.6B', size: '382 MB', experimental: true, note: 'stock Qwen3 0.6B with tools in its own format (no Squiggle training): the smallest model here that uses tools, and it stays under 1 GB of memory on a phone. Thinks before answering, so it\'s slow. Experimental', phone: true, runtime: 'wllama', tools: true, native: true, family: 'qwen3',
    url: HF + 'unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_0.gguf', bytes: 382156480 },
  LF12: { label: 'Test: LFM2.5 1.2B', size: '696 MB', experimental: true, note: 'phone size test: Squiggle Small\'s bigger sibling (1.2B). Chat only, no tools', phone: true, runtime: 'wllama',
    url: HF + 'LiquidAI/LFM2.5-1.2B-Instruct-GGUF/resolve/main/LFM2.5-1.2B-Instruct-Q4_0.gguf', bytes: 695751488 },
  LL1: { label: 'Test: Llama 3.2 1B', size: '773 MB', experimental: true, note: 'phone size test: probably right at the edge. Chat only, no tools', phone: true, runtime: 'wllama',
    url: HF + 'unsloth/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf', bytes: 773025824 },
  // Gemma 4 E2B pruned (80K vocab, hidden 1024, FFN 42%, 31 layers) and healed by distillation, last on
  // E2B's own answers and tool calls (lm-experiments experiments/tiny-gemma4, heal 3).
  TG4: { label: 'Test: Tiny Gemma 4', size: '778 MB', experimental: true, note: 'Gemma 4 E2B cut down for phones (0.6B core) and healed on E2B\'s own answers. Answers short questions, calls Gemma 4\'s tools; still often wrong. Experimental', phone: true, runtime: 'wllama', tools: true, native: true, family: 'gemma4',
    url: HF + 'kealjones/tiny-gemma4-test/resolve/main/tiny-gemma4-heal3-v2-Q4_0.gguf', bytes: 778158496 },
  // Heal 4 pilot A (lm-experiments experiments/tiny-gemma4, 2026-11-03): heal 3 + 750 steps on Toucan's multi-turn
  // tool conversations with real results. In tests it answers from tool results (heal 3 replied with nothing) and
  // handles a failed search, but plain text got a little worse. Same size and runtime as TG4.
  TG4A: { label: 'Test: Tiny Gemma 4 (heal 4)', size: '778 MB', experimental: true, note: 'tiny Gemma 4 trained further on tool conversations with real results: it now answers from what a search returns. Plain answers got a little worse than heal 3. Experimental', phone: true, runtime: 'wllama', tools: true, native: true, family: 'gemma4', thinking: false,
    url: HF + 'kealjones/tiny-gemma4-test/resolve/main/tiny-gemma4-heal4a-Q4_0.gguf', bytes: 778158496 },
  // Stock Qwen3.5 0.8B (Keal, 2026-10-31): tools through Qwen's own chat template, like TG4 (native), no fine-tune.
  Q35: { label: 'Test: Qwen3.5 0.8B', size: '507 MB', experimental: true, note: 'stock Qwen3.5 0.8B with tools in its own tool format (no Squiggle training). Runs without thinking, as its model card recommends for this size, and needs about 1.1 GB of memory while answering. Experimental', phone: true, runtime: 'wllama', tools: true, native: true, family: 'qwen35', thinking: false,
    url: HF + 'unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_0.gguf', bytes: 507154688 },
  // LFM3-1.7B (Liquid, 2026-11-03; Keal 2026-11-09): post-trained for agent harnesses. On Squiggle's prompt and tools it
  // greets without calling a tool, writes code itself, looks up Jaws and 17*23 with the right tools and calls
  // tool_info(["run_js"]) for a gated tool, where LFM2.5 1.2B did none of those (llama.cpp replays, Nov 9). Thinking on
  // by default (its card). wllama 3.13's llama.cpp runs it through the GGUF's own template; on a phone CPU it's slow
  // (1 GB, thinks first), so this entry is for computers and for seeing it work; no MLC build exists.
  LF3: { label: 'Test: LFM3 1.7B', size: '1.0 GB', experimental: true, note: 'stock LFM3 1.7B with tools in its own format, thinking first. The first Liquid model trained for agent harnesses: it chats, writes code and picks tools sensibly where LFM2.5 did not, but it is 1 GB on the CPU and thinks before every reply. Experimental', phone: true, runtime: 'wllama', tools: true, native: true, family: 'lfm3',
    url: HF + 'LiquidAI/LFM3-1.7B-GGUF/resolve/main/LFM3-1.7B-QAD-Q4_0.gguf', bytes: 1049615680 },
  // Not on this device: runs on the relay (only listed when the relay offers it).
  // WebLLM (MLC) on WebGPU (engine-webllm.js, Keal 2026-11-02): the same small-model path as the
  // wllama models (runtime 'wllama', so isLite and the small-model harness apply), compiled for the
  // GPU. Measured on an iPhone (app/memtest.html): 5-12x faster than wllama's CPU build for about
  // twice the memory; 1B fits, Qwen3.5 2B loaded but died on its first reply. Sizes are approximate.
  WL1: { label: 'Llama 3.2 1B (GPU, fast)', size: '~700 MB', experimental: true, note: 'stock Llama 3.2 1B on WebLLM (WebGPU): about 30 words a second on an iPhone, much faster than the CPU models, but it uses about twice the memory. Chat only, no tools. Experimental', phone: true, runtime: 'wllama', backend: 'webllm',
    mlc: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', bytes: 700000000 },
  WQ06: { label: 'Qwen3 0.6B (GPU, fast)', size: '~350 MB', experimental: true, note: 'stock Qwen3 0.6B on WebLLM (WebGPU) with tools in Qwen\'s own format: about 30 words a second on an iPhone, for about twice the memory of the CPU models. Experimental', phone: true, runtime: 'wllama', backend: 'webllm', tools: true, native: true, toolFormat: 'qwen3', family: 'qwen3',
    mlc: 'Qwen3-0.6B-q4f16_1-MLC', bytes: 350000000 },
  WQ35: { label: 'Qwen3.5 0.8B (GPU)', size: '~500 MB', experimental: true, note: 'stock Qwen3.5 0.8B on WebLLM (WebGPU) with tools in its own format: about 14 words a second on an iPhone (3x the CPU build). Runs without thinking, as its model card recommends for this size. Experimental', phone: true, runtime: 'wllama', backend: 'webllm', tools: true, native: true, toolFormat: 'qwen35', family: 'qwen35', thinking: false,
    mlc: 'Qwen3.5-0.8B-q4f16_1-MLC', bytes: 500000000 },
  // LFM2.5 1.2B Instruct on WebLLM (Keal, 2026-11-08): naklitechie's community MLC build, compiled with Kiln's
  // fork of mlc-llm before TVM's October changes, so it names WebLLM 0.2.86 (`webllm`; 0.2.87 can't load it).
  // Tools in LFM2's own format (toolformats/lfm2.js: Pythonic calls, results in a tool turn), so it's native
  // and small: the short find-first prompt with gated tools. On an iPhone (memtest, full 4K prompt): first
  // word in 19 s, 18.7 tok/s, ahead of Qwen3 0.6B on WebLLM; its KV cache is in 6 of 16 layers.
  WLF12: { label: 'Test: LFM2.5 1.2B (GPU)', size: '~630 MB', experimental: true, note: 'stock LFM2.5 1.2B Instruct on WebLLM (WebGPU) with tools in its own format: about 19 words a second on an iPhone, faster than Qwen3 0.6B and twice its size. A community build, 4K context at most. Experimental', phone: true, runtime: 'wllama', backend: 'webllm', tools: true, native: true, toolFormat: 'lfm2', family: 'lfm2', thinking: false, webllm: '0.2.86', maxContext: 4096,
    mlc: 'LFM2.5-1.2B-Instruct-q4f16_1-MLC', bytes: 630000000,
    mlcRecord: {
      model: HF + 'naklitechie/LFM2.5-1.2B-Instruct-q4f16_1-MLC/resolve/main/',
      model_lib: HF + 'naklitechie/LFM2.5-1.2B-Instruct-q4f16_1-MLC/resolve/main/LFM2.5-1.2B-Instruct-q4f16_1-webgpu.wasm',
      overrides: { context_window_size: 4096 },
    } },
  // LFM3 1.7B on WebLLM (Keal, 2026-11-09): our own MLC build (lm-experiments experiments/lfm3-mlc: model definition for
  // mlc-llm, TVM built from source at WebLLM 0.2.87's commit, q4f16_1, 4K window, prefill chunks of 256 because five of its
  // layers attend over a 256-token window). Tools in LFM3's own format (toolformats/lfm3.js). On an iPhone in Squiggle
  // (2026-11-10, small-model prompt and tools): "Hii" → a plain greeting, first word in 15 s, 13.7 tok/s. memtest's
  // 3K-token prompt killed the tab while answering, so long chats are at the phone's memory edge.
  WLF3: { label: 'Test: LFM3 1.7B (GPU)', size: '~990 MB', experimental: true, note: 'LFM3 1.7B on WebLLM (WebGPU) with tools in its own format, thinking first: about 14 words a second on an iPhone, 8x the CPU build. Our own 4-bit build of Liquid\'s weights; long chats may run a phone out of memory. Experimental', phone: true, runtime: 'wllama', backend: 'webllm', tools: true, native: true, toolFormat: 'lfm3', family: 'lfm3', maxContext: 4096,
    mlc: 'LFM3-1.7B-q4f16_1-MLC', bytes: 990000000,
    mlcRecord: {
      model: HF + 'kealjones/LFM3-1.7B-q4f16_1-MLC/resolve/main/',
      model_lib: HF + 'kealjones/LFM3-1.7B-q4f16_1-MLC/resolve/main/LFM3-1.7B-q4f16_1-webgpu.wasm',
      overrides: { context_window_size: 4096 },
    } },
  // LFM3 1.7B with Liquid's own quantization-aware-trained 4-bit weights (Keal, 2026-11-10): lm-experiments job lfm3-mlc-8 copies
  // the 107 linear layers of LiquidAI's LFM3-1.7B-QAD-Q4_0.gguf bit-for-bit into our q4f16_1 layout (qad_to_mlc.py:
  // Q4_0 (k-8)*d = MLC (q-7)*s with q = 15-k, s = -d); embedding, norms and conv kernels as in WLF3. Its model library is
  // compiled for one sequence (max_batch_size=1): ~17 MB of scratch instead of ~163 MB, which WebLLM never used.
  WLF3QAD: { label: 'Test: LFM3 1.7B QAD (GPU)', size: '~990 MB', experimental: true, note: 'LFM3 1.7B on WebLLM with Liquid\'s own 4-bit weights (trained to survive 4 bits) and a model library that reserves ~150 MB less memory than the plain 4-bit build. Experimental', phone: true, runtime: 'wllama', backend: 'webllm', tools: true, native: true, toolFormat: 'lfm3', family: 'lfm3', maxContext: 4096,
    mlc: 'LFM3-1.7B-QAD-q4f16_1-MLC', bytes: 990000000,
    mlcRecord: {
      model: HF + 'kealjones/LFM3-1.7B-QAD-q4f16_1-MLC/resolve/main/',
      model_lib: HF + 'kealjones/LFM3-1.7B-QAD-q4f16_1-MLC/resolve/main/LFM3-1.7B-q4f16_1-b1-webgpu.wasm',
      overrides: { context_window_size: 4096 },
    } },
  // The same model in MLC's 3-bit group quantization (q3f16_1, 769 MB): Keal's call, in case 4-bit is too big on a phone.
  // It isn't (the 4-bit runs), and 3-bit loses the model's judgement: on an iPhone (2026-11-10) "Hii" became 400 tokens of
  // "likely a placeholder… I'll proceed to use the tool calls?", with or without Squiggle's prompt, where the 4-bit build and
  // Liquid's own 4-bit (llama.cpp) both just greet. Kept for comparison.
  WLF3Q3: { label: 'Test: LFM3 1.7B 3-bit (GPU)', size: '~770 MB', experimental: true, note: 'LFM3 1.7B in 3-bit on WebLLM (WebGPU), a fifth smaller than the 4-bit build but noticeably worse: it overthinks even a greeting. For comparison only. Experimental', phone: true, runtime: 'wllama', backend: 'webllm', tools: true, native: true, toolFormat: 'lfm3', family: 'lfm3', maxContext: 4096,
    mlc: 'LFM3-1.7B-q3f16_1-MLC', bytes: 806000000,
    mlcRecord: {
      model: HF + 'kealjones/LFM3-1.7B-q3f16_1-MLC/resolve/main/',
      model_lib: HF + 'kealjones/LFM3-1.7B-q3f16_1-MLC/resolve/main/LFM3-1.7B-q3f16_1-webgpu.wasm',
      overrides: { context_window_size: 4096 },
    } },
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

// The model for this device: computers run E4B. Phones with WebGPU run Qwen3 0.6B on WebLLM: the only one that
// stays alive in iPhone 16 Safari and uses tools (2026-11-04); Gemma 4 gets the tab killed. Phones without WebGPU
// run Squiggle Small (LFM2.5 350M fine-tuned on the harness) on the CPU. Phones can still pick the cloud model.
export const hasWebGpu = () => typeof navigator !== 'undefined' && Boolean(navigator.gpu);
export function deviceModel() {
  return isMobile() ? (hasWebGpu() ? 'WQ06' : 'SQ') : 'E4B';
}
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
export async function conversation({ system, messages = [], tools = [], thinking = false, maxOutputTokens = 2048, greedy = false, known = [], gate = null }) {
  if (!engine) throw new Error('Model not loaded.');
  const gen = generationFor();
  const preface = {
    messages: [{ role: 'system', content: system }, ...messages],
    // A model trained without thinking (thinking: false in MODELS) gets the prompt it was trained on.
    extra_context: { enable_thinking: thinking && gen.thinking },
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
