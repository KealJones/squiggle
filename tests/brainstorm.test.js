import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viewFor, nextVoice, systemFor, continueSystem, cutOff, PIECE } from '../app/src/brainstorm.js';

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

test('B is the critic and starts with the weakest part; neither opens with praise or is told to keep it short', () => {
  assert.match(systemFor('B', 'x'), /critic.*Start every turn with the weakest/s);
  assert.match(systemFor('A', 'x'), /builder/);
  for (const v of ['A', 'B']) {
    assert.match(systemFor(v, 'x'), /Never open with praise/);
    assert.doesNotMatch(systemFor(v, 'x'), /short paragraph|keep it (short|brief)/i);
  }
});

test('a reply that hit the limit counts as cut off; one that finished, or wrote nothing, does not', () => {
  assert.equal(cutOff('lots of text', PIECE), true);
  assert.equal(cutOff('done.', 200), false);
  assert.equal(cutOff('', PIECE), false, 'an empty call keeps the last reply\'s count; not a cut-off');
  assert.equal(cutOff('x'.repeat(PIECE * 4), null), true, 'no count (cloud): estimated from the text');
  assert.equal(cutOff('x'.repeat(400), null), false);
});

test('finishing a cut-off turn: same instructions, then the end of what it wrote and "carry on from there"', () => {
  const sys = continueSystem('B', 'cats', 'a'.repeat(5000) + 'THE END BIT');
  assert.ok(sys.startsWith(systemFor('B', 'cats')));
  assert.match(sys, /cut off by the length limit/);
  assert.match(sys, /THE END BIT/);
  assert.ok(sys.length < systemFor('B', 'cats').length + 2700, 'only the tail is shown back');
});

test('a turn longer than the whole budget keeps its end', () => {
  const doc = msg('assistant', 'START ' + 'word '.repeat(3000) + 'FINAL LINE', { voice: 'A' });
  const v = viewFor([seed, doc], 'B', 500).messages;
  assert.equal(v.length, 1);
  assert.match(v[0].content, /^….*FINAL LINE$/s);
  assert.doesNotMatch(v[0].content, /START/);
  assert.ok(v[0].content.length <= 500 * 3.5 + 1);
});
