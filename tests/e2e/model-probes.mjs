// Behaviour probes for a native-tool small model on wllama (the app's own runtime and the GGUF's own chat
// template), in headless Chromium. Each probe comes in matched pairs that differ in one thing, so a failure
// says what the model can't do: e.g. the same name typed in one message vs given in a later turn, the same
// weather text pasted by the user vs returned by a tool, a tool declared vs only listed by name.
// Not part of the e2e suite (it downloads the model).
//
//   node tests/e2e/model-probes.mjs [--model TG4 | --url <gguf>] [--modes greedy,app] [--tokens 320] [--only <part of a name>] [--out file.json]
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }

const arg = (name, dflt) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : dflt;
const MODEL = arg('--model', 'TG4');
const URL_OVERRIDE = arg('--url', '');                     // any GGUF, e.g. the E2B teacher, instead of a MODELS entry
const MODES = arg('--modes', 'greedy').split(',');
const TOKENS = Number(arg('--tokens', 320));
const ONLY = arg('--only', '');
const OUT = arg('--out', '');
const APP = new URL('../../app/', import.meta.url).pathname;
const CSP = readFileSync(join(APP, 'index.html'), 'utf8').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };

// ── Tools, as the app declares them (tools.js / tasks.js) ───────────────────
const S = (props, required) => ({ type: 'object', properties: props, required });
const fn = (name, description, parameters) => ({ type: 'function', function: { name, description, parameters } });
const WEB_SEARCH = fn('web_search', 'Search the web (DuckDuckGo). Returns a short summary when one exists, plus titles, links and snippets. To read a result in full, pass its url to fetch_url.',
  S({ query: { type: 'string', description: 'What to search for' }, count: { type: 'number', description: 'How many results (default 6, max 10)' } }, ['query']));
const FETCH_URL = fn('fetch_url', 'Read a web page as text.', S({ url: { type: 'string', description: 'The page address' } }, ['url']));
const RECALL = fn('recall', 'Search saved memory facts.', S({ query: { type: 'string', description: 'What to look for' } }, ['query']));
const TOOL_INFO = fn('tool_info', 'Get how to call tools from the "other tools" list. Ask for every tool you expect to need at once. They are ready to call after this.',
  S({ names: { type: 'array', items: { type: 'string' }, description: 'Tool names from the list, e.g. ["read_file", "grep"]' } }, ['names']));
const BASE = [WEB_SEARCH, FETCH_URL];
const SYSTEM = 'You are Squiggle, a helpful assistant that figures things out. Use tools to look up what you don\'t know instead of guessing.';
const GATED_SYSTEM = SYSTEM + '\nOther tools: recall, remember, read_file, write_file, grep, calculate, git_clone. Before calling one, get how with tool_info(names); ask for every one you expect to need at once.';

// The app's own setup for tiny Gemma with Settings → Small-model mode on (agent.js LITE_SYSTEM_NATIVE + the gated
// tool names; GATE's tools declared: plan, done, need, find, checkpoint, tool_info, web_search, fetch_url).
const APP_SMALL_SYSTEM = [
  'You are Squiggle, an assistant that figures things out. Think first. If you',
  'don\'t know something, don\'t guess: find it or look it up. For anything with',
  'more than one step, make a plan, then do one step at a time.',
  'Start with plan, done, need and find; find tells you which of your other tools fits.',
  'Arguments: plan(goal, steps), done(result), need(what), find(query).',
  'Other tools: recall, remember, read_file, write_file, grep, calculate, git_clone. Before calling one, get how with tool_info(names); ask for every one you expect to need at once.',
].join('\n');
const HARNESS = [
  fn('plan', 'Make a plan for a request that takes more than one step, then work it one step at a time. Calling it again revises the plan; finished steps keep their results.', S({ goal: { type: 'string', description: 'What the user wants, in one line' }, steps: { type: 'array', items: { type: 'string' }, description: 'Short imperative steps, e.g. "Find where the login form is defined"' } }, ['goal', 'steps'])),
  fn('done', 'Finish the current step. result = the facts the rest of the task needs (paths, numbers, names, decisions), one to three lines.', S({ result: { type: 'string', description: 'What this step found or did' } }, ['result'])),
  fn('need', 'Say what is missing to go on. Squiggle searches for it, and asks the user if it can\'t be found.', S({ what: { type: 'string', description: 'What you need, e.g. "which repo the site lives in"' } }, ['what'])),
  fn('find', 'Search everything Squiggle knows: tools (and how to call them), recipes from past tasks, memory, past chats and this task\'s earlier results.', S({ query: { type: 'string', description: 'What you are looking for, in plain words' } }, ['query'])),
];
const sys = (s = SYSTEM) => ({ role: 'system', content: s });
const user = (c) => ({ role: 'user', content: c });
const said = (c) => ({ role: 'assistant', content: c });
const searchedFor = (q) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: q }) } }] });
const result = (obj) => ({ role: 'tool', tool_call_id: 'c1', name: 'web_search', content: JSON.stringify(obj) });
const weather = (t, sky) => ({ results: [{ title: 'Phoenix, AZ Weather', snippet: `${t}°F, ${sky}, wind 9 mph` }] });

// ── Checks on { text, calls: [{name, args}] } ──────────────────────────────
const call = (name, ...words) => (r) => r.calls.length === 1 && r.calls[0].name === name &&
  words.every(w => JSON.stringify(r.calls[0].args).toLowerCase().includes(w));
const answers = (want, notWant) => (r) => !r.calls.length && r.text.includes(want) && !r.text.includes(notWant);
const failedPlainly = (r) => (r.calls.length === 1 && r.calls[0].name === 'web_search') ||
  (!r.calls.length && !/\d+\s*°/.test(r.text) && /couldn|could not|error|timed? ?out|try again|unable|failed|didn't work|wasn't able/i.test(r.text));

const PROBES = [
  // 1. Reading a later turn: the same request in one message vs spread over two.
  { name: '1a name in one message', messages: [sys(), user('search the web for patrick stewart')], tools: BASE, pass: call('web_search', 'stewart') },
  { name: '1b name given in turn 2', messages: [sys(), user('look up an actor for me'), said('Sure, which actor?'), user('just use the web_search tool for "patrick stewart"')], tools: BASE, pass: call('web_search', 'stewart') },
  { name: '1c star trek, detail in turn 2', messages: [sys(), user('can you find out the name of the man who was in star trek that recently died?'),
    said('Sure. Do you remember anything else about him, like which Star Trek series he was in?'), user('literally just search the web for like "death star trek" and look for the latest results man')], tools: BASE, pass: call('web_search', 'star trek') },
  // 2. Reading a tool result: the same text pasted by the user vs returned by web_search, and two values.
  { name: '2a 61F pasted by the user', messages: [sys(), user(`a weather site says: "Phoenix, AZ Weather - 61°F, light rain, wind 9 mph". what's it like outside in phoenix rn`)], tools: BASE, pass: answers('61', '97') },
  { name: '2b 61F as a tool result', messages: [sys(), user("what's it like outside in phoenix rn"), searchedFor('Phoenix weather now'), result(weather(61, 'light rain'))], tools: BASE, pass: answers('61', '97') },
  { name: '2c 97F pasted by the user', messages: [sys(), user(`a weather site says: "Phoenix, AZ Weather - 97°F, clear and sunny, wind 9 mph". what's it like outside in phoenix rn`)], tools: BASE, pass: answers('97', '61') },
  { name: '2d 97F as a tool result', messages: [sys(), user("what's it like outside in phoenix rn"), searchedFor('Phoenix weather now'), result(weather(97, 'clear and sunny'))], tools: BASE, pass: answers('97', '61') },
  { name: '2e tool error', messages: [sys(), user("what's it like outside in phoenix rn"), searchedFor('Phoenix weather now'), result({ error: 'search service timed out' })], tools: BASE, pass: failedPlainly },
  // 3. Choosing a tool from its description: declared vs only listed by name (the app's gated tools).
  { name: '3a recall declared', messages: [sys(), user('What do you remember about me?')], tools: [...BASE, RECALL], pass: call('recall') },
  { name: '3b recall listed by name only', messages: [sys(GATED_SYSTEM), user('What do you remember about me?')], tools: [...BASE, TOOL_INFO], pass: call('tool_info', 'recall') },
  // 4. The same as 1b, 1c, 2b and 3b, but with the app's small-model-mode prompt and declared tools.
  { name: '4a app small mode: name given in turn 2', messages: [sys(APP_SMALL_SYSTEM), user('look up an actor for me'), said('Sure, which actor?'), user('just use the web_search tool for "patrick stewart"')], tools: [...HARNESS, TOOL_INFO, ...BASE], pass: call('web_search', 'stewart') },
  { name: '4b app small mode: star trek, detail in turn 2', messages: [sys(APP_SMALL_SYSTEM), user('can you find out the name of the man who was in star trek that recently died?'),
    said('Sure. Do you remember anything else about him, like which Star Trek series he was in?'), user('literally just search the web for like "death star trek" and look for the latest results man')], tools: [...HARNESS, TOOL_INFO, ...BASE], pass: call('web_search', 'star trek') },
  { name: '4c app small mode: 61F as a tool result', messages: [sys(APP_SMALL_SYSTEM), user("what's it like outside in phoenix rn"), searchedFor('Phoenix weather now'), result(weather(61, 'light rain'))], tools: [...HARNESS, TOOL_INFO, ...BASE], pass: answers('61', '97') },
  { name: '4d app small mode: remember about me', messages: [sys(APP_SMALL_SYSTEM), user('What do you remember about me?')], tools: [...HARNESS, TOOL_INFO, ...BASE], pass: (r) => r.calls.length === 1 && ((r.calls[0].name === 'tool_info' && JSON.stringify(r.calls[0].args).includes('recall')) || (r.calls[0].name === 'find' && /me|user|remember|memory/i.test(JSON.stringify(r.calls[0].args)))) },
].filter(p => !ONLY || p.name.includes(ONLY));

const PAGE = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>model probes</title>
<script type="module" src="/probe.js"></script>`;
const PROBE_JS = `
  import { MODELS } from '/src/engine.js';
  const VERSION = '3.8.1';
  const { Wllama } = await import('https://cdn.jsdelivr.net/npm/@wllama/wllama@' + VERSION + '/esm/index.min.js');
  let w = null;
  window.load = async () => {
    w = new Wllama({ default: 'https://cdn.jsdelivr.net/npm/@wllama/wllama@' + VERSION + '/esm/wasm/wllama.wasm' }, { suppressNativeLog: true });
    const n = crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    const t0 = performance.now();
    await w.loadModelFromUrl(${JSON.stringify(URL_OVERRIDE)} || MODELS['${MODEL}'].url, { n_ctx: 4096, n_gpu_layers: 0, n_threads: n, jinja: true });
    return { loadMs: Math.round(performance.now() - t0), threads: n, label: ${JSON.stringify(URL_OVERRIDE)} || MODELS['${MODEL}'].label };
  };
  // Same settings as NativeConversation: the GGUF's template with tools and thinking, llama.cpp's parsed calls.
  window.probe = async ({ messages, tools, mode, tokens }) => {
    const t0 = performance.now();
    const stream = await w.createChatCompletion({ messages, tools, chat_template_kwargs: { enable_thinking: true }, stream: true,
      max_tokens: tokens, temperature: mode === 'greedy' ? 0 : 0.7, top_k: 64, top_p: 0.95, penalty_repeat: 1.15, cache_prompt: false, seed: 1 });
    let text = '', thinking = ''; const parts = [];
    for await (const chunk of stream) {
      const d = (chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta) || {};
      if (d.reasoning_content) thinking += d.reasoning_content;
      if (d.content) text += d.content;
      for (const tc of d.tool_calls || []) {
        const p = parts[tc.index || 0] = parts[tc.index || 0] || { name: '', args: '' };
        if (tc.function && tc.function.name) p.name += tc.function.name;
        if (tc.function && tc.function.arguments) p.args += tc.function.arguments;
      }
    }
    const calls = parts.filter(Boolean).map(p => { let a = p.args; try { a = JSON.parse(p.args || '{}'); } catch {} return { name: p.name, args: a }; });
    return { text: text.trim(), thinking: thinking.trim(), calls, ms: Math.round(performance.now() - t0) };
  };
  window.ready = true;
`;

const srv = http.createServer((req, res) => {
  const iso = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') { res.writeHead(200, { 'Content-Type': 'text/html', ...iso }); return res.end(PAGE); }
  if (path === '/probe.js') { res.writeHead(200, { 'Content-Type': 'text/javascript', ...iso }); return res.end(PROBE_JS); }
  const file = normalize(join(APP, path));
  if (!file.startsWith(APP) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', ...iso });
  res.end(readFileSync(file));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const profile = mkdtempSync(join(tmpdir(), 'model-probes-'));
const browser = await chromium.launchPersistentContext(profile, {});
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:${srv.address().port}/`);
await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
page.setDefaultTimeout(0);
console.log('loaded', JSON.stringify(await page.evaluate(() => window.load())));
const rows = [];
for (const mode of MODES) {
  for (const p of PROBES) {
    const r = await page.evaluate((o) => window.probe(o), { messages: p.messages, tools: p.tools, mode, tokens: TOKENS });
    const ok = Boolean(p.pass(r));
    rows.push({ mode, probe: p.name, pass: ok, ...r });
    const shown = r.calls.length ? r.calls.map(c => `CALL ${c.name}(${JSON.stringify(c.args)})`).join(' ') + (r.text ? ' + ' + r.text : '') : r.text;
    console.log(`${ok ? 'PASS' : 'FAIL'}  [${mode}] ${p.name}  (${(r.ms / 1000).toFixed(0)} s)\n      reply: ${shown.replace(/\s+/g, ' ').slice(0, 220) || '(empty)'}\n      thinking: ${r.thinking.replace(/\s+/g, ' ').slice(0, 260) || '(none)'}`);
    if (OUT) writeFileSync(OUT, JSON.stringify(rows, null, 1));
  }
}
for (const mode of MODES) {
  const m = rows.filter(r => r.mode === mode);
  console.log(`${mode}: ${m.filter(r => r.pass).length}/${m.length} passed`);
}
await browser.close();
srv.close();
