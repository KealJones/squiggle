// Keyword relevance (BM25) plus optional semantic similarity, used by smart
// context and memory recall. Pure functions (tests/search.test.js).

const STOP = new Set(('a an and are as at be but by for from has have i if in into is it its me my of on or our so ' +
  'that the their them then there these they this to us was we were what when where which who why will with you your ' +
  'do does did can could would should about just how also any all not no yes ok okay please thanks').split(' '));

export function tokenize(text) {
  return String(text || '').toLowerCase()
    .replace(/[`*_#>\[\](){}"',.;:!?<>|=+~^$%&@\\]/g, ' ')
    .split(/\s+/)
    .map(w => w.replace(/^[-/]+|[-/]+$/g, ''))
    .filter(w => w.length > 1 && !STOP.has(w))
    .map(stem);
}

// Light suffix stripping so "repos"/"repo", "pushing"/"push" match. A trailing e goes too, so "named"/"name"
// and "decided"/"decide" meet ("named" lost its e with the -ed and never matched "name": "What's my name?"
// found no memory, tests/eval/retrieval.mjs 2026-11-09).
function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

// docs: [{ id, text }] -> scorer(query) => Map(id -> score)
export function bm25(docs, { k1 = 1.4, b = 0.75 } = {}) {
  const toks = docs.map(d => tokenize(d.text));
  const avg = toks.reduce((n, t) => n + t.length, 0) / Math.max(1, toks.length);
  const df = new Map();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) || 0) + 1);
  const N = docs.length;
  const tf = toks.map(t => { const m = new Map(); for (const w of t) m.set(w, (m.get(w) || 0) + 1); return m; });
  return (query) => {
    const q = [...new Set(tokenize(query))];
    const scores = new Map();
    docs.forEach((d, i) => {
      let s = 0;
      for (const w of q) {
        const f = tf[i].get(w);
        if (!f) continue;
        const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
        s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * toks[i].length / (avg || 1)));
      }
      if (s > 0) scores.set(d.id, s);
    });
    return scores;
  };
}

// Relevance of short records (memory facts) to a query on an absolute 0..1 scale: the cosine between the
// two sets of content words, |shared| / sqrt(|record| · |query|). One shared word between a two-word fact
// and a three-word question is 0.41; one word out of eight in a long request against a four-word fact is
// 0.18; nothing shared is 0. Unlike bm25 + blend (which rank candidates against each other, so the best
// of a bad bunch still scores 1), a record with nothing in common with the query scores 0 whatever the
// others do. Words are unweighted on purpose: with a few dozen records, rarity statistics are noise.
// Words on most of the records (the user's name, "user", "squiggle") say nothing about which one fits
// and are left out on both sides; `generic` returns them, for callers that link records by shared entities.
// docs: [{ id, text }] -> { score(query) => Map(id -> 0..1), generic: Set(word) }
export function overlap(docs, { genericShare = 0.3, genericMin = 3 } = {}) {
  const toks = docs.map(d => [...new Set(tokenize(d.text))]);
  const N = docs.length;
  const df = new Map();
  for (const t of toks) for (const w of t) df.set(w, (df.get(w) || 0) + 1);
  const generic = new Set([...df].filter(([, n]) => n >= genericMin && n / N >= genericShare).map(([w]) => w));
  const kept = toks.map(t => t.filter(w => !generic.has(w)));
  return {
    generic,
    score(query) {
      const q = new Set(tokenize(query).filter(w => !generic.has(w)));
      const out = new Map();
      if (!q.size) return out;
      docs.forEach((d, i) => {
        if (!kept[i].length) return;
        const shared = kept[i].filter(w => q.has(w)).length;
        if (shared) out.set(d.id, shared / Math.sqrt(kept[i].length * q.size));
      });
      return out;
    },
  };
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na * nb) || 1);
}

// Blend keyword and semantic scores into one 0..1 relevance per id.
// `semantic` is an optional Map(id -> cosine). Keyword scores are normalized
// by the best match so the two scales are comparable.
// `absolute`: the keyword scores are already 0..1 (coverage) and are used as they are.
export function blend(keyword, semantic, { wKeyword = 0.45, wSemantic = 0.55, absolute = false } = {}) {
  const out = new Map();
  const maxK = absolute ? 1 : Math.max(0, ...keyword.values());
  const ids = new Set([...keyword.keys(), ...(semantic ? semantic.keys() : [])]);
  for (const id of ids) {
    const k = maxK ? (keyword.get(id) || 0) / maxK : 0;
    if (!semantic) { out.set(id, k); continue; }
    const s = Math.max(0, ((semantic.get(id) || 0) - 0.15) / 0.85); // MiniLM cosines below ~0.15 are noise
    out.set(id, wKeyword * k + wSemantic * s);
  }
  return out;
}
