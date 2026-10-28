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

test('logCall counts calls per step and bounds the log; taskItems feed find', () => {
  const t = mk();
  const s = tasks.startStep(t);
  for (let i = 0; i < 50; i++) tasks.logCall(t, s, { name: 'read_file', args: { path: '/home/x' + i }, label: 'read x' + i, text: 'line ' + i });
  assert.equal(s.calls, 50);
  assert.equal(t.log.length, 40);
  tasks.logCall(t, s, { name: 'find', args: {}, text: 'Tools: …' });
  tasks.finishStep(t, 'found it');
  const items = tasks.taskItems(t);
  assert.ok(items.some(x => x.source === 'step result' && /found it/.test(x.text)));
  assert.ok(!items.some(x => /Tools: …/.test(x.text)), 'harness tool output is not a finding');
});

test('resumable: a waiting task takes the next message as its answer; "continue" resumes a stopped one', () => {
  const session = { tasks: {} };
  const t = mk();
  session.tasks[t.id] = t;
  assert.equal(tasks.resumable(session, null, 'hello'), null);
  t.waiting = true;
  assert.deepEqual(tasks.resumable(session, null, 'yes'), { task: t, how: 'answer' });
  assert.equal(tasks.resumable(session, 'thread1', 'yes'), null, 'other threads are separate');
  t.waiting = false; t.status = 'stopped';
  assert.equal(tasks.resumable(session, null, 'what else?'), null);
  assert.deepEqual(tasks.resumable(session, null, 'ok continue'), { task: t, how: 'continue' });
  assert.deepEqual(tasks.resumable(session, null, 'Keep going please'), { task: t, how: 'continue' });
  t.status = 'done';
  assert.equal(tasks.resumable(session, null, 'continue'), null);
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
