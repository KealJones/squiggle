import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSession, mergeJsonl, parseJsonl, mergeFor } from '../app/src/merge.js';

const base = () => ({
  v: 1, id: 's1', title: 'Chat', created: 1, updated: 10,
  messages: [{ id: 'm1', role: 'user', content: 'hi', ts: 1, thread: null }, { id: 'm2', role: 'assistant', content: 'hello', ts: 2, thread: null }],
  threads: {}, observations: [], summaries: {},
});

test('two devices adding messages: both kept, in time order', () => {
  const a = base(); a.messages.push({ id: 'm3', role: 'user', content: 'from desktop', ts: 5, thread: null }); a.updated = 20;
  const b = base(); b.messages.push({ id: 'm4', role: 'user', content: 'from phone', ts: 4, thread: null }); b.updated = 15;
  const m = mergeSession(a, b);
  assert.deepEqual(m.messages.map(x => x.id), ['m1', 'm2', 'm4', 'm3']);
  assert.equal(m.updated, 20);
});

test('threads and summaries merge, newest edit wins per item', () => {
  const a = base(); a.threads.t1 = { id: 't1', parent: 'm2', updated: 5, title: 'x' };
  const b = base(); b.threads.t2 = { id: 't2', parent: 'm1', updated: 6, title: 'y' };
  b.threads.t1 = { id: 't1', parent: 'm2', updated: 9, title: 'x', summary: 'done' };
  a.summaries.main = { text: 'old', ts: 1, upTo: 'm1' }; b.summaries.main = { text: 'new', ts: 2, upTo: 'm2' };
  const m = mergeSession(a, b);
  assert.deepEqual(Object.keys(m.threads).sort(), ['t1', 't2']);
  assert.equal(m.threads.t1.summary, 'done');
  assert.equal(m.summaries.main.text, 'new');
});

test('edited message (pin) wins by mts', () => {
  const a = base(); a.messages[0] = { ...a.messages[0], pinned: true, mts: 50 };
  const b = base();
  assert.equal(mergeSession(a, b).messages[0].pinned, true);
  assert.equal(mergeSession(b, a).messages[0].pinned, true);
});

test('delete wins only if it is the latest change', () => {
  const a = base(); a.deleted = true; a.updated = 30;
  const b = base(); b.updated = 20;
  assert.equal(mergeSession(a, b).deleted, true);
  b.updated = 40;
  assert.equal(mergeSession(a, b).deleted, false);
});

test('jsonl facts union by id; corrupt lines are skipped', () => {
  const a = '{"id":"f1","s":"a","p":"b","o":"c","ts":1}\n{"id":"f2","s":"x","p":"y","o":"z","ts":2,"mts":2}\n';
  const b = '{"id":"f2","s":"x","p":"y","o":"z","ts":2,"mts":9,"deleted":true}\nnot json\n{"id":"f3","s":"q","p":"r","o":"s","ts":3}\n';
  const m = parseJsonl(mergeJsonl(a, b));
  assert.deepEqual(m.map(f => f.id), ['f1', 'f2', 'f3']);
  assert.equal(m[1].deleted, true);
});

test('mergeFor picks a strategy by path', () => {
  assert.ok(mergeFor('sessions/s1.json'));
  assert.ok(mergeFor('squiggle/sessions/s1.json'));
  assert.ok(mergeFor('memory/facts.jsonl'));
  assert.equal(mergeFor('home/notes.md'), null);
  const merged = JSON.parse(mergeFor('sessions/s1.json')(JSON.stringify(base()), JSON.stringify({ ...base(), messages: [...base().messages, { id: 'm9', role: 'user', content: 'x', ts: 9 }] })));
  assert.equal(merged.messages.length, 3);
});
