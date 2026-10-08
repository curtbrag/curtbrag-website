'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createPhoneFollow, validateFollowUrl } = require('../netlify/functions/lib/phone-follow.cjs');
const { fixture: apiFixture } = require('./control-command-api.test.cjs');
const deployment = require('../netlify/functions/lib/control-deployment.cjs');
const NOW = Date.parse('2026-10-08T23:00:00Z');
const SOURCE = 'curtis-s26-ultra';
const KEY = 'follow-state-v1';
const record = { controller_id: SOURCE, role: 'personal-controller', worker_enabled: false, mining_enabled: false };
const start = (requestId = crypto.randomUUID()) => ({ controller_id: SOURCE, duration_minutes: 60, request_id: requestId });
const stop = (requestId = crypto.randomUUID()) => ({ request_id: requestId });
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function fixture({ controllers = [record], attempts = 5 } = {}) {
  let value = null, revision = 0, clock = NOW, readFailure = false, writeFailure = null, gate = null, readReceipt = null, writeReceipt = null;
  const reads = [], writes = [];
  const store = {
    async getWithMetadata(key, options) {
      if (readFailure) throw Error('Fixture read failure');
      const snapshot = value === null ? null : { data: copy(value), etag: 'v' + revision };
      reads.push({ key, options });
      if (gate && gate.remaining > 0) { const current = gate; if (--current.remaining === 0) current.release(); await current.promise; }
      return readReceipt || snapshot;
    },
    async set(key, text, options) {
      const candidate = JSON.parse(text), expected = options.onlyIfNew ? value === null : options.onlyIfMatch === 'v' + revision;
      writes.push({ key, candidate: copy(candidate), options: copy(options), committed: false });
      if (writeFailure === 'throw') throw Error('Fixture write failure');
      if (writeFailure === 'conflict' || !expected) return { modified: false };
      if (writeReceipt) return writeReceipt;
      value = candidate; revision++; writes.at(-1).committed = true;
      if (writeFailure === 'after') { writeFailure = null; throw Error('Fixture response lost'); }
      return { modified: true, etag: 'v' + revision };
    },
  };
  const api = createPhoneFollow({ store, controllers: { list: async () => controllers }, now: () => clock, maxAttempts: attempts });
  return { api, store, reads, writes, snapshot: () => copy(value), seed: next => { value = copy(next); revision++; }, advance: milliseconds => { clock += milliseconds; },
    failRead: () => { readFailure = true; }, failWrite: kind => { writeFailure = kind; }, readReceipt: receipt => { readReceipt = receipt; }, writeReceipt: receipt => { writeReceipt = receipt; },
    barrier(count = 2) { let release; const promise = new Promise(resolve => { release = resolve; }); gate = { remaining: count, promise, release }; } };
}
const update = (session, overrides = {}) => ({ session_id: session, status: 'following', message: 'Current website requested.', current_url: 'https://www.google.com/search?q=tools',
  current_navigation: { id: 'navigation-1', units: [{ device_id: 'phone191', status: 'queued', job_id: 'follow-job-191' }] }, ...overrides });

test('absent state is OFF, has no capture metadata and performs no write', async () => {
  const h = fixture(), response = await h.api.status();
  assert.deepEqual(response, { ok: true, follow: { active: false, session_id: null, controller_id: null, expires_at: null, started_at: null, stopped_at: null,
    runner: { status: 'off', message: 'Following is off.', seen_at: null }, current_url: null, current_navigation: null } });
  assert.equal(h.writes.length, 0); assert.equal(h.reads[0].options.consistency, 'strong');
});
test('one registered S26 starts a fixed one-hour session without enrolling a worker', async () => {
  const h = fixture(), response = await h.api.start(start());
  assert.equal(response.follow.active, true); assert.equal(response.follow.controller_id, SOURCE);
  assert.equal(response.follow.started_at, NOW); assert.equal(response.follow.expires_at, NOW + 3600000);
  assert.equal(response.follow.runner.status, 'waiting'); assert.equal(response.follow.runner.seen_at, null);
  assert.equal(response.follow.current_url, null); assert.ok(h.writes[0].options.onlyIfNew);
  assert.equal(JSON.stringify(response).includes('worker_enabled'), false); assert.equal(Object.hasOwn(response.follow, 'request_receipts'), false);
});
test('missing or worker/mining controller registration never starts', async () => {
  for (const controllers of [[], [{ ...record, worker_enabled: true }], [{ ...record, mining_enabled: true }], [{ ...record, role: 'worker' }]]) {
    const h = fixture({ controllers }); await assert.rejects(h.api.start(start()), error => error.statusCode === 409); assert.equal(h.writes.length, 0);
  }
});
test('Start replay and a second active Start preserve the same session and original expiry', async () => {
  const h = fixture(), request = start(), first = await h.api.start(request);
  h.advance(5000); const replay = await h.api.start(request), another = await h.api.start(start());
  assert.deepEqual(replay.follow, first.follow); assert.deepEqual(another.follow, first.follow);
  assert.equal(h.writes.filter(write => write.committed).length, 2);
});
test('a stopped Start request cannot reactivate, and a repeated old Stop cannot stop a later session', async () => {
  const h = fixture(), firstStart = start(), first = await h.api.start(firstStart), firstStop = stop();
  await h.api.runnerUpdate(update(first.follow.session_id));
  const stopped = await h.api.stop(firstStop);
  assert.equal(stopped.follow.active, false); assert.equal(stopped.follow.current_url, null); assert.equal(stopped.follow.current_navigation, null);
  assert.equal((await h.api.start(firstStart)).follow.active, false);
  const fresh = await h.api.start(start()); assert.notEqual(fresh.follow.session_id, first.follow.session_id);
  assert.equal((await h.api.stop(firstStop)).follow.session_id, fresh.follow.session_id); assert.equal((await h.api.status()).follow.active, true);
});
test('expiry turns OFF and erases current URL/report without extending the lease', async () => {
  const h = fixture(), first = await h.api.start(start()); await h.api.runnerUpdate(update(first.follow.session_id)); h.advance(3600000);
  const response = await h.api.status(); assert.equal(response.follow.active, false); assert.equal(response.follow.stopped_at, first.follow.expires_at);
  assert.equal(response.follow.current_url, null); assert.equal(response.follow.current_navigation, null); assert.equal(h.snapshot().current_url, null);
  await assert.rejects(h.api.runnerUpdate(update(first.follow.session_id)), error => error.statusCode === 409);
});
test('concurrent Starts preserve one session and both request receipts with conditional writes', async () => {
  const h = fixture(); h.barrier(); const results = await Promise.all([h.api.start(start()), h.api.start(start())]);
  assert.equal(results[0].follow.session_id, results[1].follow.session_id); assert.equal(h.snapshot().request_receipts.length, 2);
  assert.ok(h.writes.every(write => write.options.onlyIfNew || write.options.onlyIfMatch));
});
test('a runner update racing Stop cannot resurrect or retain browsing metadata', async () => {
  for (const stopFirst of [false, true]) {
    const h = fixture(), first = await h.api.start(start()); h.barrier();
    const work = [() => h.api.runnerUpdate(update(first.follow.session_id)), () => h.api.stop(stop())]; if (stopFirst) work.reverse();
    const results = await Promise.allSettled(work.map(run => run()));
    assert.ok(results.some(result => result.status === 'fulfilled'));
    const state = (await h.api.status()).follow; assert.equal(state.active, false); assert.equal(state.current_url, null); assert.equal(state.current_navigation, null);
  }
});
test('stale session reports and off reports during active sessions fail without state changes', async () => {
  const h = fixture(), first = await h.api.start(start()), before = h.snapshot();
  for (const value of [update(crypto.randomUUID()), { session_id: null, status: 'off', message: 'Off' }, update(first.follow.session_id, { status: 'off' })]) {
    await assert.rejects(h.api.runnerUpdate(value), error => error.statusCode === 409);
  }
  assert.deepEqual(h.snapshot(), before);
});
test('inactive runner presence is permitted but cannot publish URLs, navigation or an active claim', async () => {
  const h = fixture(); const response = await h.api.runnerUpdate({ session_id: null, status: 'off', message: 'Runner present, following off.', current_url: null, current_navigation: null });
  assert.equal(response.follow.active, false); assert.equal(response.follow.runner.seen_at, NOW);
  for (const value of [update(null), { session_id: null, status: 'off', message: 'Off', current_url: 'https://www.google.com/' }, { session_id: null, status: 'waiting', message: 'Waiting' }]) {
    await assert.rejects(h.api.runnerUpdate(value), error => error.statusCode === 409);
  }
});
test('waiting or unavailable retains only the latest public URL/navigation until explicit clear or Stop', async () => {
  const h = fixture(), first = await h.api.start(start()); await h.api.runnerUpdate(update(first.follow.session_id));
  await h.api.runnerUpdate(update(first.follow.session_id, { current_url: 'https://www.google.com/search?q=new', current_navigation: { id: 'navigation-2', units: [] } }));
  const response = await h.api.runnerUpdate({ session_id: first.follow.session_id, status: 'unavailable', message: 'Phone is disconnected.' });
  assert.equal(response.follow.current_url, 'https://www.google.com/search?q=new'); assert.equal(response.follow.current_navigation.id, 'navigation-2');
  const serialized = JSON.stringify(h.snapshot()); assert.equal(serialized.includes('q=tools'), false); assert.equal(serialized.includes('navigation-1'), false);
  assert.ok(h.snapshot().request_receipts.every(receipt => !Object.hasOwn(receipt, 'current_url')));
  const clear = await h.api.runnerUpdate({ session_id: first.follow.session_id, status: 'waiting', message: 'Source hidden.', current_url: null, current_navigation: null });
  assert.equal(clear.follow.current_url, null); assert.equal(clear.follow.current_navigation, null);
});
test('public video URL is data; local, credential, sign-in and controller URLs are rejected', () => {
  for (const url of ['https://www.youtube.com/watch?v=abc&t=2', 'https://www.tiktok.com/@curtis/video/123', 'https://www.google.com/search?q=tools#results']) assert.equal(validateFollowUrl(url), url);
  for (const url of ['http://www.google.com/', 'javascript:alert(1)', 'https://192.168.1.1/', 'https://node.local/', 'https://user:pw@www.google.com/', 'https://www.google.com:8443/',
    'https://www.google.com/\n', 'https://www.google.com/\\test', 'https://www.google.com/?access_token=private', 'https://www.google.com/?Authorization=private',
    'https://www.google.com/#session=private', 'https://www.google.com/?code=123', 'https://www.google.com/login', 'https://www.google.com/%61uth/page',
    'https://curtbrag.com/cluster/control/', 'https://curtbrag.com/cluster/dashboard/?controller=personal', 'https://www.google.com/#/oauth?access_token=private',
    'https://www.google.com/#/auth?code=private', 'https://www.google.com/#/video?access_token=private', 'https://' + 'a'.repeat(64) + '.com/',
    'https://' + Array(5).fill('a'.repeat(60)).join('.') + '/']) assert.throws(() => validateFollowUrl(url), error => error.statusCode === 400, url);
});
test('strict input rejects duration extension, source changes, flags, unknown fields and reused action IDs', async () => {
  const h = fixture();
  for (const input of [null, [], { ...start(), duration_minutes: 120 }, { ...start(), duration_minutes: '60' }, { ...start(), controller_id: 'phone191' },
    { ...start(), request_id: 'not-uuid' }, { ...start(), request_id: [crypto.randomUUID()] }, { ...start(), active: true }, { ...start(), password: 'private' }]) await assert.rejects(h.api.start(input), error => error.statusCode === 400);
  assert.equal(h.writes.length, 0); const first = start(); await h.api.start(first);
  await assert.rejects(h.api.stop(stop(first.request_id)), error => error.statusCode === 409);
});
test('UUID request case cannot reactivate a replayed stopped session', async () => {
  const h = fixture(), request = start(); await h.api.start(request); await h.api.stop(stop());
  const response = await h.api.start({ ...request, request_id: request.request_id.toUpperCase() }); assert.equal(response.follow.active, false);
});
test('reports reject extra data, duplicate units, S26, malformed IDs/messages and invalid states', async () => {
  const h = fixture(), first = await h.api.start(start());
  const invalid = [{ id: 'nav', units: [{ device_id: SOURCE, status: 'queued' }] }, { id: 'nav', units: [{ device_id: 'phone191', status: 'passed' }] },
    { id: 'nav', units: [{ device_id: 'phone191', status: 'queued', job_id: '../job' }] }, { id: 'nav', units: [{ device_id: 'phone191', status: 'queued', url: 'https://private/' }] },
    { id: 'nav', units: [{ device_id: 'phone191', status: 'queued' }, { device_id: 'phone191', status: 'failed' }] }, { id: 'nav', units: [], history: [] }, { id: 'x'.repeat(121), units: [] }];
  const before = h.snapshot();
  for (const current_navigation of invalid) await assert.rejects(h.api.runnerUpdate(update(first.follow.session_id, { current_navigation })), error => error.statusCode === 400);
  for (const override of [{ message: '<script>' }, { message: 'x'.repeat(241) }, { message: 'line\nbreak' }, { tabs: [] }, { current_url: 'https://www.google.com/?token=private' }]) {
    await assert.rejects(h.api.runnerUpdate(update(first.follow.session_id, override)), error => error.statusCode === 400);
  }
  assert.deepEqual(h.snapshot(), before);
});
test('all thirteen canonical units can be reported while S26 remains source-only', async () => {
  const h = fixture(), first = await h.api.start(start());
  const units = ['phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254','Alina','Nexus','SteamDeck','viki','RenderRig'].map(device_id => ({ device_id, status: 'skipped', message: 'Busy' }));
  const response = await h.api.runnerUpdate(update(first.follow.session_id, { current_navigation: { id: 'all-13', units } }));
  assert.equal(response.follow.current_navigation.units.length, 13); assert.equal(response.follow.active, true);
});
test('missing read/write receipts, read failures and write failures fail closed', async () => {
  const read = fixture(); read.failRead(); await assert.rejects(read.api.status(), error => error.statusCode === 503); assert.equal(read.writes.length, 0);
  for (const receipt of [{ data: {} }, { data: null, etag: 'v1' }, {}]) { const h = fixture(); h.readReceipt(receipt); await assert.rejects(h.api.status(), error => error.statusCode === 503); }
  for (const receipt of [{ modified: true }, {}, { modified: 'true', etag: 'v1' }]) { const h = fixture(); h.writeReceipt(receipt); await assert.rejects(h.api.start(start()), error => error.statusCode === 503); }
  const write = fixture(); write.failWrite('throw'); await assert.rejects(write.api.start(start()), error => error.statusCode === 503); assert.equal(write.snapshot(), null);
});
test('lost response after Start and Stop reconciles exact committed state without replay', async () => {
  const h = fixture(), request = start(); h.failWrite('after'); const first = await h.api.start(request);
  assert.equal(first.follow.active, true); assert.deepEqual((await h.api.start(request)).follow, first.follow);
  h.failWrite('after'); const stopped = await h.api.stop(stop()); assert.equal(stopped.follow.active, false);
  assert.equal(h.writes.filter(write => write.committed).length, 2);
});
test('bounded conflict retries do not acknowledge failed writes or remove old operation IDs', async () => {
  const h = fixture({ attempts: 3 }); h.failWrite('conflict'); await assert.rejects(h.api.start(start()), error => error.statusCode === 409);
  assert.equal(h.writes.length, 3); assert.equal(h.snapshot(), null);
});
test('receipt capacity reserves a Stop slot and never evicts an old Start ID', async () => {
  const h = fixture(), firstRequest = start(); await h.api.start(firstRequest);
  const state = h.snapshot(); while (state.request_receipts.length < 1999) state.request_receipts.push({ request_id: crypto.randomUUID(), kind: 'start', session_id: state.session_id }); h.seed(state);
  await assert.rejects(h.api.start(start()), error => error.statusCode === 409);
  assert.equal((await h.api.stop(stop())).follow.active, false); assert.equal(h.snapshot().request_receipts.length, 2000);
  assert.equal((await h.api.start(firstRequest)).follow.active, false);
});
test('Stop always disables a valid active session even if its normal receipt capacity is full', async () => {
  const h = fixture(); await h.api.start(start()); const state = h.snapshot();
  while (state.request_receipts.length < 2000) state.request_receipts.push({ request_id: crypto.randomUUID(), kind: 'start', session_id: state.session_id }); h.seed(state);
  const request = stop(); assert.equal((await h.api.stop(request)).follow.active, false);
  assert.equal(h.snapshot().request_receipts.length, 2001); assert.equal((await h.api.stop(request)).follow.active, false);
  assert.equal((await h.api.stop(stop())).follow.active, false);
});
test('corrupt persisted state cannot become an active response or leak unknown fields', async () => {
  for (const change of [{ schema: 2 }, { active: 'true' }, { current_url: 'https://www.google.com/?token=private' }, { history: [] }, { runner: { status: 'following', message: 'OK', seen_at: NOW, password: 'private' } }]) {
    const h = fixture(); await h.api.start(start()); h.seed({ ...h.snapshot(), ...change }); await assert.rejects(h.api.status(), error => error.statusCode === 503);
  }
});

function runtimeFactory(deploymentContext = { context: null, deployID: null }) {
  const filename = path.resolve(__dirname, '../netlify/functions/lib/phone-follow.cjs'), module = { exports: {} };
  function localRequire(name) { if (name === './control-deployment.cjs') return deploymentContext; if (name.startsWith('.')) return require(path.resolve(path.dirname(filename), name)); return require(name); }
  const compile = vm.runInThisContext('(function(require,module,exports){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename });
  compile(localRequire, module, module.exports); return module.exports.openPhoneFollow;
}
test('trusted deployment contexts isolate follower stores and incomplete contexts fail closed', () => {
  const open = runtimeFactory(), calls = [], options = { getStore: spec => { calls.push(spec); return fixture().store; }, controllers: { list: async () => [record] }, fetch: async () => { throw Error('No network'); } };
  open({ ...options, env: { CONTEXT: 'production' } }); assert.equal(calls.at(-1).name, 'cp-phone-follow');
  for (const CONTEXT of ['deploy-preview','branch-deploy']) { open({ ...options, env: { CONTEXT, DEPLOY_ID: 'test-deploy' } }); assert.equal(calls.at(-1).name, 'cp-phone-follow-isolated-' + CONTEXT + '-test-deploy'); }
  const before = calls.length;
  for (const env of [{ CONTEXT: 'unknown' }, { CONTEXT: 'deploy-preview' }, { CONTEXT: 'branch-deploy', DEPLOY_ID: '../production' }]) assert.throws(() => open({ ...options, env }), error => error.statusCode === 503);
  assert.equal(calls.length, before);
  const providerContext = { siteID: 'fixture-site', token: 'fixture-token', edgeURL: 'https://edge.invalid', uncachedEdgeURL: 'https://strong.invalid' };
  open({ ...options, env: { CONTEXT: 'production' }, providerContext }); for (const key of Object.keys(providerContext)) assert.equal(calls.at(-1)[key], providerContext[key]);
  assert.throws(() => open({ ...options, env: { CONTEXT: 'production' }, event: { blobs: 'legacy' } }), error => error.statusCode === 503);
});
test('existing owner auth gates all follower APIs before storage access', async () => {
  const h = apiFixture();
  for (const authorization of ['', 'Bearer wrong', 'Bearer fixture-agent']) {
    assert.equal((await h.cpGet('phone-follow-status', { headers: { authorization } })).status, 401);
    for (const [action, body] of [['phone-follow-start', start()], ['phone-follow-stop', stop()], ['phone-follow-runner-update', { session_id: null, status: 'off', message: 'Off' }]]) {
      assert.equal((await h.cp(action, body, { headers: { authorization } })).status, 401);
    }
  }
  assert.equal(h.calls.some(call => call.name.startsWith('cp-phone-follow') || call.name.startsWith('cp-personal-controllers')), false);
});
test('API registration/start/status/update/stop works without touching worker, queue or mining stores', async () => {
  const h = apiFixture(); assert.equal((await h.cpGet('phone-follow-status')).body.follow.active, false);
  assert.equal((await h.cp('phone-follow-start', start())).status, 409);
  const registration = { controller_id: SOURCE, name: 'Curtis S26 Ultra', model: 'SM-S948U', private_ip: '192.168.1.237', adb_connect_port: 38033 };
  assert.equal((await h.cp('register-personal-controller', registration)).status, 200);
  const begun = await h.cp('phone-follow-start', start()); assert.equal(begun.status, 200);
  assert.equal((await h.cp('phone-follow-runner-update', update(begun.body.follow.session_id))).status, 200);
  const ended = await h.cp('phone-follow-stop', stop()); assert.equal(ended.status, 200); assert.equal(ended.body.follow.active, false);
  assert.equal((await h.cp('phone-follow-runner-update', update(begun.body.follow.session_id))).status, 409);
  assert.equal(h.calls.some(call => ['cp-devices','cp-desired','cp-groups','cp-commands','cp-observed','swarm-jobs-v2'].includes(call.name)), false);
  const context = deployment.context || 'production', name = context === 'production' ? 'cp-phone-follow' : 'cp-phone-follow-isolated-' + context + '-' + deployment.deployID;
  assert.equal(h.inspect(name, KEY).current_url, null);
});
test('API non-object and malformed JSON requests return structured errors without activating', async () => {
  const h = apiFixture();
  for (const action of ['phone-follow-start','phone-follow-stop','phone-follow-runner-update']) {
    for (const body of [null, [], false, 1, 'text']) assert.equal((await h.cp(action, body)).status, 400);
    assert.equal((await h.cp(action, {}, { event: { body: '{' } })).status, 400);
  }
  assert.equal(h.writes.length, 0);
});
