// Task state for step mode (docs/harness.md, "Task state" and "Step prompt").
// A task is a goal plus a plan of steps; the agent works one step at a time
// with a fresh prompt per step, so a small context can finish a long job.
// Pure data work (no storage, no engine) so it runs in node tests; agent.js
// owns the loop and saves tasks on the session.
//
//   session.tasks[id] = { id, msg, thread, goal, request, created, updated, mts,
//     status: 'active' | 'done' | 'stopped',
//     steps: [{ id, text, status: 'todo' | 'active' | 'done' | 'blocked', result?, need?, calls }],
//     recipe?, waiting?, answers?: [{ q, a }], log: [{ step, name, args, ok, label, text }], tools: [name] }
import { uid } from './util.js';

const truncate = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };

export const STEP_SOFT_CAP = 12;   // tool calls in one step before the model is told to wrap the step up
export const STEP_HARD_CAP = 18;   // after this the step is closed with what it has
export const CHECK_IN_EVERY = 60;  // tool calls per turn between "Keep going?" check-ins
const MAX_STEPS = 12;
const MAX_LOG = 40;

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = (description) => ({ type: 'string', description });

// The tools the harness adds for every model (answered by agent.js, never by tools.js).
export const HARNESS_SPECS = {
  plan: { name: 'plan', description: 'Make a plan for a request that takes more than one step, then work it one step at a time. Calling it again revises the plan; finished steps keep their results.', parameters: S({ goal: str('What the user wants, in one line'), steps: { type: 'array', items: { type: 'string' }, description: 'Short imperative steps, e.g. "Find where the login form is defined"' } }, ['goal', 'steps']) },
  done: { name: 'done', description: 'Finish the current step. result = the facts the rest of the task needs (paths, numbers, names, decisions), one to three lines.', parameters: S({ result: str('What this step found or did') }, ['result']) },
  need: { name: 'need', description: 'Say what is missing to go on. Squiggle searches for it, and asks the user if it can\'t be found.', parameters: S({ what: str('What you need, e.g. "which repo the site lives in"') }, ['what']) },
  find: { name: 'find', description: 'Search everything Squiggle knows: tools (and how to call them), recipes from past tasks, memory, past chats and this task\'s earlier results.', parameters: S({ query: str('What you are looking for, in plain words') }, ['query']) },
};
export const HARNESS = new Set(Object.keys(HARNESS_SPECS));

const cleanSteps = (steps) => (Array.isArray(steps) ? steps : typeof steps === 'string' ? steps.split(/\n+/) : [])
  .map(s => String(typeof s === 'object' && s ? s.text || s.step || '' : s).replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').replace(/\s+/g, ' ').trim())
  .filter(Boolean).slice(0, MAX_STEPS);
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
  const texts = cleanSteps(steps);
  if (goal && String(goal).trim()) task.goal = truncate(String(goal).replace(/\s+/g, ' ').trim(), 300);
  if (!task.goal) task.goal = texts[0] || truncate(task.request, 200);
  const done = task.steps.filter(s => s.status === 'done');
  const used = new Set();
  const next = texts.map((text) => {
    const prev = done.find(d => !used.has(d.id) && same(d.text, text));
    if (prev) { used.add(prev.id); return prev; }
    return { id: uid('st'), text, status: 'todo', calls: 0 };
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
  s.result = truncate(String(result || '').trim() || '(no result given)', 600);
  delete s.need;
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

export function logCall(task, step, { name, args, ok, label, text }) {
  task.log.push({ step: step ? step.id : null, name, args: args && typeof args === 'object' ? args : {}, ok: ok !== false, label: label || name, text: truncate(String(text || ''), 1500) });
  if (task.log.length > MAX_LOG) task.log.splice(0, task.log.length - MAX_LOG);
  if (step) step.calls = (step.calls || 0) + 1;
}

export function touch(task, now = Date.now()) { task.updated = now; task.mts = now; }

// "1. [done] Find the file → app/src/main.js line 40"
export function renderPlan(task, { results = true } = {}) {
  const now = current(task);
  return task.steps.map((s, i) => {
    const tag = s.status === 'done' ? 'done' : s === now ? (s.status === 'blocked' ? 'blocked' : 'now') : 'todo';
    const res = results && s.status === 'done' && s.result ? ` → ${s.result.replace(/\s+/g, ' ')}` : '';
    const need = s.status === 'blocked' && s.need ? ` (needs: ${s.need})` : '';
    return `${i + 1}. [${tag}] ${s.text}${res}${need}`;
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

// System text for one step (docs/harness.md, "Step prompt"). Sections that
// are empty are left out. `sections` = [{ title, text }] in order.
export function stepSystem(base, task, sections = []) {
  const out = [base, `## Goal\n${task.goal}`, `## Plan\n${renderPlan(task)}`];
  if (task.answers && task.answers.length) out.push('## The user answered your questions\n' + task.answers.map(a => `- ${a.q ? a.q + ': ' : ''}${a.a}`).join('\n'));
  for (const s of sections) if (s && s.text && String(s.text).trim()) out.push(`## ${s.title}\n${String(s.text).trim()}`);
  return out.join('\n\n');
}

export function stepUser(task) {
  const s = current(task);
  const n = stepIndex(task, s) + 1;
  return `${task.request || task.goal}\n\nWork on step ${n} now: ${s.text}\nWhen the step is finished, call done with what you found.`;
}

export function finalSystem(base, task) {
  return `${base}\n\n## Goal\n${task.goal}\n\n## What each step found\n${renderPlan(task)}${task.answers && task.answers.length ? '\n\n## The user answered\n' + task.answers.map(a => `- ${a.a}`).join('\n') : ''}`;
}

export function finalUser(task) {
  return `${task.request || task.goal}\n\nEvery step is done. Write the reply to this request now, using what the steps found. Don't call tools.`;
}

// The latest task in this conversation line that can pick up again from the
// new message: one waiting on an answer, or a stopped one when the user says
// to go on.
const GO_ON = /^\s*(?:ok(?:ay)?[,.!\s]*)?(?:continue|keep going|go on|go ahead|resume|carry on|yes,? (?:continue|keep going))\b/i;
export function resumable(session, threadId, text) {
  const tasks = Object.values(session.tasks || {}).filter(t => (t.thread || null) === (threadId || null) && t.status !== 'done');
  if (!tasks.length) return null;
  const t = tasks.sort((a, b) => b.updated - a.updated)[0];
  if (t.waiting) return { task: t, how: 'answer' };
  if (GO_ON.test(String(text || '')) && current(t)) return { task: t, how: 'continue' };
  return null;
}
