// Git and GitHub tools: clone, status, branch, commit, push (with the push policy),
// pull, log, show, list repos, open a pull request.
import { git, fs, net, remoteUrl, exists, rmrf, walk, stageAll, statusLines, currentBranch, author, mkdirp } from '../git.js';
import { gh } from '../github.js';
import * as storage from '../storage.js';
import { checkBranch, pushPolicy, touchesWorkflows, agentBranchName, parseRepo, AGENT_BRANCH_PREFIX } from '../guard.js';
import * as grants from '../grants.js';
import { wrapUntrusted } from '../untrusted.js';
import { defineTool, params, str, num } from './registry.js';
import { MAX_READ, REPOS, numberedLines } from './workspace.js';

// ── Repo helpers ──────────────────────────────────────────────────────────
async function repoDir(name) {
  const n = String(name || '').includes('/') ? parseRepo(name).name : String(name || '');
  if (!n) throw new Error('Which repo? Pass the folder name under /repos or owner/name.');
  const dir = `${REPOS}/${n}`;
  if (!await exists(dir + '/.git')) throw new Error(`/repos/${n} is not cloned. Use git_clone first.`);
  return dir;
}

// A commit id (short or full), branch, tag or HEAD, with ~N / ^ for ancestors.
async function resolveCommit(dir, ref) {
  const m = /^(.*?)((?:[~^]\d*)*)$/.exec(ref);
  const base = m[1] || 'HEAD';
  let oid;
  if (/^[0-9a-f]{4,40}$/i.test(base)) {
    try { oid = await git.expandOid({ fs, dir, oid: base.toLowerCase() }); } catch { oid = null; }
  }
  if (!oid) oid = await git.resolveRef({ fs, dir, ref: base });
  for (const step of m[2].match(/[~^]\d*/g) || []) {
    const n = step.length > 1 ? +step.slice(1) : 1;
    for (let i = 0; i < (step[0] === '~' ? n : 1); i++) {
      const { commit } = await git.readCommit({ fs, dir, oid });
      const parent = commit.parent[step[0] === '^' ? n - 1 : 0];
      if (!parent) throw new Error('no parent');
      oid = parent;
    }
  }
  return oid;
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

// ── Tools ─────────────────────────────────────────────────────────────────
export const githubListRepos = defineTool({
  name: 'github_list_repos',
  group: 'git and GitHub',
  description: 'List the GitHub repos the user has given Squiggle access to.',
  parameters: params({}),
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
});

export const gitClone = defineTool({
  name: 'git_clone',
  group: 'git and GitHub',
  description: 'Clone a GitHub repo into /repos/<name>. Pulls if it is already cloned.',
  parameters: params({ repo: str('owner/name'), branch: str('Branch to check out (default: the repo default)') }, ['repo']),
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
});

export const gitStatus = defineTool({
  name: 'git_status',
  group: 'git and GitHub',
  description: 'Show the current branch and changed files of a cloned repo.',
  parameters: params({ repo: str('Folder name under /repos (or owner/name)') }, ['repo']),
  async run({ repo }) {
    const dir = await repoDir(repo);
    return { model: { branch: await currentBranch(dir), changes: await statusLines(dir) }, label: `status of ${repo}` };
  },
});

export const gitBranch = defineTool({
  name: 'git_branch',
  group: 'git and GitHub',
  description: 'Switch to a branch, or start a new one. Pass an existing branch name (e.g. "main") to switch to it. A new branch gets the "agent/" prefix; you can push agent/ branches freely, while pushing any other branch asks the user first. Uncommitted changes carry over to a new branch.',
  parameters: params({ repo: str('Folder name under /repos'), name: str('Existing branch, or a short name for a new one, e.g. "fix-login"'), from: str('For a new branch: branch or commit to start from (default: current)') }, ['repo', 'name']),
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
});

export const gitCommit = defineTool({
  name: 'git_commit',
  group: 'git and GitHub',
  description: 'Commit all changes in a repo on the current branch.',
  parameters: params({ repo: str('Folder name under /repos'), message: str('Commit message') }, ['repo', 'message']),
  async run({ repo, message }) {
    const dir = await repoDir(repo);
    const problem = checkBranch(await currentBranch(dir));
    if (problem) return { model: { error: problem } };
    const n = await stageAll(dir);
    if (!n) return { model: { ok: false, error: 'Nothing to commit.' } };
    const oid = await git.commit({ fs, dir, message: String(message || 'Update').slice(0, 2000), author: await author() });
    return { model: { ok: true, commit: oid.slice(0, 8), files: n }, label: `committed ${n} file(s) in ${repo}` };
  },
});

export const gitPush = defineTool({
  name: 'git_push',
  group: 'git and GitHub',
  description: `Push the current branch to GitHub (never forced). ${AGENT_BRANCH_PREFIX} branches push right away; any other branch (like main) asks the user for permission first.`,
  parameters: params({ repo: str('Folder name under /repos') }, ['repo']),
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
});

export const gitPull = defineTool({
  name: 'git_pull',
  group: 'git and GitHub',
  description: 'Fetch and fast-forward the current branch from GitHub.',
  parameters: params({ repo: str('Folder name under /repos') }, ['repo']),
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
});

export const gitLog = defineTool({
  name: 'git_log',
  group: 'git and GitHub',
  description: 'Recent commits on the current branch.',
  parameters: params({ repo: str('Folder name under /repos'), count: num('How many (default 10)') }, ['repo']),
  async run({ repo, count = 10 }) {
    const dir = await repoDir(repo);
    const log = await git.log({ fs, dir, depth: Math.min(50, count) });
    const lines = log.map(c => `${c.oid.slice(0, 8)} ${new Date(c.commit.author.timestamp * 1000).toISOString().slice(0, 10)} ${c.commit.author.name}: ${c.commit.message.split('\n')[0]}`);
    return { model: { commits: wrapUntrusted('git log', lines.join('\n')) }, label: `log of ${repo}` };
  },
});

export const gitShow = defineTool({
  name: 'git_show',
  group: 'git and GitHub',
  description: 'Read a file as it was at an earlier commit, with line numbers. To restore it, write that content back with write_file (overwrite: true).',
  parameters: params({ repo: str('Folder name under /repos'), path: str('File path in the repo, e.g. app/src/main.js'), ref: str('Commit id from git_log (short is fine), or HEAD~1 for the one before the latest'), start_line: num('First line (default 1)'), end_line: num('Last line (default start_line + 150)') }, ['repo', 'path', 'ref']),
  async run({ repo, path, ref = 'HEAD', start_line = 1, end_line }, ctx = {}) {
    const dir = await repoDir(repo);
    const name = dir.slice(REPOS.length + 1);
    const filepath = String(path || '').replace(/^\/?repos\/[^/]+\//, '').replace(/^\/+/, '');
    if (!filepath) return { model: { error: 'Give the file path inside the repo, e.g. app/src/main.js.' } };
    let oid;
    try { oid = await resolveCommit(dir, String(ref || 'HEAD').trim()); }
    catch { return { model: { error: `Unknown commit or branch "${ref}". Use a commit id from git_log, a branch name, or HEAD~1.` }, label: `git_show ${ref} (unknown)` }; }
    let text;
    try { text = new TextDecoder().decode((await git.readBlob({ fs, dir, oid, filepath })).blob); }
    catch { return { model: { error: `${filepath} didn't exist at ${oid.slice(0, 8)}.` }, label: `git_show ${filepath} at ${oid.slice(0, 8)} (missing)` }; }
    const lines = text.split('\n');
    const start = Math.max(1, Math.floor(start_line) || 1);
    const { out, end } = numberedLines(lines, start, Math.min(lines.length, Math.floor(end_line) || start + 149), Math.min(MAX_READ, ctx.room || MAX_READ));
    return {
      model: { repo: name, path: filepath, commit: oid.slice(0, 8), total_lines: lines.length, start_line: start, end_line: end, content: wrapUntrusted(`file ${filepath} at ${oid.slice(0, 8)}`, out), ...(end < lines.length ? { more: `lines ${end + 1}-${lines.length} not shown; call again with start_line` } : {}) },
      label: `read ${filepath} at ${oid.slice(0, 8)}${start > 1 || end < lines.length ? ` lines ${start}-${end}` : ''}`,
    };
  },
});

export const githubOpenPr = defineTool({
  name: 'github_open_pr',
  group: 'git and GitHub',
  description: 'Open a pull request from the current (pushed) branch.',
  parameters: params({ repo: str('Folder name under /repos'), title: str('PR title'), body: str('PR description'), base: str('Target branch (default: repo default)') }, ['repo', 'title']),
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
});
