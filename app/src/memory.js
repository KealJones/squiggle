// Learned memory: a small graph of facts about the person and their projects,
// stored one fact per line in memory/facts.jsonl in the storage repo (so
// devices merge cleanly), held in memory while the app runs.
//
// A fact is a subject → relation → object edge, e.g.
//   { s: 'Keal', p: 'prefers', o: 'no approval prompts for pushes' }
//   { s: 'squiggle', p: 'stores sessions in', o: 'a private GitHub repo' }
// Entities are the subjects/objects; recall walks one hop from matching facts.
import * as storage from './storage.js';
import { uid, emitter } from './util.js';
import { parseJsonl, toJsonl } from './merge.js';
import { bm25, blend, cosine } from './search.js';
import { embed } from './embed.js';

const FILE = 'memory/facts.jsonl';
const TOMBSTONE_TTL = 90 * 24 * 3600 * 1000;
export const events = emitter();
let facts = [];
let saveTimer = null;

export async function load() {
  facts = parseJsonl(await storage.read(FILE));
  events.emit('change');
}

export const all = () => facts.filter(f => !f.deleted);
export const factText = (f) => `${f.s} ${f.p} ${f.o}${f.note ? ` (${f.note})` : ''}`;
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const key = (f) => `${norm(f.s)}|${norm(f.p)}|${norm(f.o)}`;

export function add({ s, p, o, note, source, auto = false }) {
  if (!s || !p || !o) throw new Error('A fact needs a subject, a relation and an object.');
  const now = Date.now();
  const k = key({ s, p, o });
  const existing = facts.find(f => key(f) === k);
  if (existing) {
    Object.assign(existing, { deleted: false, mts: now, note: note || existing.note });
    if (!auto) existing.auto = false; // confirmed by an explicit remember
    save();
    return existing;
  }
  const f = { id: uid('f'), s: String(s).trim(), p: String(p).trim(), o: String(o).trim(), ts: now, mts: now, auto };
  if (note) f.note = String(note).trim();
  if (source) f.source = source;
  facts.push(f);
  save();
  return f;
}

export function update(id, patch) {
  const f = facts.find(x => x.id === id);
  if (!f) return null;
  Object.assign(f, patch, { mts: Date.now() });
  save();
  return f;
}

export function remove(id) {
  return update(id, { deleted: true });
}

function save() {
  events.emit('change');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const cutoff = Date.now() - TOMBSTONE_TTL;
    facts = facts.filter(f => !(f.deleted && (f.mts || 0) < cutoff));
    await storage.write(FILE, toJsonl(facts));
    storage.sync();
  }, 1200);
}

// Called after a sync brought a new facts file in.
export async function reload(paths) {
  if (paths.includes('*') || paths.includes(FILE)) await load();
}

// Facts relevant to `query`, best first: keyword + semantic match, then one
// hop through shared entities (a fact about "squiggle" pulls in other facts
// whose subject or object is "squiggle", at a discount).
export async function recall(query, k = 8) {
  const live = all();
  if (!live.length || !String(query || '').trim()) return [];
  const docs = live.map(f => ({ id: f.id, text: factText(f) }));
  const kw = bm25(docs)(query);
  let sem = null;
  const vecs = await embed([query, ...docs.map(d => d.text)]).catch(() => null);
  if (vecs) {
    sem = new Map();
    docs.forEach((d, i) => sem.set(d.id, cosine(vecs[0], vecs[i + 1])));
  }
  const score = blend(kw, sem);
  const byId = new Map(live.map(f => [f.id, f]));
  const top = [...score.entries()].filter(([, s]) => s > 0.2).sort((a, b) => b[1] - a[1]).slice(0, k);
  const result = new Map(top);
  for (const [id, s] of top) {
    const f = byId.get(id);
    for (const g of live) {
      if (result.has(g.id)) continue;
      const shares = [g.s, g.o].some(e => norm(e) === norm(f.s) || norm(e) === norm(f.o));
      if (shares) result.set(g.id, Math.max(result.get(g.id) || 0, s * 0.5));
    }
  }
  return [...result.entries()].sort((a, b) => b[1] - a[1]).slice(0, k)
    .map(([id, s]) => ({ fact: byId.get(id), score: s }));
}

// Entity -> facts, for the memory panel's graph view.
export function entities() {
  const map = new Map();
  for (const f of all()) {
    for (const e of [f.s, f.o]) {
      const n = norm(e);
      if (!map.has(n)) map.set(n, { name: e, facts: [] });
      map.get(n).facts.push(f);
    }
  }
  return [...map.values()].sort((a, b) => b.facts.length - a.facts.length);
}
