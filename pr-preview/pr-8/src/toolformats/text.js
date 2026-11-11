// Small pieces every tool format shares: holding back a half-written marker while streaming, and
// splitting "<think>…</think>" off the start of a reply.

// How many characters at the end of `text` could be the start of `mark` (so they aren't shown yet).
export function heldBack(text, mark) {
  for (let k = Math.min(mark.length - 1, text.length); k > 0; k--) if (mark.startsWith(text.slice(-k))) return k;
  return 0;
}

const OPEN = '<think>', CLOSE = '</think>';

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

// A tool spec as the model sees it: OpenAI's { type: 'function', function } wrapper or the bare function.
export const fnOf = (t) => t.function || t;
// A call's arguments as an object (nativeMessages keeps them as a JSON string).
export const argsOf = (a) => { if (typeof a === 'string') { try { return JSON.parse(a); } catch { return {}; } } return a || {}; };
