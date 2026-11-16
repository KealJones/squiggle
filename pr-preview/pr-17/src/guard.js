// Hard rules the model cannot talk its way around. Pure functions so they're
// unit-tested (tests/guard.test.js).

export const AGENT_BRANCH_PREFIX = 'agent/';

// Can the agent commit/push on this branch at all? (Detached HEAD or a
// malformed name: no.) Returns an error message or null.
export function checkBranch(branch) {
  if (!branch) return 'Not on a branch (detached HEAD). Use git_branch to switch to or create a branch.';
  if (!isValidBranchName(branch)) return `"${branch}" is not a valid branch name.`;
  return null;
}

// Push policy. agent/ branches are the agent's own: push freely. Any other
// branch needs the person's approval, either once or remembered as a grant
// for that exact repo + branch. Force pushes are never made.
//   grants: Set of grantKey(repo, branch)
export function pushPolicy(repo, branch, grants) {
  if (branch.startsWith(AGENT_BRANCH_PREFIX)) return 'free';
  if (grants && grants.has(grantKey(repo, branch))) return 'granted';
  return 'ask';
}

export const grantKey = (repo, branch) => `${String(repo).toLowerCase()}:${branch}`;

// Workflow files run code on GitHub with the repo's secrets, so pushes that
// change them always need a fresh, one-time approval — on any branch, and
// regardless of "always allow".
export const touchesWorkflows = (paths) => paths.filter(p => /^\.github\/workflows\//.test(p));

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
  if (top === 'web') return { area: 'web', rel: rest.join('/') };
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
  if (r.area === 'web') return '/web' + (r.rel ? '/' + r.rel : '');
  return '/repos' + (r.repo ? '/' + r.repo : '') + (r.rel ? '/' + r.rel : '');
}

// "owner/name", "https://github.com/owner/name(.git)" → { owner, name }
/** A repo the model named in full ("owner/name", a github.com link), or only in part ("tester" for tester/app, or
 *  just "app"): a part is completed when exactly one repo fits, first from GitHub links and owner/name in what the
 *  user said (`said`), then from the repos the app can reach (`reachable`, async, full names). LFM2.5 1.2B called
 *  git_clone(repo="tester") for "pull github.com/tester/app", got "use owner/name" back and repeated itself until
 *  the repeat guard stopped it (failures.md case 16). Returns { owner, name, completed?: 'your message' |
 *  'your repos' }; throws with the candidates when several fit. */
export async function completeRepo(repo, { said = '', reachable = async () => [] } = {}) {
  try { return parseRepo(repo); } catch (e) {
    const want = String(repo || '').trim().replace(/^@/, '').toLowerCase();
    if (!want || /[\s/]/.test(want)) throw e;
    const fits = (full) => { const [o, n] = String(full).toLowerCase().split('/'); return o === want || n === want; };
    const named = [...new Set([...String(said).matchAll(/\bgithub\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*?)(?:\.git)?(?=[\s/#?,;:!)]|\.?$|\.\s)/gi),
      ...String(said).matchAll(/(?:^|\s)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?=\s|$|[.,;:!?)])/g)].map(m => `${m[1]}/${m[2]}`))].filter(fits);
    if (named.length === 1) return { ...parseRepo(named[0]), completed: 'your message' };
    let found = [];
    if (!named.length) { try { found = (await reachable()).filter(Boolean).filter(fits); } catch {} }
    if (found.length === 1) return { ...parseRepo(found[0]), completed: 'your repos' };
    const options = named.length ? named : found;
    if (options.length) throw new Error(`"${repo}" could be ${options.slice(0, 6).join(', ')}. Call again with one of those (owner/name).`);
    throw e;
  }
}

export function parseRepo(s) {
  const m = String(s || '').trim().match(/^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  if (!m) throw new Error(`"${s}" is not a GitHub repo. Use owner/name.`);
  return { owner: m[1], name: m[2] };
}
