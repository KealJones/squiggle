// The whole context a model was given in one turn, exactly as Squiggle sent it: every conversation the agent
// opened (the chat phase, each plan step, the final reply), with its system prompt, the tool schemas declared,
// the tools only listed by name, the messages it started with, and every round after: what went in (the
// user's message, tool results) and what came out (thinking, text, tool calls). Where an engine renders the
// prompt text in Squiggle's own code (WebLLM's raw formats: LFM2, LFM3, Gemma 4), that exact text is kept too;
// llama.cpp, LiteRT and WebLLM's chat API render inside the runtime, so for those the structured payload is
// what there is.
//
// Saved per reply as prompts/<session>/<id>.json in the storage repo when "Save tool results and prompts" is on
// (agent.js), and shown in "What the model saw" (ui/panels.js). Pure apart from the module-level slot the
// engines write the rendered text to, so it runs in node tests.

const CAP = 40000;          // characters per string; a fetched page in a tool result can be far longer
const MAX_ROUNDS = 80;      // per conversation (a long step mode turn has many)

const cap = (s) => {
  s = String(s ?? '');
  return s.length > CAP ? s.slice(0, CAP) + `\n… (${s.length - CAP} more characters not kept)` : s;
};
// A deep copy with every long string cut, so the trace never holds a reference to live conversation state.
export function clip(v, depth = 0) {
  if (v == null || depth > 12) return v ?? null;
  if (typeof v === 'string') return cap(v);
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(x => clip(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) if (typeof x !== 'function') out[k] = clip(x, depth + 1);
  return out;
}

const nameOf = (t) => (t && (t.name || (t.function && t.function.name))) || '';

export function createTrace() {
  return { v: 1, created: Date.now(), tools: {}, convs: [] };
}

/** Starts a conversation in the trace. `tools`: every spec given to the engine. `declared`: the names whose full
 *  schema the model sees (all of them, unless the model's tools are gated or fenced); the rest are listed by name. */
export function openConv(trace, { phase, system = '', tools = [], declared = null, messages = [], model = null }) {
  if (!trace) return null;
  for (const t of tools) { const n = nameOf(t); if (n && !trace.tools[n]) trace.tools[n] = clip(t); }
  const names = tools.map(nameOf).filter(Boolean);
  const shown = declared ? names.filter(n => declared.includes(n)) : names;
  const conv = { phase: String(phase || ''), at: Date.now(), model, system: cap(system), declared: shown,
    named: names.filter(n => !shown.includes(n)), messages: clip(messages), rounds: [] };
  trace.convs.push(conv);
  return conv;
}

/** One round of the open conversation: what was sent, what came back, the exact prompt text if the engine
 *  rendered it, and tools whose schema was declared after this round (a find or tool_info that named them). */
export function addRound(trace, { input, output, rendered = null, added = [] }) {
  const conv = trace && trace.convs[trace.convs.length - 1];
  if (!conv || conv.rounds.length >= MAX_ROUNDS) return;
  const o = output || {};
  conv.rounds.push({
    at: Date.now(),
    input: clip(input),
    output: { thinking: cap(o.thinking || ''), text: cap(o.text || ''), toolCalls: clip(o.toolCalls || []), ...(o.repaired ? { repaired: cap(o.repaired) } : {}) },
    ...(rendered ? { rendered: { kind: rendered.kind, text: cap(rendered.text) } } : {}),
    ...(added && added.length ? { added: [...added] } : {}),
  });
}

// ── The exact prompt text, from the engines that render it ────────────────

let lastRendered = null;
/** Engines call this with the prompt they're about to send (kind: 'raw prompt' or 'chat messages'). */
export function noteRendered(kind, text) {
  lastRendered = { kind, text: typeof text === 'string' ? text : JSON.stringify(text, null, 1) };
  // Kept across a crash too: a tab killed while reading this prompt can't save its trace (incidents.js, model-ui.js).
  try { localStorage.setItem(LAST_PROMPT_KEY, lastRendered.text.slice(-200000)); } catch {}
}
export const LAST_PROMPT_KEY = 'squiggle-last-prompt';
/** The agent takes it after each reply; null when the engine rendered nothing itself. */
export function takeRendered() { const r = lastRendered; lastRendered = null; return r; }

// ── As text (the panel's Copy button, pasting into a bug report or a chat) ─

const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 1));
function messageText(m) {
  if (!m || typeof m !== 'object') return show(m);
  const head = `[${m.role || 'message'}${m.name ? ' ' + m.name : ''}]`;
  const parts = [];
  if (m.content != null && m.content !== '') parts.push(show(m.content));
  if (m.tool_calls && m.tool_calls.length) parts.push('tool calls: ' + show(m.tool_calls));
  return `${head}\n${parts.join('\n')}`;
}

export function traceText(trace) {
  if (!trace || !trace.convs) return '';
  const out = [];
  trace.convs.forEach((c, i) => {
    out.push(`######## ${i + 1}. ${c.phase}${c.model ? ` (${c.model})` : ''}`);
    out.push('=== System prompt ===\n' + (c.system || '(none)'));
    if (c.declared.length) out.push('=== Tools declared (full schemas) ===\n' + c.declared.map(n => show(trace.tools[n] || n)).join('\n'));
    if (c.named.length) out.push('=== Tools listed by name only ===\n' + c.named.join(', '));
    if (c.messages && c.messages.length) out.push('=== Messages it started with ===\n' + c.messages.map(messageText).join('\n\n'));
    c.rounds.forEach((r, j) => {
      out.push(`=== Round ${j + 1}: sent ===\n` + (Array.isArray(r.input) ? r.input.map(messageText).join('\n\n') : show(r.input)));
      if (r.rendered) out.push(`=== Round ${j + 1}: exact ${r.rendered.kind} ===\n` + r.rendered.text);
      const o = r.output || {};
      out.push(`=== Round ${j + 1}: model wrote ===\n` + [o.thinking && `(thinking)\n${o.thinking}`, o.text && `(text)\n${o.text}`,
        o.toolCalls && o.toolCalls.length && `(tool calls)\n${show(o.toolCalls)}`].filter(Boolean).join('\n\n'));
      if (r.added) out.push(`(declared after this round: ${r.added.join(', ')})`);
    });
  });
  return out.join('\n\n');
}
