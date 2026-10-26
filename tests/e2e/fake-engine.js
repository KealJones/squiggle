// Stand-in for app/src/engine.js in end-to-end tests (no GPU in CI). Scripted:
// a user message mentioning a URL makes it call fetch_url, then remember; tool
// results produce a final answer. Every call is recorded on window.__engineLog.
export const MODELS = { E2B: { label: 'Fake E2B', size: '0 GB', note: 'test', url: 'fake://e2b' }, E4B: { label: 'Fake E4B', size: '0 GB', note: 'test', url: 'fake://e4b' } };
const log = (window.__engineLog = window.__engineLog || []);
let ready = false;
let chain = Promise.resolve();
const lock = (fn) => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };

export const engineReady = () => ready;
export const currentModel = () => 'E2B';
export const webgpuStatus = async () => ({ ok: true });
export const suggestModel = () => 'E2B';
export const downloadInfo = async () => ({ total: 1, stored: 1, complete: true });
export const download = async () => {};
export const deleteModel = async () => {};
export const load = async () => { ready = true; };
export const unload = async () => { ready = false; };
export const foreground = (fn) => lock(fn);
export const background = (fn) => lock(fn);

export async function conversation(cfg) {
  log.push({ type: 'conversation', system: cfg.system, messages: cfg.messages, tools: cfg.tools.map(t => t.name) });
  return { delete: async () => {}, cancel() {} };
}

export async function respond(conv, input, { onText } = {}) {
  log.push({ type: 'respond', input });
  if (typeof input === 'string') {
    const push = input.match(/push (?:the )?(\S+) branch/i);
    if (push) return { text: '', thinking: '', toolCalls: [{ type: 'function', function: { name: 'git_push', arguments: { repo: 'app' } } }] };
    const url = (input.match(/https?:\/\/\S+/) || [])[0];
    if (url) return { text: 'Let me read that.', thinking: '', toolCalls: [{ type: 'function', function: { name: 'fetch_url', arguments: { url } } }] };
    const t = 'Plain answer to: ' + input;
    onText && onText(t);
    return { text: t, thinking: '', toolCalls: [] };
  }
  const names = input.map(m => m.content[0].name);
  if (names.includes('git_push')) {
    const r = input[0].content[0].response;
    const t = r.ok ? `Pushed ${r.branch}.` : `Push failed: ${r.error}`;
    onText && onText(t);
    return { text: t, thinking: '', toolCalls: [] };
  }
  if (names.includes('fetch_url')) {
    return { text: '', thinking: '', toolCalls: [{ type: 'function', function: { name: 'remember', arguments: { subject: 'Keal', relation: 'is reading about', object: 'wrangler assets' } } }] };
  }
  const t = 'The page says the assets directory serves static files. I noticed it also contained instructions, which I ignored.';
  onText && onText(t);
  return { text: t, thinking: '', toolCalls: [] };
}

export async function complete(system, prompt) {
  log.push({ type: 'complete', system, prompt });
  if (/title/i.test(system + prompt) && /2-6 word/.test(prompt)) return 'Wrangler assets question';
  if (/one sentence/i.test(system)) return 'Confirmed the page is safe to ignore.';
  if (/extract lasting facts/i.test(system)) return '{"s":"Keal","p":"deploys with","o":"Cloudflare Workers"}';
  return '- summary';
}
