// Tool formats: how a model's own chat template writes tools, calls and results, for runtimes that
// have no template engine of their own (WebLLM). One module per format; adding a model family means
// adding a module here and naming it in the model's `toolFormat` (engine.js MODELS). docs/extending.md.
//
// A format is:
//   id          the name a model's `toolFormat` uses
//   mode        'chat': goes through WebLLM's chat API (messages); 'raw': the whole prompt is rendered
//               here and sent as a raw completion (when the template needs turns WebLLM's chat API
//               can't express: a tool role, or a reply that continues after a result)
//   messages(history, tools, { thinking })  chat mode: OpenAI-shaped history → WebLLM chat messages
//   prompt(history, tools, { thinking })    raw mode: OpenAI-shaped history → prompt text (no BOS), ending
//                                           with the generation prompt
//   stop        raw mode: strings that end generation
//   bos         raw mode: the start-of-text token as text. WebLLM adds it to a raw completion only for builds
//               with an artifact manifest; for the others the shim puts it at the front of the prompt
//   callStart   the text where tool calls begin in a reply (held back while streaming), or null
//   parseCalls(text) → [{ name, arguments }]   the calls in a finished reply, from callStart on
//   split(raw, { thinking, prompt }) → { thinking, text, pending }   thinking vs answer in the reply so far
import { splitRaw } from './text.js';
import { toWebLLMMessages, qwen3, qwen35 } from './qwen.js';
import { gemma4 } from './gemma4.js';
import { lfm2 } from './lfm2.js';

const formats = new Map();

export function registerToolFormat(f) {
  if (!f || typeof f.id !== 'string' || !f.id) throw new Error('A tool format needs an id');
  if (f.mode === 'chat' ? typeof f.messages !== 'function' : f.mode === 'raw' ? typeof f.prompt !== 'function' : true) {
    throw new Error(`Tool format ${f.id}: mode must be 'chat' (with messages) or 'raw' (with prompt)`);
  }
  if (typeof f.parseCalls !== 'function' || typeof f.split !== 'function') throw new Error(`Tool format ${f.id} needs parseCalls and split`);
  formats.set(f.id, f);
  return f;
}

export const toolFormat = (id) => (id && formats.get(id)) || null;
export const toolFormats = () => [...formats.keys()];

// No tool format: plain text both ways (the fenced ```tool_call format, chat-only models, background jobs).
export const PLAIN = {
  id: 'plain',
  mode: 'chat',
  messages: (history) => toWebLLMMessages(history),
  callStart: null,
  parseCalls: () => [],
  split: (raw, { thinking }) => splitRaw(raw, thinking === true),
};

for (const f of [qwen3, qwen35, gemma4, lfm2]) registerToolFormat(f);
