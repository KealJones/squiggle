// Squiggle relay — a Cloudflare Worker that serves the app (static assets in
// ./app) and the few things a browser can't do against GitHub on its own,
// because github.com's login and git endpoints don't send CORS headers:
//
//   GET  /api/config                     public app settings (app slug, features)
//   POST /api/auth/device                start GitHub device-flow sign-in
//   POST /api/auth/token                 poll device flow for the user token
//   POST /api/auth/refresh               rotate an expiring user token
//   ANY  /api/git/github.com/<o>/<r>/... git smart-HTTP relay (clone/fetch/push)
//   GET  /api/fetch?url=...              optional readable-web relay (ENABLE_FETCH)
//   GET  /api/search?q=...               web search (ENABLE_FETCH): LangSearch when the
//                                        LANGSEARCH_API_SECRET_KEY secret is set, else (or if it
//                                        fails) DuckDuckGo Lite plus its Instant Answer, then
//                                        Wikipedia search when DuckDuckGo asks for a bot check
//   GET  /api/ai/status                  cloud model: enabled? today's usage and limit
//   POST /api/ai/chat                    cloud model (Workers AI), for allowed GitHub users only,
//                                        with a hard daily cap that never goes past the free tier
//
// Its only optional secret is a search API key (LANGSEARCH_API_SECRET_KEY), used
// here and never sent to the browser. Device-flow tokens are minted and refreshed
// with only the public client ID. Tokens pass through the relay on their way to GitHub
// but are never stored or logged.

const GITHUB = 'https://github.com';
const GIT_PATH = /^\/api\/git\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const FETCH_MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      // Everything else is the static app (wrangler serves ./app before the
      // Worker runs; this is the fallback when a path matches no asset).
      if (!env.ASSETS) return new Response('Not found', { status: 404 });
      if (url.pathname.endsWith('/')) {
        const index = new URL(url.pathname + 'index.html', url);
        return env.ASSETS.fetch(new Request(index, request));
      }
      return env.ASSETS.fetch(request);
    }

    const origin = request.headers.get('Origin');
    const allowed = allowedOrigin(origin, url, env);
    if (origin && !allowed) return json({ error: 'Origin not allowed.' }, 403);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(allowed, request) });

    let res;
    try {
      res = await route(request, url, env);
    } catch (e) {
      res = json({ error: String((e && e.message) || e) }, e && e.status || 502);
    }
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors(allowed, request))) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};

async function route(request, url, env) {
  const p = url.pathname;

  if (p === '/api/config' && request.method === 'GET') {
    return json({
      appSlug: env.GITHUB_APP_SLUG || null,
      clientConfigured: Boolean(env.GITHUB_CLIENT_ID),
      fetchEnabled: env.ENABLE_FETCH === 'true',
      aiEnabled: aiEnabled(env),
    });
  }

  if (p === '/api/ai/status' && request.method === 'GET') {
    if (!aiEnabled(env)) return json({ enabled: false });
    return json({ enabled: true, ...(await budget(env, 'status')) });
  }
  if (p === '/api/ai/chat') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    return aiChat(request, env);
  }

  if (p.startsWith('/api/auth/')) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    if (!env.GITHUB_CLIENT_ID) return json({ error: 'GITHUB_CLIENT_ID is not set on the Worker.' }, 500);
    const body = await request.json().catch(() => ({}));

    if (p === '/api/auth/device') {
      return githubForm('/login/device/code', { client_id: env.GITHUB_CLIENT_ID });
    }
    if (p === '/api/auth/token') {
      if (typeof body.device_code !== 'string') return json({ error: 'device_code required' }, 400);
      return githubForm('/login/oauth/access_token', {
        client_id: env.GITHUB_CLIENT_ID,
        device_code: body.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
    }
    if (p === '/api/auth/refresh') {
      if (typeof body.refresh_token !== 'string') return json({ error: 'refresh_token required' }, 400);
      // Device-flow tokens refresh without a client secret.
      return githubForm('/login/oauth/access_token', {
        client_id: env.GITHUB_CLIENT_ID,
        refresh_token: body.refresh_token,
        grant_type: 'refresh_token',
      });
    }
    return json({ error: 'Not found.' }, 404);
  }

  if (p.startsWith('/api/git/')) return gitRelay(request, url);

  if (p === '/api/fetch') {
    if (env.ENABLE_FETCH !== 'true') return json({ error: 'Web fetch relay is disabled.' }, 404);
    if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
    // Only the app's own pages may use the relay (browsers can't forge these
    // headers; non-browser clients could, which is why it's opt-in).
    const site = request.headers.get('Sec-Fetch-Site');
    if (!request.headers.get('Origin') && site !== 'same-origin') return json({ error: 'Forbidden.' }, 403);
    return webRelay(url.searchParams.get('url'));
  }

  if (p === '/api/search') {
    if (env.ENABLE_FETCH !== 'true') return json({ error: 'Web access is disabled on the relay.' }, 404);
    if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
    const site = request.headers.get('Sec-Fetch-Site');
    if (!request.headers.get('Origin') && site !== 'same-origin') return json({ error: 'Forbidden.' }, 403);
    return webSearch(url.searchParams.get('q'), Number(url.searchParams.get('n')) || 8, env);
  }

  return json({ error: 'Not found.' }, 404);
}

// ── Web search (DuckDuckGo Lite: no key, plain HTML) ───────────────────────
async function webSearch(q, n, env = {}) {
  const query = String(q || '').trim().slice(0, 300);
  if (!query) return json({ error: 'Pass a search query: ?q=...' }, 400);
  if (env.LANGSEARCH_API_SECRET_KEY) {
    const results = await langSearch(query, Math.min(Math.max(n, 1), 15), env.LANGSEARCH_API_SECRET_KEY).catch(() => null);
    if (results && results.length) return json({ query, answer: null, results });
    // Over its limit, down, or nothing found: DuckDuckGo below.
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; squiggle-relay)' };
    // Results page and the official Instant Answer API, in parallel. The
    // instant answer is a bonus: it failing never fails the search.
    const [page, instant] = await Promise.all([
      fetch('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query), { headers: { ...headers, Accept: 'text/html' }, signal: ctrl.signal }).then(r => r.text()),
      fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&t=squiggle`, { headers: { ...headers, Accept: 'application/json' }, signal: ctrl.signal })
        .then(r => r.json()).catch(() => null),
    ]);
    const answer = instantAnswer(instant);
    const blocked = /anomaly|captcha/i.test(page) && !/result-link/.test(page);
    const count = Math.min(Math.max(n, 1), 15);
    if (blocked) {
      // DuckDuckGo wants a bot check: Wikipedia's search still answers most lookups.
      const wiki = await wikipediaSearch(query, count, ctrl.signal).catch(() => []);
      if (!wiki.length && !answer) return json({ error: 'DuckDuckGo is asking for a bot check right now and Wikipedia found nothing. Try again in a little while.' }, 503);
      return json({ query, answer, results: wiki, note: 'DuckDuckGo asked for a bot check, so these results are from Wikipedia search.' });
    }
    return json({ query, answer, results: parseDdgLite(page).slice(0, count) });
  } finally {
    clearTimeout(timer);
  }
}

// LangSearch (https://docs.langsearch.com): a real search API with a free plan.
// Snippets only, so results stay small for 4K phone contexts. Following its best
// practices: questions about what's current search the past year first and widen
// to all time when that comes back thin; a brief server error is retried once.
const RECENT = /\b(latest|newest|most recent|recent(ly)?|current(ly)?|right now|nowadays|today|tonight|this (week|month|year|season)|upcoming|new(est)? (season|series|version|release|episode|album|movie|model))\b/i;
async function langSearch(query, n, key) {
  const freshness = RECENT.test(query) ? 'oneYear' : 'noLimit';
  const first = await langSearchOnce(query, n, key, freshness);
  if (freshness !== 'noLimit' && first && first.length < Math.min(3, n)) {
    const wide = await langSearchOnce(query, n, key, 'noLimit');
    if (wide && wide.length > first.length) return [...first, ...wide.filter(w => !first.some(f => f.url === w.url))].slice(0, n);
  }
  return first;
}
async function langSearchOnce(query, n, key, freshness, attempt = 0) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.langsearch.com/v1/web-search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, count: n, freshness }),
      signal: ctrl.signal,
    });
    if (r.status >= 500 && attempt === 0) {
      clearTimeout(timer);
      await new Promise(res => setTimeout(res, 300 + Math.random() * 400));
      return langSearchOnce(query, n, key, freshness, 1);
    }
    if (!r.ok) return null;   // 429 (burst or daily allowance) and the rest: DuckDuckGo instead
    const d = await r.json();
    const items = (d && d.data && d.data.webPages && d.data.webPages.value) || [];
    return items.filter(x => x && x.url).slice(0, n).map(x => ({
      title: cleanText(x.name || x.url),
      url: x.url,
      snippet: cleanText(x.snippet || x.text || '').slice(0, 400),
    }));
  } finally {
    clearTimeout(timer);
  }
}

// Wikipedia's search API (no key): the fallback when DuckDuckGo is blocked.
async function wikipediaSearch(query, n, signal) {
  const u = 'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=' + Math.min(n, 10) + '&srsearch=' + encodeURIComponent(query);
  const d = await fetch(u, { headers: { 'User-Agent': 'squiggle-relay (https://github.com/KealJones/squiggle)', Accept: 'application/json' }, signal }).then(r => r.json());
  return ((d && d.query && d.query.search) || []).map(r => ({
    title: r.title,
    url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(r.title).replace(/ /g, '_')),
    snippet: cleanText(r.snippet),
  }));
}

const decodeEntities = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const cleanText = (s) => decodeEntities(String(s || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

// The useful part of an Instant Answer API response, or null when it has
// nothing (most specific queries). Prefers a direct answer, then the topic
// summary (usually Wikipedia), then a definition.
export function instantAnswer(d) {
  if (!d || typeof d !== 'object') return null;
  const pick = (text, source, url, heading) => text ? { heading: heading || d.Heading || '', text: cleanText(text).slice(0, 1200), source: source || 'DuckDuckGo', url: url || '' } : null;
  return pick(d.Answer && String(d.Answer), 'DuckDuckGo', '', d.AnswerType)
    || pick(d.AbstractText, d.AbstractSource, d.AbstractURL)
    || pick(d.Definition, d.DefinitionSource, d.DefinitionURL)
    || null;
}

// Pulls { title, url, snippet } out of a DuckDuckGo Lite results page.
// Result links go through a duckduckgo.com/l/?uddg=<real url> redirect;
// ads go through y.js and are skipped.
export function parseDdgLite(html) {
  const out = [];
  const linkRe = /<a[^>]+href=["']([^"']+)["'][^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
  const matches = [...String(html).matchAll(linkRe)];
  matches.forEach((m, i) => {
    let href = decodeEntities(m[1]);
    if (/\/y\.js|ad_provider|ad_domain/.test(href)) return;
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith('//')) href = 'https:' + href;
    if (!/^https?:\/\//.test(href)) return;
    const end = i + 1 < matches.length ? matches[i + 1].index : html.length;
    const block = html.slice(m.index, end);
    const snip = block.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i);
    out.push({ title: cleanText(m[2]), url: href, snippet: snip ? cleanText(snip[1]) : '' });
  });
  return out;
}

async function githubForm(path, params) {
  const r = await fetch(GITHUB + path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'squiggle-relay' },
    body: new URLSearchParams(params),
  });
  // GitHub returns OAuth errors (authorization_pending, slow_down, ...) as
  // 200 + {error}; pass them through untouched for the client to handle.
  return new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'application/json' } });
}

async function gitRelay(request, url) {
  const m = url.pathname.match(GIT_PATH);
  if (!m) return json({ error: 'Only github.com git smart-HTTP paths are relayed.' }, 400);
  const [, owner, repo, , endpoint] = m;
  if (endpoint === 'info/refs') {
    const svc = url.searchParams.get('service');
    if (svc !== 'git-upload-pack' && svc !== 'git-receive-pack') return json({ error: 'Bad service.' }, 400);
  } else if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405);
  }
  const target = `${GITHUB}/${owner}/${repo}.git/${endpoint}${url.search}`;
  const headers = new Headers({ 'User-Agent': 'git/squiggle-relay' });
  for (const h of ['Authorization', 'Content-Type', 'Accept', 'Git-Protocol', 'Content-Encoding']) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    // Buffered rather than streamed: works on every runtime, and git request
    // bodies (negotiation, pushed packs) are well within Worker memory.
    body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
    redirect: 'manual',
  });
  const out = new Headers();
  for (const h of ['Content-Type', 'Cache-Control', 'WWW-Authenticate']) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

async function webRelay(raw) {
  let target;
  try { target = new URL(raw || ''); } catch { return json({ error: 'A full http(s) URL is required.' }, 400); }
  if (!/^https?:$/.test(target.protocol)) return json({ error: 'Only http(s) URLs.' }, 400);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    // No cookies or credentials are forwarded; the request is anonymous.
    const r = await fetch(target.href, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; squiggle-relay)', Accept: 'text/html,application/json,text/plain,*/*' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const reader = r.body ? r.body.getReader() : null;
    const chunks = [];
    let size = 0;
    let truncated = false;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FETCH_MAX_BYTES) { truncated = true; await reader.cancel(); break; }
      chunks.push(value);
    }
    const headers = {
      'Content-Type': r.headers.get('Content-Type') || 'application/octet-stream',
      'X-Final-Url': r.url,
      'X-Upstream-Status': String(r.status),
      'X-Truncated': String(truncated),
      'Access-Control-Expose-Headers': 'X-Final-Url, X-Upstream-Status, X-Truncated',
    };
    return new Response(new Blob(chunks), { status: 200, headers });
  } finally {
    clearTimeout(timer);
  }
}

// ── Cloud model (Workers AI) ────────────────────────────────────────────────
// Off unless the Worker has an AI binding, a budget Durable Object and a list
// of GitHub logins allowed to use it (AI_USERS). Every request reserves its
// worst-case cost against today's budget first and is refused when that would
// go over AI_DAILY_NEURONS (default 9,000 — under Cloudflare's free 10,000 a
// day, which also covers any other Workers AI use on the account). The budget
// resets with Cloudflare's, at 00:00 UTC.
export const AI_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const AI_RATES = { input: 9091 / 1e6, output: 27273 / 1e6 }; // neurons per token
const AI_MAX_OUTPUT = 2048;
const aiEnabled = (env) => Boolean(env.AI && env.AI_BUDGET && (env.AI_USERS || '').trim());
export const aiLimit = (env) => Math.min(Number(env.AI_DAILY_NEURONS) || 9000, 9900);
export function aiEstimate(body) {
  const inputTokens = Math.ceil(JSON.stringify([body.messages, body.tools || []]).length / 3);
  const out = Math.min(Number(body.max_tokens) || 1024, AI_MAX_OUTPUT);
  return inputTokens * AI_RATES.input + out * AI_RATES.output;
}
export const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
export const nextReset = (t = Date.now()) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };

async function budget(env, op, amount = 0) {
  const stub = env.AI_BUDGET.get(env.AI_BUDGET.idFromName('daily'));
  const r = await stub.fetch('https://budget/' + op, { method: 'POST', body: JSON.stringify({ amount, limit: aiLimit(env) }) });
  return r.json();
}

// Who is calling: the GitHub user behind the token (cached briefly per isolate).
const userCache = new Map();
async function githubLogin(auth) {
  const hit = userCache.get(auth);
  if (hit && hit.until > Date.now()) return hit.login;
  const r = await fetch('https://api.github.com/user', { headers: { Authorization: auth, 'User-Agent': 'squiggle-relay', Accept: 'application/vnd.github+json' } });
  const login = r.ok ? (await r.json()).login : null;
  if (userCache.size > 100) userCache.clear();
  userCache.set(auth, { login, until: Date.now() + 10 * 60 * 1000 });
  return login;
}

async function aiChat(request, env) {
  if (!aiEnabled(env)) return json({ error: 'The cloud model is not set up on this relay.' }, 404);
  const auth = request.headers.get('Authorization') || '';
  if (!/^(Bearer|token) \S+$/.test(auth)) return json({ error: 'Sign in first.' }, 401);
  const login = await githubLogin(auth);
  const allowed = (env.AI_USERS || '').split(',').map(u => u.trim().toLowerCase()).filter(Boolean);
  if (!login || !allowed.includes(login.toLowerCase())) return json({ error: 'This GitHub account is not allowed to use the cloud model on this relay.' }, 403);

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.messages) || !body.messages.length) return json({ error: 'messages required' }, 400);
  const req = { messages: body.messages, max_tokens: Math.min(Number(body.max_tokens) || 1024, AI_MAX_OUTPUT) };
  if (Array.isArray(body.tools) && body.tools.length) req.tools = body.tools;
  if (typeof body.temperature === 'number') req.temperature = body.temperature;

  const estimate = aiEstimate(req);
  const held = await budget(env, 'reserve', estimate);
  if (!held.ok) return json({ error: 'limit', message: "You've hit today's free cloud limit, so the cloud model is paused until it resets.", ...held }, 429);
  let result;
  try {
    result = await env.AI.run(AI_MODEL, req);
  } catch (e) {
    await budget(env, 'settle', -estimate); // nothing was used (or Cloudflare refused)
    const msg = String((e && e.message) || e);
    if (/limit|quota|neuron|4006|exceeded/i.test(msg)) return json({ error: 'limit', message: "Cloudflare says today's free AI allowance is used up. The cloud model is paused until it resets.", resetsAt: nextReset() }, 429);
    return json({ error: 'The cloud model failed: ' + msg }, 502);
  }
  const usage = result.usage || {};
  const used = typeof usage.neurons === 'number' ? usage.neurons
    : (usage.prompt_tokens || 0) * AI_RATES.input + (usage.completion_tokens || 0) * AI_RATES.output;
  const after = await budget(env, 'settle', used - estimate);
  const msg = (result.choices && result.choices[0] && result.choices[0].message) || {};
  return json({
    content: msg.content || result.response || '',
    reasoning: msg.reasoning || '',
    tool_calls: (msg.tool_calls || result.tool_calls || []).map(t => ({ id: t.id, function: { name: t.function ? t.function.name : t.name, arguments: t.function ? t.function.arguments : t.arguments } })),
    usage: { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0, neurons: used },
    budget: after,
  });
}

// One instance ('daily') holds today's running total. Reservations make the
// cap hold even when several requests are in flight at once.
export class AiBudget {
  constructor(state) { this.storage = state.storage; }
  async fetch(request) {
    const op = new URL(request.url).pathname.slice(1);
    const { amount = 0, limit = 9000 } = await request.json().catch(() => ({}));
    const day = utcDay();
    let rec = (await this.storage.get('usage')) || { day, used: 0 };
    if (rec.day !== day) rec = { day, used: 0 };
    const view = (ok) => Response.json({ ok, used: Math.round(rec.used * 10) / 10, limit, resetsAt: nextReset() });
    if (op === 'reserve') {
      if (rec.used + amount > limit) return view(false);
      rec.used += amount;
    } else if (op === 'settle') {
      rec.used = Math.max(0, rec.used + amount);
    } else {
      return view(rec.used < limit);
    }
    await this.storage.put('usage', rec);
    return view(true);
  }
}

export function allowedOrigin(origin, url, env) {
  if (!origin) return null;
  if (origin === url.origin) return origin;
  const list = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

function cors(origin, request) {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || 'Authorization, Content-Type, Accept, Git-Protocol',
    'Access-Control-Expose-Headers': 'X-Final-Url, X-Upstream-Status, X-Truncated',
    'Access-Control-Max-Age': '600',
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export const _test = { GIT_PATH, route, parseDdgLite, instantAnswer, aiEstimate, AiBudget };
