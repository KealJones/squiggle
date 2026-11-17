// Tiny DOM helpers shared by the UI modules. No framework: the app is plain ES
// modules with no build step, and these dozen lines are all it needs.
import { marked, DOMPurify } from '../../vendor/markdown.js';

export const $ = (sel, root = document) => root.querySelector(sel);

/** h(tag, attrs, ...children): attrs are attributes, except class, on<event> handlers and html. */
export const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
};

/** An inline SVG icon from the sprite in index.html. */
export const icon = (id) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = `<use href="#${id}"/>`; return s; };

/** Markdown → sanitized HTML. */
export const md = (text) => DOMPurify.sanitize(marked.parse(String(text || ''), { breaks: true }));

export const ago = (ts) => {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// The "working" indicator: the logo squiggle wiggling like a snake. It's an
// animated WebP (app/icons/squiggle.webp, made by scripts/squiggle-webp.mjs)
// used as a CSS mask, so it takes the element's colour and costs nothing per
// frame on the main thread (no SMIL, no style recalcs), and browsers stop it
// when it's hidden. A still frame for people who prefer reduced motion (CSS).
export const squiggleWait = () => h('span', { class: 'squiggle-wait', role: 'status', 'aria-label': 'Working' });

export function iconButton(id, label, onclick, pressed) {
  return h('button', { class: 'icon-btn', 'aria-label': label, title: label, onclick, 'aria-pressed': pressed ? 'true' : null }, icon(id));
}

// Follow the bottom only while the reader is there (Keal, 2026-11-13: "i cant scroll up when the text is being
// streamed in"). Scrolling up with a wheel or a finger lets go at once; back at the bottom, it follows again. `force`
// (opening a chat, sending a message) jumps to the bottom and follows from there.
const NEAR = 40;
const follow = new WeakMap();   // el → { on, touching }
const atBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR;
function watch(el) {
  let f = follow.get(el);
  if (f) return f;
  f = { on: true, touching: false };
  follow.set(el, f);
  el.addEventListener('wheel', (e) => { if (e.deltaY < 0) f.on = false; }, { passive: true });
  el.addEventListener('touchstart', () => { f.touching = true; }, { passive: true });
  const lift = () => { f.touching = false; f.on = atBottom(el); };
  el.addEventListener('touchend', lift, { passive: true });
  el.addEventListener('touchcancel', lift, { passive: true });
  el.addEventListener('scroll', () => { if (!f.touching) f.on = atBottom(el); }, { passive: true });
  return f;
}
export const scrollDown = (el, { force = false } = {}) => {
  const f = watch(el);
  if (force) f.on = true;
  requestAnimationFrame(() => { if (f.on && !f.touching) el.scrollTop = el.scrollHeight; });
};

// A short note at the bottom of the screen that goes away on its own.
let toastTimer = null;
export function toast(text, ms = 5000) {
  let t = document.querySelector('.toast');
  if (!t) { t = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(t); }
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// Number formatting
// Keeps the screen on while any reason holds it (a reply, a voice call). Browsers drop the lock whenever the page is
// hidden, so it's asked for again when the page shows. Best effort: no Wake Lock API (or refused) changes nothing.
const awake = new Set();
let wakeLock = null, asking = false;
async function syncWake() {
  if (asking) return;
  try {
    if (awake.size && !wakeLock && document.visibilityState === 'visible' && navigator.wakeLock) {
      asking = true;
      const lock = await navigator.wakeLock.request('screen');
      wakeLock = lock;
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
    } else if (!awake.size && wakeLock) await wakeLock.release();
  } catch {} finally {
    if (asking) { asking = false; if (!awake.size && wakeLock) syncWake(); }   // let go while the request was pending
  }
}
export function keepAwake(reason, on) {
  if (on) awake.add(reason); else awake.delete(reason);
  syncWake();
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', syncWake);

export const fmtTok = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
export const fmtPct = (n, of) => { const p = 100 * n / (of || 1); return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`; };
export const gb = (n) => (n / 1e9).toFixed(2);
export const pct = (got, total) => (total ? ` (${Math.round(100 * got / total)}%)` : '');
export function eta(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 90) return 'under 2 min left';
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} min left`;
  return `about ${(seconds / 3600).toFixed(1)} h left`;
}
