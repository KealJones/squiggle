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
const SURFACE = arg('--surface', 'tools');   // 'bash': one bash tool in place of the file, web, git and maths tools (lab)
const TURN_TIMEOUT = Number(arg('--timeout', 300)) * 1000;
const LIVE = !has('--no-live');
const OUT = arg('--out', `docs/evals/${MODEL}-${MODE}${SURFACE === 'bash' ? '-bash' : ''}${arg('--set', '') ? '-' + arg('--set', '').replace(/\.json$/, '') : ''}.json`);
const ONLY = arg('--cases', '') ? new Set(arg('--cases', '').split(',').map(Number)) : null;
const VERBOSE = has('--verbose');

// --set: another file of cases next to this one (tasks-tools.json: everyday jobs for comparing tool surfaces).
const spec = JSON.parse(readFileSync(new URL('./' + arg('--set', 'cases.json'), import.meta.url), 'utf8'));
const cases = spec.cases.filter(c => !ONLY || ONLY.has(c.id));

const profile = join(tmpdir(), `squiggle-drive-${has('--fake') ? 'fake' : MODEL}`); mkdirSync(profile, { recursive: true });
const root = makeGitRoot(); makeRepo(root, 'tester', 'state', { 'README.md': '# state\n' });
makeRepo(root, 'tester', 'app', { 'README.md': '# app\nA test app.\n', 'src/index.js': 'console.log("hi")\n' });
// The repos the GitHub App "can reach" (github_list_repos; git_clone completes partial names from them).
const REPOS = [['tester/app', 'A test app', false], ['tester/bubbles', 'Bubble physics toy', false], ['tester/state', 'Squiggle storage', true]]
  .map(([f, d, p]) => ({ full_name: f, name: f.split('/')[1], owner: { login: 'tester' }, private: p, default_branch: 'main', description: d }));
const { appUrl, close } = await start(root, {}, { liveWeb: LIVE });
// SQUIGGLE_CHROME_ARGS (space-separated) replaces the WebGPU flags and SQUIGGLE_CHANNEL picks Playwright's channel, for
// machines whose GPU needs other switches (a headless Linux GPU box: tests/eval/gpu-probe.mjs finds the set that works).
const chromeArgs = process.env.SQUIGGLE_CHROME_ARGS ? process.env.SQUIGGLE_CHROME_ARGS.split(/\s+/).filter(Boolean) : ['--enable-unsafe-webgpu', '--enable-features=Vulkan'];
const ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1280, height: 800 }, args: chromeArgs, ...(process.env.SQUIGGLE_CHANNEL ? { channel: process.env.SQUIGGLE_CHANNEL } : {}) });
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
  // A server that isn't up must stop the run, not score every case as a model failure (2026-11-10: a queued
  // LFM3 run whose server failed to load wrote 10 "fails" in 0 model calls).
  const probe = await fetch(LLM, { method: 'POST', body: JSON.stringify({ prompt: 'Hi', max_tokens: 1 }) }).then(r => r.ok, () => false);
  if (!probe) { console.error(`No model server answering at ${LLM}: start tests/eval/llm_server.py first.`); process.exit(2); }
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
await page.evaluate(async ({ MODEL, MODE, SMALL, CTX, SURFACE }) => {
  const util = await import('/src/util.js'); await util.kv.set('auth', { access_token: 'ghu_test', refresh_token: null, expires_at: null });
  const gh = await import('/src/github.js'); await gh.loadAuth();
  const s = { model: MODEL, toolSurface: SURFACE, lab: SURFACE === 'bash', contextMode: MODE, contextSize: CTX, semantic: false, learn: false, fastDecode: false, recallChats: true, debugTools: true, phoneG3: true, phoneSQ: true, phoneWQ06: true, phoneLFM: true, phoneSemantic: true, mobileTuned: true, harnessV2: true, voiceEngine: 'system' };
  if (SMALL !== '') s.smallMode = SMALL === '1' ? { [MODEL]: true } : {};
  localStorage.setItem('squiggle-settings', JSON.stringify(s));
  localStorage.removeItem('squiggle-model-loading');
  const storage = await import('/src/storage.js');
  if (!storage.storageConfig()) await storage.useStorage({ owner: 'tester', name: 'state', branch: 'main', root: '' });
}, { MODEL, MODE, SMALL, CTX, SURFACE });
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
console.log(`model ${MODEL} ${state} in ${((Date.now() - t0) / 1000).toFixed(0)}s; mode ${MODE}; ${SURFACE === 'bash' ? 'one bash tool; ' : ''}${cases.length} cases${LIVE ? ', live web' : ''}`);
if (state !== 'ready') { console.log('model not ready; stopping'); await ctx.close(); await close(); process.exit(2); }

const lastReply = () => page.evaluate(() => {
  const s = window.__sqState.current; const m = s && [...s.messages].reverse().find(x => x.role === 'assistant');
  return m && { content: m.content || '', thinking: (m.thinking || '').slice(0, 600), tools: (m.tools || []).map(t => ({ name: t.name, args: t.args, ok: t.ok, result: t.result })), window: m.context && m.context.window, llm: (window.__llmLog || []).slice(), trace: m.trace || '' };
});

// How many times the model was asked for a reply (every phase, every round), from the trace the app saves for
// each reply (trace.js, Settings → Lab, on by default). `calls` from --llm only counts the native server's
// completions, so it is null on a real runtime; a round is the thing a phone pays for, so it is counted here.
// agent.js writes the trace without waiting for it (storage.write(...).catch), so the file can land a moment
// after the turn ends: it is given ~3 s to appear.
const roundsOf = (trace) => (trace ? page.evaluate(async (path) => {
  try {
    const st = await import('/src/storage.js');
    let text = null;
    for (let i = 0; i < 15 && text == null; i++) { text = await st.read(path); if (text == null) await new Promise(r => setTimeout(r, 200)); }
    if (text == null) return { error: `trace ${path} never arrived` };
    const file = JSON.parse(text);
    const convs = file.convs || [];
    return { rounds: convs.reduce((n, c) => n + (c.rounds || []).length, 0), convs: convs.length,
      think: convs.reduce((n, c) => n + (c.rounds || []).reduce((m, r) => m + ((r.output && r.output.thinking) || '').length, 0), 0) };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}, trace) : Promise.resolve(null));

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
// On the bash surface every call is `bash`: what a command did counts as the tool it stands for, so the same
// cases grade both surfaces (gh repo list → github_list_repos, curl → fetch_url, …).
const COMMANDS = [[/\bgh\s+repo\s+list\b/, 'github_list_repos'], [/\b(git\s+clone|gh\s+repo\s+clone)\b/, 'git_clone'], [/\bcurl\b/, 'fetch_url'],
  [/(^|[|;&]\s*|\$\(\s*)search\b/, 'web_search'], [/(^|[|;&]\s*)wiki\b/, 'wiki_lookup'], [/(^|[|;&]\s*)node\b/, 'run_js'], [/\bbc\b|\$\(\(/, 'calculate'],
  [/(^|[|;&]\s*)(grep|rg)\b/, 'grep'], [/(^|[|;&]\s*)(cat|head|tail|sed\s+-n)\b/, 'read_file'], [/(^|[|;&]\s*)(ls|find|tree)\b/, 'list_files'], [/>\s*\S/, 'write_file']];
const commandTools = (t) => (t.name === 'bash' ? COMMANDS.filter(([r]) => r.test(String((t.args && t.args.command) || ''))).map(([, n]) => n) : []);
// Every check a case makes, so a score is "checks that held / checks made" instead of pass-or-fail: one wrong
// claim in a good answer and a wholly wrong answer are not the same thing (Hermes's core_tool_deferral battery
// grades 0..1 partial credit per task; see docs/evals.md).
function checkCount(c) {
  return [c.expect, c.reject, c.expectUrlFromTools, c.file, c.maxRounds, c.maxWords, c.maxToolCalls, c.noRepeat].filter(Boolean).length
    + (c.tools || []).length + (c.noTools || []).length;
}

function grade(c, reply, { rounds = null } = {}) {
  const problems = [];
  const text = (reply && reply.content) || '';
  if (c.maxRounds && rounds != null && rounds > c.maxRounds) problems.push(`${rounds} rounds (at most ${c.maxRounds})`);
  if (c.maxWords) { const n = text.trim().split(/\s+/).filter(Boolean).length; if (n > c.maxWords) problems.push(`${n} words (at most ${c.maxWords})`); }
  const calls = (reply && reply.tools) || [];
  if (c.maxToolCalls && calls.length > c.maxToolCalls) problems.push(`${calls.length} tool calls (at most ${c.maxToolCalls})`);
  if (c.noRepeat) {
    // The same call, arguments and all, run twice in one reply: a page fetched again when it is already saved,
    // the same grep twice. The app has this rule for a resumed turn (resume.js repeatKey); a case can ask for it
    // within one turn too.
    const seen = new Set();
    for (const x of calls) {
      const key = `${x.name} ${JSON.stringify(x.args || {})}`;
      if (seen.has(key)) { problems.push(`ran the same call twice: ${String(key).slice(0, 80)}`); break; }
      seen.add(key);
    }
  }
  const names = ((reply && reply.tools) || []).flatMap(t => [t.name, ...commandTools(t)]);
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

const results = { model: MODEL, surface: SURFACE, mode: MODE, small: SMALL, ctx: CTX, live: LIVE, date: new Date().toISOString(), cases: [], errors };
let passed = 0;
for (const c of cases) {
  await page.evaluate(async () => { const s = await import('/src/sessions.js'); const ch = await import('/src/ui/chat.js'); ch.openSession(s.newSession()); window.__llmLog = []; });
  const turns = [];
  let last = null;
  const t = Date.now();
  for (const text of c.messages) {
    const r = await send(text);
    turns.push({ text, timedOut: r.timedOut, reply: r.reply });
    last = r;
  }
  // Interactive fairness (Hermes's rule, docs/evals.md): a reply that ends by asking the user something gets the
  // case's scripted answer, at most twice, and the roundtrips are recorded instead of counted as a failure.
  // Without this every case a model is right to ask about scores 0, which poisons the battery — and asking
  // instead of guessing is what the small-model prompt tells it to do after two or three attempts.
  const asked = (reply) => Boolean(reply && (((reply.tools || []).some(x => x.name === 'ask_user' || x.name === 'need'))
    || /\?\s*$/.test(String(reply.content || '').trim())));
  const scripted = [...(c.replies || [])];
  let roundtrips = 0;
  while (scripted.length && roundtrips < 2 && last && !last.timedOut && asked(last.reply)) {
    const r = await send(scripted.shift());
    roundtrips++;
    turns.push({ text: r && 'scripted', scripted: true, timedOut: r.timedOut, reply: r.reply });
    last = r;
  }
  const trace = last && last.reply && last.reply.trace ? await roundsOf(last.reply.trace) : null;
  const rounds = trace && trace.rounds != null ? trace.rounds : (last && last.reply && last.reply.llm && last.reply.llm.length) || null;
  if (trace && trace.error) console.log(`       (no round count: ${trace.error})`);
  const problems = last && last.timedOut ? ['timed out'] : grade(c, last && last.reply, { rounds });
  if (c.file && !(last && last.timedOut)) {
    const got = await page.evaluate(async (p) => (await import('/src/tools/workspace.js')).readAgentFile(p), c.file[0]).catch(() => null);
    if (got == null) problems.push(`${c.file[0]} wasn't written`); else if (!re(c.file[1]).test(got)) problems.push(`${c.file[0]} lacks /${c.file[1]}/`);
  }
  const ok = problems.length === 0;
  if (ok) passed++;
  const lr = last && last.reply;
  const calls = lr && lr.llm ? lr.llm.length : null;
  const toolTokens = lr && lr.window && lr.window.parts ? lr.window.parts.tools : null;
  const checks = checkCount(c);
  // Partial credit: the checks that held. A timed-out case scores 0 and stays in the denominator (same-denominator
  // rule, docs/evals.md), but ab.mjs leaves it out of the rounds and wall means.
  const score = checks ? Math.max(0, (checks - problems.length) / checks) : (ok ? 1 : 0);
  const toolCalls = lr && lr.tools ? lr.tools.length : null;
  results.cases.push({ id: c.id, name: c.name, ok, score, checks, problems, ms: Date.now() - t, rounds, calls, toolCalls,
    thinkChars: trace ? trace.think : null, convs: trace ? trace.convs : null, roundtrips, timedOut: Boolean(last && last.timedOut), toolTokens, turns });
  const reply = String((last && last.reply && last.reply.content) || '').replace(/\s+/g, ' ').slice(0, 160);
  const tools = ((last && last.reply && last.reply.tools) || []).map(x => (x.name === 'bash' ? `$ ${String((x.args && x.args.command) || '').slice(0, 70)}` : x.name)).join(' · ');
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(c.id).padStart(2)} ${c.name}  (${((Date.now() - t) / 1000).toFixed(0)} s${rounds != null ? `, ${rounds} rounds` : ''}${roundtrips ? `, ${roundtrips} scripted replies` : ''}${toolTokens != null ? `, tool definitions ${toolTokens} tokens` : ''}, score ${score.toFixed(2)})${ok ? '' : '\n       ' + problems.join('; ')}\n       tools: ${tools || '(none)'}\n       reply: ${reply}`);
}
results.passed = passed; results.total = cases.length;
results.score = results.cases.reduce((n, c) => n + c.score, 0) / (cases.length || 1);
console.log(`\n${passed}/${cases.length} passed, mean score ${results.score.toFixed(2)} (${MODEL}, ${MODE})`);
if (errors.length) console.log('page errors:', errors.slice(0, 5).join('\n'));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(results, null, 1));
console.log(`written to ${OUT}`);
await ctx.close(); await close(); process.exit(passed === cases.length ? 0 : 1);
