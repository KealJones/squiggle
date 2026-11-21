// A/B battery: the same cases, the same model, two checkouts of Squiggle — so a harness change can be shown to
// help (or not) instead of argued about. Adapted from Hermes Agent's `evals/core_tool_deferral` harness
// (github.com/NousResearch/hermes-agent, MIT), which runs two pinned checkouts over a task battery and grades
// accuracy, turns, tokens and wall per cell. What is kept from it: two arms from real checkouts, repetitions per
// cell, partial credit per case, efficiency reported beside accuracy, and the discipline below. What is
// different: Squiggle's "agent" is the browser app, so an arm is a checkout whose `app/` is served to the browser
// (SQUIGGLE_APP_DIR) while the graders, the cases and this runner all come from the checkout ab.mjs runs in —
// both arms are therefore scored by exactly one copy of the harness, and a branch cannot flatter itself by
// editing its own cases. What an arm does *not* swap: worker/ (the relay) and tests/ itself, so a change there
// isn't what ab.mjs measures. The model is local, so cells run one at a time and the budget is wall-clock, not
// dollars.
//
//   node tests/eval/ab.mjs --base <dir> --pr <dir> [--model KLF3] [--reps 3] [--set cases.json]
//        [--cases 1,2] [--mode compact] [--timeout 300] [--results docs/evals/ab-<date>] [--fresh] [--fake]
//
// Each cell is (arm, rep): one run.mjs over the whole case set, its JSON kept under --results. Cells are skipped
// when their file is already there, so a stopped battery picks up where it left off (--fresh re-runs them).
//
// Discipline (from that harness; the reasons are the same here):
// - Same denominator: a case that timed out or errored scores 0 and stays in the score denominator. It is left
//   out of the rounds and wall means, where it would otherwise look like a win (a crash is fast).
// - Interactive fairness: a reply that ends by asking the user gets the case's scripted answer (run.mjs
//   `replies`), at most twice. Scoring an honest question as a failure poisons the battery.
// - Contested cells: when the arms differ on a case at --reps 3, the report says to re-run that case at 6 before
//   concluding anything. One run of a small model is noise, not a result.
// - Read the transcripts of anything surprising: every cell's JSON keeps each turn, its tools and the reply.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const arg = (n, d) => process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d;
const has = (n) => process.argv.includes(n);
const BASE = arg('--base', ''), PR = arg('--pr', '');
const MODEL = arg('--model', 'KLF3'), MODE = arg('--mode', 'compact'), SET = arg('--set', 'cases.json');
const REPS = Number(arg('--reps', 3));
const CASES = arg('--cases', '');
const RESULTS = resolve(arg('--results', `docs/evals/ab-${new Date().toISOString().slice(0, 10)}-${MODEL}`));
if (!BASE || !PR) { console.error('--base <dir> and --pr <dir> are both needed (two checkouts; `git worktree add` makes one)'); process.exit(2); }
for (const dir of [BASE, PR]) if (!existsSync(join(dir, 'app/index.html'))) { console.error(`${dir} is not a Squiggle checkout (no app/index.html)`); process.exit(2); }

const sha = (dir) => (spawnSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout || '').trim();
const ARMS = [['base', BASE], ['pr', PR]];
mkdirSync(RESULTS, { recursive: true });
console.log(`A/B ${MODEL} ${MODE}, ${SET}, ${REPS} rep(s)\n  base ${sha(BASE)}  ${BASE}\n  pr   ${sha(PR)}  ${PR}\n  results ${RESULTS}\n`);

// ── Run the cells ────────────────────────────────────────────────────────
for (let rep = 1; rep <= REPS; rep++) {
  for (const [arm, dir] of ARMS) {
    const out = join(RESULTS, `${arm}-rep${rep}.json`);
    if (existsSync(out) && !has('--fresh')) { console.log(`skip ${arm} rep${rep} (already run)`); continue; }
    const args = ['tests/eval/run.mjs', '--model', MODEL, '--mode', MODE, '--set', SET, '--out', out, '--timeout', arg('--timeout', '300')];
    if (CASES) args.push('--cases', CASES);
    if (has('--fake')) args.push('--fake');
    if (has('--no-live')) args.push('--no-live');
    console.log(`\n── ${arm} rep${rep} (app from ${dir}) ──`);
    const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, SQUIGGLE_APP_DIR: join(dir, 'app') } });
    // Exit 2 is "the model never loaded": an infra failure, never scored (Hermes's exit-3 rule).
    if (r.status === 2 || !existsSync(out)) { console.error(`\n${arm} rep${rep}: no result (model not ready?). Fix that before reading any numbers.`); process.exit(3); }
  }
}

// ── Report ───────────────────────────────────────────────────────────────
const runs = { base: [], pr: [] };
for (const f of readdirSync(RESULTS).filter(f => /^(base|pr)-rep\d+\.json$/.test(f))) {
  runs[f.startsWith('base') ? 'base' : 'pr'].push(JSON.parse(readFileSync(join(RESULTS, f), 'utf8')));
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmt = (x, n = 2) => (x == null ? '—' : x.toFixed(n));
const cells = (arm, id) => runs[arm].flatMap(r => r.cases.filter(c => c.id === id));
const ids = [...new Set(runs.base.flatMap(r => r.cases.map(c => c.id)))].sort((a, b) => a - b);

// Scores keep every cell (same denominator); rounds and wall keep only the cells that finished.
const scoreOf = (arm, id) => mean(cells(arm, id).map(c => c.score));
const finished = (arm, id) => cells(arm, id).filter(c => !c.timedOut && !c.problems.includes('timed out'));
const roundsOf = (arm, id) => mean(finished(arm, id).map(c => c.rounds).filter(x => x != null));
const wallOf = (arm, id) => mean(finished(arm, id).map(c => c.ms / 1000));
const thinkOf = (arm, id) => mean(finished(arm, id).map(c => c.thinkChars).filter(x => x != null));

const rows = [], contested = [];
for (const id of ids) {
  const name = (cells('base', id)[0] || cells('pr', id)[0] || {}).name || '';
  const row = { id, name, score: { base: scoreOf('base', id), pr: scoreOf('pr', id) }, rounds: { base: roundsOf('base', id), pr: roundsOf('pr', id) },
    wall: { base: wallOf('base', id), pr: wallOf('pr', id) }, think: { base: thinkOf('base', id), pr: thinkOf('pr', id) },
    spread: { base: [...new Set(cells('base', id).map(c => c.score.toFixed(2)))], pr: [...new Set(cells('pr', id).map(c => c.score.toFixed(2)))] },
    timedOut: cells('base', id).concat(cells('pr', id)).filter(c => c.timedOut).length,
    roundtrips: cells('base', id).concat(cells('pr', id)).reduce((n, c) => n + (c.roundtrips || 0), 0) };
  rows.push(row);
  const moved = row.score.base != null && row.score.pr != null && Math.abs(row.score.pr - row.score.base) > 0.001;
  if (moved && (row.spread.base.length > 1 || row.spread.pr.length > 1 || REPS < 6)) contested.push(id);
}
const col = (f) => rows.map(f).filter(x => x != null);
console.log(`\n\n${'case'.padEnd(46)} ${'score'.padEnd(13)} ${'rounds'.padEnd(13)} ${'wall s'.padEnd(13)} thinking chars`);
console.log('-'.repeat(46 + 14 * 3 + 16));
for (const r of rows) {
  const pair = (o, n = 2) => `${fmt(o.base, n)}→${fmt(o.pr, n)}`.padEnd(13);
  console.log(`${String(r.id).padStart(3)} ${r.name.slice(0, 41).padEnd(42)} ${pair(r.score)} ${pair(r.rounds, 1)} ${pair(r.wall, 0)} ${pair(r.think, 0)}`);
}
const m = (k, f = 2) => `${fmt(mean(col(r => r[k].base)), f)} → ${fmt(mean(col(r => r[k].pr)), f)}`;
console.log('-'.repeat(46 + 14 * 3 + 16));
console.log(`mean of case means:  score ${m('score')}   rounds ${m('rounds', 1)}   wall ${m('wall', 0)} s   thinking ${m('think', 0)} chars`);
const timeouts = rows.reduce((n, r) => n + r.timedOut, 0), trips = rows.reduce((n, r) => n + r.roundtrips, 0);
console.log(`cells: ${runs.base.length + runs.pr.length} runs over ${ids.length} cases; ${timeouts} timed out (scored 0, left out of the means); ${trips} scripted replies sent`);
if (contested.length) console.log(`contested at ${REPS} rep(s): cases ${contested.join(', ')} — re-run just those at 6 before concluding:\n  node tests/eval/ab.mjs --base ${BASE} --pr ${PR} --model ${MODEL} --reps 6 --cases ${contested.join(',')} --results ${RESULTS}-contested`);
const summary = { model: MODEL, mode: MODE, set: SET, reps: REPS, base: { dir: BASE, sha: sha(BASE) }, pr: { dir: PR, sha: sha(PR) }, date: new Date().toISOString(), rows, contested, timeouts };
writeFileSync(join(RESULTS, 'SUMMARY.json'), JSON.stringify(summary, null, 1));
console.log(`\nwritten to ${join(RESULTS, 'SUMMARY.json')}`);
