// Squiggle UI: setup, sessions, chat with threads, and side panels.
import { marked, DOMPurify } from '../vendor/markdown.js';
import * as github from './github.js';
import * as storage from './storage.js';
import * as sessions from './sessions.js';
import * as memory from './memory.js';
import * as engine from './engine.js';
import * as agent from './agent.js';
import { loadEmbedder } from './embed.js';
import { resolveAgentPath } from './guard.js';
import { pfs, walk } from './git.js';
import { bm25 } from './search.js';

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
const squiggleWait = () => h('span', { class: 'squiggle-wait', role: 'status', 'aria-label': 'Working' }, icon('squiggle'));

// ── Settings (per device) ──────────────────────────────────────────────────
const SETTINGS_KEY = 'squiggle-settings';
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch {}
  Object.assign(agent.settings, { model: engine.suggestModel() }, saved);
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
  await Promise.all([sessions.loadAll(), memory.load()]);
  wireApp();
  setSync();
  openSession(sessions.list()[0] || sessions.newSession());
  setup.hidden = true;
  $('#app').hidden = false;
  storage.sync();
  setInterval(() => { if (document.visibilityState === 'visible') storage.sync(); }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') storage.sync();
    else sessions.flush();
  });
  initModel();
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
  const cfg = await github.relayConfig();
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
  const gpu = await engine.webgpuStatus();
  const done = h('button', { class: 'btn primary', onclick: async () => { await startApp(); if (gpu.ok) ensureModel(); } }, gpu.ok ? 'Download and start' : 'Continue');
  if (!gpu.ok) {
    body.append(h('h2', {}, 'This device can\'t run the model'), h('p', {}, gpu.reason), h('p', { class: 'muted' }, 'Your sessions are set up and will be here when you open Squiggle on a device that can.'), done);
    return;
  }
  const choice = agent.settings.model;
  body.append(
    h('h2', {}, 'Download the model'),
    h('p', {}, 'Squiggle runs Gemma 4 right here on your device. It downloads once per device, then works offline. Keep this tab open while it downloads; if it gets interrupted, it resumes where it stopped.'),
    ...Object.entries(engine.MODELS).map(([id, m]) => h('button', {
      class: 'choice', 'aria-pressed': String(id === choice),
      style: id === choice ? 'border-color: var(--action)' : '',
      onclick: () => { agent.settings.model = id; saveSettings(); showSetup('model'); },
    }, h('strong', {}, `${m.label} · ${m.size}`), h('span', {}, m.note + (id === engine.suggestModel() ? ' (suggested for this device)' : '')))),
    h('div', { class: 'row' }, done),
  );
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
  setupComposer($('#composer'), $('#input'), (text) => send(text, null));
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
    if (current && current.deleted) openSession(sessions.list()[0] || sessions.newSession());
  });
  memory.events.on('change', () => { if (drawerPanel === 'memory') renderMemoryPanel(); });
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
      h('span', { class: 't' }, s.title), h('span', { class: 'when' }, ' ', ago(s.updated)))));
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

function messageEl(m, { inThread, streaming }) {
  const el = h('div', { class: `msg ${m.role}`, 'data-mid': m.id || '' });
  const col = h('div', { style: m.role === 'user' ? 'display:flex;flex-direction:column;align-items:flex-end;width:100%' : '' });
  if (m.role === 'assistant') {
    if (m.tools && m.tools.length) col.append(toolTrail(m.tools));
    col.append(h('div', { class: 'body', html: md(m.content) }));
  } else {
    col.append(h('div', { class: 'body' }, m.content));
  }
  if (!streaming && m.id) {
    const actions = h('div', { class: 'msg-actions' + (m.pinned ? ' pinned' : '') });
    if (!inThread) actions.append(iconButton('i-thread', 'Reply in thread', () => openThread(null, null, m)));
    actions.append(iconButton('i-pin', m.pinned ? 'Unpin' : 'Pin (always keep in context)', () => {
      sessions.updateMessage(current, m, { pinned: !m.pinned });
      rerender();
    }, m.pinned));
    actions.append(iconButton('i-copy', 'Copy', () => navigator.clipboard?.writeText(m.content || '')));
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
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) { controller && controller.abort(); return; }
    const text = input.value.trim();
    if (!text) return;
    input.value = ''; grow();
    onSend(text);
  });
}

function setBusy(on) {
  busy = on;
  for (const btn of document.querySelectorAll('.composer button[type="submit"]')) {
    btn.replaceChildren(icon(on ? 'i-stop' : 'i-send'));
    btn.setAttribute('aria-label', on ? 'Stop' : 'Send');
  }
}

async function send(text, threadId) {
  if (busy) return;
  if (modelState !== 'ready') {
    const ok = await ensureModel();
    if (!ok) return;
  }
  const session = current;
  const container = threadId ? $('#thread-messages') : $('#messages-inner');
  const scroller = threadId ? $('#thread-scroll') : $('#messages');
  if (!threadId && !session.messages.some(m => !m.thread)) container.replaceChildren();
  let live = null, body = null, trail = null, think = null;
  const liveTools = [];
  setBusy(true);
  controller = new AbortController();
  try {
    await agent.runTurn({
      session, threadId, text, signal: controller.signal,
      ui: {
        onUser: (m) => { container.append(messageEl(m, { inThread: Boolean(threadId) })); scrollDown(scroller); renderSessions(); },
        onStart: () => {
          live = h('div', { class: 'msg assistant' });
          trail = h('div');
          think = h('details', { class: 'thinking', hidden: true }, h('summary', {}, 'Thinking'), h('div'));
          body = h('div', { class: 'body' }, squiggleWait());
          live.append(trail, think, body);
          container.append(live);
          scrollDown(scroller);
        },
        onThinking: (t) => { think.hidden = false; think.lastChild.textContent = t; },
        onText: (t) => { body.innerHTML = md(t); scrollDown(scroller); },
        onTool: (t) => {
          const existing = liveTools.find(x => x.running && x.name === t.name);
          if (existing) Object.assign(existing, t); else liveTools.push({ ...t });
          trail.replaceChildren(toolTrail(liveTools));
          scrollDown(scroller);
        },
        onDone: (m) => { live.replaceWith(messageEl(m, { inThread: Boolean(threadId) })); if (!threadId) $('#chat-title').textContent = session.title; },
      },
    });
  } finally {
    setBusy(false);
    controller = null;
    if (threadId) renderChat(); // refresh reply count on the parent
  }
}

// ── Model ──────────────────────────────────────────────────────────────────
async function initModel() {
  const gpu = await engine.webgpuStatus();
  if (!gpu.ok) { modelState = 'unsupported'; banner(gpu.reason); return; }
  const info = await engine.downloadInfo(agent.settings.model);
  if (!info.complete) { modelState = 'missing'; showDownloadBanner(info); return; }
  await loadModel();
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
    h('button', { class: 'btn primary', onclick: () => ensureModel() }, info && info.stored ? 'Resume download' : 'Download'));
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
        const bar = h('div');
        const label = h('span', {}, 'Downloading model…');
        banner(label, h('div', { class: 'progress' }, bar));
        let wake = null;
        try { wake = await navigator.wakeLock?.request('screen'); } catch {}
        try {
          await engine.download(id, (got, total) => {
            const pct = total ? (100 * got / total) : 0;
            bar.style.width = pct.toFixed(1) + '%';
            label.textContent = `Downloading model… ${(got / 1e9).toFixed(2)} of ${(total / 1e9).toFixed(2)} GB`;
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
  note.textContent = `${engine.MODELS[agent.settings.model].label}, running on this device. ${agent.settings.contextMode === 'smart' ? 'Smart context is on.' : ''}`;
}

async function loadModel() {
  modelState = 'loading';
  banner(squiggleWait(), h('span', {}, 'Loading the model onto your GPU…'));
  try {
    await engine.load(agent.settings.model, agent.settings.contextSize);
    modelState = 'ready';
    banner();
    updateComposerNote();
    if (agent.settings.contextMode === 'smart') loadEmbedder();
  } catch (e) {
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
  if (name === 'memory') renderMemoryPanel();
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
  setupComposer(form, input, (text) => send(text, t.id));
  c.append(scroll, form);
  scrollDown(scroll);
  if (focus) input.focus();
}

// Memory
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
  c.append(body);
  draw();
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
  const kinds = { system: 'Instructions', recent: 'Recent messages', pinned: 'Pinned', summary: 'Summary', fact: 'Memory', message: 'Earlier message', observation: 'Saved tool output', thread: 'Thread outcome' };
  body.append(
    h('p', { style: 'margin-top:0' }, `${r.mode === 'smart' ? 'Smart context' : r.mode === 'full' ? 'Full history' : 'Compaction'}: about ${r.used} of ${r.budget} tokens.`),
    h('div', { class: 'meter' }, h('div', { style: `width:${pct}%` })),
    ...r.items.map(it => h('div', { class: 'ctx-item' },
      h('div', {}, h('div', { class: 'kind' }, kinds[it.kind] || it.kind, it.score != null ? ` · relevance ${it.score}` : ''), h('div', {}, it.label)),
      h('div', { class: 'tok' }, `${it.tokens} tok`))),
    r.dropped ? h('p', { class: 'muted' }, `${r.dropped} older message${r.dropped === 1 ? ' was' : 's were'} left out. Pin a message to always include it.`) : '',
  );
  c.append(body);
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
      seg(Object.entries(engine.MODELS).map(([id, m]) => [id, `${m.label.replace('Gemma 4 ', '')} · ${m.size}`]), S.model, async (v) => { S.model = v; modelState = 'unknown'; await engine.unload(); initModel(); }),
      h('span', { class: 'hint' }, 'E2B is faster; E4B is smarter and better with tools. Each downloads once per device.')),

    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Context window'),
      seg([[4096, '4K'], [8192, '8K'], [16384, '16K']], S.contextSize, async (v) => { S.contextSize = v; if (engine.engineReady()) await loadModel(); }),
      h('span', { class: 'hint' }, 'Bigger remembers more per turn but uses more GPU memory and is slower to start.')),

    h('div', { class: 'field' }, h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: S.contextMode === 'smart' ? true : null, onchange: (e) => { S.contextMode = e.target.checked ? 'smart' : 'compact'; saveSettings(); if (S.contextMode === 'smart') loadEmbedder(); updateComposerNote(); } }),
      h('span', {}, h('strong', {}, 'Smart context (experimental)'), h('span', { class: 'hint', style: 'display:block' }, 'Instead of only a summary plus recent messages, picks the earlier messages, web pages and files most relevant to each question. Downloads a small 23 MB search model. Check "What the model saw" on any reply to compare.')))),

    h('div', { class: 'field' }, h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: S.learn ? true : null, onchange: (e) => { S.learn = e.target.checked; saveSettings(); } }),
      h('span', {}, h('strong', {}, 'Learn from conversations'), h('span', { class: 'hint', style: 'display:block' }, 'After each reply, Squiggle saves lasting facts to Memory. Review them in the Memory panel.')))),

    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Theme'),
      seg([['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], S.theme || 'auto', (v) => { S.theme = v; applyTheme(); })),

    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Storage'),
      h('span', {}, cfg ? h('a', { href: `https://github.com/${cfg.owner}/${cfg.name}${cfg.root ? '/tree/' + cfg.branch + '/' + cfg.root : ''}`, target: '_blank', rel: 'noopener' }, `${cfg.owner}/${cfg.name}${cfg.root ? '/' + cfg.root.replace(/\/$/, '') : ''}`) : 'None'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => storage.sync() }, 'Sync now'),
        h('button', { class: 'btn', onclick: async () => { await sessions.flush({ sync: false }); await storage.forgetStorage(); location.reload(); } }, 'Change repo'))),

    h('div', { class: 'field' }, h('span', { class: 'label' }, 'This device'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => { await engine.unload(); await engine.deleteModel(S.model); location.reload(); } }, 'Delete downloaded model'),
        h('button', { class: 'btn danger', onclick: async () => { await sessions.flush(); await github.signOut(); location.reload(); } }, 'Sign out'))),
  );
  c.append(body);
}
