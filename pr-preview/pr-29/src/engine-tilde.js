// Tilde (github.com/KealJones/tilde): Keal's own WebGPU engine for LFM3, built for iPhone Safari's limits
// (~1.9 GB per tab shared by JS and GPU, ~3 s per GPU command buffer). It streams the GGUF tensor by tensor, splits
// GPU work into submits sized from measured timings, needs no shader-f16, and runs LFM3 Omni: pictures, video,
// sound in, and the model's own voice out. Encoders load only while they're needed.
//
// It plugs in under engine-webllm.js's shim, posing as a WebLLM engine (completions.create with a raw prompt,
// interruptGenerate, unload), so the tool format, thinking budget, GPU-loss reload and reply resume stay in one
// place. What it adds:
//   - prompt reuse: Tilde snapshots the model's state at the shim's safe cut (prefix-cache.js snapshotPoint) and
//     goes back to it when the next prompt starts with the same tokens, so a tool round reads only what's new;
//   - media: ⟦media:id⟧ markers in the prompt (media.js) become the picture, video or sound itself;
//   - speak() and transcribe(), which run in a side sequence so the chat's cache survives them.
import { createShim, gpuGone } from './engine-webllm.js';
import { snapshotPoint } from './prefix-cache.js';
import * as media from './media.js';

// Pinned to a commit: Tilde is plain ES modules, loaded straight from jsDelivr (no build step on either side).
export const TILDE_SHA = 'ee7320121ea4db62005aecbe4c60d8d43ab900dd';
const defaultUrl = () => `https://cdn.jsdelivr.net/gh/KealJones/tilde@${TILDE_SHA}/src/index.js`;
// Tests and local checks can point it elsewhere (globalThis.SQUIGGLE_TILDE = '/tilde/src/index.js').
const libUrl = () => globalThis.SQUIGGLE_TILDE || defaultUrl();
let libP = null;
export function lib() {
  if (!libP) { libP = import(/* @vite-ignore */ libUrl()); libP.catch(() => { libP = null; }); }
  return libP;
}

// ── Files ────────────────────────────────────────────────────────────────
// Tilde keeps each file in Cache Storage (tilde-v1) in 16 MB pieces under the file's URL; sw.js leaves that
// cache alone. A model is its GGUF plus, for Omni, the encoders' mmproj.
const filesOf = (m) => [m.url, m.mmproj].filter(Boolean);
// Each file's size as MODELS says it (fileBytes): a load caches pieces without Tilde's size record, and with the size
// they still count, and a download finishes them without asking the server first (Keal's iPhone, 2026-11-17: all 63
// pieces of LFM3 1.7B were there and the download sat at 0% waiting on that request).
const sizeOf = (m, i) => (m.fileBytes && m.fileBytes[i]) || 0;
const info = (k, m, url, i) => k.cachedFileInfo(url, 'tilde-v1', { size: sizeOf(m, i) });

export async function isDownloaded(m) {
  const k = await lib();
  for (const [i, url] of filesOf(m).entries()) if (!(await info(k, m, url, i)).complete) return false;
  return true;
}

export async function downloadInfo(m) {
  const k = await lib();
  let stored = 0, complete = true;
  for (const [i, url] of filesOf(m).entries()) { const x = await info(k, m, url, i); stored += x.stored; complete = complete && x.complete; }
  return { total: m.bytes, stored: complete ? m.bytes : stored, complete };
}

export async function downloadModel(m, onProgress, signal) {
  const k = await lib();
  const sizes = m.fileBytes || filesOf(m).map(() => 0);
  // Say how far along it is straight away (pieces already cached count), so a slow first piece doesn't look stuck.
  if (onProgress) onProgress((await downloadInfo(m)).stored, m.bytes);
  let before = 0;
  for (const [i, url] of filesOf(m).entries()) {
    await k.cacheFile(url, { signal, size: sizeOf(m, i), onProgress: (done, total) => onProgress && onProgress(before + done, m.bytes || total) });
    before += sizes[i] || (await k.cachedFileInfo(url)).size;
  }
}

export async function removeModel(m) {
  const k = await lib();
  for (const url of filesOf(m)) await k.removeCachedFile(url);
}

// ── The engine under the shim ─────────────────────────────────────────────

// What a ⟦media:id⟧ marker becomes, decoded once per file (media.decoded): Tilde reads a picture as up to 256
// tokens (512×512 at most), a video at 2 frames a second in pairs of 64 tokens each (256×256, at most 30 s) with its
// soundtrack, and sound at 12.5 tokens a second (at most 2 minutes).
const VIDEO = { maxPixels: 256 * 256, maxFrames: 60 };
const AUDIO_MAX_S = 120;
async function decodeMedia(k, it) {
  if (it.kind === 'image') return { image: await createImageBitmap(it.file) };
  if (it.kind === 'video') return { video: await k.readVideo(it.file, VIDEO) };
  if (it.kind === 'audio') { const pcm = await k.decodeAudio(it.file); return { audio: pcm.length > AUDIO_MAX_S * 16000 ? pcm.subarray(0, AUDIO_MAX_S * 16000) : pcm }; }
  throw new Error(`can't take in a ${it.kind}`);
}

// The prompt as Tilde's parts: text, and each kept file wrapped the way the model's template wraps media.
async function promptParts(k, text) {
  if (!media.hasMarkers(text)) return [text];
  const out = [];
  for (const p of media.split(text)) {
    if (typeof p === 'string') { out.push(p); continue; }
    out.push('<|vision_start|>', await media.decoded(p.id, (it) => decodeMedia(k, it)), '<|vision_end|>');
  }
  return out;
}

let current = null;   // the loaded Tilde, for speak() and transcribe()

// A WebLLM-shaped engine over a loaded Tilde: the slice of WebLLM's API the shim calls (exported for tests).
export function asEngine(k, llm) {
  let ctl = null;
  const tk = llm.tokenizer;
  const open = tk.encode('<|im_start|>assistant\n<think>'), close = tk.encode('</think>')[0];
  const run = async function* ({ prompt, max_tokens, temperature, top_p, repetition_penalty }) {
    ctl = new AbortController();
    const signal = ctl.signal;
    const queue = [];
    let wake = null, done = false, error = null;
    const push = (x) => { queue.push(x); if (wake) { wake(); wake = null; } };
    (async () => {
      const parts = await promptParts(k, prompt);
      const items = llm.items(parts);
      // Snapshot where the next call is sure to render the same tokens (a media item counts as one, never matches a token).
      const at = snapshotPoint(items.map((x) => (typeof x === 'number' ? x : -1)), open, close);
      await llm.generate(items, {
        maxTokens: max_tokens || 1024, temperature: temperature ?? 0.1, topP: top_p ?? 1, topK: 50,
        repeatPenalty: repetition_penalty || 1, snapshotAt: at, signal,
        onToken: (text) => push(text),
        onRead: (r) => { stats.last = r; stats.reused += r.reused; stats.read += r.read; },
      });
    })().then(() => { done = true; push(null); }, (e) => { error = e; done = true; push(null); });
    try {
      for (;;) {
        if (!queue.length) await new Promise((r) => { wake = r; });
        const x = queue.shift();
        if (x === null && done) break;
        if (x) yield { choices: [{ text: x }] };
      }
      if (error && error.name !== 'AbortError') {
        // Said in words gpuGone() knows, so the shim loads the model again and carries the reply on.
        if (llm.gpu.lost || gpuGone(error)) throw new Error(`The GPU device was lost: ${error.message || error}`);
        if (/context is full/.test(String(error.message))) throw new Error('This conversation no longer fits in the model\'s window. Start a new chat, or switch the chat to Compress.');
        throw error;
      }
    } finally { ctl = null; }
  };
  const stats = { reused: 0, read: 0, last: null };
  return {
    tilde: llm,
    stats,
    async resetChat() {},
    interruptGenerate() { try { ctl && ctl.abort(); } catch {} },
    async unload() {
      if (current === llm) current = null;
      try { llm.gpu.device.destroy(); } catch {}
    },
    completions: { create: async (opts) => run(opts) },
    // Plain chat (a chat-only model): the template's own rendering, then the same raw path.
    chat: { completions: { create: async (opts) => {
      const thinking = opts.extra_body ? Boolean(opts.extra_body.enable_thinking) : false;
      const f = llm.formatChat(opts.messages.map((m) => ({ role: m.role, content: m.content })), { thinking });
      return run({ ...opts, prompt: Array.isArray(f) ? f.join('') : f });
    } } },
  };
}

/**
 * The engine Squiggle loads (engine.js): the shim under engine-wllama.js's conversations, over Tilde.
 * @param {object} m the MODELS entry (url, mmproj)
 */
export async function createEngine(m, contextSize, onStage = () => {}, { native = false, toolFormat: format = null } = {}) {
  onStage('starting the runtime');
  const { Conversation, NativeConversation } = await import('./engine-wllama.js');
  const k = await lib();
  let first = true;
  const make = async (stage = onStage) => {
    const llm = await k.Tilde.load(m.url, {
      ctx: contextSize, chunk: 64, mmproj: m.mmproj,
      onProgress: (p) => stage(first ? `loading the model onto the GPU (${Math.round((100 * p.loaded) / p.total)}%)` : 'loading the model onto the GPU'),
    });
    first = false;
    current = llm;
    return asEngine(k, llm);
  };
  const w = await createShim(m.id, contextSize, onStage, { format: native ? format : null, makeEngine: make, pace: false, reuse: false });
  return {
    info: { ...w.info, webllm: false, webllmVersion: undefined, tilde: TILDE_SHA.slice(0, 7), senses: m.senses || [] },
    createConversation: async (cfg) => (native ? new NativeConversation(w, cfg) : new Conversation(w, cfg)),
    delete: async () => { try { await w.exit(); } catch {} },
  };
}

// ── The model's own voice and hearing (Omni) ──────────────────────────────
// Both run in Tilde's side sequence, so the chat's prompt stays read. Callers go through engine.js, which holds
// the one-generation-at-a-time lock (the GPU's scratch buffers are shared).

/** Says `text` in the model's own voice, streaming 24 kHz mono PCM chunks to onAudio. Resolves to the whole clip. */
export async function speak(text, opts = {}) {
  if (!current) throw new Error('The model isn\'t loaded.');
  return current.speak(text, opts);
}

/** What is said in 16 kHz mono `pcm`, by the model's own hearing. */
export async function transcribe(pcm, opts = {}) {
  if (!current) throw new Error('The model isn\'t loaded.');
  return current.transcribe(pcm, opts);
}

export const SPEECH_RATE = 24000;
export const decodeAudio = async (blob) => (await lib()).decodeAudio(blob);
/** GPU memory Tilde holds right now and its peak ({ totalMB, peakMB, byTag, … }), or null when nothing is loaded. */
export const stats = () => (current ? current.stats() : null);
