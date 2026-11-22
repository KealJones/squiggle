// Files attached to a chat message: limits, text extraction, where they are
// kept, and what the model is shown.
//
// Storage only holds text (sync reads and merges files as UTF-8, and a
// binary blob would be corrupted by a conflict), so what gets synced is text:
//   text-like files   → the file itself, at home/attachments/<session>/<name>
//   PDFs              → the extracted text, at …/<name>.txt
//   images            → the text read from them (ocr.js), at …/<name>.txt
//   other binaries    → not stored; the model is told one was attached
// Everything stored is readable by the model through read_file and grep.
//
// A model that takes pictures, video or sound in directly (LFM3 Omni, engine.hasSense) gets the file itself for
// those: it's kept in memory for this page (media.js) and the model's note carries a marker the engine swaps for it.
// Nothing is stored for them (no OCR either: the model looks at the picture).
import { wrapUntrusted } from './untrusted.js';
import * as media from './media.js';

// Text recognition for images; replaceable in tests.
let ocr = async (file) => (await import('./ocr.js')).readImage(file);
export function setOcr(fn) { ocr = fn; }
// Which kinds the loaded model takes in itself ('image', 'video', 'audio'); set by the app (engine.hasSense).
let sees = () => false;
export function setSees(fn) { sees = fn || (() => false); }

export const MAX_FILES = 10;
export const MAX_BYTES = 20 * 1024 * 1024;
export const MEDIA_MAX_BYTES = 200 * 1024 * 1024;   // a video or recording the model watches or hears (kept in memory, not stored)
export const PDFJS_VERSION = '6.3.289';
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build`;
const MAX_PDF_PAGES = 400;
const OBSERVATION_CHARS = 20000;   // same cap read_file uses for what search can find

const TEXT_EXT = new Set(('txt text md markdown rst org csv tsv json jsonl ndjson xml html htm css scss js mjs cjs jsx ts tsx py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh sql yml yaml toml ini cfg conf env log diff patch tex svg lua r pl ex exs hs clj scala dart vue svelte').split(' '));
const IMAGE_EXT = new Set('png jpg jpeg gif webp bmp heic heif avif tif tiff ico'.split(' '));

const ext = (name) => (String(name).match(/\.([A-Za-z0-9]+)$/) || [])[1]?.toLowerCase() || '';

// 'pdf' | 'image' | 'text' | 'other' (other: sniffed for text when read).
export function kindOf(name, mime = '') {
  const e = ext(name);
  if (e === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (IMAGE_EXT.has(e) || (mime.startsWith('image/') && e !== 'svg')) return 'image';
  if (TEXT_EXT.has(e) || mime.startsWith('text/') || /json|xml|javascript/.test(mime)) return 'text';
  return 'other';
}

// A filename that is safe as one path segment in the storage repo, and
// unique among `taken` (names already used in this message's folder).
export function safeName(name, taken = new Set()) {
  let n = String(name || 'file').split(/[\\/]/).pop().normalize('NFC')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  if (!n) n = 'file';
  if (n.length > 80) { const e = ext(n); n = n.slice(0, 80 - (e ? e.length + 1 : 0)) + (e ? '.' + e : ''); }
  const base = n;
  for (let i = 2; taken.has(n.toLowerCase()); i++) {
    const e = ext(base);
    n = e ? `${base.slice(0, -(e.length + 1))}-${i}.${e}` : `${base}-${i}`;
  }
  taken.add(n.toLowerCase());
  return n;
}

export const fmtSize = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB` : `${(b / 1048576).toFixed(1)} MB`;
export const lineCount = (t) => t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0;

// Checks a picked set of files against the limits. Returns { ok: File[], problems: string[] }.
export function checkFiles(files, already = 0) {
  const ok = [], problems = [];
  for (const f of files) {
    if (already + ok.length >= MAX_FILES) { problems.push(`Only ${MAX_FILES} files per message; skipped ${f.name}.`); continue; }
    const mk = media.kindOfMedia(f.type || '', f.name) || (kindOf(f.name, f.type || '') === 'image' ? 'image' : null);
    if (mk && sees(mk) && f.size <= MEDIA_MAX_BYTES) { ok.push(f); continue; }
    if (f.size > MAX_BYTES) { problems.push(`${f.name} is ${fmtSize(f.size)}; files over ${fmtSize(MAX_BYTES)} can't be attached.`); continue; }
    ok.push(f);
  }
  return { ok, problems };
}

// Plain text of a text-like file, or null if it looks binary.
export function decodeText(bytes) {
  const head = bytes.subarray(0, 4096);
  if (head.includes(0)) return null;
  const text = new TextDecoder('utf-8').decode(bytes);
  if (text.includes('�') && (text.match(/�/g).length > text.length / 50)) return null;
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

let pdfjsPromise = null;
async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const lib = await import(/* @vite-ignore */ `${PDFJS_BASE}/pdf.min.mjs`);
      // CSP only allows same-origin and blob: workers, so run the CDN's
      // worker script from a blob.
      const src = await (await fetch(`${PDFJS_BASE}/pdf.worker.min.mjs`)).text();
      lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      return lib;
    })();
    pdfjsPromise.catch(() => { pdfjsPromise = null; });
  }
  return pdfjsPromise;
}

async function pdfText(bytes) {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({ data: bytes, isEvalSupported: false }).promise;
  try {
    const pages = [];
    const n = Math.min(doc.numPages, MAX_PDF_PAGES);
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let s = '';
      for (const it of tc.items) s += it.str + (it.hasEOL ? '\n' : '');
      pages.push(`--- page ${i} ---\n${s.trim()}`);
    }
    if (doc.numPages > n) pages.push(`--- ${doc.numPages - n} more pages not extracted ---`);
    const text = pages.join('\n\n');
    return text.replace(/--- page \d+ ---|\n|\s/g, '') ? text : '';   // pages with no text at all (scans)
  } finally { doc.destroy && doc.destroy(); }
}

/**
 * Reads one file into an attachment record (not stored yet):
 * { name, safe, type, size, kind, text, path, stored, chars, lines, error? }
 * `text` is the extract (null when there is none).
 */
export async function readAttachment(file, taken, sessionId) {
  const kind = kindOf(file.name, file.type || '');
  const safe = safeName(file.name, taken);
  const a = { name: safe, type: file.type || '', size: file.size, kind, text: null, path: null, stored: false, chars: 0, lines: 0 };
  const dir = `/home/attachments/${sessionId}/`;
  const mk = kind === 'image' ? 'image' : media.kindOfMedia(file.type || '', file.name);
  if (mk && sees(mk)) {
    // The model takes it in itself: kept in memory for this page, nothing stored.
    Object.assign(a, { kind: mk, media: media.keep(file, mk, safe) });
    if (mk !== 'image') a.seconds = await duration(file).catch(() => 0);
    return a;
  }
  try {
    if (kind === 'image') {
      // The model can't see images, so it gets the words in them.
      const r = await ocr(file);
      if (!r || !r.text) { a.error = 'no readable text found in the image'; return a; }
      const text = `Text read from the image ${safe} (OCR, so letters or numbers may be misread; it doesn't describe pictures or icons):\n\n${r.text}\n`;
      a.path = dir + safe + '.txt';
      Object.assign(a, { text, stored: true, chars: text.length, lines: lineCount(text) });
      return a;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text = null;
    if (kind === 'pdf') {
      text = await pdfText(bytes);
      if (!text) { a.error = 'no text found (maybe a scan)'; return a; }
      a.path = dir + safe + '.txt';
    } else {
      text = decodeText(bytes);
      if (text == null) { a.kind = 'binary'; return a; }
      a.kind = 'text';
      a.path = dir + safe;
    }
    Object.assign(a, { text, stored: true, chars: text.length, lines: lineCount(text) });
  } catch (e) {
    a.error = `couldn't read it: ${(e && e.message) || e}`;
    a.text = null; a.path = null; a.stored = false;
  }
  return a;
}

// A video's or recording's length in seconds, from the browser's own player.
function duration(file) {
  return new Promise((resolve, reject) => {
    const el = document.createElement(media.kindOfMedia(file.type || '', file.name) === 'video' ? 'video' : 'audio');
    const url = URL.createObjectURL(file);
    const done = (v) => { URL.revokeObjectURL(url); el.removeAttribute('src'); v instanceof Error ? reject(v) : resolve(v); };
    el.preload = 'metadata';
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : 0);
    el.onerror = () => done(new Error('unreadable'));
    el.src = url;
  });
}

// What goes into the message record (no text; that lives in storage). `media`: the id of a file kept in memory
// for the model (media.js); on another device or after a reload it names nothing and is ignored.
export const toRecord = (a) => ({ name: a.name, path: a.path, type: a.type || a.kind, size: a.size, chars: a.chars, ...(a.lines ? { lines: a.lines } : {}), ...(a.error ? { error: a.error } : {}), ...(a.media ? { media: a.media, kind: a.kind, ...(a.seconds ? { seconds: Math.round(a.seconds) } : {}) } : {}) });

/**
 * Saves the extracts into storage and makes them searchable.
 * `io` = { write(rel, text), observe({source,title,text}) }.
 */
export async function saveAttachments(atts, io) {
  for (const a of atts) {
    if (!a.stored || a.text == null) continue;
    await io.write(a.path.replace(/^\//, ''), a.text);
    io.observe({ source: 'attachment', title: `${a.name} (${a.path})`, text: a.text.slice(0, OBSERVATION_CHARS) });
  }
}

// One line per attachment for the model's note.
const MEDIA_WORD = { image: 'picture', video: 'video', audio: 'recording' };
// A file the model takes in itself, if it's still kept here and the model still can: its marker, else null.
const mediaMark = (a) => (a.media && media.get(a.media) && sees(a.kind) ? media.marker(a.media) : null);

function describe(a) {
  const size = fmtSize(a.size);
  const mark = mediaMark(a);
  if (mark) return `- ${a.name} (${MEDIA_WORD[a.kind] || a.kind}, ${size}${a.seconds ? `, ${Math.round(a.seconds)} s` : ''}): ${mark}`;
  if (a.stored && a.kind === 'image') return `- ${a.name} (image, ${size}): you can't see images; the text read from it is at ${a.path}`;
  if (a.stored) return `- ${a.path} (${size}, ${a.lines} line${a.lines === 1 ? '' : 's'})`;
  if (a.kind === 'image') return `- ${a.name} (image, ${size}): ${a.error ? a.error + '; ' : ''}you can't see images, so you can't say what's in it`;
  if (a.error) return `- ${a.name} (${size}): ${a.error}; not saved`;
  return `- ${a.name} (${size}): unsupported binary file; not saved and not readable`;
}

/**
 * The text the model gets for a message with attachments: the note, then the
 * start of each extract (wrapped as outside content) within `roomChars`.
 * Returns { note, excerpts, text } where text = note + excerpts.
 */
export function attachmentPrompt(atts, roomChars) {
  if (!atts || !atts.length) return { note: '', excerpts: '', text: '', mediaTokens: 0 };
  const mediaTokens = atts.reduce((n, a) => n + (mediaMark(a) ? media.tokensFor(a.kind, { seconds: a.seconds || 10 }) : 0), 0);
  const note = `[The user attached ${atts.length} file${atts.length === 1 ? '' : 's'}:\n${atts.map(describe).join('\n')}]`;
  const readable = atts.filter(a => a.stored && a.text);
  let left = Math.max(0, Math.min(roomChars, 24000) - note.length);
  const parts = [];
  readable.forEach((a, i) => {
    const share = Math.floor(left / (readable.length - i));
    const t = a.text;
    if (share < 200 && t.length > share) {
      parts.push(`(${a.path}: no room to show any of it; use read_file or grep)`);
      return;
    }
    let shown = t.length <= share ? t : t.slice(0, share);
    if (shown.length < t.length) { const cut = shown.lastIndexOf('\n'); if (cut > share * 0.6) shown = shown.slice(0, cut); }
    left -= shown.length;
    const shownLines = lineCount(shown);
    const more = shown.length < t.length
      ? `\n(showing lines 1-${shownLines} of ${a.lines}; read the rest with read_file ${a.path} start_line ${shownLines + 1}, or grep for what you need)` : '';
    parts.push(`${a.path}:\n` + wrapUntrusted('attachment ' + a.path, shown) + more);
  });
  const excerpts = parts.join('\n\n');
  return { note, excerpts, text: note + (excerpts ? '\n\n' + excerpts : ''), mediaTokens };
}

// How an earlier user message with attachments is replayed (names only; the
// text is in storage and in search).
export function replayNote(atts) {
  if (!atts || !atts.length) return '';
  // A picture still kept here is shown again (≤256 tokens); a video or recording is only named (they're long).
  return `[attached: ${atts.map(a => mediaMark(a) && a.kind === 'image' ? `${a.name} ${mediaMark(a)}` : a.media ? `${a.name} (${MEDIA_WORD[a.kind] || a.kind}, ${fmtSize(a.size)}, shown in that message only)` : a.path ? `${a.path} (${fmtSize(a.size)}${a.lines ? ', ' + a.lines + ' lines' : ''})` : `${a.name} (${fmtSize(a.size)}, not saved)`).join('; ')}]`;
}
