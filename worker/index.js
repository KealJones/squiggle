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
//
// It holds NO secrets: device-flow tokens are minted and refreshed with only
// the public client ID. Tokens pass through the relay on their way to GitHub
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
    });
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

  return json({ error: 'Not found.' }, 404);
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

export const _test = { GIT_PATH, route };
