// tools/gitcli.js on real repos (Node's fs, isomorphic-git), with git's own output formats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runGit, parseArgs } from '../app/src/tools/gitcli.js';
import { unifiedDiff, diffLines } from '../app/src/tools/diff.js';

const require = createRequire(import.meta.url);
const git = require('isomorphic-git');
const author = { name: 'Keal', email: 'k@example.com', timestamp: 1794500000, timezoneOffset: 420 };

async function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcli-'));
  await git.init({ fs, dir, defaultBranch: 'main' });
  const calls = [];
  const env = {
    git, fs, dir, name: 'demo', cwd: '/repos/demo', author: async () => author, written: () => [], noteWritten() {},
    agentBranchName: (r) => (r.startsWith('agent/') ? r : `agent/${r}`),
    call: async (name, args, extra) => { calls.push({ name, args, extra }); return { model: { ok: true } }; },
  };
  const run = async (line) => runGit(line.match(/"[^"]*"|\S+/g).map(s => s.replace(/^"|"$/g, '')), env);
  const write = (p, text) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text); };
  return { dir, env, run, write, calls };
}

test('parseArgs: grouped short options, values glued or apart, repeats, -N, and paths after --', () => {
  const o = parseArgs(['-am', 'one', '-m', 'two', '-n5', '-3', '--stat', '--format=%h', '--', 'a b.txt'], ['m', 'n']);
  assert.equal(o.a, true);
  assert.deepEqual(o.multi.m, ['one', 'two']);
  assert.equal(o.n, '3');
  assert.equal(o.stat, true);
  assert.equal(o.format, '%h');
  assert.deepEqual(o.paths, ['a b.txt']);
});

test('git: real staging: add then commit; commit without add says so; commit -am takes tracked changes', async () => {
  const { run, write } = await repo();
  write('README.md', '# Demo\n\nHello\n');
  write('README 2.md', 'dup\n');
  let r = await run('status');
  assert.match(r.stdout, /No commits yet/);
  assert.match(r.stdout, /Untracked files:[\s\S]*\tREADME 2\.md[\s\S]*\tREADME\.md/);
  assert.equal((await run('add .')).exitCode, 0);
  r = await run('commit -m "First commit"');
  assert.match(r.stdout, /^\[main \(root-commit\) [0-9a-f]{7}\] First commit\n 2 files changed, 4 insertions\(\+\)/);
  write('README.md', '# Demo\n\nHello world\n');
  r = await run('commit -m "nothing staged"');
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /no changes added to commit \(use "git add" and\/or "git commit -a"\)/);
  r = await run('commit -am "Edit README"');
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /\[main [0-9a-f]{7}\] Edit README\n 1 file changed, 1 insertion\(\+\), 1 deletion\(-\)/);
  assert.match((await run('status')).stdout, /nothing to commit, working tree clean/);
});

test('git: status long and short formats name staged, unstaged, deleted and untracked files like git', async () => {
  const { run, write, dir } = await repo();
  write('a.txt', 'a\n'); write('b.txt', 'b\n');
  await run('add -A'); await run('commit -m init');
  write('a.txt', 'a2\n'); fs.unlinkSync(path.join(dir, 'b.txt')); write('c.txt', 'c\n');
  await run('add a.txt');
  write('a.txt', 'a3\n');
  const long = (await run('status')).stdout;
  assert.match(long, /Changes to be committed:[\s\S]*\tmodified:   a\.txt/);
  assert.match(long, /Changes not staged for commit:[\s\S]*\tmodified:   a\.txt\n\tdeleted:    b\.txt/);
  assert.match(long, /Untracked files:[\s\S]*\tc\.txt/);
  assert.equal((await run('status -s')).stdout, 'MM a.txt\n D b.txt\n?? c.txt\n');
});

test('git: a same-size edit Squiggle wrote in the same second still shows as modified (and is not staged)', async () => {
  const { run, write, env } = await repo();
  write('x.js', 'return 1\n');
  await run('add x.js'); await run('commit -m one');
  write('x.js', 'return 2\n');   // same size, same second: the stat check alone misses it
  env.written = () => ['x.js'];
  assert.equal((await run('status -s')).stdout, ' M x.js\n');
  assert.match((await run('diff')).stdout, /-return 1\n\+return 2/);
});

test('git: diff (worktree, --cached, a..b --stat, --name-only) in git\'s format', async () => {
  const { run, write } = await repo();
  write('README.md', '# Demo\n\nHello\n');
  await run('add .'); await run('commit -m one');
  write('README.md', '# Demo\n\nHello world\n');
  const d = (await run('diff')).stdout;
  assert.match(d, /^diff --git a\/README\.md b\/README\.md\nindex [0-9a-f]{7}\.\.[0-9a-f]{7} 100644\n--- a\/README\.md\n\+\+\+ b\/README\.md\n@@ -1,3 \+1,3 @@\n # Demo\n \n-Hello\n\+Hello world\n$/);
  assert.equal((await run('diff --cached')).stdout, '');
  await run('add README.md');
  assert.match((await run('diff --cached')).stdout, /\+Hello world/);
  await run('commit -m two');
  await run('checkout -b side');
  write('new.js', 'x\n');
  await run('add new.js'); await run('commit -m three');
  assert.equal((await run('diff main..agent/side --stat')).stdout, ' new.js | 1 +\n 1 file changed, 1 insertion(+)\n');
  assert.equal((await run('diff main agent/side --name-only')).stdout, 'new.js\n');
  assert.equal((await run('diff --name-status HEAD~1')).stdout, 'A\tnew.js\n');
});

test('git: log (oneline, ranges, -n, --format, -- path, --stat) and show (--stat, rev:path)', async () => {
  const { run, write } = await repo();
  write('a.txt', '1\n'); await run('add .'); await run('commit -m "First"');
  write('b.txt', '2\n'); await run('add .'); await run('commit -m "Second"');
  await run('switch -c feature');
  write('a.txt', '3\n'); await run('commit -am "Third"');
  const one = (await run('log --oneline')).stdout.trim().split('\n');
  assert.equal(one.length, 3);
  assert.match(one[0], /^[0-9a-f]{7} \(HEAD -> agent\/feature\) Third$/);
  assert.match(one[1], /^[0-9a-f]{7} \(main\) Second$/);
  assert.match((await run('log main..agent/feature --oneline')).stdout, /^[0-9a-f]{7} \(HEAD -> agent\/feature\) Third\n$/);
  assert.equal((await run('log -n 1 --format=%s')).stdout, 'Third\n');
  assert.equal((await run('log --format=%s -- b.txt')).stdout, 'Second\n');
  const medium = (await run('log -1')).stdout;
  assert.match(medium, /^commit [0-9a-f]{40} \(HEAD -> agent\/feature\)\nAuthor: Keal <k@example\.com>\nDate:   \w{3} \w{3} \d+ \d\d:\d\d:\d\d \d{4} -0700\n\n    Third\n$/);
  assert.match((await run('log -1 --stat')).stdout, / a\.txt \| 2 \+-\n 1 file changed, 1 insertion\(\+\), 1 deletion\(-\)/);
  assert.match((await run('show --stat HEAD~1')).stdout, /Second\n\n b\.txt \| 1 \+/);
  assert.equal((await run('show main:a.txt')).stdout, '1\n');
  assert.equal((await run('show HEAD:a.txt')).stdout, '3\n');
});

test('git: branches: create gets agent/, list -a -v --show-current, delete refuses unmerged without -D, rename', async () => {
  const { run, write } = await repo();
  write('a', '1\n'); await run('add .'); await run('commit -m init');
  const made = await run('branch fix');
  assert.match(made.stdout, /agent\/fix/);
  assert.equal((await run('branch')).stdout, '  agent/fix\n* main\n');
  assert.equal((await run('branch --show-current')).stdout, 'main\n');
  assert.match((await run('branch -v')).stdout, /^ {2}agent\/fix [0-9a-f]{7} init\n\* main {6}[0-9a-f]{7} init\n$/);
  await run('switch agent/fix');
  write('a', '2\n'); await run('commit -am change');
  await run('switch main');
  assert.match((await run('branch -d agent/fix')).stderr, /not fully merged/);
  assert.match((await run('branch -D agent/fix')).stdout, /Deleted branch agent\/fix \(was [0-9a-f]{7}\)\./);
  await run('branch -m main trunk');
  assert.equal((await run('branch --show-current')).stdout, 'trunk\n');
});

test('git: checkout -- file and restore (--staged) put files back; reset --soft/--hard move the branch', async () => {
  const { run, write, dir } = await repo();
  write('a.txt', 'one\n'); await run('add .'); await run('commit -m one');
  write('a.txt', 'two\n'); await run('commit -am two');
  write('a.txt', 'oops\n');
  await run('checkout -- a.txt');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'two\n');
  write('a.txt', 'staged\n'); await run('add a.txt');
  await run('restore --staged a.txt');
  assert.equal((await run('status -s')).stdout, ' M a.txt\n');
  await run('restore a.txt');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'two\n');
  await run('reset --soft HEAD~1');
  assert.equal((await run('status -s')).stdout, 'M  a.txt\n', 'soft: the change stays staged');
  await run('commit -m again');
  const hard = await run('reset --hard HEAD~1');
  assert.match(hard.stdout, /^HEAD is now at [0-9a-f]{7} one$/m);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one\n');
});

test('git: rm, mv, stash push/pop, merge (fast-forward), cherry-pick refuses a dirty tree', async () => {
  const { run, write, dir } = await repo();
  write('a.txt', 'a\n'); write('d/b.txt', 'b\n'); await run('add .'); await run('commit -m init');
  assert.match((await run('rm d')).stderr, /not removing 'd' recursively without -r/);
  assert.equal((await run('rm -r d')).stdout, "rm 'd/b.txt'\n");
  assert.equal(fs.existsSync(path.join(dir, 'd/b.txt')), false);
  await run('mv a.txt c.txt');
  assert.equal((await run('status -s')).stdout, 'D  a.txt\nA  c.txt\nD  d/b.txt\n');
  await run('commit -m moves');
  write('c.txt', 'changed\n');
  assert.match((await run('stash')).stdout, /Saved working directory and index state WIP on main/);
  assert.equal(fs.readFileSync(path.join(dir, 'c.txt'), 'utf8'), 'a\n');
  await run('stash pop');
  assert.equal(fs.readFileSync(path.join(dir, 'c.txt'), 'utf8'), 'changed\n');
  assert.match((await run('cherry-pick main')).stderr, /local changes would be overwritten/);
  await run('restore c.txt');
  await run('switch -c topic');
  write('e.txt', 'e\n'); await run('add e.txt'); await run('commit -m topic');
  await run('switch main');
  const m = await run('merge agent/topic');
  assert.match(m.stdout, /^Updating [0-9a-f]{7}\.\.[0-9a-f]{7}\nFast-forward\n e\.txt \| 1 \+/);
  assert.equal(fs.readFileSync(path.join(dir, 'e.txt'), 'utf8'), 'e\n');
});

test('git: push goes through Squiggle\'s push tool (another branch by name), never forced', async () => {
  const { run, write, calls } = await repo();
  write('a', '1\n'); await run('add .'); await run('commit -m init');
  await run('branch side');
  await run('push');
  await run('push -u origin agent/side');
  assert.deepEqual(calls.map(c => [c.name, c.args.repo, c.extra && c.extra.pushBranch]), [['git_push', 'demo', undefined], ['git_push', 'demo', 'agent/side']]);
  for (const line of ['push --force', 'push -f origin main', 'push origin +main', 'push --force-with-lease']) {
    const r = await run(line);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /never force-pushes/);
  }
  assert.match((await run('push origin :main')).stderr, /deleting branches on GitHub isn't available/);
  assert.equal(calls.length, 2);
});

test('git: grep, blame, rev-parse, remote-less repos, unknown and unsupported commands', async () => {
  const { run, write } = await repo();
  write('a.js', 'const x = 1;\nconst y = 2;\n'); await run('add .'); await run('commit -m one');
  write('a.js', 'const x = 1;\nconst y = 3;\n'); await run('commit -am two');
  assert.equal((await run('grep -n "y ="')).stdout, 'a.js:2:const y = 3;\n');
  assert.equal((await run('grep nothing-here')).exitCode, 1);
  const blame = (await run('blame a.js')).stdout.split('\n');
  const [first, second] = [blame[0].slice(0, 7), blame[1].slice(0, 7)];
  assert.notEqual(first, second, 'line 2 changed in a later commit than line 1');
  assert.equal((await run('rev-parse --abbrev-ref HEAD')).stdout, 'main\n');
  assert.match((await run('rev-parse --short HEAD')).stdout, /^[0-9a-f]{7}\n$/);
  assert.match((await run('rebase main')).stderr, /rebase isn't available here/);
  assert.match((await run('frobnicate')).stderr, /'frobnicate' is not a git command/);
});

test('git: apply puts a patch from git diff back (and -R takes it off)', async () => {
  const { run, write, dir } = await repo();
  write('a.txt', 'one\ntwo\nthree\n'); write('b.txt', 'b\n'); await run('add .'); await run('commit -m init');
  write('a.txt', 'one\n2\nthree\n'); write('b.txt', 'b\nmore\n');
  const patch = (await run('diff')).stdout;
  write('p.diff', patch);
  await run('reset --hard');
  assert.equal((await run('apply --check p.diff')).exitCode, 0);
  assert.equal((await run('apply p.diff')).exitCode, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one\n2\nthree\n');
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'b\nmore\n');
  assert.equal((await run('apply -R p.diff')).exitCode, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n');
});

test('diff: every edit script turns one side into the other, and unified hunks count their lines', () => {
  let seed = 3;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let t = 0; t < 300; t++) {
    const a = Array.from({ length: rnd(40) }, () => 'abcde'[rnd(5)]);
    const b = a.slice();
    for (let e = rnd(8); e > 0; e--) { const k = rnd(b.length + 1); if (rnd(2)) b.splice(k, 1); else b.splice(k, 0, 'xyz'[rnd(3)]); }
    const ed = diffLines(a, b);
    assert.deepEqual(ed.filter(e => e.op !== '+').map(e => e.line), a);
    assert.deepEqual(ed.filter(e => e.op !== '-').map(e => e.line), b);
  }
  const d = unifiedDiff({ path: 'f', before: 'a\nb\nc\n', after: 'a\nB\nc' });
  assert.match(d, /@@ -1,3 \+1,3 @@\n a\n-b\n-c\n\+B\n\+c\n\\ No newline at end of file\n$/);
});
