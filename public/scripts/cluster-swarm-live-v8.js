(() => {
  const tab = document.getElementById('tab-swarm');
  if (!tab) return;

  const SWARM_API = '/api/cluster';
  const CONTROL_API = '/.netlify/functions/cluster-api';
  const REQUIRED_AGENT = '2.1.1';
  const DIAGNOSTIC_LINUX_AGENT = '2.2.0';
  const DIAGNOSTIC_WINDOWS_AGENT = '3.3.0';
  const REEL_WINDOWS_AGENT = '3.4.0';
  const DIAGNOSTIC_TYPES = new Set(['storage-status','process-snapshot','network-check']);
  const DIAGNOSTIC_FALLBACK = {
    'storage-status':'df -hP "$HOME"',
    'process-snapshot':'(ps -eo pid,comm,%cpu,%mem --sort=-%cpu 2>/dev/null || ps -A) | head -n 9',
    'network-check':'curl -sS -o /dev/null --max-time 12 -w "site=curtbrag.com http=%{http_code} dns_s=%{time_namelookup} connect_s=%{time_connect} total_s=%{time_total}" https://curtbrag.com/',
  };

  const FLEET = [
    ['phone173','worker'], ['phone174','worker'], ['phone176','worker'], ['phone177','worker'],
    ['phone191','worker'], ['phone195','worker'], ['phone253','worker'], ['phone254','worker'],
    ['Alina','pc'], ['Nexus','pc'], ['SteamDeck','pc'], ['viki','pc'], ['RenderRig','gpu-worker'],
  ];

  const PHONE_TARGET_THREADS = {
    phone173:8, phone174:6, phone176:8, phone177:8,
    phone191:8, phone195:6, phone253:8, phone254:6,
  };

  const IDS = new Set(FLEET.map(([id]) => id));
  const PHONE_IDS = new Set(Object.keys(PHONE_TARGET_THREADS));
  const PC_IDS = new Set(['Alina','Nexus','SteamDeck','viki','RenderRig']);
  const GPU_IDS = new Set(['RenderRig']);
  const TRANSCRIBE_IDS = new Set(['Alina','Nexus']);
  const GPU_WORK_TYPES = new Set(['gpu-status','salad-status','workstation-selftest','blender-render','ffmpeg-transcode','whisper-transcribe','comfyui-workflow','reel-create']);
  const GPU_SETTINGS_TYPES = new Set(['blender-render','ffmpeg-transcode','whisper-transcribe','comfyui-workflow']);
  const PC_TARGET_THREADS = { Alina:12, Nexus:0, SteamDeck:4, viki:4 };
  const MINER_TYPES = new Set(['mining-status','mining-stop','mining-start','mining-restart']);

  const legacyQueueShortcut = window.queueShortcut;
  const legacyDispatchCommand = window.dispatchCommand;
  const legacyQueueCmd = window.queueCmd;

  let current = null;
  let pollTimer = null;
  let requestBusy = false;
  let started = false;
  let livePaused = false;
  let nodeFilter = 'all';
  const SAMPLE_MEDIA = 'https://github.com/ggerganov/whisper.cpp/raw/master/samples/jfk.wav';

  const token = () => sessionStorage.getItem('cp_password') || '';
  const esc = (v) => String(v ?? '')
    .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
    .replaceAll('"','&quot;').replaceAll("'",'&#039;');

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

  const notify = (msg, type='ok') => {
    if (typeof window.toast === 'function') window.toast(msg, type);
    else console[type === 'error' ? 'error' : 'log'](msg);
  };

  async function request(base, action, method='GET', body=null) {
    const pw = token();
    if (!pw) throw new Error('dashboard session is not authenticated');
    const response = await fetch(`${base}?action=${encodeURIComponent(action)}&_=${Date.now()}`, {
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

  const swarmApi = (action, method='GET', body=null) => request(SWARM_API, action, method, body);
  const controlApi = (action, method='GET', body=null) => request(CONTROL_API, action, method, body);

  function canonicalize(raw) {
    const source = Array.isArray(raw?.nodes) ? raw.nodes : [];
    const byId = new Map(source.map((n) => [String(n.id), n]));
    const nodes = FLEET.map(([id, cls]) => {
      const n = byId.get(id);
      return n ? { ...n, id, node_class:n.node_class || cls } : {
        id, node_class:cls, online:false, busy:false, active_jobs:[],
        last_seen:null, agent_version:null, agent_pid:null,
      };
    });
    return {
      ...raw,
      nodes,
      jobs:(raw?.jobs || []).map((j) => ({
        ...j,
        target_device_ids:(j.target_device_ids || []).filter((id) => IDS.has(String(id))),
      })),
      results:(raw?.results || []).filter((r) => IDS.has(String(r.device_id))),
      nodes_online:nodes.filter((n) => n.online).length,
      nodes_busy:nodes.filter((n) => n.busy).length,
      hidden_extras:source.filter((n) => !IDS.has(String(n.id))),
    };
  }

  function ensureStateNote() {
    const heading = Array.from(tab.querySelectorAll('h3'))
      .find((h) => ['Swarm Nodes', 'Workers'].includes(h.textContent?.trim()));
    if (!heading) return null;
    let note = document.getElementById('swarm-live-state');
    if (!note) {
      note = document.createElement('div');
      note.id = 'swarm-live-state';
      note.style.cssText = 'font-size:10px;margin:5px 0 10px;color:var(--color-muted)';
      heading.insertAdjacentElement('afterend', note);
    }
    return note;
  }

  function setState(text, color='var(--color-muted)') {
    const el = ensureStateNote();
    if (!el) return;
    el.textContent = text;
    el.style.color = color;
  }

  function syncJobInput() {
    const type = document.getElementById('swarm-job-type')?.value || 'status';
    const input = document.getElementById('swarm-job-cmd');
    if (!input) return;
    const workloadHelp = {
      'blender-render':'{"input":"C:\\\\Jobs\\\\scene.blend","output":"C:\\\\Jobs\\\\renders\\\\frame_","engine":"cycles"}',
      'ffmpeg-transcode':'{"input":"C:\\\\Jobs\\\\source.mov","output":"C:\\\\Jobs\\\\output.mp4","preset":"medium"}',
      'whisper-transcribe':'{"input":"C:\\\\Jobs\\\\audio.mp3","output":"C:\\\\Jobs\\\\transcripts","model":"small.en"}',
      'comfyui-workflow':'{"workflow":"C:\\\\Jobs\\\\workflow.json"}',
    };
    const needsCommand = type === 'shell' || type === 'transcribe' || Object.hasOwn(workloadHelp, type);
    input.disabled = !needsCommand;
    input.placeholder = workloadHelp[type] || (type === 'transcribe'
      ? 'Media URL or existing file path on Alina/Nexus'
      : needsCommand
        ? 'Shell command (advanced)'
      : type.startsWith('mining-')
        ? 'Phones use Windows ADB thermal authority; PCs use Swarm'
        : 'No command text needed');
    if (!needsCommand) input.value = '';
  }

  function patchCommandShortcuts() {
    const heading = Array.from(document.querySelectorAll('#tab-commands h3'))
      .find((h) => h.textContent?.trim() === 'Command Shortcuts');
    const box = heading?.nextElementSibling;
    if (!box || box.dataset.clusterV8 === '1') return;
    box.dataset.clusterV8 = '1';
    box.innerHTML = `
      <button data-v8-type="status" data-v8-target="__all__">Check All Nodes</button>
      <button data-v8-type="mining-status" data-v8-target="__all__">Check All Miners</button>
      <button data-v8-type="mining-stop" data-v8-target="__all__">Stop All Miners</button>
    `;
        box.querySelectorAll('[data-v8-type]').forEach((button) => {
      button.addEventListener('click', () => runAction(button.dataset.v8Type, button.dataset.v8Target));
    });
  }

  function ensureUi() {
    document.querySelectorAll('[onclick="seedFleet()"]').forEach((button) => button.remove());

    const tabs = Array.from(document.querySelectorAll('.tab-btn'));
    const workTab = tabs.find((button) => button.dataset.tab === 'swarm');
    const advancedTabs = new Set(['config', 'analytics', 'jobs', 'commands', 'events', 'alerts']);
    if (workTab) workTab.textContent = 'Work';
    tabs.forEach((button) => {
      if (advancedTabs.has(button.dataset.tab)) button.style.display = 'none';
    });
    if (workTab && !document.getElementById('cluster-more-tabs')) {
      const more = document.createElement('button');
      more.id = 'cluster-more-tabs';
      more.type = 'button';
      more.className = 'tab-btn';
      more.textContent = 'More';
      more.addEventListener('click', () => {
        const showing = more.dataset.showing === '1';
        tabs.forEach((button) => {
          if (advancedTabs.has(button.dataset.tab)) button.style.display = showing ? 'none' : '';
        });
        more.dataset.showing = showing ? '0' : '1';
        more.textContent = showing ? 'More' : 'Less';
      });
      workTab.parentElement?.appendChild(more);
    }
    if (workTab && document.documentElement.dataset.clusterSimpleView !== '1') {
      document.documentElement.dataset.clusterSimpleView = '1';
      setTimeout(() => workTab.click(), 700);
    }

    const simpleLabels = new Map([
      ['Swarm Nodes', 'Workers'],
      ['Dispatch Swarm Job', 'Start Work'],
      ['Pending Queue', 'In Progress'],
      ['Recent Results', 'Completed Work'],
      ['Queued Jobs', 'Waiting'],
      ['Total Completed', 'Completed'],
      ['Pending Assignments', 'Assigned'],
      ['Busy Nodes', 'Working'],
    ]);
    tab.querySelectorAll('h3, div').forEach((element) => {
      const label = element.textContent?.trim();
      if (simpleLabels.has(label) && element.children.length === 0) {
        element.textContent = simpleLabels.get(label);
      }
    });

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

    ensureStateNote();

    const stateNote = document.getElementById('swarm-live-state');
    if (stateNote && !document.getElementById('swarm-useful-tools')) {
      stateNote.insertAdjacentHTML('afterend', `
        <div id="swarm-useful-tools" style="display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin:0 0 12px">
          <button type="button" id="swarm-gpu-status">GPU Check</button>
          <button type="button" id="swarm-salad-status">Salad Check</button>
          <button type="button" id="swarm-workstation-test">Workstation Test</button>
          <button type="button" id="swarm-reel-gpu-test" title="GPU encode the Reel created on RenderRig in Videos/impact-bolt-poc.mp4">Reel GPU Test</button>
          <button type="button" id="swarm-reel-create" title="Create an original Reel and preview it here">Produce Reel</button>
          <button type="button" id="swarm-fleet-storage">Fleet Storage</button>
          <button type="button" id="swarm-fleet-processes">Fleet Processes</button>
          <button type="button" id="swarm-fleet-network">Fleet Network</button>
          <button type="button" id="swarm-sample">Transcription Sample</button>
          <button type="button" id="swarm-copy-latest">Copy Latest Output</button>
          <button type="button" id="swarm-live-toggle">Pause Live Updates</button>
          <select id="swarm-node-filter" aria-label="Filter workers">
            <option value="all">All workers</option>
            <option value="online">Online only</option>
            <option value="offline">Offline only</option>
            <option value="busy">Working only</option>
          </select>
        </div>
      `);
      const tools = document.getElementById('swarm-useful-tools');
      tools.querySelectorAll('button,select').forEach((control) => {
        control.style.cssText = 'background:var(--color-bg);border:1px solid var(--color-border);border-radius:5px;padding:6px 9px;font-size:10px;color:var(--color-muted)';
      });
      document.getElementById('swarm-sample').addEventListener('click', () => {
        const input = document.getElementById('swarm-job-cmd');
        const type = document.getElementById('swarm-job-type');
        const target = document.getElementById('swarm-job-device');
        if (type) type.value = 'transcribe';
        if (target) target.value = '__pcs__';
        if (input) input.value = SAMPLE_MEDIA;
        syncJobInput();
        input?.focus();
        notify('Sample loaded. Press Start when ready.');
      });
      document.getElementById('swarm-gpu-status').addEventListener('click', () => runAction('gpu-status', 'RenderRig'));
      document.getElementById('swarm-salad-status').addEventListener('click', () => runAction('salad-status', 'RenderRig'));
      document.getElementById('swarm-workstation-test').addEventListener('click', () => runAction('workstation-selftest', 'RenderRig'));
      document.getElementById('swarm-reel-create').addEventListener('click', () => { runAction('reel-create', 'RenderRig').catch(() => {}); });
      document.getElementById('swarm-reel-gpu-test').addEventListener('click', () => {
        const settings = {
          input:'%USERPROFILE%\\Videos\\impact-bolt-poc.mp4',
          output:'%USERPROFILE%\\Videos\\impact-bolt-site-test.mp4',
          preset:'medium',
        };
        runAction('ffmpeg-transcode', 'RenderRig', JSON.stringify(settings)).catch(() => {});
      });
      document.getElementById('swarm-fleet-storage').addEventListener('click', () => { runAction('storage-status', '__all__').catch(() => {}); });
      document.getElementById('swarm-fleet-processes').addEventListener('click', () => { runAction('process-snapshot', '__all__').catch(() => {}); });
      document.getElementById('swarm-fleet-network').addEventListener('click', () => { runAction('network-check', '__all__').catch(() => {}); });
      document.getElementById('swarm-copy-latest').addEventListener('click', async () => {
        const latest = current?.results?.[0];
        const text = latest?.stdout || latest?.stderr || '';
        if (!text) return notify('No completed output to copy', 'error');
        await navigator.clipboard.writeText(text);
        notify('Latest output copied');
      });
      document.getElementById('swarm-live-toggle').addEventListener('click', (event) => {
        livePaused = !livePaused;
        event.currentTarget.textContent = livePaused ? 'Resume Live Updates' : 'Pause Live Updates';
        notify(livePaused ? 'Live updates paused' : 'Live updates resumed');
        if (!livePaused) load(true);
      });
      document.getElementById('swarm-node-filter').addEventListener('change', (event) => {
        nodeFilter = event.target.value;
        if (current) render(current);
      });
    }

    const oldTarget = document.getElementById('swarm-job-device');
    if (oldTarget && oldTarget.tagName !== 'SELECT') {
      const select = document.createElement('select');
      select.id = 'swarm-job-device';
      select.style.cssText = 'width:230px;background:var(--color-bg);border:1px solid var(--color-border);border-radius:6px;padding:8px;font-size:11px;color:var(--color-text);font-family:monospace';
      oldTarget.replaceWith(select);
    }

    const typeSelect = document.getElementById('swarm-job-type');
    if (typeSelect && typeSelect.dataset.clusterV8 !== '1') {
      typeSelect.dataset.clusterV8 = '1';
      typeSelect.innerHTML = `
        <optgroup label="RTX RenderRig">
          <option value="gpu-status">Check GPUs</option>
          <option value="salad-status">Check Salad</option>
          <option value="workstation-selftest">Run complete workstation test</option>
          <option value="reel-create">Produce original Reel</option>
          <option value="blender-render">Render Blender project</option>
          <option value="comfyui-workflow">Run ComfyUI workflow</option>
          <option value="ffmpeg-transcode">GPU video transcode</option>
          <option value="whisper-transcribe">GPU transcription</option>
        </optgroup>
        <optgroup label="Linux workers">
        <option value="transcribe">Transcribe audio or video</option>
        <option value="status">Check node status</option>
        </optgroup>
        <optgroup label="Read-only diagnostics (all workers)">
          <option value="storage-status">Check storage space</option>
          <option value="process-snapshot">Show processes</option>
          <option value="network-check">Check site connection</option>
        </optgroup>
        <optgroup label="Advanced">
        <option value="shell">Advanced command</option>
        </optgroup>
      `;
      typeSelect.value = 'gpu-status';
      typeSelect.addEventListener('change', () => {
        if (GPU_WORK_TYPES.has(typeSelect.value)) {
          const target = document.getElementById('swarm-job-device');
          if (target && Array.from(target.options || []).some((o) => o.value === 'RenderRig' && !o.disabled)) target.value = 'RenderRig';
        }
        syncJobInput();
      });
    }
    syncJobInput();

    const dispatchHeading = Array.from(tab.querySelectorAll('h3'))
      .find((h) => ['Dispatch Swarm Job', 'Start Work', 'Run Work'].includes(h.textContent?.trim()));
    if (dispatchHeading) dispatchHeading.textContent = 'Start Work';
    const dispatchCard = dispatchHeading?.parentElement;
    if (dispatchCard && !document.getElementById('swarm-work-note')) {
      dispatchCard.insertAdjacentHTML('afterbegin', `
        <div id="swarm-work-note" style="margin-bottom:12px;color:var(--color-muted);font-size:11px">
          Check storage, processes, and connectivity across the fleet. RTX work can render, transcribe, or convert media; those jobs pause Salad and resume it afterward.
        </div>
      `);
      const enqueueButton = Array.from(dispatchCard.querySelectorAll('button'))
        .find((button) => button.textContent?.trim() === 'Enqueue');
      if (enqueueButton) enqueueButton.textContent = 'Start';
    }

    patchCommandShortcuts();
  }

  function updateTargets(nodes) {
    const select = document.getElementById('swarm-job-device');
    if (!select || select.tagName !== 'SELECT') return;
    const previous = select.value || '__pcs__';
    select.innerHTML = `
      <option value="RenderRig">RenderRig (RTX, hybrid Salad)</option>
      <option value="__pcs__">All online PCs</option>
      <option value="__all__">All online nodes (read-only checks)</option>
      <option disabled>──────────────</option>
    `;
    for (const node of nodes) {
      const option = document.createElement('option');
      option.value = node.id;
      option.disabled = !node.online;
      option.textContent = `${node.online ? '●' : '○'} ${node.id} (${node.node_class || 'unknown'})`;
      select.appendChild(option);
    }
    if (Array.from(select.options).some((o) => o.value === previous && !o.disabled)) select.value = previous;
    else select.value = '__all__';
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
    setText('swarm-nodes-online', `${d.nodes_online} / ${FLEET.length}`);
    setText('swarm-total', d.total_completed ?? d.results.length ?? 0);
    setText('swarm-assignments', d.assignments_pending ?? 0);
    setText('swarm-busy', d.nodes_busy ?? 0);

    const offline = d.nodes.filter((n) => !n.online).map((n) => n.id);
    const oldAgents = d.nodes.filter((n) => n.online && !versionAtLeast(n.agent_version, REQUIRED_AGENT)).map((n) => n.id);
    const ghostCount = d.hidden_extras.length;
    let note = offline.length
      ? `Canonical fleet: ${FLEET.length - offline.length}/${FLEET.length} online · offline: ${offline.join(', ')}`
      : `Canonical fleet: ${FLEET.length}/${FLEET.length} online`;
    note += ' · phone start/stop: Windows ADB thermal authority';
    if (oldAgents.length) note += ` · upgrade agents: ${oldAgents.join(', ')}`;
    if (ghostCount) note += ` · ${ghostCount} stale record${ghostCount === 1 ? '' : 's'} hidden`;
    setState(note, offline.length || oldAgents.length ? 'var(--color-yellow)' : 'var(--color-green)');

    const grid = document.getElementById('swarm-nodes');
    if (grid) {
      const visibleNodes = d.nodes.filter((node) => {
        if (nodeFilter === 'online') return node.online;
        if (nodeFilter === 'offline') return !node.online;
        if (nodeFilter === 'busy') return node.busy;
        return true;
      });
      grid.innerHTML = visibleNodes.map((n) => {
        const color = n.busy ? 'var(--color-yellow)' : n.online ? 'var(--color-green)' : 'var(--color-red)';
        const label = n.busy ? 'BUSY' : n.online ? 'ONLINE' : 'OFFLINE';
        const active = (n.active_jobs || []).map(esc).join(', ');
        const ctl = PHONE_IDS.has(n.id)
          ? 'phone ctl: ADB thermal'
          : n.online && versionAtLeast(n.agent_version, REQUIRED_AGENT) ? 'miner ctl ✓' : 'miner ctl —';
        return `<div style="background:var(--color-bg);border-radius:6px;padding:10px;border-left:3px solid ${color}">
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:4px">
            <div style="font-weight:600;font-size:12px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>${esc(n.id)}</div>
            <span style="font-size:9px;font-weight:700;color:${color}">${label}</span>
          </div>
          <div style="font-size:10px;color:var(--color-muted)">${esc(n.node_class || 'unknown')} · agent ${esc(n.agent_version || '?')} · pid ${esc(n.agent_pid || '?')}</div>
          <div style="font-size:10px;color:var(--color-muted)">${ctl} · seen ${ago(n.last_seen)} ago</div>
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
        const waiting = (j.pending_device_ids || []).map((id) => {
          const node = d.nodes.find((n) => n.id === id);
          return `${esc(id)}${node?.online ? '' : ' (offline)'}`;
        });
        const pct = target ? Math.min(100, Math.round(done * 100 / target)) : 0;
        return `<div style="padding:10px;background:var(--color-bg);border-radius:6px;margin:6px 0;border-left:3px solid var(--color-yellow);font-family:monospace;font-size:11px">
          <div style="display:flex;justify-content:space-between;gap:8px"><strong>${esc(j.type || 'job')}</strong><span style="color:var(--color-muted)">${done}/${target || '?'} complete · ${pending} pending</span></div>
          ${j.cmd ? `<div style="color:var(--color-muted);margin-top:4px">$ ${esc(j.cmd)}</div>` : ''}
          ${waiting.length ? `<div style="color:var(--color-muted);margin-top:5px">Waiting on: ${waiting.join(', ')}</div>` : ''}
          <div style="height:4px;background:var(--color-panel);border-radius:4px;margin-top:6px;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--color-brand)"></div></div>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px"><span style="color:var(--color-muted);overflow-wrap:anywhere">${esc(j.id)}</span><button type="button" data-cancel-swarm-job="${esc(j.id)}" style="color:var(--color-red);background:transparent;border:1px solid var(--color-red);border-radius:5px;padding:4px 7px;white-space:nowrap;cursor:pointer">Cancel pending</button></div>
        </div>`;
      }).join('') : 'Empty';
      queue.querySelectorAll('[data-cancel-swarm-job]').forEach((button) => {
        button.addEventListener('click', async () => {
          const jobId = button.dataset.cancelSwarmJob;
          const job = current?.jobs.find((entry) => entry.id === jobId);
          if (!job || !confirm(`Cancel pending assignments for ${job.type} on ${(job.pending_device_ids || []).join(', ') || 'remaining devices'}? Completed results stay in history.`)) return;
          button.disabled = true;
          try {
            const result = await swarmApi('cancel-job', 'POST', { job_id:jobId });
            notify(`Cancelled ${result.assignments_removed} pending assignment${result.assignments_removed === 1 ? '' : 's'}`);
            await load(true);
          } catch (error) {
            notify(`Cancel failed: ${error.message}`, 'error');
            button.disabled = false;
          }
        });
      });
    }

    const results = document.getElementById('swarm-results');
    if (results) {
      results.innerHTML = d.results.length ? d.results.map((r, resultIndex) => `
        <div data-result-index="${resultIndex}" style="padding:9px;background:var(--color-bg);border-radius:5px;margin:5px 0;border-left:3px solid ${Number(r.exit_code) === 0 ? 'var(--color-green)' : 'var(--color-red)'}">
          <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px">
            <span><strong>${esc(r.type || 'shell')}</strong> · <code style="font-size:10px">${esc(r.device_id)}</code> · exit:${esc(r.exit_code ?? '?')}</span>
            <span style="color:var(--color-muted);font-size:10px">${ago(r.completed_at)}</span>
          </div>
          ${r.cmd ? `<div style="font-size:10px;color:var(--color-muted);font-family:monospace;margin-bottom:4px">$ ${esc(r.cmd)}</div>` : ''}
          ${r.stdout ? `<pre style="margin:0;font-size:10px;color:var(--color-muted);white-space:pre-wrap;max-height:130px;overflow:auto">${esc(r.stdout)}</pre>` : ''}
          ${r.stderr ? `<pre style="margin:4px 0 0;font-size:10px;color:var(--color-red);white-space:pre-wrap;max-height:100px;overflow:auto">${esc(r.stderr)}</pre>` : ''}
        </div>`).join('') : 'No completed work yet';

      results.querySelectorAll('[data-result-index]').forEach((card) => {
        const index = Number(card.dataset.resultIndex);
        const item = d.results[index];
        const row = card.firstElementChild;
        if (!row || row.querySelector('[data-result-action]')) return;
        const actions = document.createElement('span');
        actions.dataset.resultAction = '1';
        actions.style.cssText = 'display:flex;gap:5px;align-items:center';
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.textContent = 'Copy';
        copy.addEventListener('click', async () => {
          const text = item?.stdout || item?.stderr || '';
          if (!text) return notify('No output to copy', 'error');
          await navigator.clipboard.writeText(text);
          notify('Output copied');
        });
        actions.appendChild(copy);
        if (item?.type === 'reel-create' && Number(item.exit_code) === 0 && item.job_id) {
          const preview = document.createElement('button');
          preview.type = 'button';
          preview.textContent = 'Preview / Download';
          preview.addEventListener('click', () => openReel(item.job_id));
          actions.appendChild(preview);
        }
        if (item?.cmd?.includes('transcribe.py')) {
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.textContent = 'Retry';
          retry.addEventListener('click', async () => {
            await enqueueSwarm('shell', item.cmd, [item.device_id]);
            notify('Retry queued on ' + item.device_id);
            await load(true);
          });
          actions.appendChild(retry);
        }
        row.lastElementChild?.replaceWith(actions);
      });
    }

    updateTargets(d.nodes);
  }

  async function openReel(jobId) {
    try {
      const response = await fetch(`/api/reel-media?id=${encodeURIComponent(jobId)}`, {
        headers:{ Authorization:`Bearer ${token()}` }, cache:'no-store',
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `Video unavailable (${response.status})`);
      }
      const url = URL.createObjectURL(await response.blob());
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:#000d;display:flex;align-items:center;justify-content:center;padding:16px';
      const panel = document.createElement('div');
      panel.style.cssText = 'background:var(--color-panel);color:var(--color-text);padding:16px;border-radius:10px;width:min(100%,420px);max-height:100%;overflow:auto';
      const title = document.createElement('h3');
      title.textContent = 'Your Reel';
      const video = document.createElement('video');
      video.src = url;
      video.controls = true;
      video.playsInline = true;
      video.style.cssText = 'display:block;width:100%;max-height:70vh;background:#000';
      const download = document.createElement('a');
      download.href = url;
      download.download = `${jobId}.mp4`;
      download.textContent = 'Download MP4';
      download.style.cssText = 'display:inline-block;margin:12px 16px 0 0;color:var(--color-brand)';
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = 'Close';
      const dismiss = () => { video.pause(); overlay.remove(); URL.revokeObjectURL(url); document.removeEventListener('keydown', onKey); };
      const onKey = (event) => { if (event.key === 'Escape') dismiss(); };
      close.addEventListener('click', dismiss);
      overlay.addEventListener('click', (event) => { if (event.target === overlay) dismiss(); });
      document.addEventListener('keydown', onKey);
      panel.append(title, video, download, close);
      overlay.append(panel);
      document.body.append(overlay);
    } catch (error) { notify(`Reel preview failed: ${error.message}`, 'error'); }
  }

  async function load(force=false) {
    if (livePaused && !force) return current;
    if (requestBusy) return current;
    requestBusy = true;
    try {
      if (!current) setState(`Loading live ${FLEET.length}-node cluster state…`);
      const data = await swarmApi('queue-status');
      render(data);
      return current;
    } catch (error) {
      setState(`Swarm API error: ${error.message}`, 'var(--color-red)');
      const grid = document.getElementById('swarm-nodes');
      if (grid) grid.innerHTML = `<span style="color:var(--color-red)">Unable to load live Swarm: ${esc(error.message)}</span>`;
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

  function normalizeTarget(value) {
    const v = String(value || '').trim();
    const lower = v.toLowerCase();
    return ({ nexus:'Nexus', steamdeck:'SteamDeck', alina:'Alina', viki:'viki' }[lower] || v);
  }

  async function resolveTarget(value) {
  const normalized = normalizeTarget(value);
  if (["__all__","all","__phones__","phones","__pcs__","pcs"].includes(normalized)) return normalized;
  if (IDS.has(normalized)) return normalized;

  try {
    const data = await controlApi('devices');
    const devices = Array.isArray(data.devices) ? data.devices : [];
    const hit = devices.find((d) => d.id === value || String(d.hostname || '').toLowerCase() === String(value || '').toLowerCase());
    if (hit) return normalizeTarget(hit.hostname);
  } catch {}
  return normalized;
}

async function syncPcDesired(type, targets) {
  if (!targets.length || type === 'mining-status') return;
  const data = await controlApi('devices');
  const devices = Array.isArray(data.devices) ? data.devices : [];
  const enabled = type !== 'mining-stop';
  for (const hostname of targets) {
    const device = devices.find((d) => String(d.hostname || '').toLowerCase() === hostname.toLowerCase());
    if (!device) continue;
    await controlApi('update-desired', 'POST', {
      device_id: device.id,
      desired: {
        miner_enabled: enabled,
        workload_enabled: enabled,
        thread_count: PC_TARGET_THREADS[hostname] ?? 4,
      },
    });
  }
}

  function phoneTargets(value) {
    const v = normalizeTarget(value);
    if (v === '__all__' || v === 'all' || v === '__phones__' || v === 'phones') return Array.from(PHONE_IDS);
    return PHONE_IDS.has(v) ? [v] : [];
  }

  function pcTargets(value, type) {
    const v = normalizeTarget(value);
    const online = (current?.nodes || []).filter((n) => n.online && PC_IDS.has(n.id)).map((n) => n.id);
    let targets;
    if (v === '__all__' || v === 'all' || v === '__pcs__' || v === 'pcs') targets = online;
    else targets = PC_IDS.has(v) && online.includes(v) ? [v] : [];
    if (type === 'mining-start' || type === 'mining-restart') targets = targets.filter((id) => id !== 'Nexus');
    return targets;
  }

  function swarmTargets(value) {
    const v = normalizeTarget(value);
    const online = (current?.nodes || []).filter((n) => n.online);
    if (v === '__all__' || v === 'all') return online.map((n) => n.id);
    if (v === '__phones__' || v === 'phones') return online.filter((n) => PHONE_IDS.has(n.id)).map((n) => n.id);
    if (v === '__pcs__' || v === 'pcs') return online.filter((n) => PC_IDS.has(n.id)).map((n) => n.id);
    return IDS.has(v) && online.some((n) => n.id === v) ? [v] : [];
  }

  async function enqueueSwarm(type, cmd, targets) {
    if (!targets.length) throw new Error('No online Swarm nodes match that target');
    if (MINER_TYPES.has(type)) {
      const old = targets.filter((id) => {
        const node = current?.nodes?.find((n) => n.id === id);
        return !node || !versionAtLeast(node.agent_version, REQUIRED_AGENT);
      });
      if (old.length) throw new Error(`Upgrade Swarm agent to v${REQUIRED_AGENT}: ${old.join(', ')}`);
    }
    if (type === 'shell' && !cmd) throw new Error('Shell jobs require a command');
    const job = {
      id:`web-v8-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      type,
      cmd:cmd || '',
      command:cmd || '',
    };
    return swarmApi('enqueue', 'POST', { job, target_device_ids:targets });
  }

  async function controlPhoneAction(type, targets) {
    if (!targets.length) return { count:0, commands:[] };
    const bridge = await controlApi('bridge-status');
    if (!bridge.alive) throw new Error('Windows phone bridge is offline; phone miner state was not changed');

    const deviceData = await controlApi('devices');
    const devices = Array.isArray(deviceData.devices) ? deviceData.devices : [];
    const mapped = targets.map((hostname) => ({
      hostname,
      targetThreads:PHONE_TARGET_THREADS[hostname],
      device:devices.find((d) => d.hostname === hostname),
    }));
    const missing = mapped.filter((x) => !x.device).map((x) => x.hostname);
    if (missing.length) throw new Error(`Control-plane device record missing: ${missing.join(', ')}`);

    const enabled = type !== 'mining-stop';
    for (const x of mapped) {
      await controlApi('update-desired', 'POST', {
        device_id:x.device.id,
        desired:{ miner_enabled:enabled, workload_enabled:enabled, thread_count:x.targetThreads },
      });
    }

    const commandType = type === 'mining-restart' ? 'restart' : type;
    const commandTargets = targets.length === PHONE_IDS.size ? ['phones'] : mapped.map((x) => x.device.id);
    const commands = [];
    for (const target of commandTargets) {
      const result = await controlApi('queue-command', 'POST', {
        target,
        type:commandType,
        payload:{ source:'dashboard-v8', thermal_authority:'windows-adb' },
      });
      commands.push(result.command_id || '?');
    }
    return { count:targets.length, commands };
  }

  function transcriptionCommand(source) {
    if (!source) throw new Error('Transcription requires a media URL or file path');
    const bytes = new TextEncoder().encode(source);
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    const encoded = btoa(binary);
    return `cd "$HOME/curt-revenue-worker" && . venv/bin/activate && SOURCE="$(printf '%s' '${encoded}' | base64 -d)" && python transcribe.py "$SOURCE" --model tiny.en --output-dir outputs`;
  }

  async function runAction(type, target='__all__', cmd='') {
    try {
      if (!current) await load();
      const resolvedTarget = await resolveTarget(target);

      if (DIAGNOSTIC_TYPES.has(type)) {
        const targets = swarmTargets(resolvedTarget);
        if (!targets.length) throw new Error('No online workers match that target');
        const old = targets.filter((id) => {
          const node = current?.nodes?.find((n) => n.id === id);
          const required = id === 'RenderRig' ? DIAGNOSTIC_WINDOWS_AGENT : DIAGNOSTIC_LINUX_AGENT;
          return !node || !versionAtLeast(node.agent_version, required);
        });
        const ready = targets.filter((id) => !old.includes(id));
        const fallback = old.filter((id) => id !== 'RenderRig');
        const blocked = old.filter((id) => id === 'RenderRig');
        if (!ready.length && !fallback.length) throw new Error(`Update RenderRig to ${DIAGNOSTIC_WINDOWS_AGENT} before this check`);
        if (ready.length) await enqueueSwarm(type, '', ready);
        if (fallback.length) await enqueueSwarm('shell', DIAGNOSTIC_FALLBACK[type], fallback);
        notify(`${type}: queued on ${ready.length + fallback.length} worker${ready.length + fallback.length === 1 ? '' : 's'}${blocked.length ? ' · update RenderRig for this check' : ''}`);
        await load();
        return { ok:true, targets:[...ready, ...fallback], skipped:blocked };
      }

      if (GPU_WORK_TYPES.has(type)) {
        const targets = swarmTargets(resolvedTarget).filter((id) => GPU_IDS.has(id));
        if (!targets.length) throw new Error('RenderRig must be online for RTX work');
        if (type === 'reel-create' && !versionAtLeast(current?.nodes?.find((n) => n.id === 'RenderRig')?.agent_version, REEL_WINDOWS_AGENT)) {
          throw new Error(`Update RenderRig to ${REEL_WINDOWS_AGENT} to create Reels`);
        }
        if (GPU_SETTINGS_TYPES.has(type)) {
          let settings;
          try { settings = JSON.parse(cmd); } catch { throw new Error('Job settings must be JSON. Use Reel GPU Test for the sample video.'); }
          if (!settings || Array.isArray(settings) || typeof settings !== 'object') {
            throw new Error('Job settings must be a JSON object. Use Reel GPU Test for the sample video.');
          }
        }
        const data = await enqueueSwarm(type, cmd, targets);
        notify(`${type}: queued on RenderRig`);
        await load();
        return data;
      }

      if (type === 'transcribe') {
        const targets = swarmTargets(resolvedTarget).filter((id) => TRANSCRIBE_IDS.has(id));
        if (!targets.length) throw new Error('Transcription runs on online Alina or Nexus nodes only');
        const data = await enqueueSwarm('shell', transcriptionCommand(cmd), targets);
        notify(`transcribe: queued on ${targets.join(', ')}`);
        await load();
        return data;
      }

      if (!MINER_TYPES.has(type)) {
        const targets = swarmTargets(resolvedTarget);
        const data = await enqueueSwarm(type, cmd, targets);
        notify(`${type}: ${data.target_count} Swarm target${data.target_count === 1 ? '' : 's'}`);
        await load();
        return data;
      }

      if (type === 'mining-status') {
        const targets = swarmTargets(resolvedTarget);
        const data = await enqueueSwarm(type, '', targets);
        notify(`mining-status: ${data.target_count} Swarm target${data.target_count === 1 ? '' : 's'}`);
        await load();
        return data;
      }

      const phones = phoneTargets(resolvedTarget);
      const pcs = pcTargets(resolvedTarget, type);
      const normalized = normalizeTarget(resolvedTarget);
      if ((type === 'mining-start' || type === 'mining-restart') && normalized === 'Nexus') {
        throw new Error('Nexus mining start is blocked by thermal policy');
      }
      if (!phones.length && !pcs.length) throw new Error('No canonical targets match that miner action');

      const parts = [];
      if (phones.length) {
        const phoneResult = await controlPhoneAction(type, phones);
        parts.push(`${phoneResult.count} phone${phoneResult.count === 1 ? '' : 's'} via Windows ADB thermal control`);
      }
      if (pcs.length) {
        await syncPcDesired(type, pcs);
        const pcResult = await enqueueSwarm(type, '', pcs);
        parts.push(`${pcResult.target_count} PC${pcResult.target_count === 1 ? '' : 's'} via Swarm`);
      }
      notify(`${type}: ${parts.join(' · ')}`);
      await load();
      return { ok:true, parts };
    } catch (error) {
      notify(`${type} failed: ${error.message}`, 'error');
      throw error;
    }
  }

  window.fetchSwarmStatus = load;
  window.renderSwarmStatus = render;
  window.onSwarmTabClick = start;

  window.submitSwarmJob = async () => {
    const type = document.getElementById('swarm-job-type')?.value || 'transcribe';
    const cmd = document.getElementById('swarm-job-cmd')?.value?.trim() || '';
    const target = document.getElementById('swarm-job-device')?.value || '__pcs__';
    try { return await runAction(type, target, cmd); } catch { return null; }
  };

  window.flushSwarmQueue = async () => {
    if (!confirm('Flush all pending Swarm jobs and assignments?')) return;
    try {
      await swarmApi('flush-queue', 'POST', {});
      notify('Swarm queue flushed');
      await load();
    } catch (error) { notify(`Flush failed: ${error.message}`, 'error'); }
  };

  window.clearSwarmResults = async () => {
    if (!confirm('Clear Swarm result history?')) return;
    try {
      await swarmApi('clear-results', 'POST', {});
      notify('Swarm results cleared');
      await load();
    } catch (error) { notify(`Clear failed: ${error.message}`, 'error'); }
  };

  window.queueShortcut = async (target, type) => {
    if (MINER_TYPES.has(type)) return runAction(type, target);
    if (typeof legacyQueueShortcut === 'function') return legacyQueueShortcut(target, type);
    return runAction(type, target);
  };


window.queueCmd = async (deviceId, type) => {
  if (MINER_TYPES.has(type)) return runAction(type, deviceId);
  if (typeof legacyQueueCmd === 'function') return legacyQueueCmd(deviceId, type);
  return controlApi('queue-command', 'POST', { target:deviceId, type });
};

  window.fleetMining = async (enabled, target) => runAction(enabled ? 'mining-start' : 'mining-stop', target || '__all__');

  window.dispatchCommand = async () => {
    const type = document.getElementById('cmdType')?.value || '';
    const target = document.getElementById('cmdTarget')?.value || 'all';
    if (MINER_TYPES.has(type)) return runAction(type, target);
    if (typeof legacyDispatchCommand === 'function') return legacyDispatchCommand();
    return runAction(type, target);
  };

  window.seedFleet = () => notify('Seed Missing Nodes is disabled. The 12-node registry is authoritative.', 'error');

  ensureUi();
  patchCommandShortcuts();

  const swarmButton = document.querySelector('[data-tab="swarm"]');
  if (swarmButton) swarmButton.addEventListener('click', () => setTimeout(start, 0), true);

  if (token()) setTimeout(start, 50);
  setInterval(() => {
    ensureUi();
    if (!started && token()) start();
  }, 1000);
})();
