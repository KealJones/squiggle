// Where the relay lives.
//
//   - Served by the Worker itself: the relay is on the same origin at /api.
//   - Served by GitHub Pages (or anywhere else): config.json, written at
//     deploy time, says where the relay is: { "relayUrl": "https://…" }.
//   - Either can be overridden per device from the setup screen or Settings.
const OVERRIDE_KEY = 'squiggle-relay';
let base = null;
let fromFile = '';

export async function loadConfig() {
  try {
    const r = await fetch(new URL('config.json', document.baseURI), { cache: 'no-store' });
    if (r.ok) fromFile = String((await r.json()).relayUrl || '').trim();
  } catch { /* no config.json: the Worker serves the app, relay is same-origin */ }
  base = computeBase();
}

function computeBase() {
  const relay = relayUrl();
  return relay ? relay.replace(/\/+$/, '') + '/api' : new URL('api', document.baseURI).href;
}

// The relay's address as configured (empty = same origin).
export function relayUrl() {
  let override = '';
  try { override = localStorage.getItem(OVERRIDE_KEY) || ''; } catch {}
  return (override || fromFile).trim();
}

export function setRelayOverride(url) {
  const v = String(url || '').trim();
  if (v && !/^https?:\/\/[^/]+/.test(v)) throw new Error('Enter the relay\'s full address, like https://squiggle-relay.you.workers.dev');
  try { v ? localStorage.setItem(OVERRIDE_KEY, v) : localStorage.removeItem(OVERRIDE_KEY); } catch {}
  base = computeBase();
}

export function apiBase() {
  if (!base) base = computeBase();
  return base;
}
