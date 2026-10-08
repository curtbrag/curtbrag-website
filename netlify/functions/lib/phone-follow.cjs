'use strict';

const crypto = require('node:crypto');
const deployment = require('./control-deployment.cjs');
const { strictFetch, CommandStoreError } = require('./control-command-store.cjs');
const STATE_KEY = 'follow-state-v1';
const SOURCE = 'curtis-s26-ultra';
const LEASE = 60 * 60 * 1000;
const MAX_RECEIPTS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = value => typeof value === 'string' && UUID.test(value);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const UNITS = new Set(['phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254','Alina','Nexus','SteamDeck','viki','RenderRig']);
const UNIT_STATUS = new Set(['queued','launch-requested','failed','skipped','unconfirmed']);
const PRIVATE_KEYS = new Set(['token','tokens','auth','password','accesstoken','authorization','secret','session','code','key']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
const etag = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => JSON.parse(JSON.stringify(value));
function fail(code, message, statusCode = 503) { throw new CommandStoreError(code, message, statusCode); }
function boundedText(value, limit) { return typeof value === 'string' && value.length <= limit && !/[\x00-\x1f\x7f<>]/.test(value); }
function fields(input, allowed, action) {
  if (!object(input) || Object.keys(input).some(key => !allowed.includes(key)) || (input.action !== undefined && input.action !== action)) {
    fail('INVALID_FOLLOW_REQUEST', 'Provide only the supported following settings.', 400);
  }
}
function safeId(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && SAFE_ID.test(value); }
function validateFollowUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) fail('PRIVATE_FOLLOW_URL', 'Only a public HTTPS website can be followed.', 400);
  let page;
  try { page = new URL(value); } catch (_) { fail('PRIVATE_FOLLOW_URL', 'Only a public HTTPS website can be followed.', 400); }
  const host = page.hostname.toLowerCase();
  if (page.protocol !== 'https:' || page.username || page.password || page.port || page.href.length > 2048 || host.length > 253 || host.split('.').some(label => label.length > 63) || host.endsWith('.') ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host) || /^[\d.]+$/.test(host) || /^\d+$/.test(host.split('.').at(-1)) ||
      ['localhost','local','localdomain','lan','internal','test','invalid','onion','example','home'].some(suffix => host === suffix || host.endsWith('.' + suffix))) {
    fail('PRIVATE_FOLLOW_URL', 'Only a public HTTPS website can be followed.', 400);
  }
  let path;
  try { path = decodeURIComponent(page.pathname).toLowerCase(); } catch (_) { fail('PRIVATE_FOLLOW_URL', 'This website address cannot be followed.', 400); }
  const authPath = candidate => candidate.split('/').some(segment => ['login','signin','sign-in','auth','authenticate','authentication','oauth','oauth2'].includes(segment));
  if (authPath(path) ||
      (['curtbrag.com','www.curtbrag.com'].includes(host) && /^\/cluster\/(control|dashboard)(?:\/|$)/.test(path))) {
    fail('PRIVATE_FOLLOW_URL', 'Sign-in and controller pages are excluded from following.', 400);
  }
  const credentialKey = key => PRIVATE_KEYS.has(key.toLowerCase().replace(/[^a-z]/g, ''));
  for (const key of page.searchParams.keys()) if (credentialKey(key)) fail('PRIVATE_FOLLOW_URL', 'Addresses containing credential fields are excluded from following.', 400);
  const fragment = page.hash.slice(1).replace(/^\?/, ''), fragmentQuery = fragment.includes('?') ? fragment.slice(fragment.indexOf('?') + 1) : fragment;
  let fragmentPath;
  try { fragmentPath = decodeURIComponent(fragment.split('?')[0]).toLowerCase(); } catch (_) { fail('PRIVATE_FOLLOW_URL', 'This website address cannot be followed.', 400); }
  if (authPath(fragmentPath)) fail('PRIVATE_FOLLOW_URL', 'Sign-in pages are excluded from following.', 400);
  for (const key of new URL('https://fragment.invalid/?' + fragmentQuery).searchParams.keys()) if (credentialKey(key)) fail('PRIVATE_FOLLOW_URL', 'Addresses containing credential fields are excluded from following.', 400);
  return page.href;
}
function navigation(value) {
  if (value === null) return null;
  if (!object(value) || Object.keys(value).some(key => !['id','units'].includes(key)) || !safeId(value.id, 120) || !Array.isArray(value.units) || value.units.length > UNITS.size) {
    fail('INVALID_FOLLOW_REPORT', 'The following report is invalid.', 400);
  }
  const seen = new Set();
  const units = value.units.map(unit => {
    if (!object(unit) || Object.keys(unit).some(key => !['device_id','status','job_id','message'].includes(key)) || !UNITS.has(unit.device_id) || seen.has(unit.device_id) || !UNIT_STATUS.has(unit.status) ||
        (unit.job_id !== undefined && !safeId(unit.job_id, 220)) || (unit.message !== undefined && !boundedText(unit.message, 240))) fail('INVALID_FOLLOW_REPORT', 'The following report is invalid.', 400);
    seen.add(unit.device_id);
    return { device_id: unit.device_id, status: unit.status, ...(unit.job_id !== undefined ? { job_id: unit.job_id } : {}), ...(unit.message !== undefined ? { message: unit.message } : {}) };
  });
  return { id: value.id, units };
}
function blank() {
  return { schema: 1, active: false, session_id: null, controller_id: null, expires_at: null, started_at: null, stopped_at: null,
    runner: { status: 'off', message: 'Following is off.', seen_at: null }, current_url: null, current_navigation: null, request_receipts: [] };
}
function checkState(value) {
  if (!object(value) || Object.keys(value).some(key => !['schema','active','session_id','controller_id','expires_at','started_at','stopped_at','runner','current_url','current_navigation','request_receipts'].includes(key)) ||
      value.schema !== 1 || typeof value.active !== 'boolean' || !Array.isArray(value.request_receipts) || value.request_receipts.length > MAX_RECEIPTS + 1 || (value.active && value.request_receipts.length > MAX_RECEIPTS) ||
      !object(value.runner) || Object.keys(value.runner).some(key => !['status','message','seen_at'].includes(key)) || !['off','waiting','following','unavailable'].includes(value.runner.status) || !boundedText(value.runner.message, 240) ||
      (value.runner.seen_at !== null && !timestamp(value.runner.seen_at)) ||
      (value.session_id !== null && !uuid(value.session_id)) || (value.controller_id !== null && value.controller_id !== SOURCE) ||
      [value.expires_at,value.started_at,value.stopped_at].some(time => time !== null && !timestamp(time)) ||
      (value.active && (!value.session_id || value.controller_id !== SOURCE || !timestamp(value.started_at) || value.expires_at !== value.started_at + LEASE || value.stopped_at !== null || value.runner.status === 'off')) ||
      (!value.active && (value.current_url !== null || value.current_navigation !== null))) fail('INVALID_FOLLOW_STATE', 'Following state is unavailable.');
  const seen = new Set();
  for (const receipt of value.request_receipts) {
    if (!object(receipt) || Object.keys(receipt).some(key => !['request_id','kind','session_id'].includes(key)) || !uuid(receipt.request_id) || seen.has(receipt.request_id) || !['start','stop'].includes(receipt.kind) ||
        (receipt.session_id !== null && !uuid(receipt.session_id))) fail('INVALID_FOLLOW_STATE', 'Following request receipts are invalid.');
    seen.add(receipt.request_id);
  }
  try {
    if (value.current_url !== null) validateFollowUrl(value.current_url);
    if (value.current_navigation !== null) navigation(value.current_navigation);
  } catch (_) { fail('INVALID_FOLLOW_STATE', 'Following state contains invalid metadata.'); }
  return clone(value);
}
function stopState(state, time, message) {
  state.active = false; state.stopped_at = time; state.current_url = null; state.current_navigation = null;
  state.runner = { status: 'off', message, seen_at: null };
}
function publicFollow(state) {
  const { active,session_id,controller_id,expires_at,started_at,stopped_at,runner,current_url,current_navigation } = state;
  return clone({ active,session_id,controller_id,expires_at,started_at,stopped_at,runner,current_url,current_navigation });
}
function createPhoneFollow({ store, controllers, now = Date.now, randomId = () => crypto.randomUUID(), maxAttempts = 5 } = {}) {
  if (!store || typeof store.getWithMetadata !== 'function' || typeof store.set !== 'function' || !controllers || typeof controllers.list !== 'function' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) fail('CONFIGURATION', 'Following storage is unavailable.');
  async function read() {
    let response;
    try { response = await store.getWithMetadata(STATE_KEY, { type: 'json', consistency: 'strong' }); }
    catch (_) { fail('FOLLOW_READ_FAILED', 'Following state could not be checked.'); }
    if (response === null) return { state: blank(), etag: null };
    if (!object(response) || !etag(response.etag) || response.data === null) fail('FOLLOW_READ_FAILED', 'Following state returned an incomplete read receipt.');
    return { state: checkState(response.data), etag: response.etag };
  }
  async function transact(mutator, requestId = null) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const snapshot = await read(), state = clone(snapshot.state), time = now();
      if (!timestamp(time)) fail('CONFIGURATION', 'Following time is unavailable.');
      if (state.active && state.expires_at <= time) stopState(state, state.expires_at, 'The following session expired.');
      mutator(state, time);
      checkState(state);
      if (JSON.stringify(state) === JSON.stringify(snapshot.state)) return { ok: true, follow: publicFollow(state) };
      let receipt;
      try { receipt = await store.set(STATE_KEY, JSON.stringify(state), snapshot.etag ? { onlyIfMatch: snapshot.etag } : { onlyIfNew: true }); }
      catch (_) {
        // Lost responses are reconciled with strong state, never by blindly
        // repeating a Start or restoring an old active session.
        const observed = await read();
        if (requestId) {
          const expected = state.request_receipts.find(item => item.request_id === requestId), actual = observed.state.request_receipts.find(item => item.request_id === requestId);
          if (actual && JSON.stringify(actual) === JSON.stringify(expected)) return { ok: true, follow: publicFollow(observed.state) };
          if (actual) fail('FOLLOW_REQUEST_CONFLICT', 'This request ID was already used for another action.', 409);
        }
        if (JSON.stringify(observed.state) === JSON.stringify(state)) return { ok: true, follow: publicFollow(state) };
        fail('FOLLOW_WRITE_FAILED', 'Following state could not be confirmed. Retry the same request.');
      }
      if (!receipt || (receipt.modified !== true && receipt.modified !== false)) fail('FOLLOW_WRITE_FAILED', 'Following state returned an incomplete write receipt.');
      if (receipt.modified === false) continue;
      if (!etag(receipt.etag)) fail('FOLLOW_WRITE_FAILED', 'Following state returned no write version.');
      return { ok: true, follow: publicFollow(state) };
    }
    fail('FOLLOW_CONFLICT', 'Following state changed. Refresh and retry the same request.', 409);
  }
  function request(input, kind) {
    fields(input, kind === 'start' ? ['action','controller_id','duration_minutes','request_id'] : ['action','request_id'], 'phone-follow-' + kind);
    if (!uuid(input.request_id) || (kind === 'start' && (input.controller_id !== SOURCE || input.duration_minutes !== 60))) fail('INVALID_FOLLOW_REQUEST', 'Use the registered S26 controller and a one-hour following session with a request ID.', 400);
    return input.request_id.toLowerCase();
  }
  function replay(state, id, kind) {
    const previous = state.request_receipts.find(item => item.request_id === id);
    if (previous && previous.kind !== kind) fail('FOLLOW_REQUEST_CONFLICT', 'This request ID was already used for another action.', 409);
    return !!previous;
  }
  async function start(input) {
    const id = request(input, 'start');
    const inventory = await controllers.list();
    if (!Array.isArray(inventory) || !inventory.some(record => record.controller_id === SOURCE && record.role === 'personal-controller' && record.worker_enabled === false && record.mining_enabled === false)) fail('FOLLOW_SOURCE_NOT_REGISTERED', 'Add the S26 as a personal controller before following.', 409);
    const session = randomId();
    if (!uuid(session)) fail('CONFIGURATION', 'A following session could not be created.');
    return transact((state, time) => {
      if (replay(state, id, 'start')) return;
      // Keep one receipt slot reserved for Stop. Never evict old Start IDs,
      // which could allow an old request to reactivate a stopped session.
      if (state.request_receipts.length >= MAX_RECEIPTS - 1) fail('FOLLOW_REQUEST_CAPACITY', 'Following request storage is full. Stop remains available.', 409);
      if (!state.active) Object.assign(state, { active: true, session_id: session, controller_id: SOURCE, started_at: time, expires_at: time + LEASE, stopped_at: null,
        runner: { status: 'waiting', message: 'Waiting for the main PC follower.', seen_at: null }, current_url: null, current_navigation: null });
      state.request_receipts.push({ request_id: id, kind: 'start', session_id: state.session_id });
    }, id);
  }
  async function stop(input) {
    const id = request(input, 'stop');
    return transact((state, time) => {
      if (replay(state, id, 'stop')) return;
      if (!state.active && state.request_receipts.length >= MAX_RECEIPTS) return;
      if (state.active) stopState(state, time, 'Stopped. Waiting for runner confirmation.');
      state.request_receipts.push({ request_id: id, kind: 'stop', session_id: state.session_id });
    }, id);
  }
  async function runnerUpdate(input) {
    fields(input, ['action','session_id','status','message','current_url','current_navigation'], 'phone-follow-runner-update');
    if (!['off','waiting','following','unavailable'].includes(input.status) || !boundedText(input.message, 240) || (input.session_id !== null && !uuid(input.session_id))) fail('INVALID_FOLLOW_REPORT', 'The follower update is invalid.', 400);
    const url = input.current_url === undefined || input.current_url === null ? null : validateFollowUrl(input.current_url);
    const report = input.current_navigation === undefined ? undefined : navigation(input.current_navigation);
    return transact((state, time) => {
      if (!state.active) {
        if (input.session_id !== null || input.status !== 'off' || (input.current_url !== undefined && input.current_url !== null) || (input.current_navigation !== undefined && input.current_navigation !== null)) fail('FOLLOW_SESSION_INACTIVE', 'The following session is off or expired.', 409);
        state.runner = { status: 'off', message: input.message, seen_at: time };
        return;
      }
      if (input.session_id !== state.session_id || input.status === 'off') fail('FOLLOW_SESSION_STALE', 'The following session changed. Refresh before sending another update.', 409);
      state.runner = { status: input.status, message: input.message, seen_at: time };
      if (input.current_url !== undefined) state.current_url = url;
      if (report !== undefined) state.current_navigation = report;
    });
  }
  return { status: () => transact(() => {}), start, stop, runnerUpdate };
}
function openPhoneFollow({ getStore, event, providerContext, controllers, env = process.env, fetch: baseFetch = globalThis.fetch } = {}) {
  const context = deployment.context || env.CONTEXT, deployID = deployment.deployID || env.DEPLOY_ID;
  const preview = context === 'deploy-preview' || context === 'branch-deploy';
  if (typeof getStore !== 'function' || (context !== 'production' && !preview) || (preview && (typeof deployID !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(deployID)))) fail('CONFIGURATION', 'Following requires a verified deployment context.');
  let provider = {};
  if (providerContext !== undefined) {
    if (!object(providerContext) || ['siteID','token','edgeURL','uncachedEdgeURL'].some(key => typeof providerContext[key] !== 'string' || !providerContext[key])) fail('CONFIGURATION', 'The complete provider following context is unavailable.');
    provider = { siteID: providerContext.siteID, token: providerContext.token, edgeURL: providerContext.edgeURL, uncachedEdgeURL: providerContext.uncachedEdgeURL };
  } else if (event && event.blobs) fail('CONFIGURATION', 'The complete provider following context is unavailable.');
  const name = preview ? 'cp-phone-follow-isolated-' + context + '-' + deployID : 'cp-phone-follow';
  let store;
  try { store = getStore({ name, ...provider, consistency: 'strong', fetch: strictFetch(baseFetch) }); }
  catch (_) { fail('CONFIGURATION', 'Following storage is unavailable.'); }
  return createPhoneFollow({ store, controllers });
}
module.exports = { createPhoneFollow, openPhoneFollow, validateFollowUrl };
