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
