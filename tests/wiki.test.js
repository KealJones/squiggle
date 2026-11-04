import test from 'node:test';
import assert from 'node:assert/strict';
import { subjectWords, pickPages, parseFacts, parseWorks, render, wikiLookup, factsQuery, worksQuery, searchUrl } from '../app/src/tools/wiki.js';

const NOW = new Date('2026-11-04T12:00:00Z');
const WD = 'http://www.wikidata.org/entity/';
const lit = (value) => ({ type: 'literal', value });
const uri = (value) => ({ type: 'uri', value });

// What the APIs return (formatversion=2 search; SPARQL JSON results).
const SEARCH = { query: { pages: [
  { pageid: 2, title: 'List of Emma Stone performances', index: 2, description: 'none', fullurl: 'https://en.wikipedia.org/wiki/List_of_Emma_Stone_performances', pageprops: { wikibase_item: 'Q100' } },
  { pageid: 1, title: 'Emma Stone', index: 1, description: 'American actress (born 1988)', extract: 'Emily Jean "Emma" Stone (born November 6, 1988) is an American actress.', fullurl: 'https://en.wikipedia.org/wiki/Emma_Stone', pageprops: { wikibase_item: 'Q147077' } },
  { pageid: 3, title: 'Stone (disambiguation)', index: 3, pageprops: { disambiguation: '' } },
  { pageid: 4, title: 'Bugonia', index: 4, description: '2025 film by Yorgos Lanthimos', fullurl: 'https://en.wikipedia.org/wiki/Bugonia', pageprops: { wikibase_item: 'Q200' } },
] } };
const FACTS = { results: { bindings: [
  { p: uri(WD + 'P31'), pLabel: lit('instance of'), v: uri(WD + 'Q5'), vLabel: lit('human') },
  { p: uri(WD + 'P569'), pLabel: lit('date of birth'), v: lit('1988-11-06T00:00:00Z'), vLabel: lit('1988-11-06T00:00:00Z') },
  { p: uri(WD + 'P106'), pLabel: lit('occupation'), v: uri(WD + 'Q33999'), vLabel: lit('actor') },
  { p: uri(WD + 'P106'), pLabel: lit('occupation'), v: uri(WD + 'Q2'), vLabel: lit('film producer') },
  { p: uri(WD + 'P166'), pLabel: lit('award received'), v: uri(WD + 'Q9'), vLabel: lit('Q9') },
  ...['a', 'b', 'c', 'd', 'e', 'f'].map(x => ({ p: uri(WD + 'P166'), pLabel: lit('award received'), v: uri(WD + 'Q' + x), vLabel: lit('Award ' + x) })),
] } };
const work = (id, title, date, rel = 'P161', type = 'film') => ({ work: uri(WD + id), workLabel: lit(title), ...(date ? { date: lit(date) } : {}), rel: uri('http://www.wikidata.org/prop/direct/' + rel), typeLabel: lit(type) });
const WORKS = { results: { bindings: [
  work('Q300', 'Next Big Thing', '2027-03-01T00:00:00Z'),
  work('Q200', 'Bugonia', '2025-10-31T00:00:00Z'),
  work('Q200', 'Bugonia', '2025-10-24T00:00:00Z'),
  work('Q200', 'Bugonia', '2025-10-24T00:00:00Z', 'P162'),
  work('Q201', 'Kinds of Kindness', '2024-06-21T00:00:00Z'),
  work('Q202', 'Poor Things', '2023-12-08T00:00:00Z'),
  work('Q203', 'Untitled project', null),
  work('Q204', 'Q204', '2022-01-01T00:00:00Z'),
] } };

test('subjectWords keeps what the question is about', () => {
  assert.equal(subjectWords('What is Emma stones latest movie?'), 'Emma stones movie');
  assert.equal(subjectWords("What's Patrick Stewart's most recent released movie?"), 'Patrick Stewart\'s released movie');
  assert.equal(subjectWords('Phoenix'), 'Phoenix');
});

test('pickPages: the main article is the best non-list, non-disambiguation match; lists are kept apart', () => {
  const r = pickPages(SEARCH);
  assert.equal(r.main.title, 'Emma Stone');
  assert.equal(r.main.qid, 'Q147077');
  assert.deepEqual(r.lists.map(l => l.title), ['List of Emma Stone performances']);
  assert.deepEqual(r.others.map(o => o.title), ['Bugonia']);
  assert.equal(pickPages({}).main, null);
});

test('parseFacts: labelled, in a fixed order, dates as days, unlabelled values dropped, long lists capped', () => {
  const f = parseFacts(FACTS);
  assert.deepEqual(f.map(x => x.label), ['instance of', 'occupation', 'date of birth', 'award received']);
  assert.deepEqual(f.find(x => x.prop === 'P569').values, ['1988-11-06']);
  assert.deepEqual(f.find(x => x.prop === 'P106').values, ['actor', 'film producer']);
  const awards = f.find(x => x.prop === 'P166');
  assert.equal(awards.values.length, 4); assert.equal(awards.more, 2);
  assert.ok(!awards.values.includes('Q9'));
});

test('parseWorks: newest first, one row per work at its first release, credits merged, upcoming marked', () => {
  const w = parseWorks(WORKS, { now: NOW });
  assert.deepEqual(w.map(x => [x.title, x.date, x.upcoming]), [
    ['Next Big Thing', '2027-03-01', true], ['Bugonia', '2025-10-24', false], ['Kinds of Kindness', '2024-06-21', false],
    ['Poor Things', '2023-12-08', false], ['Untitled project', '', false]]);
  assert.equal(w[1].credit, 'cast member, producer');
});

test('render: article, facts, newest works with today\'s date, lists to fetch', () => {
  const found = pickPages(SEARCH);
  const text = render({ ...found, facts: parseFacts(FACTS), works: parseWorks(WORKS, { now: NOW }), qid: 'Q147077' }, { now: NOW, wrap: (s, t) => `<w ${s}>${t}</w>` });
  assert.match(text, /^<w wikipedia and wikidata>Wikipedia: Emma Stone \(American actress \(born 1988\)\)\n/);
  assert.match(text, /\nhttps:\/\/en\.wikipedia\.org\/wiki\/Emma_Stone\n/);
  assert.match(text, /\nWikidata Q147077:\n- instance of: human\n- occupation: actor; film producer\n- date of birth: 1988-11-06\n- award received: .* \(\+2 more\)/);
  assert.match(text, /Newest works on Wikidata \(by release date; today is 2026-11-04\):\n- Next Big Thing \(film\), 2027-03-01 \(not out yet\): cast member\n- Bugonia \(film\), 2025-10-24: cast member, producer/);
  assert.match(text, /Lists on Wikipedia \(fetch_url one for the whole list\):\n- List of Emma Stone performances: https:\/\/en\.wikipedia\.org\/wiki\/List_of_Emma_Stone_performances/);
  assert.equal(render({}), '');
});

test('wikiLookup: one search, then the two Wikidata queries for its item', async () => {
  const asked = [];
  const fakeFetch = async (url, opts) => {
    asked.push({ url, headers: opts && opts.headers });
    const u = new URL(url);
    const body = u.hostname === 'en.wikipedia.org' ? SEARCH
      : /\?work/.test(u.searchParams.get('query')) ? WORKS : FACTS;
    return { ok: true, status: 200, json: async () => body };
  };
  const r = await wikiLookup('What is Emma stones latest movie?', { fetch: fakeFetch, now: NOW });
  assert.equal(r.qid, 'Q147077');
  assert.equal(asked.length, 3, 'the list article was in the first search, so no second one');
  assert.equal(new URL(asked[0].url).searchParams.get('gsrsearch'), 'Emma stones movie');
  assert.ok(asked[0].headers['Api-User-Agent'].startsWith('Squiggle/'));
  assert.ok(!asked[1].headers, 'SPARQL gets no custom headers (no CORS preflight)');
  assert.match(r.text, /Bugonia \(film\), 2025-10-24/);
  const none = await wikiLookup('zzzz', { fetch: async () => ({ ok: true, json: async () => ({}) }) });
  assert.match(none.error, /Wikipedia has nothing for "zzzz"/);
});

test('the queries name the item and the properties', () => {
  assert.match(factsQuery('Q1'), /wd:Q1 \?d \?v/);
  assert.match(factsQuery('Q1'), /wd:P569/);
  assert.match(worksQuery('Q1'), /\?work \?rel wd:Q1/);
  assert.match(worksQuery('Q1'), /wdt:P161/);
  assert.match(searchUrl('a b'), /origin=\*/);
});
