'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../public/scripts/cluster-phone-follow.js'), 'utf8');
const NOW = 1791475200000;
const TARGETS = ['phone173', 'phone174', 'phone176', 'phone177', 'phone191', 'phone195', 'phone253', 'phone254', 'Alina', 'Nexus', 'SteamDeck', 'viki', 'RenderRig'];
const off = overrides => ({ active: false, session_id: null, controller_id: null, expires_at: null, started_at: null, stopped_at: null, runner: { status: 'off', message: 'Following is off.', seen_at: null }, current_url: null, current_navigation: null, ...overrides });
const saved = overrides => ({ active: true, session_id: 'c79bca75-e691-4e39-9542-e1ae943e2780', controller_id: 'curtis-s26-ultra', expires_at: NOW + 3600000, started_at: NOW, stopped_at: null, runner: { status: 'waiting', message: 'Waiting for the home PC.', seen_at: null }, current_url: null, current_navigation: null, ...overrides });
const reply = follow => ({ ok: true, follow });
const pending = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(options = {}) {
  const calls = [], forbidden = [], observers = [], observerQueue = new Set(), timers = new Map();
  let now = NOW, nextTimer = 0, nextUUID = 0;
  const inside = (node, root) => { for (; node; node = node.parentElement) if (node === root) return true; return false; };
  function mutation(node, kind, name) {
    for (const observer of observers) for (const target of observer.targets) if ((target.node === node || (target.options.subtree && inside(node, target.node))) && target.options[kind] && (kind !== 'attributes' || !target.options.attributeFilter || target.options.attributeFilter.includes(name))) observerQueue.add(observer);
  }
  class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(name, handler) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(handler); }
    async emit(name, event = {}) { for (const handler of this.listeners.get(name) || []) await handler(event); }
  }
  class Element extends Events {
    constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; this._text = ''; this.hidden = false; this.disabled = false; }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
    set textContent(value) { this._text = String(value); for (const child of this.children) child.parentElement = null; this.children = []; mutation(this, 'childList'); }
    set innerHTML(value) { forbidden.push('innerHTML'); throw new Error('HTML injection forbidden'); }
    get innerHTML() { forbidden.push('innerHTML'); throw new Error('HTML injection forbidden'); }
    get firstElementChild() { return this.children[0] || null; }
    get nextElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } mutation(this, 'childList'); }
    insertAdjacentElement(where, node) { assert.equal(where, 'afterend'); const parent = this.parentElement; node.parentElement = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, node); mutation(parent, 'childList'); }
    setAttribute(name, value) { this.attributes[name] = String(value); mutation(this, 'attributes', name); }
    removeAttribute(name) { delete this.attributes[name]; if (name === 'href') delete this.href; mutation(this, 'attributes', name); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    async click() { if (!this.disabled) await this.emit('click'); }
  }
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(node, config) { this.targets.push({ node, options: config }); }
    disconnect() { this.targets = []; observerQueue.delete(this); }
  }
  const make = (tag, id, text = '') => { const node = new Element(tag); node.id = id; node.textContent = text; return node; };
  const find = (node, id) => { if (node.id === id) return node; for (const child of node.children) { const found = find(child, id); if (found) return found; } return null; };
  const document = new Events(); document.body = new Element('body'); document.readyState = options.loading ? 'loading' : 'complete'; document.hidden = !!options.hidden;
  document.getElementById = id => find(document.body, id); document.createElement = tag => new Element(tag);
  const panel = make('div', 'panel'); panel.style.display = options.signedOut ? 'none' : 'block';
  const workspace = make('div', 'tab-swarm'); panel.append(workspace); document.body.append(panel);
  let fleet, grid;
  const addFleet = () => {
    if (fleet) return;
    fleet = make('section', 'cluster-view-fleet');
    const workers = make('div', 'existing-workers'); grid = make('div', 'swarm-nodes');
    for (const id of TARGETS) grid.append(make('div', null, id));
    workers.append(grid); const controllers = make('section', 'personal-controller-fleet', 'Saved S26 controller');
    fleet.append(workers, controllers); workspace.append(make('span', 'swarm-nodes-online', '13 / 13'), make('select', 'swarm-job-device', 'all worker targets'), fleet);
  };
  if (!options.lateFleet) addFleet();
  const window = new Events(); window.getComputedStyle = node => ({ display: node.style.display || 'block' });
  window.crypto = options.noUUID ? {} : { randomUUID: () => { if (options.badUUID) throw new Error('UUID unavailable.'); return 'cb555166-a06b-4074-bc52-' + String(++nextUUID).padStart(12, '0'); } };
  window.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay, delay }); return id; };
  window.clearTimeout = id => { timers.delete(id); };
  let api = options.api || (async () => reply(off()));
  window.callApi = async (...args) => { calls.push(structuredClone(args)); return api(...args); };
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = { window, document, location: { pathname: options.pathname || '/cluster/dashboard/', search: options.search || '' }, URL, URLSearchParams, MutationObserver: Observer, Date: ClockDate, Error };
  for (const key of ['fetch', 'localStorage', 'sessionStorage', 'XMLHttpRequest', 'WebSocket']) Object.defineProperty(context, key, { get() { forbidden.push(key); throw new Error('Forbidden ' + key); } });
  vm.runInNewContext(source, context);
  const get = id => document.getElementById(id);
  const flush = () => { let cycles = 0; while (observerQueue.size) { assert.ok(++cycles < 20, 'No observer loop'); const batch = [...observerQueue]; observerQueue.clear(); for (const observer of batch) if (observer.targets.length) observer.callback([]); } return cycles; };
  const settle = async () => { let cycles = 0; for (let index = 0; index < 6; index++) { await Promise.resolve(); cycles += flush(); } return cycles; };
  const advance = async milliseconds => { const until = now + milliseconds; let count = 0; while (true) { const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; assert.ok(++count < 100, 'No timer storm'); now = next[1].at; timers.delete(next[0]); next[1].callback(); await settle(); } now = until; await settle(); };
  const setSignedIn = visible => { panel.style.display = visible ? 'block' : 'none'; mutation(panel, 'attributes', 'style'); flush(); };
  const setHidden = async value => { document.hidden = value; await document.emit('visibilitychange'); await settle(); };
  const workersUpdate = () => { grid.textContent = ''; for (const id of TARGETS) grid.append(make('div', null, 'updated ' + id)); flush(); };
  return { get, calls, forbidden, observers, timers, window, document, addFleet, flush, settle, advance, setSignedIn, setHidden, workersUpdate, setApi: value => { api = value; } };
}

test('signed-out dashboard mounts OFF controls without reading, starting or polling', async () => {
  const h = fixture({ signedOut: true }); await h.settle(); await h.advance(120000);
  assert.deepEqual(h.calls, []); assert.equal(h.timers.size, 0); assert.equal(h.get('phone-follow-badge').textContent, 'OFF');
  assert.equal(h.get('phone-follow-start').disabled, true); assert.equal(h.get('phone-follow-stop').disabled, true); assert.deepEqual(h.forbidden, []);
});
test('both normal and personal dashboards mount after controller card and check status without starting', async () => {
  for (const search of ['', '?controller=personal']) {
    const h = fixture({ search }); await h.settle();
    assert.equal(h.get('personal-controller-fleet').nextElementSibling.id, 'phone-follow-control');
    assert.deepEqual(h.calls, [['phone-follow-status']]); assert.equal(h.get('phone-follow-start').disabled, false); assert.equal(h.get('phone-follow-stop').disabled, true);
    assert.equal(h.get('swarm-nodes').children.length, 13); assert.equal(h.get('swarm-nodes-online').textContent, '13 / 13'); assert.equal(h.get('swarm-job-device').textContent, 'all worker targets');
  }
});
test('helper stays out of landing, physical-display pages and other routes', () => {
  for (const pathname of ['/cluster/control/', '/cluster/display.html', '/cluster/dashboard/extra', '/']) {
    const h = fixture({ pathname }); assert.equal(h.get('phone-follow-control'), null); assert.deepEqual(h.calls, []); assert.equal(h.window.listeners.size, 0);
  }
});
test('sign-in and late Fleet construction cause one read without observer feedback or automatic POST', async () => {
  const h = fixture({ signedOut: true, lateFleet: true }); h.setSignedIn(true); await h.settle(); assert.deepEqual(h.calls, []);
  h.addFleet(); assert.ok((await h.settle()) < 5); h.workersUpdate(); h.workersUpdate(); await h.settle();
  assert.deepEqual(h.calls, [['phone-follow-status']]); assert.equal(h.get('cluster-view-fleet').children.filter(node => node.id === 'phone-follow-control').length, 1);
});
test('explicit Start sends one cryptographic UUID request for S26 and exactly 60 minutes', async () => {
  const wait = pending(); const h = fixture(); await h.settle(); h.setApi(() => wait.promise);
  const start = h.get('phone-follow-start').click(); await h.get('phone-follow-start').click(); await h.get('phone-follow-stop').click(); await h.advance(60000);
  assert.equal(h.calls.length, 2); const request = h.calls[1];
  assert.equal(request[0], 'phone-follow-start'); assert.equal(request[1], 'POST');
  assert.deepEqual(Object.keys(request[2]).sort(), ['controller_id', 'duration_minutes', 'request_id']); assert.equal(request[2].controller_id, 'curtis-s26-ultra'); assert.equal(request[2].duration_minutes, 60);
  assert.match(request[2].request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  wait.resolve(reply(saved())); await start; await h.settle();
  assert.equal(h.get('phone-follow-badge').textContent, 'SESSION SAVED'); assert.match(h.get('phone-follow-runner').textContent, /Waiting for the home PC/);
  assert.match(h.get('phone-follow-status').textContent, /session saved/); assert.equal(h.get('phone-follow-start').disabled, true); assert.equal(h.get('phone-follow-stop').disabled, false);
});
test('saved session and runner freshness are distinct, including OFF main-PC heartbeat', async () => {
  const cases = [
    [off(), /connection not confirmed/],
    [off({ runner: { status: 'off', message: 'Ready.', seen_at: NOW } }), /Main PC ready · following off/],
    [off({ runner: { status: 'off', message: 'Old.', seen_at: NOW - 60000 } }), /connection not confirmed/],
    [saved({ runner: { status: 'following', message: 'Browser link found.', seen_at: NOW } }), /Following supported links/],
    [saved({ runner: { status: 'following', message: 'Old update.', seen_at: NOW - 60000 } }), /stale/],
    [saved({ runner: { status: 'following', message: '', seen_at: null } }), /without a recent update/],
    [saved({ runner: { status: 'unavailable', message: 'S26 connection unavailable.', seen_at: NOW } }), /Unavailable.*S26 connection unavailable/],
  ];
  for (const [follow, expected] of cases) { const h = fixture({ api: async () => reply(follow) }); await h.settle(); assert.match(h.get('phone-follow-runner').textContent, expected); }
});
test('explicit Stop clears current URL and launch report with one POST and no auto restart', async () => {
  const h = fixture({ api: async () => reply(saved({ current_url: 'https://curtbrag.com/gallery/', current_navigation: { id: 'nav-1', units: [{ device_id: 'phone191', status: 'launch-requested' }] } })) }); await h.settle();
  h.setApi(async action => { assert.equal(action, 'phone-follow-stop'); return reply(off({ stopped_at: NOW })); });
  await h.get('phone-follow-stop').click(); await h.settle();
  assert.equal(h.calls[1][0], 'phone-follow-stop'); assert.equal(h.calls[1][1], 'POST'); assert.deepEqual(Object.keys(h.calls[1][2]), ['request_id']);
  assert.equal(h.get('phone-follow-badge').textContent, 'OFF'); assert.equal(h.get('phone-follow-current-url').textContent, ''); assert.equal(h.get('phone-follow-current-url').hidden, true);
  assert.doesNotMatch(h.get('phone-follow-units').textContent, /Launch requested/); assert.match(h.document.body.textContent, /Already accepted launch requests may finish after Stop/);
});
test('failed Start is never retried, blocks another Start and permits explicit Stop until checked', async () => {
  const h = fixture(); await h.settle(); h.setApi(async () => { throw new Error('Connection timed out.'); });
  await h.get('phone-follow-start').click(); await h.get('phone-follow-start').click();
  assert.equal(h.calls.filter(call => call[0] === 'phone-follow-start').length, 1); assert.match(h.get('phone-follow-status').textContent, /not|timed out/);
  assert.equal(h.get('phone-follow-status').dataset.error, '1'); assert.equal(h.get('phone-follow-start').disabled, true); assert.equal(h.get('phone-follow-stop').disabled, false);
  h.setApi(async () => reply(off())); await h.advance(20000);
  assert.equal(h.calls.filter(call => call[0] === 'phone-follow-start').length, 1); assert.equal(h.get('phone-follow-start').disabled, false);
});
test('polling uses one bounded GET at 20 seconds off or 5 seconds active and cannot overlap pending reads', async () => {
  const h = fixture(); await h.settle(); await h.advance(19999); assert.equal(h.calls.length, 1); await h.advance(1); assert.equal(h.calls.length, 2);
  const wait = pending(); h.setApi(() => wait.promise); await h.advance(20000); assert.equal(h.calls.length, 3);
  await h.advance(100000); await h.get('phone-follow-refresh').click(); assert.equal(h.calls.length, 3);
  wait.resolve(reply(saved({ expires_at: NOW + 3600000 }))); await h.settle(); h.setApi(async () => reply(saved()));
  await h.advance(4999); assert.equal(h.calls.length, 3); await h.advance(1); assert.equal(h.calls.length, 4);
  assert.ok(h.calls.every(call => call[0] === 'phone-follow-status'));
});
test('hidden document stops polling and ignores pending reply, then checks once on return', async () => {
  const wait = pending(); const h = fixture({ api: () => wait.promise }); await h.setHidden(true); await h.advance(120000);
  wait.resolve(reply(saved({ current_url: 'https://curtbrag.com/gallery/' }))); await h.settle(); assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0); assert.equal(h.get('phone-follow-current-url').textContent, '');
  h.setApi(async () => reply(off())); await h.setHidden(false); assert.equal(h.calls.length, 2); assert.equal(h.timers.size, 1);
});
test('pagehide disconnects watchers and timers; pageshow performs one safe status read', async () => {
  const h = fixture(); await h.settle(); await h.window.emit('pagehide'); assert.equal(h.timers.size, 0); assert.ok(h.observers.every(observer => observer.targets.length === 0));
  await h.advance(60000); assert.equal(h.calls.length, 1); await h.window.emit('pageshow'); await h.settle(); assert.equal(h.calls.length, 2);
});
test('sign-out clears private link and reports, rejects late reply and keeps new-session request independent', async () => {
  const h = fixture({ api: async () => reply(saved({ current_url: 'https://curtbrag.com/gallery/', current_navigation: { id: 'nav-old', units: [{ device_id: 'phone191', status: 'failed', message: 'private previous report' }] } })) }); await h.settle();
  const late = pending(); h.setApi(() => late.promise); const oldRead = h.get('phone-follow-refresh').click();
  h.setSignedIn(false); await h.settle(); assert.equal(h.get('phone-follow-current-url').textContent, ''); assert.doesNotMatch(h.document.body.textContent, /private previous report/); assert.equal(h.timers.size, 0);
  h.setApi(async () => reply(off())); h.setSignedIn(true); await h.settle();
  late.resolve(reply(saved({ current_url: 'https://curtbrag.com/private-old/' }))); await oldRead; await h.settle();
  assert.equal(h.get('phone-follow-badge').textContent, 'OFF'); assert.doesNotMatch(h.document.body.textContent, /private-old/); assert.equal(h.calls.length, 3);
});
test('Start receipt arriving after logout cannot restore a session or current link', async () => {
  const h = fixture(); await h.settle(); const late = pending(); h.setApi(() => late.promise); const start = h.get('phone-follow-start').click(); h.setSignedIn(false);
  late.resolve(reply(saved({ current_url: 'https://curtbrag.com/gallery/' }))); await start; await h.settle();
  assert.equal(h.get('phone-follow-badge').textContent, 'OFF'); assert.equal(h.get('phone-follow-current-url').textContent, ''); assert.equal(h.timers.size, 0);
});
test('expiry clears private URL locally while status read is still pending', async () => {
  const expires_at = NOW + 1000; const h = fixture({ api: async () => reply(saved({ started_at: expires_at - 3600000, expires_at, current_url: 'https://curtbrag.com/gallery/' })) }); await h.settle();
  const late = pending(); h.setApi(() => late.promise); await h.advance(1000);
  assert.equal(h.get('phone-follow-current-url').textContent, ''); assert.equal(h.get('phone-follow-badge').textContent, 'OFF'); assert.match(h.get('phone-follow-session').textContent, /expired/);
  late.resolve(reply(off())); await h.settle();
});
test('current safe link uses DOM text and secure anchor attributes, never a URL history', async () => {
  const h = fixture({ api: async () => reply(saved({ current_url: 'https://curtbrag.com/gallery/?search=%3Cimg%3E' })) }); await h.settle();
  const link = h.get('phone-follow-current-url'); assert.equal(link.href, 'https://curtbrag.com/gallery/?search=%3Cimg%3E'); assert.equal(link.textContent, link.href);
  assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener noreferrer'); assert.equal(link.referrerPolicy, 'no-referrer');
  h.setApi(async () => reply(saved({ current_url: 'https://curtbrag.com/shop/' }))); await h.get('phone-follow-refresh').click();
  assert.equal(link.textContent, 'https://curtbrag.com/shop/'); assert.doesNotMatch(h.get('phone-follow-control').textContent, /search=%3Cimg/); assert.deepEqual(h.forbidden, []);
});
test('private, sign-in, credential-bearing and malformed URLs are not linked or displayed', async () => {
  const urls = ['javascript:alert(1)', 'http://curtbrag.com/', 'https://user:secret@curtbrag.com/', 'https://curtbrag.com:8443/', 'https://192.168.1.2/', 'https://8.8.8.8/', 'https://[2001:4860:4860::8888]/', 'https://device.local/', 'https://device.localdomain/', 'https://device.onion/', 'https://device.example/', 'https://-bad.com/', 'https://bad-.com/', 'https://curtbrag.com/login/', 'https://curtbrag.com/%73ignin/', 'https://curtbrag.com/cluster/dashboard/', 'https://curtbrag.com/?access_token=secret', 'https://curtbrag.com/#session=secret', 'https://curtbrag.com/\\private', 'https://' + 'a'.repeat(64) + '.com/'];
  for (const current_url of urls) {
    const h = fixture({ api: async () => reply(saved({ current_url })) }); await h.settle();
    assert.equal(h.get('phone-follow-current-url').textContent, '', current_url); assert.equal(h.get('phone-follow-status').dataset.error, '1', current_url); assert.deepEqual(h.forbidden, []);
  }
});
test('all 13 unit reports stay separate from physical proof and inert against HTML-like report messages', async () => {
  const units = TARGETS.map((device_id, index) => ({ device_id, status: ['queued', 'launch-requested', 'failed', 'skipped', 'unconfirmed'][index % 5], message: index === 3 ? 'offline/busy' : index === 4 ? '<img src=x onerror=alert(1)>' : '' }));
  const h = fixture({ api: async () => reply(saved({ current_navigation: { id: 'nav-1', units } })) }); await h.settle();
  const list = h.get('phone-follow-units'); assert.equal(list.children.length, 13); assert.match(list.textContent, /Launch requested/); assert.match(list.textContent, /offline\/busy/); assert.match(list.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.doesNotMatch(list.textContent, /curtis-s26-ultra|playing|physically verified/i); assert.match(h.get('phone-follow-report').textContent, /Physical screens and playback are not verified/);
  assert.equal(h.get('swarm-nodes-online').textContent, '13 / 13'); assert.deepEqual(h.forbidden, []);
});
test('bad unit IDs, duplicates, statuses or excessive reports cannot claim target launch success', async () => {
  const invalid = [[{ device_id: 'curtis-s26-ultra', status: 'launch-requested' }], [{ device_id: 'phone191', status: 'success' }], [{ device_id: 'phone191', status: 'queued' }, { device_id: 'phone191', status: 'failed' }], Array.from({ length: 14 }, () => ({ device_id: 'phone191', status: 'queued' }))];
  for (const units of invalid) { const h = fixture({ api: async () => reply(saved({ current_navigation: { id: 'nav-1', units } })) }); await h.settle(); assert.equal(h.get('phone-follow-status').dataset.error, '1'); assert.doesNotMatch(h.get('phone-follow-units').textContent, /Launch requested|Success/); }
});
test('malformed state and missing UUID never enable automatic or unverified Start', async () => {
  for (const response of [{ ok: false, follow: off() }, reply({}), reply(saved({ controller_id: 'phone191' })), reply(saved({ expires_at: null })), reply(saved({ expires_at: NOW + 7200000 }))]) {
    const h = fixture({ api: async () => response }); await h.settle(); assert.equal(h.get('phone-follow-start').disabled, true); assert.equal(h.calls.length, 1); assert.equal(h.get('phone-follow-status').dataset.error, '1');
  }
  const h = fixture({ noUUID: true }); await h.settle(); await h.get('phone-follow-start').click(); assert.equal(h.calls.length, 1); assert.equal(h.get('phone-follow-start').disabled, true);
});
test('UUID generation failure releases the pending lock without making a POST', async () => {
  const h = fixture({ badUUID: true }); await h.settle(); await h.get('phone-follow-start').click(); assert.equal(h.calls.length, 1);
  assert.equal(h.get('phone-follow-control').getAttribute('aria-busy'), 'false'); assert.match(h.get('phone-follow-status').textContent, /UUID unavailable/);
});
test('reported runner error text is inert and controls remain keyboard labelled', async () => {
  const h = fixture({ api: async () => reply(saved({ runner: { status: 'unavailable', message: '<script>launch()</script>', seen_at: NOW } })) }); await h.settle();
  assert.match(h.get('phone-follow-runner').textContent, /<script>launch\(\)<\/script>/); assert.equal(h.get('phone-follow-status').getAttribute('aria-live'), 'polite');
  for (const id of ['start', 'stop', 'refresh']) { assert.equal(h.get('phone-follow-' + id).type, 'button'); assert.ok(h.get('phone-follow-' + id).textContent); }
  assert.deepEqual(h.forbidden, []);
});
test('latest link and report stay visible during an unavailable source without claiming it is current', async () => {
  const h = fixture({ api: async () => reply(saved({ runner: { status: 'unavailable', message: 'S26 browser is in the background.', seen_at: NOW }, current_url: 'https://curtbrag.com/gallery/', current_navigation: { id: 'previous-nav', units: [{ device_id: 'phone191', status: 'launch-requested' }] } })) }); await h.settle();
  assert.match(h.get('phone-follow-control').textContent, /Latest public link/); assert.equal(h.get('phone-follow-current-url').textContent, 'https://curtbrag.com/gallery/');
  assert.match(h.get('phone-follow-runner').textContent, /Unavailable.*background/); assert.match(h.get('phone-follow-units').textContent, /Launch requested/);
});
test('action receipt reports returned saved state honestly when another controller has changed it', async () => {
  const h = fixture(); await h.settle(); h.setApi(async () => reply(off())); await h.get('phone-follow-start').click();
  assert.equal(h.get('phone-follow-badge').textContent, 'OFF'); assert.match(h.get('phone-follow-status').textContent, /request recorded; following is currently off/);
  h.setApi(async () => reply(saved())); await h.get('phone-follow-start').click(); await h.get('phone-follow-stop').click();
  assert.match(h.get('phone-follow-status').textContent, /Stop request recorded; a follow session is currently active/);
});
