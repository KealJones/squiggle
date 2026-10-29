// Renders the "working" squiggle (squiggleWait() in app/src/main.js) as an
// animated WebP: a little snake slithering in place. The page uses it as a CSS
// mask, so the colour comes from the element (currentColor) and only the
// alpha here matters.
//
//   node scripts/squiggle-webp.mjs        (needs sharp: npm i -g sharp, or npx -p sharp)
//
// Writes app/icons/squiggle.webp (animated) and app/icons/squiggle-still.webp
// (one frame, for prefers-reduced-motion). Re-run after changing the shape.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
let sharp;
try { sharp = require('sharp'); } catch {
  const { execSync } = await import('node:child_process');
  sharp = require(path.join(execSync('npm root -g').toString().trim(), 'sharp'));
}

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'icons');
const W = 48, H = 16;     // same box as the #squiggle logo symbol
const SCALE = 4;          // 192×64 px: sharp on 3× phone screens at the 46×16 size
const FRAMES = 24;
const DURATION = 1200;    // ms per loop

// One frame of the snake. The wave travels from head (right) to tail (left),
// the way a real snake's body follows its head, so it reads as moving forward.
function frame(t) {
  const x0 = 3, x1 = 43, n = 90, wavelength = 21;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;                                   // 0 = tail, 1 = head
    const x = x0 + (x1 - x0) * u;
    const amp = 4.1 - 2.3 * u * u;                     // tail swings wide, head stays steadier
    const y = H / 2 + amp * Math.sin(2 * Math.PI * (x / wavelength + t));
    const w = 0.9 + 2.4 * Math.min(1, u / 0.6) + (u > 0.9 ? 0.9 * (u - 0.9) / 0.1 : 0); // thin tail → body → slightly wider head
    pts.push([x, y, w]);
  }
  const segs = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay, aw] = pts[i], [bx, by] = pts[i + 1];
    segs.push(`<line x1="${ax.toFixed(3)}" y1="${ay.toFixed(3)}" x2="${bx.toFixed(3)}" y2="${by.toFixed(3)}" stroke-width="${aw.toFixed(3)}"/>`);
  }
  const [hx, hy, hw] = pts[n];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W} ${H}">` +
    `<g stroke="#fff" stroke-linecap="round" fill="none">${segs.join('')}</g>` +
    `<circle cx="${hx.toFixed(3)}" cy="${hy.toFixed(3)}" r="${(hw / 2).toFixed(3)}" fill="#fff"/></svg>`;
}

const raw = (svg) => sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
const frames = await Promise.all(Array.from({ length: FRAMES }, (_, k) => raw(frame(k / FRAMES))));
const size = { width: W * SCALE, height: H * SCALE, channels: 4 };

await sharp(Buffer.concat(frames), { raw: { ...size, pageHeight: size.height, height: size.height * FRAMES } })
  .webp({ loop: 0, delay: Array(FRAMES).fill(Math.round(DURATION / FRAMES)), lossless: true, effort: 6 })
  .toFile(path.join(OUT, 'squiggle.webp'));
await sharp(frames[0], { raw: size }).webp({ lossless: true }).toFile(path.join(OUT, 'squiggle-still.webp'));

if (process.argv.includes('--svg')) for (let k = 0; k < FRAMES; k++) console.log(frame(k / FRAMES));
console.log(`wrote ${FRAMES} frames to app/icons/squiggle.webp and squiggle-still.webp`);
