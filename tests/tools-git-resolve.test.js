import test from 'node:test';
import assert from 'node:assert/strict';
import { completeRepo } from '../app/src/guard.js';

test('case 16: a partial repo is completed when one repo fits, from what the user said first, then their repos', async () => {
  const said = 'Can you pull GitHub.com/tester/app';
  assert.deepEqual(await completeRepo('tester', { said }), { owner: 'tester', name: 'app', completed: 'your message' });
  assert.deepEqual(await completeRepo('app', { said }), { owner: 'tester', name: 'app', completed: 'your message' });
  assert.deepEqual(await completeRepo('tester/app', { said }), { owner: 'tester', name: 'app' });
  assert.deepEqual(await completeRepo('tester', { said: 'clone tester/app please' }), { owner: 'tester', name: 'app', completed: 'your message' });
  const reachable = async () => ['tester/app', 'tester/bubbles'];
  assert.deepEqual(await completeRepo('bubbles', { reachable }), { owner: 'tester', name: 'bubbles', completed: 'your repos' });
  await assert.rejects(completeRepo('tester', { reachable }), /"tester" could be tester\/app, tester\/bubbles\. Call again/);
  await assert.rejects(completeRepo('nope', { reachable }), /Use owner\/name/);
  await assert.rejects(completeRepo('nope', { said: 'this and/or that' }), /Use owner\/name/, 'prose that looks like owner/name only counts when it fits the part named');
});
