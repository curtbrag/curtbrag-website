'use strict';

const deployment = require('./control-deployment.cjs');
const { strictFetch, CommandStoreError } = require('./control-command-store.cjs');
const INPUT_FIELDS = new Set(['action', 'controller_id', 'name', 'model', 'private_ip', 'adb_connect_port', 'adb_guid']);
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const GUID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const NAME = /^[\p{L}\p{N}\p{M} ._'’()/-]+$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9 ._()-]*$/;

class PersonalControllerError extends CommandStoreError {
  constructor(code, message, statusCode = 503) {
    super(code, message, statusCode);
    this.name = 'PersonalControllerError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
function fail(code, message, statusCode) { throw new PersonalControllerError(code, message, statusCode); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value, max, pattern) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && pattern.test(value);
}
function privateIPv4(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return false;
  const bytes = value.split('.').map(Number);
  return bytes.every(byte => byte <= 255) &&
    (bytes[0] === 10 || (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31) || (bytes[0] === 192 && bytes[1] === 168));
}
function metadata(input, stored = false) {
  const status = stored ? 503 : 400;
  if (!object(input) || (!stored && Object.keys(input).some(key => !INPUT_FIELDS.has(key))) ||
      (!stored && input.action !== undefined && input.action !== 'register-personal-controller') ||
      !text(input.controller_id, 64, ID) || !text(input.name, 80, NAME) || !text(input.model, 64, MODEL) ||
      !privateIPv4(input.private_ip) || typeof input.adb_connect_port !== 'number' ||
      !Number.isInteger(input.adb_connect_port) || input.adb_connect_port < 1 || input.adb_connect_port > 65535 ||
      (input.adb_guid !== undefined && input.adb_guid !== null && !text(input.adb_guid, 160, GUID))) {
    fail('INVALID_CONTROLLER', stored ? 'Personal controller inventory contains invalid metadata.' : 'Provide a valid controller ID, name, model, private IPv4 address and numeric connection port.', status);
  }
  return {
    controller_id: input.controller_id, name: input.name, model: input.model,
    private_ip: input.private_ip, adb_connect_port: input.adb_connect_port, adb_guid: input.adb_guid ?? null,
  };
}
function savedRecord(value, id) {
  const fields = metadata(value, true);
  if (fields.controller_id !== id || value.role !== 'personal-controller' || value.worker_enabled !== false || value.mining_enabled !== false ||
      !Number.isSafeInteger(value.registered_at) || value.registered_at <= 0 || value.registered_at > 8640000000000000) {
    fail('INVALID_CONTROLLER', 'Personal controller inventory contains invalid metadata.');
  }
  return { ...fields, role: 'personal-controller', worker_enabled: false, mining_enabled: false, registered_at: value.registered_at };
}
function sameMetadata(record, fields) { return JSON.stringify(metadata(record, true)) === JSON.stringify(fields); }
function receiptETag(value) { return typeof value === 'string' && value.trim().length > 0; }

function createPersonalControllerRegistry({ store, now = Date.now } = {}) {
  if (!store || typeof store.getWithMetadata !== 'function' || typeof store.set !== 'function' || typeof store.list !== 'function') {
    fail('CONFIGURATION', 'Personal controller inventory is unavailable.');
  }
  async function read(id) {
    let response;
    try { response = await store.getWithMetadata(id, { type: 'json', consistency: 'strong' }); }
    catch (_) { fail('READ_FAILED', 'Personal controller inventory could not be read.'); }
    if (response === null) return null;
    if (!object(response) || response.data === null || !receiptETag(response.etag)) fail('READ_FAILED', 'Personal controller inventory returned an incomplete read receipt.');
    return savedRecord(response.data, id);
  }
  async function list() {
    let entries;
    try { entries = await store.list(); }
    catch (_) { fail('READ_FAILED', 'Personal controller inventory could not be read.'); }
    if (!entries || !Array.isArray(entries.blobs) || entries.cursor) {
      fail('READ_FAILED', 'Personal controller inventory returned an incomplete list.');
    }
    const seen = new Set(), records = [];
    for (const entry of entries.blobs) {
      if (!entry || !text(entry.key, 64, ID) || seen.has(entry.key)) fail('READ_FAILED', 'Personal controller inventory contains invalid entries.');
      seen.add(entry.key);
      const record = await read(entry.key);
      if (!record) fail('READ_FAILED', 'Personal controller inventory changed while being read. Refresh it.');
      records.push(record);
    }
    return records.sort((a, b) => a.registered_at - b.registered_at || a.controller_id.localeCompare(b.controller_id));
  }
  function existingResult(record, fields) {
    if (!sameMetadata(record, fields)) fail('CONTROLLER_CONFLICT', 'This controller ID is already registered with different details.', 409);
    return { ok: true, created: false, controller: record };
  }
  async function register(input) {
    const fields = metadata(input), existing = await read(fields.controller_id);
    if (existing) return existingResult(existing, fields);
    const registeredAt = now();
    if (!Number.isSafeInteger(registeredAt) || registeredAt <= 0 || registeredAt > 8640000000000000) fail('CONFIGURATION', 'Personal controller registration time is unavailable.');
    const record = { ...fields, role: 'personal-controller', worker_enabled: false, mining_enabled: false, registered_at: registeredAt };
    let result;
    try { result = await store.set(fields.controller_id, JSON.stringify(record), { onlyIfNew: true }); }
    catch (_) {
      // A response may be lost after creation. Reconcile without overwriting or
      // inventing a new timestamp, and never replay a physical device command.
      const observed = await read(fields.controller_id);
      if (observed) return existingResult(observed, fields);
      fail('WRITE_FAILED', 'Personal controller registration could not be confirmed. Retry the same details.');
    }
    if (!result || (result.modified !== true && result.modified !== false)) fail('WRITE_FAILED', 'Personal controller registration returned an incomplete write receipt.');
    if (result.modified === false) {
      const observed = await read(fields.controller_id);
      if (observed) return existingResult(observed, fields);
      fail('WRITE_FAILED', 'Personal controller registration could not be confirmed. Retry the same details.');
    }
    if (!receiptETag(result.etag)) fail('WRITE_FAILED', 'Personal controller registration returned no write version receipt.');
    return { ok: true, created: true, controller: record };
  }
  return { list, register };
}

function openPersonalControllerRegistry({ getStore, event, providerContext, env = process.env, fetch: baseFetch = globalThis.fetch } = {}) {
  const context = deployment.context || env.CONTEXT, deployID = deployment.deployID || env.DEPLOY_ID;
  const preview = context === 'deploy-preview' || context === 'branch-deploy';
  if (typeof getStore !== 'function' || (context !== 'production' && !preview) ||
      (preview && (typeof deployID !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(deployID)))) {
    fail('CONFIGURATION', 'Personal controller inventory requires a verified deployment context.');
  }
  let provider = {};
  if (providerContext !== undefined) {
    if (!object(providerContext) || ['siteID', 'token', 'edgeURL', 'uncachedEdgeURL'].some(key => typeof providerContext[key] !== 'string' || !providerContext[key])) {
      fail('CONFIGURATION', 'The complete provider inventory context is unavailable.');
    }
    provider = { siteID: providerContext.siteID, token: providerContext.token, edgeURL: providerContext.edgeURL, uncachedEdgeURL: providerContext.uncachedEdgeURL };
  } else if (event && event.blobs) {
    fail('CONFIGURATION', 'The provider did not supply a complete inventory context.');
  }
  const name = preview ? 'cp-personal-controllers-isolated-' + context + '-' + deployID : 'cp-personal-controllers';
  let store;
  try { store = getStore({ name, ...provider, consistency: 'strong', fetch: strictFetch(baseFetch) }); }
  catch (_) { fail('CONFIGURATION', 'Personal controller inventory is unavailable.'); }
  return createPersonalControllerRegistry({ store });
}

module.exports = { PersonalControllerError, createPersonalControllerRegistry, openPersonalControllerRegistry };
