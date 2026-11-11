import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotPoint, startsWith, reusePrefix } from '../app/src/prefix-cache.js';
import { lfm3 } from '../app/src/toolformats/lfm3.js';
import { nativeMessages } from '../app/src/engine-wllama.js';

// A tokenizer where LFM3's special tokens are one id each and every other character is its own id.
const SPECIAL = ['<|startoftext|>', '<|im_start|>', '<|im_end|>', '<think>', '</think>'];
const encode = (s) => {
  const out = [];
  for (let i = 0; i < s.length;) {
    const sp = SPECIAL.findIndex((t) => s.startsWith(t, i));
    if (sp >= 0) { out.push(-1 - sp); i += SPECIAL[sp].length; } else { out.push(s.charCodeAt(i)); i += 1; }
  }
  return out;
};

// WebLLM's pipeline as far as prefix-cache.js touches it: sequences are token lists per state, a fork copies one,
// embedAndForward appends to sequence 0. `read` counts every token the "GPU" processed.
function fakePipeline({ chunk = 64 } = {}) {
  const mkState = () => ({ seqs: new Map(), max: 0 });
  const p = {
    read: 0,
    tokenizer: { encode: (s) => Int32Array.from(encode(s)) },
    prefillChunkSize: chunk, contextWindowSize: 4096, slidingWindowSize: -1, maxHistorySize: 1,
    filledKVCacheLength: 0,
    kvCache: { ...mkState(), dispose() {} },
    rnnState: { ...mkState(), dispose() {} },
    tvm: {
      scalar: (v) => v, makeShapeTuple: ([x]) => x, beginScope() {}, endScope() {}, detachFromCurrentScope: (x) => x,
      getGlobalFunc: (name) => {
        assert.equal(name, 'vm.builtin.kv_state_fork_sequence');
        return (s, parent, child, pos) => {
          assert.equal(pos, -1);
          assert.ok(s.seqs.has(parent), 'fork from a sequence that exists');
          assert.ok(!s.seqs.has(child), 'fork into a free sequence');
          assert.ok(s.seqs.size < s.max, 'room for another sequence');
          s.seqs.set(child, [...s.seqs.get(parent)]);
        };
      },
    },
    vm: { getFunction: (name) => (name === 'create_tir_paged_kv_cache' ? (n) => ({ ...mkState(), max: n, dispose() {} }) : (n) => ({ ...mkState(), max: n, dispose() {} })) },
    getActiveKVStates() { return [this.kvCache, this.rnnState]; },
    fKVCacheRemoveSequence: (s, id) => { assert.ok(s.seqs.delete(id), `remove sequence ${id} that exists`); },
    fKVCacheAddSequence: (s, id) => { assert.ok(!s.seqs.has(id)); s.seqs.set(id, []); },
    resetKVCache() { for (const s of this.getActiveKVStates()) { s.seqs.clear(); s.seqs.set(0, []); } },
    resetChat() { this.conversation = null; this.resetKVCache(); this.filledKVCacheLength = 0; },
    async getInputData() {
      if (this.conversation.isTextCompletion && this.filledKVCacheLength !== 0) throw new Error('TextCompletionExpectsKVEmptyError');
      const ids = Array.from(this.tokenizer.encode(this.conversation.prompt));
      return [[ids], ids.length, () => 0];
    },
    async embedAndForward(data, len) {
      const ids = data.flat();
      assert.equal(ids.length, len);
      for (const s of this.getActiveKVStates()) s.seqs.get(0).push(...ids);
      this.filledKVCacheLength += len;
      this.read += len;
      return { dispose() {} };
    },
  };
  return p;
}

// One raw completion the way WebLLM runs it: reset, read the prompt in pieces, then write `reply` (each sampled
// token but the last goes into the cache). Returns what sequence 0 held when the prompt was read.
async function complete(p, prompt, reply = '') {
  p.resetChat();
  p.conversation = { isTextCompletion: true, prompt };
  const [data] = await p.getInputData();
  const ids = data.flat();
  for (let i = 0; i < ids.length; i += p.prefillChunkSize) {
    const piece = ids.slice(i, i + p.prefillChunkSize);
    await p.embedAndForward([piece], piece.length);
  }
  assert.equal(p.filledKVCacheLength, p.kvCache.seqs.get(0).length);
  const seen = [...p.kvCache.seqs.get(0)];
  assert.deepEqual(p.rnnState.seqs.get(0), seen, 'conv state and KV cache read the same tokens');
  const out = encode(reply);
  for (const t of out.slice(0, -1)) await p.embedAndForward([[t]], 1);
  return seen;
}

const open = encode(lfm3.cacheMark.open), close = encode(lfm3.cacheMark.close)[0];
const install = (p) => reusePrefix({ loadedModelIdToPipeline: new Map([['m', p]]) }, lfm3.cacheMark, { log: { info() {}, warn() {} } });

test('snapshotPoint: before the generation prompt\'s last token, or right after a kept-thinking turn\'s <think>', () => {
  const sys = '<|startoftext|><|im_start|>system\nHi<|im_end|>\n<|im_start|>user\nq<|im_end|>\n';
  const first = encode(sys + '<|im_start|>assistant\n<think>');
  assert.equal(snapshotPoint(first, open, close), first.length - 1, 'a first call: all but the last token');
  const off = encode(sys + '<|im_start|>assistant\n<think></think>');
  assert.equal(snapshotPoint(off, open, close), off.length - 1, 'thinking off');
  const kept = sys + '<|im_start|>assistant\n<think>let me look</think><tool_call>x</tool_call><|im_end|>\n<|im_start|>tool\nr<|im_end|>\n';
  const second = encode(kept + '<|im_start|>assistant\n<think>');
  assert.equal(snapshotPoint(second, open, close), encode(sys + '<|im_start|>assistant\n<think>').length, 'stops where the dropped thinking was');
  const empty = encode(sys + '<|im_start|>assistant\n<think></think>Hello<|im_end|>\n<|im_start|>user\nmore<|im_end|>\n<|im_start|>assistant\n<think>');
  assert.equal(snapshotPoint(empty, open, close), empty.length - 1, 'an earlier turn without thinking stays the same');
  assert.equal(snapshotPoint([5], open, close), 0);
});

test('startsWith compares token ids', () => {
  assert.ok(startsWith([1, 2, 3], [1, 2]));
  assert.ok(!startsWith([1, 2, 3], [1, 3]));
  assert.ok(!startsWith([1], [1, 2]));
  assert.ok(!startsWith([1], null));
});

// A reply with three tool steps, rendered exactly as Squiggle does (nativeMessages → lfm3Prompt).
function toolLoop() {
  const sys = { role: 'system', content: 'You are Squiggle. ' + 'Rules and tools. '.repeat(60) };
  const msgs = [sys, { role: 'user', content: 'what is in my repo and how big is it?' }];
  const steps = [];
  const render = () => (lfm3.bos + lfm3.prompt(nativeMessages(msgs), [{ type: 'function', function: { name: 'bash', description: 'run', parameters: {} } }], { thinking: true }));
  for (let i = 0; i < 3; i++) {
    const reasoning = `Step ${i}: I should run a command to check.`;
    const call = { id: 'c' + i, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `ls -la /repo/${i}` }) } };
    steps.push({ prompt: render(), reply: `\n${reasoning}</think><tool_call>\n<function=bash>\n<parameter=command>\nls -la /repo/${i}\n</parameter>\n</function>\n</tool_call><|im_end|>` });
    msgs.push({ role: 'model', content: '', tool_calls: [call], reasoning_content: reasoning });
    msgs.push({ role: 'tool', content: [{ name: 'bash', response: { stdout: `file${i}.txt\n`.repeat(40) } }] });
  }
  steps.push({ prompt: render(), reply: '\nDone.</think>Your repo has 120 files.<|im_end|>' });
  return steps;
}

test('a tool loop reads each prompt in full the first time, then only what changed', async () => {
  const p = fakePipeline();
  const h = install(p);
  assert.ok(h, 'installed');
  assert.equal(p.kvCache.max, 2, 'room for a snapshot');
  const steps = toolLoop();
  let full = 0;
  const per = [];
  for (const { prompt, reply } of steps) {
    const seen = await complete(p, prompt, reply);
    per.push({ ...h.last });
    assert.deepEqual(seen, encode(prompt), 'the cache holds exactly this prompt, reused part included');
    full += encode(prompt).length;
  }
  assert.equal(h.totals.calls, 4);
  assert.ok(h.totals.reused > 0);
  assert.equal(h.totals.read + h.totals.reused, full);
  // The first call reads everything; each later one reads the last step again (its thinking is dropped from the
  // prompt now, which shifts its call and result) plus the new step.
  assert.deepEqual(per.map(x => x.reused > 0), [false, true, true, true]);
  assert.ok(h.totals.read < full * 0.55, `read ${h.totals.read} of ${full} prompt tokens`);
  assert.ok(h.last.reused > encode(steps[0].prompt).length - 2, 'the last step reuses at least the first prompt');
});

test('a prompt that changes early (a new turn, a new system prompt) is read in full, and still correct', async () => {
  const p = fakePipeline();
  const h = install(p);
  const steps = toolLoop();
  await complete(p, steps[0].prompt, steps[0].reply);
  const changed = steps[1].prompt.replace('You are Squiggle.', 'You are Squiggle!');
  const seen = await complete(p, changed, 'ok');
  assert.deepEqual(seen, encode(changed));
  assert.equal(h.last.reused, 0);
  // And reuse picks up again after that.
  const again = await complete(p, changed + 'x<|im_end|>\n<|im_start|>assistant\n<think>', 'ok');
  assert.deepEqual(again, encode(changed + 'x<|im_end|>\n<|im_start|>assistant\n<think>'));
  assert.ok(h.last.reused > 0);
});

test('the same prompt twice (a retry) reuses all but its last token', async () => {
  const p = fakePipeline();
  const h = install(p);
  const { prompt } = toolLoop()[0];
  await complete(p, prompt, 'partial');
  const seen = await complete(p, prompt, 'again');
  assert.deepEqual(seen, encode(prompt));
  assert.equal(h.last.reused, encode(prompt).length - 1);
  assert.equal(h.last.read, 1);
});

test('chat completions (not raw) drop the snapshot and go through untouched', async () => {
  const p = fakePipeline();
  install(p);
  const { prompt } = toolLoop()[0];
  await complete(p, prompt, 'x');
  assert.ok(p.kvCache.seqs.has(1));
  p.resetChat();
  p.conversation = { isTextCompletion: false, prompt: '' };
  await p.getInputData();
  assert.ok(!p.kvCache.seqs.has(1));
});

test('left alone: no internals, an artifact model, a model-wide sliding window, installed twice', () => {
  assert.equal(reusePrefix({}, lfm3.cacheMark), null);
  assert.equal(reusePrefix({ loadedModelIdToPipeline: new Map([['m', { ...fakePipeline(), artifact: {} }]]) }, lfm3.cacheMark), null);
  assert.equal(reusePrefix({ loadedModelIdToPipeline: new Map([['m', { ...fakePipeline(), slidingWindowSize: 256 }]]) }, lfm3.cacheMark), null);
  const p = fakePipeline();
  assert.ok(install(p));
  assert.equal(install(p), null, 'never twice');
  assert.equal(reusePrefix({ loadedModelIdToPipeline: new Map([['m', fakePipeline()]]) }, null), null, 'a format without a mark');
});
