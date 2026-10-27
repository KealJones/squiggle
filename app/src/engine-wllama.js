// Small on-device model for phones: Gemma 3 270M as a 4-bit GGUF on llama.cpp's
// WebAssembly build (wllama), CPU only. It needs no WebGPU and about a quarter
// GB of memory, so it fits a phone browser tab where the Gemma 4 models don't.
// Same conversation interface as the other engines.
//
// Tools: Gemma 3 has no tool-calling format of its own, so tools are described
// compactly in the system prompt and the model calls one by writing a
// ```tool_call fenced JSON block (the prompt-based approach Google suggests
// for Gemma 3). The block is hidden from the reply and parsed into a call.
// Tool results go back as a user turn. A 270M model will often get this wrong;
// bad calls come back to it as tool errors, like with any model.
const VERSION = '3.8.1';
const LIB = `https://cdn.jsdelivr.net/npm/@wllama/wllama@${VERSION}/esm/index.min.js`;
const WASM = `https://cdn.jsdelivr.net/npm/@wllama/wllama@${VERSION}/esm/wasm/wllama.wasm`;
const MAX_OUTPUT = 768;
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

// Tool search: listing every tool's description up front costs a 270M model
// thousands of prompt tokens on a phone CPU. Instead the prompt names the tools
// and offers find_tools; the engine answers find_tools itself (the agent never
// sees it) and adds the matching tools' details to the prompt.
export const FIND_TOOLS = 'find_tools';

const toolLine = (t) => {
  const f = t.function || t;
  const props = (f.parameters && f.parameters.properties) || {};
  const req = new Set((f.parameters && f.parameters.required) || []);
  const args = Object.keys(props).map(k => req.has(k) ? k : k + '?').join(', ');
  const desc = String(f.description || '').split(/(?<=\.)\s/)[0].slice(0, 140);
  return `- ${f.name}(${args}): ${desc}`;
};
const nameOf = (t) => (t.function || t).name;

// Ranks tools against a query by word overlap with name and description.
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

export function toolPrompt(tools, active) {
  if (!tools.length) return '';
  const known = tools.filter(t => active.has(nameOf(t)));
  return [
    `Tools exist for: ${tools.map(nameOf).join(', ')}.`,
    `To use one, first look it up: ${FENCE}\n{"name": "${FIND_TOOLS}", "arguments": {"query": "what you need to do"}}\n\`\`\``,
    known.length ? 'Tools you have looked up:\n' + known.map(toolLine).join('\n') : '',
    `To call a tool, reply with only a block like that and nothing after it: ${FENCE} then {"name": …, "arguments": {…}} then \`\`\`. You get the result in the next message. If no tool is needed, just answer.`,
  ].filter(Boolean).join('\n');
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
// How many characters at the end of `text` could be the start of MARK.
function heldBack(text) {
  for (let k = Math.min(MARK.length - 1, text.length); k > 0; k--) if (MARK.startsWith(text.slice(-k))) return k;
  return 0;
}

export class Conversation {
  constructor(w, { preface, sessionConfig }) {
    this.w = w;
    this.messages = [...preface.messages];
    this.tools = preface.tools || [];
    this.active = new Set();             // tools looked up with find_tools
    this.max = Math.min(sessionConfig.maxOutputTokens || MAX_OUTPUT, MAX_OUTPUT);
    this.greedy = Boolean(sessionConfig.samplerParams && sessionConfig.samplerParams.type === 3);
    this.ctrl = null;
  }
  cancel() { try { this.ctrl && this.ctrl.abort(); } catch {} }
  async delete() {}

  // One model reply. Yields { content } pieces as they come (a tool-call block
  // is held back), then returns { out, calls }.
  async *generate() {
    const ctrl = this.ctrl = new AbortController();
    let out = '', shown = 0, inCall = false;
    try {
      const stream = await this.w.createChatCompletion({
        messages: gemmaMessages(this.messages, this.tools, this.active),
        stream: true,
        max_tokens: this.max,
        temperature: this.greedy ? 0 : 0.7,
        top_k: 64,
        top_p: 0.95,
        penalty_repeat: 1.1,
        cache_prompt: true,
        abortSignal: ctrl.signal,
      });
      for await (const chunk of stream) {
        const piece = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
        if (!piece) continue;
        out += piece;
        if (inCall) continue;
        const at = this.tools.length ? out.indexOf(MARK) : -1;
        if (at >= 0) {
          inCall = true;
          if (at > shown) yield { content: out.slice(shown, at) };
          shown = at;
          continue;
        }
        const safe = out.length - (this.tools.length ? heldBack(out) : 0);
        if (safe > shown) { yield { content: out.slice(shown, safe) }; shown = safe; }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) throw e;
    }
    const calls = inCall ? parseToolCalls(out.slice(shown)) : [];
    if (out.length > shown && !calls.length) yield { content: out.slice(shown) };   // incl. an unparseable block
    this.messages.push({ role: 'assistant', content: out });
    return { calls, aborted: ctrl.signal.aborted };
  }

  async *sendMessageStreaming(input) {
    if (typeof input === 'string') this.messages.push({ role: 'user', content: input });
    else for (const m of input) this.messages.push(m);           // tool results from the agent
    // find_tools is answered here, then the model goes again (a few times at most).
    for (let round = 0; round < 3; round++) {
      const { calls, aborted } = yield* this.generate();
      if (aborted || !calls.length) return;
      const lookups = calls.filter(c => c.function.name === FIND_TOOLS);
      const real = calls.filter(c => c.function.name !== FIND_TOOLS);
      if (real.length || !lookups.length) {
        // Calling a tool it hadn't looked up is fine if the name is real.
        for (const c of real) this.active.add(c.function.name);
        yield { tool_calls: real };
        return;
      }
      const results = lookups.map((c) => {
        const found = findTools(this.tools, c.function.arguments.query || c.function.arguments.q || '');
        for (const t of found) this.active.add(nameOf(t));
        return { name: FIND_TOOLS, response: found.length
          ? { found: found.map(toolLine).join('\n'), next: 'Call one of these now if it fits.' }
          : { found: 'No matching tool.', next: 'Answer without a tool, or try other words.' } };
      });
      this.messages.push({ role: 'tool', content: results });
    }
  }
}

export async function createEngine(url, contextSize, onStage = () => {}) {
  onStage('starting the runtime');
  const { Wllama } = await getLib();
  const w = new Wllama({ default: WASM }, { suppressNativeLog: true });
  onStage('loading the model into memory');
  await w.loadModelFromUrl(url, { n_ctx: contextSize, n_gpu_layers: 0 });
  return {
    createConversation: async (cfg) => new Conversation(w, cfg),
    delete: async () => { try { await w.exit(); } catch {} },
  };
}
