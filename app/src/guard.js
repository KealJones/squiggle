// Hard rules the model cannot talk its way around. Pure functions so they're
// unit-tested (tests/guard.test.js).

export const AGENT_BRANCH_PREFIX = 'agent/';

// The agent may only commit to and push branches it owns.
export function checkAgentBranch(branch) {
  if (!branch) return 'Not on a branch (detached HEAD). Use git_branch to start an agent/ branch.';
  if (!branch.startsWith(AGENT_BRANCH_PREFIX)) {
    return `Branch "${branch}" is not an agent branch. The agent can only commit and push to branches starting with "${AGENT_BRANCH_PREFIX}". Use git_branch to create one.`;
  }
  if (!isValidBranchName(branch)) return `"${branch}" is not a valid branch name.`;
  return null;
}

// Turns "fix login" / "agent/fix-login" into "agent/fix-login".
export function agentBranchName(name) {
  let n = String(name || '').trim().replace(/^agent\//, '');
  n = n.toLowerCase().replace(/[^a-z0-9._/-]+/g, '-').replace(/\/+/g, '/').replace(/^[-./]+|[-./]+$/g, '');
  n = n.replace(/\.\.+/g, '.').replace(/\.lock(\/|$)/g, '-lock$1');
  if (!n) throw new Error('Branch name is empty.');
  return AGENT_BRANCH_PREFIX + n.slice(0, 80);
}

export function isValidBranchName(b) {
  return /^[A-Za-z0-9._/-]+$/.test(b) && !b.includes('..') && !b.startsWith('/') && !b.endsWith('/') &&
    !b.endsWith('.lock') && !b.includes('//');
}

// ── Agent filesystem paths ────────────────────────────────────────────────
// The agent sees one tree:
//   /home/...          its synced scratch space (stored in the storage repo)
//   /repos/<name>/...  git clones (device-local; share work by pushing)
// Returns { area: 'home'|'repos'|'root', repo?, rel } or throws.
export function resolveAgentPath(p) {
  let s = String(p ?? '').trim().replace(/\\/g, '/');
  if (!s || s === '~') s = '/home';
  if (s.startsWith('~/')) s = '/home/' + s.slice(2);
  if (!s.startsWith('/')) s = '/home/' + s;
  const parts = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) throw new Error(`Path "${p}" escapes the workspace.`);
      parts.pop();
      continue;
    }
    if (seg === '.git') throw new Error('The .git folder is managed by the git tools; it cannot be accessed directly.');
    parts.push(seg);
  }
  if (!parts.length) return { area: 'root', rel: '' };
  const [top, ...rest] = parts;
  if (top === 'home') return { area: 'home', rel: rest.join('/') };
  if (top === 'repos') {
    if (!rest.length) return { area: 'repos', repo: null, rel: '' };
    const [repo, ...inner] = rest;
    if (!/^[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`Bad repo folder name "${repo}".`);
    return { area: 'repos', repo, rel: inner.join('/') };
  }
  throw new Error(`Path "${p}" is outside the workspace. Use /home/... or /repos/<name>/...`);
}

export function agentPath(r) {
  if (r.area === 'root') return '/';
  if (r.area === 'home') return '/home' + (r.rel ? '/' + r.rel : '');
  return '/repos' + (r.repo ? '/' + r.repo : '') + (r.rel ? '/' + r.rel : '');
}

// "owner/name", "https://github.com/owner/name(.git)" → { owner, name }
export function parseRepo(s) {
  const m = String(s || '').trim().match(/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`"${s}" is not a GitHub repo. Use owner/name.`);
  return { owner: m[1], name: m[2] };
}
