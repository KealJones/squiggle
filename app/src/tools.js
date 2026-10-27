// The agent's tools. Each tool: { spec (name, description, parameters), run(args, ctx) }.
// run returns { model, label, observation? }:
//   model        what the model sees (JSON; outside text is wrapped as untrusted)
//   label        short line for the UI and for replaying history ("cloned owner/repo")
//   observation  { source, title, text } kept on the session so smart context
//                can retrieve it in later turns
import { git, fs, pfs, net, remoteUrl, exists, isDir, writeFile, rmrf, walk, stageAll, statusLines, currentBranch, author, mkdirp } from './git.js';
import { gh, apiBase, relayConfig } from './github.js';
import * as storage from './storage.js';
import * as memory from './memory.js';
import * as sessions from './sessions.js';
import { resolveAgentPath, agentPath, checkBranch, pushPolicy, touchesWorkflows, agentBranchName, parseRepo, AGENT_BRANCH_PREFIX } from './guard.js';
import * as grants from './grants.js';
import { wrapUntrusted } from './untrusted.js';
import { truncate } from './util.js';
import { bm25 } from './search.js';

const MAX_READ = 12000;
const REPOS = '/repos';

// ── Filesystem mapping ────────────────────────────────────────────────────
// /home/... lives in the storage repo (synced); /repos/<name>/... are clones.
function realPath(r) {
  if (r.area === 'home') return { kind: 'home', rel: 'home/' + r.rel };
  if (r.area === 'repos' && r.repo) return { kind: 'fs', path: `${REPOS}/${r.repo}${r.rel ? '/' + r.rel : ''}` };
  return { kind: 'virtual' };
}

async function readAgentFile(p) {
  const r = resolveAgentPath(p);
  const rp = realPath(r);
  if (rp.kind === 'home') return storage.read(rp.rel);
  if (rp.kind === 'fs') { try { return await pfs.readFile(rp.path, 'utf8'); } catch { return null; } }
  return null;
}

async function listAgentDir(p) {
  const r = resolveAgentPath(p);
  if (r.area === 'root') return ['home/', 'repos/'];
  if (r.area === 'repos' && !r.repo) return (await safeReaddir(REPOS)).map(n => n + '/');
  const rp = realPath(r);
  const files = rp.kind === 'home' ? await storage.list(rp.rel) : await walk(rp.path);
  return files.map(f => f.path + (f.size != null ? `  (${f.size} B)` : ''));
}

async function safeReaddir(dir) { try { return await pfs.readdir(dir); } catch { return []; } }

// ── Repo helpers ──────────────────────────────────────────────────────────
async function repoDir(name) {
  const n = String(name || '').includes('/') ? parseRepo(name).name : String(name || '');
  if (!n) throw new Error('Which repo? Pass the folder name under /repos or owner/name.');
  const dir = `${REPOS}/${n}`;
  if (!await exists(dir + '/.git')) throw new Error(`/repos/${n} is not cloned. Use git_clone first.`);
  return dir;
}

async function originOf(dir) {
  const remotes = await git.listRemotes({ fs, dir });
  const o = remotes.find(r => r.remote === 'origin');
  const m = o && o.url.match(/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/);
  return m ? { owner: m[1], name: m[2] } : null;
}

// Commits on the local branch that GitHub doesn't have yet (for the approval card).
async function commitsAhead(dir, branch) {
  const remote = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${branch}` }).catch(() => null);
  // Commits GitHub already has: the branch's own remote tip, or for a new
  // branch, anything on the other remote branches.
  const known = new Set(remote ? [remote] : []);
  if (!remote) {
    for (const b of await git.listBranches({ fs, dir, remote: 'origin' }).catch(() => [])) {
      for (const c of await git.log({ fs, dir, ref: `refs/remotes/origin/${b}`, depth: 200 }).catch(() => [])) known.add(c.oid);
    }
  }
  const log = await git.log({ fs, dir, ref: branch, depth: 30 }).catch(() => []);
  const out = [];
  for (const c of log) {
    if (known.has(c.oid)) break;
    out.push({ oid: c.oid, parent: c.commit.parent[0] || null, message: c.commit.message.split('\n')[0].slice(0, 120) });
  }
  return out;
}

// Files changed by those commits (each against its first parent).
async function changedPaths(dir, commits) {
  const paths = new Set();
  for (const c of commits) {
    const trees = c.parent ? [git.TREE({ ref: c.parent }), git.TREE({ ref: c.oid })] : [git.TREE({ ref: c.oid })];
    await git.walk({
      fs, dir, trees,
      map: async (filepath, [a, b]) => {
        if (filepath === '.') return;
        if (!c.parent) { if ((await a.type()) === 'blob') paths.add(filepath); return; }
        const at = a && await a.type(), bt = b && await b.type();
        if (at === 'tree' || bt === 'tree') return;
        if ((a && await a.oid()) !== (b && await b.oid())) paths.add(filepath);
      },
    });
  }
  return [...paths];
}

// ── Sandboxed JavaScript ──────────────────────────────────────────────────
let sandbox = null;
function getSandbox() {
  if (sandbox) return sandbox;
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.src = 'sandbox.html';
  frame.style.display = 'none';
  document.body.appendChild(frame);
  const pending = new Map();
  const ready = new Promise(res => {
    addEventListener('message', (e) => {
      if (e.source !== frame.contentWindow) return;
      if (e.data && e.data.ready) return res();
      const p = e.data && pending.get(e.data.id);
      if (p) { pending.delete(e.data.id); p(e.data); }
    });
  });
  sandbox = {
    async run(code, args, timeoutMs = 15000) {
      await ready;
      const id = Math.random().toString(36).slice(2);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          frame.contentWindow.postMessage({ kill: true }, '*'); // terminate the runaway worker
          resolve({ logs: [], error: `Timed out after ${timeoutMs / 1000}s.` });
        }, timeoutMs);
        pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
        frame.contentWindow.postMessage({ id, code, args }, '*');
      });
    },
  };
  return sandbox;
}

// ── Tool definitions ──────────────────────────────────────────────────────
const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'integer', description });
const bool = (description) => ({ type: 'boolean', description });

export const TOOLS = [
  // Files
  {
    spec: { name: 'list_files', description: 'List files in the workspace. /home is your own synced space; /repos/<name> are git clones.', parameters: S({ path: str('Folder, e.g. /home or /repos/myrepo/src') }) },
    async run({ path = '/' }) {
      const items = await listAgentDir(path);
      return { model: { path: agentPath(resolveAgentPath(path)), entries: items.slice(0, 400), more: Math.max(0, items.length - 400) }, label: `listed ${path}` };
    },
  },
  {
    spec: { name: 'read_file', description: 'Read lines of a text file from the workspace, with line numbers. Long files come in parts: use grep to find the lines you need, then read just that range.', parameters: S({ path: str('File path, e.g. /home/notes.md or /repos/app/README.md'), start_line: num('First line to read (default 1)'), end_line: num('Last line to read (default start_line + 150)') }, ['path']) },
    async run({ path, start_line = 1, end_line }, ctx = {}) {
      const text = await readAgentFile(path);
      if (text == null) return { model: { error: `No such file: ${path}` }, label: `read ${path} (missing)` };
      const lines = text.split('\n');
      const start = Math.max(1, Math.floor(start_line) || 1);
      let end = Math.min(lines.length, Math.floor(end_line) || start + 149);
      // Never more than the room left in the model's context (ctx.room, in chars).
      const cap = Math.min(MAX_READ, ctx.room || MAX_READ);
      let out = '';
      for (let i = start; i <= end; i++) {
        const line = `${i}: ${lines[i - 1]}\n`;
        if (out.length + line.length > cap) { end = i - 1; break; }
        out += line;
      }
      const fromRepo = resolveAgentPath(path).area === 'repos';
      return {
        model: { path, total_lines: lines.length, start_line: start, end_line: end, content: fromRepo ? wrapUntrusted('file ' + path, out) : out, ...(end < lines.length ? { more: `lines ${end + 1}-${lines.length} not shown; read them with start_line, or grep for what you need` } : {}) },
        label: `read ${path}${start > 1 || end < lines.length ? ` lines ${start}-${end}` : ''}`,
        observation: fromRepo ? { source: 'read_file', title: path, text: text.slice(0, 20000) } : null,
      };
    },
  },
  {
    spec: { name: 'grep', description: 'Search files for a word or regular expression. Returns matching lines as path:line: text. Use it to find where something is before reading.', parameters: S({ pattern: str('Text or regular expression, e.g. "function send" or "TODO|FIXME"'), path: str('Folder or file to search, e.g. /repos/app or /repos/app/src (default /home)'), ignore_case: bool('Case-insensitive (default true)'), skip: num('Skip this many matches (to get the next page)') }, ['pattern']) },
    async run({ pattern, path = '/home', ignore_case = true, skip = 0 }, ctx = {}) {
      let re;
      try { re = new RegExp(pattern, ignore_case ? 'i' : ''); } catch { re = new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ignore_case ? 'i' : ''); }
      const base = agentPath(resolveAgentPath(path));
      const single = await readAgentFile(base);
      const files = single != null ? [''] : (await listAgentDir(base)).map(e => e.replace(/\s+\(\d+ B\)$/, '')).filter(f => !f.endsWith('/'));
      const cap = Math.min(6000, ctx.room || 6000);
      const hits = [];
      let size = 0, scanned = 0, more = false, seen = 0;
      for (const f of files) {
        if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|wasm|lock|map|min\.js)$/i.test(f)) continue;
        const fp = f ? base.replace(/\/$/, '') + '/' + f : base;
        const text = f ? await readAgentFile(fp) : single;
        if (text == null || text.length > 1e6) continue;
        scanned++;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          if (seen++ < skip) continue;
          const hit = `${fp}:${i + 1}: ${lines[i].trim().slice(0, 160)}`;
          if (size + hit.length > cap || hits.length >= 60) { more = true; break; }
          hits.push(hit); size += hit.length + 1;
        }
        if (more) break;
      }
      const fromRepo = resolveAgentPath(base).area === 'repos';
      const body = hits.join('\n') || '(no matches)';
      return {
        model: { pattern, path: base, files_searched: scanned, matches: fromRepo ? wrapUntrusted('grep ' + base, body) : body, ...(more ? { more: `more matches not shown; call again with skip: ${skip + hits.length}, or narrow the pattern or path` } : {}) },
        label: `grep "${truncate(String(pattern), 40)}" in ${base} (${hits.length}${more ? '+' : ''})`,
      };
    },
  },
  {
    spec: { name: 'note', description: 'Your notepad for this chat. Save what matters for the task (findings, file locations, decisions, next steps) so you don\'t need old tool output again; update or delete notes as they stop being relevant. Your notes are always shown to you.', parameters: S({ action: { type: 'string', enum: ['add', 'update', 'delete'], description: 'add a note, update one by id, or delete one by id' }, id: str('Note id (for update/delete)'), text: str('Note text (for add/update); keep it short') }, ['action']) },
    async run({ action, id, text }, ctx = {}) {
      const s = ctx.session;
      if (!s) return { model: { error: 'No chat to keep notes in.' } };
      if (action === 'add' || action === 'update') {
        if (!text || !String(text).trim()) return { model: { error: 'Give the note text.' } };
        const n = sessions.setNote(s, action === 'update' ? id : null, String(text).trim().slice(0, 1500));
        if (!n) return { model: { error: `No note with id ${id}.` } };
        return { model: { ok: true, id: n.id, notes: sessions.liveNotes(s).length }, label: `${action === 'add' ? 'noted' : 'updated note'}: ${truncate(n.text, 60)}` };
      }
      if (action === 'delete') {
        return sessions.deleteNote(s, id) ? { model: { ok: true, deleted: id }, label: `erased note ${id}` } : { model: { error: `No note with id ${id}.` } };
      }
      return { model: { error: 'action must be add, update or delete.' } };
    },
  },
  {
    spec: { name: 'write_file', description: 'Create or overwrite a text file in the workspace. Files under /home sync to all the user\'s devices.', parameters: S({ path: str('File path'), content: str('Full file contents') }, ['path', 'content']) },
    async run({ path, content }) {
      const r = resolveAgentPath(path);
      const rp = realPath(r);
      if (rp.kind === 'virtual' || (r.area === 'repos' && !r.rel)) return { model: { error: 'Give a file path under /home/ or /repos/<name>/.' } };
      if (rp.kind === 'home') await storage.write(rp.rel, String(content));
      else {
        if (!await exists(`${REPOS}/${r.repo}`)) return { model: { error: `/repos/${r.repo} doesn't exist. Clone it first.` } };
        await writeFile(rp.path, String(content));
      }
      return { model: { ok: true, path: agentPath(r), chars: String(content).length }, label: `wrote ${agentPath(r)}` };
    },
  },
  {
    spec: { name: 'delete_file', description: 'Delete a file (or folder) in the workspace.', parameters: S({ path: str('Path to delete') }, ['path']) },
    async run({ path }) {
      const r = resolveAgentPath(path);
      const rp = realPath(r);
      if (rp.kind === 'virtual' || (r.area === 'home' && !r.rel)) return { model: { error: 'Refusing to delete a workspace root.' } };
      if (rp.kind === 'home') await storage.remove(rp.rel);
      else await rmrf(rp.path);
      return { model: { ok: true }, label: `deleted ${agentPath(r)}` };
    },
  },

  // Git
  {
    spec: { name: 'github_list_repos', description: 'List the GitHub repos the user has given Squiggle access to.', parameters: S({}) },
    async run() {
      const d = await gh('/user/installations?per_page=100');
      const repos = [];
      for (const inst of d.installations || []) {
        const r = await gh(`/user/installations/${inst.id}/repositories?per_page=100`);
        for (const x of r.repositories || []) repos.push({ repo: x.full_name, private: x.private, default_branch: x.default_branch, description: x.description || '' });
      }
      const cfg = storage.storageConfig();
      const shown = repos.filter(r => !cfg || r.repo !== `${cfg.owner}/${cfg.name}`);
      return { model: { repos: shown.map(r => ({ ...r, description: wrapUntrusted('github', r.description) })) }, label: 'listed GitHub repos' };
    },
  },
  {
    spec: { name: 'git_clone', description: 'Clone a GitHub repo into /repos/<name>. Pulls if it is already cloned.', parameters: S({ repo: str('owner/name') , branch: str('Branch to check out (default: the repo default)') }, ['repo']) },
    async run({ repo, branch }) {
      const { owner, name } = parseRepo(repo);
      const cfg = storage.storageConfig();
      if (cfg && owner === cfg.owner && name === cfg.name) return { model: { error: 'That is the storage repo; it is managed automatically. Use /home for your files.' } };
      const dir = `${REPOS}/${name}`;
      if (await exists(dir + '/.git')) {
        const o = await originOf(dir);
        if (o && (o.owner !== owner || o.name !== name)) return { model: { error: `/repos/${name} already holds ${o.owner}/${o.name}.` } };
        await git.pull({ fs, dir, ...net(), singleBranch: true, fastForwardOnly: true, author: await author() }).catch(() => {});
        return { model: { ok: true, already_cloned: true, path: `/repos/${name}`, branch: await currentBranch(dir) }, label: `updated ${owner}/${name}` };
      }
      await mkdirp(dir);
      try {
        await git.clone({ fs, dir, url: remoteUrl(owner, name), ref: branch || undefined, singleBranch: false, depth: 50, ...net() });
      } catch (e) {
        await rmrf(dir);
        throw e;
      }
      const files = await walk(dir);
      return { model: { ok: true, path: `/repos/${name}`, branch: await currentBranch(dir), files: files.length }, label: `cloned ${owner}/${name}` };
    },
  },
  {
    spec: { name: 'git_status', description: 'Show the current branch and changed files of a cloned repo.', parameters: S({ repo: str('Folder name under /repos (or owner/name)') }, ['repo']) },
    async run({ repo }) {
      const dir = await repoDir(repo);
      return { model: { branch: await currentBranch(dir), changes: await statusLines(dir) }, label: `status of ${repo}` };
    },
  },
  {
    spec: { name: 'git_branch', description: 'Switch to a branch, or start a new one. Pass an existing branch name (e.g. "main") to switch to it. A new branch gets the "agent/" prefix; you can push agent/ branches freely, while pushing any other branch asks the user first. Uncommitted changes carry over to a new branch.', parameters: S({ repo: str('Folder name under /repos'), name: str('Existing branch, or a short name for a new one, e.g. "fix-login"'), from: str('For a new branch: branch or commit to start from (default: current)') }, ['repo', 'name']) },
    async run({ repo, name, from }) {
      const dir = await repoDir(repo);
      const raw = String(name || '').trim();
      const local = await git.listBranches({ fs, dir });
      const remote = await git.listBranches({ fs, dir, remote: 'origin' }).catch(() => []);
      if (raw && (local.includes(raw) || remote.includes(raw))) {
        if (!local.includes(raw)) {
          const oid = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${raw}` });
          await git.branch({ fs, dir, ref: raw, object: oid });
        }
        try { await git.checkout({ fs, dir, ref: raw }); }
        catch (e) { return { model: { error: `Can't switch to ${raw}: uncommitted changes would be overwritten. Commit them first (or start a new branch to keep them). (${e.message})` } }; }
        return { model: { ok: true, branch: raw, existing: true }, label: `switched to ${raw} in ${repo}` };
      }
      const branch = agentBranchName(raw);
      if (!local.includes(branch)) {
        const start = from ? await git.resolveRef({ fs, dir, ref: from }).catch(() => git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${from}` })) : undefined;
        await git.branch({ fs, dir, ref: branch, object: start, checkout: false });
      }
      // Keep working-tree edits: switch HEAD without touching files.
      await git.checkout({ fs, dir, ref: branch, noCheckout: !from });
      if (from) await git.checkout({ fs, dir, ref: branch });
      return { model: { ok: true, branch }, label: `on ${branch} in ${repo}` };
    },
  },
  {
    spec: { name: 'git_commit', description: 'Commit all changes in a repo on the current branch.', parameters: S({ repo: str('Folder name under /repos'), message: str('Commit message') }, ['repo', 'message']) },
    async run({ repo, message }) {
      const dir = await repoDir(repo);
      const problem = checkBranch(await currentBranch(dir));
      if (problem) return { model: { error: problem } };
      const n = await stageAll(dir);
      if (!n) return { model: { ok: false, error: 'Nothing to commit.' } };
      const oid = await git.commit({ fs, dir, message: String(message || 'Update').slice(0, 2000), author: await author() });
      return { model: { ok: true, commit: oid.slice(0, 8), files: n }, label: `committed ${n} file(s) in ${repo}` };
    },
  },
  {
    spec: { name: 'git_push', description: `Push the current branch to GitHub (never forced). ${AGENT_BRANCH_PREFIX} branches push right away; any other branch (like main) asks the user for permission first.`, parameters: S({ repo: str('Folder name under /repos') }, ['repo']) },
    async run({ repo }, ctx = {}) {
      const dir = await repoDir(repo);
      const branch = await currentBranch(dir);
      const problem = checkBranch(branch);
      if (problem) return { model: { error: problem } };
      const o = await originOf(dir);
      const where = o ? `${o.owner}/${o.name}` : repo;

      // Pushes outside agent/ need the person's OK. The decision comes from
      // the UI (ctx.approve), never from anything the model says.
      const commits = await commitsAhead(dir, branch);
      const workflowFiles = touchesWorkflows(await changedPaths(dir, commits));
      let approval = workflowFiles.length ? 'ask' : pushPolicy(where, branch, grants.keys());
      if (approval === 'ask') {
        if (typeof ctx.approve !== 'function') return { model: { error: `Pushing to ${branch} needs the user's approval, and no one is here to approve it. Push to an ${AGENT_BRANCH_PREFIX} branch instead, or ask the user.` } };
        const decision = await ctx.approve({ kind: 'push', repo: where, branch, commits: commits.map(c => ({ oid: c.oid.slice(0, 7), message: c.message })), workflowFiles });
        if (decision === 'always' && !workflowFiles.length) { await grants.add(where, branch); approval = 'always'; }
        else if (decision === 'always') approval = 'once'; // never remembered for workflow changes
        else if (decision === 'once') approval = 'once';
        else return { model: { error: `The user did not allow pushing to ${branch} in ${where}. Don't try again; ask them how they'd like to proceed (for example, push to an ${AGENT_BRANCH_PREFIX} branch and open a pull request).` }, label: `push to ${branch} not allowed` };
      }

      let r;
      try {
        r = await git.push({ fs, dir, remote: 'origin', ref: branch, remoteRef: branch, force: false, ...net() });
      } catch (e) {
        if (/40[13]|HttpError|cancel/i.test(String(e && (e.message || e.code)))) {
          return { model: { error: `GitHub refused the push to ${where}. Either the user hasn't given Squiggle access to this repo (they can add it in Settings → Manage repo access) or they don't have write access to it. Tell the user; don't retry.` } };
        }
        if (/fast-forward|PushRejected/i.test(String(e && (e.message || e.code)))) {
          return { model: { error: `GitHub rejected the push: ${branch} has new commits on GitHub. Run git_pull first. (Squiggle never force-pushes.)` } };
        }
        throw e;
      }
      if (r && r.ok === false) {
        const detail = JSON.stringify(r.refs || {});
        const hint = /workflow/i.test(detail) ? ' The commit changes a file in .github/workflows/, which needs the optional Workflows permission on the GitHub App. Tell the user.' : '';
        return { model: { error: 'Push rejected: ' + detail + hint } };
      }
      const how = approval === 'once' ? ' (allowed once)' : approval === 'always' ? ' (always allowed)' : approval === 'granted' ? ' (allowed)' : '';
      return { model: { ok: true, branch, compare_url: o && branch.startsWith(AGENT_BRANCH_PREFIX) ? `https://github.com/${o.owner}/${o.name}/compare/${encodeURIComponent(branch)}` : null }, label: `pushed ${branch} (${repo})${how}` };
    },
  },
  {
    spec: { name: 'git_pull', description: 'Fetch and fast-forward the current branch from GitHub.', parameters: S({ repo: str('Folder name under /repos') }, ['repo']) },
    async run({ repo }) {
      const dir = await repoDir(repo);
      const branch = await currentBranch(dir);
      await git.fetch({ fs, dir, remote: 'origin', ...net() });
      const remote = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${branch}` }).catch(() => null);
      if (!remote) return { model: { ok: true, note: `Branch ${branch} is not on GitHub yet.` }, label: `fetched ${repo}` };
      await git.merge({ fs, dir, ours: branch, theirs: `origin/${branch}`, fastForwardOnly: true, author: await author() })
        .catch(e => { throw new Error('Could not fast-forward (local and remote diverged): ' + e.message); });
      await git.checkout({ fs, dir, ref: branch });
      return { model: { ok: true, branch }, label: `pulled ${repo}` };
    },
  },
  {
    spec: { name: 'git_log', description: 'Recent commits on the current branch.', parameters: S({ repo: str('Folder name under /repos'), count: num('How many (default 10)') }, ['repo']) },
    async run({ repo, count = 10 }) {
      const dir = await repoDir(repo);
      const log = await git.log({ fs, dir, depth: Math.min(50, count) });
      const lines = log.map(c => `${c.oid.slice(0, 8)} ${new Date(c.commit.author.timestamp * 1000).toISOString().slice(0, 10)} ${c.commit.author.name}: ${c.commit.message.split('\n')[0]}`);
      return { model: { commits: wrapUntrusted('git log', lines.join('\n')) }, label: `log of ${repo}` };
    },
  },
  {
    spec: { name: 'github_open_pr', description: 'Open a pull request from the current (pushed) branch.', parameters: S({ repo: str('Folder name under /repos'), title: str('PR title'), body: str('PR description'), base: str('Target branch (default: repo default)') }, ['repo', 'title']) },
    async run({ repo, title, body = '', base }) {
      const dir = await repoDir(repo);
      const branch = await currentBranch(dir);
      const problem = checkBranch(branch);
      if (problem) return { model: { error: problem } };
      const o = await originOf(dir);
      const info = await gh(`/repos/${o.owner}/${o.name}`);
      const pr = await gh(`/repos/${o.owner}/${o.name}/pulls`, { method: 'POST', body: { title, body: body + '\n\n_Opened by Squiggle._', head: branch, base: base || info.default_branch } });
      return { model: { ok: true, number: pr.number, url: pr.html_url }, label: `opened PR #${pr.number} on ${o.owner}/${o.name}` };
    },
  },

  // Web
  {
    spec: { name: 'fetch_url', description: 'Read a web page by its full URL. Returns readable text. Not a search engine.', parameters: S({ url: str('Complete http(s) URL') }, ['url']) },
    async run({ url }) {
      let u;
      try { u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url); } catch { return { model: { error: 'Pass one full URL, e.g. https://example.com/page.' } }; }
      let resp, via = 'direct';
      try { resp = await fetch(u.href, { redirect: 'follow' }); } catch {
        const cfg = await relayConfig().catch(() => ({}));
        if (!cfg.fetchEnabled) return { model: { error: 'That site blocks browser requests and the fetch relay is off.' } };
        resp = await fetch(`${apiBase()}/fetch?url=${encodeURIComponent(u.href)}`);
        via = 'relay';
      }
      const ct = resp.headers.get('content-type') || '';
      const raw = await resp.text();
      let text = raw, title = u.href;
      if (/html/i.test(ct) || /^\s*<(!doctype|html)/i.test(raw)) {
        const doc = new DOMParser().parseFromString(raw, 'text/html');
        title = (doc.title || u.href).trim();
        doc.querySelectorAll('script,style,noscript,svg,iframe,template,[hidden],[aria-hidden="true"]').forEach(n => n.remove());
        text = (doc.body ? doc.body.innerText || doc.body.textContent : doc.documentElement.textContent || '')
          .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      }
      const status = via === 'relay' ? +(resp.headers.get('x-upstream-status') || resp.status) : resp.status;
      return {
        model: { url: u.href, status, title, text: wrapUntrusted('web ' + u.hostname, truncate(text, MAX_READ)) },
        label: `read ${u.href}`,
        observation: { source: 'web', title: `${title} (${u.href})`, text: text.slice(0, 30000) },
      };
    },
  },

  {
    spec: { name: 'web_search', description: 'Search the web (DuckDuckGo). Returns a short summary when one exists, plus titles, links and snippets. To read a result in full, pass its url to fetch_url.', parameters: S({ query: str('What to search for'), count: num('How many results (default 6, max 10)') }, ['query']) },
    async run({ query, count = 6 }) {
      const q = String(query || '').trim();
      if (!q) return { model: { error: 'Give a search query.' } };
      let r;
      try { r = await fetch(`${apiBase()}/search?q=${encodeURIComponent(q)}&n=${Math.min(Math.max(+count || 6, 1), 10)}`, { cache: 'no-store' }); }
      catch { return { model: { error: 'Could not reach the relay for search.' } }; }
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) return { model: { error: d.error || `Search failed (HTTP ${r.status}).` }, label: `search failed: "${q}"` };
      const results = d.results || [];
      const a = d.answer;
      const summary = a ? `Summary${a.heading ? ` of "${a.heading}"` : ''} (${a.source}${a.url ? ', ' + a.url : ''}):\n${a.text}\n\n` : '';
      const text = summary + results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n');
      return {
        model: { query: q, count: results.length, results: wrapUntrusted('web search', text.trim() || 'No results.') },
        label: `searched the web for "${truncate(q, 60)}" (${results.length})`,
        observation: text.trim() ? { source: 'web search', title: `Search: ${q}`, text } : null,
      };
    },
  },

  // Memory
  {
    spec: { name: 'remember', description: 'Save a lasting fact about the user or their projects (preferences, decisions, names, how things work). Saved as subject → relation → object.', parameters: S({ subject: str('Who/what, e.g. "Keal" or "squiggle"'), relation: str('e.g. "prefers", "uses", "is deployed on"'), object: str('the value'), note: str('optional detail') }, ['subject', 'relation', 'object']) },
    async run({ subject, relation, object, note }, ctx) {
      const f = memory.add({ s: subject, p: relation, o: object, note, source: { session: ctx.session.id } });
      return { model: { ok: true, id: f.id }, label: `remembered: ${subject} ${relation} ${object}` };
    },
  },
  {
    spec: { name: 'recall', description: 'Search saved memory facts.', parameters: S({ query: str('What to look for') }, ['query']) },
    async run({ query }) {
      const r = await memory.recall(query, 12);
      return { model: { facts: r.map(({ fact }) => ({ id: fact.id, fact: memory.factText(fact) })) }, label: `recalled "${query}"` };
    },
  },
  {
    spec: { name: 'forget', description: 'Delete a saved memory fact by id (when the user says it is wrong or outdated).', parameters: S({ id: str('Fact id from recall') }, ['id']) },
    async run({ id }) {
      return memory.remove(id) ? { model: { ok: true }, label: 'forgot a fact' } : { model: { error: 'No fact with that id.' } };
    },
  },
  {
    spec: { name: 'search_history', description: 'Search the user\'s past conversations (all sessions) for something discussed before.', parameters: S({ query: str('What to look for') }, ['query']) },
    async run({ query }, ctx) {
      const docs = [];
      for (const s of sessions.list()) {
        for (const m of s.messages) if (m.content) docs.push({ id: `${s.id}|${m.id}`, text: m.content, s, m });
      }
      const scores = bm25(docs)(query);
      const top = docs.filter(d => scores.has(d.id)).sort((a, b) => scores.get(b.id) - scores.get(a.id)).slice(0, 6);
      return {
        model: { results: top.map(d => ({ session: d.s.title, when: new Date(d.m.ts).toISOString().slice(0, 10), role: d.m.role, text: truncate(d.m.content, 600), this_session: d.s.id === ctx.session.id })) },
        label: `searched history for "${query}"`,
      };
    },
  },

  // Code
  {
    spec: { name: 'run_js', description: 'Run JavaScript in an isolated sandbox (no access to the user\'s data or files). Use for math, data processing, or checking logic. Use console.log or return a value. Top-level await works.', parameters: S({ code: str('JavaScript code') }, ['code']) },
    async run({ code }) {
      const r = await getSandbox().run(String(code || ''));
      return { model: { stdout: truncate((r.logs || []).join('\n'), 6000), result: r.result != null ? truncate(r.result, 4000) : undefined, error: r.error || undefined }, label: 'ran JavaScript' };
    },
  },
];

export const toolSpecs = (enabled) => TOOLS.filter(t => !enabled || enabled.has(t.spec.name)).map(t => t.spec);

export async function runTool(call, ctx) {
  const fn = call && call.function || {};
  const tool = TOOLS.find(t => t.spec.name === fn.name);
  let args = fn.arguments || {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
  if (!tool) return { name: fn.name, args, model: { error: `Unknown tool "${fn.name}".` }, label: `unknown tool ${fn.name}`, ok: false };
  try {
    const r = await tool.run(args, ctx);
    return { name: fn.name, args, ...r, ok: !(r.model && r.model.error) };
  } catch (e) {
    return { name: fn.name, args, model: { error: String((e && e.message) || e) }, label: `${fn.name} failed`, ok: false };
  }
}
