import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import worker, { allowedOrigin, _test } from '../worker/index.js';

const env = { GITHUB_CLIENT_ID: 'Iv1.abc', GITHUB_APP_SLUG: 'squiggle-keal', ENABLE_FETCH: 'true', ALLOWED_ORIGINS: 'https://other.example' };
const req = (path, init = {}) => new Request('https://sq.example.workers.dev' + path, init);

test('git relay only matches github.com smart-HTTP paths', () => {
  const ok = ['/api/git/github.com/KealJones/squiggle.git/info/refs', '/api/git/github.com/a/b/git-upload-pack', '/api/git/github.com/a/b.git/git-receive-pack'];
  const bad = ['/api/git/evil.com/a/b.git/info/refs', '/api/git/github.com/a/b.git/HEAD', '/api/git/github.com/a/../b/info/refs', '/api/git/github.com/a/b/c/info/refs'];
  for (const p of ok) assert.ok(_test.GIT_PATH.test(p), p);
  for (const p of bad) assert.ok(!_test.GIT_PATH.test(p), p);
});

test('origins: same-origin and listed only', () => {
  const u = new URL('https://sq.example.workers.dev/api/config');
  assert.equal(allowedOrigin('https://sq.example.workers.dev', u, env), 'https://sq.example.workers.dev');
  assert.equal(allowedOrigin('https://other.example', u, env), 'https://other.example');
  assert.equal(allowedOrigin('https://evil.example', u, env), null);
  assert.equal(allowedOrigin(null, u, env), null);
});

test('foreign origins are refused', async () => {
  const r = await worker.fetch(req('/api/config', { headers: { Origin: 'https://evil.example' } }), env);
  assert.equal(r.status, 403);
});

test('config exposes no secrets', async () => {
  const r = await worker.fetch(req('/api/config'), env);
  const d = await r.json();
  assert.deepEqual(d, { appSlug: 'squiggle-keal', clientConfigured: true, fetchEnabled: true, aiEnabled: false });
});

test('device flow sends only the public client id to GitHub', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = mock.fn(async (url, init) => { calls.push({ url, body: String(init.body) }); return new Response('{"device_code":"d","user_code":"ABCD-1234"}'); });
  try {
    const r = await worker.fetch(req('/api/auth/device', { method: 'POST', headers: { Origin: 'https://sq.example.workers.dev' }, body: '{}' }), env);
    assert.equal((await r.json()).user_code, 'ABCD-1234');
    assert.equal(calls[0].url, 'https://github.com/login/device/code');
    assert.equal(calls[0].body, 'client_id=Iv1.abc');
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://sq.example.workers.dev');
    await worker.fetch(req('/api/auth/refresh', { method: 'POST', body: JSON.stringify({ refresh_token: 'ghr_x' }) }), env);
    assert.match(calls[1].body, /grant_type=refresh_token/);
    assert.ok(!/secret/.test(calls[1].body));
  } finally { globalThis.fetch = orig; }
});

test('git relay forwards auth to github.com and nothing else', async () => {
  const orig = globalThis.fetch;
  let seen;
  globalThis.fetch = mock.fn(async (url, init) => { seen = { url, init }; return new Response('ok', { headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement', 'Set-Cookie': 'x=1' } }); });
  try {
    const r = await worker.fetch(req('/api/git/github.com/a/b.git/info/refs?service=git-upload-pack', { headers: { Authorization: 'Basic abc', Cookie: 'secret=1' } }), env);
    assert.equal(seen.url, 'https://github.com/a/b.git/info/refs?service=git-upload-pack');
    assert.equal(seen.init.headers.get('Authorization'), 'Basic abc');
    assert.equal(seen.init.headers.get('Cookie'), null);
    assert.equal(r.headers.get('Set-Cookie'), null);
    const bad = await worker.fetch(req('/api/git/github.com/a/b.git/info/refs?service=evil'), env);
    assert.equal(bad.status, 400);
  } finally { globalThis.fetch = orig; }
});

test('fetch relay is opt-in and needs a browser same-origin request', async () => {
  const off = await worker.fetch(req('/api/fetch?url=https://example.com'), { ...env, ENABLE_FETCH: 'false' });
  assert.equal(off.status, 404);
  const noOrigin = await worker.fetch(req('/api/fetch?url=https://example.com'), env);
  assert.equal(noOrigin.status, 403);
  const badUrl = await worker.fetch(req('/api/fetch?url=file:///etc/passwd', { headers: { 'Sec-Fetch-Site': 'same-origin' } }), env);
  assert.equal(badUrl.status, 400);
});

test('search: parses DuckDuckGo Lite, decodes links and entities, skips ads', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('./fixtures/ddg-lite.html', import.meta.url), 'utf8');
  const r = _test.parseDdgLite(html);
  assert.deepEqual(r, [
    { title: 'Squiggle & Friends docs', url: 'https://example.com/docs/squiggle?a=1&b=2', snippet: 'How the relay works "end to end" \'quickly\'.' },
    { title: 'A blog post', url: 'https://blog.example.org/post', snippet: 'Second result snippet.' },
  ]);
});

test('search endpoint: browser-only, opt-in, returns JSON results, reports bot checks', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('./fixtures/ddg-lite.html', import.meta.url), 'utf8');
  const orig = globalThis.fetch;
  let page = html, seen, ia = {};
  globalThis.fetch = mock.fn(async (url) => {
    if (url.startsWith('https://api.duckduckgo.com/')) return Response.json(ia);
    seen = url; return new Response(page);
  });
  try {
    const headers = { Origin: 'https://sq.example.workers.dev' };
    const ok = await worker.fetch(req('/api/search?q=squiggle%20relay&n=1', { headers }), env);
    assert.equal(ok.status, 200);
    assert.equal(seen, 'https://lite.duckduckgo.com/lite/?q=squiggle%20relay');
    const d = await ok.json();
    assert.equal(d.results.length, 1);
    assert.equal(d.results[0].url, 'https://example.com/docs/squiggle?a=1&b=2');
    assert.equal((await worker.fetch(req('/api/search?q=x'), env)).status, 403, 'no Origin');
    assert.equal((await worker.fetch(req('/api/search?q=x', { headers }), { ...env, ENABLE_FETCH: 'false' })).status, 404);
    assert.equal((await worker.fetch(req('/api/search?q=', { headers }), env)).status, 400);
    assert.equal(d.answer, null, 'no instant answer for a specific query');
    ia = { Heading: 'Cloudflare', AbstractText: 'Cloudflare, Inc., is an American <i>company</i>.', AbstractSource: 'Wikipedia', AbstractURL: 'https://en.wikipedia.org/wiki/Cloudflare' };
    const withIa = await (await worker.fetch(req('/api/search?q=Cloudflare', { headers }), env)).json();
    assert.deepEqual(withIa.answer, { heading: 'Cloudflare', text: 'Cloudflare, Inc., is an American company.', source: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Cloudflare' });
    page = '<html>Unfortunately, bots use DuckDuckGo too. anomaly</html>';
    const partly = await worker.fetch(req('/api/search?q=Cloudflare', { headers }), env);
    assert.equal(partly.status, 200, 'results blocked but an instant answer still comes back');
    assert.equal((await partly.json()).results.length, 0);
    ia = {};
    const blocked = await worker.fetch(req('/api/search?q=x', { headers }), env);
    assert.equal(blocked.status, 503);
  } finally { globalThis.fetch = orig; }
});

test('instant answers: picks answer, then abstract, then definition', () => {
  const { instantAnswer } = _test;
  assert.equal(instantAnswer({}), null);
  assert.equal(instantAnswer(null), null);
  assert.equal(instantAnswer({ Answer: '4', AnswerType: 'calc', AbstractText: 'x' }).text, '4');
  assert.equal(instantAnswer({ Definition: 'A wavy line.', DefinitionSource: 'Wordnik' }).source, 'Wordnik');
});

// ── Cloud model ───────────────────────────────────────────────────────────
function aiEnv({ limit = '9000', run } = {}) {
  const store = new Map();
  const budget = new _test.AiBudget({ storage: { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v); } } });
  const calls = [];
  return {
    calls, store,
    env: {
      ...env, AI_USERS: 'KealJones', AI_DAILY_NEURONS: limit,
      AI_BUDGET: { idFromName: () => 'id', get: () => ({ fetch: (u, init) => budget.fetch(new Request(u, init)) }) },
      AI: { run: async (model, body) => { calls.push({ model, body }); return run ? run(body) : { choices: [{ message: { content: 'Hi from the cloud', tool_calls: [{ id: 't1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }] } }], usage: { prompt_tokens: 80, completion_tokens: 50, neurons: 2.2 } }; } },
    },
  };
}
const aiReq = (login, body = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 200 }) => req('/api/ai/chat', { method: 'POST', headers: { Authorization: 'Bearer tok-' + login, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const ghUser = (login) => mock.method(globalThis, 'fetch', async (u, init) => {
  assert.equal(String(u), 'https://api.github.com/user');
  assert.match(init.headers.Authorization, /^Bearer tok-/);
  return Response.json({ login: init.headers.Authorization.replace('Bearer tok-', '') });
});

test('cloud model: off without config, only for allowed GitHub users', async () => {
  let r = await worker.fetch(aiReq('KealJones'), env);
  assert.equal(r.status, 404);
  assert.equal((await (await worker.fetch(req('/api/config'), env)).json()).aiEnabled, false);
  const { env: e, calls } = aiEnv();
  const f = ghUser();
  try {
    r = await worker.fetch(aiReq('someone-else'), e);
    assert.equal(r.status, 403);
    r = await worker.fetch(req('/api/ai/chat', { method: 'POST', body: '{}' }), e);
    assert.equal(r.status, 401);
    assert.equal(calls.length, 0, 'never reached Workers AI');
    r = await worker.fetch(aiReq('kealjones'), e); // logins compare case-insensitively
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.content, 'Hi from the cloud');
    assert.deepEqual(d.tool_calls, [{ id: 't1', function: { name: 'web_search', arguments: '{"query":"x"}' } }]);
    assert.equal(d.budget.used, 2.2, 'charged the real usage, not the reservation');
    assert.equal(calls[0].model, '@cf/google/gemma-4-26b-a4b-it');
  } finally { f.mock.restore(); }
});

test('cloud model: hard daily cap, checked before calling Workers AI', async () => {
  const { env: e, calls, store } = aiEnv({ limit: '20' });
  const f = ghUser();
  try {
    // Worst case for 200 output tokens is ~5.5 neurons; real use 2.2 each.
    for (let i = 0; i < 6; i++) assert.equal((await worker.fetch(aiReq('KealJones'), e)).status, 200);
    assert.ok(Math.abs(store.get('usage').used - 13.2) < 0.01);
    // The next requests would risk going over: refused without calling the model.
    const before = calls.length;
    let r;
    for (let i = 0; i < 3; i++) r = await worker.fetch(aiReq('KealJones'), e);
    const d = await r.json();
    assert.equal(r.status, 429);
    assert.equal(d.error, 'limit');
    assert.match(d.message, /today's free cloud limit/);
    assert.ok(d.resetsAt > Date.now());
    assert.ok(calls.length - before <= 1);
    assert.ok(store.get('usage').used <= 20);
    // A new UTC day starts fresh.
    store.set('usage', { day: '2000-01-01', used: 9999 });
    assert.equal((await worker.fetch(aiReq('KealJones'), e)).status, 200);
  } finally { f.mock.restore(); }
});

test('cloud model: the cap can never be set above the free tier', async () => {
  assert.equal(_test.aiEstimate({ messages: [{ role: 'user', content: 'x'.repeat(3000) }], max_tokens: 1000 }) > 27, true);
  const { env: e } = aiEnv({ limit: '50000' });
  const f = ghUser();
  try {
    const d = await (await worker.fetch(aiReq('KealJones'), e)).json();
    assert.equal(d.budget.limit, 9900);
  } finally { f.mock.restore(); }
});

test('cloud model: a Workers AI quota error comes back as the limit message and refunds the reservation', async () => {
  const { env: e, store } = aiEnv({ run: () => { throw new Error('AiError: 4006: you have used up your daily free allocation of 10,000 neurons'); } });
  const f = ghUser();
  try {
    const r = await worker.fetch(aiReq('KealJones'), e);
    assert.equal(r.status, 429);
    assert.match((await r.json()).message, /allowance is used up/);
    assert.equal(store.get('usage').used, 0);
  } finally { f.mock.restore(); }
});
