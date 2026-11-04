// Voice in the UI: read a reply aloud and hands-free calls (the call bar),
// both with the browser's own speech. voice.js owns the call state machine;
// this is what shows it.
import * as agent from '../agent.js';
import * as voice from '../voice.js';
import { $, h, icon, squiggleWait, scrollDown } from './dom.js';
import { state } from './state.js';
import { send } from './chat.js';

// ── Read aloud ─────────────────────────────────────────────────────────────
// The speaker button under a reply reads it with the system voice calls use.
// One reading at a time; a call stops it.
const systemSpeaker = () => voice.systemSpeaker({ synth: window.speechSynthesis, Utterance: window.SpeechSynthesisUtterance, lang: navigator.language || 'en-US', getSettings: () => agent.settings });

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

export function toggleReadAloud(m) {
  const wasThis = state.reader && state.reader.id === m.id;
  stopReading();
  if (wasThis || state.call) return;
  const mine = { id: m.id, ctl: null };
  state.reader = mine;
  setReadButtons();
  // readAloud primes the speaker first, inside this tap (iOS only starts speech from a gesture).
  mine.ctl = voice.readAloud({
    speaker: systemSpeaker(), text: agent.scrubFakeToolNotes(m.content),
    onEnd: () => { if (state.reader === mine) { state.reader = null; setReadButtons(); } },
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
  stopReading();
  const bar = callBar();
  const ctl = voice.createCall({
    SR: sup.recognition, speaker: systemSpeaker(),
    lang: navigator.language || 'en-US',
    getSettings: () => agent.settings,
    send: (text) => send(text, null),
    onChange: (snap) => bar.update(snap),
    onError: (message, fatal) => { if (!fatal) bar.update({ ...ctl.snapshot(), error: message }); },
  });
  state.call = { ctl, bar };
  // start() must run inside this tap: iOS only lets speech begin from a gesture.
  ctl.start();
  bar.update(ctl.snapshot());
  keepAwake(true);
}

export function endCall() {
  if (!state.call) return;
  const { ctl, bar } = state.call;
  state.call = null;
  ctl.end();
  bar.close();
  keepAwake(false);
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
  const repeat = h('button', { class: 'btn', type: 'button', hidden: true, onclick: (e) => { e.stopPropagation(); state.call && state.call.ctl.repeat(); } }, 'Repeat');
  const endBtn = h('button', { class: 'btn primary', type: 'button', onclick: (e) => { e.stopPropagation(); message ? el.remove() : endCall(); } }, message ? 'Close' : 'End');
  const el = h('section', { class: 'call', 'data-state': message ? 'error' : 'listening', 'aria-label': 'Voice call', onclick: () => state.call && state.call.ctl.bargeIn() },
    h('div', { class: 'call-inner' },
      h('div', { class: 'call-head' }, dot, stateEl, wait),
      said, hint, err,
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
        if (state.call && state.call.bar === self) state.call = null;
        keepAwake(false);
        main.classList.remove('in-call'); $('#call').removeAttribute('aria-pressed');
        endBtn.textContent = 'Close'; endBtn.onclick = (e) => { e.stopPropagation(); el.remove(); };
        el.onclick = null;
      }
    },
    close() { el.remove(); main.classList.remove('in-call'); $('#call').removeAttribute('aria-pressed'); },
  };
  return self;
}
