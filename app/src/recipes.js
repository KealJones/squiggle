// Recipes: how a task was solved, kept so the second time is fast
// (docs/harness.md, "Recipes"). Stored one JSON object per line in
// memory/recipes.jsonl in the storage repo, merged across devices by id like
// memory facts, held in memory while the app runs.
//
//   { id, title,            "Kill whatever is listening on a port"
//     when,                 what requests it fits, in plain words
//     examples?: [string],  phrasings of the request that led to it (matched too)
//     steps: [string],      the plan that worked, lightly generalised
//     specifics: [string],  "<placeholder> = value": paths, repos, branches, URLs, commands
//     uses, created, lastUsed, sessions: [sessionId], pinned?,
//     ts, mts, deleted? }   ts/mts/deleted are the same sync fields facts have
//
// Everything that needs the storage repo goes through `store` (lazy-loaded
// storage.js, replaceable with setStore) so the rest is plain data work that
// runs in node tests.
import { uid, emitter } from './util.js';
import { parseJsonl, toJsonl } from './merge.js';
import { bm25, tokenize, cosine } from './search.js';

const FILE = 'memory/recipes.jsonl';
const DAY = 24 * 3600 * 1000;
export const UNUSED_TTL = 90 * DAY;       // unpinned recipes unused this long are forgotten
const TOMBSTONE_TTL = 90 * DAY;
const MAX_EXAMPLES = 6;
const MAX_STEPS = 10;
const MAX_SPECIFICS = 12;

// Relevance bar for match(): a 0..1 score (see lexicalScore). 0.35 means
// roughly "at least a third of what the request is about, including part of the
// recipe's title, is in the recipe". STRONG is the score at which a match is
// worth putting in the prompt as the starting plan (the caller decides).
export const MIN_SCORE = 0.35;
export const STRONG = 0.6;

export const events = emitter();
let recipes = [];
let saveTimer = null;
let embedder = null;
let store = null;

export function setStore(s) { store = s; }
const getStore = async () => store || (store = await import('./storage.js'));

// fn(texts: string[]) => Promise<number[][] | null>, e.g. embed() from embed.js.
export function setEmbedder(fn) { embedder = typeof fn === 'function' ? fn : null; }

// ── Storage ──────────────────────────────────────────────────────────────

function normalize(r) {
  if (!r || typeof r !== 'object' || !r.id) return null;
  const arr = (x) => Array.isArray(x) ? x.map(String).filter(Boolean) : [];
  return {
    ...r,
    title: String(r.title || '').trim(),
    when: String(r.when || '').trim(),
    examples: arr(r.examples),
    steps: arr(r.steps),
    specifics: arr(r.specifics),
    sessions: arr(r.sessions),
    uses: Number(r.uses) || 0,
    created: r.created || r.ts || 0,
    lastUsed: r.lastUsed || 0,
  };
}

let savedAt = 0;   // when memory and the file last matched

export async function load() {
  const s = await getStore();
  recipes = parseJsonl(await s.read(FILE)).map(normalize).filter(Boolean);
  savedAt = Date.now();
  events.emit('change');
}

// Called after a sync brought a new recipes file in. Merged with what's in
// memory (newest version of each recipe wins), so a recipe learned just
// before the sync, still waiting to be saved, isn't lost.
export async function reload(paths) {
  if (!(paths.includes('*') || paths.includes(FILE))) return;
  const mine = recipes;
  const s = await getStore();
  const theirs = parseJsonl(await s.read(FILE)).map(normalize).filter(Boolean);
  const stamp = (r) => r.mts || r.ts || r.lastUsed || r.created || 0;
  const byId = new Map(theirs.map(r => [r.id, r]));
  let unsaved = false;
  for (const r of mine) {
    if (stamp(r) <= savedAt) continue;          // already written; the file is the truth
    const t = byId.get(r.id);
    if (!t || stamp(r) > stamp(t)) { byId.set(r.id, r); unsaved = true; }
  }
  recipes = [...byId.values()];
  events.emit('change');
  if (unsaved) schedule();
}

function schedule() {
  events.emit('change');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { flush().catch(e => console.warn('Saving recipes failed.', e)); }, 1200);
}

// Writes now (save() debounces; tests and app shutdown call this).
export async function flush() {
  clearTimeout(saveTimer);
  const cutoff = Date.now() - TOMBSTONE_TTL;
  recipes = recipes.filter(r => !(r.deleted && (r.mts || 0) < cutoff));
  const s = await getStore();
  const at = Date.now();
  await s.write(FILE, toJsonl(recipes));
  savedAt = at;
  if (s.sync) s.sync();
}

const live = () => recipes.filter(r => !r.deleted);

// Most recently used first, then newest.
export function list() {
  return live().sort((a, b) => (b.lastUsed || b.created || 0) - (a.lastUsed || a.created || 0));
}
export const get = (id) => live().find(r => r.id === id) || null;

// ── Text helpers ─────────────────────────────────────────────────────────

// Credentials must never end up in a recipe. Token shapes are caught everywhere;
// words like "secret" only count where a value follows (a command, a URL query),
// so a path like /docs/secrets/ or a file called secrets.md is fine.
const TOKEN_SHAPE = /(\bgh[pousr]_[A-Za-z0-9]{10,}|github_pat_\w{10,}|\bsk-[A-Za-z0-9-]{16,})/;
const CRED_WORD = /(token|secret|passw(or)?d|api[_-]?key|authorization|bearer)/i;
const CRED_PARAM = /[?&#;][\w-]*(token|secret|key|passw(or)?d|auth|sig(nature)?)[\w-]*=/i;
const URL_USERINFO = /\/\/[^/@\s]+:[^/@\s]+@/;
function looksSecret(kind, v) {
  if (TOKEN_SHAPE.test(v)) return true;
  if (kind === 'url') return CRED_PARAM.test(v) || URL_USERINFO.test(v);
  if (kind === 'command') return CRED_WORD.test(v);
  return false;
}
const redact = (s) => String(s || '')
  .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[A-Za-z0-9-]{20,})\b/g, '[redacted]');
const squash = (s) => redact(String(s || '').replace(/\s+/g, ' ').trim());
const clip = (s, n) => {
  s = squash(s);
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, Math.max(n - 20, cut.lastIndexOf(' '))).replace(/[\s,;:.-]+$/, '') + '…';
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const uniq = (a) => [...new Set(a)];
const sentenceCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const FILLERS = ['please', 'hey', 'hi', 'ok', 'okay', 'so', 'um', 'uh', 'umm', 'uhh', 'well', 'yeah', 'alright', 'right',
  'can you', 'could you', 'would you', 'will you', 'can u', 'i want you to', 'i need you to', 'i would like you to', 'i want to',
  'i wanna', 'i need to', 'i need', 'i gotta', 'i have to', 'lets', "let's", 'let us', 'go ahead and', 'just'];
const LEAD = new RegExp(`^(?:(?:${FILLERS.map(esc).join('|')})\\b[\\s,.:-]*)+`, 'i');

// "hey so can you please kill whatever is on 8080, thanks" -> "Kill whatever is on 8080"
export function titleOf(goal) {
  let t = squash(goal).replace(LEAD, '');
  t = t.split(/(?<=[.!?])\s|\s[-—]\s|;\s/)[0];
  t = t.replace(/\b(thanks|thank you|thx|please)\b[\s.!?]*$/i, '').replace(/[\s,.!?:;-]+$/, '');
  t = clip(t, 70);
  return t ? sentenceCase(t) : 'Untitled recipe';
}

// ── Specifics ────────────────────────────────────────────────────────────
// Concrete things a later run can reuse. Found in tool arguments (by argument
// name, so "query" and "message" are never specifics) and in step texts.

const KINDS = ['url', 'repo', 'branch', 'command', 'path'];
const EXT = 'js|mjs|cjs|ts|tsx|jsx|json|jsonl|md|html|css|toml|yml|yaml|py|sh|txt|csv|pdf|png|jpg|svg|lock|wasm|gguf|ipynb|rs|go|sql';

function classifyArg(key, value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.length > 200 || /\n/.test(v)) return null;
  const k = String(key).toLowerCase();
  let kind = null;
  if (/^https?:\/\/[^\s]+$/i.test(v)) kind = 'url';
  else if (/^(repo|repository|full_name)$/.test(k)) kind = /^[\w.-]+(\/[\w.-]+)?$/.test(v) ? 'repo' : null;
  else if (/^(branch|ref|base|head)$/.test(k)) kind = /^[\w][\w./-]*$/.test(v) ? 'branch' : null;
  else if (/^(command|cmd|shell)$/.test(k)) kind = 'command';
  else if (/^(path|file|filepath|filename|dir|directory|folder|cwd)$/.test(k)) kind = v.length > 1 && v !== '.' ? 'path' : null;
  return kind && !looksSecret(kind, v) ? kind : null;
}

// Extra spellings of a value that a step text might use for it.
function aliases(kind, value) {
  const out = [value];
  if (kind === 'path') {
    const rel = value.replace(/^\/(?:home|repos\/[^/]+)\//, '');
    if (rel !== value && rel.length > 2) out.push(rel);
    const base = value.split('/').pop();
    if (/\.\w+$/.test(base) && base.length >= 4) out.push(base);
  }
  if (kind === 'repo' && value.includes('/')) out.push(value.split('/')[1]);
  return uniq(out).sort((a, b) => b.length - a.length);
}

const replaceValue = (text, value, token) => text.replace(
  new RegExp(`(?<![\\w/.@-])${esc(value)}(?![\\w/@-])`, 'g'), token);

// Concrete values mentioned inline in a step text.
function inlineSpecifics(text, known) {
  const found = [];
  const add = (kind, value) => { if (value && !looksSecret(kind, value) && !found.some(f => f.value === value)) found.push({ kind, value }); };
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/gi)) add('url', m[0].replace(/[.,;:!?]+$/, ''));
  for (const m of text.matchAll(/`([^`\n]{2,160})`/g)) {
    const v = m[1].trim();
    if (/^https?:\/\//i.test(v)) continue;
    if (new RegExp(`^(?:~|\\.{1,2})?/?(?:[\\w.@-]+/)*[\\w.@-]+\\.(?:${EXT})$`, 'i').test(v) || /^\/(home|repos)\//.test(v)) add('path', v);
    else if (known.repos.has(v)) add('repo', v);
    else if (/\s/.test(v) || /^(git|npm|node|lsof|kill|curl|ls|cat|grep|docker|python3?|pip|make|cd|rm|mv|cp|ps|netstat|ss|brew|apt|wrangler|npx)\b/.test(v)) add('command', v);
  }
  for (const m of text.matchAll(new RegExp(`(?<![\\w/.@-])((?:~|\\.{1,2})?/?(?:[\\w@-]+/)*[\\w@-]+(?:\\.[\\w-]+)*\\.(?:${EXT}))(?![\\w/@-])`, 'gi'))) {
    if (!/^https?:/i.test(m[1])) add('path', m[1]);
  }
  return found;
}

// ── fromTask ─────────────────────────────────────────────────────────────
// Builds a recipe from a finished task with no model: the step texts with
// their concrete values lifted into `specifics`.
//   task:    { goal, msg?, request?, steps: [{ text, status }], session? }  (docs/harness.md, "Task state")
//   toolLog: [{ name, args, ok, label }]
//   opts:    { request, sessionId, now }   request = the user's words (else task.request, else task.msg when it is text)
export function fromTask(task, toolLog = [], opts = {}) {
  const now = opts.now || Date.now();
  task = task || {};
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const done = steps.filter(s => s && s.status === 'done');
  const picked = (done.length ? done : steps.filter(s => s && s.status !== 'blocked'))
    .map(s => squash(typeof s === 'string' ? s : s.text)).filter(Boolean).slice(0, MAX_STEPS);

  // 1. Concrete values: tool arguments of successful calls first (they ran), then step texts.
  const values = []; // { kind, value }
  const seen = new Set();
  const addValue = (kind, value) => {
    const key = kind + '\0' + value;
    if (seen.has(key)) return;
    // "README.md" or "squiggle" next to "/repos/squiggle/README.md" or "KealJones/squiggle" is the same thing.
    if (values.some(v => v.kind === kind && aliases(kind, v.value).includes(value))) return;
    const short = values.find(v => v.kind === kind && aliases(kind, value).includes(v.value));
    if (short) { seen.add(key); short.value = value; return; }
    seen.add(key);
    values.push({ kind, value });
  };
  const known = { repos: new Set() };
  for (const call of toolLog || []) {
    if (!call || call.ok === false || !call.args || typeof call.args !== 'object') continue;
    for (const [k, v] of Object.entries(call.args)) {
      const kind = classifyArg(k, v);
      if (kind) { addValue(kind, v.trim()); if (kind === 'repo') known.repos.add(v.trim()); }
    }
  }
  for (const text of picked) for (const f of inlineSpecifics(text, known)) addValue(f.kind, f.value);
  const capped = values.slice(0, MAX_SPECIFICS);

  // 2. Placeholder names: <path> when there is one of a kind, <path1>, <path2> when several.
  const perKind = {};
  for (const v of capped) perKind[v.kind] = (perKind[v.kind] || 0) + 1;
  const counter = {};
  for (const v of capped) {
    counter[v.kind] = (counter[v.kind] || 0) + 1;
    v.token = `<${v.kind}${perKind[v.kind] > 1 ? counter[v.kind] : ''}>`;
  }
  const order = KINDS;
  capped.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.token.localeCompare(b.token, 'en', { numeric: true }));

  // 3. Replace the values in the step texts (longest spelling first so a full path wins over its file name).
  const spellings = capped.flatMap(v => aliases(v.kind, v.value).map(a => ({ a, token: v.token })))
    .sort((x, y) => y.a.length - x.a.length);
  const generalise = (text) => {
    for (const { a, token } of spellings) text = replaceValue(text, a, token);
    return text.replace(/`(<\w+>)`/g, '$1');
  };

  const goal = squash(task.goal) || picked[0] || '';
  const request = squash(opts.request || task.request
    || (typeof task.msg === 'string' && /\s/.test(task.msg) ? task.msg : (task.msg && task.msg.content) || ''));
  const examples = [];
  if (request && request.toLowerCase() !== goal.toLowerCase()) examples.push(clip(request, 240));
  const sessionId = opts.sessionId || task.session || task.sessionId;

  return {
    title: generalise(titleOf(goal || request)),
    when: clip(goal || request, 220),
    examples,
    steps: picked.map(generalise),
    specifics: capped.map(v => `${v.token} = ${v.value}`),
    uses: 0,
    created: now,
    lastUsed: now,
    sessions: sessionId ? [sessionId] : [],
  };
}

// ── save / merge ─────────────────────────────────────────────────────────

const tokenSet = (s) => new Set(tokenize(s));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}
function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return 2 * n / (a.size + b.size);
}

// Two recipes are "the same recipe" when their titles are nearly the same
// words, or their `when` texts are (dice >= 0.6).
function similar(a, b) {
  return jaccard(tokenSet(a.title), tokenSet(b.title)) >= 0.7
    || dice(tokenSet(a.when), tokenSet(b.when)) >= 0.6;
}

const samePhrase = (a, b) => squash(a).toLowerCase() === squash(b).toLowerCase();

// Saves a recipe. A recipe with the id of a stored one replaces its content
// (the Memory panel's edit). Otherwise, if it is close to an existing recipe
// it is merged into it: example phrasings are appended, steps and specifics
// are refreshed from the new run, and uses, created, lastUsed, pinned and the
// title stay. Returns the stored recipe.
export function save(recipe) {
  const now = Date.now();
  const incoming = normalize({ ...recipe, id: recipe.id || '_new' });
  incoming.id = recipe.id || null;
  if (!incoming.title && !incoming.steps.length) throw new Error('A recipe needs a title or steps.');
  incoming.title = incoming.title || titleOf(incoming.when);

  let existing = incoming.id ? recipes.find(r => r.id === incoming.id) : null;
  if (!existing) existing = live().find(r => similar(r, incoming)) || null;

  if (!existing) {
    const r = {
      ...incoming,
      id: incoming.id || uid('r'),
      examples: incoming.examples.slice(-MAX_EXAMPLES),
      steps: incoming.steps.slice(0, MAX_STEPS),
      specifics: incoming.specifics.slice(0, MAX_SPECIFICS),
      uses: incoming.uses || 0,
      created: incoming.created || now,
      lastUsed: incoming.lastUsed || now,
      ts: incoming.created || now,
      mts: now,
    };
    delete r.deleted;
    recipes.push(r);
    schedule();
    return r;
  }

  if (incoming.id && incoming.id === existing.id) {
    // An edit by id: take the given fields as they are.
    Object.assign(existing, incoming, { id: existing.id, created: existing.created, uses: Math.max(existing.uses, incoming.uses || 0), deleted: false, mts: now });
    schedule();
    return existing;
  }

  // A repeat of a known task: keep what makes it a good recipe, refresh the rest.
  const examples = [...existing.examples];
  const phrasings = [...incoming.examples];
  if (incoming.when && !samePhrase(incoming.when, existing.when)) phrasings.push(incoming.when);
  for (const p of phrasings) if (p && !examples.some(e => samePhrase(e, p)) && !samePhrase(p, existing.when)) examples.push(p);
  existing.examples = examples.slice(-MAX_EXAMPLES);
  if (incoming.steps.length) {
    existing.steps = incoming.steps.slice(0, MAX_STEPS);
    existing.specifics = incoming.specifics.slice(0, MAX_SPECIFICS); // placeholders belong to the steps
  }
  existing.sessions = uniq([...existing.sessions, ...incoming.sessions]).slice(-20);
  existing.mts = now;
  schedule();
  return existing;
}

export function update(id, patch) {
  const r = live().find(x => x.id === id);
  if (!r) return null;
  const { id: _i, created: _c, ...rest } = patch || {};
  Object.assign(r, rest, { mts: Date.now() });
  schedule();
  return r;
}

export function touch(id) {
  const r = live().find(x => x.id === id);
  if (!r) return null;
  const now = Date.now();
  r.uses = (r.uses || 0) + 1;
  r.lastUsed = now;
  r.mts = now;
  schedule();
  return r;
}

export function remove(id) {
  const r = recipes.find(x => x.id === id && !x.deleted);
  if (!r) return false;
  Object.assign(r, { deleted: true, mts: Date.now() });
  schedule();
  return true;
}

export function pin(id, on = true) {
  const r = live().find(x => x.id === id);
  if (!r) return null;
  if (on) r.pinned = true; else delete r.pinned;
  r.mts = Date.now();
  schedule();
  return r;
}

// Forgets unpinned recipes unused for 90 days (they are cheap to relearn).
// Deleted ones stay as tombstones so other devices drop them too.
export function prune(now = Date.now()) {
  let n = 0;
  for (const r of live()) {
    if (r.pinned) continue;
    if (now - (r.lastUsed || r.created || 0) > UNUSED_TTL) {
      Object.assign(r, { deleted: true, mts: now });
      n++;
    }
  }
  if (n) schedule();
  return n;
}

// ── match ────────────────────────────────────────────────────────────────

// Words that carry no signal in a request to an assistant (on top of search.js's stop words).
const CHATTER = new Set(('hey hi uh uhh um umm like yeah gonna wanna kinda thing things stuff basically actually really ' +
  'maybe probably guess mean know think need want get got let make again thanks thx pls plz one some something someone anything').split(' '));

function queryTokens(query) {
  return uniq(tokenize(query)).filter(w => !CHATTER.has(w));
}

const matchText = (r) => [r.title, r.when, ...(r.examples || []), ...(r.steps || [])].join('\n');

// 0..1 how much of the request this recipe covers.
//   qCov  = share of the request's words found in the recipe (long, rambling
//           requests are judged on their first 5 distinct words, so padding
//           does not sink a good match)
//   tHit  = share of the title's words the request uses
//   score = 0.65 qCov + 0.35 tHit, and 0 unless 2+ words match (1 for one-word requests).
function lexicalScore(q, docTokens, titleTokens) {
  if (!q.length) return 0;
  const hit = q.filter(w => docTokens.has(w));
  if (hit.length < Math.min(2, q.length)) return 0;
  const qCov = Math.min(1, hit.length / Math.min(q.length, 5));
  const tHit = titleTokens.size ? [...titleTokens].filter(w => q.includes(w)).length / titleTokens.size : 0;
  return Math.min(1, 0.65 * qCov + 0.35 * tHit);
}

function rank(query, pool) {
  const q = queryTokens(query);
  if (!q.length || !pool.length) return [];
  const rel = bm25(pool.map(r => ({ id: r.id, text: matchText(r) })))(query);
  return pool.map(r => {
    const lex = lexicalScore(q, new Set(tokenize(matchText(r))), new Set(tokenize(r.title)));
    return { recipe: r, lex, bm: rel.get(r.id) || 0, score: lex };
  });
}

function finish(scored, k) {
  return scored.filter(x => x.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || b.bm - a.bm)
    .slice(0, k)
    .map(({ recipe, score }) => ({ recipe, score: Math.round(score * 1000) / 1000 }));
}

// Keyword-only match (sync). Candidates are ordered by score, then BM25.
export function matchSync(query, k = 3) {
  return finish(rank(query, live()), k);
}

// Recipes that fit a request, best first: keyword coverage (above), plus
// semantic similarity when setEmbedder() was given one. Only matches scoring
// >= MIN_SCORE come back. Async because embedding is.
export async function match(query, k = 3) {
  const pool = live();
  const scored = rank(query, pool);
  if (embedder && pool.length && String(query || '').trim()) {
    try {
      const vecs = await embedder([String(query), ...pool.map(r => `${r.title}. ${r.when}`)]);
      if (vecs) {
        pool.forEach((r, i) => {
          const sem = Math.max(0, (cosine(vecs[0], vecs[i + 1]) - 0.15) / 0.85); // MiniLM cosines under ~0.15 are noise
          const s = scored.find(x => x.recipe === r);
          if (sem >= 0.5) s.score = Math.max(s.lex, 0.35 * s.lex + 0.65 * sem);
        });
      }
    } catch { /* keyword scores stand */ }
  }
  return finish(scored, k);
}

// For tests: forget everything held in memory.
export function _reset() { recipes = []; clearTimeout(saveTimer); embedder = null; store = null; savedAt = 0; }
