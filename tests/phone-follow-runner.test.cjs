'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const { Readable } = require('node:stream');
const {
  validateUrl, activeLease, registeredController, resolveTransport, AdbWire, ExistingAdb, websocketAddress,
  readJson, evaluateMetadata, BrowserSource, browserJob, freshNodes, launchResult, PhoneFollower, readStartup, sleepUntilAbort, FOREGROUND_COMMAND, FLEET,
} = require('../scripts/cluster-phone-follow.cjs');

const config = { password: 'test-owner-only', adb_path: 'C:\\PlatformTools\\adb.exe' };
const registry = { controllers: [{ controller_id: 'curtis-s26-ultra', role: 'personal-controller', worker_enabled: false, mining_enabled: false, adb_guid: 'adb-R3GL801BCMK-IEkPhu', private_ip: '192.168.1.237', adb_connect_port: 38033 }] };
const transport = 'adb-R3GL801BCMK-IEkPhu._adb-tls-connect._tcp';

function setup(options = {}) {
  let now = 1_790_000_000_000, serial = 0;
  const follow = { active: true, session_id: 'f83eefb1-777d-4e1d-a17a-343704d24429', controller_id: 'curtis-s26-ultra', started_at: now, expires_at: now + 3_600_000, runner: { status: 'waiting' }, current_url: null, current_navigation: null };
  const snapshot = { nodes: FLEET.map(id => ({ id, online: true, last_seen: now, busy: false, active_jobs: [], agent_version: '3.7.2' })), jobs: [], results: [] };
  const calls = [], captures = [], cleanups = [];
  const source = {
    async sample() { captures.push(now); return options.url ? options.url() : 'https://curtbrag.com/gallery/'; },
    async cleanup() { cleanups.push(now); },
  };
  const api = async (action, method = 'GET', body) => {
    calls.push({ action, method, body: body === undefined ? undefined : structuredClone(body) });
    if (options.api) { const value = await options.api(action, method, body, follow, calls); if (value !== undefined) return value; }
    if (action === 'phone-follow-status') return { ok: true, follow: structuredClone(follow) };
    if (action === 'personal-controllers') return registry;
    if (action === 'phone-follow-runner-update') {
      if (Object.hasOwn(body, 'current_url')) follow.current_url = body.current_url;
      if (Object.hasOwn(body, 'current_navigation')) follow.current_navigation = structuredClone(body.current_navigation);
      follow.runner = { status: body.status, message: body.message, seen_at: now };
      return { ok: true, follow: structuredClone(follow) };
    }
    throw Error('Unexpected action');
  };
  const swarm = async (action, method = 'GET', body) => {
    calls.push({ action, method, body: body === undefined ? undefined : structuredClone(body) });
    if (options.swarm) { const value = await options.swarm(action, method, body, follow, snapshot); if (value !== undefined) return value; }
    if (action === 'queue-status') return snapshot;
    if (action === 'enqueue') return { ok: true, enqueued: true, already_present: false, job_id: body.job.id, target_count: 1, target_device_ids: body.target_device_ids };
    throw Error('Unexpected action');
  };
  const follower = new PhoneFollower(config, { api, swarm, source, now: () => now, id: () => 'test-navigation-' + (++serial) });
  return { follower, follow, snapshot, calls, captures, cleanups, now: () => now, advance(ms = 5000) { now += ms; snapshot.nodes.forEach(node => { node.last_seen = now; }); }, enqueues() { return calls.filter(call => call.action === 'enqueue'); } };
}

test('OFF polls its state without phone, registry, worker, or browser access', async () => {
  const s = setup(); s.follow.active = false;
  await s.follower.tick(); await s.follower.tick();
  assert.equal(s.captures.length, 0); assert.equal(s.enqueues().length, 0);
  assert.deepEqual([...new Set(s.calls.map(call => call.action))].sort(), ['phone-follow-runner-update', 'phone-follow-status']);
  const update = s.calls.find(call => call.method === 'POST').body;
  assert.equal(update.session_id, null); assert.equal(update.status, 'off');
  assert.equal(Object.hasOwn(update, 'current_url'), false); assert.equal(Object.hasOwn(update, 'current_navigation'), false);
});

test('expired or incomplete active lease never captures or overwrites the server session', async () => {
  for (const change of [follow => { follow.expires_at = 1; }, follow => { follow.controller_id = 'unknown'; }, follow => { follow.session_id = null; }, follow => { follow.expires_at += 7_200_000; }]) {
    const s = setup(); change(s.follow); await s.follower.tick();
    assert.equal(s.captures.length, 0); assert.equal(s.enqueues().length, 0); assert.equal(s.calls.some(call => call.method === 'POST'), false);
  }
});

test('lost fresh status fails closed before a single browser capture', async () => {
  let count = 0;
  const s = setup({ api(action) { if (action === 'phone-follow-status' && ++count > 1) throw Error('secret response should never be published'); } });
  await s.follower.tick(); assert.equal(s.captures.length, 0); assert.equal(s.enqueues().length, 0);
  assert.equal(s.calls.some(call => call.method === 'POST'), false);
});

test('registry must be the single exact previously paired personal controller', () => {
  assert.deepEqual(registeredController(registry), { guid: 'adb-R3GL801BCMK-IEkPhu', address: '192.168.1.237:38033' });
  for (const field of ['role', 'worker_enabled', 'mining_enabled', 'adb_guid', 'private_ip', 'adb_connect_port']) {
    const bad = structuredClone(registry); bad.controllers[0][field] = field === 'worker_enabled' ? true : null;
    assert.throws(() => registeredController(bad));
  }
  assert.throws(() => registeredController({ controllers: [...registry.controllers, ...registry.controllers] }));
});

test('transport selection rejects stale unauthorized or unrelated phones', () => {
  const controller = registeredController(registry);
  assert.equal(resolveTransport(transport + '\tdevice model:SM_S948U\nother\tdevice', controller), transport);
  assert.equal(resolveTransport('192.168.1.237:38033\tdevice', controller), '192.168.1.237:38033');
  for (const value of [transport + '\tunauthorized', transport + '\toffline', '192.168.1.237:9999\tdevice', transport + '\tdevice\n' + transport + '\tdevice']) assert.throws(() => resolveTransport(value, controller));
});

test('automatic URLs preserve actual public path and video query while rejecting credentials and local targets', () => {
  assert.equal(validateUrl('https://www.youtube.com/watch?v=abc123&t=14'), 'https://www.youtube.com/watch?v=abc123&t=14');
  assert.equal(validateUrl('https://www.tiktok.com/@curtis/video/123#video'), 'https://www.tiktok.com/@curtis/video/123#video');
  for (const url of ['http://curtbrag.com/', 'https://user:pass@example.com/', 'https://192.168.1.237/', 'https://localhost/', 'https://example.local/', 'https://example.com:8443/', 'https://example.com/\n', 'https://example.com/?access_token=private', 'https://example.com/#token=private', 'https://example.com/#route?session=private', 'https://example.com/signin', 'https://example.com/%61uth/', 'https://curtbrag.com/cluster/control/', 'https://curtbrag.com/cluster/dashboard/?controller=personal', 'https://example.com./', 'https://example.123/']) assert.throws(() => validateUrl(url), url);
  for (const url of ['https://curtbrag.com/?pass_word=private', 'https://curtbrag.com/?p.a.s.s.w.o.r.d=private', 'https://curtbrag.com/#route?access.token=private', 'https://curtbrag.com/#/signin', 'https://curtbrag.com/authenticate', 'https://curtbrag.com/oauth2/']) assert.throws(() => validateUrl(url), url);
});

test('one stable navigation queues at most the canonical13 once and preserves exact helper shapes', async () => {
  const s = setup(); await s.follower.tick(); assert.equal(s.enqueues().length, 0);
  s.advance(); await s.follower.tick(); assert.equal(s.enqueues().length, 13);
  assert.deepEqual(s.enqueues().map(call => call.body.target_device_ids[0]), FLEET);
  assert.equal(s.enqueues().some(call => call.body.target_device_ids.includes('curtis-s26-ultra')), false);
  const android = s.enqueues()[0].body.job;
  assert.equal(android.type, 'shell'); assert.equal(android.cmd, android.command);
  assert.match(android.cmd, /f6f01768fdda090564a3f7237d97606a8f01bf4e\/scripts\/cluster-browser-open\.py/);
  assert.match(android.cmd, /--settings-b64 '[A-Za-z0-9+/=]+'/);
  const windows = s.enqueues().at(-1).body.job;
  assert.equal(windows.type, 'website-open'); assert.deepEqual(JSON.parse(windows.cmd), { url: 'https://curtbrag.com/gallery/' });
  s.advance(); await s.follower.tick(); assert.equal(s.enqueues().length, 13);
});

test('two rapid address changes never fan out an unstable intermediate page', async () => {
  let url = 'https://curtbrag.com/'; const s = setup({ url: () => url });
  await s.follower.tick(); s.advance(); url = 'https://curtbrag.com/gallery/'; await s.follower.tick();
  assert.equal(s.enqueues().length, 0); s.advance(); await s.follower.tick();
  assert.equal(s.enqueues().length, 13); assert.equal(s.follower.lastUrl, url);
});

test('offline, stale, busy and out-of-date units are skipped and never dispatched', async () => {
  const s = setup(); s.snapshot.nodes[0].online = false; s.snapshot.nodes[1].busy = true;
  s.snapshot.nodes[2].active_jobs = ['busy-job']; s.snapshot.nodes.at(-1).agent_version = '3.7.1';
  await s.follower.tick(); s.advance(); await s.follower.tick();
  assert.equal(s.enqueues().length, 9);
  assert.deepEqual(s.follower.navigation.units.filter(unit => unit.status === 'skipped').map(unit => unit.device_id), ['phone173', 'phone174', 'phone176', 'RenderRig']);
  const now = 100000; const snapshot = { nodes: [{ id: 'phone173', online: true, last_seen: 1, busy: false, active_jobs: [] }], jobs: [], results: [] };
  assert.equal(freshNodes(snapshot, now)[0].reason, 'Worker is offline.');
});

test('a Stop between unit requests prevents all remaining enqueues and clears source forwarding', async () => {
  const s = setup({ swarm(action, method, body, follow) { if (action === 'enqueue') follow.active = false; } });
  await s.follower.tick(); s.advance(); await s.follower.tick();
  assert.equal(s.enqueues().length, 1); assert.equal(s.follower.session, null); assert.equal(s.follower.lastUrl, null);
  assert.ok(s.cleanups.length >= 2);
});

test('lost enqueue response is marked unconfirmed and never replayed', async () => {
  const s = setup({ swarm(action) { if (action === 'enqueue') throw Error('private-url/auth from transport'); } });
  await s.follower.tick(); s.advance(); await s.follower.tick();
  assert.equal(s.enqueues().length, 1); assert.equal(s.follower.navigation.units[0].status, 'unconfirmed');
  assert.match(s.follower.navigation.units[0].message, /not be retried/);
  s.advance(); await s.follower.tick(); assert.equal(s.enqueues().length, 1);
  assert.equal(JSON.stringify(s.calls.filter(call => call.action === 'phone-follow-runner-update')).includes('private-url/auth'), false);
});

test('each enqueue follows a durable unconfirmed checkpoint and a later fresh lease check', async () => {
  const s = setup(); await s.follower.tick(); s.advance(); await s.follower.tick();
  for (const enqueue of s.enqueues()) {
    const index = s.calls.indexOf(enqueue);
    const previous = s.calls.slice(0, index);
    const checkpointIndex = previous.findLastIndex(call => call.action === 'phone-follow-runner-update' && call.body.current_navigation?.units.some(unit => unit.job_id === enqueue.body.job.id && unit.status === 'unconfirmed'));
    assert.ok(checkpointIndex >= 0);
    assert.equal(previous[checkpointIndex].body.current_url, 'https://curtbrag.com/gallery/');
    assert.ok(previous.slice(checkpointIndex + 1).some(call => call.action === 'phone-follow-status'));
  }
});

test('a checkpoint failure prevents its device action and does not expose transport errors', async () => {
  const s = setup({ api(action, method, body) { if (action === 'phone-follow-runner-update' && body.current_navigation) throw Error('credential-containing response'); } });
  await s.follower.tick(); s.advance(); await s.follower.tick();
  assert.equal(s.enqueues().length, 0);
  assert.equal(s.follower.navigation.units[0].status, 'unconfirmed');
  assert.equal(JSON.stringify(s.calls).includes('credential-containing'), false);
});

test('an ok-only or mismatched checkpoint acknowledgement never permits enqueue', async () => {
  for (const modify of [() => ({ ok: true }), follow => ({ ok: true, follow }), follow => ({ ok: true, follow: { ...follow, current_navigation: { id: 'different-navigation', units: [] } } })]) {
    const s = setup({ api(action, method, body, follow) { if (action === 'phone-follow-runner-update' && body.current_navigation) return modify(structuredClone(follow)); } });
    await s.follower.tick(); s.advance(); await s.follower.tick();
    assert.equal(s.enqueues().length, 0);
  }
});

test('checkpoint proof compares semantic unit fields rather than JSON property order', async () => {
  const s = setup({ api(action, method, body, follow) {
    if (action === 'phone-follow-runner-update' && body.current_navigation) {
      follow.current_url = body.current_url;
      follow.current_navigation = { units: body.current_navigation.units.map(unit => ({ message: unit.message, ...(unit.job_id ? { job_id: unit.job_id } : {}), status: unit.status, device_id: unit.device_id })), id: body.current_navigation.id };
      follow.runner = { status: body.status };
      return { ok: true, follow: structuredClone(follow) };
    }
  } });
  await s.follower.tick(); s.advance(); await s.follower.tick(); assert.equal(s.enqueues().length, 13);
});

test('Stop after a successful checkpoint prevents enqueue', async () => {
  const s = setup({ api(action, method, body, follow) { if (action === 'phone-follow-runner-update' && body.current_navigation) follow.active = false; } });
  await s.follower.tick(); s.advance(); await s.follower.tick();
  assert.equal(s.enqueues().length, 0); assert.equal(s.follower.session, null);
});

test('restart after a checkpoint and ambiguous submission never repeats the same navigation', async () => {
  const s = setup({ swarm(action) { if (action === 'enqueue') throw Error('lost response after server action'); } });
  await s.follower.tick(); s.advance(); await s.follower.tick();
  assert.equal(s.enqueues().length, 1);
  const restarted = new PhoneFollower(config, { api: s.follower.api, swarm: s.follower.swarm, source: s.follower.source, now: s.now });
  await restarted.tick(); s.advance(); await restarted.tick();
  assert.equal(s.enqueues().length, 1); assert.equal(restarted.pending.size, 1);
});

test('waiting preserves the latest public link and pending checkpoint through restart', async () => {
  let shown = true; const s = setup({ url: () => shown ? 'https://curtbrag.com/gallery/' : null });
  await s.follower.tick(); s.advance(); await s.follower.tick(); shown = false;
  s.advance(); await s.follower.tick();
  const update = s.calls.filter(call => call.action === 'phone-follow-runner-update').at(-1).body;
  assert.equal(update.status, 'waiting'); assert.equal(Object.hasOwn(update, 'current_url'), false); assert.deepEqual(update.current_navigation, s.follow.current_navigation);
  assert.equal(s.follow.current_url, 'https://curtbrag.com/gallery/'); assert.equal(s.follow.current_navigation.units.length, 13);
  const restarted = new PhoneFollower(config, { api: s.follower.api, swarm: s.follower.swarm, source: s.follower.source, now: s.now });
  shown = true; await restarted.tick(); s.advance(); await restarted.tick();
  assert.equal(s.enqueues().length, 13); assert.equal(restarted.pending.size, 13);
});

test('completed receipts reach the dashboard while the browser is absent or a new address is settling', async () => {
  for (const nextURL of [null, 'https://curtbrag.com/shop/']) {
    let shown = 'https://curtbrag.com/gallery/';
    const s = setup({ url: () => shown });
    await s.follower.tick(); s.advance(); await s.follower.tick();
    const job = s.enqueues().at(-1).body.job;
    s.snapshot.results.push({ device_id: 'RenderRig', job_id: job.id, exit_code: 0, stdout: JSON.stringify({ kind: 'website-browser-open', url: shown, state: 'launch-requested', launch_requested: true, visible_screen_verified: false }) });
    shown = nextURL; s.advance(); await s.follower.tick();
    assert.equal(s.follow.runner.status, 'waiting');
    assert.equal(s.follow.current_url, 'https://curtbrag.com/gallery/');
    assert.equal(s.follow.current_navigation.units.at(-1).status, 'launch-requested');
    assert.equal(s.follower.pending.has('RenderRig'), false);
    assert.equal(s.enqueues().length, 13);
  }
});

test('new navigation preserves earlier pending IDs even for busy/offline units across restart', async () => {
  let url = 'https://curtbrag.com/gallery/'; const s = setup({ url: () => url });
  await s.follower.tick(); s.advance(); await s.follower.tick();
  const firstJobs = s.enqueues().map(call => call.body.job.id);
  s.snapshot.nodes[0].busy = true; s.snapshot.nodes[1].online = false;
  url = 'https://curtbrag.com/shop/'; s.advance(); await s.follower.tick(); s.advance(); await s.follower.tick();
  assert.equal(s.enqueues().length, 13); assert.equal(s.follow.current_url, url);
  assert.deepEqual(s.follow.current_navigation.units.map(unit => unit.job_id), firstJobs);
  assert.ok(s.follow.current_navigation.units.every(unit => unit.status === 'skipped'));
  const restarted = new PhoneFollower(config, { api: s.follower.api, swarm: s.follower.swarm, source: s.follower.source, now: s.now });
  await restarted.tick(); assert.equal(restarted.pending.size, 13); assert.equal(s.enqueues().length, 13);
  s.snapshot.results.push({ device_id: 'phone173', job_id: firstJobs[0], exit_code: 0, stdout: JSON.stringify({ kind: 'website-browser-open', url: 'https://curtbrag.com/gallery/', state: 'launch-requested', launch_requested: true, visible_screen_verified: false }) });
  s.advance(); await restarted.tick();
  assert.equal(restarted.pending.has('phone173'), false); assert.equal(restarted.navigation.units[0].status, 'skipped');
  assert.equal(Object.hasOwn(restarted.navigation.units[0], 'job_id'), false); assert.match(restarted.navigation.units[0].message, /earlier request finished/);
});

test('missing current navigation receipt on runner restart seeds no duplicate queued actions', async () => {
  const s = setup(); s.follow.current_url = 'https://curtbrag.com/gallery/';
  s.follow.current_navigation = { id: 'saved-navigation', units: [{ device_id: 'phone173', job_id: 'saved-job', status: 'unconfirmed', message: 'Unconfirmed.' }] };
  await s.follower.tick(); s.advance(); await s.follower.tick(); assert.equal(s.enqueues().length, 0);
  assert.equal(s.follower.pending.get('phone173'), 'saved-job');
});

test('results accept only matching structured launch receipt and exact numeric/string zero', () => {
  const url = 'https://curtbrag.com/';
  const report = { kind: 'website-browser-open', url, launch_requested: true, state: 'launch-requested', visible_screen_verified: false };
  for (const exit_code of [0, '0']) assert.equal(launchResult({ stdout: JSON.stringify(report), exit_code }, url), 'launch-requested');
  for (const exit_code of [null, false, '', '00', ' 0', undefined, 1, '1']) assert.equal(launchResult({ stdout: JSON.stringify(report), exit_code }, url), 'failed');
  for (const changed of [{ ...report, url: 'https://other.com/' }, { ...report, visible_screen_verified: true }, { ...report, launch_requested: 'true' }, { ...report, state: 'success' }]) assert.equal(launchResult({ stdout: JSON.stringify(changed), exit_code: 0 }, url), 'failed');
});

test('matching worker results update only this navigation and release its pending unit', async () => {
  const s = setup(); await s.follower.tick(); s.advance(); await s.follower.tick();
  const job = s.enqueues()[0].body.job;
  s.snapshot.results.push({ device_id: 'phone173', job_id: job.id, exit_code: 0, stdout: JSON.stringify({ kind: 'website-browser-open', url: 'https://curtbrag.com/gallery/', state: 'launch-requested', launch_requested: true, visible_screen_verified: false }) });
  s.advance(); await s.follower.tick(); assert.equal(s.follower.navigation.units[0].status, 'launch-requested');
  assert.equal(s.follower.pending.has('phone173'), false); assert.equal(s.enqueues().length, 13);
});

test('hidden source with no dispatched link stays empty without starting native apps', async () => {
  const s = setup({ url: () => null }); await s.follower.tick(); s.advance(); await s.follower.tick();
  assert.equal(s.enqueues().length, 0); assert.equal(s.follow.current_url, null);
  assert.equal(s.calls.filter(call => call.action === 'phone-follow-runner-update').at(-1).body.status, 'waiting');
});

test('a fresh lease guard prevents address capture after Stop during visibility discovery', async () => {
  let active = true, removed = 0, urlReads = 0;
  const source = new BrowserSource({
    adb: { async devices() { return transport + '\tdevice'; }, async foreground() { return 'BROWSER_SAMSUNG'; }, async forward() { return 41234; }, async remove() { removed++; } },
    json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://localhost:41234/devtools/page/a' }],
    evaluate: async (url, expression) => { if (expression === 'location.href') { urlReads++; return 'https://curtbrag.com/'; } active = false; return 'visible'; },
  });
  await assert.rejects(source.sample(registeredController(registry), async () => active));
  assert.equal(urlReads, 0); assert.equal(removed, 1); assert.equal(source.forwarding, null);
});

test('visibility discovery uses at most eight concurrent readers and joins them before cleanup', async () => {
  let running = 0, maximum = 0, removedWhileRunning = false;
  const source = new BrowserSource({
    adb: { async devices() { return transport + '\tdevice'; }, async foreground() { return 'BROWSER_CHROME'; }, async forward() { return 41234; }, async remove() { removedWhileRunning = running > 0; } },
    json: async () => Array.from({ length: 32 }, (_, index) => ({ type: 'page', webSocketDebuggerUrl: 'ws://localhost:41234/devtools/page/' + index })),
    evaluate: async () => { running++; maximum = Math.max(maximum, running); await new Promise(resolve => setImmediate(resolve)); running--; return 'hidden'; },
  });
  assert.equal(await source.sample(registeredController(registry)), null);
  assert.equal(maximum, 8); assert.equal(running, 0); assert.equal(removedWhileRunning, false);
});

test('foreground change after address read removes its owned forward and discards the sample', async () => {
  let foreground = 0, removed = 0;
  const source = new BrowserSource({
    adb: { async devices() { return transport + '\tdevice'; }, async foreground() { return ++foreground < 3 ? 'BROWSER_SAMSUNG' : 'BROWSER_OTHER'; }, async forward() { return 41234; }, async remove() { removed++; } },
    json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://localhost:41234/devtools/page/a' }],
    evaluate: async (url, expression) => expression === 'location.href' ? 'https://curtbrag.com/' : expression === 'document.hasFocus()' ? true : 'visible',
  });
  assert.equal(await source.sample(registeredController(registry)), null); assert.equal(removed, 1);
});

test('loop sleeps remove abort listeners after timeout and after cancellation', async () => {
  const abort = new AbortController();
  for (let index = 0; index < 15; index++) { await sleepUntilAbort(1, abort.signal); assert.equal(getEventListeners(abort.signal, 'abort').length, 0); }
  const sleeping = sleepUntilAbort(1000, abort.signal); assert.equal(getEventListeners(abort.signal, 'abort').length, 1);
  abort.abort(); await sleeping; assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('graceful local stop prevents capture or dispatch on subsequent ticks', async () => {
  const s = setup(); await s.follower.tick(); await s.follower.stop(); s.advance(); await s.follower.tick();
  assert.equal(s.captures.length, 1); assert.equal(s.enqueues().length, 0); assert.equal(s.follower.lastUrl, null);
});

class FakeSocket extends EventEmitter {
  constructor(answer) { super(); this.answer = answer; this.connecting = false; this.destroyed = false; this.requests = []; }
  write(buffer) {
    const text = buffer.toString('utf8'), length = parseInt(text.slice(0, 4), 16), service = text.slice(4);
    assert.equal(Buffer.byteLength(service), length); this.requests.push(service);
    queueMicrotask(() => this.answer(service, this)); return true;
  }
  destroy() { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit('close')); } }
}
const protocolString = value => Buffer.from(Buffer.byteLength(value).toString(16).padStart(4, '0') + value);

test('existing ADB protocol frames fixed target requests and removes only its own allocated forward', async () => {
  const sockets = [];
  const connect = options => {
    assert.deepEqual(options, { host: '127.0.0.1', port: 5037 });
    const socket = new FakeSocket((service, target) => {
      if (service === 'host:devices-l') target.emit('data', Buffer.concat([Buffer.from('OKAY'), protocolString(transport + '\tdevice\n')]));
      else if (service === 'host:transport:' + transport) target.emit('data', Buffer.from('OKAY'));
      else if (service === 'shell:' + FOREGROUND_COMMAND) { target.emit('data', Buffer.from('OKAYBROWSER_SAMSUNG\n')); target.emit('end'); }
      else if (service === 'host-serial:' + transport + ':forward:tcp:0;localabstract:Terrace_devtools_remote') target.emit('data', Buffer.concat([Buffer.from('OKAYOKAY'), protocolString('41234')]));
      else if (service === 'host-serial:' + transport + ':killforward:tcp:41234') target.emit('data', Buffer.from('OKAYOKAY'));
      else assert.fail('Unexpected privileged ADB service ' + service);
    }); sockets.push(socket); return socket;
  };
  const adb = new ExistingAdb({ connect });
  assert.match(await adb.devices(), /device/); assert.equal(await adb.foreground(transport), 'BROWSER_SAMSUNG');
  assert.equal(await adb.forward(transport, 'BROWSER_SAMSUNG'), 41234); await adb.remove(9999); await adb.remove(41234);
  assert.equal(sockets.length, 4); assert.equal(adb.owned.size, 0);
  assert.equal(sockets.flatMap(socket => socket.requests).some(service => /pair|connect:|killforward-all|host:kill|reconnect/.test(service)), false);
});

test('ADB buffered reader handles split packets, malformed length, truncation and bounded deadline', async () => {
  const socket = new FakeSocket((service, target) => { target.emit('data', Buffer.from('OK')); queueMicrotask(() => target.emit('data', Buffer.from('AY0003abc'))); });
  const wire = new AdbWire(socket, 100); await wire.request('host:devices-l'); assert.equal(await wire.string(), 'abc'); wire.close();
  for (const reply of ['OKAYzzzz', 'OKAY0004ab']) {
    const broken = new FakeSocket((service, target) => { target.emit('data', Buffer.from(reply)); target.emit('end'); });
    const reader = new AdbWire(broken, 100); await reader.request('host:devices-l'); await assert.rejects(reader.string()); reader.close();
  }
  const silent = new FakeSocket(() => {}), reader = new AdbWire(silent, 20);
  await assert.rejects(reader.request('host:devices-l')); assert.equal(silent.destroyed, true); reader.close();
});

test('missing existing ADB server fails without launching any process or connection recovery', async () => {
  const adb = new ExistingAdb({ connect() { const socket = new FakeSocket(() => {}); socket.connecting = true; queueMicrotask(() => socket.emit('error', Error('ECONNREFUSED'))); return socket; } });
  await assert.rejects(adb.devices()); assert.equal(adb.owned.size, 0);
});

test('source reads only selected browser metadata and uses fixed Samsung socket', async () => {
  const calls = [], values = ['hidden', 'visible'];
  const adb = { async devices() { calls.push('devices'); return transport + '\tdevice'; }, async foreground() { return 'BROWSER_SAMSUNG'; }, async forward(serial, browser) { calls.push(browser); return 41234; }, async remove(port) { calls.push('remove:' + port); } };
  const source = new BrowserSource({ adb, json: async url => { assert.equal(url, 'http://127.0.0.1:41234/json/list'); return [{ type: 'page', url: 'DO NOT CAPTURE BACKGROUND URL', title: 'DO NOT CAPTURE', webSocketDebuggerUrl: 'ws://localhost:41234/devtools/page/a' }, { type: 'page', url: 'DO NOT USE URL METADATA', webSocketDebuggerUrl: 'ws://localhost:41234/devtools/page/b' }]; }, evaluate: async (url, expression) => { calls.push({ url, expression }); if (expression === 'location.href') return 'https://curtbrag.com/gallery/'; if (expression === 'document.hasFocus()') return true; return values.length ? values.shift() : 'visible'; } });
  assert.equal(await source.sample(registeredController(registry)), 'https://curtbrag.com/gallery/');
  assert.equal(calls.filter(call => call.expression === 'location.href').length, 1);
  assert.match(calls.find(call => call.expression === 'location.href').url, /\/b$/);
  assert.equal(JSON.stringify(calls).includes('DO NOT CAPTURE'), false); await source.cleanup(); assert.ok(calls.includes('remove:41234'));
});

test('native foreground app never forwards or inspects any browser target', async () => {
  let forwards = 0, reads = 0;
  const source = new BrowserSource({ adb: { async devices() { return transport + '\tdevice'; }, async foreground() { return 'BROWSER_OTHER'; }, async forward() { forwards++; }, async remove() {} }, json: async () => { reads++; } });
  assert.equal(await source.sample(registeredController(registry)), null); assert.equal(forwards, 0); assert.equal(reads, 0);
});

test('ambiguous or zero visible targets never read an address and clean their forward', async () => {
  for (const visibility of ['visible', 'hidden']) {
    const calls = [];
    const source = new BrowserSource({ adb: { async devices() { return transport + '\tdevice'; }, async foreground() { return 'BROWSER_CHROME'; }, async forward() { return 41234; }, async remove() { calls.push('removed'); } }, json: async () => ['a', 'b'].map(id => ({ type: 'page', webSocketDebuggerUrl: 'ws://localhost:41234/devtools/page/' + id })), evaluate: async (url, expression) => { calls.push(expression); return visibility; } });
    assert.equal(await source.sample(registeredController(registry)), null); assert.equal(calls.includes('location.href'), false); assert.equal(calls.at(-1), 'removed');
  }
});

test('debugger endpoints are rewritten to this owned loopback port and reject arbitrary hosts/services', () => {
  assert.equal(websocketAddress('ws://localhost:41234/devtools/page/test-123', 41234), 'ws://127.0.0.1:41234/devtools/page/test-123');
  for (const endpoint of ['ws://evil.com:41234/devtools/page/a', 'ws://localhost:1234/devtools/page/a', 'ws://user:pass@localhost:41234/devtools/page/a', 'ws://localhost:41234/devtools/browser/a', 'ws://localhost:41234/devtools/page/a?token=secret', 'wss://localhost:41234/devtools/page/a']) assert.throws(() => websocketAddress(endpoint, 41234));
});

test('CDP accepts only three fixed read-only expressions and strict metadata responses', async () => {
  const sent = [];
  class Socket extends EventEmitter {
    constructor() { super(); queueMicrotask(() => this.emit('open')); }
    addEventListener(name, fn) { this.on(name, fn); }
    send(raw) { const message = JSON.parse(raw); sent.push(message); queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: 1, result: { result: { type: 'string', value: 'visible' } } }) })); }
    close() {}
  }
  assert.equal(await evaluateMetadata('ws://127.0.0.1:41234/devtools/page/a', 'document.visibilityState', { WebSocket: Socket }), 'visible');
  assert.equal(sent[0].method, 'Runtime.evaluate'); assert.equal(sent[0].params.throwOnSideEffect, true); assert.equal(sent[0].params.silent, true);
  await assert.rejects(evaluateMetadata('ws://127.0.0.1:41234/devtools/page/a', 'document.body.innerText', { WebSocket: Socket }));
  assert.equal(sent.length, 1);
});

test('startup secrets arrive only through bounded stdin and fixed production endpoints', async () => {
  assert.deepEqual((await readStartup(Readable.from([JSON.stringify(config)]))).api_url, 'https://curtbrag.com/.netlify/functions/cluster-api');
  for (const invalid of [{ ...config, api_url: 'https://evil.com/' }, { ...config, swarm_api: 'https://evil.com/' }, { ...config, password: 'bad\nheader' }, { ...config, adb_path: 'adb.exe' }, { ...config, shell_command: 'anything' }]) await assert.rejects(readStartup(Readable.from([JSON.stringify(invalid)])));
  await assert.rejects(readStartup(Readable.from(['x'.repeat(16385)])));
});

test('lease parser requires a backend UUID and bounded start/expiry fields', () => {
  const now = Date.now(), value = { ok: true, follow: { active: true, controller_id: 'curtis-s26-ultra', session_id: 'f83eefb1-777d-4e1d-a17a-343704d24429', started_at: now, expires_at: now + 60000 } };
  assert.equal(activeLease(value, now).session_id, value.follow.session_id);
  assert.equal(activeLease({ ...value, ok: 'true' }, now), null); assert.equal(activeLease({ ok: true, follow: { ...value.follow, active: 'true' } }, now), null);
  for (const fields of [{ session_id: 'foo' }, { session_id: '00000000-0000-0000-0000-000000000000' }, { started_at: null }, { started_at: now + 10000 }, { started_at: now - 3_600_000 }]) assert.equal(activeLease({ ok: true, follow: { ...value.follow, ...fields } }, now), null);
});

test('streaming JSON rejects oversized responses while cancelling the reader', async () => {
  let cancelled = false;
  const fetch = async () => ({ ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('x'.repeat(33))); }, cancel() { cancelled = true; } }) });
  await assert.rejects(readJson('http://127.0.0.1:41234/json/list', { fetch, maxBytes: 32 }));
  assert.equal(cancelled, true);
});

test('large queue history is bounded separately and discarded except for pending launch receipts', async () => {
  const originalFetch = globalThis.fetch;
  const pending = { device_id: 'phone173', job_id: 'pending-job', exit_code: 0, stdout: '{}', stderr: 'do not retain' };
  const history = { nodes: [{ id: 'phone173', online: true, last_seen: Date.now(), busy: false, active_jobs: [], agent_version: '2.2.0', secret: 'do not retain' }], jobs: [{ cmd: 'do not retain' }], results: [pending, { device_id: 'phone174', job_id: 'unrelated-job', stdout: 'x'.repeat(1_050_000) }] };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://curtbrag.com/api/cluster?action=queue-status'); assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify(history), { status: 200 });
  };
  try {
    const follower = new PhoneFollower(config); follower.pending.set('phone173', 'pending-job');
    const result = await follower.request('https://curtbrag.com/api/cluster', 'queue-status', 'GET');
    assert.equal(result.results.length, 1); assert.equal(result.results[0].job_id, 'pending-job'); assert.equal(Object.hasOwn(result.results[0], 'stderr'), false);
    assert.deepEqual(result.jobs, []); assert.equal(Object.hasOwn(result.nodes[0], 'secret'), false); assert.equal(JSON.stringify(result).includes('do not retain'), false);
  } finally { globalThis.fetch = originalFetch; }
});


function browserFixture({ targets = 41, json, evaluate, foreground } = {}) {
  const calls = [], removes = [];
  const pages = () => Array.from({ length: targets }, (_, index) => ({ type: 'page', url: 'NEVER READ BACKGROUND URL ' + index, title: 'NEVER READ CONTENT', webSocketDebuggerUrl: 'ws://localhost:41234/devtools/page/' + index }));
  const source = new BrowserSource({
    adb: { async devices() { return transport + '\tdevice'; }, async foreground() { return foreground ? foreground() : 'BROWSER_CHROME'; }, async forward() { return 41234; }, async remove(port) { removes.push(port); } },
    json: async (...args) => json ? json(...args, pages) : pages(),
    evaluate: async (url, expression, options) => { calls.push({ url, expression }); return evaluate(url, expression, options); },
  });
  return { source, calls, removes, controller: registeredController(registry) };
}
const timeoutFailure = () => Object.assign(Error('unverified connection'), { code: 'CDP_READ_TIMEOUT' });

test('41-page Chrome with40 unknown timeouts reads only the positively visible focused page', async () => {
  let reads = 0, maximum = 0, running = 0, jsonReads = 0;
  const f = browserFixture({
    json: async (url, options, pages) => { jsonReads++; return pages(); },
    evaluate: async (url, expression, options) => {
      if (!url.endsWith('/0')) {
        assert.equal(options.timeoutMs, 1400);
        assert.equal(expression, 'document.visibilityState');
        running++; maximum = Math.max(maximum, running);
        await new Promise(resolve => setImmediate(resolve)); running--; throw timeoutFailure();
      }
      if (expression === 'location.href') { reads++; return 'https://www.google.com/'; }
      return expression === 'document.hasFocus()' ? true : 'visible';
    },
  });
  assert.equal(await f.source.sample(f.controller), 'https://www.google.com/');
  assert.equal(reads, 1); assert.equal(maximum, 8); assert.equal(running, 0); assert.equal(jsonReads, 2);
  assert.equal(f.calls.filter(call => call.expression === 'document.hasFocus()').length, 2);
  assert.equal(f.calls.some(call => call.expression !== 'document.visibilityState' && !call.url.endsWith('/0')), false);
  assert.equal(JSON.stringify(f.calls).includes('NEVER READ'), false);
  await f.source.cleanup(); assert.deepEqual(f.removes, [41234]);
});

test('timed-out pages never become hidden proof and a visible but unfocused page cannot yield a URL', async () => {
  const f = browserFixture({ evaluate: async (url, expression) => {
    if (!url.endsWith('/0')) throw timeoutFailure();
    if (expression === 'location.href') assert.fail('Unfocused address must not be read');
    return expression === 'document.hasFocus()' ? false : 'visible';
  } });
  assert.equal(await f.source.sample(f.controller), null);
  assert.equal(f.calls.some(call => call.expression === 'location.href'), false); assert.deepEqual(f.removes, [41234]);
});

test('focus loss after address read discards the address and cleans only its owned forward', async () => {
  let focused = true, reads = 0;
  const f = browserFixture({ targets: 1, evaluate: async (url, expression) => {
    if (expression === 'document.hasFocus()') return focused;
    if (expression === 'location.href') { reads++; focused = false; return 'https://www.google.com/'; }
    return 'visible';
  } });
  assert.equal(await f.source.sample(f.controller), null); assert.equal(reads, 1); assert.deepEqual(f.removes, [41234]);
});

test('Stop during focused-page proof prevents the address read', async () => {
  let active = true;
  const f = browserFixture({ targets: 1, evaluate: async (url, expression) => {
    if (expression === 'document.hasFocus()') { active = false; return true; }
    if (expression === 'location.href') assert.fail('Stopped address must not be read');
    return 'visible';
  } });
  await assert.rejects(f.source.sample(f.controller, async () => active));
  assert.equal(f.calls.some(call => call.expression === 'location.href'), false); assert.deepEqual(f.removes, [41234]);
});

test('a new target during uncertain discovery postpones sampling without reading an address', async () => {
  let discovery = 0;
  const f = browserFixture({ targets: 2,
    json: async (url, options, pages) => { const result = pages(); if (++discovery > 1) result.push({ type: 'page', webSocketDebuggerUrl: 'ws://localhost:41234/devtools/page/new' }); return result; },
    evaluate: async (url, expression) => { if (url.endsWith('/1')) throw timeoutFailure(); assert.equal(expression, 'document.visibilityState'); return 'visible'; },
  });
  assert.equal(await f.source.sample(f.controller), null); assert.equal(f.calls.some(call => call.expression === 'location.href'), false); assert.deepEqual(f.removes, [41234]);
});

test('closed uncertain targets are revalidated but unknown live-page errors still fail closed', async () => {
  for (const retained of [false, true]) {
    let discovery = 0;
    const f = browserFixture({ targets: 2,
      json: async (url, options, pages) => { const result = pages(); if (++discovery > 1 && !retained) result.pop(); return result; },
      evaluate: async (url, expression) => {
        if (url.endsWith('/1')) throw Error('generic/private response cannot be trusted');
        if (expression === 'location.href') return 'https://www.google.com/';
        return expression === 'document.hasFocus()' ? true : 'visible';
      },
    });
    if (retained) { await assert.rejects(f.source.sample(f.controller)); assert.equal(f.calls.some(call => call.expression === 'location.href'), false); }
    else { assert.equal(await f.source.sample(f.controller), 'https://www.google.com/'); await f.source.cleanup(); }
    assert.deepEqual(f.removes, [41234]);
  }
});

test('discovery bound is128 and duplicate endpoint identities never yield an address', async () => {
  for (const targets of [128, 129]) {
    const f = browserFixture({ targets, evaluate: async () => 'hidden' });
    if (targets === 128) assert.equal(await f.source.sample(f.controller), null);
    else await assert.rejects(f.source.sample(f.controller));
    assert.equal(f.calls.some(call => call.expression === 'location.href'), false); assert.deepEqual(f.removes, [41234]);
  }
  const f = browserFixture({ targets: 2, json: async (url, options, pages) => { const result = pages(); result[1] = result[0]; return result; }, evaluate: async () => assert.fail('Duplicate targets must not be evaluated') });
  await assert.rejects(f.source.sample(f.controller)); assert.deepEqual(f.removes, [41234]);
});

test('focus metadata requires a native boolean and timeouts expose only a bounded failure classification', async () => {
  for (const value of [true, false, 'true', 1, null]) {
    class Socket extends EventEmitter {
      constructor() { super(); queueMicrotask(() => this.emit('open')); }
      addEventListener(name, fn) { this.on(name, fn); }
      send(raw) { const message = JSON.parse(raw); assert.equal(message.params.expression, 'document.hasFocus()'); assert.equal(message.params.throwOnSideEffect, true); queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: 1, result: { result: { type: typeof value, value } } }) })); }
      close() {}
    }
    if (typeof value === 'boolean') assert.equal(await evaluateMetadata('ws://127.0.0.1:41234/devtools/page/0', 'document.hasFocus()', { WebSocket: Socket }), value);
    else await assert.rejects(evaluateMetadata('ws://127.0.0.1:41234/devtools/page/0', 'document.hasFocus()', { WebSocket: Socket }));
  }
  class Silent extends EventEmitter { constructor() { super(); queueMicrotask(() => this.emit('open')); } addEventListener(name, fn) { this.on(name, fn); } send() {} close() {} }
  await assert.rejects(evaluateMetadata('ws://127.0.0.1:41234/devtools/page/0', 'document.visibilityState', { WebSocket: Silent, timeoutMs: 10 }), error => error.code === 'CDP_READ_TIMEOUT' && !error.message.includes('ws:'));
});


test('a closed visible candidate and a source change during fresh target revalidation never yield a URL', async () => {
  for (const changedBrowser of [false, true]) {
    let discovery = 0, foregroundReads = 0;
    const f = browserFixture({ targets: 2,
      foreground: () => ++foregroundReads > 1 && changedBrowser ? 'BROWSER_OTHER' : 'BROWSER_CHROME',
      json: async (url, options, pages) => { const result = pages(); if (++discovery > 1) result.shift(); return result; },
      evaluate: async (url, expression) => { if (url.endsWith('/1')) throw timeoutFailure(); assert.equal(expression, 'document.visibilityState'); return 'visible'; },
    });
    assert.equal(await f.source.sample(f.controller), null); assert.equal(f.calls.some(call => call.expression === 'location.href'), false); assert.deepEqual(f.removes, [41234]);
  }
});

test('lease expiry while final focus/foreground verification is running discards the sampled URL', async () => {
  let active = true, focusReads = 0, urlReads = 0;
  const f = browserFixture({ targets: 1, evaluate: async (url, expression) => {
    if (expression === 'document.hasFocus()') { if (++focusReads === 2) active = false; return true; }
    if (expression === 'location.href') { urlReads++; return 'https://www.google.com/'; }
    return 'visible';
  } });
  await assert.rejects(f.source.sample(f.controller, async () => active)); assert.equal(urlReads, 1); assert.deepEqual(f.removes, [41234]);
});
