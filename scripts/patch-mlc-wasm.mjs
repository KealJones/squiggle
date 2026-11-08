// Renames the TVM runtime functions inside an MLC model library (.wasm) to the names
// WebLLM 0.2.87's runtime looks up, so a build compiled mid-rename can load.
//
// Builds compiled with mlc-llm around June 2026 (e.g. naklitechie's LFM2.5 port, made
// with the Kiln fork) register `runtime.TVMTensorAllocWithScope` and friends; WebLLM
// 0.2.87 asks for `runtime.TensorAllocWithScope` and stops with "Cannot find global
// function". Each new name is the old one without "TVM", so it's written over the old
// C string and padded with NULs: the file keeps its size and layout.
//
//   node scripts/patch-mlc-wasm.mjs in.wasm out.wasm
//
// Checked in Node with WebLLM 0.2.87's bundled runtime: the unpatched LFM2.5 1.2B library
// fails at "Cannot find global function runtime.TensorAllocWithScope"; patched, it gets as
// far as the official Qwen3 0.6B library does without a GPU (WebGPU module setup). Whether
// it runs on a GPU is what app/memtest.html checks.
import { readFileSync, writeFileSync } from 'node:fs';

const RENAMES = ['AllocWithScope', 'CopyFromTo', 'CreateView', 'CopyFromBytes', 'CopyToBytes']
  .map((f) => [`runtime.TVMTensor${f}`, `runtime.Tensor${f}`]);

export function patch(bytes) {
  const out = Buffer.from(bytes);
  const done = [];
  for (const [from, to] of RENAMES) {
    const old = Buffer.from(from + '\0');
    let n = 0;
    for (let i = out.indexOf(old); i >= 0; i = out.indexOf(old, i + 1)) {
      out.fill(0, i, i + old.length);
      out.write(to, i, 'latin1');
      n++;
    }
    if (n) done.push(`${from} → ${to} (${n})`);
  }
  return { bytes: out, done };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) { console.error('usage: node scripts/patch-mlc-wasm.mjs in.wasm out.wasm'); process.exit(1); }
  const { bytes, done } = patch(readFileSync(input));
  if (!done.length) { console.error('Nothing to rename: this library already uses the new names (or none of them).'); process.exit(1); }
  writeFileSync(output, bytes);
  console.log(done.join('\n'));
}
