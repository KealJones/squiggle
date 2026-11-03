// Voice in the UI: read a reply aloud, hands-free calls (the call bar), the
// natural voice's lifecycle and crash marker. voice.js owns the call state
// machine and tts.js the natural voice; this is what shows them.
import * as engine from '../engine.js';
import * as agent from '../agent.js';
import * as voice from '../voice.js';
import * as tts from '../tts.js';
import { $, h, icon, squiggleWait, scrollDown, toast, pct } from './dom.js';
import { state } from './state.js';
import { saveSettings } from './settings.js';
import { send } from './chat.js';

// ── Read aloud ─────────────────────────────────────────────────────────────
// The speaker button under a reply reads it with the voice calls use: the
// natural voice when it's chosen (loaded on the tap, kept a minute for the next
// one, then freed), otherwise the system voice. One reading at a time; a call
// stops it.
const READER_KEEP_MS = 60000;

function setReadButtons() {
  for (const b of document.querySelectorAll('.read-aloud')) {
    const on = Boolean(state.reader && state.reader.id === b.dataset.msg);
    b.replaceChildren(icon(on ? 'i-stop' : 'i-speaker'));
    b.setAttribute('aria-label', on ? 'Stop reading' : 'Read aloud');
    b.title = on ? 'Stop reading' : 'Read aloud';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

export function stopReading() {
  if (!state.reader) return;
  const r = state.reader;
  state.reader = null;
  r.ctl && r.ctl.stop();
  setReadButtons();
}

function freeReaderVoice() {
  if (!state.readerVoice) return;
  clearTimeout(state.readerVoice.timer);
  freeNaturalVoice(state.readerVoice.nv);
  state.readerVoice = null;
}

export function toggleReadAloud(m) {
  const wasThis = state.reader && state.reader.id === m.id;
  stopReading();
  if (wasThis || state.call) return;
  const system = voice.systemSpeaker({ synth: window.speechSynthesis, Utterance: window.SpeechSynthesisUtterance, lang: navigator.language || 'en-US', getSettings: () => agent.settings });
  const mine = { id: m.id, ctl: null };
  state.reader = mine;
  setReadButtons();
  const start = (speaker, fallback) => {
    if (state.reader !== mine) return;
    mine.ctl = voice.readAloud({
      speaker, text: agent.scrubFakeToolNotes(m.content),
      onEnd: (err) => {
        if (err && fallback && state.reader === mine) { toast(`The natural voice stopped (${err.message}); reading with the system voice.`); start(fallback, null); return; }
        if (state.reader === mine) { state.reader = null; setReadButtons(); }
        if (state.readerVoice) { clearTimeout(state.readerVoice.timer); state.readerVoice.timer = setTimeout(freeReaderVoice, READER_KEEP_MS); }
      },
    });
  };
  system.prime();   // inside the tap: iOS only starts speech from a gesture
  if (voiceEngine() !== 'natural') { start(system, null); return; }
  if (state.readerVoice && state.readerVoice.nv.model !== voiceModel()) freeReaderVoice();
  if (!state.readerVoice) state.readerVoice = { nv: createNaturalVoice(), timer: null };   // unlocks audio in this tap
  clearTimeout(state.readerVoice.timer);
  const nv = state.readerVoice.nv;
  nv.speaker.prime();
  const slow = setTimeout(() => { if (state.reader === mine && !mine.ctl) toast(`Loading the natural voice (${tts.TTS_MODELS[nv.model].label}, ${tts.TTS_MODELS[nv.model].size} the first time)…`, 8000); }, 800);
  nv.loaded.then(() => clearTimeout(slow), () => clearTimeout(slow));
  nv.loaded.then(() => start(nv.speaker, system), (e) => {
    if (state.readerVoice && state.readerVoice.nv === nv) freeReaderVoice();
    if (state.reader === mine) toast(`Couldn't load the natural voice (${e.message}); reading with the system voice.`);
    start(system, null);
  });
}

// ── Voice call ─────────────────────────────────────────────────────────────
// Hands-free: speech in through the Web Speech API, replies spoken sentence by
// sentence. Utterances go through send() like typed messages.
const CALL_LABELS = { listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', idle: 'Call ended' };

export function startCall() {
  const sup = voice.support(window);
  if (!sup.ok) { callBar(sup.recognition ? 'Voice calls need speech synthesis, which this browser doesn\'t have.' : voice.UNSUPPORTED_MESSAGE); return; }
  if (!state.current) return;
  // Phones ask once: the natural voice needs memory next to the chat model.
  if (voiceEngine() === 'ask') { askVoiceBar(); return; }
  stopReading();
  freeReaderVoice();
  const bar = callBar();
  const system = voice.systemSpeaker({ synth: window.speechSynthesis, Utterance: window.SpeechSynthesisUtterance, lang: navigator.language || 'en-US', getSettings: () => agent.settings });
  // The natural voice loads now (inside this tap, so its audio can be unlocked)
  // and is freed when the call ends. Until it's ready, replies use the system voice.
  const nv = voiceEngine() === 'natural' ? startNaturalVoice(bar) : null;
  const ctl = voice.createCall({
    SR: sup.recognition, speaker: nv ? nv.speaker : system, fallback: system,
    lang: navigator.language || 'en-US',
    getSettings: () => agent.settings,
    send: (text) => send(text, null),
    onChange: (snap) => bar.update(snap),
    onError: (message, fatal) => { if (!fatal) bar.update({ ...ctl.snapshot(), error: message }); },
    onFallback: (reason, detail) => naturalVoiceFellBack(reason, detail),
  });
  state.call = { ctl, bar, nv };
  // start() must run inside this tap: iOS only lets speech begin from a gesture.
  ctl.start();
  bar.update(ctl.snapshot());
  keepAwake(true);
}

export function endCall() {
  if (!state.call) return;
  const { ctl, bar } = state.call;
  releaseCallVoice();
  state.call = null;
  ctl.end();
  bar.close();
  keepAwake(false);
}

// ── Natural voice (tts.js; the model runs in a worker) ─────────────────────
// 'natural' | 'system', or 'ask' on a phone that hasn't chosen yet.
export function voiceEngine() {
  const S = agent.settings;
  if (!tts.neuralSupported(window)) return 'system';
  if (S.voiceEngine === 'natural' || S.voiceEngine === 'system') return S.voiceEngine;
  return engine.isMobile() ? 'ask' : 'natural';
}
// Kokoro is the best voice; phones default to KittenTTS, which needs a
// fraction of the memory and keeps up on a phone CPU.
export function voiceModel() {
  const m = agent.settings.voiceModel;
  return tts.TTS_MODELS[m] ? m : engine.isMobile() ? 'kitten' : 'kokoro';
}
export function naturalVoiceId(model) {
  return tts.validVoice(model, (agent.settings.ttsVoices || {})[model]);
}

// Crash marker, as for the chat model: written before the voice model loads
// and while it speaks (localStorage writes are synchronous, so it survives the
// tab being killed), removed when that's over. Found on the next open, it
// explains what happened and calls switch to system voices.
const VOICE_LOADING_KEY = 'squiggle-voice-loading';
function voiceMarker(v) {
  try { v ? localStorage.setItem(VOICE_LOADING_KEY, JSON.stringify(v)) : localStorage.removeItem(VOICE_LOADING_KEY); } catch {}
}
function loadVoiceMarker() {
  try { return JSON.parse(localStorage.getItem(VOICE_LOADING_KEY) || 'null'); } catch { return null; }
}

/** Creates and starts loading the voice model. Must run inside a tap (the
 *  player unlocks audio). Returns { tts, player, speaker, model, loaded }. */
export function createNaturalVoice({ model = voiceModel(), player = null, onStage = () => {}, onProgress = () => {} } = {}) {
  const voiceId = naturalVoiceId(model);
  if (!player) { player = tts.createPlayer(); player.unlock(); }
  const marker = { model, phase: 'load', stage: 'starting', at: Date.now(), ua: navigator.userAgent };
  voiceMarker(marker);
  const t = tts.createTTS({
    model, voice: voiceId,
    onStage: (st) => { marker.stage = st; voiceMarker(marker); onStage(st); },
    onProgress,
    onBusy: (on) => voiceMarker(on ? { ...marker, phase: 'speak', stage: 'speaking', at: Date.now() } : null),
  });
  const loaded = t.load().then((r) => { voiceMarker(null); return r; }, (e) => { voiceMarker(null); throw e; });
  const speaker = voice.neuralSpeaker({ tts: t, player, voice: voiceId, getSettings: () => agent.settings });
  return { tts: t, player, speaker, model, loaded };
}

export function freeNaturalVoice(nv) {
  if (!nv) return;
  nv.tts.terminate();
  nv.player.close();
  voiceMarker(null);
}
function releaseCallVoice() {
  if (!state.call) return;
  freeNaturalVoice(state.call.nv);
  state.call.nv = null;
}

function startNaturalVoice(bar) {
  const model = voiceModel();
  const label = tts.TTS_MODELS[model].label;
  let shown = false;
  const nv = createNaturalVoice({
    model,
    onStage: (st) => { if (/download/.test(st)) return; shown = true; bar.note(`Loading the natural voice (${label}): ${st}…`); },
    onProgress: (got, total) => { if (got < total) { shown = true; bar.note(`Downloading the natural voice (${label}, ${tts.TTS_MODELS[model].size})${pct(got, total)}. Replies use the system voice until it's ready.`); } },
  });
  nv.loaded.then(() => { if (state.call && state.call.nv === nv && shown) bar.note(`Natural voice ready (${label}).`, 4000); }, (e) => {
    if (!state.call || state.call.nv !== nv) return;
    bar.note(`Couldn't load the natural voice: ${e.message}. This call uses the system voice.`);
  });
  return nv;
}

// The natural voice failed or can't keep up. The call already moved to the
// system voice; a slow Kokoro gets the light model for the next reply.
function naturalVoiceFellBack(reason, detail) {
  const call = state.call;
  if (!call) return;
  const { bar, nv } = call;
  const model = nv ? nv.model : voiceModel();
  if (reason === 'slow' && nv && model === 'kokoro' && tts.TTS_MODELS.kitten) {
    agent.settings.voiceModel = 'kitten'; saveSettings();
    bar.note(`${tts.TTS_MODELS.kokoro.label} is too slow on this device (${Number(detail).toFixed(1)}× slower than speech), so Squiggle switched to the light natural voice (Settings → Voice calls). Using the system voice while it loads.`);
    // Reuse the unlocked player: we're not inside a tap any more.
    nv.tts.terminate();
    const next = createNaturalVoice({ model: 'kitten', player: nv.player });
    call.nv = next;
    next.loaded.then(() => { if (state.call && state.call.nv === next) { call.ctl.setSpeaker(next.speaker); bar.note('Light natural voice ready; it speaks from the next reply.', 6000); } },
      (e) => { if (state.call && state.call.nv === next) bar.note(`Couldn't load the light natural voice: ${e.message}. This call uses the system voice.`); });
    return;
  }
  bar.note(reason === 'slow'
    ? `The natural voice can't keep up on this device (${Number(detail).toFixed(1)}× slower than speech), so this call uses the system voice.`
    : `The natural voice stopped working (${detail && detail.message || detail}), so this call uses the system voice.`);
  if (nv) { nv.tts.terminate(); voiceMarker(null); }
}

// First call on a phone: natural or system voice? The answer's tap starts the call.
function askVoiceBar() {
  $('.call')?.remove();
  const m = tts.TTS_MODELS[voiceModel()];
  const choose = (v) => (e) => { e.stopPropagation(); agent.settings.voiceEngine = v; saveSettings(); el.remove(); startCall(); };
  const el = h('section', { class: 'call', 'data-state': 'ask', 'aria-label': 'Voice call' },
    h('div', { class: 'call-inner' },
      h('div', { class: 'call-head' }, h('span', {}, 'Use the natural voice?')),
      h('div', { class: 'call-hint' }, `It sounds much more human. It downloads ${m.size.replace('~', 'about ')} once and runs on this phone, using extra memory while a call is on. You can change this in Settings.`),
      h('div', { class: 'call-actions' },
        h('button', { class: 'btn', type: 'button', onclick: (e) => { e.stopPropagation(); el.remove(); } }, 'Cancel'),
        h('button', { class: 'btn', type: 'button', onclick: choose('system') }, 'System voice'),
        h('button', { class: 'btn primary', type: 'button', onclick: choose('natural') }, 'Natural voice'))));
  $('.main').insertBefore(el, $('#composer'));
}

// On open: a tab killed while the natural voice loaded or spoke.
export function checkVoiceCrash() {
  const c = loadVoiceMarker();
  if (!c) return;
  voiceMarker(null);
  const S = agent.settings;
  const m = tts.TTS_MODELS[c.model] || tts.TTS_MODELS[voiceModel()];
  const wasModel = tts.TTS_MODELS[c.model] ? c.model : voiceModel();
  S.voiceEngine = 'system'; saveSettings();
  const b = $('#voice-banner');
  const close = () => { b.hidden = true; b.replaceChildren(); };
  const lighter = wasModel === 'kokoro' && tts.TTS_MODELS.kitten;
  b.hidden = false;
  b.replaceChildren(h('div', { class: 'dl' },
    h('span', {}, `${c.phase === 'speak' ? `The natural voice (${m.label}) crashed this tab while speaking` : `Loading the natural voice (${m.label}) crashed this tab`} last time${c.stage && c.phase !== 'speak' ? `, while ${c.stage}` : ''}.`),
    h('span', { class: 'muted' }, 'This device probably ran out of memory with the voice and the chat model together, so calls use system voices now.'),
    h('div', { class: 'row' },
      lighter ? h('button', { class: 'btn primary', onclick: () => { Object.assign(S, { voiceEngine: 'natural', voiceModel: 'kitten' }); saveSettings(); close(); } }, `Use the light natural voice (${tts.TTS_MODELS.kitten.size})`) : '',
      h('button', { class: 'btn', onclick: () => { Object.assign(S, { voiceEngine: 'natural', voiceModel: wasModel }); saveSettings(); close(); } }, 'Try the natural voice again'),
      h('button', { class: 'btn ghost', onclick: close }, 'Keep system voices'))));
}

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on) wakeLock = await navigator.wakeLock?.request('screen');
    else { await wakeLock?.release(); wakeLock = null; }
  } catch {}
}

// The call bar replaces the composer while a call is on. With `message` it is
// only an explanation (unsupported browser) and closes on its own button.
function callBar(message) {
  $('.call')?.remove();
  const stateEl = h('span', { 'aria-live': 'polite' }, message ? 'Voice calls unavailable' : 'Starting…');
  const dot = h('span', { class: 'call-dot', 'aria-hidden': 'true' });
  const wait = squiggleWait(); wait.hidden = true;
  const said = h('div', { class: 'call-transcript' });
  const hint = h('div', { class: 'call-hint' }, message ? '' : 'Tap anywhere on this bar to interrupt.');
  const err = h('div', { class: 'call-error', role: 'alert' }, message || '');
  const note = h('div', { class: 'call-hint call-note', 'aria-live': 'polite', hidden: true });
  let noteTimer = null;
  const repeat = h('button', { class: 'btn', type: 'button', hidden: true, onclick: (e) => { e.stopPropagation(); state.call && state.call.ctl.repeat(); } }, 'Repeat');
  const endBtn = h('button', { class: 'btn primary', type: 'button', onclick: (e) => { e.stopPropagation(); message ? el.remove() : endCall(); } }, message ? 'Close' : 'End');
  const el = h('section', { class: 'call', 'data-state': message ? 'error' : 'listening', 'aria-label': 'Voice call', onclick: () => state.call && state.call.ctl.bargeIn() },
    h('div', { class: 'call-inner' },
      h('div', { class: 'call-head' }, dot, stateEl, wait),
      said, hint, note, err,
      h('div', { class: 'call-actions' }, repeat, endBtn)));
  const main = $('.main');
  main.insertBefore(el, $('#composer'));
  if (!message) { main.classList.add('in-call'); $('#call').setAttribute('aria-pressed', 'true'); }
  scrollDown($('#messages'));
  const self = {
    update(snap) {
      const idle = snap.state === 'idle';
      el.dataset.state = snap.error ? 'error' : snap.state;
      stateEl.textContent = snap.error && idle ? 'Call ended' : CALL_LABELS[snap.state] || snap.state;
      wait.hidden = !(snap.state === 'thinking' || snap.state === 'speaking');
      said.textContent = snap.transcript ? `“${snap.transcript}”` : '';
      said.classList.toggle('interim', Boolean(snap.interim));
      err.textContent = snap.error || '';
      repeat.hidden = !snap.canRepeat;
      hint.hidden = idle;
      if (idle && snap.error) {
        // The call stopped itself (blocked microphone, ...): keep the reason on screen.
        if (state.call && state.call.bar === self) { releaseCallVoice(); state.call = null; }
        note.hidden = true;
        keepAwake(false);
        main.classList.remove('in-call'); $('#call').removeAttribute('aria-pressed');
        endBtn.textContent = 'Close'; endBtn.onclick = (e) => { e.stopPropagation(); el.remove(); };
        el.onclick = null;
      }
    },
    // Voice status (natural voice loading, fallbacks); clears itself after `ms`.
    note(text, ms = 0) {
      clearTimeout(noteTimer);
      note.textContent = text || '';
      note.hidden = !text;
      if (text && ms) noteTimer = setTimeout(() => { if (note.textContent === text) note.hidden = true; }, ms);
    },
    close() { clearTimeout(noteTimer); el.remove(); main.classList.remove('in-call'); $('#call').removeAttribute('aria-pressed'); },
  };
  return self;
}
