'use strict';

const crypto = require('node:crypto');
const deployment = require('./control-deployment.cjs');
const STATE_KEY = 'control-state-v1';
const MAX_QUEUE = 200;
const MAX_HISTORY = 200;
const MAX_RECEIPTS = 200;
const MAX_BYTES = 8 * 1024 * 1024;

class CommandStoreError extends Error {
  constructor(code, message, statusCode = 503) {
    super(message);
    this.name = 'CommandStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
function fail(code, message, statusCode) { throw new CommandStoreError(code, message, statusCode); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (plain(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  fail('INVALID_STATE', 'Command data must contain only JSON values.');
}
function clone(value) {
  const encoded = canonical(value);
  if (Buffer.byteLength(encoded) > MAX_BYTES) fail('CAPACITY', 'Command storage has reached its safe capacity.', 409);
  return JSON.parse(encoded);
}
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function validETag(value) { return typeof value === 'string' && value.trim().length > 0; }
function recordCheck(record) {
  if (!plain(record) || typeof record.id !== 'string' || !record.id.trim() || record.id.length > 300 || /[\x00-\x1f]/.test(record.id)) fail('INVALID_STATE', 'Command storage contains an invalid record.');
  canonical(record);
}
function checkArrays(queue, history) {
  if (!Array.isArray(queue) || !Array.isArray(history)) fail('INVALID_STATE', 'Command storage arrays are unavailable.');
  if (queue.length > MAX_QUEUE) fail('CAPACITY', 'The pending command queue is full; no commands were removed.', 409);
  if (history.length > MAX_HISTORY) fail('INVALID_STATE', 'Command history exceeds its retention limit.');
  const pending = new Set();
  for (const record of queue) {
    recordCheck(record);
    if (pending.has(record.id)) fail('INVALID_STATE', 'Command storage contains duplicate pending IDs.');
    pending.add(record.id);
  }
  const archived = new Set();
  for (const record of history) {
    recordCheck(record);
    if (archived.has(record.id)) fail('INVALID_STATE', 'Command storage contains duplicate history IDs.');
    archived.add(record.id);
  }
  for (const record of queue) if (archived.has(record.id) && record.status !== 'held') fail('INVALID_STATE', 'A completed command is also pending; execution is blocked.');
}
function checkState(state, migrateLegacy) {
  if (!plain(state) || state.schema !== 1 || typeof state.revision !== 'string' || !state.revision || !plain(state.migration) || !Array.isArray(state.migration.sources) || !Array.isArray(state.requestReceipts)) fail('INVALID_STATE', 'The command storage version or receipt is invalid.');
  checkArrays(state.queue, state.history);
  if (state.requestReceipts.length > MAX_RECEIPTS) fail('INVALID_STATE', 'Command receipt retention is invalid.');
  const ids = new Set();
  for (const receipt of state.requestReceipts) {
    if (!plain(receipt) || typeof receipt.requestId !== 'string' || !receipt.requestId || ids.has(receipt.requestId) || typeof receipt.revision !== 'string') fail('INVALID_STATE', 'Command request receipts are invalid.');
    ids.add(receipt.requestId);
  }
  if (!migrateLegacy && state.migration.sources.length !== 0) fail('INVALID_STATE', 'A preview cannot use production migration sources.');
  if (migrateLegacy && state.migration.sources.length < 2) fail('INVALID_STATE', 'The command migration fence is missing.');
  clone(state);
  return state;
}

// SDK 10 reports non-412 write failures as modified:true. Reject them at the
// transport boundary, while leaving missing/conditional read semantics intact.
function strictFetch(baseFetch) {
  if (typeof baseFetch !== 'function') fail('TRANSPORT_UNAVAILABLE', 'Command storage transport is unavailable.');
  return async function checkedFetch(input, options = {}) {
    const response = await baseFetch(input, options);
    const method = String(options.method || (input && input.method) || 'GET').toUpperCase();
    if (method === 'PUT' && response.status !== 200 && response.status !== 412) fail('WRITE_REJECTED', 'Command storage rejected the write.');
    return response;
  };
}

function createControlCommandStore({ store, legacyStore, now = () => new Date().toISOString(), randomId = () => crypto.randomUUID(), maxAttempts = 5, migrateLegacy = true } = {}) {
  if (!store || typeof store.getWithMetadata !== 'function' || typeof store.set !== 'function' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) fail('CONFIGURATION', 'Command storage is not configured safely.');
  if (legacyStore && typeof legacyStore.getWithMetadata !== 'function') fail('CONFIGURATION', 'Legacy command storage is not configured safely.');
  const sourceSpecs = migrateLegacy ? [{ source: 'cp', key: 'queue', store }, { source: 'cp', key: 'history', store }, ...(legacyStore ? [{ source: 'legacy', key: 'queue', store: legacyStore }, { source: 'legacy', key: 'history', store: legacyStore }] : [])] : [];

  async function readBlob(target, key) {
    let response;
    try { response = await target.getWithMetadata(key, { type: 'json', consistency: 'strong' }); }
    catch (_) { fail('READ_FAILED', 'Command storage could not be read safely.'); }
    if (response === null) return null;
    if (!plain(response) || response.data === null || !validETag(response.etag)) fail('READ_FAILED', 'Command storage returned an incomplete read receipt.');
    return { data: clone(response.data), etag: response.etag };
  }
  async function readSources() {
    return Promise.all(sourceSpecs.map(async spec => {
      const blob = await readBlob(spec.store, spec.key);
      if (blob && !Array.isArray(blob.data)) fail('INVALID_STATE', 'A legacy command source is malformed.');
      if (blob) for (const record of blob.data) recordCheck(record);
      return { source: spec.source, key: spec.key, etag: blob ? blob.etag : null, digest: digest(blob ? blob.data : null), data: blob ? blob.data : [] };
    }));
  }
  function fingerprints(sources) { return sources.map(({ source, key, etag, digest: hash }) => ({ source, key, etag, digest: hash })); }
  async function verifyFence(state) {
    const live = fingerprints(await readSources());
    if (canonical(live) !== canonical(state.migration.sources)) fail('LEGACY_SOURCE_CHANGED', 'An older command writer changed the migration sources. Commands are held until the writer is updated.');
  }
  const legacyPayloadKeys = ['url', 'sshCmd', 'displayMode', 'miningLevel', 'poolUrl', 'namespace', 'podName', 'tail'];
  function intent(record) {
    const payload = plain(record.payload) ? clone(record.payload) : {};
    for (const key of legacyPayloadKeys) if (!(key in payload) && record[key] !== undefined && record[key] !== null) payload[key] = record[key];
    for (const key of Object.keys(payload)) if (payload[key] === null) delete payload[key];
    return canonical({ type: record.type || record.command || null, target: record.target || 'all', payload });
  }
  function normalized(record, source, history) {
    const copy = clone(record);
    if (!copy.type && copy.command) copy.type = copy.command;
    if (!copy.route) copy.route = source === 'cp' ? 'bridge' : 'legacy';
    if (!copy.status) copy.status = history ? 'completed' : 'queued';
    return copy;
  }
  function held(record, reason, copies) {
    return { ...record, route: 'held', status: 'held', hold_reason: reason, migration_evidence: copies };
  }
  function mergeSources(sources) {
    const pending = new Map();
    const history = new Map();
    const cpPendingIds = new Set(sources.filter(source => source.source === 'cp' && source.key === 'queue').flatMap(source => source.data.map(record => record.id)));
    for (const source of sources) {
      const map = source.key === 'queue' ? pending : history;
      for (const original of source.data) {
        const incoming = normalized(original, source.source, source.key === 'history');
        const previous = map.get(incoming.id);
        if (!previous) { map.set(incoming.id, incoming); continue; }
        const matches = source.key === 'queue' ? intent(previous) === intent(incoming) && previous.status === incoming.status : canonical(previous) === canonical(incoming);
        if (!matches) map.set(incoming.id, held(previous, 'Conflicting copies of this command require review before execution.', previous.migration_evidence ? [...previous.migration_evidence, incoming] : [previous, incoming]));
      }
    }
    for (const [id, record] of pending) {
      const terminal = history.get(id);
      if (terminal) pending.set(id, held(record, 'This command is both pending and recorded as finished; automatic replay is blocked.', [record, terminal]));
      else if (record.status === 'running') pending.set(id, held(record, 'This older running command has no verified execution owner; automatic replay is blocked.', [record]));
      else if (!cpPendingIds.has(id) && record.status !== 'held') pending.set(id, held(record, 'An older legacy-only command requires review before execution.', [record]));
      else if (!['queued', 'running', 'held'].includes(record.status)) pending.set(id, held(record, 'A pending command has a terminal or unknown status; automatic replay is blocked.', [record]));
    }
    const queue = [...pending.values()];
    const archived = [...history.values()].slice(-MAX_HISTORY);
    checkArrays(queue, archived);
    return { queue, history: archived };
  }
  async function conditionalWrite(state, etag) {
    let result;
    try { result = await store.set(STATE_KEY, JSON.stringify(state), etag === null ? { onlyIfNew: true } : { onlyIfMatch: etag }); }
    catch (_) { fail('WRITE_UNCERTAIN', 'The command write could not be confirmed. Do not automatically replay this request.'); }
    if (!result || (result.modified !== true && result.modified !== false)) fail('WRITE_UNCERTAIN', 'Command storage returned no valid write receipt.');
    if (result.modified === false) return null;
    if (!validETag(result.etag)) fail('WRITE_UNCERTAIN', 'Command storage returned no write version receipt.');
    return result.etag;
  }
  async function load() {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const existing = await readBlob(store, STATE_KEY);
      if (existing) {
        const state = checkState(existing.data, migrateLegacy);
        await verifyFence(state);
        return { state, etag: existing.etag };
      }
      const first = await readSources();
      const second = await readSources();
      if (canonical(fingerprints(first)) !== canonical(fingerprints(second))) continue;
      const merged = mergeSources(second);
      const state = { schema: 1, revision: randomId(), ...merged, migration: { sources: fingerprints(second) }, requestReceipts: [] };
      checkState(state, migrateLegacy);
      let etag;
      try { etag = await conditionalWrite(state, null); }
      catch (error) {
        const observed = await readBlob(store, STATE_KEY);
        if (observed && observed.data.revision === state.revision) { await verifyFence(checkState(observed.data, migrateLegacy)); return { state: observed.data, etag: observed.etag }; }
        throw error;
      }
      if (etag !== null) { await verifyFence(state); return { state, etag }; }
    }
    fail('CONFLICT', 'Command storage is busy; retry this request later.', 409);
  }
  function receipt(state, etag, options = {}) { return { schema: 1, revision: state.revision, etag, migrated: true, ...options }; }
  function response(state, etag, result, options, includeResult) {
    const output = { queue: clone(state.queue), history: clone(state.history), receipt: receipt(state, etag, options) };
    if (includeResult) output.result = clone(result);
    return output;
  }
  async function snapshot() {
    const { state, etag } = await load();
    return response(state, etag, null, {}, false);
  }
  async function transact(mutator, { requestId, requestFingerprint } = {}) {
    if (typeof mutator !== 'function') fail('INVALID_REQUEST', 'A command transaction is required.', 400);
    if (requestId !== undefined && (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 300)) fail('INVALID_REQUEST', 'The request ID is invalid.', 400);
    if (requestFingerprint !== undefined && (typeof requestFingerprint !== 'string' || !requestFingerprint || requestFingerprint.length > 32768)) fail('INVALID_REQUEST', 'The request fingerprint is invalid.', 400);
    const fingerprint = requestFingerprint === undefined ? null : requestFingerprint;
    // Internal receipts also protect older clients that do not send request_id:
    // the SDK may retry a committed conditional PUT and then return a conflict.
    const operationId = requestId || 'internal:' + randomId();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const { state, etag } = await load();
      const previous = state.requestReceipts.find(entry => entry.requestId === operationId);
      if (previous) {
        if ((previous.fingerprint === undefined ? null : previous.fingerprint) !== fingerprint) fail('REQUEST_ID_REUSED', 'This request ID was already used for a different action.', 409);
        return response(state, etag, previous.result, requestId ? { request_id: requestId, replayed: true } : { replayed: true }, true);
      }
      const draft = { queue: clone(state.queue), history: clone(state.history) };
      const result = mutator(draft);
      if (result && typeof result.then === 'function') fail('INVALID_REQUEST', 'Command transactions must be synchronous.', 400);
      const safeResult = result === undefined ? null : clone(result);
      draft.history = draft.history.slice(-MAX_HISTORY);
      checkArrays(draft.queue, draft.history);
      const archived = new Set(draft.history.map(entry => entry.id));
      for (const old of state.queue) if (!draft.queue.some(entry => entry.id === old.id) && !archived.has(old.id)) fail('INVALID_TRANSITION', 'Removing a pending command requires a saved history record.', 409);
      if (!requestId && canonical(draft) === canonical({ queue: state.queue, history: state.history })) return response(state, etag, safeResult, {}, true);
      const next = { ...state, ...draft, revision: randomId(), requestReceipts: clone(state.requestReceipts) };
      next.requestReceipts.push({ requestId: operationId, fingerprint, result: safeResult, revision: next.revision, at: now() });
      next.requestReceipts = next.requestReceipts.slice(-MAX_RECEIPTS);
      checkState(next, migrateLegacy);
      try {
        const writtenETag = await conditionalWrite(next, etag);
        if (writtenETag === null) continue;
        await verifyFence(next);
        return response(next, writtenETag, safeResult, requestId ? { request_id: requestId, replayed: false } : {}, true);
      } catch (error) {
        // A transport timeout may follow a committed write. Reconcile using the
        // revision/receipt, never by repeating the mutator after an unknown write.
        let observed;
        try { observed = await readBlob(store, STATE_KEY); if (observed) { checkState(observed.data, migrateLegacy); await verifyFence(observed.data); } }
        catch (_) { throw error; }
        const committed = observed && (observed.data.revision === next.revision || observed.data.requestReceipts.some(entry => entry.requestId === operationId && entry.revision === next.revision));
        if (committed) return response(observed.data, observed.etag, safeResult, requestId ? { request_id: requestId, replayed: false } : {}, true);
        throw error;
      }
    }
    fail('CONFLICT', 'Command storage is busy; retry this request later.', 409);
  }
  return { snapshot, transact };
}

function openControlCommandStore({ getStore, event, env = process.env, fetch: baseFetch = globalThis.fetch } = {}) {
  if (typeof getStore !== 'function') fail('CONFIGURATION', 'Command storage is unavailable.');
  const context = deployment.context || env.CONTEXT;
  const deployID = deployment.deployID || env.DEPLOY_ID;
  const preview = context === 'deploy-preview' || context === 'branch-deploy';
  if (context !== 'production' && !preview) fail('DEPLOYMENT_CONTEXT', 'Command controls require a verified deployment context.');
  if (preview && (typeof deployID !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(deployID))) fail('DEPLOYMENT_CONTEXT', 'Preview command controls require an isolated deployment ID.');
  const checkedFetch = strictFetch(baseFetch);
  let provider = {};
  if (event && event.blobs) {
    try {
      const data = JSON.parse(Buffer.from(event.blobs, 'base64').toString('utf8'));
      const headers = event.headers || {};
      const siteID = headers['x-nf-site-id'] || headers['X-Nf-Site-Id'];
      if (typeof data.token !== 'string' || !data.token || typeof siteID !== 'string' || !siteID) throw new Error('Invalid provider context');
      provider = { siteID, token: data.token };
    } catch (_) { fail('CONFIGURATION', 'The provider command storage context is unavailable.'); }
  }
  const name = preview ? 'cp-commands-isolated-' + context + '-' + deployID : 'cp-commands';
  const store = getStore({ name, ...provider, consistency: 'strong', fetch: checkedFetch });
  const legacyStore = preview ? undefined : getStore({ name: 'cluster-control', ...provider, consistency: 'strong', fetch: checkedFetch });
  return createControlCommandStore({ store, legacyStore, migrateLegacy: !preview });
}

module.exports = { STATE_KEY, CommandStoreError, strictFetch, createControlCommandStore, openControlCommandStore };
