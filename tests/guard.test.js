import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAgentBranch, agentBranchName, resolveAgentPath, agentPath, parseRepo } from '../app/src/guard.js';

test('agent may only commit/push agent/ branches', () => {
  assert.equal(checkAgentBranch('agent/fix-login'), null);
  assert.match(checkAgentBranch('main'), /not an agent branch/);
  assert.match(checkAgentBranch('feature/agent/x'), /not an agent branch/);
  assert.match(checkAgentBranch('agentx/foo'), /not an agent branch/);
  assert.match(checkAgentBranch(null), /detached/);
  assert.match(checkAgentBranch('agent/../main'), /valid/);
});

test('branch names are normalized under agent/', () => {
  assert.equal(agentBranchName('Fix Login Bug!'), 'agent/fix-login-bug');
  assert.equal(agentBranchName('agent/already'), 'agent/already');
  assert.equal(agentBranchName('../../main'), 'agent/main');
  assert.equal(agentBranchName('x.lock'), 'agent/x-lock');
  assert.throws(() => agentBranchName('!!!'));
  for (const n of ['a b', '..', 'feat//x', '/lead', 'trail/']) {
    assert.equal(checkAgentBranch(agentBranchName(n === '..' ? 'dots..here' : n)), null, n);
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
