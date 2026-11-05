import test from 'node:test';
import assert from 'node:assert/strict';
import { subjectWords, headWords, titleInQuery, pickPages, parseFacts, parseLinks, render, wikiLookup, factsQuery, linksQuery, searchUrl, renderRows, wikidataQuery } from '../app/src/tools/wiki.js';

const NOW = new Date('2026-11-04T12:00:00Z');
const WD = 'http://www.wikidata.org/entity/';
const lit = (value) => ({ type: 'literal', value });
const uri = (value) => ({ type: 'uri', value });
const fact = (p, label, v, aliases = '') => ({ p: uri(WD + p), pLabel: lit(label), v: /^Q\d/.test(v) ? uri(WD + v) : lit(v), vLabel: lit(v), ...(aliases ? { aliases: lit(aliases) } : {}) });

// Shapes as the live APIs returned them (2026-11-04): formatversion=2 search, SPARQL JSON results.
const SEARCH = { query: { pages: [
  { title: 'List of Emma Stone performances', index: 2, fullurl: 'https://en.wikipedia.org/wiki/List_of_Emma_Stone_performances', pageprops: { wikibase_item: 'Q27468518' } },
  { title: 'Emma Stone', index: 1, description: 'American actress and film producer (born 1988)', extract: 'Emily Jean "Emma" Stone (born November 6, 1988) is an American actress.', fullurl: 'https://en.wikipedia.org/wiki/Emma_Stone', pageprops: { wikibase_item: 'Q147077' } },
  { title: "Emma D'Arcy", index: 3, description: 'English actor (born 1992)', pageprops: { wikibase_item: 'Q101232509' } },
  { title: 'Stone (disambiguation)', index: 4, pageprops: { disambiguation: '' } },
] } };
// The drink's own facts (the inventor is not the company's founder).
const COKE = { results: { bindings: [
  fact('P31', 'instance of', 'drink brand', 'is a|is an|has type'),
  fact('P17', 'country', 'United States', 'state|land'),
  fact('P61', 'discoverer or inventor', 'John Pemberton', 'developed by|devised by|discovered by|inventor|invented by|founder'),
  fact('P127', 'owned by', 'The Coca-Cola Company', 'owner|proprietor'),
  fact('P571', 'inception', '1886-05-08T00:00:00Z', 'created in year|created on|date founded|founded'),
  fact('P910', "topic's main category", 'Category:Coca-Cola'),
  fact('P373', 'Commons category', 'Coca-Cola'),
  fact('P1543', 'short name', 'Coke'), fact('P1543', 'short name', 'Coca'), fact('P1543', 'short name', 'Cola'), fact('P1543', 'short name', 'cola'),
  fact('P999', 'unlabelled', 'Q12345'),
] } };
const link = (id, title, date, via, type) => ({ x: uri(WD + id), xLabel: lit(title), ...(date ? { date: lit(date) } : {}), pLabel: lit(via), ...(type ? { type: lit(type) } : {}) });
const LINKS = { results: { bindings: [
  link('Q1', 'The Catch', '2027-05-21T00:00:00Z', 'cast member', 'film'),
  link('Q1', 'The Catch', '2027-05-21T00:00:00Z', 'producer', 'film'),
  link('Q2', 'Bugonia', '2025-08-28T00:00:00Z', 'cast member', 'film'),
  link('Q3', 'Poor Things', '2023-09-01T00:00:00Z', 'cast member', 'film'),
  link('Q4', 'Some award ceremony', null, 'nominee', null),
  link('Q5', 'Q5', '2024-01-01T00:00:00Z', 'cast member', 'film'),
  link('Q6', 'Category:Emma Stone', null, "category's main topic", null),
] } };

test('subjectWords drops asking, arithmetic and possessives; headWords is the name part', () => {
  assert.equal(subjectWords('What is Emma stones latest movie?'), 'Emma stones movie');
  assert.equal(subjectWords("what is Emma stone's birth year divided by 2?"), 'Emma stone birth year');
  assert.equal(subjectWords('when was zig created?'), 'zig created');
  assert.equal(subjectWords('founder of Coca-Cola?'), 'founder Coca-Cola');
  assert.equal(headWords('Emma stone birth year'), 'Emma stone');
  assert.equal(headWords('directed jaws'), 'directed jaws');
});

test('pickPages: the article named in the question wins; lists and others kept apart', () => {
  const r = pickPages(SEARCH, 'Emma stone birth year');
  assert.equal(r.main.title, 'Emma Stone'); assert.equal(r.matched, true);
  assert.deepEqual(r.lists.map(l => l.title), ['List of Emma Stone performances']);
  assert.deepEqual(r.others.map(o => o.title), ["Emma D'Arcy"]);
  assert.equal(titleInQuery('Jaws (film)', 'who directed jaws'), true);
  assert.equal(titleInQuery('Jaws 2', 'who directed jaws'), false, 'numbers count (the live search ranked Jaws 2 first)');
  assert.equal(titleInQuery('The Coca-Cola Company', 'founder of Coca-Cola company'), true);
  assert.equal(titleInQuery("Emma D'Arcy", 'Emma stone birth year'), false);
  assert.equal(pickPages({}).main, null);
});

test('parseFacts: every real fact, ranked by the question; bookkeeping, ids and unlabelled values dropped', () => {
  const founder = parseFacts(COKE, { query: 'founder of Coca-Cola?' });
  assert.equal(founder[0].label, 'discoverer or inventor', 'the "founder" alias');
  assert.deepEqual(founder[0].values, ['John Pemberton']);
  assert.ok(!founder.some(f => /category/i.test(f.label)), 'no Wikimedia bookkeeping');
  assert.ok(!founder.some(f => f.prop === 'P999'));
  const created = parseFacts(COKE, { query: 'when was Coca-Cola created?' });
  assert.equal(created[0].label, 'inception'); assert.deepEqual(created[0].values, ['1886-05-08']);
  const plain = parseFacts(COKE);
  assert.deepEqual(plain.map(f => f.prop), ['P17', 'P31', 'P61', 'P127', 'P571', 'P1543'], 'no question: lower property numbers first');
  const short = plain.find(f => f.prop === 'P1543');
  assert.equal(short.values.length, 3); assert.equal(short.more, 1);
});

test('parseLinks: newest first, one row per item, all its links; a hub (too many links) is flagged', () => {
  const { links, hub } = parseLinks(LINKS, { now: NOW });
  assert.equal(hub, false);
  assert.deepEqual(links.map(x => [x.title, x.date, x.upcoming]), [['The Catch', '2027-05-21', true], ['Bugonia', '2025-08-28', false], ['Poor Things', '2023-09-01', false], ['Some award ceremony', '', false]]);
  assert.equal(links[0].via, 'cast member, producer');
  const many = { results: { bindings: Array.from({ length: 500 }, (_, i) => link('Q' + (i + 10), 'Thing ' + i, null, 'country', null)) } };
  assert.equal(parseLinks(many).hub, true);
});

test('render: the article, ranked facts, newest links with today\'s date, lists, other matches', () => {
  const found = pickPages(SEARCH, 'Emma Stone');
  const text = render({ ...found, facts: parseFacts(COKE), links: parseLinks(LINKS, { now: NOW }).links, qid: 'Q147077' }, { now: NOW, small: true, wrap: (s, t) => `<w ${s}>${t}</w>` });
  assert.match(text, /^<w wikipedia and wikidata>Wikipedia: Emma Stone \(American actress and film producer \(born 1988\)\)\n/);
  assert.match(text, /\nWikidata Q147077 \(most relevant to the question first\):\n- country: United States\n/);
  assert.match(text, /Newest things that link to it on Wikidata \(today is 2026-11-04\):\n- The Catch \(film\), 2027-05-21 \(not out yet\): its cast member, producer\n- Bugonia \(film\), 2025-08-28: its cast member/);
  assert.match(text, /Lists on Wikipedia \(fetch_url one for the whole list\):\n- List of Emma Stone performances: https/);
  assert.match(text, /Other matches \(if this is the wrong one, wiki_lookup one of these\):\n- Emma D'Arcy \(English actor \(born 1992\)\)/);
  assert.equal(render({}), '');
});

const fakeFetch = (asked, { search = SEARCH, retry = null } = {}) => async (url, opts) => {
  asked.push({ url, headers: opts && opts.headers });
  const u = new URL(url);
  let body;
  if (u.hostname === 'en.wikipedia.org') body = asked.filter(a => /wikipedia/.test(a.url)).length > 1 && retry ? retry : search;
  else if (u.hostname === 'www.wikidata.org') body = { entities: { Q42: { labels: { en: { value: 'Douglas Adams' } }, descriptions: { en: { value: 'English writer' } }, sitelinks: { enwiki: { url: 'https://en.wikipedia.org/wiki/Douglas_Adams' } } } } };
  else body = /\?x \?dp/.test(u.searchParams.get('query')) ? LINKS : COKE;
  return { ok: true, status: 200, json: async () => body };
};

test('wikiLookup: one search when the article is named; the name part searched again when it isn\'t', async () => {
  let asked = [];
  const r = await wikiLookup('What is Emma stones latest movie?', { fetch: fakeFetch(asked), now: NOW });
  assert.equal(r.qid, 'Q147077');
  assert.equal(asked.filter(a => /wikipedia/.test(a.url)).length, 1);
  assert.ok(asked[0].headers['Api-User-Agent'].startsWith('Squiggle/'));
  assert.ok(!asked[1].headers, 'SPARQL gets no custom headers (no CORS preflight)');
  // The first search found only other people (as the live API did): the second, "Emma stone", finds her.
  asked = [];
  const noise = { query: { pages: [{ title: 'Emma Watson', index: 1, pageprops: { wikibase_item: 'Q39476' } }, { title: 'Israel', index: 2, pageprops: { wikibase_item: 'Q801' } }] } };
  const r2 = await wikiLookup("what is Emma stone's birth year divided by 2?", { fetch: fakeFetch(asked, { search: noise, retry: SEARCH }), now: NOW });
  const searches = asked.filter(a => /wikipedia/.test(a.url)).map(a => new URL(a.url).searchParams.get('gsrsearch'));
  assert.deepEqual(searches, ['Emma stone birth year', 'Emma stone']);
  assert.equal(r2.main.title, 'Emma Stone');
});

test('wikiLookup takes a Q-id straight to Wikidata', async () => {
  const asked = [];
  const r = await wikiLookup('Q42', { fetch: fakeFetch(asked), now: NOW });
  assert.equal(r.main.title, 'Douglas Adams');
  assert.equal(r.main.url, 'https://en.wikipedia.org/wiki/Douglas_Adams');
  assert.ok(!asked.some(a => /en\.wikipedia\.org/.test(a.url)), 'no Wikipedia search');
});

test('the queries: every non-id property with aliases; links from any property, capped', () => {
  assert.match(factsQuery('Q1'), /wd:Q1 \?d \?v/);
  assert.match(factsQuery('Q1'), /FILTER\(\?t NOT IN \(wikibase:ExternalId/);
  assert.match(factsQuery('Q1'), /skos:altLabel/);
  assert.match(linksQuery('Q1'), /\?x \?dp wd:Q1 \. \?p wikibase:directClaim \?dp \. \} LIMIT 500/);
  assert.match(searchUrl('a b'), /origin=\*/);
});

test('wikidata_query: rows as compact lines; the service\'s own error comes back', async () => {
  assert.equal(renderRows({ head: { vars: ['item', 'date'] }, results: { bindings: [{ item: uri(WD + 'Q2'), date: lit('2025-08-28T00:00:00Z') }] } }), '1 row:\nitem: Q2 | date: 2025-08-28');
  assert.equal(renderRows({ head: {}, boolean: true }), 'ASK: true');
  assert.equal(renderRows({ head: { vars: ['x'] }, results: { bindings: [] } }), 'No rows.');
  const bad = async () => ({ ok: false, status: 400, text: async () => 'SPARQL-QUERY: queryStr=...\njava.util.concurrent.ExecutionException: org.openrdf.query.MalformedQueryException: Encountered " "a" "a "" at line 3\n\tat java...' });
  const r = await wikidataQuery.run({ sparql: 'SELECT ?x WHERE { ?x a a }' }, { fetch: bad });
  assert.match(r.model.error, /^HTTP 400: java\.util\.concurrent\.ExecutionException: .*Encountered/);
  const good = async () => ({ ok: true, json: async () => ({ head: { vars: ['n'] }, results: { bindings: [{ n: lit('3') }] } }) });
  const ok = await wikidataQuery.run({ sparql: 'SELECT ...' }, { fetch: good });
  assert.match(ok.model.result, /1 row:\nn: 3/);
});
