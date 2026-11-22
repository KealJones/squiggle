// Which Chrome switches give WebGPU a real GPU on this machine? Tries a few flag sets in headless Chromium and
// prints, for each: the adapter (vendor, architecture, description), shader-f16, the largest buffer, and a timed
// matrix multiply on the GPU. Made for a headless Linux GPU box (an HF Job): Chrome's WebGPU there needs Vulkan and
// the right switches, and gets SwiftShader (the CPU) or nothing when they're wrong. The first set that finds a
// hardware adapter is printed as SQUIGGLE_CHROME_ARGS / SQUIGGLE_CHANNEL for tests/eval/run.mjs.
//
//   node tests/eval/gpu-probe.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }

const VK = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan', '--use-angle=vulkan', '--use-vulkan=native', '--disable-vulkan-surface'];
const SETS = [
  // Google Chrome itself, as the Chrome team's Colab T4 guide uses (developer.chrome.com/docs/web-platform/webgpu/colab-headless).
  { name: 'Google Chrome + Vulkan', channel: 'chrome', args: VK },
  { name: 'new headless + Vulkan', channel: 'chromium', args: VK },
  { name: 'new headless + Vulkan + webgpu-developer', channel: 'chromium', args: [...VK, '--enable-dawn-features=allow_unsafe_apis', '--enable-webgpu-developer-features'] },
  { name: 'headless shell + Vulkan', channel: undefined, args: VK },
  { name: 'repo default', channel: undefined, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] },
];

const probe = async () => {
  if (!navigator.gpu) return { error: 'no navigator.gpu' };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return { error: 'requestAdapter returned null' };
  const info = adapter.info || {};
  const out = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
    fallback: Boolean(adapter.isFallbackAdapter || info.isFallbackAdapter), f16: adapter.features.has('shader-f16'),
    maxBuffer: adapter.limits.maxBufferSize, maxStorage: adapter.limits.maxStorageBufferBindingSize };
  // 1024² f32 matmul, 8 times: a rough GPU speed check (a T4 should be in the low milliseconds, SwiftShader seconds).
  const device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } });
  const N = 1024, bytes = N * N * 4;
  const mk = (usage) => device.createBuffer({ size: bytes, usage });
  const a = mk(GPUBufferUsage.STORAGE), b = mk(GPUBufferUsage.STORAGE), c = mk(GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const code = `@group(0) @binding(0) var<storage, read> a: array<f32>; @group(0) @binding(1) var<storage, read> b: array<f32>;
    @group(0) @binding(2) var<storage, read_write> c: array<f32>;
    @compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
      let n = ${N}u; if (g.x >= n || g.y >= n) { return; } var s = 0.0;
      for (var k = 0u; k < n; k++) { s += a[g.y * n + k] * b[k * n + g.x]; } c[g.y * n + g.x] = s; }`;
  const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
  const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [a, b, c].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  const run = async (times) => {
    const t0 = performance.now();
    for (let i = 0; i < times; i++) {
      const enc = device.createCommandEncoder(); const pass = enc.beginComputePass();
      pass.setPipeline(pipe); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(N / 16, N / 16); pass.end();
      device.queue.submit([enc.finish()]);
    }
    await device.queue.onSubmittedWorkDone();
    return performance.now() - t0;
  };
  await run(1);
  out.matmulMs = Math.round(await run(8) / 8 * 10) / 10;
  out.gflops = Math.round(2 * N ** 3 / (out.matmulMs / 1000) / 1e9);
  return out;
};

let found = null;
for (const set of SETS) {
  let browser;
  const t0 = Date.now();
  try {
    browser = await chromium.launch({ headless: true, args: set.args, ...(set.channel ? { channel: set.channel } : {}) });
    const page = await browser.newPage();
    await page.goto('https://example.com/').catch(() => page.goto('about:blank'));
    let r;
    try { r = await Promise.race([page.evaluate(probe), new Promise((_, no) => setTimeout(() => no(new Error('probe timed out (60 s)')), 60000))]); }
    catch (e) { r = { error: String(e && e.message || e).split('\n')[0] }; }
    console.log(JSON.stringify({ set: set.name, ms: Date.now() - t0, ...r }));
    const gpuPage = await browser.newPage().then(async (p) => { await p.goto('chrome://gpu').catch(() => {}); await new Promise((ok) => setTimeout(ok, 1500)); return p.evaluate(() => document.body.innerText).catch(() => ''); }).catch(() => '');
    const lines = gpuPage.split('\n').filter(l => /WebGPU|Vulkan|GL_RENDERER|GL_VENDOR|Driver vendor|Driver version|GPU0|GPU1|Disabled|Software|crash|error|fail/i.test(l));
    if (lines.length) console.log('  chrome://gpu: ' + lines.slice(0, 24).join(' | '));
    if (!found && !r.error && !r.fallback && !/swiftshader|llvmpipe|software/i.test(`${r.vendor} ${r.architecture} ${r.description}`)) found = set;
  } catch (e) {
    console.log(JSON.stringify({ set: set.name, ms: Date.now() - t0, error: String(e && e.message || e).split('\n')[0] }));
  } finally { await browser?.close().catch(() => {}); }
}
if (found) {
  console.log(`\nHARDWARE WEBGPU: ${found.name}`);
  console.log(`SQUIGGLE_CHROME_ARGS="${found.args.join(' ')}"${found.channel ? ` SQUIGGLE_CHANNEL=${found.channel}` : ''}`);
} else console.log('\nNO HARDWARE WEBGPU: every set came back with no adapter or a software one');
process.exit(found ? 0 : 2);
