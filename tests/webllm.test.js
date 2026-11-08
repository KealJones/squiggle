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

// ── Gemma 4 (tiny Gemma 4 on WebLLM) ─────────────────────────────────────
import { gemma4Prompt, parseGemmaCalls, splitGemma, registerModel } from '../app/src/engine-webllm.js';
import { readFileSync } from 'node:fs';

const GEMMA_FIXTURES = JSON.parse(readFileSync(new URL('./fixtures/gemma4-template.json', import.meta.url), 'utf8'));

test('gemma4Prompt matches Gemma 4\'s own chat template exactly (system, tools, thinking, calls, results in the model turn)', () => {
  for (const [name, c] of Object.entries(GEMMA_FIXTURES)) {
    assert.equal(gemma4Prompt(c.messages, c.tools || [], { thinking: Boolean(c.enable_thinking) }), c.expected, name);
  }
});

test('parseGemmaCalls reads Gemma 4 calls: strings with braces, numbers, arrays, nested objects, several calls', () => {
  assert.deepEqual(parseGemmaCalls('ok<|tool_call>call:web_search{count:3,query:<|"|>Phoenix, AZ {weather}<|"|>}<tool_call|><|tool_call>call:tool_info{names:[<|"|>recall<|"|>,<|"|>grep<|"|>],opt:{a:true,b:null}}<tool_call|>'),
    [{ name: 'web_search', arguments: { count: 3, query: 'Phoenix, AZ {weather}' } }, { name: 'tool_info', arguments: { names: ['recall', 'grep'], opt: { a: true, b: null } } }]);
  assert.deepEqual(parseGemmaCalls('no calls here'), []);
});

test('splitGemma separates the thought channel, waits on half-written markers, and handles a thought the prompt opened', () => {
  assert.deepEqual(splitGemma('<|chan'), { thinking: '', text: '', pending: true });
  assert.deepEqual(splitGemma('<|channel>thought\nSearch first.<chan'), { thinking: 'Search first.', text: '', pending: true });
  assert.deepEqual(splitGemma('<|channel>thought\nSearch first.\n<channel|>It is 61°F.'), { thinking: 'Search first.', text: 'It is 61°F.' });
  assert.deepEqual(splitGemma('Just an answer.'), { thinking: '', text: 'Just an answer.' });
  assert.deepEqual(splitGemma('read the result<channel|>Sunny.', true), { thinking: 'read the result', text: 'Sunny.' });
});

// A stand-in for WebLLM's raw completions API (what the Gemma 4 path uses).
function fakeCompletionEngine(text) {
  const seen = { requests: [], resets: 0 };
  return {
    seen,
    completions: { async create(req) {
      seen.requests.push(req);
      return (async function* () { for (let i = 0; i < text.length; i += 4) yield { choices: [{ text: text.slice(i, i + 4) }] }; })();
    } },
    async resetChat() { seen.resets++; },
    interruptGenerate() {},
    async unload() {},
  };
}

test('NativeConversation over the WebLLM shim with Gemma 4: one rendered prompt, thinking, text, then a parsed native call', async () => {
  const fake = fakeCompletionEngine('<|channel>thought\nThe name is in this turn.\n<channel|>Searching.<|tool_call>call:web_search{query:<|"|>patrick stewart<|"|>}<tool_call|>');
  // Our Gemma build ships an artifact manifest, so WebLLM adds <bos> itself and the prompt starts at the system turn.
  registerModel({ model_id: 'tiny-gemma4-heal4a-q4f16_1-MLC', model: 'https://example.invalid/', model_lib: 'https://example.invalid/lib.wasm', model_manifest: 'mlc-model-manifest.json' });
  const w = await createShim('tiny-gemma4-heal4a-q4f16_1-MLC', 4096, () => {}, { format: 'gemma4', engine: fake });
  const conv = new NativeConversation(w, { preface: { messages: [{ role: 'system', content: 'You are Squiggle.' }], tools: TOOLS, extra_context: { enable_thinking: true } }, sessionConfig: { maxOutputTokens: 256 } });
  const got = { thinking: '', text: '', calls: [] };
  for await (const x of conv.sendMessageStreaming('look up an actor: patrick stewart')) {
    if (x.thinking) got.thinking += x.thinking;
    if (x.content) got.text += x.content;
    if (x.tool_calls) got.calls.push(...x.tool_calls);
  }
  const req = fake.seen.requests[0];
  assert.equal(fake.seen.resets, 1);
  assert.ok(req.prompt.startsWith('<|turn>system\n<|think|>\nYou are Squiggle.<|tool>declaration:web_search{'), req.prompt.slice(0, 120));
  assert.ok(req.prompt.endsWith('<|turn>user\nlook up an actor: patrick stewart<turn|>\n<|turn>model\n'));
  assert.deepEqual(req.stop, ['<turn|>', '<|tool_response>']);
  assert.match(got.thinking, /The name is in this turn\./);
  assert.equal(got.text.trim(), 'Searching.');
  assert.equal(got.calls.length, 1);
  const f = got.calls[0].function || got.calls[0];
  assert.equal(f.name, 'web_search');
  assert.deepEqual(typeof f.arguments === 'string' ? JSON.parse(f.arguments) : f.arguments, { query: 'patrick stewart' });
});
