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

export const scrollDown = (el) => requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });

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
