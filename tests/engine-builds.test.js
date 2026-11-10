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
  assert.deepEqual(listed.filter(id => !engine.MODELS[id].lab).sort(), ['WLF3QAD', 'cloud']);
  assert.equal(engine.MODELS.WLF3QAD.label, engine.MODELS.LF3.label);
  device({ gpu: false });
  assert.ok(engine.listedModels({}).includes('LF3') && !engine.listedModels({}).includes('WLF3QAD'));
});

test('a GPU without 16-bit floats, and a build that crashed here, take the CPU build', async () => {
  device({ gpu: true, f16: false });
  assert.equal(await engine.probeGpu(), false);
  assert.equal(engine.forDevice('WLF3QAD'), 'LF3', 'the WebLLM build is q4f16 only');
  assert.match(engine.runnerLabel('LF3'), /^on the CPU/);
  assert.match(engine.runnerLabel('WLF3QAD'), /GPU/);
  engine.setAvoided(['WLF3QAD']);
  assert.equal(engine.forDevice('WLF3QAD'), 'LF3');
  engine.setAvoided([]);
});
