import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { find, renderFind, rankTools, snippet, NOTHING, BARS } from '../app/src/find.js';
import { findTools } from '../app/src/engine-wllama.js';
import * as R from '../app/src/recipes.js';

// The real tool specs (extracted from app/src/tools.js).
const TOOLS = JSON.parse(readFileSync(new URL('./fixtures/tool-specs.json', import.meta.url), 'utf8'));
const wrapped = TOOLS.map(function_ => ({ type: 'function', function: function_ }));

const top = (q, tools = TOOLS) => rankTools(q, tools).map(t => t.name);

// ── tool ranking ─────────────────────────────────────────────────────────

const CASES = [
  // [what a person (or the model) might type, the tool they need]
  ['google the latest wrangler release notes', 'web_search'],
  ['look up how to kill a process on a port', 'web_search'],
  ['i need to search the web for something', 'web_search'],
  ['open app/src/memory.js and show me it', 'read_file'],
  ['show me what is in the readme file', 'read_file'],
  ['read this link https://developers.cloudflare.com/workers/', 'fetch_url'],
  ['open that page and summarize it', 'fetch_url'],
  ['save this to a file called notes.md', 'write_file'],
  ['change the wave function in main.js to slither', 'edit_file'],
  ['restore main.js to before that commit', 'git_show'],
  ['remember that I prefer pushing straight to main', 'remember'],
  ['commit my changes', 'git_commit'],
  ['push the branch to github', 'git_push'],
  ['make a new branch for this', 'git_branch'],
  ['what changed in the repo', 'git_status'],
  ['clone KealJones/squiggle', 'git_clone'],
  ['open a pull request', 'github_open_pr'],
  ['where is runTurn defined', 'grep'],
  ['what files are in the docs folder', 'list_files'],
  ['what did we talk about yesterday regarding tokenizers', 'search_history'],
  ['delete the old notes file', 'delete_file'],
  ['calculate 17 percent of 2340', 'calculate'],
  ['how much is 3 tacos at 3.50 each', 'calculate'],
  ['what do you know about my son', 'recall'],
  ['uhh so like can you kinda grab that github thing and pull it down', 'git_clone'],
  ['jot this down for later', 'note'],
  ['forget that, it is wrong', 'forget'],
  ['git push', 'git_push'],
  ['yo can u google if wllama supports webgpu yet', 'web_search'],
];

test('the right tool ranks first for everyday requests', () => {
  for (const [q, want] of CASES) assert.equal(top(q)[0], want, q);
});

test('find ranks tools better than the old word-overlap findTools', () => {
  let now = 0, before = 0;
  for (const [q, want] of CASES) {
    if (top(q)[0] === want) now++;
    const old = findTools(TOOLS, q, 3);
    if (old[0] && old[0].name === want) before++;
  }
  assert.equal(now, CASES.length);
  assert.ok(before <= CASES.length - 10, `old ranking got ${before}/${CASES.length} first place`);
});

test('chit-chat and general knowledge questions match no tool', () => {
  for (const q of ['hey whats up lol', 'thanks that was great', 'what is the capital of france', 'tell me a joke', 'lol', '', 'umm uh yeah']) {
    assert.deepEqual(top(q), [], q);
  }
});

test('tool ranking accepts both spec shapes and skips the harness tools', () => {
  assert.deepEqual(top('commit my changes', wrapped)[0], 'git_commit');
  const harness = [
    { name: 'plan', description: 'Start a plan for the task.', parameters: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] } },
    { name: 'find', description: 'Search tools, recipes, memory and chats.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    ...TOOLS,
  ];
  assert.ok(!top('make a plan and find what we need', harness).includes('plan'));
  assert.ok(!top('search everything', harness).includes('find'));
});

test('tool results carry name, arguments, a one-line description and a score', () => {
  const [t] = rankTools('push the branch to github', TOOLS);
  assert.equal(t.name, 'git_push');
  assert.deepEqual(t.args.map(a => a.name), ['repo']);
  assert.equal(t.args[0].required, true);
  assert.ok(!t.description.includes('\n'));
  assert.ok(t.description.length <= 140);
  assert.ok(t.score >= BARS.tool);
  assert.equal(t.spec.name, 'git_push');
});

test('k limits the tools and a missing tools list is fine', () => {
  assert.ok(rankTools('git push the branch and open a pull request', TOOLS, { k: 2 }).length <= 2);
  assert.deepEqual(rankTools('git push', null), []);
  assert.deepEqual(rankTools('git push', []), []);
});

test('file names and URLs in a request do not leak noise words into the ranking', () => {
  // "js" and "md" are not words the user cares about; "run_js" must not win for a .js file.
  assert.equal(top('open tools.js')[0], 'read_file');
  assert.notEqual(top('read the notes.md file please')[0], 'note');
  assert.equal(top('https://github.com/KealJones/squiggle/pull/3 what does it say')[0], 'fetch_url');
});

// ── find over several sources ────────────────────────────────────────────

const fact = (s, p, o, note) => ({ id: 'f_' + s + p, s, p, o, note });
const FACTS = [
  { fact: fact('Keal', 'prefers', 'pushing straight to main when he says it is chill'), score: 1 },
  { fact: fact('squiggle', 'stores sessions in', 'a private GitHub repo'), score: 0.62 },
  { fact: fact('Keal', 'has a son', 'Dash'), score: 0.18 },
];
const HISTORY = [
  { session: 's_1', title: 'Tokenizer zoo ideas', ts: Date.UTC(2026, 9, 12, 15), score: 7.1,
    text: 'okay so the idea is a zoo of weird tokenizers, byte pair, unigram, and one that splits on vowels, and then we train the same tiny model on each and compare loss curves on the same data' },
  { session: 's_1', title: 'Tokenizer zoo ideas', ts: Date.UTC(2026, 9, 12, 16), score: 2.0, text: 'sounds good, the tokenizer comparison is a good first experiment' },
  { session: 's_2', title: 'iPhone crash', ts: Date.UTC(2026, 9, 3, 9), score: 3.3, text: 'safari killed the tab when the model loaded, probably memory' },
  { session: 's_3', title: 'Lunch', ts: Date.UTC(2026, 9, 1, 9), score: 0.4, text: 'what should i make tonight' },
];
const TASK = [
  { id: 'o1', source: 'step 1', text: 'Found the login form in app/src/main.js at line 412, setup wizard step 3' },
  { id: 'o2', source: 'step 2', text: 'The relay URL is stored in config.json under "relay"' },
  { id: 'o3', source: 'tool output', text: 'Directory listing: README.md docs/ app/ worker/ tests/' },
];

function sources(extra = {}) {
  return {
    tools: TOOLS,
    recipes: { match: async () => [] },
    recall: async () => FACTS,
    searchHistory: async () => HISTORY,
    taskItems: TASK,
    ...extra,
  };
}

test('find returns every kind, labelled by kind, with an empty result for the ones that miss', async () => {
  const r = await find('push the tokenizer zoo branch to github', sources());
  assert.deepEqual(Object.keys(r), ['tools', 'recipes', 'facts', 'chats', 'task']);
  assert.equal(r.tools[0].name, 'git_push');
  assert.deepEqual(r.recipes, []);
  assert.ok(r.chats.length >= 1);
  assert.equal(r.chats[0].title, 'Tokenizer zoo ideas');
});

test('facts below the bar are dropped', async () => {
  const r = await find('where does squiggle keep sessions', sources());
  assert.deepEqual(r.facts.map(f => f.text), [
    'Keal prefers pushing straight to main when he says it is chill',
    'squiggle stores sessions in a private GitHub repo',
  ]);
  assert.ok(r.facts.every(f => f.score >= BARS.fact));
});

test('chat results need the query words, come one per chat, with a snippet around the match', async () => {
  const r = await find('that weird tokenizers idea with vowels', sources());
  assert.equal(r.chats.length, 1);
  const c = r.chats[0];
  assert.equal(c.session, 's_1');
  assert.match(c.text, /vowels/);
  assert.ok(c.text.length <= 175);
  assert.ok(!r.chats.some(x => x.session === 's_3'));
});

test('a history hit that shares no words with the query is dropped even if the source scored it', async () => {
  const r = await find('relay url config', sources());
  assert.deepEqual(r.chats, []);
});

test('task items match on their words, best first', async () => {
  const r = await find('where was the login form', sources());
  assert.deepEqual(r.task.map(t => t.id), ['o1']);
  const r2 = await find('relay config', sources());
  assert.deepEqual(r2.task.map(t => t.id), ['o2']);
  const none = await find('banana bread recipe', sources());
  assert.deepEqual(none.task, []);
});

test('one-word queries need one matching word, longer ones need two', async () => {
  const one = await find('relay', sources());
  assert.deepEqual(one.task.map(t => t.id), ['o2']);
  const many = await find('relay is somewhere in the main login screen code', sources());
  // two of its words are in the login-form item; "relay" alone is not enough once the query has several words
  assert.deepEqual(many.task.map(t => t.id), ['o1']);
  const strict = await find('where did the relay get stored for the sessions list', sources({ taskItems: [{ id: 'x', source: 'step 1', text: 'The relay was down' }] }));
  assert.deepEqual(strict.task, []);
});

test('a source may be missing, throw, or return junk', async () => {
  const r = await find('push the branch to github', { tools: TOOLS });
  assert.equal(r.tools[0].name, 'git_push');
  assert.deepEqual([r.recipes, r.facts, r.chats, r.task], [[], [], [], []]);

  const bad = await find('push the branch', {
    recipes: { match: () => { throw new Error('boom'); } },
    recall: async () => { throw new Error('boom'); },
    searchHistory: async () => [null, {}, { text: null }],
    taskItems: [null, {}, { text: '' }],
  });
  assert.deepEqual(bad, { tools: [], recipes: [], facts: [], chats: [], task: [] });

  assert.deepEqual(await find('', sources()), { tools: [], recipes: [], facts: [], chats: [], task: [] });
  assert.deepEqual(await find('x', undefined), { tools: [], recipes: [], facts: [], chats: [], task: [] });
});

test('recipes come from the recipes module and keep their scores', async () => {
  R._reset();
  const files = {};
  R.setStore({ read: async (p) => files[p] ?? null, write: async (p, c) => { files[p] = c; }, sync() {} });
  R.save({
    title: 'Kill whatever is listening on a port',
    when: 'Free up a port by stopping the process that is listening on it',
    examples: ['kill 8080'],
    steps: ['Find the PID with lsof -i :<port>', 'Kill the process', 'Check the port is free'],
    specifics: ['<port> = 8080'],
  });
  R.save({ title: 'Summarise a web page', when: 'Read a web page and tell me what it says', steps: ['Fetch the page', 'Summarise it'] });
  const r = await find('kill whatever is listening on port 3000', sources({ recipes: R }));
  assert.equal(r.recipes.length, 1);
  assert.equal(r.recipes[0].recipe.title, 'Kill whatever is listening on a port');
  assert.ok(r.recipes[0].score >= BARS.recipe);
  R._reset();
});

test('recipes the source scored under the bar are dropped', async () => {
  const weak = { recipe: { title: 'x', steps: ['y'] }, score: 0.1 };
  const strong = { recipe: { title: 'z', steps: ['w'] }, score: 0.8 };
  const r = await find('anything', { recipes: { match: async () => [weak, strong] } });
  assert.deepEqual(r.recipes, [strong]);
});

test('k caps each kind', async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ fact: fact('Keal', 'likes', `ramen number ${i}`), score: 0.9 }));
  const r = await find('ramen', sources({ recall: async () => many }), { k: 2 });
  assert.equal(r.facts.length, 2);
});

// ── snippet ──────────────────────────────────────────────────────────────

test('snippet centres on the densest cluster of query words', () => {
  const text = 'Lots of boring words about nothing at all. '.repeat(10) + 'Then the relay worker routes device flow login requests to GitHub. ' + 'More filler that goes on. '.repeat(10);
  const s = snippet(text, ['relay', 'worker', 'login']);
  assert.match(s, /relay worker routes device flow login/);
  assert.ok(s.startsWith('…') && s.endsWith('…'));
  assert.ok(s.length <= 175);
  assert.equal(snippet('short text', ['short']), 'short text');
  assert.equal(snippet('', ['x']), '');
});

// ── renderFind ───────────────────────────────────────────────────────────

test('renderFind writes a compact block a small model can use', async () => {
  const r = await find('push the tokenizer zoo branch to github', sources({
    recipes: { match: async () => [{ score: 0.8, recipe: {
      title: 'Push a branch to GitHub',
      steps: ['Check git status', 'Commit the changes', 'Push the branch'],
      specifics: ['<repo> = KealJones/squiggle', '<branch> = agent/readme-link'],
    } }] },
    recall: async () => [{ fact: fact('Keal', 'prefers', 'pushing straight to main when he says it is chill'), score: 1 }],
  }));
  const out = renderFind(r);
  assert.match(out, /^Tools:\n- git_push\(repo\): Push the current branch to GitHub \(never forced\)\./);
  assert.match(out, /\nRecipes from similar tasks:\n\* Push a branch to GitHub\n  1\. Check git status\n  2\. Commit the changes\n  3\. Push the branch\n  Specifics: <repo> = KealJones\/squiggle; <branch> = agent\/readme-link\n/);
  assert.match(out, /\nMemory:\n- Keal prefers pushing straight to main when he says it is chill\n/);
  assert.match(out, /\nPast chats:\n- \(2026-10-12, Tokenizer zoo ideas\) .*tokenizers/);
  assert.ok(out.length < 1800, `rendered ${out.length} characters`);
});

test('renderFind shows optional arguments with a question mark', () => {
  const out = renderFind({ tools: rankTools('google something', TOOLS, { k: 1 }) });
  assert.match(out, /^Tools:\n- web_search\(query, count\?\): Search the web \(DuckDuckGo\)\./);
});

test('renderFind labels task items and says when nothing matched', async () => {
  const out = renderFind({ task: [{ id: 'o1', source: 'step 1', text: 'Found the login form in app/src/main.js' }, { id: 'o3', source: 'tool output', text: 'listing' }, { id: 'o4', source: 'note', text: 'x' }] });
  assert.equal(out, 'This task:\n- (earlier step) Found the login form in app/src/main.js\n- (earlier tool output) listing\n- (note) x');
  assert.equal(renderFind({ tools: [], recipes: [], facts: [], chats: [], task: [] }), NOTHING);
  assert.equal(renderFind(undefined), NOTHING);
  assert.match(NOTHING, /^Nothing found\./);
});

test('renderFind handles a chat without a date or title and trims long lines', () => {
  const out = renderFind({ chats: [{ title: '', text: 'x'.repeat(500) }, { title: 'A', ts: 0, text: 'y' }] });
  const lines = out.split('\n');
  assert.equal(lines[1].startsWith('- (earlier chat) '), true);
  assert.ok(lines[1].length < 230);
  assert.equal(lines[2], '- (A) y');
});
