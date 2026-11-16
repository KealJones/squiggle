// A chat's own system prompt (session.systemPrompt, edited from the chat details: panels.js renderPromptPanel).
// null or missing = Squiggle builds the prompt as usual; any string, even an empty one, replaces it in every phase
// (chat, plan steps, final reply). Two placeholders fill in what changes between calls:
//   {{tools}}  the tool-names line gated models get (agent.js toolNamesLine); on a line of its own, the line is
//              dropped when there are no names (the final reply has no tools)
//   {{date}}   today's date, as the built prompt writes it
// Pure (tests/prompt.test.js).

export const TOOLS = '{{tools}}';
export const DATE = '{{date}}';

export const today = (now = new Date()) => now.toDateString();

// The text sent to the model for an edited prompt.
export function fillPrompt(text, { names = '', now = new Date() } = {}) {
  const date = today(now);
  const lines = [];
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() === TOOLS) { if (names) lines.push(...names.split('\n')); continue; }
    lines.push(line.replaceAll(TOOLS, names).replaceAll(DATE, date));
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

// The built prompt turned back into an editable template: the names line and the date become placeholders.
export function toTemplate(built, { names = '', now = new Date() } = {}) {
  let text = String(built ?? '');
  if (names) text = text.replace(names, TOOLS);
  return text.replaceAll(today(now), DATE);
}

// What a session uses: its own text, or null for Squiggle's.
export const ownPrompt = (session) => (session && typeof session.systemPrompt === 'string' ? session.systemPrompt : null);
