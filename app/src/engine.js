// On-device models. Gemma 4 E2B/E4B run through LiteRT-LM on WebGPU; the
// Hugging Face (ONNX) models — Gemma 4 E2B Mobile, Gemma 3, SmolLM — run
// through onnxruntime-web (engine-onnx.js). Handles the one-time resumable
// download into IndexedDB, engine startup, and streaming generation with tools.
import { kv, mutex } from './util.js';

const LITERT = 'https://cdn.jsdelivr.net/npm/@litert-lm/core@0.14.0/+esm';
const HF = 'https://huggingface.co/';

// phone: small enough for a phone's per-tab memory. size: download size.
export const MODELS = {
  E4B: { label: 'Gemma 4 E4B', size: '3.0 GB', note: 'smartest, best with tools', phone: false, runtime: 'litert',
    url: HF + 'litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm' },
  E2B: { label: 'Gemma 4 E2B', size: '2.0 GB', note: 'faster, still good with tools', phone: false, runtime: 'litert',
    url: HF + 'litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm' },
  'E2B-QAT': { label: 'Gemma 4 E2B Mobile', size: '2.3 GB', note: 'experimental: E2B squeezed to about 1 GB of memory for phones (text only)', phone: true, runtime: 'onnx',
    repo: 'onnx-community/gemma-4-E2B-it-qat-mobile-ONNX', family: 'gemma4', needsF16: true,
    files: { 'onnx/decoder_model_merged_q2f16.onnx': 807184, 'onnx/decoder_model_merged_q2f16.onnx_data': 994621440, 'onnx/embed_tokens_q2f16.onnx_data': 1296564224,
      'tokenizer.json': 32169626, 'tokenizer_config.json': 1877, 'chat_template.jinja': 17336, 'generation_config.json': 209 },
    graph: 'onnx/decoder_model_merged_q2f16.onnx', data: 'onnx/decoder_model_merged_q2f16.onnx_data',
    // The embedding tables stay in storage; rows are read per token.
    lookup: { file: 'onnx/embed_tokens_q2f16.onnx_data', layers: 35, tables: [
      { w: 0, rowBytes: 384, s: 100663296, blocks: 6, bits: 2, dim: 1536, mul: 39.191835884530846 },
      { w: 103809024, rowBytes: 4480, s: 1278214144, blocks: 35, bits: 4, dim: 8960, mul: 16, zeroIds: [258880, 258881] },
    ] } },
  'G3-1B': { label: 'Gemma 3 1B', size: '0.8 GB', note: 'small and quick; fine for chat, weak with tools', phone: true, runtime: 'onnx',
    repo: 'onnx-community/gemma-3-1b-it-ONNX', family: 'gemma3', needsF16: true, stopText: ['<end_of_turn>'],
    files: { 'onnx/model_q4f16.onnx': 461341, 'onnx/model_q4f16.onnx_data': 763067904, 'tokenizer.json': 20323013, 'tokenizer_config.json': 2327, 'chat_template.jinja': 1532, 'generation_config.json': 244 },
    graph: 'onnx/model_q4f16.onnx', data: 'onnx/model_q4f16.onnx_data' },
  'G3-270M': { label: 'Gemma 3 270M', size: '0.3 GB', note: 'tiny; simple chat only', phone: true, runtime: 'onnx',
    repo: 'onnx-community/gemma-3-270m-it-ONNX', family: 'gemma3', needsF16: true, stopText: ['<end_of_turn>'],
    files: { 'onnx/model_q4f16.onnx': 330717, 'onnx/model_q4f16.onnx_data': 272626176, 'tokenizer.json': 20323013, 'tokenizer_config.json': 2313, 'chat_template.jinja': 1532, 'generation_config.json': 202 },
    graph: 'onnx/model_q4f16.onnx', data: 'onnx/model_q4f16.onnx_data' },
  'SL3-3B': { label: 'SmolLM3 3B', size: '2.1 GB', note: 'fully open training data; thinks before answering', phone: false, runtime: 'onnx',
    repo: 'HuggingFaceTB/SmolLM3-3B-ONNX', family: 'smollm3', needsF16: true, stopText: ['<|im_end|>'],
    files: { 'onnx/model_q4f16.onnx': 301534, 'onnx/model_q4f16.onnx_data': 2124320768, 'tokenizer.json': 11574059, 'tokenizer_config.json': 56256, 'chat_template.jinja': 5575, 'generation_config.json': 182 },
    graph: 'onnx/model_q4f16.onnx', data: 'onnx/model_q4f16.onnx_data' },
  'SL2-1.7B': { label: 'SmolLM2 1.7B', size: '1.1 GB', note: 'fully open training data', phone: false, runtime: 'onnx',
    repo: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', family: 'smollm2', needsF16: true, stopText: ['<|im_end|>'],
    files: { 'onnx/model_q4f16.onnx': 1108730338, 'tokenizer.json': 2104556, 'tokenizer_config.json': 3764, 'generation_config.json': 132 },
    graph: 'onnx/model_q4f16.onnx' },
  'SL2-360M': { label: 'SmolLM2 360M', size: '0.3 GB', note: 'tiny, fully open training data; simple chat only', phone: true, runtime: 'onnx',
    repo: 'onnx-community/SmolLM2-360M-Instruct-ONNX', family: 'smollm2', needsF16: true, stopText: ['<|im_end|>'],
    files: { 'onnx/model_q4f16.onnx': 272353302, 'tokenizer.json': 3522656, 'tokenizer_config.json': 3794, 'generation_config.json': 132 },
    graph: 'onnx/model_q4f16.onnx' },
  // Not on this device: runs on the relay (only listed when the relay offers it).
  cloud: { label: 'Gemma 4 26B (Cloudflare)', size: 'no download', note: 'bigger and smarter, runs on your Cloudflare relay; chats leave this device. Free daily limit, then it pauses until midnight UTC.', phone: true, runtime: 'cloud', needsRelay: true },
};

// Every file a model needs. ONNX files are stored as Blobs so single rows can
// be read without loading the whole file.
export function modelFiles(id) {
  const m = MODELS[id];
  if (!m) throw new Error(`Unknown model "${id}".`);
  if (m.runtime === 'cloud') return [];
  if (m.runtime !== 'onnx') return [{ path: '', url: m.url, size: 0, blob: false }];
  return Object.entries(m.files).map(([path, size]) => ({ path, url: `${HF}${m.repo}/resolve/main/${path}`, size, blob: true }));
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

// Phones and tablets: tighter per-tab memory limits (iOS Safari kills a tab
// that goes over), so they get lighter defaults. iPadOS reports as a Mac.
export function isMobile() {
  const ua = navigator.userAgent;
  return /Android|iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

// The model for this device: computers use E4B; phones use E2B Mobile, the
// only Gemma 4 build that fits a phone's per-tab memory.
export function deviceModel() {
  return isMobile() ? 'E2B-QAT' : 'E4B';
}
export const suggestModel = deviceModel;
export const modelFitsDevice = (id) => !isMobile() || Boolean(MODELS[id] && MODELS[id].phone);

// ── Download (resumable, chunked into IndexedDB) ──────────────────────────

const metaKey = (url) => 'model-meta:' + url;
const recSize = (r) => (r == null ? 0 : r.size ?? r.byteLength);

export async function downloadInfo(id) {
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

async function downloadFile({ url, blob }, onProgress, signal) {
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
      await kv.set([url, batchStart], blob ? new Blob([batch]) : batch, 'model');
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

// Stored files for the ONNX engine: whole files as bytes, or random access.
async function records(url) {
  const out = [];
  for (const off of await chunkOffsets(url)) {
    const rec = await kv.get([url, off], 'model');
    if (!rec) throw new Error('Model data is missing; download it again.');
    out.push({ off, rec, size: recSize(rec) });
  }
  if (!out.length) throw new Error('Model is not downloaded yet.');
  return out;
}
async function readAll(url) {
  const recs = await records(url);
  const buf = new Uint8Array(recs.reduce((n, r) => n + r.size, 0));
  for (const r of recs) buf.set(await asBytes(r.rec), r.off);
  return buf;
}
function randomReader(url) {
  let recsP = null;
  return async (start, len) => {
    const recs = await (recsP = recsP || records(url));
    const out = new Uint8Array(len);
    let lo = 0, hi = recs.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (recs[mid].off <= start) lo = mid; else hi = mid - 1; }
    let got = 0;
    for (let i = lo; got < len && i < recs.length; i++) {
      const r = recs[i], a = start + got - r.off, b = Math.min(r.size, a + (len - got));
      const part = r.rec instanceof Blob ? new Uint8Array(await r.rec.slice(a, b).arrayBuffer()) : r.rec.subarray(a, b);
      out.set(part, got); got += part.byteLength;
    }
    return out;
  };
}
function storedFiles(id) {
  const byPath = new Map(modelFiles(id).map(f => [f.path, f.url]));
  const url = (p) => { if (!byPath.has(p)) throw new Error(`Missing model file ${p}.`); return byPath.get(p); };
  const text = async (p) => new TextDecoder().decode(await readAll(url(p)));
  return { bytes: (p) => readAll(url(p)), text, json: async (p) => JSON.parse(await text(p)), reader: (p) => randomReader(url(p)) };
}

// ── Engine ────────────────────────────────────────────────────────────────

// fast: multi-token prediction (Gemma 4's speculative drafter). Noticeably
// faster replies, but it loads an extra small model, so it costs memory.
let engineFast = null;
export async function load(id, contextSize, { fast = true } = {}) {
  if (engine && loadedModel === id && engineContext === contextSize && engineFast === fast) return;
  await unload();
  if (MODELS[id].runtime === 'cloud') {
    engine = (await import('./engine-cloud.js')).createEngine();
    loadedModel = id; engineContext = contextSize; engineFast = fast;
    return;
  }
  if (MODELS[id].runtime === 'onnx') {
    const onnx = await import('./engine-onnx.js');
    const spec = MODELS[id];
    const useGpu = !spec.needsF16 || await onnx.gpuHasF16();
    engine = await onnx.createEngine(spec, storedFiles(id), { contextSize, useGpu });
    loadedModel = id; engineContext = contextSize; engineFast = fast;
    return;
  }
  lib = lib || await import(LITERT);
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
export async function conversation({ system, messages = [], tools = [], thinking = false, maxOutputTokens = 2048, greedy = false }) {
  if (!engine) throw new Error('Model not loaded.');
  const preface = {
    messages: [{ role: 'system', content: system }, ...messages],
    extra_context: { enable_thinking: thinking },
  };
  if (tools.length) preface.tools = tools.map(t => ({ type: 'function', function: t }));
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
