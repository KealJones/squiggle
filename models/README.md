# Patched model libraries

`LFM2.5-1.2B-Instruct-q4f16_1-webgpu.tensor-names.wasm` is naklitechie's WebGPU library for
[LFM2.5-1.2B-Instruct](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct) (from
[naklitechie/LFM2.5-1.2B-Instruct-q4f16_1-MLC](https://huggingface.co/naklitechie/LFM2.5-1.2B-Instruct-q4f16_1-MLC),
compiled with [Kiln](https://github.com/NakliTechie/kiln)) with five TVM runtime function names
renamed by `scripts/patch-mlc-wasm.mjs`, so WebLLM 0.2.87 can find them. Nothing else is changed;
the weights still load from naklitechie's repo.

- original sha256 `8a7c8cf25b4ce681a4e8704e0b68790985556a2ad9b1890733b26556f0c9a2f9`
- patched sha256 `9caa9d258888e69c282e7f448f612a5bdf7ea2ef874f878cf3f0b1bd734b74cc`

The model and its LFM Open License v1.0 are © Liquid AI. Used by `app/memtest.html` only.
