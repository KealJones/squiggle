// On-device model: Gemma 4 (E2B or E4B) through LiteRT-LM on WebGPU.
// Handles the one-time resumable download into IndexedDB, engine startup,
// and streaming generation with tool calls.
import { kv, mutex } from './util.js';

const LITERT = 'https://cdn.jsdelivr.net/npm/@litert-lm/core@0.14.0/+esm';

export const MODELS = {
  E2B: { label: 'Gemma 4 E2B', size: '1.9 GB', note: 'faster, good on phones',
    url: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm' },
  E4B: { label: 'Gemma 4 E4B', size: '2.8 GB', note: 'smarter, better with tools',
    url: 'https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm' },
};

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

// Picks E4B when the device looks capable, else E2B.
export function suggestModel() {
  const mem = navigator.deviceMemory || 4;
  const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  return !mobile && mem >= 8 ? 'E4B' : 'E2B';
}

// ── Download (resumable, chunked into IndexedDB) ──────────────────────────

const metaKey = (url) => 'model-meta:' + url;

export async function downloadInfo(id) {
  const url = MODELS[id].url;
  return (await kv.get(metaKey(url))) || { total: 0, stored: 0, complete: false };
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
  const url = MODELS[id].url;
  const meta = await downloadInfo(id);
  if (meta.complete) return;
  try { await navigator.storage?.persist?.(); } catch {}

  let offset = 0;
  const offsets = await chunkOffsets(url);
  for (const off of offsets) {
    const rec = await kv.get([url, off], 'model');
    if (!rec || off !== offset) break;
    offset += rec.byteLength;
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
  for (const off of await chunkOffsets(url)) { const r = await kv.get([url, off], 'model'); if (r) n += r.byteLength; }
  return n;
}

export async function deleteModel(id) {
  const url = MODELS[id].url;
  for (const off of await chunkOffsets(url)) await kv.del([url, off], 'model');
  await kv.del(metaKey(url));
}

function modelStream(url, offsets) {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= offsets.length) { controller.close(); return; }
      const rec = await kv.get([url, offsets[i++]], 'model');
      if (!rec) { controller.error(new Error('Model data is missing; download it again.')); return; }
      controller.enqueue(rec);
    },
  }, new CountQueuingStrategy({ highWaterMark: 1 }));
}

// ── Engine ────────────────────────────────────────────────────────────────

export async function load(id, contextSize) {
  if (engine && loadedModel === id && engineContext === contextSize) return;
  await unload();
  lib = lib || await import(LITERT);
  const url = MODELS[id].url;
  const offsets = await chunkOffsets(url);
  if (!offsets.length) throw new Error('Model is not downloaded yet.');
  const base = { maxNumTokens: contextSize };
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
