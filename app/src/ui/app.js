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
import { startCall, endCall, checkVoiceCrash } from './voice-ui.js';
import { checkCloud, initModel } from './model-ui.js';

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
  storage.events.on('synced', async ({ changed }) => {
    if (!changed.length) return;
    await sessions.reload(changed);
    await memory.reload(changed);
    await grants.reload(changed);
    await recipes.reload(changed);
    if (state.current && state.current.deleted) openSession(sessions.list()[0] || sessions.newSession());
  });
  const memoryChanged = () => { if (state.drawerPanel === 'memory' && !document.querySelector('#drawer .recipe-form')) renderMemoryPanel(); };
  memory.events.on('change', memoryChanged);
  recipes.events.on('change', memoryChanged);
  sessions.events.on('session', (id) => { if (state.drawerPanel === 'notes' && state.current && id === state.current.id) renderNotesPanel(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); closeSidebar(); if (sideOverlay()) setSideOpen(false, false); } });
}
