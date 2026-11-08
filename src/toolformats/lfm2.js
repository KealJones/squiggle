// LFM2 / LFM2.5 (Liquid AI), from the model's own chat template (LiquidAI/LFM2.5-1.2B-Instruct,
// chat_template.jinja; tests/fixtures/lfm2-template.json pins this port to its output).
//
//   <|im_start|>system
//   {system}
//   List of tools: [{"name": "web_search", "description": "…", "parameters": {…}}, …]<|im_end|>
//   <|im_start|>user …<|im_end|>
//   <|im_start|>assistant
//   <|tool_call_start|>[web_search(query='phoenix weather')]<|tool_call_end|><|im_end|>
//   <|im_start|>tool
//   …result…<|im_end|>
//
// Calls are a Python list of function calls; results come back in their own `tool` turn. WebLLM's chat
// API has no tool role for this model, so the prompt is rendered here and sent as a raw completion
// (the shim adds <|startoftext|>: see `bos` in toolformats/index.js). <|tool_call_start|>/<|tool_call_end|>
// aren't special tokens in its tokenizer, so they come back as text.
import { splitRaw, fnOf, argsOf } from './text.js';

const CALL_START = '<|tool_call_start|>', CALL_END = '<|tool_call_end|>';

// Python's json.dumps (what the template's tojson does): ", " and ": " between items, non-ASCII kept.
export function pyJson(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(pyJson).join(', ') + ']';
  return '{' + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ': ' + pyJson(x)).join(', ') + '}';
}

// An argument value the way the template writes it: strings in single quotes, lists and objects as
// JSON, everything else through Python's str() (True, False, None).
function argValue(v) {
  if (typeof v === 'string') return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'";
  if (v && typeof v === 'object') return pyJson(v);
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v === null || v === undefined) return 'None';
  return String(v);
}

export function callText(calls) {
  const parts = calls.map((c) => {
    const f = c.function || c;
    return f.name + '(' + Object.entries(argsOf(f.arguments)).map(([k, v]) => k + '=' + argValue(v)).join(', ') + ')';
  });
  return CALL_START + '[' + parts.join(', ') + ']' + CALL_END;
}

const contentOf = (c) => (typeof c === 'string' ? c : c == null ? '' : Array.isArray(c) ? c.map(x => (typeof x === 'string' ? x : x && x.type === 'text' ? x.text || '' : pyJson(x))).join('') : pyJson(c));

// OpenAI-shaped messages (nativeMessages) → LFM2's prompt text, with the generation prompt.
export function lfm2Prompt(messages, tools = []) {
  let msgs = messages;
  let system = '';
  if (msgs[0] && msgs[0].role === 'system') { system = contentOf(msgs[0].content); msgs = msgs.slice(1); }
  if (tools.length) system += (system ? '\n' : '') + 'List of tools: [' + tools.map(t => pyJson(fnOf(t))).join(', ') + ']';
  let out = system ? '<|im_start|>system\n' + system + '<|im_end|>\n' : '';
  let last = -1;
  msgs.forEach((m, i) => { if (m.role === 'assistant') last = i; });
  msgs.forEach((m, i) => {
    out += '<|im_start|>' + m.role + '\n';
    if (m.role === 'assistant') {
      const keep = i === last;
      const thinking = m.thinking || m.reasoning || m.reasoning_content;
      if (thinking && typeof thinking === 'string' && keep) out += '<think>' + thinking + '</think>';
      let content = contentOf(m.content);
      if (!keep && content.includes('</think>')) content = content.split('</think>').pop().trim();
      out += content;
      if (m.tool_calls && m.tool_calls.length) out += callText(m.tool_calls);
      out += '<|im_end|>\n';
    } else {
      out += contentOf(m.content) + '<|im_end|>\n';
    }
  });
  return out + '<|im_start|>assistant\n';
}

// ── Reading calls back: [name(key='value', n=3, flag=True), other()] ──

function skip(s, i) { while (i < s.length && /\s/.test(s[i])) i++; return i; }

function readString(s, i) {
  const q = s[i];
  let out = '';
  i++;
  while (i < s.length && s[i] !== q) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const c = s[i + 1];
      if (c === 'n') out += '\n'; else if (c === 't') out += '\t'; else if (c === 'r') out += '\r';
      else if (c === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 4; }
      else out += c;
      i += 2;
    } else out += s[i++];
  }
  return [out, i + 1];
}

const WORDS = { True: true, False: false, None: null, true: true, false: false, null: null };

function readValue(s, i) {
  i = skip(s, i);
  const c = s[i];
  if (c === "'" || c === '"') return readString(s, i);
  if (c === '[' || c === '(') {
    const close = c === '[' ? ']' : ')';
    const arr = [];
    i = skip(s, i + 1);
    while (i < s.length && s[i] !== close) {
      const [v, j] = readValue(s, i);
      arr.push(v);
      i = skip(s, j);
      if (s[i] === ',') i = skip(s, i + 1);
      else if (s[i] !== close) break;
    }
    return [arr, i + 1];
  }
  if (c === '{') {
    const o = {};
    i = skip(s, i + 1);
    while (i < s.length && s[i] !== '}') {
      let key;
      if (s[i] === "'" || s[i] === '"') [key, i] = readString(s, i);
      else { const m = /^[^:,}]+/.exec(s.slice(i)); key = m ? m[0].trim() : ''; i += m ? m[0].length : 0; }
      i = skip(s, i);
      if (s[i] === ':') i++;
      const [v, j] = readValue(s, i);
      o[key] = v;
      i = skip(s, j);
      if (s[i] === ',') i = skip(s, i + 1);
      else if (s[i] !== '}') break;
    }
    return [o, i + 1];
  }
  const m = /^[^,)\]}]+/.exec(s.slice(i));
  const raw = m ? m[0].trim() : '';
  const end = i + (m ? m[0].length : 0);
  if (raw in WORDS) return [WORDS[raw], end];
  if (raw !== '' && !isNaN(Number(raw))) return [Number(raw), end];
  return [raw, end];
}

// One call: name(key=value, …). Positional arguments (rare) are kept as _0, _1, ….
function readCall(s, i) {
  i = skip(s, i);
  const m = /^[A-Za-z_][\w.\-]*/.exec(s.slice(i));
  if (!m) return [null, s.length];
  const name = m[0];
  i = skip(s, i + name.length);
  const args = {};
  if (s[i] !== '(') return [{ name, arguments: args }, i];
  i = skip(s, i + 1);
  let pos = 0;
  while (i < s.length && s[i] !== ')') {
    const k = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(s.slice(i));
    if (k) {
      const [v, j] = readValue(s, i + k[0].length);
      args[k[1]] = v;
      i = j;
    } else {
      const [v, j] = readValue(s, i);
      args['_' + pos++] = v;
      i = j;
    }
    i = skip(s, i);
    if (s[i] === ',') i = skip(s, i + 1);
    else if (s[i] !== ')') break;
  }
  return [{ name, arguments: args }, i + 1];
}

// The calls in a reply. Also takes JSON calls ({"name": …, "arguments": …}), which LFM2 writes when a
// prompt asks for them. The end marker may be missing (generation stops on it).
export function parseLfmCalls(text) {
  const calls = [];
  let at = text.indexOf(CALL_START);
  while (at >= 0) {
    const from = at + CALL_START.length;
    const end = text.indexOf(CALL_END, from);
    const body = text.slice(from, end < 0 ? text.length : end).trim();
    if (/^\[?\s*\{/.test(body)) {
      try {
        const list = JSON.parse(body.startsWith('[') ? body : '[' + body + ']');
        for (const o of list) if (o && o.name) calls.push({ name: String(o.name), arguments: argsOf(o.arguments ?? o.parameters) });
      } catch {}
    } else {
      let i = skip(body, 0);
      const listed = body[i] === '[';
      if (listed) i++;
      while (i < body.length) {
        const [call, j] = readCall(body, i);
        if (!call) break;
        calls.push(call);
        i = skip(body, j);
        if (body[i] === ',') { i++; continue; }
        break;
      }
    }
    at = end < 0 ? -1 : text.indexOf(CALL_START, end);
  }
  return calls;
}

export const lfm2 = {
  id: 'lfm2',
  mode: 'raw',
  prompt: (history, tools) => lfm2Prompt(history, tools),
  bos: '<|startoftext|>',
  // Stop at the end of the turn, or right after a call: the text LFM2 writes after its call list
  // ("Checking the status…") isn't shown and would only cost time on a phone.
  stop: ['<|im_end|>', CALL_END],
  callStart: CALL_START,
  parseCalls: parseLfmCalls,
  // The template never opens <think> itself (the Thinking build writes its own tag).
  split: (raw) => splitRaw(raw),
};
