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

test('case 19 (plan mode couldn\'t ask the user): a question asks, ask_user exists, harness text stays out of the user turn', async () => {
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

test('case 20 ("you don\'t have a bubbles repo"): gh repo list shows every repo newest first, the prompt says gh is signed in, find names real tools', async () => {
  const { runGh } = await import('../app/src/tools/ghcli.js');
  const { nothingFor, NOTHING } = await import('../app/src/find.js');
  // 40 old repos (lowest ids, listed first by the App's endpoint) and the new one last, as GitHub returns them.
  const mk = (name, pushed, priv = false) => ({ name, full_name: `KealJones/${name}`, owner: { login: 'KealJones' }, private: priv, description: `${name} repo`, pushed_at: pushed, default_branch: 'main', html_url: `https://github.com/KealJones/${name}` });
  const repos = [...Array.from({ length: 40 }, (_, i) => mk(`old${i}`, `2016-01-${String(i % 28 + 1).padStart(2, '0')}T00:00:00Z`)), mk('squiggle-state', '2026-11-15T19:00:00Z', true), mk('bubbles', '2026-11-10T00:00:00Z', true)];
  const env = { repos: async () => repos, login: async () => 'KealJones', isStorage: (o, n) => n === 'squiggle-state', now: () => new Date('2026-11-15T19:00:00Z'), gh: async (p) => { if (p === '/repos/KealJones/bubbles') return repos.at(-1); throw Object.assign(new Error('Not Found'), { status: 404 }); } };
  // At a terminal: gh's header and table (tools/tty.js sets env.tty when stdout isn't piped).
  const list = await runGh(['repo', 'list'], { ...env, tty: true });
  const lines = list.stdout.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['', 'Showing 30 of 41 repositories in @KealJones', '']);
  assert.match(lines[3], /^NAME +DESCRIPTION +INFO +UPDATED$/);
  assert.match(lines[4], /^KealJones\/bubbles +bubbles repo +private +about 5 days ago$/, 'newest push first');
  assert.equal(lines[4].indexOf('bubbles repo'), lines[3].indexOf('DESCRIPTION'), 'columns line up');
  assert.doesNotMatch(list.stdout, /squiggle-state/, 'the storage repo stays hidden');
  assert.equal((await runGh(['repo', 'list', '-L', '100'], { ...env, tty: true })).stdout.trim().split('\n').length, 2 + 1 + 41);
  assert.match((await runGh(['repo', 'list', '--visibility', 'private'], { ...env, tty: true })).stdout, /^\nShowing 1 of 1 repositories in @KealJones that match your search\n/);
  // Like gh at a terminal it can't measure: 80 columns, long cells cut with "..." (the full text is one command away).
  const { ttyTable } = await import('../app/src/tools/ghcli.js');
  const long = 'Bubbles: a bubbly little playground for physics-y soap bubble simulations in the browser';
  const t = ttyTable(['NAME', 'DESCRIPTION', 'INFO', 'UPDATED'], [['KealJones/bubbles', long, 'private', 'about 5 days ago'], ['KealJones/squiggle', 'Short one', 'public', 'about 1 hour ago']]).split('\n');
  assert.ok(t.every(l => l.length <= 80), t.join('\n'));
  assert.match(t[1], /^KealJones\/bubbles +Bubbles: a bubbly little \S*\.\.\. +private +about 5 days ago$/); assert.equal(t[1].length, 80);
  assert.equal(ttyTable(['A', 'B'], [['x', long]], 200).split('\n')[1], 'x  ' + long, 'GH_FORCE_TTY=200 is a 200-column terminal');
  // Piped or redirected: gh's plain rows, no header.
  assert.match((await runGh(['repo', 'list'], env)).stdout, /^KealJones\/bubbles\tbubbles repo\tprivate\t2026-11-10T00:00:00Z\n/);
  const all = await runGh(['repo', 'list', '--all'], env);
  assert.equal(all.exitCode, 1, 'a made-up flag fails like gh instead of printing the same list');
  assert.match(all.stderr, /^unknown flag: --all/);
  assert.match((await runGh(['repo', 'view', 'bubbles'], env)).stdout, /^name:\tKealJones\/bubbles\n/, 'a bare name is the user\'s, like gh');
  // The small bash prompt says git and gh act as the user; demo mode drops that line.
  const src = readFileSync(new URL('../app/src/agent.js', import.meta.url), 'utf8');
  assert.match(src, /const GITHUB_LINE = "git and gh are signed in as the user: \\"my repo X\\" is theirs, so gh repo clone X/);
  assert.match(src, /LITE_SYSTEM_BASH = \[[^\]]*GITHUB_LINE,/);
  assert.match(src, /storage\.isLocal\(\) \? LITE_SYSTEM_BASH\.replace\(GITHUB_LINE/);
  // find's empty answer names tools the model has: bash and ask_user for LFM3; Squiggle Small's text is unchanged.
  assert.doesNotMatch(nothingFor({ bash: true, ask: 'ask_user' }), /web_search|need/);
  assert.match(nothingFor({ bash: true, ask: 'ask_user' }), /use bash .*gh.*ask_user/);
  assert.equal(nothingFor({ ask: 'need' }), NOTHING);
  assert.match(src, /if \(text === NOTHING\) text = nothingFor\(\{ bash: bashSurface\(\), ask: askName\(\) \}\);/);
});

test('case 20: tools/tty.js marks gh as at a terminal only when its stdout reaches the model, like a real shell', async () => {
  const { Bash, defineCommand } = await import('just-bash');
  const { ttyPlugin } = await import('../app/src/tools/tty.js');
  const gh = defineCommand('gh', async (args, ctx) => ({ stdout: (ctx.env.get('GH_FORCE_TTY') ? 'tty' : 'pipe') + '\n', stderr: '', exitCode: 0 }));
  const shell = new Bash({ customCommands: [gh] }); shell.registerTransformPlugin(ttyPlugin);
  const cases = { 'gh': 'tty\n', 'gh | cat': 'pipe\n', 'x=$(gh); echo $x': 'pipe\n', 'gh > /tmp/a; cat /tmp/a': 'pipe\n',
    'for i in 1; do gh; done': 'tty\n', 'for i in 1; do gh; done | cat': 'pipe\n', '{ gh; } > /tmp/b; cat /tmp/b': 'pipe\n',
    'gh && gh | cat': 'tty\npipe\n', 'cat <(gh)': 'pipe\n', 'f() { gh; }; f': 'tty\n', 'GH_FORCE_TTY= gh': 'pipe\n', 'if gh; then :; fi': 'tty\n' };
  for (const [script, want] of Object.entries(cases)) assert.equal((await shell.exec(script)).stdout, want, script);
  assert.equal((await shell.exec('gh >&2')).stderr, 'tty\n', 'stderr is the terminal too');
});

test('case 21: "what do you remember about me" finds the facts; LFM3\'s prompt says how to save and look them up', async () => {
  const { rankFacts } = await import('../app/src/memory-rank.js');
  const live = [{ id: 'f', text: 'The user says: I like short answers.', mts: 1 }];
  assert.deepEqual(rankFacts(live, 'What do you remember about me?').map(r => r.fact.id), ['f']);
  assert.deepEqual(rankFacts(live, 'me').map(r => r.fact.id), ['f']);
  const src = readFileSync(new URL('../app/src/agent.js', import.meta.url), 'utf8');
  assert.match(src, /LITE_SYSTEM_BASH = \[[^\]]*MEMORY_LINE,/);
  assert.match(src, /const MEMORY_LINE = 'When the user tells you something lasting about themselves or their work, save it with the memory tool \(add\); when it changes, or they ask you to forget it, replace or remove that entry\./);
  const mem = readFileSync(new URL('../app/src/tools/memory.js', import.meta.url), 'utf8');
  assert.match(mem, /The user says: \$\{text\}/);
});

test('case 22: "forget that I like short answers" saved the opposite; LFM3 gets Hermes\'s memory tool, and a blind call gets the definition', async () => {
  const { memoryTool, COMMON_FROM } = await import('../app/src/tools/common.js');
  const p = memoryTool.spec.parameters;
  assert.deepEqual(p.properties.action.enum, ['add', 'replace', 'remove'], 'forgetting is an action of the same tool, not a separate one to find');
  assert.ok(p.properties.old_text && p.properties.content && p.properties.target, 'Hermes\'s argument names');
  assert.equal(COMMON_FROM.memory, 'remember');
  const src = readFileSync(new URL('../app/src/agent.js', import.meta.url), 'utf8');
  assert.match(src, /const LOADED = new Set\(\[[^\]]*'memory'/, 'memory is loaded up front, never called from its name alone');
  assert.match(src, /if \(blind\) return \{ response: blind \};/, 'a deferred tool called with arguments that don\'t fit doesn\'t run');
});

test('case 23 (Zac Efron in High School Musical: The Series): sidebars and link-only lists never reach the page text', async () => {
  const { DOMParser } = await import('linkedom');
  const { pageText } = await import('../app/src/webpage.js');
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>
    <header><nav><a href="/">Home</a></nav></header>
    <main><article><h1>Olivia Rodrigo</h1>
      <p>Rodrigo rose to fame on Disney Channel, landing a starring role in the TV series High School Musical: The Musical: The Series at age 15.</p>
      <h2>Other Famous Disney Stars</h2>
      <ul><li><a href="/zac-efron">Zac Efron</a></li><li><a href="/demi-lovato">Demi Lovato</a></li><li><a href="/miley-cyrus">Miley Cyrus</a></li></ul>
      <aside><a href="/taylor-swift">Taylor Swift</a></aside>
      <p>The breakup ballad debuted at No. 1 on the Billboard Hot 100.</p>
    </article></main>
    <footer>Privacy</footer></body></html>`, 'text/html');
  const t = pageText(doc);
  assert.match(t, /at age 15\./);
  assert.match(t, /debuted at No\. 1/);
  assert.doesNotMatch(t, /Zac Efron|Demi Lovato|Miley Cyrus|Other Famous|Taylor Swift|Privacy|Home/);
});
