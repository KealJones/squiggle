// Brainstorm chats (Keal, 2026-11-12): the person sends the idea, then the model talks to itself. Two voices, A and B,
// take turns, in one of two framings (session.brainstorm):
// - 'transcript' (the default): the model gets the whole brainstorm as a labelled transcript in one user turn and
//   writes one speaker's next turn, so nobody it talks to sits in the user role (failures.md case 21: in the role
//   flip LFM3 served and agreed with the other voice whatever the system prompt said).
// - 'flip' (the first design; `true` on chats made before the switch): each voice sees its own turns as the
//   assistant and everything else (the other voice, the person) as the user.
// The person can jump in between turns to steer, and stop it. No tools, no plan, no thinking: just the back-and-forth.
// A turn can be as long as the voice wants: one call writes up to PIECE tokens, and a turn cut off there is handed back
// to the same voice (a fresh call with what it wrote so far) to finish, since a 4K window can't hold a long turn at once.
// In the transcript framing a brainstorm runs in phases (Keal, 2026-11-12, after chat s0mwe4yoqe000frhk4 asked which
// noodle shape and got twenty turns about one cheese ratio): diverge first (both voices only add options, nobody
// judges), then one cluster turn (group them, pick the most promising), then converge (A builds, B criticizes). A turn
// that repeats an earlier one is thrown away and tried again; a second repeat stops the run (`isRepeat`).
// The browser-side modules load in run(), so the pure parts here are testable in node.

export const VOICES = { A: 'Squiggle A', B: 'Squiggle B', S: 'Squiggle' };   // S writes the wrap-up
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
// The same jobs, for the transcript framing, where the model writes a named speaker's lines.
const PART = {
  A: 'A is the builder: pushes the idea further with new, concrete ideas, and when B criticizes something, either fixes it or says plainly why the criticism is wrong.',
  B: 'B is the critic: starts every turn with the weakest or riskiest part of what A just said and why it would fail, including anywhere A made the person\'s idea safer or more ordinary than they asked for, then offers a fix or a different direction, and agrees only with what survives that.',
};
// The person's idea is the point (chat s0mwec78t10005me61, 2026-11-12: "an app that just shows the last thing said by each
// person… everything that gets said is replaced" became a chat app with history, search and "show last N turns";
// Keal: "they took my fun stupid idea and make it normal ass boring normal chat").
const PREMISE = 'The person\'s idea is the point. Take it exactly as they said it, including whatever makes it strange, impractical or funny, and push it further on its own terms. Don\'t fix it, soften it, or turn it into something ordinary.';

// Sampling for brainstorm turns: LFM3's card says temperature 0.1 for chat and agents, nearly greedy, which is how two
// voices handed almost the same transcript wrote the same turn again and kept every idea ordinary. Hotter while
// listing, a little cooler while testing, the card's own for the wrap-up. A presence penalty against reusing words.
export const SAMPLING = { diverge: { temperature: 0.9, presence: 0.6 }, cluster: { temperature: 0.7, presence: 0.4 }, converge: { temperature: 0.7, presence: 0.4 } };
const other = (v) => (v === 'A' ? 'B' : 'A');

// Phases, by how many voice turns came before this one ("diverge before you converge": generate options without
// judging, group them, then evaluate; the critic coming in on turn two is what narrowed every brainstorm so far).
export const DIVERGE_TURNS = 4;
export const CONVERGE_TURNS = 6;  // testing turns before the wrap-up (and again after each one, on Keep going)
export const PHASES = { diverge: 'listing options', cluster: 'grouping', converge: 'testing', decision: 'wrap-up' };
export function phaseOf(line) {
  const n = turns(line).filter(m => m.role === 'assistant' && m.voice).length;
  return n < DIVERGE_TURNS ? 'diverge' : n === DIVERGE_TURNS ? 'cluster' : 'converge';
}

// The brainstorm ends with a wrap-up for the person (Keal, 2026-11-12, chat s0mweal56h0007v3ch: "we gotta get a summary
// and final decision message"): a summary, the decision, why, and what's still open. Due after CONVERGE_TURNS testing
// turns since the grouping turn or the last wrap-up.
export function wrapUpDue(line) {
  const all = turns(line);
  const last = all.map(m => Boolean(m.decision)).lastIndexOf(true);
  const voiced = all.slice(last + 1).filter(m => m.role === 'assistant' && m.voice).length;
  return last >= 0 ? voiced >= CONVERGE_TURNS : voiced >= DIVERGE_TURNS + 1 + CONVERGE_TURNS;
}
export function wrapUpSystem(topic) {
  return [
    `This is the end of a brainstorm between two partners, A and B. What the person who started it said: ${clipMiddle(String(topic || ''), TOPIC)}`,
    PREMISE,
    'You write the wrap-up for the person, in four short parts with these headings:',
    '**Summary**: the options the brainstorm considered, grouped, a few bullets.',
    '**Decision**: the one take on the idea, or answer to the question, it lands on, stated plainly, even if it is a hypothesis.',
    '**Why**: the reasons, including which of B\'s objections it survives and which it doesn\'t.',
    '**Still open**: what is untested and how to test it.',
    'Write it for the person, not for A or B: no "A:" or "B:" labels.',
  ].join('\n');
}
// Every phase is tied back to the person's question, and from the cluster turn on each turn ends with a proposed
// answer (Keal: "always got to keep that question in mind… even if it is just a hypothesis, get into a proposal").
export const BEST = 'Best answer so far:';
const PHASE_PART = {
  diverge: (v) => `Right now both partners are only generating options. ${v} adds directions for the person's idea (or answers to their question) that nobody has listed yet, the bolder the better, as a short list with one line each on why it could work. No judging, no picking favourites, no details yet.`,
  cluster: (v) => `Now ${v} restates the person's idea or question in one line, groups every option listed so far into a few themes, says which fit what the person asked for best and why, and ends with a line starting "${BEST}" giving a first take, even if it's only a hypothesis. No new options.`,
  converge: (v) => `${PART[v]} Everything is judged by whether it serves what the person asked for; anything that drifts away from it gets pulled back to it. ${v} ends every turn with a line starting "${BEST}" giving its current take, even if it's only a hypothesis.`,
};
// A long idea (a pasted page of notes) is cut in the middle, keeping its start and end.
export const clipMiddle = (s, chars) => (s.length <= chars ? s : s.slice(0, Math.ceil(chars / 2)) + ' … ' + s.slice(-Math.floor(chars / 2)));
const TOPIC = 600;                // characters of the idea in a system prompt; the transcript carries it in full (up to a third of its budget)

export const framingOf = (session) => (session && (session.brainstorm === 'flip' || session.brainstorm === true) ? 'flip' : 'transcript');
export const PERSON = 'The person who started this brainstorm';

// opts.phase: the transcript framing's phase (default converge); opts.retry: the last try repeated an earlier turn.
export function systemFor(voice, topic, steer = '', framing = 'flip', { phase = 'converge', retry = false } = {}) {
  topic = clipMiddle(String(topic || ''), TOPIC);
  if (framing === 'transcript') return [
    `This is a brainstorm between two partners, A and B. What the person who started it said: ${topic}`,
    PREMISE,
    ...(steer ? [`The person who started it just stepped in and said: "${steer}". This turn follows that direction, whatever ${other(voice)} last said.`] : []),
    `You write ${voice}'s turns. ${(PHASE_PART[phase] || PHASE_PART.converge)(voice)}`,
    `${voice} never opens with praise or agreement: the first sentence is about the idea. No repeating earlier points, and no questions for anyone at the end. Take as much space as the turn needs.`,
    `Write ${voice}'s own words in the first person ("I'd try…"), not a description of what ${voice} says.`,
    ...(retry ? [`${voice}'s last try repeated an earlier turn almost word for word and was thrown away: this turn says something that isn't in the transcript yet.`] : []),
    `Reply with ${voice}'s next turn only: no "${voice}:" label and nothing for anyone else.`,
  ].join('\n');
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
export function continueSystem(voice, topic, sofar, steer = '', framing = 'flip', opts = {}) {
  const tail = sofar.length > TAIL ? '…' + sofar.slice(-TAIL) : sofar;
  const what = framing === 'transcript' ? `${voice}'s turn` : 'Your reply to the latest message';
  return `${systemFor(voice, topic, steer, framing, opts)}\n\n${what} was cut off by the length limit. It ends like this:\n\n${tail}\n\nContinue it from exactly where it stops, mid-sentence if needed. Don't repeat any of it and don't start over.`;
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
  if (last && est(last.content) > budget) last.content = '…' + last.content.slice(-Math.max(300, Math.floor(budget * 3)));   // slice(-0) would keep it all
  return { topic: seed ? seed.content : '', messages };
}

// In the transcript framing the model is writing a script, and a script goes on: chat s0mwe3d6wm000gl4py's first turn
// finished A's part and carried on with "A: Let me flesh out…", and B's first was "B: … A: … B: …", each running until
// the window filled. Like any transcript prompt, a turn ends where the next speaker's label starts (the person's
// included) after a blank line, and a leading label of its own is dropped.
const LEAD = /^\s*(?:\*\*)?[AB](?::\*\*|\*\*:|:)[ \t]*/;   // B:, **B:** or **B**:
// A blank line before it, as transcriptFor joins turns: a "Q: … / A: …" list inside a turn doesn't end it.
const NEXT = new RegExp(`\\n[ \\t]*\\n[ \\t]*(?:\\*\\*)?(?:A|B|${PERSON})(?::\\*\\*|\\*\\*:|:)`);
// LFM3 sometimes thinks out loud with thinking off and closes it with a stray </think> (chat s0mwec78t10005me61, three
// turns in a row): what comes after it is the turn, what came before was the draft.
export function dropThinking(text) {
  const t = String(text || ''), i = t.lastIndexOf('</think>');
  if (i < 0) return t;
  const after = t.slice(i + 8).replace(/^\s+/, '');
  return after || t.slice(0, i).replace(/<think>/g, '').trimEnd();
}
export function ownTurn(text, framing = 'transcript') {
  if (framing !== 'transcript') return { text: dropThinking(text), other: false };
  const t = dropThinking(text).replace(LEAD, '');
  const m = t.match(NEXT);
  return m ? { text: t.slice(0, m.index).trimEnd(), other: true } : { text: t, other: false };
}

// A turn that says again what an earlier turn said: most of its word triples (85%) are in one earlier turn. In chat
// s0mwe4yoqe000frhk4 B posted the same 685 characters four times and A its recipe three times: once the transcript shows
// a voice saying something twice, the likeliest next turn is that text again. Short turns (under 30 words) are left
// alone; a turn that quotes an earlier one and adds as much again isn't a repeat.
const MIN_WORDS = 30, SAME = 0.85;
const triples = (text) => {
  const w = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i + 2 < w.length; i++) out.add(w[i] + ' ' + w[i + 1] + ' ' + w[i + 2]);
  return { set: out, words: w.length };
};
// Measured against everything said before, not one turn at a time: in chat s0mweal56h0007v3ch B's first testing turn
// was its own earlier list plus A's best answer pasted after it. "Best answer so far" lines are left out of the
// comparison: an answer that holds from turn to turn is allowed to repeat.
const noBest = (t) => String(t || '').split('\n').filter(l => !l.includes(BEST)).join('\n');
export function isRepeat(text, earlier) {
  const t = triples(noBest(text));
  if (t.words < MIN_WORDS || !t.set.size) return false;
  const seen = new Set();
  for (const e of earlier) for (const x of triples(noBest(e)).set) seen.add(x);
  let hit = 0;
  for (const x of t.set) if (seen.has(x)) hit++;
  return hit / t.set.size >= SAME;
}

/**
 * The transcript framing: the whole brainstorm as one user turn, every turn labelled with who said it (A, B, or the
 * person), ending with the ask for `voice`'s next turn. The oldest turns after the idea drop off to fit `budget`
 * tokens, and a turn longer than what's left keeps its end. Returns { messages } like viewFor.
 */
export function transcriptFor(line, voice, budget = Infinity) {
  const all = turns(line);
  const seed = all.find(m => m.role === 'user');
  const label = (m) => (m.role === 'user' ? PERSON : m.decision ? 'Wrap-up' : m.voice || 'A');
  // Repeats saved before repeats were caught are left out, so the model doesn't see itself saying a thing twice.
  const said = [];
  const entries = all.filter(m => m !== seed).filter(m => {
    if (m.role === 'assistant' && !m.decision && isRepeat(m.content, said)) return false;
    said.push(m.content); return true;
  }).map(m => `${label(m)}: ${m.content}`);
  // The idea opens the transcript but takes at most a third of the budget, so the turns still fit (review, 2026-11-12:
  // an idea over ~4,000 characters left no room and B never saw A's turn).
  const head = seed ? `${PERSON}: ${clipMiddle(seed.content, Math.max(300, Math.floor(budget / 3) * 3))}` : '';
  // The question again right before the ask, where a small model's attention is (the head may be far back).
  const what = voice === 'S' ? 'the wrap-up' : `${voice}'s next turn`;
  const ask = seed ? `The question: ${clipMiddle(seed.content, 300)}\nNow write ${what}.` : `Now write ${what}.`;
  let room = budget - est(head) - est(ask), start = entries.length;
  while (start > 0 && est(entries[start - 1]) <= room) room -= est(entries[--start]);
  const kept = entries.slice(start);
  if (start > 0 && !kept.length && room > 0) kept.push('…' + entries[entries.length - 1].slice(-Math.floor(room * 3)));
  const body = [head, ...(start > 0 && kept.length ? ['…'] : []), ...kept].filter(Boolean).join('\n\n');
  return { messages: [{ role: 'user', content: `${body}\n\n${ask}` }] };
}

/**
 * Runs voices back and forth until stopped or MAX_TURNS. `takeSteer()` returns what the person typed since the last
 * turn (or ''), added to the chat before the next voice speaks; `wantsWrap()` is true once the person asked for the
 * wrap-up. ui: onStart(voice, phase), onText(text), onDone(msg), onSteer(msg); the wrap-up comes as voice 'S', phase
 * 'decision'. With `wrapOnly` it writes just the wrap-up. Returns why it ended: 'stopped' | 'limit' | 'error' |
 * 'stuck' (a voice repeated itself twice) | 'done' (wrapped up). In the transcript framing a run that ends by itself
 * (done, limit, stuck) ends with a wrap-up; Stop and errors don't.
 */
export async function run({ session, signal, ui = {}, takeSteer = () => '', wantsWrap = () => false, wrapOnly = false }) {
  const [engine, sessions, { replyModel }] = await Promise.all([import('./engine.js'), import('./sessions.js'), import('./agent.js')]);
  const framing = framingOf(session);
  const topicOf = (line) => (turns(line).find(m => m.role === 'user') || {}).content || '';

  // One turn (a voice's, or the wrap-up as 'S'), continued while it's cut off and stopped where another speaker starts.
  async function speak(line, voice, systemOf, sampling = null) {
    let sofar = '';
    for (let piece = 0; piece < MAX_PIECES && !signal.aborted; piece++) {
      const r = await engine.foreground(async () => {
        const system = systemOf(sofar);
        const budget = engine.contextFor(engine.currentModel()) - PIECE - est(system) - 200;
        const { messages } = framing === 'transcript' ? transcriptFor(line, voice, budget) : viewFor(line, voice, budget);
        const conv = await engine.conversation({ system, messages: messages.slice(0, -1), maxOutputTokens: PIECE, sampling, strictThinking: true });
        // This call stops as soon as the model starts another speaker's turn (ownTurn); Stop still stops it all.
        const call = new AbortController();
        const stop = () => call.abort();
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) call.abort();   // Stop pressed while this waited for the generation lock
        let other = false;
        try {
          const out = await engine.respond(conv, messages[messages.length - 1].content, { signal: call.signal, onText: (t) => {
            const own = ownTurn(sofar + t, framing);
            if (own.other && !other) { other = true; call.abort(); }
            ui.onText && ui.onText(own.text);
          } });
          return { text: out.text || '', thinking: out.thinking || '', speed: await engine.smallSpeed() };
        } finally { signal.removeEventListener('abort', stop); try { await conv.delete(); } catch {} }
      });
      const own = ownTurn(sofar + r.text, framing);
      sofar = own.text;
      // Nothing came back: an error that says what did, not a "nothing to add" turn and on to the next voice
      // (chat s0mwf2h9yl000pi7l4, Gemma 4 26B: four empty turns in a row).
      if (!sofar.trim() && !signal.aborted) {
        const model = (replyModel() || {}).label || 'The model';
        throw new Error(`${model} sent back no text${r.thinking ? ` (only ${r.thinking.length} characters of thinking)` : ''}.`);
      }
      if (own.other || !cutOff(r.text, r.speed)) break;
    }
    return sofar;
  }

  async function wrapUp() {
    const line = sessions.lineMessages(session, null);
    const topic = topicOf(line);
    ui.onStart && ui.onStart('S', 'decision');
    let text = '', error = null;
    try {
      text = (await speak(line, 'S', (sofar) => sofar
        ? `${wrapUpSystem(topic)}\n\nThe wrap-up was cut off by the length limit. It ends like this:\n\n${sofar.length > TAIL ? '…' + sofar.slice(-TAIL) : sofar}\n\nContinue it from exactly where it stops. Don't repeat any of it.`
        : wrapUpSystem(topic))).trim();
    } catch (e) { error = e; }
    if (signal.aborted && !text) { ui.onDone && ui.onDone(null); return 'stopped'; }
    const msg = sessions.addMessage(session, { role: 'assistant', decision: true, content: text || '_(nothing to add)_', ...(error ? { error: String(error.message || error) } : {}), model: replyModel() });
    ui.onDone && ui.onDone(msg);
    return error ? 'error' : 'done';
  }
  const wraps = framing === 'transcript';
  if (wrapOnly) return wraps ? wrapUp() : 'done';

  for (let i = 0; i < MAX_TURNS; i++) {
    if (signal.aborted || session.deleted || session.archived) return 'stopped';
    const steer = takeSteer();
    if (steer) ui.onSteer && ui.onSteer(sessions.addMessage(session, { role: 'user', content: steer }));
    const line = sessions.lineMessages(session, null);
    if (wraps && (wantsWrap() || wrapUpDue(line))) return wrapUp();
    const voice = nextVoice(line);
    const phase = wraps ? phaseOf(line) : null;
    const topic = topicOf(line);
    let text = '', error = null, repeats = 0;
    for (;;) {
      ui.onStart && ui.onStart(voice, phase);
      error = null;
      try {
        const st = latestSteer(line);
        const opts = { phase: phase || 'converge', retry: repeats > 0 };
        text = (await speak(line, voice, (sofar) => (sofar ? continueSystem(voice, topic, sofar, st, framing, opts) : systemFor(voice, topic, st, framing, opts)), SAMPLING[phase || 'converge'])).trim();
      } catch (e) { error = e; }
      // A repeat is thrown away, never saved, so the transcript never shows it twice; one more try, then the run stops.
      if (error || signal.aborted || !isRepeat(text, turns(line).filter(m => m.role === 'assistant').map(m => m.content))) break;
      ui.onDone && ui.onDone(null);
      if (++repeats > 1) { if (wraps) await wrapUp(); return 'stuck'; }
    }
    if (signal.aborted && !text) { ui.onDone && ui.onDone(null); return 'stopped'; }
    // An error is shown under the turn, not written into it, so the next voice doesn't read it as A's or B's words.
    const msg = sessions.addMessage(session, { role: 'assistant', voice, content: text || '_(nothing to add)_', ...(phase ? { phase } : {}), ...(error ? { error: String(error.message || error) } : {}), model: replyModel() });
    ui.onDone && ui.onDone(msg);
    if (error) return 'error';
  }
  if (signal.aborted) return 'stopped';
  if (wraps) { const why = await wrapUp(); if (why !== 'done') return why; }
  return 'limit';
}
