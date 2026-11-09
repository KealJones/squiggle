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
import { toolFormat, PLAIN } from './toolformats/index.js';
import { heldBack } from './toolformats/text.js';

// Older names, kept for the tests and anything importing them from here.
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

// q4f16 needs the GPU's shader-f16 feature; the f32 build runs without it (more memory).
// Our own builds only come in q4f16.
async function pickId(mlc) {
  if (custom.has(mlc)) return mlc;
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

// format: a tool format id (toolformats/) for models whose tools go through their own template (native),
// null for the fenced ```tool_call format and chat-only models (plain text both ways).
// engine: an already-made engine with WebLLM's API (tests pass a fake).
export async function createShim(mlc, contextSize, onStage = () => {}, { format = null, engine: given = null } = {}) {
  const id = given ? mlc : await pickId(mlc);
  const fmt = toolFormat(format) || PLAIN;
  const manifest = Boolean((custom.get(id) || {}).model_manifest);
  onStage('loading the model onto the GPU');
  const engine = given || await (await libFor(id)).CreateMLCEngine(id, {
    appConfig: await appConfigFor(id),
    initProgressCallback: (p) => onStage(/fetch/i.test(p.text || '') ? 'downloading the model' : 'loading the model onto the GPU'),
  }, { context_window_size: contextSize });

  // One reply. Chat formats go through WebLLM's chat API, raw ones send the rendered prompt as a text
  // completion. Either way the reply streams back as thinking (reasoning_content) and text, with the
  // format's call block held back and handed over as delta.tool_calls at the end.
  async function* stream(opts, signal) {
    // A chat format with no tools and no thinking switch (a background job) is plain text, as before.
    const f = fmt.mode === 'raw' || (fmt !== PLAIN && (opts.tools || opts.chat_template_kwargs)) ? fmt : PLAIN;
    const thinking = opts.chat_template_kwargs ? Boolean(opts.chat_template_kwargs.enable_thinking) : undefined;
    const history = opts.messages || [];
    const tools = opts.tools || [];
    const onAbort = () => { try { engine.interruptGenerate(); } catch {} };
    signal && signal.addEventListener('abort', onAbort, { once: true });
    try {
      let chunks, prompt = '';
      if (f.mode === 'raw') {
        // WebLLM puts the conversation's prefix tokens (BOS) in front of a raw completion only on its manifest
        // path; a build without a manifest gets the prompt as is (web-llm 0.2.86/0.2.87 getInputData).
        prompt = (f.bos && !manifest ? f.bos : '') + f.prompt(history, tools, { thinking: Boolean(thinking), names: opts.tool_names || [] });
        try { await engine.resetChat(); } catch {}         // raw completions need an empty KV cache
        chunks = await engine.completions.create({ prompt, stream: true, max_tokens: opts.max_tokens, ...sampling(opts), stop: f.stop });
      } else {
        let messages = f.messages(history, tools, { thinking });
        // WebLLM can't continue an assistant turn; a prefilled retry starts the reply fresh instead.
        while (messages.length && messages[messages.length - 1].role === 'assistant') messages = messages.slice(0, -1);
        chunks = await engine.chat.completions.create({
          messages,
          stream: true,
          max_tokens: opts.max_tokens,
          ...sampling(opts),
          ...(thinking === undefined ? {} : { extra_body: { enable_thinking: thinking } }),
        });
      }
      const ctx = { thinking, prompt };
      const visible = (text) => {
        if (!f.callStart) return text;
        const at = text.indexOf(f.callStart);
        // Whitespace before a call isn't shown; it's sent once more text follows.
        return (at >= 0 ? text.slice(0, at) : text.slice(0, text.length - heldBack(text, f.callStart))).replace(/\s+$/, '');
      };
      let raw = '', shownThink = 0, shownText = 0;
      for await (const c of chunks) {
        if (signal && signal.aborted) break;
        const ch = c.choices && c.choices[0];
        const piece = (ch && (ch.text ?? (ch.delta && ch.delta.content))) || '';
        if (!piece) continue;
        raw += piece;
        const s = f.split(raw, ctx);
        if (s.thinking.length > shownThink) { yield { choices: [{ delta: { reasoning_content: s.thinking.slice(shownThink) } }] }; shownThink = s.thinking.length; }
        if (s.pending) continue;
        const text = visible(s.text);
        if (text.length > shownText) { yield { choices: [{ delta: { content: text.slice(shownText) } }] }; shownText = text.length; }
      }
      // Thinking that never closed (cut off by max_tokens): it was all thinking, no reply.
      const s = f.split(raw, ctx);
      if (!f.callStart) {
        if (s.text.length > shownText) yield { choices: [{ delta: { content: s.text.slice(shownText) } }] };
        return;
      }
      const at = s.text.indexOf(f.callStart);
      const before = (at >= 0 ? s.text.slice(0, at) : s.text).replace(/\s+$/, '');
      if (before.length > shownText) yield { choices: [{ delta: { content: before.slice(shownText) } }] };
      const calls = at >= 0 ? f.parseCalls(s.text.slice(at)) : [];
      if (calls.length) yield callChunk(calls);
    } finally {
      signal && signal.removeEventListener('abort', onAbort);
    }
  }

  return {
    async createChatCompletion(opts) { return stream(opts, opts.abortSignal); },
    async exit() { try { await engine.unload(); } catch {} },
    info: { gpu: true, threads: 1, compat: false, webllm: true, webllmVersion: versionFor(id), toolFormat: fmt.id, toolNames: Boolean(fmt.listsNames), id },
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
    info: { ...w.info, asked: { gpu: true, threads: false, isolated: Boolean(globalThis.crossOriginIsolated), webgpu: true } },
    createConversation: async (cfg) => (native ? new NativeConversation(w, cfg) : new Conversation(w, cfg)),
    delete: async () => { try { await w.exit(); } catch {} },
  };
}
