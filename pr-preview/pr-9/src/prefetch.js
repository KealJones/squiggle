// Fresh context (settings.contextMode 'fresh', docs/harness.md "Fresh context"): every turn starts new.
// Before the model sees a message, the agent looks things up for it: the message is made to stand on its own
// (a follow-up borrows the names from the question before it), earlier messages of this chat, its saved
// pages, memory facts and (when the setting is on) other chats are searched, and the web is searched with the
// same words. Only what clears a bar comes back; nothing is replayed just for being recent. The agent hands
// the result to the model as the result of a `find` call it already made, so none of it reads as the user
// talking (smart context's recalled block, quoted after the request, did read that way to small models).
//
// Pure apart from the inputs passed in, so it runs in node tests.
import { bm25, tokenize, cosine } from './search.js';

// ── The question on its own ────────────────────────────────────────────────

// Words that start sentences or questions, never names.
const NOT_NAMES = new Set(('I I\'m I\'d I\'ll I\'ve Im A An The This That These Those What Whats What\'s Who Whose Whom When Where Why How ' +
  'Which Is Are Was Were Do Does Did Can Could Would Should Will Shall May Might Must Have Has Had Please Tell Show Give Find Look ' +
  'Search Get Make Let Hey Hi Hello Yo Ok Okay So And But Or Also Then Now Awesome Cool Nice Great Thanks Thank Yes Yeah Yep No Nope ' +
  'Sure Well Oh Hmm Wait Actually Really Just Maybe About My Your Our Their His Her Its It It\'s He She They We You Me Us Them').split(' '));

const clean = (w) => w.replace(/['’]s$/, '').replace(/[.'’-]+$/, '');

/** Capitalised words that look like names ("Patrick Stewart", "Bugonia"), in order, without repeats. A word
 *  that starts a sentence is capitalised anyway, so it counts only when the next word is a capitalised name
 *  too ("Patrick Stewart was…"): "Sick I only asked…" and "Uhm thank you…" name nothing (Fresh looked up
 *  "Sick, Sick, Sick" and the actress Uhm Ji-won for them, 2026-11-09). */
export function namesIn(text) {
  const s = String(text || '');
  const out = [];
  for (const m of s.matchAll(/\b[A-Z][\p{L}\p{N}'’.-]*/gu)) {
    const w = clean(m[0]);
    if (w.length < 2 || NOT_NAMES.has(w) || out.includes(w)) continue;
    const before = s.slice(0, m.index);
    if (/^\s*$|[.!?]["'”’)]?\s+$|\n\s*$/.test(before)) {
      const next = /^\s+([A-Z][\p{L}\p{N}'’.-]*)/u.exec(s.slice(m.index + m[0].length));
      if (!next || NOT_NAMES.has(clean(next[1]))) continue;
    }
    out.push(w);
  }
  return out;
}

const PRONOUN = /\b(he|him|his|she|her|hers|they|them|their|theirs|it|its|that|this|those|these|one|ones|same)\b/i;
const FOLLOW_ON = /^\s*(and|also|but|so|ok(ay)?|awesome|cool|nice|great|thanks|what about|how about|and what about|what else|why|how come|really)\b/i;

/** The message points back at something earlier ("run that script", "what about it?"). */
export function pointsBack(message) {
  const m = String(message || '');
  return PRONOUN.test(m) || FOLLOW_ON.test(m);
}

/** A follow-up needs the question before it: it points back ("his", "that one") or carries on ("what about…")
 *  and names nothing of its own. */
export function isFollowUp(message) {
  return !namesIn(message).length && pointsBack(message);
}

// Asking Squiggle to do or make something, not asking about something: no web or Wikipedia lookup first.
const DO_VERB = '(write|make|create|build|run|execute|fix|debug|refactor|generate|draft|code|implement|edit|change|rename|delete|remove|add|test|convert|translate|rewrite|format|sort|plot|save|commit|push|clone|print)';
const DO_REQUEST = new RegExp(`(^|[.!?,]\\s*)((ok(ay)?|cool|so|now|then|just|anyway|anyways|but|and|alright|great|nice|awesome)[,!.]?\\s+)*(please\\s+)?((can|could|would|will)\\s+(you\\s+|u\\s+)?(please\\s+)?(help\\s+(me\\s+)?)?|help\\s+me\\s+|i\\s+(want|need|would like)\\s+(you\\s+)?to\\s+|let'?s\\s+|go\\s+(ahead\\s+and\\s+)?)?${DO_VERB}\\b`, 'i');

/** "Can you help me write a generator…", "Run that script with run_js", "write me a for loop". */
export const doRequest = (message) => DO_REQUEST.test(String(message || '').replace(/[‘’]/g, "'"));

/** The message as a search query that stands on its own. A follow-up gets the names (or, failing that, the
 *  topic words) of the previous question. Returns { query, borrowed } (borrowed: the words added). */
export function standalone(message, { prevUser = '' } = {}) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!prevUser || !isFollowUp(text)) return { query: text, borrowed: '' };
  const names = namesIn(prevUser);
  const borrowed = (names.length ? names : tokenize(prevUser).filter(w => !tokenize(text).includes(w)).slice(0, 6)).join(' ');
  // "Awesome, what about his most recent movie?" → "Patrick Stewart his most recent movie?"
  const rest = text.replace(/^((awesome|cool|nice|great|ok(ay)?|thanks|and|also|but|so|really)\b[\s,!.]*)+/i, '').replace(/^(and )?(what|how) about\s+/i, '');
  return { query: borrowed ? `${borrowed} ${rest || text}` : text, borrowed };
}

/** Links and repo paths in a message ("github.com/kealjones/bubbles", "https://example.com/a"), lower-cased,
 *  without the scheme or trailing punctuation. */
export function refsIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/(?:https?:\/\/)?((?:[\w-]+\.)+[a-z]{2,}\/[^\s"'<>)\]]+)/gi)) {
    const r = m[1].toLowerCase().replace(/[.,;:!?]+$/, '').replace(/\.git$/, '').replace(/\/$/, '');
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

// ── Is it worth looking anything up? ───────────────────────────────────────

const SMALL_TALK = /^\s*(hi|hey|hello|yo|sup|thanks?( you)?|thank u|ty|thx|ok(ay)?|k|cool|nice|great|awesome|lol|lmao|haha|bye|good ?(morning|night|evening)|yes|yeah|yep|no|nope|sure|got it|perfect|sounds good)\b[\s!.,?]*$/i;
const ARITHMETIC = /^[\s\d.,+\-*/()%x×÷^=]+\??$/;

/** Plain small talk, an acknowledgement or bare arithmetic: nothing to look up. */
export const smallTalk = (message) => SMALL_TALK.test(String(message || '')) || ARITHMETIC.test(String(message || '').trim());

// ── Ranking what's saved ───────────────────────────────────────────────────

// Bars: by meaning, MiniLM's cosine (unrelated text sits around 0.1-0.3, the same topic 0.45 and up); by
// words, at least two of the query's words (or all of a one-word query), and a third of them.
export const BARS = { meaning: 0.45, words: 0.34 };

/** Ranks candidates [{ id, kind, text, ts?, boost? }] for the query and keeps the ones over the bar, best first.
 *  `vecs`: embeddings (the query first, then one per candidate) for ranking by meaning; else words. Each kept one
 *  gets `score` (0..1). */
export function rank(query, candidates, { vecs = null, k = 6 } = {}) {
  const all = (candidates || []).filter(c => c && String(c.text || '').trim());
  // A query that names someone or something only matches text that names them too: "Emma Stone's latest
  // movie" shares "latest movie" with a Patrick Stewart question, and by meaning they're close as well.
  // A link or repo path is a name too, and an exact one: "pull github.com/kealjones/bubbles" matched an old chat
  // about github.com/kealjones/squiggle on the word "GitHub.com", and the model went after squiggle (2026-11-09).
  const refs = refsIn(query);
  const names = refs.length ? refs : namesIn(query).map(n => n.toLowerCase());
  const named = (c) => !names.length || names.some(n => String(c.text).toLowerCase().includes(n));
  const keep = all.map((c, i) => [c, i]).filter(([c]) => named(c));
  const list = keep.map(([c]) => c);
  if (vecs && vecs.length === all.length + 1) vecs = [vecs[0], ...keep.map(([, i]) => vecs[i + 1])];
  if (!list.length) return [];
  const qw = [...new Set(tokenize(query))];
  let scored;
  if (vecs && vecs.length === list.length + 1 && vecs.every(Boolean)) {
    scored = list.map((c, i) => ({ c, s: cosine(vecs[0], vecs[i + 1]) + (c.boost || 0) }))
      .filter(x => x.s >= BARS.meaning);
  } else {
    if (!qw.length) return [];
    const kw = bm25(list.map((c, i) => ({ id: i, text: c.text })))(qw.join(' '));
    const top = Math.max(0, ...kw.values());
    scored = list.map((c, i) => {
      const words = new Set(tokenize(c.text));
      const hits = qw.filter(w => words.has(w)).length;
      const share = hits / qw.length;
      const ok = hits >= Math.min(2, qw.length) && share >= BARS.words;
      return { c, s: ok ? 0.5 * share + 0.5 * (top ? (kw.get(i) || 0) / top : 0) + (c.boost || 0) : -1 };
    }).filter(x => x.s >= 0);
  }
  return scored.sort((a, b) => b.s - a.s || (b.c.ts || 0) - (a.c.ts || 0)).slice(0, k)
    .map(({ c, s }) => ({ ...c, score: Math.round(Math.min(1, s) * 100) / 100 }));
}

/** This chat's earlier exchanges as candidates: one per question with the reply to it. The last exchange gets
 *  a small boost (a follow-up is usually about it), never a free pass. */
export function exchangeCandidates(line, { textOf = (m) => m.content, max = 40 } = {}) {
  const out = [];
  const msgs = (line || []).filter(m => m && !m.deleted && (m.role === 'user' || m.role === 'assistant')).slice(-max);
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== 'user') continue;
    const reply = msgs[i + 1] && msgs[i + 1].role === 'assistant' ? msgs[i + 1] : null;
    const q = String(textOf(msgs[i]) || '').trim();
    const a = reply ? String(textOf(reply) || '').trim() : '';
    if (!q) continue;
    out.push({ id: `x:${msgs[i].id}`, kind: 'exchange', ts: msgs[i].ts, ref: msgs[i].id, question: q, answer: a, text: `${q}\n${a}` });
  }
  if (out.length) out[out.length - 1].boost = 0.05;
  return out;
}

// ── Standing instructions ──────────────────────────────────────────────────

// Fresh replays nothing, so an instruction meant for the whole chat ("answer in Spanish from now on", "always
// show your sources", "call me Kay") was gone on the next message unless it happened to match the question
// (2026-11-09). These are the user's own messages that read as a rule for what follows, kept short, and they
// go in every lookup for this chat. Only the user's turns count; a rule inside a long request is left alone
// (the whole message would be replayed), and the current message is never one (it's in the prompt already).
const STANDING = /\b(from now on|for the rest of (this|the) (chat|conversation|session)|going forward|in (this|our) (chat|conversation)|always|never|don'?t ever|every time|each time|whenever you|call me|my name is|address me as|(answer|reply|respond|write|talk|speak) (only )?in [a-z]+|(use|stick to) (metric|imperial|celsius|fahrenheit|british|american|uk|us) (units|spelling|english)?|keep (it|them|your (answers|replies))|be (brief|concise|short|terse|detailed)|no (bullet points|lists|emoji|markdown)|without (bullet points|lists|emoji|markdown))\b/i;
const ONE_OFF = /\b(this (time|once)|just (this|for) (once|now)|for now)\b/i;

/** The user's standing instructions in this chat: short user messages before `current` that read as a rule for
 *  what follows, oldest first, without repeats. `textOf` reads a message's text. */
export function standingInstructions(line, { current = null, textOf = (m) => m.content, max = 5, maxChars = 200 } = {}) {
  const out = [];
  for (const m of line || []) {
    if (!m || m.deleted || m.role !== 'user' || (current && m.id === current)) continue;
    const text = String(textOf(m) || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > maxChars || !STANDING.test(text) || ONE_OFF.test(text)) continue;
    if (out.some(x => x.toLowerCase() === text.toLowerCase())) continue;
    out.push(text);
  }
  return out.slice(-max);
}

// ── What the model gets ────────────────────────────────────────────────────

const oneLine = (s, n) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
};
const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric' }) : '');

/** The lookup's result, as the model reads it. `wrap(source, text)` marks outside content (untrusted.js).
 *  sizes: characters per kind, smaller for small models. Returns '' when nothing was found anywhere. */
export function render({ query, exchanges = [], chats = [], facts = [], pages = [], wiki = '', web = null, check = '', standing = [], tools = [] },
  { wrap = (s, t) => t, small = false, bash = false } = {}) {
  const n = small ? { q: 160, a: 280, page: 500, snip: 220 } : { q: 240, a: 500, page: 900, snip: 400 };
  const parts = [];
  if (check) parts.push(check);
  if (standing.length) parts.push('Instructions the user gave earlier in this chat, still in force:\n' + standing.map(s => `- "${s}"`).join('\n'));
  // Tools that fit the request, as the model's own find would list them (they're ready to call after this).
  if (tools.length) parts.push('Tools for this (ready to call):\n' + tools.map(t => `- ${t.name}(${(t.args || []).map(a => a.required ? a.name : a.name + '?').join(', ')}): ${t.description}`).join('\n'));
  if (exchanges.length) {
    // `full`: the exchange a pointing-back message is about ("run that script"), with the reply as written
    // (code keeps its lines), not squeezed to one line.
    const full = small ? 1500 : 3000;
    parts.push('Earlier in this chat:\n' + exchanges.map(x => (x.full && x.answer
      ? `- The user asked "${oneLine(x.question, n.q)}"; you answered:\n${x.answer.length > full ? x.answer.slice(0, full) + '\n…' : x.answer}`
      : `- The user asked "${oneLine(x.question, n.q)}"${x.answer ? `; you answered "${oneLine(x.answer, n.a)}"` : ''}`)).join('\n'));
  }
  if (chats.length) {
    parts.push('Other chats:\n' + chats.map(x =>
      `- (${[when(x.ts), oneLine(x.title, 40)].filter(Boolean).join(', ')}) the user asked "${oneLine(x.question, n.q)}"${x.answer ? `; you answered "${oneLine(x.answer, n.a)}"` : ''}`).join('\n'));
  }
  if (facts.length) parts.push('Memory:\n' + facts.map(f => `- ${oneLine(f, 200)}`).join('\n'));
  if (pages.length) parts.push('Pages and files saved in this chat:\n' + pages.map(p => wrap(p.source || 'saved page', `${p.title || ''}\n${oneLine(p.text, n.page)}`)).join('\n'));
  if (wiki) parts.push(`Wikipedia and Wikidata:\n${wiki}`);
  if (web && web.items && web.items.length) {
    const body = [
      web.answer && web.answer.text ? `Summary (${web.answer.source || 'search'}): ${oneLine(web.answer.text, n.page)}` : '',
      ...web.items.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${oneLine(x.snippet, n.snip)}`),
    ].filter(Boolean).join('\n');
    parts.push(`Web search for "${oneLine(web.query || query, 80)}":\n${wrap('web search', body)}`);
  } else if (web && web.error) {
    parts.push(`The web search failed: ${web.error}`);
  }
  if (!parts.length) return '';
  const tail = bash
    ? ((web && web.items && web.items.length) || wiki ? 'To read a result, curl its link in bash (pipe into grep for the part you need). If none of this answers it, search with other words.' : tools.length ? `Call ${tools[0].name} for this.` : 'If this doesn\'t answer it, search in bash.')
    : (web && web.items && web.items.length) || wiki
    ? 'To read a result in full, call fetch_url with its link. If none of this answers it, call web_search with other words.'
    : tools.length ? `Call ${tools[0].name} for this; don't search the web for it.`
    : 'If this doesn\'t answer it, call web_search.';
  return `Looked up before answering, for "${oneLine(query, 120)}" (search results, not the user's words):\n\n${parts.join('\n\n')}\n\n${tail}`;
}
