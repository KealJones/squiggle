// Hugging Face (ONNX) models on onnxruntime-web: Gemma 4 E2B "mobile" (QAT),
// Gemma 3, SmolLM2 and SmolLM3. Exposes the same conversation interface as
// LiteRT-LM (createConversation → sendMessageStreaming / cancel / delete), so
// engine.js and agent.js don't care which runtime runs a model.
//
// Gemma 4 E2B's embedding tables are 1.3 GB but each token only needs one
// ~5 KB row, so they stay in storage and rows are read per token (RowLookup).
// That keeps the in-memory part of the model at about 1 GB, which is what lets
// it fit on a phone.
import { Tokenizer, Template } from '../vendor/hf.js';

const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
let ort = null;
const dbg = (...a) => { if (globalThis.SQUIGGLE_DEBUG) console.error('[onnx]', ...a); };

async function loadOrt() {
  if (ort) return ort;
  ort = await import(ORT_BASE + 'ort.webgpu.min.mjs');
  ort.env.wasm.wasmPaths = ORT_BASE;
  ort.env.wasm.numThreads = 1; // no cross-origin isolation on static hosting
  ort.env.wasm.proxy = false;
  return ort;
}

export async function gpuHasF16() {
  try {
    const a = await navigator.gpu?.requestAdapter();
    return Boolean(a && a.features.has('shader-f16'));
  } catch { return false; }
}

// ── fp16 helpers ──────────────────────────────────────────────────────────
const HALF = (() => {
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return t;
})();
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function toHalfBits(x) {
  f32[0] = x;
  const b = u32[0], s = (b >>> 16) & 0x8000, e = ((b >>> 23) & 0xff) - 112, m = b & 0x7fffff;
  if (e <= 0) {
    if (e < -10) return s;
    const mm = (m | 0x800000) >> (1 - e);
    return s | ((mm + 0x0fff + ((mm >> 13) & 1)) >> 13);
  }
  if (e >= 31) return s | 0x7c00 | (((b >>> 23) & 0xff) === 0xff && m ? 0x200 : 0);
  const r = s | (e << 10) | (m >> 13);
  const rem = m & 0x1fff;
  return rem > 0x1000 || (rem === 0x1000 && (r & 1)) ? r + 1 : r;
}
export const f16round = Math.f16round || ((x) => HALF[toHalfBits(x)]);

// ── Embedding rows read from storage ──────────────────────────────────────
// spec: { tables: [{ w, rowBytes, s, blocks, bits, dim, mul, zeroIds? }], vocab }
export class RowLookup {
  constructor(read, spec, cap = 4096) {
    this.read = read; this.spec = spec; this.cap = cap; this.cache = new Map();
  }
  async rowsFor(ids) {
    const missing = [...new Set(ids)].filter(id => !this.cache.has(id));
    for (let i = 0; i < missing.length; i += 32) {
      await Promise.all(missing.slice(i, i + 32).map(async (id) => {
        const parts = await Promise.all(this.spec.tables.map(async (t) => {
          const src = t.zeroIds && t.zeroIds.includes(id) ? 0 : id;
          const [w, s] = await Promise.all([this.read(t.w + src * t.rowBytes, t.rowBytes), this.read(t.s + src * t.blocks * 2, t.blocks * 2)]);
          return { w, s: new Uint16Array(s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength)) };
        }));
        this.cache.set(id, parts);
      }));
    }
    while (this.cache.size > this.cap) this.cache.delete(this.cache.keys().next().value);
  }
  // Returns one Float32Array per table, each [ids.length * dim].
  async embed(ids) {
    await this.rowsFor(ids);
    return this.spec.tables.map((t, ti) => {
      const out = new Float32Array(ids.length * t.dim);
      const per = 8 / t.bits, mask = (1 << t.bits) - 1, zp = 1 << (t.bits - 1), block = t.dim / t.blocks;
      const mul = f16round(t.mul);
      ids.forEach((id, n) => {
        const { w, s } = this.cache.get(id)[ti];
        const base = n * t.dim;
        for (let j = 0; j < t.dim; j++) {
          const q = (w[(j / per) | 0] >> (t.bits * (j % per))) & mask;
          out[base + j] = f16round(f16round((q - zp) * HALF[s[(j / block) | 0]]) * mul);
        }
      });
      return out;
    });
  }
}

// ── Gemma 4 native tool-call syntax ───────────────────────────────────────
const Q = '<|"|>';
export function formatArg(v) {
  if (typeof v === 'string') return Q + v + Q;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return '[' + v.map(formatArg).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => k + ':' + formatArg(v[k])).join(',') + '}';
  return v == null ? 'null' : String(v);
}
export function toolResponseText(name, response) {
  const body = response && typeof response === 'object' && !Array.isArray(response)
    ? Object.keys(response).sort().map(k => k + ':' + formatArg(response[k])).join(',')
    : 'value:' + formatArg(response);
  return `response:${name}{${body}}<tool_response|>`;
}
// Parses `name{key:<|"|>text<|"|>,n:3,flag:true,list:[...],obj:{...}}`.
export function parseGemmaCall(src) {
  const m = /^\s*(?:call:)?([\w.-]+)\s*\{/.exec(src);
  if (!m) return null;
  let i = m[0].length - 1;
  const ws = () => { while (/\s/.test(src[i] || '')) i++; };
  function value() {
    ws();
    if (src.startsWith(Q, i)) { const end = src.indexOf(Q, i + Q.length); const s = src.slice(i + Q.length, end < 0 ? src.length : end); i = end < 0 ? src.length : end + Q.length; return s; }
    if (src[i] === '"') { let j = i + 1, s = ''; while (j < src.length && src[j] !== '"') { if (src[j] === '\\') j++; s += src[j++]; } i = j + 1; return s; }
    if (src[i] === '{') return obj();
    if (src[i] === '[') { i++; const a = []; ws(); while (i < src.length && src[i] !== ']') { a.push(value()); ws(); if (src[i] === ',') i++; ws(); } i++; return a; }
    const tok = /^[^,}\]]*/.exec(src.slice(i))[0]; i += tok.length; const t = tok.trim();
    if (t === 'true') return true; if (t === 'false') return false; if (t === 'null') return null;
    return t !== '' && !isNaN(+t) ? +t : t;
  }
  function obj() {
    i++; const o = {}; ws();
    while (i < src.length && src[i] !== '}') {
      let key;
      if (src.startsWith(Q, i)) key = value();
      else { const k = /^[^:}]*/.exec(src.slice(i))[0]; i += k.length; key = k.trim(); }
      ws(); if (src[i] === ':') i++;
      o[key] = value(); ws();
      if (src[i] === ',') i++; ws();
    }
    i++; return o;
  }
  return { function: { name: m[1], arguments: obj() } };
}

// Tools for models without a native tool format: listed in the system prompt,
// called with <tool_call>{json}</tool_call>.
export function toolPrompt(tools) {
  const lines = tools.map(t => {
    const p = t.parameters && t.parameters.properties || {};
    const req = new Set(t.parameters && t.parameters.required || []);
    const args = Object.entries(p).map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${v.type || 'any'}`).join(', ');
    return `- ${t.name}(${args}): ${t.description}`;
  });
  return `You can use tools. To call one, reply with only this and nothing after it:\n<tool_call>{"name": "tool_name", "arguments": {...}}</tool_call>\nThen wait for the result. Tools:\n${lines.join('\n')}`;
}
export function parseJsonCall(text) {
  const m = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/.exec(text);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]);
    if (j && j.name) return { function: { name: j.name, arguments: j.arguments || j.parameters || {} } };
  } catch {}
  return null;
}

// What to show while streaming a model without native tool tokens: drop
// <think> blocks and tool calls, and hold back a possible half-written tag.
export function visible(text, final) {
  let v = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/<think>[\s\S]*$/, '').replace(/<tool_call>[\s\S]*$/, '');
  if (!final) { const m = /<[a-z_/]*$/i.exec(v); if (m) v = v.slice(0, m.index); }
  return final ? v.trimEnd() : v;
}
export const thinkText = (text) => { const m = /<think>([\s\S]*?)(?:<\/think>|$)/.exec(text); return m ? m[1] : ''; };

// ── Engine ────────────────────────────────────────────────────────────────
// files: { json(path), text(path), bytes(path), reader(path) → read(off, len) }
export async function createEngine(spec, files, { contextSize = 4096, useGpu = true } = {}) {
  const o = await loadOrt();
  const tokJson = await files.json('tokenizer.json');
  const tokCfg = await files.json('tokenizer_config.json');
  const tokenizer = new Tokenizer(tokJson, tokCfg);
  dbg('tokenizer ready');
  const templateSrc = spec.files['chat_template.jinja'] ? await files.text('chat_template.jinja') : tokCfg.chat_template;
  const template = new Template(templateSrc);
  const gen = spec.files['generation_config.json'] ? await files.json('generation_config.json') : {};
  const ids = (s) => tokenizer.encode(s, { add_special_tokens: false }).ids;
  const one = (s) => { const t = ids(s); return t.length === 1 ? t[0] : -1; };
  const eos = new Set([].concat(gen.eos_token_id ?? [], spec.eos ?? []).map(Number));
  for (const s of spec.stopText || []) { const t = one(s); if (t >= 0) eos.add(t); }

  // The weights are only needed while the session is created; keep no reference
  // afterwards so the (up to 1 GB) buffer can be freed.
  const session = await (async () => {
    const graph = await files.bytes(spec.graph);
    dbg('graph', graph.length);
    const externalData = spec.data ? [{ path: spec.data.split('/').pop(), data: await files.bytes(spec.data) }] : undefined;
    return o.InferenceSession.create(graph, {
      executionProviders: [useGpu ? 'webgpu' : 'wasm'],
      externalData,
      graphOptimizationLevel: 'all',
      ...(useGpu ? { preferredOutputLocation: 'gpu-buffer' } : {}),
    });
  })();
  dbg('session ready');
  const meta = new Map((session.inputMetadata || []).map(m => [m.name, m]));
  const inputs = new Set(session.inputNames);
  const pastNames = session.inputNames.filter(n => n.startsWith('past_key_values'));
  const lookup = spec.lookup ? new RowLookup(files.reader(spec.lookup.file), spec.lookup, useGpu ? 4096 : 1024) : null;

  function emptyPast(name) {
    const m = meta.get(name);
    const shape = m && m.shape ? m.shape.map((d, i) => (i === 2 ? 0 : typeof d === 'number' ? d : 1)) : [1, spec.kvHeads || 1, 0, spec.headDim || 64];
    const type = m && m.type === 'float32' ? 'float32' : (spec.kvType || 'float16');
    return new o.Tensor(type, type === 'float16' ? new Uint16Array(0) : new Float32Array(0), shape);
  }

  async function lastLogits(t) {
    const data = t.location === 'gpu-buffer' ? await t.getData(true) : t.data;
    const v = t.dims[t.dims.length - 1], sub = data.subarray(data.length - v);
    let row;
    if (sub instanceof Float32Array) row = sub.slice();
    else if (sub instanceof Uint16Array) { row = new Float32Array(v); for (let k = 0; k < v; k++) row[k] = HALF[sub[k]]; }
    else row = Float32Array.from(sub); // Float16Array
    if (t.location !== 'gpu-buffer') try { t.dispose?.(); } catch {}
    return row;
  }

  class State {
    constructor() { this.past = null; this.pos = 0; }
    reset() { this.free(); this.past = null; this.pos = 0; }
    free() { if (this.past) for (const t of Object.values(this.past)) try { t.dispose?.(); } catch {} }
    // Runs tokens through the model; returns logits for the last one.
    async forward(tokens) {
      if (this.pos + tokens.length > contextSize) throw new Error(`This conversation is longer than the ${contextSize / 1024}K context window. Start a new chat or raise the context size in Settings.`);
      const chunk = spec.lookup ? 128 : 32;
      let logits = null;
      for (let s = 0; s < tokens.length; s += chunk) {
        const part = tokens.slice(s, s + chunk), n = part.length;
        const feeds = {};
        if (lookup) {
          const [e, p] = await lookup.embed(part);
          feeds.inputs_embeds = new o.Tensor('float32', e, [1, n, spec.lookup.tables[0].dim]);
          feeds.per_layer_inputs = new o.Tensor('float32', p, [1, n, spec.lookup.layers, spec.lookup.tables[1].dim / spec.lookup.layers]);
        } else {
          feeds.input_ids = new o.Tensor('int64', BigInt64Array.from(part, BigInt), [1, n]);
        }
        const total = this.pos + n;
        feeds.attention_mask = new o.Tensor('int64', new BigInt64Array(total).fill(1n), [1, total]);
        if (inputs.has('position_ids')) feeds.position_ids = new o.Tensor('int64', BigInt64Array.from({ length: n }, (_, i) => BigInt(this.pos + i)), [1, n]);
        if (inputs.has('num_logits_to_keep')) feeds.num_logits_to_keep = new o.Tensor('int64', BigInt64Array.from([1n]), []);
        for (const name of pastNames) feeds[name] = this.past ? this.past[name] : emptyPast(name);
        const out = await session.run(feeds);
        const old = this.past;
        this.past = {};
        for (const name of pastNames) this.past[name] = out[name.replace('past_key_values', 'present')];
        if (old) for (const t of Object.values(old)) try { t.dispose?.(); } catch {}
        logits = out.logits;
        if (s + chunk < tokens.length) { try { logits.dispose?.(); } catch {} logits = null; }
        this.pos = total;
      }
      return lastLogits(logits);
    }
  }

  function sample(logits, greedy) {
    let best = 0;
    for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
    if (greedy) return best;
    const K = 64, T = 0.7, P = 0.95;
    const top = [];
    for (let i = 0; i < logits.length; i++) {
      const v = logits[i];
      if (top.length < K) { top.push([v, i]); if (top.length === K) top.sort((a, b) => a[0] - b[0]); }
      else if (v > top[0][0]) { top[0] = [v, i]; let j = 0; while (j + 1 < K && top[j][0] > top[j + 1][0]) { [top[j], top[j + 1]] = [top[j + 1], top[j]]; j++; } }
    }
    top.sort((a, b) => b[0] - a[0]);
    const mx = top[0][0];
    let ps = top.map(([v]) => Math.exp((v - mx) / T));
    const sum = ps.reduce((a, b) => a + b, 0);
    ps = ps.map(p => p / sum);
    let acc = 0, cut = ps.length;
    for (let i = 0; i < ps.length; i++) { acc += ps[i]; if (acc >= P) { cut = i + 1; break; } }
    let r = Math.random() * ps.slice(0, cut).reduce((a, b) => a + b, 0);
    for (let i = 0; i < cut; i++) { r -= ps[i]; if (r <= 0) return top[i][1]; }
    return top[0][1];
  }

  const render = (messages, tools, thinking) => template.render({
    messages, tools: tools && tools.length ? tools : undefined, add_generation_prompt: true,
    bos_token: tokCfg.bos_token?.content ?? tokCfg.bos_token ?? '', eos_token: tokCfg.eos_token?.content ?? tokCfg.eos_token ?? '',
    enable_thinking: Boolean(thinking),
  });

  const native = spec.family === 'gemma4';
  const T = native ? { call: one('<|tool_call>'), callEnd: one('<tool_call|>'), resp: one('<|tool_response>'), ch: one('<|channel>'), chEnd: one('<channel|>') } : {};

  class Conversation {
    constructor({ preface, sessionConfig }) {
      this.state = new State();
      this.system = preface.messages[0].content;
      this.history = preface.messages.slice(1);
      this.tools = (preface.tools || []).map(t => t.function);
      this.thinking = Boolean(preface.extra_context && preface.extra_context.enable_thinking) && native;
      this.max = sessionConfig.maxOutputTokens || 1024;
      this.greedy = sessionConfig.samplerParams && sessionConfig.samplerParams.type === 3;
      this.cancelled = false;
      this.lastTok = -1;
      this.lastText = '';
    }
    cancel() { this.cancelled = true; }
    async delete() { this.state.free(); }

    messages(extra) {
      const sys = native || !this.tools.length ? this.system : this.system + '\n\n' + toolPrompt(this.tools);
      return [{ role: 'system', content: sys }, ...this.history, ...extra];
    }

    async *sendMessageStreaming(input) {
      this.cancelled = false;
      let prompt;
      if (typeof input === 'string') {
        this.history.push({ role: 'user', content: input });
        this.state.reset();
        prompt = render(this.messages([]), native ? this.tools.map(f => ({ type: 'function', function: f })) : null, this.thinking);
      } else if (native) {
        // Continue the same model turn: feed the tool results in place.
        const blocks = input.flatMap(m => m.content).map(c => toolResponseText(c.name, c.response));
        prompt = (this.openCall ? '}<tool_call|>' : '') + (this.lastTok === T.resp ? '' : '<|tool_response>') + blocks.join('<|tool_response>');
      } else {
        const results = input.flatMap(m => m.content).map(c => `${c.name}: ${JSON.stringify(c.response)}`).join('\n');
        this.history.push({ role: 'assistant', content: this.lastText.trim() }, { role: 'user', content: `Tool results:\n${results}\n\nContinue.` });
        this.state.reset();
        prompt = render(this.messages([]), null, false);
      }
      let logits = await this.state.forward(ids(prompt));

      // Stream: text, thinking, and tool calls, split by special tokens (Gemma 4)
      // or by text markers (others).
      let mode = 'text', seg = [], segText = '', callBuf = [], allText = '', shown = 0, thoughtShown = 0;
      const flushDelta = () => {
        const s = tokenizer.decode(seg, { skip_special_tokens: true });
        const d = s.slice(segText.length);
        segText = s;
        return d;
      };
      for (let n = 0; n < this.max && !this.cancelled; n++) {
        const tok = sample(logits, this.greedy);
        this.lastTok = tok;
        (this.raw = this.raw || []).push(tok);
        if (eos.has(tok)) break;
        if (native) {
          if (tok === T.resp) break; // waiting for tool results
          if (tok === T.ch) { mode = 'thought'; seg = []; segText = ''; }
          else if (tok === T.chEnd) { mode = 'text'; seg = []; segText = ''; }
          else if (tok === T.call) { mode = 'call'; callBuf = []; }
          else if (tok === T.callEnd) {
            const call = parseGemmaCall(tokenizer.decode(callBuf, { skip_special_tokens: false }));
            if (call) yield { tool_calls: [call] };
            mode = 'text'; seg = []; segText = '';
          } else if (mode === 'call') callBuf.push(tok);
          else {
            seg.push(tok);
            let d = flushDelta();
            if (mode === 'thought') { if (segText.startsWith('thought\n') && segText.length - d.length < 8) d = segText.slice(8); if (d) yield { thinking: d }; }
            else if (d) { allText += d; yield { content: d }; }
          }
        } else {
          seg.push(tok);
          allText += flushDelta();
          const th = thinkText(allText);
          if (th.length > thoughtShown) { yield { thinking: th.slice(thoughtShown) }; thoughtShown = th.length; }
          const v = visible(allText, false);
          if (v.length > shown) { yield { content: v.slice(shown) }; shown = v.length; }
          if (/<\/tool_call>/.test(allText)) break;
        }
        logits = await this.state.forward([tok]);
      }
      // A call cut off by end-of-turn (the 2-bit model sometimes skips the closing
      // marker): parse what's there.
      this.openCall = native && mode === 'call' && callBuf.length > 0;
      if (this.openCall) {
        const call = parseGemmaCall(tokenizer.decode(callBuf, { skip_special_tokens: true }));
        if (call) yield { tool_calls: [call] };
      }
      dbg('generated', JSON.stringify(tokenizer.decode(this.raw || [], { skip_special_tokens: false })));
      this.raw = [];
      if (!native) {
        const v = visible(allText, true);
        if (v.length > shown) yield { content: v.slice(shown) };
        this.lastText = allText;
        const call = parseJsonCall(allText);
        if (call) yield { tool_calls: [call] };
      }
    }
  }

  return {
    createConversation: async (cfg) => new Conversation(cfg),
    delete: async () => { try { await session.release(); } catch {} },
    info: { useGpu, inputs: [...inputs] },
  };
}
