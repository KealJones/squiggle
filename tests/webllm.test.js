import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQwenCalls, toWebLLMMessages, toolSystem, splitRaw, createShim, paceGpu, webkitGpu, pacedGpu } from '../app/src/engine-webllm.js';
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

// iOS 27 Safari takes the GPU device away with the tab still open; WebLLM's runtime then disposes itself and every
// call throws "Object has already been disposed" (Keal's iPhone, 2026-11-11). The shim loads the model again.
function disposedEngine({ afterChunks = 0, text = 'Hello' } = {}) {
  const seen = { unloaded: false };
  return {
    seen,
    chat: { completions: { async create() {
      if (!afterChunks) throw new Error('Object has already been disposed');
      return (async function* () { yield { choices: [{ delta: { content: text } }] }; throw new Error('Object has already been disposed'); })();
    } } },
    interruptGenerate() {},
    async unload() { seen.unloaded = true; },
  };
}

test('a lost GPU before the reply starts: the model is loaded again and the reply runs as if nothing happened', async () => {
  const dead = disposedEngine();
  const fresh = fakeEngine('Hi there!');
  let made = 0;
  const w = await createShim('Llama-3.2-1B-Instruct-q4f16_1-MLC', 4096, () => {}, { engine: dead, makeEngine: async () => { made += 1; return fresh; } });
  const conv = new Conversation(w, { preface: { messages: [{ role: 'system', content: 'S' }] }, sessionConfig: { maxOutputTokens: 64 } });
  let content = '';
  for await (const x of conv.sendMessageStreaming('hi')) if (x.content) content += x.content;
  assert.equal(content, 'Hi there!');
  assert.equal(made, 1);
  assert.equal(w.reloads, 1);
  assert.ok(dead.seen.unloaded, 'the dead engine is let go');
  assert.equal(fresh.seen.requests.length, 1, 'the retry sends the same request to the new engine');
});

test('a lost GPU partway through a reply: no repeated text, a plain error, and the next message works', async () => {
  const dead = disposedEngine({ afterChunks: 1, text: 'Hel' });
  const fresh = fakeEngine('Second try.');
  const w = await createShim('Llama-3.2-1B-Instruct-q4f16_1-MLC', 4096, () => {}, { engine: dead, makeEngine: async () => fresh });
  const conv = new Conversation(w, { preface: { messages: [{ role: 'system', content: 'S' }] }, sessionConfig: { maxOutputTokens: 64 } });
  let content = '', err = null;
  try { for await (const x of conv.sendMessageStreaming('hi')) if (x.content) content += x.content; } catch (e) { err = e; }
  assert.equal(content, 'Hel');
  assert.match(String(err && err.message), /loaded again: send the message again/);
  const conv2 = new Conversation(w, { preface: { messages: [{ role: 'system', content: 'S' }] }, sessionConfig: { maxOutputTokens: 64 } });
  let again = '';
  for await (const x of conv2.sendMessageStreaming('hi')) if (x.content) again += x.content;
  assert.equal(again, 'Second try.');
});

test('a GPU lost again right after the reload: one retry only, and the error says so', async () => {
  let made = 0;
  const w = await createShim('Llama-3.2-1B-Instruct-q4f16_1-MLC', 4096, () => {}, { engine: disposedEngine(), makeEngine: async () => { made += 1; return disposedEngine(); } });
  const conv = new Conversation(w, { preface: { messages: [{ role: 'system', content: 'S' }] }, sessionConfig: { maxOutputTokens: 64 } });
  await assert.rejects(async () => { for await (const x of conv.sendMessageStreaming('hi')) void x; }, /dropped the model again right after it was reloaded/);
  assert.equal(made, 1);
});

// A stand-in for the device watcher: which device is in use, and a way to lose it.
function fakeWatch() {
  let n = 0, cur = { id: n };
  const fns = new Set();
  return {
    current: () => cur,
    onLost(fn) { fns.add(fn); return () => fns.delete(fn); },
    newDevice() { cur = { id: ++n }; },
    lose(notes = cur, reason = 'destroyed') { notes.lost = { reason }; for (const fn of fns) fn(notes); },
  };
}
const NO_GPU = 'Unable to find a compatible GPU. This issue might be because your computer doesn\'t have a GPU';
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
async function reply(w) {
  const conv = new Conversation(w, { preface: { messages: [{ role: 'system', content: 'S' }] }, sessionConfig: { maxOutputTokens: 64 } });
  let content = '';
  for await (const x of conv.sendMessageStreaming('hi')) if (x.content) content += x.content;
  return content;
}

test('a GPU lost between messages is noticed before the next send: the dead engine is never asked', async () => {
  const watch = fakeWatch();
  const dead = disposedEngine();
  const fresh = fakeEngine('Back again.');
  let made = 0;
  const w = await createShim('Llama-3.2-1B-Instruct-q4f16_1-MLC', 4096, () => {}, { engine: dead, watch, waits: [0], makeEngine: async () => { made += 1; watch.newDevice(); return fresh; } });
  watch.lose();
  await tick(400);                      // the page is showing, so it reloads in the background
  assert.equal(made, 1, 'reloaded before anything was sent');
  assert.equal(await reply(w), 'Back again.');
  assert.equal(made, 1);
  assert.ok(dead.seen.unloaded);
});

test('a device let go on purpose (an old engine\'s, or after a reload) does not trigger a reload', async () => {
  const watch = fakeWatch();
  let made = 0;
  const w = await createShim('Llama-3.2-1B-Instruct-q4f16_1-MLC', 4096, () => {}, { engine: fakeEngine('Fine.'), watch, waits: [0], makeEngine: async () => { made += 1; return fakeEngine('x'); } });
  watch.newDevice();                    // some other engine (a download) got its own device
  watch.lose(watch.current());
  watch.lose({ id: 'elsewhere' });
  await tick(400);
  assert.equal(made, 0);
  assert.equal(await reply(w), 'Fine.');
});

test('no GPU for a while after the loss ("Unable to find a compatible GPU"): it keeps asking, then the reply runs', async () => {
  const watch = fakeWatch();
  let tries = 0;
  const w = await createShim('Llama-3.2-1B-Instruct-q4f16_1-MLC', 4096, () => {}, {
    engine: disposedEngine(), watch, waits: [0, 1, 1, 1],
    makeEngine: async () => { tries += 1; if (tries < 3) throw new Error(NO_GPU); watch.newDevice(); return fakeEngine('Made it.'); },
  });
  assert.equal(await reply(w), 'Made it.');
  assert.equal(tries, 3);
});

test('no GPU at all after the loss: a plain error, and the next message tries again instead of "Model not loaded"', async () => {
  const watch = fakeWatch();
  let gpu = false;
  const w = await createShim('Llama-3.2-1B-Instruct-q4f16_1-MLC', 4096, () => {}, {
    engine: disposedEngine(), watch, waits: [0, 1],
    makeEngine: async () => { if (!gpu) throw new Error(NO_GPU); watch.newDevice(); return fakeEngine('Second time lucky.'); },
  });
  await assert.rejects(() => reply(w), /The GPU went away.*hasn't given it back yet/);
  gpu = true;
  assert.equal(await reply(w), 'Second time lucky.');
});

test('a load that fails for another reason is not retried and says what it was', async () => {
  const watch = fakeWatch();
  let tries = 0;
  const w = await createShim('Llama-3.2-1B-Instruct-q4f16_1-MLC', 4096, () => {}, {
    engine: disposedEngine(), watch, waits: [0, 1, 1],
    makeEngine: async () => { tries += 1; throw new Error('QuotaExceededError'); },
  });
  await assert.rejects(() => reply(w), /QuotaExceededError/);
  assert.equal(tries, 1);
});

test('think_prefill: LFM3 carries on from thinking written into its turn; the reply after it is plain text', async () => {
  let prompt = '';
  const engine = { async resetChat() {}, interruptGenerate() {}, async unload() {}, completions: { async create(o) {
    prompt = o.prompt;
    return (async function* () { for (const t of ['Here is one way.', ' What maths?']) yield { choices: [{ text: t }] }; })();
  } } };
  const w = await createShim('LFM3-1.7B-QAD-q4f16_1-MLC', 4096, () => {}, { format: 'lfm3', engine, pace: false, watch: fakeWatch() });
  assert.equal(w.info.closesThinking, true);
  const chunks = await w.createChatCompletion({ messages: [{ role: 'user', content: 'crazy maths?' }], chat_template_kwargs: { enable_thinking: true }, think_prefill: 'Options: 5!, 2^10.\n\nEnough.\n', stream: true });
  let text = '', thinking = '';
  for await (const c of chunks) { const d = c.choices[0].delta; text += d.content || ''; thinking += d.reasoning_content || ''; }
  assert.ok(prompt.endsWith('<|im_start|>assistant\n<think>Options: 5!, 2^10.\n\nEnough.\n</think>'), prompt.slice(-120));
  assert.equal(thinking, '');
  assert.equal(text, 'Here is one way. What maths?');
  const off = await w.createChatCompletion({ messages: [{ role: 'user', content: 'x' }], chat_template_kwargs: { enable_thinking: false }, think_prefill: 'ignored', stream: true });
  for await (const c of off) void c;
  assert.ok(prompt.endsWith('<think></think>'), 'thinking off: nothing written into it');
});

test('paceGpu: smaller prompt pieces, and each waits for the GPU before the next is queued (iOS 27 Safari)', async () => {
  const order = [];
  const pipe = {
    prefillChunkSize: 256,
    async embedAndForward(chunk) { order.push(`forward ${chunk.length}`); return 'logits'; },
    async sync() { order.push('sync'); },
  };
  const engine = { loadedModelIdToPipeline: new Map([['m', pipe]]) };
  assert.equal(paceGpu(engine), 1);
  assert.equal(pipe.prefillChunkSize, 128);
  assert.equal(await pipe.embedAndForward([1, 2, 3]), 'logits');
  await pipe.embedAndForward([4]);
  assert.deepEqual(order, ['forward 3', 'sync', 'forward 1', 'sync']);
  assert.equal(paceGpu(engine), 0, 'never wrapped twice');
  const small = { prefillChunkSize: 64, async embedAndForward() {}, async sync() {} };
  paceGpu({ loadedModelIdToPipeline: new Map([['s', small]]) });
  assert.equal(small.prefillChunkSize, 64, 'a smaller chunk stays');
  assert.equal(paceGpu({}), 0, 'an engine without those internals is left alone');
});

test('paceGpu: a frame-long gap after each prompt piece (Android), none after a generated token', async () => {
  const pipe = { prefillChunkSize: 256, async embedAndForward() { return 'logits'; }, async sync() {} };
  paceGpu({ loadedModelIdToPipeline: new Map([['m', pipe]]) }, 128, 40);
  let t = performance.now();
  await pipe.embedAndForward([[1, 2, 3]], 3);
  assert.ok(performance.now() - t >= 35, 'a prompt piece waits');
  t = performance.now();
  await pipe.embedAndForward([[7]], 1);
  assert.ok(performance.now() - t < 30, 'a decoded token does not');
});

test('pacedGpu: phones (iPhone and Android), not computers other than Safari', () => {
  assert.ok(pacedGpu('Mozilla/5.0 (Linux; Android 17; Pixel 10 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36'));
  assert.ok(pacedGpu('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1'));
  assert.ok(!pacedGpu('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'));
});

test('webkitGpu: every iPhone browser and Mac Safari, not Chrome or Firefox on a computer', () => {
  assert.ok(webkitGpu('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1'));
  assert.ok(webkitGpu('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1'));
  assert.ok(webkitGpu('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15'));
  assert.ok(!webkitGpu('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'));
  assert.ok(!webkitGpu('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0'));
});

test('other errors are not mistaken for a lost GPU', async () => {
  const broken = { chat: { completions: { async create() { throw new Error('Context window exceeded'); } } }, interruptGenerate() {}, async unload() {} };
  let made = 0;
  const w = await createShim('Llama-3.2-1B-Instruct-q4f16_1-MLC', 4096, () => {}, { engine: broken, makeEngine: async () => { made += 1; return broken; } });
  const conv = new Conversation(w, { preface: { messages: [{ role: 'system', content: 'S' }] }, sessionConfig: { maxOutputTokens: 64 } });
  await assert.rejects(async () => { for await (const x of conv.sendMessageStreaming('hi')) void x; }, /Context window exceeded/);
  assert.equal(made, 0);
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
