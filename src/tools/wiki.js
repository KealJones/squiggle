// wiki_lookup: facts about a person, place, work or thing from Wikipedia and Wikidata, straight from the browser
// (both send CORS headers for origin=*). One Wikipedia search finds the article (it handles typos: "Emma stones"
// finds Emma Stone) and its Wikidata item; then two SPARQL queries get the item's key facts and the newest works
// it's credited on (films, albums, books…, by release date). The model only passes words: it doesn't need to know
// Wikidata ids or SPARQL (a 0.6B model doesn't; it would make them up).
//
// The pure parts (queries, parsing, rendering) are exported for tests; `ctx.fetch` replaces fetch.
import { wrapUntrusted } from '../untrusted.js';
import { truncate } from '../util.js';
import { defineTool, params, str } from './registry.js';

const WP = 'https://en.wikipedia.org/w/api.php';
const SPARQL = 'https://query.wikidata.org/sparql';
const UA = 'Squiggle/0.1 (https://github.com/KealJones/squiggle)';

// Properties worth showing, in this order (wdt: truthy values only, so the current population, not every census).
export const FACT_PROPS = [
  'P31', 'P279', 'P106', 'P569', 'P19', 'P570', 'P20', 'P27', 'P26', 'P22', 'P25', 'P40', 'P69', 'P108', 'P39', 'P102',
  'P571', 'P576', 'P112', 'P169', 'P159', 'P17', 'P131', 'P36', 'P35', 'P6', 'P1082', 'P2046', 'P577', 'P57', 'P58',
  'P161', 'P175', 'P50', 'P136', 'P495', 'P449', 'P2047', 'P1113', 'P54', 'P413', 'P800', 'P166', 'P856',
];
// How a work is credited to the subject, for "newest works".
export const WORK_RELS = { P161: 'cast member', P725: 'voice actor', P175: 'performer', P50: 'author', P57: 'director', P58: 'screenwriter', P162: 'producer', P86: 'composer', P170: 'creator' };

const MAX_PER_PROP = 4;

export function searchUrl(q, limit = 5) {
  const p = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', origin: '*', redirects: '1',
    generator: 'search', gsrsearch: q, gsrlimit: String(limit), gsrnamespace: '0',
    prop: 'pageprops|description|extracts|info', ppprop: 'wikibase_item|disambiguation', inprop: 'url',
    exintro: '1', explaintext: '1', exsentences: '3', exlimit: String(limit),
  });
  return `${WP}?${p}`;
}

export function factsQuery(qid) {
  return `SELECT ?p ?pLabel ?v ?vLabel WHERE {
  VALUES ?p { ${FACT_PROPS.map(p => 'wd:' + p).join(' ')} }
  ?p wikibase:directClaim ?d .
  wd:${qid} ?d ?v .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
}

export function worksQuery(qid) {
  return `SELECT ?work ?workLabel ?date ?rel ?typeLabel WHERE {
  VALUES ?rel { ${Object.keys(WORK_RELS).map(p => 'wdt:' + p).join(' ')} }
  ?work ?rel wd:${qid} .
  OPTIONAL { ?work wdt:P577 ?date . }
  OPTIONAL { ?work wdt:P31 ?type . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY DESC(?date) LIMIT 60`;
}

const sparqlUrl = (q) => `${SPARQL}?${new URLSearchParams({ query: q, format: 'json' })}`;

// Words that are about asking, not about the subject: dropped from the Wikipedia search.
const ASKING = new Set(('what whats who whos whose when where why how which is are was were do does did can could would should will ' +
  'the a an of in on at to for me my you your please tell show find look up search give know latest newest recent most last ' +
  'new current currently now today right about').split(' '));
/** The words of a question that name what it's about ("What is Emma stones latest movie?" → "Emma stones movie"). */
export function subjectWords(q) {
  const words = String(q || '').replace(/[?!.,;:"“”()]/g, ' ').split(/\s+/).filter(Boolean);
  const kept = words.filter(w => !ASKING.has(w.toLowerCase().replace(/['’]s$/, '')));
  return (kept.length ? kept : words).join(' ');
}

const isList = (title) => /^(list|lists) of\b|\b(filmography|discography|bibliography|videography|performances|awards and nominations)\b/i.test(title);

/** Wikipedia search result → { main, lists, others } (each { title, description, extract, url, qid }). */
export function pickPages(json) {
  const pages = ((json && json.query && json.query.pages) || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0))
    .map(p => ({ title: p.title, description: p.description || '', extract: p.extract || '', url: p.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(String(p.title).replace(/ /g, '_'))}`,
      qid: p.pageprops && p.pageprops.wikibase_item, disambiguation: Boolean(p.pageprops && 'disambiguation' in p.pageprops) }));
  const main = pages.find(p => !p.disambiguation && !isList(p.title)) || null;
  const lists = pages.filter(p => isList(p.title));
  const others = pages.filter(p => p !== main && !lists.includes(p) && !p.disambiguation).slice(0, 2);
  return { main, lists, others };
}

const isDate = (v) => /^[+-]?\d{4}-\d{2}-\d{2}T/.test(v);
const day = (v) => String(v).replace(/^\+/, '').slice(0, 10);
const valueText = (b) => {
  const raw = b.vLabel ? b.vLabel.value : b.v ? b.v.value : '';
  if (isDate(raw)) return day(raw);
  if (/^https?:\/\/www\.wikidata\.org\/entity\//.test(raw) || /^[QPL]\d+$/.test(raw)) return '';   // no English label (the label service gives the id)
  return raw;
};

/** SPARQL facts → [{ prop, label, values[] }] in FACT_PROPS order, values capped. */
export function parseFacts(json) {
  const byProp = new Map();
  for (const b of (json && json.results && json.results.bindings) || []) {
    const pid = String(b.p && b.p.value || '').split('/').pop();
    const v = valueText(b);
    if (!pid || !v) continue;
    const e = byProp.get(pid) || { prop: pid, label: (b.pLabel && b.pLabel.value) || pid, values: [] };
    if (!e.values.includes(v)) e.values.push(v);
    byProp.set(pid, e);
  }
  return FACT_PROPS.filter(p => byProp.has(p)).map(p => {
    const e = byProp.get(p);
    return { ...e, more: Math.max(0, e.values.length - MAX_PER_PROP), values: e.values.slice(0, MAX_PER_PROP) };
  });
}

/** SPARQL works → newest first, one row per work: [{ title, date, type, credit, upcoming }]. Undated works last. */
export function parseWorks(json, { now = new Date(), k = 8 } = {}) {
  const today = now.toISOString().slice(0, 10);
  const byWork = new Map();
  for (const b of (json && json.results && json.results.bindings) || []) {
    const id = b.work && b.work.value;
    const title = b.workLabel && b.workLabel.value;
    if (!id || !title || /^Q\d+$/.test(title)) continue;
    const date = b.date && isDate(b.date.value) ? day(b.date.value) : '';
    const rel = String(b.rel && b.rel.value || '').split('/').pop();
    const w = byWork.get(id) || { title, date: '', type: '', credits: new Set() };
    // A work released in several countries has several dates: the first release counts.
    if (date && (!w.date || date < w.date)) w.date = date;
    if (!w.type && b.typeLabel && !/^Q\d+$/.test(b.typeLabel.value)) w.type = b.typeLabel.value;
    if (WORK_RELS[rel]) w.credits.add(WORK_RELS[rel]);
    byWork.set(id, w);
  }
  return [...byWork.values()]
    .sort((a, b) => (b.date || '0000').localeCompare(a.date || '0000'))
    .slice(0, k)
    .map(w => ({ title: w.title, date: w.date, type: w.type, credit: [...w.credits].join(', '), upcoming: Boolean(w.date && w.date > today) }));
}

/** What the model reads. `wrap` marks it as outside content. */
export function render({ main, lists = [], others = [], facts = [], works = [], qid = '' }, { now = new Date(), small = false, wrap = (s, t) => t } = {}) {
  if (!main) return '';
  const lines = [`Wikipedia: ${main.title}${main.description ? ` (${main.description})` : ''}`];
  if (main.extract) lines.push(truncate(main.extract.replace(/\s+/g, ' '), small ? 300 : 600));
  lines.push(main.url);
  if (facts.length) {
    lines.push('', `Wikidata ${qid}:`);
    for (const f of facts.slice(0, small ? 12 : 30)) lines.push(`- ${f.label}: ${f.values.join('; ')}${f.more ? ` (+${f.more} more)` : ''}`);
  }
  if (works.length) {
    lines.push('', `Newest works on Wikidata (by release date; today is ${now.toISOString().slice(0, 10)}):`);
    for (const w of works.slice(0, small ? 6 : 8)) lines.push(`- ${w.title}${w.type ? ` (${w.type})` : ''}${w.date ? `, ${w.date}` : ', no date'}${w.upcoming ? ' (not out yet)' : ''}${w.credit ? `: ${w.credit}` : ''}`);
  }
  if (lists.length) lines.push('', 'Lists on Wikipedia (fetch_url one for the whole list):', ...lists.map(l => `- ${l.title}: ${l.url}`));
  if (others.length && !small) lines.push('', 'Other matches:', ...others.map(o => `- ${o.title}${o.description ? ` (${o.description})` : ''}: ${o.url}`));
  return wrap('wikipedia and wikidata', lines.join('\n'));
}

const WORKS_ASKED = /\b(movie|movies|film|films|show|shows|series|album|albums|song|songs|book|books|novel|novels|role|roles|work|works|filmography|discography|bibliography|played|starred|wrote|directed|released|latest|newest|recent|upcoming|next)\b/i;

/** The whole lookup. Returns { text, main, qid, facts, works, lists } or { error }. */
export async function wikiLookup(query, { fetch: f = globalThis.fetch, now = new Date(), small = false, wrap } = {}) {
  const get = async (url, headers) => {
    const r = await f(url, headers ? { headers } : undefined);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  const words = subjectWords(query);
  let found = pickPages(await get(searchUrl(words), { 'Api-User-Agent': UA }));
  if (!found.main) return { error: `Wikipedia has nothing for "${truncate(words, 80)}".` };
  const { main } = found;
  // A question about someone's works: look for their list or filmography article too.
  if (WORKS_ASKED.test(query) && !found.lists.length) {
    const more = pickPages(await get(searchUrl(`${main.title} filmography OR discography OR bibliography OR performances`, 3), { 'Api-User-Agent': UA }).catch(() => null));
    found = { ...found, lists: more.lists.filter(l => l.title.toLowerCase().includes(main.title.toLowerCase().split(' (')[0])) };
  }
  let facts = [], works = [];
  if (main.qid) {
    const [fj, wj] = await Promise.all([get(sparqlUrl(factsQuery(main.qid))).catch(() => null), get(sparqlUrl(worksQuery(main.qid))).catch(() => null)]);
    facts = fj ? parseFacts(fj) : [];
    works = wj ? parseWorks(wj, { now }) : [];
  }
  const text = render({ ...found, facts, works, qid: main.qid || '' }, { now, small, wrap });
  return { text, main, qid: main.qid || '', facts, works, lists: found.lists };
}

export const wikiTool = defineTool({
  name: 'wiki_lookup',
  group: 'web',
  description: 'Facts about a person, place, film, company or thing from Wikipedia and Wikidata: the article\'s opening, key facts (born, died, spouse, founded, population…) and their newest works by release date (films, albums, books). Pass the name, or the question.',
  parameters: params({ query: str('Who or what, e.g. "Emma Stone" or "Emma Stone latest movie"') }, ['query']),
  async run({ query }, ctx = {}) {
    const q = String(query || '').trim();
    if (!q) return { model: { error: 'Give a name or a question.' } };
    let r;
    try { r = await wikiLookup(q, { fetch: ctx.fetch, small: Boolean(ctx.pageCards), wrap: wrapUntrusted }); } catch (e) { return { model: { error: `Wikipedia or Wikidata didn't answer (${e.message}). Try web_search.` } }; }
    if (r.error) return { model: { error: `${r.error} Try web_search.` }, label: `looked up "${truncate(q, 50)}" on Wikipedia (nothing)` };
    return {
      model: { found: r.text },
      label: `looked up "${r.main.title}" on Wikipedia and Wikidata${r.qid ? ` (${r.qid})` : ''}`,
      // Its links count as given (fetch_url's check), and later searches can find it.
      observation: { source: 'wikipedia', title: `${r.main.title} (${r.main.url})`, text: r.text.replace(/<\/?untrusted[^>]*>/g, '') },
      items: [r.main, ...r.lists].map(p => ({ title: p.title, url: p.url })),
    };
  },
});
