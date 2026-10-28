import test from 'node:test';
import assert from 'node:assert/strict';
import { speakable, splitSentences, takeSpeakable, pickVoice, support, createCall, neuralSpeaker, systemSpeaker, realTimeFactor } from '../app/src/voice.js';

test('speakable strips markdown formatting', () => {
  const s = speakable('# Title\n\nThis is **bold**, *italic* and `code`.\n\n- first item\n- second item\n\n1. one\n> quoted');
  assert.equal(s, 'Title.\nThis is bold, italic and code.\nfirst item.\nsecond item.\none.\nquoted');
});

test('speakable replaces code blocks (closed or not) with a notice', () => {
  assert.equal(speakable('Run this:\n```js\nconst a = 1;\n```\nDone.'), 'Run this:\nCode omitted.\nDone.');
  assert.equal(speakable('Look:\n```\nunfinished'), 'Look:\nCode omitted.');
  assert.equal(speakable('```a\n1\n```\n```b\n2\n```'), 'Code omitted.');
});

test('speakable turns URLs into domains and keeps link text', () => {
  assert.equal(speakable('See [the docs](https://developers.cloudflare.com/workers/) now.'), 'See the docs now.');
  assert.equal(speakable('Visit https://www.example.com/a/b?x=1, then stop.'), 'Visit example.com, then stop.');
  assert.equal(speakable('<https://github.com/x/y>'), 'github.com');
  assert.equal(speakable('![diagram](https://x.io/a.png)'), 'diagram');
});

test('speakable drops tables rules, html, emoji and keeps snake_case', () => {
  assert.equal(speakable('| a | b |\n|---|---|\n| 1 | 2 |'), 'a, b.\n1, 2.');
  assert.equal(speakable('<b>hi</b> ⚠️ there'), 'hi there');
  assert.equal(speakable('use my_var_name here'), 'use my_var_name here');
  assert.equal(speakable('---\ntext'), 'text');
  assert.equal(speakable(''), '');
});

test('splitSentences splits, keeps abbreviations and decimals, merges short, splits long', () => {
  assert.deepEqual(splitSentences('This is the first sentence of many. This is the second one, longer! And a third question here?'),
    ['This is the first sentence of many.', 'This is the second one, longer!', 'And a third question here?']);
  assert.deepEqual(splitSentences('Yes. Okay. We can use e.g. a cache, version 3.5 is fine.'), ['Yes. Okay. We can use e.g. a cache, version 3.5 is fine.']);
  const long = Array(60).fill('word').join(' ') + ', ' + Array(60).fill('more').join(' ') + '.';
  const parts = splitSentences(long);
  assert.ok(parts.length >= 2 && parts.every(p => p.length <= 240));
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), long);
});

test('takeSpeakable streams complete sentences only and never code', () => {
  let from = 0;
  const say = [];
  const feed = (raw, final) => { const r = takeSpeakable(raw, from, final); from = r.next; say.push(...r.chunks); };
  const full = 'Here is the first sentence of the answer. And the second **one** is longer. Code:\n```js\nlet a = 1. 2. 3.\n```\nAll done now';
  for (let i = 1; i <= full.length; i++) feed(full.slice(0, i), false);
  assert.deepEqual(say.slice(0, 2), ['Here is the first sentence of the answer.', 'And the second one is longer.']);
  assert.ok(!say.join(' ').includes('let a'));
  feed(full, true);
  assert.equal(say.join(' '), 'Here is the first sentence of the answer. And the second one is longer. Code: Code omitted. All done now');
  // incomplete sentence is held back
  assert.deepEqual(takeSpeakable('Half a sent', 0), { chunks: [], next: 0 });
});

test('pickVoice prefers saved, then exact locale and natural voices', () => {
  const v = [
    { name: 'A', lang: 'de-DE', voiceURI: 'a' }, { name: 'B', lang: 'en-GB', voiceURI: 'b' },
    { name: 'C Natural', lang: 'en-US', voiceURI: 'c' }, { name: 'D', lang: 'en-US', voiceURI: 'd', default: true },
  ];
  assert.equal(pickVoice(v, 'en-US').voiceURI, 'c');
  assert.equal(pickVoice(v, 'en-US', 'b').voiceURI, 'b');
  assert.equal(pickVoice(v, 'en-AU').voiceURI, 'c');
  assert.equal(pickVoice(v, 'de').voiceURI, 'a');
  assert.equal(pickVoice([], 'en'), null);
});

test('pickVoice on an iPhone: premium/enhanced voices win; Eloquence and novelty voices never do', () => {
  const ios = [
    { name: 'Albert', lang: 'en-US', voiceURI: 'com.apple.speech.synthesis.voice.Albert' },
    { name: 'Eddy (English (US))', lang: 'en-US', voiceURI: 'com.apple.eloquence.en-US.Eddy', default: true },
    { name: 'Grandpa (English (US))', lang: 'en-US', voiceURI: 'com.apple.eloquence.en-US.Grandpa' },
    { name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.voice.compact.en-US.Samantha' },
    { name: 'Fred', lang: 'en-US', voiceURI: 'com.apple.speech.synthesis.voice.Fred' },
  ];
  assert.equal(pickVoice(ios, 'en-US').name, 'Samantha', 'plain Samantha beats the robotic default');
  const better = [...ios, { name: 'Ava', lang: 'en-US', voiceURI: 'com.apple.voice.enhanced.en-US.Ava' }];
  assert.equal(pickVoice(better, 'en-US').name, 'Ava');
  const best = [...better, { name: 'Zoe', lang: 'en-US', voiceURI: 'com.apple.voice.premium.en-US.Zoe' }, { name: 'Serena', lang: 'en-GB', voiceURI: 'com.apple.voice.premium.en-GB.Serena' }];
  assert.equal(pickVoice(best, 'en-US').name, 'Zoe', 'same quality: the exact locale wins');
  assert.equal(pickVoice([{ name: 'Microsoft Ava Online (Natural) - English (United States)', lang: 'en-US', voiceURI: 'x' }, { name: 'Microsoft David - English (United States)', lang: 'en-US', voiceURI: 'y', default: true }], 'en-US').voiceURI, 'x');
  assert.equal(pickVoice([{ name: 'Google US English', lang: 'en-US', voiceURI: 'g' }, { name: 'Fred', lang: 'en-US', voiceURI: 'f', default: true }], 'en-US').voiceURI, 'g');
});

test('support reports missing APIs', () => {
  assert.equal(support({}).ok, false);
  assert.equal(support({ webkitSpeechRecognition: function () {}, speechSynthesis: {}, SpeechSynthesisUtterance: function () {} }).ok, true);
});

test('createCall: utterance → send → spoken in chunks, recognition paused while speaking', async () => {
  const recs = [], spoken = [];
  class SR { constructor() { recs.push(this); this.running = false; } start() { this.running = true; this.onstart?.(); } abort() { this.running = false; setTimeout(() => this.onend?.(), 0); } }
  class U { constructor(t) { this.text = t; } }
  const synth = { getVoices: () => [], speak: (u) => { if (u.text) { spoken.push({ text: u.text, recRunning: recs[0].running }); setTimeout(() => u.onend(), 5); } }, cancel() {} };
  let call;
  const states = [];
  call = createCall({
    SR, synth, Utterance: U, silenceMs: 20, resumeDelayMs: 10, onChange: (s) => states.push(s.state),
    send: async (text) => { call.feed('You said: ' + text + '. Second sentence here for you.'); call.finish('You said: ' + text + '. Second sentence here for you.'); },
  });
  call.start();
  recs[0].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'hello there' }], { isFinal: true })] });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(spoken.map(s => s.text).join('|'), 'You said: hello there.|Second sentence here for you.');
  assert.ok(spoken.every(s => !s.recRunning));
  assert.equal(call.snapshot().state, 'listening');
  assert.ok(recs[0].running);
  call.end();
  assert.equal(call.snapshot().state, 'idle');
  assert.equal(recs[0].running, false);
});

// A natural voice made of fakes: tts answers each synth after `synthMs`
// (reporting `reportMs`), the player "plays" for `playMs`.
function fakeNatural({ synthMs = 5, reportMs = 10, audioMs = 100, playMs = 5, ready = true, fail = null } = {}) {
  const log = [];
  let busy = Promise.resolve();
  const tts = {
    state: ready ? 'ready' : 'loading',
    synth(text) {
      log.push(['synth', text]);
      const p = busy.then(() => new Promise((res, rej) => setTimeout(() => (fail && fail(text) ? rej(new Error('boom')) : res({ samples: new Float32Array(24 * audioMs).fill(0.1), sampleRate: 24000, ms: reportMs })), synthMs)));
      busy = p.catch(() => {});
      return p;
    },
    cancel() { log.push(['cancel']); },
  };
  const player = {
    unlock() { log.push(['unlock']); },
    play(samples) { log.push(['play', samples.length]); return new Promise(r => setTimeout(r, playMs)); },
    stop() { log.push(['stop']); },
  };
  return { tts, player, log, speaker: neuralSpeaker({ tts, player, voice: 'af_heart' }) };
}
function fakeCallParts() {
  const recs = [], spoken = [];
  class SR { constructor() { recs.push(this); this.running = false; } start() { this.running = true; this.onstart?.(); } abort() { this.running = false; setTimeout(() => this.onend?.(), 0); } }
  class U { constructor(t) { this.text = t; } }
  const synth = { getVoices: () => [], speak: (u) => { if (u.text) { spoken.push(u.text); setTimeout(() => u.onend(), 5); } else spoken.primed = true; }, cancel() {} };
  return { SR, U, synth, recs, spoken, system: systemSpeaker({ synth, Utterance: U }) };
}
const REPLY = 'First sentence of the reply is here. Second sentence of the reply is here. Third sentence of the reply is here.';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

test('realTimeFactor averages the last chunks', () => {
  assert.equal(realTimeFactor([]), 0);
  assert.equal(realTimeFactor([{ synthMs: 100, audioMs: 1000 }, { synthMs: 300, audioMs: 1000 }]), 0.2);
  assert.equal(realTimeFactor([{ synthMs: 9000, audioMs: 1000 }, { synthMs: 100, audioMs: 1000 }, { synthMs: 100, audioMs: 1000 }, { synthMs: 100, audioMs: 1000 }]), 0.1);
});

test('natural voice: primes both voices in the tap, synthesizes ahead while playing, never uses system speech', async () => {
  const P = fakeCallParts(), N = fakeNatural({ synthMs: 5, playMs: 20 });
  let call;
  call = createCall({ SR: P.SR, speaker: N.speaker, fallback: P.system, silenceMs: 10, resumeDelayMs: 5,
    send: async () => { call.feed(REPLY); call.finish(REPLY); } });
  call.start();
  assert.ok(P.spoken.primed, 'system speech primed');
  assert.deepEqual(N.log[0], ['unlock'], 'audio unlocked inside start()');
  P.recs[0].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'hi' }], { isFinal: true })] });
  await wait(300);
  const kinds = N.log.map(l => l[0]);
  assert.deepEqual(N.log.filter(l => l[0] === 'synth').map(l => l[1]), ['First sentence of the reply is here.', 'Second sentence of the reply is here.', 'Third sentence of the reply is here.']);
  // The second chunk was requested before the first one started playing.
  assert.ok(kinds.indexOf('play') > kinds.lastIndexOf('synth') - 1 && N.log.slice(0, kinds.indexOf('play')).filter(l => l[0] === 'synth').length >= 2, JSON.stringify(N.log));
  assert.equal(kinds.filter(k => k === 'play').length, 3);
  assert.deepEqual(P.spoken.slice(), []);
  assert.equal(call.snapshot().state, 'listening');
  assert.equal(call.voice, 'natural');
  call.end();
});

test('natural voice still loading: that reply uses the system voice; the next one is natural', async () => {
  const P = fakeCallParts(), N = fakeNatural({ ready: false });
  let call;
  call = createCall({ SR: P.SR, speaker: N.speaker, fallback: P.system, silenceMs: 10, resumeDelayMs: 5,
    send: async () => { call.feed(REPLY); call.finish(REPLY); } });
  call.start();
  P.recs[0].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'hi' }], { isFinal: true })] });
  await wait(150);
  assert.equal(P.spoken.length, 3, 'whole reply in one voice');
  assert.equal(N.log.filter(l => l[0] === 'synth').length, 0);
  N.tts.state = 'ready';
  P.recs[0].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'again' }], { isFinal: true })] });
  await wait(200);
  assert.equal(N.log.filter(l => l[0] === 'play').length, 3);
  assert.equal(P.spoken.length, 3);
  call.end();
});

test('natural voice fails mid-reply: the failed chunk and the rest are said by the system voice, once', async () => {
  const P = fakeCallParts(), N = fakeNatural({ fail: (t) => /Second/.test(t) });
  const fallbacks = [];
  let call;
  call = createCall({ SR: P.SR, speaker: N.speaker, fallback: P.system, silenceMs: 10, resumeDelayMs: 5,
    onFallback: (reason, detail) => fallbacks.push([reason, detail.message]),
    send: async () => { call.feed(REPLY); call.finish(REPLY); } });
  call.start();
  P.recs[0].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'hi' }], { isFinal: true })] });
  await wait(200);
  assert.deepEqual(fallbacks, [['error', 'boom']]);
  assert.equal(N.log.filter(l => l[0] === 'play').length, 1);
  assert.deepEqual(P.spoken.slice(), ['Second sentence of the reply is here.', 'Third sentence of the reply is here.']);
  assert.equal(call.voice, 'system');
  // setSpeaker brings a (new) natural voice back for the next reply.
  const N2 = fakeNatural();
  call.setSpeaker(N2.speaker);
  P.recs[0].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'again' }], { isFinal: true })] });
  await wait(200);
  assert.equal(N2.log.filter(l => l[0] === 'play').length, 3);
  call.end();
});

test('natural voice slower than speech: after two chunks the call switches to the system voice', async () => {
  const P = fakeCallParts(), N = fakeNatural({ reportMs: 250, audioMs: 100 });
  const fallbacks = [];
  let call;
  call = createCall({ SR: P.SR, speaker: N.speaker, fallback: P.system, silenceMs: 10, resumeDelayMs: 5,
    onFallback: (reason, detail) => fallbacks.push([reason, Math.round(detail * 10) / 10]),
    send: async () => { call.feed(REPLY); call.finish(REPLY); } });
  call.start();
  P.recs[0].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'hi' }], { isFinal: true })] });
  await wait(200);
  assert.deepEqual(fallbacks, [['slow', 2.5]]);
  // Two finished syntheses (one of them prefetched) are enough to tell.
  const played = N.log.filter(l => l[0] === 'play').length;
  assert.ok(played >= 1 && played <= 2, String(played));
  assert.ok(N.log.some(l => l[0] === 'cancel'), 'prepared chunks dropped');
  assert.deepEqual(P.spoken.slice(), REPLY.match(/[^.]+\./g).map(x => x.trim()).slice(played), 'the rest, each said once');
  call.end();
});

test('natural voice: barge-in and end stop the audio and drop queued synthesis', async () => {
  const P = fakeCallParts(), N = fakeNatural({ playMs: 200 });
  let call;
  call = createCall({ SR: P.SR, speaker: N.speaker, fallback: P.system, silenceMs: 10, resumeDelayMs: 5,
    send: async () => { call.feed(REPLY); call.finish(REPLY); } });
  call.start();
  P.recs[0].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'hi' }], { isFinal: true })] });
  await wait(60);
  assert.equal(call.snapshot().state, 'speaking');
  call.bargeIn();
  assert.equal(call.snapshot().state, 'listening');
  assert.ok(N.log.some(l => l[0] === 'stop') && N.log.some(l => l[0] === 'cancel'));
  const plays = N.log.filter(l => l[0] === 'play').length;
  await wait(300);
  assert.equal(N.log.filter(l => l[0] === 'play').length, plays, 'nothing more plays after barge-in');
  call.end();
  assert.equal(call.snapshot().state, 'idle');
});

test('natural voice: a play that never ends is cut off by the watchdog', async () => {
  const P = fakeCallParts();
  const log = [];
  const tts = { state: 'ready', synth: async () => ({ samples: new Float32Array(24), sampleRate: 24000, ms: 1 }), cancel() {} };
  const player = { unlock() {}, play: () => new Promise(() => {}), stop() { log.push('stop'); } };
  const sp = neuralSpeaker({ tts, player });
  const t0 = Date.now();
  await new Promise((resolve) => sp.play(sp.prepare('x'), resolve));
  assert.ok(Date.now() - t0 >= 2900 && log.includes('stop'));
  void P;
});
