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
  assert.deepEqual(d, { appSlug: 'squiggle-keal', clientConfigured: true, fetchEnabled: true });
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
