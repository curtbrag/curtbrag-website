const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../netlify/functions/swarm-core/index.mjs'), 'utf8');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const pair = (job_id = 'browser-open-old-0', device_id = 'phone253') => ({ job_id, device_id });
const resultKey = (request, ts = 1700000000000) => `result--${ts}--${request.job_id}--${request.device_id}`;
const indexKey = request => `result-index--${request.job_id}--${request.device_id}`;
const receipt = (request = pair(), ts = 1700000000000) => ({
  ...request, type: 'shell', exit_code: 0, completed_at: ts, schema: 2,
  stdout: JSON.stringify({ kind: 'website-browser-open', url: 'https://curtbrag.com/', state: 'launch-requested', launch_requested: true, visible_screen_verified: false }),
  stderr: '', cmd: 'original command must not be returned', unrelated_private_field: 'must not be returned'
});

function harness({ history = 0, fault = null, migrated = true } = {}) {
  const values = new Map(migrated ? [['migration--v2', { done: true }]] : []);
  const reads = [], writes = [], deletes = [], lists = [], pages = [], warnings = [];
  for (let i = 0; i < history; i++) {
    const request = pair(`old-${i}`);
    values.set(resultKey(request, 1700000000000 + i), receipt(request, 1700000000000 + i));
  }
  const storage = {
    get: async key => { reads.push(key); if (fault === `get:${key}`) throw Error('Fixture storage unavailable'); return clone(values.get(key) ?? null); },
    setJSON: async (key, value) => { if (fault === `write:${key}`) throw Error('Fixture write unavailable'); writes.push(key); values.set(key, clone(value)); },
    delete: async key => { deletes.push(key); values.delete(key); },
    list: options => {
      lists.push(clone(options));
      const matching = [...values.keys()].filter(key => key.startsWith(options.prefix)).sort();
      if (options.paginate) return (async function* () {
        for (let offset = 0; offset < matching.length; offset += 1000) {
          pages.push(offset);
          if (fault === `page:${offset}`) throw Error('Fixture listing unavailable');
          yield { blobs: matching.slice(offset, offset + 1000).map(key => ({ key })) };
        }
      })();
      if (fault === `list:${options.prefix}`) return Promise.reject(Error('Fixture listing unavailable'));
      return Promise.resolve({ blobs: matching.map(key => ({ key })) });
    }
  };
  const context = vm.createContext({ getStore: () => storage, crypto, Response, URL, Buffer, Date,
    console: { warn: message => warnings.push(message) }, process: { env: { CLUSTER_WEB_PASSWORD: 'fixture-operator' } } });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace('export default async (request) => {', 'globalThis.handler = async (request) => {'), context);
  async function call(action, body, { authenticated = true, method = body === undefined ? 'GET' : 'POST' } = {}) {
    const response = await context.handler({ url: `https://curtbrag.com/api/cluster?action=${action}`, method,
      headers: new Headers(authenticated ? { authorization: 'Bearer fixture-operator' } : {}), json: async () => body });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  const lookup = (requests, options) => call('job-results', { requests }, options);
  return { values, reads, writes, deletes, lists, pages, warnings, call, lookup };
}

test('receipt lookup requires operator authentication before reads, migration or writes', async () => {
  const h = harness({ migrated: false });
  const response = await h.lookup([pair()], { authenticated: false });
  assert.equal(response.status, 401);
  assert.deepEqual(h.reads, []); assert.deepEqual(h.writes, []); assert.deepEqual(h.lists, []);
});

test('receipt lookup validates method and bounded exact identifiers without sanitizing aliases', async () => {
  const h = harness();
  assert.equal((await h.call('job-results')).status, 405);
  for (const body of [null, {}, [], { requests: [] }, { requests: [pair()], extra: true }, { requests: Array.from({ length: 17 }, () => pair()) },
    { requests: [null] }, { requests: [{ ...pair(), extra: true }] }, { requests: [{ job_id: 'x' }] },
    ...['../other', 'white space', 'bad/slash', 'bad\nline', 'x'.repeat(97), '__proto__'].map(job_id => ({ requests: [pair(job_id)] }))]) {
    assert.equal((await h.call('job-results', body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(h.writes, []); assert.deepEqual(h.reads, []); assert.deepEqual(h.lists, []);
});

test('indexed receipt survives the latest-fifty window without reading history or original commands', async () => {
  const h = harness({ history: 1200 }); const request = pair(), value = receipt(request), key = resultKey(request);
  h.values.set(key, value); h.values.set(indexKey(request), { ...request, result_key: key });
  const response = await h.lookup([request]);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.data.complete, true); assert.equal(response.data.history_keys_examined, 0);
  assert.equal(response.data.results.length, 1); assert.equal(response.data.results[0].job_id, request.job_id);
  assert.equal(response.data.results[0].cmd, undefined); assert.equal(response.data.results[0].unrelated_private_field, undefined);
  assert.deepEqual(response.data.pending, []); assert.deepEqual(response.data.missing, []);
  assert.deepEqual(h.lists, []); assert.deepEqual(h.reads, [indexKey(request), key]); assert.deepEqual(h.writes, []);
});

test('receipt lookup preserves unknown exits instead of coercing them into success', async () => {
  for (const code of [null, undefined, false, true, '', ' ', [], {}, 1.5, Number.MAX_SAFE_INTEGER+1]) {
    const h = harness(), request = pair();
    const key = resultKey(request);
    h.values.set(key, {...receipt(request), exit_code:code});
    h.values.set(indexKey(request), {...request, result_key:key});
    const response = await h.lookup([request]);
    assert.equal(response.data.results[0].exit_code, null);
    assert.deepEqual(h.writes, []); assert.deepEqual(h.deletes, []);
  }
  for (const [input, expected] of [[0,0],[1,1],[-15,-15],['0',0],['17',17],['-15',-15]]) {
    const h = harness(), request = pair(), key = resultKey(request);
    h.values.set(key, {...receipt(request), exit_code:input});h.values.set(indexKey(request), {...request, result_key:key});
    assert.equal((await h.lookup([request])).data.results[0].exit_code, expected);
  }
});

test('completion acknowledges an unknown exit without inventing success or replaying the job', async () => {
  for (const code of [null, undefined, false, '', ' ', {}]) {
    const h = harness(), request = pair('unknown-exit');
    h.values.set(`job--${request.job_id}`, {id:request.job_id,type:'shell'});
    h.values.set(`assignment--${request.job_id}--${request.device_id}`, {...request});
    const response = await h.call('job-complete', {...request, stdout:'delivered but unverified', exit_code:code});
    assert.equal(response.status,200);assert.equal(response.data.remaining,0);
    const index = h.values.get(indexKey(request));
    assert.equal(h.values.get(index.result_key).exit_code,null);
    assert.equal(h.values.has(`assignment--${request.job_id}--${request.device_id}`),false);
    assert.equal(h.values.has(`job--${request.job_id}`),false);
    assert.equal((await h.lookup([request])).data.results[0].exit_code,null);
  }
});

test('older receipts use bounded paginated key metadata and read only the requested body', async () => {
  const h = harness({ history: 1200 }), request = pair('old-1');
  const response = await h.lookup([request]);
  assert.equal(response.status, 200); assert.equal(response.data.results[0].job_id, 'old-1');
  assert.equal(response.data.complete, true); assert.equal(response.data.history_keys_examined, 1200);
  assert.deepEqual(h.lists, [{ prefix: 'result--', paginate: true }]); assert.deepEqual(h.pages, [0, 1000]);
  assert.equal(h.reads.filter(key => key.startsWith('result--')).length, 1); assert.deepEqual(h.writes, []);
});

test('lookup has a hard five-thousand metadata bound and reports incomplete history honestly', async () => {
  const h = harness({ history: 6000 }), request = pair('old-5500');
  const response = await h.lookup([request]);
  assert.equal(response.status, 200); assert.equal(response.data.complete, false); assert.equal(response.data.history_keys_examined, 5000);
  assert.deepEqual(response.data.results, []); assert.deepEqual(response.data.missing, [request]);
  assert.deepEqual(h.pages, [0, 1000, 2000, 3000, 4000]);
  assert.equal(h.reads.filter(key => key.startsWith('result--')).length, 0); assert.deepEqual(h.writes, []);
});

test('pending and missing pairs are classified without dispatching or migrating any work', async () => {
  const h = harness({ migrated: false }), waiting = pair('waiting'), absent = pair('absent');
  h.values.set(`assignment--${waiting.job_id}--${waiting.device_id}`, { ...waiting, job: { cmd: 'must not return' } });
  h.values.set('jobs', [{ id: 'legacy-job', type: 'shell', cmd: 'must not enqueue' }]);
  const response = await h.lookup([waiting, absent]);
  assert.equal(response.status, 200); assert.deepEqual(response.data.pending, [waiting]); assert.deepEqual(response.data.missing, [absent]);
  assert.deepEqual(h.writes, []); assert.deepEqual(h.deletes, []); assert.equal(h.reads.includes('jobs'), false); assert.equal(h.reads.includes('migration--v2'), false);
});

test('storage failures never turn into a false missing receipt', async () => {
  for (const fault of [`get:${indexKey(pair())}`, 'page:1000', `get:${resultKey(pair())}`, `get:assignment--${pair().job_id}--${pair().device_id}`]) {
    const h = harness({ history: fault === 'page:1000' ? 1200 : 0, fault });
    if (fault === `get:${resultKey(pair())}`) h.values.set(indexKey(pair()), { ...pair(), result_key: resultKey(pair()) });
    const response = await h.lookup([pair()]);
    assert.equal(response.status, 503, fault); assert.equal(response.data.ok, false); assert.equal(response.data.missing, undefined);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.deepEqual(h.writes, []);
  }
});

test('index paths and stored values cannot expose another blob or another job/unit pair', async () => {
  for (const wrong of [
    { ...pair(), result_key: 'node--private' },
    { ...pair('other'), result_key: resultKey(pair()) },
    { ...pair(), result_key: resultKey(pair('other')) }
  ]) {
    const h = harness(); h.values.set(indexKey(pair()), wrong); h.values.set('node--private', { secret: 'excluded' });
    const response = await h.lookup([pair()]); assert.equal(response.status, 200); assert.deepEqual(response.data.results, []);
    assert.equal(h.reads.includes('node--private'), false);
  }
  const h = harness(), wanted = pair('a--b', 'c'), colliding = pair('a', 'b--c');
  h.values.set(resultKey(wanted), receipt(colliding));
  const response = await h.lookup([wanted]); assert.deepEqual(response.data.results, []); assert.deepEqual(response.data.missing, [wanted]);
});

test('duplicate pairs are deduplicated and a sixteen-device batch stays bounded', async () => {
  const h = harness(), request = pair(), key = resultKey(request);
  h.values.set(key, receipt(request)); h.values.set(indexKey(request), { ...request, result_key: key });
  const duplicate = await h.lookup([request, request]); assert.equal(duplicate.data.results.length, 1); assert.equal(h.reads.length, 2);
  const batch = harness();
  const requests = Array.from({ length: 16 }, (_, index) => pair(`batch-${index}`, `unit${index}`));
  assert.equal((await batch.lookup(requests)).status, 200); assert.equal(batch.reads.length, 32);
});

test('new completions write a direct receipt pointer and remain retrievable after history ages', async () => {
  const h = harness({ history: 6000 }), request = pair('new-completion');
  h.values.set(`job--${request.job_id}`, { id: request.job_id, type: 'shell', cmd: 'excluded from lookup' });
  h.values.set(`assignment--${request.job_id}--${request.device_id}`, { ...request });
  assert.equal((await h.call('job-complete', { ...request, stdout: receipt().stdout, exit_code: 0 })).status, 200);
  const index = h.values.get(indexKey(request)); assert.equal(index.job_id, request.job_id); assert.ok(h.values.has(index.result_key));
  h.reads.length = 0; h.lists.length = 0; h.writes.length = 0;
  const response = await h.lookup([request]); assert.equal(response.data.results.length, 1); assert.equal(response.data.complete, true);
  assert.deepEqual(h.lists, []); assert.deepEqual(h.writes, []); assert.equal(h.reads.length, 2);
});

test('index write outage does not repeat a completed device request and fallback retains its receipt', async () => {
  const request = pair('index-outage'), h = harness({ fault: `write:${indexKey(request)}` });
  h.values.set(`job--${request.job_id}`, { id: request.job_id, type: 'shell' });
  h.values.set(`assignment--${request.job_id}--${request.device_id}`, { ...request });
  assert.equal((await h.call('job-complete', { ...request, stdout: receipt().stdout, exit_code: 0 })).status, 200);
  assert.equal(h.values.has(`assignment--${request.job_id}--${request.device_id}`), false);
  assert.equal(h.values.has(`job--${request.job_id}`), false); assert.equal(h.warnings.length, 1);
  assert.equal((await h.lookup([request])).data.results.length, 1);
});

test('clearing result history also removes indexes and cannot resurrect a discarded receipt', async () => {
  const h = harness(), request = pair(), key = resultKey(request);
  h.values.set(key, receipt(request)); h.values.set(indexKey(request), { ...request, result_key: key });
  assert.equal((await h.call('clear-results', {})).status, 200);
  assert.equal(h.values.has(indexKey(request)), false); assert.equal(h.values.has(key), false);
  assert.deepEqual((await h.lookup([request])).data.results, []);
});
