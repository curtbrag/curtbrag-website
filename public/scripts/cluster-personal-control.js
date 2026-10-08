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
  window.addEventListener('pagehide', () => { observer?.disconnect(); observer = null; watchedWorkspace = null; watchedBridge = null; });
})();
