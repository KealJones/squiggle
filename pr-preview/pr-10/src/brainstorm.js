// Brainstorm chats (Keal, 2026-11-12): the person sends the idea, then the model talks to itself. Two voices, A and B,
// take turns; each sees its own turns as the assistant and everything else (the other voice, the person) as the user.
// The person can jump in between turns to steer, and stop it. No tools, no plan, no thinking: just the back-and-forth.
// A turn can be as long as the voice wants: one call writes up to PIECE tokens, and a turn cut off there is handed back
// to the same voice (a fresh call with what it wrote so far) to finish, since a 4K window can't hold a long turn at once.
// The browser-side modules load in run(), so the pure parts here are testable in node.

export const VOICES = { A: 'Squiggle A', B: 'Squiggle B' };
export const MAX_TURNS = 20;      // per run, so a forgotten tab doesn't brainstorm all night; "Keep going" starts another
export const PIECE = 1024;        // tokens one call writes (engine-wllama's most); a longer turn is continued
export const MAX_PIECES = 8;      // calls per turn: room for a long document, not a runaway
const TAIL = 2400;                // characters of a cut-off turn shown back when it continues (its end is what matters)
// Tokens from characters, on the safe side (markdown, tables and symbols cost more tokens per character than prose).
const est = (s) => Math.ceil(String(s || '').length / 3);

// Each voice's job, so two copies of one model argue instead of agreeing with each other. "Lean toward testing" wasn't
// enough: in the first real run (chat s0mwdzez4u000gv6fi, LFM3 1.7B, 2026-11-12) B opened almost every turn with praise
// and by its fourth turn both were just agreeing and drafting a spec sheet together.
const ROLE = {
  A: 'You are the builder. Push the idea further with new, concrete ideas. When your partner criticizes something, either fix it or say plainly why the criticism is wrong.',
  B: 'You are the critic. Start every turn with the weakest or riskiest part of what your partner just said and why it would fail. Then offer a fix or a different direction. Agree only with what survives that.',
};

export function systemFor(voice, topic, steer = '') {
  return [
    `You are brainstorming with a partner. The topic, from the person who started this: ${topic}`,
    ...(steer ? [`The person who started this just stepped in and said: "${steer}". Your turn follows that direction, whatever your partner last said.`] : []),
    'Your partner\'s messages arrive as the user turns. Reply to them directly, like a conversation between two collaborators.',
    ROLE[voice],
    'Never open with praise or agreement: your first sentence is about the idea. Don\'t repeat earlier points. Take as much space as the turn needs.',
    'When the person who started this steps in, follow their direction.',
  ].join('\n');
}

// The system prompt for finishing a turn that was cut off: the same instructions, then what it wrote so far.
export function continueSystem(voice, topic, sofar, steer = '') {
  const tail = sofar.length > TAIL ? '…' + sofar.slice(-TAIL) : sofar;
  return `${systemFor(voice, topic, steer)}\n\nYour reply to the latest message was cut off by the length limit. It ends like this:\n\n${tail}\n\nContinue it from exactly where it stops, mid-sentence if needed. Don't repeat any of it and don't start over.`;
}

// Whether one call stopped short rather than finishing. The runtime's own reason when it gives one ('length': it ran
// out of max_tokens or of context window, which on a 4K model comes first: chat s0mwe2h0vm000lwbud's turns stopped at
// ~300–450 tokens), else the token count (streamed pieces ≈ tokens), else an estimate from the text. A call that wrote
// nothing isn't cut off (smallSpeed keeps the previous reply's numbers when nothing streamed).
export function cutOff(text, speed, cap = PIECE) {
  if (!String(text || '').trim()) return false;
  if (speed && speed.finish) return speed.finish === 'length';
  const tokens = speed && speed.tokens != null ? speed.tokens : Math.ceil(String(text).length / 4);
  return tokens >= cap - 8;
}

const said = (m) => !m.deleted && !m.thread && (m.role === 'user' || m.role === 'assistant');
export const turns = (line) => line.filter(said);

// What the person said when they last stepped in, while it's fresh: until both voices have answered it. In chat
// s0mwe2h0vm000lwbud "Lets get back to pasta shapes", merged after A's long reply that ended in a question to B,
// was ignored: B answered A's question. The system prompt is where a small model takes direction from.
export function latestSteer(line) {
  const all = turns(line);
  const seed = all.find(m => m.role === 'user');
  let since = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    if (m.role === 'assistant') { if (++since >= 2) return ''; continue; }
    return m === seed ? '' : m.content;
  }
  return '';
}

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
  const messages = out.slice(start);
  // A turn longer than the whole budget (a long document): its end, which is what gets answered.
  const last = messages[messages.length - 1];
  if (last && est(last.content) > budget) last.content = '…' + last.content.slice(-Math.max(0, Math.floor(budget * 3)));
  return { topic: seed ? seed.content : '', messages };
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
    let sofar = '', error = null;
    try {
      for (let piece = 0; piece < MAX_PIECES && !signal.aborted; piece++) {
        const r = await engine.foreground(async () => {
          const topic = (turns(line).find(m => m.role === 'user') || {}).content || '';
          const steer = latestSteer(line);
          const system = sofar ? continueSystem(voice, topic, sofar, steer) : systemFor(voice, topic, steer);
          const budget = engine.contextFor(engine.currentModel()) - PIECE - est(system) - 200;
          const { messages } = viewFor(line, voice, budget);
          const conv = await engine.conversation({ system, messages: messages.slice(0, -1), maxOutputTokens: PIECE });
          try {
            const out = await engine.respond(conv, messages[messages.length - 1].content, { signal, onText: (t) => ui.onText && ui.onText(sofar + t) });
            return { text: out.text || '', speed: await engine.smallSpeed() };
          } finally { try { await conv.delete(); } catch {} }
        });
        sofar += r.text;
        if (!cutOff(r.text, r.speed)) break;
      }
    } catch (e) { error = e; }
    const text = sofar.trim();
    if (signal.aborted && !text) { ui.onDone && ui.onDone(null); return 'stopped'; }
    const content = error ? [text, `⚠️ ${error.message || error}`].filter(Boolean).join('\n\n') : text || '_(nothing to add)_';
    const msg = sessions.addMessage(session, { role: 'assistant', voice, content, model: replyModel() });
    ui.onDone && ui.onDone(msg);
    if (error) return 'error';
  }
  return signal.aborted ? 'stopped' : 'limit';
}
