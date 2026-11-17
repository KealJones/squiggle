// One model, several builds: the user picks "LFM3 1.7B" and the device decides how it runs (engine.forDevice).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
function device({ ua = MAC, gpu = true, f16 = true } = {}) {
  const adapter = { features: new Set(f16 ? ['shader-f16'] : []) };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true,
    value: { userAgent: ua, maxTouchPoints: 0, ...(gpu ? { gpu: { requestAdapter: async () => adapter } } : {}) } });
}
device();
const engine = await import('../app/src/engine.js');

test('LFM3 is one model: the GPU build with WebGPU, the CPU build without', () => {
  device({ gpu: true });
  assert.equal(engine.deviceModel(), 'WLF3QAD');
  assert.equal(engine.forDevice('LF3'), 'WLF3QAD', 'a chat saved on a CPU device opens on the GPU build here');
  device({ gpu: false });
  assert.equal(engine.deviceModel(), 'LF3');
  assert.equal(engine.forDevice('WLF3QAD'), 'LF3', 'a chat saved on a GPU device opens on the CPU build here');
  device({ ua: IPHONE, gpu: true });
  assert.equal(engine.deviceModel(), 'WLF3QAD');
  assert.equal(engine.forDevice('cloud'), 'cloud', 'a model without builds is itself');
});

test('only the build this device runs is listed, under one name', () => {
  device({ gpu: true });
  const listed = engine.listedModels({ cloudOffered: true });
  assert.ok(listed.includes('WLF3QAD') && !listed.includes('LF3'), listed.join());
  assert.deepEqual(listed.sort(), ['SQ', 'TG4A', 'WLF3QAD', 'cloud'], 'LFM3 once, Keal\'s two small models, the cloud model');
  assert.equal(engine.MODELS.WLF3QAD.label, engine.MODELS.LF3.label);
  device({ gpu: false });
  assert.ok(engine.listedModels({}).includes('LF3') && !engine.listedModels({}).includes('WLF3QAD'));
});

test('a GPU without 16-bit floats keeps the GPU build (its q4f32 twin); a build that crashed here takes the CPU one', async () => {
  device({ gpu: true, f16: false });
  assert.equal(await engine.probeGpu(), false);
  assert.equal(engine.forDevice('WLF3QAD'), 'WLF3QAD', 'the WebLLM build has a q4f32_1 twin (mlcRecordF32)');
  assert.ok(engine.MODELS.WLF3QAD.mlcRecordF32 && /q4f32_1/.test(engine.MODELS.WLF3QAD.mlcRecordF32.model_lib));
  assert.match(engine.runnerLabel('LF3'), /^on the CPU/);
  assert.match(engine.runnerLabel('WLF3QAD'), /GPU/);
  engine.setAvoided(['WLF3QAD']);
  assert.equal(engine.forDevice('WLF3QAD'), 'LF3');
  engine.setAvoided([]);
});

test('WebGPU without a usable adapter keeps setup and chats on the CPU build', async () => {
  const original = globalThis.navigator;
  try {
    for (const [scenario, requestAdapter] of [
      ['missing', async () => null],
      ['rejected', async () => { throw new Error('GPU unavailable'); }],
    ]) {
      let requests = 0;
      globalThis.navigator = { userAgent: MAC, gpu: { requestAdapter: () => { requests++; return requestAdapter(); } } };
      const engine = await import(`../app/src/engine.js?adapter=${scenario}`);
      const [status, shaderF16] = await Promise.all([engine.webgpuStatus(), engine.probeGpu()]);
      assert.equal(status.ok, false);
      assert.equal(shaderF16, null);
      assert.equal(requests, 1);
      assert.equal(engine.deviceModel(), 'LF3');
      assert.equal(engine.forDevice('LF3'), 'LF3');
      assert.equal(engine.forDevice('WLF3QAD'), 'LF3');
      assert.ok(engine.listedModels().includes('LF3'));
      assert.ok(!engine.listedModels().includes('WLF3QAD'));
    }
  } finally {
    globalThis.navigator = original;
  }
});
