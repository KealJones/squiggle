// Neural text-to-speech, the pure parts: which models exist, text → phonemes
// → token ids, voice style vectors, and audio clean-up. No DOM, no network,
// so the worker (tts-worker.js), the UI and node tests all share it.
//
// Text normalisation and the Kokoro phoneme fixes are ported from kokoro-js
// 1.2.1 (Apache-2.0, github.com/hexgrad/kokoro, js/src/phonemize.js); the
// KittenTTS tokeniser follows kittentts 0.8.0 (Apache-2.0, onnx_model.py).

const HF = 'https://huggingface.co';

// Cache Storage bucket for model and voice files (sw.js keeps it on updates).
export const TTS_CACHE = 'squiggle-tts-v1';

// Model files are pinned to a commit so a repo update can't change what loads.
export const TTS_MODELS = {
  kokoro: {
    label: 'Kokoro 82M',
    size: '~90 MB',
    bytes: 92361116,
    license: 'Apache-2.0',
    repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    rev: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
    file: 'onnx/model_quantized.onnx', // q8
    sampleRate: 24000,
    voices: {
      // Best-rated English voices (the model card's grades), best first.
      af_heart: 'Heart (US, female)',
      af_bella: 'Bella (US, female)',
      af_nicole: 'Nicole (US, female, soft)',
      bf_emma: 'Emma (UK, female)',
      am_michael: 'Michael (US, male)',
      am_fenrir: 'Fenrir (US, male)',
      am_puck: 'Puck (US, male)',
      bm_george: 'George (UK, male)',
      bm_fable: 'Fable (UK, male)',
    },
    defaultVoice: 'af_heart',
  },
  kitten: {
    label: 'KittenTTS nano 0.8',
    size: '~28 MB',
    bytes: 24369971 + 3278902,
    license: 'Apache-2.0',
    repo: 'KittenML/kitten-tts-nano-0.8-int8',
    rev: '84781d74e29ee25217551556398b42f80593a813',
    file: 'kitten_tts_nano_v0_8.onnx',
    voicesFile: 'voices.npz',
    sampleRate: 24000,
    voices: {
      'expr-voice-2-f': 'Bella (female)',
      'expr-voice-3-f': 'Luna (female)',
      'expr-voice-4-f': 'Rosie (female)',
      'expr-voice-5-f': 'Kiki (female)',
      'expr-voice-2-m': 'Jasper (male)',
      'expr-voice-3-m': 'Bruno (male)',
      'expr-voice-4-m': 'Hugo (male)',
      'expr-voice-5-m': 'Leo (male)',
    },
    // config.json speed_priors: the model's natural pace runs fast.
    speedPriors: { 'expr-voice-4-m': 0.9 },
    speedPrior: 0.8,
    defaultVoice: 'expr-voice-2-f',
  },
};

export function modelUrl(id, file) {
  const m = TTS_MODELS[id];
  return `${HF}/${m.repo}/resolve/${m.rev}/${file || m.file}`;
}
export function voiceUrl(id, voice) {
  const m = TTS_MODELS[id];
  return id === 'kokoro' ? modelUrl(id, `voices/${voice}.bin`) : modelUrl(id, m.voicesFile);
}
export function validVoice(id, voice) {
  const m = TTS_MODELS[id];
  return m && Object.hasOwn(m.voices, voice) ? voice : m ? m.defaultVoice : null;
}

// ── Text normalisation (kokoro-js) ─────────────────────────────────────────

function splitNum(s) {
  if (s.includes('.')) return s;
  if (s.includes(':')) {
    const [h, m] = s.split(':').map(Number);
    return m === 0 ? `${h} o'clock` : m < 10 ? `${h} oh ${m}` : `${h} ${m}`;
  }
  const year = parseInt(s.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return s;
  const left = s.slice(0, 2), right = parseInt(s.slice(2, 4), 10), plural = s.endsWith('s') ? 's' : '';
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${plural}`;
    if (right < 10) return `${left} oh ${right}${plural}`;
  }
  return `${left} ${right}${plural}`;
}
function flipMoney(s) {
  const bill = s[0] === '$' ? 'dollar' : 'pound';
  if (isNaN(Number(s.slice(1)))) return `${s.slice(1)} ${bill}s`;
  if (!s.includes('.')) return `${s.slice(1)} ${bill}${s.slice(1) === '1' ? '' : 's'}`;
  const [whole, frac] = s.slice(1).split('.');
  const cents = parseInt(frac.padEnd(2, '0'), 10);
  const coins = s[0] === '$' ? (cents === 1 ? 'cent' : 'cents') : (cents === 1 ? 'penny' : 'pence');
  return `${whole} ${bill}${whole === '1' ? '' : 's'} and ${cents} ${coins}`;
}
function pointNum(s) {
  const [a, b] = s.split('.');
  return `${a} point ${b.split('').join(' ')}`;
}

/** Spoken-form text: numbers, years, times, money, titles, initialisms. */
export function normalizeText(text) {
  return String(text || '')
    .replace(/[‘’]/g, "'")
    .replace(/«/g, '“').replace(/»/g, '”')
    .replace(/[“”]/g, '"')
    .replace(/\(/g, '«').replace(/\)/g, '»')
    .replace(/[^\S \n]/g, ' ')
    .replace(/  +/g, ' ')
    .replace(/(?<=\n) +(?=\n)/g, '')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc')
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, flipMoney)
    .replace(/\d*\.\d+/g, pointNum)
    .replace(/(?<=\d)-(?=\d)/g, ' to ')
    .replace(/(?<=\d)S/g, ' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
    .trim();
}

const PUNCT = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCT_RE = new RegExp(`(\\s*[${PUNCT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g');

/** Text → [{punct, text}] runs; punctuation is kept as written, the rest is phonemized. */
export function splitPunct(text) {
  const out = [];
  let at = 0;
  for (const m of text.matchAll(PUNCT_RE)) {
    if (at < m.index) out.push({ punct: false, text: text.slice(at, m.index) });
    if (m[0].length) out.push({ punct: true, text: m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ punct: false, text: text.slice(at) });
  return out;
}

/** Text → phoneme string. `espeak(text, lang)` returns phoneme lines (the
 *  phonemizer package's `phonemize`). Kokoro voices starting with 'b' are British. */
export async function toPhonemes(text, { espeak, model = 'kokoro', voice = '' } = {}) {
  const british = model === 'kokoro' && voice[0] === 'b';
  const lang = british ? 'en' : 'en-us';
  const runs = splitPunct(normalizeText(text));
  const parts = [];
  for (const r of runs) parts.push(r.punct ? r.text : (await espeak(r.text, lang)).join(' '));
  let p = parts.join('');
  if (model === 'kokoro') {
    p = p.replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ').replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
      .replace(/ʲ/g, 'j').replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ɬ/g, 'l')
      .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
      .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
    if (!british) p = p.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
    return p.trim();
  }
  // KittenTTS was trained on words and punctuation marks separated by spaces
  // (Python's re.findall(r"\w+|[^\w\s]") joined with ' '; \w excludes marks).
  return (p.match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu) || []).join(' ');
}

// ── Tokenisers (one id per character, 0 pads both ends) ────────────────────

const KOKORO_VOCAB = { '$': 0, ';': 1, ':': 2, ',': 3, '.': 4, '!': 5, '?': 6, '—': 9, '…': 10, '"': 11, '(': 12, ')': 13, '“': 14, '”': 15, ' ': 16, '̃': 17, 'ʣ': 18, 'ʥ': 19, 'ʦ': 20, 'ʨ': 21, 'ᵝ': 22, 'ꭧ': 23, 'A': 24, 'I': 25, 'O': 31, 'Q': 33, 'S': 35, 'T': 36, 'W': 39, 'Y': 41, 'ᵊ': 42, 'a': 43, 'b': 44, 'c': 45, 'd': 46, 'e': 47, 'f': 48, 'h': 50, 'i': 51, 'j': 52, 'k': 53, 'l': 54, 'm': 55, 'n': 56, 'o': 57, 'p': 58, 'q': 59, 'r': 60, 's': 61, 't': 62, 'u': 63, 'v': 64, 'w': 65, 'x': 66, 'y': 67, 'z': 68, 'ɑ': 69, 'ɐ': 70, 'ɒ': 71, 'æ': 72, 'β': 75, 'ɔ': 76, 'ɕ': 77, 'ç': 78, 'ɖ': 80, 'ð': 81, 'ʤ': 82, 'ə': 83, 'ɚ': 85, 'ɛ': 86, 'ɜ': 87, 'ɟ': 90, 'ɡ': 92, 'ɥ': 99, 'ɨ': 101, 'ɪ': 102, 'ʝ': 103, 'ɯ': 110, 'ɰ': 111, 'ŋ': 112, 'ɳ': 113, 'ɲ': 114, 'ɴ': 115, 'ø': 116, 'ɸ': 118, 'θ': 119, 'œ': 120, 'ɹ': 123, 'ɾ': 125, 'ɻ': 126, 'ʁ': 128, 'ɽ': 129, 'ʂ': 130, 'ʃ': 131, 'ʈ': 132, 'ʧ': 133, 'ʊ': 135, 'ʋ': 136, 'ʌ': 138, 'ɣ': 139, 'ɤ': 140, 'χ': 142, 'ʎ': 143, 'ʒ': 147, 'ʔ': 148, 'ˈ': 156, 'ˌ': 157, 'ː': 158, 'ʰ': 162, 'ʲ': 164, '↓': 169, '→': 171, '↗': 172, '↘': 173, 'ᵻ': 177 };

// StyleTTS 2's symbol table: id = position; a repeated symbol keeps its last position.
const KITTEN_SYMBOLS = ['$', ...';:,.!?¡¿—…"«»"" ', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  ...'ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘\'̩\'ᵻ'];

export const VOCAB = {
  kokoro: new Map(Object.entries(KOKORO_VOCAB)),
  kitten: new Map(KITTEN_SYMBOLS.map((s, i) => [s, i])),
};

export const MAX_TOKENS = 510; // the model's context is 512 with the two pads

/** Phonemes → ids with a 0 pad at each end; unknown characters are dropped. */
export function tokenize(phonemes, model = 'kokoro') {
  const vocab = VOCAB[model];
  const ids = [0];
  for (const ch of phonemes) {
    const id = vocab.get(ch);
    if (id != null) ids.push(id);
  }
  ids.push(0);
  return ids;
}

/** Text too long for one pass → two halves cut at the space nearest a
 *  sentence/clause boundary in the middle (callers recurse). */
export function halve(text) {
  const t = String(text).trim();
  const mid = Math.floor(t.length / 2);
  let best = -1, bestScore = Infinity;
  for (let i = 1; i < t.length - 1; i++) {
    if (t[i] !== ' ') continue;
    const prev = t[i - 1];
    const score = Math.abs(i - mid) - (/[.!?;:]/.test(prev) ? t.length / 3 : /,/.test(prev) ? t.length / 5 : 0);
    if (score < bestScore) { bestScore = score; best = i; }
  }
  if (best < 0) best = mid || 1;
  return [t.slice(0, best).trim(), t.slice(best).trim()].filter(Boolean);
}

// ── Voices (style vectors) ─────────────────────────────────────────────────

export const STYLE_DIM = 256;

/** The style row for this input: Kokoro picks by token count, Kitten by
 *  character count of the text. `table` is a Float32Array of rows × 256. */
export function styleFor(table, model, { ids, text }) {
  const rows = Math.floor(table.length / STYLE_DIM);
  const want = model === 'kokoro' ? Math.max(ids.length - 2, 0) : String(text || '').length;
  const row = Math.min(want, rows - 1);
  return table.slice(row * STYLE_DIM, (row + 1) * STYLE_DIM);
}

/** One float32 array from a .npz (an uncompressed zip of .npy files), by name
 *  without the .npy suffix. */
export function readNpz(buffer, name) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  let at = 0;
  while (at + 30 <= bytes.length && dv.getUint32(at, true) === 0x04034b50) {
    const method = dv.getUint16(at + 8, true);
    let size = dv.getUint32(at + 18, true);
    const nameLen = dv.getUint16(at + 26, true), extraLen = dv.getUint16(at + 28, true);
    const file = dec.decode(bytes.subarray(at + 30, at + 30 + nameLen));
    const start = at + 30 + nameLen + extraLen;
    if (size === 0xffffffff) {
      // Zip64 (numpy writes it): the sizes are in extra field 0x0001.
      for (let e = at + 30 + nameLen; e + 4 <= start;) {
        const id = dv.getUint16(e, true), len = dv.getUint16(e + 2, true);
        if (id === 1) { size = Number(dv.getBigUint64(e + 4 + (dv.getUint32(at + 22, true) === 0xffffffff ? 8 : 0), true)); break; }
        e += 4 + len;
      }
    }
    if (file === `${name}.npy`) {
      if (method !== 0) throw new Error(`${file} is compressed; only stored .npz files are supported`);
      return readNpy(bytes.subarray(start, start + size));
    }
    at = start + size;
  }
  throw new Error(`${name} not found in voices file`);
}

export function readNpy(bytes) {
  if (bytes[0] !== 0x93 || String.fromCharCode(...bytes.subarray(1, 6)) !== 'NUMPY') throw new Error('not a .npy array');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = bytes[6];
  const headerLen = major === 1 ? dv.getUint16(8, true) : dv.getUint32(8, true);
  const headerStart = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLen));
  if (!/'descr':\s*'<f4'/.test(header) || /'fortran_order':\s*True/.test(header)) throw new Error('expected a little-endian float32 C-order array');
  const data = bytes.subarray(headerStart + headerLen);
  // Copy: the data may not be 4-byte aligned inside the zip.
  const out = new Float32Array(Math.floor(data.length / 4));
  new Uint8Array(out.buffer).set(data.subarray(0, out.length * 4));
  return out;
}

// ── Audio ──────────────────────────────────────────────────────────────────

/** Trims near-silence at both ends, keeping a little so sentences don't run
 *  together, and fades the edges to avoid clicks. Returns a view or copy. */
export function tidyAudio(samples, sampleRate, { threshold = 0.004, keepStartMs = 30, keepEndMs = 160, fadeMs = 6 } = {}) {
  const n = samples.length;
  let a = 0, b = n - 1;
  while (a < n && Math.abs(samples[a]) < threshold) a++;
  while (b > a && Math.abs(samples[b]) < threshold) b--;
  if (a >= n) return samples.subarray(0, 0);
  a = Math.max(0, a - Math.round(keepStartMs * sampleRate / 1000));
  b = Math.min(n, b + 1 + Math.round(keepEndMs * sampleRate / 1000));
  const out = samples.slice(a, b);
  const f = Math.min(Math.round(fadeMs * sampleRate / 1000), Math.floor(out.length / 2));
  for (let i = 0; i < f; i++) { const g = i / f; out[i] *= g; out[out.length - 1 - i] *= g; }
  return out;
}

/** Real-time factor over recent chunks (synthesis time / audio length). The
 *  natural voice keeps up while this stays under 1. */
export function realTimeFactor(history, last = 3) {
  const h = history.slice(-last).filter(x => x && x.audioMs > 0);
  if (!h.length) return 0;
  return h.reduce((s, x) => s + x.synthMs, 0) / h.reduce((s, x) => s + x.audioMs, 0);
}
