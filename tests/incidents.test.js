import { test } from 'node:test';
import assert from 'node:assert/strict';
import { report, setSink, gpu, trackBuffers } from '../app/src/incidents.js';

test('incidents: reports made before the app can save them wait, then go out in order with the GPU numbers', () => {
  report('gpu-lost', { reloads: 1 });
  report('reply-error', { message: 'x' });
  const got = [];
  setSink((r) => got.push(r));
  report('tab-killed', {});
  assert.deepEqual(got.map(r => r.kind), ['gpu-lost', 'reply-error', 'tab-killed']);
  assert.ok(got[0].at && got[0].gpu && 'bytes' in got[0].gpu);
});

test('trackBuffers: counts what a device allocates and frees, and what it held when it was lost', () => {
  const device = { createBuffer: (d) => ({ size: d.size, destroy() {} }) };
  const start = gpu.bytes;
  const drop = trackBuffers(device);
  const a = device.createBuffer({ size: 1000 });
  device.createBuffer({ size: 500 });
  assert.equal(gpu.bytes - start, 1500);
  a.destroy(); a.destroy();               // freeing twice counts once
  assert.equal(gpu.bytes - start, 500);
  assert.ok(gpu.peak >= start + 1500);
  drop();                                 // lost: everything it held is gone
  assert.equal(gpu.atLoss, 500);
  assert.equal(gpu.bytes, start);
});
