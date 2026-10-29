// Renders the "working" squiggle (squiggleWait() in app/src/main.js) as an
// animated WebP: the logo squiggle wiggling like a snake. The page uses it as a CSS
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
const FRAMES = 48;
const DURATION = 2400;    // ms per loop (one wavelength)

// One frame: the #squiggle logo itself (same humps, 3px round stroke), with
// its wave sliding along the body like a snake's. Frame 0 is the logo exactly.
// Each hump in the logo is the cubic (0,8) (3,2) (7,2) (11,8) (mirrored for
// the dips), so the profile below is that curve, repeated every 22 units.
const HUMP = (() => {
  const pts = [];
  for (let i = 0; i <= 400; i++) {
    const u = i / 400, v = 1 - u;
    pts.push([3 * v * v * u * 3 + 3 * v * u * u * 7 + u * u * u * 11, 3 * v * v * u * 6 + 3 * v * u * u * 6]);
  }
  return (s) => { // height above the midline at distance s (0..11) into a hump
    let i = pts.findIndex(([x]) => x >= s);
    if (i <= 0) return 0;
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    return ay + (by - ay) * (s - ax) / (bx - ax || 1);
  };
})();
const wave = (s) => { // the logo's profile as a periodic function (period 22)
  const m = ((s % 22) + 22) % 22;
  return m < 11 ? -HUMP(m) : HUMP(m - 11);
};
function frame(t) {
  const d = [];
  for (let x = 2; x <= 46.0001; x += 0.25) {
    const y = H / 2 + wave(x - 2 + 22 * t);  // wave runs head (right) to tail (left)
    d.push(`${d.length ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(3)}`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W} ${H}">` +
    `<path d="${d.join('')}" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
// The still frame for reduced motion is the logo path itself.
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W} ${H}">` +
  '<path d="M2 8c4-6 8-6 11 0s7 6 11 0 7-6 11 0 7 6 11 0" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>';

const raw = (svg) => sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
const frames = await Promise.all(Array.from({ length: FRAMES }, (_, k) => raw(frame(k / FRAMES))));
const size = { width: W * SCALE, height: H * SCALE, channels: 4 };

await sharp(Buffer.concat(frames), { raw: { ...size, pageHeight: size.height, height: size.height * FRAMES } })
  .webp({ loop: 0, delay: Array(FRAMES).fill(Math.round(DURATION / FRAMES)), lossless: true, effort: 6 })
  .toFile(path.join(OUT, 'squiggle.webp'));
await sharp(await raw(LOGO), { raw: size }).webp({ lossless: true }).toFile(path.join(OUT, 'squiggle-still.webp'));

if (process.argv.includes('--svg')) for (let k = 0; k < FRAMES; k++) console.log(frame(k / FRAMES));
console.log(`wrote ${FRAMES} frames to app/icons/squiggle.webp and squiggle-still.webp`);
