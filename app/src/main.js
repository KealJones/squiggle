// Squiggle UI: setup, sessions, chat with threads, and side panels.
import { marked, DOMPurify } from '../vendor/markdown.js';
import * as github from './github.js';
import { loadConfig, relayUrl, setRelayOverride } from './config.js';
import * as storage from './storage.js';
import * as sessions from './sessions.js';
import * as memory from './memory.js';
import * as grants from './grants.js';
import * as recipes from './recipes.js';
import * as tasks from './tasks.js';
import * as engine from './engine.js';
import * as agent from './agent.js';
import { loadEmbedder, embed } from './embed.js';
import { resolveAgentPath } from './guard.js';
import { pfs, walk } from './git.js';
import { bm25 } from './search.js';
import * as attachments from './attachments.js';
import { checkFiles, fmtSize } from './attachments.js';
import * as voice from './voice.js';
import * as tts from './tts.js';

const $ = (sel, root = document) => root.querySelector(sel);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
};
const icon = (id) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = `<use href="#${id}"/>`; return s; };
const md = (text) => DOMPurify.sanitize(marked.parse(String(text || ''), { breaks: true }));
const ago = (ts) => {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
// The "working" indicator: the logo squiggle itself, rippling. Each of its
// four humps swells and settles a quarter-beat after the one before, so a
// wave seems to pass through it left to right. Same shape and size as the
// logo; still for people who prefer reduced motion.
const WAVE = (() => {
  // [start x, direction, control offsets] exactly as in #squiggle
  const humps = [[2, -1, 4, 8], [13, 1, 3, 7], [24, -1, 3, 7], [35, 1, 3, 7]];
  const frame = (t) => 'M2 8' + humps.map(([x, dir, c1, c2], i) => {
    const a = 6 * dir * (0.84 + 0.16 * Math.cos(2 * Math.PI * t - i * Math.PI / 2));
    const y = (8 + a).toFixed(2);
    return ` C${x + c1} ${y} ${x + c2} ${y} ${x + 11} 8`;
  }).join('');
  const steps = 16;
  const values = Array.from({ length: steps + 1 }, (_, k) => frame(k / steps)).join(';');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  return `<svg viewBox="0 0 48 16" aria-hidden="true"><path d="${frame(0)}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">` +
    (still ? '' : `<animate attributeName="d" dur="1.4s" repeatCount="indefinite" values="${values}"/>`) + '</path></svg>';
})();
const squiggleWait = () => h('span', { class: 'squiggle-wait', role: 'status', 'aria-label': 'Working', html: WAVE });

// ── Settings (per device) ──────────────────────────────────────────────────
const SETTINGS_KEY = 'squiggle-settings';
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch {}
  const mobile = engine.isMobile();
  Object.assign(agent.settings, { model: engine.deviceModel() }, mobile ? { contextSize: 4096, fastDecode: false, semantic: false } : {}, saved);
  // Phones only run models that fit a phone; anything else moves to the default.
  if (!engine.MODELS[agent.settings.model] || !engine.modelFitsDevice(agent.settings.model)) {
    agent.settings.model = engine.deviceModel();
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...saved, model: agent.settings.model })); } catch {}
  }
  // Phones set up before the lighter defaults existed saved the desktop ones
  // (and could crash loading the model); move them over once.
  // Phones used to default to the cloud model; Gemma 3 270M on the CPU is the
  // phone default now. Move them over once (the cloud model stays in Settings).
  if (mobile && !saved.phoneG3) {
    if (agent.settings.model === 'cloud') agent.settings.model = 'G3';
    saved = { ...saved, model: agent.settings.model, phoneG3: true };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved)); } catch {}
  }
  // Stock Gemma 3 270M can't use tools (it runs as plain chat); phones move
  // to Squiggle Small, the fine-tuned model that can. Once; G3 stays in Settings.
  if (mobile && !saved.phoneSQ) {
    if (agent.settings.model === 'G3') agent.settings.model = 'SQ';
    saved = { ...saved, model: agent.settings.model, phoneSQ: true };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved)); } catch {}
  }
  if (mobile && !saved.mobileTuned) {
    Object.assign(agent.settings, { contextSize: 4096, fastDecode: false, mobileTuned: true });
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...saved, model: agent.settings.model, contextSize: 4096, fastDecode: false, mobileTuned: true })); } catch {}
  }
  // Harness v2: smart context is the default (BM25 alone is enough on a phone;
  // embeddings stay optional). Move existing devices over once.
  if (!saved.harnessV2) {
    agent.settings.contextMode = 'smart';
    saved = { ...saved, contextMode: 'smart', harnessV2: true };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved)); } catch {}
  }
  if (saved.tools) agent.settings.tools = new Set(saved.tools);
  applyTheme();
}
function saveSettings() {
  const s = { ...agent.settings, tools: agent.settings.tools ? [...agent.settings.tools] : null };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}
function applyTheme() {
  const t = agent.settings.theme || 'auto';
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

// ── State ──────────────────────────────────────────────────────────────────
let current = null;            // session in the main view
let openThreadId = null;       // thread shown in the drawer
let busy = false;
let controller = null;
let modelState = 'unknown';    // 'missing' | 'downloading' | 'loading' | 'ready' | 'unsupported' | 'error'

// ── Boot ───────────────────────────────────────────────────────────────────
boot().catch(e => fatal(e));

async function boot() {
  loadSettings();
  await loadConfig();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  await github.loadAuth();
  await storage.loadStorageConfig();
  if (!github.isSignedIn() || !storage.storageConfig()) return showSetup();
  await startApp();
}

async function startApp() {
  // Load everything before showing the app, so nothing tapped during startup
  // gets overridden when loading finishes.
  const setup = $('#setup');
  setup.hidden = false;
  $('#setup-steps').hidden = true;
  $('#setup-body').replaceChildren(h('p', { class: 'muted' }, 'Opening your sessions… '), squiggleWait());
  await storage.open();
  await Promise.all([sessions.loadAll(), memory.load(), grants.load(), recipes.load()]);
  recipes.prune();
  wireApp();
  setSync();
  openSession(sessions.list()[0] || sessions.newSession());
  setup.hidden = true;
  $('#app').hidden = false;
  checkVoiceCrash();
  storage.sync();
  setInterval(() => { if (document.visibilityState === 'visible') storage.sync(); }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') storage.sync();
    else sessions.flush();
  });
  checkCloud().finally(() => initModel());
}

function fatal(e) {
  console.error(e);
  document.body.innerHTML = '';
  document.body.append(h('main', { class: 'setup' }, h('div', { class: 'setup-card' },
    h('h2', {}, 'Squiggle could not start'), h('p', { class: 'error' }, String(e.message || e)),
    h('button', { class: 'btn', onclick: () => location.reload() }, 'Reload'))));
}

// ── Setup wizard ───────────────────────────────────────────────────────────
async function showSetup(step) {
  $('#app').hidden = true;
  $('#setup').hidden = false;
  if (!step) step = !github.isSignedIn() ? 'signin' : 'storage';
  const order = ['signin', 'install', 'storage', 'model'];
  $('#setup-steps').hidden = false;
  $('#setup-steps').querySelectorAll('li').forEach((li, i) => {
    li.className = i < order.indexOf(step) ? 'done' : i === order.indexOf(step) ? 'now' : '';
  });
  const body = $('#setup-body');
  body.replaceChildren();
  try {
    if (step === 'signin') await setupSignIn(body);
    else if (step === 'install') await setupInstall(body);
    else if (step === 'storage') await setupStorage(body);
    else if (step === 'model') await setupModel(body);
  } catch (e) {
    body.append(h('p', { class: 'error' }, String(e.message || e)), h('button', { class: 'btn', onclick: () => showSetup(step) }, 'Try again'));
  }
}

async function setupSignIn(body) {
  let cfg;
  try { cfg = await github.relayConfig(); }
  catch (e) { if (e.code === 'relay') return setupRelay(body, e.message); throw e; }
  body.append(
    h('h2', {}, 'Your agent, on your devices'),
    h('p', {}, 'Squiggle runs an AI model on this device. Conversations, memory and files are saved to a private GitHub repo of yours, so you can pick up on any device.'),
  );
  if (!cfg.clientConfigured) {
    body.append(h('p', { class: 'error' }, 'The relay has no GitHub App configured yet. Set GITHUB_CLIENT_ID in wrangler.toml and redeploy (see the README).'));
    return;
  }
  const go = h('button', { class: 'btn primary' }, 'Sign in with GitHub');
  body.append(go);
  go.onclick = async () => {
    go.disabled = true;
    const flow = await github.startDeviceFlow();
    body.replaceChildren(
      h('h2', {}, 'Enter this code on GitHub'),
      h('div', { class: 'code-box' }, flow.user_code),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => { navigator.clipboard?.writeText(flow.user_code).catch(() => {}); window.open(flow.verification_uri, '_blank', 'noopener'); } }, 'Copy code and open GitHub'),
      ),
      h('p', { class: 'muted', style: 'margin-top:14px' }, 'Waiting for you to approve… this page continues on its own.'),
    );
    try {
      await github.pollDeviceFlow(flow);
      const insts = await github.installations();
      showSetup(insts.length ? 'storage' : 'install');
    } catch (e) {
      body.append(h('p', { class: 'error' }, e.message), h('button', { class: 'btn', onclick: () => showSetup('signin') }, 'Start over'));
    }
  };
}

// Shown when the relay can't be reached (e.g. a GitHub Pages copy whose
// config.json is missing or points somewhere wrong).
function setupRelay(body, problem) {
  const input = h('input', { type: 'text', value: relayUrl(), placeholder: 'https://squiggle-relay.you.workers.dev', spellcheck: 'false', 'aria-label': 'Relay address' });
  const err = h('p', { class: 'error' }, problem);
  const save = h('button', { class: 'btn primary' }, 'Connect');
  save.onclick = async () => {
    try { setRelayOverride(input.value); github.resetRelayConfig(); showSetup('signin'); }
    catch (e) { err.textContent = e.message; }
  };
  body.append(
    h('h2', {}, 'Connect to your relay'),
    h('p', {}, 'Squiggle needs its relay (the small Cloudflare Worker from the README) to sign in to GitHub and sync. Enter its address.'),
    h('div', { class: 'field' }, h('label', {}, 'Relay address'), input),
    h('div', { class: 'row' }, save),
    err,
  );
}

async function setupInstall(body) {
  const url = await github.installUrl();
  body.append(
    h('h2', {}, 'Give Squiggle access to your repos'),
    h('p', {}, 'Install the Squiggle app on your GitHub account and choose which repos it can use. Include any repo you want the agent to work on. You can change this any time.'),
    h('div', { class: 'row' },
      h('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener' }, 'Install on GitHub'),
      h('button', { class: 'btn', onclick: async () => { if ((await github.installations()).length) showSetup('storage'); else msg.textContent = 'Squiggle isn\'t installed yet. Finish the install on GitHub, then try again.'; } }, 'I installed it'),
    ),
  );
  const msg = h('p', { class: 'error' });
  body.append(msg);
  const check = async () => { if ((await github.installations()).length) { removeEventListener('focus', check); showSetup('storage'); } };
  addEventListener('focus', check);
}

async function setupStorage(body) {
  if ((await github.installations()).length === 0) return showSetup('install');
  body.append(h('h2', {}, 'Where should Squiggle keep your stuff?'), h('p', { class: 'muted' }, 'Looking for an existing Squiggle repo…'));
  const found = await storage.findExistingStorage();
  body.replaceChildren(h('h2', {}, 'Where should Squiggle keep your stuff?'));
  if (found) {
    body.append(
      h('p', {}, `Found your Squiggle storage in ${found.owner}/${found.name}.`),
      h('button', { class: 'btn primary', onclick: () => chooseStorage(found, body) }, 'Continue with this repo'),
      h('p', { class: 'muted', style: 'margin-top:16px' }, 'Or pick a different one:'),
    );
  } else {
    body.append(h('p', {}, 'Squiggle saves sessions, memory and files to a private GitHub repo you own.'));
  }
  body.append(
    h('button', { class: 'choice', onclick: () => storageCreate(body) }, h('strong', {}, 'Create a new private repo'), h('span', {}, 'Recommended. Named squiggle-state unless you change it.')),
    h('button', { class: 'choice', onclick: () => storagePick(body) }, h('strong', {}, 'Use an existing repo'), h('span', {}, 'Any private repo you gave Squiggle access to. Its other files stay untouched.')),
  );
}

function storageCreate(body) {
  const input = h('input', { type: 'text', value: 'squiggle-state', 'aria-label': 'Repo name', spellcheck: 'false' });
  const err = h('p', { class: 'error' });
  const create = h('button', { class: 'btn primary' }, 'Create private repo');
  body.replaceChildren(
    h('h2', {}, 'Create your storage repo'),
    h('div', { class: 'field' }, h('label', {}, 'Repo name'), input, h('span', { class: 'hint' }, 'It will be private. Only you and Squiggle can see it.')),
    h('div', { class: 'row' }, create, h('button', { class: 'btn ghost', onclick: () => showSetup('storage') }, 'Back')),
    err,
  );
  create.onclick = async () => {
    const name = input.value.trim().replace(/[^A-Za-z0-9_.-]/g, '-');
    if (!name) return;
    create.disabled = true; err.textContent = '';
    try {
      const info = await storage.createStorageRepo(name);
      await chooseStorage(info, body);
    } catch (e) {
      create.disabled = false;
      if (e.code !== 'cannot-create') { err.textContent = e.message; return; }
      // Fallback: the person creates it on GitHub, then we pick it up.
      const app = await github.installUrl();
      body.replaceChildren(
        h('h2', {}, 'Create it on GitHub'),
        h('p', {}, 'GitHub didn\'t let Squiggle create the repo directly. Two quick steps:'),
        h('p', {}, '1. Create the private repo (the form is pre-filled):'),
        h('a', { class: 'btn primary', href: storage.newRepoUrl(name), target: '_blank', rel: 'noopener' }, 'Create on GitHub'),
        h('p', { style: 'margin-top:16px' }, '2. Give Squiggle access to it:'),
        h('a', { class: 'btn', href: app, target: '_blank', rel: 'noopener' }, 'Update app access'),
        h('div', { class: 'row', style: 'margin-top:18px' }, h('button', { class: 'btn primary', onclick: () => storagePick(body, name) }, 'Done, continue')),
      );
    }
  };
}

async function storagePick(body, prefer) {
  body.replaceChildren(h('h2', {}, 'Pick a repo'), h('p', { class: 'muted' }, 'Loading your repos…'));
  const repos = await github.accessibleRepos();
  const list = h('div', { class: 'repo-list' });
  repos.sort((a, b) => (b.name === prefer) - (a.name === prefer) || (b.private - a.private) || a.full_name.localeCompare(b.full_name));
  for (const r of repos) {
    list.append(h('button', { onclick: () => checkAndChoose(r) }, h('span', {}, r.full_name), r.private ? h('span', { class: 'muted' }, 'private') : h('span', { class: 'pub' }, 'public')));
  }
  const err = h('div');
  const app = await github.installUrl();
  body.replaceChildren(
    h('h2', {}, 'Pick a repo'),
    repos.length ? list : h('p', {}, 'Squiggle can\'t see any repos yet.'),
    h('p', { class: 'muted' }, 'Not listed? ', h('a', { href: app, target: '_blank', rel: 'noopener' }, 'Give Squiggle access to it'), ', then ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); storagePick(body, prefer); } }, 'refresh'), '.'),
    err,
    h('button', { class: 'btn ghost', onclick: () => showSetup('storage') }, 'Back'),
  );
  async function checkAndChoose(r) {
    err.replaceChildren(h('p', { class: 'muted' }, 'Checking…'));
    const info = await storage.inspectRepo(r.owner.login, r.name);
    if (!info.ok) { err.replaceChildren(h('p', { class: 'error' }, info.problem)); return; }
    const note = info.root ? `This repo already has other files, so Squiggle will keep everything in a "${info.root.replace(/\/$/, '')}" folder.` : null;
    err.replaceChildren(
      note ? h('p', {}, note) : '',
      h('button', { class: 'btn primary', onclick: () => chooseStorage(info, body) }, `Use ${info.owner}/${info.name}`),
    );
  }
}

async function chooseStorage(info, body) {
  body.replaceChildren(h('h2', {}, 'Setting up storage'), h('p', { class: 'muted' }, `Connecting to ${info.owner}/${info.name}…`), squiggleWait());
  await storage.useStorage(info);
  showSetup('model');
}

async function setupModel(body) {
  await checkCloud();
  const gpu = await engine.webgpuStatus();
  const done = h('button', { class: 'btn primary', onclick: async () => { await startApp(); if (gpu.ok) ensureModel(); } }, gpu.ok ? 'Download and start' : 'Continue');
  if (engine.isMobile()) {
    // Gemma 4 doesn't fit a phone browser tab; phones run Gemma 3 270M on the
    // CPU (no WebGPU needed), or the cloud model when the relay offers it.
    if (!engine.modelFitsDevice(agent.settings.model) || (agent.settings.model === 'cloud' && !cloudOffered)) agent.settings.model = engine.deviceModel();
    saveSettings();
    const picker = modelPicker(agent.settings.model, (id) => { agent.settings.model = id; saveSettings(); });
    body.append(h('h2', {}, 'On your phone'),
      h('p', {}, 'Phones run Gemma 3 270M right here: a 242 MB download, then it works offline. It\'s small, so it\'s quick but much less capable than Gemma 4, especially with tools.' +
        (cloudOffered ? ' For harder tasks, pick the cloud model (Gemma 4 26B on your relay, free daily limit).' : '') + ' Your computer keeps running Gemma 4 locally.'),
      picker,
      h('button', { class: 'btn primary', onclick: async () => { await startApp(); if (agent.settings.model !== 'cloud') ensureModel(); } }, 'Start'));
    return;
  }
  if (!gpu.ok && cloudOffered) {
    agent.settings.model = 'cloud'; saveSettings();
    body.append(h('h2', {}, 'This device can\'t run a model itself'), h('p', {}, gpu.reason),
      h('p', {}, 'Squiggle will use the cloud model on your Cloudflare relay instead (free daily limit, then it pauses until midnight UTC).'),
      h('button', { class: 'btn primary', onclick: async () => { await startApp(); } }, 'Start'));
    return;
  }
  if (!gpu.ok) {
    // No WebGPU: the small CPU model still runs.
    agent.settings.model = 'SQ'; saveSettings();
    body.append(h('h2', {}, 'No WebGPU on this browser'), h('p', {}, gpu.reason),
      h('p', {}, 'Squiggle will run Squiggle Small on the CPU instead: a 219 MB download, much less capable than Gemma 4.'),
      h('button', { class: 'btn primary', onclick: async () => { await startApp(); ensureModel(); } }, 'Download and start'));
    return;
  }
  if (!engine.modelFitsDevice(agent.settings.model)) agent.settings.model = engine.deviceModel();
  saveSettings();
  const where = engine.isMobile() ? 'phone' : 'computer';
  const picker = modelPicker(agent.settings.model, (id) => { agent.settings.model = id; saveSettings(); });
  body.append(
    h('h2', {}, 'Pick a model'),
    h('p', {}, `Squiggle runs the model right here on your ${where}. It's a one-time download, then it works offline. You can switch later in Settings.`),
    picker,
    h('p', { class: 'muted' }, 'Wi-Fi is best. If the download gets interrupted, it picks up where it stopped.'),
    h('div', { class: 'row' }, done),
  );
}

// Models this device can run, as a list of choices with size and a note.
function modelPicker(value, onPick) {
  const ids = Object.keys(engine.MODELS).filter(id => engine.modelFitsDevice(id) && (!engine.MODELS[id].needsRelay || cloudOffered));
  const list = h('div', { class: 'model-list', role: 'radiogroup', 'aria-label': 'Model' });
  const render = (v) => list.replaceChildren(...ids.map((id) => {
    const m = engine.MODELS[id];
    return h('button', { class: 'model-option', role: 'radio', 'aria-checked': String(id === v), 'data-model': id, onclick: () => { render(id); onPick(id); } },
      h('span', { class: 'model-name' }, m.label, id === engine.deviceModel() ? h('span', { class: 'tag' }, 'recommended') : ''),
      h('span', { class: 'model-size' }, m.size),
      h('span', { class: 'model-note' }, m.note));
  }));
  render(value);
  return list;
}

// ── App wiring ─────────────────────────────────────────────────────────────
let wired = false;
function wireApp() {
  if (wired) return; wired = true;
  $('#new-chat').onclick = () => { openSession(sessions.newSession()); closeSidebar(); $('#input').focus(); };
  $('#open-sidebar').onclick = () => $('#sidebar').classList.add('open');
  document.addEventListener('click', (e) => {
    const sb = $('#sidebar');
    if (sb.classList.contains('open') && !sb.contains(e.target) && !$('#open-sidebar').contains(e.target)) closeSidebar();
  });
  $('#close-drawer').onclick = closeDrawer;
  document.querySelectorAll('.side-nav [data-panel]').forEach(b => b.onclick = () => { closeSidebar(); openPanel(b.dataset.panel); });
  $('#session-search').addEventListener('input', () => renderSessions());
  setupComposer($('#composer'), $('#input'), (text, files) => send(text, null, files));
  $('#call').onclick = () => (call ? endCall() : startCall());
  sessions.events.on('list', () => renderSessions());
  sessions.events.on('session', (id) => {
    if (busy || !current || id !== current.id) return;
    renderChat();
    // Don't rebuild the thread panel while the person is typing in it.
    const draft = document.querySelector('#drawer textarea');
    if (openThreadId && (!draft || !draft.value)) renderThreadPanel();
  });
  storage.events.on('status', setSync);
  storage.events.on('synced', async ({ changed }) => {
    if (!changed.length) return;
    await sessions.reload(changed);
    await memory.reload(changed);
    await grants.reload(changed);
    await recipes.reload(changed);
    if (current && current.deleted) openSession(sessions.list()[0] || sessions.newSession());
  });
  const memoryChanged = () => { if (drawerPanel === 'memory' && !document.querySelector('#drawer .recipe-form')) renderMemoryPanel(); };
  memory.events.on('change', memoryChanged);
  recipes.events.on('change', memoryChanged);
  sessions.events.on('session', (id) => { if (drawerPanel === 'notes' && current && id === current.id) renderNotesPanel(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); closeSidebar(); } });
}

const closeSidebar = () => $('#sidebar').classList.remove('open');

function setSync() {
  const st = storage.syncStatus();
  const line = $('#sync-line');
  if (!line) return;
  const cfg = storage.storageConfig();
  const dot = h('span', { class: 'sync-dot' + (st.syncing ? ' busy' : st.lastError ? ' err' : '') });
  const text = st.syncing ? 'Syncing…' : st.lastError ? `Sync failed: ${st.lastError}` : st.lastSync ? `Synced ${ago(st.lastSync)}` : 'Not synced yet';
  line.replaceChildren(dot, h('span', { title: cfg ? `${cfg.owner}/${cfg.name}` : '' }, text));
}
setInterval(setSync, 30000);

// ── Sessions sidebar (with search) ─────────────────────────────────────────
function renderSessions() {
  const ul = $('#session-list');
  const q = $('#session-search').value.trim();
  ul.replaceChildren();
  if (q) return renderSearch(ul, q);
  for (const s of sessions.list()) {
    ul.append(h('li', {}, h('button', { 'aria-current': String(current && s.id === current.id), onclick: () => { openSession(s); closeSidebar(); } },
      h('span', { class: 't' }, s.title), h('span', { class: 'when' }, ago(s.updated)))));
  }
  if (!ul.children.length) ul.append(h('li', { class: 'muted', style: 'padding: 8px 10px' }, 'No chats yet.'));
}

function renderSearch(ul, q) {
  const docs = [];
  for (const s of sessions.list()) {
    if (s.title) docs.push({ id: `${s.id}|`, text: s.title, s });
    for (const m of s.messages) if (m.content) docs.push({ id: `${s.id}|${m.id}`, text: m.content, s, m });
  }
  const scores = bm25(docs)(q);
  const hits = docs.filter(d => scores.has(d.id)).sort((a, b) => scores.get(b.id) - scores.get(a.id)).slice(0, 30);
  if (!hits.length) { ul.append(h('li', { class: 'muted', style: 'padding: 8px 10px' }, 'No matches.')); return; }
  for (const d of hits) {
    const snip = d.m ? snippet(d.m.content, q) : 'Title match';
    ul.append(h('li', {}, h('button', { onclick: () => { openSession(d.s, d.m); closeSidebar(); } },
      h('span', { class: 't' }, d.s.title), h('span', { class: 'when', style: 'display:block' }, (d.m && d.m.thread ? 'In a thread: ' : '') + snip))));
  }
}

function snippet(text, q) {
  const t = String(text).replace(/\s+/g, ' ');
  const w = q.toLowerCase().split(/\s+/).find(x => t.toLowerCase().includes(x));
  const i = w ? t.toLowerCase().indexOf(w) : 0;
  const start = Math.max(0, i - 30);
  return (start ? '…' : '') + t.slice(start, start + 90) + (t.length > start + 90 ? '…' : '');
}

// ── Chat ───────────────────────────────────────────────────────────────────
function openSession(s, focusMessage) {
  current = s;
  closeDrawer();
  renderSessions();
  renderChat();
  if (focusMessage) {
    if (focusMessage.thread) openThread(focusMessage.thread, focusMessage.id);
    else requestAnimationFrame(() => {
      const el = document.querySelector(`[data-mid="${focusMessage.id}"]`);
      if (el) { el.scrollIntoView({ block: 'center' }); el.animate([{ background: 'var(--marker)' }, { background: 'transparent' }], { duration: 1400 }); }
    });
  }
}

function renderChat() {
  $('#chat-title').textContent = current.title;
  const inner = $('#messages-inner');
  inner.replaceChildren();
  const line = sessions.lineMessages(current, null);
  if (!line.length) { inner.append(emptyState()); return; }
  for (const m of line) inner.append(messageEl(m, { inThread: false }));
  scrollDown($('#messages'));
}

function emptyState() {
  const ideas = ['What do you remember about me?', 'Clone one of my repos and summarize it', 'Read https://example.com and tell me what it says'];
  return h('div', { class: 'empty' },
    icon('squiggle'),
    h('h2', {}, 'What are we working on?'),
    h('p', {}, 'Squiggle runs on this device and picks up where you left off on any other.'),
    h('div', { class: 'suggestions' }, ideas.map(t => h('button', { onclick: () => { $('#input').value = t; $('#input').focus(); } }, t))));
}

function messageEl(m, { inThread, streaming, session }) {
  const el = h('div', { class: `msg ${m.role}`, 'data-mid': m.id || '' });
  const col = h('div', { style: m.role === 'user' ? 'display:flex;flex-direction:column;align-items:flex-end;width:100%' : '' });
  if (m.role === 'assistant') {
    const owner = session || current;
    const task = m.task && owner && owner.tasks && owner.tasks[m.task];
    if (task) col.append(planEl(task, { live: false }));
    if (m.tools && m.tools.length) col.append(toolTrail(m.tools));
    // Saved thinking stays viewable (collapsed); it's never sent back to the model.
    if (m.thinking) col.append(h('details', { class: 'thinking' }, h('summary', {}, 'Thinking'), h('div', {}, m.thinking)));
    col.append(h('div', { class: 'body', html: md(agent.scrubFakeToolNotes(m.content)) }));
  } else {
    col.append(h('div', { class: 'body' }, m.content));
    if (m.attachments && m.attachments.length) {
      col.append(h('div', { class: 'attach-chips sent' }, m.attachments.map(a => h('span', { class: 'chip', title: a.path ? a.path : (a.error || 'not saved') },
        icon('i-attach'), h('span', { class: 'chip-name' }, a.name), h('span', { class: 'chip-size' }, fmtSize(a.size))))));
    }
  }
  if (!streaming && m.id) {
    const actions = h('div', { class: 'msg-actions' + (m.pinned ? ' pinned' : '') });
    if (!inThread) actions.append(iconButton('i-thread', 'Reply in thread', () => openThread(null, null, m)));
    actions.append(iconButton('i-pin', m.pinned ? 'Unpin' : 'Pin (always keep in context)', () => {
      sessions.updateMessage(current, m, { pinned: !m.pinned });
      rerender();
    }, m.pinned));
    actions.append(iconButton('i-copy', 'Copy', () => navigator.clipboard?.writeText(m.content || '')));
    if (m.role === 'assistant' && m.content && voice.support(window).synthesis) {
      const on = Boolean(reader && reader.id === m.id);
      const b = iconButton(on ? 'i-stop' : 'i-speaker', on ? 'Stop reading' : 'Read aloud', () => toggleReadAloud(m), on);
      b.classList.add('read-aloud');
      b.dataset.msg = m.id;
      actions.append(b);
    }
    if (m.role === 'assistant' && m.context) actions.append(iconButton('i-eye', 'What the model saw', () => openPanel('context', m)));
    col.append(actions);
    if (!inThread) {
      const t = sessions.threadOf(current, m.id);
      if (t) {
        const n = current.messages.filter(x => x.thread === t.id).length;
        col.append(h('button', { class: 'thread-link', onclick: () => openThread(t.id) },
          icon('squiggle'), h('span', { class: 'count' }, `${n} ${n === 1 ? 'reply' : 'replies'}`),
          t.summary ? h('span', { class: 'sum' }, t.summary) : ''));
      }
    }
  }
  el.append(col);
  return el;
}

// The plan as a checklist: live above the reply while it runs, then a
// compact "N/M steps" chip that expands to the same list.
function planEl(task, { live }) {
  const { done, total } = tasks.progress(task);
  const now = tasks.current(task);
  const state = task.status === 'done' ? 'done' : task.waiting ? 'waiting for your answer' : task.status === 'stopped' ? 'paused' : 'working';
  const list = h('ol', { class: 'plan-steps' }, task.steps.map(s => h('li', { class: `step ${s.status}${s === now && task.status === 'active' ? ' now' : ''}` },
    h('span', { class: 'mark', 'aria-hidden': 'true' }, s.status === 'done' ? '✓' : s.status === 'blocked' ? '?' : s === now && live && task.status === 'active' && !task.waiting ? '' : '○'),
    s === now && live && task.status === 'active' && !task.waiting && s.status !== 'blocked' ? squiggleWait() : '',
    h('span', { class: 'text' }, s.text,
      s.result ? h('span', { class: 'result' }, s.result) : '',
      s.need ? h('span', { class: 'result' }, 'Needs: ' + s.need) : ''))));
  const head = [h('strong', {}, task.goal), ' ', h('span', { class: 'muted' }, `${done}/${total} steps · ${state}`)];
  if (live) return h('div', { class: 'plan live', role: 'status', 'aria-live': 'polite' }, h('div', { class: 'plan-head' }, ...head), list);
  return h('details', { class: 'plan chip' }, h('summary', {}, `${done}/${total} steps`, h('span', { class: 'muted' }, ` · ${task.goal}`)), list);
}

// "Keep going?" after every 60 tool calls (never "say continue").
function checkInCard(task, calls, decide) {
  const card = h('div', { class: 'approval checkin', role: 'group', 'aria-label': 'Keep going?' },
    h('p', { class: 'q' }, `Squiggle has made ${calls} tool calls on this. Keep going?`),
    task ? planEl(task, { live: false }) : '');
  card.append(h('div', { class: 'row' },
    h('button', { class: 'btn primary', onclick: () => card.settle(true) }, 'Keep going'),
    h('button', { class: 'btn ghost', onclick: () => card.settle(false) }, 'Stop here')));
  let settled = false;
  card.settle = (go) => {
    if (settled) return;
    settled = true;
    decide(go);
    card.replaceChildren(h('p', { class: 'muted' }, go ? 'Kept going.' : 'Paused. Say "continue" to pick it up again.'));
    card.classList.add('settled');
  };
  return card;
}

function toolTrail(tools) {
  return h('div', { class: 'tool-trail' }, tools.map(t => h('div', { class: 'tool' + (t.ok === false ? ' fail' : '') },
    t.running ? squiggleWait() : h('span', { 'aria-hidden': 'true' }, t.ok === false ? '✕' : '✓'), h('span', {}, t.label || t.name))));
}

function iconButton(id, label, onclick, pressed) {
  return h('button', { class: 'icon-btn', 'aria-label': label, title: label, onclick, 'aria-pressed': pressed ? 'true' : null }, icon(id));
}

function rerender() {
  renderChat();
  if (openThreadId) renderThreadPanel();
}

const scrollDown = (el) => requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });

function setupComposer(form, input, onSend) {
  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + 'px'; };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(hover: none)').matches) { e.preventDefault(); form.requestSubmit(); }
  });

  // Attachments: chosen with the paperclip, dropped on the composer or pasted.
  let files = [];
  const inner = form.querySelector('.composer-inner');
  const chips = h('div', { class: 'attach-chips', hidden: true });
  const notice = h('div', { class: 'attach-notice', role: 'status', hidden: true });
  const picker = h('input', { type: 'file', multiple: true, hidden: true, 'aria-hidden': 'true', tabindex: '-1', class: 'attach-input' });
  const renderChips = () => {
    chips.hidden = !files.length;
    chips.replaceChildren(...files.map(f => h('span', { class: 'chip' }, h('span', { class: 'chip-name' }, f.name), h('span', { class: 'chip-size' }, fmtSize(f.size)),
      h('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove ${f.name}`, onclick: () => { files = files.filter(x => x !== f); renderChips(); } }, icon('i-close')))));
  };
  const add = (list) => {
    const { ok, problems } = checkFiles([...list], files.length);
    files = files.concat(ok);
    renderChips();
    notice.hidden = !problems.length;
    notice.textContent = problems.join(' ');
  };
  picker.addEventListener('change', () => { add(picker.files); picker.value = ''; });
  inner.insertBefore(h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Attach files', title: 'Attach files', onclick: () => picker.click() }, icon('i-attach')), input);
  form.insertBefore(chips, inner);
  form.insertBefore(notice, inner);
  form.append(picker);
  input.addEventListener('paste', (e) => {
    const pasted = e.clipboardData && e.clipboardData.files;
    if (pasted && pasted.length) { e.preventDefault(); add(pasted); }
  });
  form.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); form.classList.add('dragging'); } });
  form.addEventListener('dragleave', (e) => { if (!form.contains(e.relatedTarget)) form.classList.remove('dragging'); });
  form.addEventListener('drop', (e) => {
    form.classList.remove('dragging');
    if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); add(e.dataTransfer.files); }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) { controller && controller.abort(); return; }
    const text = input.value.trim();
    if (!text && !files.length) return;
    const sending = files;
    input.value = ''; grow();
    files = []; renderChips(); notice.hidden = true;
    onSend(text, sending);
  });
}

function setBusy(on) {
  busy = on;
  for (const btn of document.querySelectorAll('.composer button[type="submit"]')) {
    btn.replaceChildren(icon(on ? 'i-stop' : 'i-send'));
    btn.setAttribute('aria-label', on ? 'Stop' : 'Send');
  }
}

async function send(text, threadId, files = []) {
  if (busy) return;
  if (modelState !== 'ready') {
    if (loadCrashMarker()) return; // the crash banner is showing; let the person choose
    const ok = await ensureModel();
    if (!ok) return;
  }
  const session = current;
  const container = threadId ? $('#thread-messages') : $('#messages-inner');
  const scroller = threadId ? $('#thread-scroll') : $('#messages');
  if (!threadId && !session.messages.some(m => !m.thread)) container.replaceChildren();
  let live = null, body = null, trail = null, think = null, plan = null;
  const vc = !threadId && call ? call.ctl : null; // a voice call speaks this reply as it streams
  const liveTools = [];
  setBusy(true);
  controller = new AbortController();
  try {
    const attachments = await readFiles(files, session);
    await agent.runTurn({
      session, threadId, text, attachments, signal: controller.signal,
      ui: {
        onUser: (m) => { container.append(messageEl(m, { inThread: Boolean(threadId) })); scrollDown(scroller); renderSessions(); },
        onStart: () => {
          live = h('div', { class: 'msg assistant' });
          trail = h('div');
          think = h('details', { class: 'thinking', hidden: true }, h('summary', {}, 'Thinking'), h('div'));
          plan = h('div', { hidden: true });
          body = h('div', { class: 'body' }, squiggleWait());
          live.append(plan, trail, think, body);
          container.append(live);
          scrollDown(scroller);
        },
        onThinking: (t) => { think.hidden = false; think.lastChild.textContent = t; },
        onText: (t) => { const clean = agent.scrubFakeToolNotes(t); body.innerHTML = md(clean); scrollDown(scroller); if (vc) vc.feed(clean); },
        onTool: (t) => {
          if (t.name === 'note' && !t.running && drawerPanel === 'notes') renderNotesPanel();
          const existing = liveTools.find(x => x.running && x.name === t.name);
          if (existing) Object.assign(existing, t); else liveTools.push({ ...t });
          trail.replaceChildren(toolTrail(liveTools));
          scrollDown(scroller);
        },
        onPlan: (task) => { plan.hidden = false; plan.replaceChildren(planEl(task, { live: true })); scrollDown(scroller); },
        onCheckIn: ({ task, calls }, decide) => {
          const card = checkInCard(task, calls, decide);
          controller.signal.addEventListener('abort', () => card.settle(false), { once: true });
          live.insertBefore(card, body);
          scrollDown(scroller);
          card.querySelector('button').focus({ preventScroll: true });
        },
        onApproval: (req, decide) => {
          const card = approvalCard(req, (d) => decide(d));
          controller.signal.addEventListener('abort', () => card.settle('deny', 'Stopped'), { once: true });
          live.insertBefore(card, body);
          scrollDown(scroller);
          card.querySelector('button').focus({ preventScroll: true });
        },
        onDone: (m) => { if (vc) vc.finish(agent.scrubFakeToolNotes(m.content)); live.replaceWith(messageEl(m, { inThread: Boolean(threadId), session })); if (!threadId) $('#chat-title').textContent = session.title; },
      },
    });
  } finally {
    setBusy(false);
    controller = null;
    if (threadId) renderChat(); // refresh reply count on the parent
  }
}

// Reads the chosen files (PDF text extraction can take a moment).
async function readFiles(files, session) {
  const out = [];
  const taken = new Set(session.messages.flatMap(m => (m.attachments || []).map(a => String(a.path || a.name).split('/').pop().toLowerCase())));
  for (const f of files) out.push(await attachments.readAttachment(f, taken, session.id));
  return out;
}

// ── Read aloud ─────────────────────────────────────────────────────────────
// The speaker button under a reply reads it with the voice calls use: the
// natural voice when it's chosen (loaded on the tap, kept a minute for the next
// one, then freed), otherwise the system voice. One reading at a time; a call
// stops it.
let reader = null;          // { id, ctl }
let readerVoice = null;     // { nv, timer } natural voice kept between readings
const READER_KEEP_MS = 60000;

function setReadButtons() {
  for (const b of document.querySelectorAll('.read-aloud')) {
    const on = Boolean(reader && reader.id === b.dataset.msg);
    b.replaceChildren(icon(on ? 'i-stop' : 'i-speaker'));
    b.setAttribute('aria-label', on ? 'Stop reading' : 'Read aloud');
    b.title = on ? 'Stop reading' : 'Read aloud';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

function stopReading() {
  if (!reader) return;
  const r = reader;
  reader = null;
  r.ctl && r.ctl.stop();
  setReadButtons();
}

function freeReaderVoice() {
  if (!readerVoice) return;
  clearTimeout(readerVoice.timer);
  freeNaturalVoice(readerVoice.nv);
  readerVoice = null;
}

function toggleReadAloud(m) {
  const wasThis = reader && reader.id === m.id;
  stopReading();
  if (wasThis || call) return;
  const system = voice.systemSpeaker({ synth: window.speechSynthesis, Utterance: window.SpeechSynthesisUtterance, lang: navigator.language || 'en-US', getSettings: () => agent.settings });
  const mine = { id: m.id, ctl: null };
  reader = mine;
  setReadButtons();
  const start = (speaker, fallback) => {
    if (reader !== mine) return;
    mine.ctl = voice.readAloud({
      speaker, text: agent.scrubFakeToolNotes(m.content),
      onEnd: (err, stopped) => {
        if (err && fallback && reader === mine) { toast(`The natural voice stopped (${err.message}); reading with the system voice.`); start(fallback, null); return; }
        if (reader === mine) { reader = null; setReadButtons(); }
        if (readerVoice) { clearTimeout(readerVoice.timer); readerVoice.timer = setTimeout(freeReaderVoice, READER_KEEP_MS); }
      },
    });
  };
  system.prime();   // inside the tap: iOS only starts speech from a gesture
  if (voiceEngine() !== 'natural') { start(system, null); return; }
  if (readerVoice && readerVoice.nv.model !== voiceModel()) freeReaderVoice();
  if (!readerVoice) readerVoice = { nv: createNaturalVoice(), timer: null };   // unlocks audio in this tap
  clearTimeout(readerVoice.timer);
  const nv = readerVoice.nv;
  nv.speaker.prime();
  const slow = setTimeout(() => { if (reader === mine && !mine.ctl) toast(`Loading the natural voice (${tts.TTS_MODELS[nv.model].label}, ${tts.TTS_MODELS[nv.model].size} the first time)…`, 8000); }, 800);
  nv.loaded.then(() => clearTimeout(slow), () => clearTimeout(slow));
  nv.loaded.then(() => start(nv.speaker, system), (e) => {
    if (readerVoice && readerVoice.nv === nv) freeReaderVoice();
    if (reader === mine) toast(`Couldn't load the natural voice (${e.message}); reading with the system voice.`);
    start(system, null);
  });
}

// ── Voice call ─────────────────────────────────────────────────────────────
// Hands-free: speech in through the Web Speech API, replies spoken sentence by
// sentence. Utterances go through send() like typed messages. voice.js owns the
// state machine; this is the bar that shows it.
let call = null;
const CALL_LABELS = { listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', idle: 'Call ended' };

function startCall() {
  const sup = voice.support(window);
  if (!sup.ok) { callBar(null, sup.recognition ? 'Voice calls need speech synthesis, which this browser doesn\'t have.' : voice.UNSUPPORTED_MESSAGE); return; }
  if (!current) return;
  // Phones ask once: the natural voice needs memory next to the chat model.
  if (voiceEngine() === 'ask') { askVoiceBar(); return; }
  stopReading();
  freeReaderVoice();
  const bar = callBar();
  const system = voice.systemSpeaker({ synth: window.speechSynthesis, Utterance: window.SpeechSynthesisUtterance, lang: navigator.language || 'en-US', getSettings: () => agent.settings });
  // The natural voice loads now (inside this tap, so its audio can be unlocked)
  // and is freed when the call ends. Until it's ready, replies use the system voice.
  const nv = voiceEngine() === 'natural' ? startNaturalVoice(bar) : null;
  const ctl = voice.createCall({
    SR: sup.recognition, speaker: nv ? nv.speaker : system, fallback: system,
    lang: navigator.language || 'en-US',
    getSettings: () => agent.settings,
    send: (text) => send(text, null),
    onChange: (snap) => bar.update(snap),
    onError: (message, fatal) => { if (!fatal) bar.update({ ...ctl.snapshot(), error: message }); },
    onFallback: (reason, detail) => naturalVoiceFellBack(reason, detail),
  });
  call = { ctl, bar, nv };
  // start() must run inside this tap: iOS only lets speech begin from a gesture.
  ctl.start();
  bar.update(ctl.snapshot());
  keepAwake(true);
}

function endCall() {
  if (!call) return;
  const { ctl, bar } = call;
  releaseCallVoice();
  call = null;
  ctl.end();
  bar.close();
  keepAwake(false);
}

// ── Natural voice (tts.js; the model runs in a worker) ─────────────────────
// 'natural' | 'system', or 'ask' on a phone that hasn't chosen yet.
function voiceEngine() {
  const S = agent.settings;
  if (!tts.neuralSupported(window)) return 'system';
  if (S.voiceEngine === 'natural' || S.voiceEngine === 'system') return S.voiceEngine;
  return engine.isMobile() ? 'ask' : 'natural';
}
// Kokoro is the best voice; phones default to KittenTTS, which needs a
// fraction of the memory and keeps up on a phone CPU.
function voiceModel() {
  const m = agent.settings.voiceModel;
  return tts.TTS_MODELS[m] ? m : engine.isMobile() ? 'kitten' : 'kokoro';
}
function naturalVoiceId(model) {
  return tts.validVoice(model, (agent.settings.ttsVoices || {})[model]);
}

// Crash marker, as for the chat model: written before the voice model loads
// and while it speaks (localStorage writes are synchronous, so it survives the
// tab being killed), removed when that's over. Found on the next open, it
// explains what happened and calls switch to system voices.
const VOICE_LOADING_KEY = 'squiggle-voice-loading';
function voiceMarker(v) {
  try { v ? localStorage.setItem(VOICE_LOADING_KEY, JSON.stringify(v)) : localStorage.removeItem(VOICE_LOADING_KEY); } catch {}
}
function loadVoiceMarker() {
  try { return JSON.parse(localStorage.getItem(VOICE_LOADING_KEY) || 'null'); } catch { return null; }
}

/** Creates and starts loading the voice model. Must run inside a tap (the
 *  player unlocks audio). Returns { tts, player, speaker, model }. */
function createNaturalVoice({ model = voiceModel(), player = null, onStage = () => {}, onProgress = () => {} } = {}) {
  const voiceId = naturalVoiceId(model);
  if (!player) { player = tts.createPlayer(); player.unlock(); }
  const marker = { model, phase: 'load', stage: 'starting', at: Date.now(), ua: navigator.userAgent };
  voiceMarker(marker);
  const t = tts.createTTS({
    model, voice: voiceId,
    onStage: (st) => { marker.stage = st; voiceMarker(marker); onStage(st); },
    onProgress,
    onBusy: (busy) => voiceMarker(busy ? { ...marker, phase: 'speak', stage: 'speaking', at: Date.now() } : null),
  });
  const loaded = t.load().then((r) => { voiceMarker(null); return r; }, (e) => { voiceMarker(null); throw e; });
  const speaker = voice.neuralSpeaker({ tts: t, player, voice: voiceId, getSettings: () => agent.settings });
  return { tts: t, player, speaker, model, loaded };
}

function freeNaturalVoice(nv) {
  if (!nv) return;
  nv.tts.terminate();
  nv.player.close();
  voiceMarker(null);
}
function releaseCallVoice() {
  if (!call) return;
  freeNaturalVoice(call.nv);
  call.nv = null;
}

const pct = (got, total) => (total ? ` (${Math.round(100 * got / total)}%)` : '');

function startNaturalVoice(bar) {
  const model = voiceModel();
  const label = tts.TTS_MODELS[model].label;
  let shown = false;
  const nv = createNaturalVoice({
    model,
    onStage: (st) => { if (/download/.test(st)) return; shown = true; bar.note(`Loading the natural voice (${label}): ${st}…`); },
    onProgress: (got, total) => { if (got < total) { shown = true; bar.note(`Downloading the natural voice (${label}, ${tts.TTS_MODELS[model].size})${pct(got, total)}. Replies use the system voice until it's ready.`); } },
  });
  nv.loaded.then(() => { if (call && call.nv === nv && shown) bar.note(`Natural voice ready (${label}).`, 4000); }, (e) => {
    if (!call || call.nv !== nv) return;
    bar.note(`Couldn't load the natural voice: ${e.message}. This call uses the system voice.`);
  });
  return nv;
}

// The natural voice failed or can't keep up. The call already moved to the
// system voice; a slow Kokoro gets the light model for the next reply.
function naturalVoiceFellBack(reason, detail) {
  if (!call) return;
  const { bar, nv } = call;
  const model = nv ? nv.model : voiceModel();
  if (reason === 'slow' && nv && model === 'kokoro' && tts.TTS_MODELS.kitten) {
    agent.settings.voiceModel = 'kitten'; saveSettings();
    bar.note(`${tts.TTS_MODELS.kokoro.label} is too slow on this device (${Number(detail).toFixed(1)}× slower than speech), so Squiggle switched to the light natural voice (Settings → Voice calls). Using the system voice while it loads.`);
    // Reuse the unlocked player: we're not inside a tap any more.
    nv.tts.terminate();
    const next = createNaturalVoice({ model: 'kitten', player: nv.player });
    call.nv = next;
    next.loaded.then(() => { if (call && call.nv === next) { call.ctl.setSpeaker(next.speaker); bar.note('Light natural voice ready; it speaks from the next reply.', 6000); } },
      (e) => { if (call && call.nv === next) bar.note(`Couldn't load the light natural voice: ${e.message}. This call uses the system voice.`); });
    return;
  }
  bar.note(reason === 'slow'
    ? `The natural voice can't keep up on this device (${Number(detail).toFixed(1)}× slower than speech), so this call uses the system voice.`
    : `The natural voice stopped working (${detail && detail.message || detail}), so this call uses the system voice.`);
  if (nv) { nv.tts.terminate(); voiceMarker(null); }
}

// First call on a phone: natural or system voice? The answer's tap starts the call.
function askVoiceBar() {
  $('.call')?.remove();
  const m = tts.TTS_MODELS[voiceModel()];
  const choose = (v) => (e) => { e.stopPropagation(); agent.settings.voiceEngine = v; saveSettings(); el.remove(); startCall(); };
  const el = h('section', { class: 'call', 'data-state': 'ask', 'aria-label': 'Voice call' },
    h('div', { class: 'call-inner' },
      h('div', { class: 'call-head' }, h('span', {}, 'Use the natural voice?')),
      h('div', { class: 'call-hint' }, `It sounds much more human. It downloads ${m.size.replace('~', 'about ')} once and runs on this phone, using extra memory while a call is on. You can change this in Settings.`),
      h('div', { class: 'call-actions' },
        h('button', { class: 'btn', type: 'button', onclick: (e) => { e.stopPropagation(); el.remove(); } }, 'Cancel'),
        h('button', { class: 'btn', type: 'button', onclick: choose('system') }, 'System voice'),
        h('button', { class: 'btn primary', type: 'button', onclick: choose('natural') }, 'Natural voice'))));
  $('.main').insertBefore(el, $('#composer'));
}

// On open: a tab killed while the natural voice loaded or spoke.
function checkVoiceCrash() {
  const c = loadVoiceMarker();
  if (!c) return;
  voiceMarker(null);
  const S = agent.settings;
  const m = tts.TTS_MODELS[c.model] || tts.TTS_MODELS[voiceModel()];
  const wasModel = tts.TTS_MODELS[c.model] ? c.model : voiceModel();
  S.voiceEngine = 'system'; saveSettings();
  const b = $('#voice-banner');
  const close = () => { b.hidden = true; b.replaceChildren(); };
  const lighter = wasModel === 'kokoro' && tts.TTS_MODELS.kitten;
  b.hidden = false;
  b.replaceChildren(h('div', { class: 'dl' },
    h('span', {}, `${c.phase === 'speak' ? `The natural voice (${m.label}) crashed this tab while speaking` : `Loading the natural voice (${m.label}) crashed this tab`} last time${c.stage && c.phase !== 'speak' ? `, while ${c.stage}` : ''}.`),
    h('span', { class: 'muted' }, 'This device probably ran out of memory with the voice and the chat model together, so calls use system voices now.'),
    h('div', { class: 'row' },
      lighter ? h('button', { class: 'btn primary', onclick: () => { Object.assign(S, { voiceEngine: 'natural', voiceModel: 'kitten' }); saveSettings(); close(); } }, `Use the light natural voice (${tts.TTS_MODELS.kitten.size})`) : '',
      h('button', { class: 'btn', onclick: () => { Object.assign(S, { voiceEngine: 'natural', voiceModel: wasModel }); saveSettings(); close(); } }, 'Try the natural voice again'),
      h('button', { class: 'btn ghost', onclick: close }, 'Keep system voices'))));
}

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on) wakeLock = await navigator.wakeLock?.request('screen');
    else { await wakeLock?.release(); wakeLock = null; }
  } catch {}
}

// The call bar replaces the composer while a call is on. With `message` it is
// only an explanation (unsupported browser) and closes on its own button.
function callBar(_unused, message) {
  $('.call')?.remove();
  const state = h('span', { 'aria-live': 'polite' }, message ? 'Voice calls unavailable' : 'Starting…');
  const dot = h('span', { class: 'call-dot', 'aria-hidden': 'true' });
  const wait = squiggleWait(); wait.hidden = true;
  const said = h('div', { class: 'call-transcript' });
  const hint = h('div', { class: 'call-hint' }, message ? '' : 'Tap anywhere on this bar to interrupt.');
  const err = h('div', { class: 'call-error', role: 'alert' }, message || '');
  const note = h('div', { class: 'call-hint call-note', 'aria-live': 'polite', hidden: true });
  let noteTimer = null;
  const repeat = h('button', { class: 'btn', type: 'button', hidden: true, onclick: (e) => { e.stopPropagation(); call && call.ctl.repeat(); } }, 'Repeat');
  const endBtn = h('button', { class: 'btn primary', type: 'button', onclick: (e) => { e.stopPropagation(); message ? el.remove() : endCall(); } }, message ? 'Close' : 'End');
  const el = h('section', { class: 'call', 'data-state': message ? 'error' : 'listening', 'aria-label': 'Voice call', onclick: () => call && call.ctl.bargeIn() },
    h('div', { class: 'call-inner' },
      h('div', { class: 'call-head' }, dot, state, wait),
      said, hint, note, err,
      h('div', { class: 'call-actions' }, repeat, endBtn)));
  const main = $('.main');
  main.insertBefore(el, $('#composer'));
  if (!message) { main.classList.add('in-call'); $('#call').setAttribute('aria-pressed', 'true'); }
  scrollDown($('#messages'));
  const self = {
    update(snap) {
      const idle = snap.state === 'idle';
      el.dataset.state = snap.error ? 'error' : snap.state;
      state.textContent = snap.error && idle ? 'Call ended' : CALL_LABELS[snap.state] || snap.state;
      wait.hidden = !(snap.state === 'thinking' || snap.state === 'speaking');
      said.textContent = snap.transcript ? `“${snap.transcript}”` : '';
      said.classList.toggle('interim', Boolean(snap.interim));
      err.textContent = snap.error || '';
      repeat.hidden = !snap.canRepeat;
      hint.hidden = idle;
      if (idle && snap.error) {
        // The call stopped itself (blocked microphone, ...): keep the reason on screen.
        if (call && call.bar === self) { releaseCallVoice(); call = null; }
        note.hidden = true;
        keepAwake(false);
        main.classList.remove('in-call'); $('#call').removeAttribute('aria-pressed');
        endBtn.textContent = 'Close'; endBtn.onclick = (e) => { e.stopPropagation(); el.remove(); };
        el.onclick = null;
      }
    },
    // Voice status (natural voice loading, fallbacks); clears itself after `ms`.
    note(text, ms = 0) {
      clearTimeout(noteTimer);
      note.textContent = text || '';
      note.hidden = !text;
      if (text && ms) noteTimer = setTimeout(() => { if (note.textContent === text) note.hidden = true; }, ms);
    },
    close() { clearTimeout(noteTimer); el.remove(); main.classList.remove('in-call'); $('#call').removeAttribute('aria-pressed'); },
  };
  return self;
}

// Permission card for actions outside the agent's own space (pushing to a
// non-agent branch). The decision comes only from these buttons.
function approvalCard(req, decide) {
  const commits = req.commits || [];
  const wf = req.workflowFiles || [];
  const card = h('div', { class: 'approval', role: 'group', 'aria-label': 'Permission needed' },
    h('p', { class: 'q' }, 'Push to ', h('strong', {}, req.branch), ' in ', h('strong', {}, req.repo), '?'),
    wf.length ? h('p', { class: 'warn' }, `This changes GitHub Actions workflow ${wf.length === 1 ? 'file' : 'files'} (${wf.join(', ')}). Workflows run code on GitHub with this repo's secrets, so Squiggle asks every time.`) : '',
    commits.length ? h('ul', { class: 'commits' }, commits.slice(0, 5).map(c => h('li', {}, h('code', {}, c.oid), ' ', c.message)),
      commits.length > 5 ? h('li', { class: 'muted' }, `and ${commits.length - 5} more`) : '') : h('p', { class: 'muted' }, 'No new commits; this updates the branch on GitHub.'),
  );
  const row = h('div', { class: 'row' },
    h('button', { class: 'btn primary', onclick: () => card.settle('once') }, 'Allow once'),
    wf.length ? '' : h('button', { class: 'btn', onclick: () => card.settle('always') }, `Always allow ${req.branch}`),
    h('button', { class: 'btn ghost', onclick: () => card.settle('deny') }, 'Don\'t allow'));
  card.append(row);
  let settled = false;
  card.settle = (d, text) => {
    if (settled) return;
    settled = true;
    decide(d);
    const label = text || { once: 'Allowed once', always: `Always allowed for ${req.branch} in ${req.repo} (change in Settings)`, deny: 'Not allowed' }[d];
    card.replaceChildren(h('p', { class: 'muted' }, `Push to ${req.branch}: ${label}.`));
    card.classList.add('settled');
  };
  return card;
}

// ── Model ──────────────────────────────────────────────────────────────────
async function initModel() {
  // Free space taken by models Squiggle no longer offers, and on phones by
  // on-device models a phone can't run.
  engine.cleanupStorage({ keep: (id) => engine.modelFitsDevice(id) })
    .then((n) => n && console.info(`Freed ${(n / 1e9).toFixed(1)} GB of old model downloads.`)).catch(() => {});
  if (engine.MODELS[agent.settings.model].runtime === 'cloud') {
    if (!cloudOffered) {
      agent.settings.model = engine.deviceModel(); saveSettings();
      return initModel();
    }
    return loadModel();
  }
  if (engine.needsGpu(agent.settings.model)) {
    const gpu = await engine.webgpuStatus();
    if (!gpu.ok) {
      // No WebGPU: Squiggle Small runs on the CPU instead.
      agent.settings.model = 'SQ'; saveSettings();
      return initModel();
    }
  }
  const info = await engine.downloadInfo(agent.settings.model);
  if (!info.complete) { modelState = 'missing'; showDownloadBanner(info); return; }
  let crashed = loadCrashMarker();
  // A crash with a different model (say Gemma 4 on a phone) says nothing about this one.
  if (crashed && crashed.model !== agent.settings.model && !engine.needsGpu(agent.settings.model)) { setCrashMarker(null); crashed = null; }
  if (crashed) { modelState = 'idle'; showCrashBanner(crashed); return; }
  if (engine.isMobile() && engine.needsGpu(agent.settings.model)) { modelState = 'idle'; showLoadBanner(); return; }
  await loadModel();
}


// Whether the relay offers the cloud model (checked once at startup).
let cloudOffered = false;
async function checkCloud() {
  try { cloudOffered = Boolean((await github.relayConfig()).aiEnabled); } catch { cloudOffered = false; }
  return cloudOffered;
}

// Crash-loop guard. A note is written just before the model loads and
// removed once it's loaded (or fails normally). If the browser killed the
// tab mid-load (out of memory), the note is still there next time, and
// Squiggle asks instead of loading again.
const LOADING_KEY = 'squiggle-model-loading';
function loadCrashMarker() {
  try { return JSON.parse(localStorage.getItem(LOADING_KEY) || 'null'); } catch { return null; }
}
function setCrashMarker(v) {
  try { v ? localStorage.setItem(LOADING_KEY, JSON.stringify(v)) : localStorage.removeItem(LOADING_KEY); } catch {}
}

function showLoadBanner() {
  const m = engine.MODELS[agent.settings.model];
  banner(h('span', {}, `${m.label} is downloaded.`),
    h('button', { class: 'btn primary', onclick: (e) => { e.currentTarget.disabled = true; loadModel(); } }, 'Load model'));
}

// Models from most to least memory needed; a crash offers the next one down.
const BY_MEMORY = ['E4B', 'E2B', 'SQ', 'G3'];
function lighterModel(id) {
  const i = BY_MEMORY.indexOf(id);
  return BY_MEMORY.slice(i + 1).find(m => engine.MODELS[m] && engine.modelFitsDevice(m)) || null;
}
function lightest() {
  const S = agent.settings;
  return !lighterModel(S.model) && S.contextSize <= 4096 && !S.fastDecode;
}

function showCrashBanner(c) {
  const m = engine.MODELS[c.model] || engine.MODELS[agent.settings.model];
  const S = agent.settings;
  const next = lighterModel(S.model) || S.model;
  const nm = engine.MODELS[next];
  const lighter = h('button', { class: 'btn primary', onclick: async () => {
    Object.assign(agent.settings, { model: next, contextSize: 4096, fastDecode: false });
    saveSettings(); setCrashMarker(null);
    modelPromise = null; ensureModel(); // downloads the lighter model first if needed, then loads
  } }, next === S.model ? 'Use lighter settings' : `Use lighter settings (${nm.label}, ${nm.size})`);
  // Settings may have become lighter since the crash (e.g. phones moved to a phone model).
  const changed = c.model !== S.model || c.contextSize !== S.contextSize || Boolean(c.fast) !== Boolean(S.fastDecode);
  const again = h('button', { class: changed ? 'btn primary' : 'btn', onclick: () => { setCrashMarker(null); loadModel(); } }, changed ? 'Load model' : 'Try again');
  const settingsText = `${engine.MODELS[S.model].label}, ${S.contextSize / 1024}K context, speed boost ${S.fastDecode ? 'on' : 'off'}`;
  banner(h('div', { class: 'dl' },
    h('span', {}, `${c.phase === 'reply' ? m.label + ' crashed this tab while answering' : 'Loading ' + m.label + ' crashed this tab last time'}${c.stage ? `, while ${c.stage}` : ''}.`),
    c.gpu ? h('span', { class: 'muted' }, `GPU: ${c.gpu}`) : '',
    h('span', { class: 'muted' }, changed
      ? `This device now uses lighter settings (${settingsText}), which need much less memory.`
      : lightest()
        ? 'This is already the lightest setup. Close other tabs and apps, then try again; some devices can\'t run the model.'
        : `Lighter settings use ${nm.label} (needs less memory), a 4K context and no speed boost.`),
    h('div', { class: 'row' }, changed || lightest() ? '' : lighter, again)));
}

// A short note at the bottom of the screen that goes away on its own.
let toastTimer = null;
function toast(text, ms = 5000) {
  let t = document.querySelector('.toast');
  if (!t) { t = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(t); }
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function banner(...content) {
  const b = $('#model-banner');
  if (!content.length) { b.hidden = true; b.replaceChildren(); return; }
  b.hidden = false;
  b.replaceChildren(...content);
}

function showDownloadBanner(info) {
  const m = engine.MODELS[agent.settings.model];
  const resumed = info && info.stored ? ` (${Math.round(100 * info.stored / (info.total || 1))}% done)` : '';
  banner(h('span', {}, `Download ${m.label} (${m.size}) to start chatting${resumed}.`),
    h('button', { class: 'btn primary', onclick: (e) => { e.currentTarget.disabled = true; ensureModel(); } }, info && info.stored ? 'Resume download' : 'Download'));
}

const gb = (n) => (n / 1e9).toFixed(2);
function eta(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 90) return 'under 2 min left';
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} min left`;
  return `about ${(seconds / 3600).toFixed(1)} h left`;
}

let modelPromise = null;
function ensureModel() {
  if (modelState === 'ready') return Promise.resolve(true);
  if (modelState === 'unsupported') return Promise.resolve(false);
  modelPromise = modelPromise || (async () => {
    try {
      const id = agent.settings.model;
      const info = await engine.downloadInfo(id);
      if (!info.complete) {
        modelState = 'downloading';
        const m = engine.MODELS[id];
        const bar = h('div');
        const progress = h('div', { class: 'progress indeterminate', role: 'progressbar', 'aria-label': 'Model download' }, bar);
        const label = h('span', {}, `Starting download of ${m.label}…`);
        const detail = h('span', { class: 'muted' }, 'Keep this tab open. If it gets interrupted, it picks up where it stopped.');
        banner(h('div', { class: 'dl' }, h('div', { class: 'dl-head' }, squiggleWait(), label), progress, detail));
        // Keep the screen on while downloading (best effort; never blocks).
        let wake = null;
        navigator.wakeLock?.request('screen').then(w => { wake = w; }).catch(() => {});
        // Smoothed speed for the time estimate.
        let lastT = performance.now(), lastGot = null, speed = 0;
        try {
          await engine.download(id, (got, total) => {
            const now = performance.now();
            if (lastGot != null && now - lastT > 700) {
              const inst = (got - lastGot) / ((now - lastT) / 1000);
              speed = speed ? speed * 0.7 + inst * 0.3 : inst;
              lastT = now; lastGot = got;
            } else if (lastGot == null) { lastGot = got; lastT = now; }
            if (!total) return;
            const pct = Math.min(100, 100 * got / total);
            progress.classList.remove('indeterminate');
            progress.setAttribute('aria-valuenow', pct.toFixed(0));
            bar.style.width = pct.toFixed(1) + '%';
            label.textContent = `Downloading ${m.label}: ${gb(got)} of ${gb(total)} GB (${pct.toFixed(0)}%)`;
            if (speed > 0) detail.textContent = `${(speed / 1e6).toFixed(1)} MB/s · ${eta((total - got) / speed)}`;
          }, undefined, {
            onWaiting: () => {
              label.textContent = `${m.label} is downloading in another tab or window.`;
              detail.textContent = 'This tab will continue as soon as it finishes.';
            },
          });
        } finally { try { await wake?.release(); } catch {} }
      }
      await loadModel();
      return modelState === 'ready';
    } catch (e) {
      modelState = 'error';
      banner(h('span', { class: 'error' }, e.message), h('button', { class: 'btn', onclick: () => { modelPromise = null; ensureModel(); } }, 'Resume'));
      return false;
    } finally {
      modelPromise = null;
    }
  })();
  return modelPromise;
}

function updateComposerNote() {
  const note = $('#composer-note');
  if (!note || modelState !== 'ready') return;
  const cloud = engine.MODELS[agent.settings.model].runtime === 'cloud';
  note.textContent = `${engine.MODELS[agent.settings.model].label}, ${cloud ? 'running on your Cloudflare relay (free daily limit)' : 'running on this device'}. ${agent.settings.contextMode === 'smart' ? 'Smart context is on.' : ''}`;
}

async function loadModel() {
  modelState = 'loading';
  const S = agent.settings;
  const cloud = engine.MODELS[S.model].runtime === 'cloud';
  const step = h('span', { class: 'muted' });
  banner(h('div', { class: 'dl' }, h('div', { class: 'dl-head' }, squiggleWait(), h('span', {}, cloud ? 'Connecting to the cloud model…' : `Loading ${engine.MODELS[S.model].label}…`)), step));
  // The marker is rewritten at every step (localStorage writes are synchronous,
  // so it survives the tab being killed) and says where a crash happened.
  const marker = { model: S.model, contextSize: S.contextSize, fast: S.fastDecode, at: Date.now(), stage: 'starting', gpu: cloud ? '' : await engine.gpuSummary(), ua: navigator.userAgent };
  setCrashMarker(marker);
  try {
    await engine.load(S.model, S.contextSize, { fast: S.fastDecode, onStage: (st) => { marker.stage = st; setCrashMarker(marker); step.textContent = st[0].toUpperCase() + st.slice(1) + '…'; } });
    setCrashMarker(null);
    // While a reply is generated, keep a marker too: a crash mid-reply then
    // says so on the next open.
    engine.setProgress((st) => {
      if (!st) { setCrashMarker(null); return; }
      setCrashMarker({ ...marker, phase: 'reply', stage: st, at: Date.now() });
    });
    modelState = 'ready';
    banner();
    updateComposerNote();
    if (agent.settings.contextMode === 'smart' && agent.settings.semantic) loadSemantic();
  } catch (e) {
    setCrashMarker(null);
    modelState = 'error';
    banner(h('span', { class: 'error' }, 'Could not start the model: ' + e.message), h('button', { class: 'btn', onclick: () => loadModel() }, 'Try again'));
  }
}

// ── Drawer panels ──────────────────────────────────────────────────────────
let drawerPanel = null;

function openDrawer(title, panel) {
  drawerPanel = panel;
  $('#drawer').hidden = false;
  $('#drawer-title').textContent = title;
  const c = $('#drawer-content');
  c.replaceChildren();
  return c;
}

function closeDrawer() {
  $('#drawer').hidden = true;
  drawerPanel = null;
  openThreadId = null;
}

function openPanel(name, arg) {
  if (name === 'notes') renderNotesPanel();
  else if (name === 'memory') renderMemoryPanel();
  else if (name === 'files') renderFilesPanel('/home');
  else if (name === 'settings') renderSettingsPanel();
  else if (name === 'context') renderContextPanel(arg);
}

// Threads
function openThread(threadId, focusId, parentMsg) {
  if (!threadId && parentMsg) {
    const existing = sessions.threadOf(current, parentMsg.id);
    threadId = existing ? existing.id : sessions.startThread(current, parentMsg).id;
  }
  openThreadId = threadId;
  renderThreadPanel(true);
  if (focusId) requestAnimationFrame(() => document.querySelector(`#thread-messages [data-mid="${focusId}"]`)?.scrollIntoView({ block: 'center' }));
}

function renderThreadPanel(focus = false) {
  const t = current.threads[openThreadId];
  if (!t) return closeDrawer();
  const c = openDrawer('Thread', 'thread');
  const parent = current.messages.find(m => m.id === t.parent);
  const scroll = h('div', { class: 'messages', id: 'thread-scroll' });
  const list = h('div', { id: 'thread-messages' });
  if (parent) list.append(h('div', { class: 'thread-parent' }, messageEl(parent, { inThread: true })));
  for (const m of current.messages.filter(x => x.thread === t.id)) list.append(messageEl(m, { inThread: true }));
  if (t.summary) list.append(h('p', { class: 'muted' }, 'So far: ', t.summary));
  scroll.append(list);
  const input = h('textarea', { rows: 1, placeholder: 'Reply in thread', 'aria-label': 'Reply in thread' });
  const form = h('form', { class: 'composer' }, h('div', { class: 'composer-inner' }, input, h('button', { class: 'icon-btn', type: 'submit', 'aria-label': 'Send' }, icon(busy ? 'i-stop' : 'i-send'))));
  setupComposer(form, input, (text, files) => send(text, t.id, files));
  c.append(scroll, form);
  scrollDown(scroll);
  if (focus) input.focus();
}

// Memory
// The agent's notepad for the open chat (read-only here; the agent edits it).
function renderNotesPanel() {
  const c = openDrawer('Notes', 'notes');
  const notes = current ? sessions.liveNotes(current) : [];
  const body = h('div', { class: 'drawer-body' },
    h('p', { class: 'hint' }, 'What the agent chose to remember for this chat. It adds, updates and erases these as it works; they\'re always in its context, instead of old tool output.'),
    notes.length
      ? h('ul', { class: 'fact-list notes-list' }, notes.map(n => h('li', {},
          h('div', { class: 'fact' }, h('span', { class: 'muted' }, n.id + ' · ' + new Date(n.mts || n.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })), h('div', { class: 'note-text' }, n.text)))))
      : h('p', { class: 'muted' }, 'No notes yet in this chat.'));
  c.append(body);
}

// Semantic search (MiniLM on the CPU) for smart context, memory and recipes.
function loadSemantic() {
  loadEmbedder().then((ok) => { if (ok) recipes.setEmbedder(embed); });
}

function renderMemoryPanel() {
  const c = openDrawer('Memory', 'memory');
  const body = h('div', { class: 'drawer-body' });
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Search memory', 'aria-label': 'Search memory' });
  const list = h('ul', { class: 'fact-list' });
  const add = h('form', { class: 'row', style: 'margin-bottom:14px' });
  const s = h('input', { type: 'text', placeholder: 'Subject', class: 'search', style: 'flex:1;min-width:80px;margin:0', 'aria-label': 'Subject' });
  const p = h('input', { type: 'text', placeholder: 'relation', class: 'search', style: 'flex:1;min-width:80px;margin:0', 'aria-label': 'Relation' });
  const o = h('input', { type: 'text', placeholder: 'Object', class: 'search', style: 'flex:1;min-width:80px;margin:0', 'aria-label': 'Object' });
  add.append(s, p, o, h('button', { class: 'btn', type: 'submit' }, 'Add'));
  add.onsubmit = (e) => { e.preventDefault(); if (s.value && p.value && o.value) { memory.add({ s: s.value, p: p.value, o: o.value, source: 'user' }); s.value = p.value = o.value = ''; } };
  const draw = async () => {
    const q = search.value.trim();
    const facts = q ? (await memory.recall(q, 50)).map(r => r.fact) : memory.all().slice().reverse();
    list.replaceChildren(...facts.map(f => h('li', {},
      h('div', { class: 'fact' }, h('span', { class: 's' }, f.s), ' ', h('span', { class: 'p' }, f.p), ' ', h('span', { class: 'o' }, f.o),
        f.note ? h('div', { class: 'muted' }, f.note) : '', f.auto ? h('span', { class: 'auto' }, 'Learned automatically') : ''),
      iconButton('i-close', 'Delete fact', () => memory.remove(f.id)))));
    if (!facts.length) list.append(h('li', { class: 'muted' }, q ? 'Nothing matches.' : 'Nothing yet. Squiggle saves facts as you chat, or add one above.'));
  };
  search.addEventListener('input', draw);
  body.append(h('p', { class: 'muted', style: 'margin-top:0' }, 'What Squiggle knows about you and your projects. Synced to all your devices; delete anything that\'s wrong.'), add, search, list);
  body.append(recipeSection());
  c.append(body);
  draw();
}

// Recipes: how finished tasks were solved, reused for similar requests.
function recipeSection() {
  const all = recipes.list();
  const wrap = h('section', { class: 'recipes' }, h('h3', {}, 'Recipes'),
    h('p', { class: 'muted' }, 'How Squiggle solved tasks before, so the next similar request is faster. Unused recipes are forgotten after 90 days unless pinned.'));
  if (!all.length) { wrap.append(h('p', { class: 'muted' }, 'None yet. When Squiggle finishes a task it made a plan for, it saves how it did it here.')); return wrap; }
  const ul = h('ul', { class: 'fact-list recipe-list' });
  for (const r of all) {
    const used = r.uses ? `used ${r.uses} time${r.uses === 1 ? '' : 's'}, last ${ago(r.lastUsed)}` : `saved ${ago(r.created)}`;
    const steps = h('ol', { class: 'recipe-steps' }, (r.steps || []).map(st => h('li', {}, st)));
    const edit = () => {
      const ta = h('textarea', { class: 'recipe-edit', rows: Math.min(10, (r.steps || []).length + 2), 'aria-label': 'Recipe steps, one per line' }, (r.steps || []).join('\n'));
      const title = h('input', { class: 'search', type: 'text', value: r.title, 'aria-label': 'Recipe title' });
      const form = h('form', { class: 'recipe-form' }, title, ta, h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'submit' }, 'Save'), h('button', { class: 'btn ghost', type: 'button', onclick: () => renderMemoryPanel() }, 'Cancel')));
      form.onsubmit = (e) => { e.preventDefault(); recipes.update(r.id, { title: title.value.trim() || r.title, steps: ta.value.split('\n').map(x => x.trim()).filter(Boolean) }); };
      li.replaceChildren(form);
      title.focus();
    };
    const li = h('li', {},
      h('details', { class: 'recipe' },
        h('summary', {}, h('span', { class: 'fact' }, r.title), ' ', h('span', { class: 'muted' }, used), r.pinned ? h('span', { class: 'auto' }, 'Pinned') : ''),
        r.when ? h('p', { class: 'muted' }, 'For: ' + r.when) : '', steps,
        r.specifics && r.specifics.length ? h('p', { class: 'muted' }, r.specifics.join(' · ')) : ''),
      h('div', { class: 'recipe-actions' },
        iconButton('i-pin', r.pinned ? 'Unpin recipe' : 'Pin recipe (never forget it)', () => recipes.pin(r.id, !r.pinned), r.pinned),
        h('button', { class: 'btn ghost small', onclick: edit }, 'Edit'),
        iconButton('i-close', 'Delete recipe', () => recipes.remove(r.id))));
    ul.append(li);
  }
  wrap.append(ul);
  return wrap;
}

// Files (read-only browser of the agent's workspace)
async function renderFilesPanel(path) {
  const c = openDrawer('Files', 'files');
  const body = h('div', { class: 'drawer-body' });
  c.append(body);
  body.append(h('p', { class: 'muted', style: 'margin-top:0' }, path === '/home' ? '/home syncs to all your devices. Repos under /repos live on this device; push branches to share them.' : path));
  const tabs = h('div', { class: 'seg', style: 'margin-bottom:12px' },
    h('button', { 'aria-pressed': String(path.startsWith('/home')), onclick: () => renderFilesPanel('/home') }, 'Home'),
    h('button', { 'aria-pressed': String(path.startsWith('/repos')), onclick: () => renderFilesPanel('/repos') }, 'Repos'));
  body.append(tabs);
  const ul = h('ul', { class: 'file-tree' });
  body.append(ul);
  const r = resolveAgentPath(path);
  let files = [];
  if (r.area === 'home') files = (await storage.list('home/' + r.rel)).map(f => ({ label: f.path, open: `/home/${r.rel ? r.rel + '/' : ''}${f.path}` }));
  else if (r.area === 'repos' && !r.repo) files = (await pfs.readdir('/repos').catch(() => [])).map(n => ({ label: n + '/', dir: `/repos/${n}` }));
  else files = (await walk(`/repos/${r.repo}${r.rel ? '/' + r.rel : ''}`)).map(f => ({ label: f.path, open: `/repos/${r.repo}/${r.rel ? r.rel + '/' : ''}${f.path}` }));
  if (!files.length) ul.append(h('li', { class: 'muted' }, 'Empty.'));
  for (const f of files.slice(0, 500)) {
    ul.append(h('li', {}, h('button', { onclick: () => f.dir ? renderFilesPanel(f.dir) : showFile(f.open) }, f.label)));
  }
  async function showFile(p) {
    const rr = resolveAgentPath(p);
    const text = rr.area === 'home' ? await storage.read('home/' + rr.rel) : await pfs.readFile(`/repos/${rr.repo}/${rr.rel}`, 'utf8').catch(() => null);
    body.replaceChildren(h('button', { class: 'btn ghost', onclick: () => renderFilesPanel(p.split('/').slice(0, rr.area === 'home' ? 2 : 3).join('/')) }, 'Back'),
      h('p', { class: 'muted' }, p), h('pre', { class: 'file-view' }, text == null ? '(binary or missing)' : text.slice(0, 200000)));
  }
}

// What the model saw
function renderContextPanel(m) {
  const c = openDrawer('What the model saw', 'context');
  const r = m.context;
  const body = h('div', { class: 'drawer-body' });
  const pct = Math.min(100, Math.round(100 * (r.used || 0) / (r.budget || 1)));
  const kinds = { actions: 'Earlier tool calls', system: 'Instructions', recent: 'Recent messages', pinned: 'Pinned', summary: 'Summary', fact: 'Memory', message: 'Earlier message', observation: 'Saved tool output', thread: 'Thread outcome', refs: 'Resolved references', recipe: 'Recipe', plan: 'Plan (step prompt)', chat: 'Another chat', note: 'Note' };
  body.append(
    h('p', { style: 'margin-top:0' }, `${r.mode === 'step' ? 'Last step\'s prompt' : r.mode === 'smart' ? 'Smart context' : r.mode === 'full' ? 'Full history' : 'Compaction'}: about ${r.used} of ${r.budget} tokens.`),
    h('div', { class: 'meter' }, h('div', { style: `width:${pct}%` })),
    ...r.items.map(it => h('div', { class: 'ctx-item' },
      h('div', {}, h('div', { class: 'kind' }, kinds[it.kind] || it.kind, it.score != null ? ` · relevance ${it.score}` : ''), h('div', {}, it.label)),
      h('div', { class: 'tok' }, `${it.tokens} tok`))),
    r.dropped ? h('p', { class: 'muted' }, `${r.dropped} older message${r.dropped === 1 ? ' was' : 's were'} left out. Pin a message to always include it.`) : '',
  );
  c.append(body);
}

// Voice for calls: the natural voice (a small neural model on this device) or
// an installed system voice, how fast, and whether talking over a reply
// interrupts it (off by default: speakers make the mic hear itself).
let voicesWatched = false;
const TEST_LINE = 'Hi, this is how I sound on a call.';
function voiceSettingsField(S, seg) {
  const synth = window.speechSynthesis;
  if (!voicesWatched) {
    voicesWatched = true;
    synth.addEventListener?.('voiceschanged', () => { if (drawerPanel === 'settings') renderSettingsPanel(); });
  }
  const lang = navigator.language || 'en-US';
  const neural = tts.neuralSupported(window);
  const engineNow = voiceEngine();
  const natural = engineNow === 'natural';
  const model = voiceModel(), m = tts.TTS_MODELS[model];
  // Best-sounding voices for this language first; robotic ones are left out.
  const prim = lang.toLowerCase().split('-')[0];
  const mine = (v) => String(v.lang || '').toLowerCase().startsWith(prim) ? 1 : 0;
  const voices = Array.from(synth.getVoices() || []).filter(v => voice.voiceQuality(v) > -10)
    .sort((a, b) => mine(b) - mine(a) || voice.voiceQuality(b) - voice.voiceQuality(a) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  const tier = (v) => { const q = voice.voiceQuality(v); return q >= 9 ? ', premium' : q >= 6 ? ', enhanced' : ''; };
  const auto = voice.pickVoice(voices, lang, '');
  const select = natural
    ? h('select', { id: 'voice-select', 'aria-label': 'Voice', onchange: (e) => { S.ttsVoices = { ...(S.ttsVoices || {}), [model]: e.target.value }; saveSettings(); } },
        Object.entries(m.voices).map(([id, name]) => h('option', { value: id, selected: id === naturalVoiceId(model) ? true : null }, name)))
    : h('select', { id: 'voice-select', 'aria-label': 'Voice', onchange: (e) => { S.voiceURI = e.target.value; saveSettings(); } },
        h('option', { value: '' }, auto ? `Automatic (${auto.name})` : 'Automatic'),
        voices.map(v => h('option', { value: v.voiceURI, selected: v.voiceURI === S.voiceURI ? true : null }, `${v.name} (${v.lang}${tier(v)})`)));
  const status = h('span', { class: 'voice-status', 'aria-live': 'polite' });
  const testSystem = () => {
    synth.cancel();
    const u = new SpeechSynthesisUtterance(TEST_LINE);
    const v = voice.pickVoice(synth.getVoices(), lang, S.voiceURI);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = Number(S.voiceRate) || 1;
    synth.speak(u);
  };
  // Loads the model just for this (inside the tap, so audio unlocks), says the
  // line, and frees it again. During a call, the call's voice is used.
  const testNatural = async (e) => {
    const btn = e.currentTarget;
    if (call && call.nv) {
      if (call.nv.tts.state !== 'ready') { status.textContent = 'The natural voice is still loading for the call.'; return; }
      status.textContent = 'End the call to test another voice; the call uses the voice it started with.';
      return;
    }
    btn.disabled = true;
    const nv = createNaturalVoice({
      model,
      onStage: (st) => { status.textContent = `${st[0].toUpperCase()}${st.slice(1)}…`; },
      onProgress: (got, total) => { status.textContent = `Downloading ${m.label} (${m.size})${pct(got, total)}…`; },
    });
    try {
      const r = await nv.loaded;
      status.textContent = r.cached ? 'Speaking…' : `Loaded in ${(r.ms / 1000).toFixed(1)} s. Speaking…`;
      const a = await nv.tts.synth(TEST_LINE, { speed: Number(S.voiceRate) || 1 });
      await nv.player.play(a.samples, a.sampleRate);
      status.textContent = `${m.label} took ${(a.ms / 1000).toFixed(1)} s for ${(a.samples.length / a.sampleRate).toFixed(1)} s of speech${a.ms > 1000 * a.samples.length / a.sampleRate ? ': slower than speech on this device, so calls may pause between sentences' : ''}.`;
    } catch (err) {
      status.textContent = `Couldn't play the natural voice: ${err.message}.`;
    } finally {
      freeNaturalVoice(nv);
      btn.disabled = false;
    }
  };
  return h('div', { class: 'field' }, h('span', { class: 'label' }, 'Voice calls'),
    neural ? seg([['natural', 'Natural'], ['system', 'System voices']], natural ? 'natural' : 'system', (v) => { S.voiceEngine = v; }) : '',
    neural ? h('span', { class: 'hint' }, natural
      ? `A neural voice that runs on this device. It downloads once (${m.size}) and loads only during calls.`
      : engineNow === 'ask' ? 'Your first call asks whether to use the natural voice.' : 'Your browser\'s built-in voices.') : '',
    natural ? seg([['kokoro', `Best (${tts.TTS_MODELS.kokoro.size})`], ['kitten', `Light (${tts.TTS_MODELS.kitten.size})`]], model, (v) => { S.voiceModel = v; }) : '',
    natural ? h('span', { class: 'hint' }, model === 'kokoro'
      ? 'Kokoro: the most natural. Needs a fast computer to keep up, and about 400 MB of memory during calls.'
      : 'KittenTTS: lighter and faster, about 250 MB of memory during calls. The safer choice on phones.') : '',
    select,
    seg([[0.9, 'Slow'], [1, 'Normal'], [1.2, 'Fast'], [1.4, 'Faster']], Number(S.voiceRate) || 1, (v) => { S.voiceRate = v; }),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: natural ? testNatural : testSystem }, 'Test voice'), status),
    h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: S.voiceBargeIn ? true : null, onchange: (e) => { S.voiceBargeIn = e.target.checked; saveSettings(); } }),
      h('span', {}, h('strong', {}, 'Interrupt by talking'), h('span', { class: 'hint', style: 'display:block' }, 'Keep listening while Squiggle speaks, so you can cut in. Use headphones: on speakers it can hear itself.'))),
    h('span', { class: 'hint' }, 'Tap the headset button next to the message box to start a hands-free call. Replies are spoken as they arrive; code is skipped and links are read as their site name.'),
    natural || voices.some(v => mine(v) && voice.voiceQuality(v) >= 6) ? '' : h('span', { class: 'hint' }, 'For a much more natural voice, choose Natural above, or download a "Premium" or "Enhanced" voice in your device\'s settings (iPhone: Settings → Accessibility → Spoken Content → Voices), then pick it here.'));
}

// Settings
function renderSettingsPanel() {
  const c = openDrawer('Settings', 'settings');
  const body = h('div', { class: 'drawer-body' });
  const S = agent.settings;
  const seg = (options, value, onPick) => h('div', { class: 'seg' }, options.map(([v, label]) => h('button', { 'aria-pressed': String(v === value), onclick: () => { onPick(v); saveSettings(); renderSettingsPanel(); } }, label)));
  const cfg = storage.storageConfig();

  body.append(
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Model'),
      modelPicker(S.model, async (v) => { if (v === S.model) return; S.model = v; saveSettings(); modelState = 'unknown'; await engine.unload(); initModel(); }),
      h('span', { class: 'hint' }, engine.isMobile()
        ? 'Phones run Gemma 3 270M on the CPU by default: Gemma 4 doesn\'t fit in a phone browser tab. It\'s much less capable, especially with tools; the cloud model is the stronger option when your relay offers it.'
        : 'Gemma 4 E4B is the default on computers: the smartest and best with tools. Each model downloads once per device.')),

    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Context window'),
      seg([[4096, '4K'], [8192, '8K'], [16384, '16K']], S.contextSize, async (v) => { S.contextSize = v; if (engine.engineReady()) await loadModel(); }),
      h('span', { class: 'hint' }, 'Bigger remembers more per turn but uses more memory and is slower to start. Phones are safest at 4K.')),

    engine.MODELS[S.model].runtime !== 'litert' ? '' : h('div', { class: 'field' }, h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: S.fastDecode ? true : null, onchange: async (e) => { S.fastDecode = e.target.checked; saveSettings(); if (engine.engineReady()) await loadModel(); } }),
      h('span', {}, h('strong', {}, 'Speed boost'), h('span', { class: 'hint', style: 'display:block' }, 'Replies come noticeably faster, but it loads an extra helper model and needs more memory. Off by default on phones.')))),

    h('div', { class: 'field' }, h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: S.contextMode === 'smart' ? true : null, onchange: (e) => { S.contextMode = e.target.checked ? 'smart' : 'compact'; saveSettings(); if (S.contextMode === 'smart' && S.semantic) loadSemantic(); updateComposerNote(); renderSettingsPanel(); } }),
      h('span', {}, h('strong', {}, 'Smart context'), h('span', { class: 'hint', style: 'display:block' }, 'Instead of only a summary plus recent messages, picks the earlier messages, other chats, web pages and files most relevant to each question and to the current step. Check "What the model saw" on any reply.')))),
    S.contextMode !== 'smart' ? '' : h('div', { class: 'field' }, h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: S.semantic ? true : null, onchange: (e) => { S.semantic = e.target.checked; saveSettings(); if (S.semantic) loadSemantic(); } }),
      h('span', {}, h('strong', {}, 'Search by meaning'), h('span', { class: 'hint', style: 'display:block' }, 'Also matches by meaning, not just words. Downloads a small 23 MB search model that runs on the CPU. Off by default on phones.')))),

    h('div', { class: 'field' }, h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: S.learn ? true : null, onchange: (e) => { S.learn = e.target.checked; saveSettings(); } }),
      h('span', {}, h('strong', {}, 'Learn from conversations'), h('span', { class: 'hint', style: 'display:block' }, 'After each reply, Squiggle saves lasting facts to Memory. Review them in the Memory panel.')))),

    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Theme'),
      seg([['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], S.theme || 'auto', (v) => { S.theme = v; applyTheme(); })),

    voice.support(window).synthesis ? voiceSettingsField(S, seg) : '',

    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Storage'),
      h('span', {}, cfg ? h('a', { href: `https://github.com/${cfg.owner}/${cfg.name}${cfg.root ? '/tree/' + cfg.branch + '/' + cfg.root : ''}`, target: '_blank', rel: 'noopener' }, `${cfg.owner}/${cfg.name}${cfg.root ? '/' + cfg.root.replace(/\/$/, '') : ''}`) : 'None'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => storage.sync() }, 'Sync now'),
        h('button', { class: 'btn', onclick: async () => { await sessions.flush({ sync: false }); await storage.forgetStorage(); location.reload(); } }, 'Change repo'))),

    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Repo access'),
      h('span', { class: 'hint' }, 'The agent can work on repos you\'ve given Squiggle access to, and read any public repo.'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => window.open(await github.installUrl(), '_blank', 'noopener') }, 'Manage repo access'))),

    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Relay'),
      h('span', {}, relayUrl() || 'Same site as the app'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => {
        const v = prompt('Relay address (leave empty to use the deployed setting):', relayUrl());
        if (v === null) return;
        try { setRelayOverride(v); location.reload(); } catch (e) { alert(e.message); }
      } }, 'Change'))),

    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Push permissions'),
      h('span', { class: 'hint' }, 'The agent pushes its own agent/ branches freely. Pushing any other branch asks first, unless you chose "Always allow" for it.'),
      grants.list().length
        ? h('ul', { class: 'fact-list' }, grants.list().map(g => h('li', {},
            h('div', { class: 'fact' }, 'Always allow ', h('span', { class: 's' }, g.branch), ' in ', h('span', { class: 'o' }, g.repo)),
            h('button', { class: 'btn ghost', onclick: async () => { await grants.revoke(g.id); renderSettingsPanel(); } }, 'Revoke'))))
        : h('span', { class: 'muted' }, 'None yet.')),

    h('div', { class: 'field' }, h('span', { class: 'label' }, 'This device'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => { await engine.unload(); await engine.deleteModel(S.model); location.reload(); } }, 'Delete downloaded model'),
        h('button', { class: 'btn danger', onclick: async () => { await sessions.flush(); await github.signOut(); location.reload(); } }, 'Sign out'))),
  );
  c.append(body);
}
