import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../app/src/recipes.js';
import { parseJsonl, mergeJsonl, mergeFor } from '../app/src/merge.js';

const DAY = 24 * 3600 * 1000;
const FILE = 'memory/recipes.jsonl';

// In-memory stand-in for storage.js.
function memStore(files = {}) {
  const s = { files, writes: 0, syncs: 0,
    read: async (p) => (p in s.files ? s.files[p] : null),
    write: async (p, c) => { s.files[p] = c; s.writes++; },
    sync: () => { s.syncs++; } };
  return s;
}
let store;
beforeEach(() => { R._reset(); store = memStore(); R.setStore(store); });
afterEach(() => { R._reset(); });

const killPort = () => ({
  title: 'Kill whatever is listening on a port',
  when: 'Free up a port by stopping the process that is listening on it',
  examples: ['kill 8080', 'ugh the dev server is still running on 3000, get rid of it'],
  steps: ['Find the PID with lsof -i :<port>', 'Kill the process with kill <pid>', 'Check that the port is free'],
  specifics: ['<port> = 8080'],
});
const readmeLink = () => ({
  title: 'Add a link to a doc in the README',
  when: 'Link a docs page from the README of a repo',
  steps: ['Clone <repo>', 'Read the README', 'Add the link', 'Commit and push an agent branch'],
  specifics: ['<repo> = KealJones/squiggle'],
});
const summarise = () => ({
  title: 'Summarise a web page',
  when: 'Read a web page from a link and tell me what it says',
  steps: ['Fetch the page', 'Summarise it in a few lines'],
});

// ── fromTask ─────────────────────────────────────────────────────────────

const readmeTask = () => ({
  id: 'tk1', msg: 'm_0a1',
  goal: 'Add the harness doc link to the README of KealJones/squiggle',
  steps: [
    { id: 's1', text: 'Clone KealJones/squiggle', status: 'done', result: 'cloned' },
    { id: 's2', text: 'Read README.md and find where docs are linked', status: 'done' },
    { id: 's3', text: 'Edit /repos/squiggle/README.md to add a link to docs/harness.md', status: 'done' },
    { id: 's4', text: 'Commit and push branch agent/readme-link', status: 'done' },
  ],
});
const readmeLog = () => [
  { name: 'git_clone', args: { repo: 'KealJones/squiggle' }, ok: true, label: 'cloned KealJones/squiggle' },
  { name: 'read_file', args: { path: '/repos/squiggle/README.md' }, ok: true, label: 'read README.md' },
  { name: 'write_file', args: { path: '/repos/squiggle/README.md', content: '# Squiggle\n…' }, ok: true, label: 'wrote README.md' },
  { name: 'git_branch', args: { repo: 'squiggle', branch: 'agent/readme-link' }, ok: true, label: 'branch' },
  { name: 'git_commit', args: { repo: 'squiggle', message: 'docs: link harness spec' }, ok: true, label: 'committed' },
  { name: 'git_push', args: { repo: 'squiggle' }, ok: true, label: 'pushed' },
];
const REQUEST = 'hey so can you like add a link to the harness doc in the readme, um, for squiggle';

test('fromTask lifts paths, repos and branches into specifics and generalises the steps', () => {
  const r = R.fromTask(readmeTask(), readmeLog(), { request: REQUEST, sessionId: 's_1', now: 1000 });
  assert.equal(r.title, 'Add the harness doc link to the README of <repo>');
  assert.equal(r.when, 'Add the harness doc link to the README of KealJones/squiggle');
  assert.deepEqual(r.examples, [REQUEST]);
  assert.deepEqual(r.steps, [
    'Clone <repo>',
    'Read <path1> and find where docs are linked',
    'Edit <path1> to add a link to <path2>',
    'Commit and push branch <branch>',
  ]);
  assert.deepEqual(r.specifics, [
    '<repo> = KealJones/squiggle',
    '<branch> = agent/readme-link',
    '<path1> = /repos/squiggle/README.md',
    '<path2> = docs/harness.md',
  ]);
  assert.equal(r.uses, 0);
  assert.equal(r.created, 1000);
  assert.deepEqual(r.sessions, ['s_1']);
});

test('fromTask never keeps content, commit messages, queries or code as specifics', () => {
  const task = { goal: 'Look up how wrangler secrets work', steps: [{ text: 'Search the web for wrangler secret put', status: 'done' }, { text: 'Read the result page', status: 'done' }] };
  const log = [
    { name: 'web_search', args: { query: 'wrangler secret put how to' }, ok: true },
    { name: 'fetch_url', args: { url: 'https://developers.cloudflare.com/workers/configuration/secrets/' }, ok: true },
    { name: 'run_js', args: { code: 'console.log(1+1)' }, ok: true },
    { name: 'git_commit', args: { repo: 'squiggle', message: 'fix the thing' }, ok: true },
  ];
  const r = R.fromTask(task, log);
  assert.deepEqual(r.specifics, ['<url> = https://developers.cloudflare.com/workers/configuration/secrets/', '<repo> = squiggle']);
  assert.ok(!r.specifics.some(s => /wrangler secret put|console\.log|fix the thing/.test(s)));
});

test('fromTask skips failed tool calls and anything that looks like a secret', () => {
  const task = { goal: 'Push the notes', steps: [{ text: 'Write /home/notes.md', status: 'done' }] };
  const log = [
    { name: 'read_file', args: { path: '/home/old-notes.md' }, ok: false },
    { name: 'write_file', args: { path: '/home/notes.md', content: 'x' }, ok: true },
    { name: 'fetch_url', args: { url: 'https://api.github.com/user?access_token=ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, ok: true },
    { name: 'run_shell', args: { command: 'curl -H "Authorization: Bearer abc123" https://example.com' }, ok: true },
  ];
  const r = R.fromTask(task, log);
  assert.deepEqual(r.specifics, ['<path> = /home/notes.md']);
});

test('fromTask redacts tokens pasted into the request', () => {
  const r = R.fromTask({ goal: 'Check my repos', steps: [{ text: 'List repos', status: 'done' }] }, [],
    { request: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 to check my repos' });
  assert.ok(!r.examples.join(' ').includes('ghp_'));
  assert.match(r.examples[0], /\[redacted\]/);
});

test('fromTask picks up backticked commands and URLs written in step texts', () => {
  const task = {
    goal: 'Get rid of whatever is on port 8080',
    steps: [
      { text: 'Find the process with `lsof -i :8080`', status: 'done' },
      { text: 'Stop it with `kill 41233`', status: 'done' },
      { text: 'Open http://localhost:8080 to check it is gone', status: 'done' },
    ],
  };
  const r = R.fromTask(task, []);
  assert.deepEqual(r.steps, ['Find the process with <command1>', 'Stop it with <command2>', 'Open <url> to check it is gone']);
  assert.deepEqual(r.specifics, ['<url> = http://localhost:8080', '<command1> = lsof -i :8080', '<command2> = kill 41233']);
});

test('fromTask uses finished steps only, falls back to the goal for the title, and tolerates odd input', () => {
  const task = { goal: '', steps: [{ text: 'Check the weather in Austin', status: 'done' }, { text: 'Ask the user which day', status: 'blocked' }, { text: 'Never got here', status: 'todo' }] };
  const r = R.fromTask(task, null);
  assert.deepEqual(r.steps, ['Check the weather in Austin']);
  assert.equal(r.title, 'Check the weather in Austin');
  const empty = R.fromTask({}, undefined);
  assert.deepEqual(empty.steps, []);
  assert.equal(empty.title, 'Untitled recipe');
  // When nothing is marked done (a stopped task is never saved, but be safe) all non-blocked steps are used.
  const none = R.fromTask({ goal: 'x y', steps: [{ text: 'One' }, { text: 'Two', status: 'blocked' }] });
  assert.deepEqual(none.steps, ['One']);
});

test('titleOf drops the chatter around a spoken request', () => {
  assert.equal(R.titleOf("hey so can you please kill whatever is listening on 8080, thanks"), 'Kill whatever is listening on 8080');
  assert.equal(R.titleOf("okay um I wanna push the harness branch. then open a PR"), 'Push the harness branch');
  assert.equal(R.titleOf('   '), 'Untitled recipe');
  assert.ok(R.titleOf('word '.repeat(60)).length <= 71);
});

test('the request text can come from task.msg when it is text, not an id', () => {
  const r = R.fromTask({ goal: 'Do the thing', msg: 'please do the thing with the other thing', steps: [{ text: 'A', status: 'done' }] });
  assert.deepEqual(r.examples, ['please do the thing with the other thing']);
  const r2 = R.fromTask({ goal: 'Do the thing', msg: 'm_0a1', steps: [{ text: 'A', status: 'done' }] });
  assert.deepEqual(r2.examples, []);
});

// ── storage ──────────────────────────────────────────────────────────────

test('save then flush writes one JSON object per line and load reads it back', async () => {
  const a = R.save(killPort());
  const b = R.save(readmeLink());
  await R.flush();
  assert.equal(store.syncs, 1);
  const lines = store.files[FILE].trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map(l => JSON.parse(l).id).sort(), [a.id, b.id].sort());
  assert.match(a.id, /^r/);

  R._reset();
  R.setStore(store);
  assert.deepEqual(R.list(), []);
  await R.load();
  assert.equal(R.list().length, 2);
  assert.equal(R.get(a.id).title, 'Kill whatever is listening on a port');
});

test('load skips corrupt lines and entries without an id, and fills in missing arrays', async () => {
  store.files[FILE] = [
    JSON.stringify({ id: 'r1', title: 'Fine', when: 'w', steps: ['a'], uses: 2, created: 5 }),
    '{ this is not json',
    JSON.stringify({ title: 'No id' }),
    '',
  ].join('\n');
  await R.load();
  assert.equal(R.list().length, 1);
  const r = R.get('r1');
  assert.deepEqual(r.specifics, []);
  assert.deepEqual(r.sessions, []);
  assert.equal(r.uses, 2);
});

test('load on a repo with no recipes file gives an empty list', async () => {
  await R.load();
  assert.deepEqual(R.list(), []);
});

test('reload only reloads when recipes.jsonl changed', async () => {
  await R.load();
  store.files[FILE] = JSON.stringify({ id: 'r9', title: 'From another device', when: 'w', steps: ['x'] }) + '\n';
  await R.reload(['sessions/s_1.json', 'memory/facts.jsonl']);
  assert.equal(R.list().length, 0);
  await R.reload(['memory/recipes.jsonl']);
  assert.equal(R.list().length, 1);
  store.files[FILE] = '';
  await R.reload(['*']);
  assert.equal(R.list().length, 0);
});

test('a recipe learned just before a sync survives the reload', async () => {
  await R.load();
  store.files[FILE] = JSON.stringify({ id: 'r9', title: 'From another device', when: 'w', steps: ['x'], mts: 1 }) + '\n';
  await new Promise(r => setTimeout(r, 5));
  const mine = R.save(killPort());          // not flushed yet (save debounces)
  await R.reload(['memory/recipes.jsonl']);
  assert.deepEqual(R.list().map(r => r.id).sort(), [mine.id, 'r9'].sort());
  await R.flush();
  assert.match(store.files[FILE], new RegExp(mine.id));
});

test('change events fire on save, touch and remove', () => {
  let n = 0;
  R.events.on('change', () => n++);
  const r = R.save(killPort());
  R.touch(r.id);
  R.remove(r.id);
  assert.equal(n, 3);
});

// ── save / merge ─────────────────────────────────────────────────────────

test('saving the same task again merges into the existing recipe', () => {
  const first = R.save({ ...R.fromTask(readmeTask(), readmeLog(), { request: REQUEST, sessionId: 's_1', now: 1000 }) });
  R.touch(first.id); R.touch(first.id);
  R.pin(first.id, true);

  // Same task a week later, different wording, one more step this time, another repo folder.
  const again = R.fromTask({
    goal: 'Add the harness doc link to the README of KealJones/squiggle',
    steps: [{ text: 'Clone KealJones/squiggle', status: 'done' }, { text: 'Edit README.md to add a link to docs/harness.md', status: 'done' }, { text: 'Open a pull request for agent/readme-link-2', status: 'done' }],
  }, [
    { name: 'git_clone', args: { repo: 'KealJones/squiggle' }, ok: true },
    { name: 'write_file', args: { path: '/repos/squiggle/README.md' }, ok: true },
    { name: 'git_branch', args: { repo: 'squiggle', branch: 'agent/readme-link-2' }, ok: true },
  ], { request: 'put the harness doc in the squiggle readme', sessionId: 's_2' });
  const merged = R.save(again);

  assert.equal(merged.id, first.id);
  assert.equal(R.list().length, 1);
  assert.equal(merged.uses, 2);
  assert.equal(merged.created, 1000);
  assert.equal(merged.pinned, true);
  assert.equal(merged.title, first.title);
  assert.deepEqual(merged.examples, [REQUEST, 'put the harness doc in the squiggle readme']);
  assert.deepEqual(merged.steps, again.steps);
  assert.deepEqual(merged.specifics, again.specifics);
  assert.deepEqual(merged.sessions, ['s_1', 's_2']);
});

test('merging does not repeat an example phrasing', () => {
  const a = R.save({ ...killPort() });
  R.save({ ...killPort(), examples: ['KILL 8080', 'another way to say it'] });
  assert.equal(R.list().length, 1);
  assert.deepEqual(R.get(a.id).examples, ['kill 8080', 'ugh the dev server is still running on 3000, get rid of it', 'another way to say it']);
});

test('different tasks stay separate recipes', () => {
  R.save(killPort());
  R.save(readmeLink());
  R.save(summarise());
  assert.equal(R.list().length, 3);
  // "Add a link to a doc in the README" vs "Add a link to a doc in the wiki": close, but not the same task.
  R.save({ title: 'Delete a branch on GitHub', when: 'Remove an old branch from a repo', steps: ['x'] });
  assert.equal(R.list().length, 4);
});

test('merging keeps at most 6 examples, newest last', () => {
  const r = R.save({ ...killPort(), examples: [] });
  for (let i = 0; i < 10; i++) R.save({ ...killPort(), examples: [`phrasing number ${i}`] });
  const ex = R.get(r.id).examples;
  assert.equal(ex.length, 6);
  assert.equal(ex[5], 'phrasing number 9');
});

test('save with an existing id edits that recipe (the Memory panel)', () => {
  const r = R.save(killPort());
  R.touch(r.id);
  const edited = R.save({ ...R.get(r.id), title: 'Free a port', steps: ['Find the PID', 'Kill it'] });
  assert.equal(edited.id, r.id);
  assert.equal(edited.title, 'Free a port');
  assert.deepEqual(edited.steps, ['Find the PID', 'Kill it']);
  assert.equal(edited.uses, 1);
  assert.equal(R.list().length, 1);
});

test('save rejects an empty recipe', () => {
  assert.throws(() => R.save({}), /title or steps/);
});

test('a deleted recipe is not merged into; the task starts a new one', () => {
  const a = R.save(killPort());
  R.remove(a.id);
  const b = R.save(killPort());
  assert.notEqual(a.id, b.id);
  assert.equal(R.list().length, 1);
});

// ── touch / pin / remove / prune ─────────────────────────────────────────

test('touch counts a use and refreshes lastUsed', async () => {
  const r = R.save({ ...killPort(), lastUsed: 5 });
  const before = Date.now();
  R.touch(r.id);
  assert.equal(R.get(r.id).uses, 1);
  assert.ok(R.get(r.id).lastUsed >= before);
  assert.equal(R.touch('nope'), null);
});

test('list puts the recipe used most recently first', () => {
  const a = R.save(killPort());
  const b = R.save(readmeLink());
  R.update(a.id, { lastUsed: 100 });
  R.update(b.id, { lastUsed: 200 });
  assert.deepEqual(R.list().map(r => r.id), [b.id, a.id]);
});

test('remove leaves a tombstone that is saved but not listed', async () => {
  const r = R.save(killPort());
  assert.equal(R.remove(r.id), true);
  assert.equal(R.remove(r.id), false);
  assert.equal(R.get(r.id), null);
  assert.deepEqual(R.list(), []);
  await R.flush();
  const rows = parseJsonl(store.files[FILE]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deleted, true);
});

test('prune forgets unpinned recipes unused for 90 days and returns the count', () => {
  const now = Date.now();
  const old = R.save({ ...killPort(), lastUsed: now - 91 * DAY });
  const fresh = R.save({ ...readmeLink(), lastUsed: now - 89 * DAY });
  const pinned = R.save({ ...summarise(), lastUsed: now - 400 * DAY });
  R.pin(pinned.id, true);
  assert.equal(R.prune(now), 1);
  assert.equal(R.get(old.id), null);
  assert.ok(R.get(fresh.id));
  assert.ok(R.get(pinned.id));
  assert.equal(R.prune(now), 0);
  R.pin(pinned.id, false);
  assert.equal(R.get(pinned.id).pinned, undefined);
  assert.equal(R.prune(now), 1);
});

test('prune counts from created when a recipe was never used', async () => {
  store.files[FILE] = JSON.stringify({ id: 'r_old', title: 'Old', when: 'w', steps: ['s'], created: 10 * DAY, ts: 10 * DAY }) + '\n';
  await R.load();
  assert.equal(R.prune(50 * DAY), 0);
  assert.equal(R.prune(200 * DAY), 1);
});

test('devices merge recipes by id and a newer delete wins', () => {
  const a = { id: 'r_x', title: 'Kill a port', when: 'w', steps: ['s'], uses: 3, ts: 10, mts: 50 };
  const del = { ...a, deleted: true, mts: 90 };
  const merged = parseJsonl(mergeJsonl(JSON.stringify(a) + '\n', JSON.stringify(del) + '\n'));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].deleted, true);
  // and the file is merged by the same strategy as facts
  assert.equal(typeof mergeFor(FILE), 'function');
});

// ── match ────────────────────────────────────────────────────────────────

function seed() {
  const ids = {};
  ids.kill = R.save(killPort()).id;
  ids.readme = R.save(readmeLink()).id;
  ids.page = R.save(summarise()).id;
  ids.push = R.save({
    title: 'Push a branch to GitHub',
    when: 'Publish my changes on a branch of a repo',
    steps: ['Check git status', 'Commit the changes', 'Push the branch', 'Tell the user the branch name'],
  }).id;
  return ids;
}

test('match finds the recipe for a request in plain words', async () => {
  const ids = seed();
  const hit = async (q) => (await R.match(q)).map(m => m.recipe.id);
  assert.equal((await hit('kill whatever is listening on port 3000'))[0], ids.kill);
  assert.equal((await hit('add a link to the docs page in the readme'))[0], ids.readme);
  assert.equal((await hit('can you read this page and summarise what it says'))[0], ids.page);
  assert.equal((await hit('push my changes on this branch to github'))[0], ids.push);
});

test('match uses the example phrasings a recipe has collected', async () => {
  const ids = seed();
  const m = await R.match('ugh the dev server is still running on 3000 get rid of it');
  assert.equal(m[0].recipe.id, ids.kill);
  assert.ok(m[0].score >= R.STRONG);
});

test('match copes with rambling, voice-dictated requests', async () => {
  const ids = seed();
  const q = "okay so um I was working on the readme earlier and, no wait, I mean I want to like add a link in the readme to the docs page, yeah the harness doc, you know";
  const m = await R.match(q);
  assert.equal(m[0].recipe.id, ids.readme);
});

test('match returns nothing for requests no recipe fits', async () => {
  seed();
  for (const q of ['hey whats up lol', 'what is the capital of France', 'tell me a joke', 'thanks that was great', '', '   ']) {
    assert.deepEqual(await R.match(q), [], q);
  }
});

test('one shared word is not a match', async () => {
  seed();
  assert.deepEqual(await R.match('write a poem about a branch'), []);
  assert.deepEqual(await R.match('what port is postgres on'), []);
});

test('match respects k, orders by score, and reports scores in 0..1', async () => {
  seed();
  R.save({ title: 'Push the harness doc link to GitHub', when: 'Add a link in the README and push the branch', steps: ['Add the link', 'Push the branch'] });
  const all = await R.match('add a link to the readme and push the branch', 5);
  assert.ok(all.length >= 2);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].score >= all[i].score);
  for (const m of all) assert.ok(m.score >= R.MIN_SCORE && m.score <= 1);
  assert.equal((await R.match('add a link to the readme and push the branch', 1)).length, 1);
});

test('deleted recipes never match', async () => {
  const ids = seed();
  R.remove(ids.kill);
  assert.deepEqual(await R.match('kill whatever is listening on port 3000'), []);
});

test('matchSync is the keyword half of match', async () => {
  seed();
  const q = 'kill whatever is listening on port 3000';
  assert.deepEqual(R.matchSync(q), await R.match(q));
});

test('a semantic embedder can rescue a request with no shared words', async () => {
  const ids = seed();
  const q = 'my localhost server wont start, something already grabbed the socket';
  assert.deepEqual(await R.match(q), []);
  // A toy embedder: "socket"/"port"-ish texts point the same way.
  const vec = (t) => /socket|port|listening/i.test(t) ? [1, 0.05, 0] : /readme|link/i.test(t) ? [0, 1, 0] : [0, 0, 1];
  R.setEmbedder(async (texts) => texts.map(vec));
  const m = await R.match(q);
  assert.equal(m.length, 1);
  assert.equal(m[0].recipe.id, ids.kill);
  assert.ok(m[0].score >= R.MIN_SCORE);
});

test('a broken embedder falls back to keywords', async () => {
  const ids = seed();
  R.setEmbedder(async () => { throw new Error('model failed to load'); });
  const m = await R.match('kill whatever is listening on port 3000');
  assert.equal(m[0].recipe.id, ids.kill);
  R.setEmbedder(async () => null);
  assert.equal((await R.match('kill whatever is listening on port 3000'))[0].recipe.id, ids.kill);
});

test('typos and dictation slips still find the recipe; numbers are never fuzzed', () => {
  R._reset(); R.setStore(store);
  R.save({ title: 'Deploy the Squiggle site', when: 'deploy squiggle to github pages', steps: ['Push main', 'Check the deploy run'] });
  R.save({ title: 'Kill whatever is on port 8080', when: 'free port 8080', steps: ['lsof -i :8080', 'kill the pid'] });
  assert.equal(R.matchSync('deploi the squigle site')[0]?.recipe.title, 'Deploy the Squiggle site');
  assert.equal(R.matchSync('pls deplyo squiggel')[0]?.recipe.title, 'Deploy the Squiggle site');
  // A different port still fits the same recipe (recipes generalise values), but by words, not by fuzzing the number.
  assert.equal(R.matchSync('free port 9000')[0]?.recipe.title, 'Kill whatever is on port 8080');
  assert.equal(R.matchSync('bake a cake').length, 0);
  assert.equal(R.editDistance('deploi', 'deploy'), 1);
  assert.equal(R.editDistance('teh', 'the'), 1);
  assert.equal(R.editDistance('abcdef', 'uvwxyz', 2), 3);
});
