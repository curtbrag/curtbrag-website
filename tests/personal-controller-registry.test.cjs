const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./control-command-api.test.cjs');
const { createPersonalControllerRegistry, openPersonalControllerRegistry } = require('../netlify/functions/lib/personal-controllers.cjs');

const STORE = 'cp-personal-controllers';
const ID = 'curtis-s26-ultra';
const input = overrides => ({ controller_id: ID, name: "Curtis's S26 Ultra", model: 'SM-S948U', private_ip: '192.168.1.237',
  adb_connect_port: 38033, adb_guid: 'adb-R3GL801BCMK-IEkPhu', ...overrides });
const register = (h, value = input(), extra) => h.cp('register-personal-controller', value, extra);
const list = (h, extra) => h.cpGet('personal-controllers', extra);
const stored = overrides => ({ ...input(), role: 'personal-controller', worker_enabled: false, mining_enabled: false,
  registered_at: Date.parse('2026-10-08T21:00:00Z'), ...overrides });

test('owner registration creates fixed personal metadata exclusively in the dedicated inventory', async () => {
  const h = fixture(), response = await register(h);
  assert.equal(response.status, 200); assert.equal(response.body.created, true);
  const record = response.body.controller;
  assert.equal(record.role, 'personal-controller');
  assert.equal(record.worker_enabled, false); assert.equal(record.mining_enabled, false);
  assert.ok(Number.isSafeInteger(record.registered_at) && record.registered_at > 0);
  assert.equal(record.name, "Curtis's S26 Ultra"); assert.equal(record.private_ip, '192.168.1.237');
  for (const field of ['agent_token', 'desired', 'observed', 'last_seen_at', 'online', 'heartbeat', 'status']) assert.equal(Object.hasOwn(record, field), false);
  assert.ok(h.writes.length === 1 && h.writes.every(write => write.name === STORE && write.options.onlyIfNew === true));
  assert.deepEqual(h.inspect(STORE, ID), record);
  assert.deepEqual((await list(h)).body.controllers, [record]);
  assert.equal(h.calls.some(call => ['cp-devices', 'cp-desired', 'cp-groups', 'cp-commands', 'cp-observed'].includes(call.name)), false);
});

test('GET and POST require the existing owner auth before any inventory access', async () => {
  const h = fixture();
  for (const token of ['', 'Bearer wrong-fixture', 'Bearer fixture-agent']) {
    assert.equal((await register(h, input(), { headers: { authorization: token } })).status, 401);
    assert.equal((await list(h, { headers: { authorization: token } })).status, 401);
  }
  assert.equal(h.calls.some(call => call.name.startsWith(STORE)), false);
  assert.equal(h.writes.length, 0);
});

test('exact retries preserve owner registration time and perform no second write', async () => {
  const h = fixture(), first = await register(h), second = await register(h);
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(second.body.created, false);
  assert.deepEqual(second.body.controller, first.body.controller);
  assert.equal(h.writes.filter(write => write.committed).length, 1);
});

test('conflicting re-registration rejects every changed metadata field without overwriting', async () => {
  const h = fixture(), first = await register(h);
  for (const value of [input({ name: 'Another phone' }), input({ model: 'SM-S948B' }), input({ private_ip: '192.168.1.238' }),
    input({ adb_connect_port: 38034 }), input({ adb_guid: 'other-guid' })]) assert.equal((await register(h, value)).status, 409);
  assert.deepEqual(h.inspect(STORE, ID), first.body.controller);
  assert.equal(h.writes.filter(write => write.committed).length, 1);
});

test('concurrent identical registration acknowledges one creation and one exact retry', async () => {
  const h = fixture(); h.barrier('read', STORE, ID);
  const results = await Promise.all([register(h), register(h)]);
  assert.ok(results.every(response => response.status === 200));
  assert.deepEqual(results.map(response => response.body.created).sort(), [false, true]);
  assert.deepEqual(results[0].body.controller, results[1].body.controller);
  assert.equal(h.writes.filter(write => write.committed).length, 1);
  assert.ok(h.writes.some(write => write.status === 412));
});

test('concurrent conflicting registration never overwrites the winning metadata', async () => {
  const h = fixture(); h.barrier('read', STORE, ID);
  const results = await Promise.all([register(h), register(h, input({ name: 'Other owner label' }))]);
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
  const winner = results.find(response => response.status === 200);
  assert.deepEqual(h.inspect(STORE, ID), winner.body.controller);
  assert.equal(h.writes.filter(write => write.committed).length, 1);
});

test('privilege, credential, command, URL and unknown fields are rejected rather than stored', async () => {
  const h = fixture();
  for (const field of ['role', 'worker_enabled', 'mining_enabled', 'agent_token', 'password', 'desired', 'command', 'url', 'online', 'last_seen_at']) {
    const response = await register(h, input({ [field]: field === 'worker_enabled' ? false : 'fixture-injection' }));
    assert.equal(response.status, 400, field);
  }
  assert.equal((await register(h, { ...input(), ['__proto__']: { worker_enabled: true } })).status, 400);
  assert.equal(h.writes.length, 0);
});

test('strict bounded fields reject traversal, HTML, controls, public IPs and untyped ports', async () => {
  const h = fixture();
  const bad = [input({ controller_id: '../all' }), input({ controller_id: 'ID' }), input({ controller_id: 'x'.repeat(65) }),
    input({ name: '<script>' }), input({ name: ' padded ' }), input({ name: 'line\nbreak' }), input({ name: 'x'.repeat(81) }),
    input({ model: 'x'.repeat(65) }), input({ model: 'model\u0000' }), input({ private_ip: 'https://192.168.1.237/' }),
    input({ private_ip: '8.8.8.8' }), input({ private_ip: '127.0.0.1' }), input({ private_ip: '192.168.01.237' }),
    input({ private_ip: '172.32.1.1' }), input({ private_ip: '192.168.1.256' }), input({ adb_guid: 'x'.repeat(161) }),
    input({ adb_guid: 'host;cmd' }), input({ adb_guid: '' }), input({ adb_connect_port: '38033' }),
    input({ adb_connect_port: null }), input({ adb_connect_port: false }), input({ adb_connect_port: 0 }),
    input({ adb_connect_port: 65536 }), input({ adb_connect_port: 2.5 })];
  for (const value of bad) assert.equal((await register(h, value)).status, 400, JSON.stringify(value));
  assert.equal(h.writes.length, 0);
});

test('registration rejects non-object JSON bodies and malformed JSON without inventory access', async () => {
  const h = fixture();
  for (const value of [null, [], 'details', 1, true, false]) {
    const response = await register(h, value);
    assert.equal(response.status, 400); assert.equal(response.body.code, 'INVALID_CONTROLLER');
  }
  assert.equal((await register(h, input(), { event: { body: '{' } })).status, 400);
  assert.equal(h.calls.some(call => call.name.startsWith(STORE)), false);
  assert.equal(h.writes.length, 0);
});

test('private network ranges and absent optional GUID are valid without online claims', async () => {
  const h = fixture();
  for (const [index, ip] of ['10.1.2.3', '172.16.1.1', '172.31.255.254', '192.168.1.237'].entries()) {
    const response = await register(h, input({ controller_id: 'controller-' + index, private_ip: ip, adb_guid: undefined }));
    assert.equal(response.status, 200); assert.equal(response.body.controller.adb_guid, null);
  }
  assert.equal((await list(h)).body.controllers.length, 4);
});

test('read, HTTP write and thrown write failures cannot be acknowledged as registration', async () => {
  for (const kind of ['read', 'http', 'throw']) {
    const h = fixture();
    h.fault(kind === 'read' ? 'read' : 'write', STORE, ID, kind === 'read' ? 'throw' : kind);
    const response = await register(h);
    assert.equal(response.status, 503, kind);
    assert.equal(h.inspect(STORE, ID), undefined);
    assert.equal(h.writes.some(write => write.committed), false);
  }
});

test('lost response after creation reconciles the exact stored metadata and timestamp', async () => {
  const h = fixture(); h.fault('write', STORE, ID, 'after');
  const response = await register(h);
  assert.equal(response.status, 200); assert.equal(response.body.created, false);
  assert.deepEqual(response.body.controller, h.inspect(STORE, ID));
  assert.equal((await register(h)).body.created, false);
  assert.equal(h.writes.filter(write => write.committed).length, 1);
});

test('GET projects only non-secret fixed metadata, and malformed persisted roles fail closed', async () => {
  const h = fixture({ seed: [{ store: STORE, key: ID, value: stored({ agent_token: 'fixture-secret', password: 'fixture-secret', online: true }) }] });
  const response = await list(h);
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(response.body).includes('fixture-secret'), false);
  assert.equal(Object.hasOwn(response.body.controllers[0], 'online'), false);
  for (const changes of [{ role: 'worker' }, { worker_enabled: true }, { mining_enabled: true }, { registered_at: null }, { controller_id: 'different' }]) {
    h.seed(STORE, ID, stored(changes));
    assert.equal((await list(h)).status, 503);
    assert.equal((await register(h)).status, 503);
  }
});

test('preview registrations use only the trusted isolated namespace, never production inventory', async () => {
  for (const context of ['deploy-preview', 'branch-deploy']) {
    const original = stored(), h = fixture({ env: { CONTEXT: context, DEPLOY_ID: 'registry-preview' }, seed: [{ store: STORE, key: ID, value: original }] });
    const response = await register(h);
    assert.equal(response.status, 200);
    assert.ok(h.writes.every(write => write.name === STORE + '-isolated-' + context + '-registry-preview'));
    assert.deepEqual(h.inspect(STORE, ID), original);
    assert.equal((await list(h)).body.controllers.length, 1);
  }
});

test('unknown deployment or missing preview ID fails before any inventory store is opened', async () => {
  for (const env of [{ CONTEXT: 'unknown' }, { CONTEXT: 'deploy-preview', DEPLOY_ID: '' }, { CONTEXT: 'branch-deploy', DEPLOY_ID: '../prod' }]) {
    const h = fixture({ env });
    assert.equal((await register(h)).status, 503);
    assert.equal((await list(h)).status, 503);
    assert.equal(h.calls.some(call => call.name.startsWith(STORE)), false);
    assert.equal(h.writes.length, 0);
  }
});

test('missing read or write version receipts never produce an accepted registration', async () => {
  for (const receipt of [{ modified: true }, null, {}, { modified: 'true', etag: 'v1' }]) {
    const registry = createPersonalControllerRegistry({ store: { list: async () => ({ blobs: [] }), getWithMetadata: async () => null, set: async () => receipt } });
    await assert.rejects(registry.register(input()), error => error.statusCode === 503);
  }
  for (const receipt of [{ data: stored() }, { data: null, etag: 'v1' }, {}]) {
    const registry = createPersonalControllerRegistry({ store: { list: async () => ({ blobs: [{ key: ID }] }), getWithMetadata: async () => receipt, set: async () => assert.fail('Must not write') } });
    await assert.rejects(registry.register(input()), error => error.statusCode === 503);
    await assert.rejects(registry.list(), error => error.statusCode === 503);
  }
});

test('full provider context is forwarded without substituting its edge token onto API transport', () => {
  const calls = [], providerContext = { siteID: 'fixture-site', token: 'fixture-runtime-token', edgeURL: 'https://fixture-edge.invalid', uncachedEdgeURL: 'https://fixture-strong.invalid' };
  const store = { list() {}, getWithMetadata() {}, set() {} };
  openPersonalControllerRegistry({ env: { CONTEXT: 'production' }, providerContext, getStore(options) { calls.push(options); return store; }, fetch: async () => { throw Error('No network'); } });
  assert.equal(calls[0].name, STORE); assert.equal(calls[0].consistency, 'strong');
  for (const key of Object.keys(providerContext)) assert.equal(calls[0][key], providerContext[key]);
  assert.throws(() => openPersonalControllerRegistry({ env: { CONTEXT: 'production' }, event: { blobs: 'fixture-legacy' }, getStore() { assert.fail('Incomplete context must fail'); } }), error => error.statusCode === 503);
});

test('listing does not invalidate a legitimate inventory beyond an unsupported count threshold', async () => {
  const seed = Array.from({ length: 101 }, (_, index) => ({ store: STORE, key: 'personal-' + index, value: stored({ controller_id: 'personal-' + index }) }));
  const response = await list(fixture({ seed }));
  assert.equal(response.status, 200); assert.equal(response.body.controllers.length, 101);
});
