// The pure parts of memory (no storage, so node tests can load them): how facts are ranked against a
// request, and which extracted facts are about the user at all. memory.js re-exports them.
import { overlap, blend, tokenize } from './search.js';

export const factText = (f) => `${f.s} ${f.p} ${f.o}${f.note ? ` (${f.note})` : ''}`;
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// The ranking behind recall, pure (tests): facts, the query, optional semantic scores by id.
export function rankFacts(live, query, { sem = null, k = 8 } = {}) {
  const docs = live.map(f => ({ id: f.id, text: factText(f) }));
  const cov = overlap(docs);
  const kw = cov.score(query);
  const score = blend(kw, sem, { absolute: true });
  const byId = new Map(live.map(f => [f.id, f]));
  const top = [...score.entries()].filter(([, s]) => s > 0.2).sort((a, b) => b[1] - a[1]).slice(0, k);
  const result = new Map(top);
  const specific = (e) => { const t = tokenize(e); return t.length > 0 && t.some(w => !cov.generic.has(w)); };
  for (const [id, s] of top) {
    const f = byId.get(id);
    for (const g of live) {
      if (result.has(g.id)) continue;
      const shares = [g.s, g.o].some(e => (norm(e) === norm(f.s) || norm(e) === norm(f.o)) && specific(e));
      if (shares) result.set(g.id, Math.max(result.get(g.id) || 0, s * 0.5));
    }
  }
  return [...result.entries()].sort((a, b) => b[1] - a[1]).slice(0, k)
    .map(([id, s]) => ({ fact: byId.get(id), score: s }));
}

// Memory holds what the user said about themselves and their world. A fact whose subject is the
// assistant itself ("Squiggle is a private AI agent", "Squiggle has_tool chat renaming") came from the
// system prompt or the assistant's own reply, not from the person, unless the user's message names what
// the fact says. (The user's project can also be called Squiggle, so the test is what they said, not the name.)
const SELF = /^(squiggle|the assistant|assistant|ai|the ai|you|model|the model|it)$/i;
export function aboutTheUser(f, userText) {
  if (!SELF.test(String(f.s || '').trim())) return true;
  const said = new Set(tokenize(userText));
  return tokenize(`${f.p} ${f.o}`).some(w => said.has(w));
}

