// The chat: sessions sidebar (with search), the message list, the composer,
// sending a turn through agent.runTurn, and the cards a turn can show
// (approval, check-in). Threads render through the same pieces (panels.js).
import * as storage from '../storage.js';
import * as sessions from '../sessions.js';
import * as tasks from '../tasks.js';
import * as agent from '../agent.js';
import * as attachments from '../attachments.js';
import { checkFiles, fmtSize } from '../attachments.js';
import * as voice from '../voice.js';
import { bm25 } from '../search.js';
import { $, h, icon, md, ago, squiggleWait, iconButton, scrollDown, keepAwake, toast } from './dom.js';
import { smoothText } from './smooth.js';
import { state } from './state.js';
import { openThread, openPanel, closeDrawer, renderThreadPanel, renderNotesPanel } from './panels.js';
import { renderSide } from './side.js';
import { toggleReadAloud } from './voice-ui.js';
import { ensureModel, loadCrashMarker, updateComposerNote, useSessionModel, sessionModel, switchModel, useSessionContext } from './model-ui.js';
import * as engine from '../engine.js';
import { CONTEXT_MODES, contextMode } from '../context.js';
import { showChatInUrl } from './links.js';
import * as brainstorm from '../brainstorm.js';

export const closeSidebar = () => $('#sidebar').classList.remove('open');

export function setSync() {
  const st = storage.syncStatus();
  const line = $('#sync-line');
  if (!line) return;
  const cfg = storage.storageConfig();
  const dot = h('span', { class: 'sync-dot' + (st.syncing ? ' busy' : st.lastError ? ' err' : '') });
  const text = storage.isLocal() ? 'Demo: saved in this browser only'
    : st.syncing ? 'Syncing…' : st.lastError ? `Sync failed: ${st.lastError}` : st.lastSync ? `Synced ${ago(st.lastSync)}` : 'Not synced yet';
  line.replaceChildren(dot, h('span', { title: cfg && !cfg.local ? `${cfg.owner}/${cfg.name}` : '' }, text));
}

// ── Sessions sidebar (with search) ─────────────────────────────────────────
export function renderSessions() {
  const ul = $('#session-list');
  const q = $('#session-search').value.trim();
  ul.replaceChildren();
  if (q) return renderSearch(ul, q);
  const item = (s) => h('li', {}, h('button', { 'aria-current': String(state.current && s.id === state.current.id), onclick: () => { openSession(s); closeSidebar(); } },
    h('span', { class: 't' }, s.title), h('span', { class: 'when' }, ago(s.updated))));
  for (const s of sessions.list()) ul.append(item(s));
  if (!ul.children.length) ul.append(h('li', { class: 'muted', style: 'padding: 8px 10px' }, 'No chats yet.'));
  const archived = sessions.listArchived();
  if (archived.length) {
    const d = h('details', { class: 'archived' }, h('summary', {}, `Archived (${archived.length})`), h('ul', {}, archived.map(item)));
    d.open = archivedOpen || Boolean(state.current && state.current.archived);
    d.addEventListener('toggle', () => { archivedOpen = d.open; });
    ul.append(h('li', { class: 'archived-group' }, d));
  }
}
let archivedOpen = false;

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
// url: how the address bar follows ('push' for a chat the person picked, 'replace', or 'none'; links.js).
export function openSession(s, focusMessage, { url = 'push' } = {}) {
  const changed = !state.current || state.current.id !== s.id;
  state.current = s;
  showChatInUrl(s.id, changed ? url : 'replace');
  closeDrawer();
  renderSessions();
  renderChat();
  useSessionModel(s).catch(() => {});
  if (focusMessage) {
    if (focusMessage.thread) openThread(focusMessage.thread, focusMessage.id);
    else requestAnimationFrame(() => {
      const el = document.querySelector(`[data-mid="${focusMessage.id}"]`);
      if (el) { el.scrollIntoView({ block: 'center' }); el.animate([{ background: 'var(--marker)' }, { background: 'transparent' }], { duration: 1400 }); }
    });
  }
}

export function renderChat() {
  const current = state.current;
  $('#chat-title').textContent = current.title;
  renderSide();
  renderBrainstormBar();
  const inner = $('#messages-inner');
  inner.replaceChildren();
  const line = sessions.lineMessages(current, null);
  if (!line.length) { inner.append(emptyState()); return; }
  for (const m of line) inner.append(messageEl(m, { inThread: false }));
  scrollDown($('#messages'), { force: true });
}

function emptyState() {
  if (state.current.brainstorm) return h('div', { class: 'empty' },
    icon('squiggle'),
    h('h2', {}, 'What are we brainstorming?'),
    h('p', {}, 'Send the idea, then Squiggle talks it through with itself. Jump in any time to steer it.'),
    newChatSettings());
  const ideas = ['What do you remember about me?', 'Clone one of my repos and summarize it', 'Read https://example.com and tell me what it says'];
  return h('div', { class: 'empty' },
    icon('squiggle'),
    h('h2', {}, 'What are we working on?'),
    h('p', {}, 'Squiggle runs on this device and picks up where you left off on any other.'),
    newChatSettings(),
    h('div', { class: 'suggestions' }, ideas.map(t => h('button', { onclick: () => { $('#input').value = t; $('#input').focus(); } }, t))));
}

// A new chat's settings, before its first message: which model and how its context is built (Keal, 2026-11-10:
// "a little setting button before the first message, that after it's started is gone"). The context type stays for
// the chat's life (the sidebar shows it); the model can still switch in the chat details.
function newChatSettings() {
  const session = state.current;
  const model = sessionModel(session);
  const mode = session.contextMode || agent.settings.defaultContextMode || 'compact';
  const framing = brainstorm.framingOf(session);
  const summary = h('span', {}, 'This chat: ', h('b', {}, engine.MODELS[model] ? engine.MODELS[model].label : model), ' · ', h('b', {}, session.brainstorm ? (framing === 'flip' ? 'Brainstorm (role flip)' : 'Brainstorm') : contextMode(mode).short));
  const choice = (name, value, checked, label, hint, onPick) => h('label', { class: 'choice' },
    h('input', { type: 'radio', name, value, checked: checked ? true : null, onchange: onPick }),
    h('span', {}, h('span', { class: 'choice-label' }, label), hint ? h('span', { class: 'choice-hint' }, hint) : ''));
  const models = engine.listedModels({ cloudOffered: state.cloudOffered }).map(id => choice('chat-model', id, id === model, engine.MODELS[id].label,
    `${engine.MODELS[id].size}${engine.MODELS[id].experimental ? ' · experimental' : ''}`, async () => {
      session.model = id; sessions.touch(session);
      await switchModel(sessionModel(session)); renderChat();
    }));
  const kinds = [[false, 'Chat', 'Squiggle answers you.'], [true, 'Brainstorm', 'You send the idea; Squiggle talks it through with itself.']]
    .map(([on, label, hint]) => choice('chat-kind', String(on), Boolean(session.brainstorm) === on, label, hint, () => {
      session.brainstorm = on ? 'transcript' : false; sessions.touch(session); renderChat();   // false, not undefined: a dropped key would let a merge bring 'transcript' back
    }));
  const framings = [['transcript', 'Transcript', 'Squiggle writes each voice\'s next turn from the whole brainstorm.'], ['flip', 'Role flip', 'Each voice sees the other as the user.']]
    .map(([k, label, hint]) => choice('chat-framing', k, k === framing, label, hint, () => {
      session.brainstorm = k; sessions.touch(session); renderChat();
    }));
  const modes = Object.entries(CONTEXT_MODES).filter(([, d]) => d.offered).map(([k, d]) => choice('chat-context', k, k === mode, d.label, d.hint.split('. ')[0] + '.', () => {
    session.contextMode = k; sessions.touch(session);
    useSessionContext(session); renderChat();
  }));
  return h('details', { class: 'chat-setup' },
    h('summary', {}, icon('i-settings'), summary, h('span', { class: 'muted' }, 'Change')),
    h('div', { class: 'chat-setup-body' },
      h('fieldset', {}, h('legend', {}, 'Kind'), ...kinds),
      h('fieldset', {}, h('legend', {}, 'Model'), ...models),
      session.brainstorm ? h('fieldset', {}, h('legend', {}, 'Brainstorm'), ...framings) : h('fieldset', {}, h('legend', {}, 'Context'), ...modes),
      h('p', { class: 'muted' }, 'The context type stays for this chat; the model can switch later in the chat details.')));
}

export function messageEl(m, { inThread, streaming, session }) {
  const current = state.current;
  const who = m.decision ? 'S' : m.voice;   // a brainstorm's wrap-up is written by "Squiggle"
  const el = h('div', { class: `msg ${m.role}${who ? ' voice-' + who.toLowerCase() : ''}`, 'data-mid': m.id || '' });
  const col = h('div', { style: m.role === 'user' ? 'display:flex;flex-direction:column;align-items:flex-end;width:100%' : '' });
  if (m.role === 'assistant') {
    if (who) col.append(h('div', { class: 'voice-label' }, voiceLabel(who, m.decision ? 'decision' : m.phase)));
    const owner = session || current;
    const task = m.task && owner && owner.tasks && owner.tasks[m.task];
    if (task) col.append(planEl(task, { live: false }));
    if (m.tools && m.tools.length) col.append(toolTrail(m.tools));
    // Saved thinking stays viewable (collapsed); it's never sent back to the model.
    if (m.thinking) col.append(h('details', { class: 'thinking' }, h('summary', {}, 'Thinking'), h('div', {}, m.thinking)));
    col.append(h('div', { class: 'body', html: md(agent.scrubFakeToolNotes(m.content)) }));
    if (m.error) col.append(h('div', { class: 'msg-error muted' }, '⚠️ ' + m.error));
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
    const copy = iconButton('i-copy', 'Copy', async () => {
      try { await navigator.clipboard.writeText(m.content || ''); } catch { return; }
      copy.replaceChildren(icon('i-check')); copy.classList.add('done'); copy.setAttribute('aria-label', 'Copied');
      setTimeout(() => { copy.replaceChildren(icon('i-copy')); copy.classList.remove('done'); copy.setAttribute('aria-label', 'Copy'); }, 1500);
    });
    actions.append(copy);
    if (m.role === 'assistant' && m.content && voice.support(window).synthesis) {
      const on = Boolean(state.reader && state.reader.id === m.id);
      const b = iconButton(on ? 'i-stop' : 'i-speaker', on ? 'Stop reading' : 'Read aloud', () => toggleReadAloud(m), on);
      b.classList.add('read-aloud');
      b.dataset.msg = m.id;
      actions.append(b);
    }
    if (m.role === 'assistant' && m.context) actions.append(iconButton('i-eye', 'What the model saw', () => openPanel('context', m)));
    const del = iconButton('i-trash', 'Delete message', () => {
      if (!confirm('Delete this message? It disappears from the chat on all your devices.')) return;
      sessions.deleteMessage(current, m);
      rerender();
    });
    del.classList.add('danger');
    actions.append(del);
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
export function planEl(task, { live }) {
  const { done, total } = tasks.progress(task);
  const now = tasks.current(task);
  const st = task.status === 'done' ? 'done' : task.waiting ? 'waiting for your answer' : task.status === 'stopped' ? 'paused' : 'working';
  const list = h('ol', { class: 'plan-steps' }, task.steps.map(s => h('li', { class: `step ${s.status}${s === now && task.status === 'active' ? ' now' : ''}` },
    h('span', { class: 'mark', 'aria-hidden': 'true' }, s.status === 'done' ? '✓' : s.status === 'blocked' ? '?' : s === now && live && task.status === 'active' && !task.waiting ? '' : '○'),
    s === now && live && task.status === 'active' && !task.waiting && s.status !== 'blocked' ? squiggleWait() : '',
    h('span', { class: 'text' }, s.text,
      s.result ? h('span', { class: 'result' }, s.result) : '',
      s.need ? h('span', { class: 'result' }, 'Needs: ' + s.need) : ''))));
  const head = [h('strong', {}, task.goal), ' ', h('span', { class: 'muted' }, `${done}/${total} steps · ${st}`)];
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

export function toolTrail(tools) {
  return h('div', { class: 'tool-trail' }, tools.map(t => h('div', { class: 'tool' + (t.ok === false ? ' fail' : ''), title: t.args ? `${t.name}(${JSON.stringify(t.args)})` : null },
    t.running ? squiggleWait() : h('span', { 'aria-hidden': 'true' }, t.ok === false ? '✕' : '✓'),
    h('span', {}, t.label || t.name, t.error ? h('span', { class: 'tool-error' }, t.error) : null,
      // Saved with Settings → Debug → "Save tool results".
      t.result ? h('details', { class: 'tool-result' }, h('summary', {}, 'Result'), h('pre', {}, t.result)) : null))));
}

export function rerender() {
  renderChat();
  if (state.openThreadId) renderThreadPanel();
}

// ── Composer ───────────────────────────────────────────────────────────────
export function setupComposer(form, input, onSend) {
  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + 'px'; };
  input.addEventListener('input', () => { grow(); syncSendButton(); });
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
    const text = input.value.trim();
    if (state.busy && steers(form) && text) { state.brainstorm.steer.push(text); input.value = ''; grow(); renderBrainstormBar(); syncSendButton(); return; }
    if (state.busy) { state.controller && state.controller.abort(); return; }
    if (!text && !files.length) return;
    const sending = files;
    input.value = ''; grow();
    files = []; renderChips(); notice.hidden = true;
    onSend(text, sending);
  });
}

function setBusy(on) {
  state.busy = on;
  keepAwake('reply', on);   // a phone that sleeps mid-reply loses the GPU (iOS Safari)
  syncSendButton();
  renderSide();
  renderBrainstormBar();
}

// Stop while a reply runs; during a brainstorm, typed text turns it back into Send (to steer).
// Typing in the main composer during a brainstorm in the open chat steers it; a thread's composer never does.
const steers = (form) => Boolean(form.id === 'composer' && state.brainstorm && state.brainstorm.session === state.current);

function syncSendButton() {
  for (const btn of document.querySelectorAll('.composer button[type="submit"]')) {
    const input = btn.closest('form').querySelector('textarea');
    const stop = state.busy && !(steers(btn.closest('form')) && input && input.value.trim());
    btn.replaceChildren(icon(stop ? 'i-stop' : 'i-send'));
    btn.setAttribute('aria-label', stop ? 'Stop' : 'Send');
  }
}

// ── A turn ─────────────────────────────────────────────────────────────────
export async function send(text, threadId, files = [], opts = {}) {
  if (state.busy) return;
  await useSessionModel(state.current);
  if (state.modelState !== 'ready') {
    if (loadCrashMarker()) return; // the crash banner is showing; let the person choose
    const ok = await ensureModel();
    if (!ok) return;
  }
  const session = state.current;
  if (session.brainstorm && !threadId) return runBrainstorm(text, files, opts);
  // The first message settles the chat's context type: what was picked, or the default (it's shown, not changed, after).
  if (!session.contextMode && !session.messages.some(m => !m.deleted)) session.contextMode = agent.settings.defaultContextMode || 'compact';
  const container = threadId ? $('#thread-messages') : $('#messages-inner');
  const scroller = threadId ? $('#thread-scroll') : $('#messages');
  if (!threadId && !session.messages.some(m => !m.thread)) container.replaceChildren();
  let live = null, body = null, trail = null, think = null, plan = null;
  const smooth = smoothText((t) => { body.innerHTML = md(t); scrollDown(scroller); });
  const vc = !threadId && state.call ? state.call.ctl : null; // a voice call speaks this reply as it streams
  const liveTools = [];
  if (!threadId) state.liveTurn = { ctx: null, tools: liveTools, task: null };
  setBusy(true);
  const controller = state.controller = new AbortController();
  try {
    const atts = await readFiles(files, session);
    await agent.runTurn({
      session, threadId, text, attachments: atts, signal: controller.signal,
      ui: {
        onUser: (m) => { container.append(messageEl(m, { inThread: Boolean(threadId) })); scrollDown(scroller, { force: true }); renderSessions(); },
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
        onText: (t) => { const clean = agent.scrubFakeToolNotes(t); smooth.feed(clean); if (vc) vc.feed(clean); },
        onTool: (t) => {
          if (t.name === 'note' && !t.running && state.drawerPanel === 'notes') renderNotesPanel();
          const existing = liveTools.find(x => x.running && x.name === t.name);
          if (existing) Object.assign(existing, t); else liveTools.push({ ...t });
          trail.replaceChildren(toolTrail(liveTools));
          scrollDown(scroller);
          if (!threadId) renderSide();
        },
        onPlan: (task) => { plan.hidden = false; plan.replaceChildren(planEl(task, { live: true })); scrollDown(scroller); if (!threadId) { state.liveTurn.task = task; renderSide(); } },
        onContext: (ctx) => { if (!threadId) { state.liveTurn.ctx = ctx; renderSide(); } },
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
        onDone: (m) => { smooth.stop(); if (vc) vc.finish(agent.scrubFakeToolNotes(m.content)); live.replaceWith(messageEl(m, { inThread: Boolean(threadId), session })); if (!threadId) $('#chat-title').textContent = session.title; state.liveTurn = null; renderSide(); },
      },
    });
  } finally {
    smooth.stop();
    setBusy(false);
    state.controller = null;
    if (!threadId) { state.liveTurn = null; renderSide(); }
    if (threadId) renderChat(); // refresh reply count on the parent
    updateComposerNote();       // small models: the last reply's speed
  }
}

// Reads the chosen files (PDF text extraction can take a moment).
async function readFiles(files, session) {
  const out = [];
  const taken = new Set(session.messages.flatMap(m => (m.attachments || []).map(a => String(a.path || a.name).split('/').pop().toLowerCase())));
  for (const f of files) out.push(await attachments.readAttachment(f, taken, session.id));
  return out;
}

// ── Brainstorm chats (brainstorm.js) ───────────────────────────────────────
// The bar over the composer: what's running and a Stop button, or Keep going once it has stopped.
function renderBrainstormBar() {
  const form = $('#composer');
  let bar = form.querySelector('.brainstorm-bar');
  const session = state.current;
  const on = Boolean(session && session.brainstorm);
  if (!bar) { bar = h('div', { class: 'brainstorm-bar', hidden: true }); form.insertBefore(bar, form.querySelector('.composer-inner')); }
  $('#input').placeholder = !on ? 'Message Squiggle' : session.messages.some(m => !m.deleted) ? 'Jump in to steer the brainstorm' : 'Pitch an idea to brainstorm';
  const run = state.brainstorm && state.brainstorm.session === session ? state.brainstorm : null;
  const started = on && session.messages.some(m => m.role === 'assistant' && m.voice && !m.deleted);
  bar.hidden = !(run || (started && !state.busy));
  if (bar.hidden) return;
  // The wrap-up (summary and decision) is the transcript framing's: asked for while it runs, it comes after this turn.
  const wraps = brainstorm.framingOf(session) === 'transcript';
  const note = run && run.wrap ? ' · wrapping up after this turn' : run && run.steer.length ? ` · you'll jump in after this turn` : '';
  const wrapBtn = (onclick) => (wraps ? h('button', { type: 'button', class: 'btn wrap-btn', onclick }, 'Wrap up') : '');
  bar.replaceChildren(...(run
    ? [squiggleWait(), h('span', {}, `Brainstorming${note}`), run.wrap ? '' : wrapBtn(() => { run.wrap = true; renderBrainstormBar(); }),
      h('button', { type: 'button', class: 'btn main-btn', onclick: () => state.controller && state.controller.abort() }, icon('i-stop'), 'Stop')]
    : [h('span', { class: 'muted' }, 'Brainstorm stopped.'),
      wrapBtn((e) => { e.currentTarget.disabled = true; send('', null, [], { wrap: true }); }),
      h('button', { type: 'button', class: 'btn main-btn', onclick: (e) => { e.currentTarget.disabled = true; send('', null, []); } }, 'Keep going')]));
}

// "Squiggle A · listing options": which voice, and which phase of the brainstorm (transcript framing).
const voiceLabel = (v, phase) => (brainstorm.VOICES[v] || v) + (brainstorm.PHASES[phase] ? ` · ${brainstorm.PHASES[phase]}` : '');

async function runBrainstorm(text, files, { wrap = false } = {}) {
  if (state.brainstorm) return;   // one run at a time (a second Keep going while the model loaded)
  const session = state.current;
  if (files.length) toast('Brainstorms don\'t read attachments; sending just the text.');
  const container = $('#messages-inner');
  const scroller = $('#messages');
  const here = () => state.current === session;
  if (text) {
    if (!session.messages.some(m => !m.deleted)) { container.replaceChildren(); session.title = text.replace(/\s+/g, ' ').slice(0, 60); $('#chat-title').textContent = session.title; }
    const m = sessions.addMessage(session, { role: 'user', content: text });
    container.append(messageEl(m, { inThread: false }));
    scrollDown(scroller, { force: true });
    renderSessions();
  }
  if (!session.messages.some(m => m.role === 'user' && !m.deleted)) return;
  const controller = state.controller = new AbortController();
  const run = state.brainstorm = { session, steer: [], wrap: false };
  setBusy(true);
  let live = null, body = null, smooth = null, trail = null;
  try {
    const why = await brainstorm.run({
      session, signal: controller.signal,
      wrapOnly: wrap, wantsWrap: () => run.wrap,
      takeSteer: () => { const t = run.steer.splice(0).join('\n\n'); renderBrainstormBar(); return t; },
      ui: {
        onSteer: (m) => { if (here()) { $('#messages-inner').append(messageEl(m, { inThread: false })); scrollDown(scroller, { force: true }); } },
        onStart: (v, phase) => {
          if (!here()) return;
          body = h('div', { class: 'body' }, squiggleWait());
          trail = h('div');   // what this voice looks up, as it goes
          live = h('div', { class: `msg assistant voice-${v.toLowerCase()}` }, h('div', {}, h('div', { class: 'voice-label' }, voiceLabel(v, phase)), trail, body));
          smooth = smoothText((t) => { body.innerHTML = md(t); if (here() && live && live.isConnected) scrollDown(scroller); });
          $('#messages-inner').append(live);
          scrollDown(scroller);
        },
        onText: (t) => smooth && smooth.feed(t),
        onTool: (recs) => { if (trail) { trail.replaceChildren(toolTrail(recs)); if (here()) scrollDown(scroller); } },
        onDone: (m) => {
          if (smooth) smooth.stop();
          // Left and came back mid-turn: the list was redrawn without the live turn, so the finished one is added.
          if (live && live.isConnected) { if (m) live.replaceWith(messageEl(m, { inThread: false, session })); else live.remove(); }
          else if (m && here()) { $('#messages-inner').append(messageEl(m, { inThread: false, session })); scrollDown(scroller); }
          live = body = smooth = null;
        },
      },
    });
    const wrapped = brainstorm.framingOf(session) === 'transcript' ? ' and wrapped up' : '';
    if (why === 'limit') toast(`Paused after ${brainstorm.MAX_TURNS} turns${wrapped}. Keep going or jump in to carry on.`);
    if (why === 'stuck') toast(`A voice kept repeating an earlier turn, so it stopped there${wrapped}. Jump in to steer it somewhere new, or Keep going.`);
  } finally {
    if (smooth) smooth.stop();
    // Typed to jump in, but the run ended first (Stop, the turn limit, an error): it's kept, and the next run starts from it.
    if (run.steer.length) sessions.addMessage(session, { role: 'user', content: run.steer.splice(0).join('\n\n') });
    if (state.brainstorm === run) state.brainstorm = null;
    if (state.controller === controller) state.controller = null;
    setBusy(false);
    sessions.flush();
    if (here()) rerender();
  }
}
