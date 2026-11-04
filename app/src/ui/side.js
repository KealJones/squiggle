// Chat details sidebar (#ctx-side): model and how it runs, the context window
// (what the last call was made of, live while a reply runs), the plan, and
// what this chat used and made. Always there on wide screens (collapsible);
// an overlay on narrow ones. See CLAUDE.md "Chat details sidebar".
import * as sessions from '../sessions.js';
import * as tasks from '../tasks.js';
import * as engine from '../engine.js';
import * as agent from '../agent.js';
import { fmtSize } from '../attachments.js';
import { contextMode } from '../context.js';
import { $, h, icon, fmtTok, fmtPct, toast } from './dom.js';
import { state } from './state.js';
import { planEl } from './chat.js';
import { openPanel } from './panels.js';
import { smallHow, sessionModel, switchModel } from './model-ui.js';
import { openSession, renderSessions } from './chat.js';

const SIDE_KEY = 'squiggle-side';
export const sideOverlay = () => matchMedia('(max-width: 1199px)').matches;
export function sideOpenPref() {
  let v = null;
  try { v = localStorage.getItem(SIDE_KEY); } catch {}
  return v == null ? !sideOverlay() : v === 'open';
}
export function setSideOpen(open, remember = true) {
  $('#ctx-side').hidden = !open;
  $('#toggle-side').setAttribute('aria-expanded', String(open));
  // On narrow screens it's an overlay: opening it there isn't a standing choice.
  if (remember && !sideOverlay()) try { localStorage.setItem(SIDE_KEY, open ? 'open' : 'closed'); } catch {}
  if (open) renderSide();
}

const PARTS = [
  ['instructions', 'Instructions'], ['tools', 'Tool definitions'], ['conversation', 'Conversation'], ['memory', 'Memory & notes'],
  ['recalled', 'Recalled'], ['message', 'Request'], ['turn', 'This turn'],
];

// Sections remember being collapsed (per device).
function sideSection(key, title, aside, ...body) {
  let closed = [];
  try { closed = JSON.parse(localStorage.getItem(SIDE_KEY + '-closed') || '[]'); } catch {}
  const d = h('details', { class: 'side-sec', 'data-sec': key }, h('summary', {}, title, aside ? h('span', { class: 'aside' }, aside) : ''), h('div', { class: 'sec-body' }, ...body));
  d.open = !closed.includes(key);
  d.addEventListener('toggle', () => {
    let c = [];
    try { c = JSON.parse(localStorage.getItem(SIDE_KEY + '-closed') || '[]'); } catch {}
    c = c.filter(k => k !== key);
    if (!d.open) c.push(key);
    try { localStorage.setItem(SIDE_KEY + '-closed', JSON.stringify(c)); } catch {}
  });
  return d;
}

let sideFrame = 0;
export function renderSide() {
  if (sideFrame || !$('#ctx-side') || $('#ctx-side').hidden) return;
  // A microtask, not a frame or a timer: updates in one burst draw once, and it still draws
  // when the turn never yields to the event loop (a hidden tab, or a model that answers instantly).
  sideFrame = 1;
  queueMicrotask(() => { sideFrame = 0; drawSide(); });
}

function drawSide() {
  const body = $('#ctx-side-body');
  if (!body || !state.current) return;
  const line = sessions.lineMessages(state.current, null);
  const lastCtx = [...line].reverse().find(m => m.role === 'assistant' && m.context);
  const liveTurn = state.liveTurn;
  const ctx = (liveTurn && liveTurn.ctx) || (lastCtx && lastCtx.context) || null;
  const open = [...body.querySelectorAll('.side-sec')].map(d => d.dataset.sec);
  const scroll = body.scrollTop;
  const lastReply = [...line].reverse().find(m => m.role === 'assistant');
  body.replaceChildren(sideModel(lastReply), sideContext(ctx, liveTurn && liveTurn.ctx ? null : lastCtx), sideProgress(line), ...sideUsage(line), sideNotes(), sideActions());
  if (open.length) body.scrollTop = scroll;
}

function sideModel(lastReply) {
  const items = [];
  const M = engine.MODELS[agent.settings.model];
  if (M) {
    const cloud = M.runtime === 'cloud';
    items.push(['Model', M.label], ['Runs', cloud ? 'Cloudflare relay (free daily limit)' : `this device${smallHow()}`]);
  }
  items.push(['Status', state.modelState === 'ready' ? (state.busy ? 'replying' : 'ready') : state.modelState]);
  items.push(['Context', contextMode(agent.settings.contextMode).short]);
  if (agent.smallModeSwitchable() && agent.smallMode()) items.push(['Mode', 'Small-model']);
  // Replies save which model wrote them (agent.js replyModel); shown when it isn't the current one.
  const rm = lastReply && lastReply.model;
  if (rm && rm.id && rm.id !== agent.settings.model) items.push(['Last reply by', `${rm.label || rm.id}${rm.how ? ` (${rm.how})` : ''}`]);
  const kv = h('dl', { class: 'kv' }, items.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  // Which model this chat uses: the device default, or its own.
  const session = state.current;
  const ids = Object.keys(engine.MODELS).filter(id => engine.modelFitsDevice(id) && (!engine.MODELS[id].needsRelay || state.cloudOffered));
  const def = engine.MODELS[agent.settings.defaultModel] ? agent.settings.defaultModel : agent.settings.model;
  const pick = h('select', { class: 'side-select', 'aria-label': 'Model for this chat', disabled: state.busy ? true : null, onchange: async (e) => {
    const v = e.target.value;
    if (v) session.model = v; else delete session.model;
    sessions.touch(session);
    await switchModel(sessionModel(session));
    renderSide();
  } },
    h('option', { value: '', selected: !session.model ? true : null }, `Default (${engine.MODELS[def] ? engine.MODELS[def].label : def})`),
    ...ids.map(id => h('option', { value: id, selected: session.model === id ? true : null }, engine.MODELS[id].label)));
  const chooser = h('div', { class: 'side-field' }, h('label', {}, 'Model for this chat'), pick,
    h('span', { class: 'side-hint' }, session.model ? 'This chat always uses this model; other chats keep the default.' : 'Change the default in Settings.'));
  if (M && M.runtime !== 'cloud' && engine.isLite() && state.modelState === 'ready') engine.smallSpeed().then((sp) => {
    if (!sp || !kv.isConnected) return;
    kv.append(h('dt', {}, 'Last reply'), h('dd', {}, `first token ${(sp.waitMs / 1000).toFixed(1)} s${sp.perSec ? `, ${sp.perSec} tok/s` : ''}`));
  }).catch(() => {});
  return sideSection('model', 'Model', '', kv, chooser);
}

function sideContext(ctx, msg) {
  if (!ctx) return sideSection('context', 'Context', '', h('p', { class: 'empty-line' }, 'Send a message to see what goes into the model\'s context.'));
  const w = ctx.window;
  const link = msg ? h('button', { class: 'side-link', onclick: () => openPanel('context', msg) }, icon('i-eye'), 'What the model saw') : '';
  if (!w) {
    // Replies saved before the breakdown existed: just the total.
    const size = ctx.budget || agent.settings.contextSize;
    return sideSection('context', 'Context', fmtPct(ctx.used || 0, size),
      h('p', { class: 'ctx-total' }, `${fmtTok(ctx.used || 0)} of ${fmtTok(size)} tokens`),
      h('div', { class: 'ctx-bar' }, h('span', { style: `width:${Math.min(100, 100 * (ctx.used || 0) / (size || 1))}%;background:var(--part-conversation)` })), link);
  }
  const used = Math.min(w.used || 0, w.size);
  const free = Math.max(0, w.size - (w.used || 0));
  const shown = PARTS.filter(([k]) => (w.parts[k] || 0) > 0);
  return sideSection('context', 'Context', `${fmtPct(used, w.size)} used`,
    h('p', { class: 'ctx-total', title: `${(w.used || 0).toLocaleString()} of ${w.size.toLocaleString()} tokens (estimated)` }, `${fmtTok(w.used || 0)} of ${fmtTok(w.size)} tokens`),
    h('div', { class: 'ctx-bar', role: 'img', 'aria-label': `${fmtPct(used, w.size)} of the context window used` },
      shown.map(([k, label]) => h('span', { title: `${label}: ${fmtTok(w.parts[k])}`, style: `width:${100 * w.parts[k] / w.size}%;background:var(--part-${k})` }))),
    h('ul', { class: 'ctx-rows' },
      shown.map(([k, label]) => h('li', {}, h('span', { class: 'sw', style: `background:var(--part-${k})` }), h('span', {}, label), h('span', { class: 'n' }, fmtTok(w.parts[k])), h('span', { class: 'p' }, fmtPct(w.parts[k], w.size)))),
      h('li', {}, h('span', { class: 'sw free' }), h('span', {}, 'Free space'), h('span', { class: 'n' }, fmtTok(free)), h('span', { class: 'p' }, fmtPct(free, w.size)))),
    ctx.mode === 'step' ? h('p', { class: 'ctx-note' }, 'Plan step: each step starts with a fresh context.') : '',
    link);
}

function sideProgress(line) {
  const current = state.current, liveTurn = state.liveTurn;
  const task = (liveTurn && liveTurn.task) || (() => {
    const m = [...line].reverse().find(x => x.task && current.tasks && current.tasks[x.task]);
    return m ? current.tasks[m.task] : null;
  })();
  if (!task) return sideSection('progress', 'Progress', '', h('p', { class: 'empty-line' }, 'No plan yet. Longer jobs get a step list here.'));
  const { done, total } = tasks.progress(task);
  const el = planEl(task, { live: Boolean(liveTurn) });
  if (el.tagName === 'DETAILS') el.open = true;  // a finished plan: still show the steps here
  return sideSection('progress', 'Progress', `${done}/${total}`, el);
}

// The agent's notepad for this chat (read-only; it edits them with the note tool).
function sideNotes() {
  const notes = state.current ? sessions.liveNotes(state.current) : [];
  const link = h('button', { class: 'side-link', onclick: () => openPanel('notes') }, icon('i-note'), 'Open notes');
  return sideSection('notes', 'Notes', notes.length ? String(notes.length) : '',
    notes.length ? h('ul', { class: 'use-list notes' }, notes.slice(-6).map(n => h('li', {}, h('span', { class: 'label', title: n.text }, n.text)))) : h('p', { class: 'empty-line' }, 'The agent keeps short notes here while it works.'),
    notes.length ? link : '');
}

// Archive or delete this chat.
function sideActions() {
  const s = state.current;
  const archive = h('button', { class: 'btn', onclick: () => {
    sessions.archive(s, !s.archived);
    toast(s.archived ? 'Chat archived.' : 'Chat restored.');
    if (s.archived) openSession(sessions.list()[0] || sessions.newSession()); else { renderSessions(); renderSide(); }
  } }, icon('i-archive'), s.archived ? 'Unarchive' : 'Archive');
  const del = h('button', { class: 'btn danger', onclick: () => {
    if (!confirm(`Delete "${s.title}"? This removes the chat from all your devices.`)) return;
    sessions.remove(s);
    toast('Chat deleted.');
    openSession(sessions.list()[0] || sessions.newSession());
  } }, icon('i-trash'), 'Delete');
  return sideSection('actions', 'This chat', s.archived ? 'archived' : '', h('div', { class: 'row side-actions' }, archive, del));
}

// Tools grouped by name, plus what came in (attachments, pages, repos) and what went out (files, commits, pushes, PRs).
const HARNESS_TOOLS = new Set(['plan', 'done', 'checkpoint']);
const OUTPUT_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'git_commit', 'git_push', 'git_branch', 'github_open_pr', 'remember', 'note']);
function sideUsage(line) {
  const liveTurn = state.liveTurn;
  // The harness's own bookkeeping (plan, done, checkpoint) isn't a tool the chat "used".
  const tools = line.flatMap(m => m.tools || []).filter(t => !HARNESS_TOOLS.has(t.name));
  if (liveTurn) tools.push(...liveTurn.tools.filter(t => !t.running && !HARNESS_TOOLS.has(t.name)));
  const counts = new Map();
  for (const t of tools) {
    const c = counts.get(t.name) || { n: 0, fail: 0 };
    c.n++; if (t.ok === false) c.fail++;
    counts.set(t.name, c);
  }
  const files = line.flatMap(m => m.attachments || []);
  const pages = [...new Set(tools.filter(t => t.name === 'fetch_url' && t.ok !== false && t.args && t.args.url).map(t => t.args.url))];
  const used = [];
  if (files.length) used.push(...files.map(a => h('li', {}, icon('i-attach'), h('span', { class: 'label', title: a.name }, a.name), h('span', { class: 'count' }, fmtSize(a.size)))));
  if (pages.length) used.push(...pages.slice(-8).map(u => h('li', {}, h('span', { class: 'label', title: u }, u.replace(/^https?:\/\//, '')))));
  const toolRows = [...counts].sort((a, b) => b[1].n - a[1].n)
    .map(([name, c]) => h('li', {}, h('span', { class: 'label' }, name), c.fail ? h('span', { class: 'fail', title: `${c.fail} failed` }, `${c.fail}✕`) : '', h('span', { class: 'count' }, `×${c.n}`)));
  const outs = tools.filter(t => OUTPUT_TOOLS.has(t.name) && t.ok !== false).slice(-12)
    .map(t => h('li', {}, h('span', { class: 'label', title: t.args ? JSON.stringify(t.args) : (t.label || t.name) }, t.label || t.name)));
  return [
    sideSection('used', 'Used in this chat', tools.length ? `${tools.length} call${tools.length === 1 ? '' : 's'}` : '',
      used.length || toolRows.length ? h('ul', { class: 'use-list' }, ...used, ...toolRows) : h('p', { class: 'empty-line' }, 'Nothing yet: tools, files and pages show up here.')),
    sideSection('outputs', 'Outputs', outs.length ? String(outs.length) : '',
      outs.length ? h('ul', { class: 'use-list' }, ...outs) : h('p', { class: 'empty-line' }, 'Files written, commits, pushes and saved notes show up here.')),
  ];
}
