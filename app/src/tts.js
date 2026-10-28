// Natural voice, main-thread side: the voice model in a worker (tts-worker.js)
// and a Web Audio player. Everything browser-specific is injectable so tests
// can drive it.
import { TTS_MODELS, validVoice } from './tts-text.js';

export { TTS_MODELS, validVoice };

export function neuralSupported(win = globalThis) {
  return Boolean(win.Worker && (win.AudioContext || win.webkitAudioContext) && typeof win.WebAssembly === 'object');
}

const cancelled = () => Object.assign(new Error('cancelled'), { cancelled: true });

/** The voice model running in a worker. load() resolves when it can speak;
 *  synth(text) resolves with { samples, sampleRate, ms }. A download that
 *  stops making progress for `stallMs`, or a start-up step that takes longer
 *  than `startMs`, fails the load (the call then uses system voices).
 *  onBusy(true|false) reports whether a synthesis is outstanding (crash marker). */
export function createTTS({
  model = 'kokoro', voice, url = new URL('./tts-worker.js', import.meta.url), WorkerCtor = globalThis.Worker,
  onStage = () => {}, onProgress = () => {}, onBusy = () => {}, stallMs = 30000, startMs = 60000,
} = {}) {
  let worker = null, state = 'idle', loading = null, nextId = 1, failure = null;
  const pending = new Map();

  function settleAll(err) {
    const was = pending.size;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    if (was) onBusy(false);
  }
  function terminate() {
    if (worker) { try { worker.terminate(); } catch {} }
    worker = null;
    if (state !== 'failed') state = 'closed';
    settleAll(cancelled());
  }

  function load() {
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      let timer = null;
      const arm = (ms, why) => { clearTimeout(timer); timer = setTimeout(() => fail(new Error(why)), ms); };
      const fail = (e) => {
        clearTimeout(timer);
        failure = e;
        const wasReady = state === 'ready';
        state = 'failed';
        if (worker) { try { worker.terminate(); } catch {} worker = null; }
        settleAll(e);
        if (!wasReady) reject(e);
      };
      try {
        worker = new WorkerCtor(url, { type: 'module', name: 'squiggle-voice' });
      } catch (e) { fail(e); return; }
      state = 'loading';
      arm(startMs, 'the voice model took too long to start');
      worker.onerror = (e) => {
        try { e.preventDefault(); } catch {}
        fail(new Error(e && e.message ? e.message : 'the voice worker stopped'));
      };
      worker.onmessage = (e) => {
        const m = e.data || {};
        if (m.type === 'stage') {
          onStage(m.stage);
          if (/download/.test(m.stage)) arm(stallMs, 'the voice download stalled');
          else arm(startMs, `the voice model took too long (${m.stage})`);
        } else if (m.type === 'progress') {
          onProgress(m.loaded, m.total);
          arm(stallMs, 'the voice download stalled');
        } else if (m.type === 'ready') {
          clearTimeout(timer);
          state = 'ready';
          resolve(m);
        } else if (m.type === 'audio' || m.type === 'cancelled' || (m.type === 'error' && m.id != null)) {
          const p = pending.get(m.id);
          if (!p) return;
          pending.delete(m.id);
          if (!pending.size) onBusy(false);
          if (m.type === 'audio') p.resolve({ samples: m.samples, sampleRate: m.sampleRate, ms: m.ms });
          else p.reject(m.type === 'cancelled' ? cancelled() : new Error(m.message));
        } else if (m.type === 'error') {
          fail(new Error(m.message));
        }
      };
      worker.postMessage({ type: 'load', model, voice });
    });
    return loading;
  }

  function synth(text, { speed = 1, voice: v = voice } = {}) {
    if (state !== 'ready') return Promise.reject(failure || new Error('the voice model is not loaded'));
    const id = nextId++;
    const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    if (pending.size === 1) onBusy(true);
    worker.postMessage({ type: 'speak', id, text, speed, voice: v });
    return p;
  }

  // Drops queued requests; the one being synthesized finishes and is ignored.
  function cancel() {
    if (worker && state === 'ready') worker.postMessage({ type: 'cancel' });
    settleAll(cancelled());
  }

  return { load, synth, cancel, terminate, model, voice, get state() { return state; }, get error() { return failure; } };
}

/** Web Audio output. unlock() must run inside a user gesture (iOS); play()
 *  resolves when the clip ends or stop() is called. */
export function createPlayer({ AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext } = {}) {
  let ctx = null, source = null, finish = null;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  return {
    unlock() {
      try {
        if (!ctx) ctx = new AudioContextCtor({ latencyHint: 'interactive' });
        ctx.resume && ctx.resume().catch(() => {});
        // A silent buffer started inside the gesture unlocks output on iOS.
        const b = ctx.createBuffer(1, 1, 22050);
        const s = ctx.createBufferSource();
        s.buffer = b; s.connect(ctx.destination); s.start(0);
      } catch {}
    },
    async play(samples, sampleRate) {
      if (!ctx) throw new Error('audio output was not unlocked');
      if (ctx.state !== 'running') {
        // iOS suspends or interrupts the context (other audio, the mic); try once.
        try { await Promise.race([ctx.resume(), sleep(1500)]); } catch {}
        if (ctx.state !== 'running') throw new Error(`audio output is ${ctx.state}`);
      }
      this.stop();
      const buf = ctx.createBuffer(1, samples.length, sampleRate);
      if (buf.copyToChannel) buf.copyToChannel(samples, 0); else buf.getChannelData(0).set(samples);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      source = src;
      return new Promise((resolve) => {
        finish = () => { if (source === src) { source = null; finish = null; } resolve(); };
        src.onended = finish;
        src.start();
      });
    },
    stop() {
      const s = source, f = finish;
      source = null; finish = null;
      if (s) { s.onended = null; try { s.stop(); } catch {} try { s.disconnect(); } catch {} }
      if (f) f();
    },
    close() {
      this.stop();
      if (ctx) { try { ctx.close(); } catch {} }
      ctx = null;
    },
    get state() { return ctx ? ctx.state : 'closed'; },
  };
}
