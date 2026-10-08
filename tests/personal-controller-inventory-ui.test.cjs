'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../public/scripts/cluster-personal-control.js'), 'utf8');

function fixture(options = {}) {
  const requests = [], forbidden = [];
  class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
    async emit(type, event = {}) { event.preventDefault ||= () => { event.prevented = true; }; for (const callback of this.listeners.get(type) || []) await callback(event); }
  }
  class Element extends Events {
    constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; this.value = ''; this._text = ''; this.hidden = false; this.disabled = false; this.classList = { add() {} }; }
    get firstElementChild() { return this.children[0] || null; }
    get nextElementSibling() { const list = this.parentElement?.children || []; return list[list.indexOf(this) + 1] || null; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    get innerHTML() { forbidden.push('read innerHTML'); throw new Error('HTML access is forbidden'); }
    set innerHTML(value) { forbidden.push('write innerHTML'); throw new Error('HTML rendering is forbidden'); }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    insertBefore(child, before) { child.parentElement = this; const index = this.children.indexOf(before); if (index < 0) this.children.push(child); else this.children.splice(index, 0, child); }
    insertAdjacentElement(where, child) { assert.equal(where, 'afterend'); const list = this.parentElement.children; list.splice(list.indexOf(this) + 1, 0, child); child.parentElement = this.parentElement; }
    setAttribute(name, value) { this.attributes[name] = String(value); if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    querySelector(selector) { if (selector === 'h1') return find(this, node => node.tagName === 'H1'); throw new Error('Unexpected selector ' + selector); }
    querySelectorAll(selector) { assert.equal(selector, 'button'); return all(this, node => node.tagName === 'BUTTON'); }
    async click() { if (!this.disabled) await this.emit('click'); }
    focus() { this.focused = true; }
  }
  function find(element, predicate) { if (predicate(element)) return element; for (const child of element.children) { const value = find(child, predicate); if (value) return value; } return null; }
  function all(element, predicate) { return [...(predicate(element) ? [element] : []), ...element.children.flatMap(child => all(child, predicate))]; }
  const document = new Events(); document.body = new Element('body'); document.readyState = 'complete'; document.hidden = false; document.title = 'Cluster workspace';
  document.createElement = tag => new Element(tag);
  document.getElementById = id => find(document.body, node => node.id === id);
  document.querySelector = selector => { const match = /^\[data-tab="(devices|swarm)"\]$/.exec(selector); assert.ok(match, 'Known outer dashboard tab only'); return find(document.body, node => node.getAttribute('data-tab') === match[1]); };
  const make = (tag, id, text = '') => { const node = new Element(tag); node.id = id; node.textContent = text; return node; };
  const panel = make('div', 'panel'); panel.style.display = options.signedOut ? 'none' : 'block';
  const header = make('div', 'existing-header'); header.append(make('h1', 'existing-title', 'Cluster workspace'));
  const devices = make('div', 'tab-devices'); devices.style.display = 'none';
  const table = make('table', 'devicesTable', 'existing worker table'); devices.append(table);
  const devicesTab = make('button', 'devices-tab', 'Devices'); devicesTab.setAttribute('data-tab', 'devices'); devicesTab.addEventListener('click', () => { devices.style.display = 'block'; });
  const workers = make('div', 'deviceGrid', 'existing worker inventory');
  const queue = make('select', 'cmdTarget', 'existing worker/group targets');
  panel.append(header, devicesTab, workers, queue, devices); document.body.append(panel);
  const window = new Events(); window.getComputedStyle = node => ({ display: node.style.display || 'block' }); window.matchMedia = () => null;
  let implementation = options.api || (async () => ({ controllers: [] }));
  window.callApi = async (...args) => { requests.push(structuredClone(args)); return implementation(...args); };
  const context = { window, document, navigator: { onLine: true }, location: { pathname: options.pathname || '/cluster/dashboard/', search: '' }, URLSearchParams, Date, Error };
  for (const name of ['fetch', 'localStorage', 'sessionStorage', 'XMLHttpRequest', 'WebSocket']) Object.defineProperty(context, name, { get() { forbidden.push(name); throw new Error('Forbidden ' + name); } });
  vm.runInNewContext(source, context);
  const get = id => document.getElementById(id);
  function fill(data = {}) {
    for (const [name, value] of Object.entries({ name: 'Curtis S26 Ultra', model: 'Samsung Galaxy S26 Ultra', private_ip: '192.168.1.88', adb_connect_port: '37129', ...data })) get('personal-controller-input-' + name).value = String(value);
  }
  const submit = () => get('personal-controller-registration-form').emit('submit');
  return { get, requests, forbidden, window, document, devices, table, workers, queue, fill, submit, setApi: api => { implementation = api; } };
}
const controller = overrides => ({ controller_id: 'curtis-s26-ultra', name: 'Curtis S26 Ultra', model: 'Samsung Galaxy S26 Ultra', private_ip: '192.168.1.88', adb_connect_port: 37129, role: 'personal-controller', worker_enabled: false, mining_enabled: false, registered_at: 1791480000000, ...overrides });
const pending = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('inventory creates separate Devices section without loading or registering automatically', async () => {
  const h = fixture();
  assert.equal(h.devices.firstElementChild.id, 'personal-controller-inventory');
  assert.match(h.get('personal-controller-inventory').textContent, /Add personal controller/);
  assert.equal(h.table.textContent, 'existing worker table'); assert.equal(h.workers.textContent, 'existing worker inventory'); assert.equal(h.queue.textContent, 'existing worker/group targets');
  await h.window.emit('pageshow'); await h.window.emit('online'); await h.document.emit('visibilitychange');
  assert.equal(h.devices.children.filter(node => node.id === 'personal-controller-inventory').length, 1);
  assert.deepEqual(h.requests, []); assert.deepEqual(h.forbidden, []);
});
test('landing helper does not add inventory or make API requests', () => {
  const h = fixture({ pathname: '/cluster/control/' }); assert.equal(h.get('personal-controller-inventory'), null); assert.deepEqual(h.requests, []);
});
test('explicit Devices click loads inventory once and keeps returned text inert', async () => {
  const data = controller({ name: '<img src=x onerror=alert(1)>', model: '<script>worker()</script>', adb_guid: 'adb-safe-guid' });
  const h = fixture({ api: async () => ({ controllers: [data] }) });
  await h.get('devices-tab').click();
  assert.deepEqual(h.requests, [['personal-controllers']]);
  const list = h.get('personal-controller-inventory-list');
  assert.match(list.textContent, /<img src=x onerror=alert\(1\)>/); assert.match(list.textContent, /<script>worker\(\)<\/script>/);
  assert.match(list.textContent, /Registered personal controller/); assert.match(list.textContent, /Last registered/); assert.doesNotMatch(list.textContent, /ONLINE|worker ready/i);
  assert.equal(h.table.textContent, 'existing worker table'); assert.equal(h.queue.textContent, 'existing worker/group targets'); assert.deepEqual(h.forbidden, []);
});
test('reopening Devices refreshes saved records but never submits registration', async () => {
  const h = fixture({ api: async () => ({ controllers: [controller()] }) });
  await h.get('devices-tab').click(); await h.get('devices-tab').click();
  assert.deepEqual(h.requests, [['personal-controllers'], ['personal-controllers']]);
});
test('pending read locks refresh and registration without replay', async () => {
  const wait = pending(); const h = fixture({ api: () => wait.promise }); h.fill();
  const first = h.get('devices-tab').click(); await h.get('devices-tab').click(); await h.submit();
  assert.equal(h.requests.length, 1); assert.equal(h.get('personal-controller-register').disabled, true); assert.equal(h.get('personal-controller-inventory').getAttribute('aria-busy'), 'true');
  wait.resolve({ controllers: [] }); await first; assert.equal(h.get('personal-controller-register').disabled, false);
});
test('explicit registration sends exact stable-ID contract, omits blank GUID and displays the receipt immediately', async () => {
  const h = fixture({ api: async () => ({ ok: true, created: true, controller: controller() }) }); h.fill(); await h.submit();
  assert.deepEqual(h.requests, [['register-personal-controller', 'POST', { controller_id: 'curtis-s26-ultra', name: 'Curtis S26 Ultra', model: 'Samsung Galaxy S26 Ultra', private_ip: '192.168.1.88', adb_connect_port: 37129 }]]);
  assert.match(h.get('personal-controller-inventory-list').textContent, /Curtis S26 Ultra/);
  assert.match(h.get('personal-controller-inventory-status').textContent, /Personal controller registered/);
  assert.equal(h.table.textContent, 'existing worker table'); assert.equal(h.queue.textContent, 'existing worker/group targets'); assert.deepEqual(h.forbidden, []);
});
test('optional ADB identifier is sent as non-secret inventory metadata', async () => {
  const h = fixture({ api: async () => ({ ok: true, created: true, controller: controller({ adb_guid: 'adb-unit_123._tls' }) }) }); h.fill({ adb_guid: 'adb-unit_123._tls' }); await h.submit();
  assert.equal(h.requests[0][2].adb_guid, 'adb-unit_123._tls'); assert.match(h.get('personal-controller-inventory-list').textContent, /adb-unit_123/);
});
test('pending registration makes a single request and does not retry on lifecycle changes', async () => {
  const wait = pending(); const h = fixture({ api: () => wait.promise }); h.fill();
  const first = h.submit(); await h.submit(); await h.get('personal-controller-inventory-refresh').click();
  await h.window.emit('online'); await h.window.emit('pageshow'); await h.document.emit('visibilitychange');
  assert.equal(h.requests.length, 1); assert.equal(h.get('personal-controller-register').disabled, true);
  wait.resolve({ ok: true, created: true, controller: controller() }); await first;
  assert.equal(h.get('personal-controller-register').disabled, false); assert.equal(h.get('personal-controller-inventory').getAttribute('aria-busy'), 'false');
});
test('local validation rejects invalid connection metadata before any API operation', async () => {
  const cases = [
    { controller_id: '1-controller' }, { controller_id: 'A-controller' }, { controller_id: 'a'.repeat(65) },
    { name: '' }, { name: 'a'.repeat(81) }, { name: 'bad\nname' }, { name: '<img>' }, { name: 'Phone & Tablet' }, { model: '模型' }, { model: '' }, { model: '_Model' }, { model: 'Model/Version' },
    { private_ip: '8.8.8.8' }, { private_ip: '192.168.01.2' }, { private_ip: 'https://192.168.1.2/' }, { private_ip: '172.32.0.1' },
    { adb_connect_port: '0' }, { adb_connect_port: '65536' }, { adb_connect_port: '12.5' }, { adb_connect_port: '2e3' },
    { adb_guid: 'identifier:with-colon' }, { adb_guid: '_leading' }, { adb_guid: 'a'.repeat(161) },
  ];
  for (const invalid of cases) {
    const h = fixture(); h.fill(invalid); await h.submit(); assert.deepEqual(h.requests, [], JSON.stringify(invalid));
    assert.equal(h.get('personal-controller-inventory-status').dataset.error, '1'); assert.equal(h.get('personal-controller-register').disabled, false);
  }
});
test('all private IPv4 ranges and port limits can be submitted', async () => {
  for (const [private_ip, adb_connect_port] of [['10.0.0.1', 1], ['172.16.0.1', 65535], ['172.31.255.254', 12345], ['192.168.255.254', 65535]]) {
    const h = fixture({ api: async () => ({ ok: true, created: true, controller: controller({ private_ip, adb_connect_port }) }) }); h.fill({ private_ip, adb_connect_port }); await h.submit();
    assert.equal(h.requests.length, 1); assert.equal(h.requests[0][2].adb_connect_port, adb_connect_port);
  }
});
test('exact duplicate receipt is visible without extra requests or duplicate cards', async () => {
  const h = fixture({ api: async () => ({ ok: true, created: false, controller: controller() }) }); h.fill(); await h.submit(); await h.submit();
  assert.match(h.get('personal-controller-inventory-status').textContent, /already registered/); assert.equal(h.get('personal-controller-inventory-list').children.length, 1); assert.equal(h.requests.length, 2);
});
test('server conflict or connection failure remains visible and preserves entered details', async () => {
  for (const message of ['Controller ID already has different connection details.', 'Connection timed out. Please retry.']) {
    const h = fixture({ api: async () => { throw new Error(message); } }); h.fill(); await h.submit();
    assert.equal(h.get('personal-controller-inventory-status').textContent, message); assert.equal(h.get('personal-controller-inventory-status').dataset.error, '1');
    assert.equal(h.get('personal-controller-input-private_ip').value, '192.168.1.88'); assert.equal(h.get('personal-controller-inventory-list').children.length, 0);
    await h.window.emit('pageshow'); assert.equal(h.requests.length, 1);
  }
});
test('failed refresh retains previously displayed saved records and reports failure', async () => {
  const h = fixture({ api: async () => ({ controllers: [controller()] }) }); await h.get('devices-tab').click();
  h.setApi(async () => { throw new Error('Storage unavailable.'); }); await h.get('personal-controller-inventory-refresh').click();
  assert.match(h.get('personal-controller-inventory-list').textContent, /Curtis S26 Ultra/); assert.equal(h.get('personal-controller-inventory-status').textContent, 'Storage unavailable.');
});
test('worker or mining records and unverified lists cannot enter personal inventory', async () => {
  for (const response of [{ controllers: [controller({ role: 'worker' })] }, { controllers: [controller({ worker_enabled: true })] }, { controllers: [controller({ mining_enabled: true })] }, { controllers: null }]) {
    const h = fixture({ api: async () => response }); await h.get('devices-tab').click();
    assert.equal(h.get('personal-controller-inventory-list').children.length, 0); assert.equal(h.get('personal-controller-inventory-status').dataset.error, '1'); assert.equal(h.table.textContent, 'existing worker table');
  }
});
test('all valid saved records are displayed without truncating a larger inventory', async () => {
  const records = Array.from({ length: 101 }, (_, index) => controller({ controller_id: 'personal-' + index, name: 'Controller ' + index }));
  const h = fixture({ api: async () => ({ controllers: records }) }); await h.get('devices-tab').click();
  assert.equal(h.get('personal-controller-inventory-list').children.length, 101); assert.match(h.get('personal-controller-inventory-list').textContent, /Controller 100/);
  assert.equal(h.get('personal-controller-inventory-status').dataset.error, '0');
});
test('unverified registration receipts do not claim success', async () => {
  for (const response of [{ ok: true, controller: controller({ role: 'worker' }) }, { ok: true, controller: controller({ controller_id: 'other-controller' }) }, { controller: controller() }]) {
    const h = fixture({ api: async () => response }); h.fill(); await h.submit();
    assert.equal(h.get('personal-controller-inventory-list').children.length, 0); assert.match(h.get('personal-controller-inventory-status').textContent, /not be verified/);
  }
});
test('missing registration time stays unavailable instead of claiming live device status', async () => {
  const h = fixture({ api: async () => ({ controllers: [controller({ registered_at: null })] }) }); await h.get('devices-tab').click();
  assert.match(h.get('personal-controller-inventory-list').textContent, /Last registeredUnavailable/); assert.doesNotMatch(h.get('personal-controller-inventory-list').textContent, /ONLINE|connected now|last seen/i);
});
test('signed-out dashboard and missing normal API refuse registration and reads', async () => {
  for (const missing of [false, true]) {
    const h = fixture({ signedOut: !missing }); if (missing) h.window.callApi = undefined; h.fill(); await h.submit(); await h.get('devices-tab').click();
    assert.deepEqual(h.requests, []); assert.equal(h.get('personal-controller-inventory-status').dataset.error, '1'); assert.match(h.get('personal-controller-inventory-status').textContent, missing ? /unavailable/ : /Sign in/);
  }
});
test('fields are labelled and registration has an explicit submit affordance', () => {
  const h = fixture();
  for (const key of ['name', 'model', 'private_ip', 'adb_connect_port', 'controller_id', 'adb_guid']) {
    const input = h.get('personal-controller-input-' + key); assert.equal(input.name, key);
    const label = input.parentElement.children.find(node => node.tagName === 'LABEL'); assert.equal(label.getAttribute('for'), input.id);
  }
  assert.equal(h.get('personal-controller-register').type, 'submit'); assert.equal(h.get('personal-controller-inventory-refresh').type, 'button');
  assert.equal(h.get('personal-controller-inventory-status').getAttribute('aria-live'), 'polite');
});
test('generic form starts blank and derives stable IDs from names without hardcoding S26', async () => {
  const h = fixture();
  assert.equal(h.get('personal-controller-input-name').value, ''); assert.equal(h.get('personal-controller-input-model').value, '');
  assert.equal(h.get('personal-controller-input-controller_id').value, ''); assert.equal(h.get('personal-controller-input-controller_id').required, false);
  h.setApi(async (_action, _method, payload) => ({ ok: true, created: true, controller: controller(payload) }));
  h.fill({ name: 'Kitchen phone', model: 'SM-S948U' }); await h.submit(); assert.equal(h.requests[0][2].controller_id, 'kitchen-phone');
  h.fill({ name: '253 phone', controller_id: '' }); await h.submit(); assert.equal(h.requests[1][2].controller_id, 'personal-253-phone');
  h.fill({ name: 'Élodie phone', controller_id: '' }); await h.submit(); assert.equal(h.requests[2][2].controller_id, 'elodie-phone');
  h.fill({ name: 'Another phone', controller_id: 'my-explicit-id' }); await h.submit(); assert.equal(h.requests[3][2].controller_id, 'my-explicit-id');
});
