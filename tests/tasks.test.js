import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as tasks from '../app/src/tasks.js';
import { mergeSession } from '../app/src/merge.js';

const mk = () => tasks.newTask({ msg: 'm1', request: 'kill whatever is on 8080 and restart the dev server', goal: 'Free port 8080 and restart', steps: ['1. Find what is listening on 8080', '- Stop it', 'Restart the dev server'] });

test('newTask cleans step text and starts every step as todo', () => {
  const t = mk();
  assert.equal(t.status, 'active');
  assert.deepEqual(t.steps.map(s => s.text), ['Find what is listening on 8080', 'Stop it', 'Restart the dev server']);
  assert.ok(t.steps.every(s => s.status === 'todo' && s.calls === 0));
  assert.equal(tasks.current(t), t.steps[0]);
});

test('steps as a newline string, and an empty plan falls back to the goal', () => {
  assert.equal(tasks.newTask({ goal: 'g', steps: 'a\nb' }).steps.length, 2);
  const t = tasks.newTask({ request: 'do the thing', steps: [] });
  assert.equal(t.steps.length, 1);
  assert.equal(t.steps[0].text, 'do the thing');
});

test('step lifecycle: start, done, blocked, answered', () => {
  const t = mk();
  tasks.startStep(t);
  assert.equal(t.steps[0].status, 'active');
  tasks.finishStep(t, 'node (pid 4242) on 8080');
  assert.equal(t.steps[0].status, 'done');
  assert.equal(tasks.current(t).text, 'Stop it');
  tasks.blockStep(t, 'is it ok to kill pid 4242?');
  assert.equal(t.steps[1].status, 'blocked');
  assert.match(tasks.renderPlan(t), /2\. \[blocked\] Stop it \(needs: is it ok to kill pid 4242\?\)/);
  t.waiting = true;
  tasks.answerNeed(t, 'yes go ahead');
  assert.equal(t.steps[1].status, 'todo');
  assert.equal(t.waiting, false);
  assert.deepEqual(t.answers, [{ q: 'is it ok to kill pid 4242?', a: 'yes go ahead' }]);
  assert.match(tasks.stepSystem('SYS', t), /## The user answered your questions\n- is it ok to kill pid 4242\?: yes go ahead/);
  tasks.finishStep(t, 'killed'); tasks.finishStep(t, 'restarted');
  assert.ok(tasks.isFinished(t));
  assert.deepEqual(tasks.progress(t), { done: 3, total: 3 });
});

test('revising the plan keeps finished steps and their results', () => {
  const t = mk();
  tasks.finishStep(t, 'node (pid 4242)');
  tasks.setPlan(t, '', ['Find what is listening on 8080', 'Ask before stopping it', 'Stop it']);
  assert.deepEqual(t.steps.map(s => [s.text, s.status]), [['Find what is listening on 8080', 'done'], ['Ask before stopping it', 'todo'], ['Stop it', 'todo']]);
  assert.equal(t.steps[0].result, 'node (pid 4242)');
  assert.equal(t.goal, 'Free port 8080 and restart', 'an empty goal keeps the old one');
  // Done steps the new plan leaves out stay at the front.
  tasks.setPlan(t, 'New goal', ['Something else']);
  assert.deepEqual(t.steps.map(s => s.text), ['Find what is listening on 8080', 'Something else']);
  assert.equal(t.goal, 'New goal');
});

test('the step prompt has goal, plan with results, sections, and the request', () => {
  const t = mk();
  tasks.finishStep(t, 'node (pid 4242)');
  tasks.startStep(t);
  const sys = tasks.stepSystem('BASE', t, [{ title: 'Recipe from a similar task', text: 'Kill a port\n1. lsof -i :<port>' }, { title: 'Empty', text: '  ' }]);
  assert.match(sys, /^BASE\n\n## Goal\nFree port 8080 and restart\n\n## Plan\n1\. \[done\] Find what is listening on 8080 → node \(pid 4242\)\n2\. \[now\] Stop it\n3\. \[todo\] Restart the dev server/);
  assert.match(sys, /## Recipe from a similar task\nKill a port/);
  assert.doesNotMatch(sys, /## Empty/);
  assert.match(tasks.stepUser(t), /^kill whatever is on 8080 and restart the dev server\n\nWork on step 2 now: Stop it\nWhen the step is finished, call done with what you found\.$/);
});

test('logCall counts calls per step, keeps arguments of old calls but not their output', () => {
  const t = mk();
  const s = tasks.startStep(t);
  const before = t.mts;
  for (let i = 0; i < 160; i++) tasks.logCall(t, s, { name: 'read_file', args: { path: '/home/x' + i }, label: 'read x' + i, text: 'line ' + i }, before + 1 + i);
  assert.equal(s.calls, 160);
  assert.equal(t.log.length, 150);
  assert.ok(t.mts > before, 'logging a call bumps the task so the newer log wins a merge');
  assert.equal(t.log.filter(l => l.text).length, 40, 'only the newest keep their output');
  assert.deepEqual(t.log[0].args, { path: '/home/x10' }, 'old calls keep their arguments (recipes use them)');
  tasks.logCall(t, s, { name: 'find', args: {}, text: 'Tools: …' });
  tasks.finishStep(t, 'found it');
  const items = tasks.taskItems(t);
  assert.ok(items.some(x => x.source === 'step result' && /found it/.test(x.text)));
  assert.ok(!items.some(x => /Tools: …/.test(x.text)), 'harness tool output is not a finding');
});

test('compactOld drops tool output of old finished tasks only', () => {
  const now = Date.now();
  const old = mk(); tasks.logCall(old, null, { name: 'read_file', text: 'big' }, now - 5 * 86400000); old.status = 'done'; old.updated = now - 5 * 86400000;
  const fresh = mk(); tasks.logCall(fresh, null, { name: 'read_file', text: 'big' }, now); fresh.status = 'done';
  const running = mk(); tasks.logCall(running, null, { name: 'read_file', text: 'big' }, now - 9 * 86400000); running.updated = now - 9 * 86400000;
  const session = { tasks: { [old.id]: old, [fresh.id]: fresh, [running.id]: running } };
  assert.ok(tasks.compactOld(session, now));
  assert.equal(old.log[0].text, '');
  assert.equal(fresh.log[0].text, 'big');
  assert.equal(running.log[0].text, 'big', 'active tasks keep everything');
});

test('samePlan: re-sending the current plan is not a revision', () => {
  const t = mk();
  tasks.finishStep(t, 'x');
  assert.ok(tasks.samePlan(t, ['Stop it', 'Restart the dev server']));
  assert.ok(tasks.samePlan(t, ['Find what is listening on 8080', '2. stop it', 'Restart the dev server']), 'done steps and numbering are ignored');
  assert.ok(!tasks.samePlan(t, ['Stop it', 'Restart the dev server', 'Check it works']));
});

test('step prompt stays within a token budget: sections go first, then older results shrink', () => {
  const t = tasks.newTask({ request: 'r'.repeat(3000), goal: 'Big job', steps: Array.from({ length: 10 }, (_, i) => `Step number ${i + 1}`) });
  for (let i = 0; i < 9; i++) tasks.finishStep(t, `result ${i} `.repeat(60));
  const sections = [{ title: 'Recipe from a similar task', text: 'recipe '.repeat(200) }, { title: 'Found earlier in this task', text: 'found '.repeat(400) }];
  const all = tasks.stepPrompt('BASE', t, sections);
  assert.deepEqual(all.shown, ['Recipe from a similar task', 'Found earlier in this task']);
  const p = tasks.stepPrompt('BASE', t, sections, { maxTokens: 1200 });
  assert.ok(Math.ceil(p.text.length / 3.2) <= 1200, `fits: ${p.text.length}`);
  assert.ok(!p.shown.includes('Found earlier in this task'), 'the lowest-priority section went first');
  assert.match(p.text, /9\. \[done\] Step number 9 → (result 8 ){10}/, 'the latest results stay whole');
  assert.ok(tasks.stepUser(t).length < 900, 'the request is trimmed');
  assert.ok(Math.ceil(tasks.finalSystem('BASE', t, { maxTokens: 1500 }).length / 3.2) <= 1500);
});

test('resumable: only the task of the latest reply, when waiting or told to go on', () => {
  const session = { tasks: {} };
  const t = mk();
  session.tasks[t.id] = t;
  assert.equal(tasks.resumable(session, null, 'hello', t.id), null);
  t.waiting = true;
  assert.deepEqual(tasks.resumable(session, null, 'yes', t.id), { task: t, how: 'answer' });
  assert.equal(tasks.resumable(session, null, 'yes', null), null, 'an older task is not picked up by a later chat reply');
  assert.equal(tasks.resumable(session, 'thread1', 'yes', t.id), null, 'other threads are separate');
  t.waiting = false; t.status = 'stopped';
  assert.equal(tasks.resumable(session, null, 'what else?', t.id), null);
  assert.deepEqual(tasks.resumable(session, null, 'ok continue', t.id), { task: t, how: 'continue' });
  assert.deepEqual(tasks.resumable(session, null, 'Keep going please', t.id), { task: t, how: 'continue' });
  for (const s of t.steps) s.status = 'done';
  assert.deepEqual(tasks.resumable(session, null, 'continue', t.id), { task: t, how: 'continue' }, 'all steps done but no final reply yet');
  t.status = 'done';
  assert.equal(tasks.resumable(session, null, 'continue', t.id), null);
});

test('tasks merge across devices by id, newest wins', () => {
  const a = mk(); const b = JSON.parse(JSON.stringify(a));
  tasks.finishStep(b, 'from the phone', a.mts + 10);
  const other = tasks.newTask({ goal: 'other' });
  const m = mergeSession({ id: 's', updated: 1, messages: [], tasks: { [a.id]: a } }, { id: 's', updated: 2, messages: [], tasks: { [b.id]: b, [other.id]: other } });
  assert.equal(m.tasks[a.id].steps[0].result, 'from the phone');
  assert.ok(m.tasks[other.id]);
});

test('harness tool specs are well formed', () => {
  for (const name of ['plan', 'done', 'need', 'find']) {
    const s = tasks.HARNESS_SPECS[name];
    assert.equal(s.name, name);
    assert.ok(s.description.length > 20);
    assert.ok(s.parameters.required.length >= 1);
  }
});

test('junkCheck reads the model verdict on the last result from its Check line', () => {
  for (const t of [
    'Check: Results are about Rennes city, a suburb, and a Paris store; none of them mention a famous building.\nNext: search again',
    'Check: The web_search returned no results about the book\'s setting.',
    'Check: these pages are unrelated to the question.',
    'Check: the snippet doesn\'t mention the year.',
  ]) assert.equal(tasks.junkCheck(t), true, t);
  for (const t of [
    'Check: the fetched page states Elvis Presley recorded it.',
    'Check: find confirmed web_search is available.',
    'Request: nothing useful here\nNext: look it up',        // only the Check line counts
    '',
  ]) assert.equal(tasks.junkCheck(t), false, t);
});

test('checkLine returns what the model took from the last result', () => {
  assert.equal(tasks.checkLine('Check: The page says season 2 premiered in Feb 2025.\nNext: answer'), 'The page says season 2 premiered in Feb 2025.');
  assert.equal(tasks.checkLine('Request: x\nNext: y'), '');
});

test('trimArgs keeps tool arguments small enough for the session record', () => {
  const big = 'x'.repeat(5000);
  assert.deepEqual(tasks.trimArgs({ path: '/repos/app/src/main.js', content: big, n: 3, list: ['a'] }),
    { path: '/repos/app/src/main.js', content: 'x'.repeat(300) + '… (5000 characters)', n: 3, list: ['a'] });
});

// ── AI-managed context ──────────────────────────────────────────────────────
test('plan steps can be objects: needs (valid refs only) and summarize kind survive; strings still work', async () => {
  const t = await import('../app/src/tasks.js');
  const task = t.newTask({ request: 'r', goal: 'g', steps: [{ text: '1. Read the page', kind: 'summarize', needs: ['file:/web/2.txt', 'nonsense'] }, 'Compare', { text: 'Write it up', needs: 'step:1, step:2' }] });
  assert.deepEqual(task.steps.map(s => [s.text, s.needs || null, s.kind || null]), [
    ['Read the page', ['file:/web/2.txt'], 'summarize'], ['Compare', null, null], ['Write it up', ['step:1', 'step:2'], null]]);
  assert.match(t.renderPlan(task), /1\. \[now\] \(summarize\) Read the page \[attach: file:\/web\/2\.txt\]/);
  // A JSON string of steps (some models send one) is read the same way.
  assert.deepEqual(t.normSteps('[{"text":"A","needs":["step:1"]}]'), [{ text: 'A', needs: ['step:1'] }]);
  // Finishing a step drops its checkpoint; a summarize step keeps a longer result.
  task.steps[0].checkpoint = { summary: 's', next: 'n' };
  t.finishStep(task, 'x'.repeat(1200));
  assert.equal(task.steps[0].checkpoint, undefined);
  assert.equal(task.steps[0].result.length, 1200);
});

test('parseRef reads step/note/file/find references', async () => {
  const { parseRef } = await import('../app/src/tasks.js');
  assert.deepEqual(parseRef('step:2'), { kind: 'step', n: 2 });
  assert.deepEqual(parseRef('file:/repos/squiggle/app/src/main.js:610-640'), { kind: 'file', path: '/repos/squiggle/app/src/main.js', start: 610, end: 640 });
  assert.deepEqual(parseRef('file:/web/3.txt'), { kind: 'file', path: '/web/3.txt' });
  assert.deepEqual(parseRef('note:n3'), { kind: 'note', id: 'n3' });
  assert.deepEqual(parseRef('find: login form'), { kind: 'find', query: 'login form' });
  assert.equal(parseRef('step:0'), null);
  assert.equal(parseRef('the second step'), null);
});

test('budgetLine says what is used and left, and suggests a checkpoint when room is low', async () => {
  const { budgetLine } = await import('../app/src/tasks.js');
  assert.equal(budgetLine(2310, 4096, 700), 'Context: 2,310 of 4,096 tokens used (about 1,090 left after room for your reply).');
  assert.match(budgetLine(3000, 4096, 700), /about 400 left[^]*running low on room[^]*checkpoint/);
});

test('fitAttachments trims the largest attachment (head and tail) and says how to get the rest', async () => {
  const { fitAttachments } = await import('../app/src/tasks.js');
  const out = fitAttachments([{ ref: 'file:/web/1.txt', text: 'HEAD ' + 'a'.repeat(8000) + ' TAIL', how: 'read_file /web/1.txt with a line range for the rest' }, { ref: 'step:1', text: 'small result' }], 500);
  assert.equal(out[1].text, 'small result');
  assert.ok(out[0].trimmed);
  assert.match(out[0].text, /^HEAD /);
  assert.match(out[0].text, / TAIL$/);
  assert.match(out[0].text, /cut to fit: \d+ characters left out; read_file \/web\/1\.txt/);
});

test('stepUser: checkpointed and summarize steps get their own instruction, plus the budget line', async () => {
  const t = await import('../app/src/tasks.js');
  const task = t.newTask({ request: 'Who is older?', goal: 'g', steps: [{ text: 'Read the bio', kind: 'summarize' }] });
  assert.match(t.stepUser(task, { budget: 'Context: 1 of 2' }), /a summarize step\): Read the bio\nRead what's attached, then call done with a short summary[^]*\n\nContext: 1 of 2$/);
  task.steps[0].checkpoint = { summary: 'half done', next: 'finish the bio' };
  assert.match(t.stepUser(task), /You checkpointed step 1 \(Read the bio\)[^]*Carry on now: finish the bio/);
});

test('stepPrompt never drops sections marked keep (checkpoint, attachments), only the others', async () => {
  const t = await import('../app/src/tasks.js');
  const task = t.newTask({ request: 'r', goal: 'g', steps: ['a'] });
  const p = t.stepPrompt('base', task, [{ title: 'Attached for this step', text: 'ATT', keep: true }, { title: 'Memory', text: 'm'.repeat(4000) }], { maxTokens: 50 });
  assert.deepEqual(p.shown, ['Attached for this step']);
  assert.match(p.text, /## Attached for this step\nATT/);
});
