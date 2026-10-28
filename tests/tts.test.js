import test from 'node:test';
import assert from 'node:assert/strict';
import { TTS_MODELS, modelUrl, voiceUrl, validVoice, normalizeText, splitPunct, toPhonemes, tokenize, VOCAB, halve, styleFor, readNpz, tidyAudio, STYLE_DIM } from '../app/src/tts-text.js';
import { createTTS, createPlayer, neuralSupported } from '../app/src/tts.js';

test('model files are pinned to a commit', () => {
  for (const id of Object.keys(TTS_MODELS)) {
    assert.match(modelUrl(id), /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//);
    assert.ok(TTS_MODELS[id].voices[TTS_MODELS[id].defaultVoice]);
  }
  assert.equal(voiceUrl('kokoro', 'af_heart'), modelUrl('kokoro', 'voices/af_heart.bin'));
  assert.equal(voiceUrl('kitten', 'expr-voice-2-f'), modelUrl('kitten', 'voices.npz'));
  assert.equal(validVoice('kokoro', 'nope'), 'af_heart');
  assert.equal(validVoice('kokoro', 'bf_emma'), 'bf_emma');
});

test('normalizeText speaks numbers, money, times and titles', () => {
  assert.equal(normalizeText('It costs $4.50, or £1.'), 'It costs 4 dollars and 50 cents, or 1 pound.');
  assert.equal(normalizeText('Meet at 3:30 or 10:00 in 1984.'), 'Meet at 3 30 or 10 o\'clock in 19 84.');
  assert.equal(normalizeText('Version 3.14 of 1,000 files'), 'Version 3 point 1 4 of 1000 files');
  assert.equal(normalizeText('Dr. Smith and Mr. Jones'), 'Doctor Smith and Mister Jones');
  assert.equal(normalizeText('pages 3-5'), 'pages 3 to 5');
  assert.equal(normalizeText('the U.S. economy'), 'the U-S- economy');
});

test('splitPunct keeps punctuation runs separate', () => {
  assert.deepEqual(splitPunct('Hi, there. Ok'), [{ punct: false, text: 'Hi' }, { punct: true, text: ', ' }, { punct: false, text: 'there' }, { punct: true, text: '. ' }, { punct: false, text: 'Ok' }]);
});

test('toPhonemes: punctuation stays, Kokoro fixes, Kitten spacing, British voices use en', async () => {
  const calls = [];
  const espeak = async (t, lang) => { calls.push([t, lang]); return [{ Hello: 'həlˈoʊ', world: 'wˈɜːld', ninety: 'nˈaɪnti', 'n̩': 'n̩' }[t] || t]; };
  assert.equal(await toPhonemes('Hello, world.', { espeak, model: 'kokoro', voice: 'af_heart' }), 'həlˈoʊ, wˈɜːld.');
  assert.deepEqual(calls.map(c => c[1]), ['en-us', 'en-us']);
  assert.equal(await toPhonemes('ninety', { espeak, model: 'kokoro', voice: 'af_heart' }), 'nˈaɪndi', 'American flap');
  calls.length = 0;
  assert.equal(await toPhonemes('ninety', { espeak, model: 'kokoro', voice: 'bf_emma' }), 'nˈaɪnti');
  assert.equal(calls[0][1], 'en');
  // Kitten: words and marks separated by spaces, like Python's \w+|[^\w\s] (marks split off).
  assert.equal(await toPhonemes('Hello, world.', { espeak, model: 'kitten' }), 'həlˈoʊ , wˈɜːld .');
  assert.equal(await toPhonemes('n̩', { espeak, model: 'kitten' }), 'n ̩');
});

test('tokenize: per-character ids with 0 pads; unknown characters dropped', () => {
  assert.deepEqual(tokenize('hi!', 'kokoro'), [0, 50, 51, 5, 0]);
  assert.deepEqual(tokenize('a\u{1F600}b', 'kokoro'), [0, 43, 44, 0]);
  // Kitten uses StyleTTS 2's table, where a repeated symbol keeps its last index
  // (the same ids as onnx-community/kitten-tts-nano-0.1-ONNX's tokenizer.json).
  const k = VOCAB.kitten;
  assert.equal(k.get('"'), 15); assert.equal(k.get(' '), 16); assert.equal(k.get('A'), 17);
  assert.equal(k.get('ɑ'), 69); assert.equal(k.get('ˈ'), 156); assert.equal(k.get("'"), 176);
  assert.equal(k.get('̩'), 175); assert.equal(k.get('ᵻ'), 177);
  assert.equal(VOCAB.kokoro.get('ʊ'), 135);
});

test('halve cuts long text near the middle, preferring sentence and clause ends', () => {
  assert.deepEqual(halve('One two three. Four five six seven eight'), ['One two three.', 'Four five six seven eight']);
  assert.deepEqual(halve('alpha beta gamma delta'), ['alpha beta', 'gamma delta']);
  assert.deepEqual(halve('word'), ['wo', 'rd']);
});

test('styleFor: Kokoro by token count, Kitten by text length, clamped', () => {
  const rows = 4, table = new Float32Array(rows * STYLE_DIM).map((_, i) => Math.floor(i / STYLE_DIM));
  assert.equal(styleFor(table, 'kokoro', { ids: [0, 1, 2, 0] })[0], 2);
  assert.equal(styleFor(table, 'kokoro', { ids: new Array(50) })[0], 3);
  assert.equal(styleFor(table, 'kitten', { text: 'abc' })[0], 3);
  assert.equal(styleFor(table, 'kitten', { text: 'a' }).length, STYLE_DIM);
});

// A stored zip64 .npz like numpy writes.
function npz(entries) {
  const parts = [];
  for (const [name, arr] of entries) {
    const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${arr.length},), }`.padEnd(117, ' ') + '\n';
    const npy = Buffer.concat([Buffer.from([0x93]), Buffer.from('NUMPY'), Buffer.from([1, 0]), Buffer.from(Uint16Array.of(header.length).buffer), Buffer.from(header), Buffer.from(Float32Array.from(arr).buffer)]);
    const fname = Buffer.from(name + '.npy');
    const extra = Buffer.alloc(20); extra.writeUInt16LE(1, 0); extra.writeUInt16LE(16, 2); extra.writeBigUInt64LE(BigInt(npy.length), 4); extra.writeBigUInt64LE(BigInt(npy.length), 12);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(45, 4); h.writeUInt32LE(0xffffffff, 18); h.writeUInt32LE(0xffffffff, 22); h.writeUInt16LE(fname.length, 26); h.writeUInt16LE(extra.length, 28);
    parts.push(h, fname, extra, npy);
  }
  return new Uint8Array(Buffer.concat([...parts, Buffer.from([0x50, 0x4b, 0x01, 0x02])]));
}

test('readNpz reads stored zip64 entries by name', () => {
  const buf = npz([['a', [1, 2, 3]], ['expr-voice-2-f', [0.5, -0.25]]]);
  assert.deepEqual(Array.from(readNpz(buf, 'expr-voice-2-f')), [0.5, -0.25]);
  assert.deepEqual(Array.from(readNpz(buf.buffer, 'a')), [1, 2, 3]);
  assert.throws(() => readNpz(buf, 'missing'), /not found/);
});

test('tidyAudio trims silence, keeps a short tail and fades the edges', () => {
  const sr = 1000, s = new Float32Array(1000);
  for (let i = 300; i < 600; i++) s[i] = 0.5;
  const out = tidyAudio(s, sr, { keepStartMs: 10, keepEndMs: 50, fadeMs: 5 });
  assert.equal(out.length, 300 + 10 + 50);
  assert.equal(out[0], 0);
  assert.equal(out[15], 0.5);
  assert.equal(tidyAudio(new Float32Array(10), sr).length, 0);
});

// ── tts.js with a fake Worker ──────────────────────────────────────────────
function fakeWorkerClass(script) {
  const made = [];
  class W {
    constructor(url, opts) { this.url = url; this.opts = opts; this.sent = []; this.terminated = false; made.push(this); }
    postMessage(m) { this.sent.push(m); setTimeout(() => script(this, m), 0); }
    reply(m) { if (!this.terminated) this.onmessage && this.onmessage({ data: m }); }
    terminate() { this.terminated = true; }
  }
  return { W, made };
}

test('createTTS: load with stages, ordered synth, cancel, terminate; module worker', async () => {
  const stages = [], busy = [];
  const { W, made } = fakeWorkerClass((w, m) => {
    if (m.type === 'load') { w.reply({ type: 'stage', stage: 'downloading the voice model' }); w.reply({ type: 'progress', loaded: 5, total: 10 }); w.reply({ type: 'ready', ms: 12, cached: false }); }
    if (m.type === 'speak' && m.text !== 'slow') w.reply({ type: 'audio', id: m.id, samples: new Float32Array([m.id]), sampleRate: 24000, ms: 5 });
    if (m.type === 'cancel') for (const s of w.sent.filter(x => x.type === 'speak' && x.text === 'slow')) w.reply({ type: 'cancelled', id: s.id });
  });
  const t = createTTS({ model: 'kitten', voice: 'expr-voice-2-f', url: 'w.js', WorkerCtor: W, onStage: (s) => stages.push(s), onBusy: (b) => busy.push(b) });
  assert.equal(t.state, 'idle');
  await assert.rejects(t.synth('early'), /not loaded/);
  const r = await t.load();
  assert.equal(r.ms, 12);
  assert.equal(t.state, 'ready');
  assert.deepEqual(made[0].opts, { type: 'module', name: 'squiggle-voice' });
  assert.deepEqual(made[0].sent[0], { type: 'load', model: 'kitten', voice: 'expr-voice-2-f' });
  assert.deepEqual(stages, ['downloading the voice model']);
  const a = await t.synth('one', { speed: 1.2 });
  assert.equal(a.samples[0], 1);
  assert.equal(made[0].sent[1].speed, 1.2);
  assert.deepEqual(busy, [true, false]);
  const slow = t.synth('slow');
  t.cancel();
  await assert.rejects(slow, (e) => e.cancelled === true);
  t.terminate();
  assert.equal(made[0].terminated, true);
  assert.equal(t.state, 'closed');
});

test('createTTS: a load error, a stalled download and a worker crash all fail cleanly', async () => {
  const { W } = fakeWorkerClass((w, m) => { if (m.type === 'load') w.reply({ type: 'error', message: 'no WebAssembly' }); });
  const t1 = createTTS({ url: 'w.js', WorkerCtor: W });
  await assert.rejects(t1.load(), /no WebAssembly/);
  assert.equal(t1.state, 'failed');

  const { W: W2, made } = fakeWorkerClass((w, m) => { if (m.type === 'load') w.reply({ type: 'stage', stage: 'downloading the voice model' }); });
  const t2 = createTTS({ url: 'w.js', WorkerCtor: W2, stallMs: 30 });
  await assert.rejects(t2.load(), /download stalled/);
  assert.equal(made[0].terminated, true, 'a failed load frees the worker');

  const { W: W3, made: m3 } = fakeWorkerClass((w, m) => { if (m.type === 'load') w.reply({ type: 'ready', ms: 1 }); });
  const t3 = createTTS({ url: 'w.js', WorkerCtor: W3 });
  await t3.load();
  const p = t3.synth('hello');
  m3[0].onerror({ message: 'out of memory', preventDefault() {} });
  await assert.rejects(p, /out of memory/);
  assert.equal(t3.state, 'failed');
  await assert.rejects(t3.synth('again'), /out of memory/);
});

test('createPlayer: unlock in the gesture, play resolves on end, stop ends early', async () => {
  const log = [];
  class Ctx {
    constructor() { this.state = 'suspended'; this.destination = {}; log.push('new'); }
    resume() { this.state = 'running'; log.push('resume'); return Promise.resolve(); }
    close() { log.push('close'); this.state = 'closed'; }
    createBuffer(ch, len, sr) { const d = new Float32Array(len); return { length: len, sampleRate: sr, copyToChannel: (s) => d.set(s), data: d }; }
    createBufferSource() {
      const src = { connect() {}, disconnect() {}, start() { log.push(['start', src.buffer.length]); if (src.buffer.length > 1) src.t = setTimeout(() => src.onended && src.onended(), 10); }, stop() { log.push('stop'); clearTimeout(src.t); src.onended && src.onended(); } };
      return src;
    }
  }
  const p = createPlayer({ AudioContextCtor: Ctx });
  await assert.rejects(p.play(new Float32Array(4), 24000), /not unlocked/);
  p.unlock();
  assert.deepEqual(log.slice(0, 3), ['new', 'resume', ['start', 1]]);
  await p.play(new Float32Array(240), 24000);
  const playing = p.play(new Float32Array(2400), 24000);
  await new Promise(r => setTimeout(r, 1));
  p.stop();
  await playing; // resolves after stop
  p.close();
  assert.equal(p.state, 'closed');
  assert.ok(log.includes('close'));
  assert.equal(neuralSupported({}), false);
  assert.equal(neuralSupported({ Worker() {}, AudioContext() {}, WebAssembly: {} }), true);
});
