import { test } from 'node:test';
import assert from 'node:assert/strict';
// bash.js reaches the workspace storage, which opens IndexedDB on import (as in failures.test.js).
globalThis.indexedDB = globalThis.indexedDB || { open: () => ({}) };
const { flags, elsewhere, ELSEWHERE, HELP } = await import('../app/src/tools/bash.js');

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

test('stand-ins: npm, tsc, pnpm, python… say they run on GitHub Actions and give the job line to copy', () => {
  const repo = { owner: 'k', name: 'app' };
  assert.match(elsewhere('npm', ['test'], repo), /^npm: doesn't run here[\s\S]*\n  job run -R k\/app -- "npm ci && npm test"\n/);
  assert.match(elsewhere('npm', ['install'], repo), /-- "npm install"/, 'an install needs no npm ci first');
  assert.match(elsewhere('tsc', ['--noEmit'], repo), /-- "npm ci && npx tsc --noEmit"/);
  assert.match(elsewhere('pnpm', ['run', 'lint'], repo), /-- "corepack enable && pnpm install && pnpm run lint"/);
  assert.match(elsewhere('yarn', [], repo), /-- "corepack enable && yarn"/);
  assert.match(elsewhere('python3', ['-c', 'print("hi $USER")'], repo), /-- "python3 -c 'print\(\\"hi \\\$USER\\"\)'"/, 'quoted so the line pastes as one command');
  assert.match(elsewhere('python', ['train.py'], repo), /no Python/);
  const loose = elsewhere('npm', ['test'], null);
  assert.match(loose, /job run -- "npm ci && npm test"\nAdd -R owner\/name/);
  for (const n of ['npm', 'npx', 'pnpm', 'yarn', 'tsc', 'python', 'python3', 'pip', 'pip3', 'sqlite3']) assert.ok(ELSEWHERE[n], n);
  assert.match(HELP.all, /Not here: npm, npx, pnpm, yarn, tsc, python, pip, sqlite3/);
});
