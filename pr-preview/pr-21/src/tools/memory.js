// Memory tools: lasting facts (memory.js) and past conversations (sessions.js).
import * as memory from '../memory.js';
import * as sessions from '../sessions.js';
import { wrapUntrusted } from '../untrusted.js';
import { bm25 } from '../search.js';
import { truncate } from '../util.js';
import { defineTool, params, str, oneOf } from './registry.js';

export const remember = defineTool({
  name: 'remember',
  group: 'memory',
  description: 'Save something to remember, in one sentence about the user ("The user likes short answers", not "I like…"): a fact about them or their projects (preferences, decisions, names, how things work). "everywhere" (the default) keeps it for every chat; "this chat" keeps it only here.',
  parameters: params({ fact: str('What to remember, e.g. "Keal prefers short answers"'), scope: oneOf(['everywhere', 'this chat'], 'everywhere (default) or this chat') }),   // fact isn't required so the fine-tunes' triple call gets through
  // The two fine-tunes learned the old subject/relation/object call; it still works.
  async run({ fact, scope, subject, relation, object, note }, ctx = {}) {
    let text = String(fact || [subject, relation, object].filter(Boolean).join(' ')).trim();
    // Models copy the user's "I like…" (Keal's iPhone, 2026-11-16); read in another chat, "I" would be the assistant.
    if (fact && /^(i|i'm|i've|i'd|my|me)\b/i.test(text)) text = `The user says: ${text}`;
    if (!text) return { model: { error: 'Give the fact to remember, in one sentence.' } };
    if (scope === 'this chat') {
      if (!ctx.session) return { model: { error: 'No chat to remember it in.' } };
      const n = sessions.setNote(ctx.session, null, text.slice(0, 1500));
      return { model: { ok: true, id: n.id, scope }, label: `remembered for this chat: ${truncate(text, 60)}` };
    }
    const f = fact ? memory.add({ text, note, source: { session: ctx.session && ctx.session.id } })
      : memory.add({ s: subject, p: relation, o: object, note, source: { session: ctx.session && ctx.session.id } });
    return { model: { ok: true, id: f.id }, label: `remembered: ${truncate(text, 60)}` };
  },
});

export const recall = defineTool({
  name: 'recall',
  group: 'memory',
  description: 'Search saved memory facts.',
  parameters: params({ query: str('What to look for') }, ['query']),
  async run({ query }) {
    const r = await memory.recall(query, 12);
    return { model: { facts: r.map(({ fact }) => ({ id: fact.id, fact: memory.factText(fact) })) }, label: `recalled "${query}"` };
  },
});

export const forget = defineTool({
  name: 'forget',
  group: 'memory',
  description: 'Delete a saved memory fact by id (when the user says it is wrong or outdated).',
  parameters: params({ id: str('Fact id from recall') }, ['id']),
  async run({ id }) {
    return memory.remove(id) ? { model: { ok: true }, label: 'forgot a fact' } : { model: { error: 'No fact with that id.' } };
  },
});

export const searchHistory = defineTool({
  name: 'search_history',
  group: 'memory',
  description: 'Search the user\'s past conversations (all sessions) for something discussed before. Each result has session_id, message_id and link, a markdown link that opens that chat: to point the user at it, put the link in your reply exactly as shown.',
  parameters: params({ query: str('What to look for') }, ['query']),
  async run({ query }, ctx) {
    const docs = [];
    for (const s of sessions.list()) {
      for (const m of s.messages) if (m.content) docs.push({ id: `${s.id}|${m.id}`, text: m.content, s, m });
      // Attached documents are searchable too (their text is outside content).
      for (const o of s.observations || []) if (o.source === 'attachment') docs.push({ id: `${s.id}|${o.id}`, text: o.title + '\n' + o.text, s, o });
    }
    const scores = bm25(docs)(query);
    const top = docs.filter(d => scores.has(d.id)).sort((a, b) => scores.get(b.id) - scores.get(a.id)).slice(0, 6);
    // Ids so a result can be opened or quoted later; the link is ui/links.js's #chat=<id> (] would break its text).
    const ids = (d) => ({ session_id: d.s.id, message_id: (d.m || d.o).id, link: `[${String(d.s.title || '').replace(/[[\]\n]/g, ' ').trim() || 'Untitled chat'}](#chat=${d.s.id})` });
    return {
      model: { results: top.map(d => d.o
        ? { session: d.s.title, ...ids(d), when: new Date(d.o.ts).toISOString().slice(0, 10), role: 'attachment', file: d.o.title, text: wrapUntrusted('attachment ' + d.o.title, d.o.text), this_session: d.s.id === ctx.session.id }
        : { session: d.s.title, ...ids(d), when: new Date(d.m.ts).toISOString().slice(0, 10), role: d.m.role, text: d.m.content, this_session: d.s.id === ctx.session.id }) },
      label: `searched history for "${query}"`,
    };
  },
});
