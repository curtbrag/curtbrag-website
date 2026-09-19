(() => {
  if (!document.getElementById('tab-swarm')) return;

  const API = '/.netlify/functions/swarm-core';
  let lastStatus = null;
  let pollTimer = null;

  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  const ago = (ts) => {
    if (!ts) return 'never';
    const secs = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000));
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
    return `${Math.floor(secs / 86400)}d`;
  };

  const notify = (msg, type = 'ok') => {
    if (typeof window.toast === 'function') window.toast(msg, type);
    else console[type === 'error' ? 'error' : 'log'](msg);
  };

  async function swarmRequest(action, method = 'GET', body = null) {
    const token = sessionStorage.getItem('cp_password') || '';
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${API}?action=${encodeURIComponent(action)}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });

    let data = {};
    try { data = await response.json(); } catch {}

    if (response.status === 401) throw new Error('Swarm authorization failed');
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || `Swarm API ${response.status}`);
    }
    return data;
  }

  function installUi() {
    // seed-fleet is an obsolete and dangerous path. Remove it from the UI.
    document.querySelectorAll('[onclick="seedFleet()"]')
      .forEach((button) => button.remove());

    const swarmTab = document.querySelector('[data-tab="swarm"]');
    if (swarmTab) swarmTab.textContent = 'Swarm';

    const tab = document.getElementById('tab-swarm');
    const stats = tab?.firstElementChild;
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

    const oldTarget = document.getElementById('swarm-job-device');
    if (oldTarget && oldTarget.tagName !== 'SELECT') {
      const select = document.createElement('select');
      select.id = 'swarm-job-device';
      select.style.cssText = 'width:210px;background:var(--color-bg);border:1px solid var(--color-border);border-radius:6px;padding:8px;font-size:11px;color:var(--color-text);font-family:monospace';
      select.innerHTML = `
        <option value="__all__">All online nodes</option>
        <option value="__phones__">All online phones</option>
        <option value="__pcs__">All online PCs</option>
      `;
      oldTarget.replaceWith(select);

      const label = select.parentElement?.querySelector('div');
      if (label) label.textContent = 'Target';
    }

    const dispatchHeading = Array.from(tab?.querySelectorAll('h3') || [])
      .find((h) => h.textContent?.includes('Dispatch Swarm Job'));
    const dispatchCard = dispatchHeading?.parentElement;
    if (dispatchCard && !document.getElementById('swarm-presets')) {
      dispatchCard.insertAdjacentHTML('afterbegin', `
        <div id="swarm-presets" style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;margin-bottom:8px">
          <button type="button" data-swarm-preset="ping" style="background:transparent;border:1px solid var(--color-border);border-radius:5px;padding:5px 9px;cursor:pointer;font-size:10px;color:var(--color-muted)">Ping All</button>
          <button type="button" data-swarm-preset="status" style="background:transparent;border:1px solid var(--color-border);border-radius:5px;padding:5px 9px;cursor:pointer;font-size:10px;color:var(--color-muted)">Status All</button>
        </div>
      `);

      dispatchCard.querySelector('[data-swarm-preset="ping"]')?.addEventListener('click', () => enqueuePreset('echo', '', '__all__'));
      dispatchCard.querySelector('[data-swarm-preset="status"]')?.addEventListener('click', () => enqueuePreset('status', '', '__all__'));
    }

    const nodeHeading = Array.from(tab?.querySelectorAll('h3') || [])
      .find((h) => h.textContent?.trim() === 'Swarm Nodes');
    if (nodeHeading && !document.getElementById('swarm-auth-state')) {
      nodeHeading.insertAdjacentHTML('afterend', '<span id="swarm-auth-state" style="margin-left:8px;font-size:10px;color:var(--color-muted)"></span>');
    }
  }

  function updateTargetSelect(nodes) {
    const select = document.getElementById('swarm-job-device');
    if (!select || select.tagName !== 'SELECT') return;
    const current = select.value;

    select.innerHTML = `
      <option value="__all__">All online nodes</option>
      <option value="__phones__">All online phones</option>
      <option value="__pcs__">All online PCs</option>
      <option disabled>──────────────</option>
    `;

    for (const node of [...nodes].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      const option = document.createElement('option');
      option.value = node.id;
      option.disabled = !node.online;
      const cls = node.node_class || 'unknown';
      option.textContent = `${node.online ? '●' : '○'} ${node.id} (${cls})`;
      select.appendChild(option);
    }

    if (Array.from(select.options).some((o) => o.value === current && !o.disabled)) {
      select.value = current;
    }
  }

  function renderStatus(data) {
    lastStatus = data;

    const nodes = data.nodes || [];
    const jobs = data.jobs || [];
    const results = data.results || [];

    const queued = document.getElementById('swarm-queued');
    const online = document.getElementById('swarm-nodes-online');
    const total = document.getElementById('swarm-total');
    const assignments = document.getElementById('swarm-assignments');
    const busy = document.getElementById('swarm-busy');
    const auth = document.getElementById('swarm-auth-state');

    if (queued) queued.textContent = data.queued ?? 0;
    if (online) online.textContent = `${data.nodes_online ?? 0} / ${nodes.length}`;
    if (total) total.textContent = data.total_completed ?? 0;
    if (assignments) assignments.textContent = data.assignments_pending ?? 0;
    if (busy) busy.textContent = data.nodes_busy ?? nodes.filter((n) => n.busy).length;
    if (auth) {
      auth.textContent = data.auth_enforced ? 'auth enforced' : 'compatibility auth';
      auth.style.color = data.auth_enforced ? 'var(--color-green)' : 'var(--color-yellow)';
    }

    const nodeGrid = document.getElementById('swarm-nodes');
    if (nodeGrid) {
      nodeGrid.innerHTML = nodes.length
        ? [...nodes]
          .sort((a, b) => Number(b.online) - Number(a.online) || String(a.id).localeCompare(String(b.id)))
          .map((n) => {
            const color = n.busy
              ? 'var(--color-yellow)'
              : n.online
                ? 'var(--color-green)'
                : 'var(--color-red)';
            const state = n.busy ? 'BUSY' : n.online ? 'ONLINE' : 'OFFLINE';
            const active = (n.active_jobs || []).map(esc).join(', ');
            return `<div style="background:var(--color-bg);border-radius:6px;padding:10px;border-left:3px solid ${color}">
              <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:4px">
                <div style="font-weight:600;font-size:12px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>${esc(n.id)}</div>
                <span style="font-size:9px;font-weight:700;color:${color}">${state}</span>
              </div>
              <div style="font-size:10px;color:var(--color-muted)">${esc(n.node_class || 'unknown')} · agent ${esc(n.agent_version || '?')} · pid ${esc(n.agent_pid || '?')}</div>
              <div style="font-size:10px;color:var(--color-muted)">Seen ${ago(n.last_seen)} ago</div>
              ${active ? `<div style="font-size:10px;color:var(--color-yellow);margin-top:3px">Active: ${active}</div>` : ''}
              ${n.last_job ? `<div style="font-size:10px;color:var(--color-muted);margin-top:3px">Last: ${esc(n.last_job).slice(0,18)} · exit ${esc(n.last_exit ?? '?')}</div>` : ''}
            </div>`;
          }).join('')
        : '<span style="color:var(--color-muted)">No Swarm agents have checked in yet</span>';
    }

    const queue = document.getElementById('swarm-queue-list');
    if (queue) {
      queue.innerHTML = jobs.length
        ? jobs.map((j) => {
            const done = Number(j.completed_count || 0);
            const target = Number(j.target_count || 0);
            const pending = Number(j.pending_count || 0);
            const pct = target > 0 ? Math.min(100, Math.round((done / target) * 100)) : 0;
            const targets = (j.target_device_ids || []).join(', ');
            return `<div style="padding:10px;background:var(--color-bg);border-radius:6px;margin:6px 0;border-left:3px solid var(--color-yellow);font-family:monospace;font-size:11px">
              <div style="display:flex;justify-content:space-between;gap:8px">
                <strong>${esc(j.type)}</strong>
                <span style="color:var(--color-muted)">${done}/${target || '?'} complete · ${pending} pending · ${ago(j.queued_at)}</span>
              </div>
              ${j.cmd ? `<div style="color:var(--color-muted);margin-top:4px">$ ${esc(j.cmd)}</div>` : ''}
              ${targets ? `<div style="font-size:9px;color:var(--color-muted);margin-top:4px">Targets: ${esc(targets)}</div>` : ''}
              <div style="height:4px;background:var(--color-panel);border-radius:4px;margin-top:6px;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--color-brand)"></div></div>
            </div>`;
          }).join('')
        : 'Empty';
    }

    const resultsEl = document.getElementById('swarm-results');
    if (resultsEl) {
      resultsEl.innerHTML = results.length
        ? results.map((r) => `<div style="padding:9px;background:var(--color-bg);border-radius:5px;margin:5px 0;border-left:3px solid ${Number(r.exit_code) === 0 ? 'var(--color-green)' : 'var(--color-red)'}">
            <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px">
              <span><strong>${esc(r.type || 'shell')}</strong> · <code style="font-size:10px">${esc(r.device_id)}</code> · exit:${esc(r.exit_code ?? '?')}</span>
              <span style="color:var(--color-muted);font-size:10px">${ago(r.completed_at)}</span>
            </div>
            ${r.cmd ? `<div style="font-size:10px;color:var(--color-muted);font-family:monospace;margin-bottom:4px">$ ${esc(r.cmd)}</div>` : ''}
            ${r.stdout ? `<pre style="margin:0;font-size:10px;color:var(--color-muted);white-space:pre-wrap;max-height:120px;overflow:auto">${esc(r.stdout)}</pre>` : ''}
            ${r.stderr ? `<pre style="margin:4px 0 0;font-size:10px;color:var(--color-red);white-space:pre-wrap;max-height:100px;overflow:auto">${esc(r.stderr)}</pre>` : ''}
          </div>`).join('')
        : 'No results yet';
    }

    updateTargetSelect(nodes);
  }

  async function fetchStatus() {
    try {
      const data = await swarmRequest('queue-status');
      renderStatus(data);
    } catch (error) {
      notify(`Swarm status: ${error.message}`, 'error');
    }
  }

  function targetIds(value) {
    const nodes = lastStatus?.nodes || [];
    if (value === '__all__') return null;
    if (value === '__phones__') {
      return nodes.filter((n) => n.online && (n.node_class === 'worker' || String(n.id).startsWith('phone'))).map((n) => n.id);
    }
    if (value === '__pcs__') {
      return nodes.filter((n) => n.online && !(n.node_class === 'worker' || String(n.id).startsWith('phone'))).map((n) => n.id);
    }
    return value ? [value] : null;
  }

  async function enqueue(type, cmd, targetValue) {
    if (type === 'shell' && !cmd) {
      notify('Shell jobs require a command', 'error');
      return;
    }

    const job = {
      id: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      cmd: cmd || '',
      command: cmd || '',
    };

    const targets = targetIds(targetValue || '__all__');
    const body = { job };
    if (targets) body.target_device_ids = targets;

    if (targets && targets.length === 0) {
      notify('No online nodes match that target', 'error');
      return;
    }

    const data = await swarmRequest('enqueue', 'POST', body);
    notify(`Swarm job ${data.job_id}: ${data.target_count} target${data.target_count === 1 ? '' : 's'}`);
    await fetchStatus();
  }

  async function enqueuePreset(type, cmd, targetValue) {
    try { await enqueue(type, cmd, targetValue); }
    catch (error) { notify(`Enqueue failed: ${error.message}`, 'error'); }
  }

  window.fetchSwarmStatus = fetchStatus;
  window.renderSwarmStatus = renderStatus;

  window.onSwarmTabClick = () => {
    fetchStatus();
    if (!pollTimer) pollTimer = setInterval(fetchStatus, 5000);
  };

  window.submitSwarmJob = async () => {
    const type = document.getElementById('swarm-job-type')?.value || 'status';
    const cmd = document.getElementById('swarm-job-cmd')?.value?.trim() || '';
    const target = document.getElementById('swarm-job-device')?.value || '__all__';
    try {
      await enqueue(type, cmd, target);
      const input = document.getElementById('swarm-job-cmd');
      if (input) input.value = '';
    } catch (error) {
      notify(`Enqueue failed: ${error.message}`, 'error');
    }
  };

  window.flushSwarmQueue = async () => {
    if (!confirm('Flush all pending Swarm jobs and assignments?')) return;
    try {
      const data = await swarmRequest('flush-queue', 'POST', {});
      notify(`Flushed ${data.jobs_removed ?? 0} job(s), ${data.assignments_removed ?? 0} assignment(s)`);
      await fetchStatus();
    } catch (error) {
      notify(`Flush failed: ${error.message}`, 'error');
    }
  };

  window.clearSwarmResults = async () => {
    if (!confirm('Clear Swarm result history?')) return;
    try {
      const data = await swarmRequest('clear-results', 'POST', {});
      notify(`Cleared ${data.removed ?? 0} result(s)`);
      await fetchStatus();
    } catch (error) {
      notify(`Clear failed: ${error.message}`, 'error');
    }
  };

  installUi();

  const swarmButton = document.querySelector('[data-tab="swarm"]');
  if (swarmButton) {
    swarmButton.addEventListener('click', () => window.onSwarmTabClick());
  }
})();
