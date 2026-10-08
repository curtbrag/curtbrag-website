const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../public/scripts/cluster-personal-control.js'), 'utf8');

function harness(options = {}) {
  const calls = [], forbidden = [], observers = [], pending = new Set();
  let writes = 0;
  class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, listener, config = {}) {
      const list = this.listeners.get(type) || [];
      list.push({ listener, once: !!config.once }); this.listeners.set(type, list);
    }
    async emit(type, extra = {}) {
      const event = { type, target: this, ...extra };
      const promises = [];
      for (const record of [...(this.listeners.get(type) || [])]) {
        if (record.once) this.listeners.set(type, this.listeners.get(type).filter(item => item !== record));
        promises.push(record.listener(event));
      }
      await Promise.all(promises);
    }
  }
  const descendant = (element, target) => element === target || element.children.some(child => descendant(child, target));
  function mutation(target, type, attributeName) {
    writes++;
    for (const observer of observers) {
      if (observer.targets.some(({ element, config }) => (element === target || (config.subtree && descendant(element, target))) && config[type] && (!attributeName || !config.attributeFilter || config.attributeFilter.includes(attributeName)))) pending.add(observer);
    }
  }
  class Element extends Events {
    constructor(tag) {
      super(); this.tagName = tag.toUpperCase(); this.id = ''; this.children = []; this.parentElement = null;
      this.attributes = {}; this.dataset = {}; this.style = {}; this.disabled = false; this.hidden = false; this.open = false;
      this.value = ''; this.className = ''; this._text = ''; this.focused = false;
      const classes = new Set(); this.classList = { add: value => classes.add(value), contains: value => classes.has(value) };
    }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) {
      if (this.textContent === String(value)) return;
      this._text = String(value); this.children = []; mutation(this, 'childList');
    }
    get firstElementChild() { return this.children[0] || null; }
    get nextElementSibling() {
      if (!this.parentElement) return null;
      return this.parentElement.children[this.parentElement.children.indexOf(this) + 1] || null;
    }
    append(...items) { for (const item of items) { item.parentElement = this; this.children.push(item); } mutation(this, 'childList'); }
    insertBefore(item, before) {
      const index = before ? this.children.indexOf(before) : this.children.length;
      if (index < 0) throw new Error('Not a child');
      item.parentElement = this; this.children.splice(index, 0, item); mutation(this, 'childList');
    }
    insertAdjacentElement(position, item) {
      assert.equal(position, 'afterend'); this.parentElement.insertBefore(item, this.nextElementSibling);
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
      mutation(this, 'attributes', name);
    }
    getAttribute(name) { return this.attributes[name] ?? null; }
    querySelector(selector) {
      const matches = item => selector === 'h1' ? item.tagName === 'H1' : selector === 'button[onclick="fetchSwarmStatus()"]' && item.tagName === 'BUTTON' && item.getAttribute('onclick') === 'fetchSwarmStatus()';
      const visit = item => { for (const child of item.children) { if (matches(child)) return child; const found = visit(child); if (found) return found; } return null; };
      return visit(this);
    }
    querySelectorAll(selector) {
      assert.equal(selector, 'button');
      const found = [];
      const visit = item => { for (const child of item.children) { if (child.tagName === 'BUTTON') found.push(child); visit(child); } };
      visit(this); return found;
    }
    click() { if (!this.disabled) return this.emit('click'); return Promise.resolve(); }
    focus() { this.focused = true; }
  }
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(element, config) { this.targets.push({ element, config }); }
    disconnect() { this.targets = []; pending.delete(this); }
  }
  const document = new Events();
  document.body = new Element('body'); document.hidden = false; document.title = 'Cluster workspace'; document.readyState = options.loading ? 'loading' : 'complete';
  document.createElement = tag => new Element(tag);
  document.querySelector = selector => {
    assert.equal(selector, '[data-tab="swarm"]');
    const visit = item => { if (item.getAttribute('data-tab') === 'swarm') return item; for (const child of item.children) { const found = visit(child); if (found) return found; } return null; };
    return visit(document.body);
  };
  document.getElementById = id => {
    const visit = item => { if (item.id === id) return item; for (const child of item.children) { const found = visit(child); if (found) return found; } return null; };
    return visit(document.body);
  };
  const make = (tag, id, text = '') => { const item = new Element(tag); item.id = id; item.textContent = text; return item; };
  const pathname = options.pathname || '/cluster/control/';
  let panel, workspace, bridge, count, grid;
  function addWorkspace() {
    workspace = make('div', 'tab-swarm');
    const outer = make('button', 'existing-workspace', 'Workspace'); outer.setAttribute('data-tab', 'swarm');
    outer.addEventListener('click', () => { calls.push('workspace'); workspace.style.display = 'block'; }); panel.append(outer);
    count = make('span', 'swarm-nodes-online', '8 / 13');
    grid = make('div', 'swarm-nodes'); grid.setAttribute('data-connection', 'live');
    for (const view of ['fleet', 'research', 'results']) {
      const tab = make('button', 'cluster-view-tab-' + view, view); tab.setAttribute('role', 'tab');
      tab.addEventListener('click', () => calls.push('tab:' + view)); workspace.append(tab);
    }
    const refresh = make('button', 'existing-refresh', 'Refresh'); refresh.setAttribute('onclick', 'fetchSwarmStatus()');
    refresh.addEventListener('click', () => calls.push('refresh'));
    workspace.append(count, grid, refresh); panel.append(workspace);
  }
  if (/\/dashboard\/?$/.test(pathname)) {
    const gate = make('div', 'loginGate'); const password = make('input', 'pwInput'); password.value = 'untouched-owner-input';
    const login = make('button', 'loginBtn', 'Sign in'); gate.append(password, login); document.body.append(gate);
    panel = make('div', 'panel'); panel.style.display = options.signedOut ? 'none' : 'block';
    const header = make('div', 'existing-header'); bridge = make('div', 'bridgeStatus', options.bridge || 'Bridge: online · last seen 10/8/2026, 2:00:00 PM · Main PC');
    header.append(make('h1', 'existing-title', 'Cluster workspace'), bridge); panel.append(header); document.body.append(panel);
    if (!options.lateWorkspace) addWorkspace();
  } else {
    const install = make('button', 'personal-control-install');
    const status = make('p', 'personal-control-install-status');
    const help = make('details', 'personal-control-install-help'); help.hidden = true;
    help.append(make('summary', null, 'Home-screen setup'));
    document.body.append(install, status, help);
  }
  const window = new Events();
  const media = new Events(); media.matches = !!options.standalone;
  window.matchMedia = query => { assert.equal(query, '(display-mode: standalone)'); return media; };
  window.getComputedStyle = element => ({ display: element.style.display || 'block' });
  const navigator = { onLine: options.online !== false };
  const context = { window, document, navigator, location: { pathname, search: options.search || '' }, URLSearchParams, MutationObserver: Observer };
  for (const name of ['fetch', 'localStorage', 'sessionStorage', 'XMLHttpRequest', 'WebSocket']) Object.defineProperty(context, name, { get() { forbidden.push(name); throw new Error('Forbidden ' + name); } });
  Object.defineProperty(window, 'fetch', { get() { forbidden.push('window.fetch'); throw new Error('Forbidden fetch'); } });
  vm.runInNewContext(source, context);
  const get = id => document.getElementById(id);
  const flush = () => {
    let cycles = 0;
    while (pending.size) {
      if (++cycles > 20) throw new Error('Observer loop');
      const batch = [...pending]; pending.clear(); for (const observer of batch) if (observer.targets.length) observer.callback([]);
    }
    return cycles;
  };
  return { get, calls, forbidden, document, window, navigator, media, panel, bridge, addWorkspace, observers, flush, mutation, writes: () => writes, grid: () => grid, count: () => count };
}

test('install button opens manual help without a native prompt and never performs network or storage work', async () => {
  const h = harness(); assert.equal(h.get('personal-control-install-help').open, false);
  await h.get('personal-control-install').click();
  assert.equal(h.get('personal-control-install-help').open, true); assert.equal(h.get('personal-control-install-help').hidden, false);
  assert.match(h.get('personal-control-install-status').textContent, /browser menu/); assert.deepEqual(h.forbidden, []); assert.deepEqual(h.calls, []);
});

test('native installation prompts only once after an explicit click, including while choice is pending', async () => {
  const h = harness(); let prompted = 0, prevented = 0, finish;
  const choice = new Promise(resolve => { finish = resolve; });
  await h.window.emit('beforeinstallprompt', { preventDefault() { prevented++; }, prompt: async () => { prompted++; }, userChoice: choice });
  await h.window.emit('pageshow'); await h.window.emit('online'); assert.equal(prompted, 0); assert.equal(prevented, 1);
  const first = h.get('personal-control-install').click(); await h.get('personal-control-install').click();
  assert.equal(prompted, 1); assert.equal(h.get('personal-control-install').disabled, true);
  finish({ outcome: 'accepted' }); await first;
  assert.match(h.get('personal-control-install-status').textContent, /Installation requested/);
  assert.equal(h.get('personal-control-install').disabled, false); await h.get('personal-control-install').click(); assert.equal(prompted, 1);
});

test('native dismissal and rejection both leave manual installation usable', async () => {
  for (const rejected of [false, true]) {
    const h = harness(); let prompted = 0;
    await h.window.emit('beforeinstallprompt', { preventDefault() {}, prompt: async () => { prompted++; if (rejected) throw new Error('Denied'); }, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
    await h.get('personal-control-install').click();
    assert.equal(prompted, 1); assert.equal(h.get('personal-control-install').disabled, false); assert.equal(h.get('personal-control-install-help').open, true);
    assert.match(h.get('personal-control-install-status').textContent, rejected ? /could not open/ : /dismissed/);
    await h.get('personal-control-install').click(); assert.equal(prompted, 1);
  }
});

test('standalone mode and appinstalled show Installed without prompting', async () => {
  const existing = harness({ standalone: true }); assert.equal(existing.get('personal-control-install').textContent, 'Installed');
  assert.equal(existing.get('personal-control-install').disabled, true);
  const h = harness(); await h.window.emit('appinstalled'); assert.equal(h.get('personal-control-install').textContent, 'Installed');
  await h.window.emit('beforeinstallprompt', { preventDefault() { throw new Error('Must not capture installed prompt'); } });
  await h.get('personal-control-install').click(); assert.equal(h.get('personal-control-install-help').open, false);
});

test('appinstalled wins over an outstanding native choice and standalone changes are honored', async () => {
  const h = harness(); let finish;
  await h.window.emit('beforeinstallprompt', { preventDefault() {}, prompt: async () => {}, userChoice: new Promise(resolve => { finish = resolve; }) });
  const pending = h.get('personal-control-install').click(); await h.window.emit('appinstalled'); finish({ outcome: 'dismissed' }); await pending;
  assert.equal(h.get('personal-control-install').textContent, 'Installed'); assert.match(h.get('personal-control-install-status').textContent, /^Installed/);
  const other = harness(); await other.media.emit('change', { matches: true }); assert.equal(other.get('personal-control-install').textContent, 'Installed');
});

test('early install events survive DOM readiness without automatic prompting', async () => {
  const h = harness({ loading: true }); let prompted = 0;
  await h.window.emit('beforeinstallprompt', { preventDefault() {}, prompt: async () => { prompted++; }, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
  assert.equal(prompted, 0); await h.document.emit('DOMContentLoaded'); await h.get('personal-control-install').click(); assert.equal(prompted, 1);
});

test('normal dashboard only receives the phone entry link and leaves authentication and title intact', async () => {
  const h = harness({ pathname: '/cluster/dashboard/' });
  assert.equal(h.get('personal-controller-link').href, '/cluster/control/'); assert.equal(h.get('personal-controller-card'), null);
  assert.equal(h.document.body.classList.contains('personal-controller'), false); assert.equal(h.document.title, 'Cluster workspace');
  assert.equal(h.get('pwInput').value, 'untouched-owner-input'); assert.equal(h.panel.style.display, 'block');
  await h.window.emit('pageshow'); assert.equal(h.get('existing-header').children.filter(item => item.id === 'personal-controller-link').length, 1);
  assert.deepEqual(h.forbidden, []); assert.deepEqual(h.calls, []);
});

test('personal query enables its own card and badge without enrolling a worker or changing sign-in', () => {
  const h = harness({ pathname: '/cluster/dashboard', search: '?controller=personal' });
  assert.equal(h.document.body.classList.contains('personal-controller'), true); assert.equal(h.document.title, 'Personal phone controller — CurtBrag');
  assert.equal(h.get('personal-controller-badge').textContent, 'Personal phone controller'); assert.match(h.get('personal-controller-sign-in').textContent, /existing dashboard password/);
  assert.equal(h.panel.children[0].id, 'existing-header'); assert.equal(h.panel.children[1].id, 'personal-controller-card');
  assert.equal(h.get('pwInput').value, 'untouched-owner-input'); assert.equal(h.get('loginBtn').textContent, 'Sign in'); assert.equal(h.panel.style.display, 'block');
  assert.deepEqual(h.forbidden, []); assert.deepEqual(h.calls, []);
});

test('signed-out personal mode keeps the existing gate intact and disables all control navigation', async () => {
  const h = harness({ pathname: '/cluster/dashboard/', search: '?controller=personal', signedOut: true });
  assert.equal(h.panel.style.display, 'none'); assert.equal(h.get('loginGate').hidden, false); assert.match(h.get('personal-controller-session').textContent, /Sign in/);
  for (const id of ['fleet-button', 'research-button', 'results-button', 'refresh']) { assert.equal(h.get('personal-controller-' + id).disabled, true); await h.get('personal-controller-' + id).click(); }
  assert.match(h.get('personal-controller-workers').textContent, /unavailable/); assert.match(h.get('personal-controller-bridge').textContent, /unavailable/);
  assert.deepEqual(h.calls, []); assert.deepEqual(h.forbidden, []);
});

test('only explicit actions click the existing navigation tabs or refresh button', async () => {
  const h = harness({ pathname: '/cluster/dashboard/', search: '?controller=personal' });
  delete h.get('existing-refresh').attributes.onclick;
  await h.window.emit('pageshow'); await h.window.emit('online'); await h.window.emit('offline'); await h.document.emit('visibilitychange'); h.flush();
  assert.deepEqual(h.calls, []);
  for (const view of ['fleet', 'research', 'results']) await h.get('personal-controller-' + view + '-button').click();
  await h.get('personal-controller-refresh').click(); assert.deepEqual(h.calls, ['workspace', 'tab:fleet', 'workspace', 'tab:research', 'workspace', 'tab:results', 'refresh']);
  assert.equal(h.get('cluster-view-tab-research').focused, true); assert.deepEqual(h.forbidden, []);
});

test('disabled or non-tab targets cannot be activated through the controller', async () => {
  const h = harness({ pathname: '/cluster/dashboard/', search: '?controller=personal' });
  h.get('cluster-view-tab-fleet').disabled = true; h.get('cluster-view-tab-research').setAttribute('role', 'button'); h.get('existing-refresh').disabled = true;
  await h.window.emit('pageshow');
  await h.get('personal-controller-fleet-button').click(); await h.get('personal-controller-research-button').click(); await h.get('personal-controller-refresh').click(); assert.deepEqual(h.calls, []);
});

test('worker counts are verified only with the existing live marker; arbitrary bridge text does not prove readiness', () => {
  const h = harness({ pathname: '/cluster/dashboard/', search: '?controller=personal' });
  assert.match(h.get('personal-controller-workers').textContent, /8 \/ 13.*latest dashboard update/);
  assert.match(h.get('personal-controller-bridge').textContent, /reported online/);
  h.grid().setAttribute('data-connection', 'stale'); h.bridge.textContent = 'Everything online, cloud ready, ADB authorized'; h.flush();
  assert.match(h.get('personal-controller-workers').textContent, /unavailable/); assert.match(h.get('personal-controller-bridge').textContent, /unavailable/);
  h.grid().setAttribute('data-connection', 'live'); h.count().textContent = '99 / 13'; h.flush(); assert.match(h.get('personal-controller-workers').textContent, /unavailable/);
});

test('bridge reports remain separate from worker heartbeat and network availability', async () => {
  const h = harness({ pathname: '/cluster/dashboard/', search: '?controller=personal', bridge: 'Bridge: offline · last seen never' });
  assert.match(h.get('personal-controller-bridge').textContent, /reported offline/); assert.match(h.get('personal-controller-workers').textContent, /latest dashboard update/);
  h.navigator.onLine = false; await h.window.emit('offline'); assert.match(h.get('personal-controller-internet').textContent, /reports offline/);
  assert.match(h.get('personal-controller-bridge').textContent, /reported offline/); assert.deepEqual(h.calls, []);
});

test('shortcuts reveal the outer Workspace tab before selecting a view when Administration hid it', async () => {
  const h = harness({ pathname: '/cluster/dashboard/', search: '?controller=personal' });
  h.get('tab-swarm').style.display = 'none';
  await h.get('personal-controller-research-button').click();
  assert.equal(h.get('tab-swarm').style.display, 'block'); assert.deepEqual(h.calls, ['workspace', 'tab:research']);
  assert.equal(h.get('cluster-view-tab-research').focused, true); assert.deepEqual(h.forbidden, []);
});

test('late workspace construction and sign-in visibility update without observer loops or automatic refresh', () => {
  const h = harness({ pathname: '/cluster/dashboard/', search: '?controller=personal', signedOut: true, lateWorkspace: true });
  assert.equal(h.get('personal-controller-card'), null); h.addWorkspace(); assert.ok(h.flush() < 5); assert.ok(h.get('personal-controller-card'));
  h.panel.style.display = 'block'; h.mutation(h.panel, 'attributes', 'style'); h.flush(); assert.equal(h.get('personal-controller-fleet-button').disabled, false);
  const before = h.writes(); h.count().textContent = '9 / 13'; assert.ok(h.flush() < 5); assert.match(h.get('personal-controller-workers').textContent, /9 \/ 13/);
  const after = h.writes(); h.mutation(h.count(), 'childList'); h.flush(); assert.equal(h.writes(), after + 1); assert.ok(after > before);
  assert.equal(h.panel.children.filter(item => item.id === 'personal-controller-card').length, 1); assert.deepEqual(h.calls, []); assert.deepEqual(h.forbidden, []);
});

test('pagehide disconnects bounded observers and pageshow reconnects without issuing commands', async () => {
  const h = harness({ pathname: '/cluster/dashboard/', search: '?controller=personal' });
  assert.ok(h.observers[0].targets.every(({ element }) => ['panel', 'tab-swarm', 'bridgeStatus'].includes(element.id)));
  await h.window.emit('pagehide'); assert.equal(h.observers[0].targets.length, 0);
  h.count().textContent = '10 / 13'; h.flush(); await h.window.emit('pageshow'); assert.match(h.get('personal-controller-workers').textContent, /10 \/ 13/);
  assert.ok(h.observers[1].targets.length > 0); assert.deepEqual(h.calls, []);
});

test('out-of-scope pages and other controller query values never activate personal control', async () => {
  for (const pathname of ['/', '/cluster/display.html', '/cluster/control/extra', '/cluster/dashboard/extra']) {
    const h = harness({ pathname, search: '?controller=personal' }); assert.equal(h.window.listeners.size, 0); assert.deepEqual(h.forbidden, []);
  }
  const h = harness({ pathname: '/cluster/dashboard/', search: '?controller=other' }); assert.equal(h.get('personal-controller-card'), null);
  await h.window.emit('beforeinstallprompt', { preventDefault() { throw new Error('Normal dashboard must not capture install prompts'); } });
});
