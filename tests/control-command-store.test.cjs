'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { STATE_KEY, strictFetch, createControlCommandStore, captureControlContext, openControlCommandStore } = require('../netlify/functions/lib/control-command-store.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const command = (id, extra = {}) => ({ id, type: 'open-url', target: 'phone253', payload: { url: 'https://curtbrag.com/' }, status: 'queued', ...extra });

class MemoryStore {
  constructor() { this.records = new Map(); this.version = 0; this.reads = []; this.writes = []; this.failure = null; this.readFailure = null; }
  seed(key, value) { this.records.set(key, { data: copy(value), etag: '"v' + ++this.version + '"' }); }
  async getWithMetadata(key, options) {
    this.reads.push({ key, options });
    assert.equal(options.consistency, 'strong');
    assert.equal(options.type, 'json');
    assert.equal('etag' in options, false);
    if (this.readFailure) throw this.readFailure;
    return this.records.has(key) ? copy(this.records.get(key)) : null;
  }
  async set(key, serialized, options) {
    this.writes.push({ key, options });
    assert.ok(key === STATE_KEY || key.startsWith('history-backup-v1-'));
    assert.equal(Object.keys(options).length, 1);
    const old = this.records.get(key);
    if (options.onlyIfNew ? old : (!old || old.etag !== options.onlyIfMatch)) return { modified: false };
    if (this.failure === 'precommit') throw Error('synthetic transport failure');
    const etag = '"v' + ++this.version + '"';
    this.records.set(key, { data: JSON.parse(serialized), etag });
    if (this.failure === 'aftercommit') { this.failure = null; throw Error('synthetic timeout'); }
    if (this.failure === 'no-etag') return { modified: true };
    return { modified: true, etag };
  }
}
function fixture(options = {}) {
  const store = new MemoryStore();
  const legacyStore = new MemoryStore();
  let revision = 0;
  const api = createControlCommandStore({ store, legacyStore, randomId: () => 'revision-' + ++revision, now: () => '2026-10-08T20:00:00.000Z', ...options });
  return { store, legacyStore, api };
}
async function enqueue(api, id, requestId = id) {
  return api.transact(draft => { draft.queue.push(command(id)); return { accepted: id }; }, { requestId, requestFingerprint: 'enqueue:' + id });
}

test('first snapshot migrates empty sources once and every read/write uses strong CAS', async () => {
  const { store, legacyStore, api } = fixture();
  const first = await api.snapshot();
  assert.deepEqual(first.queue, []);
  assert.equal(first.receipt.schema, 1);
  assert.equal(first.receipt.migrated, true);
  await api.snapshot();
  assert.equal(store.writes.length, 1);
  assert.deepEqual(store.writes[0].options, { onlyIfNew: true });
  assert.equal(legacyStore.writes.length, 0);
});

test('parallel appends conflict and preserve both requests', async () => {
  const { api, store } = fixture();
  await api.snapshot();
  const values = await Promise.all([enqueue(api, 'a'), enqueue(api, 'b')]);
  assert.equal(values.length, 2);
  assert.deepEqual((await api.snapshot()).queue.map(entry => entry.id).sort(), ['a', 'b']);
  assert.ok(store.writes.slice(1).every(entry => /^"v\d+"$/.test(entry.options.onlyIfMatch)));
});

test('completion and enqueue preserve queue/history together under a conflict', async () => {
  const { api } = fixture();
  await enqueue(api, 'a');
  await Promise.all([
    api.transact(draft => { const original = draft.queue.shift(); draft.history.push({ ...original, status: 'completed' }); return { completed: original.id }; }, { requestId: 'complete-a', requestFingerprint: 'complete:a' }),
    enqueue(api, 'b'),
  ]);
  const value = await api.snapshot();
  assert.deepEqual(value.queue.map(entry => entry.id), ['b']);
  assert.deepEqual(value.history.map(entry => entry.id), ['a']);
});

test('saved request result is returned without reapplying callback; changed fingerprint rejects', async () => {
  const { api } = fixture();
  const accepted = await enqueue(api, 'a', 'stable');
  let callbacks = 0;
  const replay = await api.transact(() => { callbacks++; }, { requestId: 'stable', requestFingerprint: 'enqueue:a' });
  assert.equal(callbacks, 0);
  assert.deepEqual(replay.result, accepted.result);
  assert.equal(replay.receipt.replayed, true);
  await assert.rejects(api.transact(() => {}, { requestId: 'stable', requestFingerprint: 'flush' }), { code: 'REQUEST_ID_REUSED', statusCode: 409 });
  await assert.rejects(api.transact(() => {}, { requestId: 'stable' }), { code: 'REQUEST_ID_REUSED' });
});

test('postcommit timeout reconciles the exact revision instead of replaying', async () => {
  const { api, store } = fixture();
  await api.snapshot();
  store.failure = 'aftercommit';
  let calls = 0;
  const outcome = await api.transact(draft => { calls++; draft.queue.push(command('a')); return 'accepted'; }, { requestId: 'a', requestFingerprint: 'enqueue:a' });
  assert.equal(outcome.result, 'accepted');
  assert.equal(calls, 1);
  assert.equal((await api.snapshot()).queue.length, 1);
});

test('precommit write error remains uncertain and never reruns callback', async () => {
  const { api, store } = fixture();
  await api.snapshot();
  store.failure = 'precommit';
  let calls = 0;
  await assert.rejects(api.transact(draft => { calls++; draft.queue.push(command('a')); return null; }, { requestId: 'a' }), { code: 'WRITE_UNCERTAIN' });
  assert.equal(calls, 1);
  store.failure = null;
  assert.deepEqual((await api.snapshot()).queue, []);
});

test('missing successful write ETag is reconciled through fresh read', async () => {
  const { api, store } = fixture();
  await api.snapshot();
  store.failure = 'no-etag';
  assert.equal((await enqueue(api, 'a')).result.accepted, 'a');
});

test('SDK retry412 after a committed write cannot repeat an old client callback', async () => {
  const { api, store } = fixture();
  await api.snapshot();
  const original = store.set.bind(store);
  let first = true;
  store.set = async (...args) => { const result = await original(...args); if (first) { first = false; assert.equal(result.modified, true); return { modified: false }; } return result; };
  let calls = 0;
  const outcome = await api.transact(draft => { calls++; draft.queue.push(command('a')); return { accepted: 'a' }; });
  assert.equal(calls, 1);
  assert.equal(outcome.result.accepted, 'a');
  assert.equal('request_id' in outcome.receipt, false);
  assert.equal((await api.snapshot()).queue.length, 1);
});

test('read failures and 304-style null data never turn into empty queue', async () => {
  const { api, store } = fixture();
  store.readFailure = Error('synthetic read error');
  await assert.rejects(api.snapshot(), { code: 'READ_FAILED' });
  store.readFailure = null;
  store.records.set(STATE_KEY, { data: null, etag: '"unchanged"' });
  await assert.rejects(api.snapshot(), { code: 'READ_FAILED' });
  assert.equal(store.writes.length, 0);
});

test('matching old dual writes deduplicate and choose bridge authority', async () => {
  const { api, store, legacyStore } = fixture();
  const cp = command('a');
  store.seed('queue', [cp]);
  legacyStore.seed('queue', [{ id: 'a', command: cp.type, target: cp.target, payload: cp.payload, status: 'queued', created_at: 'old' }]);
  const value = await api.snapshot();
  assert.equal(value.queue.length, 1);
  assert.equal(value.queue[0].route, 'bridge');
  assert.deepEqual(store.records.get('queue').data, [cp]);
  assert.equal(legacyStore.writes.length, 0);
});

test('legacy-only old payload is preserved but held until reviewed', async () => {
  const { api, legacyStore } = fixture();
  legacyStore.seed('queue', [{ id: 'a', command: 'open-url', target: 'all', url: 'https://curtbrag.com/', queuedAt: '2026-10-08' }]);
  const value = await api.snapshot();
  assert.equal(value.queue[0].route, 'held');
  assert.equal(value.queue[0].status, 'held');
  assert.equal(value.queue[0].type, 'open-url');
  assert.equal(value.queue[0].url, 'https://curtbrag.com/');
});

test('conflicting queued copies are held while an unrelated command survives', async () => {
  const { api, store, legacyStore } = fixture();
  store.seed('queue', [command('a'), command('b')]);
  legacyStore.seed('queue', [command('a', { payload: { url: 'https://different.invalid/' } })]);
  const value = await api.snapshot();
  assert.equal(value.queue[0].status, 'held');
  assert.equal(value.queue[0].route, 'held');
  assert.equal(value.queue[0].migration_evidence.length, 2);
  assert.equal(value.queue[1].status, 'queued');
});

test('pending + terminal overlap and duplicate terminal evidence are held, never replayed', async () => {
  const { api, store } = fixture();
  store.seed('queue', [command('a')]);
  store.seed('history', [command('a', { status: 'completed', result: 'one' }), command('a', { status: 'failed', result: 'two' })]);
  const value = await api.snapshot();
  assert.equal(value.queue[0].status, 'held');
  assert.equal(value.history.length, 1);
  assert.equal(value.history[0].migration_evidence.length, 2);
});

test('old running command is held without an owner and source drift blocks all mutation', async () => {
  const { api, store, legacyStore } = fixture();
  store.seed('queue', [command('a', { status: 'running' })]);
  assert.equal((await api.snapshot()).queue[0].status, 'held');
  assert.equal((await api.snapshot()).queue[0].migration_evidence[0].status, 'running');
  const written = store.writes.length;
  legacyStore.seed('queue', [command('new-old-writer')]);
  await assert.rejects(enqueue(api, 'b'), { code: 'LEGACY_SOURCE_CHANGED' });
  assert.equal(store.writes.length, written);
});

test('changed source between strong migration reads cannot be silently migrated', async () => {
  const { api, store } = fixture({ maxAttempts: 2 });
  const original = store.getWithMetadata.bind(store);
  store.getWithMetadata = async (key, options) => { if (key === 'queue') store.seed('queue', [command('new-' + store.version)]); return original(key, options); };
  await assert.rejects(api.snapshot(), { code: 'CONFLICT' });
  assert.equal(store.writes.length, 0);
});

test('full pending queue rejects append without evicting any existing command', async () => {
  const { api, store } = fixture();
  store.seed('queue', Array.from({ length: 200 }, (_, index) => command('q-' + index)));
  await api.snapshot();
  const written = store.writes.length;
  await assert.rejects(enqueue(api, 'overflow'), { code: 'CAPACITY' });
  assert.equal(store.writes.length, written);
  assert.equal((await api.snapshot()).queue.length, 200);
});

test('flush requires cancellation archives and retains bounded history', async () => {
  const { api, store } = fixture();
  store.seed('history', Array.from({ length: 200 }, (_, index) => command('h-' + index, { status: 'completed' })));
  await enqueue(api, 'a');
  await assert.rejects(api.transact(draft => { draft.queue = []; }), { code: 'INVALID_TRANSITION' });
  const result = await api.transact(draft => { draft.history.push(...draft.queue.map(record => ({ ...record, status: 'cancelled' }))); draft.queue = []; return { flushed: 1 }; }, { requestId: 'flush', requestFingerprint: 'flush' });
  assert.deepEqual(result.queue, []);
  assert.equal(result.history.length, 200);
  assert.equal(result.history.at(-1).status, 'cancelled');
});

test('200 reports of16KiB plus a full pending queue fit the bounded envelope', async () => {
  const { api, store } = fixture();
  store.seed('history', Array.from({ length: 200 }, (_, index) => command('h-' + index, { status: 'completed', output: 'x'.repeat(16 * 1024) })));
  store.seed('queue', Array.from({ length: 200 }, (_, index) => command('q-' + index)));
  const migrated = await api.snapshot();
  assert.equal(migrated.history.length, 200);
  assert.equal(migrated.queue.length, 200);
  const completed = await api.transact(draft => { const record = draft.queue.shift(); draft.history.push({ ...record, status: 'completed', output: 'x'.repeat(16 * 1024) }); });
  assert.equal(completed.history.length, 200);
  assert.equal(completed.history.at(-1).id, 'q-0');
  assert.equal(completed.queue.length, 199);
});

test('oversize envelope rejects before writing and preserves all acknowledged state', async () => {
  const { api, store } = fixture();
  await enqueue(api, 'a');
  const written = store.writes.length;
  await assert.rejects(api.transact(draft => { draft.queue[0].payload = { data: 'x'.repeat(8 * 1024 * 1024) }; }), { code: 'CAPACITY' });
  assert.equal(store.writes.length, written);
  assert.equal((await api.snapshot()).queue[0].payload.url, 'https://curtbrag.com/');
});

test('read-only no-op polling avoids writes; asynchronous and non-JSON callbacks reject', async () => {
  const { api, store } = fixture();
  await api.snapshot();
  const written = store.writes.length;
  await api.transact(() => ({ commands: [] }));
  assert.equal(store.writes.length, written);
  await assert.rejects(api.transact(async () => null), { code: 'INVALID_REQUEST' });
  await assert.rejects(api.transact(() => Infinity), { code: 'INVALID_STATE' });
  assert.equal(store.writes.length, written);
});

test('bounded verified CAS conflicts fail honestly instead of an unconditional write', async () => {
  const { api, store } = fixture({ maxAttempts: 2 });
  await api.snapshot();
  const original = store.set.bind(store);
  store.set = async (key, value, options) => { assert.ok(options.onlyIfMatch); return { modified: false }; };
  await assert.rejects(enqueue(api, 'a'), { code: 'CONFLICT', statusCode: 409 });
  store.set = original;
  assert.deepEqual((await api.snapshot()).queue, []);
});

test('strict transport rejects failed PUT even with an error ETag and preserves412/GET404/304', async () => {
  for (const status of [201, 204, 400, 403, 500, 503]) {
    const checked = strictFetch(async () => new Response(status === 204 ? null : '', { status, headers: { etag: '"error"' } }));
    await assert.rejects(checked('https://offline.invalid/', { method: 'put' }), { code: 'WRITE_REJECTED' });
  }
  for (const [method, status] of [['PUT', 412], ['GET', 404], ['GET', 304]]) {
    const checked = strictFetch(async () => new Response(status === 304 ? null : '', { status }));
    assert.equal((await checked('https://offline.invalid/', { method })).status, status);
  }
});

test('legacy source drift during successful CAS prevents success acknowledgement', async () => {
  const { api, store, legacyStore } = fixture();
  await api.snapshot();
  const original = store.set.bind(store);
  store.set = async (...args) => { const result = await original(...args); legacyStore.seed('queue', [command('late-old-writer')]); return result; };
  await assert.rejects(enqueue(api, 'a'), { code: 'LEGACY_SOURCE_CHANGED' });
  assert.equal(store.records.get(STATE_KEY).data.queue[0].id, 'a');
});

test('new explicit legacy commands after cutover keep their route', async () => {
  const { api } = fixture();
  await api.snapshot();
  await api.transact(draft => { draft.queue.push(command('new-legacy', { route: 'legacy' })); }, { requestId: 'new-legacy' });
  assert.equal((await api.snapshot()).queue[0].route, 'legacy');
});

const HISTORY_NOW = Date.parse('2026-10-08T20:00:00.000Z');
async function oldHistoryFixture() {
  const values = fixture();
  const cp = Array.from({ length: 200 }, (_, index) => command('cp-' + index, { status: 'completed', finished_at: HISTORY_NOW - 200 + index }));
  const legacy = Array.from({ length: 50 }, (_, index) => ({ id: 'legacy-' + index, command: 'restart', target: 'all', completedAt: new Date(HISTORY_NOW - 86400000 + index).toISOString(), result: 'old report' }));
  values.store.seed('history', cp);
  values.legacyStore.seed('history', legacy);
  values.legacyStore.seed('queue', [command('held-pending', { type: 'mining-start' })]);
  await values.api.snapshot();
  const previous = copy(values.store.records.get(STATE_KEY).data);
  previous.revision = 'deployed-old-history';
  previous.history = [...cp.slice(50).map(record => ({ ...record, route: 'bridge' })), ...legacy.map(record => ({ ...record, type: record.command, route: 'legacy', status: 'completed' }))];
  previous.requestReceipts = [{ requestId: 'accepted-before-repair', fingerprint: 'old', result: { accepted: true }, revision: 'saved-old-request', at: '2026-10-08' }];
  delete previous.migration.history_version;
  values.store.seed(STATE_KEY, previous);
  return { ...values, cp, legacy, previous };
}

test('initial retention keeps newest CP200 over appended older legacy50', async () => {
  const { api, store, legacyStore } = fixture();
  store.seed('history', Array.from({ length: 200 }, (_, index) => command('cp-' + index, { status: 'completed', finished_at: HISTORY_NOW + index })));
  legacyStore.seed('history', Array.from({ length: 50 }, (_, index) => ({ id: 'old-' + index, command: 'restart', target: 'all', completedAt: new Date(HISTORY_NOW - 86400000 + index).toISOString() })));
  const snapshot = await api.snapshot();
  assert.equal(snapshot.history.length, 200);
  assert.ok(snapshot.history.every(record => record.id.startsWith('cp-')));
  assert.equal(snapshot.history.at(-1).id, 'cp-199');
  assert.equal(snapshot.receipt.history_version, 2);
});

test('deployed old history repairs once with immutable backup and no pending or receipt changes', async () => {
  const { api, store, legacyStore, previous } = await oldHistoryFixture();
  const sourceBefore = copy([...store.records.entries()].filter(([key]) => ['queue', 'history'].includes(key)));
  const legacyBefore = copy([...legacyStore.records.entries()]);
  const snapshot = await api.snapshot();
  const upgraded = store.records.get(STATE_KEY).data;
  assert.equal(snapshot.history.length, 200);
  assert.ok(snapshot.history.every(record => record.id.startsWith('cp-')));
  assert.equal(upgraded.migration.history_repair.restored_count, 50);
  assert.deepEqual(upgraded.queue, previous.queue);
  assert.deepEqual(upgraded.requestReceipts, previous.requestReceipts);
  assert.deepEqual(upgraded.migration.sources, previous.migration.sources);
  assert.deepEqual(sourceBefore, copy([...store.records.entries()].filter(([key]) => ['queue', 'history'].includes(key))));
  assert.deepEqual(legacyBefore, copy([...legacyStore.records.entries()]));
  const repair = upgraded.migration.history_repair;
  const backup = store.records.get(repair.backup_key);
  assert.deepEqual(backup.data, { schema: 1, source_revision: previous.revision, history: previous.history });
  assert.equal(backup.etag, repair.backup_etag);
  const writes = store.writes.length;
  await api.snapshot();
  assert.equal(store.writes.length, writes);
});

test('unconfirmed backup write blocks repair without touching authoritative state', async () => {
  const { api, store, previous } = await oldHistoryFixture();
  store.failure = 'precommit';
  await assert.rejects(api.snapshot(), { code: 'HISTORY_BACKUP_UNCONFIRMED' });
  assert.deepEqual(store.records.get(STATE_KEY).data, previous);
});

test('committed backup timeout is strongly confirmed before state repair', async () => {
  const { api, store } = await oldHistoryFixture();
  store.failure = 'aftercommit';
  const snapshot = await api.snapshot();
  assert.equal(snapshot.receipt.history_version, 2);
  const backupWrite = store.writes.findIndex(write => write.key.startsWith('history-backup-v1-'));
  assert.ok(backupWrite >= 0);
  assert.deepEqual(store.writes[backupWrite].options, { onlyIfNew: true });
});

test('existing immutable backup conflicts are never overwritten', async () => {
  const { api, store, previous } = await oldHistoryFixture();
  const key = 'history-backup-v1-' + crypto.createHash('sha256').update(previous.revision).digest('hex');
  const conflicting = { schema: 1, source_revision: previous.revision, history: [] };
  store.seed(key, conflicting);
  const writes = store.writes.length;
  await assert.rejects(api.snapshot(), { code: 'HISTORY_BACKUP_CONFLICT' });
  assert.equal(store.writes.length, writes);
  assert.deepEqual(store.records.get(key).data, conflicting);
  assert.deepEqual(store.records.get(STATE_KEY).data, previous);
});

test('matching concurrent immutable backup creation is strongly verified without overwriting', async () => {
  const { api, store, previous } = await oldHistoryFixture();
  const original = store.set.bind(store);
  let backupAttempts = 0;
  store.set = async (...args) => {
    if (args[0].startsWith('history-backup-v1-')) {
      backupAttempts++;
      assert.deepEqual(args[2], { onlyIfNew: true });
      store.seed(args[0], JSON.parse(args[1]));
      return { modified: false };
    }
    return original(...args);
  };
  assert.equal((await api.snapshot()).receipt.history_version, 2);
  assert.equal(backupAttempts, 1);
  const repair = store.records.get(STATE_KEY).data.migration.history_repair;
  assert.deepEqual(store.records.get(repair.backup_key).data.history, previous.history);
  assert.equal(repair.backup_etag, store.records.get(repair.backup_key).etag);
});

test('accepted backup with failed confirmation read cannot authorize main history mutation', async () => {
  const { api, store, previous } = await oldHistoryFixture();
  const originalRead = store.getWithMetadata.bind(store);
  let backupReads = 0;
  store.getWithMetadata = async (...args) => {
    if (args[0].startsWith('history-backup-v1-') && ++backupReads > 1) throw Error('synthetic unavailable backup receipt');
    return originalRead(...args);
  };
  await assert.rejects(api.snapshot(), { code: 'READ_FAILED' });
  assert.deepEqual(store.records.get(STATE_KEY).data, previous);
  assert.equal([...store.records.keys()].filter(key => key.startsWith('history-backup-v1-')).length, 1);
});

test('source drift after backup confirmation blocks repair before state CAS', async () => {
  const { api, store, legacyStore, previous } = await oldHistoryFixture();
  const original = store.set.bind(store);
  store.set = async (...args) => { const result = await original(...args); if (args[0].startsWith('history-backup-v1-')) legacyStore.seed('history', []); return result; };
  await assert.rejects(api.snapshot(), { code: 'LEGACY_SOURCE_CHANGED' });
  assert.deepEqual(store.records.get(STATE_KEY).data, previous);
});

test('repair CAS conflict recomputes from fresh authority and preserves a concurrent completion', async () => {
  const { api, store, previous } = await oldHistoryFixture();
  const original = store.set.bind(store);
  let conflict = true;
  store.set = async (...args) => {
    if (args[0] === STATE_KEY && conflict) {
      conflict = false;
      const concurrent = copy(previous);
      concurrent.revision = 'concurrent-completion';
      concurrent.history = [...concurrent.history.slice(1), command('new-completion', { route: 'bridge', status: 'completed', finished_at: HISTORY_NOW + 1000 })];
      store.seed(STATE_KEY, concurrent);
      return { modified: false };
    }
    return original(...args);
  };
  const snapshot = await api.snapshot();
  assert.equal(snapshot.history.at(-1).id, 'new-completion');
  assert.deepEqual(snapshot.queue, previous.queue);
  assert.equal(store.records.get(STATE_KEY).data.migration.history_repair.previous_revision, 'concurrent-completion');
  assert.equal([...store.records.keys()].filter(key => key.startsWith('history-backup-v1-')).length, 2);
});

test('state repair committed timeout reconciles revision without repeating upgrade', async () => {
  const { api, store } = await oldHistoryFixture();
  const original = store.set.bind(store);
  let stateWrites = 0;
  store.set = async (...args) => { const result = await original(...args); if (args[0] === STATE_KEY) { stateWrites++; throw Error('synthetic committed repair timeout'); } return result; };
  assert.equal((await api.snapshot()).receipt.history_version, 2);
  assert.equal(stateWrites, 1);
});

test('repair keeps current same-ID terminal authority while preserving complete old evidence', async () => {
  const { api, store, previous } = await oldHistoryFixture();
  const terminal = previous.history.find(record => record.id === 'cp-50');
  terminal.status = 'cancelled';
  terminal.pending_cancelled_at = HISTORY_NOW + 1000;
  terminal.output = 'operator cancelled the held entry';
  store.seed(STATE_KEY, previous);
  const snapshot = await api.snapshot();
  const authoritative = snapshot.history.find(record => record.id === 'cp-50');
  assert.equal(authoritative.status, 'cancelled');
  assert.equal(authoritative.output, terminal.output);
  assert.equal(authoritative.finished_at, terminal.finished_at);
  assert.equal(snapshot.history.at(-1).id, 'cp-50');
});

test('runtime rejects unknown context and isolates preview without touching production sources', async () => {
  const opened = [];
  const getStore = options => { opened.push(options); return new MemoryStore(); };
  assert.throws(() => openControlCommandStore({ getStore, env: {}, fetch: async () => { throw Error('offline'); } }), { code: 'DEPLOYMENT_CONTEXT' });
  assert.throws(() => openControlCommandStore({ getStore, env: { CONTEXT: 'deploy-preview' }, fetch: async () => {} }), { code: 'DEPLOYMENT_CONTEXT' });
  const api = openControlCommandStore({ getStore, env: { CONTEXT: 'deploy-preview', DEPLOY_ID: 'dummy-123' }, fetch: async () => {} });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].name, 'cp-commands-isolated-deploy-preview-dummy-123');
  assert.equal(opened[0].consistency, 'strong');
  await api.snapshot();
  assert.equal(opened[0].siteID, undefined);
});

test('runtime preserves one complete provider context only in SDK options, never saved state', async () => {
  const stores = [];
  const event = { blobs: Buffer.from(JSON.stringify({ url: 'https://cached.offline.invalid/', token: 'synthetic-provider-token' })).toString('base64'), headers: { 'x-nf-site-id': 'synthetic-site' } };
  const providerContext = captureControlContext({ context: Buffer.from(JSON.stringify({ siteID: 'synthetic-site', token: 'synthetic-provider-token', edgeURL: 'https://cached.offline.invalid/', uncachedEdgeURL: 'https://uncached.offline.invalid/' })).toString('base64') });
  const api = openControlCommandStore({ getStore: options => { const store = new MemoryStore(); stores.push({ store, options }); return store; }, event, providerContext, env: { CONTEXT: 'production' }, fetch: async () => {} });
  await api.snapshot();
  for (const { options } of stores) {
    assert.equal(options.siteID, 'synthetic-site');
    assert.equal(options.token, 'synthetic-provider-token');
    assert.equal(options.edgeURL, 'https://cached.offline.invalid/');
    assert.equal(options.uncachedEdgeURL, 'https://uncached.offline.invalid/');
  }
  const saved = JSON.stringify(stores[0].store.records.get(STATE_KEY).data);
  assert.equal(saved.includes('synthetic-provider-token'), false);
  assert.equal(saved.includes('synthetic-site'), false);
  assert.equal(saved.includes('cached.offline'), false);
});

test('legacy event token alone cannot be reinterpreted as API credentials or combined with partial context', () => {
  let stores = 0;
  const getStore = () => { stores++; return new MemoryStore(); };
  const event = { blobs: Buffer.from(JSON.stringify({ url: 'https://cached.offline.invalid/', token: 'other-token' })).toString('base64'), headers: { 'x-nf-site-id': 'other-site' } };
  const partial = Buffer.from(JSON.stringify({ siteID: 'runtime-site', token: 'runtime-token', edgeURL: 'https://cached.offline.invalid/' })).toString('base64');
  assert.equal(captureControlContext({ context: partial }), undefined);
  assert.throws(() => openControlCommandStore({ getStore, event, env: { CONTEXT: 'production' }, fetch: async () => {} }), { code: 'CONFIGURATION' });
  assert.throws(() => openControlCommandStore({ getStore, event, providerContext: { siteID: 'runtime-site', token: 'runtime-token', edgeURL: 'https://cached.offline.invalid/' }, env: { CONTEXT: 'production' }, fetch: async () => {} }), { code: 'CONFIGURATION' });
  assert.equal(stores, 0);
});

test('capture follows normal Netlify.env priority and never mixes fields across contexts', () => {
  const prior = globalThis.Netlify;
  const rich = { siteID: 'runtime-site', token: 'runtime-token', edgeURL: 'https://cached.offline.invalid/', uncachedEdgeURL: 'https://uncached.offline.invalid/' };
  const encoded = Buffer.from(JSON.stringify(rich)).toString('base64');
  try {
    globalThis.Netlify = { env: { get: key => key === 'NETLIFY_BLOBS_CONTEXT' ? encoded : undefined } };
    assert.deepEqual(captureControlContext(), rich);
    const partial = Buffer.from(JSON.stringify({ siteID: 'other-site', token: 'other-token' })).toString('base64');
    assert.equal(captureControlContext({ context: partial }), undefined);
    assert.equal(captureControlContext({ env: { NETLIFY_BLOBS_CONTEXT: partial } }), undefined);
  } finally { if (prior === undefined) delete globalThis.Netlify; else globalThis.Netlify = prior; }
});

let publishedSDK;
try { publishedSDK = require.resolve('@netlify/control-blobs', { paths: [path.resolve(__dirname, '..')] }); }
catch (_) { publishedSDK = path.resolve(__dirname, '../../controller-reevaluation/storage-sources-20261008/blobs-10.7.12/dist/main.cjs'); }
function sdkRuntimeFixture() {
  const network = [];
  const blobs = new Map();
  let revision = 0;
  const syntheticFetch = async (url, options) => {
    network.push({ url, method: options.method, headers: options.headers });
    const parsed = new URL(url);
    assert.equal(parsed.host, 'uncached.offline.invalid');
    const key = parsed.pathname;
    if (String(options.method).toUpperCase() === 'GET') {
      const stored = blobs.get(key);
      return stored ? new Response(stored.body, { headers: { etag: stored.etag } }) : new Response('', { status: 404 });
    }
    const old = blobs.get(key);
    if ((options.headers['if-none-match'] === '*' && old) || (options.headers['if-match'] && (!old || options.headers['if-match'] !== old.etag))) return new Response('', { status: 412 });
    assert.ok(options.headers['if-match'] || options.headers['if-none-match'] === '*');
    const etag = '"sdk-' + ++revision + '"';
    blobs.set(key, { body: options.body, etag });
    return new Response('', { headers: { etag } });
  };
  const environment = {};
  const env = { get: key => environment[key], set: (key, value) => { environment[key] = value; }, has: key => key in environment, delete: key => { delete environment[key]; }, toObject: () => ({ ...environment }) };
  const context = { module: { exports: {} }, exports: {}, URL, TextEncoder, TextDecoder, ReadableStream, Blob, Response, Buffer, atob, btoa, process: { env: environment }, fetch: syntheticFetch, setTimeout: callback => { callback(); return 0; } };
  context.require = name => {
    if (name === 'process') return context.process;
    if (name === '@netlify/runtime-utils') return { base64Decode: value => Buffer.from(value, 'base64').toString(), base64Encode: value => Buffer.from(value).toString('base64'), getEnvironment: () => env };
    if (name === '@netlify/otel') return { getTracer: () => null, withActiveSpan: (_tracer, _name, run) => run(null) };
    throw Error('Unexpected dependency: ' + name);
  };
  vm.runInNewContext(fs.readFileSync(publishedSDK, 'utf8'), context);
  const sdk = context.module.exports;
  const event = { blobs: Buffer.from(JSON.stringify({ url: 'https://cached.offline.invalid/', token: 'dummy' })).toString('base64'), headers: { 'x-nf-site-id': 'dummy-site', 'x-nf-deploy-id': 'dummy-deploy' } };
  const rich = { edgeURL: 'https://cached.offline.invalid/', uncachedEdgeURL: 'https://uncached.offline.invalid/', siteID: 'dummy-site', token: 'dummy', deployID: 'dummy-deploy' };
  environment.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify(rich)).toString('base64');
  const getStore = options => {
    const store = sdk.getStore(options);
    return { getWithMetadata: async (...args) => { const value = await store.getWithMetadata(...args); return value === null ? null : copy(value); }, set: (...args) => store.set(...args) };
  };
  return { sdk, event, rich, environment, getStore, syntheticFetch, network };
}

test('exact pinned SDK10.7.12 preserves supplied uncached runtime transport after connectLambda', { skip: !fs.existsSync(publishedSDK) }, async () => {
  const { sdk, event, environment, getStore, syntheticFetch, network } = sdkRuntimeFixture();
  const providerContext = captureControlContext({ env: environment });
  sdk.connectLambda(event);
  assert.equal(JSON.parse(Buffer.from(environment.NETLIFY_BLOBS_CONTEXT, 'base64').toString()).uncachedEdgeURL, undefined);
  const api = openControlCommandStore({ getStore, event, providerContext, env: { CONTEXT: 'production' }, fetch: syntheticFetch });
  await api.snapshot();
  await enqueue(api, 'a');
  assert.equal((await api.snapshot()).queue.length, 1);
  assert.equal(network.some(request => new URL(request.url).host === 'api.netlify.com'), false);
  assert.equal(network.some(request => new URL(request.url).host === 'cached.offline.invalid'), false);
  assert.ok(network.some(request => request.headers['if-match']));
  assert.ok(network.some(request => request.headers['if-none-match'] === '*'));
});

test('exact SDK modern warm invocations retain normal runtime context and strong conditional storage', { skip: !fs.existsSync(publishedSDK) }, async () => {
  const { environment, getStore, syntheticFetch, network } = sdkRuntimeFixture();
  const initialContext = environment.NETLIFY_BLOBS_CONTEXT;
  for (let invocation = 0; invocation < 3; invocation++) {
    const providerContext = captureControlContext({ env: environment });
    assert.ok(providerContext);
    const api = openControlCommandStore({ getStore, event: { headers: {} }, providerContext, env: { CONTEXT: 'production' }, fetch: syntheticFetch });
    assert.equal((await api.snapshot()).queue.length, invocation);
    await enqueue(api, 'modern-' + invocation);
    assert.equal((await api.snapshot()).queue.length, invocation + 1);
    assert.equal(environment.NETLIFY_BLOBS_CONTEXT, initialContext);
  }
  assert.equal(network.some(request => new URL(request.url).host === 'api.netlify.com'), false);
  assert.equal(network.some(request => new URL(request.url).host === 'cached.offline.invalid'), false);
  assert.ok(network.some(request => request.headers['if-match']));
  assert.ok(network.some(request => request.headers['if-none-match'] === '*'));
});
