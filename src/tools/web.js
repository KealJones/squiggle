// Web tools: read a page, search the web (through the relay).
import { apiBase, relayConfig } from '../github.js';
import { wrapUntrusted } from '../untrusted.js';
import { truncate } from '../util.js';
import { pageCard, pageText } from '../webpage.js';
import { defineTool, params, str, num } from './registry.js';
import { MAX_READ, saveWebPage } from './workspace.js';

export const fetchUrl = defineTool({
  name: 'fetch_url',
  group: 'web',
  description: 'Read a web page by its full URL. Returns readable text. Not a search engine.',
  parameters: params({ url: str('Complete http(s) URL') }, ['url']),
  async run({ url }, ctx = {}) {
    let u;
    try { u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url); } catch { return { model: { error: 'Pass one full URL, e.g. https://example.com/page.' } }; }
    let resp, via = 'direct';
    try { resp = await fetch(u.href, { redirect: 'follow' }); } catch {
      const cfg = await relayConfig().catch(() => ({}));
      if (!cfg.fetchEnabled) return { model: { error: 'That site blocks browser requests and the fetch relay is off.' } };
      resp = await fetch(`${apiBase()}/fetch?url=${encodeURIComponent(u.href)}`);
      via = 'relay';
    }
    const ct = resp.headers.get('content-type') || '';
    const raw = await resp.text();
    let text = raw, title = u.href, headings = [];
    if (/html/i.test(ct) || /^\s*<(!doctype|html)/i.test(raw)) {
      const doc = new DOMParser().parseFromString(raw, 'text/html');
      title = (doc.title || u.href).trim();
      headings = [...doc.querySelectorAll('h1,h2,h3')].map(h => (h.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      doc.querySelectorAll('script,style,noscript,svg,iframe,template,[hidden],[aria-hidden="true"]').forEach(n => n.remove());
      text = pageText(doc);
    }
    const status = via === 'relay' ? +(resp.headers.get('x-upstream-status') || resp.status) : resp.status;
    // Small models: the page is saved as a file and they get a short card
    // (opening, sections with line numbers) and grep or read_file for the rest.
    if (ctx.pageCards && text.length > 1500) {
      const path = saveWebPage(u.href, title, text);
      const card = pageCard(text, headings);
      return {
        model: { url: u.href, status, title, saved: path, lines: card.lines, opening: wrapUntrusted('web ' + u.hostname, card.opening), sections: card.sections, more: `The whole page is in ${path}. To find something, grep a pattern in ${path}; to read a part, read_file it with a line range.` },
        label: `read ${u.href} (saved as ${path})`,
        observation: { source: 'web', title: `${title} (${u.href})`, text: text.slice(0, 30000) },
      };
    }
    return {
      model: { url: u.href, status, title, text: wrapUntrusted('web ' + u.hostname, truncate(text, MAX_READ)) },
      label: `read ${u.href}`,
      observation: { source: 'web', title: `${title} (${u.href})`, text: text.slice(0, 30000) },
    };
  },
});

export const webSearch = defineTool({
  name: 'web_search',
  group: 'web',
  description: 'Search the web (DuckDuckGo). Returns a short summary when one exists, plus titles, links and snippets. To read a result in full, pass its url to fetch_url.',
  parameters: params({ query: str('What to search for'), count: num('How many results (default 6, max 10)') }, ['query']),
  async run({ query, count = 6 }) {
    const q = String(query || '').trim();
    if (!q) return { model: { error: 'Give a search query.' } };
    let r;
    try { r = await fetch(`${apiBase()}/search?q=${encodeURIComponent(q)}&n=${Math.min(Math.max(+count || 6, 1), 10)}`, { cache: 'no-store' }); }
    catch { return { model: { error: 'Could not reach the relay for search.' } }; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) return { model: { error: d.error || `Search failed (HTTP ${r.status}).` }, label: `search failed: "${q}"` };
    const results = d.results || [];
    const a = d.answer;
    const summary = a ? `Summary${a.heading ? ` of "${a.heading}"` : ''} (${a.source}${a.url ? ', ' + a.url : ''}):\n${a.text}\n\n` : '';
    const text = summary + results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n');
    return {
      model: { query: q, count: results.length, results: wrapUntrusted('web search', text.trim() || 'No results.') },
      label: `searched the web for "${truncate(q, 60)}" (${results.length})`,
      observation: text.trim() ? { source: 'web search', title: `Search: ${q}`, text } : null,
    };
  },
});
