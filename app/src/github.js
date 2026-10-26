// GitHub sign-in (device flow through the relay) and REST helpers.
//
// The user token lives only in this module's closure and IndexedDB. Nothing
// here is exposed to the model: tools call git/REST functions that attach the
// token themselves, and model-written code runs in an opaque-origin sandbox
// that cannot read IndexedDB.
import { kv, sleep } from './util.js';

import { apiBase } from './config.js';
export { apiBase };
const REST = 'https://api.github.com';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let auth = null;          // { access_token, refresh_token, expires_at, refresh_expires_at }
let refreshing = null;
let userCache = null;
let configCache = null;

export async function relayConfig() {
  if (!configCache) {
    let r;
    try { r = await fetch(apiBase() + '/config'); }
    catch { throw relayError('Can\'t reach the relay.'); }
    if (!r.ok) throw relayError(`The relay answered with an error (${r.status}).`);
    configCache = await r.json();
  }
  return configCache;
}

function relayError(msg) {
  const e = new Error(`${msg} Check that the Squiggle relay is deployed and allows this site (ALLOWED_ORIGINS).`);
  e.code = 'relay';
  return e;
}

export function resetRelayConfig() { configCache = null; }

export async function loadAuth() {
  auth = (await kv.get('auth')) || null;
  return Boolean(auth);
}

export const isSignedIn = () => Boolean(auth);

async function relayPost(path, body) {
  const r = await fetch(apiBase() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok && !data.error) data.error = `HTTP ${r.status}`;
  return data;
}

// Step 1: get a user code to show the person.
export async function startDeviceFlow() {
  const d = await relayPost('/auth/device');
  if (d.error) throw new Error(d.error_description || d.error);
  return d; // { device_code, user_code, verification_uri, interval, expires_in }
}

// Step 2: poll until the person approves on github.com (or it expires).
export async function pollDeviceFlow(flow, signal) {
  let interval = Math.max(5, flow.interval || 5) * 1000;
  const deadline = Date.now() + (flow.expires_in || 900) * 1000;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw new Error('Sign-in cancelled.');
    await sleep(interval);
    const t = await relayPost('/auth/token', { device_code: flow.device_code });
    if (t.access_token) { await saveTokens(t); return true; }
    if (t.error === 'authorization_pending') continue;
    if (t.error === 'slow_down') { interval += 5000; continue; }
    throw new Error(t.error_description || t.error || 'Sign-in failed.');
  }
  throw new Error('The sign-in code expired. Try again.');
}

async function saveTokens(t) {
  const now = Date.now();
  auth = {
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    // Apps with token expiry off return no expires_in; treat as long-lived.
    expires_at: t.expires_in ? now + t.expires_in * 1000 : null,
    refresh_expires_at: t.refresh_token_expires_in ? now + t.refresh_token_expires_in * 1000 : null,
  };
  userCache = null;
  await kv.set('auth', auth);
}

export async function signOut() {
  auth = null; userCache = null;
  await kv.del('auth');
}

// A valid access token, refreshing it first if it's about to expire.
async function token() {
  if (!auth) throw new Error('Not signed in to GitHub.');
  if (auth.expires_at && auth.expires_at - Date.now() < REFRESH_MARGIN_MS) {
    if (!auth.refresh_token) throw new Error('GitHub session expired. Sign in again.');
    refreshing = refreshing || (async () => {
      const t = await relayPost('/auth/refresh', { refresh_token: auth.refresh_token });
      if (!t.access_token) {
        await signOut();
        throw new Error('GitHub session expired. Sign in again.');
      }
      await saveTokens(t);
    })().finally(() => { refreshing = null; });
    await refreshing;
  }
  return auth.access_token;
}

// For isomorphic-git's onAuth.
export async function gitAuth() {
  return { username: 'x-access-token', password: await token() };
}

// GitHub REST call. Returns parsed JSON (or null for 204); throws with
// GitHub's message on failure, carrying .status.
export async function gh(path, { method = 'GET', body, accept } = {}) {
  const r = await fetch(path.startsWith('http') ? path : REST + path, {
    // GitHub marks responses cacheable for 60s; a cached "not installed yet"
    // or stale repo list would otherwise stick around after things change.
    cache: 'no-store',
    method,
    headers: {
      Authorization: 'Bearer ' + await token(),
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const err = new Error((data && data.message) || `GitHub API error ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

export async function getUser() {
  if (!userCache) userCache = await gh('/user');
  return userCache;
}

export async function commitAuthor() {
  const u = await getUser();
  return { name: u.name || u.login, email: `${u.id}+${u.login}@users.noreply.github.com` };
}

// All installations of this GitHub App the user can see, and their repos.
export async function installations() {
  const d = await gh('/user/installations?per_page=100');
  return d.installations || [];
}

export async function installationRepos(installationId) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const d = await gh(`/user/installations/${installationId}/repositories?per_page=100&page=${page}`);
    all.push(...(d.repositories || []));
    if (!d.repositories || d.repositories.length < 100) break;
  }
  return all;
}

export async function accessibleRepos() {
  const out = [];
  for (const inst of await installations()) out.push(...await installationRepos(inst.id));
  return out;
}

export async function installUrl() {
  const cfg = await relayConfig();
  return cfg.appSlug ? `https://github.com/apps/${cfg.appSlug}/installations/new` : 'https://github.com/settings/installations';
}
