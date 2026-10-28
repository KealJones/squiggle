import test from 'node:test';
import assert from 'node:assert/strict';
import { speakable, splitSentences, takeSpeakable, pickVoice, support, createCall } from '../app/src/voice.js';

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
