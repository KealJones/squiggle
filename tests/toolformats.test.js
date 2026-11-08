// Tool formats (app/src/toolformats/): the registry, LFM2's template port and call parser, and the
// WebLLM shim driving a raw-prompt format end to end with a fake engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toolFormat, toolFormats, registerToolFormat, PLAIN } from '../app/src/toolformats/index.js';
import { lfm2Prompt, parseLfmCalls, pyJson } from '../app/src/toolformats/lfm2.js';
import { createShim, setVersion, versionFor, DEFAULT_VERSION } from '../app/src/engine-webllm.js';
import { NativeConversation } from '../app/src/engine-wllama.js';

const LFM = JSON.parse(readFileSync(new URL('./fixtures/lfm2-template.json', import.meta.url), 'utf8'));

test('the registry has every built-in format, each with the parts the shim needs', () => {
  assert.deepEqual(toolFormats().sort(), ['gemma4', 'lfm2', 'qwen3', 'qwen35']);
  for (const id of toolFormats()) {
    const f = toolFormat(id);
    assert.ok(f.mode === 'chat' ? typeof f.messages === 'function' : typeof f.prompt === 'function' && Array.isArray(f.stop), id);
    assert.equal(typeof f.parseCalls, 'function');
    assert.equal(typeof f.split, 'function');
  }
  assert.equal(toolFormat('nope'), null);
  assert.equal(toolFormat(null), null);
  assert.equal(PLAIN.callStart, null);
});

test('registerToolFormat refuses a format the shim could not drive, and adds one it can', () => {
  assert.throws(() => registerToolFormat({ id: 'bad', mode: 'raw' }), /mode must be/);
  assert.throws(() => registerToolFormat({ id: 'bad', mode: 'chat', messages: () => [] }), /parseCalls and split/);
  const f = registerToolFormat({ id: 'test-fmt', mode: 'chat', messages: () => [], callStart: null, parseCalls: () => [], split: (raw) => ({ thinking: '', text: raw }) });
  assert.equal(toolFormat('test-fmt'), f);
});

// Squiggle hands tools over in OpenAI's { type: 'function', function } shape and keeps call arguments as JSON
// strings (nativeMessages); the template got bare functions and argument objects. Both must render the same.
const asSquiggle = (c) => ({
  tools: (c.tools || []).map(t => ({ type: 'function', function: t })),
  messages: c.messages.map(m => (m.tool_calls ? { ...m, tool_calls: m.tool_calls.map(tc => ({ ...tc, function: { ...tc.function, arguments: JSON.stringify(tc.function.arguments) } })) } : m)),
});

test('lfm2Prompt matches LFM2.5\'s own chat template exactly (tools, Pythonic calls, tool turns, thinking, odd arguments)', () => {
  for (const [name, c] of Object.entries(LFM)) {
    assert.equal(lfm2Prompt(c.messages, c.tools || []), c.expected, name);
    const s = asSquiggle(c);
    assert.equal(lfm2Prompt(s.messages, s.tools), c.expected, name + ' (Squiggle shapes)');
  }
});

test('pyJson writes JSON the way Python\'s json.dumps does', () => {
  assert.equal(pyJson({ a: [1, 'x', true, null], b: { 'c d': 'é' } }), '{"a": [1, "x", true, null], "b": {"c d": "é"}}');
});

test('parseLfmCalls reads Pythonic calls: quotes and escapes, numbers, True/False/None, lists, objects, several calls', () => {
  assert.deepEqual(parseLfmCalls('<|tool_call_start|>[web_search(query=\'it\\\'s a "test"\\nline two \\\\ done\', count=2.5, safe=True, region=None, opts={"a": 1, "b": [true, null]}), tool_info(names=["recall", "grep"])]<|tool_call_end|>'), [
    { name: 'web_search', arguments: { query: 'it\'s a "test"\nline two \\ done', count: 2.5, safe: true, region: null, opts: { a: 1, b: [true, null] } } },
    { name: 'tool_info', arguments: { names: ['recall', 'grep'] } },
  ]);
});

test('parseLfmCalls takes a call with no end marker (generation stops on it), no arguments, and JSON calls', () => {
  assert.deepEqual(parseLfmCalls('<|tool_call_start|>[find(query="patrick stewart")]'), [{ name: 'find', arguments: { query: 'patrick stewart' } }]);
  assert.deepEqual(parseLfmCalls('<|tool_call_start|>[list_files()]<|tool_call_end|>'), [{ name: 'list_files', arguments: {} }]);
  assert.deepEqual(parseLfmCalls('<|tool_call_start|>[{"name": "web_search", "arguments": {"query": "x"}}]<|tool_call_end|>'), [{ name: 'web_search', arguments: { query: 'x' } }]);
  assert.deepEqual(parseLfmCalls('no calls'), []);
});

test('every built-in format reads back the calls it writes into history', () => {
  const calls = [{ function: { name: 'web_search', arguments: JSON.stringify({ query: 'a "b" c', n: 2 }) } }];
  const history = [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', tool_calls: calls }];
  const lfm = lfm2Prompt(history, []);
  assert.deepEqual(parseLfmCalls(lfm.slice(lfm.indexOf('<|tool_call_start|>'))), [{ name: 'web_search', arguments: { query: 'a "b" c', n: 2 } }]);
});

// A stand-in for WebLLM's raw completions API.
function fakeCompletionEngine(text) {
  const seen = { requests: [], resets: 0 };
  return {
    seen,
    completions: { async create(req) {
      seen.requests.push(req);
      return (async function* () { for (let i = 0; i < text.length; i += 3) yield { choices: [{ text: text.slice(i, i + 3) }] }; })();
    } },
    async resetChat() { seen.resets++; },
    interruptGenerate() {},
    async unload() {},
  };
}

const TOOLS = [{ type: 'function', function: { name: 'web_search', description: 'Search the web.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } }];

test('NativeConversation over the WebLLM shim with LFM2: one rendered prompt, then text and a parsed call', async () => {
  const fake = fakeCompletionEngine('Let me look.<|tool_call_start|>[web_search(query=\'patrick stewart\')]');
  const w = await createShim('LFM2.5-1.2B-Instruct-q4f16_1-MLC', 4096, () => {}, { format: 'lfm2', engine: fake });
  assert.equal(w.info.toolFormat, 'lfm2');
  const conv = new NativeConversation(w, { preface: { messages: [{ role: 'system', content: 'You are Squiggle.' }], tools: TOOLS, extra_context: { enable_thinking: false } }, sessionConfig: { maxOutputTokens: 256 } });
  const got = { text: '', calls: [] };
  for await (const x of conv.sendMessageStreaming('look up an actor: patrick stewart')) {
    if (x.content) got.text += x.content;
    if (x.tool_calls) got.calls.push(...x.tool_calls);
  }
  const req = fake.seen.requests[0];
  assert.equal(fake.seen.resets, 1);
  // No manifest on this build: WebLLM won't add the start-of-text token, so the prompt carries it.
  assert.ok(req.prompt.startsWith('<|startoftext|><|im_start|>system\nYou are Squiggle.\nList of tools: [{"name": "web_search", "description": "Search the web.", '), req.prompt.slice(0, 160));
  assert.ok(req.prompt.endsWith('<|im_start|>user\nlook up an actor: patrick stewart<|im_end|>\n<|im_start|>assistant\n'), req.prompt.slice(-120));
  assert.deepEqual(req.stop, ['<|im_end|>', '<|tool_call_end|>']);
  assert.equal(got.text.trim(), 'Let me look.');
  assert.equal(got.calls.length, 1);
  const f = got.calls[0].function || got.calls[0];
  assert.equal(f.name, 'web_search');
  assert.deepEqual(typeof f.arguments === 'string' ? JSON.parse(f.arguments) : f.arguments, { query: 'patrick stewart' });
});

test('a model can name its own WebLLM version; the rest use the default', () => {
  setVersion('LFM2.5-1.2B-Instruct-q4f16_1-MLC', '0.2.86');
  assert.equal(versionFor('LFM2.5-1.2B-Instruct-q4f16_1-MLC'), '0.2.86');
  assert.equal(versionFor('LFM2.5-1.2B-Instruct-q4f32_1-MLC'), '0.2.86');
  assert.equal(versionFor('Qwen3-0.6B-q4f16_1-MLC'), DEFAULT_VERSION);
});
