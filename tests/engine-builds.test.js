// One model, several builds: the user picks LFM3 and the device decides how it runs (engine.forDevice): LFM3 Omni 2B
// on Keptsam with WebGPU (2026-11-16), then the WebLLM build if that one crashed here, then the GGUF on the CPU.
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
  assert.equal(engine.deviceModel(), 'KOMNI');
  assert.equal(engine.forDevice('LF3'), 'KOMNI', 'a chat saved on a CPU device opens on the GPU build here');
  assert.equal(engine.forDevice('WLF3QAD'), 'KOMNI', 'a chat saved with the WebLLM build opens on Keptsam');
  device({ gpu: false });
  assert.equal(engine.deviceModel(), 'LF3');
  assert.equal(engine.forDevice('KOMNI'), 'LF3', 'a chat saved on a GPU device opens on the CPU build here');
  device({ ua: IPHONE, gpu: true });
  assert.equal(engine.deviceModel(), 'KOMNI');
  assert.equal(engine.forDevice('cloud'), 'cloud', 'a model without builds is itself');
});

test('only the build this device runs is listed, under one name', () => {
  device({ gpu: true });
  const listed = engine.listedModels({ cloudOffered: true });
  assert.ok(listed.includes('KOMNI') && !listed.includes('LF3') && !listed.includes('WLF3QAD'), listed.join());
  assert.deepEqual(listed.sort(), ['KOMNI', 'SQ', 'TG4A', 'cloud'], 'LFM3 once, Keal\'s two small models, the cloud model');
  assert.equal(engine.MODELS.WLF3QAD.label, engine.MODELS.LF3.label);
  device({ gpu: false });
  assert.ok(engine.listedModels({}).includes('LF3') && !engine.listedModels({}).includes('KOMNI'));
});

test('a GPU without 16-bit floats keeps the GPU build (Keptsam needs none); a build that crashed here takes the next one', async () => {
  device({ gpu: true, f16: false });
  assert.equal(await engine.probeGpu(), false);
  assert.equal(engine.forDevice('WLF3QAD'), 'KOMNI', 'Keptsam stores halves in u32: no shader-f16 needed');
  assert.match(engine.runnerLabel('KOMNI'), /GPU.*Keptsam/);
  assert.deepEqual(engine.MODELS.KOMNI.senses, ['image', 'video', 'audio', 'voice']);
  engine.setAvoided(['KOMNI']);
  assert.equal(engine.forDevice('KOMNI'), 'WLF3QAD', 'the WebLLM build has a q4f32_1 twin (mlcRecordF32)');
  assert.ok(engine.MODELS.WLF3QAD.mlcRecordF32 && /q4f32_1/.test(engine.MODELS.WLF3QAD.mlcRecordF32.model_lib));
  assert.match(engine.runnerLabel('LF3'), /^on the CPU/);
  assert.match(engine.runnerLabel('WLF3QAD'), /GPU/);
  engine.setAvoided(['KOMNI', 'WLF3QAD']);
  assert.equal(engine.forDevice('WLF3QAD'), 'LF3');
  engine.setAvoided([]);
});
