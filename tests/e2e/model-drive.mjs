// Drives the real app (not the fake engine) with a real small model in headless Chromium: the e2e harness's
// git server and relay, a persistent browser profile so the model download is kept, and a scripted set of
// messages sent through the composer. Prints, per turn: the reply, tool calls, the context window parts, time
// to first token and tokens/s, JS heap and the renderer's RSS. Not part of the e2e suite (it downloads models).
//
//   node tests/e2e/model-drive.mjs --model Q35 [--mode smart|compact|managed] [--small 0|1] [--threads] [--gpu]
//        [--ctx 4096] [--turns 5] [--timeout 300] [--msgs a|b] [--verbose] [--out file.json]
//
// --threads serves the app with COOP/COEP (what sw.js does for "Use all CPU cores"); --small sets Small-model
// mode for the model. The profile lives in the OS temp dir, one per model.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeGitRoot, makeRepo, start } from './harness.mjs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }
const arg = (n, d) => process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d;
const has = (n) => process.argv.includes(n);
const MODEL = arg('--model', 'SQ'), MODE = arg('--mode', 'smart'), SMALL = arg('--small', ''), CTX = Number(arg('--ctx', 4096));
const THREADS = has('--threads'), GPU = has('--gpu'), TURNS = Number(arg('--turns', 4)), OUT = arg('--out', '');
const TURN_TIMEOUT = Number(arg('--timeout', 300)) * 1000;
const SETS = {
  a: ['hi', 'what is 15% of 240?', 'remember that my dog is named Pip', 'what is my dog\'s name?', 'who is the prime minister of the UK right now? look it up', 'thanks! summarize what we did'],
  b: ['hi', 'who is the prime minister of the UK right now? look it up', 'what is my dog\'s name?'],
};
const MSGS = SETS[arg('--msgs', 'a')].slice(0, TURNS);
const profile = join(tmpdir(), `squiggle-drive-${MODEL}`); mkdirSync(profile, { recursive: true });

const root = makeGitRoot(); makeRepo(root, 'tester', 'state', { 'README.md': '# state\n' });
const { appUrl, close } = await start(root, {}, { isolate: THREADS });
const ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1280, height: 800 }, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
await ctx.route('https://api.github.com/**', async (route) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST' };
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const path = new URL(route.request().url()).pathname;
  if (path === '/user') return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ login: 'tester', id: 42, name: 'Test Er' }) });
  return route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: '{"message":"Not Found"}' });
});
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); if (has('--verbose')) console.log('  [' + m.type() + '] ' + m.text().slice(0, 200)); });
await page.goto(appUrl + '/');
await page.waitForSelector('#setup:not([hidden]) button, #app:not([hidden])');
await page.evaluate(async ({ MODEL, MODE, SMALL, CTX, THREADS, GPU }) => {
  const util = await import('/src/util.js'); await util.kv.set('auth', { access_token: 'ghu_test', refresh_token: null, expires_at: null });
  const gh = await import('/src/github.js'); await gh.loadAuth();
  const s = { model: MODEL, contextMode: MODE, contextSize: CTX, semantic: false, learn: true, fastDecode: false, smallThreads: THREADS, smallGpu: GPU, phoneG3: true, phoneSQ: true, mobileTuned: true, harnessV2: true, voiceEngine: 'system' };
  if (SMALL !== '') s.smallMode = SMALL === '1' ? { [MODEL]: true } : {};
  localStorage.setItem('squiggle-settings', JSON.stringify(s));
  localStorage.removeItem('squiggle-model-loading');
  const storage = await import('/src/storage.js');
  if (!storage.storageConfig()) await storage.useStorage({ owner: 'tester', name: 'state', branch: 'main', root: '' });
}, { MODEL, MODE, SMALL, CTX, THREADS, GPU });
await page.reload();
await page.waitForSelector('#app:not([hidden])');
await page.evaluate(async () => { const st = (await import('/src/ui/state.js')).state; window.__sqState = st; window.__sqBusy = () => st.busy; });
await page.evaluate(async () => { const s = await import('/src/sessions.js'); const c = await import('/src/ui/chat.js'); c.openSession(s.newSession()); });

const rss = () => { try { return Math.max(...execSync("ps -eo rss,args | grep -- '--type=renderer' | grep -v grep | awk '{print $1}'").toString().trim().split('\n').map(Number)) / 1024 | 0; } catch { return null; } };
const snap = () => page.evaluate(async () => {
  const st = (await import('/src/ui/state.js')).state;
  const eng = await import('/src/engine.js');
  const sp = await eng.smallSpeed().catch(() => null);
  const s = st.current; const last = s && [...s.messages].reverse().find(m => m.role === 'assistant');
  return { modelState: st.modelState, busy: st.busy, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, speed: sp,
    note: document.querySelector('#composer-note')?.textContent, banner: document.querySelector('#model-banner:not([hidden])')?.textContent?.slice(0, 200) || '',
    last: last && { content: last.content, thinking: (last.thinking || '').slice(0, 400), tools: (last.tools || []).map(t => ({ name: t.name, args: t.args, ok: t.ok, label: t.label })), window: last.context && last.context.window, mode: last.context && last.context.mode, used: last.context && last.context.used, budget: last.context && last.context.budget, task: last.task },
    title: s && s.title, nMsgs: s && s.messages.length };
});

const results = { model: MODEL, mode: MODE, small: SMALL, ctx: CTX, threads: THREADS, gpu: GPU, turns: [], errors };
// Load the model first (the download may take a while) and time it separately.
const t0 = Date.now();
await page.evaluate(async () => { const m = await import('/src/ui/model-ui.js'); await m.ensureModel(); });
await page.waitForFunction(() => window.__sqState.modelState === 'ready', null, { timeout: 1200000 }).catch(() => {});
results.loadMs = Date.now() - t0;
results.afterLoad = { ...(await snap()), rssMB: rss() };
console.log(`model ${MODEL} state=${results.afterLoad.modelState} load=${results.loadMs}ms heap=${results.afterLoad.heapMB}MB rss=${results.afterLoad.rssMB}MB note="${results.afterLoad.note}"`);

for (const text of MSGS) {
  const before = await snap();
  const t = Date.now();
  await page.fill('#input', text);
  await page.locator('#composer').evaluate(f => f.requestSubmit());
  const probe = async (tag) => console.log(`  [${tag}] ` + JSON.stringify(await page.evaluate(() => ({ busy: window.__sqState.busy, modelState: window.__sqState.modelState, nMsgs: window.__sqState.current && window.__sqState.current.messages.length, input: document.querySelector('#input').value }))));
  if (has('--verbose')) { await probe('after submit'); await page.waitForTimeout(1500); await probe('1.5s later'); }
  const started = await page.waitForFunction(() => window.__sqBusy(), null, { timeout: 60000 }).then(() => true).catch(() => false);
  if (!started) console.log('  turn did not start');
  const done = await page.waitForFunction(() => !window.__sqBusy(), null, { timeout: TURN_TIMEOUT }).then(() => true).catch(() => false);
  if (!done) { await page.click('#send').catch(() => {}); await page.waitForFunction(() => !window.__sqBusy(), null, { timeout: 60000 }).catch(() => {}); }
  const after = await snap();
  const turn = { text, ms: Date.now() - t, timedOut: !done, reply: after.last && after.last.content, thinking: after.last && after.last.thinking, tools: after.last && after.last.tools, window: after.last && after.last.window, ctxMode: after.last && after.last.mode, used: after.last && after.last.used, budget: after.last && after.last.budget, speed: after.speed, heapMB: after.heapMB, rssMB: rss(), nMsgs: after.nMsgs, newReply: !before.last || !after.last || before.last.content !== after.last.content || after.nMsgs !== before.nMsgs };
  results.turns.push(turn);
  console.log(`\n> ${text}\n  [${(turn.ms / 1000).toFixed(1)}s${turn.timedOut ? ' TIMEOUT' : ''}] speed=${JSON.stringify(turn.speed)} heap=${turn.heapMB}MB rss=${turn.rssMB}MB window=${JSON.stringify(turn.window && turn.window.parts)} used=${turn.used}/${turn.budget}`);
  if (turn.tools && turn.tools.length) console.log('  tools: ' + turn.tools.map(x => `${x.name}(${JSON.stringify(x.args)})${x.ok === false ? ' FAIL' : ''}`).join('; '));
  if (turn.thinking) console.log('  thinking: ' + turn.thinking.replace(/\s+/g, ' ').slice(0, 200));
  console.log('  reply: ' + String(turn.reply || '').replace(/\s+/g, ' ').slice(0, 400));
}
results.final = { ...(await snap()), rssMB: rss() };
if (errors.length) console.log('\nerrors:', errors.slice(0, 10).join('\n'));
if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 1));
await ctx.close(); await close(); process.exit(0);
