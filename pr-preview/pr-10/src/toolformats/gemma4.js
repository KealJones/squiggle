// Gemma 4 (tiny Gemma 4 on WebLLM). Gemma 4 keeps a tool call, its results and the reply in ONE model
// turn, which WebLLM's chat API can't continue, so this format renders the whole prompt itself (a port of the
// parts of Gemma 4's chat template Squiggle uses; tests/fixtures/gemma4-template.json pins it to the real
// template's output) and is sent as a raw text completion (`bos`: see toolformats/index.js).
import { heldBack, fnOf, argsOf } from './text.js';

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

export const gemma4 = {
  id: 'gemma4',
  mode: 'raw',
  prompt: (history, tools, { thinking }) => gemma4Prompt(history, tools, { thinking }),
  bos: '<bos>',
  // Generation stops at the <|tool_response> that follows a call, or at the end of the model turn.
  stop: ['<turn|>', '<|tool_response>'],
  callStart: G_CALL,
  parseCalls: (text) => parseGemmaCalls(text + (text.includes('<tool_call|>') ? '' : '<tool_call|>')),
  // After a tool result the template opens the thought itself, so the reply starts inside it.
  split: (raw, { prompt }) => splitGemma(raw, prompt.endsWith(G_THINK)),
};
