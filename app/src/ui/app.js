// The running app: loads everything, wires the static shell (index.html) to
// the modules under ui/, and keeps state in sync with storage events.
import * as storage from '../storage.js';
import * as sessions from '../sessions.js';
import * as memory from '../memory.js';
import * as grants from '../grants.js';
import * as recipes from '../recipes.js';
import { $, h, squiggleWait } from './dom.js';
import { state } from './state.js';
import { openSession, renderChat, renderSessions, setSync, setupComposer, send, closeSidebar } from './chat.js';
import { openPanel, closeDrawer, renderThreadPanel, renderNotesPanel, renderMemoryPanel } from './panels.js';
import { setSideOpen, sideOpenPref, sideOverlay } from './side.js';
import { startCall, endCall } from './voice-ui.js';
import { checkCloud, initModel } from './model-ui.js';
import { requestedChat, showChatInUrl } from './links.js';

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
  wireApp();
  setSync();
  // A chat link (#chat=<id>) opens that chat if this account has it; else the usual one, and the link waits for
  // the first sync (it may be from another device), keeping its id in the address bar until then.
  const asked = requestedChat();
  const linked = openable(asked);
  pendingChat = asked && !linked ? asked : '';
  openSession(linked || sessions.list()[0] || sessions.newSession(), null, { url: pendingChat ? 'none' : 'replace' });
  setup.hidden = true;
  $('#app').hidden = false;
  storage.sync();
  setInterval(() => { if (document.visibilityState === 'visible') storage.sync(); }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') storage.sync();
    else sessions.flush();
  });
  checkCloud().finally(() => initModel());
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
