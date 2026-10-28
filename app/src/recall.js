// Recalled messages (docs/harness.md, "0b. Smart, reworked"): a small, clearly
// labelled block of earlier messages (this chat's older ones and other chats')
// and memory facts, appended AFTER the user's new message. The old Smart put
// these in the system prompt, where small models read them as the person
// talking now.
//
// Pure apart from the optional embed/recall functions passed in.

import { tokenize, bm25, cosine } from './search.js';
import { estTokens } from './util.js';

const DAY = 24 * 3600 * 1000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const NUMS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, couple: 2, few: 3 };

// Talk about the past: lowers the bar a little.
export const PAST_REF = /\b(last time|earlier|before|yesterday|ago|last (week|month|night)|the other day|we (talked|discussed|did|said)|you (said|told|mentioned|suggested|recommended)|i (said|told you|mentioned|asked|wrote)|remember|previous(ly)?|that (thing|one)|what (was|were) (it|that|those))\b/i;
// Words that are about the asking, not the topic ("what I said about X").
const META = new Set(['said', 'say', 'told', 'tell', 'mention', 'mentioned', 'talk', 'talked', 'discuss', 'discussed', 'ask', 'asked',
  'remember', 'recall', 'earlier', 'previous', 'previously', 'last', 'time', 'thing', 'stuff', 'again', 'chat', 'conversation', 'other', 'ago',
  'week', 'month', 'day', 'days', 'yesterday', 'today', 'morning', 'night', 'tonight', 'lol', 'hey', 'hi', 'hello', 'cool', 'nice', 'great']);
const PRONOUN = /\b(it|that|this|those|these|them|the one|same)\b/i;

const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

// A date window from phrases like "yesterday", "last week", "3 days ago",
// "on Monday". Generous on purpose: people are loose about these.
// Returns { from, to, phrase } or null.
export function timeWindow(text, now = Date.now()) {
  const s = String(text || '').toLowerCase();
  const today = startOfDay(now);
  const w = (from, to, phrase) => ({ from, to, phrase });
  let m;
  if ((m = s.match(/\b(earlier today|this morning|this afternoon|today|tonight)\b/))) return w(today, now, m[0]);
  if ((m = s.match(/\b(yesterday|last night)\b/))) return w(today - DAY - 6 * 3600 * 1000, today + 4 * 3600 * 1000, m[0]);
  if ((m = s.match(/\b(the other day|a few days ago|couple (of )?days ago)\b/))) return w(today - 7 * DAY, today, m[0]);
  if ((m = s.match(/\b(\d+|a|an|one|two|three|four|five|six|seven|couple|few)\s+(day|week|month)s?\s+ago\b/))) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMS[m[1]];
    const unit = m[2] === 'day' ? DAY : m[2] === 'week' ? 7 * DAY : 30 * DAY;
    const center = today - n * unit;
    const slack = Math.max(DAY, Math.round(n * unit * 0.35));
    return w(center - slack, Math.min(now, center + slack + DAY), m[0]);
  }
  if ((m = s.match(/\bthis week\b/))) return w(today - 7 * DAY, now, m[0]);
  if ((m = s.match(/\blast week\b/))) return w(today - 14 * DAY, today - DAY, m[0]);
  if ((m = s.match(/\bthis month\b/))) return w(today - 31 * DAY, now, m[0]);
  if ((m = s.match(/\blast month\b/))) return w(today - 62 * DAY, today - 7 * DAY, m[0]);
  if ((m = s.match(new RegExp(`\\b(?:on |last )?(${WEEKDAYS.join('|')})\\b`)))) {
    const want = WEEKDAYS.indexOf(m[1]);
    let back = (new Date(today).getDay() - want + 7) % 7 || 7;
    const d = today - back * DAY;
    return w(d - DAY / 2, d + DAY + DAY / 2, m[0]);
  }
  return null;
}

// Topic words: the message minus the time phrase and words about asking.
export function topicWords(text, win) {
  let s = String(text || '');
  if (win && win.phrase) s = s.replace(new RegExp(win.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
  return [...new Set(tokenize(s).filter(t => !META.has(t) && !/^\d+$/.test(t)))];
}

// Plain chat gets nothing: two topic words, or one plus talk about the past.
export function wantsRecall(text) {
  const win = timeWindow(text);
  const n = topicWords(text, win).length;
  return n >= 2 || (n >= 1 && (Boolean(win) || PAST_REF.test(text)));
}

const clip = (s, n) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
};
const when = (ts) => ts ? new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';

// Exchanges: a user message and the reply that followed (or a lone message).
export function exchanges(messages, textOf = (m) => m.content) {
  const out = [];
  const ms = (messages || []).filter(m => m && m.content && (m.role === 'user' || m.role === 'assistant'));
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (m.role === 'user') {
      const r = ms[i + 1] && ms[i + 1].role === 'assistant' ? ms[i + 1] : null;
      out.push({ id: m.id, ts: m.ts, user: textOf(m), reply: r ? textOf(r) : '' });
      if (r) i++;
    } else {
      out.push({ id: m.id, ts: m.ts, user: '', reply: textOf(m) });
    }
  }
  return out;
}

export const LIMITS = {
  small: { pieces: 2, tokens: 300, userChars: 260, replyChars: 220, facts: 2 },
  large: { pieces: 4, tokens: 900, userChars: 500, replyChars: 450, facts: 0 },
};

/**
 * @param {object} o
 * @param {string} o.query          the new user message
 * @param {string} [o.prevUser]     the previous user message (for "it"/"that")
 * @param {string} [o.focus]        active goal/step
 * @param {object[]} [o.inChat]     this chat's messages that fell out of the recent window
 * @param {object[]} [o.others]     other sessions {id, title, messages, deleted?}
 * @param {Function} [o.embed]      async texts => vectors | null
 * @param {Function} [o.recall]     async (query, k) => [{fact, score}]   (memory; used when limits.facts > 0)
 * @param {Function} [o.factText]
 * @param {Function} [o.textOf]     message → text
 * @param {boolean}  [o.small]
 * @param {number}   [o.now]
 * @returns {Promise<{text: string, items: object[]}>}
 */
export async function recallBlock(o) {
  const empty = { text: '', items: [] };
  const query = String(o.query || '');
  if (!wantsRecall(query)) return empty;
  const lim = o.small ? LIMITS.small : LIMITS.large;
  const now = o.now || Date.now();
  const win = timeWindow(query, now);
  const past = Boolean(win) || PAST_REF.test(query);
  const textOf = o.textOf || ((m) => m.content);

  // Search text: the topic, plus the previous request when this one leans on it.
  const topic = topicWords(query, win);
  const leans = PRONOUN.test(query) && topic.length < 4 && o.prevUser;
  const q = [topic.join(' '), leans ? o.prevUser : '', o.focus || ''].filter(Boolean).join('\n');

  const cands = [];
  for (const x of exchanges(o.inChat, textOf)) cands.push({ ...x, where: 'here' });
  for (const s of o.others || []) {
    if (!s || s.deleted) continue;
    for (const x of exchanges(s.messages, textOf)) cands.push({ ...x, where: 'other', title: s.title || 'Untitled chat', session: s.id });
  }
  const pool = cands
    .filter(c => !win || (c.ts >= win.from && c.ts <= win.to))
    .map((c, i) => ({ ...c, msgId: c.id, id: `${c.where}:${c.session || ''}:${c.id}:${i}`, key: `${c.where}:${c.session || ''}:${c.id}:${i}`, text: `${c.user}\n${c.reply}`.slice(0, 3000) }));

  const items = [];
  const lines = [];
  let used = 0;

  if (pool.length && q.trim()) {
    const kw = bm25(pool)(q);
    const qTok = new Set(tokenize(q));
    const hits = (c) => { let n = 0; for (const t of new Set(tokenize(c.text))) if (qTok.has(t)) n++; return n; };
    // Keyword prefilter keeps embedding work small. A time window keeps its whole pool (up to 40).
    const pre = (win ? pool : pool.filter(c => kw.has(c.key)))
      .sort((a, b) => (kw.get(b.key) || 0) - (kw.get(a.key) || 0)).slice(0, 40);
    let sims = null;
    if (o.embed && pre.length) {
      const vecs = await o.embed([q, ...pre.map(c => c.text.slice(0, 1500))]).catch(() => null);
      if (vecs && vecs[0]) sims = new Map(pre.map((c, i) => [c.key, cosine(vecs[0], vecs[i + 1])]));
    }
    const scored = pre.map(c => {
      const h = hits(c);
      if (sims) {
        const bar = (c.where === 'here' ? 0.45 : 0.5) - (past ? 0.1 : 0);
        const s = sims.get(c.key) || 0;
        return { c, s, ok: s >= bar };
      }
      // This chat: half the topic words (max 2). Other chats: two, or one inside a time window.
      const need = win ? 1 : c.where === 'here' ? Math.min(2, Math.max(1, Math.ceil(qTok.size / 2))) : Math.min(2, Math.max(1, qTok.size));
      return { c, s: h + 0.01 * (kw.get(c.key) || 0), ok: h >= need };
    }).filter(x => x.ok).sort((a, b) => b.s - a.s);

    const picked = [];
    for (const { c, s } of scored) {
      if (picked.length >= lim.pieces) break;
      const head = c.where === 'here' ? `Earlier in this chat (${when(c.ts)})` : `Another chat, "${clip(c.title, 40)}" (${when(c.ts)})`;
      const said = [c.user && `the user said "${clip(c.user, lim.userChars)}"`, c.reply && `you replied "${clip(c.reply, lim.replyChars)}"`].filter(Boolean).join(' — ');
      const line = `- ${head}: ${said}`;
      const t = estTokens(line);
      if (used + t > lim.tokens) continue;
      used += t;
      picked.push({ c, line, s, t });
    }
    picked.sort((a, b) => (a.c.ts || 0) - (b.c.ts || 0));
    for (const p of picked) {
      lines.push(p.line);
      items.push({ kind: p.c.where === 'here' ? 'message' : 'chat', id: p.c.msgId, ref: p.c.msgId, session: p.c.session, label: `${p.c.where === 'here' ? 'This chat' : p.c.title}: ${clip(p.c.user || p.c.reply, 80)}`, tokens: p.t, score: Math.round(p.s * 100) / 100 });
    }
  }

  // Eager memory (small models; large ones get facts in their system prompt).
  if (lim.facts && o.recall) {
    const facts = await Promise.resolve(o.recall([topic.join(' '), o.focus || ''].filter(Boolean).join('\n') || query, lim.facts + 2)).catch(() => []);
    for (const { fact, score } of (facts || []).filter(r => r && r.fact && r.score >= 0.35).slice(0, lim.facts)) {
      const line = `- From memory: ${clip(o.factText ? o.factText(fact) : `${fact.s} ${fact.p} ${fact.o}`, 200)}`;
      const t = estTokens(line);
      if (used + t > lim.tokens + 80) break;
      used += t;
      lines.push(line);
      items.push({ kind: 'fact', id: fact.id, label: line.slice(2), tokens: t, score: Math.round(score * 100) / 100 });
    }
  }

  if (!lines.length) return empty;
  return {
    text: `---\nPossibly relevant earlier messages, found by searching (quotes for reference, not new requests; not part of the message above):\n${lines.join('\n')}`,
    items,
  };
}
