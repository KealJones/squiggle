// WebLLM (MLC) on WebGPU for phones: the same small models as engine-wllama.js, but compiled
// for the GPU. On an iPhone it ran Llama 3.2 1B at ~30 tok/s vs ~2.6 on wllama's CPU build,
// for about twice the memory (app/memtest.html, 2026-11-02). It plugs in under engine-wllama.js:
// createShim() returns an object with the slice of wllama's API that Conversation and
// NativeConversation use (createChatCompletion with OpenAI-shaped streaming chunks, exit),
// so prompt shaping, tool parsing and the anti-loop logic stay in one place.
//
// WebLLM has no chat-template engine, so each native-tool model names a tool format (toolformats/:
// Qwen3, Qwen3.5, Gemma 4, LFM2) that renders its template and reads its calls back. WebLLM keeps its
// files in Cache Storage (webllm/config, /model, /wasm); sw.js keeps those caches across updates.
import { report, gpu, trackBuffers } from './incidents.js';
import { reusePrefix } from './prefix-cache.js';
import { toolFormat, PLAIN } from './toolformats/index.js';
import { heldBack } from './toolformats/text.js';

// Older names, kept for the tests and anything importing them from here.
import { noteRendered } from './trace.js';
export { toolSystem, toWebLLMMessages, parseQwenCalls } from './toolformats/qwen.js';
export { gemmaArg, gemma4Prompt, parseGemmaCalls, splitGemma } from './toolformats/gemma4.js';
export { splitRaw } from './toolformats/text.js';

// ── Which WebLLM ─────────────────────────────────────────────────────────
// A model library (.wasm) carries its own TVM runtime, and WebLLM's JavaScript must match it: a community
// build compiled before TVM's October 2026 changes loads on 0.2.86 and not on 0.2.87 (CLAUDE.md, memtest).
// So each model can name the WebLLM it needs (MODELS `webllm`); versions load side by side as separate
// modules, and only one engine runs at a time.
export const DEFAULT_VERSION = '0.2.87';
const versions = new Map();   // model id → WebLLM version
const libs = new Map();       // version → import promise
export function setVersion(id, version) {
  if (!version) return;
  versions.set(id, version);
  versions.set(id.replace('q4f16_1', 'q4f32_1'), version);
}
export const versionFor = (id) => versions.get(id) || DEFAULT_VERSION;
function libFor(id) {
  const v = versionFor(id);
  if (!libs.has(v)) {
    const p = import(`https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@${v}/+esm`);
    p.catch(() => libs.delete(v));
    libs.set(v, p);
  }
  return libs.get(v);
}

// Our own and community MLC builds aren't in WebLLM's prebuilt list: engine.js registers their records
// (model URL, compiled .wasm, manifest) and every WebLLM call gets an appConfig that adds them.
const custom = new Map();
export function registerModel(record, { version } = {}) {
  custom.set(record.model_id, record);
  setVersion(record.model_id, version);
}
async function appConfigFor(id) {
  if (!custom.has(id)) return undefined;
  const { prebuiltAppConfig } = await libFor(id);
  return { ...prebuiltAppConfig, model_list: [...prebuiltAppConfig.model_list, custom.get(id)] };
}

// q4f16 needs the GPU's shader-f16 feature; the f32 build runs without it (more memory). One of our own builds
// gets the f32 path only when its q4f32_1 twin is registered (engine.js mlcRecordF32).
async function pickId(mlc) {
  const f32 = mlc.replace('q4f16_1', 'q4f32_1');
  if (custom.has(mlc) && !custom.has(f32)) return mlc;
  try {
    const a = navigator.gpu && await navigator.gpu.requestAdapter();
    if (a && a.features.has('shader-f16')) return mlc;
  } catch {}
  return mlc.replace('q4f16_1', 'q4f32_1');
}

// ── Download ──────────────────────────────────────────────────────────────

export async function isDownloaded(mlc) {
  try { const id = await pickId(mlc); return await (await libFor(id)).hasModelInCache(id, await appConfigFor(id)); } catch { return false; }
}

// WebLLM has no download-only call: loading fills its cache, then the engine is let go.
export async function downloadModel(mlc, onProgress, signal) {
  const id = await pickId(mlc);
  const { CreateMLCEngine } = await libFor(id);
  let engine = null;
  const onAbort = () => { try { engine && engine.unload(); } catch {} };
  signal && signal.addEventListener('abort', onAbort, { once: true });
  try {
    engine = await CreateMLCEngine(id, {
      appConfig: await appConfigFor(id),
      initProgressCallback: (p) => onProgress && onProgress(Math.round((p.progress || 0) * 1000), 1000),
    });
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
  } finally {
    signal && signal.removeEventListener('abort', onAbort);
    try { engine && await engine.unload(); } catch {}
  }
}

export async function removeModel(mlc) {
  for (const id of new Set([mlc, mlc.replace('q4f16_1', 'q4f32_1')])) {
    try { await (await libFor(id)).deleteModelAllInfoInCache(id, await appConfigFor(id)); } catch {}
  }
}

// ── The shim ──────────────────────────────────────────────────────────────

// WebLLM's names for the sampling wllama's conversations pass (engine-wllama.js samplingOptions). WebLLM
// has no top_k or min_p; a repeat penalty of 1 (off) is left out, and a presence penalty passes through.
export function sampling(opts) {
  const out = { temperature: opts.temperature, top_p: opts.top_p };
  if (opts.penalty_repeat && opts.penalty_repeat !== 1) out.repetition_penalty = opts.penalty_repeat;
  if (opts.penalty_present) out.presence_penalty = opts.penalty_present;
  return out;
}

const callChunk = (calls) => ({ choices: [{ delta: { tool_calls: calls.map((c, index) => ({ index, id: '', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } }] });

// When the browser takes the GPU device away (iOS 27 Safari does it with the tab still open: memory pressure, the
// phone locking, switching apps), WebLLM's TVM runtime disposes itself (Instance.dispose on device.lost) and every
// later call throws "Object has already been disposed". The engine object still looks loaded, so without this every
// message fails until the page is reloaded (an iPhone, iOS 27.2.1, 2026-11-11).
// "Model not loaded" is what an engine left unloaded by a failed reload says; it needs the same reload.
export const gpuGone = (e) => /already been disposed|device (was )?lost|Instance\.dispose|GPUDevice.*(lost|destroyed)|Model not loaded/i.test(String((e && e.message) || e || ''));
// Loading failed because the browser had no GPU to give: WebLLM's "Unable to find a compatible GPU" (requestAdapter
// came back empty). Right after Safari's GPU process dies it can say this for a while (an iPhone, 2026-11-11).
export const noAdapter = (e) => /compatible GPU|requestAdapter|no (webgpu )?adapter/i.test(String((e && e.message) || e || ''));

// Why the GPU went away. WebLLM only logs this to the console (no use on a phone), so every device it asks for is
// watched: device.lost's reason and message, and the first WebGPU error nobody caught (an out-of-memory or a limit
// the model breaks shows up there first). Shown in the error a user sees, and on the console. One record per device,
// so a device that was let go on purpose (unload) can't be mistaken for the one in use; whoever listens gets the record.
let gpuNotes = { lost: null, error: null };
let watching = false;
const lostListeners = new Set();
function watchDevices() {
  if (watching || typeof GPUAdapter === 'undefined' || !GPUAdapter.prototype || !GPUAdapter.prototype.requestDevice) return;
  watching = true;
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (...args) {
    const device = await request.apply(this, args);
    try {
      const notes = gpuNotes = { lost: null, error: null };
      const drop = trackBuffers(device);
      routeSelfCopies(device);
      device.lost.then((info) => {
        drop();
        notes.lost = { reason: info && info.reason, message: info && info.message, at: Date.now(), gpuBytes: gpu.atLoss };
        console.warn('Squiggle: GPU device lost', notes.lost);
        for (const fn of lostListeners) { try { fn(notes); } catch {} }
      });
      device.addEventListener('uncapturederror', (ev) => {
        if (!notes.error) notes.error = String((ev && ev.error && ev.error.message) || ev).slice(0, 300);
      });
    } catch {}
    return device;
  };
}
// WebGPU refuses a copy from a buffer to itself ("copyBufferToBuffer: source equals destination not valid"), even
// between two parts that don't touch. TVM makes exactly that copy when one of the model's states is copied inside
// its own storage: forking a sequence, which prompt reuse does (prefix-cache.js). On an iPhone that error was
// the first thing wrong before the GPU was lost for good (incident 2026-11-11 19:35, three minutes before reuse
// was reverted). So such a copy goes through a scratch buffer instead: out, then back in, in the same encoder.
// Every other copy is passed on untouched. Old scratch buffers are left to the garbage collector, not destroyed:
// an encoder that hasn't been submitted yet may still name one.
const encoderDevice = new WeakMap();   // encoder → the device that made it
const scratchOf = new WeakMap();       // device → { buffer, size }
export const selfCopies = { routed: 0 };
export function routeSelfCopies(device, Encoder = globalThis.GPUCommandEncoder) {
  const proto = Encoder && Encoder.prototype;
  if (!device || typeof device.createCommandEncoder !== 'function' || !proto || typeof proto.copyBufferToBuffer !== 'function') return false;
  const create = device.createCommandEncoder.bind(device);
  device.createCommandEncoder = (...args) => { const enc = create(...args); try { encoderDevice.set(enc, device); } catch {} return enc; };
  if (proto.squiggleSelfCopy) return true;
  const copy = proto.copyBufferToBuffer;
  proto.copyBufferToBuffer = function (src, srcOffset, dst, dstOffset, size) {
    const dev = encoderDevice.get(this);
    if (arguments.length < 5 || src !== dst || !dev || !(size > 0)) return copy.apply(this, arguments);
    let s = scratchOf.get(dev);
    if (!s || s.size < size) {
      const bytes = Math.max(65536, Math.ceil(size / 4) * 4);
      s = { size: bytes, buffer: dev.createBuffer({ size: bytes, usage: 0x4 | 0x8 }) };   // COPY_SRC | COPY_DST
      scratchOf.set(dev, s);
    }
    selfCopies.routed += 1;
    copy.call(this, src, srcOffset, s.buffer, 0, size);
    return copy.call(this, s.buffer, 0, dst, dstOffset, size);
  };
  proto.squiggleSelfCopy = true;
  return true;
}

// Prompt reuse (prefix-cache.js) is on by default since 2026-11-15 (passed on an iPhone): open the app once with
// ?reuse=0 and this browser keeps it off (a Home Screen app has no address bar), ?reuse=1 turns it back on.
const REUSE_KEY = 'squiggle-reuse';
export function reuseWanted(search = globalThis.location && location.search, store = globalThis.localStorage) {
  try {
    const q = new URLSearchParams(search || '').get('reuse');
    if (q !== null) { if (q === '0' || q === 'off') store.setItem(REUSE_KEY, '0'); else store.removeItem(REUSE_KEY); }
    return store.getItem(REUSE_KEY) !== '0';
  } catch { return false; }
}

const deviceWatch = {
  current: () => gpuNotes,
  onLost(fn) { lostListeners.add(fn); return () => lostListeners.delete(fn); },
};
export function gpuLossDetail(notes = gpuNotes) {
  const bits = [];
  const { lost, error } = notes || {};
  if (lost) bits.push(`reason "${lost.reason || 'unknown'}"${lost.message ? `, Safari said: "${String(lost.message).slice(0, 200)}"` : ''}`);
  if (error) bits.push(`the first GPU error was: "${error}"`);
  return bits.length ? ` (${bits.join('; ')})` : ' (the browser gave no reason)';
}

// Runs fn now if the page is showing, else once it shows again: a GPU asked for from a hidden tab is often refused.
function whenVisible(fn, delay = 300) {
  const doc = globalThis.document;
  if (!doc || doc.visibilityState !== 'hidden') { setTimeout(fn, delay); return; }
  const on = () => { if (doc.visibilityState === 'hidden') return; doc.removeEventListener('visibilitychange', on); setTimeout(fn, delay); };
  doc.addEventListener('visibilitychange', on);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// How long to keep asking for the GPU after it was lost, in pauses between tries (~11 s in all).
export const REVIVE_WAITS = [0, 500, 1500, 3000, 6000];

// iOS 27 Safari (WebKit 325185 "Long running command buffers can hang the system") kills its GPU process when one
// command buffer runs, or waits in the queue, for more than about 3 seconds; the device is lost with reason
// "destroyed" (onnxruntime#33753: a ~900-token prompt read in one go on an iPhone, iOS 27.2). WebLLM reads a
// prompt in prefill_chunk_size pieces (256 tokens for our LFM3 builds, ~2.5 s each on an iPhone 16) and queues them
// all without waiting, so the later pieces time out in the queue: an iPhone lost the GPU on "Hi" (a ~1,000-token
// prompt) from iOS 27.2.1 on, with the build that ran there on iOS 26. On WebKit the pieces are made smaller and each
// one waits for the GPU to finish. The compiled kernels take any length up to the build's chunk size, so it's a
// runtime setting; it reaches into WebLLM's pipeline (loadedModelIdToPipeline, prefillChunkSize, embedAndForward,
// sync, all in 0.2.86/0.2.87), and does nothing if those aren't there.
// Android has the opposite problem (Greg's phone in Chrome, 2026-11-11): nothing kills the long work, so the phone's
// own screen waits behind it and everything drops to a couple of frames a second. So phones get the same pacing,
// plus a gap the length of a frame after each prompt piece for the system to draw in (not after each generated
// token: those are short, and each already ends with a sync).
export const PACED_CHUNK = 128;
export const PACED_GAP_MS = 16;
const uaOf = () => (globalThis.navigator && navigator.userAgent) || '';
export const webkitGpu = (ua = uaOf()) =>
  /iPhone|iPad|iPod/.test(ua) || (/AppleWebKit/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|Edg|Firefox|FxiOS/.test(ua));
export const pacedGpu = (ua = uaOf()) => webkitGpu(ua) || /Android/.test(ua);
export function paceGpu(engine, chunk = PACED_CHUNK, gap = PACED_GAP_MS) {
  const pipes = engine && engine.loadedModelIdToPipeline;
  if (!pipes || typeof pipes.values !== 'function') return 0;
  let paced = 0;
  for (const p of pipes.values()) {
    if (!p || p.squigglePaced || typeof p.embedAndForward !== 'function') continue;
    const forward = p.embedAndForward;
    p.embedAndForward = async function (...args) {
      const out = await forward.apply(this, args);
      if (typeof this.sync === 'function') await this.sync();   // this piece is done before the next is queued
      if (gap && args[1] > 1) await sleep(gap);                  // a prompt piece: let the screen draw a frame
      return out;
    };
    if (typeof p.prefillChunkSize === 'number' && p.prefillChunkSize > chunk) p.prefillChunkSize = chunk;
    p.squigglePaced = true;
    paced += 1;
  }
  return paced;
}

// format: a tool format id (toolformats/) for models whose tools go through their own template (native),
// null for the fenced ```tool_call format and chat-only models (plain text both ways).
// engine: an already-made engine with WebLLM's API (tests pass a fake). makeEngine: how to make another one
// when the GPU device is lost (tests pass a fake; by default the same CreateMLCEngine call, from WebLLM's cache).
// watch: which GPU device is in use and when one is lost (tests pass a fake). waits: pauses between reload tries.
// reuse: keep a prompt prefix in the model's cache between calls (prefix-cache.js), for formats that say where a
// prompt can be cut (cacheMark). On unless this browser turned it off (reuseWanted).
export async function createShim(mlc, contextSize, onStage = () => {}, { format = null, engine: given = null, makeEngine = null, pace = pacedGpu(), watch = deviceWatch, waits = REVIVE_WAITS, reuse: wantReuse = reuseWanted() } = {}) {
  const id = given ? mlc : await pickId(mlc);
  const fmt = toolFormat(format) || PLAIN;
  const manifest = Boolean((custom.get(id) || {}).model_manifest);
  const make = makeEngine || (async (stage = onStage) => (await libFor(id)).CreateMLCEngine(id, {
    appConfig: await appConfigFor(id),
    initProgressCallback: (p) => stage(/fetch/i.test(p.text || '') ? 'downloading the model' : 'loading the model onto the GPU'),
  }, { context_window_size: contextSize }));
  if (watch === deviceWatch) watchDevices();
  onStage('loading the model onto the GPU');
  let engine = given || await make();
  let device = watch.current();       // the device this engine runs on (WebLLM asks for one per engine)
  // Before pacing: the caches are made again with the build's own prefill chunk size.
  let reuse = wantReuse && fmt.cacheMark ? reusePrefix(engine, fmt.cacheMark) : null;
  let reuseOn = Boolean(reuse);
  if (wantReuse) console.info(reuse ? 'Squiggle: prompt reuse is on (trial).' : 'Squiggle: prompt reuse was asked for, but this model or this WebLLM can\'t do it.');
  if (pace && !paceGpu(engine)) console.warn('Squiggle: could not pace WebLLM\'s GPU work (its internals changed); long prompts may lose the GPU on Safari or stall the screen on Android.');
  let reloads = 0, reviving = null, stale = false, closed = false, lostNotes = null;

  // A fresh engine from the files WebLLM already cached. Not reported through onStage: that's the load screen's
  // (and its crash marker's), and this happens mid-reply or in the background. Right after Safari's GPU process
  // dies it may have no GPU to give for a few seconds ("Unable to find a compatible GPU"), so it keeps asking for a
  // while. If it never gets one, the engine stays marked stale and the next message tries again, rather than
  // talking to the unloaded engine ("Model not loaded").
  function revive() {
    if (reviving) return reviving;
    reviving = (async () => {
      reloads += 1;
      stale = false;
      console.info('Squiggle: the GPU device was lost; loading the model onto the GPU again.');
      const was = lostNotes || device, started = Date.now();
      const old = engine;
      // A GPU lost with prompt reuse on: the reload runs without it (it may be why), and the incident says it was on.
      const hadReuse = reuse;
      if (reuse) { reuse = null; reuseOn = false; console.warn('Squiggle: the GPU was lost with prompt reuse on; it stays off until the page is reloaded.'); }
      engine = null;
      try { old && await old.unload(); } catch {}
      let last = null, tries = 0;
      for (const wait of waits) {
        if (wait) await sleep(wait);
        if (closed) return;
        tries += 1;
        try { engine = await make(() => {}); break; } catch (e) {
          last = e;
          if (!noAdapter(e) && !gpuGone(e)) break;
          console.warn('Squiggle: no GPU yet, asking again', String((e && e.message) || e));
        }
      }
      report('gpu-lost', {
        model: id, lost: was && was.lost, firstGpuError: was && was.error, reloads, tries, reloadMs: Date.now() - started,
        reuse: hadReuse ? { ...hadReuse.totals, last: hadReuse.last, selfCopies: selfCopies.routed } : undefined,
        backAgain: Boolean(engine), loadError: engine ? undefined : String((last && last.message) || last).slice(0, 300),
        visible: globalThis.document ? document.visibilityState : undefined,
      });
      if (!engine) {
        stale = true;
        if (!noAdapter(last) && !gpuGone(last)) throw last;
        throw new Error(`The GPU went away${gpuLossDetail(lostNotes || device)} and the browser hasn't given it back yet. Send the message again in a moment; if it keeps happening, reload the page.`);
      }
      device = watch.current();
      lostNotes = null;
      if (pace) paceGpu(engine);
    })().finally(() => { reviving = null; });
    return reviving;
  }

  // Noticed before the next message: when the device goes (the phone locked, the app was switched, Safari's GPU
  // process restarted), the model is loaded again as soon as the page shows, so it's ready by the time the user
  // sends instead of the send finding a dead engine. A device let go on purpose (unload, a download's engine) is
  // ignored: only the one this engine runs on counts, and not while reloading or after exit.
  const unwatch = watch.onLost((notes) => {
    if (notes !== device || reviving || closed) return;
    stale = true;
    lostNotes = notes;
    whenVisible(() => { if (stale && !reviving && !closed) revive().catch((e) => console.warn('Squiggle: background reload failed', e)); });
  });
  async function ready() {
    if (reviving) { try { await reviving; } catch {} }
    if (stale || !engine) await revive();
  }

  // One reply. Chat formats go through WebLLM's chat API, raw ones send the rendered prompt as a text
  // completion. Either way the reply streams back as thinking (reasoning_content) and text, with the
  // format's call block held back and handed over as delta.tool_calls at the end.
  // If the GPU goes away mid-reply the model is loaded again and the reply goes on: before anything was shown it starts
  // over (every request carries the whole conversation); raw formats carry on from what was written (the prompt plus
  // the partial reply, so nothing is repeated and the consumer just sees the next words). A chat format can't
  // continue an assistant turn: the error is flagged `gpuLost` so engine.respond can restart the call (resume.js).
  // `opts.resume_raw` starts from a partial reply the same way (the page was reloaded mid-reply); `opts.on_raw(raw)`
  // reports the raw text as it grows, for the checkpoint.
  async function* stream(opts, signal) {
    await ready();
    const st = { raw: opts.resume_raw || '', thinkShown: 0, textShown: 0 };
    try {
      yield* streamOnce(opts, signal, st);
    } catch (e) {
      if (!gpuGone(e) || (signal && signal.aborted)) throw e;
      const first = gpuLossDetail(lostNotes || device);
      // iOS gives a hidden tab no GPU (an iPhone, 2026-11-15: 11 s of "no GPU yet" while the user was in another app), so
      // the reload waits until the page shows again. If it still can't get one, reloadToResume: the page reloads and
      // picks the reply up from its checkpoint (resume.js), the same path as a tab iOS killed.
      await new Promise((r) => whenVisible(r, 0));
      try { await revive(); } catch (er) { throw Object.assign(er, { reloadToResume: true }); }
      const shown = st.thinkShown || st.textShown;
      if (shown && fmt.mode !== 'raw') throw Object.assign(new Error(`The GPU dropped the model partway through this reply${first}. It has been loaded again: send the message again.`), { gpuLost: true });
      if (!shown) { st.raw = opts.resume_raw || ''; }
      else { const at = fmt.callStart ? st.raw.indexOf(fmt.callStart) : -1; if (at >= 0) st.raw = st.raw.slice(0, at); }   // half a tool call is thrown away; the model writes it again
      try {
        yield* streamOnce(opts, signal, st);
      } catch (e2) {
        if (!gpuGone(e2)) throw e2;
        stale = true;
        throw Object.assign(new Error(`The GPU dropped the model again right after it was reloaded${gpuLossDetail(device)}; the first time${first}. This device may not have enough GPU memory for this model right now.`), { reloadToResume: true });
      }
    }
  }

  async function* streamOnce(opts, signal, st = { raw: '', thinkShown: 0, textShown: 0 }) {
    // A chat format with no tools and no thinking switch (a background job) is plain text, as before.
    const f = fmt.mode === 'raw' || (fmt !== PLAIN && (opts.tools || opts.chat_template_kwargs)) ? fmt : PLAIN;
    const thinking = opts.chat_template_kwargs ? Boolean(opts.chat_template_kwargs.enable_thinking) : undefined;
    const history = opts.messages || [];
    const tools = opts.tools || [];
    const onAbort = () => { try { engine.interruptGenerate(); } catch {} };
    signal && signal.addEventListener('abort', onAbort, { once: true });
    try {
      let chunks, prompt = '', base = '';
      if (f.mode === 'raw') {
        // WebLLM puts the conversation's prefix tokens (BOS) in front of a raw completion only on its manifest
        // path; a build without a manifest gets the prompt as is (web-llm 0.2.86/0.2.87 getInputData).
        prompt = (f.bos && !manifest ? f.bos : '') + f.prompt(history, tools, { thinking: Boolean(thinking), names: opts.tool_names || [] });
        // think_prefill: thinking written into the model's own turn and closed here, so it carries on from it as
        // if it had thought that (the thinking budget, engine-wllama.js). The reply then starts after the close.
        if (opts.think_prefill && f.thinkClose && thinking && prompt.endsWith(f.thinkOpen)) prompt += opts.think_prefill + f.thinkClose;
        base = prompt;   // what the model's own words are split against (ctx.prompt)
        prompt += st.raw;      // a reply carried on after a lost GPU or a reload: the model goes on from what it wrote
        noteRendered('raw prompt', prompt);   // the exact text the model reads ("What the model saw", trace.js)
        try { await engine.resetChat(); } catch {}         // raw completions need an empty KV cache (a kept prefix snapshot survives: prefix-cache.js)
        chunks = await engine.completions.create({ prompt, stream: true, max_tokens: opts.max_tokens, ...sampling(opts), stop: f.stop });
      } else {
        let messages = f.messages(history, tools, { thinking });
        // WebLLM can't continue an assistant turn; a prefilled retry starts the reply fresh instead.
        while (messages.length && messages[messages.length - 1].role === 'assistant') messages = messages.slice(0, -1);
        noteRendered('chat messages (WebLLM applies the template)', messages);
        chunks = await engine.chat.completions.create({
          messages,
          stream: true,
          max_tokens: opts.max_tokens,
          ...sampling(opts),
          ...(thinking === undefined ? {} : { extra_body: { enable_thinking: thinking } }),
        });
      }
      const ctx = { thinking, prompt: f.mode === 'raw' ? base : prompt };
      const visible = (text) => {
        if (!f.callStart) return text;
        const at = text.indexOf(f.callStart);
        // Whitespace before a call isn't shown; it's sent once more text follows.
        return (at >= 0 ? text.slice(0, at) : text.slice(0, text.length - heldBack(text, f.callStart))).replace(/\s+$/, '');
      };
      let raw = f.mode === 'raw' ? st.raw : '';
      // What `raw` adds to what the consumer has seen (st keeps the counts across a reload of the engine).
      const news = function* () {
        const s = f.split(raw, ctx);
        if (s.thinking.length > st.thinkShown) { yield { choices: [{ delta: { reasoning_content: s.thinking.slice(st.thinkShown) } }] }; st.thinkShown = s.thinking.length; }
        if (s.pending) return;
        const text = visible(s.text);
        if (text.length > st.textShown) { yield { choices: [{ delta: { content: text.slice(st.textShown) } }] }; st.textShown = text.length; }
      };
      if (raw) yield* news();
      for await (const c of chunks) {
        if (signal && signal.aborted) break;
        const ch = c.choices && c.choices[0];
        const piece = (ch && (ch.text ?? (ch.delta && ch.delta.content))) || '';
        if (!piece) continue;
        raw += piece;
        if (f.mode === 'raw') { st.raw = raw; opts.on_raw && opts.on_raw(raw); }
        yield* news();
      }
      // Thinking that never closed (cut off by max_tokens): it was all thinking, no reply.
      const s = f.split(raw, ctx);
      if (!f.callStart) {
        if (s.text.length > st.textShown) yield { choices: [{ delta: { content: s.text.slice(st.textShown) } }] };
        return;
      }
      const at = s.text.indexOf(f.callStart);
      const before = (at >= 0 ? s.text.slice(0, at) : s.text).replace(/\s+$/, '');
      if (before.length > st.textShown) yield { choices: [{ delta: { content: before.slice(st.textShown) } }] };
      const calls = at >= 0 ? f.parseCalls(s.text.slice(at)) : [];
      if (calls.length) yield callChunk(calls);
    } finally {
      signal && signal.removeEventListener('abort', onAbort);
    }
  }

  return {
    async createChatCompletion(opts) { return stream(opts, opts.abortSignal); },
    async exit() { closed = true; unwatch(); try { engine && await engine.unload(); } catch {} },
    info: { gpu: true, threads: 1, compat: false, webllm: true, closesThinking: Boolean(fmt.mode === 'raw' && fmt.thinkClose), get reuse() { return reuseOn; }, webllmVersion: versionFor(id), toolFormat: fmt.id, toolNames: Boolean(fmt.listsNames), id },
    get reloads() { return reloads; },
    get paced() { return Boolean(pace); },
    // Prompt tokens reused from the cache vs read, last call and in all (null when reuse is off, or was turned off).
    get reuse() { return reuse ? { ...reuse.totals, last: reuse.last, selfCopies: selfCopies.routed } : null; },
  };
}

// The engine Squiggle loads (engine.js): the shim under engine-wllama.js's conversations. Built here,
// not in engine-wllama.js, so a browser still holding an older cached engine-wllama.js can't end up
// loading a WebLLM model through the wllama path.
export async function createEngine(mlc, contextSize, onStage = () => {}, { native = false, toolFormat: format = null } = {}) {
  onStage('starting the runtime');
  const { Conversation, NativeConversation } = await import('./engine-wllama.js');
  const w = await createShim(mlc, contextSize, onStage, { format: native ? format : null });
  return {
    // `reuse` stays live: it goes off for good when the GPU is lost with it on.
    info: Object.defineProperty({ ...w.info, asked: { gpu: true, threads: false, isolated: Boolean(globalThis.crossOriginIsolated), webgpu: true } },
      'reuse', { get: () => w.info.reuse, enumerable: true }),
    createConversation: async (cfg) => (native ? new NativeConversation(w, cfg) : new Conversation(w, cfg)),
    delete: async () => { try { await w.exit(); } catch {} },
  };
}
