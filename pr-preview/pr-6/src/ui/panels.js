// The drawer panels: threads, notes, memory (with recipes), files, and
// "what the model saw". Settings has its own module (settings-panel.js).
import * as storage from '../storage.js';
import * as sessions from '../sessions.js';
import * as memory from '../memory.js';
import * as recipes from '../recipes.js';
import { resolveAgentPath } from '../guard.js';
import { pfs, walk } from '../git.js';
import { contextMode } from '../context.js';
import { $, h, icon, ago, iconButton, scrollDown } from './dom.js';
import { state } from './state.js';
import { messageEl, setupComposer, send } from './chat.js';
import { renderSettingsPanel } from './settings-panel.js';

export function openDrawer(title, panel) {
  state.drawerPanel = panel;
  $('#drawer').hidden = false;
  $('#drawer-title').textContent = title;
  const c = $('#drawer-content');
  c.replaceChildren();
  return c;
}

export function closeDrawer() {
  $('#drawer').hidden = true;
  state.drawerPanel = null;
  state.openThreadId = null;
}

export function openPanel(name, arg) {
  if (name === 'notes') renderNotesPanel();
  else if (name === 'memory') renderMemoryPanel();
  else if (name === 'files') renderFilesPanel('/home');
  else if (name === 'settings') renderSettingsPanel();
  else if (name === 'context') renderContextPanel(arg);
}

// ── Threads ────────────────────────────────────────────────────────────────
export function openThread(threadId, focusId, parentMsg) {
  if (!threadId && parentMsg) {
    const existing = sessions.threadOf(state.current, parentMsg.id);
    threadId = existing ? existing.id : sessions.startThread(state.current, parentMsg).id;
  }
  state.openThreadId = threadId;
  renderThreadPanel(true);
  if (focusId) requestAnimationFrame(() => document.querySelector(`#thread-messages [data-mid="${focusId}"]`)?.scrollIntoView({ block: 'center' }));
}

export function renderThreadPanel(focus = false) {
  const current = state.current;
  const t = current.threads[state.openThreadId];
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
  const form = h('form', { class: 'composer' }, h('div', { class: 'composer-inner' }, input, h('button', { class: 'icon-btn', type: 'submit', 'aria-label': 'Send' }, icon(state.busy ? 'i-stop' : 'i-send'))));
  setupComposer(form, input, (text, files) => send(text, t.id, files));
  c.append(scroll, form);
  scrollDown(scroll);
  if (focus) input.focus();
}

// ── Notes ──────────────────────────────────────────────────────────────────
// The agent's notepad for the open chat (read-only here; the agent edits it).
export function renderNotesPanel() {
  const c = openDrawer('Notes', 'notes');
  const notes = state.current ? sessions.liveNotes(state.current) : [];
  const body = h('div', { class: 'drawer-body' },
    h('p', { class: 'hint' }, 'What the agent chose to remember for this chat. It adds, updates and erases these as it works; they\'re always in its context, instead of old tool output.'),
    notes.length
      ? h('ul', { class: 'fact-list notes-list' }, notes.map(n => h('li', {},
          h('div', { class: 'fact' }, h('span', { class: 'muted' }, n.id + ' · ' + new Date(n.mts || n.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })), h('div', { class: 'note-text' }, n.text)))))
      : h('p', { class: 'muted' }, 'No notes yet in this chat.'));
  c.append(body);
}

// ── Memory ─────────────────────────────────────────────────────────────────
export function renderMemoryPanel() {
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

// ── Files (read-only browser of the agent's workspace) ─────────────────────
export async function renderFilesPanel(path) {
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

// ── What the model saw ─────────────────────────────────────────────────────
const KINDS = { actions: 'Earlier tool calls', system: 'Instructions', recent: 'Recent messages', pinned: 'Pinned', summary: 'Summary', fact: 'Memory', message: 'Earlier message', observation: 'Saved tool output', thread: 'Thread outcome', refs: 'Resolved references', recipe: 'Recipe', plan: 'Plan (step prompt)', chat: 'Another chat', note: 'Note' };
function renderContextPanel(m) {
  const c = openDrawer('What the model saw', 'context');
  const r = m.context;
  const body = h('div', { class: 'drawer-body' });
  const pct = Math.min(100, Math.round(100 * (r.used || 0) / (r.budget || 1)));
  const how = r.mode === 'step' ? 'Last step\'s prompt' : r.mode === 'smart' ? 'Smart context' : r.mode === 'full' ? 'Full history' : r.mode === 'compact' || r.mode === 'managed' ? 'Compaction' : `${contextMode(r.mode).label} context`;
  body.append(
    h('p', { style: 'margin-top:0' }, `${how}: about ${r.used} of ${r.budget} tokens.`),
    h('div', { class: 'meter' }, h('div', { style: `width:${pct}%` })),
    ...r.items.map(it => h('div', { class: 'ctx-item' },
      h('div', {}, h('div', { class: 'kind' }, KINDS[it.kind] || it.kind, it.placed ? ` · ${it.placed}` : '', it.score != null ? ` · relevance ${it.score}` : ''), h('div', {}, it.label)),
      h('div', { class: 'tok' }, `${it.tokens} tok`))),
    r.recalled ? h('details', {}, h('summary', {}, 'Recalled block (sent after your message)'), h('pre', { class: 'ctx-recalled' }, r.recalled)) : '',
    r.dropped ? h('p', { class: 'muted' }, `${r.dropped} older message${r.dropped === 1 ? ' was' : 's were'} left out. Pin a message to always include it.`) : '',
  );
  c.append(body);
}
