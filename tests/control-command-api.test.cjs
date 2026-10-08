// All API regression tests use synthetic credentials and in-memory storage.
// Native fetch is replaced; no network, actual queues, or devices are accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const integrationTest = require.main === module ? (name, run) => test(name, { timeout: 3000 }, run) : () => {};
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const NOW = Date.parse('2026-10-08T19:00:00Z');
const STATE_KEY = 'control-state-v1';
const TYPE = 'phone-return-termux';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const sortedIds = values => values.map(item => item.id).sort();

function fixture(options = {}) {
  const fixtureNow = options.now ?? NOW;
  const stores = new Map(), reads = [], writes = [], calls = [], faults = [], barriers = [], modules = new Map();
  let identities = 0;
  const data = name => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); };
  function seed(name, key, value) { data(name).set(key, { value: clone(value), etag: '"v1"', version: 1 }); }
  seed('cp-commands', 'queue', options.queue || []);
  seed('cp-commands', 'history', options.history || []);
  seed('cluster-control', 'queue', options.legacyQueue || []);
  seed('cluster-control', 'history', options.legacyHistory || []);
  seed('cp-bridge', 'heartbeat', options.bridge === undefined ? { last_seen_at: new Date(fixtureNow - 1000).toISOString(), bridge_version: '2.5.0' } : options.bridge);
  for (const device of options.devices || [{ id: 'fixture-phone', hostname: 'phone173', device_class: 'phone' }]) seed('cp-devices', device.id, device);
  for (const entry of options.seed || []) seed(entry.store, entry.key, entry.value);

  function fault(stage, name, key, kind = 'throw', count = 1, skip = 0) { faults.push({ stage, name, key, kind, count, skip }); }
  function takeFault(stage, name, key) {
    const item = faults.find(item => item.count && item.stage === stage && item.name === name && item.key === key);
    if (item?.skip) { item.skip--; return null; }
    if (item) { item.count--; return item; }
    return null;
  }
  function barrier(stage, name, key, count = 2) {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    barriers.push({ stage, name, key, count, arrived: 0, promise, release });
  }
  async function wait(stage, name, key) {
    const item = barriers.find(item => item.stage === stage && item.name === name && item.key === key && item.arrived < item.count);
    if (!item) return;
    item.arrived++;
    if (item.arrived === item.count) item.release();
    await item.promise;
  }
  async function read(name, key, opts, withMetadata = false) {
    if (takeFault('read', name, key)) throw new Error('Fixture read unavailable');
    const row = data(name).get(key);
    const snapshot = row ? clone(row) : null;
    reads.push({ name, key, options: clone(opts), etag: snapshot?.etag ?? null });
    await wait('read', name, key);
    if (!snapshot) return null;
    const value = opts?.type === 'text' ? (typeof snapshot.value === 'string' ? snapshot.value : JSON.stringify(snapshot.value)) : clone(snapshot.value);
    return realmCopy(withMetadata ? { data: value, etag: snapshot.etag, metadata: {} } : value);
  }
  async function memoryFetch(_input, init = {}) {
    const request = init.fixtureWrite;
    if (!request) throw new Error('Network access is prohibited in these fixtures');
    const { name, key, value, options: writeOptions } = request;
    const failed = takeFault('write', name, key);
    if (failed?.kind === 'throw') throw new Error('Fixture storage write unavailable');
    if (failed?.kind === 'http') return new Response('', { status: 503 });
    const previous = data(name).get(key);
    const conflict = (writeOptions.onlyIfNew === true && !!previous) ||
      (writeOptions.onlyIfMatch !== undefined && writeOptions.onlyIfMatch !== previous?.etag);
    if (conflict) {
      writes.push({ name, key, options: clone(writeOptions), status: 412, committed: false });
      return new Response('', { status: 412 });
    }
    const version = (previous?.version || 0) + 1, etag = `"v${version}"`;
    data(name).set(key, { value: clone(value), version, etag });
    writes.push({ name, key, options: clone(writeOptions), status: 200, committed: true, value: clone(value) });
    if (failed?.kind === 'after') throw new Error('Fixture response lost after committed write');
    return new Response('', { status: 200, headers: { ETag: etag } });
  }
  function getStore(nameOrOptions, suppliedOptions = {}) {
    const name = typeof nameOrOptions === 'string' ? nameOrOptions : nameOrOptions.name;
    const storeOptions = typeof nameOrOptions === 'string' ? suppliedOptions : nameOrOptions;
    calls.push({ name, options: { ...storeOptions, fetch: storeOptions.fetch ? 'custom-fetch' : undefined } });
    async function set(key, value, writeOptions = {}) {
      let parsed = value;
      if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch {} }
      const response = await (storeOptions.fetch || memoryFetch)(`https://fixture.invalid/${encodeURIComponent(name)}/${encodeURIComponent(key)}`, {
        method: 'PUT', body: typeof value === 'string' ? value : JSON.stringify(value),
        fixtureWrite: { name, key, value: parsed, options: writeOptions },
      });
      // SDK 10 reports any non-412 response as modified:true. Checked fetch
      // must reject actual storage failures before this misleading SDK result.
      return realmCopy({ modified: response.status !== 412, etag: response.headers.get('etag') || null });
    }
    return {
      get: (key, opts) => read(name, key, opts),
      getWithMetadata: (key, opts) => read(name, key, opts, true),
      set, setJSON: (key, value, opts) => set(key, JSON.stringify(value), opts),
      list: async () => ({ blobs: [...data(name).keys()].map(key => ({ key })) }),
      delete: async key => data(name).delete(key),
    };
  }
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [fixtureNow])); }
    static now() { return fixtureNow; }
  }
  const fixtureCrypto = { ...crypto, randomBytes: length => Buffer.alloc(length, ++identities) };
  const env = { CLUSTER_WEB_PASSWORD: 'fixture-operator', CLUSTER_API_KEY: 'fixture-agent', CONTEXT: 'production', ...options.env };
  const context = vm.createContext({
    Buffer, Date: Clock, process: { env }, console: { warn() {}, error() {}, log() {} },
    fetch: memoryFetch, Response, Headers, Request, URL, AbortController,
    TextEncoder, TextDecoder, setTimeout, clearTimeout,
  });
  const realmCopy = vm.runInContext('(value) => JSON.parse(JSON.stringify(value))', context);
  function load(filename) {
    const absolute = path.resolve(filename);
    if (!absolute.startsWith(ROOT + path.sep)) throw new Error('Fixture dependency outside candidate repository');
    if (modules.has(absolute)) return modules.get(absolute).exports;
    const module = { exports: {} }; modules.set(absolute, module);
    function localRequire(name) {
      if (name === '@netlify/blobs' || name === '@netlify/control-blobs') return { getStore, connectLambda() {} };
      if (name === 'crypto' || name === 'node:crypto') return fixtureCrypto;
      if (name.startsWith('.')) return load(path.resolve(path.dirname(absolute), name));
      throw new Error(`Unexpected dependency in offline fixture: ${name}`);
    }
    const wrapped = '(function(exports, require, module, __filename, __dirname) {\n' + fs.readFileSync(absolute, 'utf8') + '\n})';
    const compile = vm.runInContext(wrapped, context, { filename: absolute });
    compile(module.exports, localRequire, module, absolute, path.dirname(absolute));
    return module.exports;
  }
  async function invoke(filename, method, action, body = {}, extra = {}) {
    const headers = filename === 'cluster-api.js' ? { authorization: 'Bearer fixture-operator' } :
      filename === 'agent-api.js' ? { 'x-agent-token': 'fixture-agent', 'x-device-id': 'fixture-phone' } : { 'x-cluster-key': 'fixture-agent' };
    const response = await load(path.join(ROOT, 'netlify/functions', filename)).handler({
      httpMethod: method, headers: { ...headers, ...extra.headers },
      queryStringParameters: { action, ...extra.params },
      path: filename === 'agent-api.js' ? `/.netlify/functions/agent-api/${action}` : `/.netlify/functions/${filename.slice(0, -3)}`,
      body: JSON.stringify(body), ...extra.event,
    }, {});
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null };
  }
  return {
    fault, barrier, reads, writes, calls, seed,
    inspect: (name, key) => clone(data(name).get(key)?.value),
    stage(queue, history) {
      const row = data('cp-commands').get(STATE_KEY);
      if (!row) throw new Error('Initialize the authoritative fixture before staging known current commands');
      const value = { ...clone(row.value), queue: clone(queue), ...(history ? { history: clone(history) } : {}) }, version = row.version + 1;
      data('cp-commands').set(STATE_KEY, { value, version, etag: `"v${version}"` });
    },
    cp: (action, body = {}, extra) => invoke('cluster-api.js', 'POST', action, body, extra),
    cpGet: (action = 'commands', extra) => invoke('cluster-api.js', 'GET', action, {}, extra),
    agent: (action, method = 'GET', body = {}, extra) => invoke('agent-api.js', method, action, body, extra),
    legacy: (action = '', method = 'GET', body = {}, extra) => invoke('cluster-control.js', method, action, body, extra),
    async ready() { const result = await this.cpGet(); assert.equal(result.status, 200); return result.body; },
    async view() { const result = await this.cpGet(); assert.equal(result.status, 200); return result.body; },
  };
}

function cmd(id, type = 'run-diagnostic', target = 'phone173') {
  return { id, type, target, route: 'bridge', payload: {}, status: 'queued', created_by: 'operator', created_at: NOW - 5000, started_at: null, finished_at: null, result_summary: null };
}
const completed = command => ({ ...clone(command), status: 'completed', output: 'old output', result_summary: 'old result', finished_at: NOW - 1 });
const completion = command => ({ id: command.id, type: command.type, target: command.target, status: 'completed', output: 'fixture result', result_summary: 'fixture done' });
const phoneReport = overrides => ({ kind: 'phone-controller-return', unit: 'phone253', state: 'termux-foreground', foreground_app_verified: true, visible_screen_verified: false, controller_state: 'connected', error: null, ...overrides });
const phoneCmd = () => cmd('return-253', TYPE, 'phone253');
const phoneCompletion = overrides => ({ ...completion(phoneCmd()), output: JSON.stringify(phoneReport()), ...overrides });
async function queue(h, target = 'phone173', extra = {}) { return h.cp('queue-command', { type: 'run-diagnostic', target, ...extra }); }
function preserves(view, expected) {
  const actual = [...sortedIds(view.queue), ...sortedIds(view.history)].sort();
  assert.deepEqual(actual, [...expected].sort());
  assert.equal(new Set(actual).size, actual.length, 'Each command must have one lifecycle location');
}

integrationTest('concurrent acknowledged enqueues preserve both IDs and use conditional writes', async () => {
  const h = fixture(); await h.ready(); h.barrier('read', 'cp-commands', STATE_KEY);
  const responses = await Promise.all([queue(h, 'phone173'), queue(h, 'phone174')]);
  assert.ok(responses.every(response => response.status === 200)); const view = await h.view();
  preserves(view, responses.map(response => response.body.command_id));
  assert.ok(h.writes.some(write => write.status === 412));
  assert.ok(h.writes.filter(write => write.name === 'cp-commands' && write.key === STATE_KEY).every(write => write.options.onlyIfNew === true || typeof write.options.onlyIfMatch === 'string'));
});

integrationTest('completion racing enqueue atomically archives old ID and retains new ID', async () => {
  const a = cmd('old-a'), old = completed(cmd('old-history')), h = fixture({ queue: [a], history: [old] });
  await h.ready(); h.barrier('read', 'cp-commands', STATE_KEY);
  const [done, added] = await Promise.all([h.cp('bridge-complete', completion(a)), queue(h, 'phone174')]);
  assert.equal(done.status, 200); assert.equal(added.status, 200); const view = await h.view();
  preserves(view, [a.id, old.id, added.body.command_id]); assert.deepEqual(sortedIds(view.queue), [added.body.command_id]);
  assert.deepEqual(view.history.find(item => item.id === old.id), old);
});

integrationTest('simultaneous completions retain both reports and previous history', async () => {
  const a = cmd('a'), b = cmd('b'), old = completed(cmd('old')), h = fixture({ queue: [a, b], history: [old] });
  await h.ready(); h.barrier('read', 'cp-commands', STATE_KEY);
  const responses = await Promise.all([h.cp('bridge-complete', completion(a)), h.cp('bridge-complete', completion(b))]);
  assert.ok(responses.every(response => response.status === 200)); const view = await h.view();
  preserves(view, ['a', 'b', 'old']); assert.equal(view.queue.length, 0); assert.deepEqual(view.history.find(item => item.id === 'old'), old);
});

integrationTest('duplicate ordinary completion cannot append duplicate history', async () => {
  const a = cmd('a'), h = fixture({ queue: [a] }); await h.ready();
  assert.equal((await h.cp('bridge-complete', completion(a))).status, 200);
  const retry = await h.cp('bridge-complete', completion(a)); assert.ok([200, 409].includes(retry.status));
  const view = await h.view(); preserves(view, ['a']); assert.equal(view.history.length, 1);
});

integrationTest('unavailable atomic completion write returns failure without removing queued work', async () => {
  const a = cmd('a'), old = completed(cmd('old')), h = fixture({ queue: [a], history: [old] }); await h.ready();
  const before = h.inspect('cp-commands', STATE_KEY); h.fault('write', 'cp-commands', STATE_KEY, 'throw', 100);
  assert.equal((await h.cp('bridge-complete', completion(a))).status, 503); assert.deepEqual(h.inspect('cp-commands', STATE_KEY), before);
});

integrationTest('unavailable queue-state read returns failure instead of fabricating history', async () => {
  const a = cmd('a'), old = completed(cmd('old')), h = fixture({ queue: [a], history: [old] }); await h.ready();
  const before = h.inspect('cp-commands', STATE_KEY); h.fault('read', 'cp-commands', STATE_KEY, 'throw', 100);
  assert.equal((await h.cp('bridge-complete', completion(a))).status, 503); assert.deepEqual(h.inspect('cp-commands', STATE_KEY), before);
});

integrationTest('migration history read failure never overwrites existing reports', async () => {
  const a = cmd('a'), old = completed(cmd('old')), h = fixture({ queue: [a], history: [old] });
  h.fault('read', 'cp-commands', 'history', 'throw', 100);
  assert.equal((await h.cp('bridge-complete', completion(a))).status, 503);
  assert.deepEqual(h.inspect('cp-commands', 'queue'), [a]); assert.deepEqual(h.inspect('cp-commands', 'history'), [old]);
});

integrationTest('HTTP503 storage response cannot be mistaken for accepted enqueue or CAS conflict', async () => {
  const h = fixture(); await h.ready(); h.fault('write', 'cp-commands', STATE_KEY, 'http', 100);
  assert.equal((await queue(h)).status, 503); assert.equal(h.inspect('cp-commands', STATE_KEY).queue.length, 0);
  assert.ok(h.calls.some(call => call.name === 'cp-commands' && call.options.fetch === 'custom-fetch'));
});

integrationTest('stable request ID reconciles a write committed before response loss', async () => {
  const h = fixture(); await h.ready(); h.fault('write', 'cp-commands', STATE_KEY, 'after');
  const first = await queue(h, 'phone173', { request_id: 'stable-request-1' });
  assert.ok([200, 503].includes(first.status)); const retry = await queue(h, 'phone173', { request_id: 'stable-request-1' });
  assert.equal(retry.status, 200); const view = await h.view(); assert.equal(view.queue.length, 1); assert.equal(view.queue[0].id, retry.body.command_id);
  if (first.status === 200) assert.equal(first.body.command_id, retry.body.command_id);
});

integrationTest('request ID reuse with changed input is rejected without adding a command', async () => {
  const h = fixture(); assert.equal((await queue(h, 'phone173', { request_id: 'same-request' })).status, 200);
  assert.equal((await queue(h, 'phone174', { request_id: 'same-request' })).status, 409);
  assert.equal((await h.view()).queue.length, 1);
});

integrationTest('full queue rejects enqueue and preserves oldest acknowledged command', async () => {
  const initial = Array.from({ length: 200 }, (_, index) => cmd(`old-${index}`)), h = fixture({ queue: initial });
  const response = await queue(h); assert.ok([409, 429, 503].includes(response.status));
  assert.deepEqual((await h.view()).queue, initial);
});

integrationTest('simultaneous exclusive fleet checks accept at most one request', async () => {
  const h = fixture(); await h.ready(); h.barrier('read', 'cp-commands', STATE_KEY);
  const responses = await Promise.all([h.cp('queue-command', { type: 'fleet-check', target: 'all' }), h.cp('queue-command', { type: 'fleet-check', target: 'all' })]);
  assert.equal(responses.filter(response => response.status === 200).length, 1); assert.equal(responses.filter(response => response.status === 409).length, 1);
  assert.equal((await h.view()).queue.filter(item => item.type === 'fleet-check').length, 1);
});

integrationTest('reset restart writer reports rejected storage instead of success', async () => {
  const h = fixture(); await h.ready(); h.fault('write', 'cp-commands', STATE_KEY, 'throw', 100);
  assert.equal((await h.cp('reset-restart-count', { device_id: 'fixture-phone' })).status, 503);
  assert.equal(h.inspect('cp-commands', STATE_KEY).queue.length, 0);
});

integrationTest('reset restart and standard enqueue preserve both concurrent records', async () => {
  const h = fixture(); await h.ready(); h.barrier('read', 'cp-commands', STATE_KEY);
  const responses = await Promise.all([h.cp('reset-restart-count', { device_id: 'fixture-phone' }), queue(h, 'phone174')]);
  assert.ok(responses.every(response => response.status === 200)); const view = await h.view();
  assert.equal(view.queue.length, 2); assert.deepEqual(view.queue.map(item => item.type).sort(), ['reset-restart-count', 'run-diagnostic']);
});

integrationTest('flush failure preserves the entire outstanding queue and history', async () => {
  const a = cmd('a'), old = completed(cmd('old')), h = fixture({ queue: [a], history: [old] }); await h.ready();
  const before = h.inspect('cp-commands', STATE_KEY); h.fault('write', 'cp-commands', STATE_KEY, 'throw', 100);
  assert.equal((await h.cp('flush-queue', {})).status, 503); assert.deepEqual(h.inspect('cp-commands', STATE_KEY), before);
});

integrationTest('flush racing enqueue archives cancellations atomically and stable replay leaves later work', async () => {
  const a = cmd('a'), old = completed(cmd('old')), h = fixture({ queue: [a], history: [old] }); await h.ready(); h.barrier('read', 'cp-commands', STATE_KEY);
  const [flushed, added] = await Promise.all([h.cp('flush-queue', { request_id: 'stable-flush-1' }), queue(h)]);
  assert.equal(flushed.status, 200); assert.equal(added.status, 200); let view = await h.view(); preserves(view, ['a', 'old', added.body.command_id]);
  assert.equal(view.history.find(item => item.id === 'a').status, 'cancelled');
  const later = await queue(h, 'phone174'); assert.equal(later.status, 200); const before = clone(h.inspect('cp-commands', STATE_KEY));
  assert.equal((await h.cp('flush-queue', { request_id: 'stable-flush-1' })).status, 200);
  view = await h.view(); assert.ok(view.queue.some(item => item.id === later.body.command_id));
  const after = h.inspect('cp-commands', STATE_KEY); assert.deepEqual(after.queue, before.queue); assert.deepEqual(after.history, before.history);
});

integrationTest('unknown mismatched and cancelled bridge completions cannot fabricate successful history', async () => {
  const a = cmd('a'), h = fixture({ queue: [a] }); await h.ready();
  assert.equal((await h.cp('bridge-complete', completion(cmd('unknown')))).status, 409);
  assert.ok([400, 409].includes((await h.cp('bridge-complete', { ...completion(a), target: 'phone174' })).status));
  assert.ok([400, 409].includes((await h.cp('bridge-complete', { ...completion(a), type: 'browse' })).status));
  assert.equal((await h.cp('flush-queue')).status, 200);
  assert.equal((await h.cp('bridge-complete', completion(a))).status, 409); assert.equal((await h.view()).history.length, 1);
});

integrationTest('changed ordinary completion cannot replace a terminal report', async () => {
  const a = cmd('a'), h = fixture({ queue: [a] }); assert.equal((await h.cp('bridge-complete', completion(a))).status, 200);
  const before = (await h.view()).history; assert.equal((await h.cp('bridge-complete', { ...completion(a), output: 'different result' })).status, 409);
  assert.deepEqual((await h.view()).history, before);
});

integrationTest('an old uncoordinated writer triggers the migration fence without replacing authoritative state', async () => {
  const h = fixture({ queue: [cmd('a')] }); await h.ready(); const before = h.inspect('cp-commands', STATE_KEY);
  h.seed('cp-commands', 'queue', [cmd('a'), cmd('old-writer-addition')]);
  assert.equal((await queue(h)).status, 503); assert.deepEqual(h.inspect('cp-commands', STATE_KEY), before);
  assert.equal(h.inspect('cp-commands', 'queue').length, 2);
});

integrationTest('flush safely clears a migration hold while preserving its existing terminal evidence', async () => {
  const pending = cmd('overlap-a'), saved = completed(pending), h = fixture({ queue: [pending], history: [saved] });
  const initial = await h.ready(); assert.equal(initial.pending.length, 1); assert.equal(initial.pending[0].status, 'held');
  const flushed = await h.cp('flush-queue'); assert.equal(flushed.status, 200); assert.equal(flushed.body.cancelled, 1);
  const state = h.inspect('cp-commands', STATE_KEY); assert.equal(state.queue.length, 0); assert.equal(state.history.length, 1);
  const entry = state.history[0]; assert.equal(entry.id, saved.id); assert.equal(entry.status, saved.status); assert.equal(entry.output, saved.output);
  assert.equal(entry.finished_at, saved.finished_at); assert.equal(entry.pending_cancelled_at, NOW); assert.equal(entry.cancelled_pending_record.id, pending.id);
  assert.equal(entry.cancelled_pending_record.status, 'held');
  assert.deepEqual(h.inspect('cp-commands', 'queue'), [pending]); assert.deepEqual(h.inspect('cp-commands', 'history'), [saved]);
});

integrationTest('flush at full pending capacity retains every cancelled ID within history retention', async () => {
  const pending = Array.from({ length: 200 }, (_, index) => cmd(`pending-${index}`));
  const history = Array.from({ length: 199 }, (_, index) => completed(cmd(`historical-${index}`)));
  const h = fixture({ queue: pending, history }); await h.ready(); const result = await h.cp('flush-queue');
  assert.equal(result.status, 200); assert.equal(result.body.cancelled, 200); const state = h.inspect('cp-commands', STATE_KEY);
  assert.equal(state.queue.length, 0); assert.equal(state.history.length, 200); assert.deepEqual(sortedIds(state.history), sortedIds(pending));
  assert.ok(state.history.every(entry => entry.status === 'cancelled'));
});

integrationTest('bridge report limits reject oversize input without mutation and accept supported boundaries', async () => {
  for (const changed of [{ output: 'x'.repeat(32769) }, { result_summary: 'x'.repeat(1025) }]) {
    const a = cmd('a'), h = fixture({ queue: [a] }); await h.ready(); const before = h.inspect('cp-commands', STATE_KEY);
    assert.equal((await h.cp('bridge-complete', { ...completion(a), ...changed })).status, 400); assert.deepEqual(h.inspect('cp-commands', STATE_KEY), before);
  }
  const a = cmd('a'), h = fixture({ queue: [a] });
  assert.equal((await h.cp('bridge-complete', { ...completion(a), output: 'x'.repeat(32768), result_summary: 'x'.repeat(1024) })).status, 200);
  assert.equal(h.inspect('cp-commands', STATE_KEY).history[0].output.length, 32768);
});

integrationTest('direct agent cannot claim or complete fixed bridge-only phone return', async () => {
  const a = phoneCmd(), h = fixture({ queue: [a], devices: [{ id: 'fixture-phone', hostname: 'phone253', device_class: 'phone' }] });
  const poll = await h.agent('commands'); assert.equal(poll.status, 200); assert.deepEqual(poll.body.commands, []);
  assert.equal((await h.agent('command-result', 'POST', { command_id: a.id, success: true, exit_code: 0, stdout: 'unverified' })).status, 409);
  assert.equal((await h.legacy('', 'POST', { action: 'complete', id: a.id, command: TYPE, target: a.target, result: 'unverified' })).status, 409);
  const view = await h.view(); assert.equal(view.queue[0].status, 'queued'); assert.equal(view.history.length, 0);
});

integrationTest('all canonical phones accept fixed return commands without arbitrary payloads', async () => {
  for (const target of ['phone173', 'phone174', 'phone176', 'phone177', 'phone191', 'phone195', 'phone253', 'phone254']) {
    const h = fixture(); const response = await h.cp('queue-command', { type: TYPE, target }); assert.equal(response.status, 200, target);
    const view = await h.view(); assert.equal(view.queue.length, 1); assert.equal(view.queue[0].id, response.body.command_id); assert.deepEqual(view.queue[0].payload, {});
    assert.equal(h.inspect('cluster-control', 'queue').length, 0);
  }
  for (const payload of [null, [], '', false, 0, { cmd: 'input keyevent 4' }]) {
    const h = fixture(); assert.equal((await h.cp('queue-command', { type: TYPE, target: 'phone253', payload })).status, 400);
    assert.equal(h.writes.length, 0);
  }
});

integrationTest('phone return rejects noncanonical targets and retains authentication', async () => {
  for (const target of ['all', 'phones', 'pcs', 'Alina', 'Phone253', 'phone252', 'phone253;input keyevent 4', 'fixture-phone']) {
    const h = fixture(); assert.equal((await h.cp('queue-command', { type: TYPE, target })).status, 400, target); assert.equal(h.writes.length, 0);
  }
  const h = fixture(); assert.equal((await h.cp('queue-command', { type: TYPE, target: 'phone253' }, { headers: { authorization: '' } })).status, 401); assert.equal(h.writes.length, 0);
});

integrationTest('phone return requires fresh valid bridge2.5 and excludes future heartbeats', async () => {
  for (const bridge of [null, {}, { bridge_version: '2.4.99', last_seen_at: new Date(NOW).toISOString() }, { bridge_version: '2.5', last_seen_at: new Date(NOW).toISOString() }, { bridge_version: '2.5.0', last_seen_at: 'invalid' }, { bridge_version: '2.5.0', last_seen_at: new Date(NOW - 60000).toISOString() }, { bridge_version: '2.5.0', last_seen_at: new Date(NOW + 1).toISOString() }]) {
    const h = fixture({ bridge }); assert.equal((await h.cp('queue-command', { type: TYPE, target: 'phone253' })).status, 409); assert.equal(h.writes.length, 0);
  }
});

integrationTest('concurrent same-phone return dedupe happens within atomic transition', async () => {
  const h = fixture(); await h.ready(); h.barrier('read', 'cp-commands', STATE_KEY);
  const responses = await Promise.all([h.cp('queue-command', { type: TYPE, target: 'phone253' }), h.cp('queue-command', { type: TYPE, target: 'phone253' })]);
  assert.equal(responses.filter(response => response.status === 200).length, 1); assert.equal(responses.filter(response => response.status === 409).length, 1);
  assert.equal((await h.view()).queue.length, 1);
});

integrationTest('strict phone completion validation rejects mismatches and contradictory evidence', async () => {
  for (const overrides of [{ id: 'unknown' }, { target: 'phone191' }, { type: 'browse' }, { output: 'not json' }, { output: JSON.stringify(phoneReport({ visible_screen_verified: true })) }, { output: JSON.stringify(phoneReport({ controller_state: 'disconnected' })) }, { status: 'failed' }, { output: JSON.stringify(phoneReport({ foreground_app_verified: false })) }]) {
    const a = phoneCmd(), h = fixture({ queue: [a] }); await h.ready(); const before = h.inspect('cp-commands', STATE_KEY);
    assert.ok([400, 409].includes((await h.cp('bridge-complete', phoneCompletion(overrides))).status)); assert.deepEqual(h.inspect('cp-commands', STATE_KEY), before);
  }
});

integrationTest('phone completion write failure has no partial archive and can retry cleanly', async () => {
  const a = phoneCmd(), h = fixture({ queue: [a] }); await h.ready(); const before = h.inspect('cp-commands', STATE_KEY);
  h.fault('write', 'cp-commands', STATE_KEY, 'throw'); assert.equal((await h.cp('bridge-complete', phoneCompletion())).status, 503);
  assert.deepEqual(h.inspect('cp-commands', STATE_KEY), before); assert.equal((await h.cp('bridge-complete', phoneCompletion())).status, 200);
  const view = await h.view(); preserves(view, [a.id]); assert.equal(view.queue.length, 0); assert.deepEqual(JSON.parse(view.history[0].output), phoneReport());
});

integrationTest('terminal phone return replays identical evidence and rejects changed or disguised evidence', async () => {
  const h = fixture({ queue: [phoneCmd()] }); assert.equal((await h.cp('bridge-complete', phoneCompletion())).status, 200);
  assert.equal((await h.cp('bridge-complete', phoneCompletion())).status, 200);
  assert.equal((await h.cp('bridge-complete', phoneCompletion({ type: 'browse' }))).status, 409);
  assert.ok([400, 409].includes((await h.cp('bridge-complete', phoneCompletion({ output: JSON.stringify(phoneReport({ visible_screen_verified: true })) }))).status));
  assert.equal((await h.view()).history.length, 1);
});

integrationTest('phone completion sanitizes success output and bounds failed error evidence', async () => {
  let h = fixture({ queue: [phoneCmd()] });
  assert.equal((await h.cp('bridge-complete', phoneCompletion({ output: JSON.stringify(phoneReport({ command: 'arbitrary', endpoint: 'private' })), result_summary: 'unverified summary' }))).status, 200);
  let entry = (await h.view()).history[0]; assert.deepEqual(JSON.parse(entry.output), phoneReport()); assert.equal(entry.result_summary, 'Termux foreground verified');
  h = fixture({ queue: [phoneCmd()] }); const output = JSON.stringify(phoneReport({ state: 'failed', foreground_app_verified: false, controller_state: 'unauthorized', error: 'Denied\npermission\u0000' + 'x'.repeat(600) }));
  assert.equal((await h.cp('bridge-complete', phoneCompletion({ status: 'failed', output }))).status, 200);
  entry = (await h.view()).history[0]; const error = JSON.parse(entry.output).error; assert.equal(entry.status, 'failed'); assert.equal(error.length, 500); assert.equal(/[\u0000-\u001f\u007f]/.test(error), false);
});

integrationTest('agent acknowledgement racing enqueue retains both and marks only claimed record', async () => {
  const a = { ...cmd('a'), route: 'agent', recipient_ids: ['fixture-phone'] }, h = fixture(); await h.ready(); h.stage([a]); h.barrier('read', 'cp-commands', STATE_KEY);
  const [poll, added] = await Promise.all([h.agent('commands'), queue(h, 'phone174')]);
  assert.equal(poll.status, 200); assert.equal(added.status, 200); const view = h.inspect('cp-commands', STATE_KEY); preserves(view, ['a', added.body.command_id]);
  assert.equal(view.queue.find(item => item.id === 'a').status, 'running'); assert.equal(view.queue.find(item => item.id === added.body.command_id).status, 'queued');
});

integrationTest('agent result racing enqueue atomically archives full original command', async () => {
  const a = { ...cmd('a'), route: 'agent', recipient_ids: ['fixture-phone'], status: 'running', assignments: { 'fixture-phone': { status: 'running', acked_by: 'fixture-phone', acked_at: NOW } } }, h = fixture(); await h.ready(); h.stage([a]); h.barrier('read', 'cp-commands', STATE_KEY);
  const [done, added] = await Promise.all([h.agent('command-result', 'POST', { command_id: 'a', success: true, exit_code: 0, stdout: 'done' }), queue(h, 'phone174')]);
  assert.equal(done.status, 200); assert.equal(added.status, 200); const view = h.inspect('cp-commands', STATE_KEY); preserves(view, ['a', added.body.command_id]);
  assert.equal(view.history[0].created_at, a.created_at); assert.equal(view.history[0].stdout, 'done');
});

integrationTest('agent write and read failures return503 rather than acknowledged delivery/result', async () => {
  for (const action of ['commands', 'command-result']) {
    const a = { ...cmd('a'), route: 'agent', recipient_ids: ['fixture-phone'], ...(action === 'command-result' ? { status: 'running', assignments: { 'fixture-phone': { status: 'running', acked_by: 'fixture-phone', acked_at: NOW } } } : {}) };
    const h = fixture(); await h.ready(); h.stage([a]); const before = h.inspect('cp-commands', STATE_KEY);
    h.fault('write', 'cp-commands', STATE_KEY, 'throw', 100);
    assert.equal((await h.agent(action, action === 'commands' ? 'GET' : 'POST', { command_id: 'a', success: true, exit_code: 0, stdout: 'done' })).status, 503); assert.deepEqual(h.inspect('cp-commands', STATE_KEY), before);
  }
});

integrationTest('legacy enqueue and control enqueue share atomic authority and preserve delivery schemas', async () => {
  const h = fixture(); await h.ready(); h.barrier('read', 'cp-commands', STATE_KEY);
  const [modern, legacy] = await Promise.all([queue(h, 'phone173'), h.legacy('', 'POST', { command: 'mining-status', target: 'node1', password: 'fixture-operator' })]);
  assert.equal(modern.status, 200); assert.equal(legacy.status, 200);
  const legacyView = await h.legacy(); assert.equal(legacyView.status, 200);
  const pendingIds = sortedIds(legacyView.body.queue); assert.ok(!pendingIds.includes(modern.body.command_id)); assert.ok(pendingIds.includes(legacy.body.id));
  const authoritative = h.inspect('cp-commands', STATE_KEY); preserves(authoritative, [modern.body.command_id, legacy.body.id]);
});

integrationTest('legacy poll racing enqueue neither loses new command nor reintroduces delivered command', async () => {
  const h = fixture(); await h.ready();
  const first = await h.legacy('', 'POST', { command: 'mining-status', target: 'node1', password: 'fixture-operator' }); assert.equal(first.status, 200);
  h.barrier('read', 'cp-commands', STATE_KEY);
  const [poll, enqueue] = await Promise.all([h.legacy('poll'), h.legacy('', 'POST', { command: 'mining-status', target: 'node2', password: 'fixture-operator' })]);
  assert.equal(poll.status, 200); assert.equal(enqueue.status, 200); assert.equal(poll.body.id, first.body.id);
  const view = await h.legacy(); assert.ok(view.body.queue.some(item => item.id === enqueue.body.id)); assert.equal(view.body.queue.find(item => item.id === first.body.id).status, 'running');
  const next = await h.legacy('poll'); assert.equal(next.body.id, enqueue.body.id); const empty = await h.legacy('poll'); assert.deepEqual(empty.body, {});
});

integrationTest('legacy storage failure returns503 before reporting delivery or completion', async () => {
  const h = fixture(); await h.ready(); await h.legacy('', 'POST', { command: 'mining-status', target: 'node1', password: 'fixture-operator' });
  h.fault('write', 'cp-commands', STATE_KEY, 'throw', 100); assert.equal((await h.legacy('poll')).status, 503);
  const completionHarness = fixture(); await completionHarness.ready();
  const first = await completionHarness.legacy('', 'POST', { command: 'mining-status', target: 'node1', password: 'fixture-operator' });
  assert.equal((await completionHarness.legacy('poll')).body.id, first.body.id); completionHarness.fault('write', 'cp-commands', STATE_KEY, 'throw', 100);
  assert.equal((await completionHarness.legacy('', 'POST', { action: 'complete', id: first.body.id, command: 'mining-status', target: 'node1', result: 'done' })).status, 503);
});

integrationTest('preview invocation cannot mutate production queue using explicit production storage overrides', async () => {
  const h = fixture({ env: { CONTEXT: 'deploy-preview', DEPLOY_ID: 'fixture-preview', SITE_ID: 'fixture-production-site', NETLIFY_ACCESS_TOKEN: 'synthetic-production-override' } });
  await queue(h);
  assert.ok(!h.writes.some(write => write.committed && ['cp-commands', 'cluster-control'].includes(write.name)), 'Preview must reject writes or use a separate preview namespace');
});

module.exports = { fixture, STATE_KEY, cmd, completion, phoneCmd, phoneCompletion, phoneReport };
