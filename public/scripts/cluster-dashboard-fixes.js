(() => {
  if (!document.getElementById('tab-swarm')) return;

  // Use the same production route already proven by the controller tests.
  // This avoids the dashboard depending on the direct Netlify function URL.
  const API = '/api/cluster';
  const FLEET = [
    ['phone173','phone'], ['phone174','phone'], ['phone176','phone'], ['phone177','phone'],
    ['phone191','phone'], ['phone195','phone'], ['phone253','phone'], ['phone254','phone'],
    ['Alina','pc'], ['Nexus','pc'], ['SteamDeck','pc'],
  ];
  const IDS = new Set(FLEET.map(([id]) => id));
  const PHONE_IDS = new Set(FLEET.filter(([,kind]) => kind === 'phone').map(([id]) => id));
  const PC_IDS = new Set(FLEET.filter(([,kind]) => kind === 'pc').map(([id]) => id));
  let cleanStatus = null;
  let timer = null;
  let requestInFlight = false;

  const esc = (v) => String(v ?? '')
    .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
    .replaceAll('"','&quot;').replaceAll("'",'&#039;');

  const authHeaders = () => {
    const token = sessionStorage.getItem('cp_password') || '';
    return token
      ? { 'Content-Type':'application/json', Authorization:`Bearer ${token}` }
      : { 'Content-Type':'application/json' };
  };

  async function request(action, method='GET', body=null) {
    const r = await fetch(`${API}?action=${encodeURIComponent(action)}`, {
      method,
      headers: authHeaders(),
      body: body == null ? undefined : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });

    let data = {};
    try { data = await r.json(); } catch {}

    if (r.status === 401) throw new Error('authorization failed — log out and back in');
    if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  function canonicalize(data) {
    const byId = new Map((data.nodes || []).map((n) => [String(n.id), n]));
    const nodes = FLEET.map(([id,kind]) => {
      const n = byId.get(id);
      return n ? { ...n, id, node_class:n.node_class || (kind === 'phone' ? 'worker' : 'pc') } : {
        id,
        node_class:kind === 'phone' ? 'worker' : 'pc',
        online:false,
        busy:false,
        active_jobs:[],
        last_seen:null,
        agent_version:null,
        agent_pid:null,
      };
    });

    const extras = (data.nodes || []).filter((n) => !IDS.has(String(n.id)));
    const results = (data.results || []).filter((r) => IDS.has(String(r.device_id)));
    const jobs = (data.jobs || []).map((j) => ({
      ...j,
      target_device_ids:(j.target_device_ids || []).filter((id) => IDS.has(String(id))),
    }));

    return {
      ...data,
      nodes,
      results,
      jobs,
      nodes_online:nodes.filter((n) => n.online).length,
      nodes_busy:nodes.filter((n) => n.busy).length,
      _hiddenExtras:extras,
    };
  }

  function ensureFleetNote() {
    const tab = document.getElementById('tab-swarm');
    const heading = Array.from(tab?.querySelectorAll('h3') || [])
      .find((h) => h.textContent?.trim() === 'Swarm Nodes');
    if (!heading) return null;

    let note = document.getElementById('swarm-canonical-note');
    if (!note) {
      note = document.createElement('div');
      note.id = 'swarm-canonical-note';
      note.style.cssText = 'font-size:10px;margin:4px 0 10px;color:var(--color-muted)';
      heading.insertAdjacentElement('afterend', note);
    }
    return note;
  }

  function showState(text, color='var(--color-muted)') {
    const note = ensureFleetNote();
    if (note) {
      note.textContent = text;
      note.style.color = color;
    }
  }

  function addFleetNote(data) {
    const note = ensureFleetNote();
    if (!note) return;

    const offline = data.nodes.filter((n) => !n.online).map((n) => n.id);
    const hidden = data._hiddenExtras?.length || 0;
    note.textContent = offline.length
      ? `Canonical fleet: ${11 - offline.length}/11 online · offline: ${offline.join(', ')}${hidden ? ` · ${hidden} non-canonical record hidden` : ''}`
      : `Canonical fleet: 11/11 online${hidden ? ` · ${hidden} non-canonical record hidden` : ''}`;
    note.style.color = offline.length ? 'var(--color-yellow)' : 'var(--color-green)';
  }

  function targetIds(value) {
    const nodes = cleanStatus?.nodes || [];
    const online = nodes.filter((n) => n.online);
    if (value === '__all__') return online.map((n) => n.id);
    if (value === '__phones__') return online.filter((n) => PHONE_IDS.has(n.id)).map((n) => n.id);
    if (value === '__pcs__') return online.filter((n) => PC_IDS.has(n.id)).map((n) => n.id);
    return value && IDS.has(value) && online.some((n) => n.id === value) ? [value] : [];
  }

  async function enqueue(type, cmd='', target='__all__') {
    if (!cleanStatus) await window.fetchSwarmStatus();
    const targets = targetIds(target);
    if (!targets.length) throw new Error('No online canonical nodes match that target');
    if (type === 'shell' && !cmd) throw new Error('Shell jobs require a command');

    const job = {
      id:`web-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      type,
      cmd,
      command:cmd,
    };

    return request('enqueue','POST',{ job, target_device_ids:targets });
  }

  // cluster-swarm-v2.js owns the detailed cards/results renderer. Wrap it so
  // only the canonical 11 devices are presented to the operator.
  const baseRender = window.renderSwarmStatus;
  window.renderSwarmStatus = (raw) => {
    cleanStatus = canonicalize(raw || {});
    if (typeof baseRender === 'function') baseRender(cleanStatus);
    addFleetNote(cleanStatus);
  };

  window.fetchSwarmStatus = async () => {
    if (requestInFlight) return cleanStatus;
    requestInFlight = true;

    try {
      if (!cleanStatus) showState('Loading live Swarm state…');
      const data = await request('queue-status');
      window.renderSwarmStatus(data);
      return cleanStatus;
    } catch (e) {
      showState(`Swarm API error: ${e.message}`, 'var(--color-red)');

      const grid = document.getElementById('swarm-nodes');
      if (grid && (!cleanStatus || !cleanStatus.nodes_online)) {
        grid.innerHTML = `<span style="color:var(--color-red)">Unable to load Swarm: ${esc(e.message)}</span>`;
      }

      const ids = ['swarm-queued','swarm-nodes-online','swarm-total','swarm-assignments','swarm-busy'];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && (el.textContent === '—' || el.textContent === '--')) el.textContent = '!';
      }

      if (typeof window.toast === 'function') window.toast(`Swarm status: ${e.message}`,'error');
      else console.error(e);
      return null;
    } finally {
      requestInFlight = false;
    }
  };

  function startPolling() {
    window.fetchSwarmStatus();
    if (!timer) timer = setInterval(window.fetchSwarmStatus, 5000);
  }

  window.onSwarmTabClick = startPolling;

  window.submitSwarmJob = async () => {
    const type = document.getElementById('swarm-job-type')?.value || 'status';
    const cmd = document.getElementById('swarm-job-cmd')?.value?.trim() || '';
    const target = document.getElementById('swarm-job-device')?.value || '__all__';

    try {
      const d = await enqueue(type,cmd,target);
      if (typeof window.toast === 'function') {
        window.toast(`Swarm job ${d.job_id}: ${d.target_count} canonical target${d.target_count === 1 ? '' : 's'}`);
      }
      const input = document.getElementById('swarm-job-cmd');
      if (input) input.value = '';
      await window.fetchSwarmStatus();
    } catch (e) {
      if (typeof window.toast === 'function') window.toast(`Enqueue failed: ${e.message}`,'error');
      else showState(`Enqueue failed: ${e.message}`, 'var(--color-red)');
    }
  };

  function replacePresetListeners() {
    for (const [key,type] of [['ping','echo'],['status','status']]) {
      const old = document.querySelector(`[data-swarm-preset="${key}"]`);
      if (!old || old.dataset.canonicalFixed === '1') continue;

      const btn = old.cloneNode(true);
      btn.dataset.canonicalFixed = '1';
      old.replaceWith(btn);
      btn.addEventListener('click', async () => {
        try {
          const d = await enqueue(type,'','__all__');
          if (typeof window.toast === 'function') {
            window.toast(`${key === 'ping' ? 'Ping' : 'Status'}: ${d.target_count} canonical target(s)`);
          }
          await window.fetchSwarmStatus();
        } catch (e) {
          if (typeof window.toast === 'function') window.toast(`${key} failed: ${e.message}`,'error');
          else showState(`${key} failed: ${e.message}`, 'var(--color-red)');
        }
      });
    }
  }

  function thermalLabel(d) {
    const phone = d?.device_class === 'phone' || String(d?.hostname || '').startsWith('phone');
    if (phone) {
      const s = Number(d?.observed?.thermal_status);
      const names = ['NONE','LIGHT','MODERATE','SEVERE','CRITICAL','EMERGENCY','SHUTDOWN'];
      return Number.isInteger(s) && s >= 0 && s < names.length ? names[s] : '—';
    }
    const t = Number(d?.observed?.temp_current || d?.observed?.temp_peak || 0);
    return Number.isFinite(t) && t > 0 && t < 120 ? `${Math.round(t)}°C` : '—';
  }

  function patchClusterRenderers() {
    document.querySelectorAll('[onclick="seedFleet()"]').forEach((b) => b.remove());

    const th = Array.from(document.querySelectorAll('#tab-devices th'))
      .find((e) => e.textContent?.trim() === 'Temp' || e.textContent?.trim() === 'Thermal');
    if (th) {
      th.textContent = 'Thermal';
      th.title = 'Phones use Android Thermal Status. Raw phone Celsius values are ignored.';
    }

    window.deviceRow = (d) => {
      const online = !!d.online;
      const mining = online && !!d.observed?.xmrig_running;
      const hash = Number(d.observed?.hashrate_60s || d.observed?.hashrate_10s || 0);
      const hashText = online ? String(hash || 0) : (hash > 0 ? `last ${hash}` : '—');
      return `<tr style="border-bottom:1px solid var(--color-border);cursor:pointer;opacity:${online ? 1 : .7}" onclick="showDetail('${esc(d.id)}')">
        <td style="padding:12px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${online ? 'var(--color-green)' : 'var(--color-red)'}"></span></td>
        <td style="padding:12px">${esc(d.hostname)}</td>
        <td style="padding:12px">${esc(d.device_class)}</td>
        <td style="padding:12px;font-family:monospace">${esc(d.current_ip || 'N/A')}</td>
        <td style="padding:12px">${online ? (mining ? '✓' : '✗') : 'OFFLINE'}</td>
        <td style="padding:12px">${hashText}</td>
        <td style="padding:12px">${thermalLabel(d)}</td>
        <td style="padding:12px">${typeof window.timeAgo === 'function' ? window.timeAgo(d.last_seen_at) : ''}</td>
      </tr>`;
    };

    window.workerCard = (d) => {
      const online = !!d.online;
      const mining = online && !!d.observed?.xmrig_running;
      const hash = Number(d.observed?.hashrate_60s || d.observed?.hashrate_10s || 0);
      const dot = !online ? 'var(--color-red)' : mining ? 'var(--color-green)' : 'var(--color-yellow)';
      const hashText = online ? `${hash || 0} H/s` : (hash > 0 ? `LAST ${hash} H/s` : '—');
      return `<div style="background:var(--color-panel);border:1px solid var(--color-border);border-radius:8px;padding:16px;cursor:pointer;opacity:${online ? 1 : .72}" onclick="showDetail('${esc(d.id)}')">
        <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:8px">
          <div><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${dot}"></span><strong style="margin-left:8px">${esc(d.hostname)}</strong></div>
          <span style="font-size:9px;font-weight:700;color:${dot}">${online ? 'ONLINE' : 'OFFLINE'}</span>
        </div>
        <div style="font-size:12px;color:var(--color-muted);margin-bottom:8px">${esc(d.current_ip || 'N/A')}</div>
        <div style="font-size:13px;margin-bottom:4px">Miner: <strong>${online ? (mining ? 'RUNNING' : 'stopped') : 'OFFLINE'}</strong></div>
        <div style="font-size:13px;margin-bottom:4px">Hash: <strong>${hashText}</strong></div>
        <div style="font-size:13px;color:var(--color-muted)">Last: <strong>${typeof window.timeAgo === 'function' ? window.timeAgo(d.last_seen_at) : ''}</strong></div>
      </div>`;
    };
  }

  patchClusterRenderers();
  replacePresetListeners();

  // The page can already be authenticated when this script loads (refresh),
  // so populate Swarm immediately instead of leaving the operator staring at dashes.
  if (sessionStorage.getItem('cp_password')) {
    setTimeout(startPolling, 50);
  }

  // Login can happen after this file loaded. Once the password appears, load Swarm.
  const loginBtn = document.getElementById('loginBtn');
  if (loginBtn) {
    loginBtn.addEventListener('click', () => {
      setTimeout(() => {
        if (sessionStorage.getItem('cp_password')) startPolling();
      }, 400);
    });
  }

  // Direct click fallback. The existing v2 listener may also call the same function;
  // requestInFlight makes duplicate clicks harmless.
  const swarmButton = document.querySelector('[data-tab="swarm"]');
  if (swarmButton) swarmButton.addEventListener('click', startPolling);

  setTimeout(() => {
    patchClusterRenderers();
    replacePresetListeners();
    if (typeof window.renderFleet === 'function') window.renderFleet();
    if (typeof window.renderDevicesTable === 'function') window.renderDevicesTable();
  }, 0);
})();
