import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineTool, registerTool, unregisterTool, getTool, listTools, toolSpecs, runTool, params, str } from '../app/src/tools/registry.js';

const echo = defineTool({ name: 'echo_test', description: 'Echoes its input.', parameters: params({ text: str('what to echo') }, ['text']), run: async ({ text }, ctx) => ({ model: { text, who: ctx && ctx.session && ctx.session.id }, label: `echoed ${text}` }) });

test('defineTool builds a { spec, run } tool with a JSON-schema spec', () => {
  assert.deepEqual(echo.spec, { name: 'echo_test', description: 'Echoes its input.', parameters: { type: 'object', properties: { text: { type: 'string', description: 'what to echo' } }, required: ['text'] } });
  assert.equal(typeof echo.run, 'function');
  assert.deepEqual(defineTool({ name: 'no_args', description: 'x', run: async () => ({}) }).spec.parameters, { type: 'object', properties: {}, required: [] });
});

test('registerTool adds a tool, keeps registration order, and replaces in place', () => {
  const a = registerTool(defineTool({ name: 'first_test', description: 'a', run: async () => ({ model: { v: 1 } }) }));
  registerTool(echo);
  registerTool(defineTool({ name: 'first_test', description: 'a2', run: async () => ({ model: { v: 2 } }) }));
  const names = listTools().map(t => t.spec.name);
  assert.deepEqual(names.slice(names.indexOf('first_test'), names.indexOf('first_test') + 2), ['first_test', 'echo_test']);
  assert.equal(getTool('first_test').spec.description, 'a2');
  assert.notEqual(getTool('first_test'), a);
  assert.ok(unregisterTool('first_test'));
  assert.equal(getTool('first_test'), null);
});

test('registerTool rejects bad names and tools without run or description', () => {
  assert.throws(() => registerTool({ spec: { name: 'Bad Name', description: 'x' }, run: async () => ({}) }), /Tool name/);
  assert.throws(() => registerTool({ spec: { name: 'no_run', description: 'x' } }), /no run/);
  assert.throws(() => registerTool({ spec: { name: 'no_desc' }, run: async () => ({}) }), /no description/);
});

test('toolSpecs returns every spec, or only the enabled set', () => {
  registerTool(echo);
  assert.ok(toolSpecs().some(s => s.name === 'echo_test'));
  assert.deepEqual(toolSpecs(new Set(['echo_test'])).map(s => s.name), ['echo_test']);
  assert.deepEqual(toolSpecs(new Set()), []);
});

test('runTool parses string arguments, passes ctx, and reports ok from the result', async () => {
  registerTool(echo);
  const r = await runTool({ function: { name: 'echo_test', arguments: '{"text":"hi"}' } }, { session: { id: 's1' } });
  assert.deepEqual(r, { name: 'echo_test', args: { text: 'hi' }, model: { text: 'hi', who: 's1' }, label: 'echoed hi', ok: true });
  const bad = await runTool({ function: { name: 'echo_test', arguments: '{not json' } }, {});
  assert.deepEqual(bad.args, {});
});

test('runTool never throws: unknown tools, thrown errors and error results all come back as ok: false', async () => {
  const unknown = await runTool({ function: { name: 'nope_test' } }, {});
  assert.equal(unknown.ok, false);
  assert.match(unknown.model.error, /Unknown tool/);
  registerTool(defineTool({ name: 'boom_test', description: 'x', run: async () => { throw new Error('kaboom'); } }));
  const thrown = await runTool({ function: { name: 'boom_test' } }, {});
  assert.deepEqual([thrown.ok, thrown.model.error, thrown.label], [false, 'kaboom', 'boom_test failed']);
  registerTool(defineTool({ name: 'err_test', description: 'x', run: async () => ({ model: { error: 'no' } }) }));
  assert.equal((await runTool({ function: { name: 'err_test' } }, {})).ok, false);
});

test('case 13 (run_js with {expression}): a call missing a required argument is an error naming it, and nothing runs', async () => {
  let ran = 0;
  const t = registerTool(defineTool({ name: 'needs_code_test', description: 'x', parameters: params({ code: str('JavaScript code') }, ['code']), run: async () => { ran++; return { model: { stdout: '' } }; } }));
  const r = await runTool({ function: { name: 'needs_code_test', arguments: { expression: '1+1' } } });
  assert.equal(ran, 0);
  assert.equal(r.ok, false);
  assert.equal(r.model.error, 'needs_code_test needs "code" (JavaScript code). You sent: expression. Call it again with code.');
  const ok = await runTool({ function: { name: 'needs_code_test', arguments: JSON.stringify({ code: '' }) } });
  assert.equal(ok.ok, true, 'an empty string is still an argument');
  assert.equal(ran, 1);
  unregisterTool(t.spec.name);
});
