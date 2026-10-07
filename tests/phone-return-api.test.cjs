const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../netlify/functions/cluster-api.js'), 'utf8');
const NOW = Date.parse('2026-10-07T05:00:00.000Z');
const TYPE = 'phone-return-termux';
const PHONES = ['phone173', 'phone174', 'phone176', 'phone177', 'phone191', 'phone195', 'phone253', 'phone254'];
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  const stores = new Map(), writes = [];
  const getData = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  getData('cp-bridge').set('heartbeat', clone(options.bridge === undefined ? {
    last_seen_at: new Date(NOW - 1000).toISOString(), bridge_version: '2.5.0',
  } : options.bridge));
  getData('cp-commands').set('queue', clone(options.queue || []));
  getData('cp-commands').set('history', clone(options.history || []));
  for (const device of options.devices || []) getData('cp-devices').set(device.id, clone(device));
  const getStore = name => ({
    get: async key => clone(getData(name).get(key) ?? null),
    setJSON: async (key, value) => {
      if (options.failWrite === name + ':' + key) throw new Error('Mock persistence failure');
      writes.push({name, key, value: clone(value)}); getData(name).set(key, clone(value));
    },
    set: async (key, value) => { writes.push({name, key, value}); getData(name).set(key, value); },
    list: async () => ({blobs: [...getData(name).keys()].map(key => ({key}))}),
  });
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  const exported = {};
  const context = vm.createContext({
    require: name => name === '@netlify/blobs' ? {getStore, connectLambda() {}} : name === 'crypto' ? crypto : (() => {throw new Error('Unexpected dependency: ' + name);})(),
    exports: exported, module: {exports: exported}, Buffer, Date: Clock,
    process: {env: {CLUSTER_WEB_PASSWORD: 'fixture-operator-password'}},
    console: {warn() {}, log() {}, error() {}},
  });
  vm.runInContext(source, context, {filename: 'cluster-api.js'});
  return {
    data: (store, key) => clone(getData(store).get(key)), writes,
    post: async (action, body = {}, authenticated = true) => {
      const response = await exported.handler({
        httpMethod: 'POST', headers: {authorization: authenticated ? 'Bearer fixture-operator-password' : ''},
        queryStringParameters: {action}, body: JSON.stringify(body),
      });
      return {status: response.statusCode, body: JSON.parse(response.body)};
    },
  };
}

const queued = (overrides = {}) => ({id: 'return-253', type: TYPE, target: 'phone253', payload: {}, status: 'queued', created_at: NOW - 5000, ...overrides});
const report = (overrides = {}) => ({kind: 'phone-controller-return', unit: 'phone253', state: 'termux-foreground', foreground_app_verified: true, visible_screen_verified: false, controller_state: 'connected', error: null, ...overrides});
const completion = (overrides = {}) => ({id: 'return-253', type: TYPE, target: 'phone253', status: 'completed', output: JSON.stringify(report()), ...overrides});
const queueReturn = (h, target = 'phone253', extra = {}) => h.post('queue-command', {type: TYPE, target, ...extra});

test('each canonical phone accepts one fixed return request without legacy dual-write', async () => {
  for (const target of PHONES) {
    const h = harness(); const response = await queueReturn(h, target);
    assert.equal(response.status, 200, target);
    const commands = h.data('cp-commands', 'queue');
    assert.equal(commands.length, 1); assert.equal(commands[0].type, TYPE); assert.equal(commands[0].target, target);
    assert.deepEqual(commands[0].payload, {}); assert.equal(commands[0].id, response.body.command_id);
    assert.equal(h.data('cluster-control', 'queue'), undefined);
  }
});

test('empty payload is accepted and all other explicit payload forms are rejected', async () => {
  assert.equal((await queueReturn(harness(), 'phone253', {payload: {}})).status, 200);
  for (const payload of [null, [], '', 'return-termux', false, 0, {cmd: 'input keyevent 4'}, {endpoint: '192.168.1.253:39899'}, {action: 'return-termux'}]) {
    const h = harness(); assert.equal((await queueReturn(h, 'phone253', {payload})).status, 400);
    assert.deepEqual(h.writes, []);
  }
});

test('groups, computers, case variants and injected target strings never queue phone return', async () => {
  for (const target of ['all', 'phones', 'pcs', 'Alina', 'Nexus', 'SteamDeck', 'viki', 'RenderRig', 'Phone253', 'phone252', 'phone253;input keyevent 4', '192.168.1.253:39899', '__proto__']) {
    const h = harness(); assert.equal((await queueReturn(h, target)).status, 400, target); assert.deepEqual(h.writes, []);
  }
});

test('registered device aliases cannot bypass the canonical phone target restriction', async () => {
  const h = harness({devices: [{id: 'registered-253', hostname: 'phone253'}]});
  assert.equal((await queueReturn(h, 'registered-253')).status, 400); assert.deepEqual(h.writes, []);
});

test('missing, invalid, stale and future heartbeat timestamps reject before enqueue', async () => {
  for (const bridge of [null, {}, {bridge_version: '2.5.0'}, {bridge_version: '2.5.0', last_seen_at: 'invalid'}, {bridge_version: '2.5.0', last_seen_at: new Date(NOW - 60000).toISOString()}, {bridge_version: '2.5.0', last_seen_at: new Date(NOW - 120000).toISOString()}, {bridge_version: '2.5.0', last_seen_at: new Date(NOW + 1).toISOString()}]) {
    const h = harness({bridge}); assert.equal((await queueReturn(h)).status, 409); assert.deepEqual(h.writes, []);
  }
});

test('heartbeat ages zero and 59999 milliseconds are accepted', async () => {
  for (const age of [0, 59999]) {
    const h = harness({bridge: {bridge_version: '2.5.0', last_seen_at: new Date(NOW - age).toISOString()}});
    assert.equal((await queueReturn(h)).status, 200);
  }
});

test('bridge version must be a complete semantic numeric version at least 2.5.0', async () => {
  for (const version of ['2.4.99', '1.99.99', '2.5', '2.5.0.1', '2.5.0-beta', '2.5.-1', '2.05.0', '2.5.NaN', 'Infinity.5.0', '9007199254740992.0.0', ' 2.5.0', null]) {
    const h = harness({bridge: {bridge_version: version, last_seen_at: new Date(NOW).toISOString()}});
    assert.equal((await queueReturn(h)).status, 409, String(version)); assert.deepEqual(h.writes, []);
  }
  for (const version of ['2.5.0', '2.5.1', '2.10.0', '3.0.0']) {
    assert.equal((await queueReturn(harness({bridge: {bridge_version: version, last_seen_at: new Date(NOW).toISOString()}}))).status, 200, version);
  }
});

test('same-phone duplicate return is rejected while another phone can queue', async () => {
  const h = harness({queue: [queued()]});
  assert.equal((await queueReturn(h)).status, 409); assert.deepEqual(h.writes, []);
  assert.equal((await queueReturn(h, 'phone191')).status, 200);
  assert.deepEqual(h.data('cp-commands', 'queue').map(c => c.target), ['phone253', 'phone191']);
});

test('a same-phone command of a different type does not trigger return deduplication', async () => {
  const h = harness({queue: [queued({type: 'mining-status'})]});
  assert.equal((await queueReturn(h)).status, 200);
});

test('fixed return requests retain existing operator authentication', async () => {
  const h = harness(); assert.equal((await h.post('queue-command', {type: TYPE, target: 'phone253'}, false)).status, 401);
  assert.deepEqual(h.writes, []);
});

test('successful return completion removes only its matching queue record and stores verified foreground contract', async () => {
  const other = queued({id: 'other', target: 'phone191'}), h = harness({queue: [queued(), other]});
  assert.equal((await h.post('bridge-complete', completion())).status, 200);
  assert.deepEqual(h.data('cp-commands', 'queue'), [other]);
  const entry = h.data('cp-commands', 'history')[0]; assert.equal(entry.status, 'completed');
  assert.equal(entry.target, 'phone253'); assert.equal(entry.type, TYPE); assert.deepEqual(JSON.parse(entry.output), report());
  assert.equal(entry.result_summary, 'Termux foreground verified');
});

test('failed return completion remains failed and preserves the separate controller state', async () => {
  const failed = report({state: 'failed', foreground_app_verified: false, controller_state: 'unauthorized', error: 'Phone rejected the existing controller'});
  const h = harness({queue: [queued()]});
  assert.equal((await h.post('bridge-complete', completion({status: 'failed', output: JSON.stringify(failed)}))).status, 200);
  const entry = h.data('cp-commands', 'history')[0]; assert.equal(entry.status, 'failed');
  assert.deepEqual(JSON.parse(entry.output), failed); assert.deepEqual(h.data('cp-commands', 'queue'), []);
});

test('missing command, mismatched ID, target and type cannot complete a return', async () => {
  for (const overrides of [{id: 'unknown'}, {target: 'phone191'}, {type: 'browse'}, {type: 'phone-return-termux;input keyevent 4'}]) {
    const h = harness({queue: [queued()]}); const response = await h.post('bridge-complete', completion(overrides));
    assert.ok([400, 409].includes(response.status)); assert.deepEqual(h.writes, []); assert.deepEqual(h.data('cp-commands', 'queue'), [queued()]);
  }
  const h = harness(); assert.equal((await h.post('bridge-complete', completion())).status, 409); assert.deepEqual(h.writes, []);
});

test('return type cannot consume an existing different-type command', async () => {
  const h = harness({queue: [queued({type: 'browse'})]});
  assert.equal((await h.post('bridge-complete', completion())).status, 400); assert.deepEqual(h.writes, []);
});

test('duplicate completed return is rejected even when disguised as an older command type', async () => {
  const h = harness({queue: [queued()]}); assert.equal((await h.post('bridge-complete', completion())).status, 200);
  const count = h.writes.length;
  for (const type of [TYPE, 'browse']) assert.equal((await h.post('bridge-complete', completion({type}))).status, 409);
  assert.equal(h.writes.length, count); assert.equal(h.data('cp-commands', 'history').length, 1);
});

test('completion output must be bounded JSON matching the phone and the controller-return contract', async () => {
  for (const output of [undefined, {}, '', 'not json', 'null', '[]', '1', 'x'.repeat(4097), JSON.stringify(report({kind: 'phone-termux-return'})), JSON.stringify(report({unit: 'phone191'})), JSON.stringify(report({visible_screen_verified: true})), JSON.stringify(report({foreground_app_verified: 'true'})), JSON.stringify(report({state: 'return-requested'})), JSON.stringify(report({controller_state: 'connected;input keyevent 4'})), JSON.stringify(report({error: {message: 'nested'}}))]) {
    const h = harness({queue: [queued()]}); assert.equal((await h.post('bridge-complete', completion({output}))).status, 400, String(output)); assert.deepEqual(h.writes, []);
  }
});

test('completion status and foreground evidence must agree and physical visibility cannot be asserted', async () => {
  for (const overrides of [
    {status: undefined}, {status: 'running'}, {status: 'failed'},
    {output: JSON.stringify(report({foreground_app_verified: false}))},
    {output: JSON.stringify(report({controller_state: 'disconnected'}))},
    {output: JSON.stringify(report({error: 'Reported success with an error'}))},
    {output: JSON.stringify(report({state: 'failed', foreground_app_verified: false, controller_state: 'failed', error: 'No foreground match'}))},
    {status: 'failed', output: JSON.stringify(report({state: 'failed', foreground_app_verified: true, controller_state: 'failed', error: 'Contradictory evidence'}))},
  ]) {
    const h = harness({queue: [queued()]}); assert.equal((await h.post('bridge-complete', completion(overrides))).status, 400); assert.deepEqual(h.writes, []);
  }
});

test('completion sanitizes report fields and does not store caller-supplied commands or summary', async () => {
  const unsafe = report({command: 'arbitrary', endpoint: 'private', debug: {contents: 'private'}});
  const h = harness({queue: [queued()]});
  assert.equal((await h.post('bridge-complete', completion({output: JSON.stringify(unsafe), result_summary: 'Unverified caller summary'}))).status, 200);
  const entry = h.data('cp-commands', 'history')[0]; assert.deepEqual(JSON.parse(entry.output), report());
  assert.equal(entry.result_summary, 'Termux foreground verified');
});

test('failure error text is bounded and control characters are removed', async () => {
  const failed = report({state: 'failed', foreground_app_verified: false, controller_state: 'failed', error: 'Denied\npermission\u0000' + 'x'.repeat(600)});
  const h = harness({queue: [queued()]});
  assert.equal((await h.post('bridge-complete', completion({status: 'failed', output: JSON.stringify(failed)}))).status, 200);
  const error = JSON.parse(h.data('cp-commands', 'history')[0].output).error;
  assert.equal(error.length, 500); assert.equal(/[\u0000-\u001f\u007f]/.test(error), false);
});

test('return enqueue storage failure is reported without a legacy command', async () => {
  const h = harness({failWrite: 'cp-commands:queue'}); assert.equal((await queueReturn(h)).status, 503);
  assert.deepEqual(h.data('cp-commands', 'queue'), []); assert.equal(h.data('cluster-control', 'queue'), undefined);
});

test('return completion storage failure is reported and does not claim completed success', async () => {
  const h = harness({queue: [queued()], failWrite: 'cp-commands:history'});
  assert.equal((await h.post('bridge-complete', completion())).status, 503);
  assert.deepEqual(h.data('cp-commands', 'queue'), [queued()]); assert.deepEqual(h.data('cp-commands', 'history'), []);
});

test('existing command enqueue and completion behavior is preserved', async () => {
  const h = harness();
  const response = await h.post('queue-command', {type: 'browse', target: 'phone253', payload: {url: 'https://curtbrag.com/'}});
  assert.equal(response.status, 200); assert.equal(h.data('cluster-control', 'queue').length, 1);
  assert.equal((await h.post('bridge-complete', {id: response.body.command_id, type: 'browse', target: 'phone253', status: 'failed', output: 'Existing plain output', result_summary: 'Existing summary'})).status, 200);
  const entry = h.data('cp-commands', 'history')[0]; assert.equal(entry.status, 'completed');
  assert.equal(entry.output, 'Existing plain output'); assert.equal(entry.result_summary, 'Existing summary');
});
