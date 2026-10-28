// Stand-in for app/src/engine.js in end-to-end tests (no GPU in CI). Scripted:
// a user message mentioning a URL makes it call fetch_url, then remember; tool
// results produce a final answer. Every call is recorded on window.__engineLog.
export const MODELS = {
  E4B: { label: 'Fake E4B', size: '3.0 GB', note: 'test', url: 'fake://e4b', phone: false, runtime: 'litert' },
  E2B: { label: 'Fake E2B', size: '2.0 GB', note: 'test', url: 'fake://e2b', phone: false, runtime: 'litert' },
  G3: { label: 'Fake G3', size: '242 MB', note: 'test', url: 'fake://g3', phone: true, runtime: 'wllama' },
  SQ: { label: 'Fake SQ', size: '219 MB', note: 'test', url: 'fake://sq', phone: true, runtime: 'wllama', tools: true },
  cloud: { label: 'Fake Cloud', size: 'no download', note: 'test', phone: true, runtime: 'cloud', needsRelay: true },
};
const log = (window.__engineLog = window.__engineLog || []);
let ready = false;
let chain = Promise.resolve();
const lock = (fn) => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };

export const engineReady = () => ready;
export const currentModel = () => 'E2B';
export const isLite = (id) => Boolean(MODELS[id] && MODELS[id].runtime === 'wllama');
export const chatOnly = (id) => isLite(id) && !(MODELS[id] && MODELS[id].tools);
export const webgpuStatus = async () => ({ ok: true });
export const suggestModel = () => 'E2B';
export const deviceModel = () => (/iPhone|Android/.test(navigator.userAgent) ? 'G3' : 'E4B');
export const needsGpu = (id) => Boolean(MODELS[id] && MODELS[id].runtime === 'litert');
export const cleanupStorage = async ({ keep } = {}) => { window.__cleanup = Object.keys(MODELS).filter(id => !keep || keep(id)); return 0; };
export const modelFitsDevice = (id) => !isMobile() || Boolean(MODELS[id] && MODELS[id].phone);
export const deleteModel = async (id) => { (window.__deleted = window.__deleted || []).push(id); };
export const isMobile = () => /iPhone|Android/.test(navigator.userAgent);
window.__loads = 0;
export const downloadInfo = async (id) => (window.__noE4B && id === 'E4B' ? { total: 0, stored: 0, complete: false } : { total: 1, stored: 1, complete: true });
export const download = async () => {};
export const load = async (id, ctx, opts = {}) => {
  opts.onStage && opts.onStage('loading the model onto the GPU');
  window.__loads++; window.__lastLoad = { id, ctx, opts: { fast: opts.fast } }; ready = true;
};
export const gpuSummary = async () => 'fake gpu, f16';
export const setProgress = (fn) => { window.__progress = fn; };
export const unload = async () => { ready = false; };
export const foreground = (fn) => lock(fn);
export const background = (fn) => lock(fn);

export async function conversation(cfg) {
  log.push({ type: 'conversation', system: cfg.system, messages: cfg.messages, tools: cfg.tools.map(t => t.name), known: cfg.known || [] });
  return { cfg, delete: async () => {}, cancel() {}, replaceResult(msg, response) { log.push({ type: 'replace', name: msg.content[0].name, response }); return true; } };
}

const call = (name, args) => ({ text: '', thinking: '', toolCalls: [{ type: 'function', function: { name, arguments: args } }] });
const say = (t, onText, thinking = '') => { onText && onText(t); return { text: t, thinking, toolCalls: [] }; };

// Step mode (docs/harness.md): PLANTEST plans two steps (find, then done; then
// an answer without done), NEEDTEST asks the user through `need`, and the final
// prompt gets a summary reply.
function stepScript(conv, input, onText) {
  const sys = (conv.cfg && conv.cfg.system) || '';
  if (typeof input === 'string') {
    if (/Every step is done/.test(input)) return say(/NEEDTEST/.test(input) ? 'Set up Wobble, as you said.' : 'Port 8080 had node (pid 4242); it is free now.', onText);
    if (/PLANTEST|NEEDTEST/.test(input) && /Work on step 1 now/.test(input)) {
      if (/NEEDTEST/.test(input)) return /The user answered/.test(sys) ? call('done', { result: 'Call it Wobble' }) : call('need', { what: 'What should the new project be called?' });
      return { ...call('find', { query: 'search the web for what uses port 8080' }), thinking: 'Look it up first.' };
    }
    if (/PLANTEST/.test(input) && /Work on step 2 now/.test(input)) return say('Stopped node (pid 4242).', onText);
    if (/^PLANTEST/.test(input)) return call('plan', { goal: 'Free port 8080', steps: ['Find what is listening on 8080', 'Stop it'] });
    if (/^NEEDTEST/.test(input)) return call('plan', { goal: 'Set up the repo', steps: ['Pick the repo'] });
    return null;
  }
  if (input[0] && input[0].content[0].name === 'find') return call('done', { result: 'node (pid 4242) is on 8080' });
  return null;
}

export async function respond(conv, input, { onText } = {}) {
  log.push({ type: 'respond', input, system: conv.cfg && conv.cfg.system });
  const scripted = stepScript(conv, input, onText);
  if (scripted) return scripted;
  if (typeof input === 'string') {
    const push = input.match(/push (?:the )?(\S+) branch/i);
    if (push) return { text: '', thinking: '', toolCalls: [{ type: 'function', function: { name: 'git_push', arguments: { repo: 'app' } } }] };
    const url = (input.match(/https?:\/\/\S+/) || [])[0];
    if (url) return { text: 'Let me read that.', thinking: '', toolCalls: [{ type: 'function', function: { name: 'fetch_url', arguments: { url } } }] };
    if (/markdown reply/i.test(input)) {
      const t = '**Bold** answer with a [link](https://www.example.com/page). Second sentence is here.\n\n```js\ncode()\n```\nAll `done` now.';
      onText && onText(t.slice(0, 60)); onText && onText(t);
      return { text: t, thinking: '', toolCalls: [] };
    }
    const t = 'Plain answer to: ' + input;
    onText && onText(t);
    return { text: t, thinking: '', toolCalls: [] };
  }
  const names = input.map(m => m.content[0].name);
  // CARDTEST: a page card, then grep in the saved page, then an answer.
  const first = input[0].content[0].response || {};
  if (names[0] === 'fetch_url' && first.saved) {
    return { text: '', thinking: 'Check: the card says the page is about Gemma 3 model sizes.\nNext: grep for the file size.', toolCalls: [{ type: 'function', function: { name: 'grep', arguments: { pattern: 'GB|MB', path: first.saved } } }] };
  }
  if (names[0] === 'grep' && /\/web\//.test(first.path || '')) {
    const t = 'The Q4_0 GGUF is 242 MB (from the page).';
    onText && onText(t);
    return { text: t, thinking: 'Check: grep found "The Q4_0 GGUF of the 270M model is 242 MB."', toolCalls: [] };
  }
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
  return { text: t, thinking: 'Checked the page for instructions before answering.', toolCalls: [] };
}

export async function complete(system, prompt) {
  log.push({ type: 'complete', system, prompt });
  if (/title/i.test(system + prompt) && /2-6 word/.test(prompt)) return 'Wrangler assets question';
  if (/one sentence/i.test(system)) return 'Confirmed the page is safe to ignore.';
  if (/extract lasting facts/i.test(system)) return '{"s":"Keal","p":"deploys with","o":"Cloudflare Workers"}';
  return '- summary';
}
