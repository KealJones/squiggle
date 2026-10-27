// Smart context: decides what the model sees for each turn, within a fixed
// token budget, instead of sending the whole conversation.
//
//   always:   system prompt, the most recent turns, pinned messages,
//             a rolling summary of older turns (the "backbone"),
//             and relevant memory facts
//   smart:    + older messages, saved tool output (web pages, files) and
//             thread outcomes, ranked by relevance to the new message
//   compact:  summary + recent only (classic compaction)
//   full:     as many recent turns as fit, nothing retrieved
//
// Returns the preface for the model plus a report of exactly what was
// included (shown in the "What the model saw" panel).
import { estTokens, truncate } from './util.js';
import { bm25, blend, cosine } from './search.js';
import { wrapUntrusted } from './untrusted.js';

const RECENT_SHARE = { smart: 0.45, compact: 0.6, full: 1 };
const MIN_RECENT = 2;
const OBS_MIN_SCORE = 0.9;
const MIN_SCORE = 0.18;
const CHUNK_TOKENS = 700;

const day = (ts) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// How a past message is replayed to the model.
// Tool use is deliberately NOT written into the replayed message text: a
// small model copies whatever format it sees in its own past turns, and
// would start writing "[tools used: ...]" instead of calling tools. Recent
// tool actions go in a separate system-prompt section instead (see below).
export function messageText(m, threadNotes) {
  let text = m.role === 'assistant' ? scrubFakeToolNotes(m.content).trim() : (m.content || '');
  const note = threadNotes && threadNotes.get(m.id);
  if (note) text += `\n\n[a side thread on this message concluded: ${note}]`;
  return text;
}

// Small models sometimes imitate tool bookkeeping instead of calling tools;
// drop lines like "[tools used: ...]" so they never pass as real actions.
export function scrubFakeToolNotes(text) {
  return String(text || '').replace(/^\s*\[(?:tools? used|tool calls?)[^\]\n]*\]\s*$/gim, '').replace(/\n{3,}/g, '\n\n');
}

// Split long text into ~CHUNK_TOKENS pieces on paragraph boundaries.
export function chunk(text, maxTokens = CHUNK_TOKENS) {
  const paras = String(text || '').split(/\n{2,}/);
  const out = [];
  let cur = '';
  for (const p of paras) {
    if (cur && estTokens(cur + '\n\n' + p) > maxTokens) { out.push(cur); cur = ''; }
    if (estTokens(p) > maxTokens) {
      for (let i = 0; i < p.length; i += maxTokens * 3) out.push(p.slice(i, i + maxTokens * 3));
    } else {
      cur = cur ? cur + '\n\n' + p : p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * @param {object} o
 * @param {object[]} o.line        messages in this conversation line, oldest first (see sessions.lineMessages)
 * @param {object}   o.session     the session (observations, summaries, threads)
 * @param {string|null} o.threadId
 * @param {string}   o.query       the new user message
 * @param {number}   o.budget      tokens available for the preface (system + history)
 * @param {string}   o.mode        'smart' | 'compact' | 'full'
 * @param {string}   o.system      base system prompt
 * @param {Function} [o.recall]    async (query, k) => [{ fact, score }]
 * @param {Function} [o.embed]     async (texts) => Float32Array[] | null
 * @param {Function} [o.factText]
 */
export async function assembleContext(o) {
  const { line, session, threadId = null, query, budget, mode = 'smart', system } = o;
  const report = { mode, budget, items: [] };
  let used = estTokens(system) + estTokens(query) + 40;
  report.items.push({ kind: 'system', label: 'System prompt', tokens: estTokens(system) });

  // Thread outcomes, shown next to the message each thread branched from.
  const threadNotes = new Map();
  for (const t of Object.values(session.threads || {})) {
    if (t.summary && t.id !== threadId) threadNotes.set(t.parent, t.summary);
  }

  // 1. Recent window, newest first, at least MIN_RECENT messages.
  const recentCap = Math.floor((budget - used) * (RECENT_SHARE[mode] || 0.45));
  const recent = [];
  let recentTokens = 0;
  for (let i = line.length - 1; i >= 0; i--) {
    const t = estTokens(messageText(line[i], threadNotes)) + 8;
    if (recent.length >= MIN_RECENT && recentTokens + t > recentCap) break;
    recent.unshift(line[i]);
    recentTokens += t;
  }
  // Never start the replay mid-exchange on an assistant message.
  while (recent.length > 1 && recent[0].role !== 'user' && recentTokens > recentCap) {
    recentTokens -= estTokens(messageText(recent[0], threadNotes)) + 8;
    recent.shift();
  }
  used += recentTokens;
  const recentIds = new Set(recent.map(m => m.id));
  const older = line.filter(m => !recentIds.has(m.id));
  if (recent.length) report.items.push({ kind: 'recent', label: `Last ${recent.length} message${recent.length === 1 ? '' : 's'}`, tokens: recentTokens, ids: [...recentIds] });

  const sections = [];

  // What the agent actually did with tools in the replayed turns.
  const actions = recent.filter(m => m.role === 'assistant' && m.tools && m.tools.length)
    .flatMap(m => m.tools.filter(t => t.ok !== false).map(t => t.label || t.name));
  if (actions.length) {
    const body = `## Tool calls you made in the conversation above\n${actions.slice(-12).map(a => `- ${truncate(a, 160)}`).join('\n')}\n(These already happened. To do anything new, call the tool again; never just say it was done.)`;
    sections.push(body);
    used += estTokens(body);
    report.items.push({ kind: 'actions', label: `${actions.length} earlier tool call${actions.length === 1 ? '' : 's'}`, tokens: estTokens(body) });
  }

  // 2. Pinned messages that fell out of the recent window.
  const pinned = older.filter(m => m.pinned);
  if (pinned.length) {
    const body = pinned.map(m => `- (${m.role}, ${day(m.ts)}) ${truncate(messageText(m), 1200)}`).join('\n');
    const t = estTokens(body);
    if (used + t < budget) {
      sections.push(`## Pinned by the user\n${body}`);
      used += t;
      for (const m of pinned) report.items.push({ kind: 'pinned', id: m.id, label: snippet(m.content), tokens: estTokens(messageText(m)) });
    }
  }

  // 3. Rolling summary of what's no longer in the window.
  const summary = pickSummary(session, threadId, line);
  if (older.length && summary && mode !== 'full') {
    const body = `## Earlier in this conversation (summary)\n${summary.text}`;
    const t = estTokens(body);
    if (used + t < budget) {
      sections.push(body);
      used += t;
      report.items.push({ kind: 'summary', label: 'Summary of earlier messages', tokens: t });
    }
  }

  // 3b. The agent's own notepad for this chat (all modes): what it decided
  // matters. Kept whole when it fits; otherwise the newest notes.
  const notes = Object.values(session.notes || {}).filter(n => !n.deleted).sort((a, b) => a.ts - b.ts);
  if (notes.length) {
    const cap = Math.floor(budget * 0.25);
    const lines = [];
    let t = 0;
    for (const n of [...notes].reverse()) {
      const ln = `- [${n.id}] ${n.text}`;
      const lt = estTokens(ln);
      if (t + lt > cap) break;
      lines.unshift(ln); t += lt;
      report.items.push({ kind: 'note', id: n.id, label: n.text.slice(0, 80), tokens: lt });
    }
    if (lines.length) {
      sections.push(`## Your notes for this chat (update or delete with the note tool when they stop being relevant)\n${lines.join('\n')}${lines.length < notes.length ? `\n(${notes.length - lines.length} older notes not shown; delete ones you no longer need)` : ''}`);
      used += t;
    }
  }

  // 4. Memory facts (all modes; they're small and about the person).
  if (o.recall) {
    const facts = (await o.recall(query, 10)).filter(r => r.score >= 0.25);
    const cap = Math.floor(budget * 0.12);
    const lines = [];
    let t = 0;
    for (const { fact, score } of facts) {
      const ln = `- ${o.factText ? o.factText(fact) : `${fact.s} ${fact.p} ${fact.o}`}`;
      const lt = estTokens(ln);
      if (t + lt > cap || used + t + lt > budget) break;
      lines.push(ln); t += lt;
      report.items.push({ kind: 'fact', id: fact.id, label: ln.slice(2), tokens: lt, score: round(score) });
    }
    if (lines.length) { sections.push(`## What you know about the user and their work\n${lines.join('\n')}`); used += t; }
  }

  // 5. Smart retrieval from older messages, tool output and thread outcomes.
  if (mode === 'smart') {
    const cands = [];
    const pinnedIds = new Set(pinned.map(m => m.id));
    for (const m of older) {
      if (pinnedIds.has(m.id) || !m.content) continue;
      cands.push({ id: 'm:' + m.id, kind: 'message', ts: m.ts, text: messageText(m), render: (x) => `(${m.role === 'user' ? 'user said' : 'you said'}, ${day(m.ts)}) ${x}`, label: snippet(m.content), ref: m.id });
    }
    const lineThread = (obs) => !obs.thread || obs.thread === threadId;
    for (const ob of (session.observations || []).filter(lineThread)) {
      chunk(ob.text).forEach((c, i) => cands.push({
        id: `o:${ob.id}:${i}`, kind: 'observation', ts: ob.ts, text: `${ob.title}\n${c}`,
        render: (x) => wrapUntrusted(ob.source, x), label: `${ob.source}: ${ob.title}`, ref: ob.id,
      }));
    }
    for (const t of Object.values(session.threads || {})) {
      if (t.summary && t.id !== threadId && !recentIds.has(t.parent)) {
        cands.push({ id: 't:' + t.id, kind: 'thread', ts: t.updated, text: `${t.title}\n${t.summary}`, render: (x) => `(side thread "${t.title}") ${x}`, label: `Thread: ${t.title}`, ref: t.id });
      }
    }
    if (cands.length) {
      const prevUser = [...recent].reverse().find(m => m.role === 'user');
      const q = query + (prevUser ? '\n' + prevUser.content : '');
      const kw = bm25(cands)(q);
      let sem = null;
      const vecs = o.embed ? await o.embed([q, ...cands.map(c => c.text)]).catch(() => null) : null;
      if (vecs) { sem = new Map(); cands.forEach((c, i) => sem.set(c.id, cosine(vecs[0], vecs[i + 1]))); }
      const scores = blend(kw, sem);
      const newest = Math.max(...cands.map(c => c.ts || 0));
      // Old tool output only comes back on a strong match. When the message
      // names a file, only output about that file qualifies (a README that
      // mentions tools.js is not "about" tools.js). Notes cover the rest.
      const named = [...String(query).matchAll(/[\w.-]+\.[a-z]{1,5}\b/gi)].map(m => m[0].toLowerCase()).filter(f => !/^\d/.test(f));
      const obsOk = (c, s) => c.kind !== 'observation' || (named.length
        ? named.some(f => c.label.toLowerCase().includes(f))
        : s >= OBS_MIN_SCORE);
      const ranked = cands
        .map(c => ({ c, s: (scores.get(c.id) || 0) + 0.05 * recency(c.ts, newest) }))
        .filter(x => x.s >= MIN_SCORE && obsOk(x.c, x.s))
        .sort((a, b) => b.s - a.s);
      const obsCap = Math.floor(budget * 0.25);
      let obsUsed = 0;
      const picked = [];
      for (const { c, s } of ranked) {
        const body = c.render(truncate(c.text, 4000));
        const t = estTokens(body) + 4;
        if (used + t > budget) continue;
        if (c.kind === 'observation') { if (obsUsed + t > obsCap) continue; obsUsed += t; }
        picked.push({ c, body, s });
        used += t;
        report.items.push({ kind: c.kind, id: c.id, ref: c.ref, label: c.label, tokens: t, score: round(s) });
      }
      if (picked.length) {
        picked.sort((a, b) => (a.c.ts || 0) - (b.c.ts || 0)); // chronological reads better
        sections.push(`## Possibly relevant earlier context (retrieved for this message)\n${picked.map(p => p.body).join('\n\n')}`);
      }
    }
  }

  // Replay recent messages as real turns. Merge same-role runs and make the
  // first turn a user turn, which Gemma's chat template expects.
  const messages = [];
  for (const m of recent) {
    const role = m.role === 'user' ? 'user' : 'model';
    const text = messageText(m, threadNotes);
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content += '\n\n' + text;
    else messages.push({ role, content: text });
  }
  if (messages.length && messages[0].role !== 'user') messages.unshift({ role: 'user', content: '(continuing our conversation)' });
  // The new message is sent next as a user turn, so history must end on the model.
  if (messages.length && messages[messages.length - 1].role === 'user') messages.push({ role: 'model', content: '(no reply)' });

  report.used = used;
  report.dropped = Math.max(0, older.length - report.items.filter(i => i.kind === 'message').length - pinned.length);
  const systemText = [system, ...sections].join('\n\n');
  return { system: systemText, messages, report };
}

function pickSummary(session, threadId, line) {
  const s = session.summaries || {};
  if (threadId && s[threadId]) return s[threadId];
  const main = s.main;
  if (!main) return null;
  // In a thread, the main summary only applies if it doesn't reach past the fork.
  return line.some(m => m.id === main.upTo) ? main : null;
}

const recency = (ts, newest) => Math.exp(-Math.max(0, newest - (ts || 0)) / (3 * 24 * 3600 * 1000));
const round = (x) => Math.round(x * 100) / 100;
const snippet = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 90);

// Messages the rolling summary should absorb: everything older than the last
// `keep` messages that the current summary doesn't already cover.
export function summaryBacklog(line, summary, keep = 6) {
  const cutoff = Math.max(0, line.length - keep);
  const start = summary ? line.findIndex(m => m.id === summary.upTo) + 1 : 0;
  return line.slice(start, cutoff);
}
