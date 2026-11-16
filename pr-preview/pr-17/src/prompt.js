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

// A chat's own tool choices (session.chatTools): { off: [names], desc: { name: text } }, or null for Squiggle's.
// Turned-off tools are left out of every phase and refused if the model calls one anyway; an edited description
// replaces the tool's own (only the top-level one: parameters keep theirs). `done` and `checkpoint` belong to plan
// and AI-managed context, so they can't be turned off on their own.
export const LOCKED = new Set(['done', 'checkpoint']);
export const ownTools = (session) => (session && session.chatTools && typeof session.chatTools === 'object' ? session.chatTools : null);
export const toolOff = (prefs, name) => Boolean(prefs && !LOCKED.has(name) && Array.isArray(prefs.off) && prefs.off.includes(name));
export function withPrefs(prefs, specs) {
  if (!prefs) return specs;
  return specs.filter(t => !toolOff(prefs, t.name)).map((t) => {
    const d = prefs.desc && prefs.desc[t.name];
    return typeof d === 'string' && d !== t.description ? { ...t, description: d } : t;
  });
}
// What the editor saves: only what differs from Squiggle's (null when nothing does).
export function toolPrefs(rows) {
  const off = rows.filter(r => !r.on && !LOCKED.has(r.name)).map(r => r.name);
  const desc = Object.fromEntries(rows.filter(r => typeof r.text === 'string' && r.text !== r.description).map(r => [r.name, r.text]));
  return off.length || Object.keys(desc).length ? { off, desc } : null;
}
