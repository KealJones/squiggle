// Memory tools: lasting facts (memory.js) and past conversations (sessions.js).
import * as memory from '../memory.js';
import * as sessions from '../sessions.js';
import { wrapUntrusted } from '../untrusted.js';
import { truncate } from '../util.js';
import { bm25 } from '../search.js';
import { defineTool, params, str } from './registry.js';
import { bestPart } from './workspace.js';

export const remember = defineTool({
  name: 'remember',
  group: 'memory',
  description: 'Save a lasting fact about the user or their projects (preferences, decisions, names, how things work). Saved as subject → relation → object.',
  parameters: params({ subject: str('Who/what, e.g. "Keal" or "squiggle"'), relation: str('e.g. "prefers", "uses", "is deployed on"'), object: str('the value'), note: str('optional detail') }, ['subject', 'relation', 'object']),
  async run({ subject, relation, object, note }, ctx) {
    const f = memory.add({ s: subject, p: relation, o: object, note, source: { session: ctx.session.id } });
    return { model: { ok: true, id: f.id }, label: `remembered: ${subject} ${relation} ${object}` };
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
  description: 'Search the user\'s past conversations (all sessions) for something discussed before.',
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
    return {
      model: { results: top.map(d => d.o
        ? { session: d.s.title, when: new Date(d.o.ts).toISOString().slice(0, 10), role: 'attachment', file: d.o.title, text: wrapUntrusted('attachment ' + d.o.title, bestPart(d.o.text, query)), this_session: d.s.id === ctx.session.id }
        : { session: d.s.title, when: new Date(d.m.ts).toISOString().slice(0, 10), role: d.m.role, text: truncate(d.m.content, 600), this_session: d.s.id === ctx.session.id }) },
      label: `searched history for "${query}"`,
    };
  },
});
