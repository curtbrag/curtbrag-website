(() => {
  'use strict';
  if (!/^\/cluster\/dashboard\/?$/.test(location.pathname)) return;
  const TARGETS = ['phone173', 'phone174', 'phone176', 'phone177', 'phone191', 'phone195', 'phone253', 'phone254', 'Alina', 'Nexus', 'SteamDeck', 'viki', 'RenderRig'];
  const UNIT_LABELS = { queued: 'Queued', 'launch-requested': 'Launch requested', failed: 'Failed', skipped: 'Skipped', unconfirmed: 'Unconfirmed' };
  const RUNNER_LABELS = { off: 'Off', waiting: 'Waiting for the home PC', following: 'Following supported links', unavailable: 'Unavailable' };
  const PRIVATE_KEYS = new Set(['token', 'tokens', 'auth', 'password', 'accesstoken', 'authorization', 'secret', 'session', 'code', 'key']);
  let snapshot = null;
  let busy = false;
  let uncertainAction = false;
  let signedIn = null;
  let generation = 0;
  let initialRead = false;
  let timer = null;
  let observer = null;
  let watchedWorkspace = null;
  let suspended = false;
  let initialized = false;
  let navigationKey = '';
  const byId = id => document.getElementById(id);
  const make = (tag, id, text = '') => { const node = document.createElement(tag); if (id) node.id = id; if (text) node.textContent = text; return node; };
  const text = (id, value) => { const node = byId(id); if (node && node.textContent !== value) node.textContent = value; };
  const hasUUID = () => typeof window.crypto?.randomUUID === 'function';
  function authenticated() {
    const panel = byId('panel');
    return !!panel && !panel.hidden && panel.style.display !== 'none' && (typeof window.getComputedStyle !== 'function' || window.getComputedStyle(panel).display !== 'none');
  }
  const usable = () => authenticated() && !document.hidden && !suspended;
  const active = () => !!snapshot?.active && snapshot.expires_at > Date.now();
  function message(value, error = false) {
    text('phone-follow-status', value);
    const node = byId('phone-follow-status');
    if (node) node.dataset.error = error ? '1' : '0';
  }
  function updateButtons() {
    const allowed = usable() && !busy && hasUUID();
    const start = byId('phone-follow-start'), stop = byId('phone-follow-stop'), refresh = byId('phone-follow-refresh');
    if (start) start.disabled = !allowed || !snapshot || active() || uncertainAction;
    if (stop) stop.disabled = !allowed || (!snapshot?.active && !uncertainAction);
    if (refresh) refresh.disabled = !usable() || busy;
    byId('phone-follow-control')?.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
  function clearTimer() { if (timer !== null) { window.clearTimeout(timer); timer = null; } }
  function schedule() {
    clearTimer();
    if (!usable() || !byId('phone-follow-control')) return;
    let delay = active() ? 5000 : 20000;
    if (active()) delay = Math.min(delay, Math.max(1, snapshot.expires_at - Date.now()));
    timer = window.setTimeout(() => { timer = null; render(); readStatus(); }, delay);
  }
  function publicURL(value) {
    if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) return null;
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.href.length > 2048 || host.length > 253 || host.endsWith('.') ||
          !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host) || /^[\d.]+$/.test(host) || /^\d+$/.test(host.split('.').at(-1)) || host.split('.').some(label => label.length > 63) ||
          ['localhost', 'local', 'localdomain', 'lan', 'internal', 'test', 'invalid', 'onion', 'example', 'home'].some(suffix => host === suffix || host.endsWith('.' + suffix))) return null;
      const path = decodeURIComponent(url.pathname).toLowerCase();
      if (path.split('/').some(segment => ['login', 'signin', 'sign-in', 'auth', 'authenticate', 'authentication', 'oauth', 'oauth2'].includes(segment)) || (['curtbrag.com', 'www.curtbrag.com'].includes(host) && /^\/cluster\/(control|dashboard)(?:\/|$)/.test(path))) return null;
      const privateKey = key => PRIVATE_KEYS.has(key.toLowerCase().replace(/[^a-z]/g, ''));
      for (const key of url.searchParams.keys()) if (privateKey(key)) return null;
      for (const key of new URLSearchParams(url.hash.slice(1).replace(/^\?/, '')).keys()) if (privateKey(key)) return null;
      return url;
    } catch { return null; }
  }
  const time = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString() : 'Not reported';
  function checked(response) {
    const follow = response?.follow;
    if (response?.ok !== true || !follow || typeof follow.active !== 'boolean' || !follow.runner || !Object.hasOwn(RUNNER_LABELS, follow.runner.status)) throw new Error('The saved follow status could not be verified. Refresh status.');
    if (follow.active && (follow.controller_id !== 'curtis-s26-ultra' || typeof follow.session_id !== 'string' || !follow.session_id || follow.session_id.length > 128 || !Number.isSafeInteger(follow.started_at) || follow.started_at <= 0 || !Number.isSafeInteger(follow.expires_at) || follow.expires_at > 8640000000000000 || follow.expires_at !== follow.started_at + 3600000)) throw new Error('The saved follow session could not be verified. Refresh status.');
    if (follow.current_url != null && !publicURL(follow.current_url)) throw new Error('The reported link is not a supported public HTTPS address.');
    const navigation = follow.current_navigation;
    if (navigation != null) {
      if (typeof navigation.id !== 'string' || !navigation.id || navigation.id.length > 120 || !Array.isArray(navigation.units) || navigation.units.length > TARGETS.length) throw new Error('The launch report could not be verified. Refresh status.');
      const seen = new Set();
      for (const unit of navigation.units) {
        if (!unit || !TARGETS.includes(unit.device_id) || seen.has(unit.device_id) || !Object.hasOwn(UNIT_LABELS, unit.status) || (unit.message != null && (typeof unit.message !== 'string' || unit.message.length > 240))) throw new Error('The launch report could not be verified. Refresh status.');
        seen.add(unit.device_id);
      }
    }
    return follow;
  }
  function render() {
    if (!byId('phone-follow-control')) return;
    const following = active();
    text('phone-follow-badge', !snapshot ? 'OFF' : following ? 'SESSION SAVED' : 'OFF');
    text('phone-follow-session', !snapshot ? 'No follow session has been verified.' : following ? 'One-hour session saved. Stops automatically: ' + time(snapshot.expires_at) + '.' : snapshot.active ? 'The saved session has expired.' : 'Following is off.');
    const runner = snapshot?.runner;
    const seen = typeof runner?.seen_at === 'number' && Number.isFinite(runner.seen_at) && runner.seen_at > 0;
    const stale = seen && (Date.now() - runner.seen_at > 30000 || runner.seen_at - Date.now() > 10000);
    let runnerText = !snapshot ? 'Main PC connection has not been checked.' : !following ? seen && !stale && runner.status === 'off' ? 'Main PC ready · following off.' : 'Main PC connection not confirmed · following off.' : 'Runner: ' + RUNNER_LABELS[runner.status] + (stale ? ' · last update is stale' : '') + '.';
    if (following && runner?.status === 'following' && !seen) runnerText = 'Runner: following was reported without a recent update time.';
    if (following && typeof runner?.message === 'string' && runner.message) runnerText += ' ' + runner.message.slice(0, 240);
    if (following && seen) runnerText += ' Last update: ' + time(runner.seen_at) + '.';
    text('phone-follow-runner', runnerText);
    const link = byId('phone-follow-current-url');
    const url = following ? publicURL(snapshot.current_url) : null;
    if (link) { link.hidden = !url; if (url) { link.href = url.href; if (link.textContent !== url.href) link.textContent = url.href; } else { link.removeAttribute('href'); link.textContent = ''; } }
    text('phone-follow-current-empty', url ? '' : 'No supported public link reported.');
    const navigation = following ? snapshot.current_navigation : null;
    const key = JSON.stringify(navigation);
    if (key !== navigationKey) {
      navigationKey = key;
      const list = byId('phone-follow-units'); list.textContent = '';
      const reports = new Map((navigation?.units || []).map(unit => [unit.device_id, unit]));
      for (const id of TARGETS) {
        const row = make('div'); row.className = 'phone-follow-unit';
        const report = reports.get(id);
        row.append(make('strong', null, id), make('span', null, report ? UNIT_LABELS[report.status] : 'No launch reported'));
        if (report?.message) row.append(make('small', null, report.message));
        list.append(row);
      }
    }
    updateButtons();
  }
  function validReply(requestGeneration) {
    if (!authenticated()) { sync(); return false; }
    return generation === requestGeneration && usable();
  }
  async function readStatus() {
    if (!usable() || busy || !byId('phone-follow-control')) return;
    initialRead = true; clearTimer(); busy = true; updateButtons();
    const requestGeneration = generation;
    try {
      if (typeof window.callApi !== 'function') throw new Error('Dashboard controls are unavailable. Refresh this page.');
      const response = await window.callApi('phone-follow-status');
      if (!validReply(requestGeneration)) return;
      snapshot = checked(response); uncertainAction = false;
      message('Saved follow status checked. Browser-launch reports do not verify physical screens.'); render();
    } catch (error) {
      if (!validReply(requestGeneration)) return;
      message(error instanceof Error ? error.message : 'Follow status is unavailable. Refresh status.', true); render();
    } finally {
      if (generation === requestGeneration) { busy = false; updateButtons(); schedule(); }
    }
  }
  async function action(kind) {
    if (!usable() || busy || !hasUUID()) return;
    if (kind === 'start' && (!snapshot || active() || uncertainAction)) return;
    if (kind === 'stop' && !snapshot?.active && !uncertainAction) return;
    clearTimer(); busy = true; updateButtons();
    const requestGeneration = generation;
    message(kind === 'start' ? 'Saving a one-hour follow session…' : 'Stopping the follow session…');
    try {
      const body = { request_id: window.crypto.randomUUID() };
      if (kind === 'start') Object.assign(body, { controller_id: 'curtis-s26-ultra', duration_minutes: 60 });
      if (typeof window.callApi !== 'function') throw new Error('Dashboard controls are unavailable. Refresh this page.');
      const response = await window.callApi('phone-follow-' + kind, 'POST', body);
      if (!validReply(requestGeneration)) return;
      snapshot = checked(response); uncertainAction = false;
      message(kind === 'start' ? active() ? 'Follow session saved. Check the runner status below.' : 'Follow request recorded; following is currently off.' : active() ? 'Stop request recorded; a follow session is currently active. Refresh status.' : 'Follow session stopped.'); render();
    } catch (error) {
      if (!validReply(requestGeneration)) return;
      uncertainAction = true;
      message((error instanceof Error ? error.message : 'The request was not confirmed.') + ' Refresh status before starting again; Stop remains available.', true); render();
    } finally {
      if (generation === requestGeneration) { busy = false; updateButtons(); schedule(); }
    }
  }
  function mount() {
    const fleet = byId('cluster-view-fleet'); const workers = byId('swarm-nodes')?.parentElement;
    if (!fleet || !workers || workers.parentElement !== fleet || byId('phone-follow-control')) return;
    const card = make('section', 'phone-follow-control'); card.className = 'cluster-control-card phone-follow-card'; card.setAttribute('aria-labelledby', 'phone-follow-heading');
    const heading = make('div'); heading.className = 'phone-follow-heading';
    heading.append(make('h3', 'phone-follow-heading', 'Follow S26'), make('span', 'phone-follow-badge', 'OFF'));
    const controls = make('div'); controls.className = 'cluster-action-row';
    for (const [id, label, handler] of [['start', 'Start following S26', () => action('start')], ['stop', 'Stop following', () => action('stop')], ['refresh', 'Refresh follow status', readStatus]]) {
      const button = make('button', 'phone-follow-' + id, label); button.type = 'button'; button.disabled = true; button.addEventListener('click', handler); controls.append(button);
    }
    const status = make('p', 'phone-follow-status', 'Sign in to check follow status.'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const link = make('a', 'phone-follow-current-url'); link.hidden = true; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer';
    const report = make('details', 'phone-follow-report'); report.append(make('summary', null, 'Latest launch results · 13 units'), make('p', null, 'Launch requested means a browser request was sent. Physical screens and playback are not verified.'), make('div', 'phone-follow-units'));
    card.append(heading, make('p', null, 'Opt in for 60 minutes. Supported public links opened in Chrome or Samsung Internet on S26 are sent to the cluster workers. S26 stays the source.'), make('p', null, 'S26 must be on home Wi-Fi with the home PC runner connected. Only the current public URL is followed; taps, native apps and playback are not shared.'), controls, status, make('p', 'phone-follow-session'), make('p', 'phone-follow-runner'), make('p', null, 'Already accepted launch requests may finish after Stop.'), make('h4', null, 'Latest public link'), link, make('p', 'phone-follow-current-empty'), report);
    const controllers = byId('personal-controller-fleet'); const anchor = controllers?.parentElement === fleet ? controllers : workers;
    anchor.insertAdjacentElement('afterend', card); render();
  }
  function watch() {
    if (typeof MutationObserver !== 'function') return;
    if (!observer) {
      observer = new MutationObserver(sync);
      const panel = byId('panel'); if (panel) observer.observe(panel, { childList: true, attributes: true, attributeFilter: ['style', 'hidden'] });
    }
    const workspace = byId('tab-swarm');
    if (workspace && workspace !== watchedWorkspace) { observer.observe(workspace, { childList: true }); watchedWorkspace = workspace; }
  }
  function sync() {
    mount();
    const authenticatedNow = authenticated();
    if (authenticatedNow !== signedIn) {
      signedIn = authenticatedNow; generation += 1; busy = false; initialRead = false; clearTimer();
      if (!signedIn) { snapshot = null; uncertainAction = false; navigationKey = ''; message('Sign in to check follow status.'); render(); }
    }
    watch(); updateButtons();
    if (usable() && !initialRead && byId('phone-follow-control')) readStatus();
  }
  function init() { if (!initialized) { initialized = true; sync(); } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
  window.addEventListener('pagehide', () => { suspended = true; generation += 1; busy = false; initialRead = false; clearTimer(); observer?.disconnect(); observer = null; watchedWorkspace = null; });
  window.addEventListener('pageshow', () => { suspended = false; if (initialized) sync(); });
  document.addEventListener('visibilitychange', () => { generation += 1; busy = false; initialRead = false; clearTimer(); if (initialized) sync(); });
})();
