// The drawer panels: threads, notes, memory (with recipes), files, and
// "what the model saw". Settings has its own module (settings-panel.js).
import * as storage from '../storage.js';
import * as sessions from '../sessions.js';
import * as memory from '../memory.js';
import * as recipes from '../recipes.js';
import { resolveAgentPath } from '../guard.js';
import { pfs, walk } from '../git.js';
import { contextMode } from '../context.js';
import { $, h, icon, ago, iconButton, scrollDown, toast } from './dom.js';
import { traceText } from '../trace.js';
import { estTokens } from '../util.js';
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
  scrollDown(scroll, { force: true });
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
    h('p', { class: 'muted' }, 'How Squiggle solved tasks before, so the next similar request is faster. New ones wait for your OK before Squiggle uses them. Unused recipes are forgotten after 90 days unless pinned.'));
  if (!all.length) { wrap.append(h('p', { class: 'muted' }, 'None yet. When Squiggle finishes a task it made a plan for, it saves how it did it here.')); return wrap; }
  const ul = h('ul', { class: 'fact-list recipe-list' });
  // Possible recipes (waiting for approval) first: Squiggle doesn't use them until they're approved.
  const sorted = [...all.filter(r => r.pending), ...all.filter(r => !r.pending)];
  for (const r of sorted) {
    const used = r.pending ? `possible recipe, saved ${ago(r.created)}` : r.uses ? `used ${r.uses} time${r.uses === 1 ? '' : 's'}, last ${ago(r.lastUsed)}` : `saved ${ago(r.created)}`;
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
    const li = h('li', { class: r.pending ? 'pending' : null },
      h('details', { class: 'recipe' },
        h('summary', {}, h('span', { class: 'fact' }, r.title), ' ', h('span', { class: 'muted' }, used), r.pending ? h('span', { class: 'auto' }, 'Needs your OK') : '', r.pinned ? h('span', { class: 'auto' }, 'Pinned') : ''),
        r.when ? h('p', { class: 'muted' }, 'For: ' + r.when) : '', steps,
        r.specifics && r.specifics.length ? h('p', { class: 'muted' }, r.specifics.join(' · ')) : ''),
      h('div', { class: 'recipe-actions' },
        r.pending ? h('button', { class: 'btn primary small', title: 'Use this recipe for similar requests', onclick: () => recipes.approve(r.id) }, 'Approve') : '',
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
const KINDS = { actions: 'Earlier tool calls', system: 'Instructions', recent: 'Recent messages', pinned: 'Pinned', summary: 'Summary', fact: 'Memory', message: 'Earlier message', observation: 'Saved tool output', thread: 'Thread outcome', refs: 'Resolved references', recipe: 'Recipe', plan: 'Plan (step prompt)', chat: 'Another chat', note: 'Note', web: 'Web search' };
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
    fullContext(m),
  );
  c.append(body);
}

// The whole context, exactly as sent (trace.js): every conversation of the turn with its system prompt, tool
// schemas, starting messages and each round in and out, loaded from the reply's own file in the storage repo.
function fullContext(m) {
  const box = h('section', { class: 'trace' }, h('h3', {}, 'Everything the model was sent'));
  if (!m.trace) {
    box.append(h('p', { class: 'muted' }, 'Not saved for this reply. Turn on Settings → Lab → "Save tool results and prompts" to keep the full context of new replies.'));
    return box;
  }
  const status = h('p', { class: 'muted' }, 'Loading…');
  box.append(status);
  // Written in the background as the reply finishes, so it may land a moment after the panel opens.
  const readSoon = async (tries = 10) => { for (let i = 0; i < tries; i++) { const t = await storage.read(m.trace); if (t) return t; await new Promise(r => setTimeout(r, 300)); } return null; };
  readSoon().then((text) => {
    let t = null;
    try { t = JSON.parse(text); } catch {}
    if (!t || !t.convs) { status.textContent = 'The saved context isn\'t on this device yet (it syncs with the chat).'; return; }
    const pre = (s) => h('pre', { class: 'trace-pre' }, typeof s === 'string' ? s : JSON.stringify(s, null, 1));
    const msg = (x) => h('div', { class: 'trace-msg' }, h('div', { class: 'kind' }, `${x.role || 'message'}${x.name ? ' · ' + x.name : ''}`),
      x.content != null && x.content !== '' ? pre(x.content) : '', x.tool_calls && x.tool_calls.length ? pre({ tool_calls: x.tool_calls }) : '');
    const list = (input) => (Array.isArray(input) ? input : [input]).map(x => (x && typeof x === 'object' && x.role ? msg(x) : pre(x)));
    const copy = h('button', { class: 'btn small', onclick: async () => {
      try { await navigator.clipboard.writeText(traceText(t)); toast('Copied the whole context.'); } catch { toast('Couldn\'t copy here.'); }
    } }, 'Copy all as text');
    status.replaceWith(h('div', { class: 'row', style: 'margin:4px 0 10px' }, copy,
      h('span', { class: 'muted' }, `${t.convs.length} conversation${t.convs.length === 1 ? '' : 's'}, about ${estTokens(traceText(t))} tokens in all`)));
    t.convs.forEach((c, i) => {
      const d = h('details', { class: 'trace-conv' }, h('summary', {}, `${i + 1}. ${c.phase}`, h('span', { class: 'muted' }, ` · ${c.rounds.length} round${c.rounds.length === 1 ? '' : 's'}${c.model ? ' · ' + c.model : ''}`)));
      d.open = t.convs.length === 1;
      d.append(
        h('details', {}, h('summary', {}, `System prompt (about ${estTokens(c.system)} tokens)`), pre(c.system || '(none)')),
        c.declared.length ? h('details', {}, h('summary', {}, `Tools declared in full (${c.declared.length}, about ${estTokens(JSON.stringify(c.declared.map(n => t.tools[n])))} tokens)`),
          ...c.declared.map(n => h('details', { class: 'trace-tool' }, h('summary', {}, n), pre(t.tools[n] || n)))) : '',
        c.named.length ? h('p', { class: 'trace-named' }, h('span', { class: 'kind' }, 'Listed by name only: '), c.named.join(', ')) : '',
        c.messages && c.messages.length ? h('details', {}, h('summary', {}, `Messages it started with (${c.messages.length})`), ...c.messages.map(msg)) : '',
        ...c.rounds.map((r, j) => h('details', { class: 'trace-round' }, h('summary', {}, `Round ${j + 1}`, h('span', { class: 'muted' }, r.output && r.output.toolCalls && r.output.toolCalls.length ? ` · called ${r.output.toolCalls.map(x => (x.function && x.function.name) || x.name).join(', ')}` : r.output && r.output.text ? ' · replied' : '')),
          h('div', { class: 'kind' }, 'Sent'), ...list(r.input),
          r.added ? h('p', { class: 'muted' }, `Declared with this input: ${r.added.join(', ')}`) : '',
          r.rendered ? h('details', {}, h('summary', {}, `Exact ${r.rendered.kind}`), pre(r.rendered.text)) : '',
          h('div', { class: 'kind' }, 'The model wrote'),
          r.output && r.output.thinking ? h('details', {}, h('summary', {}, 'Thinking'), pre(r.output.thinking)) : '',
          r.output && r.output.text ? pre(r.output.text) : '',
          r.output && r.output.toolCalls && r.output.toolCalls.length ? pre(r.output.toolCalls) : '')),
      );
      box.append(d);
    });
  }).catch((e) => { status.textContent = `Couldn't load it: ${e.message || e}`; });
  return box;
}
