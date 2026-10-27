// Sessions (conversations with threads), stored as sessions/<id>.json in the
// storage repo. In-memory cache + debounced save + sync.
import * as storage from './storage.js';
import { uid, emitter, monotonicNow } from './util.js';
import { mergeSession } from './merge.js';

export const events = emitter();
const cache = new Map();   // id -> session
let saveTimer = null;
const pendingSave = new Set();

export function newSession(title = 'New chat') {
  const now = Date.now();
  const s = { v: 1, id: uid('s'), title, created: now, updated: now, messages: [], threads: {}, observations: [], summaries: {}, notes: {} };
  cache.set(s.id, s);
  return s;
}

// Loads every session file, merging into sessions already in memory (never
// dropping one that hasn't been saved yet, and keeping object identity).
export async function loadAll() {
  const files = await storage.list('sessions');
  for (const f of files) {
    if (!/^[^/]+\.json$/.test(f.path)) continue;
    const s = parse(await storage.read('sessions/' + f.path));
    if (!s || !s.id) continue;
    const cur = cache.get(s.id);
    if (cur) Object.assign(cur, normalize(mergeSession(cur, s)));
    else cache.set(s.id, normalize(s));
  }
  events.emit('list');
}

// Reload only the given session files after a sync brought in changes,
// merging with any unsaved in-memory edits.
export async function reload(paths) {
  const all = paths.includes('*');
  if (all) { await loadAll(); return; }
  let touched = false;
  for (const p of paths) {
    const m = p.match(/^sessions\/([^/]+)\.json$/);
    if (!m) continue;
    const fresh = parse(await storage.read(p));
    if (!fresh) continue;
    const cur = cache.get(fresh.id);
    // Merge into the existing object so views holding it stay current.
    if (cur) Object.assign(cur, normalize(mergeSession(cur, fresh)));
    else cache.set(fresh.id, normalize(fresh));
    touched = true;
    events.emit('session', fresh.id);
  }
  if (touched) events.emit('list');
}

export function list() {
  return [...cache.values()].filter(s => !s.deleted && s.messages.length)
    .sort((a, b) => b.updated - a.updated);
}

export const get = (id) => cache.get(id) || null;

export function touch(session) {
  session.updated = Date.now();
  cache.set(session.id, session);
  pendingSave.add(session.id);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 1500);
  events.emit('list');
}

export async function flush({ sync = true } = {}) {
  clearTimeout(saveTimer);
  const ids = [...pendingSave];
  pendingSave.clear();
  for (const id of ids) {
    const s = cache.get(id);
    if (s) await storage.write(`sessions/${id}.json`, JSON.stringify(s, null, 1));
  }
  if (ids.length && sync) storage.sync();
}

export function remove(session) {
  session.deleted = true;
  touch(session);
}

// ── Message helpers ────────────────────────────────────────────────────────

export function addMessage(session, msg) {
  const m = { id: uid('m'), ts: monotonicNow(), thread: null, ...msg };
  session.messages.push(m);
  if (m.thread && session.threads[m.thread]) session.threads[m.thread].updated = m.ts;
  touch(session);
  return m;
}

export function updateMessage(session, m, patch) {
  Object.assign(m, patch, { mts: Date.now() });
  touch(session);
}

export function startThread(session, parentMessage) {
  const id = uid('t');
  const now = Date.now();
  session.threads[id] = {
    id, parent: parentMessage.id, created: now, updated: now,
    title: String(parentMessage.content || '').replace(/\s+/g, ' ').slice(0, 60),
  };
  touch(session);
  return session.threads[id];
}

export function threadOf(session, parentId) {
  return Object.values(session.threads).find(t => t.parent === parentId) || null;
}

// The messages a model sees for a conversation line:
//   main thread  -> main messages
//   a thread     -> main messages up to and including the parent, then the thread
export function lineMessages(session, threadId = null) {
  const main = session.messages.filter(m => !m.thread);
  if (!threadId) return main;
  const t = session.threads[threadId];
  if (!t) return [];
  const idx = main.findIndex(m => m.id === t.parent);
  const before = idx >= 0 ? main.slice(0, idx + 1) : [];
  return before.concat(session.messages.filter(m => m.thread === threadId));
}

export function addObservation(session, obs) {
  const o = { id: uid('o'), ts: Date.now(), ...obs };
  session.observations.push(o);
  // Keep the file bounded: oldest observations go first.
  if (session.observations.length > 200) session.observations.splice(0, session.observations.length - 200);
  touch(session);
  return o;
}

// The agent's notepad for this chat. Deleting keeps a tombstone so the
// delete syncs (merge keeps the newest version of each note).
export const liveNotes = (session) => Object.values(session.notes || {}).filter(n => !n.deleted).sort((a, b) => a.ts - b.ts);
export function setNote(session, id, text) {
  session.notes = session.notes || {};
  const now = Date.now();
  const prev = id && session.notes[id];
  if (id && (!prev || prev.deleted)) return null;
  const n = prev ? { ...prev, text, mts: now } : { id: 'n' + (Object.keys(session.notes).length + 1) + '-' + uid('').slice(-4), text, ts: now, mts: now };
  session.notes[n.id] = n;
  touch(session);
  return n;
}
export function deleteNote(session, id) {
  const prev = session.notes && session.notes[id];
  if (!prev || prev.deleted) return false;
  session.notes[id] = { id, deleted: true, ts: prev.ts, mts: Date.now() };
  touch(session);
  return true;
}

function parse(text) { try { return JSON.parse(text); } catch { return null; } }

function normalize(s) {
  s.messages = s.messages || [];
  s.notes = s.notes || {};
  s.threads = s.threads || {};
  s.observations = s.observations || [];
  s.summaries = s.summaries || {};
  return s;
}
