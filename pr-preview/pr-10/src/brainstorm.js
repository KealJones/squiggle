// Brainstorm chats (Keal, 2026-11-12): the person sends the idea, then the model talks to itself. Two voices, A and B,
// take turns; each sees its own turns as the assistant and everything else (the other voice, the person) as the user.
// The person can jump in between turns to steer, and stop it. No tools, no plan, no thinking: just the back-and-forth.
// The browser-side modules load in run(), so the pure parts here are testable in node.

export const VOICES = { A: 'Squiggle A', B: 'Squiggle B' };
export const MAX_TURNS = 20;      // per run, so a forgotten tab doesn't brainstorm all night; "Keep going" starts another
const MAX_OUTPUT = 400;
const est = (s) => Math.ceil(String(s || '').length / 3.5);

// What each voice leans toward, so two copies of one model argue instead of agreeing with each other.
const LEAN = {
  A: 'You lean toward pitching: add new ideas, build on what works, make things concrete.',
  B: 'You lean toward testing: poke holes, ask what is missing or what would break, then suggest a fix.',
};

export function systemFor(voice, topic) {
  return [
    `You are brainstorming with a partner. The topic, from the person who started this: ${topic}`,
    'Your partner\'s messages arrive as the user turns. Reply to them directly, like a conversation between two collaborators.',
    LEAN[voice],
    'Each turn: react to what your partner just said, then add one new idea, challenge or question. Don\'t just agree, don\'t repeat earlier points, and keep it to a short paragraph or a few bullets.',
    'When the person who started this steps in, follow their direction.',
  ].join('\n');
}

const said = (m) => !m.deleted && !m.thread && (m.role === 'user' || m.role === 'assistant');
export const turns = (line) => line.filter(said);

// Who speaks next: the other voice from the last one that spoke, else A.
export function nextVoice(line) {
  const last = [...turns(line)].reverse().find(m => m.role === 'assistant' && m.voice);
  return last && last.voice === 'A' ? 'B' : 'A';
}

/**
 * The chat as `voice` sees it: its own turns as the assistant, everything else as the user (consecutive user
 * turns merged, since chat templates want them alternating). The idea itself starts A's view; B knows it from its
 * system prompt and starts at A's first turn. The person's later messages are marked as theirs. Old turns are
 * dropped from the front to fit `budget` tokens. Returns { topic, messages } with the last message from the user.
 */
export function viewFor(line, voice, budget = Infinity) {
  const all = turns(line);
  const seed = all.find(m => m.role === 'user');
  const out = [];
  for (const m of all) {
    if (m === seed && voice !== 'A') continue;
    const mine = m.role === 'assistant' && m.voice === voice;
    const text = m.role === 'user' && m !== seed ? `The person who started this brainstorm steps in: ${m.content}` : m.content;
    const role = mine ? 'assistant' : 'user';
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content += '\n\n' + text;
    else out.push({ role, content: text });
  }
  // Keep the newest turns that fit; the view has to start with a user turn.
  let used = 0, start = out.length;
  while (start > 0 && used + est(out[start - 1].content) <= budget) used += est(out[--start].content);
  if (start === out.length && out.length) start = out.length - 1;   // always keep the turn being answered
  while (start < out.length && out[start].role !== 'user') start++;
  return { topic: seed ? seed.content : '', messages: out.slice(start) };
}

/**
 * Runs voices back and forth until stopped or MAX_TURNS. `takeSteer()` returns what the person typed since the last
 * turn (or ''), added to the chat before the next voice speaks. ui: onStart(voice), onText(text), onDone(msg),
 * onSteer(msg). Returns why it ended: 'stopped' | 'limit' | 'error'.
 */
export async function run({ session, signal, ui = {}, takeSteer = () => '' }) {
  const [engine, sessions, { replyModel }] = await Promise.all([import('./engine.js'), import('./sessions.js'), import('./agent.js')]);
  for (let i = 0; i < MAX_TURNS; i++) {
    if (signal.aborted) return 'stopped';
    const steer = takeSteer();
    if (steer) ui.onSteer && ui.onSteer(sessions.addMessage(session, { role: 'user', content: steer }));
    const line = sessions.lineMessages(session, null);
    const voice = nextVoice(line);
    ui.onStart && ui.onStart(voice);
    let r = { text: '' }, error = null;
    try {
      r = await engine.foreground(async () => {
        const budget = engine.contextFor(engine.currentModel()) - MAX_OUTPUT - est(systemFor(voice, '')) - 400;
        const { topic, messages } = viewFor(line, voice, budget);
        const conv = await engine.conversation({ system: systemFor(voice, topic), messages: messages.slice(0, -1), maxOutputTokens: MAX_OUTPUT });
        try {
          return await engine.respond(conv, messages[messages.length - 1].content, { signal, onText: (t) => ui.onText && ui.onText(t) });
        } finally { try { await conv.delete(); } catch {} }
      });
    } catch (e) { error = e; }
    const text = (r.text || '').trim();
    if (signal.aborted && !text) { ui.onDone && ui.onDone(null); return 'stopped'; }
    const content = error ? [text, `⚠️ ${error.message || error}`].filter(Boolean).join('\n\n') : text || '_(nothing to add)_';
    const msg = sessions.addMessage(session, { role: 'assistant', voice, content, model: replyModel() });
    ui.onDone && ui.onDone(msg);
    if (error) return 'error';
  }
  return signal.aborted ? 'stopped' : 'limit';
}
