// Streamed text shown at an even pace instead of in bursts (the idea of smooth-stream-text): the text that has
// arrived is revealed a few characters per frame, at a speed set whenever text arrives so that backlog is gone in
// about LAG seconds whatever the model's speed (a speed set every frame would slow down as it caught up).
// feed(text) takes the whole text so far; if it was rewritten (a held-back marker dropped), it carries on from what
// still matches. Renders at most every FRAME ms: each render re-parses the markdown, and on a phone the main
// thread also drives the model.
const LAG = 0.4, MIN_RATE = 40, FRAME = 33;

export function smoothText(render, { raf = globalThis.requestAnimationFrame, caf = globalThis.cancelAnimationFrame } = {}) {
  let target = '', shown = 0, last = 0, drawn = 0, id = 0, rate = MIN_RATE;
  const tick = (now) => {
    id = 0;
    const dt = last ? Math.min(100, now - last) : 16;
    last = now;
    if (shown >= target.length) { last = 0; return; }
    let n = Math.min(target.length, shown + Math.max(1, Math.round(rate * dt / 1000)));
    if (/[\uD800-\uDBFF]/.test(target[n - 1] || '')) n += 1;   // never half an emoji
    shown = n;
    if (shown === target.length || now - drawn >= FRAME) { drawn = now; render(target.slice(0, shown)); }
    id = raf(tick);
  };
  return {
    feed(text) {
      let same = 0;
      const max = Math.min(shown, text.length);
      while (same < max && text.charCodeAt(same) === target.charCodeAt(same)) same += 1;
      target = text;
      if (same < shown) { shown = same; render(target.slice(0, shown)); }
      rate = Math.max(MIN_RATE, (target.length - shown) / LAG);   // characters a second
      if (!id && shown < target.length) id = raf(tick);
    },
    stop() { if (id) caf(id); id = 0; },
  };
}
