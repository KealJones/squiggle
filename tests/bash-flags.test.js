import { test } from 'node:test';
import assert from 'node:assert/strict';
// bash.js reaches the workspace storage, which opens IndexedDB on import (as in failures.test.js).
globalThis.indexedDB = globalThis.indexedDB || { open: () => ({}) };
const { flags } = await import('../app/src/tools/bash.js');

test('flags: short options together, as git and curl are usually written', () => {
  assert.deepEqual(flags(['-am', 'Remove README'], ['m', 'message']), { _: [], a: true, m: 'Remove README' });
  assert.deepEqual(flags(['-a', '-m', 'x'], ['m']), { _: [], a: true, m: 'x' });
  assert.deepEqual(flags(['-sSL', 'https://e.test'], ['o']), { _: ['https://e.test'], s: true, S: true, L: true });
  assert.deepEqual(flags(['-sX', 'POST', 'https://e.test'], ['X']), { _: ['https://e.test'], s: true, X: 'POST' });
});

test('flags: what already worked keeps working', () => {
  assert.deepEqual(flags(['--title', 'T', '--body=B'], ['title', 'body']), { _: [], title: 'T', body: 'B' });
  assert.deepEqual(flags(['-title', 'T'], ['title']), { _: [], title: 'T' }, 'a one-dash long name it knows');
  assert.deepEqual(flags(['--show-current']), { _: [], 'show-current': true });
  assert.equal(flags(['-5'], ['n'])['5'], true, 'git log -5 is read by log itself');
});
