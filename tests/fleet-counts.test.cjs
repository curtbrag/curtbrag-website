'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../public/scripts/cluster-swarm-live-v8.js'), 'utf8');
const counts = source.slice(source.indexOf('  function renderFleetCounts()'), source.indexOf('  function ensureStateNote()'));
const callback = source.slice(source.indexOf('  window.updatePersonalControllerCount ='), source.indexOf('  function setState('));
const stale = source.slice(source.indexOf('  function markConnectionStale('), source.indexOf('  function load(force='));
const roster = source.match(/  const FLEET = \[[\s\S]*?\n  \];/)[0];

function fixture(options = {}) {
  let writes = 0;
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.dataset = {}; this._text = ''; this.parentElement = null; }
    get firstElementChild() { return this.children[0] || null; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { writes++; this._text = String(value); this.children = []; }
    remove() { if (this.parentElement) { const list = this.parentElement.children; list.splice(list.indexOf(this), 1); this.parentElement = null; } }
    append(...items) { for (const item of items) { item.remove(); item.parentElement = this; this.children.push(item); writes++; } }
    insertBefore(item, before) { item.remove(); const index = this.children.indexOf(before); item.parentElement = this; if (index < 0) this.children.push(item); else this.children.splice(index, 0, item); writes++; }
  }
  const root = new Element('main');
  const make = (tag, id, text = '') => { const element = new Element(tag); element.id = id; element.textContent = text; return element; };
  const workerCount = make('div', 'swarm-nodes-online', 'Unverified');
  const statCard = make('div', 'worker-stat-card'); statCard.append(make('div', null, 'Workers online'), workerCount);
  const workerCard = make('section', 'worker-card'); workerCard.append(make('h3', null, 'Workers'));
  const grid = make('div', 'swarm-nodes'); grid.dataset.connection = 'stale'; workerCard.append(grid); root.append(statCard, workerCard);
  const layoutReady = () => root.append(make('nav', 'cluster-work-navigation'));
  if (!options.lateLayout) layoutReady();
  const find = (node, id) => { if (node.id === id) return node; for (const child of node.children) { const found = find(child, id); if (found) return found; } return null; };
  const document = { getElementById: id => find(root, id), createElement: tag => new Element(tag) };
  const window = {};
  const context = vm.createContext({ window, document, setState() {} });
  vm.runInContext(roster + '\nlet registeredControllerCount = null; let fleetWorkersVerified = false;\n' + counts + callback + stale, context);
  const get = id => document.getElementById(id);
  const repaint = () => vm.runInContext('renderFleetCounts()', context);
  const workers = online => { workerCount.textContent = online + ' / 13'; grid.dataset.connection = 'live'; vm.runInContext('fleetWorkersVerified = true; renderFleetCounts()', context); };
  repaint();
  return { window, get, root, grid, workerCount, statCard, workerCard, repaint, workers, context, layoutReady, writes: () => writes };
}

test('registered total includes one controller while online denominator remains the canonical 13 workers', () => {
  const h = fixture(); h.workers(13); h.window.updatePersonalControllerCount(1);
  assert.equal(h.get('swarm-fleet-total').textContent, '14 devices');
  assert.equal(h.workerCount.textContent, '13 / 13');
  assert.equal(h.get('swarm-fleet-detail').textContent, 'Workers online: 13 / 13 · 1 controller registered');
  assert.equal(h.get('swarm-fleet-summary').textContent, '14 devices · 13 / 13 workers online · 1 controller registered');
  assert.equal(h.workerCount.parentElement, h.get('swarm-fleet-detail')); assert.equal(h.workerCount.hidden, undefined);
  assert.equal(h.statCard.firstElementChild.textContent, 'Fleet devices');
  assert.doesNotMatch(h.root.textContent, /14\s*\/\s*14|14 online/);
});
test('registry before worker status stays truthful then online/offline worker changes retain the registered total', () => {
  const h = fixture(); h.window.updatePersonalControllerCount(1);
  assert.equal(h.get('swarm-fleet-total').textContent, '14 devices'); assert.match(h.get('swarm-fleet-summary').textContent, /Worker availability unverified/);
  h.workers(8); assert.equal(h.get('swarm-fleet-summary').textContent, '14 devices · 8 / 13 workers online · 1 controller registered');
  h.workers(0); assert.equal(h.get('swarm-fleet-summary').textContent, '14 devices · 0 / 13 workers online · 1 controller registered');
});
test('real stale handler visibly preserves Unverified and registration total without inventing online state', () => {
  const h = fixture(); h.workers(13); h.window.updatePersonalControllerCount(1);
  vm.runInContext("markConnectionStale('Checking connection')", h.context);
  assert.equal(h.workerCount.textContent, 'Unverified'); assert.equal(h.grid.dataset.connection, 'stale');
  assert.equal(h.get('swarm-fleet-total').textContent, '14 devices');
  assert.equal(h.get('swarm-fleet-detail').textContent, 'Workers online: Unverified · 1 controller registered');
  assert.equal(h.get('swarm-fleet-summary').textContent, '14 devices · Worker availability unverified · 1 controller registered');
  h.workers(13); assert.match(h.get('swarm-fleet-summary').textContent, /13 \/ 13 workers online/);
});
test('unknown snapshot is distinct from an empty registry and clears old controller contribution', () => {
  const h = fixture(); h.workers(13);
  assert.equal(h.get('swarm-fleet-total').textContent, '13 workers'); assert.match(h.get('swarm-fleet-detail').textContent, /Controller registration unavailable/);
  h.window.updatePersonalControllerCount(0); assert.equal(h.get('swarm-fleet-total').textContent, '13 devices'); assert.match(h.get('swarm-fleet-summary').textContent, /0 controllers registered/);
  h.window.updatePersonalControllerCount(2); assert.equal(h.get('swarm-fleet-total').textContent, '15 devices');
  h.window.updatePersonalControllerCount(null); assert.equal(h.get('swarm-fleet-total').textContent, '13 workers'); assert.doesNotMatch(h.root.textContent, /15 devices|2 controllers registered/);
});
test('unchanged updates are idempotent and invalid counts cannot alter UI or dispatch targets', () => {
  const h = fixture(); h.workers(13); h.window.updatePersonalControllerCount(1); const before = h.writes();
  for (let count = 0; count < 5; count++) { h.window.updatePersonalControllerCount(1); h.repaint(); }
  for (const invalid of ['1', -1, NaN, Infinity, {}, 1.5]) h.window.updatePersonalControllerCount(invalid);
  assert.equal(h.writes(), before); assert.equal(h.get('swarm-fleet-total').textContent, '14 devices');
  assert.deepEqual(Object.keys(h.window), ['updatePersonalControllerCount']);
  assert.equal(h.workerCard.children.filter(node => node.id === 'swarm-fleet-summary').length, 1);
});
test('core integrates count rendering with layout, successful refresh and stale checks without changing canonical roster', () => {
  assert.equal(vm.runInNewContext(roster + '\nFLEET.length'), 13);
  assert.match(source, /setText\('swarm-nodes-online', `\$\{d\.nodes_online\} \/ \$\{FLEET\.length\}`\);\s*fleetWorkersVerified = true;\s*renderFleetCounts\(\);/);
  assert.match(source, /ensureControlLayout\(\);\s*renderFleetCounts\(\);/);
  assert.match(source, /Worker connections · 13 workers/); assert.doesNotMatch(source, /Fleet connections · 13 devices/);
});
test('a deferred control layout retains the counter in its original stat card until ready', () => {
  const h = fixture({ lateLayout: true }); h.workers(13); h.window.updatePersonalControllerCount(1);
  assert.equal(h.workerCount.parentElement, h.statCard); assert.equal(h.get('swarm-fleet-total'), null);
  assert.equal(h.get('swarm-fleet-summary').textContent, '14 devices · 13 / 13 workers online · 1 controller registered');
  h.layoutReady(); h.repaint();
  assert.equal(h.get('swarm-fleet-total').textContent, '14 devices'); assert.equal(h.workerCount.parentElement, h.get('swarm-fleet-detail'));
  const before = h.writes(); h.repaint(); assert.equal(h.writes(), before);
});
