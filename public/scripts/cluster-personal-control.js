(() => {
  'use strict';
  const landing = /^\/cluster\/control\/?$/.test(location.pathname);
  const dashboard = /^\/cluster\/dashboard\/?$/.test(location.pathname);
  if (!landing && !dashboard) return;

  const personal = dashboard && new URLSearchParams(location.search).get('controller') === 'personal';
  const standalone = typeof window.matchMedia === 'function' ? window.matchMedia('(display-mode: standalone)') : null;
  let installed = !!standalone?.matches;
  let installEvent = null;
  let installing = false;
  let initialized = false;
  let observer = null;
  let watchedWorkspace = null;
  let watchedBridge = null;
  let installMessage = '';
  let inventoryBusy = false;
  let inventoryRecords = [];
  let inventoryHasSnapshot = false;
  let inventoryStatusText = 'Open Fleet or Devices to view saved personal controllers.';
  let inventoryStatusError = false;
  let inventorySignedIn = null;
  let inventoryLoadAttempted = false;
  let inventoryRequestVersion = 0;
  let inventoryObserver = null;
  let watchedInventoryWorkspace = null;
  const byId = id => document.getElementById(id);
  const setText = (element, text) => { if (element && element.textContent !== text) element.textContent = text; };
  const make = (tag, id, text) => {
    const element = document.createElement(tag);
    if (id) element.id = id;
    if (text) element.textContent = text;
    return element;
  };

  function updateInstall() {
    const button = byId('personal-control-install');
    if (!button) return;
    button.disabled = installed || installing;
    setText(button, installed ? 'Installed' : installing ? 'Opening install…' : 'Add to home screen');
    setText(byId('personal-control-install-status'), installed ? 'Installed. Open this controller from your home screen.' : installMessage || (installEvent ? 'Home-screen installation is available.' : 'Use your browser’s home-screen or install option.'));
  }
  function openInstallHelp(message) {
    const help = byId('personal-control-install-help');
    if (help) { help.hidden = false; help.open = true; }
    installMessage = message;
    updateInstall();
  }
  async function requestInstall() {
    if (installed || installing) return;
    const available = installEvent;
    if (!available) {
      openInstallHelp('Open your browser menu and choose Add to home screen or Install app. You can also keep using this page in the browser.');
      return;
    }
    installEvent = null;
    installing = true;
    updateInstall();
    try {
      await available.prompt();
      const choice = await available.userChoice;
      if (!installed) openInstallHelp(choice?.outcome === 'accepted' ? 'Installation requested. Follow your browser’s instructions to finish.' : 'Installation dismissed. You can use the browser menu to add this controller later.');
    } catch {
      if (!installed) openInstallHelp('Your browser could not open installation. Use its menu to add this controller to the home screen.');
    } finally {
      installing = false;
      updateInstall();
    }
  }
  function bindInstall() {
    const button = byId('personal-control-install');
    if (button && button.dataset.personalInstallBound !== '1') {
      button.dataset.personalInstallBound = '1';
      button.addEventListener('click', requestInstall);
    }
    updateInstall();
  }
  window.addEventListener('beforeinstallprompt', event => {
    if (installed || (!landing && !personal)) return;
    event.preventDefault();
    installEvent = event;
    installMessage = '';
    updateInstall();
  });
  window.addEventListener('appinstalled', () => { installed = true; installEvent = null; updateInstall(); });
  standalone?.addEventListener?.('change', event => {
    if (event.matches) { installed = true; installEvent = null; }
    updateInstall();
  });

  function panelVisible() {
    const panel = byId('panel');
    return !!panel && !panel.hidden && panel.style.display !== 'none' && (typeof window.getComputedStyle !== 'function' || window.getComputedStyle(panel).display !== 'none');
  }
  function inventoryMessage(text, error = false) {
    inventoryStatusText = text; inventoryStatusError = error;
    for (const id of ['personal-controller-inventory-status', 'personal-controller-fleet-status']) {
      const status = byId(id);
      if (status) { setText(status, text); if (status.dataset.error !== (error ? '1' : '0')) status.dataset.error = error ? '1' : '0'; }
    }
  }
  function inventoryLock(busy) {
    inventoryBusy = busy;
    for (const id of ['personal-controller-inventory-refresh', 'personal-controller-register', 'personal-controller-fleet-refresh']) {
      const button = byId(id);
      if (button) button.disabled = busy;
    }
    for (const id of ['personal-controller-inventory', 'personal-controller-fleet']) byId(id)?.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
  function inventoryApi() {
    if (!panelVisible()) throw new Error('Sign in to view or add personal controllers.');
    if (typeof window.callApi !== 'function') throw new Error('Dashboard controls are unavailable. Refresh this page and retry.');
    return window.callApi;
  }
  function privateAddress(value) {
    const parts = value.split('.');
    if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return false;
    const numbers = parts.map(Number);
    return numbers[0] === 10 || (numbers[0] === 172 && numbers[1] >= 16 && numbers[1] <= 31) || (numbers[0] === 192 && numbers[1] === 168);
  }
  function registrationPayload() {
    const value = key => byId('personal-controller-input-' + key).value.trim();
    const name = value('name');
    const payload = {
      controller_id: value('controller_id') || controllerSlug(name), name, model: value('model'),
      private_ip: value('private_ip'), adb_connect_port: Number(value('adb_connect_port')),
    };
    const guid = value('adb_guid');
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(payload.controller_id)) throw new Error('Use a controller ID of up to 64 lowercase letters, numbers and hyphens, starting with a letter.');
    if (!payload.name || payload.name.length > 80 || !/^[\p{L}\p{N}\p{M} ._'’()/-]+$/u.test(payload.name)) throw new Error('Enter a controller name of up to 80 letters, numbers, spaces or simple punctuation.');
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,63}$/.test(payload.model)) throw new Error('Enter a model of up to 64 letters, numbers, spaces, dots, underscores, hyphens or parentheses.');
    if (!privateAddress(payload.private_ip)) throw new Error('Enter its private local IPv4 address, such as 192.168.1.20.');
    if (!/^\d{1,5}$/.test(value('adb_connect_port')) || !Number.isInteger(payload.adb_connect_port) || payload.adb_connect_port < 1 || payload.adb_connect_port > 65535) throw new Error('Enter a wireless debugging connection port from 1 to 65535.');
    if (guid && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(guid)) throw new Error('Use a wireless debugging ID of up to 160 letters, numbers, dots, hyphens or underscores, starting with a letter or number.');
    if (guid) payload.adb_guid = guid;
    return payload;
  }
  function controllerSlug(name) {
    let slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!/^[a-z]/.test(slug)) slug = 'personal-' + (slug || 'controller');
    return slug.slice(0, 64).replace(/-+$/g, '');
  }
  function isPersonalRecord(record) {
    return !!record && record.role === 'personal-controller' && record.worker_enabled === false && record.mining_enabled === false && typeof record.controller_id === 'string' && typeof record.name === 'string' && typeof record.model === 'string' && typeof record.private_ip === 'string' && Number.isInteger(record.adb_connect_port);
  }
  function registrationTime(record) {
    const registered = typeof record.registered_at === 'number' && Number.isFinite(record.registered_at) && record.registered_at > 0 ? new Date(record.registered_at) : null;
    return registered && Number.isFinite(registered.getTime()) ? registered.toLocaleString() : 'Unavailable';
  }
  function renderFleetControllers(records) {
    const list = byId('personal-controller-fleet-list');
    if (!list) return;
    list.textContent = '';
    if (!records.length) { list.append(make('div', null, 'No personal controllers registered.')); return; }
    for (const record of records) {
      const tile = make('article'); tile.className = 'personal-controller-fleet-tile';
      const heading = make('div'); heading.className = 'personal-controller-fleet-tile-heading';
      const name = make('strong', null, record.name);
      const badge = make('span', null, 'REGISTERED'); badge.className = 'personal-controller-fleet-badge';
      heading.append(name, badge);
      tile.append(heading, make('div', null, 'Personal controller · ' + record.model), make('div', null, 'Saved connection: ' + record.private_ip + ':' + record.adb_connect_port), make('div', null, 'Last registered: ' + registrationTime(record)));
      list.append(tile);
    }
  }
  function renderInventory(records) {
    inventoryRecords = records;
    inventoryHasSnapshot = true;
    renderFleetControllers(records);
    const list = byId('personal-controller-inventory-list');
    if (!list) return;
    list.textContent = '';
    if (!records.length) { list.append(make('p', null, 'No personal controllers registered.')); return; }
    for (const record of records) {
      const card = make('article'); card.className = 'personal-controller-inventory-record';
      const label = make('p', null, 'Registered personal controller'); label.className = 'personal-controller-registration-label';
      card.append(label, make('h3', null, record.name));
      const details = make('dl');
      const fields = [['Model', record.model], ['Local network address', record.private_ip], ['Wireless debugging port', String(record.adb_connect_port)], ['Last registered', registrationTime(record)]];
      for (const [name, value] of fields) details.append(make('dt', null, name), make('dd', null, value));
      const identifiers = make('details'); identifiers.className = 'personal-controller-inventory-identifiers';
      identifiers.append(make('summary', null, 'Connection identifiers'));
      const identifierList = make('dl'); identifierList.append(make('dt', null, 'Controller ID'), make('dd', null, record.controller_id));
      if (typeof record.adb_guid === 'string' && record.adb_guid) identifierList.append(make('dt', null, 'Wireless debugging ID'), make('dd', null, record.adb_guid));
      identifiers.append(identifierList); card.append(details, identifiers); list.append(card);
    }
  }
  async function refreshInventory() {
    if (inventoryBusy) return;
    if (!panelVisible()) { syncControllerSession(); inventoryMessage('Sign in to view or add personal controllers.', true); return; }
    const requestVersion = ++inventoryRequestVersion;
    if (panelVisible()) inventoryLoadAttempted = true;
    inventoryLock(true); inventoryMessage('Loading personal controllers…');
    try {
      const api = inventoryApi();
      const response = await api('personal-controllers');
      if (!currentInventoryRequest(requestVersion)) return;
      if (!Array.isArray(response?.controllers) || response.controllers.some(record => !isPersonalRecord(record))) throw new Error('The saved controller list could not be verified. Retry refresh.');
      renderInventory(response.controllers);
      inventoryMessage(response.controllers.length ? 'Saved personal controllers loaded. Registration does not report whether a device is online.' : 'No personal controllers registered.');
    } catch (error) {
      if (!currentInventoryRequest(requestVersion)) return;
      inventoryMessage(error instanceof Error ? error.message : 'Could not load personal controllers. Retry refresh.', true);
    } finally { if (requestVersion === inventoryRequestVersion) inventoryLock(false); }
  }
  async function registerController(event) {
    event.preventDefault();
    if (inventoryBusy) return;
    if (!panelVisible()) { syncControllerSession(); inventoryMessage('Sign in to view or add personal controllers.', true); return; }
    const requestVersion = ++inventoryRequestVersion;
    inventoryLock(true); inventoryMessage('Saving personal controller…');
    try {
      const api = inventoryApi();
      const payload = registrationPayload();
      const response = await api('register-personal-controller', 'POST', payload);
      if (!currentInventoryRequest(requestVersion)) return;
      if (response?.ok !== true || !isPersonalRecord(response.controller) || response.controller.controller_id !== payload.controller_id) throw new Error('Registration response could not be verified. Refresh the list before retrying.');
      const records = inventoryRecords.filter(record => record.controller_id !== response.controller.controller_id);
      records.push(response.controller); renderInventory(records);
      inventoryMessage(response.created === false ? 'This personal controller is already registered with these details.' : 'Personal controller registered. Its saved details are shown below.');
    } catch (error) {
      if (!currentInventoryRequest(requestVersion)) return;
      inventoryMessage(error instanceof Error ? error.message : 'Registration was not confirmed. Refresh the list before retrying.', true);
    } finally { if (requestVersion === inventoryRequestVersion) inventoryLock(false); }
  }
  function currentInventoryRequest(requestVersion) {
    if (!panelVisible()) { syncControllerSession(); return false; }
    return requestVersion === inventoryRequestVersion;
  }
  function syncControllerSession() {
    const signedIn = panelVisible();
    if (signedIn !== inventorySignedIn) {
      inventorySignedIn = signedIn;
      inventoryLoadAttempted = false;
      if (!signedIn) {
        inventoryRequestVersion += 1;
        inventoryRecords = []; inventoryHasSnapshot = false;
        for (const id of ['personal-controller-inventory-list', 'personal-controller-fleet-list']) {
          const list = byId(id); if (list) list.textContent = '';
        }
        for (const key of ['name', 'model', 'private_ip', 'adb_connect_port', 'controller_id', 'adb_guid']) {
          const input = byId('personal-controller-input-' + key); if (input) input.value = '';
        }
        inventoryLock(false);
        inventoryMessage('Sign in to view personal controllers.');
      }
    }
    if (signedIn && byId('personal-controller-fleet') && !inventoryLoadAttempted && !inventoryBusy) refreshInventory();
  }
  function createFleetInventory() {
    const fleet = byId('cluster-view-fleet');
    const workers = byId('swarm-nodes')?.parentElement;
    if (!fleet || !workers || workers.parentElement !== fleet || byId('personal-controller-fleet')) return;
    const section = make('section', 'personal-controller-fleet'); section.className = 'cluster-control-card';
    section.setAttribute('aria-labelledby', 'personal-controller-fleet-heading');
    const heading = make('div'); heading.className = 'personal-controller-fleet-heading';
    const refresh = make('button', 'personal-controller-fleet-refresh', 'Refresh personal controllers'); refresh.type = 'button'; refresh.addEventListener('click', refreshInventory);
    heading.append(make('h3', 'personal-controller-fleet-heading', 'Personal controllers'), refresh);
    const status = make('p', 'personal-controller-fleet-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    section.append(heading, make('p', null, 'Registered personal phones, shown separately from cluster workers.'), status, make('div', 'personal-controller-fleet-list'));
    workers.insertAdjacentElement('afterend', section);
    inventoryMessage(inventoryStatusText, inventoryStatusError);
    if (inventoryHasSnapshot) renderFleetControllers(inventoryRecords);
    inventoryLock(inventoryBusy);
    const fleetTab = byId('cluster-view-tab-fleet');
    if (fleetTab && fleetTab.dataset.personalControllersBound !== '1') {
      fleetTab.dataset.personalControllersBound = '1';
      fleetTab.addEventListener('click', syncControllerSession);
    }
  }
  function watchControllerInventory() {
    if (typeof MutationObserver !== 'function' || (!byId('tab-devices') && !byId('personal-controller-fleet'))) return;
    if (!inventoryObserver) {
      inventoryObserver = new MutationObserver(() => { createFleetInventory(); syncControllerSession(); watchControllerInventory(); });
      const panel = byId('panel');
      if (panel) inventoryObserver.observe(panel, { childList: true, attributes: true, attributeFilter: ['style', 'hidden'] });
    }
    const workspace = byId('tab-swarm');
    if (workspace && workspace !== watchedInventoryWorkspace) {
      inventoryObserver.observe(workspace, { childList: true });
      watchedInventoryWorkspace = workspace;
    }
  }
  function createInventory() {
    const tab = byId('tab-devices');
    if (!tab || byId('personal-controller-inventory')) return;
    const section = make('section', 'personal-controller-inventory');
    section.setAttribute('aria-labelledby', 'personal-controller-inventory-heading');
    section.append(make('h2', 'personal-controller-inventory-heading', 'Personal controllers'), make('p', null, 'Phones used to control the cluster. These registrations stay separate from cluster workers.'));
    const refresh = make('button', 'personal-controller-inventory-refresh', 'Refresh personal controllers');
    refresh.type = 'button'; refresh.addEventListener('click', refreshInventory);
    const status = make('p', 'personal-controller-inventory-status', 'Open Devices or refresh to view saved personal controllers.');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const list = make('div', 'personal-controller-inventory-list');
    section.append(refresh, status, list);
    const form = make('form', 'personal-controller-registration-form');
    form.append(make('h3', null, 'Add personal controller'), make('p', null, 'Save the connection details shown in Wireless debugging. Registration does not pair or connect the phone.'));
    const fields = make('div'); fields.className = 'personal-controller-registration-fields';
    const addField = (parent, key, label, defaultValue = '', maxLength = 80) => {
      const wrapper = make('div'); const input = make('input', 'personal-controller-input-' + key);
      const caption = make('label', null, label); caption.setAttribute('for', input.id);
      input.type = 'text'; input.name = key; input.value = defaultValue; input.maxLength = maxLength; input.autocomplete = 'off';
      input.required = key !== 'adb_guid' && key !== 'controller_id';
      if (key === 'adb_connect_port') { input.inputMode = 'numeric'; input.setAttribute('pattern', '[0-9]{1,5}'); }
      if (key === 'private_ip') { input.inputMode = 'decimal'; input.placeholder = '192.168.1.20'; }
      wrapper.append(caption, input); parent.append(wrapper);
    };
    addField(fields, 'name', 'Controller name');
    addField(fields, 'model', 'Phone model', '', 64);
    addField(fields, 'private_ip', 'Local network address', '', 15);
    addField(fields, 'adb_connect_port', 'Wireless debugging connection port', '', 5);
    const advanced = make('details'); advanced.className = 'personal-controller-registration-advanced';
    advanced.append(make('summary', null, 'Advanced connection details'), make('p', null, 'A stable controller ID is created from the name. Set your own ID only if needed.'));
    addField(advanced, 'controller_id', 'Controller ID (optional)', '', 64);
    addField(advanced, 'adb_guid', 'Wireless debugging ID (optional)', '', 160);
    const submit = make('button', 'personal-controller-register', 'Add personal controller'); submit.type = 'submit';
    form.append(fields, advanced, submit); form.addEventListener('submit', registerController);
    section.append(form); tab.insertBefore(section, tab.firstElementChild);
    const idInput = byId('personal-controller-input-controller_id');
    idInput.placeholder = 'Created from the controller name';
    byId('personal-controller-input-name').addEventListener('input', event => { idInput.placeholder = controllerSlug(event.target.value.trim()); });
    document.querySelector('[data-tab="devices"]')?.addEventListener('click', refreshInventory);
  }
  function refreshButton() {
    return Array.from(byId('tab-swarm')?.querySelectorAll('button') || []).find(button => button.textContent.trim() === 'Refresh') || null;
  }
  function navigate(view) {
    const target = byId('cluster-view-tab-' + view);
    if (panelVisible() && target?.getAttribute('role') === 'tab' && !target.disabled) {
      const workspace = document.querySelector('[data-tab="swarm"]');
      if (workspace && !workspace.disabled) workspace.click();
      target.click(); target.focus();
    }
  }
  function createCard(panel) {
    const card = make('section', 'personal-controller-card');
    card.className = 'personal-controller-card cluster-control-card';
    card.append(make('h2', null, 'Personal phone controller'), make('p', null, 'Control your cluster from this phone, at home or away.'));
    const status = make('div', 'personal-controller-status');
    status.className = 'controller-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    for (const name of ['session', 'internet', 'workers', 'bridge']) status.append(make('p', 'personal-controller-' + name));
    card.append(status);
    const actions = make('div');
    actions.className = 'cluster-action-row controller-shortcuts';
    for (const [view, label] of [['fleet', 'Fleet'], ['research', 'Research'], ['results', 'Queue & results']]) {
      const button = make('button', 'personal-controller-' + view + '-button', label);
      button.type = 'button';
      button.addEventListener('click', () => navigate(view));
      actions.append(button);
    }
    const refresh = make('button', 'personal-controller-refresh', 'Refresh status');
    refresh.type = 'button';
    refresh.addEventListener('click', () => {
      const target = refreshButton();
      if (panelVisible() && target && !target.disabled) target.click();
    });
    actions.append(refresh);
    card.append(actions, make('p', null, 'Home devices need to stay connected. Queue results are shared; saved reports stay in this browser.'));
    const install = make('button', 'personal-control-install', 'Add to home screen');
    install.type = 'button';
    const help = make('details', 'personal-control-install-help');
    help.append(make('summary', null, 'Home-screen setup'), make('p', null, 'In Chrome, open the menu and choose Add to home screen or Install app if offered. Sign in with your existing dashboard password.'));
    const installStatus = make('p', 'personal-control-install-status');
    installStatus.setAttribute('role', 'status');
    card.append(install, installStatus, help);
    panel.insertBefore(card, panel.firstElementChild?.nextElementSibling || byId('tab-swarm'));
    bindInstall();
  }
  function updateStatus() {
    if (!personal || !byId('personal-controller-card')) return;
    const signedIn = panelVisible();
    setText(byId('personal-controller-session'), signedIn ? 'Signed in.' : 'Sign in to use controls.');
    setText(byId('personal-controller-internet'), navigator.onLine === false ? 'Phone network: browser reports offline.' : 'Phone network: browser reports online.');
    const count = byId('swarm-nodes-online')?.textContent?.trim() || '';
    const parts = /^(\d+)\s*\/\s*(\d+)$/.exec(count);
    const verified = signedIn && byId('swarm-nodes')?.dataset.connection === 'live' && parts && Number(parts[2]) > 0 && Number(parts[1]) <= Number(parts[2]);
    setText(byId('personal-controller-workers'), verified ? 'Workers: ' + count + ' · latest dashboard update.' : 'Workers: status unavailable. Refresh the dashboard.');
    const bridge = byId('bridgeStatus')?.textContent?.replace(/\s+/g, ' ').trim() || '';
    const reported = /^Bridge:\s*(online|offline)\s*·\s*last seen\s+(.+)$/.exec(bridge);
    setText(byId('personal-controller-bridge'), signedIn && reported ? 'Home controller: reported ' + reported[1] + ' · last seen ' + reported[2].slice(0, 240) + '.' : 'Home controller: status unavailable.');
    for (const view of ['fleet', 'research', 'results']) {
      const target = byId('cluster-view-tab-' + view);
      byId('personal-controller-' + view + '-button').disabled = !signedIn || !target || target.getAttribute('role') !== 'tab' || target.disabled;
    }
    byId('personal-controller-refresh').disabled = !signedIn || !refreshButton() || refreshButton().disabled;
  }
  function ensureDashboard() {
    const panel = byId('panel');
    if (!panel) return;
    createInventory();
    createFleetInventory();
    syncControllerSession();
    watchControllerInventory();
    if (!personal) {
      if (!byId('personal-controller-link')) {
        const link = make('a', 'personal-controller-link', 'Use your personal phone');
        link.href = '/cluster/control/';
        link.className = 'personal-controller-link';
        (panel.firstElementChild || panel).append(link);
      }
      return;
    }
    document.body.classList.add('personal-controller');
    if (document.title !== 'Personal phone controller — CurtBrag') document.title = 'Personal phone controller — CurtBrag';
    const gate = byId('loginGate');
    if (gate && !byId('personal-controller-sign-in')) gate.append(make('p', 'personal-controller-sign-in', 'Sign in with your existing dashboard password.'));
    const heading = panel.querySelector('h1');
    if (heading && !byId('personal-controller-badge')) {
      const badge = make('span', 'personal-controller-badge', 'Personal phone controller');
      badge.className = 'personal-controller-badge';
      heading.insertAdjacentElement('afterend', badge);
    }
    if (byId('tab-swarm') && !byId('personal-controller-card')) createCard(panel);
    updateStatus();
  }
  function watchDashboard() {
    if (!personal || typeof MutationObserver !== 'function') return;
    if (!observer) {
      observer = new MutationObserver(() => { ensureDashboard(); watchDashboard(); });
      const panel = byId('panel');
      if (panel) observer.observe(panel, { childList: true, attributes: true, attributeFilter: ['style', 'hidden'] });
    }
    const workspace = byId('tab-swarm');
    if (workspace && workspace !== watchedWorkspace) {
      observer.observe(workspace, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-connection'] });
      watchedWorkspace = workspace;
    }
    const bridge = byId('bridgeStatus');
    if (bridge && bridge !== watchedBridge) {
      observer.observe(bridge, { childList: true, subtree: true, characterData: true });
      watchedBridge = bridge;
    }
  }
  function init() {
    if (initialized) return;
    initialized = true;
    if (dashboard) { ensureDashboard(); watchDashboard(); }
    if (landing) bindInstall();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
  const recheck = () => { if (initialized && dashboard) { ensureDashboard(); watchDashboard(); } updateInstall(); };
  window.addEventListener('online', recheck);
  window.addEventListener('offline', recheck);
  window.addEventListener('pageshow', recheck);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) recheck(); });
  window.addEventListener('pagehide', () => { observer?.disconnect(); observer = null; watchedWorkspace = null; watchedBridge = null; inventoryObserver?.disconnect(); inventoryObserver = null; watchedInventoryWorkspace = null; });
})();
