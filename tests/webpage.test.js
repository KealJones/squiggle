import test from 'node:test';
import assert from 'node:assert/strict';
import { pageCard } from '../app/src/webpage.js';
import { resolveAgentPath, agentPath } from '../app/src/guard.js';

const PAGE = [
  'Jump to content', 'Main menu', 'Search', 'Gemma 3',
  'Gemma 3 is a family of open models from Google, released in March 2025 in sizes from 270M to 27B parameters.',
  'The smallest model is meant for phones and other devices with little memory.',
  'Contents', 'Model details', 'The 270M model has 170M embedding parameters and 100M in its transformer blocks.',
  'Files', 'The Q4_0 GGUF of the 270M model is 242 MB.', 'License', 'Gemma terms of use.',
].join('\n');

test('pageCard: the opening skips menus; sections get their line numbers', () => {
  const c = pageCard(PAGE, ['Gemma 3', 'Model details', 'Files', 'License']);
  assert.equal(c.lines, 13);
  assert.match(c.opening, /^Gemma 3 is a family of open models/);
  assert.doesNotMatch(c.opening, /Jump to content|Main menu/);
  assert.equal(c.sections, '4 Gemma 3 · 8 Model details · 10 Files · 12 License');
});

test('/web/ paths resolve to the in-memory web area', () => {
  const r = resolveAgentPath('/web/3.txt');
  assert.deepEqual(r, { area: 'web', rel: '3.txt' });
  assert.equal(agentPath(r), '/web/3.txt');
  assert.throws(() => resolveAgentPath('/web/../../etc'), /escapes/);
});
