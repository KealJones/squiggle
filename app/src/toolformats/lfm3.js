// LFM3 (Liquid AI), from the model's own chat template (LiquidAI/LFM3-1.7B, chat_template.jinja;
// tests/fixtures/lfm3-template.json pins this port to its output, thinking off and on).
//
//   <|im_start|>system
//   {system}
//
//   <tools>
//   {"name": "web_search", "description": "…", "parameters": {…}}      one tool per line
//   </tools><|im_end|>
//   <|im_start|>assistant
//   <think></think>text<tool_call>\n<function=web_search>\n<parameter=query>\nphoenix\n</parameter>\n</function>\n</tool_call><|im_end|>
//   <|im_start|>tool
//   <tool_response>\n…result…\n</tool_response><|im_end|>
//
// Calls are Qwen3.5's XML; results come back in a tool turn. Thinking is on by default: the generation prompt
// ends with "<think>\n" (on) or "<think></think>" (off), and earlier turns' thinking is dropped except the
// last assistant turn's (kept as written, inside <think>…</think>). The prompt is rendered here and sent as a raw completion (WebLLM's chat API has no
// tool turn for this model); the shim adds <|startoftext|> (`bos`). The template puts "<think>\n" at the end
// of the generation prompt with thinking on; the model's own thinking opens that way too.
import { splitRaw, fnOf, argsOf } from './text.js';
import { parseQwenCalls } from './qwen.js';
import { pyJson } from './lfm2.js';

const renderValue = (v) => (typeof v === 'string' ? v : v === true ? 'true' : v === false ? 'false' : v === null || v === undefined ? 'null' : v && typeof v === 'object' ? pyJson(v) : String(v));

export function callText(calls) {
  return calls.map((c) => {
    const f = c.function || c;
    const args = argsOf(f.arguments);
    return `<tool_call>\n<function=${f.name}>\n` + Object.entries(args).map(([k, v]) => `<parameter=${k}>\n${renderValue(v)}\n</parameter>\n`).join('') + '</function>\n</tool_call>';
  }).join('\n\n');
}

const contentOf = (c) => (typeof c === 'string' ? c : c == null ? '' : Array.isArray(c) ? c.map(x => (typeof x === 'string' ? x : x && x.type === 'text' ? x.text || '' : pyJson(x))).join('') : pyJson(c));

// A tool's JSON the way the template writes it: the function's keys in order, defer_loading left out.
const toolJson = (t) => { const f = { ...fnOf(t) }; delete f.defer_loading; return pyJson(f); };

// OpenAI-shaped messages (nativeMessages) → LFM3's prompt text, with the generation prompt.
// names: tools a gated model hasn't looked up yet, listed as {"name": …} like LFM2 (not in the template).
export function lfm3Prompt(messages, tools = [], { thinking = true, names = [] } = {}) {
  let msgs = messages;
  let system = '';
  if (msgs[0] && msgs[0].role === 'system') { system = contentOf(msgs[0].content); msgs = msgs.slice(1); }
  const listed = [...tools.map(toolJson), ...names.map(n => pyJson({ name: n }))];
  if (listed.length) system += (system ? '\n\n' : '') + '<tools>\n' + listed.join('\n') + '\n</tools>';
  let out = system ? '<|im_start|>system\n' + system + '<|im_end|>\n' : '';
  let last = -1;
  msgs.forEach((m, i) => { if (m.role === 'assistant') last = i; });
  msgs.forEach((m, i) => {
    if (m.role === 'assistant') {
      const keep = i === last;
      let content = contentOf(m.content);
      let reasoning = m.reasoning_content || m.reasoning || m.thinking || '';
      if (typeof reasoning !== 'string') reasoning = '';
      if (!reasoning && content.includes('</think>')) {
        const at = content.indexOf('</think>');
        reasoning = content.slice(0, at).replace(/^\s*<think>/, '').trim();
        content = content.slice(at + '</think>'.length).trim();
      }
      out += '<|im_start|>assistant\n<think>' + (keep ? reasoning : '') + '</think>' + content;
      if (m.tool_calls && m.tool_calls.length) out += callText(m.tool_calls);
      out += '<|im_end|>\n';
    } else if (m.role === 'tool') {
      const c = contentOf(m.content);
      out += '<|im_start|>tool\n' + (c.includes('<tool_response>') ? c : '<tool_response>\n' + c + '\n</tool_response>') + '<|im_end|>\n';
    } else {
      out += '<|im_start|>' + m.role + '\n' + contentOf(m.content) + '<|im_end|>\n';
    }
  });
  return out + '<|im_start|>assistant\n' + (thinking ? '<think>' : '<think></think>');
}

export const lfm3 = {
  id: 'lfm3',
  mode: 'raw',
  prompt: (history, tools, { thinking, names } = {}) => lfm3Prompt(history, tools, { thinking: thinking !== false, names }),
  bos: '<|startoftext|>',
  listsNames: true,
  stop: ['<|im_end|>'],
  callStart: '<tool_call>',
  parseCalls: parseQwenCalls,
  // How its thinking opens and closes: the shim can close a thinking block itself (think_prefill).
  thinkOpen: '<think>',
  thinkClose: '</think>',
  // With thinking on the prompt ends inside <think>, so the reply starts as thinking until </think>.
  split: (raw, { prompt }) => splitRaw(raw, Boolean(prompt && prompt.endsWith('<think>'))),
};
