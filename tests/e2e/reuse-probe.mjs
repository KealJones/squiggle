// Prompt-prefix reuse on the real model (prefix-cache.js): the same LFM3 tool-loop prompts, greedy, once with
// reuse off and once on, in headless Chromium on WebGPU. The replies must match, and the second run should read
// far fewer prompt tokens. Not part of the e2e suite (it downloads the model, ~1 GB, and runs it in software).
//
//   node tests/e2e/reuse-probe.mjs [--steps 3] [--tokens 16] [--out file.json]
//
// Needs a real GPU: in the cloud sandbox WebGPU only gets SwiftShader (lavapipe isn't offered to WebGPU), and its
// GPU process dies ~40 s into LFM3's first prompt with reuse off too (2026-11-11). Run it on a computer with a GPU.
// The q4f16 build when the adapter has shader-f16, the q4f32 twin otherwise (engine-webllm.js pickId).
// --args "…" adds Chrome switches; --adapter-only prints the WebGPU adapter and stops.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeGitRoot, start } from './harness.mjs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }
const arg = (n, d) => process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d;
const STEPS = Number(arg('--steps', 3)), TOKENS = Number(arg('--tokens', 16)), OUT = arg('--out', '');

const profile = join(tmpdir(), 'squiggle-reuse-probe'); mkdirSync(profile, { recursive: true });
const { appUrl, close } = await start(makeGitRoot(), {});
// --disable-gpu-watchdog: software GPUs take longer than the watchdog allows for one prompt piece.
const extra = (arg('--args', '') || '').split(' ').filter(Boolean);
const ctx = await chromium.launchPersistentContext(profile, { args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--disable-gpu-watchdog', '--ignore-gpu-blocklist', ...extra] });
const page = ctx.pages()[0] || await ctx.newPage();
const t00 = Date.now();
page.on('console', (m) => { const t = m.text(); if (/Squiggle|error|Error|probe/.test(t) || process.argv.includes('--verbose')) console.log(`  ${Math.round((Date.now() - t00) / 1000)}s [${m.type()}] ${t.slice(0, 240)}`); });
page.on('pageerror', (e) => console.log('  pageerror: ' + String(e).slice(0, 300)));
await page.goto(appUrl + '/');

if (process.argv.includes('--adapter-only')) {
  console.log(await page.evaluate(async () => { const a = await navigator.gpu.requestAdapter(); return a ? `${a.info.vendor}/${a.info.architecture} f16=${a.features.has('shader-f16')}` : 'none'; }));
  await ctx.close(); await close(); process.exit(0);
}
const result = await page.evaluate(async ({ STEPS, TOKENS }) => {
  const adapter = await navigator.gpu.requestAdapter();
  const f16 = Boolean(adapter && adapter.features.has('shader-f16'));
  console.log('probe: adapter', adapter && (adapter.info ? JSON.stringify({ vendor: adapter.info.vendor, arch: adapter.info.architecture, desc: adapter.info.description }) : ''), 'f16', f16, 'maxBuffer', adapter && adapter.limits.maxBufferSize, 'maxStorage', adapter && adapter.limits.maxStorageBufferBindingSize);
  const eng = await import('/src/engine.js');
  const m = eng.MODELS.WLF3QAD;
  const w = await import('/src/engine-webllm.js');
  w.registerModel({ model_id: m.mlc, ...m.mlcRecord }, { version: m.webllm });
  w.registerModel({ model_id: m.mlc.replace('q4f16_1', 'q4f32_1'), ...m.mlcRecordF32 }, { version: m.webllm });
  const tools = [{ type: 'function', function: { name: 'bash', description: 'Run a shell command in the workspace and return its output.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }];
  const system = 'You are Squiggle, a personal AI agent running privately on the user\'s own device. Use the bash tool to look things up in the workspace. Keep answers short. ' + 'Never guess a file\'s contents; read it. '.repeat(12);
  // Fixed calls and results, so both runs see the same prompts whatever the model writes.
  const calls = ['ls /repo', 'wc -l /repo/*.md', 'head -5 /repo/README.md'].slice(0, STEPS);
  const outs = ['README.md\nnotes.md\nsrc\n', '  40 /repo/README.md\n  12 /repo/notes.md\n  52 total\n', '# Demo\nA small demo repo.\n\nIt has notes and a src folder.\n'];
  async function run(reuse) {
    const t0 = performance.now();
    const shim = await w.createShim(m.mlc, 4096, (st) => console.log('probe: ' + st), { format: 'lfm3', reuse, pace: true });
    console.log('probe: loaded, reuse ' + reuse);
    const loadMs = Math.round(performance.now() - t0);
    const msgs = [{ role: 'system', content: system }, { role: 'user', content: 'What files are in my repo and how long is the README?' }];
    const steps = [];
    for (let i = 0; i <= calls.length; i++) {
      const s0 = performance.now();
      let text = '', thinking = '', first = 0;
      const stream = await shim.createChatCompletion({ messages: msgs, tools, chat_template_kwargs: { enable_thinking: true }, max_tokens: TOKENS, temperature: 0, top_p: 1 });
      for await (const c of stream) {
        const d = c.choices[0].delta || {};
        if (!first && (d.reasoning_content || d.content)) first = performance.now();
        thinking += d.reasoning_content || ''; text += d.content || '';
      }
      console.log(`probe: step ${i} done in ${Math.round(performance.now() - s0)} ms: ${JSON.stringify((thinking + '|' + text).slice(0, 80))} ${JSON.stringify(shim.reuse && shim.reuse.last)}`);
      steps.push({ thinking, text, firstMs: Math.round(first - s0), totalMs: Math.round(performance.now() - s0), reuse: shim.reuse && shim.reuse.last });
      if (i < calls.length) {
        msgs.push({ role: 'assistant', content: null, reasoning_content: `I'll run ${calls[i]}.`, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: calls[i] }) } }] });
        msgs.push({ role: 'tool', tool_call_id: 'c' + i, name: 'bash', content: outs[i] });
        if (i > 0) delete msgs[msgs.length - 4].reasoning_content;   // as nativeMessages does: only the live round keeps it
      }
    }
    const totals = shim.reuse;
    await shim.exit();
    return { loadMs, steps, totals };
  }
  const off = await run(false);
  const on = await run(true);
  return { f16, off, on };
}, { STEPS, TOKENS });

const same = result.off.steps.map((s, i) => s.thinking === result.on.steps[i].thinking && s.text === result.on.steps[i].text);
console.log(JSON.stringify({ f16: result.f16, same, off: result.off.steps.map(s => s.firstMs), on: result.on.steps.map(s => s.firstMs), reuse: result.on.steps.map(s => s.reuse), totals: result.on.totals }, null, 1));
for (let i = 0; i < same.length; i++) if (!same[i]) console.log(`step ${i} differs:\n  off: ${JSON.stringify(result.off.steps[i])}\n  on:  ${JSON.stringify(result.on.steps[i])}`);
if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 1));
await ctx.close();
await close();
process.exit(same.every(Boolean) ? 0 : 1);
