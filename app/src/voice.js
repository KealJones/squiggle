// Voice call mode: speech-to-text (Web Speech API) in, text-to-speech out.
// Pure helpers first (markdown → speakable text, sentence chunking, voice
// choice), then createCall(), a small state machine with every browser object
// injected so the UI (main.js) stays thin and tests can drive it.

// ── Pure helpers ───────────────────────────────────────────────────────────

const ABBREV = /(?:^|[\s(])(?:e\.g|i\.e|vs|etc|mr|mrs|ms|dr|prof|sr|jr|st|no|fig|approx|inc|ltd)\.$/i;
const FENCE_LINE = /^[ \t]*(```|~~~)/gm;

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'link'; }
}

/** Markdown (or plain) reply text → what should be said aloud. Lines are kept
 *  as '\n'-separated so the chunker can pause between them. */
export function speakable(md) {
  let t = String(md || '').replace(/\r\n?/g, '\n');
  // Fenced code (an unclosed fence runs to the end), then replace with one notice.
  t = t.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, '\nCode omitted.\n');
  t = t.replace(/(?:Code omitted\.\s*){2,}/g, 'Code omitted.\n');
  t = t.replace(/<(https?:\/\/[^>\s]+)>/g, (_, u) => domainOf(u));
  t = t.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[a-z][^>]*>/gi, '');
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => alt);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]*)[^)]*\)/g, (_, text, url) => (/^https?:\/\//i.test(text) ? domainOf(text) : text));
  t = t.replace(/\bhttps?:\/\/[^\s)<>\]]+/gi, (u) => domainOf(u.replace(/[.,;:!?]+$/, '')) + (/[.,;:!?]+$/.test(u) ? u.match(/[.,;:!?]+$/)[0] : ''));
  t = t.replace(/`([^`\n]{1,40})`/g, '$1').replace(/`[^`\n]*`/g, 'code omitted');
  const out = [];
  for (let line of t.split('\n')) {
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue;                 // horizontal rule
    if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-') && line.includes('|')) continue; // table rule
    let block = false;
    if (/^\s*#{1,6}\s+/.test(line)) { line = line.replace(/^\s*#{1,6}\s+/, ''); block = true; }
    if (/^\s*>+\s?/.test(line)) line = line.replace(/^\s*(>\s?)+/, '');
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) { line = line.replace(/^\s*([-*+]|\d+[.)])\s+/, ''); block = true; }
    if (/^\s*\|.*\|\s*$/.test(line)) { line = line.trim().slice(1, -1).split('|').map(c => c.trim()).filter(Boolean).join(', '); block = true; }
    line = line
      .replace(/(\*{1,3})(?=\S)([^*\n]*?\S)\1/g, '$2')
      .replace(/(^|[\s(])_{1,3}(?=\S)([^_\n]*?\S)_{1,3}(?=[\s).,!?:;]|$)/g, '$1$2')
      .replace(/~~([^~\n]+)~~/g, '$1')
      .replace(/[*_~#]{2,}/g, ' ')
      .replace(/\p{Extended_Pictographic}️?/gu, '')
      .replace(/[ \t]+/g, ' ')
      .trim();
    if (!line) continue;
    if (block && !/[.!?…:;,)"'”’]$/.test(line)) line += '.';
    out.push(line);
  }
  return out.join('\n');
}

/** Plain speakable text → utterance-sized sentences. Short ones are merged, long
 *  ones are split at commas, so no single utterance runs long (Chrome cuts
 *  utterances off after ~15 s). */
export function splitSentences(plain, { max = 240, min = 28 } = {}) {
  const pieces = [];
  for (const line of String(plain || '').split('\n')) {
    let s = line.trim();
    if (!s) continue;
    let start = 0;
    const re = /[.!?…]+["'”’)\]]*(?=\s|$)/g;
    let m;
    const lineParts = [];
    while ((m = re.exec(s))) {
      const end = m.index + m[0].length;
      if (/^\./.test(m[0]) && ABBREV.test(s.slice(0, end))) continue;
      lineParts.push(s.slice(start, end).trim());
      start = end;
    }
    if (start < s.length) lineParts.push(s.slice(start).trim());
    for (let p of lineParts) {
      while (p.length > max) {
        let cut = Math.max(p.lastIndexOf(', ', max), p.lastIndexOf('; ', max), p.lastIndexOf(': ', max)) + 1;
        if (cut < max / 3) cut = p.lastIndexOf(' ', max);
        if (cut <= 0) cut = max;
        pieces.push(p.slice(0, cut).trim());
        p = p.slice(cut).trim();
      }
      if (p) pieces.push(p);
    }
  }
  const merged = [];
  let acc = '';
  for (const p of pieces) {
    acc = acc ? `${acc} ${p}` : p;
    if (acc.length >= min) { merged.push(acc); acc = ''; }
  }
  if (acc) merged.push(acc);
  return merged;
}

/** The natural voice starts speaking once the first chunk is synthesized, and
 *  that takes time in proportion to its length. So a long first chunk is cut
 *  at its first sentence or clause break (after `min` characters). */
export function firstPiece(text, { max = 40, min = 12 } = {}) {
  const t = String(text || '').trim();
  if (t.length <= max) return [t];
  const re = /[.!?…]+["'”’)\]]*\s|[,;:]\s|\s[—–]\s/g;
  let m;
  while ((m = re.exec(t))) {
    const end = m.index + m[0].length;
    if (end < min) continue;
    if (/^\./.test(m[0]) && ABBREV.test(t.slice(0, m.index + 1))) continue;
    if (t.length - end < 8) break; // nothing worth a second piece
    return [t.slice(0, end).trim(), t.slice(end).trim()];
  }
  return [t];
}

/** Streaming chunker. `raw` is the reply so far (markdown); `from` is how much of
 *  it was already taken. Returns the new speakable chunks and the new offset.
 *  Cuts only at a sentence end outside a code fence, so partial markdown and
 *  half-streamed code blocks are never spoken. `final` takes everything. */
export function takeSpeakable(raw, from = 0, final = false) {
  raw = String(raw || '');
  const rest = raw.slice(Math.min(from, raw.length));
  if (final) return { chunks: splitSentences(speakable(rest)), next: raw.length };
  const fences = (s) => (s.match(FENCE_LINE) || []).length;
  const re = /[.!?…]+["'”’)\]*_`]*\s|\n/g;
  let cut = 0, m;
  while ((m = re.exec(rest))) {
    const end = m.index + m[0].length;
    if (m[0] !== '\n' && /^\./.test(m[0]) && ABBREV.test(rest.slice(0, m.index + m[0].trimEnd().length))) continue;
    if (fences(rest.slice(0, end)) % 2) continue;
    cut = end;
  }
  if (!cut && rest.length > 300 && !(fences(rest) % 2)) {
    const sp = rest.lastIndexOf(', ');
    if (sp > 100) cut = sp + 2;
  }
  if (!cut) return { chunks: [], next: from };
  return { chunks: splitSentences(speakable(rest.slice(0, cut))), next: from + cut };
}

/** Best installed voice for `lang`: the saved one if it still exists, else the
 *  best-scoring voice for the language. Quality beats everything else: Apple
 *  marks it in the voiceURI (premium > enhanced > compact), Edge/Android in the
 *  name ("Natural", "Neural"); robotic voices (Apple's Eloquence set, novelty
 *  voices) are avoided. On iPhone, Squiggle used to land on one of those. */
const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|fred|good news|jester|junior|kathy|organ|ralph|superstar|trinoids|whisper|wobble|zarvox)\b/i;
const ELOQUENCE = /^(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;
export function voiceQuality(v) {
  const uri = String(v.voiceURI || ''), name = String(v.name || '');
  if (/eloquence/i.test(uri) || ELOQUENCE.test(name) || /eloquence/i.test(name)) return -10;
  if (NOVELTY.test(name) || /novelty/i.test(name)) return -10;
  if (/premium/i.test(uri) || /premium/i.test(name)) return 9;
  if (/natural|neural/i.test(name)) return 8;
  if (/siri/i.test(uri) || /siri/i.test(name)) return 7;
  if (/enhanced/i.test(uri) || /enhanced/i.test(name)) return 6;
  if (/google/i.test(name)) return 4;
  if (/compact/i.test(uri)) return /samantha/i.test(name) ? 1 : 0;
  return 1;
}
export function pickVoice(voices, lang = 'en-US', savedURI = '') {
  const list = Array.from(voices || []);
  if (!list.length) return null;
  const saved = savedURI && list.find(v => v.voiceURI === savedURI);
  if (saved) return saved;
  const want = String(lang || 'en-US').toLowerCase();
  const prim = want.split(/[-_]/)[0];
  const score = (v) => {
    const l = String(v.lang || '').toLowerCase().replace('_', '-');
    let s = 0;
    if (l === want) s += 3; else if (l.split('-')[0] === prim) s += 1; else return -100;
    s += voiceQuality(v);
    if (v.default) s += 0.5;
    if (v.localService) s += 0.25;
    return s;
  };
  let best = null, bestScore = -Infinity;
  for (const v of list) { const sc = score(v); if (sc > -100 && sc > bestScore) { best = v; bestScore = sc; } }
  return best || list.find(v => v.default) || list[0];
}

export function support(win = globalThis) {
  const recognition = win.SpeechRecognition || win.webkitSpeechRecognition || null;
  const synthesis = Boolean(win.speechSynthesis && win.SpeechSynthesisUtterance);
  return { recognition, synthesis, ok: Boolean(recognition && synthesis) };
}

export const UNSUPPORTED_MESSAGE = 'Voice calls need speech recognition, which this browser doesn\'t have. Try Chrome, Edge or Safari.';

const ERRORS = {
  'not-allowed': 'Microphone access is blocked. Allow the microphone for this site in your browser settings, then start the call again.',
  'service-not-allowed': 'Speech recognition isn\'t available here. On iPhone, use Safari (not an app added to the Home Screen) and make sure Dictation is turned on in Settings.',
  'audio-capture': 'No microphone was found. Plug one in or check your sound settings.',
};

// ── Speakers ───────────────────────────────────────────────────────────────
// A speaker says one chunk at a time:
//   prime()                 inside the call button's tap (iOS unlocks audio only then)
//   ready()                 can speak now (the natural voice may still be loading)
//   prepare(text) → item    start any slow work early (the natural voice synthesizes)
//   play(item, onEnd)       speak; onEnd(error?) exactly once, when done or failed
//   cancel()                stop now and drop prepared work
//   tooSlow?()              the natural voice can't keep up with speech

const rateOf = (s) => Math.min(2, Math.max(0.5, Number(s.voiceRate) || 1));

/** The browser's speech synthesis. Errors just move on to the next chunk. */
export function systemSpeaker({ synth, Utterance, lang = 'en-US', getSettings = () => ({}) }) {
  let watchdog = null;
  return {
    kind: 'system',
    ready: () => true,
    prime() { try { const u = new Utterance(''); u.volume = 0; synth.speak(u); } catch {} },
    prepare: (text) => ({ text }),
    play(item, onEnd) {
      const s = getSettings();
      const u = new Utterance(item.text);
      const voice = pickVoice(synth.getVoices && synth.getVoices(), lang, s.voiceURI);
      if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = lang;
      u.rate = rateOf(s);
      let ended = false;
      const done = () => { if (ended) return; ended = true; clearTimeout(watchdog); onEnd(); };
      u.onend = done;
      u.onerror = done;
      // Some browsers drop 'end' (Chrome after a long pause); don't hang the call.
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { try { synth.cancel(); } catch {} done(); }, 6000 + item.text.length * 130 / u.rate);
      try { synth.speak(u); } catch { done(); }
    },
    cancel() { clearTimeout(watchdog); try { synth.cancel(); } catch {} },
  };
}

/** The natural voice: `tts` (tts.js createTTS) synthesizes, `player` plays.
 *  Chunks are synthesized ahead (prepare) while earlier ones play, so there
 *  are no gaps as long as synthesis runs faster than speech. */
export function neuralSpeaker({
  tts, player, voice, getSettings = () => ({}), now = () => Date.now(),
  synthTimeoutMs = (text) => 20000 + text.length * 150, slowRtf = 1.15, slowAfter = 2,
}) {
  const stats = [];
  return {
    kind: 'natural',
    ready: () => tts.state === 'ready',
    prime() { player.unlock(); },
    prepare(text) {
      const item = { text };
      item.audio = tts.synth(text, { speed: rateOf(getSettings()), voice }).then((a) => {
        if (a.samples.length) stats.push({ synthMs: a.ms, audioMs: 1000 * a.samples.length / a.sampleRate });
        return a;
      });
      item.audio.catch(() => {}); // play() reports failures
      return item;
    },
    play(item, onEnd) {
      let finished = false, watchdog = null;
      const end = (err) => {
        if (finished) return;
        finished = true; clearTimeout(timer); clearTimeout(watchdog);
        onEnd(err);
      };
      const timer = setTimeout(() => end(new Error('the natural voice took too long')), synthTimeoutMs(item.text));
      const audio = item.audio || this.prepare(item.text).audio;
      audio.then((a) => {
        if (finished) return;
        clearTimeout(timer);
        if (!a.samples.length) { end(); return; }
        const ms = 1000 * a.samples.length / a.sampleRate;
        watchdog = setTimeout(() => { player.stop(); end(); }, ms + 3000);
        player.play(a.samples, a.sampleRate).then(() => end(), end);
      }, (e) => { if (!(e && e.cancelled)) end(e); });
    },
    cancel() { tts.cancel(); player.stop(); },
    rtf: () => realTimeFactor(stats),
    tooSlow: () => stats.length >= slowAfter && realTimeFactor(stats) > slowRtf,
  };
}

/** Synthesis time / audio length over the last few chunks (under 1 keeps up). */
export function realTimeFactor(history, last = 3) {
  const h = history.slice(-last).filter(x => x && x.audioMs > 0);
  if (!h.length) return 0;
  return h.reduce((s, x) => s + x.synthMs, 0) / h.reduce((s, x) => s + x.audioMs, 0);
}

// ── Call state machine ─────────────────────────────────────────────────────

/** A hands-free call. Injected: SR (recognition constructor), send(text) (runs
 *  a normal chat turn; resolves when it is over), and either a `speaker` (with
 *  a `fallback`, normally system speech) or synth + Utterance for system speech.
 *  The UI calls feed(rawReplyText) while the reply streams and finish(rawReply)
 *  at the end. States: listening → thinking → speaking → listening … ; idle
 *  when ended.
 *
 *  Each reply is spoken by one voice: the speaker if it's ready when the reply
 *  starts, else the fallback. If the speaker fails or can't keep up, the rest
 *  of the call uses the fallback and onFallback(reason, detail) says why;
 *  setSpeaker() installs a new one for the next reply. */
export function createCall({
  SR, synth, Utterance, speaker = null, fallback = null, send, lang = 'en-US', getSettings = () => ({}),
  onChange = () => {}, onError = () => {}, onFallback = () => {},
  silenceMs = 1200, interimSilenceMs = 2200, resumeDelayMs = 350, lookahead = 2,
}) {
  const system = synth && Utterance ? systemSpeaker({ synth, Utterance, lang, getSettings }) : null;
  let primary = speaker || system;
  fallback = fallback || (speaker ? system : null);
  let primaryFailed = false, turnSpeaker = null;
  let active = false, state = 'idle';
  let rec = null, recRunning = false, wantListen = false, restartTimer = null, restarts = [];
  let finalText = '', interimText = '', commitTimer = null;
  let gen = 0, queue = [], speaking = false, resumeTimer = null;
  let turnOpen = false, muted = false, cursor = 0, latestRaw = '', transcript = '', error = '';

  const snapshot = () => ({ state, transcript, interim: Boolean(interimText), canRepeat: active && !turnOpen && Boolean(speakable(latestRaw)), error });
  const emit = () => onChange(snapshot());
  const setState = (s) => { state = s; emit(); };

  function buildRec() {
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = lang;
    rec.maxAlternatives = 1;
    rec.onstart = () => { recRunning = true; };
    rec.onresult = onResult;
    rec.onerror = onRecError;
    rec.onend = onRecEnd;
  }

  function startRec() {
    if (!active || !wantListen || recRunning) return;
    if (!rec) buildRec();
    try { rec.start(); recRunning = true; } catch { /* already started: its 'end' will restart us */ }
  }
  function pauseRec() {
    wantListen = false;
    clearTimeout(restartTimer);
    if (rec && recRunning) { try { rec.abort(); } catch {} }
  }

  function onResult(e) {
    if (!active || !wantListen && !getSettings().voiceBargeIn) return;
    if (state === 'speaking') {
      // Only reached with "interrupt by talking" on (recognition is paused otherwise).
      if (!getSettings().voiceBargeIn) return;
      bargeIn();
    }
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const text = String(r[0] && r[0].transcript || '').trim();
      if (!text) continue;
      if (r.isFinal) finalText += (finalText ? ' ' : '') + text; else interim += (interim ? ' ' : '') + text;
    }
    interimText = interim;
    transcript = [finalText, interimText].filter(Boolean).join(' ');
    emit();
    clearTimeout(commitTimer);
    if (transcript) commitTimer = setTimeout(commit, interim ? interimSilenceMs : silenceMs);
  }

  function onRecError(ev) {
    const code = ev && ev.error;
    if (code === 'no-speech' || code === 'aborted') return;
    if (ERRORS[code]) return fail(ERRORS[code]);
    if (code === 'network') { onError('Speech recognition lost its connection. Trying again.'); return; }
    onError(`Speech recognition problem (${code || 'unknown'}).`);
  }

  function onRecEnd() {
    recRunning = false;
    if (!active || !wantListen) return;
    const now = Date.now();
    restarts = restarts.filter(t => now - t < 4000);
    restarts.push(now);
    if (restarts.length > 12) return fail('Speech recognition keeps stopping. Check the microphone and start the call again.');
    clearTimeout(restartTimer);
    restartTimer = setTimeout(startRec, 250);
  }

  function fail(message) {
    error = message;
    onError(message, true);
    end(message);
  }

  function commit() {
    clearTimeout(commitTimer);
    const text = [finalText, interimText].filter(Boolean).join(' ').trim();
    finalText = ''; interimText = '';
    if (!text || !active || state !== 'listening') return;
    transcript = text;
    pauseRec();
    gen++; queue = []; muted = false; cursor = 0; latestRaw = ''; turnSpeaker = null;
    turnOpen = true;
    setState('thinking');
    Promise.resolve().then(() => send(text)).catch((e) => onError(String(e && e.message || e)))
      .finally(() => { if (turnOpen) finish(latestRaw); });
  }

  // Reply text streams in here (cumulative raw markdown).
  function feed(raw) {
    if (!active || !turnOpen) return;
    latestRaw = String(raw || '');
    if (muted) return;
    const { chunks, next } = takeSpeakable(latestRaw, cursor, false);
    cursor = next;
    enqueue(chunks);
  }
  function finish(raw) {
    if (!active || !turnOpen) return;
    if (raw != null) latestRaw = String(raw);
    turnOpen = false;
    if (!muted) {
      const { chunks, next } = takeSpeakable(latestRaw, cursor, true);
      cursor = next;
      enqueue(chunks);
    }
    pump();
  }

  // The voice for this reply, chosen when its first chunk is queued.
  function voiceForTurn() {
    if (!turnSpeaker) turnSpeaker = !primaryFailed && primary.ready() ? primary : (fallback || primary);
    return turnSpeaker;
  }

  function enqueue(chunks) {
    if (!chunks.length) return;
    const first = !turnSpeaker;
    const sp = voiceForTurn();
    if (first && sp.kind === 'natural') chunks = [...firstPiece(chunks[0]), ...chunks.slice(1)];
    for (const text of chunks) queue.push({ text, speaker: sp, item: null });
    prefetch();
    pump();
  }

  // Start synthesizing the next few chunks while the current one plays.
  function prefetch() {
    for (const q of queue.slice(0, lookahead)) if (!q.item) q.item = q.speaker.prepare(q.text);
  }

  // The speaker failed or fell behind: the rest of the call (from this chunk
  // on) uses the fallback.
  function switchToFallback(reason, detail, redo) {
    if (!fallback || primaryFailed) return;
    primaryFailed = true;
    try { primary.cancel(); } catch {}
    turnSpeaker = fallback;
    queue = [...(redo ? [redo] : []), ...queue].map(q => ({ text: q.text, speaker: fallback, item: null }));
    onFallback(reason, detail);
  }

  function pump() {
    if (!active || speaking) return;
    const next = queue.shift();
    if (next == null) {
      if (!turnOpen && (state === 'speaking' || state === 'thinking')) resumeSoon();
      return;
    }
    speaking = true;
    if (state !== 'speaking') setState('speaking');
    if (!getSettings().voiceBargeIn) pauseRec();
    const myGen = gen, sp = next.speaker;
    const item = next.item || sp.prepare(next.text);
    prefetch();
    sp.play(item, (err) => {
      if (myGen !== gen) return;
      speaking = false;
      if (sp === primary && sp !== fallback) {
        if (err) switchToFallback('error', err, next);
        else if (sp.tooSlow && sp.tooSlow()) switchToFallback('slow', sp.rtf ? sp.rtf() : 0);
      }
      pump();
    });
  }

  /** A new voice (say, a lighter model that finished loading) for the next reply. */
  function setSpeaker(sp) {
    primary = sp;
    primaryFailed = false;
    if (active) try { sp.prime(); } catch {}
  }

  function resumeSoon(delay = resumeDelayMs) {
    clearTimeout(resumeTimer);
    const myGen = gen;
    resumeTimer = setTimeout(() => {
      if (!active || myGen !== gen || speaking || queue.length || turnOpen && state === 'speaking') return;
      resume();
    }, delay);
  }
  function resume() {
    transcript = ''; interimText = ''; finalText = '';
    wantListen = true;
    setState('listening');
    startRec();
  }

  function stopSpeech() {
    gen++; queue = []; speaking = false;
    clearTimeout(resumeTimer);
    for (const sp of new Set([primary, fallback])) if (sp) { try { sp.cancel(); } catch {} }
  }

  // Tap or talk over the reply: stop speaking and listen. Tapping while
  // listening with text pending sends it now.
  function bargeIn() {
    if (!active) return;
    if (state === 'speaking') {
      stopSpeech();
      muted = true;
      resume();
    } else if (state === 'listening' && (finalText || interimText)) commit();
  }

  function repeat() {
    if (!active || turnOpen || !speakable(latestRaw)) return;
    stopSpeech();
    pauseRec();
    const { chunks } = takeSpeakable(latestRaw, 0, true);
    muted = false;
    turnSpeaker = null;
    enqueue(chunks);
  }

  function start() {
    if (active) return;
    active = true; error = '';
    // iOS Safari only lets speech and Web Audio start from a user gesture;
    // start() runs inside the call button's tap, so unlock both now.
    for (const sp of new Set([primary, fallback])) if (sp) { try { sp.prime(); } catch {} }
    transcript = '';
    resume();
  }

  function end(message = '') {
    if (!active && state === 'idle') return;
    active = false; wantListen = false; turnOpen = false;
    clearTimeout(commitTimer); clearTimeout(restartTimer);
    stopSpeech();
    if (rec) {
      rec.onresult = rec.onerror = rec.onend = rec.onstart = null;
      try { rec.abort(); } catch {}
      rec = null; recRunning = false;
    }
    if (message) error = message;
    setState('idle');
  }

  return {
    start, end, feed, finish, bargeIn, repeat, snapshot, setSpeaker,
    get active() { return active; },
    get voice() { return primaryFailed ? (fallback || primary).kind : primary.kind; },
  };
}

/** Reads one message aloud with a speaker (system or natural): markdown →
 *  sentences, each prepared one ahead so the natural voice has no gaps.
 *  onEnd(err, stopped) fires once: when the last sentence ends, on an error,
 *  or after stop(). Call it inside the tap (prime() unlocks audio on iOS). */
export function readAloud({ speaker, text, onEnd = () => {} }) {
  const chunks = splitSentences(speakable(text));
  let i = 0, ended = false, next = null;
  const finish = (err, stopped = false) => { if (ended) return; ended = true; onEnd(err || null, stopped); };
  const step = () => {
    if (ended) return;
    if (i >= chunks.length) { finish(null); return; }
    const item = next || speaker.prepare(chunks[i]);
    next = i + 1 < chunks.length ? speaker.prepare(chunks[i + 1]) : null;
    i++;
    speaker.play(item, (err) => { if (ended) return; if (err) finish(err); else step(); });
  };
  try { speaker.prime && speaker.prime(); } catch {}
  step();
  return {
    stop() { if (ended) return; finish(null, true); try { speaker.cancel(); } catch {} },
    get done() { return ended; },
    get total() { return chunks.length; },
  };
}
