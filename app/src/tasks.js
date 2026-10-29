// Task state for step mode (docs/harness.md, "Task state" and "Step prompt").
// A task is a goal plus a plan of steps; the agent works one step at a time
// with a fresh prompt per step, so a small context can finish a long job.
// Pure data work (no storage, no engine) so it runs in node tests; agent.js
// owns the loop and saves tasks on the session.
//
//   session.tasks[id] = { id, msg, thread, goal, request, created, updated, mts,
//     status: 'active' | 'done' | 'stopped',
//     steps: [{ id, text, status: 'todo' | 'active' | 'done' | 'blocked', result?, need?, calls,
//               needs?: ['step:1' | 'note:<id>' | 'file:<path>[:a-b]' | 'find:<query>'], kind?: 'summarize',
//               checkpoint?: { summary, needs, next } }],   (needs/kind/checkpoint: AI-managed context)
//     recipe?, waiting?, answers?: [{ q, a }], log: [{ step, name, args, ok, label, text }], tools: [name] }
import { uid, estTokens } from './util.js';

const truncate = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };

export const STEP_SOFT_CAP = 12;   // tool calls in one step before the model is told to wrap the step up
export const STEP_HARD_CAP = 18;   // after this the step is closed with what it has
export const CHECK_IN_EVERY = 60;  // tool calls per turn between "Keep going?" check-ins
const MAX_STEPS = 12;
const MAX_LOG = 150;        // calls kept per task (their arguments feed recipes)
const MAX_LOG_TEXT = 40;    // …of which the newest keep their output text
const FULL_RESULTS = 2;     // done steps whose results the step prompt shows in full
const MAX_REVISIONS = 3;    // plan revisions per task; after that the plan stands
export { MAX_REVISIONS };

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = (description) => ({ type: 'string', description });

// The tools the harness adds for every model (answered by agent.js, never by tools.js).
export const HARNESS_SPECS = {
  plan: { name: 'plan', description: 'Make a plan for a request that takes more than one step, then work it one step at a time. Calling it again revises the plan; finished steps keep their results.', parameters: S({ goal: str('What the user wants, in one line'), steps: { type: 'array', items: { type: 'string' }, description: 'Short imperative steps, e.g. "Find where the login form is defined"' } }, ['goal', 'steps']) },
  done: { name: 'done', description: 'Finish the current step. result = the facts the rest of the task needs (paths, numbers, names, decisions), one to three lines.', parameters: S({ result: str('What this step found or did') }, ['result']) },
  need: { name: 'need', description: 'Say what is missing to go on. Squiggle searches for it, and asks the user if it can\'t be found.', parameters: S({ what: str('What you need, e.g. "which repo the site lives in"') }, ['what']) },
  find: { name: 'find', description: 'Search everything Squiggle knows: tools (and how to call them), recipes from past tasks, memory, past chats and this task\'s earlier results.', parameters: S({ query: str('What you are looking for, in plain words') }, ['query']) },
};
// AI-managed context (docs/harness.md, "the model manages its own context"): plan steps can say what they
// need attached, and `checkpoint` hands off to a fresh context instead of running out.
const NEEDS = { type: 'array', items: { type: 'string' }, description: 'What to attach: "step:2" (that step\'s result), "note:<id>", "file:<path>" or "file:<path>:10-40", "find:<query>"' };
export const MANAGED_SPECS = {
  plan: { name: 'plan', description: 'Make a plan for a request that takes more than one step, then work it one step at a time, each with a fresh view. A step can list what it needs attached (earlier results, files, notes, a search), and a "summarize" step reads something big and keeps only what later steps need. Calling it again revises the plan; finished steps keep their results.',
    parameters: S({ goal: str('What the user wants, in one line'), steps: { type: 'array', items: S({ text: str('Short imperative step, e.g. "Compare the two birth years"'), needs: NEEDS, kind: { type: 'string', enum: ['summarize'], description: 'summarize: read the attached thing and finish with a short summary' } }, ['text']), description: 'The steps in order' } }, ['goal', 'steps']) },
  checkpoint: { name: 'checkpoint', description: 'Running low on room: save where you are and carry on in a fresh context. The fresh one gets the request, your summary, what you list in needs, and next as the instruction. The user sees one continuous reply.',
    parameters: S({ summary: str('What is known and done so far (facts, paths, numbers, unfinished thinking)'), needs: NEEDS, next: str('What to do next') }, ['summary', 'next']) },
};
export const HARNESS = new Set([...Object.keys(HARNESS_SPECS), 'checkpoint']);
export const MAX_CHECKPOINTS = 4;   // per turn; then the person is asked whether to go on

const cleanText = (t) => String(t ?? '').replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').replace(/\s+/g, ' ').trim();
// Steps as given: strings, or { text, needs, kind } objects (AI-managed context).
export function normSteps(steps) {
  if (typeof steps === 'string') { try { const j = JSON.parse(steps); if (Array.isArray(j)) steps = j; } catch {} }
  const list = Array.isArray(steps) ? steps : typeof steps === 'string' ? steps.split(/\n+/) : [];
  return list.map((x) => {
    if (!x || typeof x !== 'object') return { text: cleanText(x) };
    const out = { text: cleanText(x.text || x.step || '') };
    const needs = (Array.isArray(x.needs) ? x.needs : typeof x.needs === 'string' ? x.needs.split(/[,\n]+/) : [])
      .map(n => String(n).trim()).filter(n => parseRef(n)).slice(0, 6);
    if (needs.length) out.needs = needs;
    if (/^summar/i.test(String(x.kind || ''))) out.kind = 'summarize';
    return out;
  }).filter(x => x.text).slice(0, MAX_STEPS);
}
const cleanSteps = (steps) => normSteps(steps).map(x => x.text);
const same = (a, b) => a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function newTask({ msg = null, thread = null, request = '', goal = '', steps = [], recipe = null, now = Date.now() } = {}) {
  const t = { id: uid('k'), msg, thread, request: truncate(String(request || ''), 2000), goal: '', created: now, updated: now, mts: now, status: 'active', steps: [], log: [], tools: [] };
  if (recipe) t.recipe = recipe;
  setPlan(t, goal, steps, now);
  return t;
}

// Starts or revises the plan. Finished steps keep their results: a new step
// with the same text as a done one stays done, and done steps the new plan
// leaves out stay at the front so their findings aren't lost.
export function setPlan(task, goal, steps, now = Date.now()) {
  const items = normSteps(steps);
  if (goal && String(goal).trim()) task.goal = truncate(String(goal).replace(/\s+/g, ' ').trim(), 300);
  if (!task.goal) task.goal = (items[0] && items[0].text) || truncate(task.request, 200);
  const done = task.steps.filter(s => s.status === 'done');
  const used = new Set();
  const next = items.map(({ text, needs, kind }) => {
    const prev = done.find(d => !used.has(d.id) && same(d.text, text));
    if (prev) { used.add(prev.id); return prev; }
    return { id: uid('st'), text, status: 'todo', calls: 0, ...(needs ? { needs } : {}), ...(kind ? { kind } : {}) };
  });
  const kept = done.filter(d => !used.has(d.id));
  task.steps = [...kept, ...next];
  if (!task.steps.length) task.steps = [{ id: uid('st'), text: task.goal, status: 'todo', calls: 0 }];
  touch(task, now);
  return task;
}

export const current = (task) => task && task.steps.find(s => s.status !== 'done') || null;
export const stepIndex = (task, step) => task.steps.indexOf(step);
export const progress = (task) => ({ done: task.steps.filter(s => s.status === 'done').length, total: task.steps.length });
export const isFinished = (task) => task.steps.length > 0 && task.steps.every(s => s.status === 'done');

export function startStep(task, now = Date.now()) {
  const s = current(task);
  if (s && s.status !== 'active') { s.status = 'active'; delete s.need; touch(task, now); }
  return s;
}

export function finishStep(task, result, now = Date.now()) {
  const s = current(task);
  if (!s) return null;
  s.status = 'done';
  s.result = truncate(String(result || '').trim() || '(no result given)', s.kind === 'summarize' ? 1500 : 600);
  delete s.need;
  delete s.checkpoint;
  touch(task, now);
  return s;
}

export function blockStep(task, what, now = Date.now()) {
  const s = current(task);
  if (!s) return null;
  s.status = 'blocked';
  s.need = truncate(String(what || '').trim(), 400);
  touch(task, now);
  return s;
}

// The user's reply to a `need` question: recorded, and the step goes back to work.
export function answerNeed(task, answer, now = Date.now()) {
  const s = task.steps.find(x => x.status === 'blocked');
  task.answers = task.answers || [];
  task.answers.push({ q: s ? s.need : '', a: truncate(String(answer || ''), 1500) });
  if (s) { s.status = 'todo'; delete s.need; }
  task.waiting = false;
  task.status = 'active';
  touch(task, now);
  return s;
}

export function logCall(task, step, { name, args, ok, label, text }, now = Date.now()) {
  task.log.push({ step: step ? step.id : null, name, args: args && typeof args === 'object' ? args : {}, ok: ok !== false, label: label || name, text: truncate(String(text || ''), 1500) });
  if (task.log.length > MAX_LOG) task.log.splice(0, task.log.length - MAX_LOG);
  // Older entries keep their arguments (recipes use them) but drop the output text.
  for (let i = 0; i < task.log.length - MAX_LOG_TEXT; i++) if (task.log[i].text) task.log[i].text = '';
  if (step) step.calls = (step.calls || 0) + 1;
  touch(task, now);   // so the newer log wins when devices merge
}

// Is this the plan we already have (same remaining steps)? Then it's not a revision.
export function samePlan(task, steps) {
  const want = cleanSteps(steps);
  const left = task.steps.filter(s => s.status !== 'done').map(s => s.text);
  const fresh = want.filter(t => !task.steps.some(s => s.status === 'done' && same(s.text, t)));
  return fresh.length === left.length && fresh.every((t, i) => same(t, left[i]));
}

// Finished or stopped tasks older than `days` keep their plan but drop tool
// output, so session files don't grow without end.
export function compactOld(session, now = Date.now(), days = 3) {
  let changed = false;
  for (const t of Object.values(session.tasks || {})) {
    if (t.status === 'active' || (t.updated || 0) > now - days * 86400000) continue;
    for (const l of t.log || []) if (l.text) { l.text = ''; changed = true; }
  }
  return changed;
}

export function touch(task, now = Date.now()) { task.updated = now; task.mts = now; }

// "1. [done] Find the file → app/src/main.js line 40". Only the latest `full`
// done steps show their whole result; older ones are cut to `short` characters
// (find can still fetch them).
export function renderPlan(task, { results = true, full = Infinity, short = 120 } = {}) {
  const now = current(task);
  const done = task.steps.filter(s => s.status === 'done');
  const keep = new Set(done.slice(Math.max(0, done.length - full)));
  return task.steps.map((s, i) => {
    const tag = s.status === 'done' ? 'done' : s === now ? (s.status === 'blocked' ? 'blocked' : 'now') : 'todo';
    const r = s.result ? s.result.replace(/\s+/g, ' ') : '';
    const res = results && s.status === 'done' && r ? ` → ${keep.has(s) ? r : truncate(r, short)}` : '';
    const need = s.status === 'blocked' && s.need ? ` (needs: ${s.need})` : '';
    const att = s.status !== 'done' && s.needs && s.needs.length ? ` [attach: ${s.needs.join(', ')}]` : '';
    return `${i + 1}. [${tag}]${s.kind === 'summarize' ? ' (summarize)' : ''} ${s.text}${res}${need}${att}`;
  }).join('\n');
}

// Items `find` searches for "this task": step results, answers, tool output.
export function taskItems(task) {
  if (!task) return [];
  const items = [];
  for (const s of task.steps) if (s.result) items.push({ id: 'r:' + s.id, source: 'step result', text: `${s.text}: ${s.result}` });
  for (const [i, a] of (task.answers || []).entries()) items.push({ id: 'a:' + i, source: 'user answer', text: `${a.q} — the user said: ${a.a}` });
  for (const [i, l] of task.log.entries()) if (l.text && !HARNESS.has(l.name)) items.push({ id: 'l:' + i, source: 'tool output', text: `${l.label}\n${l.text}` });
  return items;
}

const answersText = (task, n = 3) => (task.answers || []).slice(-n).map(a => `- ${a.q ? truncate(a.q, 160) + ': ' : ''}${truncate(a.a, 500)}`).join('\n');

// System text for one step (docs/harness.md, "Step prompt"). `sections` =
// [{ title, text }] in priority order; empty ones are left out, and when the
// prompt would pass `maxTokens` the lowest-priority sections go first, then
// older step results get shorter. Returns { text, shown: [titles] }.
export function stepPrompt(base, task, sections = [], { maxTokens = Infinity } = {}) {
  const live = sections.filter(s => s && s.text && String(s.text).trim());
  const build = (secs, short) => {
    const out = [base, `## Goal\n${task.goal}`, `## Plan\n${renderPlan(task, { full: FULL_RESULTS, short })}`];
    if (task.answers && task.answers.length) out.push('## The user answered your questions\n' + answersText(task));
    for (const s of secs) out.push(`## ${s.title}\n${String(s.text).trim()}`);
    return out.join('\n\n');
  };
  let secs = live.slice();
  let text = build(secs, 120);
  // Sections marked keep (a checkpoint, attachments the model asked for; already sized) are never dropped.
  const lastDroppable = () => { for (let i = secs.length - 1; i >= 0; i--) if (!secs[i].keep) return i; return -1; };
  for (let i = lastDroppable(); estTokens(text) > maxTokens && i >= 0; i = lastDroppable()) { secs.splice(i, 1); text = build(secs, 120); }
  if (estTokens(text) > maxTokens) text = build(secs, 40);
  return { text, shown: secs.map(s => s.title) };
}
export const stepSystem = (base, task, sections = [], opts) => stepPrompt(base, task, sections, opts).text;

const MAX_REQUEST = 700;
export function stepUser(task, { budget = '' } = {}) {
  const s = current(task);
  const n = stepIndex(task, s) + 1;
  const head = truncate(task.request || task.goal, MAX_REQUEST);
  const tail = budget ? `\n\n${budget}` : '';
  if (s.checkpoint) return `${head}\n\nYou checkpointed step ${n} (${s.text}) to carry on with a fresh context. Carry on now: ${s.checkpoint.next || s.text}\nWhen the step is finished, call done with what you found.${tail}`;
  if (s.kind === 'summarize') return `${head}\n\nWork on step ${n} now (a summarize step): ${s.text}\nRead what's attached, then call done with a short summary: only what the rest of the task needs from it.${tail}`;
  return `${head}\n\nWork on step ${n} now: ${s.text}\nWhen the step is finished, call done with what you found.${tail}`;
}

// ── AI-managed context: references, the budget line, attachments ───────────

// "step:2", "note:n3", "file:/repos/app/src/main.js:610-640", "find:login form". null when it's none of those.
export function parseRef(ref) {
  const m = String(ref || '').trim().match(/^(step|note|file|find)\s*:\s*(.+)$/i);
  if (!m) return null;
  const kind = m[1].toLowerCase(), rest = m[2].trim();
  if (kind === 'step') { const n = parseInt(rest.replace(/^#/, ''), 10); return n > 0 ? { kind, n } : null; }
  if (kind === 'file') {
    const r = rest.match(/^(.*?):(\d+)(?:\s*-\s*(\d+))?$/);
    return r ? { kind, path: r[1], start: +r[2], end: r[3] ? +r[3] : +r[2] } : { kind, path: rest };
  }
  return { kind, [kind === 'note' ? 'id' : 'query']: rest };
}

// The last line before the model writes (docs/harness.md, "A budget line on every prompt").
export const LOW_ROOM = 600;
export function budgetLine(used, total, reserve) {
  const left = Math.max(0, total - used - reserve);
  const r = (x) => Math.max(0, Math.round(x / 10) * 10).toLocaleString('en-US');
  const line = `Context: ${r(used)} of ${total.toLocaleString('en-US')} tokens used (about ${r(left)} left after room for your reply).`;
  return left < LOW_ROOM ? `${line} ${lowRoomNote()}` : line;
}
export const lowRoomNote = () => 'You\'re running low on room. Finish now, or call checkpoint with what you need for the next part.';

// Attachments for a step: [{ ref, text }] → fitted under maxTokens by trimming the largest (head and
// tail kept) and saying what was cut and how to get the rest. Never drops one outright.
export function fitAttachments(items, maxTokens) {
  const out = items.map(x => ({ ...x, text: String(x.text || ''), trimmed: false }));
  const total = () => out.reduce((n, x) => n + estTokens(x.text), 0);
  for (let guard = 0; total() > maxTokens && guard < 20; guard++) {
    const big = out.reduce((a, b) => estTokens(b.text) > estTokens(a.text) ? b : a);
    const over = total() - maxTokens;
    const keep = Math.max(200, (estTokens(big.text) - over - 40) * 3.5);   // characters to keep
    if (big.text.length <= keep + 50) break;
    const head = big.text.slice(0, Math.floor(keep * 0.7)), tail = big.text.slice(big.text.length - Math.floor(keep * 0.3));
    big.text = `${head}\n… (cut to fit: ${big.text.length - head.length - tail.length} characters left out${big.how ? '; ' + big.how : ''}) …\n${tail}`;
    big.trimmed = true;
  }
  return out;
}

export function finalSystem(base, task, { maxTokens = Infinity } = {}) {
  const build = (short) => `${base}\n\n## Goal\n${task.goal}\n\n## What each step found\n${renderPlan(task, { full: 4, short })}${task.answers && task.answers.length ? '\n\n## The user answered\n' + answersText(task) : ''}`;
  let text = build(300);
  if (estTokens(text) > maxTokens) text = build(120);
  if (estTokens(text) > maxTokens) text = build(40);
  return text;
}

export function finalUser(task) {
  return `${truncate(task.request || task.goal, MAX_REQUEST)}\n\nEvery step is done. Write the reply to this request now, using what the steps found. Don't call tools.`;
}

// The task that can pick up again from the new message: only the one the
// latest reply in this conversation line belongs to (`lastTaskId`), when it is
// waiting on an answer, or stopped and the user says to go on. A stopped task
// whose steps are all done resumes straight to its final reply.
const GO_ON = /^\s*(?:ok(?:ay)?[,.!\s]*)?(?:continue|keep going|go on|go ahead|resume|carry on|yes,? (?:continue|keep going))\b/i;
export function resumable(session, threadId, text, lastTaskId) {
  const t = lastTaskId && session.tasks && session.tasks[lastTaskId];
  if (!t || (t.thread || null) !== (threadId || null) || t.status === 'done') return null;
  if (t.waiting) return { task: t, how: 'answer' };
  if (GO_ON.test(String(text || ''))) return { task: t, how: 'continue' };
  return null;
}

// The model's own verdict on the last result, from the Check line of its thinking.
const JUNK = /\b(no (useful |relevant )?(results?|info(rmation)?|answer)|nothing (useful|relevant|about)|not (useful|relevant|helpful)|unrelated|irrelevant|off[- ]topic|(did ?n[o']t|does ?n[o']t|do ?n[o']t|none of (them|these|the results)) (find|mention|answer|say|give|contain|name|list|include|match))\b/i;
// The Check line of the model's thinking ('' when it wrote none), without the label.
export function checkLine(thinking) {
  const line = String(thinking || '').split('\n').find(l => /^\s*check\s*:/i.test(l));
  return line ? line.replace(/^\s*check\s*:\s*/i, '').trim().slice(0, 500) : '';
}

export function junkCheck(thinking) {
  const line = String(thinking || '').split('\n').find(l => /^\s*check\s*:/i.test(l));
  return Boolean(line && JUNK.test(line));
}

// Tool arguments for the session record: strings over 300 characters (file
// contents, code) keep their start and say how long they were.
export function trimArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 300) out[k] = v.slice(0, 300) + `… (${v.length} characters)`;
    else if (v && typeof v === 'object') out[k] = JSON.stringify(v).length > 300 ? JSON.stringify(v).slice(0, 300) + '…' : v;
    else out[k] = v;
  }
  return out;
}
