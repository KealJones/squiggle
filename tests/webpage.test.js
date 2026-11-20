import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { pageCard, pageText } from '../app/src/webpage.js';
import { resolveAgentPath, agentPath } from '../app/src/guard.js';

const PAGE = [
  'Jump to content', 'Main menu', 'Search', 'Gemma 3',
  'Gemma 3 is a family of open models from Google, released in March 2025 in sizes from 270M to 27B parameters.',
  'The smallest model is meant for phones and other devices with little memory.',
  'Contents', 'Model details', 'The 270M model has 170M embedding parameters and 100M in its transformer blocks.',
  'Files', 'The Q4_0 GGUF of the 270M model is 242 MB.', 'License', 'Gemma terms of use.',
].join('\n');

test('pageCard: the opening skips menus; sections get their line numbers', () => {
  const c = pageCard(PAGE, ['Gemma 3', 'Model details', 'Files', 'License']);
  assert.equal(c.lines, 13);
  assert.match(c.opening, /^Gemma 3 is a family of open models/);
  assert.doesNotMatch(c.opening, /Jump to content|Main menu/);
  assert.equal(c.sections, '4 Gemma 3 · 8 Model details · 10 Files · 12 License');
});

const html = (body) => new DOMParser().parseFromString(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`, 'text/html');
const LONG = 'This sentence is long enough to count as real prose on the page, so the main landmark holds the content. ';

test('pageText: the main landmark is the content; banner, navigation, sidebars and footer are left out', () => {
  const doc = html(`
    <header><a href="/">Site</a><nav><ul><li><a href="/a">Movies</a></li><li><a href="/b">TV</a></li></ul></nav></header>
    <div role="banner">Subscribe banner</div>
    <main>
      <article>
        <header><h1>Olivia Rodrigo</h1><p>By Staff · Updated Apr 6, 2026</p></header>
        <p>${LONG}Rodrigo landed a starring role in High School Musical: The Musical: The Series at age 15.</p>
        <aside><h3>Trending</h3><p>Some other story</p></aside>
        <div role="complementary">Ad slot</div>
        <footer><p>Article footnote stays.</p></footer>
      </article>
    </main>
    <aside>Sidebar outside main</aside>
    <footer>© Site 2026 · Privacy</footer>`);
  const t = pageText(doc);
  assert.match(t, /Olivia Rodrigo/);
  assert.match(t, /By Staff · Updated Apr 6, 2026/, "an article's own header is not the page banner");
  assert.match(t, /at age 15\./);
  assert.match(t, /Article footnote stays\./, "an article's own footer is not the page footer");
  for (const junk of ['Movies', 'Subscribe banner', 'Trending', 'Ad slot', 'Sidebar outside main', 'Privacy']) assert.doesNotMatch(t, new RegExp(junk), junk);
});

test('pageText: without landmarks, a link-only list and its heading are left out; links with other text stay', () => {
  const doc = html(`<div class="page">
    <p>${LONG}</p>
    <h2>Other Famous Disney Stars</h2>
    <ul><li><a href="/z">Zac Efron</a></li><li><a href="/d">Demi Lovato</a></li><li><a href="/m">Miley Cyrus</a></li></ul>
    <h2>Albums</h2>
    <ul><li><a href="/s"><i>Sour</i></a> (2021)</li><li><a href="/g"><i>GUTS</i></a> (2023)</li><li><a href="/y">You Seem Pretty Sad for a Girl So in Love</a> (2026)</li></ul>
    <ul><li><a href="/1">Only</a></li><li><a href="/2">two</a></li></ul>
  </div>`);
  const t = pageText(doc);
  assert.doesNotMatch(t, /Zac Efron|Demi Lovato|Other Famous Disney Stars/);
  assert.match(t, /Albums\n+Sour \(2021\)\n+GUTS \(2023\)/, 'a list that says something besides its links is content');
  assert.match(t, /Only\n+two/, 'two links are not a link list');
});

test('pageText: a main landmark with hardly any of the text is not taken as the content', () => {
  const doc = html(`<main><p>Hero</p></main><div><p>${LONG.repeat(5)}</p></div>`);
  const t = pageText(doc);
  assert.match(t, /^Hero/);
  assert.match(t, /real prose/);
});

test('pageText: a landmark wrapped around the content is kept, whatever its role', () => {
  const doc = html(`<div role="complementary"><article><p>${LONG}</p></article><article><p>Second post.</p></article></div>`);
  const t = pageText(doc);
  assert.match(t, /real prose/);
  assert.match(t, /Second post\./);
});

test('/web/ paths resolve to the in-memory web area', () => {
  const r = resolveAgentPath('/web/3.txt');
  assert.deepEqual(r, { area: 'web', rel: '3.txt' });
  assert.equal(agentPath(r), '/web/3.txt');
  assert.throws(() => resolveAgentPath('/web/../../etc'), /escapes/);
});
