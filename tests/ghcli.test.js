// tools/ghcli.js against a fake GitHub: gh's formats, --json/--jq, approvals for merges and API writes, and the
// storage repo out of reach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGh } from '../app/src/tools/ghcli.js';

const PR = (n, extra = {}) => ({
  number: n, title: `PR ${n}`, body: `body ${n}`, state: 'open', merged_at: null, html_url: `https://github.com/k/bubbles/pull/${n}`,
  head: { ref: `agent/b${n}`, sha: `sha${n}`, repo: { full_name: 'k/bubbles' } }, base: { ref: 'main', repo: { full_name: 'k/bubbles' } },
  user: { login: 'k' }, created_at: '2026-11-12T19:00:00Z', labels: [], assignees: [], requested_reviewers: [], draft: false, node_id: `PR_${n}`, ...extra,
});

function fake({ approve } = {}) {
  const calls = [];
  const routes = {
    'GET /repos/k/bubbles': { default_branch: 'main', full_name: 'k/bubbles', html_url: 'https://github.com/k/bubbles' },
    'GET /repos/k/bubbles/pulls?state=open&per_page=30&sort=created&direction=desc': [PR(2), PR(1)],
    'GET /repos/k/bubbles/pulls?state=closed&per_page=30&sort=created&direction=desc': [PR(3, { state: 'closed', merged_at: '2026-11-11T00:00:00Z' }), PR(4, { state: 'closed' })],
    'GET /repos/k/bubbles/pulls/1': PR(1),
    'GET /repos/k/bubbles/pulls?state=all&head=k%3Aagent%2Fb1&per_page=5': [PR(1)],
    'GET /repos/k/bubbles/issues?state=open&per_page=60': [{ number: 9, title: 'Bug', state: 'open', labels: [{ name: 'bug' }], updated_at: '2026-11-12T00:00:00Z', html_url: 'u9' }, { number: 1, title: 'PR 1', pull_request: {}, state: 'open', labels: [] }],
  };
  const env = {
    repo: { owner: 'k', name: 'bubbles' }, branch: 'agent/b1', login: async () => 'k', approve,
    isStorage: (o, n) => o.toLowerCase() === 'k' && n.toLowerCase() === 'squiggle-state', storageName: 'squiggle-state',
    exec: async (cmd, { stdin }) => { const m = /jq -r '(.*)'$/.exec(cmd); const data = JSON.parse(stdin); return { stdout: m[1] === '.[].number' ? data.map(x => x.number).join('\n') + '\n' : '', stderr: '', exitCode: 0 }; },
    gh: async (path, opts = {}) => {
      const method = opts.method || 'GET';
      calls.push({ method, path, body: opts.body });
      const key = `${method} ${path}`;
      if (key in routes) return routes[key];
      if (method === 'POST' && path === '/repos/k/bubbles/pulls') return PR(5, { title: opts.body.title, html_url: 'https://github.com/k/bubbles/pull/5' });
      if (method === 'PUT' || method === 'PATCH' || method === 'POST' || method === 'DELETE') return {};
      const e = new Error('Not Found'); e.status = 404; throw e;
    },
  };
  return { env, calls, run: (line) => runGh(line.match(/"[^"]*"|'[^']*'|\S+/g).map(s => s.replace(/^["']|["']$/g, '')), env) };
}

test('gh pr list: gh\'s tab-separated rows, --state merged, --json fields, --jq through jq', async () => {
  const { run } = fake();
  assert.equal((await run('pr list')).stdout, '2\tPR 2\tagent/b2\tOPEN\t2026-11-12T19:00:00Z\n1\tPR 1\tagent/b1\tOPEN\t2026-11-12T19:00:00Z\n');
  assert.match((await run('pr list --state merged')).stdout, /^3\tPR 3\tagent\/b3\tMERGED/);
  const j = JSON.parse((await run('pr list --json number,title,headRefName,state')).stdout);
  assert.deepEqual(j[0], { number: 2, title: 'PR 2', headRefName: 'agent/b2', state: 'OPEN' });
  assert.equal((await run("pr list --json number --jq '.[].number'")).stdout, '2\n1\n');
  const bad = await run('pr list --json nope');
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /Unknown JSON field: "nope"[\s\S]*headRefName/);
});

test('gh pr view: by number or the current branch; pr create posts the PR with the Squiggle footer', async () => {
  const { run, calls } = fake();
  assert.match((await run('pr view 1')).stdout, /^title:\tPR 1\nstate:\tOPEN\n[\s\S]*number:\t1\n[\s\S]*--\nbody 1\n$/);
  assert.match((await run('pr view')).stdout, /number:\t1/, 'the current branch agent/b1 has PR 1');
  assert.equal((await run('pr create --title "Cleanup" --body "Removes a file"')).stdout, 'https://github.com/k/bubbles/pull/5\n');
  const post = calls.find(c => c.method === 'POST' && c.path === '/repos/k/bubbles/pulls');
  assert.deepEqual(post.body, { title: 'Cleanup', body: 'Removes a file\n\n_Opened by Squiggle._', head: 'agent/b1', base: 'main', draft: false });
  assert.match((await run('pr create --body x')).stderr, /must provide `--title`/);
});

test('gh pr edit and comment change the PR without asking; pr merge asks first, and a no stops it', async () => {
  const asked = [];
  let answer = 'deny';
  const { run, calls } = fake({ approve: async (req) => { asked.push(req); return answer; } });
  await run('pr edit 1 --body "New body" --add-label cleanup');
  assert.ok(calls.some(c => c.method === 'PATCH' && c.path === '/repos/k/bubbles/pulls/1' && c.body.body === 'New body'));
  assert.ok(calls.some(c => c.method === 'POST' && c.path === '/repos/k/bubbles/issues/1/labels'));
  await run('pr comment 1 --body hi');
  assert.equal(asked.length, 0);
  const no = await run('pr merge 1 --squash');
  assert.equal(no.exitCode, 1);
  assert.match(no.stderr, /did not allow/);
  assert.equal(asked[0].title, 'Merge PR #1 into main in k/bubbles');
  assert.ok(!calls.some(c => c.method === 'PUT'), 'nothing merged');
  answer = 'once';
  assert.match((await run('pr merge 1 --squash -d')).stdout, /Squashed and merged pull request k\/bubbles#1[\s\S]*Deleted branch agent\/b1/);
  assert.deepEqual(calls.find(c => c.method === 'PUT').body, { merge_method: 'squash' });
  assert.ok(calls.some(c => c.method === 'DELETE' && c.path === '/repos/k/bubbles/git/refs/heads/agent/b1'));
});

test('gh pr merge with no one to ask refuses (an unattended run never merges)', async () => {
  const { run, calls } = fake();
  const r = await run('pr merge 1');
  assert.match(r.stderr, /needs the user's approval, and no one is here/);
  assert.ok(!calls.some(c => c.method === 'PUT'));
});

test('gh api: reads run, writes ask, {owner}/{repo} fill in, -f makes it a POST like gh', async () => {
  const asked = [];
  const { run, calls } = fake({ approve: async (req) => { asked.push(req); return 'once'; } });
  await run('api repos/{owner}/{repo}/pulls/1');
  assert.equal(calls.at(-1).path, '/repos/k/bubbles/pulls/1');
  assert.equal(asked.length, 0);
  await run('api repos/{owner}/{repo}/issues -f title=Hi -F draft=true');
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/repos/k/bubbles/issues', body: { title: 'Hi', draft: true } });
  assert.equal(asked[0].title, 'POST /repos/k/bubbles/issues on GitHub');
  await run('api -X GET search/issues -f q=bug');
  assert.equal(calls.at(-1).path, '/search/issues?q=bug');
  assert.equal(asked.length, 1, 'a GET with fields is still a read');
});

test('gh: the storage repo is out of reach (by name, by -R, by numeric id, by search)', async () => {
  const { run, calls } = fake({ approve: async () => 'once' });
  const gq = await runGh(['api', 'graphql', '-f', 'query={ repository(owner: "k", name: "squiggle-state") { id } }'], fake().env);
  assert.match(gq.stderr, /storage repo/);
  for (const line of ['api repos/k/squiggle-state/contents/memory', 'api repos/K/Squiggle-State', 'api repositories/123/contents', 'pr list -R k/squiggle-state', 'repo view k/squiggle-state', 'search repos squiggle-state']) {
    const r = await run(line);
    assert.equal(r.exitCode, 1, line);
    assert.match(r.stderr, /storage repo/, line);
  }
  assert.equal(calls.length, 0);
});

test('gh issue list leaves pull requests out; unknown commands list what is available', async () => {
  const { run } = fake();
  assert.equal((await run('issue list')).stdout, '9\tOPEN\tBug\tbug\t2026-11-12T00:00:00Z\n');
  assert.match((await run('pr frob')).stderr, /Available here: list, view, create/);
  assert.match((await run('auth token')).stderr, /never shown/);
});
