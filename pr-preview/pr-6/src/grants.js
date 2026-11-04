// "Always allow" push permissions, one per repo + branch. Stored in the
// storage repo (settings/push-grants.jsonl) so they apply on every device.
// The model can't write here: agent file tools only reach home/.
import * as storage from './storage.js';
import { uid, emitter } from './util.js';
import { parseJsonl, toJsonl } from './merge.js';
import { grantKey } from './guard.js';

const FILE = 'settings/push-grants.jsonl';
export const events = emitter();
let grants = [];

export async function load() {
  grants = parseJsonl(await storage.read(FILE));
  events.emit('change');
}

export async function reload(paths) {
  if (paths.includes('*') || paths.includes(FILE)) await load();
}

export const list = () => grants.filter(g => !g.deleted);
export const keys = () => new Set(list().map(g => grantKey(g.repo, g.branch)));

export async function add(repo, branch) {
  const k = grantKey(repo, branch);
  const now = Date.now();
  const existing = grants.find(g => grantKey(g.repo, g.branch) === k);
  if (existing) Object.assign(existing, { deleted: false, mts: now });
  else grants.push({ id: uid('g'), repo, branch, ts: now, mts: now });
  await save();
}

export async function revoke(id) {
  const g = grants.find(x => x.id === id);
  if (!g) return;
  Object.assign(g, { deleted: true, mts: Date.now() });
  await save();
}

async function save() {
  events.emit('change');
  await storage.write(FILE, toJsonl(grants));
  storage.sync();
}
