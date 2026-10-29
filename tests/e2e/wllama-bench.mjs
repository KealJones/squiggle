// Real small model on wllama in headless Chromium: one thread vs several cores
// (page cross-origin isolated, as sw.js does with the "Use all CPU cores"
// setting), and WebGPU when the browser has it. Prints load info and speed.
// Not part of the e2e suite (it downloads the model).
//
//   node tests/e2e/wllama-bench.mjs [--model SQ] [--prompt "…"] [--tokens 64]
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }

const arg = (name, dflt) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : dflt;
const MODEL = arg('--model', 'SQ');
const PROMPT = arg('--prompt', 'Explain in a few sentences why the sky is blue, then list three colours of sunsets.');
const TOKENS = Number(arg('--tokens', 64));
const APP = new URL('../../app/', import.meta.url).pathname;
const CSP = readFileSync(join(APP, 'index.html'), 'utf8').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };

const PAGE = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>wllama bench</title>
<script type="module" src="/bench.js"></script>`;
const BENCH_JS = `
  import { MODELS } from '/src/engine.js';
  import { createEngine, lastSpeed } from '/src/engine-wllama.js';
  window.run = async ({ gpu, threads, prompt, tokens }) => {
    const t0 = performance.now();
    const eng = await createEngine(MODELS['${MODEL}'].url, 2048, () => {}, { gpu, threads });
    const loadMs = Math.round(performance.now() - t0);
    const conv = await eng.createConversation({ preface: { messages: [] }, sessionConfig: { maxOutputTokens: tokens } });
    let text = '';
    for await (const x of conv.sendMessageStreaming(prompt)) if (x && x.content) text += x.content;
    const out = { info: eng.info, loadMs, speed: lastSpeed(), isolated: crossOriginIsolated, cores: navigator.hardwareConcurrency, text: text.slice(0, 160) };
    await eng.delete();
    return out;
  };
  window.ready = true;
`;

function serve(isolate) {
  const srv = http.createServer((req, res) => {
    const iso = isolate ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' } : {};
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/') { res.writeHead(200, { 'Content-Type': 'text/html', ...iso }); return res.end(PAGE); }
    if (path === '/bench.js') { res.writeHead(200, { 'Content-Type': 'text/javascript', ...iso }); return res.end(BENCH_JS); }
    const file = normalize(join(APP, path));
    if (!file.startsWith(APP) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', ...iso });
    res.end(readFileSync(file));
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
const runs = [
  { name: '1 thread', isolate: false, gpu: false, threads: false },
  { name: 'all cores (isolated)', isolate: true, gpu: false, threads: true },
  { name: 'WebGPU', isolate: false, gpu: true, threads: false },
];
for (const r of runs) {
  const srv = await serve(r.isolate);
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 200)); });
  await page.goto(`http://127.0.0.1:${srv.address().port}/`);
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  try {
    const out = await page.evaluate((o) => window.run(o), { gpu: r.gpu, threads: r.threads, prompt: PROMPT, tokens: TOKENS });
    console.log(`${r.name}: ${JSON.stringify(out)}`);
  } catch (e) { console.log(`${r.name}: FAILED ${e.message.slice(0, 300)}`); }
  await page.close();
  srv.close();
}
await browser.close();
