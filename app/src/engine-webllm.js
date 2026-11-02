// WebLLM (MLC) on WebGPU for phones: the same small models as engine-wllama.js, but compiled
// for the GPU. On an iPhone it ran Llama 3.2 1B at ~30 tok/s vs ~2.6 on wllama's CPU build,
// for about twice the memory (app/memtest.html, 2026-11-02). It plugs in under engine-wllama.js:
// createShim() returns an object with the slice of wllama's API that Conversation and
// NativeConversation use (createChatCompletion with OpenAI-shaped streaming chunks, exit),
// so prompt shaping, tool parsing and the anti-loop logic stay in one place.
//
// WebLLM has no chat-template engine, so for native-tool models (Qwen3, Qwen3.5) this file
// renders the tool declarations into the system prompt the way their templates do, sends tool
// results as <tool_response> user turns, and parses <tool_call> blocks back into
// delta.tool_calls. WebLLM keeps its files in Cache Storage (webllm/config, /model, /wasm);
// sw.js keeps those caches across updates.
const VERSION = '0.2.87';
const LIB = `https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@${VERSION}/+esm`;

let lib = null;
const getLib = async () => lib || (lib = await import(LIB));

// q4f16 needs the GPU's shader-f16 feature; the f32 build runs without it (more memory).
async function pickId(mlc) {
  try {
    const a = navigator.gpu && await navigator.gpu.requestAdapter();
    if (a && a.features.has('shader-f16')) return mlc;
  } catch {}
  return mlc.replace('q4f16_1', 'q4f32_1');
}

// ── Download ──────────────────────────────────────────────────────────────

export async function isDownloaded(mlc) {
  try { return await (await getLib()).hasModelInCache(await pickId(mlc)); } catch { return false; }
}

// WebLLM has no download-only call: loading fills its cache, then the engine is let go.
export async function downloadModel(mlc, onProgress, signal) {
  const { CreateMLCEngine } = await getLib();
  const id = await pickId(mlc);
  let engine = null;
  const onAbort = () => { try { engine && engine.unload(); } catch {} };
  signal && signal.addEventListener('abort', onAbort, { once: true });
  try {
    engine = await CreateMLCEngine(id, {
      initProgressCallback: (p) => onProgress && onProgress(Math.round((p.progress || 0) * 1000), 1000),
    });
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
  } finally {
    signal && signal.removeEventListener('abort', onAbort);
    try { engine && await engine.unload(); } catch {}
  }
}

export async function removeModel(mlc) {
  const l = await getLib();
  for (const id of new Set([mlc, mlc.replace('q4f16_1', 'q4f32_1')])) {
    try { await l.deleteModelAllInfoInCache(id); } catch {}
  }
}

// ── Tool formats (from the models' own chat templates) ────────────────────

const fnOf = (t) => t.function || t;
const toolJson = (tools) => tools.map(t => JSON.stringify({ type: 'function', function: fnOf(t) })).join('\n');

const QWEN35_HEAD = '# Tools\n\nYou have access to the following functions:\n\n<tools>';
const QWEN35_TAIL = '\n</tools>\n\nIf you choose to call a function ONLY reply in the following format with NO suffix:\n\n<tool_call>\n<function=example_function_name>\n<parameter=example_parameter_1>\nvalue_1\n</parameter>\n<parameter=example_parameter_2>\nThis is the value for the second parameter\nthat can span\nmultiple lines\n</parameter>\n</function>\n</tool_call>\n\n<IMPORTANT>\nReminder:\n- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags\n- Required parameters MUST be specified\n- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after\n- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls\n</IMPORTANT>';
const QWEN3_HEAD = '# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>';
const QWEN3_TAIL = '\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>';

export function toolSystem(format, system, tools) {
  if (!tools.length) return system;
  if (format === 'qwen35') return QWEN35_HEAD + '\n' + toolJson(tools) + QWEN35_TAIL + (system ? '\n\n' + system : '');
  return (system ? system + '\n\n' : '') + QWEN3_HEAD + '\n' + toolJson(tools) + QWEN3_TAIL;
}

// An assistant turn's earlier calls, written back the way the model writes them.
function callText(format, calls) {
  return calls.map((c) => {
    const f = c.function || c;
    let args = f.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    if (format === 'qwen35') {
      const ps = Object.entries(args || {}).map(([k, v]) => `<parameter=${k}>\n${typeof v === 'string' ? v : JSON.stringify(v)}\n</parameter>\n`).join('');
      return `<tool_call>\n<function=${f.name}>\n${ps}</function>\n</tool_call>`;
    }
    return `<tool_call>\n${JSON.stringify({ name: f.name, arguments: args || {} })}\n</tool_call>`;
  }).join('\n');
}

// OpenAI-shaped history (nativeMessages) → what WebLLM takes: system first, then user/assistant
// turns; tool results become user turns of <tool_response> blocks, as the Qwen templates render them.
export function toWebLLMMessages(messages, { tools = [], format = null } = {}) {
  const out = [];
  const push = (role, content) => {
    const last = out[out.length - 1];
    if (last && last.role === role && role !== 'system') last.content += '\n' + content;
    else out.push({ role, content });
  };
  let system = '';
  for (const m of messages) {
    if (m.role === 'system') { system += (system ? '\n\n' : '') + (m.content || ''); continue; }
    if (m.role === 'tool') { push('user', `<tool_response>\n${m.content}\n</tool_response>`); continue; }
    if (m.role === 'assistant') {
      const calls = m.tool_calls && m.tool_calls.length ? callText(format, m.tool_calls) : '';
      push('assistant', [m.content || '', calls].filter(Boolean).join('\n\n') || '(no reply)');
      continue;
    }
    if (m.role === 'user') push('user', String(m.content ?? ''));
  }
  const sys = format ? toolSystem(format, system, tools) : system;
  return [...(sys ? [{ role: 'system', content: sys }] : []), ...out];
}

// Parses the calls in a finished reply: Qwen3.5's <function=…><parameter=…> blocks or
// Qwen3's JSON. Returns [{ name, arguments }].
export function parseQwenCalls(text) {
  const calls = [];
  const re = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const body = m[1];
    const fn = /<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/.exec(body);
    if (fn) {
      const args = {};
      const pre = /<parameter=([^>\s]+)>\n?([\s\S]*?)\n?<\/parameter>/g;
      let p;
      while ((p = pre.exec(fn[2]))) {
        const raw = p[2];
        try { args[p[1]] = /^[\[{"]|^-?\d|^(true|false|null)$/.test(raw.trim()) ? JSON.parse(raw) : raw; } catch { args[p[1]] = raw; }
      }
      calls.push({ name: fn[1], arguments: args });
      continue;
    }
    const json = body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1);
    try {
      const o = JSON.parse(json);
      let args = o.arguments ?? o.parameters ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      if (o.name) calls.push({ name: String(o.name), arguments: args && typeof args === 'object' ? args : {} });
    } catch {}
  }
  return calls;
}

// ── The shim ──────────────────────────────────────────────────────────────

const CALL = '<tool_call>';
const OPEN = '<think>', CLOSE = '</think>';
function heldBack(text, mark) {
  for (let k = Math.min(mark.length - 1, text.length); k > 0; k--) if (mark.startsWith(text.slice(-k))) return k;
  return 0;
}

// format: 'qwen35' | 'qwen3' for models whose tools go through their own template (native),
// null for the fenced ```tool_call format (plain text both ways, nothing to translate).
// engine: an already-made engine with WebLLM's chat API (tests pass a fake).
export async function createShim(mlc, contextSize, onStage = () => {}, { format = null, engine: given = null } = {}) {
  const id = given ? mlc : await pickId(mlc);
  onStage('loading the model onto the GPU');
  const engine = given || await (await getLib()).CreateMLCEngine(id, {
    initProgressCallback: (p) => onStage(/fetch/i.test(p.text || '') ? 'downloading the model' : 'loading the model onto the GPU'),
  }, { context_window_size: contextSize });

  async function* stream(opts, signal) {
    const native = Boolean(format) && (opts.tools || opts.chat_template_kwargs);
    let messages = native
      ? toWebLLMMessages(opts.messages, { tools: opts.tools || [], format })
      : toWebLLMMessages(opts.messages);
    // WebLLM can't continue an assistant turn; a prefilled retry starts the reply fresh instead.
    while (messages.length && messages[messages.length - 1].role === 'assistant') messages = messages.slice(0, -1);
    const thinking = opts.chat_template_kwargs ? Boolean(opts.chat_template_kwargs.enable_thinking) : undefined;
    const onAbort = () => { try { engine.interruptGenerate(); } catch {} };
    signal && signal.addEventListener('abort', onAbort, { once: true });
    try {
      const chunks = await engine.chat.completions.create({
        messages,
        stream: true,
        max_tokens: opts.max_tokens,
        temperature: opts.temperature,
        top_p: opts.top_p,
        repetition_penalty: opts.penalty_repeat,
        ...(thinking === undefined ? {} : { extra_body: { enable_thinking: thinking } }),
      });
      // Split <think> off into reasoning_content and, for native models, hold back
      // <tool_call> blocks and hand them over as delta.tool_calls at the end.
      let raw = '', shownThink = 0, shownText = 0;
      for await (const c of chunks) {
        if (signal && signal.aborted) break;
        const piece = (c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.content) || '';
        if (!piece) continue;
        raw += piece;
        const s = splitRaw(raw, thinking === true);
        if (s.thinking.length > shownThink) { yield { choices: [{ delta: { reasoning_content: s.thinking.slice(shownThink) } }] }; shownThink = s.thinking.length; }
        if (s.pending) continue;
        let text = s.text;
        if (native) {
          const at = text.indexOf(CALL);
          text = at >= 0 ? text.slice(0, at) : text.slice(0, text.length - heldBack(text, CALL));
          text = text.replace(/\s+$/, '');   // whitespace before a call isn't shown; it's sent once more text follows
        }
        if (text.length > shownText) { yield { choices: [{ delta: { content: text.slice(shownText) } }] }; shownText = text.length; }
      }
      const s = splitRaw(raw, thinking === true);
      // Thinking that never closed (cut off by max_tokens): it was all thinking, no reply.
      if (native) {
        const at = s.text.indexOf(CALL);
        const before = at >= 0 ? s.text.slice(0, at).replace(/\s+$/, '') : s.text;
        if (before.length > shownText) yield { choices: [{ delta: { content: before.slice(shownText) } }] };
        const calls = at >= 0 ? parseQwenCalls(s.text.slice(at)) : [];
        if (calls.length) yield { choices: [{ delta: { tool_calls: calls.map((c, index) => ({ index, id: '', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } }] };
      } else if (s.text.length > shownText) yield { choices: [{ delta: { content: s.text.slice(shownText) } }] };
    } finally {
      signal && signal.removeEventListener('abort', onAbort);
    }
  }

  return {
    async createChatCompletion(opts) { return stream(opts, opts.abortSignal); },
    async exit() { try { await engine.unload(); } catch {} },
    info: { gpu: true, threads: 1, compat: false, webllm: true, id },
  };
}

// The engine Squiggle loads (engine.js): the shim under engine-wllama.js's conversations. Built here,
// not in engine-wllama.js, so a browser still holding an older cached engine-wllama.js can't end up
// loading a WebLLM model through the wllama path.
export async function createEngine(mlc, contextSize, onStage = () => {}, { native = false, toolFormat = null } = {}) {
  onStage('starting the runtime');
  const { Conversation, NativeConversation } = await import('./engine-wllama.js');
  const w = await createShim(mlc, contextSize, onStage, { format: native ? toolFormat : null });
  return {
    info: { ...w.info, asked: { gpu: true, threads: false, isolated: Boolean(globalThis.crossOriginIsolated), webgpu: true } },
    createConversation: async (cfg) => (native ? new NativeConversation(w, cfg) : new Conversation(w, cfg)),
    delete: async () => { try { await w.exit(); } catch {} },
  };
}

// "<think>…</think>rest" → { thinking, text, pending }. pending while a tag might still be forming.
// assumeOpen: thinking was asked for and the template may already have written the opening tag,
// so text before a </think> is thinking even without a <think>.
export function splitRaw(raw, assumeOpen = false) {
  const rest = raw.replace(/^\s+/, '');
  if (!rest || OPEN.startsWith(rest)) return { thinking: '', text: '', pending: true };
  if (!rest.startsWith(OPEN) && !assumeOpen) return { thinking: '', text: raw };
  const body = rest.startsWith(OPEN) ? rest.slice(OPEN.length) : rest;
  const end = body.indexOf(CLOSE);
  if (end < 0) return { thinking: body.slice(0, body.length - heldBack(body, CLOSE)), text: '', pending: true };
  return { thinking: body.slice(0, end).replace(/^\n+/, ''), text: body.slice(end + CLOSE.length).replace(/^\s+/, '') };
}
