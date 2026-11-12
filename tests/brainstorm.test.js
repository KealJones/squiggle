import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viewFor, nextVoice, systemFor } from '../app/src/brainstorm.js';

let n = 0;
const msg = (role, content, extra = {}) => ({ id: 'm' + (++n), role, content, ts: n, thread: null, ...extra });
const seed = msg('user', 'A coffee shop for dogs');
const a1 = msg('assistant', 'Dog-safe pup cups', { voice: 'A' });
const b1 = msg('assistant', 'Who cleans up?', { voice: 'B' });
const steer = msg('user', 'focus on money');
const a2 = msg('assistant', 'Memberships', { voice: 'A' });

test('A goes first, then they alternate', () => {
  assert.equal(nextVoice([seed]), 'A');
  assert.equal(nextVoice([seed, a1]), 'B');
  assert.equal(nextVoice([seed, a1, b1, steer]), 'A');
});

test('each voice sees its own turns as the assistant and the other voice as the user', () => {
  const A = viewFor([seed, a1, b1], 'A').messages;
  assert.deepEqual(A.map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(A[0].content, 'A coffee shop for dogs');
  const B = viewFor([seed, a1, b1, a2], 'B').messages;
  assert.deepEqual(B.map(m => [m.role, m.content]), [['user', 'Dog-safe pup cups'], ['assistant', 'Who cleans up?'], ['user', 'Memberships']]);
  assert.equal(viewFor([seed, a1], 'B').topic, 'A coffee shop for dogs');
  assert.match(systemFor('B', 'A coffee shop for dogs'), /A coffee shop for dogs/);
});

test('the person jumping in is marked and merged with the other voice', () => {
  const A = viewFor([seed, a1, b1, steer], 'A').messages;
  assert.equal(A.length, 3);
  assert.equal(A[2].role, 'user');
  assert.match(A[2].content, /^Who cleans up\?\n\nThe person who started this brainstorm steps in: focus on money$/);
});

test('old turns drop off the front to fit, and the view still starts with a user turn', () => {
  const line = [seed];
  for (let i = 0; i < 30; i++) line.push(msg('assistant', `turn ${i} `.repeat(40), { voice: i % 2 ? 'B' : 'A' }));
  const v = viewFor(line, 'A', 300).messages;
  assert.ok(v.length < 31 && v.length >= 1);
  assert.equal(v[0].role, 'user');
  assert.equal(v[v.length - 1].role, 'user');
  assert.match(v[v.length - 1].content, /turn 29/);
});

test('deleted messages and thread replies are left out', () => {
  const gone = msg('assistant', 'x', { voice: 'B', deleted: true });
  const side = msg('user', 'side question', { thread: 't1' });
  assert.deepEqual(viewFor([seed, a1, gone, side], 'B').messages.map(m => m.content), ['Dog-safe pup cups']);
  assert.equal(nextVoice([seed, a1, gone]), 'B');
});
