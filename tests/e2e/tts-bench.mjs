// Real neural voice in headless Chromium: loads app/src/tts-worker.js under the
// app's CSP, downloads the real model from Hugging Face, and measures load time,
// real-time factor and memory (RSS of the tab's renderer process, and of all
// Chromium processes). Not part of the e2e suite (it downloads the model).
//
//   node tests/e2e/tts-bench.mjs [--model kokoro|kitten] [--voice af_heart] [--wav out-dir]
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, extname, normalize } from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }

const arg = (name, dflt) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : dflt;
const MODEL = arg('--model', 'kokoro');
const VOICE = arg('--voice', '');
const WAV = arg('--wav', '');
const APP = new URL('../../app/', import.meta.url).pathname;
const CSP = readFileSync(join(APP, 'index.html'), 'utf8').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };

const PAGE = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>tts bench</title><script type="module" src="/bench.js"></script>`;
const BENCH_JS = `
  window.violations = [];
  document.addEventListener('securitypolicyviolation', e => violations.push(e.violatedDirective + ' ' + e.blockedURI));
  window.bench = (model, voice, sentences) => new Promise((resolve, reject) => {
    const w = new Worker('/src/tts-worker.js', { type: 'module' });
    window.w = w;
    const t0 = performance.now(), res = { stages: [], speak: [] };
    let id = 0, last = 0;
    w.onerror = (e) => reject(new Error('worker error: ' + (e.message || 'load failed')));
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'stage') res.stages.push([m.stage, Math.round(performance.now() - t0)]);
      else if (m.type === 'progress') { res.total = m.total; if (performance.now() - last > 2000) { last = performance.now(); console.log('progress ' + m.loaded + '/' + m.total); } }
      else if (m.type === 'ready') { res.loadMs = Math.round(performance.now() - t0); res.workerLoadMs = m.ms; res.cached = m.cached; window.__ready = true; next(); }
      else if (m.type === 'audio') {
        const s = m.samples; let sum = 0, peak = 0, zc = 0;
        for (let i = 0; i < s.length; i++) { sum += s[i] * s[i]; peak = Math.max(peak, Math.abs(s[i])); if (i && (s[i] >= 0) !== (s[i - 1] >= 0)) zc++; }
        const audioMs = 1000 * s.length / m.sampleRate;
        res.speak.push({ text: sentences[m.id], synthMs: m.ms, audioMs: Math.round(audioMs), rtf: +(m.ms / audioMs).toFixed(3), rms: +Math.sqrt(sum / s.length).toFixed(4), peak: +peak.toFixed(3), zcr: +(zc / s.length).toFixed(4), nan: s.some(Number.isNaN) });
        (window.wavs = window.wavs || []).push(Array.from(s));
        next();
      }
      else if (m.type === 'error') reject(new Error(m.message));
    };
    const next = () => { if (id < sentences.length) { window.__speaking = true; w.postMessage({ type: 'speak', id, text: sentences[id++], speed: 1, voice }); } else { window.__speaking = false; resolve(res); } };
    w.postMessage({ type: 'load', model, voice });
  });
`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/bench.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); return; }
  if (u.pathname === '/bench.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(BENCH_JS); return; }
  const p = normalize(join(APP, u.pathname));
  if (!p.startsWith(APP) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(p));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/bench.html`;

// Resident memory of the tab's renderer process (the one a phone kills), in MB.
function rendererMB(pid) {
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,args=']).toString().trim().split('\n').map(l => l.trim().split(/\s+/));
  const kids = new Map();
  for (const [p, pp] of out) { if (!kids.has(+pp)) kids.set(+pp, []); kids.get(+pp).push(+p); }
  const info = new Map(out.map(([p, , r, ...a]) => [+p, { rss: +r, args: a.join(' ') }]));
  let best = 0; const stack = [...(kids.get(pid) || [])];
  while (stack.length) { const p = stack.pop(); const i = info.get(p); if (i && /--type=renderer/.test(i.args) && !/extension/.test(i.args)) best = Math.max(best, i.rss); stack.push(...(kids.get(p) || [])); }
  return Math.round(best / 1024);
}

// Sum of resident memory of the browser and all its child processes, in MB.
function rssMB(pid) {
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=']).toString().trim().split('\n').map(l => l.trim().split(/\s+/).map(Number));
  const kids = new Map();
  for (const [p, pp] of out) { if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(p); }
  const rss = new Map(out.map(([p, , r]) => [p, r]));
  let total = 0; const stack = [...(kids.get(pid) || [])];
  while (stack.length) { const p = stack.pop(); total += rss.get(p) || 0; stack.push(...(kids.get(p) || [])); }
  return Math.round(total / 1024);
}

const SENTENCES = [
  'Hi! I checked the repo, and the build is passing again.',
  'The relay forwards the device-flow login, because GitHub does not send CORS headers for it.',
  'On your phone, Gemma 3 runs on the CPU, so replies take a few seconds longer.',
  'It costs $4.50 a month, and the meeting moved to 3:30 on March 12th.',
  'Want me to open a pull request?',
];

const browser = await chromium.launch();
const pid = process.pid; // Chromium runs as children of this process; its own RSS is subtracted below
const results = [];
// One context for both runs, so the second load comes from Cache Storage.
const ctx = await browser.newContext();
for (const run of ['cold', 'warm']) {
  const page = await ctx.newPage();
  page.on('console', m => { if (/progress/.test(m.text())) process.stdout.write('  ' + m.text() + '\r'); else if (m.type() === 'error' || m.type() === 'warning') console.log('  [console]', m.text().slice(0, 300)); });
  page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 300)));
  await page.goto(url);
  await page.waitForTimeout(500);
  const before = rssMB(pid), rBefore = rendererMB(pid);
  let peakLoad = before, peakSpeak = before, rPeak = rBefore;
  const sampler = setInterval(async () => {
    try {
      const m = rssMB(pid);
      rPeak = Math.max(rPeak, rendererMB(pid));
      const st = await page.evaluate(() => ({ ready: Boolean(window.__ready), speaking: Boolean(window.__speaking) })).catch(() => ({}));
      if (!st.ready) peakLoad = Math.max(peakLoad, m); else peakSpeak = Math.max(peakSpeak, m);
    } catch {}
  }, 150);
  const t0 = Date.now();
  let r;
  try {
    r = await page.evaluate(([m, v, s]) => window.bench(m, v, s), [MODEL, VOICE, SENTENCES]);
  } catch (e) {
    clearInterval(sampler);
    console.log(`\n${run}: FAILED after ${Date.now() - t0} ms: ${e.message}`);
    console.log('CSP violations:', await page.evaluate(() => window.violations));
    process.exitCode = 1;
    break;
  }
  clearInterval(sampler);
  const afterSpeak = rssMB(pid), rAfter = rendererMB(pid);
  const violations = await page.evaluate(() => window.violations);
  if (WAV && run === 'warm') {
    mkdirSync(WAV, { recursive: true });
    const wavs = await page.evaluate(() => window.wavs);
    wavs.forEach((s, i) => writeFileSync(join(WAV, `${MODEL}-${i}.wav`), wav(Float32Array.from(s), 24000)));
  }
  await page.evaluate(() => { window.w.terminate(); });
  await page.waitForTimeout(1500);
  const afterTerminate = rssMB(pid);
  await page.close();
  const audioMs = r.speak.reduce((n, x) => n + x.audioMs, 0), synthMs = r.speak.reduce((n, x) => n + x.synthMs, 0);
  results.push({ run, ...r, mem: { beforeMB: before, peakDuringLoadMB: peakLoad, peakWhileSpeakingMB: peakSpeak, afterSpeakMB: afterSpeak, afterTerminateMB: afterTerminate, rendererBeforeMB: rBefore, rendererPeakMB: rPeak, rendererAfterSpeakMB: rAfter, rendererAfterTerminateMB: rendererMB(pid) }, totalRtf: +(synthMs / audioMs).toFixed(3), violations });
  console.log(`\n${run}: load ${r.loadMs} ms (cached: ${r.cached}), RTF ${(synthMs / audioMs).toFixed(2)} over ${(audioMs / 1000).toFixed(1)} s of audio; memory ${before} → peak ${Math.max(peakLoad, peakSpeak)} MB (load peak ${peakLoad}, speaking ${peakSpeak}), after terminate ${afterTerminate} MB; tab renderer ${rBefore} → peak ${rPeak} MB, ${rAfter} MB after speaking; CSP violations: ${violations.length}`);
}
console.log(JSON.stringify({ model: MODEL, voice: VOICE || '(default)', cpu: execFileSync('nproc').toString().trim() + ' cores', results }, null, 1));
await browser.close();
server.close();

function wav(samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), 44 + i * 2));
  return b;
}
