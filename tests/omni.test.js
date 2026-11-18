// LFM3 Omni on Tilde: pictures, video and sound reach the model itself (media.js, attachments.js), the engine
// swaps markers for them and snapshots at the shim's safe cut (engine-tilde.js), and its own voice plays a
// sentence once it's made (omni-voice.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as media from '../app/src/media.js';
import { readAttachment, attachmentPrompt, replayNote, toRecord, setOcr, setSees, checkFiles, MAX_BYTES } from '../app/src/attachments.js';
import { asEngine } from '../app/src/engine-tilde.js';
import { omniSpeaker } from '../app/src/omni-voice.js';

test('media: a kept file splits out of prompt text at its marker, and decodes once to the same object', async () => {
  const id = media.keep(new Blob(['x']), 'image', 'cat.png');
  const parts = media.split(`look ${media.marker(id)} here ⟦media:gone⟧`);
  assert.equal(parts.length, 3);
  assert.equal(parts[0], 'look ');
  assert.equal(parts[1].kind, 'image');
  assert.equal(parts[2], ' here ⟦media:gone⟧', 'a marker for nothing kept stays text');
  let n = 0;
  const dec = () => Promise.resolve({ image: { n: ++n } });
  const a = await media.decoded(id, dec), b = await media.decoded(id, dec);
  assert.equal(a, b, 'Tilde compares media by identity, so prompt reuse needs the same object');
  assert.equal(n, 1);
  assert.equal(media.kindOfMedia('video/mp4', 'x'), 'video');
  assert.equal(media.kindOfMedia('', 'note.m4a'), 'audio');
  assert.equal(media.kindOfMedia('image/png', 'a.png'), null);
  assert.ok(media.tokensFor('video', { seconds: 600 }) < 3000, 'a long video is counted as the 30 s that are read');
});

test('attachments: a model that sees gets the picture itself, no OCR; one that doesn\'t gets the text as before', async () => {
  let ocrCalls = 0;
  setOcr(async () => { ocrCalls++; return { text: 'TOTAL 12.50' }; });
  setSees((k) => ['image', 'video', 'audio'].includes(k));
  try {
    const img = new File([new Uint8Array(10)], 'receipt.png', { type: 'image/png' });
    const a = await readAttachment(img, new Set(), 's1');
    assert.equal(ocrCalls, 0);
    assert.equal(a.kind, 'image');
    assert.ok(a.media && media.get(a.media));
    const p = attachmentPrompt([a], 4000);
    assert.ok(p.text.includes(media.marker(a.media)), p.text);
    assert.ok(p.mediaTokens > 0);
    assert.ok(!/can't see images/.test(p.text));
    const rec = toRecord(a);
    assert.equal(rec.media, a.media);
    assert.ok(replayNote([rec]).includes(media.marker(a.media)), 'a picture still kept here is shown again later');
    const clip = await readAttachment(new File([new Uint8Array(10)], 'clip.mp4', { type: 'video/mp4' }), new Set(), 's1');
    assert.equal(clip.kind, 'video');
    assert.ok(!replayNote([toRecord(clip)]).includes('⟦media:'), 'a video is only named in later turns');
    // A video bigger than the 20 MB text limit is fine when the model watches it.
    const big = { name: 'big.mov', type: 'video/quicktime', size: MAX_BYTES * 3 };
    assert.equal(checkFiles([big]).ok.length, 1);
    setSees(() => false);
    assert.equal(checkFiles([big]).ok.length, 0);
    const b = await readAttachment(img, new Set(), 's1');
    assert.equal(ocrCalls, 1);
    assert.ok(!b.media);
    assert.ok(!attachmentPrompt([a], 4000).text.includes('⟦media:'), 'a model that can\'t see gets no marker');
  } finally { setSees(() => false); setOcr(async () => ({ text: '' })); }
});

// A fake Tilde: tokens are characters, so snapshot points can be checked by eye.
function fakeLlm(reply) {
  const tk = { encode: (s) => [...s].map((c) => c.charCodeAt(0)) };
  const calls = [];
  return {
    calls,
    tokenizer: tk,
    gpu: { lost: null, device: { destroy() {} } },
    items: (parts) => parts.flatMap((p) => (typeof p === 'string' ? tk.encode(p) : [p])),
    formatChat: (msgs) => msgs.map((m) => m.content).join('\n'),
    async generate(items, o) {
      calls.push({ items, o });
      o.onRead({ reused: 0, read: items.length });
      for (const piece of reply) { if (o.signal.aborted) break; o.onToken(piece); await null; }
      return reply.join('');
    },
  };
}

test('engine-tilde: streams Tilde\'s tokens as WebLLM chunks, snapshots at the safe cut, swaps markers for files', async () => {
  const llm = fakeLlm(['Hel', 'lo']);
  const k = { readVideo: async () => ({ frames: [] }), decodeAudio: async () => new Float32Array(16000) };
  const eng = asEngine(k, llm);
  const prompt = '<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n<think>';
  let out = '';
  for await (const c of await eng.completions.create({ prompt, max_tokens: 20, temperature: 0.1 })) out += c.choices[0].text;
  assert.equal(out, 'Hello');
  const { o } = llm.calls[0];
  assert.equal(o.snapshotAt, prompt.length - 1, 'no earlier assistant turn: everything but the last token');
  assert.equal(o.topK, 50);
  // A second turn: the snapshot stops right after the last assistant turn's <think> (its thinking is dropped next time).
  const p2 = '<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n<think>hmm</think>Hello<|im_end|>\n<|im_start|>user\nmore<|im_end|>\n<|im_start|>assistant\n<think>';
  for await (const c of await eng.completions.create({ prompt: p2 })) void c;
  const cut = p2.indexOf('<think>') + '<think>'.length;
  assert.equal(llm.calls[1].o.snapshotAt, cut);
  // Media: the marker becomes <|vision_start|>, the decoded file, <|vision_end|>.
  const id = media.keep(new Blob(['a']), 'audio', 'memo.m4a');
  for await (const c of await eng.completions.create({ prompt: `<|im_start|>user\n${media.marker(id)}what is said?<|im_end|>\n<|im_start|>assistant\n<think>` })) void c;
  const items = llm.calls[2].items;
  const at = items.findIndex((x) => typeof x !== 'number');
  assert.ok(at > 0 && items[at].audio instanceof Float32Array);
  assert.equal(String.fromCharCode(...items.slice(at - 16, at)), '<|vision_start|>');
  // Stopping mid-reply ends the stream quietly, like WebLLM's interruptGenerate.
  const slow = fakeLlm(['a', 'b', 'c', 'd']);
  const e2 = asEngine(k, slow);
  let got = '';
  for await (const c of await e2.completions.create({ prompt: 'x' })) { got += c.choices[0].text; e2.interruptGenerate(); }
  assert.ok(got.length < 4);
});

test('engine-tilde: a lost GPU is reported in words the shim reloads on; a full window says what to do', async () => {
  const llm = fakeLlm([]);
  llm.generate = async () => { llm.gpu.lost = { reason: 'destroyed' }; throw new Error('GPU lost: destroyed'); };
  const eng = asEngine({}, llm);
  await assert.rejects(async () => { for await (const c of await eng.completions.create({ prompt: 'x' })) void c; }, /device was lost/);
  const full = fakeLlm([]);
  full.generate = async () => { throw new Error('context is full'); };
  await assert.rejects(async () => { for await (const c of await asEngine({}, full).completions.create({ prompt: 'x' })) void c; }, /no longer fits/);
});

test('omni voice: a sentence plays once it\'s all made, the next one is made meanwhile, cancel stops both', async () => {
  const played = [];
  class FakeAC {
    constructor() { this.currentTime = 0; this.destination = {}; }
    resume() {}
    createBuffer(ch, n) { return { n, copyToChannel() {} }; }
    createBufferSource() { const s = { connect() {}, start() { played.push(s.buffer.n); setTimeout(() => s.onended && s.onended(), 1); }, stop() {} }; return s; }
  }
  globalThis.AudioContext = FakeAC;
  const made = [];
  const sp = omniSpeaker({ speak: async (text, { onAudio, signal }) => {
    made.push(text);
    for (let i = 0; i < 3; i++) { if (signal.aborted) return; onAudio(new Float32Array(100)); await new Promise((r) => setTimeout(r, 2)); }
  } });
  sp.prime();
  const a = sp.prepare('One.'), b = sp.prepare('Two.');
  await new Promise((r) => sp.play(a, r));
  assert.deepEqual(played.slice(-1), [300], 'the whole sentence in one buffer');
  assert.deepEqual(made, ['One.', 'Two.'], 'the next sentence was being made while the first played');
  await new Promise((r) => sp.play(b, r));
  const c = sp.prepare('Three.');
  sp.cancel();
  let ended = false;
  sp.play(c, () => { ended = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(ended);
  delete globalThis.AudioContext;
});
