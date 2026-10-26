import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBranch, pushPolicy, grantKey, agentBranchName, resolveAgentPath, agentPath, parseRepo } from '../app/src/guard.js';

test('push policy: agent/ is free, everything else asks unless always-allowed', () => {
  const none = new Set();
  assert.equal(pushPolicy('Keal/app', 'agent/fix-login', none), 'free');
  assert.equal(pushPolicy('Keal/app', 'main', none), 'ask');
  assert.equal(pushPolicy('Keal/app', 'feature/agent/x', none), 'ask');
  assert.equal(pushPolicy('Keal/app', 'agentx/foo', none), 'ask');
  const grants = new Set([grantKey('Keal/App', 'main')]);
  assert.equal(pushPolicy('keal/app', 'main', grants), 'granted', 'repo match is case-insensitive');
  assert.equal(pushPolicy('Keal/app', 'release', grants), 'ask', 'grant is per branch');
  assert.equal(pushPolicy('Keal/other', 'main', grants), 'ask', 'grant is per repo');
  assert.equal(pushPolicy('Keal/app', 'Main', grants), 'ask', 'branch names are exact');
});

test('branch checks reject detached HEAD and malformed names', () => {
  assert.equal(checkBranch('main'), null);
  assert.equal(checkBranch('agent/x'), null);
  assert.match(checkBranch(null), /detached/);
  assert.match(checkBranch('agent/../main'), /valid/);
  assert.match(checkBranch('bad name'), /valid/);
});

test('branch names are normalized under agent/', () => {
  assert.equal(agentBranchName('Fix Login Bug!'), 'agent/fix-login-bug');
  assert.equal(agentBranchName('agent/already'), 'agent/already');
  assert.equal(agentBranchName('../../main'), 'agent/main');
  assert.equal(agentBranchName('x.lock'), 'agent/x-lock');
  assert.throws(() => agentBranchName('!!!'));
  for (const n of ['a b', '..', 'feat//x', '/lead', 'trail/']) {
    const b = agentBranchName(n === '..' ? 'dots..here' : n);
    assert.equal(checkBranch(b), null, n);
    assert.equal(pushPolicy('a/b', b, new Set()), 'free', n);
  }
});

test('workspace paths stay inside /home and /repos', () => {
  assert.deepEqual(resolveAgentPath('/home/notes.md'), { area: 'home', rel: 'notes.md' });
  assert.deepEqual(resolveAgentPath('notes.md'), { area: 'home', rel: 'notes.md' });
  assert.deepEqual(resolveAgentPath('~/a/b.txt'), { area: 'home', rel: 'a/b.txt' });
  assert.deepEqual(resolveAgentPath('/repos/app/src/x.js'), { area: 'repos', repo: 'app', rel: 'src/x.js' });
  assert.deepEqual(resolveAgentPath('/repos/app/../other/y'), { area: 'repos', repo: 'other', rel: 'y' });
  assert.equal(resolveAgentPath('/').area, 'root');
  assert.throws(() => resolveAgentPath('/home/../../etc'), /escapes/);
  assert.throws(() => resolveAgentPath('/state/sessions/x.json'), /outside the workspace/);
  assert.throws(() => resolveAgentPath('/repos/app/.git/config'), /\.git/);
  assert.throws(() => resolveAgentPath('/repos/../state'), /outside/);
  assert.equal(agentPath(resolveAgentPath('/repos/app/./src//x.js')), '/repos/app/src/x.js');
});

test('repo references', () => {
  assert.deepEqual(parseRepo('KealJones/squiggle'), { owner: 'KealJones', name: 'squiggle' });
  assert.deepEqual(parseRepo('https://github.com/a/b.git'), { owner: 'a', name: 'b' });
  assert.throws(() => parseRepo('just-a-name'));
  assert.throws(() => parseRepo('https://evil.com/a/b'));
});

test('workflow file changes are detected', async () => {
  const { touchesWorkflows } = await import('../app/src/guard.js');
  assert.deepEqual(touchesWorkflows(['src/a.js', '.github/workflows/ci.yml', '.github/dependabot.yml', 'docs/.github/workflows/x.yml']), ['.github/workflows/ci.yml']);
});
