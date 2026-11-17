// Pictures, videos and sound the model takes in directly (LFM3 Omni on Keptsam), instead of the text read from them.
//
// Storage only holds text (attachments.js), so the files themselves live here, in memory, for as long as the page
// is open: an attachment the model can take in is kept under an id, and the prompt carries a marker for it where the
// user's message lists it. The engine (engine-keptsam.js) swaps each marker for the file itself when it reads the
// prompt. Each file is decoded once and the same object is handed over every time, so the engine can tell a prompt
// it has already read (Keptsam compares media by identity) and doesn't read it again. After a reload the files are
// gone and the markers aren't written: the model gets the attachment's text as before.

const kept = new Map();   // id → { kind, file, name, decoded?: Promise }
let next = 0;

export const KINDS = ['image', 'video', 'audio'];
const MARK = /⟦media:([a-z0-9]+)⟧/g;
export const marker = (id) => `⟦media:${id}⟧`;

/** Keeps a file for the model to take in; returns its id. */
export function keep(file, kind, name = file.name) {
  const id = (Date.now().toString(36) + (next++).toString(36)).slice(-10);
  kept.set(id, { kind, file, name });
  return id;
}

export const get = (id) => kept.get(id) || null;
export const forget = (id) => kept.delete(id);

/** Splits prompt text at media markers: strings, and { id, kind, file, name } for each marker still kept. */
export function split(text) {
  const out = [];
  let at = 0;
  for (const m of text.matchAll(MARK)) {
    const it = kept.get(m[1]);
    if (!it) continue;   // gone (page reloaded): the marker stays as text, which never happens since it isn't written then
    if (m.index > at) out.push(text.slice(at, m.index));
    out.push({ id: m[1], ...it });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export const hasMarkers = (text) => typeof text === 'string' && text.includes('⟦media:');

/** The decoded file (by `decode(item)`), made once and shared: the same object every time. */
export function decoded(id, decode) {
  const it = kept.get(id);
  if (!it) return null;
  if (!it.decoded) { it.decoded = decode(it); it.decoded.catch(() => { it.decoded = null; }); }
  return it.decoded;
}

/** Rough prompt tokens a file takes once the model reads it (for the context window): what Keptsam reads it as. */
export function tokensFor(kind, { seconds = 10 } = {}) {
  if (kind === 'image') return 260;                        // up to 256 picture tokens + its markers
  if (kind === 'audio') return Math.ceil(Math.min(seconds, 120) * 12.5) + 2;   // engine-keptsam.js reads at most 2 minutes
  if (kind === 'video') return Math.ceil(Math.min(seconds, 30)) * (64 + 12 + 8) + 2;   // and 30 s of video   // a frame pair a second (64 at low detail) + its timestamp + its sound
  return 0;
}

export const kindOfMedia = (mime = '', name = '') => {
  if (/^video\//.test(mime) || /\.(mp4|m4v|mov|webm)$/i.test(name)) return 'video';
  if (/^audio\//.test(mime) || /\.(mp3|m4a|wav|ogg|oga|opus|aac|flac|weba)$/i.test(name)) return 'audio';
  return null;
};
