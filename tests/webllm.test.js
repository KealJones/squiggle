import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQwenCalls, toWebLLMMessages, toolSystem, splitRaw, createShim } from '../app/src/engine-webllm.js';
import { NativeConversation, Conversation } from '../app/src/engine-wllama.js';

const TOOLS = [
  { type: 'function', function: { name: 'web_search', description: 'Search the web.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
];

// A stand-in for WebLLM's engine: streams the given text in small pieces and records the request.
function fakeEngine(text) {
  const seen = { requests: [], interrupted: false, unloaded: false };
  return {
    seen,
    chat: { completions: { async create(req) {
      seen.requests.push(req);
      return (async function* () { for (let i = 0; i < text.length; i += 5) yield { choices: [{ delta: { content: text.slice(i, i + 5) } }] }; })();
    } } },
    interruptGenerate() { seen.interrupted = true; },
    async unload() { seen.unloaded = true; },
  };
}

test('parseQwenCalls reads Qwen3.5 <function=…><parameter=…> blocks, typing JSON-looking values', () => {
  const calls = parseQwenCalls('<tool_call>\n<function=web_search>\n<parameter=query>\nweather in Phoenix\n</parameter>\n<parameter=limit>\n3\n</parameter>\n</function>\n</tool_call>');
  assert.deepEqual(calls, [{ name: 'web_search', arguments: { query: 'weather in Phoenix', limit: 3 } }]);
});

test('parseQwenCalls reads Qwen3 JSON calls, several in a row', () => {
  const calls = parseQwenCalls('<tool_call>\n{"name": "web_search", "arguments": {"query": "a"}}\n</tool_call>\n<tool_call>\n{"name": "read_file", "arguments": "{\\"path\\": \\"x\\"}"}\n</tool_call>');
  assert.deepEqual(calls, [{ name: 'web_search', arguments: { query: 'a' } }, { name: 'read_file', arguments: { path: 'x' } }]);
});

test('toWebLLMMessages: tools into the system prompt, past calls written back, results as <tool_response> user turns', () => {
  const out = toWebLLMMessages([
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'weather?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"weather"}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'web_search', content: '{"answer":"sunny"}' },
  ], { tools: TOOLS, format: 'qwen35' });
  assert.equal(out[0].role, 'system');
  assert.ok(out[0].content.startsWith('# Tools\n\nYou have access to the following functions:'));
  assert.ok(out[0].content.endsWith('\n\nBe brief.'));
  assert.match(out[2].content, /<tool_call>\n<function=web_search>\n<parameter=query>\nweather\n<\/parameter>\n<\/function>\n<\/tool_call>/);
  assert.deepEqual(out[3], { role: 'user', content: '<tool_response>\n{"answer":"sunny"}\n</tool_response>' });
  assert.equal(toolSystem('qwen3', 'S', []), 'S');
  assert.ok(toolSystem('qwen3', 'S', TOOLS).startsWith('S\n\n# Tools\n\nYou may call one or more functions'));
});

test('splitRaw separates thinking, waits on half-written tags, and handles a template-opened <think>', () => {
  assert.deepEqual(splitRaw('<thi'), { thinking: '', text: '', pending: true });
  assert.deepEqual(splitRaw('<think>\nhmm</thi'), { thinking: '\nhmm', text: '', pending: true });
  assert.deepEqual(splitRaw('<think>\nhmm\n</think>\n\nHi'), { thinking: 'hmm\n', text: 'Hi' });
  assert.deepEqual(splitRaw('plain'), { thinking: '', text: 'plain' });
  assert.deepEqual(splitRaw('hmm</think>Hi', true), { thinking: 'hmm', text: 'Hi' });
});

test('NativeConversation over the WebLLM shim: thinking, text, then a parsed Qwen3.5 tool call', async () => {
  const fake = fakeEngine('<think>\nNeed to search.\n</think>\n\nLet me look.\n\n<tool_call>\n<function=web_search>\n<parameter=query>\nphoenix weather\n</parameter>\n</function>\n</tool_call>');
  const w = await createShim('Qwen3.5-0.8B-q4f16_1-MLC', 4096, () => {}, { format: 'qwen35', engine: fake });
  const conv = new NativeConversation(w, { preface: { messages: [{ role: 'system', content: 'S' }], tools: TOOLS, extra_context: { enable_thinking: true } }, sessionConfig: { maxOutputTokens: 256 } });
  let thinking = '', content = '', calls = null;
  for await (const x of conv.sendMessageStreaming('weather?')) {
    if (x.thinking) thinking += x.thinking;
    if (x.content) content += x.content;
    if (x.tool_calls) calls = x.tool_calls;
  }
  assert.equal(thinking.trim(), 'Need to search.');
  assert.equal(content, 'Let me look.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'web_search');
  assert.deepEqual(calls[0].function.arguments, { query: 'phoenix weather' });
  const req = fake.seen.requests[0];
  assert.deepEqual(req.extra_body, { enable_thinking: true });
  assert.equal(req.messages[0].role, 'system');
  assert.match(req.messages[0].content, /<tools>\n\{"type":"function"/);
  assert.equal(req.messages.at(-1).role, 'user');
});

test('Conversation (fenced format) over the shim passes plain text through and never sends a trailing assistant turn', async () => {
  const fake = fakeEngine('Hello there, friend.');
  const w = await createShim('Llama-3.2-1B-Instruct-q4f16_1-MLC', 4096, () => {}, { engine: fake });
  const conv = new Conversation(w, { preface: { messages: [{ role: 'system', content: 'S' }] }, sessionConfig: { maxOutputTokens: 64 } });
  let content = '';
  for await (const x of conv.sendMessageStreaming('hi')) if (x.content) content += x.content;
  assert.equal(content, 'Hello there, friend.');
  const req = fake.seen.requests[0];
  assert.equal(req.extra_body, undefined);
  assert.equal(req.messages.at(-1).role, 'user');
  await w.exit();
  assert.ok(fake.seen.unloaded);
});
