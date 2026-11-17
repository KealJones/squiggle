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
// Deferred tools (defer_loading, LFM3's model card "Tool search"): left out of <tools>; a tool result that holds
// tool_reference parts gets each referenced tool's definition written in, between <additional_tools> tags, the way
// the template's render_tool_response does (parts joined by newlines, a run of references in one block).
const deferredOf = (t) => Boolean((t && t.defer_loading) || fnOf(t).defer_loading);
export function toolResponse(c, tools) {
  if (typeof c === 'string') return c.includes('<tool_response>') ? c : '<tool_response>\n' + c + '\n</tool_response>';
  if (!Array.isArray(c)) return '<tool_response>\n' + contentOf(c) + '\n</tool_response>';
  const isRef = (x) => x && typeof x === 'object' && x.type === 'tool_reference';
  let out = '<tool_response>\n';
  c.forEach((x, i) => {
    if (i) out += '\n';
    if (isRef(x)) {
      if (i === 0 || !isRef(c[i - 1])) out += '<additional_tools>\n';
      const t = tools.find(y => fnOf(y).name === x.name);
      if (!t) throw new Error(`Tool reference '${x.name}' not found in available tools. Every tool referenced by a tool_reference must be in \`tools\` on every request.`);
      out += toolJson(t);
      if (i === c.length - 1 || !isRef(c[i + 1])) out += '\n</additional_tools>';
    } else out += contentOf([x]);
  });
  return out + '\n</tool_response>';
}

export function lfm3Prompt(messages, tools = [], { thinking = true, names = [], thinkStart = '' } = {}) {
  let msgs = messages;
  let system = '';
  if (msgs[0] && msgs[0].role === 'system') { system = contentOf(msgs[0].content); msgs = msgs.slice(1); }
  const listed = [...tools.filter(t => !deferredOf(t)).map(toolJson), ...names.map(n => pyJson({ name: n }))];
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
      out += '<|im_start|>tool\n' + toolResponse(m.content, tools) + '<|im_end|>\n';
    } else {
      out += '<|im_start|>' + m.role + '\n' + contentOf(m.content) + '<|im_end|>\n';
    }
  });
  return out + '<|im_start|>assistant\n' + (thinking ? '<think>' + thinkStart : '<think></think>');
}

// Where the prompt leaves the model inside its thinking: the words after the last <think> (empty for a plain
// opening), or null when the generation prompt doesn't open one.
export function openThinking(prompt) {
  const p = String(prompt || '');
  const at = p.lastIndexOf('<|im_start|>assistant\n<think>');
  if (at < 0) return null;
  const rest = p.slice(at + '<|im_start|>assistant\n<think>'.length);
  return rest.includes('</think>') ? null : rest;
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
  // Where a prompt can be cut for reuse on WebLLM (prefix-cache.js): an assistant turn's thinking opens with
  // `open` and ends at `close`; only the last turn's thinking is kept, so a cut never goes past it.
  cacheMark: { open: '<|im_start|>assistant\n<think>', close: '</think>' },
  thinkOpen: '<think>',
  thinkClose: '</think>',
  // With thinking on the prompt ends inside <think>, so the reply starts as thinking until </think>.
  split: (raw, { prompt }) => splitRaw(raw, Boolean(prompt && prompt.endsWith('<think>'))),
  toolRefs: true,   // renders tool_reference parts itself (toolResponse)
};

// LFM3 Omni 2B: the same format, with its thinking started for it. Omni's branch skipped the 1.7B's MOPD and agentic
// RL (LFM3 model card's training diagram) and closes an open <think> straight away; started with the 1.7B's own
// opening words it reasons and reaches for tools (llama.cpp on the CPU, 2026-11-17: bat-and-ball 0.10 → 0.05; the
// weather question went to a tool search instead of "I can't check live data"). Those words are shown as the start
// of its thinking. The thinking-budget path writes its own text after <think> and is left as it is.
export const OMNI_THINK_START = 'We need to';
export const lfm3Omni = {
  ...lfm3,
  id: 'lfm3-omni',
  thinkStart: OMNI_THINK_START,
  prompt: (history, tools, { thinking, names } = {}) => lfm3Prompt(history, tools, { thinking: thinking !== false, names, thinkStart: OMNI_THINK_START }),
  split: (raw, ctx) => (openThinking(ctx.prompt) === OMNI_THINK_START ? splitRaw(OMNI_THINK_START + raw, true) : lfm3.split(raw, ctx)),
};
