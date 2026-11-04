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

// Readable text of a parsed (not rendered) page, one block per line. innerText
// needs layout, so on a DOMParser document it ran every paragraph, heading and
// list item together into one line.
const BLOCK = 'p,div,li,ul,ol,h1,h2,h3,h4,h5,h6,tr,section,article,header,footer,nav,aside,main,pre,blockquote,dt,dd,figcaption,figure,table,form,details,summary,hr';
export function pageText(doc) {
  const root = doc.body || doc.documentElement;
  if (!root) return '';
  for (const br of root.querySelectorAll('br')) br.replaceWith(doc.createTextNode('\n'));
  for (const el of root.querySelectorAll(BLOCK)) { el.before(doc.createTextNode('\n')); el.after(doc.createTextNode('\n')); }
  for (const cell of root.querySelectorAll('td,th')) cell.after(doc.createTextNode(' | '));
  return (root.textContent || '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n').map(l => l.trim()).filter((l, i, a) => l || (a[i - 1] && a[i - 1].trim()))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
