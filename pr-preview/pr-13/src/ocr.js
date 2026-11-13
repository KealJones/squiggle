// Reads the text in an image (screenshots, receipts, signs, error messages)
// with Tesseract.js on the CPU, so the model works from the exact words
// instead of guessing at a picture. English only; the language data (a few MB)
// is fetched once from jsDelivr and cached by Tesseract in IndexedDB.
//
// Two passes, merged: the image as is (capped at 2000 px) and a half-size
// grayscale copy. Big display text ("$109" in a 120 px font) is often misread
// at full size and read correctly at half size; small text needs full size.
// The worker is closed shortly after use to give the memory back.
export const TESSERACT_VERSION = '5.1.1';
const BASE = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist`;
const CORE = `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_VERSION}`;
const MAX_SIDE = 2000;
const IDLE_MS = 20000;

let workerPromise = null;
let idleTimer = null;

async function getWorker() {
  clearTimeout(idleTimer);
  if (!workerPromise) {
    workerPromise = (async () => {
      const mod = await import(/* @vite-ignore */ `${BASE}/tesseract.esm.min.js`);
      const T = mod.createWorker ? mod : mod.default;
      // The page CSP only allows same-origin and blob: workers; Tesseract runs
      // its CDN worker script from a blob (workerBlobURL), which is allowed.
      return T.createWorker('eng', 1, { workerPath: `${BASE}/worker.min.js`, corePath: CORE, workerBlobURL: true });
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

function release() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const p = workerPromise;
    workerPromise = null;
    try { (await p).terminate(); } catch {}
  }, IDLE_MS);
}

// Draws the image at `scale` of its (capped) size, optionally in grayscale with
// stretched contrast. Returns a canvas Tesseract can read.
function draw(bmp, scale, gray) {
  const cap = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * cap * scale)), h = Math.max(1, Math.round(bmp.height * cap * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: gray });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  if (gray) {
    const img = ctx.getImageData(0, 0, w, h), d = img.data;
    let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 4) { const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000; d[i] = y; if (y < lo) lo = y; if (y > hi) hi = y; }
    const k = hi > lo ? 255 / (hi - lo) : 1;
    for (let i = 0; i < d.length; i += 4) { const y = (d[i] - lo) * k; d[i] = d[i + 1] = d[i + 2] = y; }
    ctx.putImageData(img, 0, 0);
  }
  return c;
}

const norm = (l) => l.toLowerCase().replace(/[^a-z0-9$%.,:]+/g, '');
// Drops OCR noise from icons and borders ("< hd <C ©"): a line needs a few
// letters or digits, and mostly those.
const useful = (l) => {
  const chars = l.replace(/\s/g, '');
  const letters = (l.match(/[A-Za-z0-9]/g) || []).length;
  const textish = (chars.match(/[A-Za-z0-9$%€£.,:;'"\/+\-()]/g) || []).length;
  return letters >= 2 && textish / chars.length > 0.6;
};
const clean = (t) => String(t || '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l && useful(l));

// The full-size pass in order, then lines only the half-size pass found.
export function mergePasses(full, half) {
  const a = clean(full), b = clean(half);
  const seen = new Set(a.map(norm));
  const extra = b.filter(l => { const n = norm(l); if (n.length < 2 || seen.has(n)) return false; seen.add(n); return true; });
  return { text: a.join('\n'), extra: extra.join('\n') };
}

/**
 * Text found in an image (a File or Blob). Returns { text, confidence } where
 * text may be '' when nothing readable was found.
 */
export async function readImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const w = await getWorker();
    const full = await w.recognize(draw(bmp, 1, false));
    const half = await w.recognize(draw(bmp, 0.5, true));
    const m = mergePasses(full.data.text, half.data.text);
    const text = m.text + (m.extra ? `\n\n[also read at a smaller size]\n${m.extra}` : '');
    return { text: text.trim(), confidence: Math.round(Math.max(full.data.confidence || 0, half.data.confidence || 0)) };
  } finally {
    bmp.close && bmp.close();
    release();
  }
}
