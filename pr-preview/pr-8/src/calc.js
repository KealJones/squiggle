// `calculate`: plain arithmetic for the model, so it never does math in its
// head or has to write JavaScript for it. A small recursive-descent parser:
// no eval, no variables, nothing but numbers.
//
//   numbers      12, 3.5, .5, 1e6, 1,234,567 (thousands commas), $ € £ ignored
//   operators    + - * / ^ (power, right-assoc), unary -, parentheses, × ÷ x
//   percent      25%  = 0.25;  "15% of 240" = 36;  "of" means times
//   functions    sqrt abs round(x[, digits]) floor ceil min max pow log (base 10) ln exp
//   constants    pi, e
//
// calculate(expr) → { result } or { error }.
const FUNCS = {
  sqrt: [1, 1, Math.sqrt], abs: [1, 1, Math.abs], floor: [1, 1, Math.floor], ceil: [1, 1, Math.ceil],
  round: [1, 2, (x, d = 0) => { const k = 10 ** d; return Math.round(x * k) / k; }],
  min: [1, 50, Math.min], max: [1, 50, Math.max], pow: [2, 2, Math.pow],
  log: [1, 1, Math.log10], ln: [1, 1, Math.log], exp: [1, 1, Math.exp],
};
const CONSTS = { pi: Math.PI, e: Math.E };

function tokenize(src) {
  let s = String(src || '').toLowerCase()
    .replace(/[$€£]/g, '').replace(/×|(?<=[\d.)]\s*)x(?=\s*[\d.(])/g, '*').replace(/÷/g, '/').replace(/\*\*/g, '^')
;
  // Thousands commas (1,234,567) unless the expression calls a function, where
  // commas separate arguments: max(1,234,5) is three numbers.
  if (!/[a-z]\s*\(/.test(s)) s = s.replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  const out = [];
  const re = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)|([a-z]+)|(\S))/gy;
  let m;
  while (re.lastIndex < s.length && (m = re.exec(s))) {
    if (m[1] !== undefined) out.push({ t: 'num', v: parseFloat(m[1]) });
    else if (m[2] !== undefined) out.push({ t: 'id', v: m[2] });
    else if (m[3] !== undefined) {
      if (!'+-*/^%(),'.includes(m[3])) throw new Error(`Unexpected "${m[3]}". Use numbers, + - * / ^ %, parentheses and functions like sqrt or round.`);
      out.push({ t: 'op', v: m[3] });
    }
  }
  if (s.trim() && !out.length) throw new Error('Nothing to calculate.');
  return out;
}

export function calculate(expr) {
  try {
    if (String(expr || '').length > 500) throw new Error('Expression too long.');
    const toks = tokenize(expr);
    let i = 0;
    const peek = () => toks[i];
    const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;
    const eat = (v) => { if (!isOp(v)) throw new Error(`Expected "${v}".`); i++; };

    // expr := term (('+'|'-') term)*
    const expr_ = () => {
      let v = term();
      while (isOp('+') || isOp('-')) { const o = toks[i++].v; const r = term(); v = o === '+' ? v + r : v - r; }
      return v;
    };
    // term := unary (('*'|'/'|'of') unary)*
    const term = () => {
      let v = unary();
      for (;;) {
        if (isOp('*')) { i++; v *= unary(); }
        else if (isOp('/')) { i++; const r = unary(); if (r === 0) throw new Error('Division by zero.'); v /= r; }
        else if (peek() && peek().t === 'id' && peek().v === 'of') { i++; v *= unary(); }
        else return v;
      }
    };
    // unary := ('-'|'+') unary | power
    const unary = () => {
      if (isOp('-')) { i++; return -unary(); }
      if (isOp('+')) { i++; return unary(); }
      return power();
    };
    // power := postfix ('^' unary)?   (right-assoc; -2^2 = -4)
    const power = () => {
      const b = postfix();
      if (isOp('^')) { i++; return Math.pow(b, unary()); }
      return b;
    };
    // postfix := atom '%'*
    const postfix = () => {
      let v = atom();
      while (isOp('%')) { i++; v /= 100; }
      return v;
    };
    const atom = () => {
      const t = peek();
      if (!t) throw new Error('The expression ends too early.');
      if (t.t === 'num') { i++; return t.v; }
      if (isOp('(')) { i++; const v = expr_(); eat(')'); return v; }
      if (t.t === 'id') {
        i++;
        if (t.v in CONSTS) return CONSTS[t.v];
        const f = FUNCS[t.v];
        if (!f) throw new Error(`Unknown name "${t.v}". Functions: ${Object.keys(FUNCS).join(', ')}; constants: pi, e.`);
        eat('(');
        const args = [];
        if (!isOp(')')) { args.push(expr_()); while (isOp(',')) { i++; args.push(expr_()); } }
        eat(')');
        if (args.length < f[0] || args.length > f[1]) throw new Error(`${t.v} takes ${f[0] === f[1] ? f[0] : `${f[0]} to ${f[1]}`} argument${f[1] === 1 ? '' : 's'}.`);
        return f[2](...args);
      }
      throw new Error(`Unexpected "${t.v}".`);
    };

    const v = expr_();
    if (i < toks.length) throw new Error(`Unexpected "${toks[i].v}" after the expression.`);
    if (!Number.isFinite(v)) throw new Error('The result is not a finite number.');
    return { result: Number(v.toPrecision(12)) };
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
}
