// Runs the failure casebook (tests/eval/cases.json, from docs/failures.md) through the real app with a real
// model, and grades each case: regexes on the final reply, tools the last turn must or must not have called.
// Prints a pass/fail table and writes the full transcript as JSON, so a change to find, the context modes or a
// lookup tool can be checked against the cases that produced them, model by model.
//
//   node tests/eval/run.mjs --model WQ06 [--mode smart|fresh|compact] [--small 0|1] [--ctx 4096]
//        [--cases 1,2,10] [--timeout 300] [--no-live] [--out docs/evals/WQ06-fresh.json] [--verbose] [--fake]
//        [--llm http://127.0.0.1:8711]
//
// --llm runs a WebLLM model (raw tool formats: LFM2.5 1.2B, the phone default) on native llama.cpp instead of
// WebGPU, so a machine with no GPU (CI, a cloud box) can run the phone model at a usable speed: the app, the
// agent and the model's own prompt format are the real ones; only the completion is swapped
// (tests/eval/llm_server.py, tests/eval/native-webllm.js).
//
// Needs a WebGPU device for the GPU models (WLF12, WQ06, TG4A's MLC build) or a few cores for the CPU ones; the
// model downloads once into a persistent profile in the OS temp dir, like tests/e2e/model-drive.mjs. The real web
// and Wikipedia are used unless --no-live (the harness's fixed search page can't answer "latest" questions).
// Not part of the e2e suite. The same harness as model-drive: a local git server, the real relay code, the real
// app, GitHub's REST API mocked.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { makeGitRoot, makeRepo, start } from '../e2e/harness.mjs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }

const arg = (n, d) => process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d;
const has = (n) => process.argv.includes(n);
const MODEL = arg('--model', 'WQ06'), MODE = arg('--mode', 'smart'), SMALL = arg('--small', ''), CTX = Number(arg('--ctx', 4096));
const TURN_TIMEOUT = Number(arg('--timeout', 300)) * 1000;
const LIVE = !has('--no-live');
const OUT = arg('--out', `docs/evals/${MODEL}-${MODE}.json`);
const ONLY = arg('--cases', '') ? new Set(arg('--cases', '').split(',').map(Number)) : null;
const VERBOSE = has('--verbose');

const spec = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
const cases = spec.cases.filter(c => !ONLY || ONLY.has(c.id));

const profile = join(tmpdir(), `squiggle-drive-${has('--fake') ? 'fake' : MODEL}`); mkdirSync(profile, { recursive: true });
const root = makeGitRoot(); makeRepo(root, 'tester', 'state', { 'README.md': '# state\n' });
makeRepo(root, 'tester', 'app', { 'README.md': '# app\nA test app.\n', 'src/index.js': 'console.log("hi")\n' });
// The repos the GitHub App "can reach" (github_list_repos; git_clone completes partial names from them).
const REPOS = [['tester/app', 'A test app', false], ['tester/bubbles', 'Bubble physics toy', false], ['tester/state', 'Squiggle storage', true]]
  .map(([f, d, p]) => ({ full_name: f, name: f.split('/')[1], owner: { login: 'tester' }, private: p, default_branch: 'main', description: d }));
const { appUrl, close } = await start(root, {}, { liveWeb: LIVE });
const ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1280, height: 800 }, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
await ctx.route('https://api.github.com/**', async (route) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST' };
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const p = new URL(route.request().url()).pathname;
  const body = p === '/user' ? { login: 'tester', id: 42, name: 'Test Er' } : p === '/user/installations' ? { installations: [{ id: 1, account: { login: 'tester' } }] }
    : p === '/user/installations/1/repositories' ? { total_count: REPOS.length, repositories: REPOS } : null;
  return route.fulfill({ status: body ? 200 : 404, headers: cors, contentType: 'application/json', body: JSON.stringify(body || { message: 'Not Found' }) });
});
// --llm: WebLLM's completions go to native llama.cpp (see the top of this file).
const LLM = arg('--llm', '');
if (LLM) {
  await ctx.route(/cdn\.jsdelivr\.net\/npm\/@mlc-ai\/web-llm@/, r => r.fulfill({ contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: readFileSync(new URL('./native-webllm.js', import.meta.url), 'utf8') }));
}
// --fake swaps in the e2e suite's scripted engine: for checking the runner itself, not a model.
if (has('--fake')) await ctx.route(appUrl + '/src/engine.js', r => r.fulfill({ contentType: 'text/javascript', body: readFileSync(new URL('../e2e/fake-engine.js', import.meta.url)) }));
const page = ctx.pages()[0] || await ctx.newPage();
if (LLM) await page.exposeFunction('__llm', async (body) => (await fetch(LLM, { method: 'POST', body })).text());
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); if (VERBOSE) console.log('  [' + m.type() + '] ' + m.text().slice(0, 200)); });
await page.goto(appUrl + '/');
await page.waitForSelector('#setup:not([hidden]) button, #app:not([hidden])');
await page.evaluate(async ({ MODEL, MODE, SMALL, CTX }) => {
  const util = await import('/src/util.js'); await util.kv.set('auth', { access_token: 'ghu_test', refresh_token: null, expires_at: null });
  const gh = await import('/src/github.js'); await gh.loadAuth();
  const s = { model: MODEL, contextMode: MODE, contextSize: CTX, semantic: false, learn: false, fastDecode: false, recallChats: true, debugTools: true, phoneG3: true, phoneSQ: true, phoneWQ06: true, phoneLFM: true, phoneSemantic: true, mobileTuned: true, harnessV2: true, voiceEngine: 'system' };
  if (SMALL !== '') s.smallMode = SMALL === '1' ? { [MODEL]: true } : {};
  localStorage.setItem('squiggle-settings', JSON.stringify(s));
  localStorage.removeItem('squiggle-model-loading');
  const storage = await import('/src/storage.js');
  if (!storage.storageConfig()) await storage.useStorage({ owner: 'tester', name: 'state', branch: 'main', root: '' });
}, { MODEL, MODE, SMALL, CTX });
await page.reload();
await page.waitForSelector('#app:not([hidden])');
await page.evaluate(async () => { const st = (await import('/src/ui/state.js')).state; window.__sqState = st; });

// The seeds: facts and an earlier chat the cases can be fooled by.
await page.evaluate(async (seed) => {
  const memory = await import('/src/memory.js');
  for (const f of seed.facts || []) memory.add(f);
  await memory.flush();
  const sessions = await import('/src/sessions.js');
  for (const c of seed.chats || []) {
    const s = sessions.newSession(c.title);
    for (const m of c.messages) sessions.addMessage(s, m);
  }
  await sessions.flush({ sync: false });
}, spec.seed || {});

const t0 = Date.now();
await page.evaluate(async () => { const m = await import('/src/ui/model-ui.js'); await m.ensureModel(); });
await page.waitForFunction(() => window.__sqState.modelState === 'ready', null, { timeout: 1200000 }).catch(() => {});
const state = await page.evaluate(() => window.__sqState.modelState);
console.log(`model ${MODEL} ${state} in ${((Date.now() - t0) / 1000).toFixed(0)}s; mode ${MODE}; ${cases.length} cases${LIVE ? ', live web' : ''}`);
if (state !== 'ready') { console.log('model not ready; stopping'); await ctx.close(); await close(); process.exit(2); }

const lastReply = () => page.evaluate(() => {
  const s = window.__sqState.current; const m = s && [...s.messages].reverse().find(x => x.role === 'assistant');
  return m && { content: m.content || '', thinking: (m.thinking || '').slice(0, 600), tools: (m.tools || []).map(t => ({ name: t.name, args: t.args, ok: t.ok, result: t.result })), window: m.context && m.context.window };
});

async function send(text) {
  const before = await page.evaluate(() => window.__sqState.current.messages.length);
  await page.fill('#input', text);
  await page.locator('#composer').evaluate(f => f.requestSubmit());
  // Done when a reply has been added and the turn is over (a fast model can finish between two polls).
  const done = await page.waitForFunction((n) => !window.__sqState.busy && window.__sqState.current.messages.length >= n + 2, before, { timeout: TURN_TIMEOUT }).then(() => true).catch(() => false);
  if (!done) { await page.click('#send').catch(() => {}); await page.waitForFunction(() => !window.__sqState.busy, null, { timeout: 60000 }).catch(() => {}); }
  return { timedOut: !done, reply: await lastReply() };
}

const re = (p) => new RegExp(p, 'i');
function grade(c, reply) {
  const problems = [];
  const text = (reply && reply.content) || '';
  const names = ((reply && reply.tools) || []).map(t => t.name);
  if (c.expect && !re(c.expect).test(text)) problems.push(`reply lacks /${c.expect}/`);
  if (c.reject && re(c.reject).test(text)) problems.push(`reply matches /${c.reject}/`);
  for (const want of c.tools || []) if (!names.some(n => re('^(' + want + ')$').test(n))) problems.push(`no ${want} call`);
  for (const bad of c.noTools || []) if (names.includes(bad)) problems.push(`called ${bad}`);
  if (c.expectUrlFromTools) {
    // Every URL in the reply must appear in a tool result or argument (no made-up links).
    const seen = JSON.stringify((reply && reply.tools) || []);
    for (const u of text.match(/https?:\/\/\S+/g) || []) if (!seen.includes(u.replace(/[).,]+$/, ''))) problems.push(`made-up URL ${u}`);
  }
  return problems;
}

const results = { model: MODEL, mode: MODE, small: SMALL, ctx: CTX, live: LIVE, date: new Date().toISOString(), cases: [], errors };
let passed = 0;
for (const c of cases) {
  await page.evaluate(async () => { const s = await import('/src/sessions.js'); const ch = await import('/src/ui/chat.js'); ch.openSession(s.newSession()); });
  const turns = [];
  let last = null;
  const t = Date.now();
  for (const text of c.messages) {
    const r = await send(text);
    turns.push({ text, timedOut: r.timedOut, reply: r.reply });
    last = r;
  }
  const problems = last && last.timedOut ? ['timed out'] : grade(c, last && last.reply);
  const ok = problems.length === 0;
  if (ok) passed++;
  results.cases.push({ id: c.id, name: c.name, ok, problems, ms: Date.now() - t, turns });
  const reply = String((last && last.reply && last.reply.content) || '').replace(/\s+/g, ' ').slice(0, 160);
  const tools = ((last && last.reply && last.reply.tools) || []).map(x => x.name).join(', ');
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(c.id).padStart(2)} ${c.name}${ok ? '' : '\n       ' + problems.join('; ')}\n       tools: ${tools || '(none)'}\n       reply: ${reply}`);
}
results.passed = passed; results.total = cases.length;
console.log(`\n${passed}/${cases.length} passed (${MODEL}, ${MODE})`);
if (errors.length) console.log('page errors:', errors.slice(0, 5).join('\n'));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(results, null, 1));
console.log(`written to ${OUT}`);
await ctx.close(); await close(); process.exit(passed === cases.length ? 0 : 1);
