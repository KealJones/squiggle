import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillPrompt, toTemplate, ownPrompt } from '../app/src/prompt.js';

const now = new Date(2026, 10, 16);
const names = 'Tools ready to call: bash, find.\nOther tools, by area: notes: note.';

test('a built prompt round-trips through the template', () => {
  const built = `You are Squiggle.\n${names}\nToday is ${now.toDateString()}.`;
  const tpl = toTemplate(built, { names, now });
  assert.equal(tpl, 'You are Squiggle.\n{{tools}}\nToday is {{date}}.');
  assert.equal(fillPrompt(tpl, { names, now }), built);
});

test('a {{tools}} line is dropped when there are no names', () => {
  assert.equal(fillPrompt('A\n{{tools}}\nB', { now }), 'A\nB');
  assert.equal(fillPrompt('A\n\n{{tools}}\n\nB', { now }), 'A\n\nB');
});

test('placeholders inside a line are filled in place', () => {
  assert.equal(fillPrompt('Date: {{date}}. {{tools}}', { names: 'x', now }), `Date: ${now.toDateString()}. x`);
});

test('an empty prompt stays empty; null means the default', () => {
  assert.equal(fillPrompt('', { names, now }), '');
  assert.equal(ownPrompt({ systemPrompt: '' }), '');
  assert.equal(ownPrompt({ systemPrompt: null }), null);
  assert.equal(ownPrompt({}), null);
  assert.equal(ownPrompt(null), null);
});

import { withPrefs, toolPrefs, toolOff } from '../app/src/prompt.js';

const specs = [
  { name: 'bash', description: 'Run a shell command.', parameters: {} },
  { name: 'remember', description: 'Save a fact.', parameters: {} },
  { name: 'done', description: 'Finish a step.', parameters: {} },
];

test('turned-off tools are left out and edited descriptions replace the tool\'s own', () => {
  const prefs = { off: ['remember', 'done'], desc: { bash: 'Shell.' } };
  const out = withPrefs(prefs, specs);
  assert.deepEqual(out.map(t => [t.name, t.description]), [['bash', 'Shell.'], ['done', 'Finish a step.']], 'done is locked on');
  assert.equal(specs[0].description, 'Run a shell command.', 'the registry\'s spec is not changed');
  assert.equal(withPrefs(null, specs), specs);
  assert.equal(toolOff(prefs, 'remember'), true);
  assert.equal(toolOff(prefs, 'done'), false);
});

test('the editor saves only what differs, or null', () => {
  const rows = specs.map(s => ({ ...s, on: true, text: s.description }));
  assert.equal(toolPrefs(rows), null);
  rows[1].on = false; rows[0].text = 'Shell.'; rows[2].on = false;
  assert.deepEqual(toolPrefs(rows), { off: ['remember'], desc: { bash: 'Shell.' } });
});
