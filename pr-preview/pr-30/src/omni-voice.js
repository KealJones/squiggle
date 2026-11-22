// LFM3 Omni's own voice and hearing (engine.speak / engine.transcribe, on Tilde), for read aloud, voice calls and
// the composer's microphone. Both run on the GPU between replies, in a side sequence of the model, so the chat's
// prompt stays read.
//
//   omniSpeaker   the speaker interface voice.js uses (prime, prepare, play, cancel), in the model's own voice.
//                 Speech is made slower than real time for now (~0.3× on an iPhone 16, Tilde 2026-11-16), so a
//                 sentence plays once it's all made, while the next one is being made: pauses between sentences
//                 instead of stutters inside them.
//   OmniRecognition  a stand-in for the Web Speech API's SpeechRecognition (what voice.js createCall drives): the
//                 microphone with a simple voice-activity check; each utterance is transcribed by the model.
//   recordOnce    one utterance from the microphone, for the composer: 16 kHz mono PCM.

export const RATE = 24000;

/** The model's own voice as a voice.js speaker. `speak(text, { signal, onAudio })` makes one clip. */
export function omniSpeaker({ speak }) {
  let ac = null;
  const sources = new Set();
  const pending = new Set();
  const ctx = () => (ac ||= new (globalThis.AudioContext || globalThis.webkitAudioContext)({ sampleRate: RATE }));
  return {
    kind: 'omni',
    // Inside the tap: iOS only lets audio start from a gesture, so a silent blip unlocks the context.
    prime() {
      const c = ctx();
      try { c.resume(); const s = c.createBufferSource(); s.buffer = c.createBuffer(1, 1, RATE); s.connect(c.destination); s.start(); } catch {}
    },
    prepare(text) {
      const item = { text, chunks: [], done: false, error: null, wake: null, ctl: new AbortController() };
      pending.add(item);
      item.promise = Promise.resolve()
        .then(() => speak(text, { signal: item.ctl.signal, onAudio: (pcm) => item.chunks.push(pcm) }))
        .catch((e) => { if (!item.ctl.signal.aborted) item.error = e; })
        .finally(() => { item.done = true; pending.delete(item); if (item.wake) item.wake(); });
      return item;
    },
    play(item, onEnd) {
      let ended = false;
      const finish = (err) => { if (ended) return; ended = true; onEnd(err || undefined); };
      const go = () => {
        if (item.error || !item.chunks.length) return finish(item.error);
        const c = ctx();
        try { c.resume(); } catch {}
        const n = item.chunks.reduce((s, x) => s + x.length, 0);
        const buf = c.createBuffer(1, n, RATE);
        let o = 0;
        for (const x of item.chunks) { buf.copyToChannel(x, 0, o); o += x.length; }
        const s = c.createBufferSource();
        s.buffer = buf; s.connect(c.destination);
        sources.add(s);
        s.onended = () => { sources.delete(s); finish(); };
        s.start(c.currentTime + 0.03);
        item.stop = () => { try { s.stop(); } catch {} finish(); };
      };
      if (item.done) go(); else item.wake = go;
    },
    cancel() {
      for (const it of pending) { try { it.ctl.abort(); } catch {} }
      for (const s of sources) { try { s.onended = null; s.stop(); } catch {} }
      sources.clear();
    },
  };
}

// ── Listening ───────────────────────────────────────────────────────────────

// Mono PCM at `from` Hz → 16 kHz, through the browser's own resampler.
export async function to16k(pcm, from) {
  if (from === 16000) return pcm;
  const n = Math.max(1, Math.round((pcm.length * 16000) / from));
  const oc = new OfflineAudioContext(1, n, 16000);
  const b = oc.createBuffer(1, pcm.length, from);
  b.copyToChannel(pcm, 0);
  const s = oc.createBufferSource();
  s.buffer = b; s.connect(oc.destination); s.start();
  return (await oc.startRendering()).getChannelData(0).slice();
}

const join = (parts) => { const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

/**
 * The microphone, cut into utterances by loudness: onUtterance(pcm16k) after each stretch of speech followed by
 * `silenceMs` of quiet. The threshold follows the room's noise floor. Returns { stop() }.
 */
// Call it straight from the tap, before any await: iOS only lets an AudioContext run if it's made and resumed inside
// the gesture (made after awaiting the microphone, it stays suspended and hears nothing; the test iPhone, 2026-11-17).
// One context serves every listen, so a call's later turns (started after a reply, not by a tap) keep hearing.
let micAc = null;
export function micContext() {
  if (!micAc || micAc.state === 'closed') micAc = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
  try { micAc.resume(); } catch {}
  return micAc;
}
export function listen(opts) {
  return listenOn(micContext(), opts);
}

async function listenOn(ac, { onUtterance, onSpeech = () => {}, silenceMs = 900, minSpeechMs = 250, maxMs = 30000, keepAll = false }) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  try { await ac.resume(); } catch {}
  const src = ac.createMediaStreamSource(stream);
  const proc = ac.createScriptProcessor(4096, 1, 1);
  const rate = ac.sampleRate, blockMs = (4096 / rate) * 1000;
  let floor = 0.01, speech = [], pre = [], speechMs = 0, quietMs = 0, talking = false, stopped = false;
  const all = [];   // everything heard (keepAll), for a recording the person ends themselves
  proc.onaudioprocess = (ev) => {
    if (stopped) return;
    const x = ev.inputBuffer.getChannelData(0).slice();
    if (keepAll) all.push(x);
    let e = 0; for (let i = 0; i < x.length; i++) e += x[i] * x[i];
    const rms = Math.sqrt(e / x.length);
    const thr = Math.max(0.012, floor * 3);
    if (!talking) {
      floor = 0.95 * floor + 0.05 * Math.min(rms, 0.05);
      pre.push(x); if (pre.length > 3) pre.shift();   // a little audio from before the voice started
      if (rms > thr) { talking = true; speech = [...pre]; speechMs = 0; quietMs = 0; onSpeech(); }
      return;
    }
    speech.push(x);
    if (rms > thr) { speechMs += blockMs; quietMs = 0; } else quietMs += blockMs;
    if (quietMs >= silenceMs || speechMs + quietMs >= maxMs) {
      talking = false; pre = [];
      const pcm = join(speech); speech = [];
      if (speechMs >= minSpeechMs) to16k(pcm, rate).then(onUtterance, () => {});
    }
  };
  src.connect(proc); proc.connect(ac.destination);
  return {
    // Whatever was being said right now, as an utterance (true if there was any).
    flush() {
      if (keepAll) {
        // The whole recording, whatever the loudness check made of it (a quiet voice still counts).
        if (!all.length) return false;
        stopped = true;
        to16k(join(all), rate).then(onUtterance, () => {});
        return true;
      }
      if (!talking || !speech.length) return false;
      talking = false;
      const pcm = join(speech); speech = []; pre = [];
      to16k(pcm, rate).then(onUtterance, () => {});
      return true;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try { proc.disconnect(); src.disconnect(); } catch {}
      for (const t of stream.getTracks()) t.stop();
    },
  };
}

/**
 * A stand-in for SpeechRecognition (the slice voice.js createCall uses): each utterance is transcribed by the model
 * and delivered as one final result. `transcribe(pcm16k)` → text.
 */
export function omniRecognition({ transcribe }) {
  return class OmniRecognition {
    constructor() { this.continuous = true; this.interimResults = false; this.lang = 'en-US'; this.maxAlternatives = 1; this.mic = null; this.on = false; }
    start() {
      this.on = true;
      listen({
        onUtterance: async (pcm) => {
          if (!this.on) return;
          let text = '';
          try { text = await transcribe(pcm); } catch (e) { if (this.on) this.onerror?.({ error: 'transcribe', message: String(e && e.message || e) }); return; }
          if (!this.on || !text) return;
          this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text, confidence: 1 }], { isFinal: true })] });
        },
      }).then((mic) => {
        if (!this.on) { mic.stop(); return; }
        this.mic = mic;
        this.onstart?.();
      }, (e) => {
        this.on = false;
        this.onerror?.({ error: e && e.name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture' });
        this.onend?.();
      });
    }
    stop() { this.#end(); }
    abort() { this.#end(); }
    #end() {
      const was = this.on;
      this.on = false;
      if (this.mic) { this.mic.stop(); this.mic = null; }
      if (was) setTimeout(() => this.onend?.(), 0);
    }
  };
}

/** One utterance from the microphone (ends after a pause, or on stop()): { done: Promise<pcm16k|null>, stop() }. */
// Ends by itself after a pause once speech was heard, or when stop() is called: then everything recorded counts.
// Call it straight from the tap (see listen).
export function recordOnce({ silenceMs = 2000, onSpeech } = {}) {
  let mic = null, settle, stopWanted = false;
  const done = new Promise((r) => { settle = r; });
  const finish = (pcm) => { if (mic) { mic.stop(); mic = null; } settle(pcm); };
  listen({ silenceMs, onSpeech, keepAll: true, onUtterance: finish }).then((m) => { mic = m; if (stopWanted && !m.flush()) finish(null); }, (e) => settle(Promise.reject(e)));
  return { done, stop: () => { if (!mic) { stopWanted = true; return; } if (!mic.flush()) finish(null); } };
}
