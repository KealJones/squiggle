import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gemmaMessages, parseToolCalls, findTools, toolPrompt, Conversation, splitThinking, isLooping } from '../app/src/engine-wllama.js';

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

test('tool prompt names no tools until they are looked up', () => {
  assert.equal(toolPrompt(TOOLS, new Set()), '');
  const p = toolPrompt(TOOLS, new Set(['web_search']));
  assert.match(p, /web_search\(query\): Search the web for current information\./);
  assert.doesNotMatch(p, /read_file|remember/);
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

async function runAll(conv, input) {
  let text = '', thinking = ''; const calls = [];
  for await (const ch of conv.sendMessageStreaming(input)) { if (ch.content) text += ch.content; if (ch.thinking) thinking += ch.thinking; if (ch.tool_calls) calls.push(...ch.tool_calls); }
  return { text, thinking, calls };
}

test('find goes to the agent; tools it returns are described from then on', async () => {
  const seen = [];
  const conv = new Conversation(fakeW([
    'Let me look. ```tool_call\n{"name": "find", "arguments": {"query": "search web"}}\n```',
    '```tool_call\n{"name": "web_search", "arguments": {"query": "phoenix weather"}}\n```',
    'It is sunny.',
  ], seen), cfg());
  const r = await run(conv, 'weather in phoenix?');
  assert.equal(r.text, 'Let me look. ');
  assert.equal(r.calls[0].function.name, 'find');
  assert.doesNotMatch(seen[0][0].content, /web_search/, 'no tool names in the first prompt');
  const r2 = await run(conv, [{ role: 'tool', content: [{ name: 'find', response: { found: 'Tools:\n- web_search(query): …', tools: ['web_search'] } }] }]);
  assert.equal(r2.calls[0].function.name, 'web_search');
  assert.match(seen[1][0].content, /Tools you have looked up:\n- web_search\(query\)/);
  assert.match(seen[1].at(-1).content, /Result of find/);
  const r3 = await run(conv, [{ role: 'tool', content: [{ name: 'web_search', response: { results: ['sunny'] } }] }]);
  assert.equal(r3.text, 'It is sunny.');
});

test('the old find_tools name is treated as find', async () => {
  const r = await run(new Conversation(fakeW(['```tool_call\n{"name": "find_tools", "arguments": {"query": "x"}}\n```']), cfg()), 'hi');
  assert.equal(r.calls[0].function.name, 'find');
});

test('tools looked up in an earlier step carry over through preface.known', async () => {
  const seen = [];
  const c = cfg(); c.preface.known = ['read_file'];
  await run(new Conversation(fakeW(['ok'], seen), c), 'hi');
  assert.match(seen[0][0].content, /read_file\(path, start\?\)/);
});

test('splitThinking separates a leading think block', () => {
  assert.deepEqual(splitThinking('  <thi'), { thinking: '', text: '', pending: true });
  assert.equal(splitThinking('<think>hmm </thi').thinking, 'hmm ');
  assert.equal(splitThinking('<think>hmm </thi').open, true);
  assert.deepEqual(splitThinking('<think>a plan</think>\n\nThe answer.'), { thinking: 'a plan', text: 'The answer.' });
  assert.deepEqual(splitThinking('No thinking here.'), { thinking: '', text: 'No thinking here.' });
});

test('thinking streams separately and is not replayed into history', async () => {
  const conv = new Conversation(fakeW(['<think>I should look it up first.</think>\n```tool_call\n{"name": "find", "arguments": {"query": "weather"}}\n```']), cfg());
  const r = await runAll(conv, 'weather?');
  assert.equal(r.thinking, 'I should look it up first.');
  assert.equal(r.text, '');
  assert.equal(r.calls[0].function.name, 'find');
  assert.doesNotMatch(conv.messages.at(-1).content, /look it up first/);
});

test('a reply that repeats itself is cut off', async () => {
  const loop = 'I will use the web search tool to find the answer for you. '.repeat(6);
  assert.ok(isLooping(loop));
  assert.ok(!isLooping('A normal reply with different sentences. Each one says something new. Nothing repeats here at all.'));
  // It loops on both tries: stopped, retried once with a note, then stopped for good.
  const r = await run(new Conversation(fakeW([loop, loop]), cfg()), 'hi');
  assert.match(r.text, /asked it to try again[\s\S]*stopped: the model was repeating itself/);
  assert.ok(r.text.length < 2 * loop.length, 'stopped before the end');
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

test('thinking that llama.cpp splits into reasoning_content still reaches the thinking view', async () => {
  const w = { async createChatCompletion() {
    return (async function* () {
      yield { choices: [{ delta: { reasoning_content: 'Request: weather. ' } }] };
      yield { choices: [{ delta: { reasoning_content: 'Next: find.' } }] };
      yield { choices: [{ delta: { content: '```tool_call\n{"name": "find", "arguments": {"query": "search the web"}}\n```' } }] };
    })();
  } };
  const r = await runAll(new Conversation(w, cfg()), 'weather?');
  assert.equal(r.thinking, 'Request: weather. Next: find.');
  assert.equal(r.text, '');
  assert.equal(r.calls[0].function.name, 'find');
});

test('a closing </think> left in the content after reasoning_content is dropped', async () => {
  const w = { async createChatCompletion() {
    return (async function* () {
      yield { choices: [{ delta: { reasoning_content: 'A casual hello.' } }] };
      yield { choices: [{ delta: { content: '\n</thi' } }] };
      yield { choices: [{ delta: { content: 'nk>\nHey! What can I do for you?' } }] };
    })();
  } };
  const r = await runAll(new Conversation(w, cfg()), 'hi');
  assert.equal(r.thinking, 'A casual hello.');
  assert.equal(r.text, 'Hey! What can I do for you?');
});

test('a loop with no sentence ends is stopped, in reasoning_content too', async () => {
  for (const key of ['content', 'reasoning_content']) {
    let sent = 0;
    const w = { async createChatCompletion({ abortSignal }) {
      return (async function* () {
        if (key === 'content') yield { choices: [{ delta: { content: '<think>\nCheck: total = 2' } }] };
        else yield { choices: [{ delta: { reasoning_content: 'Check: total = 2' } }] };
        for (let i = 0; i < 2000 && !abortSignal.aborted; i++) { sent++; yield { choices: [{ delta: { [key]: ' + 2' } }] }; }
      })();
    } };
    const r = await runAll(new Conversation(w, cfg()), 'how many birds are a flock?');
    assert.ok(sent < 400, `${key}: stopped after ${sent} pieces (two tries)`);
    assert.match(r.text, /repeating itself/);
  }
});

test('a loop is stopped, the model is told where it got stuck, and its second try is used', async () => {
  const seen = [];
  let call = 0;
  const w = { async createChatCompletion({ messages, penalty_repeat, abortSignal }) {
    seen.push({ messages: JSON.parse(JSON.stringify(messages)), penalty_repeat });
    const n = call++;
    return (async function* () {
      if (n === 0) {
        yield { choices: [{ delta: { reasoning_content: 'Check: so total = 2' } }] };
        for (let i = 0; i < 2000 && !abortSignal.aborted; i++) yield { choices: [{ delta: { reasoning_content: ' + 2' } }] };
      } else {
        yield { choices: [{ delta: { reasoning_content: 'Check: the page gives no number.' } }] };
        yield { choices: [{ delta: { content: 'There is no set number of birds in a flock.' } }] };
      }
    })();
  } };
  const conv = new Conversation(w, cfg());
  const r = await runAll(conv, 'how many birds are a flock?');
  assert.equal(seen.length, 2);
  const note = seen[1].messages[seen[1].messages.length - 1].content;
  assert.match(note, /stuck repeating "2 2 2 2 2 2 2 2"/);
  assert.equal(seen[1].penalty_repeat, 1.3);
  assert.match(r.thinking, /Squiggle stopped it and asked it to try again/);
  assert.equal(r.text, 'There is no set number of birds in a flock.');
  assert.ok(!conv.messages.some(m => /Squiggle: your last reply/.test(m.content)), 'the note leaves history');
  assert.equal(conv.messages[conv.messages.length - 1].content, 'There is no set number of birds in a flock.');
});

test('replaceResult swaps a tool result already in history for a short note', async () => {
  const conv = new Conversation(fakeW(['ok', 'done']), cfg());
  await run(conv, 'look it up');
  const msg = { role: 'tool', content: [{ name: 'web_search', response: { results: 'x'.repeat(500) } }] };
  await run(conv, [msg]);
  assert.equal(conv.replaceResult(msg, { left_out: 'not useful' }), true);
  const swapped = conv.messages.find(m => m.role === 'tool');
  assert.deepEqual(swapped.content, [{ name: 'web_search', response: { left_out: 'not useful' } }]);
  assert.equal(conv.replaceResult({ role: 'tool', content: [] }, {}), false, 'unknown messages are left alone');
});

test('after a loop, what came before it is kept and the model carries on from there', async () => {
  const seen = [];
  let call = 0;
  const good = 'Request: how many birds make a flock.\nKnow: the search found a photo caption, no number.';
  const w = { async createChatCompletion({ messages, abortSignal }) {
    seen.push(JSON.parse(JSON.stringify(messages)));
    const n = call++;
    return (async function* () {
      if (n === 0) {
        yield { choices: [{ delta: { reasoning_content: good + '\nCheck: so total = 2' } }] };
        for (let i = 0; i < 2000 && !abortSignal.aborted; i++) yield { choices: [{ delta: { reasoning_content: ' + 2' } }] };
      } else {
        const prefill = messages[messages.length - 1].content;
        for (let i = 0; i < prefill.length; i += 7) yield { choices: [{ delta: { content: prefill.slice(i, i + 7) } }] };   // echoed back
        yield { choices: [{ delta: { content: 'Check: the page has no set number.\n</think>\nThere is no set number of birds in a flock.' } }] };
      }
    })();
  } };
  const conv = new Conversation(w, cfg());
  const r = await runAll(conv, 'how many birds are a flock?');
  const last = seen[1][seen[1].length - 1];
  assert.equal(last.role, 'assistant');
  assert.equal(last.content, '<think>\n' + good + '\n(I was repeating myself. Moving on.)\n', 'kept up to the loop, plus a nudge');
  assert.ok(!seen[1].some(m => /Squiggle: your last reply/.test(m.content)), 'no start-over note');
  assert.equal(r.text, 'There is no set number of birds in a flock.');
  assert.match(r.thinking, /carry on from before them\.\]\n\nCheck: the page has no set number\.\s*$/);
  assert.equal((r.thinking.match(/Request: how many birds/g) || []).length, 1, 'the kept part is not shown twice');
});

test('beforeLoop cuts at the sentence before the repeats and keeps nothing when too little came first', async () => {
  const { beforeLoop } = await import('../app/src/engine-wllama.js');
  assert.equal(beforeLoop('<think>\nRequest: a thing to find.\nCheck: total = 2 + 2 + 2 + 2', '2 2 2 2'), '<think>\nRequest: a thing to find.');
  assert.equal(beforeLoop('2 + 2 + 2 + 2', '2 2 2 2'), '');
});

test('nativeMessages: Gemma 4 tool format keeps assistant tool_calls and answers each with a tool message', async () => {
  const { nativeMessages } = await import('../app/src/engine-wllama.js');
  const out = nativeMessages([
    { role: 'system', content: 'You are Squiggle.' },
    { role: 'user', content: 'Weather in Phoenix and Tempe?' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Phoenix"}' } },
      { id: 'b', type: 'function', function: { name: 'web_search', arguments: '{"query":"Tempe weather"}' } }] },
    { role: 'tool', content: [{ name: 'web_search', response: { results: [] } }, { name: 'get_weather', response: { temp_f: 84 } }] },
    { role: 'model', content: 'It is 84°F.' },
  ]);
  assert.deepEqual(out.map(m => m.role), ['system', 'user', 'assistant', 'tool', 'tool', 'assistant']);
  assert.equal(out[2].content, null);
  assert.equal(out[3].tool_call_id, 'b');                 // matched by name, not order
  assert.equal(out[4].tool_call_id, 'a');
  assert.equal(out[4].content, '{"temp_f":84}');
});

test('NativeConversation: passes the tools to llama.cpp, streams text, returns the parsed calls and keeps them in history', async () => {
  const { NativeConversation } = await import('../app/src/engine-wllama.js');
  const seen = [];
  const deltas = [
    { content: 'Checking. ' },
    { tool_calls: [{ index: 0, id: 'x1', function: { name: 'web_', arguments: '{"query":' } }] },
    { tool_calls: [{ index: 0, function: { name: 'search', arguments: '"Phoenix weather"}' } }] },
  ];
  const w = { createChatCompletion: async (p) => { seen.push(p); return (async function* () { for (const d of deltas) yield { choices: [{ delta: d }] }; })(); } };
  const conv = new NativeConversation(w, { preface: { messages: [{ role: 'system', content: 'S' }], tools: TOOLS, extra_context: { enable_thinking: true } }, sessionConfig: { maxOutputTokens: 256 } });
  const got = [];
  for await (const x of conv.sendMessageStreaming('Weather in Phoenix?')) got.push(x);
  assert.equal(seen[0].tools, TOOLS);
  assert.deepEqual(seen[0].chat_template_kwargs, { enable_thinking: true });
  assert.equal(got[0].content, 'Checking. ');
  const calls = got.find(x => x.tool_calls).tool_calls;
  assert.deepEqual(calls[0].function, { name: 'web_search', arguments: { query: 'Phoenix weather' } });
  assert.equal(calls[0].id, 'x1');
  const last = conv.messages[conv.messages.length - 1];
  assert.equal(last.tool_calls[0].function.arguments, '{"query":"Phoenix weather"}');
  // The result goes back as a tool message answering that call.
  deltas.length = 0; deltas.push({ content: 'Sunny.' });
  for await (const x of conv.sendMessageStreaming([{ role: 'tool', content: [{ name: 'web_search', response: { results: ['sunny'] } }] }])) got.push(x);
  const sent = seen[1].messages;
  assert.equal(sent[sent.length - 1].role, 'tool');
  assert.equal(sent[sent.length - 1].tool_call_id, 'x1');
});
