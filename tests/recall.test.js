import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeWindow, topicWords, wantsRecall, recallBlock, exchanges } from '../app/src/recall.js';

const NOW = new Date(2026, 9, 28, 14, 0).getTime(); // Wed Oct 28 2026, 2pm local
const DAY = 864e5;
const at = (daysAgo, h = 12) => { const d = new Date(NOW - daysAgo * DAY); d.setHours(h, 0, 0, 0); return d.getTime(); };
const msg = (id, role, content, ts) => ({ id, role, content, ts });

test('timeWindow reads common phrases', () => {
  const y = timeWindow('what did I say yesterday', NOW);
  assert.ok(y.from <= at(1, 9) && y.to >= at(1, 22));
  assert.ok(!(at(0, 10) <= y.to && at(0, 10) >= y.from));
  const lw = timeWindow('what i said last week about headphones', NOW);
  assert.equal(lw.phrase, 'last week');
  assert.ok(lw.from <= at(10) && lw.to >= at(3));
  const ago = timeWindow('that thing from 3 days ago', NOW);
  assert.ok(ago.from <= at(3) && ago.to >= at(3));
  const mon = timeWindow('on Monday you said', NOW);   // Oct 26
  assert.ok(mon.from <= at(2) && mon.to >= at(2) && mon.from > at(4));
  assert.equal(timeWindow('how big is the model', NOW), null);
});

test('topic words drop the time phrase and asking words', () => {
  const t = 'what i said last week about headphones';
  assert.deepEqual(topicWords(t, timeWindow(t, NOW)), ['headphone']);
});

test('plain chat wants no recall; real questions do', () => {
  for (const t of ['hi', 'thanks!', 'lol', 'ok cool', 'hey there']) assert.equal(wantsRecall(t), false, t);
  for (const t of ['what i said last week about headphones', 'which wrangler config deploys the relay', 'remember the cat?']) assert.equal(wantsRecall(t), true, t);
});

test('exchanges pair a request with its reply', () => {
  const x = exchanges([msg('a', 'user', 'q1'), msg('b', 'assistant', 'r1'), msg('c', 'assistant', 'r2'), msg('d', 'user', 'q2')]);
  assert.deepEqual(x.map(e => [e.id, e.user, e.reply]), [['a', 'q1', 'r1'], ['c', '', 'r2'], ['d', 'q2', '']]);
});

const others = [
  { id: 's1', title: 'Headphones', messages: [msg('h1', 'user', 'I want noise cancelling headphones under $200, mostly for flights', at(6)), msg('h2', 'assistant', 'Sony WH-CH720N or the Soundcore Space Q45 fit that budget.', at(6))] },
  { id: 's2', title: 'Hi', messages: [msg('g1', 'user', 'hi', at(1)), msg('g2', 'assistant', 'Hi! What can I do for you?', at(1))] },
  { id: 's3', title: 'Old headphones', messages: [msg('o1', 'user', 'my headphones broke', at(60)), msg('o2', 'assistant', 'Sorry to hear that.', at(60))] },
];

test('"what I said last week about headphones" finds that exchange, labelled, and nothing else', async () => {
  const r = await recallBlock({ query: 'what did I say last week about headphones?', others, now: NOW, small: true });
  assert.match(r.text, /^---\nPossibly relevant earlier messages/);
  assert.match(r.text, /Another chat, "Headphones" \(.+\): the user said "I want noise cancelling headphones.*" — you replied "Sony/);
  assert.doesNotMatch(r.text, /broke/);   // outside the window
  assert.equal(r.items.length, 1);
});

test('hi gets nothing even though other chats say hi', async () => {
  assert.equal((await recallBlock({ query: 'hi', others, now: NOW })).text, '');
});

test('one shared word is not enough without a time or past reference', async () => {
  const r = await recallBlock({ query: 'cheap flights to Denver in March', others, now: NOW });
  assert.equal(r.text, '');
});

test('"it" leans on the previous request and finds older messages in this chat', async () => {
  const inChat = [msg('w1', 'user', 'how do I deploy the relay worker with wrangler', at(0, 9)), msg('w2', 'assistant', 'Run npx wrangler deploy --config wrangler.relay.toml.', at(0, 9))];
  const r = await recallBlock({ query: 'does it need the config flag?', prevUser: 'the relay worker deploy failed on cloudflare', inChat, now: NOW, small: true });
  assert.match(r.text, /Earlier in this chat \(.+\): the user said "how do I deploy the relay worker/);
  assert.equal(r.items[0].kind, 'message');
});

test('size limits hold and small models get memory facts', async () => {
  const many = Array.from({ length: 8 }, (_, i) => msg('m' + i, 'user', `headphones noise cancelling battery review number ${i} `.repeat(20), at(5)));
  const recall = async () => [{ fact: { id: 'f1', s: 'Keal', p: 'prefers', o: 'over-ear headphones' }, score: 0.6 }, { fact: { id: 'f2', s: 'x', p: 'y', o: 'z' }, score: 0.1 }];
  const r = await recallBlock({ query: 'noise cancelling headphones battery', others: [{ id: 'z', title: 'Z', messages: many }], recall, now: NOW, small: true });
  assert.ok(r.items.filter(i => i.kind === 'chat').length <= 2);
  assert.ok(r.items.reduce((n, i) => n + i.tokens, 0) <= 380);
  assert.match(r.text, /From memory: Keal prefers over-ear headphones/);
  assert.doesNotMatch(r.text, /x y z/);
});

test('with embeddings, the similarity bar decides', async () => {
  const embed = async (texts) => texts.map(t => /headphone|earbud/i.test(t) ? Float32Array.from([1, 0]) : Float32Array.from([0, 1]));
  const r = await recallBlock({ query: 'which earbuds did we pick for flights', others, embed, now: NOW });
  assert.ok(r.items.some(i => i.session === 's1'));
  assert.ok(!r.items.some(i => i.session === 's2'));
});
