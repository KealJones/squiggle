// `job` in the bash tool: run a long command on GitHub Actions instead of in the browser (builds, test suites,
// Python, anything that takes minutes or needs a real Linux box). The run keeps going after the chat turn ends, on
// any device, and the agent checks on it later by run id.
//
//   job setup [-R owner/name]       adds .github/workflows/squiggle-job.yml (asks the user; workflow changes always do)
//   job run [-R …] [--ref b] [--timeout MIN] [-t TITLE] -- COMMAND   starts it (asks the user), prints the run id
//   job list | status ID | wait ID [--max SEC] | logs ID [--raw] | cancel ID
//
// env: the same shape ghcli.js gets ({ gh, repo, approve, isStorage }) plus logs(owner, name, jobId) (the relay:
// GitHub's log downloads send no CORS headers) and sleep(ms) (tests pass a fake). The command reaches GitHub as a
// workflow input and the workflow hands it to bash through an environment variable, never pasted into the script,
// so nothing in it is evaluated by Actions' own ${{ }} templating.
import { repoOf } from './ghcli.js';

export const JOB_WORKFLOW = 'squiggle-job.yml';
export const JOB_PATH = `.github/workflows/${JOB_WORKFLOW}`;
export const JOB_YAML = `# Squiggle's job runner: runs one shell command on GitHub Actions when Squiggle starts it (\`job run\` in its
# bash tool). It never runs on its own (workflow_dispatch only) and gets a read-only token.
name: Squiggle job
run-name: "Squiggle job: \${{ inputs.title }}"
on:
  workflow_dispatch:
    inputs:
      command:
        description: Shell command (bash, from the repo's root)
        required: true
      title:
        description: Short name for the Actions list
        required: false
        default: job
      timeout:
        description: Minutes before GitHub stops it (at most 360)
        required: false
        default: "60"
permissions:
  contents: read
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: \${{ fromJSON(inputs.timeout) }}
    steps:
      - uses: actions/checkout@v4
      - name: Run
        env:
          COMMAND: \${{ inputs.command }}
        run: bash -eo pipefail -c "$COMMAND"
`;

export const JOB_HELP = `job: run a long command on GitHub Actions (a real Linux machine) instead of here. It keeps running after
your turn ends; check on it later with its run id. Good for builds, test suites, Python, anything slow.
  job setup [-R owner/name]                 add the job runner to a repo (once per repo; the user is asked)
  job run [-R owner/name] [--ref branch] [--timeout MIN] [-t TITLE] -- COMMAND
                                            start COMMAND (bash, in a checkout of the repo); prints the run id
  job status ID      queued / in_progress / completed, and how long
  job wait ID [--max SEC]                   wait up to SEC seconds (default 45) for it to finish
  job logs ID [--raw]                       its output, once finished (--raw: GitHub's whole log)
  job list   job cancel ID
The repo is the one you're in (/repos/<name>) unless -R names it. The user is asked before setup and before each run.
  job run -R me/app -t tests -- "npm ci && npm test"     then: job wait 123456 ; job logs 123456 | tail -40`;

const ok = (stdout = '') => ({ stdout: stdout && !stdout.endsWith('\n') ? stdout + '\n' : stdout, stderr: '', exitCode: 0 });
const fail = (stderr, exitCode = 1) => ({ stdout: '', stderr: stderr.endsWith('\n') ? stderr : stderr + '\n', exitCode });
class JobError extends Error {}

const b64 = (s) => { let bin = ''; for (const c of new TextEncoder().encode(s)) bin += String.fromCharCode(c); return btoa(bin); };
const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(String(s).replace(/\n/g, '')), c => c.charCodeAt(0)));
const took = (a, b) => { if (!a) return ''; const s = Math.max(0, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}h${Math.floor(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`; };

// -R/--repo, --ref, --timeout, -t/--title, --max take a value; `--` ends the options and the rest is the command.
function parse(argv) {
  const o = { _: [] };
  const valued = { R: 'repo', repo: 'repo', ref: 'ref', timeout: 'timeout', t: 'title', title: 'title', max: 'max' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.rest = argv.slice(i + 1); break; }
    const m = /^--?([A-Za-z]+)(?:=(.*))?$/.exec(a);
    if (m && valued[m[1]]) { o[valued[m[1]]] = m[2] !== undefined ? m[2] : argv[++i]; continue; }
    if (m) { o[m[1]] = true; continue; }
    o._.push(a);
  }
  return o;
}

async function ask(env, req) {
  if (typeof env.approve !== 'function') throw new JobError(`${req.title} needs the user's approval, and no one is here to approve it.`);
  const d = await env.approve({ kind: 'action', ...req });
  if (d !== 'once' && d !== 'always') throw new JobError(`The user did not allow this (${req.title}). Don't try again; ask them how they'd like to proceed.`);
}

async function installed(env, r) {
  try { return await env.gh(`${r.path}/contents/${JOB_PATH}`); } catch (e) { if (e.status === 404) return null; throw e; }
}
const runId = (o) => { const id = o._[1]; if (!/^\d+$/.test(String(id || ''))) throw new JobError(`give the run id (job list shows them), e.g. job ${o._[0]} 123456`); return id; };
const notRunner = (run) => run.path && !run.path.endsWith(JOB_PATH);

async function getRun(env, r, id) {
  const run = await env.gh(`${r.path}/actions/runs/${id}`);
  if (notRunner(run)) throw new JobError(`run ${id} isn't a Squiggle job (it's "${run.name}"); gh run view ${id} shows it`);
  return run;
}
const line = (run) => [run.id, run.status, run.conclusion || '-', took(run.run_started_at || run.created_at, run.status === 'completed' ? run.updated_at : null), run.display_title.replace(/^Squiggle job: /, '')].join('\t');

// The Run step's output: GitHub's log has the runner's setup, the checkout and cleanup around it, a timestamp on
// every line, and ##[group] markers.
export function stepOutput(log) {
  const lines = String(log || '').replace(/^﻿/, '').split(/\r?\n/).map(l => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ''));
  let start = lines.findIndex(l => /^##\[group\]Run bash -eo pipefail/.test(l));
  if (start < 0) return lines.join('\n').trim();
  while (start < lines.length && lines[start] !== '##[endgroup]') start++;
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^Post job cleanup\./.test(l) || /^##\[group\]Run actions\//.test(l)) break;
    if (/^##\[(end)?group\]/.test(l)) continue;
    out.push(l.replace(/^##\[error\]/, 'Error: ').replace(/^##\[warning\]/, 'Warning: '));
  }
  return out.join('\n').trim();
}

const SUB = {
  async setup(env, o) {
    const r = repoOf(env, o);
    const have = await installed(env, r);
    if (have) {
      const same = have.content && unb64(have.content) === JOB_YAML;
      return ok(same ? `${r.full} already has the job runner (${JOB_PATH}).` : `${r.full} already has ${JOB_PATH} (a different version, left as it is).`);
    }
    const info = await env.gh(r.path);
    await ask(env, {
      title: `Add a job runner to ${r.full}`,
      details: [`Adds ${JOB_PATH} on ${info.default_branch}, so Squiggle can run long commands on GitHub Actions in this repo.`,
        'It only runs when Squiggle starts it (and you approve each run), with a read-only token.'],
    });
    await env.gh(`${r.path}/contents/${JOB_PATH}`, { method: 'PUT', body: { message: 'Add Squiggle job runner', content: b64(JOB_YAML), branch: info.default_branch } });
    return ok(`Added ${JOB_PATH} to ${r.full} (${info.default_branch}). Start a job: job run -R ${r.full} -- "COMMAND"`);
  },

  async run(env, o) {
    const r = repoOf(env, o);
    const command = (o.rest || o._.slice(1)).join(' ').trim();
    if (!command) throw new JobError('give the command after --, e.g. job run -- "npm ci && npm test"');
    if (!(await installed(env, r))) return fail(`${r.full} has no job runner yet. Add it first: job setup -R ${r.full} (the user is asked), then run this again.`);
    const timeout = Math.max(1, Math.min(360, Math.round(+o.timeout || 60)));
    const ref = o.ref || (await env.gh(r.path)).default_branch;
    const title = String(o.title || command).replace(/\s+/g, ' ').slice(0, 60);
    await ask(env, { title: `Run a job on GitHub Actions in ${r.full}`, details: [command.slice(0, 600), `On ${ref}, stopped after ${timeout} minutes if still going.`] });
    const started = new Date(Date.now() - 5000).toISOString();
    const res = await env.gh(`${r.path}/actions/workflows/${JOB_WORKFLOW}/dispatches`, { method: 'POST', body: { ref, inputs: { command, title, timeout: String(timeout) }, return_run_details: true } });
    let id = res && res.workflow_run_id, url = res && res.html_url;
    // Older GitHub answers 204 with no run: find it by title among the runs created since.
    for (let i = 0; !id && i < 8; i++) {
      await env.sleep(2000);
      const runs = (await env.gh(`${r.path}/actions/workflows/${JOB_WORKFLOW}/runs?event=workflow_dispatch&created=${encodeURIComponent('>=' + started)}&per_page=10`)).workflow_runs || [];
      const found = runs.find(x => x.display_title === `Squiggle job: ${title}`);
      if (found) ({ id, html_url: url } = found);
    }
    if (!id) return ok(`Started a job in ${r.full}, but GitHub hasn't listed its run yet. job list -R ${r.full} shows it in a moment.`);
    return ok(`Started job ${id} in ${r.full}: ${url}\nIt keeps running on its own. Check it: job status ${id} -R ${r.full}   wait: job wait ${id} -R ${r.full}   output when done: job logs ${id} -R ${r.full}`);
  },

  async list(env, o) {
    const r = repoOf(env, o);
    let runs;
    try { runs = (await env.gh(`${r.path}/actions/workflows/${JOB_WORKFLOW}/runs?per_page=10`)).workflow_runs || []; } catch (e) { if (e.status === 404) return ok(`${r.full} has no job runner (job setup adds it).`); throw e; }
    if (!runs.length) return ok(`No jobs in ${r.full} yet.`);
    return ok(['ID\tSTATUS\tRESULT\tTIME\tTITLE', ...runs.map(line)].join('\n'));
  },

  async status(env, o) {
    const r = repoOf(env, o);
    const run = await getRun(env, r, runId(o));
    const jobs = (await env.gh(`${r.path}/actions/runs/${run.id}/jobs`)).jobs || [];
    const steps = jobs.flatMap(j => j.steps || []).filter(s => s.name === 'Run');
    const out = [line(run), run.html_url];
    if (run.status !== 'completed') out.push(steps[0] && steps[0].status === 'in_progress' ? 'The command is running.' : 'Starting up (the machine and checkout come first).');
    else out.push(run.conclusion === 'success' ? 'Finished: the command exited 0.' : run.conclusion === 'cancelled' ? 'Cancelled (by someone, or it hit its timeout).' : `Finished: ${run.conclusion}. job logs ${run.id} shows why.`);
    return ok(out.join('\n'));
  },

  async wait(env, o) {
    const r = repoOf(env, o);
    const id = runId(o);
    const max = Math.max(5, Math.min(50, +o.max || 45));   // the bash tool stops any command at 60 s
    const until = Date.now() + max * 1000;
    let run = await getRun(env, r, id);
    while (run.status !== 'completed' && Date.now() + 10000 <= until) { await env.sleep(10000); run = await getRun(env, r, id); }
    const rr = o.repo ? ` -R ${r.full}` : '';
    if (run.status !== 'completed') return ok(`${line(run)}\nStill going after ${max} s. It doesn't need you here: check again later with job status ${id}${rr}.`);
    return ok(`${line(run)}\nDone: ${run.conclusion}. Output: job logs ${id}${rr}`);
  },

  async logs(env, o) {
    const r = repoOf(env, o);
    const run = await getRun(env, r, runId(o));
    if (run.status !== 'completed') return fail(`job ${run.id} is ${run.status} (${took(run.run_started_at || run.created_at)}). GitHub serves the output once it finishes: job wait ${run.id}, or check back later.`);
    const jobs = (await env.gh(`${r.path}/actions/runs/${run.id}/jobs`)).jobs || [];
    if (!jobs.length) return fail(`job ${run.id} ended (${run.conclusion}) before its machine started; nothing ran.`);
    if (!env.logs) return fail('Reading logs needs the relay, which isn\'t set up here.');
    const text = await env.logs(r.owner, r.name, jobs[0].id);
    return ok(o.raw ? text : stepOutput(text) || '(the command printed nothing)');
  },

  async cancel(env, o) {
    const r = repoOf(env, o);
    const run = await getRun(env, r, runId(o));
    if (run.status === 'completed') return ok(`job ${run.id} already finished (${run.conclusion}).`);
    await env.gh(`${r.path}/actions/runs/${run.id}/cancel`, { method: 'POST' });
    return ok(`Cancelling job ${run.id}.`);
  },
};

export async function runJob(argv, env) {
  const o = parse(argv);
  const sub = o._[0];
  try {
    if (!sub || sub === 'help' || o.help || o.h) return ok(JOB_HELP);
    if (!SUB[sub]) return fail(`job: unknown subcommand "${sub}". Use: setup, run, list, status, wait, logs, cancel (job --help)`);
    return await SUB[sub](env, o);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (e && e.status === 404) return fail(`job: not found (${msg}). Check the run id and repo, and that Squiggle has access to it (Settings → Manage repo access).`);
    if (e && e.status === 403 && /workflow/i.test(msg)) return fail(`job: GitHub refused (${msg}). Squiggle's GitHub App needs the Actions and Workflows permissions (docs/setup.md).`);
    return fail(`job: ${msg}${e && e.status ? ` (HTTP ${e.status})` : ''}`);
  }
}
