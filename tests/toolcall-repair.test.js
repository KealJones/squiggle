import test from 'node:test';
import assert from 'node:assert/strict';
import { failedCallText, repairCalls, unreadableNote } from '../app/src/toolcall-repair.js';

// The error Keal hit on desktop (Gemma 4 E4B, LiteRT-LM 0.14.0).
const ERR = 'Failed to parse tool calls from code block: call:grep{path:<|"|>/repos/squiggle<|"|>,pattern:".squiggle-wait|indeterminate"}\n' +
  'full response: <|tool_call>call:grep{path:<|"|>/repos/squiggle<|"|>,pattern:".squiggle-wait|indeterminate"}<tool_call|>\n' +
  'error: Failed to parse FC tool calls: FallThrough(ParseCancelledError(NoAltError(NoViableAltError { ... })))';

test('a call LiteRT could not parse is read leniently', () => {
  const raw = failedCallText(ERR);
  assert.match(raw, /^<\|tool_call>call:grep/);
  assert.deepEqual(repairCalls(raw), [{ type: 'function', function: { name: 'grep', arguments: { path: '/repos/squiggle', pattern: '.squiggle-wait|indeterminate' } } }]);
});

test('lenient reading: numbers, booleans, lists, nested objects, escapes, several calls', () => {
  const calls = repairCalls('call:read_file{path:<|"|>/home/a.md<|"|>, start_line: 10, end_line:20}call:plan{goal:"Fix it",steps:[<|"|>one<|"|>, "two \\"quoted\\""]}call:x{opts:{deep:true,n:null}}');
  assert.deepEqual(calls.map(c => c.function), [
    { name: 'read_file', arguments: { path: '/home/a.md', start_line: 10, end_line: 20 } },
    { name: 'plan', arguments: { goal: 'Fix it', steps: ['one', 'two "quoted"'] } },
    { name: 'x', arguments: { opts: { deep: true, n: null } } },
  ]);
  assert.deepEqual(repairCalls('call:grep{path:<|"|>/repos/x'), [], 'unreadable calls are skipped');
  assert.equal(failedCallText('some other error'), null);
  assert.match(unreadableNote('call:grep{oops'), /couldn't be read[\s\S]*<\|"\|>/);
});
