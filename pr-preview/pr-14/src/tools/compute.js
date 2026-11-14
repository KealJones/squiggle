// Computation tools: exact maths (calc.js) and sandboxed JavaScript (sandbox.html).
import { truncate } from '../util.js';
import { calculate as calc } from '../calc.js';
import { defineTool, params, str } from './registry.js';

// ── Sandboxed JavaScript ──────────────────────────────────────────────────
// sandbox.html is an opaque-origin iframe that runs the code in a Worker: it
// can't reach the app's storage, token or sessions, and a runaway is killed.
let sandbox = null;
function getSandbox() {
  if (sandbox) return sandbox;
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.src = 'sandbox.html';
  frame.style.display = 'none';
  document.body.appendChild(frame);
  const pending = new Map();
  const ready = new Promise(res => {
    addEventListener('message', (e) => {
      if (e.source !== frame.contentWindow) return;
      if (e.data && e.data.ready) return res();
      const p = e.data && pending.get(e.data.id);
      if (p) { pending.delete(e.data.id); p(e.data); }
    });
  });
  sandbox = {
    async run(code, args, timeoutMs = 15000) {
      await ready;
      const id = Math.random().toString(36).slice(2);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          frame.contentWindow.postMessage({ kill: true }, '*'); // terminate the runaway worker
          resolve({ logs: [], error: `Timed out after ${timeoutMs / 1000}s.` });
        }, timeoutMs);
        pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
        frame.contentWindow.postMessage({ id, code, args }, '*');
      });
    },
  };
  return sandbox;
}

export const calculate = defineTool({
  name: 'calculate',
  group: 'maths and code',
  description: 'Calculate a math expression exactly: + - * / ^, parentheses, percentages (15% of 240), pi and e, sqrt, round(x, digits), min, max, abs, floor, ceil, pow, log, ln, exp. Use it for every sum, price, percentage or conversion; never do math in your head.',
  parameters: params({ expression: str('A math expression, e.g. "300 * 25% + (120 - 60)" or "round((72 - 32) * 5 / 9, 1)"') }, ['expression']),
  async run({ expression }) {
    const r = calc(expression);
    return r.error ? { model: { expression, error: r.error } } : { model: { expression, result: r.result }, label: `calculated ${truncate(String(expression), 40)} = ${r.result}` };
  },
});

export const runJs = defineTool({
  name: 'run_js',
  group: 'maths and code',
  description: 'Run JavaScript in an isolated sandbox (no access to the user\'s data or files). Use for code, data processing, or checking logic, not for plain math (use calculate). Use console.log or return a value. Top-level await works.',
  parameters: params({ code: str('JavaScript code') }, ['code']),
  async run({ code }) {
    const r = await getSandbox().run(String(code || ''));
    return { model: { stdout: truncate((r.logs || []).join('\n'), 6000), result: r.result != null ? truncate(r.result, 4000) : undefined, error: r.error || undefined }, label: 'ran JavaScript' };
  },
});
