// One browser filesystem (LightningFS on IndexedDB) shared by the storage
// repo clone (/state) and the agent's repo clones (/repos/<name>), plus
// isomorphic-git wired to the relay.
import { git, http, LightningFS } from '../vendor/git.js';
import { apiBase, gitAuth, commitAuthor } from './github.js';

export { git };
export const fs = new LightningFS('squiggle-fs');
export const pfs = fs.promises;
export const corsProxy = () => apiBase() + '/git';

export const remoteUrl = (owner, name) => `https://github.com/${owner}/${name}.git`;

// Options every network git call needs.
export const net = () => ({ http, corsProxy: corsProxy(), onAuth: gitAuth, onAuthFailure: () => ({ cancel: true }) });

export async function author() { return commitAuthor(); }

export async function exists(path) {
  try { await pfs.stat(path); return true; } catch { return false; }
}

export async function isDir(path) {
  try { return (await pfs.stat(path)).isDirectory(); } catch { return false; }
}

export async function mkdirp(path) {
  const parts = path.split('/').filter(Boolean);
  let cur = '';
  for (const p of parts) {
    cur += '/' + p;
    try { await pfs.mkdir(cur); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}

export async function rmrf(path) {
  let st;
  try { st = await pfs.lstat(path); } catch { return; }
  if (st.isDirectory()) {
    for (const name of await pfs.readdir(path)) await rmrf(path + '/' + name);
    await pfs.rmdir(path);
  } else {
    await pfs.unlink(path);
  }
}

export async function writeFile(path, data) {
  await mkdirp(path.split('/').slice(0, -1).join('/'));
  await pfs.writeFile(path, data, typeof data === 'string' ? 'utf8' : undefined);
}

export async function readText(path) {
  return pfs.readFile(path, 'utf8');
}

// Recursive file list (relative paths), skipping .git.
export async function walk(dir, base = '') {
  const out = [];
  let names;
  try { names = await pfs.readdir(dir); } catch { return out; }
  for (const name of names.sort()) {
    if (name === '.git') continue;
    const full = dir + '/' + name;
    const rel = base ? base + '/' + name : name;
    const st = await pfs.stat(full);
    if (st.isDirectory()) out.push(...await walk(full, rel));
    else out.push({ path: rel, size: st.size });
  }
  return out;
}

export async function currentBranch(dir) {
  return git.currentBranch({ fs, dir, fullname: false }).catch(() => null);
}

// Stage every change in the working tree (adds, edits, deletes).
export async function stageAll(dir) {
  const matrix = await git.statusMatrix({ fs, dir });
  let changed = 0;
  for (const [filepath, head, work, stage] of matrix) {
    if (head === 1 && work === 1 && stage === 1) continue;
    changed++;
    if (work === 0) await git.remove({ fs, dir, filepath });
    else await git.add({ fs, dir, filepath });
  }
  return changed;
}

// Human-readable status lines like `M src/app.js`.
export async function statusLines(dir) {
  const matrix = await git.statusMatrix({ fs, dir });
  const lines = [];
  for (const [f, head, work, stage] of matrix) {
    if (head === 1 && work === 1 && stage === 1) continue;
    let code = '?';
    if (head === 0 && work === 2) code = stage === 0 ? '??' : 'A';
    else if (head === 1 && work === 0) code = 'D';
    else if (head === 1 && work === 2) code = 'M';
    else if (head === 1 && work === 1 && stage !== 1) code = 'M';
    lines.push(`${code} ${f}`);
  }
  return lines;
}
