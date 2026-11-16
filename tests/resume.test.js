import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShim } from '../app/src/engine-webllm.js';
import { NativeConversation } from '../app/src/engine-wllama.js';
import { respond } from '../app/src/engine.js';
import { Checkpoint, load, clear, decide, leftOver, MAX_TRIES } from '../app/src/resume.js';

// A localStorage stand-in (optionally full).
const memStore = ({ quota = Infinity } = {}) => {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), removeItem: (k) => m.delete(k),
    setItem(k, v) { if (String(v).length > quota) throw new Error('QuotaExceededError'); m.set(k, String(v)); } };
};

test('checkpoint: written at the start, throttled while streaming, written at once at a tool result, gone when cleared', () => {
  const s = memStore(); let t = 1000;
  const cp = new Checkpoint({ session: 's1', thread: null, user: 'm1', text: 'hi', phase: 'chat', tries: 0 }, { s, now: () => t });
  assert.equal(load(s).user, 'm1', 'there before the first word');
  t += 200; cp.partial('<think>a');
  assert.equal(load(s).raw, '', 'inside a second: not written again');
  t += 900; cp.partial('<think>abc');
  assert.equal(load(s).raw, '<think>abc');
  cp.set({ tools: [{ name: 'bash', ok: true, result: 'done' }], raw: '' });
  assert.equal(load(s).tools[0].result, 'done');
  cp.clear();
  assert.equal(load(s), null);
});

test('checkpoint: a full storage drops the tool results first, and never throws', () => {
  const s = memStore({ quota: 400 });
  const cp = new Checkpoint({ session: 's1', user: 'm1', text: 'hi', phase: 'step' }, { s });
  cp.set({ tools: [{ name: 'bash', ok: true, label: 'ls', result: 'x'.repeat(2000) }] });
  const got = load(s);
  assert.equal(got.tools[0].label, 'ls');
  assert.equal(got.tools[0].result, undefined);
  assert.equal(load(memStore()), null);
  clear(null);   // no storage at all: nothing happens
});

test('the give-up guard: a reply picked up twice that still died is left, with what was written and why', () => {
  assert.equal(decide({ tries: 0 }), 'resume');
  assert.equal(decide({ tries: MAX_TRIES - 1 }), 'resume');
  assert.equal(decide({ tries: MAX_TRIES }), 'give-up');
  const text = leftOver({ prefix: 'Part one.', raw: '<think>x</think>Part two <tool_call>\n<function=ba' });
  assert.match(text, /^Part one\.\n\nPart two\n\n_\(This reply was interrupted 2 times/);
  assert.doesNotMatch(leftOver({ prefix: '', raw: 'only thinking so far' }), /only thinking/, 'thinking alone is not a reply');
});

// ── The shim: a raw format (LFM3) carries on after a lost GPU ─────────────────────────────────────────────────────────
const dies = () => new Error('Object has already been disposed');
function rawEngine(pieces, { dieAfter = false } = {}) {
  const seen = { prompts: [] };
  return { seen, async resetChat() {}, interruptGenerate() {}, async unload() {}, completions: { async create(o) {
    seen.prompts.push(o.prompt);
    return (async function* () { for (const t of pieces) yield { choices: [{ text: t }] }; if (dieAfter) throw dies(); })();
  } } };
}
const watchless = { current: () => ({}), onLost: () => () => {} };
const lfm3 = (engine, makeEngine) => createShim('LFM3-1.7B-QAD-q4f16_1-MLC', 4096, () => {}, { format: 'lfm3', engine, makeEngine, pace: false, watch: watchless, reuse: false, waits: [0] });
async function collect(w, opts) {
  let text = '', thinking = '', calls = null;
  for await (const c of await w.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }], chat_template_kwargs: { enable_thinking: true }, stream: true, ...opts })) {
    const d = c.choices[0].delta; text += d.content || ''; thinking += d.reasoning_content || ''; if (d.tool_calls) calls = d.tool_calls;
  }
  return { text, thinking, calls };
}

test('LFM3: the GPU lost after thinking and some of the reply was shown: it goes on from the words written, nothing repeated, no error', async () => {
  const dead = rawEngine(['Let me think', ' about it.</think>', 'The first half'], { dieAfter: true });
  const fresh = rawEngine([' and the second half.']);
  const w = await lfm3(dead, async () => fresh);
  const r = await collect(w, {});
  assert.equal(r.thinking, 'Let me think about it.');
  assert.equal(r.text, 'The first half and the second half.');
  assert.equal(w.reloads, 1);
  assert.ok(fresh.seen.prompts[0].endsWith('<think>Let me think about it.</think>The first half'), fresh.seen.prompts[0].slice(-80));
  assert.equal(fresh.seen.prompts.length, 1);
});

test('LFM3: the GPU lost while still thinking: it goes on thinking, then answers', async () => {
  const dead = rawEngine(['Hmm, first'], { dieAfter: true });
  const fresh = rawEngine([' idea.</think>', 'Answer.']);
  const r = await collect(await lfm3(dead, async () => fresh), {});
  assert.equal(r.thinking, 'Hmm, first idea.');
  assert.equal(r.text, 'Answer.');
  assert.ok(fresh.seen.prompts[0].endsWith('<think>Hmm, first'));
});

test('LFM3: half a tool call is thrown away and the model writes it again; the call that finishes runs once', async () => {
  const dead = rawEngine(['</think>Looking.', '\n\n<tool_call>\n<function=ba'], { dieAfter: true });
  const fresh = rawEngine(['\n\n<tool_call>\n<function=bash>\n<parameter=command>\nls\n</parameter>\n</function>\n</tool_call>']);
  const r = await collect(await lfm3(dead, async () => fresh), {});
  assert.doesNotMatch(fresh.seen.prompts[0], /<function=ba$/, 'the half call is not in the new prompt');
  assert.ok(fresh.seen.prompts[0].endsWith('</think>Looking.\n\n'), JSON.stringify(fresh.seen.prompts[0].slice(-40)));
  assert.equal(r.text, 'Looking.');
  assert.equal(r.calls.length, 1);
  assert.equal(JSON.parse(r.calls[0].function.arguments).command, 'ls');
});

test('LFM3: a second loss right after the reload is still an error (one carry-on per reply)', async () => {
  const w = await lfm3(rawEngine(['</think>A'], { dieAfter: true }), async () => rawEngine(['b'], { dieAfter: true }));
  await assert.rejects(collect(w, {}), /dropped the model again/);
});

test('LFM3: a reply the page lost (resume_raw) goes on from the checkpoint, showing the old words first and reporting the raw text as it grows', async () => {
  const engine = rawEngine([' rest.']);
  const raws = [];
  const r = await collect(await lfm3(engine), { resume_raw: 'Thinking.</think>Start of', on_raw: (x) => raws.push(x) });
  assert.ok(engine.seen.prompts[0].endsWith('<think>Thinking.</think>Start of'));
  assert.equal(r.thinking, 'Thinking.');
  assert.equal(r.text, 'Start of rest.');
  assert.deepEqual(raws, ['Thinking.</think>Start of rest.']);
});

// ── A chat format can't carry on: the call starts over from the same input ────────────────────────────────────────────
test('a chat format (no continuing an assistant turn): the error is flagged, and engine.respond sends the same input again once, with the first try undone', async () => {
  const dead = { chat: { completions: { async create() { return (async function* () { yield { choices: [{ delta: { content: 'Hel' } }] }; throw dies(); })(); } } }, interruptGenerate() {}, async unload() {} };
  const requests = [];
  const fresh = { chat: { completions: { async create(r) { requests.push(r); return (async function* () { yield { choices: [{ delta: { content: 'Hello again.' } }] }; })(); } } }, interruptGenerate() {}, async unload() {} };
  const w = await createShim('Qwen3-0.6B-q4f16_1-MLC', 4096, () => {}, { format: 'qwen3', engine: dead, makeEngine: async () => fresh, pace: false, watch: watchless, reuse: false, waits: [0] });
  const conv = new NativeConversation(w, { preface: { messages: [{ role: 'system', content: 'S' }], tools: [] }, sessionConfig: { maxOutputTokens: 64 } });
  const seen = [];
  const r = await respond(conv, 'hi', { onText: (t) => seen.push(t) });
  assert.equal(r.text, 'Hello again.');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages.filter(m => m.role === 'user').length, 1, 'the question is in the request once');
  assert.equal(conv.messages.filter(m => m.role === 'user').length, 1, 'and in the conversation once');
});
