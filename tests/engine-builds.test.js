// Two LFM3 models, each with builds the device picks from (engine.forDevice): LFM3 1.7B on Tilde with WebGPU
// (2026-11-17), then the WebLLM build if that one crashed here, then the GGUF on the CPU; LFM3 Omni 2B on Tilde,
// and where it can't run, a chat saved with it opens on the best LFM3 1.7B build.
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

test('LFM3 1.7B: the Tilde build with WebGPU, the CPU build without; Omni stays the default where it runs', () => {
  device({ gpu: true });
  assert.equal(engine.deviceModel(), 'KOMNI');
  assert.equal(engine.forDevice('LF3'), 'KLF3', 'a chat saved on a CPU device opens on the GPU build here');
  assert.equal(engine.forDevice('WLF3QAD'), 'KLF3', 'a chat saved with the WebLLM build opens on Tilde');
  assert.equal(engine.forDevice('KOMNI'), 'KOMNI');
  device({ gpu: false });
  assert.equal(engine.deviceModel(), 'LF3');
  assert.equal(engine.forDevice('KOMNI'), 'LF3', 'a chat saved with Omni opens on the CPU build of LFM3 1.7B here');
  assert.equal(engine.forDevice('KLF3'), 'LF3');
  device({ ua: IPHONE, gpu: true });
  assert.equal(engine.deviceModel(), 'KOMNI');
  assert.equal(engine.forDevice('cloud'), 'cloud', 'a model without builds is itself');
});

test('LFM3 1.7B and LFM3 Omni 2B are listed side by side, each once', () => {
  device({ gpu: true });
  const listed = engine.listedModels({ cloudOffered: true });
  assert.deepEqual(listed.sort(), ['KLF3', 'KOMNI', 'SQ', 'TG4A', 'cloud'], 'the two LFM3s, Keal\'s two small models, the cloud model');
  assert.equal(engine.MODELS.KLF3.label, 'LFM3 1.7B');
  assert.equal(engine.MODELS.WLF3QAD.label, engine.MODELS.LF3.label);
  assert.equal(engine.MODELS.KLF3.url, engine.MODELS.LF3.url, 'Tilde reads the same QAD GGUF as llama.cpp');
  assert.equal(engine.MODELS.KLF3.toolFormat, 'lfm3', 'LFM3 1.7B thinks on its own: no started thinking');
  assert.equal(engine.MODELS.KOMNI.toolFormat, 'lfm3-omni');
  device({ gpu: false });
  assert.deepEqual(engine.listedModels({}).filter(id => engine.groupOf(id)), ['LF3'], 'without WebGPU: LFM3 1.7B on the CPU, no Omni');
});

test('a GPU without 16-bit floats keeps the Tilde builds (no shader-f16 needed); a build that crashed here takes the next one', async () => {
  device({ gpu: true, f16: false });
  assert.equal(await engine.probeGpu(), false);
  assert.equal(engine.forDevice('WLF3QAD'), 'KLF3', 'Tilde stores halves in u32: no shader-f16 needed');
  assert.match(engine.runnerLabel('KOMNI'), /GPU.*Tilde/);
  assert.match(engine.runnerLabel('KLF3'), /GPU.*Tilde/);
  assert.deepEqual(engine.MODELS.KOMNI.senses, ['image', 'video', 'audio', 'voice']);
  assert.ok(!engine.MODELS.KLF3.senses);
  engine.setAvoided(['KOMNI']);
  assert.equal(engine.forDevice('KOMNI'), 'KLF3', 'Omni crashed here: its chats open on LFM3 1.7B');
  engine.setAvoided(['KLF3']);
  assert.equal(engine.forDevice('KLF3'), 'WLF3QAD', 'the WebLLM build has a q4f32_1 twin (mlcRecordF32)');
  assert.ok(engine.MODELS.WLF3QAD.mlcRecordF32 && /q4f32_1/.test(engine.MODELS.WLF3QAD.mlcRecordF32.model_lib));
  assert.match(engine.runnerLabel('LF3'), /^on the CPU/);
  assert.match(engine.runnerLabel('WLF3QAD'), /GPU/);
  engine.setAvoided(['KLF3', 'WLF3QAD']);
  assert.equal(engine.forDevice('WLF3QAD'), 'LF3');
  engine.setAvoided([]);
});
