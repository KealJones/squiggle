// tools/jobs.js against a fake GitHub: setup and run ask first, the command travels as an input (never pasted into
// the workflow), run ids come back, wait/status/logs/cancel, and the storage repo stays out of reach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runJob, stepOutput, JOB_YAML, JOB_PATH } from '../app/src/tools/jobs.js';
import { runGh } from '../app/src/tools/ghcli.js';

const RUN = (id, extra = {}) => ({
  id, name: 'Squiggle job', display_title: 'Squiggle job: npm test', status: 'completed', conclusion: 'success', path: JOB_PATH,
  html_url: `https://github.com/k/bubbles/actions/runs/${id}`, created_at: '2026-11-14T16:00:00Z', run_started_at: '2026-11-14T16:00:00Z', updated_at: '2026-11-14T16:03:05Z', ...extra,
});
const LOG = [
  '﻿2026-11-14T16:00:01.1Z Current runner version: \'2.338.2\'',
  '2026-11-14T16:00:02.1Z ##[group]Run actions/checkout@v4', '2026-11-14T16:00:02.2Z with:', '2026-11-14T16:00:02.3Z ##[endgroup]',
  '2026-11-14T16:00:05.0Z ##[group]Run bash -eo pipefail -c "$COMMAND"', '2026-11-14T16:00:05.1Z env:', '2026-11-14T16:00:05.2Z   COMMAND: npm test', '2026-11-14T16:00:05.3Z ##[endgroup]',
  '2026-11-14T16:00:06.0Z > bubbles@1.0.0 test', '2026-11-14T16:03:00.0Z # pass 41', '2026-11-14T16:03:00.1Z ##[error]Process completed with exit code 1.',
  '2026-11-14T16:03:01.0Z Post job cleanup.', '2026-11-14T16:03:01.1Z [command]/usr/bin/git version',
].join('\n');

function fake({ approve = async () => 'once', installed = true, runs = {}, dispatch = { workflow_run_id: 77, html_url: 'https://github.com/k/bubbles/actions/runs/77' } } = {}) {
  const calls = [], asked = [];
  const env = {
    repo: { owner: 'k', name: 'bubbles' }, branch: 'main',
    approve: async (req) => { asked.push(req); return approve(req); },
    isStorage: (o, n) => o === 'k' && n === 'squiggle-state',
    sleep: async () => {},
    logs: async (o, n, jobId) => { calls.push({ method: 'LOGS', path: `${o}/${n}/${jobId}` }); return LOG; },
    gh: async (path, opts = {}) => {
      const method = opts.method || 'GET';
      calls.push({ method, path, body: opts.body });
      if (method === 'GET' && path === '/repos/k/bubbles') return { default_branch: 'main', full_name: 'k/bubbles' };
      if (method === 'GET' && path === `/repos/k/bubbles/contents/${JOB_PATH}`) {
        if (installed) return { content: btoa(JOB_YAML) };
        const e = new Error('Not Found'); e.status = 404; throw e;
      }
      if (method === 'PUT') { installed = true; return {}; }
      if (method === 'POST' && path.endsWith('/dispatches')) return dispatch;
      let m;
      if ((m = /^\/repos\/k\/bubbles\/actions\/runs\/(\d+)$/.exec(path))) { const r = runs[m[1]]; if (!r) { const e = new Error('Not Found'); e.status = 404; throw e; } return typeof r === 'function' ? r() : r; }
      if ((m = /^\/repos\/k\/bubbles\/actions\/runs\/(\d+)\/jobs/.exec(path))) return { jobs: [{ id: 900 + +m[1], name: 'run', steps: [{ name: 'Run', status: 'completed' }] }] };
      if (path.startsWith('/repos/k/bubbles/actions/workflows/squiggle-job.yml/runs')) return { workflow_runs: Object.values(runs).map(r => (typeof r === 'function' ? r() : r)) };
      if (method === 'POST') return null;
      const e = new Error('Not Found'); e.status = 404; throw e;
    },
  };
  return { env, calls, asked, run: (...argv) => runJob(argv, env) };
}

test('job setup: asks, then adds the workflow on the default branch; a second setup sees it there', async () => {
  const { run, calls, asked } = fake({ installed: false });
  const r = await run('setup');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(asked.length, 1);
  assert.match(asked[0].title, /Add a job runner to k\/bubbles/);
  const put = calls.find(c => c.method === 'PUT');
  assert.equal(put.path, `/repos/k/bubbles/contents/${JOB_PATH}`);
  assert.equal(put.body.branch, 'main');
  assert.equal(atob(put.body.content), JOB_YAML);
  assert.match((await run('setup')).stdout, /already has the job runner/);
  assert.equal(asked.length, 1, 'no second card');
});

test('job setup: a "no" leaves the repo alone and says not to retry', async () => {
  const { run, calls } = fake({ installed: false, approve: async () => 'deny' });
  const r = await run('setup');
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /did not allow[\s\S]*Don't try again/);
  assert.ok(!calls.some(c => c.method === 'PUT'));
});

test('the workflow hands the command to bash through env, never into the script', () => {
  assert.match(JOB_YAML, /COMMAND: \$\{\{ inputs\.command \}\}/);
  assert.match(JOB_YAML, /run: bash -eo pipefail -c "\$COMMAND"/);
  assert.ok(!/run:.*inputs\.command/.test(JOB_YAML));
  assert.match(JOB_YAML, /^on:\n  workflow_dispatch:/m);
  assert.match(JOB_YAML, /permissions:\n  contents: read/);
});

test('job run: asks with the command, dispatches it as an input and prints the run id', async () => {
  const { run, calls, asked } = fake();
  const r = await run('run', '-t', 'tests', '--timeout', '900', '--', 'npm ci && npm test');
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(asked[0].title, /Run a job on GitHub Actions in k\/bubbles/);
  assert.equal(asked[0].details[0], 'npm ci && npm test');
  const post = calls.find(c => c.path.endsWith('/dispatches'));
  assert.equal(post.path, '/repos/k/bubbles/actions/workflows/squiggle-job.yml/dispatches');
  assert.deepEqual(post.body, { ref: 'main', inputs: { command: 'npm ci && npm test', title: 'tests', timeout: '360' }, return_run_details: true });
  assert.match(r.stdout, /^Started job 77 in k\/bubbles: https:\/\/github\.com\/k\/bubbles\/actions\/runs\/77\n[\s\S]*job logs 77 -R k\/bubbles/);
});

test('job run: no runner yet says to run job setup; no command, no card', async () => {
  const a = fake({ installed: false });
  const r = await a.run('run', '--', 'make');
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /no job runner yet[\s\S]*job setup -R k\/bubbles/);
  assert.equal(a.asked.length, 0);
  const b = fake();
  assert.match((await b.run('run')).stderr, /give the command after --/);
  assert.equal(b.asked.length, 0);
});

test('job run: when GitHub returns no run details, finds the run by its title', async () => {
  const { run } = fake({ dispatch: null, runs: { 88: RUN(88, { display_title: 'Squiggle job: make all', status: 'queued', conclusion: null }) } });
  assert.match((await run('run', '--', 'make', 'all')).stdout, /^Started job 88 in k\/bubbles/);
});

test('job status / wait / logs / cancel; only Squiggle job runs', async () => {
  let polls = 0;
  const { run, calls } = fake({ runs: {
    5: RUN(5),
    6: () => (++polls < 3 ? RUN(6, { status: 'in_progress', conclusion: null }) : RUN(6)),
    7: RUN(7, { status: 'in_progress', conclusion: null }),
    8: RUN(8, { name: 'CI', path: '.github/workflows/ci.yml' }),
  } });
  assert.match((await run('status', '5')).stdout, /^5\tcompleted\tsuccess\t3m5s\tnpm test\n[\s\S]*exited 0/);
  assert.match((await run('wait', '6')).stdout, /Done: success\. Output: job logs 6/);
  const logs = await run('logs', '5');
  assert.equal(logs.stdout, '> bubbles@1.0.0 test\n# pass 41\nError: Process completed with exit code 1.\n');
  assert.ok(calls.some(c => c.method === 'LOGS' && c.path === 'k/bubbles/905'));
  assert.match((await run('logs', '5', '--raw')).stdout, /Current runner version/);
  const early = await run('logs', '7');
  assert.equal(early.exitCode, 1);
  assert.match(early.stderr, /in_progress[\s\S]*once it finishes/);
  assert.match((await run('cancel', '7')).stdout, /Cancelling job 7/);
  assert.ok(calls.some(c => c.method === 'POST' && c.path === '/repos/k/bubbles/actions/runs/7/cancel'));
  assert.match((await run('status', '8')).stderr, /isn't a Squiggle job/);
  assert.match((await run('status')).stderr, /give the run id/);
});

test('job list, help, and the storage repo is refused', async () => {
  const { run } = fake({ runs: { 5: RUN(5) } });
  assert.match((await run('list')).stdout, /^ID\tSTATUS\tRESULT\tTIME\tTITLE\n5\tcompleted\tsuccess/);
  assert.match((await run()).stdout, /^job: run a long command on GitHub Actions/);
  const s = await run('list', '-R', 'k/squiggle-state');
  assert.equal(s.exitCode, 1);
  assert.match(s.stderr, /storage repo/);
});

test('stepOutput keeps only the command\'s own lines; a log without the step comes back whole', () => {
  assert.equal(stepOutput(LOG), '> bubbles@1.0.0 test\n# pass 41\nError: Process completed with exit code 1.');
  assert.equal(stepOutput('2026-11-14T16:00:01.1Z hello\n'), 'hello');
});

test('gh workflow run asks, dispatches with inputs and prints the run; gh run view --log reads through the relay', async () => {
  const asked = [], calls = [];
  const env = {
    repo: { owner: 'k', name: 'bubbles' }, approve: async (q) => { asked.push(q); return 'once'; },
    logs: async () => '2026-11-14T16:00:06.0Z hi\n',
    gh: async (path, opts = {}) => {
      calls.push({ method: opts.method || 'GET', path, body: opts.body });
      if (path === '/repos/k/bubbles') return { default_branch: 'main' };
      if (path.endsWith('/dispatches')) return { workflow_run_id: 9, html_url: 'https://github.com/k/bubbles/actions/runs/9' };
      if (path === '/repos/k/bubbles/actions/workflows?per_page=100') return { workflows: [{ id: 3, name: 'Deploy', path: '.github/workflows/deploy.yml' }] };
      if (path === '/repos/k/bubbles/actions/runs/9') return RUN(9, { name: 'Deploy', head_branch: 'main', event: 'workflow_dispatch' });
      if (path.startsWith('/repos/k/bubbles/actions/runs/9/jobs')) return { jobs: [{ id: 1, name: 'build', conclusion: 'success', steps: [] }] };
      return {};
    },
  };
  const r = await runGh(['workflow', 'run', 'Deploy', '-f', 'env=prod'], env);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(asked[0].title, /Run workflow Deploy in k\/bubbles/);
  assert.deepEqual(calls.find(c => c.path.endsWith('/dispatches')), { method: 'POST', path: '/repos/k/bubbles/actions/workflows/3/dispatches', body: { ref: 'main', inputs: { env: 'prod' }, return_run_details: true } });
  assert.match(r.stdout, /gh run view 9/);
  assert.equal((await runGh(['run', 'view', '9', '--log'], env)).stdout, 'build\t2026-11-14T16:00:06.0Z hi\n');
});
