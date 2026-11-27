// Long web pages for small models (tools.js fetch_url, card mode): the page is kept
// as /web/<n>.txt and the model gets this card, then greps or reads the rest.

// A short card for a long page: the first paragraphs of real prose (skipping menus
// and other short lines), up to ~500 characters, and the section headings with the
// line they start on.
export function pageCard(text, headings = []) {
  const lines = String(text).split('\n');
  let opening = '';
  for (const l of lines) {
    const t = l.trim();
    if (t.length < 60 || !/[.!?]["')\]]?$/.test(t)) continue;      // menus, labels, captions
    opening += (opening ? '\n' : '') + t;
    if (opening.length >= 500) break;
  }
  if (opening.length > 600) opening = opening.slice(0, 600).replace(/\s+\S*$/, '') + '…';
  const sections = [];
  let from = 0;
  for (const h of headings.slice(0, 60)) {
    const i = lines.findIndex((l, k) => k >= from && l.trim() === h);
    if (i < 0) continue;
    sections.push(`${i + 1} ${h.slice(0, 60)}`);
    from = i + 1;
  }
  return { lines: lines.length, opening, sections: sections.slice(0, 25).join(' · ') };
}

// Which part of the page is the content, read the way a screen reader finds it: the
// accessibility tree's landmarks. The main landmark (<main>, role=main) is the content
// when it holds a real share of the page's text, else a lone <article>, else the body.
// 2026-11-20: biography.com's "Other Famous Disney Stars" link list came through as loose
// names next to the High School Musical paragraph, and LFM3 wrote that Olivia Rodrigo
// starred "alongside Zac Efron and Demi Lovato" (docs/failures.md case 23).
const len = (el) => (el.textContent || '').replace(/\s+/g, '').length;
function contentRoot(doc) {
  const body = doc.body || doc.documentElement;
  if (!body) return null;
  const all = len(body);
  const enough = (el) => len(el) >= Math.min(200, all) && len(el) >= all * 0.2;
  const mains = [...body.querySelectorAll('main, [role="main"]')].filter(enough);
  if (mains.length) return mains.sort((a, b) => len(b) - len(a))[0];
  const articles = [...body.querySelectorAll('article, [role="article"]')].filter(a => !a.parentElement?.closest('article, [role="article"]'));
  if (articles.length === 1 && len(articles[0]) >= all * 0.3) return articles[0];
  return body;
}

// Landmarks and widgets that are never the content: site header and footer, navigation,
// sidebars, search, menus, dialogs. Explicit roles win over the tag's implicit one; a
// <header>/<footer> is only the page's banner/contentinfo outside any sectioning element
// (an article's own header keeps its title and byline), as in HTML-AAM.
const CHROME_ROLES = new Set(['navigation', 'complementary', 'banner', 'contentinfo', 'search', 'menu', 'menubar', 'dialog', 'alertdialog']);
const SECTIONING = 'article, aside, main, nav, section, [role="article"], [role="main"], [role="region"], [role="complementary"], [role="navigation"]';
function roleOf(el) {
  const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
  if (explicit) return explicit;
  switch (el.localName) {
    case 'nav': return 'navigation';
    case 'aside': return 'complementary';
    case 'search': return 'search';
    case 'dialog': return 'dialog';
    case 'header': return el.parentElement?.closest(SECTIONING) ? '' : 'banner';
    case 'footer': return el.parentElement?.closest(SECTIONING) ? '' : 'contentinfo';
    default: return '';
  }
}
// A list whose every item is only a link (3+ items): related links, "other famous…",
// tag clouds, menus marked up without ARIA. Its heading goes with it, so no label is
// left over with nothing under it.
function linkList(list) {
  const items = [...list.children].filter(c => c.localName === 'li' || c.getAttribute('role') === 'listitem');
  if (items.length < 3) return false;
  return items.every(li => {
    const all = len(li);
    if (!all) return true;
    const linked = [...li.querySelectorAll('a[href]')].filter(a => !a.parentElement?.closest('a')).reduce((n, a) => n + len(a), 0);
    return linked >= all * 0.9;
  });
}
function dropChrome(root) {
  const contentInside = (el) => el.querySelector('main, [role="main"], article, [role="article"]');
  for (const el of [...root.querySelectorAll('*')]) {
    if (!el.isConnected) continue;
    if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) { el.remove(); continue; }
    if (CHROME_ROLES.has(roleOf(el)) && !contentInside(el)) el.remove();
  }
  for (const list of [...root.querySelectorAll('ul, ol, menu, [role="list"]')]) {
    if (!list.isConnected || !linkList(list)) continue;
    const prev = list.previousElementSibling;
    if (prev && /^h[1-6]$/.test(prev.localName) && prev.localName !== 'h1') prev.remove();
    list.remove();
  }
}

// Readable text of a parsed (not rendered) page, one block per line. innerText
// needs layout, so on a DOMParser document it ran every paragraph, heading and
// list item together into one line.
const BLOCK = 'p,div,li,ul,ol,h1,h2,h3,h4,h5,h6,tr,section,article,header,footer,nav,aside,main,pre,blockquote,dt,dd,figcaption,figure,table,form,details,summary,hr';
export function pageText(doc) {
  const root = contentRoot(doc);
  if (!root) return '';
  dropChrome(root);
  for (const br of root.querySelectorAll('br')) br.replaceWith(doc.createTextNode('\n'));
  for (const el of root.querySelectorAll(BLOCK)) { el.before(doc.createTextNode('\n')); el.after(doc.createTextNode('\n')); }
  for (const cell of root.querySelectorAll('td,th')) cell.after(doc.createTextNode(' | '));
  return (root.textContent || '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n').map(l => l.trim()).filter((l, i, a) => l || (a[i - 1] && a[i - 1].trim()))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
