// Regression tests for docs/failures.md: each test is named after the case it guards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rankTools } from '../app/src/find.js';

// web.js opens IndexedDB (through util.js kv) on import; a stub that never answers keeps node quiet.
globalThis.indexedDB = globalThis.indexedDB || { open: () => ({}) };
const { withYear, fetchUrl } = await import('../app/src/tools/web.js');

test('case 2 (Poor Things as the latest movie): "latest" searches carry the current year', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  assert.equal(withYear('Emma Stones latest movie', now), 'Emma Stones latest movie 2026');
  assert.equal(withYear('newest album by Taylor Swift', now), 'newest album by Taylor Swift 2026');
  assert.equal(withYear('latest movie 2019', now), 'latest movie 2019', 'a year already given stays');
  assert.equal(withYear('who directed Jaws', now), 'who directed Jaws');
});

test('case 4 (made-up URLs): a 404 is an error, not a page read', async () => {
  const realFetch = globalThis.fetch, realParser = globalThis.DOMParser;
  globalThis.fetch = async () => ({ status: 404, headers: { get: () => 'text/plain' }, text: async () => 'Not Found' });
  try {
    const r = await fetchUrl.run({ url: 'https://example.com/movies/bugonia/2025' }, {});
    assert.match(r.model.error, /returned HTTP 404 \(no such page\)\. Don't use it as a source/);
    assert.match(r.label, /couldn't read .* \(HTTP 404\)/);
    const r2 = await fetchUrl.run({ url: 'https://www.bugonia.com/confirmation' }, { allowUrl: () => false });
    assert.match(r2.model.error, /didn't come from a search result, a page you read or the user, so it was not opened/);
  } finally { globalThis.fetch = realFetch; globalThis.DOMParser = realParser; }
});

test('case 6 ("recent" matched git_log): a movie question clearly matches no non-lookup tool', () => {
  const tools = JSON.parse(readFileSync(new URL('./fixtures/tool-specs.json', import.meta.url), 'utf8'));
  for (const q of ['Awesome, what about his most recent released movie?', 'most recent released movie Patrick Stewart']) {
    const strong = rankTools(q, tools).filter(t => !['web_search', 'fetch_url', 'wiki_lookup'].includes(t.name) && t.score > 4);
    assert.deepEqual(strong.map(t => t.name), [], q);
  }
});

test('case 9 (other chats read as the user): other chats are off by default', () => {
  // agent.js needs the browser to import; its default and settings.js's one-time move are pinned by their source.
  const src = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
  assert.match(src('../app/src/agent.js'), /^\s*recallChats: false,/m);
  assert.match(src('../app/src/ui/settings.js'), /if \(!saved\.noChatRecall\) \{\n\s*agent\.settings\.recallChats = false;/);
});
