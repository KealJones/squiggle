// `git` in the bash tool, behaving like real git so models can use what they know (2026-11-12: a model couldn't
// commit with `git commit -am`, list PRs, or see `git diff main..branch`). Real staging: `git add` stages,
// `git commit` commits what's staged, `-a` stages tracked changes first. Output follows git's own formats.
//
// Runs on isomorphic-git; everything it touches comes in `env`, so tests run it on Node against real repos:
//   { git, fs, dir, name, cwd, author(), net(), written(), noteWritten(path), call(tool, args), agentBranchName(raw) }
//   dir: the repo's path on `fs` (null outside a repo); cwd: the shell's directory in workspace terms; call(): the
//   Squiggle tool (git_push, git_pull, git_clone), so a push still follows the push policy and never forces.
import { unifiedDiff, countLines, statLines, diffLines } from './diff.js';

const enc = new TextEncoder(), dec = new TextDecoder();
const ok = (stdout = '') => ({ stdout: stdout && !stdout.endsWith('\n') ? stdout + '\n' : stdout, stderr: '', exitCode: 0 });
const fail = (stderr, exitCode = 1, stdout = '') => ({ stdout, stderr: stderr.endsWith('\n') ? stderr : stderr + '\n', exitCode });
const fatal = (msg) => fail(`fatal: ${msg}`, 128);
class GitError extends Error { constructor(msg, code = 128) { super(msg); this.code = code; } }

// ── Arguments ──────────────────────────────────────────────────────────────

// Options for one subcommand: `spec` names the ones that take a value ("m", "message", "n", …). Handles --x=v,
// --x v, -xv for one-letter value options (-n5, -U1), grouped one-letter flags (-am "msg"), repeated options
// (several -m), -N for counts, and everything after `--` as paths.
export function parseArgs(argv, spec = []) {
  const takes = new Set(spec);
  const o = { _: [], paths: null, multi: {} };
  const set = (k, v) => { (o.multi[k] = o.multi[k] || []).push(v); o[k] = v; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.paths = argv.slice(i + 1); break; }
    let m;
    if ((m = /^--([\w-]+)=([\s\S]*)$/.exec(a))) { set(m[1], m[2]); continue; }
    if ((m = /^--([\w-]+)$/.exec(a))) { if (takes.has(m[1]) && i + 1 < argv.length) set(m[1], argv[++i]); else set(m[1], true); continue; }
    if ((m = /^-(\d+)$/.exec(a))) { set('n', m[1]); continue; }
    if ((m = /^-([a-zA-Z])([\s\S]+)$/.exec(a)) && takes.has(m[1]) && !/^[a-zA-Z]+$/.test(m[2])) { set(m[1], m[2]); continue; }   // -n5, -U1
    if ((m = /^-([a-zA-Z]+)$/.exec(a))) {
      const letters = [...m[1]];
      for (let j = 0; j < letters.length; j++) {
        const l = letters[j];
        if (takes.has(l)) {
          const rest = letters.slice(j + 1).join('');
          if (rest) set(l, rest); else if (i + 1 < argv.length) set(l, argv[++i]); else set(l, true);
          break;
        }
        set(l, true);
      }
      continue;
    }
    o._.push(a);
  }
  return o;
}

// ── Repo helpers ───────────────────────────────────────────────────────────

const join = (...p) => p.filter(Boolean).join('/').replace(/\/+/g, '/');
function normPath(p) {
  const out = [];
  for (const part of String(p).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return out.join('/');
}

function ctxOf(env) {
  const { git, fs, dir } = env;
  const pfs = fs.promises;
  const repoRel = () => {   // where the shell is, inside the repo
    const root = `/repos/${env.name}`;
    return env.cwd === root || !env.cwd.startsWith(root + '/') ? '' : env.cwd.slice(root.length + 1);
  };
  // A path the user typed → its path in the repo ('' for the root).
  const rel = (p) => {
    const s = String(p);
    if (s.startsWith('/')) {
      const root = `/repos/${env.name}`;
      if (s === root) return '';
      if (s.startsWith(root + '/')) return normPath(s.slice(root.length + 1));
      throw new GitError(`${s}: '${s}' is outside repository at '${root}'`);
    }
    return normPath(join(repoRel(), s));
  };
  const read = async (p) => { try { return dec.decode(await pfs.readFile(`${dir}/${p}`)); } catch { return null; } };
  const write = async (p, text) => {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) { const d = `${dir}/${parts.slice(0, i).join('/')}`; try { await pfs.mkdir(d); } catch { /* exists */ } }
    await pfs.writeFile(`${dir}/${p}`, text);
    env.noteWritten && env.noteWritten(`${dir}/${p}`);
  };
  const remove = async (p) => { try { await pfs.unlink(`${dir}/${p}`); } catch { /* gone */ } };
  const branch = () => git.currentBranch({ fs, dir, fullname: false }).catch(() => null);
  const head = () => git.resolveRef({ fs, dir, ref: 'HEAD' }).catch(() => null);
  const blob = async (oid, filepath) => {
    if (!oid) return null;
    try { return dec.decode((await git.readBlob({ fs, dir, oid, filepath })).blob); } catch { return null; }
  };
  const blobByOid = async (oid) => { try { return dec.decode((await git.readBlob({ fs, dir, oid })).blob); } catch { return null; } };
  return { git, fs, pfs, dir, rel, repoRel, read, write, remove, branch, head, blob, blobByOid };
}

// A commit for a name: full or short id, branch, remote branch, tag, HEAD, with ~N and ^N, and @ for HEAD.
async function resolveRev(c, spec) {
  const { git, fs, dir } = c;
  const m = /^(.*?)((?:[~^]\d*)*)$/.exec(String(spec).replace(/^@(?=$|[~^])/, 'HEAD'));
  const base = m[1] || 'HEAD';
  let oid = null;
  if (/^[0-9a-f]{4,40}$/i.test(base)) { try { oid = await git.expandOid({ fs, dir, oid: base.toLowerCase() }); } catch { oid = null; } }
  if (!oid) {
    for (const ref of [base, `refs/heads/${base}`, `refs/remotes/${base}`, `refs/remotes/origin/${base}`, `refs/tags/${base}`]) {
      try { oid = await git.resolveRef({ fs, dir, ref }); break; } catch { /* next */ }
    }
  }
  if (!oid) throw new GitError(`ambiguous argument '${spec}': unknown revision or path not in the working tree.`);
  // An annotated tag points at a tag object: follow it to the commit.
  try { const t = await git.readTag({ fs, dir, oid }); oid = t.tag.object; } catch { /* a commit */ }
  for (const step of m[2].match(/[~^]\d*/g) || []) {
    const n = step.length > 1 ? +step.slice(1) : 1;
    for (let i = 0; i < (step[0] === '~' ? n : 1); i++) {
      const { commit } = await git.readCommit({ fs, dir, oid });
      const parent = commit.parent[step[0] === '^' ? n - 1 : 0];
      if (!parent) throw new GitError(`ambiguous argument '${spec}': unknown revision or path not in the working tree.`);
      oid = parent;
    }
  }
  return oid;
}
const isRev = async (c, spec) => { try { await resolveRev(c, spec); return true; } catch { return false; } };

// Every blob in a commit's tree: path → oid.
async function treeFiles(c, oid) {
  const files = new Map();
  if (!oid) return files;
  await c.git.walk({ fs: c.fs, dir: c.dir, trees: [c.git.TREE({ ref: oid })], map: async (p, [e]) => {
    if (p === '.' || !e) return;
    if ((await e.type()) === 'blob') files.set(p, await e.oid());
  } });
  return files;
}
async function indexFiles(c) {
  const files = new Map();
  await c.git.walk({ fs: c.fs, dir: c.dir, trees: [c.git.STAGE()], map: async (p, [e]) => {
    if (p === '.' || !e) return;
    if ((await e.type()) === 'blob') files.set(p, await e.oid());
  } });
  return files;
}

// The three-way status: [{ path, head, index, work }] with each side's oid (null when the file isn't there), using
// isomorphic-git's statusMatrix plus a re-hash of the files Squiggle wrote (its stat check misses a same-size edit
// made in the same second). Unchanged files are left out unless `all`.
async function status(c, env, { all = false } = {}) {
  const { git, fs, dir } = c;
  const matrix = await git.statusMatrix({ fs, dir });
  const headOid = await c.head();
  const headFiles = await treeFiles(c, headOid);
  const index = await indexFiles(c);
  const written = new Set(env.written ? env.written() : []);
  // git's "racy clean" rule: a file changed no earlier than the index was written can look unchanged to a
  // size-and-mtime check (seconds only), so it's hashed rather than trusted.
  const indexSecs = Math.floor(await c.pfs.stat(`${dir}/.git/index`).then(st => st.mtimeMs, () => 0) / 1000);
  const racy = async (path) => { const st = await c.pfs.stat(`${dir}/${path}`).catch(() => null); return Boolean(st && Math.floor(st.mtimeMs / 1000) >= indexSecs); };
  const rows = [];
  for (const [path, _h, w, s] of matrix) {
    const ho = headFiles.get(path) || null, io = index.get(path) || null;
    let wo;
    if (w === 0) wo = null;
    else if (written.has(path) || !(w === 1 || (w === 2 && s === 2)) || await racy(path)) {
      const data = await c.pfs.readFile(`${dir}/${path}`).catch(() => null);
      wo = data ? (await git.hashBlob({ object: data })).oid : null;
    } else wo = w === 1 ? ho : io;
    if (!all && ho === io && io === wo) continue;
    rows.push({ path, head: ho, index: io, work: wo });
  }
  return rows;
}

// Paths matching what the user named: files, directories (everything under them), globs, '.' (everything under
// the shell's directory). No pathspecs: everything.
function matcher(c, specs) {
  if (!specs || !specs.length) return () => true;
  const tests = specs.map(spec => {
    const r = c.rel(spec);
    if (/[*?[]/.test(spec)) {
      const re = new RegExp('^' + r.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*') + '$');
      return (p) => re.test(p) || re.test(p.split('/').pop());
    }
    return (p) => !r || p === r || p.startsWith(r + '/');
  });
  return (p) => tests.some(t => t(p));
}
const short = (oid) => (oid || '0000000').slice(0, 7);

// ── Formatting commits ─────────────────────────────────────────────────────

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// git's default date: "Thu Nov 12 12:55:01 2026 -0700", in the commit's own zone.
export function gitDate(sig, kind = 'default') {
  const offMin = -(sig.timezoneOffset || 0);
  const d = new Date((sig.timestamp + offMin * 60) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const zone = `${offMin < 0 ? '-' : '+'}${p(Math.floor(Math.abs(offMin) / 60))}${p(Math.abs(offMin) % 60)}`;
  if (kind === 'iso') return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${zone}`;
  if (kind === 'short') return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  if (kind === 'relative') return relative(sig.timestamp);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()} ${zone}`;
}
function relative(ts) {
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  const units = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']];
  for (const [n, u] of units) if (s >= n) { const k = Math.floor(s / n); return `${k} ${u}${k === 1 ? '' : 's'} ago`; }
  return 'just now';
}

// Which branches and tags point at each commit, for "(HEAD -> main, origin/main)".
async function decorations(c) {
  const { git, fs, dir } = c;
  const by = new Map();
  const add = (oid, name) => { if (oid) by.set(oid, [...(by.get(oid) || []), name]); };
  const cur = await c.branch();
  const head = await c.head();
  for (const b of await git.listBranches({ fs, dir }).catch(() => [])) add(await git.resolveRef({ fs, dir, ref: `refs/heads/${b}` }).catch(() => null), b === cur ? `HEAD -> ${b}` : b);
  if (!cur && head) add(head, 'HEAD');
  for (const b of await git.listBranches({ fs, dir, remote: 'origin' }).catch(() => [])) if (b !== 'HEAD') add(await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${b}` }).catch(() => null), `origin/${b}`);
  for (const t of await git.listTags({ fs, dir }).catch(() => [])) add(await resolveRev(c, t).catch(() => null), `tag: ${t}`);
  for (const [oid, names] of by) by.set(oid, names.sort((a, b) => (b.startsWith('HEAD') ? 1 : 0) - (a.startsWith('HEAD') ? 1 : 0)));
  return by;
}

function formatCommit(entry, fmt, deco) {
  const { oid, commit } = entry;
  const [subject, ...rest] = commit.message.replace(/\n+$/, '').split('\n');
  const body = rest.join('\n').replace(/^\n+/, '');
  const d = deco && deco.get(oid);
  const refs = d && d.length ? ` (${d.join(', ')})` : '';
  if (fmt === 'oneline') return `${short(oid)}${refs} ${subject}`;
  if (fmt.startsWith('format:') || fmt.startsWith('tformat:')) {
    const f = fmt.replace(/^t?format:/, '');
    return f.replace(/%(H|h|T|t|P|p|s|b|B|an|ae|ad|ar|as|ai|cn|ce|cd|cr|cs|ci|d|D|n|%)/g, (_, k) => ({
      H: oid, h: short(oid), T: commit.tree, t: short(commit.tree), P: commit.parent.join(' '), p: commit.parent.map(short).join(' '),
      s: subject, b: body ? body + '\n' : '', B: commit.message, an: commit.author.name, ae: commit.author.email,
      ad: gitDate(commit.author), ar: relative(commit.author.timestamp), as: gitDate(commit.author, 'short'), ai: gitDate(commit.author, 'iso'),
      cn: commit.committer.name, ce: commit.committer.email, cd: gitDate(commit.committer), cr: relative(commit.committer.timestamp),
      cs: gitDate(commit.committer, 'short'), ci: gitDate(commit.committer, 'iso'), d: refs, D: d ? d.join(', ') : '', n: '\n', '%': '%',
    })[k]);
  }
  const lines = [`commit ${oid}${refs}`];
  if (commit.parent.length > 1) lines.push(`Merge: ${commit.parent.map(short).join(' ')}`);
  lines.push(`Author: ${commit.author.name} <${commit.author.email}>`);
  if (fmt === 'full' || fmt === 'fuller') lines.push(`Commit: ${commit.committer.name} <${commit.committer.email}>`);
  if (fmt !== 'short') lines.push(`Date:   ${gitDate(commit.author)}`);
  lines.push('', ...commit.message.replace(/\n+$/, '').split('\n').map(l => `    ${l}`).filter((l, i) => fmt !== 'short' || i === 0));
  return lines.join('\n');
}
const fmtOf = (o) => {
  if (o.oneline) return 'oneline';
  const f = o.pretty || o.format;
  if (!f || f === true) return 'medium';
  if (['oneline', 'short', 'medium', 'full', 'fuller'].includes(f)) return f;
  return /^t?format:/.test(f) ? f : `tformat:${f}`;
};

// The changes between two snapshots of the repo: [{ path, before, after, oids }]. Sides are 'commit' (an oid),
// 'index' or 'work'.
async function changes(c, env, from, to, match = () => true) {
  const side = async (s) => {
    if (s.kind === 'commit') return { files: await treeFiles(c, s.oid), text: (p, oid) => c.blobByOid(oid) };
    if (s.kind === 'index') return { files: await indexFiles(c), text: (p, oid) => c.blobByOid(oid) };
    const rows = await status(c, env, { all: true });   // the working tree: tracked files as they are now
    const files = new Map(rows.filter(r => r.work && (r.index || r.head)).map(r => [r.path, r.work]));
    return { files, text: (p) => c.read(p) };
  };
  const A = await side(from), B = await side(to);
  const paths = [...new Set([...A.files.keys(), ...B.files.keys()])].filter(match).sort();
  const out = [];
  for (const p of paths) {
    const ao = A.files.get(p) || null, bo = B.files.get(p) || null;
    if (ao === bo) continue;
    out.push({ path: p, before: ao ? await A.text(p, ao) : null, after: bo ? await B.text(p, bo) : null, oids: [short(ao), short(bo)], status: !ao ? 'A' : !bo ? 'D' : 'M' });
  }
  return out;
}
function renderChanges(list, o) {
  if (o['name-only']) return list.map(x => x.path).join('\n') + (list.length ? '\n' : '');
  if (o['name-status']) return list.map(x => `${x.status}\t${x.path}`).join('\n') + (list.length ? '\n' : '');
  const counted = () => list.map(x => ({ path: x.path, ...(countLines(x.before, x.after) || { add: null, del: null }) }));
  if (o.numstat) return counted().map(f => `${f.add ?? '-'}\t${f.del ?? '-'}\t${f.path}`).join('\n') + (list.length ? '\n' : '');
  if (o.stat) return statLines(counted());
  if (o.shortstat) { const s = statLines(counted()).trim().split('\n'); return list.length ? ` ${s[s.length - 1].trim()}\n` : ''; }
  const context = o.U != null && o.U !== true ? +o.U : o.unified != null && o.unified !== true ? +o.unified : 3;
  return list.map(x => unifiedDiff({ path: x.path, before: x.before, after: x.after, oids: x.oids, context })).join('');
}

// Commits for log: from the given tips, without those reachable from the excluded ones, newest first.
async function walkCommits(c, tips, excludes, { firstParent = false, max = 1000 } = {}) {
  const { git, fs, dir } = c;
  const hidden = new Set();
  for (const x of excludes) for (const e of await git.log({ fs, dir, ref: x, depth: max }).catch(() => [])) hidden.add(e.oid);
  const seen = new Set(), out = [];
  const queue = [];
  for (const t of tips) { const e = await git.readCommit({ fs, dir, oid: t }); queue.push(e); }
  while (queue.length && out.length < max) {
    queue.sort((a, b) => b.commit.committer.timestamp - a.commit.committer.timestamp);
    const e = queue.shift();
    if (seen.has(e.oid) || hidden.has(e.oid)) continue;
    seen.add(e.oid);
    out.push(e);
    for (const p of firstParent ? e.commit.parent.slice(0, 1) : e.commit.parent) {
      if (!seen.has(p) && !hidden.has(p)) { try { queue.push(await git.readCommit({ fs, dir, oid: p })); } catch { /* shallow clone edge */ } }
    }
  }
  return out;
}

// Revision arguments to tips and exclusions: "A..B", "A...B", "^A", names.
async function revRange(c, args) {
  const tips = [], excludes = [];
  for (const a of args) {
    let m;
    if ((m = /^(.*?)\.\.\.(.*)$/.exec(a))) {
      const x = await resolveRev(c, m[1] || 'HEAD'), y = await resolveRev(c, m[2] || 'HEAD');
      tips.push(x, y);
      for (const b of await c.git.findMergeBase({ fs: c.fs, dir: c.dir, oids: [x, y] })) excludes.push(b);
    } else if ((m = /^(.*?)\.\.(.*)$/.exec(a))) {
      excludes.push(await resolveRev(c, m[1] || 'HEAD'));
      tips.push(await resolveRev(c, m[2] || 'HEAD'));
    } else if (a.startsWith('^')) excludes.push(await resolveRev(c, a.slice(1)));
    else tips.push(await resolveRev(c, a));
  }
  return { tips, excludes };
}

async function filesChangedBy(c, entry) {
  const now = await treeFiles(c, entry.oid);
  const before = await treeFiles(c, entry.commit.parent[0] || null);
  const paths = new Set([...now.keys(), ...before.keys()]);
  return [...paths].filter(p => now.get(p) !== before.get(p));
}

// Separate a command's revisions from its paths: before `--`, a word that isn't a revision but is a path.
async function revsAndPaths(c, o) {
  const revs = [], paths = o.paths ? [...o.paths] : [];
  for (const a of o._) {
    if (/\.\./.test(a) || a.startsWith('^') || await isRev(c, a)) revs.push(a);
    else paths.push(a);
  }
  return { revs, paths };
}

// ── Subcommands ────────────────────────────────────────────────────────────

const cmds = {};

cmds.status = async (c, env, argv) => {
  const o = parseArgs(argv, ['u', 'untracked-files']);
  const rows = await status(c, env);
  const match = matcher(c, [...o._, ...(o.paths || [])]);
  const list = rows.filter(r => match(r.path));
  const branch = await c.branch();
  const track = branch ? await tracking(c, branch) : null;
  const shortStatus = o.s || o.short || o.porcelain;
  if (shortStatus) {
    const lines = [];
    if (o.b || o.branch) lines.push(`## ${branch || 'HEAD (no branch)'}${track ? `...origin/${branch}${track.ahead || track.behind ? ` [${[track.ahead && `ahead ${track.ahead}`, track.behind && `behind ${track.behind}`].filter(Boolean).join(', ')}]` : ''}` : ''}`);
    for (const r of list) {
      if (!r.head && !r.index) { lines.push(`?? ${r.path}`); continue; }
      const x = r.head === r.index ? ' ' : !r.head ? 'A' : !r.index ? 'D' : 'M';
      const y = !r.index ? ' ' : r.index === r.work ? ' ' : !r.work ? 'D' : 'M';
      if (x !== ' ' || y !== ' ') lines.push(`${x}${y} ${r.path}`);
      if (r.head && !r.index && r.work) lines.push(`?? ${r.path}`);
    }
    return ok(lines.join('\n'));
  }
  const staged = [], unstaged = [], untracked = [];
  for (const r of list) {
    if (!r.head && !r.index) { untracked.push(r.path); continue; }
    if (r.head !== r.index) staged.push(`\t${`${!r.head ? 'new file' : !r.index ? 'deleted' : 'modified'}:`.padEnd(12)}${r.path}`);
    if (r.index && r.index !== r.work) unstaged.push(`\t${`${!r.work ? 'deleted' : 'modified'}:`.padEnd(12)}${r.path}`);
    if (r.head && !r.index && r.work) untracked.push(r.path);
  }
  const out = [branch ? `On branch ${branch}` : `HEAD detached at ${short(await c.head())}`];
  if (track) {
    if (!track.ahead && !track.behind) out.push(`Your branch is up to date with 'origin/${branch}'.`);
    else if (track.ahead && track.behind) out.push(`Your branch and 'origin/${branch}' have diverged,`, `and have ${track.ahead} and ${track.behind} different commits each, respectively.`);
    else if (track.ahead) out.push(`Your branch is ahead of 'origin/${branch}' by ${track.ahead} commit${track.ahead === 1 ? '' : 's'}.`, '  (use "git push" to publish your local commits)');
    else out.push(`Your branch is behind 'origin/${branch}' by ${track.behind} commit${track.behind === 1 ? '' : 's'}, and can be fast-forwarded.`, '  (use "git pull" to update your local branch)');
  }
  if (!(await c.head())) out.push('', 'No commits yet');
  if (staged.length) out.push('', 'Changes to be committed:', '  (use "git restore --staged <file>..." to unstage)', ...staged);
  if (unstaged.length) out.push('', 'Changes not staged for commit:', '  (use "git add <file>..." to update what will be committed)', '  (use "git restore <file>..." to discard changes in working directory)', ...unstaged);
  if (untracked.length && o.u !== 'no' && o['untracked-files'] !== 'no') out.push('', 'Untracked files:', '  (use "git add <file>..." to include in what will be committed)', ...untracked.map(p => `\t${p}`));
  out.push('');
  if (!staged.length && !unstaged.length && !untracked.length) out.push('nothing to commit, working tree clean');
  else if (!staged.length) out.push(unstaged.length ? 'no changes added to commit (use "git add" and/or "git commit -a")' : 'nothing added to commit but untracked files present (use "git add" to track)');
  return ok(out.join('\n'));
};

async function tracking(c, branch) {
  const { git, fs, dir } = c;
  const remote = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${branch}` }).catch(() => null);
  const local = await git.resolveRef({ fs, dir, ref: `refs/heads/${branch}` }).catch(() => null);
  if (!remote || !local) return null;
  if (remote === local) return { ahead: 0, behind: 0 };
  const ahead = (await walkCommits(c, [local], [remote], { max: 500 })).length;
  const behind = (await walkCommits(c, [remote], [local], { max: 500 })).length;
  return { ahead, behind };
}

cmds.add = async (c, env, argv) => {
  const o = parseArgs(argv);
  if (o.p || o.patch || o.i || o.interactive) return fatal('interactive add isn\'t available here; add whole files');
  const specs = [...o._, ...(o.paths || [])];
  if (!specs.length && !o.A && !o.all && !o.u && !o.update) return fail('Nothing specified, nothing added.\nhint: Maybe you wanted to say \'git add .\'?', 0);
  const everything = (o.A || o.all) && !specs.length;
  const match = everything ? () => true : o.u && !specs.length ? () => true : matcher(c, specs);
  const rows = await status(c, env);
  const picked = rows.filter(r => match(r.path) && !((o.u || o.update) && !r.head && !r.index));
  for (const spec of specs) {
    const r = c.rel(spec);
    if (r && !/[*?[]/.test(spec) && !rows.some(x => x.path === r || x.path.startsWith(r + '/'))) {
      const tracked = (await indexFiles(c)).has(r) || [...(await indexFiles(c)).keys()].some(p => p.startsWith(r + '/'));
      const there = await c.pfs.stat(`${c.dir}/${r}`).then(() => true, () => false);
      if (!tracked && !there) return fatal(`pathspec '${spec}' did not match any files`);
      if (!tracked && there && await c.git.isIgnored({ fs: c.fs, dir: c.dir, filepath: r }) && !o.f && !o.force) {
        return fail(`The following paths are ignored by one of your .gitignore files:\n${r}\nhint: Use -f if you really want to add them.`);
      }
      if (!tracked && there && (o.f || o.force)) await c.git.add({ fs: c.fs, dir: c.dir, filepath: r, force: true });
    }
  }
  const lines = [];
  for (const r of picked) {
    if (o.n || o['dry-run']) { lines.push(`${r.work ? 'add' : 'remove'} '${r.path}'`); continue; }
    if (!r.work) await c.git.remove({ fs: c.fs, dir: c.dir, filepath: r.path });
    else await c.git.add({ fs: c.fs, dir: c.dir, filepath: r.path });
    if (o.v || o.verbose) lines.push(`${r.work ? 'add' : 'remove'} '${r.path}'`);
  }
  return ok(lines.join('\n'));
};

cmds.rm = async (c, env, argv) => {
  const o = parseArgs(argv);
  const specs = [...o._, ...(o.paths || [])];
  if (!specs.length) return fatal('No pathspec was given. Which files should I remove?');
  const index = await indexFiles(c);
  const out = [];
  for (const spec of specs) {
    const r = c.rel(spec), match = matcher(c, [spec]);
    const hits = [...index.keys()].filter(match);
    if (!hits.length) { if (o['ignore-unmatch']) continue; return fatal(`pathspec '${spec}' did not match any files`); }
    if (hits.some(p => p !== r) && !(o.r || o.R) && !/[*?[]/.test(spec)) return fatal(`not removing '${spec}' recursively without -r`);
    for (const p of hits) {
      if (!(o.n || o['dry-run'])) {
        await c.git.remove({ fs: c.fs, dir: c.dir, filepath: p });
        if (!o.cached) await c.remove(p);
      }
      if (!(o.q || o.quiet)) out.push(`rm '${p}'`);
    }
  }
  return ok(out.join('\n'));
};

cmds.mv = async (c, env, argv) => {
  const o = parseArgs(argv);
  const args = o._;
  if (args.length < 2) return fail('usage: git mv <source>... <destination>', 129);
  const dest = c.rel(args[args.length - 1]);
  const index = await indexFiles(c);
  const destIsDir = await c.pfs.stat(`${c.dir}/${dest}`).then(s => s.isDirectory(), () => false);
  for (const src of args.slice(0, -1).map(c.rel)) {
    const moving = [...index.keys()].filter(p => p === src || p.startsWith(src + '/'));
    if (!moving.length) return fatal(`not under version control, source=${src}, destination=${dest}`);
    const target = destIsDir || args.length > 2 ? join(dest, src.split('/').pop()) : dest;
    for (const p of moving) {
      const to = p === src ? target : join(target, p.slice(src.length + 1));
      const text = await c.pfs.readFile(`${c.dir}/${p}`);
      await c.write(to, text);
      await c.remove(p);
      await c.git.remove({ fs: c.fs, dir: c.dir, filepath: p });
      await c.git.add({ fs: c.fs, dir: c.dir, filepath: to });
    }
  }
  return ok('');
};

// Put files back as they are in the index (or a commit), and/or put the index entries back as in HEAD.
async function restorePaths(c, env, specs, { source = null, staged = false, worktree = true }) {
  const match = matcher(c, specs);
  const srcOid = source ? await resolveRev(c, source) : null;
  const headFiles = await treeFiles(c, await c.head());
  const index = await indexFiles(c);
  const from = srcOid ? await treeFiles(c, srcOid) : null;
  const known = new Set([...headFiles.keys(), ...index.keys(), ...(from ? from.keys() : [])]);
  for (const spec of specs) {
    const r = c.rel(spec);
    if (![...known].some(p => !r || p === r || p.startsWith(r + '/') || match(p))) throw new GitError(`pathspec '${spec}' did not match any file(s) known to git`, 1);
  }
  for (const p of [...known].filter(match)) {
    if (staged) {
      const want = from ? from.get(p) : headFiles.get(p);
      if (want) await c.git.updateIndex({ fs: c.fs, dir: c.dir, filepath: p, oid: want, add: true });
      else if (index.has(p)) await c.git.remove({ fs: c.fs, dir: c.dir, filepath: p });
    }
    if (worktree) {
      const want = from ? from.get(p) : (staged ? headFiles.get(p) : index.get(p));
      if (want) await c.write(p, await c.blobByOid(want));
      else if (from || staged) await c.remove(p);
      if (from && !staged) {   // checkout <rev> -- path also stages it
        if (want) await c.git.updateIndex({ fs: c.fs, dir: c.dir, filepath: p, oid: want, add: true });
      }
    }
  }
}

cmds.restore = async (c, env, argv) => {
  const o = parseArgs(argv, ['s', 'source']);
  const specs = [...o._, ...(o.paths || [])];
  if (!specs.length) return fatal('you must specify path(s) to restore');
  const staged = Boolean(o.S || o.staged), worktree = Boolean(o.W || o.worktree) || !staged;
  await restorePaths(c, env, specs, { source: o.s || o.source || null, staged, worktree });
  return ok('');
};

// A new branch's name: Squiggle's own work goes on agent/ branches (pushing them needs no approval).
async function newBranchName(env, raw) { return env.agentBranchName ? env.agentBranchName(raw) : raw; }

async function switchTo(c, env, name, { create = false, force = false, start = null, detach = false } = {}) {
  const { git, fs, dir } = c;
  const local = await git.listBranches({ fs, dir });
  const remote = await git.listBranches({ fs, dir, remote: 'origin' }).catch(() => []);
  if (detach) {
    const oid = await resolveRev(c, name);
    await git.checkout({ fs, dir, ref: oid, force });
    return ok(`HEAD is now at ${short(oid)} ${(await git.readCommit({ fs, dir, oid })).commit.message.split('\n')[0]}`);
  }
  if (create) {
    const branch = await newBranchName(env, name);
    if (local.includes(branch) && create !== 'force') return fatal(`a branch named '${branch}' already exists`);
    const from = start ? await resolveRev(c, start) : await c.head();
    if (!from) {   // no commits yet: just point HEAD at the new branch
      await git.writeRef({ fs, dir, ref: 'HEAD', value: `refs/heads/${branch}`, symbolic: true, force: true });
      return ok(`Switched to a new branch '${branch}'`);
    }
    await git.branch({ fs, dir, ref: branch, object: from, checkout: false, force: create === 'force' });
    if (start) await git.checkout({ fs, dir, ref: branch, force });
    else await git.checkout({ fs, dir, ref: branch, noCheckout: true });   // keeps uncommitted changes
    const renamed = branch !== name ? `\n(Squiggle starts its branches with agent/, so it's '${branch}': pushing it needs no approval.)` : '';
    return { stdout: renamed ? renamed.slice(1) + '\n' : '', stderr: `Switched to a new branch '${branch}'\n`, exitCode: 0 };
  }
  if (!local.includes(name)) {
    if (remote.includes(name)) {
      const oid = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${name}` });
      await git.branch({ fs, dir, ref: name, object: oid, checkout: false });
      await git.checkout({ fs, dir, ref: name, force });
      return { stdout: `branch '${name}' set up to track 'origin/${name}'.\n`, stderr: `Switched to a new branch '${name}'\n`, exitCode: 0 };
    }
    return null;
  }
  if ((await c.branch()) === name) return { stdout: '', stderr: `Already on '${name}'\n`, exitCode: 0 };
  try { await git.checkout({ fs, dir, ref: name, force }); }
  catch (e) {
    return fail(`error: Your local changes to the following files would be overwritten by checkout:\n\t${(e.data && e.data.filepaths || []).join('\n\t') || e.message}\nPlease commit your changes or stash them before you switch branches.\nAborting`);
  }
  const t = await tracking(c, name);
  return { stdout: t ? (t.ahead || t.behind ? `Your branch is ${t.ahead ? `ahead of 'origin/${name}' by ${t.ahead} commit(s)` : `behind 'origin/${name}' by ${t.behind} commit(s)`}.\n` : `Your branch is up to date with 'origin/${name}'.\n`) : '', stderr: `Switched to branch '${name}'\n`, exitCode: 0 };
}

cmds.checkout = async (c, env, argv) => {
  const o = parseArgs(argv, ['b', 'B']);
  if (o.b || o.B) return switchTo(c, env, o.b || o.B, { create: o.B ? 'force' : true, start: o._[0] || null, force: Boolean(o.f || o.force) });
  if (o.paths) {   // checkout [<rev>] -- <paths>
    await restorePaths(c, env, o.paths, { source: o._[0] || null, staged: false, worktree: true });
    return ok('');
  }
  const [target, ...more] = o._;
  if (!target) return fail('error: you must name a branch, a commit or -- <paths>');
  if (target === '-') return fail('error: `git checkout -` isn\'t available here; name the branch');
  if (o.detach) return switchTo(c, env, target, { detach: true, force: Boolean(o.f || o.force) });
  const sw = await switchTo(c, env, target, { force: Boolean(o.f || o.force) });
  if (sw) return sw;
  if (await isRev(c, target)) {
    if (more.length) { await restorePaths(c, env, more, { source: target }); return ok(''); }
    const res = await switchTo(c, env, target, { detach: true, force: Boolean(o.f || o.force) });
    return { ...res, stderr: `Note: switching to '${target}'.\n\nYou are in 'detached HEAD' state. To keep commits you make here, start a branch: git switch -c <name>\n` };
  }
  await restorePaths(c, env, o._, {});   // checkout <path>
  return ok('');
};

cmds.switch = async (c, env, argv) => {
  const o = parseArgs(argv, ['c', 'C', 'create', 'force-create']);
  const make = o.c || o.create || o.C || o['force-create'];
  if (make) return switchTo(c, env, make, { create: o.C || o['force-create'] ? 'force' : true, start: o._[0] || null, force: Boolean(o.f || o.force || o['discard-changes']) });
  const [target] = o._;
  if (!target) return fatal('missing branch or commit argument');
  if (o.detach || o.d) return switchTo(c, env, target, { detach: true });
  const sw = await switchTo(c, env, target, { force: Boolean(o.f || o.force || o['discard-changes']) });
  if (sw) return sw;
  if (await isRev(c, target)) return fatal(`a branch is expected, got commit '${target}'\nhint: If you want to detach HEAD at the commit, try again with the --detach option.`);
  return fatal(`invalid reference: ${target}`);
};

cmds.branch = async (c, env, argv) => {
  const { git, fs, dir } = c;
  const o = parseArgs(argv, ['m', 'M', 'd', 'D', 'u', 'set-upstream-to', 'contains', 'merged', 'no-merged', 'list', 'format', 'sort']);
  const cur = await c.branch();
  if (o['show-current']) return ok(cur || '');
  if (o.u || o['set-upstream-to'] || o['unset-upstream']) return ok('');   // upstream is always origin/<same name> here
  const del = o.d || o.D || o.delete;
  if (del) {
    const names = [...(del === true ? [] : [del]), ...o._];
    const out = [];
    const head = await c.head();
    for (const n of names) {
      if (o.r || o.remotes) return fail('error: deleting branches on GitHub isn\'t available here');
      if (n === cur) return fail(`error: cannot delete branch '${n}' used by worktree at '/repos/${env.name}'`);
      const oid = await git.resolveRef({ fs, dir, ref: `refs/heads/${n}` }).catch(() => null);
      if (!oid) return fail(`error: branch '${n}' not found.`);
      if (!o.D && !o.force && head && oid !== head && !(await git.isDescendent({ fs, dir, oid: head, ancestor: oid, depth: -1 }).catch(() => false))) {
        return fail(`error: the branch '${n}' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D ${n}'.`);
      }
      await git.deleteBranch({ fs, dir, ref: n });
      out.push(`Deleted branch ${n} (was ${short(oid)}).`);
    }
    return ok(out.join('\n'));
  }
  const mv = o.m || o.M || o.move;
  if (mv) {
    const args = [...(mv === true ? [] : [mv]), ...o._];
    const [from, to] = args.length >= 2 ? args : [cur, args[0]];
    if (!to) return fatal('branch name required');
    await git.renameBranch({ fs, dir, oldref: from, ref: to, checkout: from === cur });
    return ok('');
  }
  if (o._.length && !o.list && !o.l && !o.a && !o.r) {   // create, don't switch
    const [raw, start] = o._;
    const name = await newBranchName(env, raw);
    const local = await git.listBranches({ fs, dir });
    if (local.includes(name) && !o.f && !o.force) return fatal(`a branch named '${name}' already exists`);
    await git.branch({ fs, dir, ref: name, object: start ? await resolveRev(c, start) : undefined, checkout: false, force: Boolean(o.f || o.force) });
    return ok(name !== raw ? `(Squiggle starts its branches with agent/, so it's '${name}'.)` : '');
  }
  // List.
  const pattern = typeof o.list === 'string' ? o.list : o._[0];
  const re = pattern ? new RegExp('^' + pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*') + '$') : null;
  const rows = [];
  const showLocal = !(o.r || o.remotes), showRemote = o.a || o.all || o.r || o.remotes;
  const merged = o.merged ? await resolveRev(c, o.merged === true ? 'HEAD' : o.merged) : null;
  const notMerged = o['no-merged'] ? await resolveRev(c, o['no-merged'] === true ? 'HEAD' : o['no-merged']) : null;
  const keep = async (oid) => {
    if (merged && !(oid === merged || await git.isDescendent({ fs, dir, oid: merged, ancestor: oid, depth: -1 }).catch(() => false))) return false;
    if (notMerged && (oid === notMerged || await git.isDescendent({ fs, dir, oid: notMerged, ancestor: oid, depth: -1 }).catch(() => false))) return false;
    return true;
  };
  const vv = argv.includes('-vv');
  const verbose = o.v || vv || o.verbose;
  const line = async (label, ref, star, upstream) => {
    const oid = await git.resolveRef({ fs, dir, ref }).catch(() => null);
    if (!oid || !await keep(oid)) return;
    if (!verbose) return rows.push(`${star ? '* ' : '  '}${label}`);
    const { commit } = await git.readCommit({ fs, dir, oid });
    rows.push({ star, label, rest: `${short(oid)}${upstream ? ` [${upstream}]` : ''} ${commit.message.split('\n')[0]}` });
  };
  if (!cur && showLocal && await c.head()) rows.push(`* (HEAD detached at ${short(await c.head())})`);
  if (showLocal) {
    for (const b of (await git.listBranches({ fs, dir })).sort()) {
      if (re && !re.test(b)) continue;
      let up = null;
      if (vv) { const t = await tracking(c, b); if (t) up = `origin/${b}${t.ahead || t.behind ? `: ${[t.ahead && `ahead ${t.ahead}`, t.behind && `behind ${t.behind}`].filter(Boolean).join(', ')}` : ''}`; }
      await line(b, `refs/heads/${b}`, b === cur, up);
    }
  }
  if (showRemote) {
    for (const b of (await git.listBranches({ fs, dir, remote: 'origin' }).catch(() => [])).sort()) {
      if (b === 'HEAD' || (re && !re.test(`origin/${b}`) && !re.test(b))) continue;
      await line(o.r || o.remotes ? `origin/${b}` : `remotes/origin/${b}`, `refs/remotes/origin/${b}`, false, null);
    }
  }
  const width = Math.max(0, ...rows.filter(r => typeof r === 'object').map(r => r.label.length));
  return ok(rows.map(r => (typeof r === 'string' ? r : `${r.star ? '* ' : '  '}${r.label.padEnd(width)} ${r.rest}`)).join('\n'));
};

cmds.commit = async (c, env, argv) => {
  const { git, fs, dir } = c;
  const o = parseArgs(argv, ['m', 'message', 'F', 'file', 'author', 'C', 'reuse-message', 'c', 'date', 'cleanup', 'u', 'untracked-files']);
  const branch = await c.branch();
  if (!branch) return fatal('You are not on a branch (detached HEAD). Start one first: git switch -c <name>');
  const amend = Boolean(o.amend);
  let message = (o.multi.m || o.multi.message || []).filter(x => x !== true).join('\n\n');
  if (o.F || o.file) {
    const f = o.F || o.file;
    message = f === '-' ? (env.stdin || '') : await c.read(c.rel(f));
    if (message == null) return fatal(`could not read log file '${f}': No such file or directory`);
  }
  if (o.C || o['reuse-message']) message = (await git.readCommit({ fs, dir, oid: await resolveRev(c, o.C || o['reuse-message']) })).commit.message;
  if (!message && !amend) return fail('Aborting commit due to empty commit message.\nhint: there is no editor here: give the message with -m "…"');
  if (o.s || o.signoff) {
    const me = await env.author();
    message = `${message.replace(/\n+$/, '')}\n\nSigned-off-by: ${me.name} <${me.email}>`;
  }
  // What goes in: -a stages tracked changes; paths stage those paths (only).
  let rows = await status(c, env);
  const paths = [...o._, ...(o.paths || [])];
  if (o.a || o.all) {
    for (const r of rows) {
      if (!r.head && !r.index) continue;
      if (!r.work) await git.remove({ fs, dir, filepath: r.path });
      else if (r.work !== r.index) await git.add({ fs, dir, filepath: r.path });
    }
  } else if (paths.length) {
    const match = matcher(c, paths);
    const hits = rows.filter(r => match(r.path) && (r.head || r.index));
    if (!hits.length) return fail(`error: pathspec '${paths[0]}' did not match any file(s) known to git`);
    for (const r of hits) { if (!r.work) await git.remove({ fs, dir, filepath: r.path }); else await git.add({ fs, dir, filepath: r.path }); }
  }
  rows = await status(c, env);
  const staged = rows.filter(r => r.head !== r.index);
  if (!staged.length && !o['allow-empty'] && !amend) {
    const unstaged = rows.filter(r => r.index && r.index !== r.work).length, untracked = rows.filter(r => !r.head && !r.index).length;
    const res = await cmds.status(c, env, []);
    return { stdout: res.stdout.replace(/\n(nothing to commit, working tree clean|no changes added.*|nothing added.*)\n?$/s, '\n') + (unstaged ? 'no changes added to commit (use "git add" and/or "git commit -a")\n' : untracked ? 'nothing added to commit but untracked files present (use "git add" to track)\n' : 'nothing to commit, working tree clean\n'), stderr: '', exitCode: 1 };
  }
  let author = await env.author();
  if (typeof o.author === 'string') { const m = /^(.*?)\s*<([^>]*)>$/.exec(o.author); if (m) author = { ...author, name: m[1], email: m[2] }; }
  const parentBefore = await c.head();
  const prev = amend && parentBefore ? (await git.readCommit({ fs, dir, oid: parentBefore })).commit : null;
  const oid = await git.commit({ fs, dir, message: message || (prev && prev.message) || 'Update', author, amend });
  const { commit } = await git.readCommit({ fs, dir, oid });
  const list = await changes(c, env, { kind: 'commit', oid: commit.parent[0] || null }, { kind: 'commit', oid });
  const counts = list.map(x => ({ path: x.path, ...(countLines(x.before, x.after) || { add: 0, del: 0 }) }));
  const ins = counts.reduce((s, x) => s + x.add, 0), del = counts.reduce((s, x) => s + x.del, 0);
  const root = !commit.parent.length ? ' (root-commit)' : '';
  const out = [`[${branch}${root} ${short(oid)}] ${commit.message.split('\n')[0]}`];
  out.push(` ${list.length} file${list.length === 1 ? '' : 's'} changed${ins || !del ? `, ${ins} insertion${ins === 1 ? '' : 's'}(+)` : ''}${del ? `, ${del} deletion${del === 1 ? '' : 's'}(-)` : ''}`);
  for (const x of list) if (x.status === 'A') out.push(` create mode 100644 ${x.path}`); else if (x.status === 'D') out.push(` delete mode 100644 ${x.path}`);
  if (o.q || o.quiet) return ok('');
  return ok(out.join('\n'));
};

cmds.log = async (c, env, argv) => {
  const o = parseArgs(argv, ['n', 'max-count', 'pretty', 'format', 'author', 'grep', 'since', 'after', 'until', 'before', 'skip', 'U', 'unified', 'date']);
  const { revs, paths } = await revsAndPaths(c, o);
  let tips, excludes;
  if (o.all) {
    tips = [];
    for (const b of await c.git.listBranches({ fs: c.fs, dir: c.dir })) tips.push(await resolveRev(c, b));
    for (const b of await c.git.listBranches({ fs: c.fs, dir: c.dir, remote: 'origin' }).catch(() => [])) if (b !== 'HEAD') tips.push(await resolveRev(c, `origin/${b}`));
    excludes = [];
  } else {
    if (!(await c.head()) && !revs.length) return fatal(`your current branch '${await c.branch() || 'main'}' does not have any commits yet`);
    ({ tips, excludes } = await revRange(c, revs.length ? revs : ['HEAD']));
    if (!tips.length) tips = [await resolveRev(c, 'HEAD')];
  }
  const n = o.n || o['max-count'];
  const limit = n && n !== true ? +n : Infinity;
  let list = await walkCommits(c, tips, excludes, { firstParent: Boolean(o['first-parent']), max: Number.isFinite(limit) ? Math.max(limit * 4, 200) : 1000 });
  const when = (v) => { const t = Date.parse(v); if (!Number.isNaN(t)) return t / 1000; const m = /(\d+)\s*(second|minute|hour|day|week|month|year)s?/.exec(v); if (!m) return null; const mult = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 }[m[2]]; return Date.now() / 1000 - +m[1] * mult; };
  const since = o.since || o.after, until = o.until || o.before;
  if (since) { const t = when(since); if (t) list = list.filter(e => e.commit.committer.timestamp >= t); }
  if (until) { const t = when(until); if (t) list = list.filter(e => e.commit.committer.timestamp <= t); }
  if (o.author) { const re = new RegExp(o.author, 'i'); list = list.filter(e => re.test(`${e.commit.author.name} <${e.commit.author.email}>`)); }
  if (o.grep) { const re = new RegExp(o.grep, o.i || o['regexp-ignore-case'] ? 'i' : ''); list = list.filter(e => re.test(e.commit.message)); }
  if (o['no-merges']) list = list.filter(e => e.commit.parent.length < 2);
  if (o.merges) list = list.filter(e => e.commit.parent.length > 1);
  if (paths.length) {
    const match = matcher(c, paths);
    const kept = [];
    for (const e of list) if ((await filesChangedBy(c, e)).some(match)) kept.push(e);
    list = kept;
  }
  if (o.skip) list = list.slice(+o.skip);
  const capped = !Number.isFinite(limit) && list.length > 50;
  list = list.slice(0, Number.isFinite(limit) ? limit : 50);
  if (o.reverse) list.reverse();
  const fmt = fmtOf(o);
  const deco = fmt === 'oneline' && !o['no-decorate'] || o.decorate ? await decorations(c) : (fmt === 'medium' && !o['no-decorate'] ? await decorations(c) : null);
  const patch = o.p || o.patch || o.u, stat = o.stat || o.shortstat || o.numstat || o['name-only'] || o['name-status'];
  const out = [];
  for (const e of list) {
    let text = formatCommit(e, fmt, deco);
    if (o.graph) text = text.split('\n').map((l, i) => (i ? '| ' : '* ') + l).join('\n');
    if (patch || stat) {
      const ch = await changes(c, env, { kind: 'commit', oid: e.commit.parent[0] || null }, { kind: 'commit', oid: e.oid }, paths.length ? matcher(c, paths) : undefined);
      const body = renderChanges(ch, patch ? o : o);
      text += (fmt === 'oneline' ? '\n' : '\n\n') + body.replace(/\n$/, '');
    }
    out.push(text);
  }
  const sep = fmt === 'oneline' || fmt.startsWith('tformat:') || fmt.startsWith('format:') ? '\n' : '\n\n';
  return { stdout: out.join(sep) + (out.length ? '\n' : ''), stderr: capped ? '(showing the newest 50 commits; use -n to see more)\n' : '', exitCode: 0 };
};

cmds.show = async (c, env, argv) => {
  const o = parseArgs(argv, ['pretty', 'format', 'U', 'unified']);
  const targets = o._.length ? o._ : ['HEAD'];
  const out = [];
  for (const t of targets) {
    const colon = t.indexOf(':');
    if (colon >= 0 && !/^[a-z]+:\/\//.test(t)) {   // <rev>:<path>
      const oid = await resolveRev(c, t.slice(0, colon) || 'HEAD');
      const path = t.slice(colon + 1).startsWith('./') ? c.rel(t.slice(colon + 1)) : normPath(t.slice(colon + 1));
      const files = await treeFiles(c, oid);
      if (files.has(path)) { out.push((await c.blobByOid(files.get(path))).replace(/\n$/, '')); continue; }
      const under = [...files.keys()].filter(p => !path || p.startsWith(path + '/')).map(p => p.slice(path ? path.length + 1 : 0).split('/')[0]);
      if (under.length) { out.push(`tree ${t}\n\n${[...new Set(under)].map(x => files.has(join(path, x)) ? x : x + '/').join('\n')}`); continue; }
      return fatal(`path '${path}' does not exist in '${t.slice(0, colon) || 'HEAD'}'`);
    }
    const oid = await resolveRev(c, t);
    const entry = await c.git.readCommit({ fs: c.fs, dir: c.dir, oid });
    let text = formatCommit(entry, fmtOf(o), fmtOf(o) === 'medium' ? await decorations(c) : null);
    if (!(o.s || o['no-patch'])) {
      const ch = await changes(c, env, { kind: 'commit', oid: entry.commit.parent[0] || null }, { kind: 'commit', oid }, o.paths ? matcher(c, o.paths) : undefined);
      const body = renderChanges(ch, o);
      if (body) text += (fmtOf(o) === 'oneline' ? '\n' : '\n\n') + body.replace(/\n$/, '');
    }
    out.push(text);
  }
  return ok(out.join('\n\n'));
};

cmds.diff = async (c, env, argv) => {
  const o = parseArgs(argv, ['U', 'unified', 'diff-filter']);
  const { revs, paths } = await revsAndPaths(c, o);
  const match = paths.length ? matcher(c, paths) : undefined;
  let from, to;
  const cached = o.cached || o.staged;
  if (revs.length === 1 && /\.\.\./.test(revs[0])) {
    const [a, b] = revs[0].split('...');
    const x = await resolveRev(c, a || 'HEAD'), y = await resolveRev(c, b || 'HEAD');
    const [base] = await c.git.findMergeBase({ fs: c.fs, dir: c.dir, oids: [x, y] });
    from = { kind: 'commit', oid: base }; to = { kind: 'commit', oid: y };
  } else if (revs.length === 1 && /\.\./.test(revs[0])) {
    const [a, b] = revs[0].split('..');
    from = { kind: 'commit', oid: await resolveRev(c, a || 'HEAD') }; to = { kind: 'commit', oid: await resolveRev(c, b || 'HEAD') };
  } else if (revs.length === 2) {
    from = { kind: 'commit', oid: await resolveRev(c, revs[0]) }; to = { kind: 'commit', oid: await resolveRev(c, revs[1]) };
  } else if (revs.length === 1) {
    from = { kind: 'commit', oid: await resolveRev(c, revs[0]) }; to = cached ? { kind: 'index' } : { kind: 'work' };
  } else if (cached) {
    from = { kind: 'commit', oid: await c.head() }; to = { kind: 'index' };
  } else {
    from = { kind: 'index' }; to = { kind: 'work' };
  }
  let list = await changes(c, env, from, to, match);
  if (o['diff-filter']) list = list.filter(x => o['diff-filter'].includes(x.status));
  if (o.quiet || o['exit-code']) return { stdout: o.quiet ? '' : renderChanges(list, o), stderr: '', exitCode: list.length ? 1 : 0 };
  return ok(renderChanges(list, o));
};

cmds.reset = async (c, env, argv) => {
  const { git, fs, dir } = c;
  const o = parseArgs(argv);
  const mode = o.hard ? 'hard' : o.soft ? 'soft' : 'mixed';
  const { revs, paths } = await revsAndPaths(c, o);
  if (paths.length) {   // reset [<rev>] -- paths: unstage
    await restorePaths(c, env, paths, { source: revs[0] || null, staged: true, worktree: false });
    return ok('');
  }
  const target = await resolveRev(c, revs[0] || 'HEAD');
  const branch = await c.branch();
  if (branch) await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: target, force: true });
  else await git.writeRef({ fs, dir, ref: 'HEAD', value: target, force: true });
  if (mode === 'soft') return ok('');
  // The index (and for --hard the files) as at the target.
  const files = await treeFiles(c, target);
  const index = await indexFiles(c);
  for (const p of index.keys()) if (!files.has(p)) await git.remove({ fs, dir, filepath: p });
  for (const [p, oid] of files) if (index.get(p) !== oid) await git.updateIndex({ fs, dir, filepath: p, oid, add: true });
  if (mode === 'hard') {
    const head = (await c.git.readCommit({ fs, dir, oid: target })).commit;
    for (const p of index.keys()) if (!files.has(p)) await c.remove(p);
    for (const [p, oid] of files) {
      const now = await c.read(p);
      const want = await c.blobByOid(oid);
      if (now !== want) await c.write(p, want);
    }
    return ok(`HEAD is now at ${short(target)} ${head.message.split('\n')[0]}`);
  }
  const rows = (await status(c, env)).filter(r => r.index !== r.work && (r.index || r.head));
  return ok(rows.length ? `Unstaged changes after reset:\n${rows.map(r => `${r.work ? 'M' : 'D'}\t${r.path}`).join('\n')}` : '');
};

cmds.stash = async (c, env, argv) => {
  const { git, fs, dir } = c;
  const [sub = 'push', ...rest] = argv;
  const o = parseArgs(['push', 'save', 'pop', 'apply', 'drop', 'list', 'clear', 'show'].includes(sub) ? rest : argv, ['m', 'message']);
  const op = ['push', 'save', 'pop', 'apply', 'drop', 'list', 'clear', 'show'].includes(sub) ? (sub === 'save' ? 'push' : sub) : 'push';
  const idx = (o._[0] || '').match(/stash@\{(\d+)\}|^(\d+)$/);
  const refIdx = idx ? +(idx[1] || idx[2]) : 0;
  // isomorphic-git's stash takes its author from the repo config only.
  for (const [k, v] of Object.entries({ 'user.name': (await env.author()).name, 'user.email': (await env.author()).email })) {
    if (!(await git.getConfig({ fs, dir, path: k }).catch(() => null))) await git.setConfig({ fs, dir, path: k, value: v });
  }
  if (['pop', 'apply', 'drop', 'show'].includes(op) && !((await git.stash({ fs, dir, op: 'list' }).catch(() => [])) || []).length) return fail('No stash entries found.');
  if (op === 'list') {
    const list = await git.stash({ fs, dir, op: 'list' });
    return ok((list || []).map((s, i) => { const t = typeof s === 'string' ? s : s.message || ''; return t.startsWith('stash@') ? t : `stash@{${i}}: ${t}`; }).join('\n'));
  }
  if (op === 'show') {
    const ref = `refs/stash`;
    const oid = await git.resolveRef({ fs, dir, ref }).catch(() => null);
    if (!oid) return fail('No stash entries found.');
    const e = await git.readCommit({ fs, dir, oid });
    return ok(renderChanges(await changes(c, env, { kind: 'commit', oid: e.commit.parent[0] }, { kind: 'commit', oid }), { stat: !o.p && !o.patch }));
  }
  if (op === 'push') {
    const rows = await status(c, env);
    if (!rows.some(r => r.head || r.index)) return ok('No local changes to save');
    const branch = await c.branch();
    const head = await c.head();
    const subject = head ? (await git.readCommit({ fs, dir, oid: head })).commit.message.split('\n')[0] : '';
    const message = o.m || o.message || o._.join(' ') || '';
    await git.stash({ fs, dir, op: 'push', message });
    return ok(`Saved working directory and index state ${message ? `On ${branch}: ${message}` : `WIP on ${branch}: ${short(head)} ${subject}`}`);
  }
  try { await git.stash({ fs, dir, op, refIdx }); }
  catch (e) { return fail(/no stash|not found|NotFound/i.test(e.message) ? 'No stash entries found.' : `error: ${e.message}`); }
  if (op === 'drop') return ok(`Dropped refs/stash@{${refIdx}}`);
  if (op === 'clear') return ok('');
  return cmds.status(c, env, []);
};

cmds.merge = async (c, env, argv) => {
  const { git, fs, dir } = c;
  const o = parseArgs(argv, ['m', 'message', 's', 'strategy', 'X', 'strategy-option']);
  if (o.abort) return ok('');   // merges that conflict never start here
  const [theirs] = o._;
  if (!theirs) return fatal('No remote for the current branch.');
  const ours = await c.branch();
  if (!ours) return fatal('You are not on a branch.');
  const before = await c.head();
  const theirOid = await resolveRev(c, theirs);
  if ((await status(c, env)).some(r => r.head !== r.index || (r.index && r.index !== r.work))) {
    return fail('error: Your local changes would be overwritten by merge.\nPlease commit your changes or stash them before you merge.\nAborting');
  }
  let res;
  try {
    res = await git.merge({ fs, dir, ours, theirs: theirOid, fastForward: !o['no-ff'], fastForwardOnly: Boolean(o['ff-only']), message: o.m || o.message || `Merge branch '${theirs}' into ${ours}`, author: await env.author(), abortOnConflict: true });
  } catch (e) {
    if (e.code === 'MergeConflictError' || /conflict/i.test(e.message)) {
      const files = (e.data && e.data.filepaths) || [];
      return fail(`${files.map(f => `CONFLICT (content): Merge conflict in ${f}`).join('\n')}\nAutomatic merge failed. Nothing was changed: fix it on a branch (for example, edit the files so they agree, commit, and merge again).`);
    }
    if (e.code === 'FastForwardError') return fatal('Not possible to fast-forward, aborting.');
    throw e;
  }
  if (res.alreadyMerged) return ok('Already up to date.');
  await git.checkout({ fs, dir, ref: ours, force: true });
  const list = await changes(c, env, { kind: 'commit', oid: before }, { kind: 'commit', oid: res.oid });
  const stat = statLines(list.map(x => ({ path: x.path, ...(countLines(x.before, x.after) || { add: null, del: null }) })));
  return ok(res.fastForward ? `Updating ${short(before)}..${short(res.oid)}\nFast-forward\n${stat}` : `Merge made by the 'ort' strategy.\n${stat}`);
};

cmds['cherry-pick'] = async (c, env, argv) => {
  const { git, fs, dir } = c;
  const o = parseArgs(argv);
  if (o.abort || o.continue || o.skip) return ok('');
  if ((await status(c, env)).some(r => r.head !== r.index || (r.index && r.index !== r.work))) {
    return fail('error: your local changes would be overwritten by cherry-pick.\nhint: commit your changes or stash them to proceed.');
  }
  const out = [];
  for (const rev of o._) {
    try {
      const oid = await git.cherryPick({ fs, dir, oid: await resolveRev(c, rev), committer: await env.author() });
      await git.checkout({ fs, dir, ref: await c.branch(), force: true });
      const { commit } = await git.readCommit({ fs, dir, oid });
      out.push(`[${await c.branch()} ${short(oid)}] ${commit.message.split('\n')[0]}`);
    } catch (e) {
      return fail(`error: could not apply ${rev}: ${/conflict/i.test(e.message) ? 'it conflicts with this branch; nothing was changed' : e.message}`);
    }
  }
  return ok(out.join('\n'));
};

cmds.fetch = async (c, env, argv) => {
  const o = parseArgs(argv, ['depth']);
  const [remote = 'origin', ref] = o._;
  if (remote !== 'origin') return fatal(`'${remote}' does not appear to be a git repository (the only remote here is origin)`);
  const res = await c.git.fetch({ fs: c.fs, dir: c.dir, remote: 'origin', ref, singleBranch: Boolean(ref), tags: Boolean(o.tags), prune: Boolean(o.p || o.prune), ...(env.net ? env.net() : {}) });
  const url = (await c.git.listRemotes({ fs: c.fs, dir: c.dir })).find(r => r.remote === 'origin');
  return { stdout: '', stderr: `From ${url ? url.url : 'origin'}${res && res.pruned && res.pruned.length ? `\n - [deleted] ${res.pruned.join(', ')}` : ''}\n`, exitCode: 0 };
};

cmds.pull = async (c, env, argv) => {
  const o = parseArgs(argv);
  if (o.rebase || o.r) return fail('error: pull --rebase isn\'t available here; git pull fast-forwards, or use git fetch then git merge');
  const [remote = 'origin', ref] = o._;
  if (remote !== 'origin') return fatal(`'${remote}' does not appear to be a git repository`);
  const branch = await c.branch();
  if (ref && ref !== branch) {   // git pull origin other: fetch it and merge it in
    await cmds.fetch(c, env, ['origin', ref]);
    return cmds.merge(c, env, [`origin/${ref}`]);
  }
  const before = await c.head();
  const res = await env.call('git_pull', { repo: env.name });
  if (res.model && res.model.error) return fail(`error: ${res.model.error}`);
  const after = await c.head();
  if (before === after) return ok('Already up to date.');
  return ok(`Updating ${short(before)}..${short(after)}\nFast-forward`);
};

cmds.push = async (c, env, argv) => {
  const o = parseArgs(argv, ['o', 'push-option']);
  if (o.f || o.force || o['force-with-lease'] || o['force-if-includes'] || o._.some(a => a.startsWith('+'))) return fail('error: Squiggle never force-pushes. Pull and merge (or start a new branch) instead.');
  if (o.d || o.delete || o._.some(a => a.startsWith(':'))) return fail('error: deleting branches on GitHub isn\'t available here.');
  if (o.tags || o['follow-tags'] || o.all || o.mirror) return fail('error: git push here pushes one branch; tags and --all aren\'t available.');
  const [remote = 'origin', spec] = o._;
  if (remote !== 'origin') return fatal(`'${remote}' does not appear to be a git repository (the only remote here is origin)`);
  const cur = await c.branch();
  let branch = cur;
  if (spec && spec !== 'HEAD') {
    const [src, dst] = spec.split(':');
    if (dst && dst !== src && !(src === 'HEAD' && dst === cur)) return fail(`error: pushing ${src} to a different name (${dst}) isn't available here; push the branch under its own name.`);
    branch = src === 'HEAD' ? cur : src;
  }
  if (!branch) return fatal('You are not currently on a branch.');
  const res = await env.call('git_push', { repo: env.name }, branch !== cur ? { pushBranch: branch } : {});
  if (res.model && res.model.error) return fail(`error: ${res.model.error}`);
  const url = (await c.git.listRemotes({ fs: c.fs, dir: c.dir })).find(r => r.remote === 'origin');
  const lines = [`To ${url ? url.url : 'origin'}`, `   ${branch} -> ${branch}`];
  if (res.model && res.model.compare_url) lines.push('', `Create a pull request for '${branch}' on GitHub: gh pr create --title "…" (or visit ${res.model.compare_url})`);
  if (o.u || o['set-upstream']) lines.push(`branch '${branch}' set up to track 'origin/${branch}'.`);
  return { stdout: '', stderr: lines.join('\n') + '\n', exitCode: 0 };
};

cmds.remote = async (c, env, argv) => {
  const remotes = await c.git.listRemotes({ fs: c.fs, dir: c.dir });
  const [sub, ...rest] = argv.filter(a => a !== '-v' && a !== '--verbose');
  const verbose = argv.includes('-v') || argv.includes('--verbose');
  if (!sub) return ok(remotes.map(r => (verbose ? `${r.remote}\t${r.url} (fetch)\n${r.remote}\t${r.url} (push)` : r.remote)).join('\n'));
  const named = remotes.find(r => r.remote === (rest.find(a => !a.startsWith('-')) || 'origin'));
  if (sub === 'get-url') return named ? ok(named.url) : fail(`error: No such remote '${rest[0]}'`, 2);
  if (sub === 'show') {
    if (!named) return fail(`error: No such remote '${rest[0]}'`, 2);
    const branches = (await c.git.listBranches({ fs: c.fs, dir: c.dir, remote: named.remote }).catch(() => [])).filter(b => b !== 'HEAD');
    let headBranch = '(unknown)';
    try { headBranch = (await c.git.resolveRef({ fs: c.fs, dir: c.dir, ref: `refs/remotes/${named.remote}/HEAD`, depth: 2 })) && (await c.git.expandRef({ fs: c.fs, dir: c.dir, ref: `${named.remote}/HEAD` })).replace(/^refs\/remotes\/[^/]+\//, ''); } catch { /* unknown */ }
    return ok([`* remote ${named.remote}`, `  Fetch URL: ${named.url}`, `  Push  URL: ${named.url}`, `  HEAD branch: ${headBranch}`, '  Remote branches:', ...branches.map(b => `    ${b} tracked`)].join('\n'));
  }
  return fail(`error: remotes are fixed here (origin is the GitHub repo); 'git remote ${sub}' isn't available.`);
};

cmds['rev-parse'] = async (c, env, argv) => {
  const o = parseArgs(argv, ['short']);
  const out = [];
  if (o['show-toplevel']) out.push(`/repos/${env.name}`);
  if (o['git-dir']) out.push('.git');
  if (o['is-inside-work-tree']) out.push('true');
  if (o['show-prefix']) out.push(c.repoRel() ? c.repoRel() + '/' : '');
  for (const a of o._) {
    if (o['abbrev-ref']) { out.push(a === 'HEAD' ? (await c.branch()) || 'HEAD' : a.replace(/@\{u(pstream)?\}$/, '') === 'HEAD' ? `origin/${await c.branch()}` : a); continue; }
    const oid = await resolveRev(c, a.replace(/^(.*)@\{u(pstream)?\}$/, (_, b) => `origin/${b || 'HEAD'}`));
    out.push(o.short ? oid.slice(0, o.short === true ? 7 : +o.short) : oid);
  }
  if (typeof o.short === 'string' && !o._.length && !/^\d+$/.test(o.short)) { const oid = await resolveRev(c, o.short); out.push(oid.slice(0, 7)); }
  return ok(out.join('\n'));
};

cmds.tag = async (c, env, argv) => {
  const { git, fs, dir } = c;
  const o = parseArgs(argv, ['m', 'message', 'l', 'list', 'd', 'delete']);
  const del = o.d || o.delete;
  if (del) { for (const t of [...(del === true ? [] : [del]), ...o._]) await git.deleteTag({ fs, dir, ref: t }); return ok(''); }
  const name = o._[0];
  const listing = o.l || o.list || !name;
  if (listing) {
    const pat = typeof (o.l || o.list) === 'string' ? (o.l || o.list) : name;
    const re = pat ? new RegExp('^' + pat.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*') + '$') : null;
    return ok((await git.listTags({ fs, dir })).filter(t => !re || re.test(t)).sort().join('\n'));
  }
  const object = await resolveRev(c, o._[1] || 'HEAD');
  if (o.a || o.annotate || o.m || o.message) await git.annotatedTag({ fs, dir, ref: name, object, message: o.m || o.message || name, tagger: await env.author(), force: Boolean(o.f || o.force) });
  else await git.tag({ fs, dir, ref: name, object, force: Boolean(o.f || o.force) });
  return ok('');
};

cmds.config = async (c, env, argv) => {
  const { git, fs, dir } = c;
  const o = parseArgs(argv, ['get', 'file', 'f']);
  const me = await env.author();
  const defaults = { 'user.name': me.name, 'user.email': me.email };
  const get = async (k) => (await git.getConfig({ fs, dir, path: k }).catch(() => undefined)) ?? defaults[k];
  if (o.l || o.list) {
    const keys = ['user.name', 'user.email', 'core.bare', 'remote.origin.url', 'remote.origin.fetch'];
    const rows = [];
    for (const k of keys) { const v = await get(k); if (v !== undefined) rows.push(`${k}=${v}`); }
    for (const b of await git.listBranches({ fs, dir })) rows.push(`branch.${b}.remote=origin`, `branch.${b}.merge=refs/heads/${b}`);
    return ok(rows.join('\n'));
  }
  const key = typeof o.get === 'string' ? o.get : o._[0];
  if (!key) return fail('usage: git config <name> [<value>]', 129);
  const value = typeof o.get === 'string' ? undefined : o._[1];
  if (value === undefined || o.get) { const v = await get(key); return v === undefined ? { stdout: '', stderr: '', exitCode: 1 } : ok(String(v)); }
  if (o.unset) { await git.setConfig({ fs, dir, path: key, value: undefined }); return ok(''); }
  await git.setConfig({ fs, dir, path: key, value });
  const note = /^user\.(name|email)$/.test(key) ? '(Squiggle commits as your GitHub account; this is saved in the repo\'s config.)\n' : '';
  return { stdout: '', stderr: note, exitCode: 0 };
};

cmds.clean = async (c, env, argv) => {
  const o = parseArgs(argv, ['e', 'exclude']);
  if (!o.f && !o.force && !o.n && !o['dry-run']) return fatal('clean.requireForce defaults to true and neither -i, -n, nor -f given; refusing to clean');
  const match = matcher(c, [...o._, ...(o.paths || [])]);
  const untracked = (await status(c, env)).filter(r => !r.head && !r.index && match(r.path)).map(r => r.path);
  const out = [];
  const dirs = new Set();
  for (const p of untracked) {
    const top = p.split('/');
    if (top.length > 1 && !(o.d)) continue;   // untracked directories only with -d
    if (top.length > 1) dirs.add(top[0]);
    else out.push(`${o.n || o['dry-run'] ? 'Would remove' : 'Removing'} ${p}`);
    if (!(o.n || o['dry-run'])) await c.remove(p);
  }
  for (const d of dirs) out.push(`${o.n || o['dry-run'] ? 'Would remove' : 'Removing'} ${d}/`);
  return ok(out.join('\n'));
};

cmds['ls-files'] = async (c, env, argv) => {
  const o = parseArgs(argv);
  const match = matcher(c, [...o._, ...(o.paths || [])]);
  const rows = await status(c, env, { all: true });
  let list;
  if (o.o || o.others) list = rows.filter(r => !r.head && !r.index && match(r.path));
  else if (o.m || o.modified) list = rows.filter(r => r.index && r.index !== r.work && match(r.path));
  else if (o.d || o.deleted) list = rows.filter(r => r.index && !r.work && match(r.path));
  else list = rows.filter(r => r.index && match(r.path));
  return ok(list.map(r => r.path).sort().join('\n'));
};

cmds['ls-tree'] = async (c, env, argv) => {
  const o = parseArgs(argv);
  const [rev = 'HEAD', ...paths] = o._;
  const files = await treeFiles(c, await resolveRev(c, rev));
  const prefix = paths[0] ? normPath(paths[0]) : '';
  const rows = new Map();
  for (const [p, oid] of files) {
    if (prefix && p !== prefix && !p.startsWith(prefix + '/')) continue;
    const restPath = prefix && p !== prefix ? p.slice(prefix.length + 1) : p;
    if (o.r || o.R || p === prefix || !restPath.includes('/')) rows.set(p, `100644 blob ${oid}\t${p}`);
    else { const d = (prefix ? prefix + '/' : '') + restPath.split('/')[0]; rows.set(d, `040000 tree -\t${d}`); }
  }
  return ok([...rows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([p, l]) => (o['name-only'] ? p : l)).join('\n'));
};

cmds['cat-file'] = async (c, env, argv) => {
  const o = parseArgs(argv);
  const [spec] = o._;
  if (!spec) return fail('usage: git cat-file (-t | -s | -p) <object>', 129);
  if (spec.includes(':')) return cmds.show(c, env, [spec]);
  const oid = await resolveRev(c, spec).catch(() => spec);
  const obj = await c.git.readObject({ fs: c.fs, dir: c.dir, oid, format: 'content' });
  if (o.t) return ok(obj.type);
  if (o.s) return ok(String(obj.object.length));
  return ok(dec.decode(obj.object).replace(/\n$/, ''));
};

cmds.grep = async (c, env, argv) => {
  const o = parseArgs(argv, ['e', 'A', 'B', 'C']);
  const pattern = o.e && o.e !== true ? o.e : o._.shift();
  if (!pattern) return fatal('no pattern given');
  const src = o.F || o['fixed-strings'] ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern.replace(/\\([|(){}+?])/g, '$1');
  const re = new RegExp(o.w || o['word-regexp'] ? `\\b(?:${src})\\b` : src, o.i || o['ignore-case'] ? 'i' : '');
  const { revs, paths } = await revsAndPaths(c, o);
  const match = matcher(c, paths);
  const rows = revs.length ? [...(await treeFiles(c, await resolveRev(c, revs[0]))).entries()].map(([p, oid]) => ({ path: p, oid })) : (await status(c, env, { all: true })).filter(r => r.index && r.work).map(r => ({ path: r.path }));
  const out = [];
  let hits = 0;
  for (const r of rows.filter(x => match(x.path)).sort((a, b) => a.path.localeCompare(b.path))) {
    const text = r.oid ? await c.blobByOid(r.oid) : await c.read(r.path);
    if (text == null || text.includes('\0')) continue;
    const lines = text.split('\n');
    const found = lines.map((l, i) => (re.test(l) !== Boolean(o.v || o['invert-match']) ? i : -1)).filter(i => i >= 0);
    if (!found.length) continue;
    hits += found.length;
    const name = (revs[0] ? `${revs[0]}:` : '') + r.path;
    if (o.l || o['files-with-matches'] || o['name-only']) { out.push(name); continue; }
    if (o.c || o.count) { out.push(`${name}:${found.length}`); continue; }
    for (const i of found) out.push(`${name}:${o.n || o['line-number'] ? `${i + 1}:` : ''}${lines[i]}`);
  }
  return { stdout: out.join('\n') + (out.length ? '\n' : ''), stderr: '', exitCode: hits ? 0 : 1 };
};

cmds.blame = async (c, env, argv) => {
  const { git, fs, dir } = c;
  const o = parseArgs(argv, ['L']);
  const [first, second] = o._;
  const rev = second ? first : 'HEAD';
  const file = c.rel(second || first || (o.paths && o.paths[0]) || '');
  if (!file) return fail('usage: git blame [<rev>] <file>', 129);
  let oid = await resolveRev(c, rev);
  let text = await c.blob(oid, file);
  if (text == null) return fatal(`no such path '${file}' in ${rev}`);
  const lines = text.replace(/\n$/, '').split('\n');
  const owner = lines.map(() => null);
  let pos = lines.map((_, i) => i);   // where each line sits in the version being looked at
  for (let hops = 0; hops < 200 && owner.includes(null); hops++) {
    const { commit } = await git.readCommit({ fs, dir, oid });
    const parent = commit.parent[0];
    const older = parent ? await c.blob(parent, file) : null;
    const entry = { oid, commit };
    if (older == null) { owner.forEach((v, i) => { if (v == null) owner[i] = entry; }); break; }
    const edits = diffLines(older.replace(/\n$/, '').split('\n'), text.replace(/\n$/, '').split('\n'));
    const map = new Map();   // line in this version → line in the parent
    let a = 0, b = 0;
    for (const e of edits) { if (e.op === ' ') map.set(b, a); if (e.op !== '+') a++; if (e.op !== '-') b++; }
    pos = pos.map((p, i) => {
      if (owner[i] || p == null) return p;
      if (!map.has(p)) { owner[i] = entry; return null; }
      return map.get(p);
    });
    oid = parent; text = older;
  }
  let from = 1, to = lines.length;
  if (typeof o.L === 'string') { const m = /^(\d+)(?:,\+?(\d+))?$/.exec(o.L); if (m) { from = +m[1]; to = m[2] ? (o.L.includes('+') ? from + +m[2] - 1 : +m[2]) : from; } }
  const out = [];
  for (let i = from - 1; i < Math.min(to, lines.length); i++) {
    const e = owner[i];
    out.push(`${e ? short(e.oid) : '0000000'} (${(e ? e.commit.author.name : 'Not Committed Yet').padEnd(12).slice(0, 12)} ${e ? gitDate(e.commit.author, 'short') : ''} ${String(i + 1).padStart(String(lines.length).length)}) ${lines[i]}`);
  }
  return ok(out.join('\n'));
};

cmds.shortlog = async (c, env, argv) => {
  const o = parseArgs(argv);
  const { tips, excludes } = await revRange(c, o._.length ? o._ : ['HEAD']);
  const list = await walkCommits(c, tips, excludes, { max: 2000 });
  const by = new Map();
  for (const e of list) { const k = o.e || o.email ? `${e.commit.author.name} <${e.commit.author.email}>` : e.commit.author.name; by.set(k, [...(by.get(k) || []), e.commit.message.split('\n')[0]]); }
  const rows = [...by.entries()];
  if (o.n || o.numbered) rows.sort((a, b) => b[1].length - a[1].length);
  if (o.s || o.summary) return ok(rows.map(([k, v]) => `${String(v.length).padStart(6)}\t${k}`).join('\n'));
  return ok(rows.map(([k, v]) => `${k} (${v.length}):\n${v.map(s => `      ${s}`).join('\n')}\n`).join('\n'));
};

cmds.describe = async (c, env, argv) => {
  const o = parseArgs(argv);
  const oid = await resolveRev(c, o._[0] || 'HEAD');
  const tags = [];
  for (const t of await c.git.listTags({ fs: c.fs, dir: c.dir })) tags.push([t, await resolveRev(c, t)]);
  const history = await walkCommits(c, [oid], [], { max: 1000 });
  for (let i = 0; i < history.length; i++) {
    const hit = tags.find(([, toid]) => toid === history[i].oid);
    if (hit) return ok(i ? `${hit[0]}-${i}-g${short(oid)}` : hit[0]);
  }
  if (o.always) return ok(short(oid));
  return fatal('No names found, cannot describe anything.');
};

cmds.apply = async (c, env, argv) => {
  const o = parseArgs(argv);
  const files = o._.length ? o._ : ['-'];
  for (const f of files) {
    const patch = f === '-' ? env.stdin || '' : await c.read(c.rel(f));
    if (patch == null) return fail(`error: can't open patch '${f}': No such file or directory`);
    const res = await applyPatch(c, patch, { reverse: Boolean(o.R || o.reverse), check: Boolean(o.check), cached: Boolean(o.cached), index: Boolean(o.index) });
    if (res) return fail(res);
  }
  return ok('');
};

// Apply a unified diff: each hunk's context must match, at its line or nearby.
async function applyPatch(c, patch, { reverse = false, check = false, cached = false, index = false }) {
  const files = [];
  let cur = null, left = 0;   // lines still to read in the current hunk (from its @@ counts)
  const all = patch.split('\n');
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    let m;
    if (left > 0 && cur && cur.hunk) {
      if (line.startsWith('\\')) continue;   // "\ No newline at end of file"
      cur.hunk.lines.push(line === '' ? ' ' : line);
      if (line[0] !== '+') cur.hunk.oldLeft--;
      if (line[0] !== '-') cur.hunk.newLeft--;
      left = Math.max(cur.hunk.oldLeft, cur.hunk.newLeft);
      continue;
    }
    if (line.startsWith('--- ') && (all[i + 1] || '').startsWith('+++ ')) {
      const from = line.slice(4).replace(/\t.*$/, '').trim(), to = all[i + 1].slice(4).replace(/\t.*$/, '').trim();
      cur = { from: from === '/dev/null' ? null : from.replace(/^a\//, ''), to: to === '/dev/null' ? null : to.replace(/^b\//, ''), hunks: [] };
      files.push(cur);
      i++;
      continue;
    }
    if ((m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)) && cur) {
      cur.hunk = { start: +m[1] || 1, lines: [], oldLeft: m[2] == null ? 1 : +m[2], newLeft: m[4] == null ? 1 : +m[4] };
      cur.hunks.push(cur.hunk);
      left = Math.max(cur.hunk.oldLeft, cur.hunk.newLeft);
    }
  }
  if (!files.length) return 'error: No valid patches in input';
  const results = [];
  for (const f of files) {
    const path = reverse ? (f.to ?? f.from) : (f.to ?? f.from);
    const creating = reverse ? !f.to : !f.from, deleting = reverse ? !f.from : !f.to;
    const text = creating ? '' : await c.read(path);
    if (text == null) return `error: ${path}: No such file or directory`;
    const lines = text.split('\n');
    let shift = 0;
    for (const h of f.hunks) {
      const oldL = [], newL = [];
      for (const l of h.lines) {
        const t = l.slice(1), op = reverse ? ({ '+': '-', '-': '+', ' ': ' ' })[l[0]] : l[0];
        if (op !== '+') oldL.push(t);
        if (op !== '-') newL.push(t);
      }
      const want = Math.max(0, h.start - 1 + shift);
      let at = -1;
      for (let d = 0; d < lines.length + 1 && at < 0; d++) {
        for (const p of [want - d, want + d]) {
          if (p >= 0 && p + oldL.length <= lines.length && oldL.every((l, i) => lines[p + i] === l)) { at = p; break; }
        }
      }
      if (at < 0) return `error: patch failed: ${path}:${h.start}\nerror: ${path}: patch does not apply`;
      lines.splice(at, oldL.length, ...newL);
      shift += newL.length - oldL.length;
    }
    results.push({ path, text: lines.join('\n'), deleting });
  }
  if (check) return null;
  for (const r of results) {
    if (!cached) { if (r.deleting) await c.remove(r.path); else await c.write(r.path, r.text); }
    if (cached || index) {
      if (r.deleting) await c.git.remove({ fs: c.fs, dir: c.dir, filepath: r.path });
      else if (cached) { const { oid } = await c.git.writeBlob({ fs: c.fs, dir: c.dir, blob: enc.encode(r.text) }); await c.git.updateIndex({ fs: c.fs, dir: c.dir, filepath: r.path, oid, add: true }); }
      else await c.git.add({ fs: c.fs, dir: c.dir, filepath: r.path });
    }
  }
  return null;
}

const UNSUPPORTED = {
  rebase: 'rebase isn\'t available here. To bring a branch up to date, use git merge; to tidy history, start a new branch and commit again.',
  revert: 'revert isn\'t available here. To undo a commit\'s changes: git diff <commit>^ <commit> > undo.patch, then git apply -R undo.patch, then commit.',
  reflog: 'reflog isn\'t kept here. git log shows the history.',
  bisect: 'bisect isn\'t available here.',
  submodule: 'submodules aren\'t available here.',
  worktree: 'one working tree per repo here (/repos/<name>).',
  gc: '', prune: '', fsck: '', maintenance: '',
  'format-patch': 'format-patch isn\'t available here; use git diff or git show to get a patch.',
  am: 'am isn\'t available here; use git apply.',
  archive: 'archive isn\'t available here.',
  'filter-branch': 'filter-branch isn\'t available here.',
  notes: 'notes aren\'t available here.',
  'update-index': 'use git add / git restore --staged instead.',
};

export const GIT_COMMANDS = [...Object.keys(cmds), 'clone', 'init', 'version', 'help'].sort();

// Run one git command. Returns { stdout, stderr, exitCode }.
export async function runGit(argv, env) {
  let args = [...argv];
  while (args[0] === '-C' && args.length > 1) args = args.slice(2);   // bash.js resolved -C already
  while (args[0] && /^(-c|--no-pager|--paginate|-P|--no-optional-locks)$/.test(args[0])) args = args.slice(args[0] === '-c' ? 2 : 1);
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '--help') return ok(env.help || `usage: git <command> [<args>]\n\nAvailable here: ${GIT_COMMANDS.join(', ')}`);
  if (sub === 'version' || sub === '--version') return ok('git version 2.47.0 (isomorphic-git, in Squiggle)');
  if (sub === 'clone') {
    const o = parseArgs(rest, ['b', 'branch', 'depth', 'o', 'origin']);
    if (!o._[0]) return fail('usage: git clone <repo>', 129);
    const res = await env.call('git_clone', { repo: o._[0], ...(o.b || o.branch ? { branch: o.b || o.branch } : {}) });
    if (res.model && res.model.error) return fatal(res.model.error);
    return { stdout: res.model && res.model.note ? res.model.note + '\n' : '', stderr: `${res.model && res.model.already_cloned ? 'Already cloned; pulled into' : 'Cloning into'} '${res.model ? res.model.path : o._[0]}'...\n`, exitCode: 0 };
  }
  if (sub === 'init') {
    if (!env.initDir) return fatal('git init works in /repos/<name> here');
    const target = env.initDir(parseArgs(rest)._[0]);
    if (!target) return fatal('git init works in /repos/<name> here');
    await env.git.init({ fs: env.fs, dir: target.dir, defaultBranch: 'main' });
    return ok(`Initialized empty Git repository in ${target.path}/.git/`);
  }
  if (sub in UNSUPPORTED) return UNSUPPORTED[sub] ? fail(`git: ${UNSUPPORTED[sub]}`) : ok('');
  if (!cmds[sub]) return fail(`git: '${sub}' is not a git command. Available here: ${GIT_COMMANDS.join(', ')}`);
  if (!env.dir) return fatal('not a git repository (cd into /repos/<name>, or git -C /repos/<name> …)');
  const c = ctxOf(env);
  try {
    return await cmds[sub](c, env, rest);
  } catch (e) {
    if (e instanceof GitError) return fail(`fatal: ${e.message}`, e.code);
    return fail(`error: ${e && e.message ? e.message : e}`);
  }
}
