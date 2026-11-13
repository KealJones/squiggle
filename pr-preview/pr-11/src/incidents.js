// Problems worth looking at later, so they can be read from the storage repo instead of described from screenshots
// (Keal, 2026-11-11): a GPU lost (and whether it came back), a reply that ended in an error, a tab killed mid-reply,
// a model that failed to load. Code anywhere reports; app.js saves them (debug/incidents.jsonl). Reports made before
// that wait here.
let sink = null;
const waiting = [];
export function report(kind, detail = {}) {
  const rec = { kind, at: new Date().toISOString(), ...detail, gpu: { ...gpu } };
  if (sink) sink(rec); else waiting.push(rec);
}
export function setSink(fn) {
  sink = fn;
  while (waiting.length) fn(waiting.shift());
}

// GPU memory this page holds in WebGPU buffers (weights, KV cache, scratch), in bytes: engine-webllm counts what
// it allocates and frees. Safari has no API for a tab's memory, and on an iPhone the GPU shares the tab's ~1.9 GB,
// so this is the best measure of how full it was. atLoss: what the device held when it was last lost.
export const gpu = { bytes: 0, peak: 0, atLoss: null };

// Counts one device's buffers into `gpu`. Returns a function that drops the device's share (it's lost or gone).
export function trackBuffers(device) {
  let mine = 0, gone = false;
  const create = device.createBuffer.bind(device);
  device.createBuffer = (desc) => {
    const buf = create(desc);
    const size = Number(desc && desc.size) || 0;
    mine += size; gpu.bytes += size; gpu.peak = Math.max(gpu.peak, gpu.bytes);
    const destroy = buf.destroy && buf.destroy.bind(buf);
    let freed = false;
    buf.destroy = () => { if (!freed && !gone) { freed = true; mine -= size; gpu.bytes -= size; } return destroy && destroy(); };
    return buf;
  };
  // Buffers freed after the loss were already taken off here (the incident log showed -1 GB without this).
  return () => { if (gone) return; gone = true; gpu.atLoss = mine; gpu.bytes -= mine; mine = 0; };
}
