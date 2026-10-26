// The storage repo: a private GitHub repo that holds sessions, memory and
// the agent's /home files, cloned into the browser at /state and synced with
// a client-side "rebase":
//
//   1. remember every file this device changed since the last sync, along with
//      the version it started from (its blob id),
//   2. fetch and reset to the remote branch,
//   3. re-apply local changes; where the remote also changed a file, merge it
//      (sessions and .jsonl files merge cleanly; anything else keeps this
//      device's version and saves the other as "<file>.remote-<date>"),
//   4. commit and push; if another device pushed in the meantime, repeat.
//
// No merge conflicts ever reach the person, and no device's work is dropped.
import { git, fs, pfs, net, remoteUrl, exists, writeFile, rmrf, walk, stageAll, author } from './git.js';
import { gh, accessibleRepos } from './github.js';
import { kv, mutex, emitter, uid } from './util.js';
import { mergeFor } from './merge.js';

const DIR = '/state';
const MARKER = '.squiggle.json';
export const events = emitter();
const lock = mutex();

let cfg = null;    // { owner, name, branch, root }
let dirty = {};    // { 'repo/path': baseOid | null }
let syncing = false;
let lastSync = 0;
let lastError = null;

export const storageConfig = () => cfg;
export const syncStatus = () => ({ syncing, lastSync, lastError, pending: Object.keys(dirty).length });

export async function loadStorageConfig() {
  cfg = (await kv.get('storage')) || null;
  dirty = (await kv.get('storage-dirty')) || {};
  return cfg;
}

async function deviceTag() {
  let d = await kv.get('device');
  if (!d) { d = { id: uid('d') }; await kv.set('device', d); }
  return d.id.slice(-6);
}

// ── Setup ──────────────────────────────────────────────────────────────────

// Look for a repo this person already set up as storage (e.g. on another
// device): a private repo the app can reach that contains the marker file.
export async function findExistingStorage() {
  const repos = (await accessibleRepos()).filter(r => r.private);
  // Likely names first so the common case costs one or two requests.
  repos.sort((a, b) => score(b) - score(a));
  for (const r of repos.slice(0, 25)) {
    for (const root of ['', 'squiggle/']) {
      try {
        await gh(`/repos/${r.owner.login}/${r.name}/contents/${root}${MARKER}`);
        return { owner: r.owner.login, name: r.name, branch: r.default_branch || 'main', root };
      } catch { /* not this one */ }
    }
  }
  return null;
  function score(r) { return /squiggle/i.test(r.name) ? 2 : /state|agent|notes|memory/i.test(r.name) ? 1 : 0; }
}

// Create a new private repo. Throws err.code = 'cannot-create' if the app
// isn't allowed to (the UI then falls back to a pre-filled github.com/new).
export async function createStorageRepo(name) {
  try {
    const r = await gh('/user/repos', {
      method: 'POST',
      body: { name, private: true, auto_init: true, description: 'Squiggle storage: sessions, memory and files. Private.' },
    });
    return { owner: r.owner.login, name: r.name, branch: r.default_branch || 'main', root: '' };
  } catch (e) {
    if (e.status === 403 || e.status === 404 || e.status === 401) {
      const err = new Error('GitHub did not let Squiggle create the repo.');
      err.code = 'cannot-create';
      throw err;
    }
    if (e.status === 422) throw new Error(`A repo named "${name}" already exists. Pick it under "Use existing" or choose another name.`);
    throw e;
  }
}

export function newRepoUrl(name) {
  return `https://github.com/new?name=${encodeURIComponent(name)}&visibility=private&description=${encodeURIComponent('Squiggle storage')}`;
}

// Check a repo before using it. Returns { ok, private, empty, root, branch, problem? }.
export async function inspectRepo(owner, name) {
  const r = await gh(`/repos/${owner}/${name}`);
  const info = { owner: r.owner.login, name: r.name, branch: r.default_branch || 'main', private: r.private };
  if (!r.private) return { ...info, ok: false, problem: 'This repo is public, so your sessions and memory would be visible to everyone. Make it private on GitHub or pick another repo.' };
  if (r.permissions && !r.permissions.push) return { ...info, ok: false, problem: 'Squiggle can read this repo but not write to it. Grant the app access to it on GitHub.' };
  let rootListing = null;
  try { rootListing = await gh(`/repos/${owner}/${name}/contents/`); } catch (e) { if (e.status !== 404 && e.status !== 409) throw e; }
  if (!rootListing || !rootListing.length) return { ...info, ok: true, empty: true, root: '' };
  const names = new Set(rootListing.map(f => f.name));
  if (names.has(MARKER)) return { ...info, ok: true, root: '' };
  if (names.has('squiggle')) {
    try { await gh(`/repos/${owner}/${name}/contents/squiggle/${MARKER}`); return { ...info, ok: true, root: 'squiggle/' }; } catch {}
  }
  // A repo with other content: keep Squiggle's data in its own folder. A repo
  // holding only a README/.gitignore/LICENSE (e.g. auto_init) counts as fresh.
  const fresh = [...names].every(n => /^(readme(\.md)?|\.gitignore|license(\.md|\.txt)?)$/i.test(n));
  return { ...info, ok: true, root: fresh ? '' : 'squiggle/' };
}

export async function useStorage(info) {
  cfg = { owner: info.owner, name: info.name, branch: info.branch || 'main', root: info.root || '' };
  await kv.set('storage', cfg);
  dirty = {};
  await kv.set('storage-dirty', dirty);
  await rmrf(DIR); // fresh clone for the newly chosen repo
  await open();
  if (!await exists(`${DIR}/${cfg.root}${MARKER}`)) {
    await write(MARKER, JSON.stringify({ app: 'squiggle', v: 1, created: new Date().toISOString() }, null, 2) + '\n');
    await write('README.md', storageReadme());
  }
  await sync();
}

export async function forgetStorage() {
  cfg = null; dirty = {};
  await kv.del('storage'); await kv.del('storage-dirty');
  await rmrf(DIR);
}

// ── Clone / open ───────────────────────────────────────────────────────────

export async function open() {
  if (!cfg) throw new Error('No storage repo chosen.');
  const url = remoteUrl(cfg.owner, cfg.name);
  if (await exists(DIR + '/.git')) {
    const remotes = await git.listRemotes({ fs, dir: DIR }).catch(() => []);
    if (remotes.some(r => r.remote === 'origin' && r.url === url)) return;
    await rmrf(DIR);
  }
  try {
    await git.clone({ fs, dir: DIR, url, ref: cfg.branch, singleBranch: true, depth: 30, ...net() });
  } catch (e) {
    await rmrf(DIR);
    // Only an empty repo (nothing to clone) starts fresh locally; network or
    // auth errors must surface, or we'd sync from a blank copy.
    if (!isEmptyRepoError(e)) throw e;
    await git.init({ fs, dir: DIR, defaultBranch: cfg.branch });
    await git.addRemote({ fs, dir: DIR, remote: 'origin', url });
  }
}

// ── File access (paths relative to the storage root) ───────────────────────

const full = (rel) => `${DIR}/${cfg.root}${rel.replace(/^\/+/, '')}`;
const repoPath = (rel) => `${cfg.root}${rel.replace(/^\/+/, '')}`;

export async function read(rel) {
  try { return await pfs.readFile(full(rel), 'utf8'); } catch { return null; }
}

export async function list(relDir) {
  return walk(full(relDir).replace(/\/$/, ''));
}

async function markDirty(rel) {
  const p = repoPath(rel);
  if (p in dirty) return;
  const cur = await readOrNull(`${DIR}/${p}`);
  dirty[p] = cur == null ? null : await blobOid(cur);
  await kv.set('storage-dirty', dirty);
}

export function write(rel, content) {
  return lock(async () => {
    await markDirty(rel);
    await writeFile(full(rel), content);
    events.emit('changed', rel);
  });
}

export function remove(rel) {
  return lock(async () => {
    await markDirty(rel);
    await rmrf(full(rel));
    events.emit('changed', rel);
  });
}

async function readOrNull(path) {
  try { return await pfs.readFile(path, 'utf8'); } catch { return null; }
}

async function blobOid(text) {
  const { oid } = await git.hashBlob({ object: text });
  return oid;
}

// ── Sync ───────────────────────────────────────────────────────────────────

export function sync() {
  return lock(async () => {
    if (!cfg) return;
    syncing = true; events.emit('status', syncStatus());
    try {
      let changedPaths = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        const res = await syncOnce();
        changedPaths = changedPaths.concat(res.changed);
        if (res.pushed !== false) break;
      }
      lastSync = Date.now(); lastError = null;
      events.emit('synced', { changed: changedPaths });
    } catch (e) {
      lastError = String((e && e.message) || e);
      console.warn('Sync failed:', e);
    } finally {
      syncing = false; events.emit('status', syncStatus());
    }
  });
}

async function syncOnce() {
  const dir = DIR;
  const branch = cfg.branch;
  const before = await git.resolveRef({ fs, dir, ref: 'HEAD' }).catch(() => null);

  // 1. Capture this device's pending changes.
  const pending = { ...dirty };
  const local = {};
  for (const p of Object.keys(pending)) local[p] = await readOrNull(`${dir}/${p}`);

  // 2. Fetch and reset to the remote.
  let remoteOid = null;
  try {
    await git.fetch({ fs, dir, remote: 'origin', ref: branch, singleBranch: true, ...net() });
    remoteOid = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${branch}` });
  } catch (e) {
    if (!isEmptyRepoError(e)) throw e;
  }
  if (remoteOid && remoteOid !== before) {
    await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: remoteOid, force: true });
    await git.checkout({ fs, dir, ref: branch, force: true });
  }

  // 3. Re-apply local changes on top, merging where both sides changed.
  const tag = await deviceTag();
  for (const p of Object.keys(pending)) {
    const remote = await readOrNull(`${dir}/${p}`);
    const remoteChanged = (remote == null ? null : await blobOid(remote)) !== pending[p];
    const mine = local[p];
    if (mine == null) {
      // Deleted here. Keep the file if another device edited it meanwhile.
      if (!remoteChanged || remote == null) await rmrf(`${dir}/${p}`);
      continue;
    }
    let final = mine;
    if (remoteChanged && remote != null && remote !== mine) {
      const merge = mergeFor(p);
      if (merge) final = merge(mine, remote);
      else await writeFile(`${dir}/${p}.remote-${new Date().toISOString().slice(0, 10)}-${tag}`, remote);
    }
    await writeFile(`${dir}/${p}`, final);
  }

  // 4. Commit and push.
  const changed = await stageAll(dir);
  if (changed) {
    await git.commit({ fs, dir, message: `sync from ${tag}`, author: await author() });
  }
  const head = await git.resolveRef({ fs, dir, ref: 'HEAD' }).catch(() => null);
  let pushed = true;
  if (head && head !== remoteOid) {
    try {
      const r = await git.push({ fs, dir, remote: 'origin', ref: branch, ...net() });
      if (r && r.ok === false) pushed = false;
    } catch (e) {
      // Someone pushed between our fetch and push: loop and rebase again.
      if (/not a simple fast-forward|PushRejected|fast-forward/i.test(String(e && (e.message || e.code)))) pushed = false;
      else throw e;
    }
  }
  if (pushed) {
    // Clear only the entries we handled; writes made during the sync wait on
    // the lock, so nothing new can have slipped in.
    for (const p of Object.keys(pending)) delete dirty[p];
    await kv.set('storage-dirty', dirty);
  }

  // Which files did the remote bring in? (for reloading sessions/memory)
  let changedPaths = [];
  if (before && remoteOid && before !== remoteOid) {
    changedPaths = await diffPaths(before, remoteOid).catch(() => []);
  } else if (!before && remoteOid) {
    changedPaths = ['*'];
  }
  return { pushed, changed: changedPaths.map(p => p.startsWith(cfg.root) ? p.slice(cfg.root.length) : p) };
}

// isomorphic-git reports an empty remote as a missing branch ref.
function isEmptyRepoError(e) {
  const s = String(e && (e.code || '') + ' ' + (e.message || e));
  return /NotFoundError|Could not find|empty repository|no refs/i.test(s) && !/HttpError|401|403|5\d\d/.test(s);
}

async function diffPaths(a, b) {
  const out = [];
  await git.walk({
    fs, dir: DIR, trees: [git.TREE({ ref: a }), git.TREE({ ref: b })],
    map: async (filepath, [x, y]) => {
      if (filepath === '.') return;
      const xt = x && await x.type(), yt = y && await y.type();
      if (xt === 'tree' || yt === 'tree') return;
      const xo = x && await x.oid(), yo = y && await y.oid();
      if (xo !== yo) out.push(filepath);
    },
  });
  return out;
}

function storageReadme() {
  return `# Squiggle storage

This private repo holds your Squiggle sessions, memory and files. Squiggle
syncs it automatically from every device you sign in on.

- \`sessions/\` — conversations, one file each (threads included)
- \`memory/facts.jsonl\` — what Squiggle has learned, one fact per line
- \`home/\` — the agent's own files

It's plain text, so you can read or edit it here. Keep this repo private.
`;
}
