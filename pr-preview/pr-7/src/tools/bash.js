// `bash`: one tool in place of the file, web and git tools (lab: Settings → Lab → Tools "One bash tool",
// settings.toolSurface 'bash'). The model writes shell it already knows (cat, grep, sed, ls, find, pipes, git, curl)
// instead of learning a schema per tool: a dozen schemas were ~3.6K tokens for Gemma 4, and small models only saw
// most tools by name behind find/tool_info, which is where "list my GitHub repos" failed (failures.md case 16).
//
// The shell is just-bash (vercel-labs, a bash interpreter in TypeScript, vendored as app/vendor/just-bash.js by
// `npm run vendor`, loaded on first use; jsDelivr can't bundle it because of its Node-only gzip). It
// runs on the same files the other tools use, through WorkspaceFs:
//   /home/…   the storage repo's home/ (reads from the clone, writes and removals through storage.js so they sync)
//   /repos/…  git clones (LightningFS, as the git tools leave them)
//   /web/…    pages saved by fetch_url in card mode (read-only)
//   anything else (/tmp, and the /bin, /usr/bin, /dev, /proc just-bash sets up for itself): in memory, per session
// `.git` folders stay out of reach (guard.resolveAgentPath), as everywhere else.
//
// The commands that need Squiggle (the network, GitHub, the sandbox) call the existing tools, so their rules hold:
// git push still asks the user through the approval card, curl still refuses made-up URLs on small models and goes
// through the relay, results still come back as outside content.
//   git clone|status|log|show|checkout|switch|branch|add|commit|push|pull     gh repo list|clone, gh pr create
//   curl URL (the page as readable text)    search QUERY (web search)    wiki NAME (Wikipedia + Wikidata)
//   node -e CODE (the run_js sandbox)
import { defineTool, params, str, runTool } from './registry.js';
import { pfs, writeFile as gitWriteFile, rmrf, mkdirp, walk } from '../git.js';
import * as storage from '../storage.js';
import { resolveAgentPath } from '../guard.js';
import { REPOS, readAgentFile, listAgentDir } from './workspace.js';
import { wrapUntrusted } from '../untrusted.js';
import { truncate } from '../util.js';
import { calculate as calc } from '../calc.js';

export const LIB = new URL('../../vendor/just-bash.js', import.meta.url).href;
let lib = null;
const load = (url = LIB) => (lib = lib || import(/* @vite-ignore */ url));

// ── Paths ─────────────────────────────────────────────────────────────────

export function normalize(p) {
  const parts = [];
  for (const seg of String(p || '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return '/' + parts.join('/');
}
const resolve = (base, p) => normalize(String(p).startsWith('/') ? p : `${base || '/'}/${p}`);

const err = (code, op, path) => Object.assign(new Error(`${code}: ${{ ENOENT: 'no such file or directory', EISDIR: 'illegal operation on a directory', EROFS: 'read-only file system', EACCES: 'permission denied', ENOTSUP: 'operation not supported', ENOTEMPTY: 'directory not empty' }[code] || code}, ${op} '${path}'`), { code });

// Where a shell path lives: { kind: 'root' | 'home' | 'fs' | 'web' | 'tmp' | 'denied', real?, rel? }. 'tmp' is
// the in-memory filesystem: /tmp, and the /bin, /usr/bin, /dev and /proc just-bash puts there for itself (it looks
// commands up as /usr/bin/<name>).
function locate(path) {
  const p = normalize(path);
  if (p === '/') return { kind: 'root', p };
  const top = p.split('/')[1];
  if (!['home', 'repos', 'web'].includes(top)) return { kind: 'tmp', p };
  let r;
  try { r = resolveAgentPath(p); } catch { return { kind: 'denied', p }; }
  if (r.area === 'home') return { kind: 'home', p, rel: 'home' + (r.rel ? '/' + r.rel : ''), real: storage.realPath('home' + (r.rel ? '/' + r.rel : '')) };
  if (r.area === 'web') return { kind: 'web', p, rel: r.rel };
  if (r.area === 'repos') return { kind: 'fs', p, repo: r.repo, real: `${REPOS}${r.repo ? '/' + r.repo : ''}${r.rel ? '/' + r.rel : ''}` };
  return { kind: 'none', p };
}

// `identity` (the path: there are no links here) saves ls a realpath call per directory.
const statOf = (s, p) => ({ isFile: s.type === 'file', isDirectory: s.type === 'dir', isSymbolicLink: false, mode: s.mode || (s.type === 'dir' ? 0o755 : 0o644), size: s.size || 0, mtime: new Date(s.mtimeMs || Date.now()), identity: p });
const DIR_STAT = (p) => ({ isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o755, size: 0, mtime: new Date(), identity: p });
const text = (c) => (typeof c === 'string' ? c : new TextDecoder().decode(c));

// ── The filesystem the shell sees ─────────────────────────────────────────

/** just-bash's IFileSystem over Squiggle's workspace (see the top of this file). `tmp` is an in-memory
 *  filesystem for /tmp (just-bash's InMemoryFs). */
export class WorkspaceFs {
  constructor(tmp) { this.tmp = tmp; this.index = ['/', '/home', '/repos']; }

  async refreshIndex(cap = 4000) {
    const out = ['/', '/home', '/repos'];
    try { for (const f of await walk(storage.realPath('home'))) out.push('/home/' + f.path); } catch {}
    try {
      for (const repo of await pfs.readdir(REPOS).catch(() => [])) {
        out.push(`/repos/${repo}`);
        for (const f of (await walk(`${REPOS}/${repo}`)).slice(0, cap)) out.push(`/repos/${repo}/${f.path}`);
      }
    } catch {}
    this.index = out.slice(0, cap * 2);
  }

  resolvePath(base, p) { return resolve(base, p); }
  getAllPaths() { return [...new Set([...this.index, ...(this.tmp && this.tmp.getAllPaths ? this.tmp.getAllPaths() : [])])]; }

  async readFile(path, options) {
    const at = locate(path);
    if (at.kind === 'tmp') return this.tmp.readFile(at.p, options);
    if (at.kind === 'web') { const t = await readAgentFile(at.p); if (t == null) throw err('ENOENT', 'open', path); return t; }
    if (at.kind === 'home' || at.kind === 'fs') {
      try { return await pfs.readFile(at.real, 'utf8'); } catch (e) {
        if (await this.isDir(at)) throw err('EISDIR', 'read', path);
        throw err('ENOENT', 'open', path);
      }
    }
    if (at.kind === 'denied') throw err('EACCES', 'open', path);
    throw err(at.kind === 'root' ? 'EISDIR' : 'ENOENT', 'open', path);
  }
  // cat and friends use readFileBytes when the filesystem has it ("binary" strings, one char per byte).
  async readFileBytes(path) {
    const at = locate(path);
    if (at.kind === 'tmp' && this.tmp.readFileBytes) return this.tmp.readFileBytes(at.p);
    const buf = await this.readFileBuffer(path);
    let out = ''; for (let i = 0; i < buf.length; i += 8192) out += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
    return out;
  }
  async readFileBuffer(path) {
    const at = locate(path);
    if (at.kind === 'tmp') return this.tmp.readFileBuffer(at.p);
    if (at.kind === 'home' || at.kind === 'fs') { try { return await pfs.readFile(at.real); } catch { throw err('ENOENT', 'open', path); } }
    return new TextEncoder().encode(await this.readFile(path));
  }

  async writeFile(path, content, options) {
    const at = locate(path);
    if (at.kind === 'tmp') return this.tmp.writeFile(at.p, content, options);
    // A "binary" string is one character per byte (just-bash writes redirects that way): back to bytes, so UTF-8
    // text lands as UTF-8.
    const enc = typeof options === 'string' ? options : options && options.encoding;
    if (typeof content === 'string' && (enc === 'binary' || enc === 'latin1')) content = Uint8Array.from(content, (c) => c.charCodeAt(0) & 255);
    if (at.kind === 'home') { await storage.write(at.rel, text(content)); this.note(at.p); return; }
    if (at.kind === 'fs') {
      if (!at.repo || at.real === `${REPOS}/${at.repo}`) throw err('EISDIR', 'write', path);
      if (!(await pfs.stat(`${REPOS}/${at.repo}`).catch(() => null))) throw err('ENOENT', 'write', path);
      await gitWriteFile(at.real, content); this.note(at.p); return;
    }
    throw err(at.kind === 'web' ? 'EROFS' : at.kind === 'denied' ? 'EACCES' : 'ENOENT', 'write', path);
  }
  async appendFile(path, content, options) {
    const at = locate(path);
    if (at.kind === 'tmp') return this.tmp.appendFile(at.p, content, options);
    const enc = typeof options === 'string' ? options : options && options.encoding;
    if (typeof content === 'string' && (enc === 'binary' || enc === 'latin1')) content = Uint8Array.from(content, (c) => c.charCodeAt(0) & 255);
    let before = '';
    try { before = await this.readFile(path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return this.writeFile(path, before + text(content));
  }

  async isDir(at) {
    if (at.kind === 'root') return true;
    if (at.kind === 'web') return !at.rel;
    if (at.kind === 'fs' && !at.repo) return true;
    if (at.kind === 'home' || at.kind === 'fs') { const s = await pfs.stat(at.real).catch(() => null); return Boolean(s && s.type === 'dir') || (at.kind === 'home' && at.rel === 'home'); }
    return false;
  }
  async exists(path) { try { await this.stat(path); return true; } catch { return false; } }
  async stat(path) {
    const at = locate(path);
    if (at.kind === 'tmp') return this.tmp.stat(at.p);
    if (at.kind === 'root' || (at.kind === 'fs' && !at.repo) || (at.kind === 'web' && !at.rel)) return DIR_STAT(at.p);
    if (at.kind === 'web') { const t = await readAgentFile(at.p); if (t == null) throw err('ENOENT', 'stat', path); return { ...DIR_STAT(at.p), isFile: true, isDirectory: false, mode: 0o444, size: t.length }; }
    if (at.kind === 'home' || at.kind === 'fs') {
      const s = await pfs.stat(at.real).catch(() => null);
      if (s) return statOf(s, at.p);
      if (at.kind === 'home' && at.rel === 'home') return DIR_STAT(at.p);
      throw err('ENOENT', 'stat', path);
    }
    throw err(at.kind === 'denied' ? 'EACCES' : 'ENOENT', 'stat', path);
  }
  lstat(path) { return this.stat(path); }

  async mkdir(path, options = {}) {
    const at = locate(path);
    if (at.kind === 'tmp') return this.tmp.mkdir(at.p, options);
    if (at.kind === 'home' || (at.kind === 'fs' && at.repo)) {
      if (await this.exists(path)) { if (options.recursive) return; throw Object.assign(new Error(`EEXIST: file already exists, mkdir '${path}'`), { code: 'EEXIST' }); }
      await mkdirp(at.real); return;
    }
    throw err(at.kind === 'denied' ? 'EACCES' : 'EROFS', 'mkdir', path);
  }

  async readdir(path) {
    const at = locate(path);
    if (at.kind === 'tmp') return this.tmp.readdir(at.p);
    if (at.kind === 'root') {
      const mem = await this.tmp.readdir('/').catch(() => []);
      return [...new Set(['home', 'repos', ...((await listAgentDir('/')).includes('web/') ? ['web'] : []), ...mem.filter(n => !['home', 'repos', 'web'].includes(n))])].sort();
    }
    if (at.kind === 'web') return at.rel ? [] : (await listAgentDir('/web')).map(s => s.split(/\s+/)[0]);
    if (at.kind === 'fs' && !at.repo) return (await pfs.readdir(REPOS).catch(() => [])).filter(n => n !== '.git');
    if (at.kind === 'home' || at.kind === 'fs') {
      try { return (await pfs.readdir(at.real)).filter(n => n !== '.git').sort(); } catch {
        if (at.kind === 'home' && at.rel === 'home') return [];
        throw err('ENOENT', 'scandir', path);
      }
    }
    throw err(at.kind === 'denied' ? 'EACCES' : 'ENOENT', 'scandir', path);
  }

  async rm(path, options = {}) {
    const at = locate(path);
    if (at.kind === 'tmp') return this.tmp.rm(at.p, options);
    if (!(await this.exists(path))) { if (options.force) return; throw err('ENOENT', 'rm', path); }
    const dir = await this.isDir(at);
    if (dir && !options.recursive) throw err('EISDIR', 'rm', path);
    if (at.kind === 'home') {
      if (at.rel === 'home') throw err('EACCES', 'rm', path);
      const files = dir ? (await walk(at.real)).map(f => `${at.rel}/${f.path}`) : [at.rel];
      for (const f of files) await storage.remove(f);
      if (dir) await rmrf(at.real);
      this.note(at.p); return;
    }
    if (at.kind === 'fs' && at.repo) { await rmrf(at.real); this.note(at.p); return; }
    throw err(at.kind === 'web' ? 'EROFS' : 'EACCES', 'rm', path);
  }
  async cp(src, dest, options = {}) {
    const s = await this.stat(src);
    if (s.isDirectory) {
      if (!options.recursive) throw err('EISDIR', 'cp', src);
      await this.mkdir(dest, { recursive: true });
      for (const n of await this.readdir(src)) await this.cp(`${normalize(src)}/${n}`, `${normalize(dest)}/${n}`, options);
      return;
    }
    await this.writeFile(dest, await this.readFileBuffer(src));
  }
  async mv(src, dest) { await this.cp(src, dest, { recursive: true }); await this.rm(src, { recursive: true }); }
  // realpath and utimes aren't in the interface's listing but ls, cd, touch and others call them.
  async realpath(path) {
    const at = locate(path);
    if (at.kind === 'tmp') return this.tmp.realpath ? this.tmp.realpath(at.p) : at.p;
    await this.stat(path);
    return at.p;
  }
  async utimes(path) { if (locate(path).kind === 'tmp' && this.tmp.utimes) return this.tmp.utimes(locate(path).p, new Date(), new Date()); }
  async readdirWithFileTypes(path) {
    const at = locate(path);
    if (at.kind === 'tmp' && this.tmp.readdirWithFileTypes) return this.tmp.readdirWithFileTypes(at.p);
    const base = normalize(path);
    return Promise.all((await this.readdir(path)).map(async (name) => {
      let s = null;
      try { s = await this.stat(`${base === '/' ? '' : base}/${name}`); } catch {}
      return { name, isFile: Boolean(s && s.isFile), isDirectory: Boolean(s && s.isDirectory), isSymbolicLink: false };
    }));
  }
  async chmod() {}
  async symlink(t, p) { throw err('ENOTSUP', 'symlink', p); }
  async link(e, p) { throw err('ENOTSUP', 'link', p); }
  async readlink(p) { throw err('ENOTSUP', 'readlink', p); }

  note(p) { if (!this.index.includes(p)) this.index.push(p); }
}

// ── Commands that call Squiggle's tools ───────────────────────────────────

// The model-facing text of a tool result: an error goes to stderr (exit 1); untrusted wrappers come off (the whole
// bash output is wrapped once at the end); objects print as indented JSON, strings as they are.
const STRIP = /<\/?untrusted[^>]*>\n?/g;
function asOutput(res) {
  const m = res && res.model;
  if (m && typeof m === 'object' && m.error) return { stdout: '', stderr: String(m.error).replace(STRIP, '') + '\n', exitCode: 1 };
  const body = typeof m === 'string' ? m : JSON.stringify(m, null, 1);
  return { stdout: String(body ?? '').replace(STRIP, '').replace(/\\n/g, '\n') + '\n', stderr: '', exitCode: 0 };
}

// "-m 'fix it'" style flags: the value after a flag, and the words that aren't flags.
function flags(args, withValue = []) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = /^--?([\w-]+)=(.*)$/.exec(a);
    if (eq) { out[eq[1]] = eq[2]; continue; }
    const f = /^--?([\w-]+)$/.exec(a);
    if (f && withValue.includes(f[1]) && i + 1 < args.length) { out[f[1]] = args[++i]; continue; }
    if (f) { out[f[1]] = true; continue; }
    out._.push(a);
  }
  return out;
}

// The repo a git command means: `-C dir`, else the folder under /repos the shell is in.
function repoFrom(cwd, explicit) {
  const p = normalize(explicit ? resolve(cwd, explicit) : cwd);
  const m = /^\/repos\/([^/]+)/.exec(p);
  return m ? m[1] : null;
}

/** The custom commands for one run: each calls a Squiggle tool with the agent's context (approvals, URL rules,
 *  the room left), and records what it did for the agent (`seen`: items/observations, so the URL ledger and
 *  "pages saved in this chat" see them). */
export function commands(defineCommand, toolCtx, seen) {
  // `<cmd> --help` (or -h, or `man <cmd>`): the details live here, not in the tool description, so they cost
  // context only when the model asks (Keal's idea: name the custom commands, let --help teach them).
  const helped = (text, run) => async (argv, ctx) => (argv.some(a => a === '--help' || a === '-h') && !(argv[0] === 'commit' || argv[0] === 'log') ? { stdout: text.trim() + '\n', stderr: '', exitCode: 0 } : run(argv, ctx));
  const call = async (name, args) => {
    const res = await runTool({ function: { name, arguments: args } }, { ...toolCtx, pageCards: false });
    seen.push(res);
    return res;
  };
  const say = (stdout, exitCode = 0) => ({ stdout, stderr: '', exitCode });
  const fail = (stderr, exitCode = 1) => ({ stdout: '', stderr: stderr.endsWith('\n') ? stderr : stderr + '\n', exitCode });

  const git = defineCommand('git', helped(HELP.git, async (argv, ctx) => {
    let args = [...argv], dir = null;
    while (args[0] === '-C' && args.length > 1) { dir = args[1]; args = args.slice(2); }
    const [sub, ...rest] = args;
    const repo = repoFrom(ctx.cwd, dir);
    const needRepo = () => fail(`fatal: not a git repository (cd into /repos/<name>, or git -C /repos/<name> ${sub})`, 128);
    switch (sub) {
      case 'clone': { const f = flags(rest, ['b', 'branch', 'depth']); if (!f._[0]) return fail('usage: git clone <repo>'); return asOutput(await call('git_clone', { repo: f._[0], ...(f.b || f.branch ? { branch: f.b || f.branch } : {}) })); }
      case 'status': return repo ? asOutput(await call('git_status', { repo })) : needRepo();
      case 'log': {
        if (!repo) return needRepo();
        const f = flags(rest, ['n', 'max-count']);
        const n = Number(f.n || f['max-count'] || (rest.find(a => /^-\d+$/.test(a)) || '').slice(1)) || 10;
        return asOutput(await call('git_log', { repo, count: n }));
      }
      case 'show': {
        if (!repo) return needRepo();
        const spec = rest.find(a => !a.startsWith('-')) || 'HEAD';
        const at = spec.indexOf(':');
        if (at < 0) return fail('git show here reads a file at a commit: git show <commit>:<path> (git log lists commits)');
        return asOutput(await call('git_show', { repo, ref: spec.slice(0, at) || 'HEAD', path: spec.slice(at + 1) }));
      }
      case 'checkout': case 'switch': case 'branch': {
        if (!repo) return needRepo();
        const f = flags(rest);
        const name = f._[0];
        if (!name) return sub === 'branch' ? asOutput(await call('git_status', { repo })) : fail(`usage: git ${sub} <branch>`);
        return asOutput(await call('git_branch', { repo, name, ...(f._[1] ? { from: f._[1] } : {}) }));
      }
      case 'add': return say('');   // git commit takes every change
      case 'commit': {
        if (!repo) return needRepo();
        const f = flags(rest, ['m', 'message']);
        const message = f.m || f.message;
        if (!message) return fail('error: give a message: git commit -m "…"');
        return asOutput(await call('git_commit', { repo, message }));
      }
      case 'push': return repo ? asOutput(await call('git_push', { repo })) : needRepo();
      case 'pull': return repo ? asOutput(await call('git_pull', { repo })) : needRepo();
      case 'diff': return repo ? asOutput(await call('git_status', { repo })) : needRepo();
      default: return fail(`git: '${sub || ''}' isn't available here. Use: clone, status, log, show <commit>:<path>, checkout/switch/branch <name>, add, commit -m, push, pull.`);
    }
  }));

  const gh = defineCommand('gh', helped(HELP.gh, async (argv, ctx) => {
    const [area, verb, ...rest] = argv;
    if (area === 'repo' && verb === 'list') {
      const res = await call('github_list_repos', {});
      if (res.model && res.model.error) return asOutput(res);
      const rows = (res.model.repos || []).map(r => `${r.repo}\t${String(r.description || '').replace(STRIP, '').replace(/\s+/g, ' ').trim()}\t${r.private ? 'private' : 'public'}`);
      return say(rows.join('\n') + '\n');
    }
    if (area === 'repo' && verb === 'clone') return rest[0] ? asOutput(await call('git_clone', { repo: rest[0] })) : fail('usage: gh repo clone <owner/name>');
    if (area === 'pr' && verb === 'create') {
      const repo = repoFrom(ctx.cwd);
      if (!repo) return fail('cd into /repos/<name> first');
      const f = flags(rest, ['title', 't', 'body', 'b', 'base', 'B']);
      if (!(f.title || f.t)) return fail('usage: gh pr create --title "…" [--body "…"] [--base main]');
      return asOutput(await call('github_open_pr', { repo, title: f.title || f.t, ...(f.body || f.b ? { body: f.body || f.b } : {}), ...(f.base || f.B ? { base: f.base || f.B } : {}) }));
    }
    return fail('gh here does: gh repo list, gh repo clone <owner/name>, gh pr create --title "…" [--body "…"]');
  }));

  const curl = defineCommand('curl', helped(HELP.curl, async (argv) => {
    const f = flags(argv, ['o', 'output', 'H', 'header', 'X', 'request', 'd', 'data', 'A', 'user-agent', 'm', 'max-time']);
    const url = f._.find(a => /^(https?:\/\/|[\w-]+\.[\w.-]+)/i.test(a));
    if (!url) return fail('curl: give a URL');
    if (f.X || f.request || f.d || f.data) return fail('curl here only reads pages (GET)');
    const res = await call('fetch_url', { url });
    if (res.model && res.model.error) return asOutput(res);
    const page = (res.observation && res.observation.text) || String(res.model.text || '').replace(STRIP, '');
    return say(page.endsWith('\n') ? page : page + '\n');
  }));

  const search = defineCommand('search', helped(HELP.search, async (argv) => {
    const f = flags(argv, ['n']);
    const query = f._.join(' ').trim();
    if (!query) return fail('usage: search <words>');
    const res = await call('web_search', { query, ...(f.n ? { count: Number(f.n) } : {}) });
    if (res.model && res.model.error) return asOutput(res);
    return say(String(res.model.results || '').replace(STRIP, '').trim() + '\n');
  }));

  const wiki = defineCommand('wiki', helped(HELP.wiki, async (argv) => {
    const query = argv.join(' ').trim();
    if (!query) return fail('usage: wiki <name or question>');
    return asOutput(await call('wiki_lookup', { query }));
  }));

  const node = defineCommand('node', helped(HELP.node, async (argv, ctx) => {
    const f = flags(argv, ['e', 'eval', 'p', 'print']);
    let code = f.e || f.eval || (f.p || f.print ? `console.log(${f.p || f.print})` : null);
    if (!code && f._[0]) { try { code = await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, f._[0])); } catch { return fail(`node: cannot read ${f._[0]}`); } }
    if (!code && ctx.stdin) code = ctx.stdin;
    if (!code) return fail('usage: node -e "<code>" | node <file.js>');
    const res = await call('run_js', { code });
    const m = res.model || {};
    if (m.error) return { stdout: m.stdout ? m.stdout + '\n' : '', stderr: String(m.error) + '\n', exitCode: 1 };
    return say([m.stdout, m.result !== undefined && m.result !== null && !m.stdout ? String(m.result) : ''].filter(Boolean).join('\n') + '\n');
  }));

  // bc: decimals and percentages through calc.js (bash's own $((…)) is integers only: 5*5/129 → 0).
  const bc = defineCommand('bc', helped(HELP.bc, async (argv, ctx) => {
    const exprs = String(ctx.stdin || argv.filter(a => !a.startsWith('-')).join(' ')).split(/[\n;]+/).map(s => s.trim()).filter(Boolean);
    if (!exprs.length) return fail('usage: echo "2.5 * 4" | bc -l');
    const out = [];
    for (const e of exprs) { const r = calc(e); if (r.error) return fail(`bc: ${r.error}`); out.push(String(r.result)); }
    return say(out.join('\n') + '\n');
  }));

  // `man` alone lists the custom commands; `man <cmd>` is that command's --help. (`help` is bash's own builtin.)
  const man = defineCommand('man', async (argv) => {
    const page = argv.filter(a => !a.startsWith('-'))[0];
    if (page && !HELP[page] && page !== 'squiggle') return { stdout: '', stderr: `No manual entry for ${page}. Ordinary commands: try ${page} --help. Custom ones: man (no argument).\n`, exitCode: 16 };
    return { stdout: (HELP[page] || HELP.all).trim() + '\n', stderr: '', exitCode: 0 };
  });

  return [git, gh, curl, search, wiki, node, bc, man];
}

// ── Help ──────────────────────────────────────────────────────────────────

export const HELP = {
  all: `Custom commands here (each has --help):
  git      clone, status, log, show <commit>:<path>, checkout/switch/branch <name>, add, commit -m, push, pull
  gh       gh repo list (your GitHub repos), gh repo clone, gh pr create
  curl     curl URL: a web page as readable text (pipe it: curl URL | grep -i word)
  search   search WORDS: web search results with links
  wiki     wiki NAME: Wikipedia and Wikidata facts about something
  node     node -e CODE: run JavaScript
  bc       echo "5*5/129" | bc -l: maths with decimals and %
Everything else is ordinary bash: cat, ls, grep, sed, awk, find, head, tail, wc, sort, jq, pipes, loops.
Files: /home (yours, synced to the user's devices), /repos/<name> (git clones), /web (saved pages), /tmp.`,
  git: `git (Squiggle): works on clones in /repos/<name>; cd there first or use git -C /repos/<name>.
  git clone <owner/name | github URL>     clone into /repos/<name>
  git status | git diff                   current branch and changed files
  git log [-n N]                          recent commits
  git show <commit>:<path>                a file as it was at a commit (HEAD~1:path for the one before)
  git checkout -b <name> | git switch <name> | git branch <name>
                                          switch branch, or start one (new ones get the agent/ prefix)
  git add …                               nothing to do: commit takes every change
  git commit -m "message"                 commit all changes
  git push                                agent/ branches push right away; any other branch asks the user
  git pull                                fast-forward from GitHub`,
  gh: `gh (Squiggle):
  gh repo list                            the user's GitHub repos (owner/name, description, public/private)
  gh repo clone <owner/name>              same as git clone
  gh pr create --title "…" [--body "…"] [--base main]   from the pushed branch of the repo you're in`,
  curl: `curl URL: fetch a web page and print it as readable text (not HTML). GET only.
  Only pages from a search result, a page you read or the user (made-up URLs aren't opened).
  curl https://example.com | grep -i -m5 word     find a line without reading the whole page`,
  search: `search WORDS [-n N]: search the web; prints titles, links and snippets.
  search "who directed jaws"     then: curl <a link from the results> | grep -i director`,
  wiki: `wiki NAME: Wikipedia and Wikidata facts about a person, film, place, company…, with the newest things
  linked to it (films, albums, products) and their dates.   wiki "Emma Stone"`,
  node: `node -e "CODE" | node file.js | echo CODE | node: run JavaScript in a sandbox; prints console.log output
  and the value of the last expression. No network, no files.`,
  bc: `echo "EXPR" | bc -l   (or bc "EXPR"): maths with decimals; also 15% of 240, $1,200 * 3, sqrt(2).
  bash's own $((…)) is whole numbers only.`,
};

// ── The tool ──────────────────────────────────────────────────────────────

export const BASH_DESCRIPTION = 'Run bash: pipes, cat, ls, grep, sed, awk, find, jq, the usual tools. Files: /home (yours), /repos (git clones), /web, /tmp. ' +
  'Custom commands: git, gh, curl, search, wiki, node, bc (`man` lists them, `<command> --help` explains one).';

export const bash = defineTool({
  name: 'bash',
  group: 'shell',
  description: BASH_DESCRIPTION,
  parameters: params({ command: str('The command, e.g. ls /repos or grep -rn "login" /repos/app/src | head') }, ['command']),
  async run({ command }, ctx = {}) {
    const script = String(command || '').trim();
    // An empty command gets an example back, not just "give one": LFM2.5 1.2B sent command="" twice on "list my
    // repos" and gave up (tools vs bash run, 2026-11-10).
    if (!script) return { model: { error: 'The command was empty. Put the whole shell line in command, e.g. gh repo list, ls /repos or man.' }, label: 'bash (empty command)' };
    let L;
    try { L = await load(ctx.bashLib); } catch (e) { return { model: { error: `The shell couldn't load: ${e.message || e}` }, label: 'bash (not loaded)' }; }
    const tmp = ctx.bashTmp || (ctx.session ? (ctx.session.__bashTmp = ctx.session.__bashTmp || new L.InMemoryFs()) : new L.InMemoryFs());
    try { await tmp.mkdir('/tmp', { recursive: true }); } catch {}
    const fs = new WorkspaceFs(tmp);
    await fs.refreshIndex();
    const seen = [];
    const shell = new L.Bash({
      fs, cwd: ctx.bashCwd || '/home',
      customCommands: commands(L.defineCommand, ctx, seen),
      executionLimits: { maxExecutionTimeMs: 60000, maxOutputSize: 200000 },
    });
    let r;
    try { r = await shell.exec(script, { signal: ctx.signal }); } catch (e) { r = { stdout: '', stderr: String(e.message || e), exitCode: 1 }; }
    const room = Math.max(1500, (ctx.room || 24000) - 400);
    const out = String(r.stdout || ''), errText = String(r.stderr || '');
    const cut = (s, n) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters; narrow it with grep, head or sed -n)` : s);
    const model = { exit_code: r.exitCode };
    if (out) model.stdout = wrapUntrusted('bash output', cut(out, Math.floor(room * 0.85)));
    if (errText) model.stderr = cut(errText, Math.floor(room * 0.15));
    if (!out && !errText) model.stdout = '(no output)';
    return {
      model, ok: r.exitCode === 0,
      label: `$ ${truncate(script.replace(/\s+/g, ' '), 80)}${r.exitCode ? ` (exit ${r.exitCode})` : ''}`,
      items: seen.flatMap(x => x.items || []),
      observation: [...seen].reverse().map(x => x.observation).find(Boolean),
    };
  },
});
