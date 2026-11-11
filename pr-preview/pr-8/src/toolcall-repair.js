// LiteRT-LM throws when Gemma 4 writes a tool call it can't parse, for example a
// string argument in plain "quotes" instead of Gemma's <|"|> marks:
//   Failed to parse tool calls from code block: ... full response:
//   <|tool_call>call:grep{path:<|"|>/repos/squiggle<|"|>,pattern:".squiggle-wait|indeterminate"}<tool_call|>
// This reads such a call leniently so the turn can carry on.

const Q = '<|"|>';

/** The model's raw output from a LiteRT parse error, or null if it isn't one. */
export function failedCallText(message) {
  const m = String(message || '');
  if (!/Failed to parse (FC )?tool calls?/i.test(m)) return null;
  const full = m.match(/full response:\s*([\s\S]*?)(?:\n\s*error:|$)/i);
  return (full ? full[1] : m).trim();
}

// One value starting at s[i]: <|"|>…<|"|>, "…", '…', a nested {…} or […], or a bare word/number.
function readValue(s, i) {
  if (s.startsWith(Q, i)) { const e = s.indexOf(Q, i + Q.length); if (e < 0) throw new Error('unclosed string'); return [s.slice(i + Q.length, e), e + Q.length]; }
  const c = s[i];
  if (c === '"' || c === "'") {
    let j = i + 1, out = '';
    while (j < s.length && s[j] !== c) { if (s[j] === '\\' && j + 1 < s.length) { out += s[j + 1]; j += 2; } else out += s[j++]; }
    if (j >= s.length) throw new Error('unclosed string');
    return [out, j + 1];
  }
  if (c === '{') { const [obj, j] = readObject(s, i); return [obj, j]; }
  if (c === '[') {
    const arr = []; let j = i + 1;
    while (j < s.length) {
      while (/[\s,]/.test(s[j] || '')) j++;
      if (s[j] === ']') return [arr, j + 1];
      const [v, k] = readValue(s, j); arr.push(v); j = k;
    }
    throw new Error('unclosed list');
  }
  let j = i;
  while (j < s.length && !/[,}\]]/.test(s[j])) j++;
  const w = s.slice(i, j).trim();
  if (/^-?\d+(\.\d+)?$/.test(w)) return [Number(w), j];
  if (w === 'true' || w === 'false') return [w === 'true', j];
  if (w === 'null') return [null, j];
  return [w, j];
}

function readObject(s, i) {
  const obj = {}; let j = i + 1;
  while (j < s.length) {
    while (/[\s,]/.test(s[j] || '')) j++;
    if (s[j] === '}') return [obj, j + 1];
    let key;
    if (s.startsWith(Q, j) || s[j] === '"' || s[j] === "'") [key, j] = readValue(s, j);
    else { const m = /^[\w$.-]+/.exec(s.slice(j)); if (!m) throw new Error('bad key'); key = m[0]; j += key.length; }
    while (/\s/.test(s[j] || '')) j++;
    if (s[j] !== ':') throw new Error('expected :');
    j++;
    while (/\s/.test(s[j] || '')) j++;
    const [v, k] = readValue(s, j); obj[key] = v; j = k;
  }
  throw new Error('unclosed {');
}

/** Lenient parse of Gemma 4 calls ("call:name{...}"), or [] if none can be read. */
export function repairCalls(text) {
  const calls = [];
  const re = /call:([\w.-]+)\s*\{/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    try {
      const [args] = readObject(text, m.index + m[0].length - 1);
      calls.push({ type: 'function', function: { name: m[1], arguments: args } });
    } catch { /* unreadable: skip this one */ }
  }
  return calls;
}

/** Note for the model when its call couldn't be read at all. */
export const unreadableNote = (raw) => `(Squiggle: your tool call couldn't be read, so nothing ran: ${String(raw).slice(0, 300)}\n` +
  'Write the call again. Put every text argument between <|"|> marks, like path:<|"|>/repos/app<|"|>.)';
