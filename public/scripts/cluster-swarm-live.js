(() => {
  const tab = document.getElementById('tab-swarm');
  if (!tab) return;

  const API = '/api/cluster';
  const FLEET = [
    ['phone173','worker'], ['phone174','worker'], ['phone176','worker'], ['phone177','worker'],
    ['phone191','worker'], ['phone195','worker'], ['phone253','worker'], ['phone254','worker'],
    ['Alina','pc'], ['Nexus','pc'], ['SteamDeck','pc'],
  ];
  const IDS = new Set(FLEET.map(([id]) => id));
  const PHONE_IDS = new Set(FLEET.filter(([, cls]) => cls === 'worker').map(([id]) => id));
  const PC_IDS = new Set(FLEET.filter(([, cls]) => cls === 'pc').map(([id]) => id));

  let current = null;
  let pollTimer = null;
  let requestBusy = false;
  let started = false;

  const esc = (v) => String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

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

  const token = () => sessionStorage.getItem('cp_password') || '';

  async function api(action, method = 'GET', body = null) {
    const pw = token();
    if (!pw) throw new Error('dashboard session is not authenticated');

    const response = await fetch(`${API}?action=${encodeURIComponent(action)}&_=${Date.now()}`, {
      method,
      headers: {
        'Authorization': `Bearer ${pw}`,
        'Content-Type': 'application/json',
      },
      body: body == null ? undefined : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });

    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data;
  }

  function canonicalize(raw) {
    const source = Array.isArray(raw?.nodes) ? raw.nodes : [];
    const byId = new Map(source.map((n) => [String(n.id), n]));
    const nodes = FLEET.map(([id, cls]) => {
      const n = byId.get(id);
      return n ? { ...n, id, node_class: n.node_class || cls } : {
        id,
        node_class: cls,
        online: false,
        busy: false,
        active_jobs: [],
        last_seen: null,
        agent_version: null,
        agent_pid: null,
      };
    });

    const jobs = (raw?.jobs || []).map((j) => ({
      ...j,
      target_device_ids: (j.target_device_ids || []).filter((id) => IDS.has(String(id))),
    }));
    const results = (raw?.results || []).filter((r) => IDS.has(String(r.device_id)));
    const extras = source.filter((n) => !IDS.has(String(n.id)));

    return {
      ...raw,
      nodes,
      jobs,
      results,
      nodes_online: nodes.filter((n) => n.online).length,
      nodes_busy: nodes.filter((n) => n.busy).length,
      hidden_extras: extras,
    };
  }

  function ensureUi() {
    const stats = tab.firstElementChild;
    if (stats && !document.getElementById('swarm-assignments')) {
      stats.insertAdjacentHTML('beforeend', `
        <div style="background:var(--color-panel);border:1px solid var(--color-border);border-radius:8px;padding:16px;text-align:center">
          <div style="font-size:11px;color:var(--color-muted)">Pending Assignments</div>
          <div style="font-size:28px;font-weight:bold;color:var(--color-yellow)" id="swarm-assignments">—</div>
        </div>
        <div style="background:var(--color-panel);border:1px solid var(--color-border);border-radius:8px;padding:16px;text-align:center">
          <div style="font-size:11px;color:var(--color-muted)">Busy Nodes</div>
          <div style="font-size:28px;font-weight:bold" id="swarm-busy">—</div>
        </div>
      `);
    }

    const heading = Array.from(tab.querySelectorAll('h3'))
      .find((h) => h.textContent?.trim() === 'Swarm Nodes');
    if (heading && !document.getElementById('swarm-live-state')) {
      const note = document.createElement('div');
      note.id = 'swarm-live-state';
      note.style.cssText = 'font-size:10px;margin:5px 0 10px;color:var(--color-muted)';
      heading.insertAdjacentElement('afterend', note);
    }

    const target = document.getElementById('swarm-job-device');
    if (target && target.tagName !== 'SELECT') {
      const select = document.createElement('select');
      select.id = 'swarm-job-device';
      select.style.cssText = 'width:230px;background:var(--color-bg);border:1px solid var(--color-border);border-radius:6px;padding:8px;font-size:11px;color:var(--color-text);font-family:monospace';
      target.replaceWith(select);
    }
  }

  function setState(text, color = 'var(--color-muted)') {
    ensureUi();
    const el = document.getElementById('swarm-live-state');
    if (el) {
      el.textContent = text;
      el.style.color = color;
    }
  }

  function updateTargets(nodes) {
    const select = document.getElementById('swarm-job-device');
    if (!select || select.tagName !== 'SELECT') return;
    const previous = select.value || '__all__';
    select.innerHTML = `
      <option value="__all__">All online nodes</option>
      <option value="__phones__">All online phones</option>
      <option value="__pcs__">All online PCs</option>
      <option disabled>──────────────</option>
    `;
    for (const node of nodes) {
      const option = document.createElement('option');
      option.value = node.id;
      option.disabled = !node.online;
      option.textContent = `${node.online ? '●' : '○'} ${node.id} (${node.node_class || 'unknown'})`;
      select.appendChild(option);
    }
    if (Array.from(select.options).some((o) => o.value === previous && !o.disabled)) {
      select.value = previous;
    } else {
      select.value = '__all__';
    }
  }

  function render(raw) {
    ensureUi();
    current = canonicalize(raw || {});
    const d = current;

    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };

    setText('swarm-queued', d.queued ?? 0);
    setText('swarm-nodes-online', `${d.nodes_online} / 11`);
    setText('swarm-total', d.total_completed ?? d.results.length ?? 0);
    setText('swarm-assignments', d.assignments_pending ?? 0);
    setText('swarm-busy', d.nodes_busy ?? 0);

    const offline = d.nodes.filter((n) => !n.online).map((n) => n.id);
    const ghostCount = d.hidden_extras.length;
    setState(
      offline.length
        ? `Canonical fleet: ${11 - offline.length}/11 online · offline: ${offline.join(', ')}${ghostCount ? ` · ${ghostCount} stale record hidden` : ''}`
        : `Canonical fleet: 11/11 online${ghostCount ? ` · ${ghostCount} stale record hidden` : ''}`,
      offline.length ? 'var(--color-yellow)' : 'var(--color-green)'
    );

    const grid = document.getElementById('swarm-nodes');
    if (grid) {
      grid.innerHTML = d.nodes.map((n) => {
        const color = n.busy ? 'var(--color-yellow)' : n.online ? 'var(--color-green)' : 'var(--color-red)';
        const label = n.busy ? 'BUSY' : n.online ? 'ONLINE' : 'OFFLINE';
        const active = (n.active_jobs || []).map(esc).join(', ');
        return `<div style="background:var(--color-bg);border-radius:6px;padding:10px;border-left:3px solid ${color}">
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:4px">
            <div style="font-weight:600;font-size:12px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>${esc(n.id)}</div>
            <span style="font-size:9px;font-weight:700;color:${color}">${label}</span>
          </div>
          <div style="font-size:10px;color:var(--color-muted)">${esc(n.node_class || 'unknown')} · agent ${esc(n.agent_version || '?')} · pid ${esc(n.agent_pid || '?')}</div>
          <div style="font-size:10px;color:var(--color-muted)">Seen ${ago(n.last_seen)} ago</div>
          ${active ? `<div style="font-size:10px;color:var(--color-yellow);margin-top:3px">Active: ${active}</div>` : ''}
          ${n.last_job ? `<div style="font-size:10px;color:var(--color-muted);margin-top:3px">Last: ${esc(n.last_job).slice(0,22)} · exit ${esc(n.last_exit ?? '?')}</div>` : ''}
        </div>`;
      }).join('');
    }

    const queue = document.getElementById('swarm-queue-list');
    if (queue) {
      queue.innerHTML = d.jobs.length ? d.jobs.map((j) => {
        const done = Number(j.completed_count || 0);
        const target = Number(j.target_count || 0);
        const pending = Number(j.pending_count || 0);
        const pct = target ? Math.min(100, Math.round(done * 100 / target)) : 0;
        return `<div style="padding:10px;background:var(--color-bg);border-radius:6px;margin:6px 0;border-left:3px solid var(--color-yellow);font-family:monospace;font-size:11px">
          <div style="display:flex;justify-content:space-between;gap:8px"><strong>${esc(j.type || 'job')}</strong><span style="color:var(--color-muted)">${done}/${target || '?'} complete · ${pending} pending</span></div>
          ${j.cmd ? `<div style="color:var(--color-muted);margin-top:4px">$ ${esc(j.cmd)}</div>` : ''}
          <div style="height:4px;background:var(--color-panel);border-radius:4px;margin-top:6px;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--color-brand)"></div></div>
        </div>`;
      }).join('') : 'Empty';
    }

    const results = document.getElementById('swarm-results');
    if (results) {
      results.innerHTML = d.results.length ? d.results.map((r) => `
        <div style="padding:9px;background:var(--color-bg);border-radius:5px;margin:5px 0;border-left:3px solid ${Number(r.exit_code) === 0 ? 'var(--color-green)' : 'var(--color-red)'}">
          <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px">
            <span><strong>${esc(r.type || 'shell')}</strong> · <code style="font-size:10px">${esc(r.device_id)}</code> · exit:${esc(r.exit_code ?? '?')}</span>
            <span style="color:var(--color-muted);font-size:10px">${ago(r.completed_at)}</span>
          </div>
          ${r.cmd ? `<div style="font-size:10px;color:var(--color-muted);font-family:monospace;margin-bottom:4px">$ ${esc(r.cmd)}</div>` : ''}
          ${r.stdout ? `<pre style="margin:0;font-size:10px;color:var(--color-muted);white-space:pre-wrap;max-height:130px;overflow:auto">${esc(r.stdout)}</pre>` : ''}
          ${r.stderr ? `<pre style="margin:4px 0 0;font-size:10px;color:var(--color-red);white-space:pre-wrap;max-height:100px;overflow:auto">${esc(r.stderr)}</pre>` : ''}
        </div>`).join('') : 'No results yet';
    }

    updateTargets(d.nodes);
  }

  async function load() {
    if (requestBusy) return current;
    requestBusy = true;
    try {
      setState('Loading live Swarm state…');
      const data = await api('queue-status');
      render(data);
      return current;
    } catch (error) {
      setState(`Swarm API error: ${error.message}`, 'var(--color-red)');
      const grid = document.getElementById('swarm-nodes');
      if (grid) grid.innerHTML = `<span style="color:var(--color-red)">Unable to load live Swarm: ${esc(error.message)}</span>`;
      for (const id of ['swarm-queued','swarm-nodes-online','swarm-total','swarm-assignments','swarm-busy']) {
        const el = document.getElementById(id);
        if (el) el.textContent = '!';
      }
      console.error('Swarm load failed', error);
      return null;
    } finally {
      requestBusy = false;
    }
  }

  function start() {
    started = true;
    load();
    if (!pollTimer) pollTimer = setInterval(load, 5000);
  }

  function targetIds(value) {
    const nodes = current?.nodes || [];
    const online = nodes.filter((n) => n.online);
    if (value === '__all__') return online.map((n) => n.id);
    if (value === '__phones__') return online.filter((n) => PHONE_IDS.has(n.id)).map((n) => n.id);
    if (value === '__pcs__') return online.filter((n) => PC_IDS.has(n.id)).map((n) => n.id);
    return value && IDS.has(value) && online.some((n) => n.id === value) ? [value] : [];
  }

  async function enqueue(type, cmd, targetValue) {
    if (!current) await load();
    const targets = targetIds(targetValue || '__all__');
    if (!targets.length) throw new Error('No online canonical nodes match that target');
    if (type === 'shell' && !cmd) throw new Error('Shell jobs require a command');
    const job = {
      id: `web-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      type,
      cmd: cmd || '',
      command: cmd || '',
    };
    const data = await api('enqueue', 'POST', { job, target_device_ids: targets });
    await load();
    return data;
  }

  window.fetchSwarmStatus = load;
  window.renderSwarmStatus = render;
  window.onSwarmTabClick = start;

  window.submitSwarmJob = async () => {
    try {
      const type = document.getElementById('swarm-job-type')?.value || 'status';
      const cmd = document.getElementById('swarm-job-cmd')?.value?.trim() || '';
      const target = document.getElementById('swarm-job-device')?.value || '__all__';
      const data = await enqueue(type, cmd, target);
      if (typeof window.toast === 'function') window.toast(`Swarm job ${data.job_id}: ${data.target_count} target(s)`);
      const input = document.getElementById('swarm-job-cmd');
      if (input) input.value = '';
    } catch (error) {
      if (typeof window.toast === 'function') window.toast(`Enqueue failed: ${error.message}`, 'error');
      else setState(`Enqueue failed: ${error.message}`, 'var(--color-red)');
    }
  };

  window.flushSwarmQueue = async () => {
    if (!confirm('Flush all pending Swarm jobs and assignments?')) return;
    try {
      await api('flush-queue', 'POST', {});
      if (typeof window.toast === 'function') window.toast('Swarm queue flushed');
      await load();
    } catch (error) {
      if (typeof window.toast === 'function') window.toast(`Flush failed: ${error.message}`, 'error');
    }
  };

  window.clearSwarmResults = async () => {
    if (!confirm('Clear Swarm result history?')) return;
    try {
      await api('clear-results', 'POST', {});
      if (typeof window.toast === 'function') window.toast('Swarm results cleared');
      await load();
    } catch (error) {
      if (typeof window.toast === 'function') window.toast(`Clear failed: ${error.message}`, 'error');
    }
  };

  ensureUi();

  const swarmButton = document.querySelector('[data-tab="swarm"]');
  if (swarmButton) {
    swarmButton.addEventListener('click', () => setTimeout(start, 0), true);
  }

  const refreshButton = Array.from(tab.querySelectorAll('button'))
    .find((b) => b.textContent?.trim() === 'Refresh');
  if (refreshButton) {
    refreshButton.addEventListener('click', (event) => {
      event.preventDefault();
      load();
    }, true);
  }

  function rebindPresets() {
    for (const [key, type] of [['ping','echo'], ['status','status']]) {
      const old = document.querySelector(`[data-swarm-preset="${key}"]`);
      if (!old || old.dataset.liveBound === '1') continue;
      const button = old.cloneNode(true);
      button.dataset.liveBound = '1';
      old.replaceWith(button);
      button.addEventListener('click', async () => {
        try {
          const data = await enqueue(type, '', '__all__');
          if (typeof window.toast === 'function') window.toast(`${key === 'ping' ? 'Ping' : 'Status'}: ${data.target_count} target(s)`);
        } catch (error) {
          if (typeof window.toast === 'function') window.toast(`${key} failed: ${error.message}`, 'error');
        }
      });
    }
  }

  rebindPresets();
  setTimeout(rebindPresets, 100);
  setTimeout(rebindPresets, 1000);

  if (token()) setTimeout(start, 50);

  setInterval(() => {
    if (!started && token()) start();
  }, 1000);
})();
