(() => {
  const tab = document.getElementById('tab-swarm');
  if (!tab) return;

  const SWARM_API = '/api/cluster';
  const REQUIRED_AGENT = '2.1.1';
  const FLEET = [
    'phone173','phone174','phone176','phone177',
    'phone191','phone195','phone253','phone254',
    'Alina','Nexus','SteamDeck','viki',
  ];
  const PHONE_IDS = new Set(['phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254']);
  const PC_IDS = new Set(['Alina','Nexus','SteamDeck','viki']);
  const MINER_TYPES = new Set(['mining-status','mining-stop','mining-start','mining-restart']);

  const baseQueueShortcut = window.queueShortcut;
  const baseFleetMining = window.fleetMining;
  const baseDispatchCommand = window.dispatchCommand;
  const baseSubmitSwarmJob = window.submitSwarmJob;

  let latest = null;
  let busy = false;

  const token = () => sessionStorage.getItem('cp_password') || '';
  const esc = (v) => String(v ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

  const notify = (msg, type = 'ok') => {
    if (typeof window.toast === 'function') window.toast(msg, type);
    else console[type === 'error' ? 'error' : 'log'](msg);
  };

  const ago = (ts) => {
    if (!ts) return 'never';
    let n = Number(ts);
    if (!Number.isFinite(n)) return 'unknown';
    if (n < 100000000000) n *= 1000;
    const sec = Math.max(0, Math.floor((Date.now() - n) / 1000));
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
    return `${Math.floor(sec / 86400)}d`;
  };

  const versionAtLeast = (actual, required) => {
    const a = String(actual || '0.0.0').split('.').map((n) => Number(n) || 0);
    const r = String(required || '0.0.0').split('.').map((n) => Number(n) || 0);
    for (let i = 0; i < 3; i++) {
      if ((a[i] || 0) > (r[i] || 0)) return true;
      if ((a[i] || 0) < (r[i] || 0)) return false;
    }
    return true;
  };

  async function swarm(action, method = 'GET', body = null) {
    const pw = token();
    if (!pw) throw new Error('dashboard session is not authenticated');
    const response = await fetch(`${SWARM_API}?action=${encodeURIComponent(action)}&_=${Date.now()}`, {
      method,
      headers: {
        Authorization: `Bearer ${pw}`,
        'Content-Type': 'application/json',
      },
      body: body == null ? undefined : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function canonical(raw) {
    const source = Array.isArray(raw?.nodes) ? raw.nodes : [];
    const byId = new Map(source.map((node) => [String(node.id), node]));
    return FLEET.map((id) => byId.get(id) || {
      id,
      node_class: PHONE_IDS.has(id) ? 'worker' : 'pc',
      online: false,
      busy: false,
      active_jobs: [],
      last_seen: null,
      agent_version: null,
      agent_pid: null,
    });
  }

  function ensureSafeUi() {
    document.querySelectorAll('[onclick="seedFleet()"]')
      .forEach((button) => button.remove());

    const select = document.getElementById('swarm-job-device');
    if (select?.tagName === 'SELECT' && !Array.from(select.options).some((o) => o.value === 'viki')) {
      const option = document.createElement('option');
      option.value = 'viki';
      option.textContent = '○ viki (pc)';
      select.appendChild(option);
    }

    const shortcutBox = Array.from(document.querySelectorAll('#tab-commands h3'))
      .find((h) => h.textContent?.trim() === 'Command Shortcuts')?.nextElementSibling;
    if (shortcutBox && !shortcutBox.querySelector('[data-v7-viki-status]')) {
      const status = document.createElement('button');
      status.dataset.v7VikiStatus = '1';
      status.textContent = 'Viki Status';
      status.addEventListener('click', () => enqueueDirect('mining-status', ['viki']).catch((e) => notify(`Viki status failed: ${e.message}`, 'error')));
      const start = document.createElement('button');
      start.textContent = 'Viki Start';
      start.addEventListener('click', () => enqueueDirect('mining-start', ['viki']).catch((e) => notify(`Viki start failed: ${e.message}`, 'error')));
      const stop = document.createElement('button');
      stop.textContent = 'Viki Stop';
      stop.addEventListener('click', () => enqueueDirect('mining-stop', ['viki']).catch((e) => notify(`Viki stop failed: ${e.message}`, 'error')));
      shortcutBox.append(status, start, stop);
    }
  }

  function renderVikiCard(node) {
    const grid = document.getElementById('swarm-nodes');
    if (!grid) return;

    let card = grid.querySelector('[data-v7-node="viki"]');
    if (!card) {
      card = document.createElement('div');
      card.dataset.v7Node = 'viki';
      grid.appendChild(card);
    }

    const color = node.busy ? 'var(--color-yellow)' : node.online ? 'var(--color-green)' : 'var(--color-red)';
    const label = node.busy ? 'BUSY' : node.online ? 'ONLINE' : 'OFFLINE';
    const ctl = node.online && versionAtLeast(node.agent_version, REQUIRED_AGENT) ? 'miner ctl ✓' : 'miner ctl —';
    const active = (node.active_jobs || []).map(esc).join(', ');
    card.style.cssText = `background:var(--color-bg);border-radius:6px;padding:10px;border-left:3px solid ${color}`;
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:4px">
        <div style="font-weight:600;font-size:12px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>viki</div>
        <span style="font-size:9px;font-weight:700;color:${color}">${label}</span>
      </div>
      <div style="font-size:10px;color:var(--color-muted)">${esc(node.node_class || 'pc')} · agent ${esc(node.agent_version || '?')} · pid ${esc(node.agent_pid || '?')}</div>
      <div style="font-size:10px;color:var(--color-muted)">${ctl} · seen ${ago(node.last_seen)} ago</div>
      ${active ? `<div style="font-size:10px;color:var(--color-yellow);margin-top:3px">Active: ${active}</div>` : ''}
    `;
  }

  function render12(raw) {
    latest = raw || latest || {};
    const nodes = canonical(latest);
    const online = nodes.filter((n) => n.online).length;
    const offline = nodes.filter((n) => !n.online).map((n) => n.id);

    const count = document.getElementById('swarm-nodes-online');
    if (count) count.textContent = `${online} / ${FLEET.length}`;

    const note = document.getElementById('swarm-live-state');
    if (note) {
      note.textContent = offline.length
        ? `Canonical fleet: ${online}/${FLEET.length} online · offline: ${offline.join(', ')} · phone start/stop: Windows ADB thermal authority`
        : `Canonical fleet: ${FLEET.length}/${FLEET.length} online · phone start/stop: Windows ADB thermal authority`;
      note.style.color = offline.length ? 'var(--color-yellow)' : 'var(--color-green)';
    }

    const viki = nodes.find((n) => n.id === 'viki');
    if (viki) renderVikiCard(viki);

    const select = document.getElementById('swarm-job-device');
    const option = select?.querySelector('option[value="viki"]');
    if (option && viki) {
      option.disabled = !viki.online;
      option.textContent = `${viki.online ? '●' : '○'} viki (${viki.node_class || 'pc'})`;
    }

    ensureSafeUi();
  }

  async function refresh12() {
    if (busy || !token()) return;
    busy = true;
    try {
      const data = await swarm('queue-status');
      render12(data);
    } catch (error) {
      console.error('12-node dashboard overlay failed', error);
    } finally {
      busy = false;
    }
  }

  async function enqueueDirect(type, targets, cmd = '') {
    if (!targets.length) throw new Error('No targets');
    const data = latest || await swarm('queue-status');
    latest = data;
    const nodes = canonical(data);
    const online = new Set(nodes.filter((n) => n.online).map((n) => n.id));
    const usable = targets.filter((id) => online.has(id));
    if (!usable.length) throw new Error('No online targets');

    if (MINER_TYPES.has(type)) {
      const old = usable.filter((id) => {
        const node = nodes.find((n) => n.id === id);
        return !node || !versionAtLeast(node.agent_version, REQUIRED_AGENT);
      });
      if (old.length) throw new Error(`Upgrade Swarm agent to v${REQUIRED_AGENT}: ${old.join(', ')}`);
    }

    const job = {
      id: `web-v7-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      type,
      cmd: cmd || '',
      command: cmd || '',
    };
    const result = await swarm('enqueue', 'POST', { job, target_device_ids: usable });
    notify(`${type}: ${result.target_count} Swarm target${result.target_count === 1 ? '' : 's'}`);
    setTimeout(refresh12, 250);
    return result;
  }

  async function handleMinerGroup(type, target) {
    const t = String(target || '').toLowerCase();
    if (t === 'viki') return enqueueDirect(type, ['viki']);

    if (type === 'mining-status' && (t === 'all' || t === '__all__' || t === 'pcs' || t === '__pcs__')) {
      const data = latest || await swarm('queue-status');
      latest = data;
      const nodes = canonical(data).filter((n) => n.online);
      const targets = (t === 'pcs' || t === '__pcs__')
        ? nodes.filter((n) => PC_IDS.has(n.id)).map((n) => n.id)
        : nodes.map((n) => n.id);
      return enqueueDirect(type, targets);
    }

    if ((t === 'all' || t === '__all__' || t === 'pcs' || t === '__pcs__') && typeof baseFleetMining === 'function') {
      const enabled = type !== 'mining-stop';
      const baseTarget = (t === 'pcs' || t === '__pcs__') ? 'pcs' : 'all';
      const first = await baseFleetMining(enabled, baseTarget);
      const second = await enqueueDirect(type, ['viki']);
      return { ok: true, base: first, viki: second };
    }

    if (typeof baseQueueShortcut === 'function') return baseQueueShortcut(target, type);
    throw new Error('No compatible dashboard action');
  }

  window.queueShortcut = async (target, type) => {
    if (MINER_TYPES.has(type)) return handleMinerGroup(type, target);
    if (typeof baseQueueShortcut === 'function') return baseQueueShortcut(target, type);
  };

  window.fleetMining = async (enabled, target) => {
    const type = enabled ? 'mining-start' : 'mining-stop';
    const t = String(target || 'all').toLowerCase();
    if (t === 'viki' || t === 'all' || t === 'pcs' || t === '__all__' || t === '__pcs__') {
      return handleMinerGroup(type, target || 'all');
    }
    if (typeof baseFleetMining === 'function') return baseFleetMining(enabled, target);
  };

  window.dispatchCommand = async () => {
    const type = document.getElementById('cmdType')?.value || '';
    const target = document.getElementById('cmdTarget')?.value || 'all';
    if (MINER_TYPES.has(type) && ['all','pcs','viki'].includes(String(target).toLowerCase())) {
      return handleMinerGroup(type, target);
    }
    if (typeof baseDispatchCommand === 'function') return baseDispatchCommand();
  };

  window.submitSwarmJob = async () => {
    const type = document.getElementById('swarm-job-type')?.value || 'mining-status';
    const cmd = document.getElementById('swarm-job-cmd')?.value?.trim() || '';
    const target = document.getElementById('swarm-job-device')?.value || '__all__';
    const t = String(target).toLowerCase();

    try {
      if (MINER_TYPES.has(type) && ['all','__all__','pcs','__pcs__','viki'].includes(t)) {
        return await handleMinerGroup(type, target);
      }

      if (!MINER_TYPES.has(type) && ['all','__all__','pcs','__pcs__','viki'].includes(t)) {
        const data = latest || await swarm('queue-status');
        latest = data;
        const online = canonical(data).filter((n) => n.online);
        const targets = t === 'viki'
          ? ['viki']
          : (t === 'pcs' || t === '__pcs__')
            ? online.filter((n) => PC_IDS.has(n.id)).map((n) => n.id)
            : online.map((n) => n.id);
        return await enqueueDirect(type, targets, cmd);
      }

      if (typeof baseSubmitSwarmJob === 'function') return baseSubmitSwarmJob();
    } catch (error) {
      notify(`${type} failed: ${error.message}`, 'error');
      throw error;
    }
  };

  window.seedFleet = () => {
    notify('Seed Missing Nodes is disabled. The 12-node registry is authoritative.', 'error');
  };

  ensureSafeUi();
  setTimeout(refresh12, 100);
  setInterval(refresh12, 5000);
})();
