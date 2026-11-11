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

test('case 15 (plan mode couldn\'t ask the user): a question asks, ask_user exists, harness text stays out of the user turn', async () => {
  const t = await import('../app/src/tasks.js');
  // A step that ends on a question pauses the task instead of becoming its result.
  for (const q of ['Could you please provide the repository name and whether it should be public or private?',
    'I can create it. What should the repository be called?', 'Please tell me which branch to use.',
    'I need the repository name and visibility to proceed.', 'Let me know the name you want for the repo.']) assert.ok(t.asksUser(q), q);
  for (const r of ['Created kealjones/gizmo (private).', 'Found 3 files. Is that all of them? Yes, it is.', 'The README asks: what is X?\nDone: copied it.',
    '<tool_call>{"name":"ask","arguments":{}}</tool_call>', '']) assert.ok(!t.asksUser(r), r);
  // ask_user for v3 models; need stays for Squiggle Small (frozen).
  assert.deepEqual(t.HARNESS_SPECS.ask_user.parameters.required, ['question']);
  assert.deepEqual(t.HARNESS_SPECS.need.parameters.required, ['what']);
  assert.ok(t.HARNESS.has('ask_user') && t.HARNESS.has('need'));
  const src = readFileSync(new URL('../app/src/agent.js', import.meta.url), 'utf8');
  assert.match(src, /const askName = \(\) => \(dialect\(\)\.frozen \? 'need' : 'ask_user'\);/);
  assert.match(src, /tasks\.asksUser\(text\)\) \{[^]*?return this\.ask\(text, task\);[^]*?tasks\.finishStep\(task, text\)/, 'the question check comes before filing text as the result');
  // v3: the step and final user turns are the user's words; the goal is labelled as the model's own summary.
  const task = t.newTask({ request: 'make me a new repo for the site', goal: 'Create a new repository for the user', steps: ['Ask for the name', 'Create it'] });
  t.startStep(task);
  assert.equal(t.stepUser(task, { dialect: t.DIALECT.v3 }), 'make me a new repo for the site');
  assert.equal(t.finalUser(task, { dialect: t.DIALECT.v3 }), 'make me a new repo for the site');
  assert.match(t.stepPrompt('B', task, [], { dialect: t.DIALECT.v3, now: t.stepNow(task, { dialect: t.DIALECT.v3 }) }).text,
    /## Goal \(your own one-line summary of what the user asked\)\nCreate a new repository for the user\n[^]*## Now\nWork on step 1 now: Ask for the name$/m);
});
