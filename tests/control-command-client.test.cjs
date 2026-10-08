const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function client(kind, replies) {
  const calls = [];
  let generated = 0;
  const crypto = { randomUUID: () => `fixture-request-${++generated}` };
  const common = { crypto, Error, TypeError };
  let source, context;
  if (kind === 'workspace') {
    const full = fs.readFileSync(path.join(root, 'public/scripts/cluster-swarm-live-v8.js'), 'utf8');
    source = full.slice(full.indexOf('  const controlApi = async'), full.indexOf('  function canonicalize'));
    context = vm.createContext({ ...common, CONTROL_API: '/control', request: async (base, action, method, body) => {
      calls.push({ base, action, method, body: JSON.parse(JSON.stringify(body)) });
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return next;
    } });
    vm.runInContext(source + '\nthis.call = controlApi;', context);
  } else {
    const full = fs.readFileSync(path.join(root, 'src/pages/cluster/dashboard.astro'), 'utf8');
    source = full.slice(full.indexOf('async function callApi('), full.indexOf('async function login('));
    context = vm.createContext({ ...common, API: '/control', password: 'synthetic-fixture',
      sessionStorage: { removeItem() {} }, window: { location: { replace() {} } },
      fetchDashboardApi: async (url, opts) => {
        calls.push({ url, method: opts.method, body: JSON.parse(opts.body || 'null') });
        const next = replies.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    });
    vm.runInContext(source + '\nthis.call = callApi;', context);
  }
  return { calls, call: context.call };
}

for (const kind of ['workspace', 'administration']) {
  const success = kind === 'workspace' ? { ok: true, command_id: 'same-command' } : { ok: true, status: 200, data: { ok: true, command_id: 'same-command' } };
  test(`${kind}: lost response retries once with the same operation ID and settings`, async () => {
    const h = client(kind, [new Error('Connection timed out. Please retry.'), success]);
    const result = await h.call('queue-command', 'POST', { target: 'phone173', type: 'run-diagnostic' });
    assert.equal(result.command_id, 'same-command');
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[0].body, h.calls[1].body);
    assert.equal(h.calls[0].body.request_id, 'fixture-request-1');
  });
  test(`${kind}: validation errors do not resubmit commands`, async () => {
    const denied = kind === 'workspace' ? new Error('Command queue is full') : { ok: false, status: 409, data: { error: 'Command queue is full' } };
    const h = client(kind, [denied]);
    await assert.rejects(h.call('queue-command', 'POST', { target: 'phone173', type: 'run-diagnostic' }), /queue is full/);
    assert.equal(h.calls.length, 1);
  });
  test(`${kind}: separate deliberate actions receive different request IDs`, async () => {
    const h = client(kind, [success, success]);
    await h.call('queue-command', 'POST', { target: 'phone173', type: 'run-diagnostic' });
    await h.call('queue-command', 'POST', { target: 'phone173', type: 'run-diagnostic' });
    assert.notEqual(h.calls[0].body.request_id, h.calls[1].body.request_id);
  });
}
