// Small on-device model for phones: Gemma 3 270M as a 4-bit GGUF on llama.cpp's
// WebAssembly build (wllama), CPU only. It needs no WebGPU and about a quarter
// GB of memory, so it fits a phone browser tab where the Gemma 4 models don't.
// Same conversation interface as the other engines.
//
// Format (docs/harness.md, "Small-model format"; the fine-tune trains on it):
// the model may open with <think>…</think> (streamed to the thinking view, not
// replayed), calls a tool with a ```tool_call fenced JSON block (hidden from
// the reply and parsed into a call), and gets results back as a user turn
// "Result of <tool>:\n<json>". Bad calls come back to it as tool errors.
const VERSION = '3.8.1';
const LIB = `https://cdn.jsdelivr.net/npm/@wllama/wllama@${VERSION}/esm/index.min.js`;
const WASM = `https://cdn.jsdelivr.net/npm/@wllama/wllama@${VERSION}/esm/wasm/wllama.wasm`;
const MAX_OUTPUT = 1024;
const REPEAT_PENALTY = 1.15;
const LOOP_WORDS = 8;     // a run of this many words…
const LOOP_TIMES = 3;     // …written this many times stops the reply
const FENCE = '```tool_call';

let lib = null;
const getLib = async () => lib || (lib = await import(LIB));
const cache = async () => new (await getLib()).CacheManager();

// ── Download (wllama keeps the file in its own cache) ─────────────────────

export async function isDownloaded(url) {
  try {
    const blob = await (await cache()).open(url);
    return Boolean(blob && blob.size);
  } catch { return false; }
}

export async function downloadModel(url, onProgress, signal) {
  await (await cache()).download(url, {
    signal,
    progressCallback: ({ loaded, total }) => onProgress && onProgress(loaded, total),
  });
}

export async function removeModel(url) {
  try { await (await cache()).delete(url); } catch {}
}

// ── Prompt shaping ────────────────────────────────────────────────────────

const textOf = (c) => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('')
  : c == null ? '' : String(c);

// Tools: the prompt never lists tool names in prose (a 270M model copies
// them back). The system prompt (agent.js) names the harness tools; the model
// looks real tools up with `find`, which the agent answers, and the tools it
// found are described here from then on (docs/harness.md, "Small-model format").
const toolLine = (t) => {
  const f = t.function || t;
  const props = (f.parameters && f.parameters.properties) || {};
  const req = new Set((f.parameters && f.parameters.required) || []);
  const args = Object.keys(props).map(k => req.has(k) ? k : k + '?').join(', ');
  const desc = String(f.description || '').split(/(?<=\.)\s/)[0].slice(0, 140);
  return `- ${f.name}(${args}): ${desc}`;
};
const nameOf = (t) => (t.function || t).name;

// Ranks tools against a query by word overlap with name and description
// (the old find_tools; find.js's rankTools is what `find` uses now).
export function findTools(tools, query, k = 3) {
  const words = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1);
  const scored = tools.map((t) => {
    const f = t.function || t;
    const name = f.name.toLowerCase();
    const hay = (name.replace(/_/g, ' ') + ' ' + String(f.description || '')).toLowerCase();
    let score = 0;
    for (const w of words) {
      if (name === w) score += 6;
      else if (name.includes(w)) score += 3;
      if (hay.includes(w)) score += 1;
    }
    return { t, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map(x => x.t);
}

// Details of the tools the model has looked up (the harness tools are in the system prompt).
const HARNESS = new Set(['plan', 'done', 'need', 'find']);
export function toolPrompt(tools, active) {
  const known = tools.filter(t => active.has(nameOf(t)) && !HARNESS.has(nameOf(t)));
  return known.length ? 'Tools you have looked up:\n' + known.map(toolLine).join('\n') : '';
}

// Gemma's chat template takes one system message, then strict user/assistant
// turns starting with the user. Fold Squiggle's history into that shape: extra
// system notes join the system message, tool results become user turns, and
// back-to-back turns of the same role are merged.
export function gemmaMessages(messages, tools = [], active = new Set()) {
  const system = [];
  const turns = [];
  const push = (role, content) => {
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += '\n\n' + content;
    else turns.push({ role, content });
  };
  for (const m of messages) {
    let role = m.role === 'model' ? 'assistant' : m.role;
    let content = textOf(m.content).trim();
    if (role === 'tool') {
      const parts = Array.isArray(m.content) ? m.content : [];
      content = parts.map(p => `Result of ${p.name}:\n${JSON.stringify(p.response)}`).join('\n\n') || content;
      role = 'user';
    }
    if (!content) continue;
    if (role === 'system') { system.push(content); continue; }
    if (role === 'user' || role === 'assistant') push(role, content);
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  const tp = toolPrompt(tools, active);
  if (tp) system.push(tp);
  return [...(system.length ? [{ role: 'system', content: system.join('\n\n') }] : []), ...turns];
}

let callId = 0;
// Parses ```tool_call blocks (or a bare {"name": …} object) into calls.
export function parseToolCalls(text) {
  const calls = [];
  const blocks = [];
  const re = /```tool_call\s*([\s\S]*?)(```|$)/g;
  let m;
  while ((m = re.exec(text))) blocks.push(m[1]);
  for (const raw of blocks) {
    const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    let obj = null;
    try { obj = JSON.parse(json); } catch { continue; }
    const name = obj && (obj.name || obj.tool);
    if (!name) continue;
    let args = obj.arguments ?? obj.args ?? obj.parameters ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    calls.push({ id: 'call' + (++callId), type: 'function', function: { name: String(name), arguments: args && typeof args === 'object' ? args : {} } });
  }
  return calls;
}

// ── Engine ────────────────────────────────────────────────────────────────

const MARK = '```tool';
const OPEN = '<think>', CLOSE = '</think>';
// How many characters at the end of `text` could be the start of `mark`.
function heldBack(text, mark = MARK) {
  for (let k = Math.min(mark.length - 1, text.length); k > 0; k--) if (mark.startsWith(text.slice(-k))) return k;
  return 0;
}

// Splits raw output into thinking and reply text. `open` is true while the
// thinking block hasn't closed yet.
export function splitThinking(raw) {
  const lead = raw.length - raw.trimStart().length;
  const rest = raw.slice(lead);
  if (!rest) return { thinking: '', text: '', pending: true };
  if (OPEN.startsWith(rest)) return { thinking: '', text: '', pending: true };   // "<thi" so far
  // llama.cpp already moved the thinking to reasoning_content and left its closing tag behind.
  if (CLOSE.startsWith(rest)) return { thinking: '', text: '', pending: true };
  if (rest.startsWith(CLOSE)) return { thinking: '', text: rest.slice(CLOSE.length).replace(/^\s+/, '') };
  if (!rest.startsWith(OPEN)) return { thinking: '', text: raw };
  const body = rest.slice(OPEN.length);
  const end = body.indexOf(CLOSE);
  if (end < 0) return { thinking: body.slice(0, body.length - heldBack(body, CLOSE)), text: '', open: true };
  return { thinking: body.slice(0, end), text: body.slice(end + CLOSE.length).replace(/^\s+/, '') };
}

// True when some run of LOOP_WORDS words appears LOOP_TIMES times: the small
// model is repeating itself and won't stop on its own.
// The run of words that repeats (for telling the model where it got stuck), or ''.
export function repeatedRun(text, n = LOOP_WORDS, times = LOOP_TIMES) {
  const words = String(text).toLowerCase().match(/[a-z0-9_']+/g) || [];
  const seen = new Map();
  for (let i = 0; i + n <= words.length; i++) {
    const key = words.slice(i, i + n).join(' ');
    const c = (seen.get(key) || 0) + 1;
    if (c >= times) return key;
    seen.set(key, c);
  }
  return '';
}

// The reply up to where the repeating started (cut back to the last sentence or
// line end before it), or '' when too little came before the loop to keep.
export function beforeLoop(raw, run) {
  const words = String(run || '').split(' ').filter(Boolean);
  if (!words.length) return '';
  const re = new RegExp(words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(`[^a-z0-9_']+`), 'i');
  const m = re.exec(raw);
  if (!m) return '';
  let cut = raw.slice(0, m.index);
  const end = Math.max(cut.lastIndexOf('\n'), cut.search(/[.!?](?=[^.!?]*$)/) + 1);
  if (end > 0) cut = cut.slice(0, end);
  return cut.replace(/\s+$/, '').length >= 30 ? cut.replace(/\s+$/, '') : '';
}
export const MOVING_ON = '\n(I was repeating myself. Moving on.)\n';

// Sent to the model after a loop is stopped, once per reply; it gets one more try.
export const loopNote = (run) => `(Squiggle: your last reply got stuck repeating "${run}" and was stopped and dropped. ` +
  'Start over. In a short Check, say what you actually have so far, or that it doesn\'t answer the question. ' +
  'Then call one tool or give the answer. Don\'t repeat anything.)';

export function isLooping(text, n = LOOP_WORDS, times = LOOP_TIMES) {
  const words = String(text).toLowerCase().match(/[a-z0-9_']+/g) || [];
  if (words.length < n * times) return false;
  const seen = new Map();
  for (let i = 0; i + n <= words.length; i++) {
    const key = words.slice(i, i + n).join(' ');
    const c = (seen.get(key) || 0) + 1;
    if (c >= times) return true;
    seen.set(key, c);
  }
  return false;
}

export class Conversation {
  constructor(w, { preface, sessionConfig }) {
    this.w = w;
    this.messages = [...preface.messages];
    this.tools = preface.tools || [];
    this.active = new Set(preface.known || []);   // tools looked up with find (or already called)
    this.max = Math.min(sessionConfig.maxOutputTokens || MAX_OUTPUT, MAX_OUTPUT);
    this.greedy = Boolean(sessionConfig.samplerParams && sessionConfig.samplerParams.type === 3);
    this.ctrl = null;
  }
  cancel() { try { this.ctrl && this.ctrl.abort(); } catch {} }
  // Swaps a tool result already in history (the object sendMessageStreaming got)
  // for a shorter one. Returns true when it was found.
  replaceResult(msg, response) {
    const i = this.messages.indexOf(msg);
    if (i < 0 || !Array.isArray(msg.content)) return false;
    this.messages[i] = { ...msg, content: msg.content.map(p => ({ ...p, response })) };
    return true;
  }
  async delete() {}

  // One model reply. Yields { thinking } and { content } pieces as they come
  // (a tool-call block is held back), then returns { calls, aborted, looped, run }.
  // With canRetry, a looping reply is dropped (not kept in history) so the caller
  // can tell the model and try again; `retry` raises the repetition penalty.
  // `prefill` continues a reply already begun: the model writes on from it, and
  // nothing of it is shown again.
  async *generate({ canRetry = false, retry = false, prefill = '' } = {}) {
    const ctrl = this.ctrl = new AbortController();
    const pre = prefill ? splitThinking(prefill) : null;
    let echo = prefill ? '' : null;   // llama.cpp streams the prefill back first; it's skipped
    let out = prefill, thinkShown = pre ? pre.thinking.length : 0, shown = pre && !pre.open ? pre.text.length : 0, inCall = false, looped = false, text = '', checked = 0, reasoning = '', rChecked = 0;
    // Stop output that keeps repeating itself: checked at sentence ends, and at least
    // every 200 characters ("+ 2 + 2 + 2…" has no sentence ends).
    const loops = (buf, last, piece) => (/[.!?\n]/.test(piece) && buf.length - last > 40) || buf.length - last > 200;
    const tools = this.tools.length > 0;
    const t0 = performance.now();
    let tFirst = 0, pieces = 0;
    try {
      const stream = await this.w.createChatCompletion({
        messages: [...gemmaMessages(this.messages, this.tools, this.active), ...(prefill ? [{ role: 'assistant', content: prefill }] : [])],
        stream: true,
        max_tokens: this.max,
        temperature: this.greedy ? 0 : 0.7,
        top_k: 64,
        top_p: 0.95,
        penalty_repeat: retry ? 1.3 : REPEAT_PENALTY,
        cache_prompt: true,
        abortSignal: ctrl.signal,
      });
      for await (const chunk of stream) {
        const delta = (chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta) || {};
        if (delta.reasoning_content || delta.content) { pieces++; if (!tFirst) tFirst = performance.now(); }
        // llama.cpp may split a <think> block off into reasoning_content (it does
        // for chat templates that know about thinking, like LFM2.5's).
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          yield { thinking: delta.reasoning_content };
          if (loops(reasoning, rChecked, delta.reasoning_content)) {
            rChecked = reasoning.length;
            if (isLooping(reasoning.slice(-3000))) { looped = true; ctrl.abort(); break; }
          }
          continue;
        }
        let piece = delta.content;
        if (!piece) continue;
        if (echo !== null) {
          echo += piece;
          if (prefill.startsWith(echo) && echo.length < prefill.length) continue;
          piece = echo.startsWith(prefill) ? echo.slice(prefill.length) : echo;
          echo = null;
          if (!piece) continue;
        }
        out += piece;
        const parts = splitThinking(out);
        if (parts.thinking.length > thinkShown) { yield { thinking: parts.thinking.slice(thinkShown) }; thinkShown = parts.thinking.length; }
        text = parts.text;
        if (loops(out, checked, piece)) {
          checked = out.length;
          if (isLooping(out.slice(-3000))) { looped = true; ctrl.abort(); break; }
        }
        if (inCall || parts.open || parts.pending) continue;
        const at = tools ? text.indexOf(MARK) : -1;
        if (at >= 0) {
          inCall = true;
          if (at > shown) yield { content: text.slice(shown, at) };
          shown = at;
          continue;
        }
        const safe = text.length - (tools ? heldBack(text) : 0);
        if (safe > shown) { yield { content: text.slice(shown, safe) }; shown = safe; }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) throw e;
    }
    // Speed of this call: how long before the first token (mostly reading the
    // prompt) and tokens per second after (streamed pieces are about one token each).
    if (tFirst) speed = { waitMs: Math.round(tFirst - t0), tokens: pieces, perSec: pieces > 1 ? Math.round(10 * (pieces - 1) / ((performance.now() - tFirst) / 1000)) / 10 : null };
    const parts = splitThinking(out);
    text = parts.open ? '' : parts.text;
    if (parts.open && parts.thinking.length > thinkShown) yield { thinking: parts.thinking.slice(thinkShown) };
    if (looped && canRetry) {
      const raw = reasoning ? `<think>\n${reasoning}${out ? '\n</think>\n' + out.replace(/^\s*<\/think>\s*/, '') : ''}` : out;
      const run = repeatedRun(raw);
      const kept = beforeLoop(raw, run);
      const inText = shown > 0 || (reasoning && out.trim());
      const note = kept ? 'got stuck repeating itself; Squiggle cut the repeats and let it carry on from before them' : 'got stuck repeating itself; Squiggle stopped it and asked it to try again';
      if (inText) yield { content: `\n\n_(${note})_\n\n` };
      else yield { thinking: `\n\n[It ${note}.]\n\n` };
      return { calls: [], aborted: false, looped: true, run, kept };
    }
    const calls = inCall ? parseToolCalls(text.slice(shown)) : [];
    if (text.length > shown && !calls.length) yield { content: text.slice(shown) };   // incl. an unparseable block
    if (looped) yield { content: '\n\n_(stopped: the model was repeating itself)_' };
    // Thinking is never replayed into history.
    this.messages.push({ role: 'assistant', content: text || '(thought about it)' });
    return { calls, aborted: ctrl.signal.aborted && !looped };
  }

  async *sendMessageStreaming(input) {
    if (typeof input === 'string') this.messages.push({ role: 'user', content: input });
    else {
      for (const m of input) {                                       // tool results from the agent
        this.messages.push(m);
        // Tools `find` turned up are described in the prompt from now on.
        for (const p of Array.isArray(m.content) ? m.content : []) {
          const found = p && p.response && p.response.tools;
          if (Array.isArray(found)) for (const n of found) this.active.add(String(n));
        }
      }
    }
    let res = yield* this.generate({ canRetry: true });
    if (res.looped && res.kept) {
      // Keep what it wrote before the loop and let it carry on from there.
      const kept = res.kept;
      const prefill = kept + (/^<think>/.test(kept) && !kept.includes('</think>') ? MOVING_ON : '\n');
      res = yield* this.generate({ retry: true, prefill });
    } else if (res.looped) {
      // Too little before the loop to keep: tell the model where it got stuck and
      // let it start over; the note leaves history afterwards.
      const note = { role: 'user', content: loopNote(res.run) };
      this.messages.push(note);
      res = yield* this.generate({ retry: true });
      const i = this.messages.indexOf(note);
      if (i >= 0) this.messages.splice(i, 1);
    }
    const { calls, aborted } = res;
    if (aborted || !calls.length) return;
    for (const c of calls) {
      if (c.function.name === 'find_tools') c.function.name = 'find';     // the old name
      this.active.add(c.function.name);                                   // calling a real tool unlooked-up is fine
    }
    yield { tool_calls: calls };
  }
}

// Speed of the last call (see generate), for the composer note.
let speed = null;
export const lastSpeed = () => speed;

// gpu: offload every layer to WebGPU when the browser has it.
// threads: use several CPU cores; needs a cross-origin isolated page
// (sw.js adds the headers when the setting is on), otherwise one thread.
const safe = (fn, d) => { try { return fn(); } catch { return d; } };

export async function createEngine(url, contextSize, onStage = () => {}, { gpu = false, threads = false } = {}) {
  onStage('starting the runtime');
  const { Wllama } = await getLib();
  const w = new Wllama({ default: WASM }, { suppressNativeLog: true });
  const useGpu = Boolean(gpu) && safe(() => w.isSupportWebGPU(), false);
  const cores = Math.max(1, Math.min(4, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1));
  const n = threads && globalThis.crossOriginIsolated ? Math.max(2, cores) : 1;
  onStage(useGpu ? 'loading the model onto the GPU' : 'loading the model into memory');
  await w.loadModelFromUrl(url, { n_ctx: contextSize, n_gpu_layers: useGpu ? 999 : 0, n_threads: n });
  speed = null;
  const info = {
    gpu: useGpu,
    threads: safe(() => w.isMultithread(), false) ? n : 1,
    // Safari lacks JSPI/Memory64, so wllama runs its slower compatibility build there.
    compat: safe(() => w.getWorkerResources().compat, false),
    asked: { gpu: Boolean(gpu), threads: Boolean(threads), isolated: Boolean(globalThis.crossOriginIsolated), webgpu: safe(() => w.isSupportWebGPU(), false) },
  };
  return {
    info,
    createConversation: async (cfg) => new Conversation(w, cfg),
    delete: async () => { try { await w.exit(); } catch {} },
  };
}
