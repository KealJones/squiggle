// Qwen3 (JSON calls) and Qwen3.5 (XML calls), from the models' own chat templates. Both go through
// WebLLM's chat API: tool declarations are rendered into the system prompt, tool results become user
// turns of <tool_response> blocks, and <tool_call> blocks are parsed back out of the reply.
import { splitRaw, fnOf, argsOf } from './text.js';

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
    const args = argsOf(f.arguments);
    if (format === 'qwen35') {
      const ps = Object.entries(args).map(([k, v]) => `<parameter=${k}>\n${typeof v === 'string' ? v : JSON.stringify(v)}\n</parameter>\n`).join('');
      return `<tool_call>\n<function=${f.name}>\n${ps}</function>\n</tool_call>`;
    }
    return `<tool_call>\n${JSON.stringify({ name: f.name, arguments: args })}\n</tool_call>`;
  }).join('\n');
}

// OpenAI-shaped history (nativeMessages) → what WebLLM takes: system first, then user/assistant
// turns; tool results become user turns of <tool_response> blocks, as the Qwen templates render them.
// format null: plain text both ways (the fenced format and chat-only models).
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

const qwenFormat = (id) => ({
  id,
  mode: 'chat',
  messages: (history, tools) => toWebLLMMessages(history, { tools, format: id }),
  callStart: '<tool_call>',
  parseCalls: parseQwenCalls,
  split: (raw, { thinking }) => splitRaw(raw, thinking === true),
});

export const qwen3 = qwenFormat('qwen3');
export const qwen35 = qwenFormat('qwen35');
