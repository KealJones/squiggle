// Conflict-free merges for synced data. When two devices change the same
// file between syncs, these combine both versions instead of picking one.
// Pure functions (tests/merge.test.js).
//
// Session file (sessions/<id>.json):
// {
//   v: 1, id, title, created, updated, deleted?,
//   messages:     [{ id, role, content, ts, mts?, thread: null|threadId, tools?, context?, pinned? }],
//   threads:      { [threadId]: { id, parent: messageId, title, created, updated, summary?, summaryUpTo? } },
//   observations: [{ id, ts, thread, source, title, text }],   // tool output kept for retrieval
//   summaries:    { [ 'main' | threadId ]: { text, upTo, ts } } // rolling context summaries
// }

const mtime = (x) => (x && (x.mts || x.updated || x.ts)) || 0;

function unionById(a = [], b = []) {
  const map = new Map();
  for (const item of [...a, ...b]) {
    const prev = map.get(item.id);
    if (!prev || mtime(item) > mtime(prev)) map.set(item.id, item);
  }
  return [...map.values()];
}

function mergeRecord(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (!(k in out) || mtime(v) > mtime(out[k])) out[k] = v;
  }
  return out;
}

const byTime = (x, y) => (x.ts - y.ts) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

export function mergeSession(a, b) {
  if (!a) return b;
  if (!b) return a;
  const newer = (b.updated || 0) > (a.updated || 0) ? b : a;
  const older = newer === a ? b : a;
  const merged = {
    ...older,
    ...newer,
    updated: Math.max(a.updated || 0, b.updated || 0),
    created: Math.min(a.created || Infinity, b.created || Infinity),
    messages: unionById(a.messages, b.messages).sort(byTime),
    threads: mergeRecord(a.threads, b.threads),
    observations: unionById(a.observations, b.observations).sort(byTime),
    summaries: mergeRecord(a.summaries, b.summaries),
  };
  // A delete wins only if it's the latest change; edits made after a delete
  // on another device resurrect the session.
  merged.deleted = Boolean(newer.deleted);
  return merged;
}

// One JSON object per line, each with an id (memory/facts.jsonl).
export function parseJsonl(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip a corrupt line rather than lose the file */ }
  }
  return out;
}

export function toJsonl(items) {
  return items.map(i => JSON.stringify(i)).join('\n') + (items.length ? '\n' : '');
}

export function mergeJsonl(aText, bText) {
  const merged = unionById(parseJsonl(aText), parseJsonl(bText));
  merged.sort((x, y) => (x.ts || 0) - (y.ts || 0) || (x.id < y.id ? -1 : 1));
  return toJsonl(merged);
}

// Chooses a merge for a path, or null when the file has no merge strategy
// (then the caller keeps local and saves the remote copy beside it).
export function mergeFor(path) {
  if (/(^|\/)sessions\/[^/]+\.json$/.test(path)) {
    return (local, remote) => JSON.stringify(mergeSession(safeJson(local), safeJson(remote)), null, 1);
  }
  if (/\.jsonl$/.test(path)) return (local, remote) => mergeJsonl(local, remote);
  return null;
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
