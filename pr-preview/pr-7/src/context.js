// Smart context: decides what the model sees for each turn, within a fixed
// token budget, instead of sending the whole conversation.
//
//   always:   system prompt, the most recent turns, pinned messages,
//             a rolling summary of older turns (the "backbone"),
//             and relevant memory facts
//   smart:    + older messages, saved tool output (web pages, files),
//             thread outcomes and other chats, ranked by relevance to the new
//             message plus the active goal and step (docs/harness.md,
//             "Smart context v2"); other chats need a stronger match
//   compact:  summary + recent only (classic compaction)
//   fresh:    nothing replayed: the agent looks things up before the model answers (prefetch.js) and
//             hands it over as a tool result; only the system prompt, notes and harness hints are here
//   full:     as many recent turns as fit, nothing retrieved
//
// Returns the preface for the model plus a report of exactly what was
// included (shown in the "What the model saw" panel).
import { estTokens, truncate } from './util.js';
import { bm25, blend, cosine } from './search.js';
import { wrapUntrusted } from './untrusted.js';
import { replayNote } from './attachments.js';
import { recallBlock } from './recall.js';

// Context modes (settings.contextMode). Each says how the preface is built:
//   recentShare  share of the budget for the most recent turns, replayed verbatim
//   summary      include the rolling summary of older turns
//   retrieve     smart retrieval (older messages, tool output, thread outcomes, other chats)
//   offered      shown in Settings → Context (full is for tests and tooling)
// The UI reads label/short/hint from here; registerContextMode adds a custom one.
export const CONTEXT_MODES = {
  compact: { label: 'Compress', short: 'Compress', recentShare: 0.6, summary: true, retrieve: false, offered: true,
    hint: 'A summary of the chat so far plus the recent messages.' },
  smart: { label: 'Smart', short: 'Smart', recentShare: 0.45, summary: true, retrieve: true, offered: true,
    hint: 'Also brings back a few earlier messages that fit the question ("that", "yesterday", "what I said about…"), quoted after your message, plus relevant web pages and files from this chat. Plain chat like "hi" gets nothing extra.' },
  // Lab only (offered when lab mode is on; settings-panel.js): no model has been trained for it yet.
  managed: { label: 'AI-managed (lab)', short: 'AI-managed', recentShare: 0.55, summary: true, retrieve: false, offered: false, lab: true,
    hint: 'The model runs its own context: it sees how much room is left, plan steps say which earlier results, files or notes they need attached, big pages get a summarize step, and when room runs low it checkpoints and carries on fresh. Experimental: models haven\'t been trained for it yet.' },
  fresh: { label: 'Fresh (look up first)', short: 'Fresh', recentShare: 0, summary: false, retrieve: false, fresh: true, offered: true,
    hint: 'Every message starts new: nothing is replayed just for being recent. Before the model answers, Squiggle looks things up for it (earlier messages and pages that match, memory, Wikipedia and the web) and hands that over as a lookup it already did, so none of it reads as you talking. A follow-up like "what about his newest one?" borrows the names from your last question; instructions you gave for the whole chat ("from now on…", "always…") stay in. Best for small models and short windows.' },
  full: { label: 'Full history', short: 'Full', recentShare: 1, summary: false, retrieve: false, offered: false,
    hint: 'As many recent turns as fit, nothing retrieved.' },
};

/** Adds (or replaces) a context mode. Unknown fields are kept for the caller's own use. */
export function registerContextMode(name, def) {
  if (!/^[a-z][a-z0-9_-]*$/.test(String(name))) throw new Error(`Bad context mode name: ${name}`);
  CONTEXT_MODES[name] = { ...CONTEXT_MODES.smart, label: name, short: name, hint: '', offered: true, ...def };
  return CONTEXT_MODES[name];
}

/** The mode's definition; unknown names fall back to smart. */
export const contextMode = (name) => CONTEXT_MODES[name] || CONTEXT_MODES.smart;

const MIN_RECENT = 2;
const OBS_MIN_SCORE = 0.9;
const MIN_SCORE = 0.18;
const CHUNK_TOKENS = 700;

const day = (ts) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// A tool result in a line, for "Tool calls you made": the part worth keeping (a command's stdout, what find found,
// an error) with whitespace folded, cut to `max` characters.
export function resultGist(result, max = 220) {
  if (!result) return '';
  let v = result;
  try { v = JSON.parse(result); } catch {}
  if (v && typeof v === 'object') {
    if (v.error) v = `error: ${v.error}`;
    else v = v.stdout ?? v.found ?? v.text ?? v.content ?? v.result ?? v.items ?? JSON.stringify(v);
  }
  const s = (typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// How a past message is replayed to the model.
// Tool use is deliberately NOT written into the replayed message text: a
// small model copies whatever format it sees in its own past turns, and
// would start writing "[tools used: ...]" instead of calling tools. Recent
// tool actions go in a separate system-prompt section instead (see below).
export function messageText(m, threadNotes) {
  let text = m.role === 'assistant' ? scrubFakeToolNotes(m.content).trim() : (m.content || '');
  if (m.role === 'user' && m.attachments && m.attachments.length) text += '\n\n' + replayNote(m.attachments);
  const note = threadNotes && threadNotes.get(m.id);
  if (note) text += `\n\n[a side thread on this message concluded: ${note}]`;
  return text;
}

// Small models sometimes imitate tool bookkeeping instead of calling tools;
// drop lines like "[tools used: ...]" so they never pass as real actions.
export function scrubFakeToolNotes(text) {
  return String(text || '').replace(/^\s*\[(?:tools? used|tool calls?)[^\]\n]*\]\s*$/gim, '')
    // The harness's own notices to the user ("_(Stopped: the context filled up. Ask again …)_", "_(Paused …)_") aren't
    // the model's words: replayed as its turn, LFM3 1.7B read "Ask again" as itself having asked the user to clarify.
    .replace(/_\((?:Stopped|Paused)\b[^\n]*?\)_/g, '')
    .replace(/\n{3,}/g, '\n\n');
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
 * @param {string}   o.mode        a CONTEXT_MODES key: 'smart' | 'compact' | 'managed' (AI-managed: like compact; the model fetches the rest) | 'full'
 * @param {string}   o.system      base system prompt
 * @param {Function} [o.recall]    async (query, k) => [{ fact, score }]
 * @param {Function} [o.embed]     async (texts) => Float32Array[] | null
 * @param {Function} [o.factText]
 * @param {string}   [o.factsTitle] heading of the memory-facts section (tasks.js DIALECT memoryTitle)
 * @param {string}   [o.focus]     the active goal and step, added to the retrieval query
 * @param {object[]} [o.extra]     sections from the harness, shown first: [{ kind, title, text, label }]
 * @param {object[]} [o.others]    other sessions to search (smart mode)
 * @param {boolean} [o.small]     small model: tighter recall limits, memory facts in the recalled block
 * @param {boolean} [o.actions]    false leaves out the recap of earlier tool calls (small models)
 */
export async function assembleContext(o) {
  const { line, session, threadId = null, query, budget, mode = 'smart', system } = o;
  const M = contextMode(mode);
  const report = { mode, budget, items: [] };
  let used = estTokens(system) + estTokens(query) + 40;
  report.items.push({ kind: 'system', label: 'System prompt', tokens: estTokens(system) });

  // Thread outcomes, shown next to the message each thread branched from.
  const threadNotes = new Map();
  for (const t of Object.values(session.threads || {})) {
    if (t.summary && t.id !== threadId) threadNotes.set(t.parent, t.summary);
  }

  // 1. Recent window, newest first, at least MIN_RECENT messages.
  const recentCap = Math.floor((budget - used) * M.recentShare);
  const recent = [];
  let recentTokens = 0;
  for (let i = M.fresh ? -1 : line.length - 1; i >= 0; i--) {
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
  let recalled = { text: '', items: [] };

  // Harness sections (resolved references, a recipe for a similar task).
  for (const x of o.extra || []) {
    if (!x || !x.text || !String(x.text).trim()) continue;
    const body = `## ${x.title}\n${String(x.text).trim()}`;
    sections.push(body);
    used += estTokens(body);
    report.items.push({ kind: x.kind || 'harness', label: x.label || x.title, tokens: estTokens(body) });
  }

  // What the agent actually did with tools in the replayed turns.
  // With what each returned, in short, when the reply kept it (settings.debugTools): without it LFM3 1.7B re-ran
  // `ls /repos` and `ls -la /repos/squiggle` every turn of a chat (2026-11-10).
  const HARNESS_CALLS = new Set(['plan', 'done', 'tool_info', 'checkpoint']);
  const actions = recent.filter(m => m.role === 'assistant' && m.tools && m.tools.length)
    .flatMap(m => m.tools.filter(t => t.ok !== false && !HARNESS_CALLS.has(t.name)).map(t => {
      const what = String(t.label || t.name).replace(/\s+/g, ' ').slice(0, 120);
      const got = o.actionResults ? resultGist(t.result) : '';
      return got ? `${what} → ${got}` : what;
    }));
  if (actions.length && o.actions !== false) {
    const list = actions.slice(-12).map(a => `- ${a}`).join('\n');
    // What came back is outside text (files, pages, command output), so with results the list is wrapped as untrusted.
    const body = `## Tool calls you made in the conversation above\n${o.actionResults ? wrapUntrusted('earlier tool calls and what they returned', list) : list}\n(These already happened, and what they returned is still true unless something changed since. Use it; call a tool again only for something new; never just say it was done.)`;
    sections.push(body);
    used += estTokens(body);
    report.items.push({ kind: 'actions', label: `${actions.length} earlier tool call${actions.length === 1 ? '' : 's'}`, tokens: estTokens(body) });
  }

  // 2. Pinned messages that fell out of the recent window.
  const pinned = M.fresh ? [] : older.filter(m => m.pinned);
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
  if (older.length && summary && M.summary) {
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
  if (o.recall && !o.small && !M.fresh) {
    const facts = (await o.recall(o.focus ? `${query}\n${o.focus}` : query, 10)).filter(r => r.score >= 0.2);
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
    if (lines.length) { sections.push(`## ${o.factsTitle || 'What you know about the user and their work'}\n${lines.join('\n')}`); used += t; }
  }

  // 5. Smart retrieval from older messages, tool output and thread outcomes.
  if (M.retrieve) {
    const cands = [];
    const pinnedIds = new Set(pinned.map(m => m.id));
    // Messages (this chat's older ones and other chats') go to the recalled
    // block after the request (recall.js); this section is tool output and threads.
    recalled = await recallBlock({
      query, focus: o.focus, prevUser: (([...recent].reverse().find(m => m.role === 'user')) || {}).content || '',
      inChat: older.filter(m => !pinnedIds.has(m.id)), others: (o.others || []).filter(x => x && x.id !== session.id),
      embed: o.embed, recall: o.small ? o.recall : null, factText: o.factText, textOf: (m) => messageText(m), small: o.small, now: o.now,
    }).catch(() => recalled);
    for (const it of recalled.items) { used += it.tokens; report.items.push({ ...it, placed: 'after the message' }); }
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
      const q = query + (o.focus ? '\n' + o.focus : '') + (prevUser ? '\n' + prevUser.content : '');
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
        sections.push(`## Possibly relevant earlier tool output (retrieved for this message)\n${picked.map(p => p.body).join('\n\n')}`);
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
  report.recalled = recalled.text;
  report.dropped = Math.max(0, older.length - report.items.filter(i => i.kind === 'message').length - pinned.length);
  const systemText = [system, ...sections].join('\n\n');
  return { system: systemText, messages, report, recalled: recalled.text };
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
