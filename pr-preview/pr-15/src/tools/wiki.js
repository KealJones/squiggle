// Wikipedia and Wikidata, straight from the browser (both send CORS headers for origin=*).
//
// wiki_lookup(query): what Wikipedia and Wikidata say about whoever or whatever a question is about. One
// Wikipedia search finds the article (typos are fine: "Emma stones" finds Emma Stone) and its Wikidata item; then
// two SPARQL queries get every real fact on the item (no hand-picked list: every property except ids, links and
// media, ranked by how well its name and aliases match the question, so "founder" finds "founded by" and
// "created" finds "inception") and the newest things that link to it from any property (films someone is in,
// products a company makes…). The model only passes words or a Q-id; it never needs ids or SPARQL.
//
// wikidata_query(sparql): runs the model's own SPARQL. Only for big models (agent.js): a 0.6B model writes
// queries that don't run or that ask about the wrong item (docs/measurements-2026-11-04.md).
//
// The pure parts (queries, parsing, ranking, rendering) are exported for tests; `ctx.fetch` replaces fetch.
import { wrapUntrusted } from '../untrusted.js';
import { truncate } from '../util.js';
import { tokenize } from '../search.js';
import { defineTool, params, str } from './registry.js';

const WP = 'https://en.wikipedia.org/w/api.php';
const WD_API = 'https://www.wikidata.org/w/api.php';
const SPARQL = 'https://query.wikidata.org/sparql';
const UA = 'Squiggle/0.1 (https://github.com/KealJones/squiggle)';
const LINKS_LIMIT = 500;   // linked-from rows fetched; an item with more is a hub (a country), and the sample is noise

// ── Queries ────────────────────────────────────────────────────────────────

export function searchUrl(q, limit = 5) {
  const p = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', origin: '*', redirects: '1',
    generator: 'search', gsrsearch: q, gsrlimit: String(limit), gsrnamespace: '0',
    prop: 'pageprops|description|extracts|info', ppprop: 'wikibase_item|disambiguation', inprop: 'url',
    exintro: '1', explaintext: '1', exsentences: '3', exlimit: String(limit),
  });
  return `${WP}?${p}`;
}

export function entityUrl(qid) {
  return `${WD_API}?${new URLSearchParams({ action: 'wbgetentities', ids: qid, props: 'labels|descriptions|sitelinks/urls', languages: 'en', sitefilter: 'enwiki', format: 'json', origin: '*' })}`;
}

// Every truthy statement except ids, links and media, with the property's English name and aliases.
export function factsQuery(qid) {
  return `SELECT ?p ?pLabel ?v ?vLabel (GROUP_CONCAT(DISTINCT ?alias; separator="|") AS ?aliases) WHERE {
  wd:${qid} ?d ?v .
  ?p wikibase:directClaim ?d ; wikibase:propertyType ?t .
  FILTER(?t NOT IN (wikibase:ExternalId, wikibase:CommonsMedia, wikibase:Url, wikibase:GeoShape, wikibase:TabularData, wikibase:Math, wikibase:MusicalNotation))
  OPTIONAL { ?p skos:altLabel ?alias . FILTER(LANG(?alias) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} GROUP BY ?p ?pLabel ?v ?vLabel`;
}

// What links to the item, from any property, with a date (released, founded or started) and a type.
export function linksQuery(qid) {
  return `SELECT ?x ?xLabel ?pLabel (MIN(?d0) AS ?date) (SAMPLE(?tl) AS ?type) WHERE {
  { SELECT ?x ?p WHERE { ?x ?dp wd:${qid} . ?p wikibase:directClaim ?dp . } LIMIT ${LINKS_LIMIT} }
  OPTIONAL { ?x wdt:P577|wdt:P571|wdt:P580 ?d0 . }
  OPTIONAL { ?x wdt:P31 ?t . ?t rdfs:label ?tl . FILTER(LANG(?tl) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} GROUP BY ?x ?xLabel ?pLabel`;
}

export const sparqlUrl = (q) => `${SPARQL}?${new URLSearchParams({ query: q, format: 'json' })}`;

// ── Finding the article ─────────────────────────────────────────────────────

// Words about asking or arithmetic, not about the subject: dropped from the Wikipedia search.
const ASKING = new Set(('what whats who whos whose when where why how which is are was were do does did can could would should will ' +
  'the a an of in on at to for me my you your please tell show find look up search give know latest newest recent most last ' +
  'new current currently now today right about divided by times plus minus multiplied over half double twice squared ' +
  'sum total average percent').split(' '));
const clean = (w) => w.replace(/['’]s$/i, '').replace(/^['’"“]+|['’"”]+$/g, '');

/** The words of a question that name what it's about ("What is Emma stone's birth year divided by 2?" →
 *  "Emma stone birth year"). */
export function subjectWords(q) {
  const words = String(q || '').replace(/[?!.,;:"“”()*/+=×÷^%]/g, ' ').split(/\s+/).map(clean).filter(Boolean);
  const kept = words.filter(w => !ASKING.has(w.toLowerCase()) && !/^\d+([.,]\d+)?$/.test(w));
  return (kept.length ? kept : words).join(' ');
}

/** The name part of the subject: from its first capitalised word, two words ("Emma stone birth year" → "Emma
 *  stone"); the first two words when nothing is capitalised. */
export function headWords(subject) {
  const w = String(subject || '').split(/\s+/).filter(Boolean);
  const i = Math.max(0, w.findIndex(x => /^\p{Lu}/u.test(x)));
  return w.slice(i, i + 2).join(' ');
}

const isList = (title) => /^(list|lists) of\b|\b(filmography|discography|bibliography|videography|performances|awards and nominations)\b/i.test(title);
// Every word, numbers included ("Jaws 2" is not "Jaws"), minus the few that titles add.
const SMALL = new Set(['the', 'a', 'an', 'of', 'and', '&']);
// A plural matches its singular ("Emma stones" names Emma Stone).
const rawWords = (s) => String(s).toLowerCase().replace(/['’]s\b/g, '').split(/[^\p{L}\p{N}]+/u).filter(w => w && !SMALL.has(w)).map(w => (w.length > 3 ? w.replace(/s$/, '') : w));
/** Does the question contain every word of the article's title (its base, without "(film)")? */
export const titleInQuery = (title, query) => {
  const q = new Set(rawWords(query));
  const t = rawWords(String(title).replace(/\s*\(.*\)\s*$/, ''));
  return t.length > 0 && t.every(w => q.has(w));
};

/** Wikipedia search result → { main, lists, others } (each { title, description, extract, url, qid }). The main
 *  article is the first whose title is in the question, else the first that isn't a list or disambiguation. */
export function pickPages(json, query = '') {
  const pages = ((json && json.query && json.query.pages) || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0))
    .map(p => ({ title: p.title, description: p.description || '', extract: p.extract || '', url: p.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(String(p.title).replace(/ /g, '_'))}`,
      qid: p.pageprops && p.pageprops.wikibase_item, disambiguation: Boolean(p.pageprops && 'disambiguation' in p.pageprops) }));
  const usable = pages.filter(p => !p.disambiguation && !isList(p.title));
  const main = (query && usable.find(p => titleInQuery(p.title, query))) || usable[0] || null;
  const lists = pages.filter(p => isList(p.title));
  const others = usable.filter(p => p !== main).slice(0, 3);
  return { main, lists, others, matched: Boolean(main && query && titleInQuery(main.title, query)) };
}

// ── Facts ───────────────────────────────────────────────────────────────────

const isDate = (v) => /^[+-]?\d{4}-\d{2}-\d{2}T/.test(v);
const day = (v) => String(v).replace(/^\+/, '').slice(0, 10);
const NO_LABEL = (v) => /^https?:\/\/www\.wikidata\.org\/entity\//.test(v) || /^[QPL]\d+$/.test(v);
// Wikimedia's own bookkeeping: categories, templates, Commons, project lists.
const INTERNAL_VALUE = /^(Category|Template|Wikipedia|Portal|Module|Help):/;
const INTERNAL_PROP = /\b(Commons|Wikimedia|Wikipedia|main category|template|focus list|category)\b/i;

const valueText = (b) => {
  const raw = b.vLabel ? b.vLabel.value : b.v ? b.v.value : '';
  if (isDate(raw)) return day(raw);
  if (NO_LABEL(raw) || INTERNAL_VALUE.test(raw)) return '';
  return raw;
};

// A crude stem, so "founder" meets "founded" and "directed" meets "director".
const stem = (w) => w.toLowerCase().replace(/(ers|er|ors|or|ed|ing|ion|es|s)$/, '');

/** SPARQL facts → [{ prop, label, values[], more, score }]. Ranked by how many of the question's words the
 *  property's name and aliases share, then by property number (lower ones are the basic ones: instance of,
 *  country, born…). Values per property capped. */
export function parseFacts(json, { query = '', perProp = 3 } = {}) {
  const byProp = new Map();
  for (const b of (json && json.results && json.results.bindings) || []) {
    const pid = String(b.p && b.p.value || '').split('/').pop();
    const label = (b.pLabel && b.pLabel.value) || pid;
    const v = valueText(b);
    if (!pid || !v || INTERNAL_PROP.test(label)) continue;
    const e = byProp.get(pid) || { prop: pid, label, aliases: String(b.aliases && b.aliases.value || ''), values: [] };
    if (!e.values.includes(v)) e.values.push(v);
    byProp.set(pid, e);
  }
  const qs = new Set(tokenize(query).map(stem));
  const scoreOf = (e) => {
    if (!qs.size) return 0;
    const names = [e.label, ...e.aliases.split('|')].filter(Boolean);
    return Math.max(0, ...names.map(n => { const ws = tokenize(n).map(stem); return ws.length ? ws.filter(w => qs.has(w)).length / ws.length : 0; }));
  };
  return [...byProp.values()].map(e => ({ ...e, score: Math.round(scoreOf(e) * 100) / 100 }))
    .sort((a, b) => b.score - a.score || Number(a.prop.slice(1)) - Number(b.prop.slice(1)))
    .map(({ aliases, ...e }) => ({ ...e, more: Math.max(0, e.values.length - perProp), values: e.values.slice(0, perProp) }));
}

/** SPARQL links → newest first, one row per item: [{ title, date, type, via, upcoming }]. `hub` when the item has
 *  so many links that the sample says nothing (a country). Undated ones last. */
export function parseLinks(json, { now = new Date(), k = 8 } = {}) {
  const rows = (json && json.results && json.results.bindings) || [];
  const today = now.toISOString().slice(0, 10);
  const byItem = new Map();
  for (const b of rows) {
    const id = b.x && b.x.value;
    const title = b.xLabel && b.xLabel.value;
    if (!id || !title || NO_LABEL(title) || INTERNAL_VALUE.test(title)) continue;
    const date = b.date && isDate(b.date.value) ? day(b.date.value) : '';
    const via = b.pLabel && b.pLabel.value;
    if (via && INTERNAL_PROP.test(via)) continue;
    const it = byItem.get(id) || { title, date: '', type: '', via: new Set() };
    if (date && (!it.date || date < it.date)) it.date = date;
    if (!it.type && b.type && !NO_LABEL(b.type.value)) it.type = b.type.value;
    if (via) it.via.add(via);
    byItem.set(id, it);
  }
  const list = [...byItem.values()].sort((a, b) => (b.date || '0000').localeCompare(a.date || '0000')).slice(0, k)
    .map(x => ({ title: x.title, date: x.date, type: x.type, via: [...x.via].join(', '), upcoming: Boolean(x.date && x.date > today) }));
  return { links: list, hub: rows.length >= LINKS_LIMIT };
}

// ── What the model reads ────────────────────────────────────────────────────

export function render({ main, lists = [], others = [], facts = [], links = [], qid = '' }, { now = new Date(), small = false, wrap = (s, t) => t } = {}) {
  if (!main) return '';
  const lines = [`Wikipedia: ${main.title}${main.description ? ` (${main.description})` : ''}`];
  if (main.extract) lines.push(truncate(main.extract.replace(/\s+/g, ' '), small ? 300 : 600));
  if (main.url) lines.push(main.url);
  if (facts.length) {
    lines.push('', `Wikidata ${qid} (most relevant to the question first):`);
    for (const f of facts.slice(0, small ? 14 : 40)) lines.push(`- ${f.label}: ${f.values.join('; ')}${f.more ? ` (+${f.more} more)` : ''}`);
    const rest = facts.length - (small ? 14 : 40);
    if (rest > 0) lines.push(`(${rest} more facts not shown)`);
  }
  if (links.length) {
    lines.push('', `Newest things that link to it on Wikidata (today is ${now.toISOString().slice(0, 10)}):`);
    for (const x of links.slice(0, small ? 6 : 8)) lines.push(`- ${x.title}${x.type ? ` (${x.type})` : ''}${x.date ? `, ${x.date}` : ', no date'}${x.upcoming ? ' (not out yet)' : ''}${x.via ? `: its ${x.via}` : ''}`);
  }
  if (lists.length) lines.push('', 'Lists on Wikipedia (fetch_url one for the whole list):', ...lists.map(l => `- ${l.title}: ${l.url}`));
  if (others.length) lines.push('', 'Other matches (if this is the wrong one, wiki_lookup one of these):', ...others.slice(0, small ? 2 : 3).map(o => `- ${o.title}${o.description ? ` (${o.description})` : ''}`));
  return wrap('wikipedia and wikidata', lines.join('\n'));
}

// ── The lookup ──────────────────────────────────────────────────────────────

/** Returns { text, main, qid, facts, links, lists } or { error }. `query`: a question, a name or a Q-id. */
export async function wikiLookup(query, { fetch: f = globalThis.fetch, now = new Date(), small = false, wrap } = {}) {
  const get = async (url, headers) => {
    const r = await f(url, headers ? { headers } : undefined);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  const ua = { 'Api-User-Agent': UA };
  const q = String(query || '').trim();
  let found;
  const qidAsked = (q.match(/^Q\d+$/i) || [])[0];
  if (qidAsked) {
    const id = qidAsked.toUpperCase();
    const e = ((await get(entityUrl(id), ua)).entities || {})[id];
    if (!e || e.missing !== undefined) return { error: `Wikidata has no item ${id}.` };
    const site = e.sitelinks && e.sitelinks.enwiki;
    found = { main: { title: (e.labels && e.labels.en && e.labels.en.value) || id, description: (e.descriptions && e.descriptions.en && e.descriptions.en.value) || '', extract: '', url: site ? site.url : `https://www.wikidata.org/wiki/${id}`, qid: id }, lists: [], others: [] };
  } else {
    const words = subjectWords(q);
    found = pickPages(await get(searchUrl(words), ua), words);
    // No article named in the question: search again with just its name part ("Emma stone birth year" → "Emma stone").
    const head = headWords(words);
    if (!found.matched && head && head !== words) {
      const again = pickPages(await get(searchUrl(head), ua).catch(() => null), words);
      if (again.main && (again.matched || !found.main)) found = { ...again, lists: [...again.lists, ...found.lists.filter(l => !again.lists.some(x => x.title === l.title))] };
    }
    if (!found.main) return { error: `Wikipedia has nothing for "${truncate(words, 80)}".` };
  }
  const { main } = found;
  let facts = [], links = [];
  if (main.qid) {
    const [fj, lj] = await Promise.all([get(sparqlUrl(factsQuery(main.qid))).catch(() => null), get(sparqlUrl(linksQuery(main.qid))).catch(() => null)]);
    facts = fj ? parseFacts(fj, { query: q }) : [];
    const l = lj ? parseLinks(lj, { now }) : { links: [], hub: false };
    links = l.hub ? [] : l.links;
  }
  const text = render({ ...found, facts, links, qid: main.qid || '' }, { now, small, wrap });
  return { text, main, qid: main.qid || '', facts, links, lists: found.lists };
}

export const wikiTool = defineTool({
  name: 'wiki_lookup',
  group: 'web',
  description: 'Look up facts about anyone or anything on Wikipedia and Wikidata: the article\'s opening, every fact Wikidata has (dates, people, places, numbers…; the ones matching your question first), and the newest things linked to it (a person\'s films, a company\'s products). Pass the question, a name, or a Wikidata id like Q42.',
  parameters: params({ query: str('The question, a name ("Jaws", "Zig programming language") or a Q-id') }, ['query']),
  async run({ query }, ctx = {}) {
    const q = String(query || '').trim();
    if (!q) return { model: { error: 'Give a question, a name or a Q-id.' } };
    let r;
    try { r = await wikiLookup(q, { fetch: ctx.fetch, small: Boolean(ctx.pageCards), wrap: wrapUntrusted }); } catch (e) { return { model: { error: `Wikipedia or Wikidata didn't answer (${e.message}). Try web_search.` } }; }
    if (r.error) return { model: { error: `${r.error} Try other words, or web_search.` }, label: `looked up "${truncate(q, 50)}" on Wikipedia (nothing)` };
    return {
      model: { found: r.text },
      label: `looked up "${r.main.title}" on Wikipedia and Wikidata${r.qid ? ` (${r.qid})` : ''}`,
      // Its links count as given (fetch_url's check), and later searches can find it.
      observation: { source: 'wikipedia', title: `${r.main.title} (${r.main.url})`, text: r.text.replace(/<\/?untrusted[^>]*>/g, '') },
      items: [r.main, ...r.lists].map(p => ({ title: p.title, url: p.url })),
    };
  },
});

// ── The model's own SPARQL (big models) ─────────────────────────────────────

const MAX_ROWS = 50;
/** SPARQL JSON → a compact table: one line per row, "var: value" pairs, entity URLs shortened to ids. */
export function renderRows(json, { max = MAX_ROWS } = {}) {
  const vars = (json && json.head && json.head.vars) || [];
  const rows = (json && json.results && json.results.bindings) || [];
  if (json && typeof json.boolean === 'boolean') return `ASK: ${json.boolean}`;
  if (!rows.length) return 'No rows.';
  const short = (v) => String(v).replace(/^http:\/\/www\.wikidata\.org\/entity\//, '').replace(/^(\d{4}-\d{2}-\d{2})T00:00:00Z$/, '$1');
  const lines = rows.slice(0, max).map(b => vars.filter(v => b[v]).map(v => `${v}: ${short(b[v].value)}`).join(' | '));
  return `${rows.length} row${rows.length === 1 ? '' : 's'}${rows.length > max ? ` (first ${max})` : ''}:\n${lines.join('\n')}`;
}

export const wikidataQuery = defineTool({
  name: 'wikidata_query',
  group: 'web',
  description: 'Run your own SPARQL on the Wikidata Query Service (wd:, wdt:, p:, ps:, pq:, wikibase:label are predefined). For questions wiki_lookup can\'t answer: lists, counts, comparisons, joins. Errors come back as the service wrote them, so you can fix the query.',
  parameters: params({ sparql: str('The SPARQL query') }, ['sparql']),
  async run({ sparql }, ctx = {}) {
    const q = String(sparql || '').trim();
    if (!q) return { model: { error: 'Give a SPARQL query.' } };
    const f = ctx.fetch || globalThis.fetch;
    let r;
    try { r = await f(sparqlUrl(q)); } catch (e) { return { model: { error: `The query service didn't answer (${e.message}).` } }; }
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      // The service's own message (a parse error says where), without its Java stack trace.
      const msg = body.split('\n').find(l => /Exception|Error|Encountered|Lexical|timeout/i.test(l)) || body.slice(0, 300);
      return { model: { error: `HTTP ${r.status}: ${truncate(msg.trim(), 600)}` }, label: `Wikidata query failed (HTTP ${r.status})` };
    }
    const json = await r.json();
    const text = renderRows(json);
    return { model: { result: wrapUntrusted('wikidata query', text) }, label: `ran a Wikidata query (${text.split('\n')[0]})` };
  },
});
