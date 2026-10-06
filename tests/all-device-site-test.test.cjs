const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { TextEncoder } = require('node:util');

const source = fs.readFileSync(path.join(__dirname, '../public/scripts/cluster-swarm-live-v8.js'), 'utf8');
const feature = source.slice(source.indexOf('  let siteTest='), source.indexOf('  function ensurePhoneRecovery() {', source.indexOf('  let siteTest=')));
const storageKey = 'curt-site-test-v1';

function harness(options = {}) {
  const storage = options.storage || new Map();
  const elements = {
    'site-test-run': { disabled: false },
    'site-test-owned': { checked: true },
    'site-test-url': { value: 'https://example.com/' },
    'site-test-state': { textContent: '' },
    'site-test-export': { disabled: true },
    'site-test-close': { disabled: true },
    'site-test-report': { textContent: '' },
  };
  const calls = [];
  let loads = 0;
  const context = vm.createContext({
    URL,
    TextEncoder,
    Blob,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    setTimeout,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    document: { getElementById: id => elements[id] || null },
    current: { results: [] },
    canonicalize: value => value,
    versionAtLeast: (actual, required) => {
      const parts = value => String(value || '0.0.0').split('.').map(n => Number(n) || 0);
      const a = parts(actual), r = parts(required);
      for (let i = 0; i < 3; i++) {
        if ((a[i] || 0) > (r[i] || 0)) return true;
        if ((a[i] || 0) < (r[i] || 0)) return false;
      }
      return true;
    },
    swarmApi: async (...args) => {
      calls.push(args);
      if (options.api) return options.api(...args);
      if (args[0] === 'queue-status') return { nodes: options.nodes || [{ id: 'phone191', online: true, busy: false }], jobs: [], results: [] };
      return { ok: true };
    },
    load: async () => { loads++; },
  });
  vm.runInContext(feature + '\n;globalThis.testApi = { validateSiteTestUrl, dispatchSiteTest, closeSiteTest, renderSiteTest, siteTestCommand, get: () => siteTest, set: value => { siteTest = value; }, busy: () => siteTestBusy };', context);
  return { api: context.testApi, elements, calls, storage, loads: () => loads };
}

function batch(tasks = [{ unit: 'phone191', job_id: 'job-191', state: 'queued' }]) {
  return { id: 'site-test-fixture', url: 'https://example.com/', tasks, skipped: [], created_at: '2026-10-06T00:00:00Z' };
}

function result(overrides = {}) {
  return {
    job_id: 'job-191', device_id: 'phone191', exit_code: 0,
    stdout: JSON.stringify({ kind: 'website-load-test', url: 'https://example.com/', ok: true, total_ms: 12.6, status: 200, title: 'Example' }),
    ...overrides,
  };
}

test('URL checks accept public HTTPS and reject credentials, queries, fragments, private IPs and local hosts', () => {
  const h = harness();
  assert.equal(h.api.validateSiteTestUrl('https://example.com/page'), 'https://example.com/page');
  for (const value of [
    'example.com', 'http://example.com/', 'file:///tmp/page',
    'https://user:password@example.com/', 'https://example.com/?token=secret',
    'https://example.com/#section', 'https://example.com:8443/',
    'https://127.0.0.1/', 'https://192.168.1.191/', 'https://10.0.0.1/',
    'https://172.16.0.1/', 'https://169.254.169.254/', 'https://[::1]/',
    'https://[fd00::1]/', 'https://localhost/', 'https://phone191/',
    'https://worker.local/', 'https://example.com/' + 'a'.repeat(2000),
  ]) assert.throws(() => h.api.validateSiteTestUrl(value), undefined, value);
});

test('ownership confirmation blocks any fleet request', async () => {
  const h = harness();
  h.elements['site-test-owned'].checked = false;
  await h.api.dispatchSiteTest();
  assert.equal(h.calls.length, 0);
  assert.match(h.elements['site-test-state'].textContent, /own this site or have permission/);
  assert.equal(h.elements['site-test-run'].disabled, false);
});

test('only online idle units receive jobs, including the native Windows website-test workload', async () => {
  const h = harness({ nodes: [
    { id: 'phone191', online: true, busy: false },
    { id: 'Nexus', online: true, busy: false },
    { id: 'RenderRig', online: true, busy: false, agent_version: '3.7.1' },
    { id: 'phone253', online: true, busy: true },
    { id: 'viki', online: false, busy: false },
  ] });
  await h.api.dispatchSiteTest();
  const enqueues = h.calls.filter(call => call[0] === 'enqueue');
  assert.deepEqual(enqueues.map(call => Array.from(call[2].target_device_ids)), [['phone191'], ['Nexus'], ['RenderRig']]);
  assert.equal(new Set(enqueues.map(call => call[2].job.id)).size, 3);
  assert.ok(enqueues.every(call => call[1] === 'POST'));
  assert.equal(enqueues[0][2].job.type, 'shell');
  assert.equal(enqueues[1][2].job.type, 'shell');
  assert.match(enqueues[0][2].job.cmd, /cluster-url-test\.py/);
  assert.equal(enqueues[2][2].job.type, 'website-test');
  assert.deepEqual(JSON.parse(enqueues[2][2].job.cmd), { url: 'https://example.com/' });
  assert.equal(enqueues[2][2].job.command, enqueues[2][2].job.cmd);
  assert.deepEqual(JSON.parse(JSON.stringify(h.api.get().skipped)), [{ unit: 'phone253', reason: 'busy' }, { unit: 'viki', reason: 'offline' }]);
  assert.equal(h.loads(), 1);
});

test('RenderRig missing or below 3.7.1 is skipped with an agent update explanation', async () => {
  for (const agent_version of [undefined, '', '3.7.0', '3.6.99']) {
    const h = harness({ nodes: [
      { id: 'phone191', online: true, busy: false },
      { id: 'RenderRig', online: true, busy: false, agent_version },
    ] });
    await h.api.dispatchSiteTest();
    const enqueues = h.calls.filter(call => call[0] === 'enqueue');
    assert.equal(enqueues.length, 1, String(agent_version));
    assert.deepEqual(Array.from(enqueues[0][2].target_device_ids), ['phone191']);
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.get().skipped)), [{ unit: 'RenderRig', reason: 'agent update required' }]);
  }
});

test('a newer Windows agent is eligible for the native workload', async () => {
  const h = harness({ nodes: [{ id: 'RenderRig', online: true, busy: false, agent_version: '3.10.0' }] });
  await h.api.dispatchSiteTest();
  const enqueues = h.calls.filter(call => call[0] === 'enqueue');
  assert.equal(enqueues.length, 1);
  assert.equal(enqueues[0][2].job.type, 'website-test');
  assert.deepEqual(JSON.parse(enqueues[0][2].job.cmd), { url: 'https://example.com/' });
});

test('an entirely busy or offline fleet does not enqueue a job', async () => {
  const h = harness({ nodes: [{ id: 'phone191', online: true, busy: true }, { id: 'viki', online: false, busy: false }] });
  await h.api.dispatchSiteTest();
  assert.equal(h.calls.filter(call => call[0] === 'enqueue').length, 0);
  assert.match(h.elements['site-test-state'].textContent, /No idle online devices/);
});

test('concurrent clicks cannot duplicate submissions while fleet status is pending', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const h = harness({ api: async action => action === 'queue-status' ? blocked : { ok: true } });
  const first = h.api.dispatchSiteTest();
  assert.equal(h.api.busy(), true);
  assert.equal(h.elements['site-test-run'].disabled, true);
  assert.equal(h.elements['site-test-state'].textContent, 'Checking available devices…');
  await h.api.dispatchSiteTest();
  assert.equal(h.calls.length, 1);
  release({ nodes: [{ id: 'phone191', online: true, busy: false }] });
  await first;
  assert.equal(h.calls.filter(call => call[0] === 'enqueue').length, 1);
  assert.equal(h.api.busy(), false);
});

test('a slow first submission displays the new report instead of an old permission error', async () => {
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const submitting = new Promise(resolve => { started = resolve; });
  const h = harness({ api: async action => {
    if (action === 'queue-status') return { nodes: [{ id: 'phone191', online: true, busy: false }] };
    started();
    return blocked;
  } });
  h.elements['site-test-state'].textContent = 'Confirm you own this site or have permission to test it.';
  const pending = h.api.dispatchSiteTest();
  await submitting;
  assert.match(h.elements['site-test-state'].textContent, /0\/1 results returned/);
  assert.match(h.elements['site-test-report'].textContent, /phone191 · submitting/);
  assert.equal(h.elements['site-test-run'].disabled, true);
  assert.equal(h.elements['site-test-close'].disabled, true);
  release({ ok: true });
  await pending;
  assert.match(h.elements['site-test-report'].textContent, /phone191 · queued/);
});

test('persisted pending tasks prevent a second batch after reload', async () => {
  for (const state of ['queued', 'submitting', 'unconfirmed']) {
    const storage = new Map([[storageKey, JSON.stringify(batch([{ unit: 'phone191', job_id: 'job-191', state }]))]]);
    const h = harness({ storage });
    await h.api.dispatchSiteTest();
    assert.equal(h.calls.length, 0, state);
    assert.match(h.elements['site-test-state'].textContent, /Previous checks are pending/);
  }
});

test('unconfirmed enqueue failure is saved and blocks an unsafe retry', async () => {
  const h = harness({ api: async action => {
    if (action === 'queue-status') return { nodes: [{ id: 'phone191', online: true, busy: false }] };
    throw new Error('Connection interrupted after submission');
  } });
  await h.api.dispatchSiteTest();
  assert.equal(h.api.get().tasks[0].state, 'unconfirmed');
  assert.equal(JSON.parse(h.storage.get(storageKey)).tasks[0].state, 'unconfirmed');
  await h.api.dispatchSiteTest();
  assert.equal(h.calls.filter(call => call[0] === 'enqueue').length, 1);
  assert.match(h.elements['site-test-state'].textContent, /Previous checks are pending/);
});

test('results must match job and device, then a valid matching result survives reload', () => {
  const h = harness();
  h.api.set(batch());
  h.api.renderSiteTest([result({ job_id: 'different-job' }), result({ device_id: 'phone253' })]);
  assert.equal(h.api.get().tasks[0].state, 'queued');
  h.api.renderSiteTest([result()]);
  assert.equal(h.api.get().tasks[0].state, 'passed');
  assert.match(h.elements['site-test-report'].textContent, /phone191 · passed · HTTP 200 · 13 ms/);
  assert.equal(h.elements['site-test-export'].disabled, false);
  const reloaded = harness({ storage: h.storage });
  assert.equal(reloaded.api.get().tasks[0].state, 'passed');
  assert.equal(reloaded.api.get().tasks[0].report.url, 'https://example.com/');
});

test('a matching worker result for a different URL cannot pass the test', () => {
  const h = harness();
  h.api.set(batch());
  h.api.renderSiteTest([result({ stdout: JSON.stringify({ kind: 'website-load-test', url: 'https://other.example/', total_ms: 1, ok: true }) })]);
  assert.equal(h.api.get().tasks[0].state, 'failed');
  assert.match(h.api.get().tasks[0].error, /invalid page-load result/);
});

test('failed loads and nonzero worker exits remain failed even with otherwise valid output', () => {
  for (const input of [
    result({ stdout: JSON.stringify({ kind: 'website-load-test', url: 'https://example.com/', total_ms: 150, status: 503, ok: false, error: 'HTTP 503' }) }),
    result({ exit_code: 1 }),
  ]) {
    const h = harness();
    h.api.set(batch());
    h.api.renderSiteTest([input]);
    assert.equal(h.api.get().tasks[0].state, 'failed');
    assert.match(h.elements['site-test-state'].textContent, /1\/1 results returned · 1 failed/);
  }
});

test('malformed, wrong-kind and invalid timing output cannot count as a pass', () => {
  for (const stdout of [
    'not json',
    JSON.stringify({ kind: 'different-check', url: 'https://example.com/', total_ms: 1, ok: true }),
    JSON.stringify({ kind: 'website-load-test', url: 'https://example.com/', total_ms: 'fast', ok: true }),
  ]) {
    const h = harness();
    h.api.set(batch());
    h.api.renderSiteTest([result({ stdout, stderr: 'Worker error details' })]);
    assert.equal(h.api.get().tasks[0].state, 'failed');
    assert.equal(h.api.get().tasks[0].error, 'Worker error details');
  }
});

test('closing refuses queued, running, assigned and unknown own queue jobs', async () => {
  for (const status of ['pending', 'queued', 'running', 'assigned', 'unrecognized', undefined]) {
    const h = harness({ api: async () => ({ nodes: [], jobs: [{ id: 'job-191', status }], results: [] }) });
    h.api.set(batch());
    await h.api.closeSiteTest();
    assert.equal(h.api.get().tasks[0].state, 'queued', String(status));
    assert.equal(h.api.get().closed_at, undefined);
    assert.match(h.elements['site-test-state'].textContent, /still appear queued or running/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.elements['site-test-close'].disabled, false);
  }
});

test('closing refuses matching active job references as strings or objects', async () => {
  for (const reference of ['job-191', { id: 'job-191' }, { job_id: 'job-191' }, { job: { id: 'job-191' } }]) {
    const h = harness({ api: async () => ({ nodes: [{ id: 'phone191', active_jobs: [reference] }], jobs: [], results: [] }) });
    h.api.set(batch());
    await h.api.closeSiteTest();
    assert.equal(h.api.get().tasks[0].state, 'queued');
    assert.equal(h.api.get().closed_at, undefined);
    assert.match(h.elements['site-test-state'].textContent, /still appear queued or running/);
  }
});

test('closing first collects fresh terminal results and preserves their passed or failed state', async () => {
  const failed = result({ job_id: 'job-253', device_id: 'phone253', exit_code: 1 });
  const h = harness({ api: async () => ({ nodes: [], jobs: [{ id: 'job-191', status: 'completed' }, { id: 'job-253', status: 'failed' }], results: [result(), failed] }) });
  const saved = batch([{ unit: 'phone191', job_id: 'job-191', state: 'queued' }, { unit: 'phone253', job_id: 'job-253', state: 'queued' }]);
  saved.created_at = new Date().toISOString();
  h.api.set(saved);
  await h.api.closeSiteTest();
  assert.deepEqual(Array.from(h.api.get().tasks, t => t.state), ['passed', 'failed']);
  assert.ok(h.api.get().closed_at);
  assert.equal(h.elements['site-test-export'].disabled, false);
  assert.match(h.elements['site-test-state'].textContent, /2\/2 results returned · 1 failed · 0 closed/);
});

test('closing requires at least two minutes for young absent queued or unconfirmed submissions', async () => {
  for (const state of ['queued', 'submitting', 'unconfirmed']) {
    const h = harness();
    const saved = batch([{ unit: 'phone191', job_id: 'job-191', state }]);
    saved.created_at = new Date().toISOString();
    h.api.set(saved);
    await h.api.closeSiteTest();
    assert.equal(h.api.get().tasks[0].state, state);
    assert.equal(h.api.get().closed_at, undefined);
    assert.match(h.elements['site-test-state'].textContent, /at least two minutes/);
  }
});

test('an old report absent from the fresh queue closes unresolved and never-sent tasks without replay', async () => {
  const h = harness();
  const saved = batch(['queued', 'submitting', 'unconfirmed', 'planned'].map((state, i) => ({ unit: 'phone' + i, job_id: 'job-' + i, state })));
  saved.created_at = new Date(Date.now() - 180000).toISOString();
  h.api.set(saved);
  await h.api.closeSiteTest();
  assert.ok(h.api.get().tasks.every(t => t.state === 'closed'));
  assert.ok(h.api.get().closed_at);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], 'queue-status');
  assert.equal(h.elements['site-test-export'].disabled, false);
  assert.equal(h.elements['site-test-close'].disabled, true);
  assert.match(h.elements['site-test-state'].textContent, /0\/4 results returned · 0 failed · 4 closed/);
  assert.match(h.elements['site-test-report'].textContent, /phone0 · closed/);
  const persisted = JSON.parse(h.storage.get(storageKey));
  assert.equal(persisted.tasks[0].state, 'closed');
  h.api.renderSiteTest([result({ job_id: 'job-0', device_id: 'phone0' })]);
  assert.equal(h.api.get().tasks[0].state, 'closed', 'late output must not reopen the reviewed report');
  await h.api.dispatchSiteTest();
  assert.equal(h.calls.filter(call => call[0] === 'enqueue').length, 1, 'a new explicit batch is permitted');
});

test('known cancelled and failed queue jobs do not prevent closing an old absent report', async () => {
  for (const status of ['completed', 'cancelled', 'canceled', 'failed']) {
    const h = harness({ api: async () => ({ nodes: [], jobs: [{ id: 'job-191', status }], results: [] }) });
    const saved = batch();
    saved.created_at = new Date(Date.now() - 180000).toISOString();
    h.api.set(saved);
    await h.api.closeSiteTest();
    assert.equal(h.api.get().tasks[0].state, 'closed', status);
    assert.ok(h.api.get().closed_at);
  }
});

test('a close fetch failure or incomplete response preserves the unresolved report', async () => {
  for (const api of [async () => { throw Error('Queue connection timed out'); }, async () => ({ nodes: [] })]) {
    const h = harness({ api });
    const saved = batch();
    saved.created_at = new Date(Date.now() - 180000).toISOString();
    h.api.set(saved);
    const before = JSON.stringify(h.api.get());
    await h.api.closeSiteTest();
    assert.equal(JSON.stringify(h.api.get()), before);
    assert.equal(h.elements['site-test-run'].disabled, false);
    assert.equal(h.elements['site-test-close'].disabled, false);
    assert.match(h.elements['site-test-state'].textContent, /timed out|incomplete/);
    assert.equal(h.calls.length, 1);
  }
});

test('close and submit controls stay disabled during the fresh queue check', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness({ api: async () => pending });
  h.api.set(batch());
  const closing = h.api.closeSiteTest();
  assert.equal(h.elements['site-test-run'].disabled, true);
  assert.equal(h.elements['site-test-close'].disabled, true);
  await h.api.closeSiteTest();
  await h.api.dispatchSiteTest();
  assert.equal(h.calls.length, 1);
  release({ nodes: [], jobs: [{ id: 'job-191', status: 'running' }], results: [] });
  await closing;
  assert.equal(h.elements['site-test-run'].disabled, false);
  assert.equal(h.elements['site-test-close'].disabled, false);
});
