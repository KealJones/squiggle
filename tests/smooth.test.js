import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smoothText } from '../app/src/ui/smooth.js';

// A fake animation clock: each frame() runs the waiting callback 16 ms later.
function clock() {
  let cb = null, now = 0;
  return { raf: (f) => { cb = f; return 1; }, caf: () => { cb = null; }, frame() { const f = cb; cb = null; now += 16; if (f) f(now); return Boolean(f); } };
}

test('smoothText: a burst of text comes out a little at a time, ends complete, and stops asking for frames', () => {
  const c = clock(), seen = [];
  const s = smoothText((t) => seen.push(t), c);
  s.feed('Hello there, this is a reply that arrived all at once in one big chunk.');
  let frames = 0;
  while (c.frame()) frames += 1;
  assert.ok(frames > 3, 'spread over several frames');
  assert.equal(seen.at(-1), 'Hello there, this is a reply that arrived all at once in one big chunk.');
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].startsWith(seen[i - 1]), 'only ever grows');
});

test('smoothText: a big backlog is cleared in about half a second, not at a fixed slow speed', () => {
  const c = clock(), seen = [];
  const s = smoothText((t) => seen.push(t), c);
  s.feed('x'.repeat(2000));
  let frames = 0;
  while (c.frame()) frames += 1;
  assert.ok(frames * 16 < 1500, `took ${frames * 16} ms`);
  assert.equal(seen.at(-1).length, 2000);
});

test('smoothText: rewritten text carries on from what still matches; emoji are never split; stop() stops', () => {
  const c = clock(), seen = [];
  const s = smoothText((t) => seen.push(t), c);
  s.feed('abc <|tool_call_start|>');
  while (c.frame());
  s.feed('abc done 😀😀');
  assert.equal(seen.at(-1), 'abc ', 'cut back to the part that still matches');
  while (c.frame());
  assert.equal(seen.at(-1), 'abc done 😀😀');
  for (const t of seen) assert.ok(!/[\uD800-\uDBFF]$/.test(t), 'no half emoji');
  s.feed('abc done 😀😀 and more text to come');
  s.stop();
  assert.equal(c.frame(), false);
});
