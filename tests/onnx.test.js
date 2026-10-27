// The ONNX engine's pure parts: Gemma 4 tool-call syntax, streaming view for
// other models, and the embedding-row lookup (checked against hand-packed rows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGemmaCall, toolResponseText, formatArg, visible, thinkText, parseJsonCall, toolPrompt, RowLookup, f16round } from '../app/src/engine-onnx.js';

test('parses Gemma 4 native tool calls, including sloppy ones', () => {
  assert.deepEqual(parseGemmaCall('call:web_search{query:<|"|>weather, Phoenix<|"|>}'),
    { function: { name: 'web_search', arguments: { query: 'weather, Phoenix' } } });
  assert.deepEqual(parseGemmaCall('call:write_file{content:<|"|>a: {b}, c<|"|>,n:3,ok:true,tags:[<|"|>x<|"|>,<|"|>y<|"|>],o:{k:<|"|>v<|"|>}}').function.arguments,
    { content: 'a: {b}, c', n: 3, ok: true, tags: ['x', 'y'], o: { k: 'v' } });
  // The 2-bit model sometimes uses plain quotes and stops before closing.
  assert.deepEqual(parseGemmaCall('call:web_search{query: "current weather in Phoenix"\n'),
    { function: { name: 'web_search', arguments: { query: 'current weather in Phoenix' } } });
  assert.equal(parseGemmaCall('no call here'), null);
});

test('formats tool results the way the Gemma 4 template does', () => {
  assert.equal(toolResponseText('web_search', { results: 'a "b"', count: 2 }), 'response:web_search{count:2,results:<|"|>a "b"<|"|>}<tool_response|>');
  assert.equal(toolResponseText('git_status', 'clean'), 'response:git_status{value:<|"|>clean<|"|>}<tool_response|>');
  assert.equal(formatArg({ b: [1, true], a: null }), '{a:null,b:[1,true]}');
});

test('streaming view hides think blocks, tool calls and half-written tags', () => {
  assert.equal(visible('Hi <think>hmm</think> there', false), 'Hi there');
  assert.equal(visible('Answer <tool_call>{"name"', false), 'Answer ');
  assert.equal(visible('Hello <too', false), 'Hello ');
  assert.equal(visible('Hello <too', true), 'Hello <too');
  assert.equal(thinkText('<think>step 1'), 'step 1');
});

test('JSON tool calls for models without a native format', () => {
  assert.deepEqual(parseJsonCall('<tool_call>{"name": "recall", "arguments": {"query": "dog"}}</tool_call>'),
    { function: { name: 'recall', arguments: { query: 'dog' } } });
  assert.equal(parseJsonCall('<tool_call>{not json'), null);
  const p = toolPrompt([{ name: 'recall', description: 'Look up memory.', parameters: { type: 'object', properties: { query: { type: 'string' }, k: { type: 'number' } }, required: ['query'] } }]);
  assert.match(p, /- recall\(query: string, k\?: number\): Look up memory\./);
});

test('embedding rows: 2-bit and 4-bit block-quantized rows decode like the ONNX op', async () => {
  // Two tables, 2 tokens each. Table A: 2-bit, dim 8, 2 blocks of 4. Table B: 4-bit, dim 4, 1 block.
  const A = { w: 0, rowBytes: 2, s: 4, blocks: 2, bits: 2, dim: 8, mul: 2 };
  const B = { w: 12, rowBytes: 2, s: 16, blocks: 1, bits: 4, dim: 4, mul: 0.5, zeroIds: [1] };
  const file = new Uint8Array(20);
  const half = (x) => { const f = new Float32Array([x]), u = new Uint32Array(f.buffer)[0]; return ((u >>> 16) & 0x8000) | ((((u >>> 23) & 0xff) - 112) << 10) | ((u >>> 13) & 0x3ff); };
  const dv = new DataView(file.buffer);
  // token 0, table A: q = [0,1,2,3, 3,2,1,0] (zp 2 → -2,-1,0,1, 1,0,-1,-2), scales 1 and 0.5
  file[0] = 0 | (1 << 2) | (2 << 4) | (3 << 6); file[1] = 3 | (2 << 2) | (1 << 4) | (0 << 6);
  dv.setUint16(4, half(1), true); dv.setUint16(6, half(0.5), true);
  // token 1, table A: all q=3 (→ +1), scales 2, 2
  file[2] = 0xff; file[3] = 0xff; dv.setUint16(8, half(2), true); dv.setUint16(10, half(2), true);
  // table B, token 0: q = [8, 9, 7, 15] (zp 8 → 0, 1, -1, 7), scale 4; token 1 is a zeroId → uses token 0's row
  file[12] = 8 | (9 << 4); file[13] = 7 | (15 << 4); dv.setUint16(16, half(4), true);
  const read = async (off, len) => file.slice(off, off + len);
  const lk = new RowLookup(read, { tables: [A, B] });
  const [a, b] = await lk.embed([0, 1]);
  assert.deepEqual([...a], [-4, -2, 0, 2, 1, 0, -1, -2, 4, 4, 4, 4, 4, 4, 4, 4]);
  assert.deepEqual([...b], [0, 2, -2, 14, 0, 2, -2, 14]);
  assert.equal(f16round(1 + 2 ** -12), 1);
  assert.equal(f16round(65504), 65504);
});
