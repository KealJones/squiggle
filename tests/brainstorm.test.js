import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viewFor, transcriptFor, framingOf, nextVoice, systemFor, continueSystem, cutOff, latestSteer, ownTurn, PIECE, PERSON } from '../app/src/brainstorm.js';

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
  for (const v of ['A', 'B']) for (const f of ['flip', 'transcript']) {
    assert.match(systemFor(v, 'x', '', f), /ever opens? with praise/);
    assert.doesNotMatch(systemFor(v, 'x', '', f), /short paragraph|keep it (short|brief)/i);
  }
});

test('cut off: the runtime\'s own reason first, then the token count, then the text', () => {
  assert.equal(cutOff('half a table', { tokens: 380, finish: 'length' }), true, 'the window ran out before max_tokens');
  assert.equal(cutOff('done.', { tokens: PIECE, finish: 'stop' }), false);
  assert.equal(cutOff('lots of text', { tokens: PIECE }), true, 'no reason given: the count');
  assert.equal(cutOff('done.', { tokens: 200 }), false);
  assert.equal(cutOff('', { tokens: PIECE, finish: 'length' }), false, 'an empty call keeps the last reply\'s numbers; not a cut-off');
  assert.equal(cutOff('x'.repeat(PIECE * 4), null), true, 'no numbers (cloud): estimated from the text');
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
  assert.ok(v[0].content.length <= 500 * 3 + 1);
});

test('the person\'s latest steer goes in the system prompt until both voices have answered it', () => {
  assert.equal(latestSteer([seed, a1]), '', 'the idea itself is the topic, not a steer');
  assert.equal(latestSteer([seed, a1, b1, steer]), 'focus on money');
  assert.equal(latestSteer([seed, a1, b1, steer, a2]), 'focus on money', 'B still has to answer it');
  assert.equal(latestSteer([seed, a1, b1, steer, a2, msg('assistant', 'x', { voice: 'B' })]), '');
  assert.match(systemFor('B', 'cats', 'focus on money'), /just stepped in and said: "focus on money"/);
  assert.match(continueSystem('B', 'cats', 'so far', 'focus on money'), /focus on money/);
  assert.doesNotMatch(systemFor('B', 'cats'), /stepped in and said/);
});

test('framing: new brainstorms are transcripts; chats from before the switch (true) stay role flips', () => {
  assert.equal(framingOf({ brainstorm: 'transcript' }), 'transcript');
  assert.equal(framingOf({ brainstorm: 'flip' }), 'flip');
  assert.equal(framingOf({ brainstorm: true }), 'flip');
});

test('transcript: one user turn, every turn labelled, the person included, ending with the ask', () => {
  const v = transcriptFor([seed, a1, b1, steer], 'A').messages;
  assert.equal(v.length, 1);
  assert.equal(v[0].role, 'user');
  assert.equal(v[0].content, `${PERSON}: A coffee shop for dogs\n\nA: Dog-safe pup cups\n\nB: Who cleans up?\n\n${PERSON}: focus on money\n\nNow write A's next turn.`);
  const sys = systemFor('B', 'cats', '', 'transcript');
  assert.match(sys, /You write B's turns\. B is the critic: starts every turn with the weakest/);
  assert.match(sys, /no "B:" label/);
  assert.doesNotMatch(sys, /user turns/, 'nothing about the other voice being the user');
  assert.match(systemFor('A', 'cats', 'focus on money', 'transcript'), /just stepped in and said: "focus on money"\. This turn follows that direction, whatever B last said/);
  assert.match(continueSystem('A', 'cats', 'half a', '', 'transcript'), /A's turn was cut off by the length limit/);
});

test('transcript: the idea always stays, the oldest turns drop off, and an overlong last turn keeps its end', () => {
  const line = [seed];
  for (let i = 0; i < 30; i++) line.push(msg('assistant', `turn ${i} `.repeat(40), { voice: i % 2 ? 'B' : 'A' }));
  const t = transcriptFor(line, 'A', 400).messages[0].content;
  assert.ok(t.startsWith(`${PERSON}: A coffee shop for dogs\n\n…\n\n`), t.slice(0, 80));
  assert.match(t, /turn 29 \n\nNow write A's next turn\.$/);
  assert.doesNotMatch(t, /turn 0 /);
  const doc = msg('assistant', 'START ' + 'word '.repeat(3000) + 'FINAL LINE', { voice: 'A' });
  const d = transcriptFor([seed, doc], 'B', 500).messages[0].content;
  assert.match(d, /…[^]*FINAL LINE\n\nNow write B's next turn\.$/);
  assert.doesNotMatch(d, /START/);
});

test('transcript: a turn ends where another speaker starts, and its own leading label is dropped', () => {
  assert.deepEqual(ownTurn('B: The cache will blow up.\n\nA: Then cap it.\n\nB: Fine.'), { text: 'The cache will blow up.', other: true });
  assert.deepEqual(ownTurn('Graph attention.\n\nA: Let me flesh out the core idea.'), { text: 'Graph attention.', other: true }, 'its own label again: a new turn');
  assert.deepEqual(ownTurn(`Ok.\n${PERSON}: thanks`), { text: 'Ok.', other: true });
  assert.deepEqual(ownTurn('**B:** bold label'), { text: 'bold label', other: false });
  assert.deepEqual(ownTurn('Plan A: cheap. Plan B: fast.\nAB: testing'), { text: 'Plan A: cheap. Plan B: fast.\nAB: testing', other: false }, 'labels only at a line start');
  assert.deepEqual(ownTurn('B: x\nA: y', 'flip'), { text: 'B: x\nA: y', other: false }, 'the role flip keeps what it wrote');
});
