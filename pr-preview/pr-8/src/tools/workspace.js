// The agent's view of the filesystem, shared by the file, git and web tools.
//   /home/...          the storage repo's home/ folder (synced to every device)
//   /repos/<name>/...  git clones on this device
//   /web/<n>.txt       pages fetched in card mode (small models), in memory only
import { pfs, exists, writeFile, walk } from '../git.js';
import * as storage from '../storage.js';
import { resolveAgentPath, agentPath } from '../guard.js';

export const MAX_READ = 12000;
export const REPOS = '/repos';

// Where an agent path really lives.
export function realPath(r) {
  if (r.area === 'home') return { kind: 'home', rel: 'home/' + r.rel };
  if (r.area === 'repos' && r.repo) return { kind: 'fs', path: `${REPOS}/${r.repo}${r.rel ? '/' + r.rel : ''}` };
  return { kind: 'virtual' };
}

// Attached documents are outside content even though they live under /home.
export const isAttachmentPath = (p) => /^\/home\/attachments(\/|$)/.test(agentPath(resolveAgentPath(p)));

// Web pages fetched in card mode: never synced; the newest WEB_KEEP pages are kept.
const WEB_KEEP = 12;
const webPages = new Map();   // '1.txt' → { url, title, text }
let webSeq = 0;
export function saveWebPage(url, title, text) {
  for (const [k, v] of webPages) if (v.url === url) webPages.delete(k);
  const name = `${++webSeq}.txt`;
  webPages.set(name, { url, title, text });
  while (webPages.size > WEB_KEEP) webPages.delete(webPages.keys().next().value);
  return '/web/' + name;
}
export const isWebPath = (p) => { try { return resolveAgentPath(p).area === 'web'; } catch { return false; } };

export async function readAgentFile(p) {
  const r = resolveAgentPath(p);
  if (r.area === 'web') { const page = webPages.get(r.rel); return page ? page.text : null; }
  const rp = realPath(r);
  if (rp.kind === 'home') return storage.read(rp.rel);
  if (rp.kind === 'fs') { try { return await pfs.readFile(rp.path, 'utf8'); } catch { return null; } }
  return null;
}

// Writes a workspace file; returns an error message or null.
export async function writeAgentFile(r, text) {
  const rp = realPath(r);
  if (rp.kind === 'virtual' || (r.area === 'repos' && !r.rel)) return 'Give a file path under /home/ or /repos/<name>/.';
  if (rp.kind === 'home') { await storage.write(rp.rel, text); return null; }
  if (!await exists(`${REPOS}/${r.repo}`)) return `/repos/${r.repo} doesn't exist. Clone it first.`;
  await writeFile(rp.path, text);
  return null;
}

export async function listAgentDir(p) {
  const r = resolveAgentPath(p);
  if (r.area === 'root') return ['home/', 'repos/', ...(webPages.size ? ['web/'] : [])];
  if (r.area === 'web') return r.rel ? [] : [...webPages].map(([k, v]) => `${k}  (${v.text.length} B)`);
  if (r.area === 'repos' && !r.repo) return (await safeReaddir(REPOS)).map(n => n + '/');
  const rp = realPath(r);
  const files = rp.kind === 'home' ? await storage.list(rp.rel) : await walk(rp.path);
  return files.map(f => f.path + (f.size != null ? `  (${f.size} B)` : ''));
}

async function safeReaddir(dir) { try { return await pfs.readdir(dir); } catch { return []; } }

// The ~600 characters of `text` around the best-matching query word.
export function bestPart(text, query) {
  const words = String(query).toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const low = text.toLowerCase();
  let at = -1;
  for (const w of words) { const i = low.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const start = Math.max(0, at - 150);
  return (start ? '…' : '') + text.slice(start, start + 600);
}

// Lines start..end of `text` with line numbers, never more than `cap` characters
// (the room left in the model's context). Returns { out, end }.
export function numberedLines(lines, start, end, cap) {
  let out = '';
  for (let i = start; i <= end; i++) {
    const line = `${i}: ${lines[i - 1]}\n`;
    if (out.length + line.length > cap) { end = i - 1; break; }
    out += line;
  }
  return { out, end };
}
