// Two-device sync, git tools and sandbox, end to end in headless Chromium.
//   node tests/e2e/run.mjs [--shots <dir>]
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeGitRoot, makeRepo, git, start } from './harness.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }

const shotsDir = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const root = makeGitRoot();
const stateRepo = makeRepo(root, 'tester', 'state', { 'README.md': '# state\n' });
const appRepo = makeRepo(root, 'tester', 'app', { 'README.md': '# app\n', 'src/index.js': 'console.log("hi")\n' });
git(appRepo, 'branch', 'release', 'main');
const split = process.argv.includes('--split');
const { appUrl, relayUrl, close } = await start(root, {}, { split });
if (split) console.log(`split mode: app ${appUrl}, relay ${relayUrl} (GitHub Pages setup)`);
const browser = await chromium.launch();
const results = [];
const check = async (name, fn) => {
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 60s')), 60000))]);
    results.push(['ok', name]); console.log('ok  ', name);
  }
  catch (e) { results.push(['FAIL', name, e]); console.log('FAIL', name, '\n     ', e.message.split('\n').slice(0, 6).join('\n      ')); }
};

async function device(label, viewport) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 1280, height: 820 } });
  await ctx.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const path = new URL(req.url()).pathname;
    if (path === '/user') return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ login: 'tester', id: 42, name: 'Test Er' }) });
    return route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: '{"message":"Not Found"}' });
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
  await page.goto(appUrl + '/');
  await page.evaluate(async () => {
    const util = await import('/src/util.js');
    await util.kv.set('auth', { access_token: 'ghu_test', refresh_token: null, expires_at: null });
    const gh = await import('/src/github.js');
    await gh.loadAuth();
    window.T = {
      storage: await import('/src/storage.js'), sessions: await import('/src/sessions.js'),
      memory: await import('/src/memory.js'), tools: await import('/src/tools.js'), gitm: await import('/src/git.js'),
    };
  });
  page.label = label;
  return { ctx, page };
}

const CFG = { owner: 'tester', name: 'state', branch: 'main', root: '' };

const A = await device('desktop');
const B = await device('phone', { width: 390, height: 844 });

await check('device A sets up storage (clone, marker, push)', async () => {
  await A.page.evaluate(async (cfg) => { await T.storage.useStorage(cfg); }, CFG);
  const files = git(stateRepo, 'ls-tree', '-r', '--name-only', 'main');
  assert.match(files, /\.squiggle\.json/);
  assert.equal(git(stateRepo, 'log', '-1', '--format=%an <%ae>', 'main'), 'Test Er <42+tester@users.noreply.github.com>');
});

await check('A writes a session; B picks it up', async () => {
  const id = await A.page.evaluate(async () => {
    const s = T.sessions.newSession();
    s.title = 'Plan the relay';
    T.sessions.addMessage(s, { role: 'user', content: 'Use device flow' });
    T.sessions.addMessage(s, { role: 'assistant', content: 'Sounds good' });
    await T.sessions.flush({ sync: false });
    await T.storage.sync();
    return s.id;
  });
  assert.match(git(stateRepo, 'ls-tree', '-r', '--name-only', 'main'), new RegExp(`sessions/${id}.json`));
  const seen = await B.page.evaluate(async (cfg) => {
    await T.storage.useStorage(cfg);
    await T.sessions.loadAll();
    return T.sessions.list().map(s => [s.title, s.messages.length]);
  }, CFG);
  assert.deepEqual(seen, [['Plan the relay', 2]]);
});

await check('both devices add to the same session offline; sync merges both', async () => {
  await A.page.evaluate(async () => {
    const s = T.sessions.list()[0];
    T.sessions.addMessage(s, { role: 'user', content: 'from desktop' });
    await T.sessions.flush({ sync: false });
  });
  await B.page.evaluate(async () => {
    const s = T.sessions.list()[0];
    T.sessions.addMessage(s, { role: 'user', content: 'from phone' });
    await T.sessions.flush({ sync: false });
  });
  await A.page.evaluate(() => T.storage.sync());
  await B.page.evaluate(() => T.storage.sync());   // must merge A's change
  await A.page.evaluate(async () => { await T.storage.sync(); });
  const a = await A.page.evaluate(async () => { await T.sessions.reload(['*']); return T.sessions.list()[0].messages.map(m => m.content); });
  const b = await B.page.evaluate(async () => { await T.sessions.loadAll(); return T.sessions.list()[0].messages.map(m => m.content); });
  for (const list of [a, b]) {
    assert.ok(list.includes('from desktop') && list.includes('from phone'), JSON.stringify(list));
    assert.equal(list.length, 4);
  }
  const status = await B.page.evaluate(() => T.storage.syncStatus());
  assert.equal(status.lastError, null);
  assert.equal(status.pending, 0);
});

await check('threads and memory facts sync and merge', async () => {
  await A.page.evaluate(async () => {
    const s = T.sessions.list()[0];
    const t = T.sessions.startThread(s, s.messages[0]);
    T.sessions.addMessage(s, { role: 'user', content: 'thread question', thread: t.id });
    await T.sessions.flush({ sync: false });
    T.memory.add({ s: 'Keal', p: 'prefers', o: 'no approval prompts' });
    await new Promise(r => setTimeout(r, 1500)); // memory save debounce
  });
  await B.page.evaluate(async () => {
    await T.memory.load();
    T.memory.add({ s: 'squiggle', p: 'stores sessions in', o: 'a private repo' });
    await new Promise(r => setTimeout(r, 1500));
  });
  await A.page.evaluate(() => T.storage.sync());
  await B.page.evaluate(() => T.storage.sync());
  const b = await B.page.evaluate(async () => {
    await T.sessions.loadAll(); await T.memory.load();
    const s = T.sessions.list()[0];
    return { threads: Object.keys(s.threads).length, line: T.sessions.lineMessages(s, Object.keys(s.threads)[0]).map(m => m.content), facts: T.memory.all().map(T.memory.factText).sort() };
  });
  assert.equal(b.threads, 1);
  assert.deepEqual(b.line, ['Use device flow', 'thread question']);
  assert.deepEqual(b.facts, ['Keal prefers no approval prompts', 'squiggle stores sessions in a private repo']);
});

await check('conflicting edits to a plain file keep both versions', async () => {
  await A.page.evaluate(async () => { await T.storage.write('home/notes.md', 'desktop version\n'); });
  await B.page.evaluate(async () => { await T.storage.write('home/notes.md', 'phone version\n'); });
  await A.page.evaluate(() => T.storage.sync());
  await B.page.evaluate(() => T.storage.sync());
  const files = git(stateRepo, 'ls-tree', '-r', '--name-only', 'main').split('\n').filter(f => f.startsWith('home/'));
  assert.ok(files.includes('home/notes.md'));
  const copy = files.find(f => f.startsWith('home/notes.md.remote-'));
  assert.ok(copy, files.join(', '));
  assert.equal(git(stateRepo, 'show', 'main:home/notes.md'), 'phone version');
  assert.equal(git(stateRepo, 'show', `main:${copy}`), 'desktop version');
});

await check('push race: a push from another device in between is rebased, not lost', async () => {
  // A syncs after B pushed without A fetching first (A's local main is stale).
  await A.page.evaluate(async () => { await T.storage.write('home/a.txt', 'a\n'); });
  await B.page.evaluate(async () => { await T.storage.write('home/b.txt', 'b\n'); await T.storage.sync(); });
  await A.page.evaluate(() => T.storage.sync());
  const files = git(stateRepo, 'ls-tree', '-r', '--name-only', 'main');
  assert.match(files, /home\/a\.txt/);
  assert.match(files, /home\/b\.txt/);
});

await check('agent git tools: agent/ pushes freely; other branches need approval', async () => {
  const r = await A.page.evaluate(async () => {
    const calls = [];
    const ctx = (decision) => ({ session: T.sessions.list()[0], approve: decision && (async (req) => { calls.push(req); if (decision === 'throw') throw new Error('should not ask'); return decision; }) });
    const run = async (name, args, decision) => (await T.tools.runTool({ function: { name, arguments: args } }, ctx(decision))).model;
    const grants = await import('/src/grants.js');
    await grants.load();
    const out = { calls };
    out.clone = await run('git_clone', { repo: 'tester/app' });
    out.write = await run('write_file', { path: '/repos/app/src/index.js', content: 'console.log("changed")\n' });
    out.branch = await run('git_branch', { repo: 'app', name: 'Fix Greeting' });
    out.status = await run('git_status', { repo: 'app' });
    out.commit = await run('git_commit', { repo: 'app', message: 'Change greeting' });
    out.push = await run('git_push', { repo: 'app' }, 'throw');               // agent/: no prompt
    out.toMain = await run('git_branch', { repo: 'app', name: 'main' });       // switch to existing
    await run('write_file', { path: '/repos/app/NOTES.md', content: 'one\n' });
    out.commitMain = await run('git_commit', { repo: 'app', message: 'Add notes' });
    out.noApprover = await run('git_push', { repo: 'app' });                  // nobody to ask
    out.denied = await run('git_push', { repo: 'app' }, 'deny');
    out.once = await run('git_push', { repo: 'app' }, 'once');
    out.grantsAfterOnce = grants.list().length;
    await run('write_file', { path: '/repos/app/NOTES.md', content: 'two\n' });
    await run('git_commit', { repo: 'app', message: 'More notes' });
    out.always = await run('git_push', { repo: 'app' }, 'always');
    await run('write_file', { path: '/repos/app/NOTES.md', content: 'three\n' });
    await run('git_commit', { repo: 'app', message: 'Even more notes' });
    out.granted = await run('git_push', { repo: 'app' }, 'throw');            // remembered: no prompt
    out.grants = grants.list().map(g => `${g.repo}:${g.branch}`);
    // Workflow files: asked every time, even on agent/ branches or with a grant.
    await run('git_branch', { repo: 'app', name: 'ci-tweak' });
    await run('write_file', { path: '/repos/app/.github/workflows/ci.yml', content: 'on: push\n' });
    await run('git_commit', { repo: 'app', message: 'Add CI' });
    out.wfAgent = await run('git_push', { repo: 'app' }, 'always');
    await run('git_branch', { repo: 'app', name: 'main' });
    await run('write_file', { path: '/repos/app/.github/workflows/deploy.yml', content: 'on: push\n' });
    await run('git_commit', { repo: 'app', message: 'Add deploy' });
    out.wfMain = await run('git_push', { repo: 'app' }, 'deny');
    out.grantsAfterWf = grants.list().map(g => `${g.repo}:${g.branch}`);
    out.escape = await run('read_file', { path: '/repos/app/../../state/.squiggle.json' });
    out.gitdir = await run('read_file', { path: '/repos/app/.git/config' });
    out.storageClone = await run('git_clone', { repo: 'tester/state' });
    return out;
  });
  assert.equal(r.clone.ok, true, JSON.stringify(r.clone));
  assert.equal(r.branch.branch, 'agent/fix-greeting');
  assert.deepEqual(r.status.changes, ['M src/index.js']);
  assert.equal(r.commit.ok, true);
  assert.equal(r.push.ok, true, JSON.stringify(r.push));
  assert.equal(r.toMain.branch, 'main');
  assert.equal(r.commitMain.ok, true, 'committing on main is local and allowed');
  assert.match(r.noApprover.error, /needs the user's approval/);
  assert.match(r.denied.error, /did not allow/);
  assert.equal(r.once.ok, true, JSON.stringify(r.once));
  assert.equal(r.grantsAfterOnce, 0, '"once" saves nothing');
  assert.equal(r.always.ok, true);
  assert.equal(r.granted.ok, true, JSON.stringify(r.granted));
  assert.deepEqual(r.grants, ['tester/app:main']);
  assert.equal(r.calls.length, 5, 'asked for deny, once, always, and both workflow pushes');
  assert.deepEqual(r.calls[3].workflowFiles, ['.github/workflows/ci.yml']);
  assert.equal(r.calls[3].branch, 'agent/ci-tweak');
  assert.deepEqual(r.calls[3].commits.map(c => c.message), ['Add CI'], 'new branch: only commits GitHub lacks');
  assert.equal(r.wfAgent.ok, true);
  assert.deepEqual(r.calls[4].workflowFiles, ['.github/workflows/deploy.yml']);
  assert.match(r.wfMain.error, /did not allow/, 'grant for main does not cover workflow changes');
  assert.deepEqual(r.grantsAfterWf, ['tester/app:main'], '"always" on a workflow push is not remembered');
  assert.deepEqual(r.calls[1].commits.map(c => c.message), ['Add notes']);
  assert.equal(r.calls[0].branch, 'main');
  assert.equal(r.calls[0].repo, 'tester/app');
  assert.ok(r.escape.error, 'path escape blocked');
  assert.ok(r.gitdir.error, '.git access blocked');
  assert.match(r.storageClone.error, /storage repo/);
  assert.equal(git(appRepo, 'show', 'agent/fix-greeting:src/index.js'), 'console.log("changed")');
  assert.equal(git(appRepo, 'show', 'main:NOTES.md'), 'three');
  assert.equal(git(appRepo, 'show', 'main:src/index.js'), 'console.log("hi")');
  // The grant lives in the storage repo, so it applies on other devices too.
  assert.match(git(stateRepo, 'show', 'main:settings/push-grants.jsonl'), /"branch":"main"/);
});

await check('fetch_url wraps page text as untrusted and strips scripts', async () => {
  const r = await A.page.evaluate(async (url) => {
    const res = await T.tools.runTool({ function: { name: 'fetch_url', arguments: { url } } }, { session: T.sessions.list()[0] });
    return { model: res.model, obs: res.observation };
  }, appUrl + '/test-pages/injection.html');
  assert.match(r.model.text, /^<untrusted source="web 127\.0\.0\.1" key="[0-9a-f]{8}">/);
  assert.equal((r.model.text.match(/<\/untrusted/g) || []).length, 1, 'page cannot close the block');
  assert.ok(!r.model.text.includes('script text'), 'scripts stripped');
  assert.equal(r.model.title, 'Totally normal page');
  assert.ok(r.obs.text.includes('assets directory'));
});

await check('run_js sandbox cannot reach app data', async () => {
  const r = await A.page.evaluate(async () => {
    const run = async (code) => (await T.tools.runTool({ function: { name: 'run_js', arguments: { code } } }, {})).model;
    return {
      math: await run('return 6 * 7'),
      log: await run('console.log("hello", {a: 1})'),
      idb: await run('return await new Promise((res) => { try { const r = indexedDB.open("squiggle"); r.onsuccess = () => res("OPENED " + [...r.result.objectStoreNames].join(",")); r.onerror = () => res("blocked: " + r.error); } catch (e) { res("blocked: " + e.name); } })'),
      parentDoc: await run('try { return String(parent.document.title) } catch (e) { return "blocked: " + e.name }'),
      storage: await run('try { localStorage.getItem("squiggle-settings"); return "readable" } catch (e) { return "blocked: " + e.name }'),
      loop: await run('while (true) {}'),
      after: await run('return "alive"'),
    };
  });
  assert.equal(r.math.result, '42');
  assert.equal(r.log.stdout, 'hello {\n  "a": 1\n}');
  assert.match(r.idb.result, /blocked/);
  assert.match(r.parentDoc.result, /blocked/);
  assert.match(r.storage.result, /blocked/);
  assert.match(r.loop.error, /Timed out/);
  assert.equal(r.after.result, 'alive');
});

if (split) await check('split: app talks to a relay on another origin; other origins are refused', async () => {
  const r = await A.page.evaluate(async () => (await import('/src/config.js')).apiBase());
  assert.equal(r, relayUrl + '/api');
  const evil = await fetch(relayUrl + '/api/config', { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  const ok = await fetch(relayUrl + '/api/config', { headers: { Origin: appUrl } });
  assert.equal(ok.headers.get('access-control-allow-origin'), appUrl);
});

await check('no page errors so far', async () => {
  const errs = [...A.page.errors, ...B.page.errors].filter(e => !/favicon|404|Failed to load resource/.test(e));
  assert.deepEqual(errs, []);
});

await check('model runtime loads under the page CSP', async () => {
  const r = await A.page.evaluate(async () => {
    const violations = [];
    document.addEventListener('securitypolicyviolation', e => violations.push(`${e.violatedDirective} ${e.blockedURI}`));
    let imported = false, err = null;
    try { const m = await import('https://cdn.jsdelivr.net/npm/@litert-lm/core@0.14.0/+esm'); imported = Boolean(m.Engine); } catch (e) { err = String(e); }
    await new Promise(r => setTimeout(r, 300));
    return { imported, err, violations };
  });
  if (r.err && /Failed to fetch|NetworkError|net::/.test(r.err)) { console.log('      (skipped: CDN not reachable from this sandbox)'); return; }
  assert.deepEqual(r.violations, []);
  assert.equal(r.imported, true, r.err);
});

await check('a full agent turn through the UI (scripted model): tools, untrusted labels, memory, thread', async () => {
  const D = await device('agent');
  const fake = readFileSync(new URL('./fake-engine.js', import.meta.url));
  await D.ctx.route(appUrl + '/src/engine.js', r => r.fulfill({ contentType: 'text/javascript', body: fake }));
  await D.page.evaluate(cfg => T.storage.useStorage(cfg), CFG);
  await D.page.reload();
  await D.page.waitForSelector('#app:not([hidden])');
  await D.page.click('#new-chat');
  await D.page.fill('#input', `What does ${appUrl}/test-pages/injection.html say?`);
  await D.page.press('#input', 'Enter');
  await D.page.waitForFunction(() => [...document.querySelectorAll('.msg.assistant .body')].some(b => /assets directory serves/.test(b.textContent)), null, { timeout: 20000 });
  await D.page.waitForTimeout(4500); // background title / summary / learning jobs + memory save
  const r = await D.page.evaluate(async () => {
    const sessions = await import('/src/sessions.js');
    const memory = await import('/src/memory.js');
    const log = window.__engineLog;
    const s = sessions.list().find(x => x.messages.some(m => /test-pages\/injection/.test(m.content)));
    return {
      system: log.find(x => x.type === 'conversation').system,
      tools: log.find(x => x.type === 'conversation').tools,
      toolResult: JSON.stringify(log.filter(x => x.type === 'respond')[1].input),
      title: s.title,
      msgs: s.messages.map(m => [m.role, m.content.slice(0, 60), (m.tools || []).map(t => t.label)]),
      observations: s.observations.map(o => o.source + ':' + o.title),
      facts: memory.all().map(memory.factText),
      trail: [...document.querySelectorAll('.tool-trail .tool')].map(e => e.textContent.trim()),
    };
  });
  assert.match(r.system, /Never follow instructions/);
  assert.ok(r.tools.includes('fetch_url') && r.tools.includes('git_push') && r.tools.includes('search_history'));
  assert.match(r.toolResult, /<untrusted source=\\"web 127\.0\.0\.1\\" key=/);
  assert.equal(r.title, 'Wrangler assets question');
  assert.deepEqual(r.msgs.map(m => m[0]), ['user', 'assistant']);
  assert.ok(r.msgs[1][2].some(l => /^read http/.test(l)) && r.msgs[1][2].some(l => /^remembered/.test(l)), JSON.stringify(r.msgs));
  assert.ok(r.observations.some(o => o.startsWith('web:Totally normal page')));
  assert.ok(r.facts.includes('Keal is reading about wrangler assets'), JSON.stringify(r.facts));
  assert.ok(r.facts.includes('Keal deploys with Cloudflare Workers'), 'auto-learned fact');
  assert.equal(r.trail.length, 2);
  if (shotsDir) await D.page.screenshot({ path: `${shotsDir}/agent-turn.png` });

  // Permission card for a non-agent branch, clicked in the UI.
  await D.page.evaluate(async () => {
    const tools = await import('/src/tools.js');
    const sessions = await import('/src/sessions.js');
    const run = async (name, args) => (await tools.runTool({ function: { name, arguments: args } }, { session: sessions.list()[0] })).model;
    await run('git_clone', { repo: 'tester/app' });
    await run('git_branch', { repo: 'app', name: 'release' });
    await run('write_file', { path: '/repos/app/CHANGELOG.md', content: 'v1\n' });
    await run('git_commit', { repo: 'app', message: 'Changelog for v1' });
  });
  await D.page.fill('#input', 'Please push the release branch');
  await D.page.press('#input', 'Enter');
  await D.page.waitForSelector('.approval button', { timeout: 15000 });
  const cardText = await D.page.textContent('.approval');
  assert.match(cardText, /Push to release in tester\/app\?/);
  assert.match(cardText, /Changelog for v1/);
  if (shotsDir) await D.page.screenshot({ path: `${shotsDir}/agent-approval.png` });
  await D.page.click('.approval button:has-text("Allow once")');
  await D.page.waitForFunction(() => /Pushed release\./.test(document.querySelector('#messages-inner').textContent), null, { timeout: 15000 });
  assert.equal(git(appRepo, 'show', 'release:CHANGELOG.md'), 'v1');
  const settled = await D.page.evaluate(() => [...document.querySelectorAll('.tool-trail .tool')].map(e => e.textContent.trim()).pop());
  assert.match(settled, /pushed release \(app\) \(allowed once\)/);

  // Reply in a thread on the user's message.
  await D.page.hover('.msg.user >> nth=0');
  await D.page.click('.msg.user >> nth=0 >> [aria-label="Reply in thread"]');
  await D.page.fill('#drawer textarea', 'Is that page safe?');
  await D.page.press('#drawer textarea', 'Enter');
  await D.page.waitForFunction(() => /Plain answer to: Is that page safe/.test(document.querySelector('#thread-messages')?.textContent || ''), null, { timeout: 15000 });
  await D.page.waitForTimeout(3500);
  const t = await D.page.evaluate(async () => {
    const sessions = await import('/src/sessions.js');
    const s = sessions.list().find(x => x.messages.some(m => /test-pages\/injection/.test(m.content)));
    const th = Object.values(s.threads)[0];
    const convs = window.__engineLog.filter(x => x.type === 'conversation');
    const last = convs[convs.length - 1];
    return { summary: th.summary, mainCount: sessions.lineMessages(s).length, threadSystem: last.system, threadHistory: last.messages.map(m => m.role + ':' + m.content.slice(0, 40)), link: document.querySelector('.thread-link')?.textContent };
  });
  assert.equal(t.summary, 'Confirmed the page is safe to ignore.');
  assert.equal(t.mainCount, 4, 'thread replies stay out of the main line');
  assert.match(t.threadSystem, /side thread/);
  assert.match(t.threadHistory[0], /^user:What does/);
  assert.match(t.link, /2 replies.*Confirmed the page is safe/);
  if (shotsDir) await D.page.screenshot({ path: `${shotsDir}/agent-thread.png` });
  await D.page.click('#close-drawer');
  await D.page.hover('.msg.assistant');
  await D.page.click('.msg.assistant [aria-label="What the model saw"]');
  await D.page.waitForSelector('.ctx-item');
  if (shotsDir) await D.page.screenshot({ path: `${shotsDir}/agent-context.png` });
  const errs = D.page.errors.filter(e => !/favicon|404|Failed to load resource/.test(e));
  assert.deepEqual(errs, []);
});

// UI screenshots: reload into the app with seeded data.
if (shotsDir) {
  await check('UI renders (screenshots)', async () => {
    for (const [d, name] of [[A, 'desktop'], [B, 'phone']]) {
      await d.page.evaluate(async () => {
        const s = T.sessions.list()[0];
        T.sessions.addMessage(s, { role: 'assistant', content: 'I cloned **tester/app**, made the change on `agent/fix-greeting`, and pushed it.\n\n```js\nconsole.log("changed")\n```', tools: [{ name: 'git_clone', label: 'cloned tester/app', ok: true }, { name: 'git_push', label: 'pushed agent/fix-greeting (app)', ok: true }], context: { mode: 'compact', budget: 6300, used: 1840, items: [{ kind: 'system', label: 'System prompt', tokens: 420 }, { kind: 'recent', label: 'Last 6 messages', tokens: 980 }, { kind: 'fact', label: 'Keal prefers no approval prompts', tokens: 9, score: 0.81 }] } });
        const t = Object.values(s.threads)[0];
        t.summary = 'Decided on device flow; the relay needs no client secret.';
        T.sessions.touch(s);
        await T.sessions.flush({ sync: false });
      });
      await d.page.reload();
      await d.page.waitForSelector('#app:not([hidden])');
      await d.page.waitForTimeout(600);
      await d.page.screenshot({ path: `${shotsDir}/${name}-chat.png` });
      await d.page.click('.thread-link');
      await d.page.waitForTimeout(300);
      await d.page.screenshot({ path: `${shotsDir}/${name}-thread.png` });
      await d.page.click('#close-drawer');
    }
    await A.page.click('[data-panel="memory"]');
    await A.page.waitForTimeout(300);
    await A.page.screenshot({ path: `${shotsDir}/desktop-memory.png` });
    await A.page.click('[data-panel="settings"]');
    await A.page.waitForTimeout(300);
    await A.page.screenshot({ path: `${shotsDir}/desktop-settings.png` });
    await A.page.fill('#session-search', 'phone');
    await A.page.waitForTimeout(200);
    await A.page.screenshot({ path: `${shotsDir}/desktop-search.png` });
    const errs = [...A.page.errors, ...B.page.errors].filter(e => !/favicon|404|Failed to load resource/.test(e));
    assert.deepEqual(errs, []);
  });
  // A fresh device: first-run setup screen.
  const fresh = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await fresh.goto(appUrl + '/');
  await fresh.waitForSelector('#setup:not([hidden]) button');
  await fresh.screenshot({ path: `${shotsDir}/setup-signin.png` });
}

await browser.close();
close();
const failed = results.filter(r => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
