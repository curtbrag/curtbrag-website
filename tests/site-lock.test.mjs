import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSiteLock, COOKIE, safeReturn } from '../netlify/edge-functions/lib/site-lock-core.js';
import limit from '../netlify/edge-functions/site-login-limit.js';
import { config as limitConfig } from '../netlify/edge-functions/site-login-limit.js';
import tea from '../netlify/edge-functions/tea-router.js';

const HOST = 'https://curtbrag.com';
function setup() {
  const entries = new Map(); let password = 'fixture-password', time = 100000, calls = 0;
  const store = { get: async key => entries.get(key) || null, setJSON: async (key, value) => entries.set(key, value), delete: async key => entries.delete(key) };
  const handler = createSiteLock({ getPassword: async () => password, getSessions: () => store, getAPIKey: async () => 'fixture-worker-key', now: () => time });
  const context = { next: async () => { calls++; return new Response('private-content', { headers: { 'cache-control': 'public, max-age=31536000', 'surrogate-control': 'max-age=3600' } }); } };
  return { handler, context, entries, store, calls: () => calls, advance: ms => time += ms, password: value => password = value };
}
function post(path, body, origin = HOST) {
  return new Request(HOST + path, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
}
async function login(s, target = '/') {
  const result = await s.handler(post('/_site/login', { password: 'fixture-password', return: target }), s.context);
  assert.equal(result.status, 303);
  return { result, cookie: result.headers.get('set-cookie').split(';')[0] };
}

test('every unauthenticated page, asset, alias and API is blocked before downstream content', async () => {
  const s = setup();
  for (const host of [HOST, 'https://www.curtbrag.com', 'https://voluble-torte-5e1269.netlify.app']) {
    for (const path of ['/', '/gallery/', '/shop/', '/rig/', '/cluster/dashboard/', '/cluster/display.html', '/assets/logo_header.png', '/scripts/cluster-swarm-live-v8.js', '/_astro/style.css', '/api/cluster', '/.netlify/functions/cluster-api?action=devices', '/.netlify/images?url=/assets/logo_header.png']) {
      const result = await s.handler(new Request(host + path), s.context);
      assert.equal(result.status, 401, host + path);
      assert.equal(result.headers.get('cache-control'), 'private, no-store, max-age=0');
      assert.match(await result.text(), /Enter the password/);
    }
  }
  assert.equal(s.calls(), 0);
});
test('correct password creates a random secure host-only cookie and preserves the requested path', async () => {
  const s = setup(); const a = await login(s, '/gallery/?x=1'); const b = await login(s);
  assert.equal(a.result.headers.get('location'), '/gallery/?x=1');
  const header = a.result.headers.get('set-cookie');
  assert.match(header, new RegExp(`^${COOKIE}=[a-f0-9]{64}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax$`));
  assert.notEqual(a.cookie, b.cookie); assert.equal(header.includes('fixture-password'), false);
  const key = createHash('sha256').update(a.cookie.split('=')[1]).digest('hex');
  assert.ok(s.entries.has(key));
  const response = await s.handler(new Request(HOST + '/gallery/', { headers: { cookie: a.cookie } }), s.context);
  assert.equal(response.status, 200); assert.equal(await response.text(), 'private-content');
  assert.equal(response.headers.get('x-curtbrag-access'), 'authenticated');
  assert.match(response.headers.get('cache-control'), /no-store/); assert.equal(response.headers.has('surrogate-control'), false);
});
test('wrong passwords, cross-site submissions and unsupported methods do not create sessions', async () => {
  const s = setup();
  assert.equal((await s.handler(post('/_site/login', { password: 'wrong' }), s.context)).status, 401);
  assert.equal((await s.handler(post('/_site/login', { password: 'fixture-password' }, 'https://evil.example'), s.context)).status, 403);
  assert.equal((await s.handler(new Request(HOST + '/_site/login', { method: 'DELETE' }), s.context)).status, 405);
  assert.equal((await s.handler(new Request(HOST + '/_site/login', { method: 'POST', body: '{}', headers: { origin: HOST, 'content-type': 'application/json' } }), s.context)).status, 415);
  assert.equal(s.entries.size, 0); assert.equal(s.calls(), 0);
});
test('forged, duplicated, expired, cross-host and password-revoked cookies are rejected', async () => {
  const s = setup(); const a = await login(s);
  for (const cookie of [`${COOKIE}=true`, `${COOKIE}=${'a'.repeat(64)}`, `${a.cookie}; ${a.cookie}`]) assert.equal((await s.handler(new Request(HOST, { headers: { cookie } }), s.context)).status, 401);
  assert.equal((await s.handler(new Request('https://www.curtbrag.com/', { headers: { cookie: a.cookie } }), s.context)).status, 401);
  s.password('new-password');
  assert.equal((await s.handler(new Request(HOST, { headers: { cookie: a.cookie } }), s.context)).status, 401);
  s.password('fixture-password'); s.advance(86400001);
  assert.equal((await s.handler(new Request(HOST, { headers: { cookie: a.cookie } }), s.context)).status, 401);
  assert.equal(s.calls(), 0);
});
test('logout revokes the session and clears its cookie, while cross-origin logout is rejected', async () => {
  const s = setup(); const a = await login(s);
  assert.equal((await s.handler(post('/_site/logout', {}, 'https://evil.example'), s.context)).status, 403);
  const req = post('/_site/logout', {}); req.headers.set('cookie', a.cookie);
  const result = await s.handler(req, s.context); assert.equal(result.status, 303); assert.match(result.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(s.entries.size, 0);
  assert.equal((await s.handler(new Request(HOST, { headers: { cookie: a.cookie } }), s.context)).status, 401);
});
test('configuration and session-storage failures fail closed', async () => {
  const s = setup(); s.password(null);
  assert.equal((await s.handler(post('/_site/login', { password: 'fixture-password' }), s.context)).status, 503);
  s.password('fixture-password'); s.store.setJSON = async () => { throw new Error('write failed'); };
  assert.equal((await s.handler(post('/_site/login', { password: 'fixture-password' }), s.context)).status, 503);
  s.store.get = async () => { throw new Error('read failed'); };
  assert.equal((await s.handler(new Request(HOST, { headers: { cookie: `${COOKIE}=${'a'.repeat(64)}` } }), s.context)).status, 503);
  assert.equal(s.calls(), 0);
});
test('return destinations cannot inject HTML or redirect off-site', async () => {
  for (const value of ['https://evil.example', '//evil.example', '/\\evil.example', '/%2fevil.example', '/%0d%0aLocation:evil', '/_site/login', '/_site/logout', '/%zz']) assert.equal(safeReturn(value), '/');
  const s = setup(); const result = await s.handler(new Request(HOST + '/_site/login?return=' + encodeURIComponent('/"><img src=x onerror=alert(1)>')), s.context);
  const html = await result.text(); assert.equal(html.includes('<img src=x'), false); assert.match(html, /&lt;img/);
});
test('login attempts use platform rate limits; Tea is routed only to its own page', async () => {
  assert.equal(limit(), undefined); assert.equal(limitConfig.rateLimit.windowLimit, 10);
  const s = setup(); const req = new Request('https://teathetruth.com/');
  assert.equal((await s.handler(req, s.context)).status, 200);
  assert.equal((await tea(req, s.context)).toString(), 'https://teathetruth.com/teathetruth/index.html');
  assert.equal(await tea(new Request(HOST), s.context), undefined);
});
test('browser submit can use JSON with a secure cookie, a safe destination and actionable errors', async () => {
  const s = setup();
  const req = post('/_site/login', {password:'fixture-password',return:'//evil.example'}); req.headers.set('accept','application/json');
  const result = await s.handler(req, s.context); assert.equal(result.status,200); assert.match(result.headers.get('set-cookie'),/HttpOnly; Secure/);
  assert.deepEqual(await result.json(),{ok:true,redirect:'/'});
  const bad = post('/_site/login', {password:'wrong'}); bad.headers.set('accept','application/json');
  const failure = await s.handler(bad,s.context); assert.equal(failure.status,401); assert.equal((await failure.json()).ok,false);
  const gate = await s.handler(new Request(HOST),s.context); const html = await gate.text();
  const nonce = /<script nonce="([a-f0-9]+)"/.exec(html)[1]; assert.ok(gate.headers.get('content-security-policy').includes("script-src 'nonce-"+nonce+"'"));
  assert.ok(gate.headers.get('content-security-policy').includes("connect-src 'self'"));
});
test('verified existing service credentials preserve API access without opening pages or files', async () => {
  const s = setup();
  for (const path of ['/api/cluster', '/.netlify/functions/swarm-core']) {
    for (const headers of [{authorization:'Bearer fixture-worker-key'}, {'x-agent-token':'fixture-worker-key'}, {'x-cluster-key':'fixture-worker-key'}]) {
      assert.equal((await s.handler(new Request(HOST + path,{headers}),s.context)).status,200);
    }
    assert.equal((await s.handler(new Request(HOST + path,{headers:{authorization:'Bearer wrong'}}),s.context)).status,401);
    assert.equal((await s.handler(new Request(HOST + path,{headers:{authorization:'Bearer fixture-password'}}),s.context)).status,401);
  }
  for (const path of ['/', '/gallery/', '/assets/logo_header.png', '/.netlify/images?url=/assets/logo_header.png']) {
    assert.equal((await s.handler(new Request(HOST + path,{headers:{authorization:'Bearer fixture-worker-key'}}),s.context)).status,401);
  }
});
