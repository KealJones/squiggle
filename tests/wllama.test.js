import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gemmaMessages, parseToolCalls, findTools, toolPrompt, Conversation, FIND_TOOLS } from '../app/src/engine-wllama.js';

const TOOLS = [
  { type: 'function', function: { name: 'web_search', description: 'Search the web for current information. Returns titles and URLs.', parameters: { properties: { query: {} }, required: ['query'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file from the workspace.', parameters: { properties: { path: {}, start: {} }, required: ['path'] } } },
  { type: 'function', function: { name: 'remember', description: 'Save a lasting fact about the user.', parameters: { properties: { fact: {} }, required: ['fact'] } } },
];

test('gemmaMessages folds history into system + alternating turns', () => {
  const out = gemmaMessages([
    { role: 'system', content: 'Be brief.' },
    { role: 'assistant', content: 'stray first assistant' },
    { role: 'user', content: 'hi' },
    { role: 'user', content: [{ type: 'text', text: 'again' }] },
    { role: 'model', content: 'hello' },
    { role: 'system', content: 'Note.' },
    { role: 'tool', content: [{ name: 'read_file', response: { text: 'x' } }] },
  ]);
  assert.equal(out[0].role, 'system');
  assert.match(out[0].content, /Be brief\.\n\nNote\./);
  assert.deepEqual(out.slice(1).map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(out[1].content, 'hi\n\nagain');
  assert.match(out[3].content, /Result of read_file/);
});

test('tool prompt lists names only until tools are looked up', () => {
  const p = toolPrompt(TOOLS, new Set());
  assert.match(p, /web_search, read_file, remember/);
  assert.doesNotMatch(p, /Search the web/);
  assert.match(toolPrompt(TOOLS, new Set(['web_search'])), /web_search\(query\): Search the web for current information\./);
});

test('findTools ranks by name and description', () => {
  assert.equal(findTools(TOOLS, 'search the web for news')[0].function.name, 'web_search');
  assert.equal(findTools(TOOLS, 'open a file')[0].function.name, 'read_file');
  assert.equal(findTools(TOOLS, 'zzz').length, 0);
});

test('parseToolCalls reads fenced JSON and tolerates junk', () => {
  const c = parseToolCalls('```tool_call\n{"name": "web_search", "arguments": {"query": "weather"}}\n```');
  assert.equal(c[0].function.name, 'web_search');
  assert.deepEqual(c[0].function.arguments, { query: 'weather' });
  assert.equal(parseToolCalls('```tool_call\n{not json\n```').length, 0);
  assert.equal(parseToolCalls('```tool_call\n{"name":"remember","arguments":"{\\"fact\\":\\"a\\"}"}').length, 1);
});

// A fake wllama that replays scripted replies, streamed in small pieces.
function fakeW(replies, seen = []) {
  return { async createChatCompletion(o) {
    seen.push(o.messages);
    const text = replies.shift() || '';
    return (async function* () { for (let i = 0; i < text.length; i += 3) yield { choices: [{ delta: { content: text.slice(i, i + 3) } }] }; })();
  } };
}
const cfg = (tools = TOOLS) => ({ preface: { messages: [{ role: 'system', content: 'sys' }], tools }, sessionConfig: { maxOutputTokens: 400 } });
async function run(conv, input) {
  let text = ''; const calls = [];
  for await (const ch of conv.sendMessageStreaming(input)) { if (ch.content) text += ch.content; if (ch.tool_calls) calls.push(...ch.tool_calls); }
  return { text, calls };
}

test('plain replies stream through untouched', async () => {
  const r = await run(new Conversation(fakeW(['Hello there, `code` and ``` fences.']), cfg()), 'hi');
  assert.equal(r.text, 'Hello there, `code` and ``` fences.');
  assert.equal(r.calls.length, 0);
});

test('find_tools is answered inside the engine, then the real call goes to the agent', async () => {
  const seen = [];
  const conv = new Conversation(fakeW([
    'Let me look. ```tool_call\n{"name": "find_tools", "arguments": {"query": "search web"}}\n```',
    '```tool_call\n{"name": "web_search", "arguments": {"query": "phoenix weather"}}\n```',
  ], seen), cfg());
  const r = await run(conv, 'weather in phoenix?');
  assert.equal(r.text, 'Let me look. ');
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].function.name, 'web_search');
  assert.ok(!r.calls.some(c => c.function.name === FIND_TOOLS));
  // Second prompt carries the lookup result and the tool's details.
  const second = seen[1];
  assert.match(second[0].content, /web_search\(query\)/);
  assert.match(second.at(-1).content, /Result of find_tools/);
  // Tool results from the agent continue the conversation.
  conv.w = fakeW(['It is sunny.']);
  const r2 = await run(conv, [{ role: 'tool', content: [{ name: 'web_search', response: { results: ['sunny'] } }] }]);
  assert.equal(r2.text, 'It is sunny.');
});

test('an unparseable tool block is shown rather than lost', async () => {
  const r = await run(new Conversation(fakeW(['```tool_call\n{oops']), cfg()), 'hi');
  assert.match(r.text, /oops/);
  assert.equal(r.calls.length, 0);
});

test('without tools, nothing is held back or parsed', async () => {
  const r = await run(new Conversation(fakeW(['```tool_call {"name":"x"}```']), cfg([])), 'hi');
  assert.equal(r.calls.length, 0);
  assert.match(r.text, /tool_call/);
});
