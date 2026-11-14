// The running app: loads everything, wires the static shell (index.html) to
// the modules under ui/, and keeps state in sync with storage events.
import * as storage from '../storage.js';
import * as sessions from '../sessions.js';
import * as memory from '../memory.js';
import * as grants from '../grants.js';
import * as recipes from '../recipes.js';
import * as incidents from '../incidents.js';
import { parseJsonl, toJsonl } from '../merge.js';
import { uid } from '../util.js';
import { $, h, squiggleWait } from './dom.js';
import { state } from './state.js';
import { openSession, renderChat, renderSessions, setSync, setupComposer, send, closeSidebar } from './chat.js';
import { openPanel, closeDrawer, renderThreadPanel, renderNotesPanel, renderMemoryPanel } from './panels.js';
import { setSideOpen, sideOpenPref, sideOverlay } from './side.js';
import { startCall, endCall } from './voice-ui.js';
import { checkCloud, initModel } from './model-ui.js';
import { requestedChat, showChatInUrl } from './links.js';
import * as demo from '../demo.js';
import { showSetup } from './setup.js';

export async function startApp() {
  // Load everything before showing the app, so nothing tapped during startup
  // gets overridden when loading finishes.
  const setup = $('#setup');
  setup.hidden = false;
  $('#setup-steps').hidden = true;
  $('#setup-body').replaceChildren(h('p', { class: 'muted' }, 'Opening your sessions… '), squiggleWait());
  await storage.open();
  await Promise.all([sessions.loadAll(), memory.load(), grants.load(), recipes.load()]);
  recipes.prune();
  incidents.setSink(saveIncident);
  wireApp();
  setSync();
  // A chat link (#chat=<id>) opens that chat if this account has it; else the usual one, and the link waits for
  // the first sync (it may be from another device), keeping its id in the address bar until then.
  const asked = requestedChat();
  const linked = openable(asked);
  pendingChat = asked && !linked ? asked : '';
  // The demo opens on a new chat while only the sample chat exists, so the first question has to find it.
  const usual = demo.isDemo() && sessions.list().every(s => s.demo) ? sessions.newSession() : sessions.list()[0];
  openSession(linked || usual || sessions.newSession(), null, { url: pendingChat ? 'none' : 'replace' });
  setup.hidden = true;
  $('#app').hidden = false;
  renderDemoBanner();
  storage.sync();
  setInterval(() => { if (document.visibilityState === 'visible') storage.sync(); }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') storage.sync();
    else settle();
  });
  // Closing or reloading the tab: write what's pending (chats, memory) and save the in-memory file tree
  // (git.js persist), so a chat or fact from the last second isn't lost; the IndexedDB write usually completes
  // even as the page goes away. In demo mode this browser is the only copy.
  addEventListener('pagehide', settle);
  checkCloud().finally(() => initModel());
}

// Problems for later (incidents.js), in the storage repo so they can be read without a screenshot: one line each in
// debug/incidents.jsonl (the last 200), a crashed reply's prompt in its own file next to it.
// shortcut: prompt files of lines past the last 200 stay behind; prune them if debug/incidents/ gets big.
const INCIDENTS = 'debug/incidents.jsonl';
let savingIncident = Promise.resolve();
function saveIncident(rec) {
  savingIncident = savingIncident.then(async () => {
    const line = { id: uid('i'), ...rec, ua: navigator.userAgent, uptimeS: Math.round(performance.now() / 1000), chat: state.current && state.current.id };
    if (line.prompt) {
      line.promptFile = `debug/incidents/${line.id}.txt`;
      await storage.write(line.promptFile, line.prompt);
    }
    delete line.prompt;
    const all = parseJsonl(await storage.read(INCIDENTS)).slice(-199);
    await storage.write(INCIDENTS, toJsonl([...all, line]));
    storage.sync();
  }).catch(e => console.warn('incident', e));
}

// Demo mode's strip: what's different, things to try (sent as messages), and the way out (demo.js).
export function renderDemoBanner() {
  const b = $('#demo-banner');
  if (!b) return;
  if (!demo.isDemo()) { b.hidden = true; b.replaceChildren(); return; }
  const hidden = localStorage.getItem('squiggle-demo-banner') === 'hidden';
  b.hidden = hidden;
  if (hidden) return;
  b.replaceChildren(
    h('span', {}, h('strong', {}, 'Demo mode. '), 'This is the real Squiggle with its storage in this browser instead of a private GitHub repo: nothing syncs, the git and GitHub tools are off, and the cloud model needs a sign-in. The chat, memory and file about "Pip" are samples to search.'),
    h('button', { class: 'btn primary small', onclick: () => showSetup('signin') }, 'Sign in to sync'),
    h('button', { class: 'btn ghost small', onclick: () => { localStorage.setItem('squiggle-demo-banner', 'hidden'); renderDemoBanner(); } }, 'Hide'),
    // Each one starts a new chat, so the answer has to come from memory, the sample chat or the file, not from the thread.
    h('div', { class: 'try' }, h('span', { class: 'muted' }, 'Try:'), ...demo.TRY.map(t => h('button', { type: 'button', onclick: () => { if (state.busy) return; if (state.current.messages.length) openSession(sessions.newSession()); send(t, null, []); } }, t))),
  );
}

// Pending saves to disk, then the file tree to IndexedDB (storage.persistNow).
export async function settle() {
  await Promise.all([sessions.flush({ sync: false }), memory.flush()]);
  await storage.persistNow();
}

// A chat a link may open: this account's, not deleted (archived is fine).
const openable = (id) => {
  const s = id ? sessions.get(id) : null;
  return s && !s.deleted ? s : null;
};
let pendingChat = '';

// Opens the chat a link asks for (back/forward, a pasted link). Returns whether it did.
function followLink() {
  const id = requestedChat();
  if (!id || (state.current && state.current.id === id)) return false;
  const s = openable(id);
  if (!s) { pendingChat = id; return false; }
  pendingChat = '';
  openSession(s, null, { url: 'none' });
  closeSidebar();
  return true;
}

export function fatal(e) {
  console.error(e);
  document.body.innerHTML = '';
  document.body.append(h('main', { class: 'setup' }, h('div', { class: 'setup-card' },
    h('h2', {}, 'Squiggle could not start'), h('p', { class: 'error' }, String(e.message || e)),
    h('button', { class: 'btn', onclick: () => location.reload() }, 'Reload'))));
}

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
  $('#toggle-side').onclick = () => setSideOpen($('#ctx-side').hidden);
  $('#close-side').onclick = () => setSideOpen(false);
  setSideOpen(sideOpenPref(), false);
  document.querySelectorAll('.side-nav [data-panel]').forEach(b => b.onclick = () => { closeSidebar(); openPanel(b.dataset.panel); });
  $('#session-search').addEventListener('input', () => renderSessions());
  setupComposer($('#composer'), $('#input'), (text, files) => send(text, null, files));
  $('#call').onclick = () => (state.call ? endCall() : startCall());
  setInterval(setSync, 30000);
  sessions.events.on('list', () => renderSessions());
  sessions.events.on('session', (id) => {
    if (state.busy || !state.current || id !== state.current.id) return;
    renderChat();
    // Don't rebuild the thread panel while the person is typing in it.
    const draft = document.querySelector('#drawer textarea');
    if (state.openThreadId && (!draft || !draft.value)) renderThreadPanel();
  });
  storage.events.on('status', setSync);
  addEventListener('popstate', followLink);
  addEventListener('hashchange', followLink);
  storage.events.on('synced', async ({ changed }) => {
    if (!changed.length) { settleLink(); return; }
    await sessions.reload(changed);
    await memory.reload(changed);
    await grants.reload(changed);
    await recipes.reload(changed);
    if (state.current && state.current.deleted) openSession(sessions.list()[0] || sessions.newSession());
    settleLink();
  });
  // After a sync: a linked chat that arrived opens, unless the person has started something else meanwhile; one
  // that still isn't here was never this account's, so the address bar shows the open chat again.
  function settleLink() {
    if (!pendingChat) return;
    const id = pendingChat;
    pendingChat = '';
    const s = openable(id);
    if (s && !state.busy && requestedChat() === id) openSession(s, null, { url: 'replace' });
    else if (state.current && requestedChat() === id) showChatInUrl(state.current.id, 'replace');
  }
  const memoryChanged = () => { if (state.drawerPanel === 'memory' && !document.querySelector('#drawer .recipe-form')) renderMemoryPanel(); };
  memory.events.on('change', memoryChanged);
  recipes.events.on('change', memoryChanged);
  sessions.events.on('session', (id) => { if (state.drawerPanel === 'notes' && state.current && id === state.current.id) renderNotesPanel(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); closeSidebar(); if (sideOverlay()) setSideOpen(false, false); } });
}
