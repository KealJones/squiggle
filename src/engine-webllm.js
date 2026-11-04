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

// Our own MLC builds (tiny Gemma 4) aren't in WebLLM's prebuilt list: engine.js registers their records
// (model URL, compiled .wasm, manifest) and every WebLLM call gets an appConfig that adds them.
const custom = new Map();
export function registerModel(record) { custom.set(record.model_id, record); }
async function appConfigFor(id) {
  if (!custom.has(id)) return undefined;
  const { prebuiltAppConfig } = await getLib();
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
  try { const id = await pickId(mlc); return await (await getLib()).hasModelInCache(id, await appConfigFor(id)); } catch { return false; }
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
  const l = await getLib();
  for (const id of new Set([mlc, mlc.replace('q4f16_1', 'q4f32_1')])) {
    try { await l.deleteModelAllInfoInCache(id, await appConfigFor(id)); } catch {}
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
      // Thinking kept for the tool round being answered (nativeMessages leaves it only there), written the
      // way the Qwen templates render an assistant turn after the last user query.
      const think = m.reasoning_content ? `<think>\n${m.reasoning_content}\n</think>` : '';
      push('assistant', [think, m.content || '', calls].filter(Boolean).join('\n\n') || '(no reply)');
      continue;
    }
    if (m.role === 'user') push('user', String(m.content ?? ''));
  }
  const sys = format ? toolSystem(format, system, tools) : system;
  return [...(sys ? [{ role: 'system', content: sys }] : []), ...out];
}


// ── Gemma 4 (tiny Gemma 4 on WebLLM) ──────────────────────────────────────
// Gemma 4 keeps a tool call, its results and the reply in ONE model turn, which WebLLM's chat API can't
// continue, so this format renders the whole prompt itself (a port of the parts of Gemma 4's chat
// template Squiggle uses; tests/fixtures/gemma4-template.json pins it to the real template's output) and
// sends it as a raw text completion. WebLLM adds <bos> itself (system_prefix_token_ids).
const Q = '<|"|>';
const keys = (o) => Object.keys(o).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);
const upper = (t) => (typeof t === 'string' ? t.toUpperCase() : '');

export function gemmaArg(v, escapeKeys = true) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return Q + v + Q;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return '[' + v.map(x => gemmaArg(x, escapeKeys)).join(',') + ']';
  if (isMap(v)) return '{' + keys(v).map(k => (escapeKeys ? Q + k + Q : k) + ':' + gemmaArg(v[k], escapeKeys)).join(',') + '}';
  return String(v);
}

const STANDARD = new Set(['description', 'type', 'properties', 'required', 'nullable']);
function gemmaParams(props, required, filterKeys = false) {
  const out = [];
  for (const key of keys(props || {})) {
    if (filterKeys && STANDARD.has(key)) continue;
    const v = props[key] || {};
    const parts = [];
    if (v.description) parts.push('description:' + Q + v.description + Q);
    const T = upper(v.type);
    if (T === 'STRING') {
      if (v.enum) parts.push('enum:' + gemmaArg(v.enum));
    } else if (T === 'ARRAY' && isMap(v.items) && Object.keys(v.items).length) {
      const items = [];
      for (const ik of keys(v.items)) {
        const iv = v.items[ik];
        if (iv === null || iv === undefined) continue;
        if (ik === 'properties') items.push('properties:{' + (isMap(iv) ? gemmaParams(iv, v.items.required || []) : '') + '}');
        else if (ik === 'required') items.push('required:[' + iv.map(r => Q + r + Q).join(',') + ']');
        else if (ik === 'type') items.push('type:' + (typeof iv === 'string' ? gemmaArg(iv.toUpperCase()) : gemmaArg(iv.map(x => String(x).toUpperCase()))));
        else items.push(ik + ':' + gemmaArg(iv));
      }
      parts.push('items:{' + items.join(',') + '}');
    }
    if (v.nullable) parts.push('nullable:true');
    if (T === 'OBJECT') {
      if (isMap(v.properties)) parts.push('properties:{' + gemmaParams(v.properties, v.required || []) + '}');
      else if (isMap(v)) parts.push('properties:{' + gemmaParams(v, v.required || [], true) + '}');
      if (v.required && v.required.length) parts.push('required:[' + v.required.map(r => Q + r + Q).join(',') + ']');
    }
    parts.push('type:' + Q + T + Q + '}');
    out.push(key + ':{' + parts.join(','));
  }
  return out.join(',');
}

function gemmaDeclaration(tool) {
  const f = fnOf(tool);
  let s = 'declaration:' + f.name + '{description:' + Q + (f.description || '') + Q;
  const p = f.parameters;
  if (p) {
    s += ',parameters:{';
    if (p.properties && Object.keys(p.properties).length) s += 'properties:{' + gemmaParams(p.properties, p.required) + '},';
    if (p.required && p.required.length) s += 'required:[' + p.required.map(r => Q + r + Q).join(',') + '],';
    if (p.type) s += 'type:' + Q + upper(p.type) + Q + '}';
  }
  return (s + '}').trim();
}

const argsOf = (a) => { if (typeof a === 'string') { try { return JSON.parse(a); } catch { return {}; } } return a || {}; };
const responseBlock = (name, body) => '<|tool_response>' + (isMap(body)
  ? 'response:' + name + '{' + keys(body).map(k => k + ':' + gemmaArg(body[k], false)).join(',') + '}'
  : 'response:' + name + '{value:' + gemmaArg(body, false) + '}') + '<tool_response|>';
const stripThinking = (t) => t.split('<channel|>').map(p => (p.includes('<|channel>') ? p.split('<|channel>')[0] : p)).join('').trim();

// OpenAI-shaped messages (nativeMessages) → Gemma 4's prompt text, with the generation prompt.
export function gemma4Prompt(messages, tools = [], { thinking = false } = {}) {
  let out = '';
  let prevType = null, prevNonTool = null;
  let msgs = messages;
  if (thinking || tools.length || (msgs[0] && ['system', 'developer'].includes(msgs[0].role))) {
    out += '<|turn>system\n';
    if (thinking) { out += '<|think|>\n'; prevType = 'think'; }
    if (msgs[0] && ['system', 'developer'].includes(msgs[0].role)) { out += String(msgs[0].content || '').trim(); msgs = msgs.slice(1); }
    if (tools.length) { for (const t of tools) out += '<|tool>' + gemmaDeclaration(t) + '<tool|>'; prevType = 'tool'; }
    out += '<turn|>\n';
  }
  msgs.forEach((m, i) => {
    if (m.role === 'tool') return;
    prevType = null;
    const role = m.role === 'assistant' ? 'model' : m.role;
    if (!(role === 'model' && prevNonTool === 'assistant')) out += '<|turn>' + role + '\n';
    const calls = m.tool_calls || [];
    for (const c of calls) {
      const f = c.function || c;
      const a = argsOf(f.arguments);
      out += '<|tool_call>call:' + f.name + '{' + keys(a).map(k => k + ':' + gemmaArg(a[k], false)).join(',') + '}<tool_call|>';
      prevType = 'tool_call';
    }
    let answered = false;
    if (calls.length) {
      for (let k = i + 1; k < msgs.length && msgs[k].role === 'tool'; k++) {
        const r = msgs[k];
        const match = calls.find(c => c.id && c.id === r.tool_call_id);
        out += responseBlock(match ? (match.function || match).name : (r.name || 'unknown'), r.content);
        answered = true; prevType = 'tool_response';
      }
    }
    const content = typeof m.content === 'string' ? (role === 'model' ? stripThinking(m.content) : m.content.trim()) : '';
    out += content;
    const next = msgs.slice(i + 1).find(x => x.role !== 'tool');
    const continues = role === 'model' && next && next.role === 'assistant' && (!calls.length || answered);
    if (prevType === 'tool_call' && !answered) out += '<|tool_response>';
    else if (continues) { /* the next assistant message continues this turn */ }
    else if (!(answered && !content.trim() && !next)) out += '<turn|>\n';
    prevNonTool = m.role;
  });
  if (prevType !== 'tool_response' && prevType !== 'tool_call') out += '<|turn>model\n';
  else if (prevType === 'tool_response' && thinking) out += '<|channel>thought\n';
  return out;
}

// One argument value from Gemma's call syntax: <|"|>text<|"|>, numbers, true/false/null, {…}, […].
function readGemmaValue(s, i) {
  if (s.startsWith(Q, i)) { const end = s.indexOf(Q, i + Q.length); return end < 0 ? [s.slice(i + Q.length), s.length] : [s.slice(i + Q.length, end), end + Q.length]; }
  if (s[i] === '{') return readGemmaObject(s, i);
  if (s[i] === '[') {
    const arr = []; i++;
    while (i < s.length && s[i] !== ']') { const [v, j] = readGemmaValue(s, i); arr.push(v); i = j; if (s[i] === ',') i++; }
    return [arr, i + 1];
  }
  let j = i; while (j < s.length && !',}]'.includes(s[j])) j++;
  const raw = s.slice(i, j).trim();
  return [raw === 'true' ? true : raw === 'false' ? false : raw === 'null' ? null : (raw !== '' && !isNaN(Number(raw)) ? Number(raw) : raw), j];
}
function readGemmaObject(s, i) {
  const o = {}; i++;                                        // past '{'
  while (i < s.length && s[i] !== '}') {
    let key;
    if (s.startsWith(Q, i)) { const end = s.indexOf(Q, i + Q.length); key = s.slice(i + Q.length, end); i = end + Q.length; }
    else { const c = s.indexOf(':', i); key = s.slice(i, c).trim(); i = c; }
    i++;                                                   // past ':'
    const [v, j] = readGemmaValue(s, i); o[key] = v; i = j;
    if (s[i] === ',') i++;
  }
  return [o, i + 1];
}
export function parseGemmaCalls(text) {
  const calls = [];
  const re = /<\|tool_call>call:([\w.\-]+)(\{[\s\S]*?\})<tool_call\|>/g;
  let m;
  while ((m = re.exec(text))) { try { calls.push({ name: m[1], arguments: readGemmaObject(m[2], 0)[0] }); } catch {} }
  return calls;
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

// WebLLM's names for the sampling wllama's conversations pass (engine-wllama.js samplingOptions). WebLLM
// has no top_k or min_p; a repeat penalty of 1 (off) is left out, and a presence penalty passes through.
export function sampling(opts) {
  const out = { temperature: opts.temperature, top_p: opts.top_p };
  if (opts.penalty_repeat && opts.penalty_repeat !== 1) out.repetition_penalty = opts.penalty_repeat;
  if (opts.penalty_present) out.presence_penalty = opts.penalty_present;
  return out;
}

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
    appConfig: await appConfigFor(id),
    initProgressCallback: (p) => onStage(/fetch/i.test(p.text || '') ? 'downloading the model' : 'loading the model onto the GPU'),
  }, { context_window_size: contextSize });

  async function* stream(opts, signal) {
    if (format === 'gemma4') { yield* gemmaStream(opts, signal); return; }
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
        ...sampling(opts),
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

  // Gemma 4: the whole prompt rendered here (gemma4Prompt) and sent as a raw completion, so a reply can
  // continue the model turn after a tool result. The reply comes back as Gemma's own text: an optional
  // <|channel>thought…<channel|> block, the answer, then <|tool_call>call:name{…}<tool_call|> blocks
  // (generation stops at the <|tool_response> that follows a call, or at <turn|>).
  async function* gemmaStream(opts, signal) {
    const thinking = Boolean(opts.chat_template_kwargs && opts.chat_template_kwargs.enable_thinking);
    const prompt = gemma4Prompt(opts.messages || [], opts.tools || [], { thinking });
    const opened = prompt.endsWith(G_THINK);           // after a tool result the template opens the thought itself
    const onAbort = () => { try { engine.interruptGenerate(); } catch {} };
    signal && signal.addEventListener('abort', onAbort, { once: true });
    try {
      try { await engine.resetChat(); } catch {}         // raw completions need an empty KV cache
      const chunks = await engine.completions.create({
        prompt, stream: true, max_tokens: opts.max_tokens, ...sampling(opts), stop: ['<turn|>', '<|tool_response>'],
      });
      let raw = '', shownThink = 0, shownText = 0;
      for await (const c of chunks) {
        if (signal && signal.aborted) break;
        const piece = (c.choices && c.choices[0] && (c.choices[0].text ?? (c.choices[0].delta && c.choices[0].delta.content))) || '';
        if (!piece) continue;
        raw += piece;
        const s = splitGemma(raw, opened);
        if (s.thinking.length > shownThink) { yield { choices: [{ delta: { reasoning_content: s.thinking.slice(shownThink) } }] }; shownThink = s.thinking.length; }
        if (s.pending) continue;
        const at = s.text.indexOf(G_CALL);
        let text = at >= 0 ? s.text.slice(0, at) : s.text.slice(0, s.text.length - heldBack(s.text, G_CALL));
        text = text.replace(/\s+$/, '');
        if (text.length > shownText) { yield { choices: [{ delta: { content: text.slice(shownText) } }] }; shownText = text.length; }
      }
      const s = splitGemma(raw, opened);
      const at = s.text.indexOf(G_CALL);
      const before = (at >= 0 ? s.text.slice(0, at) : s.text).replace(/\s+$/, '');
      if (before.length > shownText) yield { choices: [{ delta: { content: before.slice(shownText) } }] };
      const calls = at >= 0 ? parseGemmaCalls(s.text.slice(at) + (s.text.slice(at).includes('<tool_call|>') ? '' : '<tool_call|>')) : [];
      if (calls.length) yield { choices: [{ delta: { tool_calls: calls.map((c, index) => ({ index, id: '', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } }] };
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

// Gemma 4's thought channel: "<|channel>thought\n…<channel|>rest" → { thinking, text, pending }.
// opened: the prompt already ended with "<|channel>thought\n", so the reply starts inside the thought.
const G_THINK = '<|channel>thought\n', G_END = '<channel|>', G_CALL = '<|tool_call>';
export function splitGemma(raw, opened = false) {
  let rest = raw;
  if (!opened) {
    const lead = rest.replace(/^\s+/, '');
    if (!lead) return { thinking: '', text: '', pending: true };
    if (G_THINK.startsWith(lead)) return { thinking: '', text: '', pending: true };
    if (!lead.startsWith(G_THINK)) return { thinking: '', text: raw.replace(/^\s+/, '') };
    rest = lead.slice(G_THINK.length);
  }
  const end = rest.indexOf(G_END);
  if (end < 0) return { thinking: rest.slice(0, rest.length - heldBack(rest, G_END)), text: '', pending: true };
  return { thinking: rest.slice(0, end).replace(/\s+$/, ''), text: rest.slice(end + G_END.length).replace(/^\s+/, '') };
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
