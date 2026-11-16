// Line diffs for `git diff`, `git show`, `git log -p` and `gh pr diff` (tools/gitcli.js): Myers' algorithm on
// the lines that differ, then git's unified format with 3 lines of context, and --stat / --numstat summaries.

// The edit script between two arrays of lines: [{ op: ' ' | '-' | '+', line }].
export function diffLines(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const head = a.slice(0, start).map(line => ({ op: ' ', line }));
  const tail = a.slice(endA).map(line => ({ op: ' ', line }));
  return slideDown([...head, ...myers(a.slice(start, endA), b.slice(start, endB)), ...tail]);
}

// git shows an added or removed run as late as it can go ("x x +x", not "x +x x"): while the line after a run
// equals the run's first line, the run moves down one.
function slideDown(edits) {
  for (let s = 0; s < edits.length; s++) {
    const op = edits[s].op;
    if (op === ' ') continue;
    let e = s;
    while (e < edits.length && edits[e].op === op) e++;
    while (e < edits.length && edits[e].op === ' ' && edits[e].line === edits[s].line) {
      edits[s].op = ' ';
      edits[e].op = op;
      s++; e++;
    }
    s = e - 1;
  }
  return edits;
}

const MAX_D = 4000;   // past this many edits, the middle is shown as all removed then all added

function myers(a, b) {
  const n = a.length, m = b.length, max = n + m;
  if (!n) return b.map(line => ({ op: '+', line }));
  if (!m) return a.map(line => ({ op: '-', line }));
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, MAX_D); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    if (found >= 0) break;
  }
  if (found < 0) return [...a.map(line => ({ op: '-', line })), ...b.map(line => ({ op: '+', line }))];
  const out = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const pv = trace[d], k = x - y;
    const down = k === -d || (k !== d && pv[off + k - 1] < pv[off + k + 1]);
    const pk = down ? k + 1 : k - 1;
    const px = pv[off + pk], py = px - pk;
    while (x > px && y > py) out.push({ op: ' ', line: a[--x] }), y--;
    if (down) out.push({ op: '+', line: b[--y] });
    else out.push({ op: '-', line: a[--x] });
  }
  while (x > 0 && y > 0) out.push({ op: ' ', line: a[--x] }), y--;
  return out.reverse();
}

const isBinary = (s) => s != null && s.slice(0, 8000).includes('\0');
// Lines with their own "\n", so a last line without one differs from the same line with one (as in git).
const toLines = (s) => (s ? s.match(/[^\n]*\n|[^\n]+$/g) : []);

// How many lines one file's change adds and removes (null for a binary file).
export function countLines(before, after) {
  if (isBinary(before) || isBinary(after)) return null;
  let add = 0, del = 0;
  for (const e of diffLines(toLines(before), toLines(after))) { if (e.op === '+') add++; else if (e.op === '-') del++; }
  return { add, del };
}

// One file's change in git's unified format. before/after: the text, or null when the file doesn't exist on
// that side. oids: [before, after] short ids for the index line. '' when nothing changed.
export function unifiedDiff({ path, before, after, oids = [], context = 3, mode = '100644' }) {
  if (before === after) return '';
  const out = [`diff --git a/${path} b/${path}`];
  if (before == null) out.push(`new file mode ${mode}`);
  else if (after == null) out.push(`deleted file mode ${mode}`);
  const [o1 = '0000000', o2 = '0000000'] = oids;
  out.push(`index ${o1}..${o2}${before != null && after != null ? ` ${mode}` : ''}`);
  if (isBinary(before) || isBinary(after)) {
    out.push(`Binary files ${before == null ? '/dev/null' : `a/${path}`} and ${after == null ? '/dev/null' : `b/${path}`} differ`);
    return out.join('\n') + '\n';
  }
  const oldLines = toLines(before);
  const edits = diffLines(oldLines, toLines(after));
  if (before == null && after === '') return out.join('\n') + '\n';   // a new empty file has no hunks
  out.push(`--- ${before == null ? '/dev/null' : `a/${path}`}`, `+++ ${after == null ? '/dev/null' : `b/${path}`}`);
  // Each edit's line numbers on both sides, then hunks around the changes (git joins hunks whose context meets).
  let la = 0, lb = 0;
  const rows = edits.map(e => {
    const row = { ...e, a: la, b: lb };
    if (e.op !== '+') la++;
    if (e.op !== '-') lb++;
    return row;
  });
  const changed = rows.map((r, i) => (r.op === ' ' ? -1 : i)).filter(i => i >= 0);
  let i = 0;
  while (i < changed.length) {
    const first = changed[i];
    let last = changed[i];
    while (i + 1 < changed.length && changed[i + 1] - last <= context * 2 + 1) last = changed[++i];
    i++;
    const hunk = rows.slice(Math.max(0, first - context), Math.min(rows.length - 1, last + context) + 1);
    const lenA = hunk.filter(r => r.op !== '+').length, lenB = hunk.filter(r => r.op !== '-').length;
    const startA = lenA ? hunk.find(r => r.op !== '+').a + 1 : hunk[0].a;
    const startB = lenB ? hunk.find(r => r.op !== '-').b + 1 : hunk[0].b;
    // git's default "function" context: the nearest line above the hunk that starts with a letter, _ or $.
    let fn = '';
    for (let k = hunk[0].a - 1; k >= 0; k--) if (/^[A-Za-z_$]/.test(oldLines[k])) { fn = ' ' + oldLines[k].replace(/\s+$/, '').slice(0, 80); break; }
    out.push(`@@ -${startA}${lenA === 1 ? '' : `,${lenA}`} +${startB}${lenB === 1 ? '' : `,${lenB}`} @@${fn}`);
    for (const r of hunk) {
      out.push(r.op + r.line.replace(/\n$/, ''));
      if (!r.line.endsWith('\n')) out.push('\\ No newline at end of file');
    }
  }
  return out.join('\n') + '\n';
}

// `git diff --stat`: one line per file and the totals. files: [{ path, add, del }] (add null for binary).
export function statLines(files) {
  if (!files.length) return '';
  const width = Math.min(50, Math.max(...files.map(f => f.path.length)));
  const most = Math.max(1, ...files.map(f => (f.add ?? 0) + (f.del ?? 0)));
  const digits = String(Math.max(0, ...files.map(f => (f.add ?? 0) + (f.del ?? 0)))).length;
  const scale = most > 50 ? 50 / most : 1;
  const lines = files.map(f => {
    if (f.add == null) return ` ${f.path.padEnd(width)} | ${'Bin'.padStart(digits)}`;
    const n = f.add + f.del;
    const plus = Math.round(f.add * scale), minus = Math.round(f.del * scale);
    return ` ${f.path.padEnd(width)} | ${String(n).padStart(digits)} ${'+'.repeat(plus)}${'-'.repeat(minus)}`;
  });
  const ins = files.reduce((s, f) => s + (f.add || 0), 0), dels = files.reduce((s, f) => s + (f.del || 0), 0);
  const parts = [`${files.length} file${files.length === 1 ? '' : 's'} changed`];
  if (ins || !dels) parts.push(`${ins} insertion${ins === 1 ? '' : 's'}(+)`);
  if (dels) parts.push(`${dels} deletion${dels === 1 ? '' : 's'}(-)`);
  return lines.join('\n') + '\n ' + parts.join(', ') + '\n';
}
