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
import { cosine } from './search.js';
import { rankFacts, aboutTheUser, factText } from './memory-rank.js';
export { rankFacts, aboutTheUser, factText };
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
  saveTimer = setTimeout(flush, 1200);
}

// Writes the facts now (saves are otherwise debounced). A `load` before a pending save would read the old
// file and the save would then write the reloaded list: callers that load right after adding (demo.js) flush.
export async function flush() {
  clearTimeout(saveTimer);
  const cutoff = Date.now() - TOMBSTONE_TTL;
  facts = facts.filter(f => !(f.deleted && (f.mts || 0) < cutoff));
  await storage.write(FILE, toJsonl(facts));
  storage.sync();
}

// Called after a sync brought a new facts file in.
export async function reload(paths) {
  if (paths.includes('*') || paths.includes(FILE)) await load();
}

// Facts relevant to `query`, best first, each with a 0..1 score. The score is absolute (search.js overlap:
// how much of the fact the query covers), not relative to the best match: when nothing fits, nothing
// scores, instead of the least unrelated fact scoring 1 and dragging its neighbours in. With embeddings,
// the semantic similarity is blended in. Then one hop through a shared entity, at half the score, but
// only through a specific one: "user", "Squiggle" or the person's name sit on most facts and linked every
// fact to every other (a request about a movie got "user considers using SQLite" that way).
export async function recall(query, k = 8) {
  const live = all();
  if (!live.length || !String(query || '').trim()) return [];
  let sem = null;
  const vecs = await embed([query, ...live.map(f => factText(f))]).catch(() => null);
  if (vecs) {
    sem = new Map();
    live.forEach((f, i) => sem.set(f.id, cosine(vecs[0], vecs[i + 1])));
  }
  return rankFacts(live, query, { sem, k });
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
