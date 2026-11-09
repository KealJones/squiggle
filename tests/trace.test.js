import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrace, openConv, addRound, noteRendered, takeRendered, traceText, clip } from '../app/src/trace.js';

const spec = (name) => ({ name, description: `${name} does a thing`, parameters: { type: 'object', properties: { q: { type: 'string' } } } });

test('a trace keeps each conversation: system, full schemas only for declared tools, the rest by name, every round', () => {
  const t = createTrace();
  openConv(t, { phase: 'Chat', system: 'You are Squiggle.', tools: [spec('find'), spec('git_clone'), spec('run_js')], declared: ['find'], messages: [{ role: 'user', content: 'pull github.com/a/b' }], model: 'LFM2.5 1.2B' });
  addRound(t, { input: [{ role: 'tool', name: 'find', content: '{"found":"…"}' }], output: { text: '', toolCalls: [{ function: { name: 'git_clone', arguments: '{"url":"…"}' } }] }, added: ['git_clone'] });
  addRound(t, { input: 'next', output: { text: 'Cloned it.' }, rendered: { kind: 'raw prompt', text: '<|startoftext|>…' } });
  openConv(t, { phase: 'Final reply', system: 'Write the reply.', tools: [] });
  const [a, b] = t.convs;
  assert.deepEqual([a.declared, a.named], [['find'], ['git_clone', 'run_js']]);
  assert.equal(Object.keys(t.tools).length, 3, 'each schema stored once for the whole trace');
  assert.equal(a.rounds.length, 2);
  assert.deepEqual(a.rounds[0].added, ['git_clone']);
  assert.equal(a.rounds[1].rendered.kind, 'raw prompt');
  assert.deepEqual([b.declared, b.named], [[], []]);
  const text = traceText(t);
  for (const want of ['######## 1. Chat (LFM2.5 1.2B)', '=== System prompt ===\nYou are Squiggle.', '"name": "find"', '=== Tools listed by name only ===\ngit_clone, run_js',
    '[user]\npull github.com/a/b', '=== Round 1: sent ===\n[tool find]', '(tool calls)', 'declared after this round: git_clone', '=== Round 2: exact raw prompt ===\n<|startoftext|>', '######## 2. Final reply']) {
    assert.ok(text.includes(want), want);
  }
});

test('no declared list means every tool in full; long strings are cut; the copy is deep', () => {
  const t = createTrace();
  const msgs = [{ role: 'user', content: 'x'.repeat(50000) }];
  openConv(t, { phase: 'Chat', tools: [spec('find'), spec('web_search')], messages: msgs });
  assert.deepEqual(t.convs[0].declared, ['find', 'web_search']);
  assert.ok(t.convs[0].messages[0].content.length < 41000 && /more characters not kept/.test(t.convs[0].messages[0].content));
  msgs[0].content = 'changed';
  assert.notEqual(t.convs[0].messages[0].content, 'changed');
  assert.deepEqual(clip({ a: [1, 'b', null], f: () => 1 }), { a: [1, 'b', null] });
});

test('the rendered prompt is taken once, and a round with no open conversation is ignored', () => {
  noteRendered('raw prompt', 'abc');
  assert.deepEqual(takeRendered(), { kind: 'raw prompt', text: 'abc' });
  assert.equal(takeRendered(), null);
  noteRendered('chat messages', [{ role: 'user', content: 'hi' }]);
  assert.match(takeRendered().text, /"role": "user"/);
  const t = createTrace();
  addRound(t, { input: 'x', output: { text: 'y' } });
  assert.equal(t.convs.length, 0);
});
