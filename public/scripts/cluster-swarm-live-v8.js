(() => {
  const tab = document.getElementById('tab-swarm');
  if (!tab) return;

  const SWARM_API = '/api/cluster';
  const CONTROL_API = '/.netlify/functions/cluster-api';
  const REQUIRED_AGENT = '2.1.1';
  const DIAGNOSTIC_LINUX_AGENT = '2.2.0';
  const DIAGNOSTIC_WINDOWS_AGENT = '3.3.0';
  const REEL_WINDOWS_AGENT = '3.5.0';
  const EPISODE_WINDOWS_AGENT = '3.7.0';
  const MEDIA_EPISODE_WINDOWS_AGENT = '3.8.0';
  const RECOVERY_BRIDGE = '2.2.0';
  const EPISODE_SAMPLE = {
    title:'Before a socket rounds a bolt',
    scenes:[
      {heading:'A loose socket is a warning',caption:'Watch the tool move before the fastener.',narration:'See that tiny rock? If the socket moves on the fastener, more force can damage the head before it loosens.',visual:'rock',duration:12},
      {heading:'Seat the socket fully',caption:'Clean the head. Check the size. Push straight on.',narration:'Clear the fastener head, confirm the socket size, and seat it all the way before you pull.',visual:'seat',duration:12},
      {heading:'Six points or twelve?',caption:'Choose the contact that fits the fastener.',narration:'A six point socket can offer more stable contact on a worn hex. Check the fit before you commit.',visual:'contact',duration:12},
      {heading:'Keep the drive square',caption:'Side load can make a socket slip.',narration:'Line up the handle and the fastener. If the socket leans, reset your angle before adding torque.',visual:'align',duration:12},
      {heading:'Use controlled force',caption:'Pull steadily and watch the fastener.',narration:'Apply force smoothly and pay attention to what moves. A socket slipping is your signal to stop.',visual:'force',duration:12},
      {heading:'Know when to stop',caption:'Recheck the fit before damage gets worse.',narration:'If the tool starts to slip, back off and choose a better approach. Saving the fastener now saves work later.',visual:'stop',duration:12},
    ],
  };
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
  const GPU_WORK_TYPES = new Set(['gpu-status','salad-status','workstation-selftest','blender-render','ffmpeg-transcode','whisper-transcribe','comfyui-workflow','reel-create','episode-create']);
  const GPU_SETTINGS_TYPES = new Set(['blender-render','ffmpeg-transcode','whisper-transcribe','comfyui-workflow','reel-create','episode-create']);
  const PC_TARGET_THREADS = { Alina:12, Nexus:0, SteamDeck:4, viki:4 };
  const MINER_TYPES = new Set(['mining-status','mining-stop','mining-start','mining-restart']);

  const legacyQueueShortcut = window.queueShortcut;
  const legacyDispatchCommand = window.dispatchCommand;
  const legacyQueueCmd = window.queueCmd;

  let current = null;
  let pollTimer = null;
  let requestBusy = false;
  let pendingLoad = null;
  let lastSuccessfulLoad = 0;
  let started = false;
  let livePaused = false;
  let jobSubmitting = false;
  let nodeFilter = 'all';
  let recoveryLastCheck = 0;
  let recoveryBusy = false;
  let recoveryReady = false;
  let recoveryCommandId = null;
  const SAMPLE_MEDIA = 'https://github.com/ggerganov/whisper.cpp/raw/master/samples/jfk.wav';
  const MEDIA_SCRIPT_URL = 'https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts/cluster-media-discover.py';
  const mediaSelected = new Map();

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`${base}?action=${encodeURIComponent(action)}&_=${Date.now()}`, {
        method,
        headers: { Authorization: `Bearer ${pw}`, 'Content-Type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body),
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      });
      let data = {};
      try { data = await response.json(); } catch (error) { if (controller.signal.aborted) throw error; }
      if (response.status === 401) {
        sessionStorage.removeItem('cp_password');
        window.location.replace('/cluster/dashboard/?signedout=1');
        throw new Error('Session expired. Sign in again.');
      }
      if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Connection timed out. Please retry.');
      throw error;
    } finally { clearTimeout(timer); }
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
      'reel-create':'{"input":"%USERPROFILE%\\\\Videos\\\\shop-clip.mp4","hook":"What I check before a stuck bolt strips","tip":"Seat a 6-point socket fully and keep it square before the first pull.","cta":"Follow @curtbrag for shop tips"}',
      'episode-create':'Paste episode JSON or use Produce Episode to load a complete example.',
    };
    const needsCommand = type === 'shell' || type === 'transcribe' || Object.hasOwn(workloadHelp, type);
    input.disabled = !needsCommand;
    input.rows = type === 'episode-create' ? 9 : 2;
    input.placeholder = workloadHelp[type] || (type === 'transcribe'
      ? 'Media URL or existing file path on Alina/Nexus'
      : needsCommand
        ? 'Shell command (advanced)'
      : type.startsWith('mining-')
        ? 'Phones use Windows ADB thermal authority; PCs use Swarm'
        : 'No command text needed');
    if (!needsCommand) input.value = '';
    const label=document.getElementById('swarm-settings-label');
    if(label)label.textContent=GPU_SETTINGS_TYPES.has(type)?'Job settings (JSON)':type==='shell'?'Shell command':type==='transcribe'?'Media URL or worker file path':'Settings';
    const help=document.getElementById('swarm-job-help');
    if(help)help.textContent=GPU_SETTINGS_TYPES.has(type)?'Enter a JSON object. Paths must exist on RenderRig.':type==='shell'?'Runs on the selected online worker or group.':type==='transcribe'?'Transcription is available on Alina and Nexus.':'No settings required for this check.';
    const field=document.getElementById('swarm-settings-field');
    if(field)field.hidden=!needsCommand;
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

  const CONTROL_VIEWS=[['fleet','Fleet','Availability, diagnostics and recovery'],['audit','Website audits','Run checks and review evidence'],['research','Research','Brief, sources and reviewed drafts'],['media','Media jobs','Find assets and produce media'],['results','Queue & results','Track assignments and inspect output']];
  function setControlView(name,focus=false){
    if(!CONTROL_VIEWS.some(([id])=>id===name))name='fleet';
    for(const [id] of CONTROL_VIEWS){
      const panel=document.getElementById('cluster-view-'+id),button=document.getElementById('cluster-view-tab-'+id);
      if(panel)panel.hidden=id!==name;
      if(button){button.setAttribute('aria-selected',String(id===name));button.tabIndex=id===name?0:-1;}
    }
    try{localStorage.setItem('curt-control-view-v1',name);}catch{}
    if(focus)document.getElementById('cluster-view-tab-'+name)?.focus();
  }
  function ensureAdminNavigation(){
    if(document.getElementById('cluster-administration'))return;
    const work=document.querySelector('[data-tab="swarm"]');if(!work)return;
    const bar=work.parentElement;bar.classList.add('cluster-top-navigation');
    const admin=document.createElement('details');admin.id='cluster-administration';
    const summary=document.createElement('summary');summary.textContent='Administration';admin.append(summary);
    const content=document.createElement('div');content.className='cluster-admin-content';admin.append(content);
    for(const button of Array.from(bar.querySelectorAll('.tab-btn'))){
      button.removeAttribute('style');
      if(button!==work)content.append(button);
    }
    work.textContent='Workspace';bar.append(work,admin);
    const legacy=document.getElementById('stat-total')?.parentElement?.parentElement;
    if(legacy){
      const details=document.createElement('details');details.className='cluster-legacy-telemetry';
      details.innerHTML='<summary>Bridge registry telemetry</summary><p>These records belong to the older device registry. Workspace status uses the current 13-worker roster.</p>';
      details.append(legacy);content.append(details);
    }
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>work.click(),{once:true});
    else work.click();
  }
  function displayLaunchCommand(mode,phone){
    if(!['activity','visuals','clock','test','dashboard','home'].includes(mode)||!PHONE_IDS.has(phone))throw new Error('Invalid display selection');
    const url='https://curtbrag.com/cluster/display.html?mode='+mode+'&name='+phone+'&immersive=1';
    return `url='${url}'; if ! command -v timeout >/dev/null 2>&1; then echo 'Display launch requires timeout utility' >&2; exit 2; fi; out=$(timeout 20 am start --user 0 -a android.intent.action.VIEW -d "$url" 2>&1); code=$?; printf '%s\\n' "$out"; if [ "$code" -ne 0 ]; then echo 'Android launch failed or timed out; unlock the phone and check browser permissions' >&2; exit 2; fi; if printf '%s' "$out" | grep -Eiq 'error|exception|denied|background activity.*(blocked|abort)'; then echo 'Android rejected the display launch' >&2; exit 2; fi; if ! printf '%s' "$out" | grep -q 'Starting: Intent'; then echo 'Termux did not report an activity launch request; physical display unverified' >&2; exit 2; fi; echo 'Termux submitted a browser intent; Android may still block background launches. Unlock the phone and open Termux, then retry.'`;
  }
  function ensureDisplayControls(){
    const panel=document.getElementById('cluster-view-fleet');if(!panel||document.getElementById('cluster-display-control'))return;
    const card=document.createElement('section');card.id='cluster-display-control';card.className='cluster-control-card';
    card.innerHTML='<h3>Phone screens</h3><p>Choose what each phone shows remotely. Connected displays update automatically every 10 seconds.</p><label for="display-target">Phone</label><select id="display-target"><option value="all">All phones</option>'+Array.from(PHONE_IDS).map(p=>'<option>'+p+'</option>').join('')+'</select> <label for="display-mode">Display</label><select id="display-mode"><option value="activity">This unit’s activity</option><option value="visuals">Animations</option><option value="clock">Clock</option><option value="test">Screen test</option><option value="dashboard">Unit activity dashboard</option><option value="home">Display overview</option></select><div class="cluster-action-row"><button id="display-send" type="button" class="cluster-primary-action">Apply to phone screens</button><a id="display-open" href="/cluster/display.html" target="_blank" rel="noopener">Open display hub</a><button id="display-results" type="button">View launch results</button></div><p id="display-state" role="status"></p>';
    panel.insertBefore(card,panel.children[1]);
    const updateDisplayLink=()=>{const phone=document.getElementById('display-target').value,mode=document.getElementById('display-mode').value;document.getElementById('display-open').href='/cluster/display.html?mode='+encodeURIComponent(mode)+(PHONE_IDS.has(phone)?'&name='+encodeURIComponent(phone):'');};
    document.getElementById('display-target').onchange=updateDisplayLink;document.getElementById('display-mode').onchange=updateDisplayLink;updateDisplayLink();
    document.getElementById('display-results').onclick=()=>setControlView('results',true);
    document.getElementById('display-send').onclick=async()=>{
      const button=document.getElementById('display-send'),state=document.getElementById('display-state');button.disabled=true;
      const saved=[],launched=[],skipped=[];try{
        const raw=await swarmApi('queue-status');if(!Array.isArray(raw?.nodes))throw new Error('Worker availability could not be verified.');
        const fresh=canonicalize(raw),selected=document.getElementById('display-target').value,mode=document.getElementById('display-mode').value;
        const phones=selected==='all'?Array.from(PHONE_IDS):PHONE_IDS.has(selected)?[selected]:[];
        if(!phones.length)throw new Error('Select a phone');
        for(const phone of phones){
          state.textContent='Saving display for '+phone+'…';
          const response=await fetch('/.netlify/functions/phone-display',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token()},body:JSON.stringify({phone,mode})});
          if(!response.ok)throw new Error('Could not save display mode for '+phone);saved.push(phone);
          const node=fresh.nodes.find(n=>n.id===phone);
          if(node?.online&&!node.busy){
            const url='https://curtbrag.com/cluster/display.html?mode='+encodeURIComponent(mode)+'&name='+encodeURIComponent(phone)+'&immersive=1&v=62';
            await enqueueSwarm('shell',browserOpenCommand(url),[phone]);launched.push(phone);
          }else skipped.push(phone+' ('+(node?.online?'busy':'offline')+')');
        }
        state.textContent='Display mode saved for '+saved.join(', ')+'. '+(launched.length?'Browser launch queued for '+launched.join(', ')+'. ':'')+(skipped.length?'Browser launch skipped: '+skipped.join(', ')+'. ':'')+'Connected displays also update automatically within 10 seconds.';
        await load(true);
      }catch(e){state.textContent=(saved.length?'Display mode saved: '+saved.join(', ')+'. ':'')+(launched.length?'Browser launch queued: '+launched.join(', ')+'. ':'')+e.message;}finally{button.disabled=false;}
    };
  }

  function ensureControlLayout(){
    if(document.getElementById('cluster-work-navigation'))return;
    const workers=document.getElementById('swarm-nodes')?.parentElement;
    const job=document.getElementById('swarm-job-type')?.closest('div[style*="margin-bottom:16px"]');
    const queue=document.getElementById('swarm-queue-list')?.parentElement;
    const results=document.getElementById('swarm-results')?.parentElement;
    if(!workers||!job||!queue||!results||!document.getElementById('cluster-workspace'))return;
    tab.classList.add('cluster-workspace-ui');
    const stats=tab.firstElementChild;stats.classList.add('cluster-work-stats');
    document.getElementById('swarm-queued').parentElement.hidden=true;
    for(const [id,label] of [['swarm-nodes-online','Workers online'],['swarm-busy','Running'],['swarm-assignments','Waiting assignments'],['swarm-total','Completed jobs']]){
      const value=document.getElementById(id);value.previousElementSibling.textContent=label;stats.append(value.parentElement);
    }
    const nav=document.createElement('nav');nav.id='cluster-work-navigation';nav.setAttribute('role','tablist');nav.setAttribute('aria-label','Cluster workflows');
    const panels={};
    for(const [id,title,description] of CONTROL_VIEWS){
      const button=document.createElement('button');button.id='cluster-view-tab-'+id;button.type='button';button.setAttribute('role','tab');button.setAttribute('aria-controls','cluster-view-'+id);button.textContent=title;button.onclick=()=>setControlView(id);
      button.onkeydown=event=>{const index=CONTROL_VIEWS.findIndex(([key])=>key===id);let next;
        if(event.key==='ArrowRight')next=(index+1)%CONTROL_VIEWS.length;
        if(event.key==='ArrowLeft')next=(index+CONTROL_VIEWS.length-1)%CONTROL_VIEWS.length;
        if(event.key==='Home')next=0;if(event.key==='End')next=CONTROL_VIEWS.length-1;
        if(next!==undefined){event.preventDefault();setControlView(CONTROL_VIEWS[next][0],true);}
      };nav.append(button);
      const panel=document.createElement('section');panel.id='cluster-view-'+id;panel.className='cluster-work-view';panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',button.id);
      const intro=document.createElement('p');intro.className='cluster-view-intro';intro.textContent=description;panel.append(intro);panels[id]=panel;
    }
    stats.insertAdjacentElement('afterend',nav);
    for(const panel of Object.values(panels))tab.append(panel);
    workers.firstElementChild.classList.add('cluster-worker-heading');
    panels.fleet.append(workers,document.getElementById('cluster-phone-recovery'));
    panels.audit.append(document.getElementById('cluster-web-audit'));
    panels.research.append(document.getElementById('cluster-workspace'));
    panels.media.append(job,document.getElementById('cluster-media-discovery'));
    panels.results.append(queue,results);
    for(const panel of Object.values(panels))for(const card of Array.from(panel.children).filter(e=>e.tagName!=='P'))card.classList.add('cluster-control-card');
    const toolbar=document.getElementById('swarm-useful-tools');toolbar.className='cluster-action-row';toolbar.removeAttribute('style');
    const diagnostics=document.createElement('details');diagnostics.className='cluster-control-details';diagnostics.innerHTML='<summary>Worker diagnostics</summary>';
    const diagnosticActions=document.createElement('div');diagnosticActions.className='cluster-action-row';diagnostics.append(diagnosticActions);
    for(const id of ['swarm-fleet-storage','swarm-fleet-processes','swarm-fleet-network','swarm-gpu-status','swarm-salad-status','swarm-workstation-test'])diagnosticActions.append(document.getElementById(id));
    toolbar.insertAdjacentElement('afterend',diagnostics);
    const mediaActions=document.createElement('div');mediaActions.className='cluster-action-row';
    for(const id of ['swarm-reel-create','swarm-episode-create'])mediaActions.append(document.getElementById(id));
    job.insertBefore(mediaActions,job.firstChild);
    const examples=document.createElement('details');examples.className='cluster-control-details';examples.innerHTML='<summary>Test jobs and examples</summary><div class="cluster-action-row"></div>';
    for(const id of ['swarm-reel-gpu-test','swarm-sample'])examples.lastChild.append(document.getElementById(id));job.append(examples);
    results.querySelector('h3').insertAdjacentElement('afterend',document.getElementById('swarm-copy-latest'));
    const recovery=document.getElementById('cluster-phone-recovery');
    const logs=document.createElement('details');logs.className='cluster-control-details';logs.innerHTML='<summary>Connection and recovery logs</summary>';
    for(const id of ['cluster-fleet-check-result','cluster-fleet-diagnostics','cluster-phone-recovery-result'])logs.append(document.getElementById(id));recovery.append(logs);
    const audit=document.getElementById('cluster-web-audit');
    const settings=document.createElement('details');settings.className='cluster-control-details';settings.innerHTML='<summary>Audit settings · JSON</summary>';
    settings.append(audit.querySelector('label[for="cluster-audit-settings"]'),document.getElementById('cluster-audit-settings'));
    const setup=document.createElement('details');setup.className='cluster-control-details';setup.innerHTML='<summary>Browser worker setup</summary>';
    const prepare=document.getElementById('cluster-browser-prepare'),setupNote=prepare.previousElementSibling;
    if(setupNote?.tagName==='P')setup.append(setupNote);setup.append(prepare,document.getElementById('cluster-browser-runtime'));
    const actions=document.createElement('div');actions.className='cluster-action-row';
    actions.append(document.getElementById('cluster-audit-run'),document.getElementById('cluster-audit-retry'));
    const review=document.createElement('div');review.className='cluster-action-row';
    const plan=Array.from(audit.querySelectorAll('button')).find(b=>b.textContent==='Build fix plan');if(plan)review.append(plan);review.append(document.getElementById('cluster-audit-export'));
    const evidence=document.createElement('details');evidence.className='cluster-control-details';evidence.innerHTML='<summary>Page-by-page evidence</summary>';evidence.append(document.getElementById('cluster-audit-report'));
    audit.append(actions,document.getElementById('cluster-audit-state'),document.getElementById('cluster-audit-delivery'),settings,setup,review,evidence);
    const research=document.getElementById('cluster-workspace');
    const sources=document.createElement('details');sources.className='cluster-control-details';sources.innerHTML='<summary>Collected source evidence</summary>';
    const sourceReport=document.getElementById('workspace-report');sourceReport.insertAdjacentElement('beforebegin',sources);sources.append(sourceReport);
    const aiSetup=document.createElement('details');aiSetup.className='cluster-control-details';aiSetup.innerHTML='<summary>Local AI setup</summary>';
    const aiPrepare=document.getElementById('workspace-ai-prepare'),aiNote=aiPrepare.previousElementSibling;
    aiPrepare.insertAdjacentElement('beforebegin',aiSetup);if(aiNote?.tagName==='P')aiSetup.append(aiNote);aiSetup.append(aiPrepare);
    const researchManage=document.createElement('details');researchManage.className='cluster-control-details';researchManage.innerHTML='<summary>Manage unfinished research</summary>';
    researchManage.append(document.getElementById('workspace-cancel'));research.append(researchManage);
    for(const id of ['cluster-audit-run','workspace-run','cluster-media-run'])document.getElementById(id).classList.add('cluster-primary-action');
    const submit=job.querySelector('button[onclick="submitSwarmJob()"]');
    submit?.classList.add('cluster-primary-action');if(submit)submit.id='swarm-job-submit';
    const input=document.getElementById('swarm-job-cmd');input.parentElement.id='swarm-settings-field';input.previousElementSibling.id='swarm-settings-label';
    document.getElementById('swarm-job-device').previousElementSibling.textContent='Target worker or group';
    const help=document.createElement('p');help.id='swarm-job-help';input.insertAdjacentElement('afterend',help);
    const feedback=document.createElement('div');feedback.id='swarm-job-feedback';feedback.hidden=true;
    feedback.innerHTML='<p id="swarm-job-status" role="status" aria-live="polite"></p><button id="swarm-job-show-queue" type="button" hidden>View queue & results</button>';
    submit.parentElement.insertAdjacentElement('afterend',feedback);
    feedback.querySelector('button').onclick=()=>setControlView('results',true);
    syncJobInput();
    ensureDisplayControls();
    const cleanup=document.createElement('details');cleanup.className='cluster-control-details';cleanup.innerHTML='<summary>Queue cleanup</summary><p>These actions affect the shared queue or saved result history.</p><div class="cluster-action-row"></div>';
    for(const selector of ['button[onclick="flushSwarmQueue()"]','button[onclick="clearSwarmResults()"]']){const b=tab.querySelector(selector);if(b)cleanup.lastChild.append(b);}panels.results.append(cleanup);
    for(const id of ['cluster-audit-state','workspace-state','cluster-media-state'])document.getElementById(id)?.setAttribute('aria-live','polite');
    document.getElementById('swarm-job-type').setAttribute('aria-label','Job type');document.getElementById('swarm-job-device').setAttribute('aria-label','Target worker');document.getElementById('swarm-job-cmd').setAttribute('aria-label','Job settings or command');
    for(const id of ['workspace-episode-load','cluster-media-draft'])document.getElementById(id)?.addEventListener('click',()=>setControlView('media'));
    let saved='fleet';try{saved=localStorage.getItem('curt-control-view-v1')||saved;}catch{}setControlView(saved);
  }

  function ensureUi() {
    document.querySelectorAll('[onclick="seedFleet()"]').forEach((button) => button.remove());

    ensureAdminNavigation();

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
          <button type="button" id="swarm-episode-create" title="Create a narrated animated episode, short cut and full video">Produce Episode</button>
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
    ensureDisplayControls();
        input?.focus();
        notify('Sample loaded. Press Start when ready.');
      });
      document.getElementById('swarm-gpu-status').addEventListener('click', () => runAction('gpu-status', 'RenderRig'));
      document.getElementById('swarm-salad-status').addEventListener('click', () => runAction('salad-status', 'RenderRig'));
      document.getElementById('swarm-workstation-test').addEventListener('click', () => runAction('workstation-selftest', 'RenderRig'));
      document.getElementById('swarm-reel-create').addEventListener('click', () => {
        const type = document.getElementById('swarm-job-type');
        const target = document.getElementById('swarm-job-device');
        const input = document.getElementById('swarm-job-cmd');
        if (type) type.value = 'reel-create';
        if (target) target.value = 'RenderRig';
        syncJobInput();
    ensureDisplayControls();
        input?.focus();
        notify('Enter your clip path and Reel text as JSON, then press Start.');
      });
      document.getElementById('swarm-episode-create').addEventListener('click', () => {
        const type = document.getElementById('swarm-job-type');
        const target = document.getElementById('swarm-job-device');
        const input = document.getElementById('swarm-job-cmd');
        if (type) type.value = 'episode-create';
        if (target) target.value = 'RenderRig';
        syncJobInput();
    ensureDisplayControls();
        if (input) input.value = JSON.stringify(EPISODE_SAMPLE, null, 2);
        input?.focus();
        notify('Review the original episode script, then press Start.');
      });
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
          <option value="episode-create">Produce narrated episode + short cut</option>
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
    ensureDisplayControls();
      });
    }
    syncJobInput();
    ensureDisplayControls();

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
    ensurePhoneRecovery();
    ensureMediaDiscovery();
    ensureWebsiteAudit();
    ensureWorkspace();
    ensureControlLayout();
    ensureFleetHealth();
    ensureChangeMonitor();
    ensureSiteTest();
    ensureBrowserOpen();
  }

  let healthRun = null, healthSubmitting = false;
  try { healthRun = JSON.parse(localStorage.getItem('curt-fleet-health-v1')); } catch {}
  function saveHealth() { try { localStorage.setItem('curt-fleet-health-v1', JSON.stringify(healthRun)); } catch {} }
  function ensureFleetHealth() {
    const fleet = document.getElementById('cluster-view-fleet');
    if (!fleet || document.getElementById('fleet-health')) return;
    const card = document.createElement('section'); card.id = 'fleet-health';
    card.className = 'cluster-control-card';
    card.innerHTML = '<h3>Fleet health report</h3><p>Check storage and website connectivity on idle workers, then collect their results in one report. Busy and offline devices are listed as skipped.</p><button id="fleet-health-run" type="button">Run fleet health check</button> <button id="fleet-health-export" type="button" disabled>Export report</button><p id="fleet-health-state" role="status" aria-live="polite">Ready for a fleet check.</p><pre id="fleet-health-report" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto"></pre>';
    fleet.prepend(card);
    card.querySelector('#fleet-health-run').onclick = dispatchFleetHealth;
    card.querySelector('#fleet-health-export').onclick = () => {
      if (!healthRun) return;
      const blob = new Blob([JSON.stringify(healthRun,null,2)], {type:'application/json'});
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = healthRun.id+'.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    renderFleetHealth(current?.results || []);
  }
  function renderFleetHealth(results) {
    const state = document.getElementById('fleet-health-state');
    if (!state || !healthRun) return;
    let changed = false;
    for (const task of healthRun.tasks) {
      const result = results.find(r => r.job_id === task.job_id && r.device_id === task.unit);
      if (result && !['passed','failed'].includes(task.state)) {
        task.state = Number(result.exit_code) === 0 ? 'passed' : 'failed';
        task.output = String(result.stdout || '').slice(0,8000);
        task.error = String(result.stderr || '').slice(0,2000); changed = true;
      }
    }
    if (changed) saveHealth();
    const complete = healthRun.tasks.filter(t => ['passed','failed'].includes(t.state)).length;
    const failed = healthRun.tasks.filter(t => t.state === 'failed').length;
    state.textContent = `${complete}/${healthRun.tasks.length} checks returned · ${failed} failed · ${healthRun.skipped.length} devices skipped${healthSubmitting ? ' · dispatching' : ''}`;
    document.getElementById('fleet-health-export').disabled = false;
    document.getElementById('fleet-health-report').textContent = healthRun.tasks.map(t =>
      `${t.unit} · ${t.check} · ${t.state}${t.output ? '\n'+t.output : ''}${t.error ? '\n'+t.error : ''}`
    ).join('\n\n') + (healthRun.skipped.length ? '\n\nSkipped: '+healthRun.skipped.map(n=>n.unit+' ('+n.reason+')').join(', ') : '');
  }
  async function dispatchFleetHealth() {
    if (healthSubmitting) return;
    const button = document.getElementById('fleet-health-run');
    healthSubmitting = true; button.disabled = true;
    try {
      await load(true);
      if (!current) throw new Error('Live worker status is unavailable.');
      if (healthRun?.tasks.some(t=>['queued','submitting','unconfirmed'].includes(t.state))) throw new Error('Previous report still has pending checks. Review Queue & results before starting another batch.');
      const nodes = current.nodes.filter(n=>n.online && !n.busy);
      if (!nodes.length) throw new Error('No idle online workers are available.');
      healthRun = {id:'fleet-health-'+Date.now(), created_at:new Date().toISOString(), tasks:[],
        skipped:current.nodes.filter(n=>!n.online || n.busy).map(n=>({unit:n.id,reason:n.online?'busy':'offline'})),
        scope:'Worker storage and website connectivity; physical screen and SSH state are not tested.'};
      for (const check of ['storage-status','network-check']) {
        const ready = nodes.filter(n=>versionAtLeast(n.agent_version,n.id==='RenderRig'?DIAGNOSTIC_WINDOWS_AGENT:DIAGNOSTIC_LINUX_AGENT));
        const fallback = nodes.filter(n=>!ready.includes(n) && n.id!=='RenderRig');
        for (const group of [ready,fallback]) {
          if (!group.length) continue;
          const jobId = healthRun.id+'-'+check+'-'+(group===ready?'native':'fallback');
          const tasks = group.map(n=>({unit:n.id,check,job_id:jobId,state:'submitting'}));
          healthRun.tasks.push(...tasks); saveHealth(); renderFleetHealth(current.results);
          const cmd = group===ready?'':DIAGNOSTIC_FALLBACK[check];
          try {
            await swarmApi('enqueue','POST',{job:{id:jobId,type:group===ready?check:'shell',cmd,command:cmd},target_device_ids:group.map(n=>n.id)});
            tasks.forEach(t=>t.state='queued');
          } catch (error) { tasks.forEach(t=>t.state='unconfirmed'); throw new Error('Submission could not be confirmed. Check Queue & results before retrying.'); }
          saveHealth();
        }
        for (const node of nodes.filter(n=>!ready.includes(n) && n.id==='RenderRig')) {
          if (!healthRun.skipped.some(n=>n.unit===node.id)) healthRun.skipped.push({unit:node.id,reason:'agent update required'});
        }
      }
      await load(true);
    } catch (error) { document.getElementById('fleet-health-state').textContent = error.message; }
    finally { healthSubmitting = false; button.disabled = false; saveHealth(); }
  }


  let changeMonitor = {baselines:{},batch:null}, changeBusy=false;
  try { const saved=JSON.parse(localStorage.getItem('curt-change-monitor-v1')); if(saved?.baselines)changeMonitor=saved; } catch {}
  function saveChangeMonitor(){try{localStorage.setItem('curt-change-monitor-v1',JSON.stringify(changeMonitor));}catch{}}
  function ensureChangeMonitor(){
    const panel=document.getElementById('cluster-view-audit');
    if(!panel||document.getElementById('cluster-change-monitor'))return;
    const card=document.createElement('section');card.id='cluster-change-monitor';card.className='cluster-control-card';
    card.innerHTML='<h3>Website change monitor</h3><p>Compare public CurtBrag page text against saved snapshots. Phones and Linux workers share the checks. First checks establish a baseline; later checks show added and removed text.</p><label for="change-paths">Public page paths · one per line</label><textarea id="change-paths" rows="4" style="display:block;width:100%;box-sizing:border-box">/\n/gallery/\n/shop/\n/cluster/</textarea><button id="change-check" type="button">Check for changes</button> <button id="change-baseline" type="button" disabled>Accept current text as baseline</button> <button id="change-export" type="button" disabled>Export change report</button><p id="change-state" role="status" aria-live="polite">Ready. Snapshots are saved in this browser.</p><pre id="change-report" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:500px;overflow:auto"></pre>';
    panel.append(card);card.querySelector('#change-check').onclick=dispatchChangeMonitor;
    card.querySelector('#change-baseline').onclick=()=>{
      for(const task of changeMonitor.batch?.tasks||[])if(task.report)changeMonitor.baselines[task.path]=task.report;
      saveChangeMonitor();renderChangeMonitor(current?.results||[]);
    };
    card.querySelector('#change-export').onclick=()=>{
      const url=URL.createObjectURL(new Blob([JSON.stringify(changeMonitor.batch,null,2)],{type:'application/json'}));
      const a=document.createElement('a');a.href=url;a.download='website-changes.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    renderChangeMonitor(current?.results||[]);
  }
  function pageChanges(before,after){
    const previous=new Set(before.split('\n')),next=new Set(after.split('\n'));
    return {added:[...next].filter(line=>!previous.has(line)),removed:[...previous].filter(line=>!next.has(line)),
      reordered:before!==after&&previous.size===next.size&&[...previous].every(line=>next.has(line))};
  }
  function renderChangeMonitor(results){
    const state=document.getElementById('change-state'),batch=changeMonitor.batch;if(!state||!batch)return;
    for(const task of batch.tasks){
      if(task.state==='complete'||task.state==='failed')continue;
      const result=results.find(r=>r.job_id===task.job_id&&r.device_id===task.worker);if(!result)continue;
      let report;try{report=JSON.parse(result.stdout||'');}catch{}
      if(Number(result.exit_code)===0&&report?.kind==='page-snapshot'&&report.path===task.path&&typeof report.text==='string'&&report.text.length<=60000&&/^[a-f0-9]{64}$/.test(report.sha256||'')){
        task.state='complete';task.report=report;
        if(!changeMonitor.baselines[task.path]){changeMonitor.baselines[task.path]=report;task.firstBaseline=true;}
      }else{task.state='failed';task.error=String(report?.error||result.stderr||'Invalid page snapshot').slice(0,1000);}
    }
    for(const task of batch.tasks)if(task.report){const baseline=changeMonitor.baselines[task.path];task.changes=pageChanges(baseline.text,task.report.text);task.changed=baseline.sha256!==task.report.sha256;}
    saveChangeMonitor();
    const complete=batch.tasks.filter(t=>t.state==='complete').length,failed=batch.tasks.filter(t=>t.state==='failed').length;
    state.textContent=`${complete}/${batch.tasks.length} pages checked · ${batch.tasks.filter(t=>t.changed).length} changed · ${failed} failed`;
    document.getElementById('change-baseline').disabled=!complete||changeBusy;
    document.getElementById('change-export').disabled=false;
    document.getElementById('change-report').textContent=batch.tasks.map(t=>{
      if(!t.report)return `${t.path} · ${t.worker} · ${t.state}${t.error?'\n'+t.error:''}`;
      return `${t.path} · ${t.worker} · ${t.changed?'CHANGED':t.firstBaseline?'Baseline saved':'Unchanged'}\n${t.report.title}\n`+
        (t.changes.reordered?'Text order or repeated lines changed.\n':'')+
        t.changes.removed.slice(0,40).map(l=>'- '+l).join('\n')+'\n'+t.changes.added.slice(0,40).map(l=>'+ '+l).join('\n')+
        (t.changes.added.length>40||t.changes.removed.length>40?'\nPreview limited; export contains all changed lines.':'');
    }).join('\n\n');
  }
  async function dispatchChangeMonitor(){
    if(changeBusy)return;changeBusy=true;const button=document.getElementById('change-check');button.disabled=true;
    try{
      const paths=[...new Set(document.getElementById('change-paths').value.split(/\s+/).filter(Boolean))];
      if(paths.length<1||paths.length>12||paths.some(path=>!/^\/(?!\/)[A-Za-z0-9/_-]*$/.test(path)||path.startsWith('/cluster/dashboard')))throw Error('Use 1–12 public paths starting with /. Dashboard pages are excluded.');
      if(changeMonitor.batch?.tasks.some(t=>['queued','submitting','unconfirmed'].includes(t.state)))throw Error('Previous checks are pending. Review Queue & results before sending another batch.');
      const fresh=canonicalize(await swarmApi('queue-status'));
      const workers=fresh.nodes.filter(n=>n.online&&!n.busy&&n.id!=='RenderRig');if(!workers.length)throw Error('No idle phone or Linux workers available.');
      const id='change-monitor-'+Date.now();changeMonitor.batch={id,created_at:new Date().toISOString(),scope:'Public CurtBrag HTML text; manual checks; baselines saved in this browser.',tasks:paths.map((path,i)=>({path,worker:workers[i%workers.length].id,job_id:id+'-'+i,state:'planned'}))};
      saveChangeMonitor();
      for(const task of changeMonitor.batch.tasks){
        const cmd=`curl -fLsS --max-time 20 'https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts/cluster-page-snapshot.py' -o "$HOME/cluster-page-snapshot.py" && { if command -v python3 >/dev/null 2>&1; then P=python3; else P=python; fi; "$P" "$HOME/cluster-page-snapshot.py" --path '${task.path}'; }`;
        task.state='submitting';saveChangeMonitor();
        try{await swarmApi('enqueue','POST',{job:{id:task.job_id,type:'shell',cmd,command:cmd},target_device_ids:[task.worker]});task.state='queued';}
        catch{task.state='unconfirmed';saveChangeMonitor();throw Error('Submission is unconfirmed. Review Queue & results before retrying.');}
        saveChangeMonitor();renderChangeMonitor(current?.results||[]);
      }
      await load(true);
    }catch(error){document.getElementById('change-state').textContent=error.message;}
    finally{changeBusy=false;button.disabled=false;saveChangeMonitor();}
  }


  let browserOpenReport=null,browserOpenBusy=false;
  try{const saved=JSON.parse(localStorage.getItem('curt-browser-open-v1'));if(saved&&Array.isArray(saved.tasks)&&Array.isArray(saved.skipped)&&typeof saved.url==='string')browserOpenReport=saved;}catch{}
  function saveBrowserOpen(){try{localStorage.setItem('curt-browser-open-v1',JSON.stringify(browserOpenReport));}catch{}}
  function validateBrowserOpenUrl(value){
    if(typeof value!=='string'||value.length>2048||/[\u0000-\u0020\u007f\\]/.test(value))throw Error('Enter a complete public HTTPS address of up to 2048 characters without spaces, control characters or backslashes.');
    let url;try{url=new URL(value);}catch{throw Error('Enter a complete HTTPS website address.');}
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.href.length>2048)throw Error('Use a public HTTPS website without credentials or a custom port.');
    const host=url.hostname.toLowerCase();
    if(host.endsWith('.')||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)||/^[\d.]+$/.test(host)||/^\d+$/.test(host.split('.').at(-1))||['localhost','local','localdomain','lan','internal','test','invalid','onion','example','home'].some(s=>host===s||host.endsWith('.'+s)))throw Error('Use a public website hostname, rather than a local name, reserved suffix or IP address.');
    return url.href;
  }
  function ensureBrowserOpen(){
    const fleet=document.getElementById('cluster-view-fleet');if(!fleet||document.getElementById('cluster-browser-open'))return;
    const card=document.createElement('section');card.id='cluster-browser-open';card.className='cluster-control-card';
    card.innerHTML='<h3>Open website on devices</h3><p>Request a browser to open a website once on your selected devices. Browser launch requests do not verify screen or page visibility.</p><label for="browser-open-url">Website address</label><input id="browser-open-url" type="url" maxlength="2048" value="https://curtbrag.com/" style="display:block;width:100%;box-sizing:border-box;margin:8px 0;padding:10px"><label for="browser-open-target">Devices</label> <select id="browser-open-target"><option value="all">All available units</option>'+FLEET.map(([id])=>'<option value="'+id+'">'+id+'</option>').join('')+'</select><div class="cluster-action-row"><button id="browser-open-run" type="button">Open on selected devices</button><button id="browser-open-close" type="button" disabled>Close report</button></div><p>Busy and offline units are skipped. Close report preserves the record without cancelling or retrying jobs.</p><p id="browser-open-state" role="status" aria-live="polite">Ready. No browser launch requested.</p><pre id="browser-open-report" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto"></pre>';
    fleet.prepend(card);card.querySelector('#browser-open-run').onclick=dispatchBrowserOpen;card.querySelector('#browser-open-close').onclick=closeBrowserOpen;
    if(browserOpenReport?.url)card.querySelector('#browser-open-url').value=browserOpenReport.url;
    if(browserOpenReport?.target==='all'||IDS.has(browserOpenReport?.target))card.querySelector('#browser-open-target').value=browserOpenReport.target;
    renderBrowserOpen(current?.results||[]);
  }
  function renderBrowserOpen(results){
    const state=document.getElementById('browser-open-state');if(!state||!browserOpenReport)return;
    for(const task of browserOpenReport.tasks){
      if(['launch-requested','failed','closed'].includes(task.state))continue;
      const result=results.find(r=>r.job_id===task.job_id&&r.device_id===task.unit);if(!result)continue;
      let report;try{report=JSON.parse(result.stdout||'');}catch{}
      if(report?.kind==='website-browser-open'&&report.url===browserOpenReport.url&&typeof report.launch_requested==='boolean'&&report.visible_screen_verified===false){
        task.report=report;task.state=Number(result.exit_code)===0&&report.launch_requested===true&&report.state==='launch-requested'?'launch-requested':'failed';
        task.error=task.state==='failed'?String(report.error||result.stderr||'The worker did not report a successful browser launch request.').slice(0,500):'';
      }else{task.state='failed';task.error=String(result.stderr||'Worker returned an invalid browser launch report.').slice(0,500);}
    }
    saveBrowserOpen();
    const tasks=browserOpenReport.tasks,requested=tasks.filter(t=>t.state==='launch-requested').length,failed=tasks.filter(t=>t.state==='failed').length,closed=tasks.filter(t=>t.state==='closed').length;
    state.textContent=(tasks.length?'':'No available selected devices. ')+`${requested+failed}/${tasks.length} launch results · ${requested} launch requested · ${failed} failed · ${closed} closed · ${browserOpenReport.skipped.length} skipped. `+(requested?'Browser launch requested; screen/page visibility unverified.':'Screen/page visibility is unverified.');
    document.getElementById('browser-open-close').disabled=browserOpenBusy||!!browserOpenReport.closed_at;
    document.getElementById('browser-open-report').textContent=browserOpenReport.url+'\n\n'+tasks.map(t=>`${t.unit} · ${t.state}${t.report?.launcher?' · '+String(t.report.launcher):''}${t.error?'\n'+t.error:''}`).join('\n\n')+(browserOpenReport.skipped.length?'\n\nSkipped: '+browserOpenReport.skipped.map(n=>n.unit+' ('+n.reason+')').join(', '):'');
  }
  function browserOpenCommand(url){
    const bytes=new TextEncoder().encode(JSON.stringify({url}));let binary='';bytes.forEach(b=>binary+=String.fromCharCode(b));const encoded=btoa(binary);
    return `curl -fLsS --max-time 20 'https://raw.githubusercontent.com/curtbrag/curtbrag-website/f5a1cd0c29479d42228dd5c7f3905ad2e7ea36b2/scripts/cluster-browser-open.py' -o "$HOME/cluster-browser-open.py" && { if command -v python3 >/dev/null 2>&1; then P=python3; else P=python; fi; "$P" "$HOME/cluster-browser-open.py" --settings-b64 '${encoded}'; }`;
  }
  async function dispatchBrowserOpen(){
    if(browserOpenBusy)return;browserOpenBusy=true;document.getElementById('browser-open-run').disabled=true;document.getElementById('browser-open-close').disabled=true;
    try{
      const url=validateBrowserOpenUrl(document.getElementById('browser-open-url').value),target=document.getElementById('browser-open-target').value;
      if(target!=='all'&&!IDS.has(target))throw Error('Select a canonical cluster unit.');
      if(browserOpenReport?.tasks.some(t=>['queued','submitting','unconfirmed'].includes(t.state)))throw Error('Previous launch requests are pending. Review Queue & results before opening another batch.');
      document.getElementById('browser-open-state').textContent='Checking available devices…';
      const raw=await swarmApi('queue-status');if(!Array.isArray(raw?.nodes))throw Error('Worker availability could not be verified.');
      const fleet=canonicalize(raw),selected=fleet.nodes.filter(n=>IDS.has(n.id)&&(target==='all'||n.id===target));
      const ready=selected.filter(n=>n.online&&!n.busy&&(n.id!=='RenderRig'||versionAtLeast(n.agent_version,'3.7.2')));
      const id='browser-open-'+Date.now()+'-'+Math.random().toString(36).slice(2,8);
      browserOpenReport={id,url,target,created_at:new Date().toISOString(),scope:'One browser launch request per selected available unit; physical screen and target page visibility are unverified.',tasks:ready.map((n,i)=>({unit:n.id,job_id:id+'-'+i,state:'planned'})),skipped:selected.filter(n=>!ready.includes(n)).map(n=>({unit:n.id,reason:!n.online?'offline':n.busy?'busy':'agent update required'}))};saveBrowserOpen();renderBrowserOpen(current?.results||[]);
      for(const task of browserOpenReport.tasks){
        const windows=task.unit==='RenderRig',cmd=windows?JSON.stringify({url}):browserOpenCommand(url);task.state='submitting';saveBrowserOpen();renderBrowserOpen(current?.results||[]);
        try{await swarmApi('enqueue','POST',{job:{id:task.job_id,type:windows?'website-open':'shell',cmd,command:cmd},target_device_ids:[task.unit]});task.state='queued';}
        catch{task.state='unconfirmed';saveBrowserOpen();throw Error('Browser launch submission is unconfirmed. Review Queue & results before retrying.');}
        saveBrowserOpen();renderBrowserOpen(current?.results||[]);
      }
      if(ready.length)await load(true);
    }catch(error){document.getElementById('browser-open-state').textContent=error.message;}
    finally{browserOpenBusy=false;document.getElementById('browser-open-run').disabled=false;document.getElementById('browser-open-close').disabled=!browserOpenReport||!!browserOpenReport.closed_at;saveBrowserOpen();}
  }
  async function closeBrowserOpen(){
    if(browserOpenBusy||!browserOpenReport||browserOpenReport.closed_at)return;
    browserOpenBusy=true;document.getElementById('browser-open-run').disabled=true;document.getElementById('browser-open-close').disabled=true;
    try{
      const raw=await swarmApi('queue-status');if(!Array.isArray(raw?.nodes)||!Array.isArray(raw.jobs)||!Array.isArray(raw.results))throw Error('Queue status is incomplete. The report remains open.');
      const fresh=canonicalize(raw);renderBrowserOpen(fresh.results);
      const ids=new Set(browserOpenReport.tasks.map(t=>t.job_id)),jobId=value=>typeof value==='string'?value:value?.job_id||value?.id||value?.job?.id,terminal=new Set(['completed','cancelled','canceled','failed']);
      if(fresh.jobs.some(job=>ids.has(jobId(job))&&!terminal.has(String(job.status??job.state??'').toLowerCase()))||fresh.nodes.some(node=>(node.active_jobs||[]).some(job=>ids.has(jobId(job)))))throw Error('Launch requests still appear queued or running. Review Queue & results before closing.');
      const age=Date.now()-Date.parse(browserOpenReport.created_at);
      if(browserOpenReport.tasks.some(t=>['queued','submitting','unconfirmed'].includes(t.state))&&(!Number.isFinite(age)||age<120000))throw Error('Wait at least two minutes after submission, then review Queue & results before closing missing launch requests.');
      for(const task of browserOpenReport.tasks)if(!['launch-requested','failed','closed'].includes(task.state))task.state='closed';
      browserOpenReport.closed_at=new Date().toISOString();saveBrowserOpen();renderBrowserOpen(fresh.results);
    }catch(error){document.getElementById('browser-open-state').textContent=error.message;}
    finally{browserOpenBusy=false;document.getElementById('browser-open-run').disabled=false;document.getElementById('browser-open-close').disabled=!browserOpenReport||!!browserOpenReport.closed_at;}
  }

  let siteTest=null, siteTestBusy=false;
  try{const saved=JSON.parse(localStorage.getItem('curt-site-test-v1'));if(saved?.tasks)siteTest=saved;}catch{}
  function saveSiteTest(){try{localStorage.setItem('curt-site-test-v1',JSON.stringify(siteTest));}catch{}}
  function validateSiteTestUrl(value){
    let url;try{url=new URL(value);}catch{throw Error('Enter a complete HTTPS website address.');}
    if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port||url.href.length>512||url.search)throw Error('Use a public HTTPS page of up to 512 characters without a login, custom port, query or fragment.');
    if(!url.hostname.includes('.')||url.hostname.endsWith('.local')||url.hostname==='localhost'||/^[\d.]+$/.test(url.hostname)||url.hostname.includes(':'))throw Error('Use a public website hostname.');
    return url.href;
  }
  function ensureSiteTest(){
    const fleet=document.getElementById('cluster-view-fleet');if(!fleet||document.getElementById('cluster-site-test'))return;
    const card=document.createElement('section');card.id='cluster-site-test';card.className='cluster-control-card';
    card.innerHTML='<h3>Test a website across devices</h3><p>Run one page-load check from each available phone or computer and collect responses and timing. Each device performs one bounded check; this does not open screens or play streams.</p><label for="site-test-url">Website address</label><input id="site-test-url" type="url" value="https://curtbrag.com/" style="display:block;width:100%;box-sizing:border-box;margin:8px 0;padding:10px"><label for="site-test-owned" style="display:block;margin:10px 0"><input id="site-test-owned" type="checkbox"> I own this site or have permission to test it.</label><button id="site-test-run" type="button">Test on all available devices</button> <button id="site-test-export" type="button" disabled>Export results</button> <button id="site-test-close" type="button" disabled>Close report</button><p>Close a report after reviewing Queue &amp; results. This preserves its export and does not cancel or retry jobs.</p><p id="site-test-state" role="status" aria-live="polite">Ready. Busy and offline units will be skipped.</p><pre id="site-test-report" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto"></pre>';
    fleet.prepend(card);card.querySelector('#site-test-run').onclick=dispatchSiteTest;
    card.querySelector('#site-test-close').onclick=closeSiteTest;
    card.querySelector('#site-test-export').onclick=()=>{
      const url=URL.createObjectURL(new Blob([JSON.stringify(siteTest,null,2)],{type:'application/json'}));
      const a=document.createElement('a');a.href=url;a.download=siteTest.id+'.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    if(siteTest?.url)card.querySelector('#site-test-url').value=siteTest.url;
    renderSiteTest(current?.results||[]);
  }
  function renderSiteTest(results){
    const state=document.getElementById('site-test-state');if(!state||!siteTest)return;
    for(const task of siteTest.tasks){
      if(['passed','failed','closed'].includes(task.state))continue;
      const result=results.find(r=>r.job_id===task.job_id&&r.device_id===task.unit);if(!result)continue;
      let report;try{report=JSON.parse(result.stdout||'');}catch{}
      if(report?.kind==='website-load-test'&&report.url===siteTest.url&&Number.isFinite(report.total_ms)){
        task.report=report;task.state=Number(result.exit_code)===0&&report.ok===true?'passed':'failed';
        task.error=String(report.error||'').slice(0,500);
      }else{task.state='failed';task.error=String(result.stderr||'Worker returned an invalid page-load result.').slice(0,500);}
    }
    saveSiteTest();
    const complete=siteTest.tasks.filter(t=>['passed','failed'].includes(t.state)).length,failed=siteTest.tasks.filter(t=>t.state==='failed').length,closed=siteTest.tasks.filter(t=>t.state==='closed').length;
    state.textContent=`${complete}/${siteTest.tasks.length} results returned · ${failed} failed · ${closed} closed · ${siteTest.skipped.length} devices skipped`;
    document.getElementById('site-test-export').disabled=false;
    document.getElementById('site-test-close').disabled=siteTestBusy||!!siteTest.closed_at;
    document.getElementById('site-test-report').textContent=siteTest.url+'\n\n'+siteTest.tasks.map(t=>{
      const r=t.report;return `${t.unit} · ${t.state}${r?' · HTTP '+(r.status??'unavailable')+' · '+Math.round(r.total_ms)+' ms':''}${r?.title?'\n'+r.title:''}${t.error?'\n'+t.error:''}`;
    }).join('\n\n')+(siteTest.skipped.length?'\n\nSkipped: '+siteTest.skipped.map(n=>n.unit+' ('+n.reason+')').join(', '):'');
  }
  function siteTestCommand(url){
    const payload=JSON.stringify({url});const bytes=new TextEncoder().encode(payload);let binary='';bytes.forEach(b=>binary+=String.fromCharCode(b));const encoded=btoa(binary);
    return `curl -fLsS --max-time 20 'https://raw.githubusercontent.com/curtbrag/curtbrag-website/d95a9fff64c84531155d858574691a18483583a7/scripts/cluster-url-test.py' -o "$HOME/cluster-url-test.py" && { if command -v python3 >/dev/null 2>&1; then P=python3; else P=python; fi; "$P" "$HOME/cluster-url-test.py" --settings-b64 '${encoded}'; }`;
  }
  async function closeSiteTest(){
    if(siteTestBusy||!siteTest||siteTest.closed_at)return;
    siteTestBusy=true;document.getElementById('site-test-run').disabled=true;document.getElementById('site-test-close').disabled=true;
    try{
      const raw=await swarmApi('queue-status');
      if(!Array.isArray(raw?.nodes)||!Array.isArray(raw.jobs)||!Array.isArray(raw.results))throw Error('Queue status is incomplete. The report remains open.');
      const fresh=canonicalize(raw);renderSiteTest(fresh.results);
      const ids=new Set(siteTest.tasks.map(t=>t.job_id)),jobId=value=>typeof value==='string'?value:value?.job_id||value?.id||value?.job?.id;
      const terminal=new Set(['completed','cancelled','canceled','failed']);
      const queued=fresh.jobs.some(job=>ids.has(jobId(job))&&!terminal.has(String(job.status??job.state??'').toLowerCase()));
      const active=fresh.nodes.some(node=>(node.active_jobs||[]).some(job=>ids.has(jobId(job))));
      if(queued||active)throw Error('Checks still appear queued or running. Review Queue & results before closing this report.');
      const ambiguous=siteTest.tasks.some(t=>['queued','submitting','unconfirmed'].includes(t.state));
      const age=Date.now()-Date.parse(siteTest.created_at);
      if(ambiguous&&(!Number.isFinite(age)||age<120000))throw Error('Wait at least two minutes after submission, then review Queue & results before closing missing checks.');
      for(const task of siteTest.tasks)if(!['passed','failed','closed'].includes(task.state))task.state='closed';
      siteTest.closed_at=new Date().toISOString();saveSiteTest();renderSiteTest(fresh.results);
    }catch(error){document.getElementById('site-test-state').textContent=error.message;}
    finally{siteTestBusy=false;document.getElementById('site-test-run').disabled=false;document.getElementById('site-test-close').disabled=!siteTest||!!siteTest.closed_at;}
  }
  async function dispatchSiteTest(){
    if(siteTestBusy)return;siteTestBusy=true;const button=document.getElementById('site-test-run');button.disabled=true;document.getElementById('site-test-close').disabled=true;
    try{
      if(!document.getElementById('site-test-owned').checked)throw Error('Confirm you own this site or have permission to test it.');
      const url=validateSiteTestUrl(document.getElementById('site-test-url').value.trim());
      if(siteTest?.tasks.some(t=>['queued','submitting','unconfirmed'].includes(t.state)))throw Error('Previous checks are pending. Review Queue & results before starting another batch.');
      document.getElementById('site-test-state').textContent='Checking available devices…';
      const fleet=canonicalize(await swarmApi('queue-status')),ready=fleet.nodes.filter(n=>n.online&&!n.busy&&(n.id!=='RenderRig'||versionAtLeast(n.agent_version,'3.7.1')));
      if(!ready.length)throw Error('No idle online devices are available.');
      const id='site-test-'+Date.now();siteTest={id,url,created_at:new Date().toISOString(),scope:'One HTML HTTP load per available unit; no physical browser or playback test.',tasks:ready.map((n,i)=>({unit:n.id,job_id:id+'-'+i,state:'planned'})),skipped:fleet.nodes.filter(n=>!ready.includes(n)).map(n=>({unit:n.id,reason:!n.online?'offline':n.busy?'busy':'agent update required'}))};saveSiteTest();renderSiteTest(current?.results||[]);
      for(const task of siteTest.tasks){
        const windows=task.unit==='RenderRig',cmd=windows?JSON.stringify({url}):siteTestCommand(url);task.state='submitting';saveSiteTest();renderSiteTest(current?.results||[]);
        try{await swarmApi('enqueue','POST',{job:{id:task.job_id,type:windows?'website-test':'shell',cmd,command:cmd},target_device_ids:[task.unit]});task.state='queued';}
        catch{task.state='unconfirmed';saveSiteTest();throw Error('Submission is unconfirmed. Review Queue & results before retrying.');}
        saveSiteTest();renderSiteTest(current?.results||[]);
      }
      await load(true);
    }catch(error){document.getElementById('site-test-state').textContent=error.message;}
    finally{siteTestBusy=false;button.disabled=false;document.getElementById('site-test-close').disabled=!siteTest||!!siteTest.closed_at;saveSiteTest();}
  }

  function ensurePhoneRecovery() {
    if (document.getElementById('cluster-phone-recovery')) return;
    const anchor = document.getElementById('swarm-nodes')?.parentElement;
    if (!anchor) return;
    const card = document.createElement('div');
    card.id = 'cluster-phone-recovery';
    card.style.cssText = 'background:var(--color-panel);border:1px solid var(--color-border);border-radius:8px;padding:16px;margin-bottom:16px';
    card.innerHTML = `<h3 style="margin:0 0 7px">Fleet connections · 13 devices</h3>
      <p style="font-size:12px;color:var(--color-muted)">8 phones · RenderRig · Alina · Nexus · SteamDeck · viki. The Windows bridge checks SSH ports automatically every 5 minutes.</p>
      <button id="cluster-fleet-check" type="button" disabled>Check all connections now</button>
      <pre id="cluster-fleet-check-result" style="white-space:pre-wrap;font-size:12px">Bridge 2.3.0 required for connection checks.</pre>
      <button id="cluster-fleet-diagnose" type="button" disabled>Check SSH login + workers</button>
      <button id="cluster-fleet-discover" type="button" disabled>Find phone IPs</button>
      <button id="cluster-pc-recover" type="button" disabled>Start missing PC workers</button>
      <pre id="cluster-fleet-diagnostics" style="white-space:pre-wrap;font-size:12px">Bridge 2.4.0 required for diagnostics and PC recovery.</pre>
      <h3>Phone worker recovery</h3>
      <p style="font-size:12px;color:var(--color-muted);margin:0 0 10px">Ask the Windows bridge to restart the existing swarm agent on offline phones and refresh their Termux boot script. Online workers, mining, and device power stay untouched.</p>
      <button id="cluster-phone-recover" type="button" disabled style="background:var(--color-brand);color:white;border:0;border-radius:6px;padding:8px 14px;cursor:pointer">Recover offline phones</button>
      <span id="cluster-phone-recovery-state" style="font-size:11px;color:var(--color-muted);margin-left:9px">Checking bridge version…</span>
      <pre id="cluster-phone-recovery-result" style="display:none;white-space:pre-wrap;font-size:11px;color:var(--color-muted);margin:10px 0 0"></pre>`;
    anchor.insertAdjacentElement('afterend', card);
    for (const [id,type] of [['cluster-fleet-diagnose','fleet-diagnose'],['cluster-pc-recover','swarm-recover-pcs'],['cluster-fleet-discover','fleet-discover']]) {
      card.querySelector(`#${id}`).addEventListener('click',async () => {
        if (type === 'swarm-recover-pcs' && !confirm('Start missing swarm workers on offline Alina, Nexus, SteamDeck and viki? Existing worker processes are preserved.')) return;
        try {
          await controlApi('queue-command','POST',{target:'all',type});
          document.getElementById('cluster-fleet-diagnostics').textContent='Queued on Windows bridge; waiting for device results…';
          await refreshPhoneRecovery(true);
        } catch(error) { notify(error.message,'error'); }
      });
    }
    card.querySelector('#cluster-fleet-check').addEventListener('click', async () => {
      const button = document.getElementById('cluster-fleet-check');
      button.disabled = true;
      try {
        await controlApi('queue-command', 'POST', {target:'all',type:'fleet-check'});
        document.getElementById('cluster-fleet-check-result').textContent = 'Checking all devices from the Windows bridge…';
      } catch (error) { notify(error.message, 'error'); }
      await refreshPhoneRecovery(true);
    });
    card.querySelector('#cluster-phone-recover').addEventListener('click', recoverOfflinePhones);
  }

  async function refreshPhoneRecovery(force=false) {
    const button = document.getElementById('cluster-phone-recover');
    const state = document.getElementById('cluster-phone-recovery-state');
    const result = document.getElementById('cluster-phone-recovery-result');
    if (!button || recoveryBusy || (!force && Date.now() - recoveryLastCheck < 12000)) return;
    recoveryBusy = true;
    recoveryLastCheck = Date.now();
    try {
      const [bridge, commands] = await Promise.all([controlApi('bridge-status'), controlApi('commands')]);
      const diagnosticPending = (commands.queue || []).some(c => ['fleet-diagnose','swarm-recover-pcs','fleet-discover'].includes(c.type));
      for (const id of ['cluster-fleet-diagnose','cluster-pc-recover','cluster-fleet-discover']) document.getElementById(id).disabled = !bridge.alive || !versionAtLeast(bridge.bridge_version,'2.4.0') || diagnosticPending;
      const diagnosticHistory = (commands.history || []).find(c => ['fleet-diagnose','swarm-recover-pcs','fleet-discover'].includes(c.type));
      if (diagnosticHistory && !diagnosticPending) document.getElementById('cluster-fleet-diagnostics').textContent = `${new Date(diagnosticHistory.finished_at).toLocaleString()} · ${diagnosticHistory.result_summary || ''}\n${diagnosticHistory.output || ''}`;
      const fleetButton = document.getElementById('cluster-fleet-check');
      fleetButton.disabled = !bridge.alive || !versionAtLeast(bridge.bridge_version, '2.3.0') || (commands.queue || []).some(c => c.type === 'fleet-check');
      const connections = bridge.fleet_connections;
      if (connections?.devices) {
        const age = Date.now() - Date.parse(connections.checked_at);
        document.getElementById('cluster-fleet-check-result').textContent = `Checked ${new Date(connections.checked_at).toLocaleString()}${age > 360000 ? ' · STALE' : ''}\n` + connections.devices.map(d => {
          const node = (current?.nodes || []).find(n => n.id === d.name);
          return `${d.name.padEnd(10)} ${d.ip}:${d.port || 'local'} · ${d.port === 0 ? 'local bridge' : d.reachable ? 'SSH port open' : 'SSH unreachable'} · worker ${node?.online ? 'online' : 'offline'}`;
        }).join('\n');
      }
      recoveryReady = !!bridge.alive && versionAtLeast(bridge.bridge_version, RECOVERY_BRIDGE);
      const offline = (current?.nodes || []).filter(n => PHONE_IDS.has(n.id) && !n.online).length;
      const pending = (commands.queue || []).some(c => c.type === 'swarm-recover');
      button.disabled = !recoveryReady || !offline || pending;
      state.textContent = !bridge.alive ? 'Windows bridge offline' :
        !recoveryReady ? `Windows bridge ${RECOVERY_BRIDGE} required (current ${bridge.bridge_version || 'older'})` :
        pending ? 'Recovery running; waiting for bridge results' :
        offline ? `${offline} offline phone worker${offline === 1 ? '' : 's'} · bridge ready` : 'All phone workers online';
      const history = (commands.history || []).find(c => c.type === 'swarm-recover' &&
        (recoveryCommandId ? c.id === recoveryCommandId : Date.now() - c.finished_at < 600000));
      if (history) {
        result.style.display = 'block';
        result.textContent = `${history.status === 'failed' ? 'Recovery failed' : 'Recovery completed'}: ${history.result_summary || ''}\n${history.output || ''}`;
      }
    } catch (error) {
      button.disabled = true;
      state.textContent = `Recovery status unavailable: ${error.message}`;
    } finally { recoveryBusy = false; }
  }

  async function recoverOfflinePhones() {
    const button = document.getElementById('cluster-phone-recover');
    if (!recoveryReady || button.disabled) return;
    const offline = (current?.nodes || []).filter(n => PHONE_IDS.has(n.id) && !n.online).map(n => n.id);
    if (!offline.length) return notify('All phone workers are already online');
    if (!confirm(`Recover swarm workers on ${offline.join(', ')}? Mining and power controls will not change.`)) return;
    button.disabled = true;
    try {
      const queued = await controlApi('queue-command', 'POST', {target:'phones', type:'swarm-recover'});
      recoveryCommandId = queued.command_id;
      document.getElementById('cluster-phone-recovery-state').textContent = `Queued recovery for ${offline.length} phones`;
      notify('Phone worker recovery queued on the Windows bridge');
      await refreshPhoneRecovery(true);
    } catch (error) {
      notify(`Phone recovery failed: ${error.message}`, 'error');
      await refreshPhoneRecovery(true);
    }
  }

  function ensureMediaDiscovery() {
    if (document.getElementById('cluster-media-discovery')) return;
    const anchor = document.getElementById('swarm-job-type')?.closest('div[style*="margin-bottom:16px"]');
    if (!anchor) return;
    const card = document.createElement('div');
    card.id = 'cluster-media-discovery';
    card.style.cssText = 'background:var(--color-panel);border:1px solid var(--color-border);border-radius:8px;padding:16px;margin-bottom:16px';
    card.innerHTML = `<h3 style="margin:0 0 7px">Discover internet media with the swarm</h3>
      <p style="font-size:12px;color:var(--color-muted);margin:0 0 10px">Search Wikimedia Commons in parallel on online phones and Linux PCs. Save a source manifest for original narrated edits; review every file and its license before publishing.</p>
      <label style="display:block;font-size:11px;margin-bottom:5px">Batch settings (JSON)</label>
      <textarea id="cluster-media-settings" rows="3" spellcheck="false" style="width:100%;box-sizing:border-box;background:var(--color-bg);color:var(--color-text);border:1px solid var(--color-border);border-radius:6px;padding:8px;font-family:monospace;font-size:12px">{"query":"machining workshop","kind":"any","per_worker":3,"workers":8}</textarea>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:9px 0"><button id="cluster-media-run" type="button" style="background:var(--color-brand);color:white;border:0;border-radius:6px;padding:8px 14px;cursor:pointer">Search across workers</button><button id="cluster-media-export" type="button" style="background:var(--color-bg);color:var(--color-text);border:1px solid var(--color-border);border-radius:6px;padding:8px 14px;cursor:pointer">Export selected manifest</button><button id="cluster-media-draft" type="button" style="background:var(--color-bg);color:var(--color-text);border:1px solid var(--color-border);border-radius:6px;padding:8px 14px;cursor:pointer">Load episode JSON</button><button id="cluster-media-credits" type="button" style="background:var(--color-bg);color:var(--color-text);border:1px solid var(--color-border);border-radius:6px;padding:8px 14px;cursor:pointer">Copy source credits</button><span id="cluster-media-state" style="font-size:11px;color:var(--color-muted)"></span></div>
      <details style="margin:10px 0"><summary style="cursor:pointer;font-size:12px">Episode batch · up to 5 finished JSON jobs</summary><p style="font-size:11px;color:var(--color-muted)">Write a distinct script for each episode. Add each finished episode from Start Work, then queue the array for RenderRig.</p><textarea id="cluster-episode-batch" rows="4" placeholder="[]" spellcheck="false" style="width:100%;box-sizing:border-box;background:var(--color-bg);color:var(--color-text);border:1px solid var(--color-border);border-radius:6px;padding:8px;font-family:monospace;font-size:11px">[]</textarea><div style="display:flex;gap:8px;margin-top:7px"><button id="cluster-batch-add" type="button">Add form episode</button><button id="cluster-batch-run" type="button">Queue batch on RenderRig</button><span id="cluster-batch-state" style="font-size:11px;color:var(--color-muted)"></span></div></details>
      <div id="cluster-media-results" style="display:grid;gap:6px;font-size:11px"></div>`;
    anchor.insertAdjacentElement('afterend', card);
    card.querySelector('#cluster-media-run').addEventListener('click', dispatchMediaDiscovery);
    card.querySelector('#cluster-media-export').addEventListener('click', exportMediaManifest);
    card.querySelector('#cluster-media-draft').addEventListener('click', loadMediaEpisodeDraft);
    card.querySelector('#cluster-media-credits').addEventListener('click', copyMediaCredits);
    card.querySelector('#cluster-batch-add').addEventListener('click', addEpisodeToBatch);
    card.querySelector('#cluster-batch-run').addEventListener('click', dispatchEpisodeBatch);
  }

  let auditBatch = null;
  let browserAuditBatch = null;
  const AUDIT_KEY='curt-website-audit-batch-v1';
  let auditRecord=null;
  try{auditRecord=JSON.parse(localStorage.getItem(AUDIT_KEY)||'null');auditBatch=auditRecord?.http_batch||null;browserAuditBatch=auditRecord?.browser_batch||null;}catch{}
  let auditSubmitting=false;
  const BROWSER_SCRIPT='https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts/cluster-browser-audit.py';
  const BROWSER_PCS=new Set(['Alina','Nexus','viki','SteamDeck']);
  function browserWorkers(spec){
    const ids=spec.browser_workers||[];
    if(!Array.isArray(ids)||ids.length>4||ids.some(id=>!BROWSER_PCS.has(id)))throw new Error('browser_workers must list Alina, Nexus, viki or SteamDeck');
    return [...new Set(ids)];
  }
  function browserCommand(path,prepare=false){
    if(!prepare&&(typeof path!=='string'||!/^\/(?!\/)[A-Za-z0-9/_-]*$/.test(path)))throw new Error('Invalid browser audit path');
    const python=prepare?'python3':'"$HOME/cluster/browser-audit-venv/bin/python"';
    return `curl -fLsS --max-time 20 '${BROWSER_SCRIPT}' -o "$HOME/cluster-browser-audit.py" && ${python} "$HOME/cluster-browser-audit.py" ${prepare?'--prepare':`--path '${path}'`}`;
  }
  async function prepareBrowserAudit(){
    const button=document.getElementById('cluster-browser-prepare');button.disabled=true;
    try{
      const spec=JSON.parse(document.getElementById('cluster-audit-settings').value),ids=browserWorkers(spec);
      if(!ids.length)throw new Error('Add browser_workers to audit settings first');
      await load(true);
      const offline=ids.filter(id=>!current?.nodes.some(n=>n.id===id&&n.online&&!n.busy));
      if(offline.length)throw new Error('Browser PCs must be online and idle: '+offline.join(', '));
      for(const id of ids){const cmd=browserCommand(null,true);await swarmApi('enqueue','POST',{job:{id:`browser-runtime-${Date.now()}-${id}`,type:'shell',cmd,command:cmd},target_device_ids:[id]});}
      notify('Browser setup queued. Check runtime results before running browser audits.');await load(true);
    }catch(error){notify(error.message,'error');}finally{button.disabled=false;}
  }
  function ensureWebsiteAudit() {
    if (document.getElementById('cluster-web-audit')) return;
    const anchor = document.getElementById('cluster-phone-recovery');
    if (!anchor) return;
    const card = document.createElement('div'); card.id='cluster-web-audit';
    card.style.cssText='background:var(--color-panel);border:1px solid var(--color-border);border-radius:8px;padding:16px;margin-bottom:16px';
    card.innerHTML=`<h3>Website audit swarm</h3><p>Split public curtbrag.com pages across online phone and Linux workers. Check HTTP responses, internal links, titles, descriptions, H1 headings, image alt attributes and mobile viewport metadata.</p><label for="cluster-audit-settings">Audit settings (JSON)</label><textarea id="cluster-audit-settings" rows="4" style="width:100%">{"paths":["/","/shop/","/gallery/","/rig/","/cluster/","/contact/"],"workers":6}</textarea><button id="cluster-audit-run" type="button">Audit website across workers</button> <button id="cluster-audit-export" type="button">Export audit report</button><p id="cluster-audit-state">HTTP/HTML checks only; visual layouts and form submissions are not tested.</p><div id="cluster-audit-report"></div>`;
    anchor.insertAdjacentElement('afterend',card);
    card.querySelector('#cluster-audit-settings').value=JSON.stringify(auditRecord?.settings||{paths:['/','/shop/','/gallery/','/rig/','/cluster/','/contact/'],workers:6,browser_workers:['Alina','Nexus']});
    const prepare=document.createElement('button');prepare.id='cluster-browser-prepare';prepare.type='button';prepare.textContent='Prepare browser testing';prepare.onclick=prepareBrowserAudit;
    card.querySelector('#cluster-audit-run').insertAdjacentElement('beforebegin',prepare);
    const note=document.createElement('p');note.textContent='Optional browser_workers run Chromium desktop/mobile checks. Prepare installs an isolated Playwright runtime and Chromium on those PCs. Reports include evidence and proposed fixes; no form submissions or code changes.';prepare.insertAdjacentElement('beforebegin',note);
    const runtime=document.createElement('p');runtime.id='cluster-browser-runtime';prepare.insertAdjacentElement('afterend',runtime);
    card.querySelector('#cluster-audit-run').addEventListener('click',dispatchWebsiteAudit);
    const retry=document.createElement('button');retry.id='cluster-audit-retry';retry.type='button';retry.textContent='Retry unsent audit tasks';retry.onclick=retryAuditTasks;card.querySelector('#cluster-audit-run').insertAdjacentElement('afterend',retry);
    const delivery=document.createElement('p');delivery.id='cluster-audit-delivery';retry.insertAdjacentElement('afterend',delivery);
    const planButton=document.createElement('button');planButton.type='button';planButton.textContent='Build fix plan';planButton.onclick=showAuditFixPlan;card.querySelector('#cluster-audit-export').insertAdjacentElement('afterend',planButton);
    card.querySelector('#cluster-audit-export').addEventListener('click',()=>{
      const reports=auditReports(current?.results || []);
      if (!reports.length) return notify('No audit results available','error');
      const json=JSON.stringify({scope:'curtbrag.com HTTP/HTML and Chromium audit; proposals require review',batch:auditRecord,reports},null,2);
      document.getElementById('cluster-audit-export-panel')?.remove();
      const panel=document.createElement('div');panel.id='cluster-audit-export-panel';
      panel.innerHTML='<h4>Combined website audit JSON</h4><p>Copy this report or download it. Keep an export before server result history expires.</p><textarea aria-label="Combined website audit JSON" readonly rows="10" style="width:100%"></textarea><a download="curt-website-audit.json">Download audit JSON</a> <button type="button">Close audit export</button>';
      panel.querySelector('textarea').value=json;
      const url=URL.createObjectURL(new Blob([json],{type:'application/json'}));panel.querySelector('a').href=url;
      panel.querySelector('button').onclick=()=>{URL.revokeObjectURL(url);panel.remove();};
      card.append(panel);panel.querySelector('textarea').focus();panel.querySelector('textarea').select();
    });
  }
  function auditReports(results) {
    const inBatch=(id,batch)=>!batch||id.startsWith(batch+'-')&&/^\d+$/.test(id.slice(batch.length+1));
    const matches=id=>id.startsWith('audit-v1-')&&inBatch(id,auditBatch)||id.startsWith('browser-audit-v1-')&&inBatch(id,browserAuditBatch);
    const selected=results.filter(r=>matches(String(r.job_id||'')));
    const live=selected.map(r=>{
      const browser=String(r.job_id).startsWith('browser-audit-v1-');
      try { const data=JSON.parse(r.stdout || '');
        if(Number(r.exit_code)===0&&data.kind==='website-audit'&&Array.isArray(data.page?.issues))return {...data.page,worker:r.device_id,mode:'HTTP/HTML'};
        if(Number(r.exit_code)===0&&data.kind==='website-browser-audit'&&Array.isArray(data.page?.viewports))return {...data.page,worker:r.device_id,mode:'Chromium',issues:data.page.viewports.flatMap(v=>(v.findings||[]).map(f=>`${v.viewport}: ${f.check} · ${f.evidence}`)),proposals:data.page.viewports.flatMap(v=>(v.findings||[]).map(f=>({viewport:v.viewport,...f})))};
        if(data.error)throw new Error(data.error);
      } catch(error){return {worker:r.device_id,mode:browser?'Chromium':'HTTP/HTML',url:'Incomplete check',issues:[String(error.message).slice(0,600)]};}
      return {worker:r.device_id,mode:browser?'Chromium':'HTTP/HTML',url:'Incomplete check',issues:[`Worker failed or returned invalid report: ${String(r.stderr || r.exit_code).slice(0,600)}`]};
    }).map((report,index)=>({...report,job_id:selected[index].job_id}));
    const combined=new Map();
    for(const report of auditRecord?.reports||[])if(matches(String(report.job_id||'')))combined.set(report.job_id+'|'+report.worker,report);
    // Queue results are newest first. Keep only the latest result for each assignment.
    const seen=new Set();
    for(const report of live){const key=report.job_id+'|'+report.worker;if(!seen.has(key)){combined.set(key,report);seen.add(key);}}
    const reports=[...combined.values()];
    if(auditRecord&&JSON.stringify(auditRecord.reports||[])!==JSON.stringify(reports)){
      auditRecord.reports=reports;
      saveAuditRecord();
    }
    return reports;
  }
  function auditFixPlan(reports,record){
    const expected=(record?.settings?.paths?.length||0)*(record?.settings?.browser_workers?.length?2:1);
    const incomplete=reports.filter(r=>r.url==='Incomplete check');
    const tasks=[];
    for(const r of reports){
      if(r.url==='Incomplete check')continue;
      if(r.mode==='Chromium')for(const f of r.proposals||[])tasks.push({page:r.url,worker:r.worker,check:f.check,viewport:f.viewport,evidence:f.evidence,proposal:f.proposal,validation:`Rerun Chromium on ${r.url} at ${f.viewport}; confirm the finding disappears and desktop/mobile layouts remain usable.`});
      else for(const issue of r.issues||[])tasks.push({page:r.url,worker:r.worker,check:'HTTP/HTML',evidence:issue,proposal:'Inspect the affected page source and correct the reported response, link or markup.',validation:`Rerun the HTTP/HTML audit on ${r.url}; confirm this finding disappears.`});
    }
    const gaps=['Forms and interactive flows have not been tested.','Single-run timings do not establish Core Web Vitals.'];
    if(expected>reports.length)gaps.push(`${expected-reports.length} expected page reports are missing.`);
    for(const r of incomplete)gaps.push(`${r.worker}: ${r.issues.join('; ')}`);
    for(const r of reports)for(const v of r.viewports||[]){
      if(v.pending_images)gaps.push(`${r.url} (${v.viewport}): ${v.pending_images} images were still pending; scroll and verify them.`);
      if(v.blocked_resource_hosts?.length)gaps.push(`${r.url} (${v.viewport}): excluded resources from ${v.blocked_resource_hosts.join(', ')} require separate review.`);
    }
    return {kind:'website-fix-plan',batch:record,report_count:reports.length,expected_reports:expected,status:incomplete.length||expected>reports.length?'incomplete':tasks.length?'review-required':'no-detected-fixes',tasks,coverage_gaps:[...new Set(gaps)]};
  }
  function showAuditFixPlan(){
    const reports=auditReports(current?.results||[]);
    if(!reports.length)return notify('Collect audit results before building a fix plan','error');
    const plan=auditFixPlan(reports,auditRecord);
    document.getElementById('cluster-audit-plan')?.remove();
    const panel=document.createElement('section');panel.id='cluster-audit-plan';
    panel.innerHTML=`<h4>Reviewable website fix plan</h4><p>${esc(plan.status)} · ${plan.report_count} / ${plan.expected_reports||'?'} reports · ${plan.tasks.length} proposed fixes</p>${plan.tasks.length?plan.tasks.map(t=>`<article><strong>${esc(t.page)} · ${esc(t.check)} ${esc(t.viewport||'')}</strong><p>Evidence (${esc(t.worker)}): ${esc(t.evidence)}</p><p>Proposed change: ${esc(t.proposal)}</p><p>Validation: ${esc(t.validation)}</p></article>`).join(''):'<p>No patches proposed from the completed checks.</p>'}<h4>Coverage to complete</h4><ul>${plan.coverage_gaps.map(g=>`<li>${esc(g)}</li>`).join('')}</ul><p>This is a review plan. Code patches and preview validation are separate steps.</p><label for="cluster-audit-plan-json">Website fix plan JSON</label><textarea id="cluster-audit-plan-json" readonly rows="8" style="width:100%"></textarea>`;
    panel.querySelector('textarea').value=JSON.stringify(plan,null,2);
    document.getElementById('cluster-web-audit').append(panel);
    panel.querySelector('textarea').focus();
  }
  function renderWebsiteAudit(results) {
    const host=document.getElementById('cluster-audit-report'); if(!host)return;
    const reports=auditReports(results);
    const unsent=auditUnsent(auditRecord,current||{jobs:[],results:[]}).length;
    document.getElementById('cluster-audit-delivery').textContent=auditRecord?.tasks?`${auditRecord.tasks.length} saved assignments · ${unsent} unsent or unconfirmed. Retry keeps the same batch and skips known jobs/results.`:'Older batch: start a new audit to enable saved assignments.';
    document.getElementById('cluster-audit-retry').disabled=auditSubmitting||!unsent;
    host.innerHTML=reports.map(r=>`<article style="border-top:1px solid var(--color-border);padding:10px 0"><strong>${esc(r.url)}</strong> · ${esc(r.worker)} · ${esc(r.mode)}${r.mode==='HTTP/HTML'?` · HTTP ${esc(r.status??'?')} · ${esc(r.ms??'?')} ms`:''}<p>${esc(r.title || '')}</p><ul>${(r.issues.length?r.issues:['No issues in the completed checks']).map(i=>`<li>${esc(i)}</li>`).join('')}</ul>${(r.proposals||[]).map(f=>`<p><strong>Proposed fix (${esc(f.viewport)}):</strong> ${esc(f.proposal)}</p>`).join('')}${(r.viewports||[]).map(v=>`<p>${esc(v.viewport)} ${esc(v.width)}×${esc(v.height)} · overflow ${esc(v.overflow_px??'?')}px · DOM ready ${esc(v.timings?.dom_content_loaded_ms??'?')} ms · load ${esc(v.timings?.load_ms??'?')} ms${v.pending_images?` · ${esc(v.pending_images)} images still pending`:''}${v.blocked_resource_hosts?.length?` · excluded hosts: ${esc(v.blocked_resource_hosts.join(', '))}`:''}</p>`).join('')}<small>${r.mode==='HTTP/HTML'?`${esc(r.links_checked||0)} internal links checked. HTTP fetch time is not browser load performance.`:'Single-run Chromium checks; forms, interactive flows and Core Web Vitals are not tested.'}</small></article>`).join('');
    const expected=auditRecord?.settings?.paths?.length*(auditRecord?.settings?.browser_workers?.length?2:1);
    if(reports.length||expected)document.getElementById('cluster-audit-state').textContent=`${reports.length}${expected?' / '+expected:''} page reports · ${reports.reduce((n,r)=>n+r.issues.length,0)} findings · HTTP/HTML + optional Chromium checks${expected&&reports.length<expected?' · incomplete; keep collecting results':''}`;
    const runtime=results.filter(r=>String(r.job_id||'').startsWith('browser-runtime-'));
    const latest=new Map();for(const r of runtime)if(!latest.has(r.device_id))latest.set(r.device_id,r);
    document.getElementById('cluster-browser-runtime').textContent=[...latest.values()].map(r=>{try{const d=JSON.parse(r.stdout||'');return `${r.device_id}: ${Number(r.exit_code)===0&&d.ready?'browser ready':d.error||'setup failed'}`;}catch{return `${r.device_id}: setup failed`;}}).join(' · ');
  }
  function auditUnsent(record,state){
    return (record?.tasks||[]).filter(t=>t.status!=='queued'&&!state.jobs.some(j=>j.id===t.job_id)&&!state.results.some(r=>r.job_id===t.job_id&&r.device_id===t.worker));
  }
  function saveAuditRecord(){try{localStorage.setItem(AUDIT_KEY,JSON.stringify(auditRecord));}catch{notify('Browser storage unavailable; export the audit report before closing this page.','error');}}
  async function submitAuditTasks(){
    const fresh=await swarmApi('queue-status');
    for(const task of auditRecord.tasks){
      if(fresh.jobs.some(j=>j.id===task.job_id)||fresh.results.some(r=>r.job_id===task.job_id&&r.device_id===task.worker))task.status='queued';
    }
    saveAuditRecord();
    for(const task of auditUnsent(auditRecord,fresh)){
      if(!fresh.nodes.some(n=>n.id===task.worker&&n.online))continue;
      task.status='submitting';saveAuditRecord();
      try{
        await swarmApi('enqueue','POST',{job:{id:task.job_id,type:'shell',cmd:task.cmd,command:task.cmd},target_device_ids:[task.worker]});
        task.status='queued';delete task.error;saveAuditRecord();
      }catch(error){task.status='unconfirmed';task.error=String(error.message).slice(0,200);saveAuditRecord();throw error;}
    }
    await load(true);
  }
  async function retryAuditTasks(){
    if(auditSubmitting)return;
    if(!auditRecord?.tasks?.length)return notify('This older batch has no saved assignments. Start a new audit.','error');
    auditSubmitting=true;
    try{await submitAuditTasks();notify('Unsent audit assignments checked; queued or completed work was skipped.');}
    catch(error){notify('Audit retry: '+error.message,'error');}
    finally{auditSubmitting=false;}
  }
  async function dispatchWebsiteAudit() {
    if(auditSubmitting)return;
    auditSubmitting=true;
    const button=document.getElementById('cluster-audit-run');button.disabled=true;
    const state=document.getElementById('cluster-audit-state');
    try {
      const spec=JSON.parse(document.getElementById('cluster-audit-settings').value);
      if(!Array.isArray(spec.paths)||spec.paths.length<1||spec.paths.length>12||!Number.isInteger(spec.workers)||spec.workers<1||spec.workers>12||spec.paths.some(p=>typeof p!=='string'||!/^\/(?!\/)[A-Za-z0-9/_-]*$/.test(p)))throw new Error('Use 1–12 site paths starting with / and workers from 1–12.');
      const browserIds=browserWorkers(spec);
      await load();
      if(!current)throw new Error('Live worker state is not available yet; retry once loaded');
      if(browserIds.some(id=>!current.nodes.some(n=>n.id===id&&n.online&&!n.busy)))throw new Error('All browser_workers must be online and idle');
      const nodes=current.nodes.filter(n=>n.online&&n.id!=='RenderRig'&&IDS.has(n.id)).slice(0,spec.workers);
      if(!nodes.length)throw new Error('No online phone or Linux workers');
      document.getElementById('cluster-audit-plan')?.remove();
      auditBatch=`audit-v1-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
      browserAuditBatch=`browser-audit-v1-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
      auditRecord={http_batch:auditBatch,browser_batch:browserAuditBatch,created_at:new Date().toISOString(),settings:{...spec,paths:[...new Set(spec.paths)],browser_workers:browserIds},tasks:[]};
      for(const [i,path] of [...new Set(spec.paths)].entries()) {
        const node=nodes[i%nodes.length];
        const cmd=`curl -fLsS --max-time 20 'https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts/cluster-web-audit.py' -o "$HOME/cluster-web-audit.py" && { if command -v python3 >/dev/null 2>&1; then P=python3; else P=python; fi; "$P" "$HOME/cluster-web-audit.py" --path '${path}'; }`;
        auditRecord.tasks.push({job_id:`${auditBatch}-${i}`,worker:node.id,path,mode:'HTTP/HTML',cmd,status:'unsent'});
      }
      for(const [i,path] of browserIds.length?[...new Set(spec.paths)].entries():[]){
        const cmd=browserCommand(path),id=browserIds[i%browserIds.length];
        auditRecord.tasks.push({job_id:`${browserAuditBatch}-${i}`,worker:id,path,mode:'Chromium',cmd,status:'unsent'});
      }
      saveAuditRecord();
      await submitAuditTasks();
    } catch(error){state.textContent=error.message;notify(error.message,'error');}finally{auditSubmitting=false;button.disabled=false;}
  }

  const WORKSPACE_KEY='curt-swarm-workspace-v1';
  let workspace=null, workspaceBusy=false;
  try { workspace=JSON.parse(localStorage.getItem(WORKSPACE_KEY)||'null'); if(!Array.isArray(workspace?.tasks))workspace=null; } catch {}
  function saveWorkspace(){ try {localStorage.setItem(WORKSPACE_KEY,JSON.stringify(workspace));}catch{notify('Browser storage unavailable; keep this page open to retain your report','error');} }
  function ensureResearchBrief(card){
    const json=document.getElementById('workspace-json');
    const fields=document.createElement('div');fields.id='workspace-brief-form';
    fields.innerHTML='<label for="workspace-brief">Research brief</label><textarea id="workspace-brief" rows="3" maxlength="500" placeholder="What should the finished report explain?"></textarea><label for="workspace-questions">Research questions</label><textarea id="workspace-questions" rows="5" placeholder="One question per line"></textarea><p>Each question becomes a separate worker assignment. This version gathers Wikipedia search excerpts for review.</p><label for="workspace-workers">Maximum workers</label><select id="workspace-workers"></select><p id="workspace-form-error" role="status" aria-live="polite"></p>';
    json.previousElementSibling.insertAdjacentElement('beforebegin',fields);
    const advanced=document.createElement('details');advanced.className='cluster-control-details';advanced.innerHTML='<summary>Advanced research settings · JSON</summary>';
    json.previousElementSibling.insertAdjacentElement('beforebegin',advanced);
    advanced.append(json.previousElementSibling,json);
    const brief=fields.querySelector('#workspace-brief'),questions=fields.querySelector('#workspace-questions'),workers=fields.querySelector('#workspace-workers'),error=fields.querySelector('#workspace-form-error');
    for(let n=1;n<=12;n++)workers.add(new Option(String(n),String(n)));
    const draftKey='curt-research-brief-draft-v1';
    const persist=()=>{try{localStorage.setItem(draftKey,json.value);}catch{error.textContent='Draft cannot be saved in this browser. Keep this page open.';}};
    const showFields=spec=>{brief.value=typeof spec.brief==='string'?spec.brief:'';questions.value=Array.isArray(spec.tasks)?spec.tasks.join('\n'):'';workers.value=String(spec.workers||3);};
    try{const draft=localStorage.getItem(draftKey);if(draft!==null)json.value=draft;else if(workspace)json.value=JSON.stringify({brief:workspace.brief,tasks:workspace.tasks.map(t=>t.query),workers:workspace.workers});showFields(JSON.parse(json.value));}catch{error.textContent='Saved settings contain invalid JSON. Correct Advanced research settings or enter a new brief.';advanced.open=true;}
    const update=()=>{error.textContent='';json.value=JSON.stringify({brief:brief.value,tasks:questions.value.split(/\r?\n/).map(q=>q.trim()).filter(Boolean),workers:Number(workers.value)},null,2);persist();};
    brief.addEventListener('input',update);questions.addEventListener('input',update);workers.addEventListener('change',update);
    json.addEventListener('input',()=>{persist();try{showFields(JSON.parse(json.value));error.textContent='';}catch{error.textContent='Settings must be valid JSON before starting research.';}});
    card.querySelector('h3').textContent='Research swarm';
    card.querySelector('h3').nextElementSibling.textContent='Separate worker assignments collect Wikipedia article introductions with dates and revision IDs. Review each question’s coverage, then export the evidence report. The local AI creates a short draft from a bounded subset for media; it does not replace the evidence report.';
    fields.querySelector('p').textContent='One question per line. Successful retrieval collects evidence; it does not mean the question is answered.';
  }
  function ensureWorkspace(){
    if(document.getElementById('cluster-workspace'))return;
    const anchor=document.getElementById('cluster-web-audit');if(!anchor)return;
    const card=document.createElement('section');card.id='cluster-workspace';
    card.style.cssText='background:var(--color-panel);border:1px solid var(--color-border);border-radius:8px;padding:16px;margin-bottom:16px';
    card.innerHTML=`<h3>Swarm workspace</h3><p>One research brief, separate worker tasks, one collected source report. Uses online phones and Linux PCs to retrieve Wikipedia sources. Gather sources, then create a cited draft on a Linux PC using a local model.</p><label for="workspace-json">Brief and tasks (JSON)</label><textarea id="workspace-json" rows="7" style="width:100%">{"brief":"Research electric vehicles for a factual content series","tasks":["Electric vehicle battery recycling","Electric vehicle charging infrastructure","Electric vehicle energy efficiency"],"workers":3}</textarea><button id="workspace-run" type="button">Start research swarm</button> <button id="workspace-retry" type="button">Retry failed / unsent tasks</button> <button id="workspace-cancel" type="button">Cancel unfinished assignments</button> <button id="workspace-export" type="button">Export combined report</button><p>Latest batch is saved in this browser. Keep the dashboard open to collect results before server history expires. Cancelling assignments does not stop commands already running.</p><p id="workspace-state"></p><div id="workspace-report"></div><h4>Local AI draft</h4><label for="workspace-ai-worker">Drafting PC</label><select id="workspace-ai-worker"><option value="viki">viki</option><option value="Alina">Alina</option><option value="Nexus">Nexus</option><option value="SteamDeck">SteamDeck</option></select><p>Prepare downloads Ollama from its official source and Qwen3 4B (about 2.5 GB plus runtime). Stored on the selected PC; model service binds to loopback. After a restart, Prepare restarts the service and reuses downloaded files.</p><button type="button" id="workspace-ai-prepare">Prepare local AI</button> <button type="button" id="workspace-ai-draft">Draft from collected sources</button><div id="workspace-ai-report"></div><button id="workspace-episode-load" type="button">Load research video JSON</button><button id="workspace-publish-package" type="button">Build publishing package</button><div id="workspace-publish-report"></div><p id="workspace-episode-state">Creates a narrated diagram preview from the completed draft. Source links remain in the combined report.</p>`;
    anchor.insertAdjacentElement('afterend',card);
    ensureResearchBrief(card);
    card.querySelector('#workspace-run').onclick=()=>dispatchWorkspace(false);
    card.querySelector('#workspace-retry').onclick=()=>dispatchWorkspace(true);
    card.querySelector('#workspace-cancel').onclick=cancelWorkspace;
    card.querySelector('#workspace-export').onclick=exportWorkspace;
    card.querySelector('#workspace-ai-prepare').onclick=()=>submitAI('runtime');
    card.querySelector('#workspace-ai-draft').onclick=()=>submitAI('draft');
    card.querySelector('#workspace-episode-load').onclick=loadResearchEpisode;
    card.querySelector('#workspace-publish-package').onclick=showPublishingPackage;
    const review=document.createElement('div');review.id='workspace-review-panel';review.hidden=true;
    review.innerHTML='<label for="workspace-review-json">Draft review (JSON)</label><textarea id="workspace-review-json" rows="12" style="width:100%"></textarea><p>Edit the title, points and verification notes. Keep source IDs from the collected report. Saving clears older caption and video settings; it does not change completed videos.</p><button id="workspace-review-save" type="button">Save reviewed draft</button> <button id="workspace-review-close" type="button">Close draft review</button><p id="workspace-review-error" role="status"></p>';
    document.getElementById('workspace-ai-report').insertAdjacentElement('afterend',review);
    const edit=document.createElement('button');edit.id='workspace-review-open';edit.type='button';edit.textContent='Edit draft JSON';review.insertAdjacentElement('beforebegin',edit);
    edit.onclick=openDraftReview;review.querySelector('#workspace-review-save').onclick=saveDraftReview;
    review.querySelector('#workspace-review-close').onclick=()=>{review.hidden=true;};
    for(const button of card.querySelectorAll('button'))button.style.cssText='padding:8px 12px;margin:6px 4px 6px 0;border:1px solid var(--color-border);border-radius:5px;cursor:pointer';
    renderWorkspace([]);
  }
  function renderWorkspace(results){
    const host=document.getElementById('workspace-report');if(!host)return;
    if(!workspace){document.getElementById('workspace-state').textContent='Ready for a research brief';return;}
    let changed=false;
    for(const task of workspace.tasks){
      const result=results.find(r=>r.job_id===task.job_id&&r.device_id===task.worker);
      if(!result){
        if(['submitting','unconfirmed'].includes(task.status)&&current?.jobs.some(j=>j.id===task.job_id)){task.status='queued';changed=true;}
        continue;
      }
      if(task.status==='succeeded'||task.status==='failed')continue;
      let data;try{data=JSON.parse(result.stdout||'');}catch{}
      task.status=Number(result.exit_code)===0&&data?.kind==='research-sources'&&Array.isArray(data.sources)&&data.sources.length?'succeeded':'failed';
      task.report=task.status==='succeeded'?data:null;task.error=task.status==='failed'?String(data?.error||result.stderr||'Worker returned an invalid report').slice(0,500):null;changed=true;
    }
    if(changed)saveWorkspace();
    if(host.contains(document.activeElement)&&/^research-(notes|coverage)-/.test(document.activeElement.id)){renderAI(results);return;}
    document.getElementById('workspace-state').textContent=`${workspace.brief} — ${workspace.tasks.filter(t=>t.status==='succeeded').length}/${workspace.tasks.length} completed · ${workspace.tasks.filter(t=>t.status==='failed').length} failed · ${workspace.tasks.filter(t=>t.coverage==='answered').length}/${workspace.tasks.length} questions reviewed as answered`;
    host.innerHTML=workspace.tasks.map(t=>`<article style="border-top:1px solid var(--color-border);padding:10px 0"><strong>${esc(t.query)}</strong><p>${esc(t.worker||'unassigned')} · ${esc(t.status)} · attempt ${esc(t.attempts)}${t.error?' · '+esc(t.error):''}</p>${(t.report?.sources||[]).map(s=>`<p><strong>${esc(s.title)}</strong><br>${esc(s.excerpt)}<br>${/^https:\/\/en\.wikipedia\.org\/wiki\//.test(s.url)?`<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">Source</a>`:'Invalid source URL'}</p>`).join('')}</article>`).join('');
    renderAI(results);
    host.querySelectorAll('article').forEach((article,index)=>{
      const task=workspace.tasks[index];
      const review=document.createElement('div');
      const label=document.createElement('label');label.textContent='Question coverage';label.htmlFor='research-coverage-'+index;
      const select=document.createElement('select');select.id=label.htmlFor;
      for(const [value,text] of [['unreviewed','Unreviewed'],['unanswered','Unanswered'],['partial','Partially answered'],['answered','Answered']])select.add(new Option(text,value));
      select.value=task.coverage||'unreviewed';
      const notesLabel=document.createElement('label');notesLabel.textContent='Answer and evidence gaps';notesLabel.htmlFor='research-notes-'+index;
      const notes=document.createElement('textarea');notes.id=notesLabel.htmlFor;notes.rows=3;notes.maxLength=5000;notes.value=task.review_notes||'';
      const save=document.createElement('button');save.textContent='Save coverage review';save.type='button';save.onclick=()=>{task.coverage=select.value;task.review_notes=notes.value;saveWorkspace();save.textContent='Review saved';};
      review.append(label,select,notesLabel,notes,save);
      for(const source of task.report?.sources||[]){const metadata=document.createElement('p');metadata.textContent=`${source.title}: ${source.evidence_type||'Legacy search snippet'} · retrieved ${source.retrieved_at||'date not recorded'} · revision ${source.revision_id??'not recorded'}`;review.append(metadata);}
      for(const gap of task.report?.gaps||[]){const note=document.createElement('p');note.textContent='Evidence gap: '+gap;review.append(note);}
      article.append(review);
    });
    for(const id of ['workspace-run','workspace-retry','workspace-cancel'])document.getElementById(id).disabled=workspaceBusy;
  }
  async function dispatchWorkspace(retry){
    if(workspaceBusy)return;
    if(!retry&&workspace?.tasks.some(t=>['submitting','queued','unconfirmed'].includes(t.status)))return notify('Finish or cancel the current batch before starting another','error');
    workspaceBusy=true;
    document.getElementById('workspace-form-error').textContent='';
    try{
      await load(true);
      const spec=retry?null:JSON.parse(document.getElementById('workspace-json').value);
      if(!retry&&(!spec||typeof spec.brief!=='string'||!spec.brief.trim()||spec.brief.length>500||!Array.isArray(spec.tasks)||!spec.tasks.length||spec.tasks.length>12||spec.tasks.some(q=>typeof q!=='string'||!q.trim()||q.length>240)||!Number.isInteger(spec.workers)||spec.workers<1||spec.workers>12))throw new Error('Use a brief, 1–12 task queries (up to 240 characters), and workers from 1–12');
      const nodes=current.nodes.filter(n=>n.online&&!n.busy&&n.id!=='RenderRig').slice(0,retry?workspace?.workers:spec.workers);
      if(!nodes.length)throw new Error('No idle online phone or Linux workers');
      if(!retry&&['runtime','draft'].some(mode=>workspace?.[mode]&&['queued','submitting','unconfirmed'].includes(workspace[mode].status)))throw new Error('Finish or cancel the pending AI stage before replacing this batch');
      if(!retry)workspace={id:`research-v1-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,brief:spec.brief,workers:spec.workers,created_at:new Date().toISOString(),tasks:spec.tasks.map(query=>({query,status:'ready',attempts:0}))};
      if(!workspace)throw new Error('No batch to retry');
      saveWorkspace();
      const tasks=workspace.tasks.filter(t=>retry?['failed','ready'].includes(t.status):t.status==='ready');
      for(const [i,task] of tasks.entries()){
        if(task.attempts>=3)continue;
        task.worker=nodes[i%nodes.length].id;task.attempts++;task.job_id=`${workspace.id}-${workspace.tasks.indexOf(task)}-${task.attempts}`;task.status='submitting';task.error=null;saveWorkspace();renderWorkspace([]);
        const encoded=btoa(Array.from(new TextEncoder().encode(task.query),b=>String.fromCharCode(b)).join(''));
        const cmd=`curl -fLsS --max-time 20 'https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts/cluster-research.py' -o "$HOME/cluster-research.py" && { if command -v python3 >/dev/null 2>&1; then P=python3; else P=python; fi; "$P" "$HOME/cluster-research.py" --query "$(printf %s '${encoded}' | base64 -d)"; }`;
        try{await swarmApi('enqueue','POST',{job:{id:task.job_id,type:'shell',cmd,command:cmd},target_device_ids:[task.worker]});task.status='queued';}
        catch(error){task.status='unconfirmed';task.error='Submission outcome uncertain. Refresh and check the queue before cancelling this assignment: '+error.message;saveWorkspace();throw error;}
        saveWorkspace();
      }
      await load(true);
    }catch(error){document.getElementById('workspace-form-error').textContent=error.message;notify(error.message,'error');}finally{workspaceBusy=false;renderWorkspace(current?.results||[]);}
  }
  async function cancelWorkspace(){
    if(!workspace||workspaceBusy)return;workspaceBusy=true;
    try{for(const task of [...workspace.tasks,workspace.runtime,workspace.draft].filter(t=>t&&['queued','submitting','unconfirmed'].includes(t.status))){
      try{await swarmApi('cancel-job','POST',{job_id:task.job_id});task.status='cancelled';saveWorkspace();}catch(error){task.error=error.message;saveWorkspace();}
    }}finally{workspaceBusy=false;renderWorkspace(current?.results||[]);}
  }

  function aiCommand(args){return `curl -fLsS --max-time 20 'https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts/cluster-ai-draft.py' -o "$HOME/cluster-ai-draft.py" && python3 "$HOME/cluster-ai-draft.py" ${args}`;}
  async function submitAI(mode){
    if(workspaceBusy||!workspace)return;
    workspaceBusy=true;
    try{
      await load(true);
      const worker=document.getElementById('workspace-ai-worker').value;
      if(!['viki','Alina','Nexus','SteamDeck'].includes(worker)||!current.nodes.some(n=>n.id===worker&&n.online&&!n.busy))throw new Error('Choose an idle online Linux PC');
      const previous=workspace[mode];
      if(previous&&['queued','submitting','unconfirmed'].includes(previous.status))throw new Error('This stage is already pending; check its status before resubmitting');
      let cmd, sources=[];
      if(mode==='runtime')cmd=`curl -fLsS --max-time 20 'https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts/cluster-ai-prepare.sh' -o "$HOME/cluster-ai-prepare.sh" && sh "$HOME/cluster-ai-prepare.sh" && ${aiCommand('--status')}`;
      else{
        if(workspace.tasks.some(t=>['ready','queued','submitting','unconfirmed'].includes(t.status)))throw new Error('Finish or cancel research tasks before drafting');
        const seen=new Set();
        // One source per completed task first, then fill remaining slots.
        const reports=workspace.tasks.filter(t=>t.status==='succeeded').map(t=>t.report.sources);
        for(let offset=0;offset<3;offset++)for(const rows of reports){const s=rows[offset];if(s&&!seen.has(s.url)&&sources.length<6){seen.add(s.url);sources.push({id:`S${sources.length+1}`,title:s.title.slice(0,160),url:s.url,excerpt:s.excerpt.slice(0,300)});}}
        if(!sources.length)throw new Error('No completed sources to draft from');
        const spec={brief:workspace.brief,sources};
        let json=JSON.stringify(spec);
        while(new TextEncoder().encode(json).length>2200){
          const longest=[...sources].sort((a,b)=>b.excerpt.length-a.excerpt.length)[0];
          if(longest.excerpt.length>60)longest.excerpt=longest.excerpt.slice(0,Math.floor(longest.excerpt.length/2));
          else if(sources.length>1)sources.pop();
          else throw new Error('Brief and source URL are too large; use a shorter brief');
          json=JSON.stringify(spec);
        }
        const encoded=btoa(Array.from(new TextEncoder().encode(json),b=>String.fromCharCode(b)).join(''));
        cmd=aiCommand(`--spec-base64 '${encoded}'`);
      }
      if(cmd.length>4000)throw new Error('Command exceeds queue limit');
      const record={worker,job_id:`${workspace.id}-${mode}-${Date.now()}`,status:'submitting',sources};
      workspace[mode]=record;saveWorkspace();renderWorkspace([]);
      try{await swarmApi('enqueue','POST',{job:{id:record.job_id,type:'shell',cmd,command:cmd},target_device_ids:[worker]});record.status='queued';}
      catch(error){record.status='unconfirmed';record.error='Submission outcome uncertain: '+error.message;throw error;}
      finally{saveWorkspace();}
      await load(true);
    }catch(error){notify(error.message,'error');}finally{workspaceBusy=false;renderWorkspace(current?.results||[]);}
  }
  function renderAI(results){
    const host=document.getElementById('workspace-ai-report');if(!host)return;
    for(const mode of ['runtime','draft']){
      const record=workspace?.[mode];if(!record)continue;
      const r=results.find(r=>r.job_id===record.job_id&&r.device_id===record.worker);
      if(!r){if(['submitting','unconfirmed'].includes(record.status)&&current?.jobs.some(j=>j.id===record.job_id)){record.status='queued';saveWorkspace();}continue;}
      if(record.status==='succeeded')continue;
      let data;const raw=(r.stdout||'').trim();try{data=JSON.parse(raw);}catch{const start=raw.lastIndexOf('{"kind":');if(start>=0)try{data=JSON.parse(raw.slice(start));}catch{}}
      const valid=mode==='runtime'?data?.kind==='ai-runtime'&&data.ready:data?.kind==='ai-research-draft'&&Array.isArray(data.draft?.points);
      record.status=Number(r.exit_code)===0&&valid?'succeeded':'failed';record.output=valid?data:null;record.error=valid?null:String(data?.error||r.stderr||r.stdout||'Invalid AI response').slice(0,500);saveWorkspace();
    }
    const runtime=workspace?.runtime,draft=workspace?.draft;
    host.innerHTML=`<p>Model preparation: ${esc(runtime?.status||'not requested')}${runtime?.error?' · '+esc(runtime.error):''}</p><p>Draft: ${esc(draft?.status||'not requested')}${draft?.worker?' · '+esc(draft.worker):''}${draft?.error?' · '+esc(draft.error):''}</p>`;
    if(draft?.status==='succeeded')host.innerHTML+=`<h4>${esc(draft.output.draft.title)}</h4><p>AI draft · ${esc(draft.output.model)} · human review required. Selected source excerpts only; references are not proof that each claim is correct.</p>${draft.output.draft.points.map(p=>`<p>${esc(p.text)} <strong>[${esc(p.sources.join(', '))}]</strong></p>`).join('')}<p><strong>Needs verification:</strong> ${esc(draft.output.draft.verification)}</p>${draft.sources.map(s=>`<p>${esc(s.id)}: ${esc(s.title)} · ${esc(s.url)}</p>`).join('')}`;
    document.getElementById('workspace-episode-load').disabled=workspaceBusy||workspace?.draft?.status!=='succeeded';
    document.getElementById('workspace-publish-package').disabled=workspaceBusy||workspace?.draft?.status!=='succeeded';
    document.getElementById('workspace-review-open').disabled=workspaceBusy||draft?.status!=='succeeded';
    if(draft?.reviewed_at)host.innerHTML+=`<p>Review edits saved: ${esc(draft.reviewed_at)} · revision ${esc(draft.review_revision||1)}. Check the final video before publishing.</p>`;
    const publishingHost=document.getElementById('workspace-publish-report');
    if(workspace?.publishing?.source_job_id===draft?.job_id&&draft?.status==='succeeded'){
      if(publishingHost.dataset.jobId!==draft.job_id)try{renderPublishingPackage(researchPublishingPackage(draft));}catch{publishingHost.replaceChildren();delete publishingHost.dataset.jobId;}
    }else{publishingHost.replaceChildren();delete publishingHost.dataset.jobId;}
    for(const id of ['workspace-ai-prepare','workspace-ai-draft'])document.getElementById(id).disabled=workspaceBusy||!workspace;
  }
  function exportWorkspace(){
    if(!workspace)return notify('No batch to export','error');
    const json=JSON.stringify(workspace,null,2);
    const existing=document.getElementById('workspace-export-panel');existing?.remove();
    const panel=document.createElement('div');panel.id='workspace-export-panel';
    panel.innerHTML='<h4>Combined report JSON</h4><p>Copy this complete report if your browser blocks downloads.</p><textarea aria-label="Combined report JSON" readonly rows="10" style="width:100%"></textarea><a download="curt-swarm-research.json">Download JSON</a> <button type="button">Close report</button>';
    panel.querySelector('textarea').value=json;
    const report=document.createElement('textarea');report.readOnly=true;report.rows=14;report.setAttribute('aria-label','Research report');report.value=researchReportText(workspace);
    const heading=document.createElement('h4');heading.textContent='Research report and question coverage';panel.append(heading,report);
    const download=document.createElement('a');download.download='curt-research-report.txt';download.textContent='Download research report';const reportUrl=URL.createObjectURL(new Blob([report.value],{type:'text/plain;charset=utf-8'}));download.href=reportUrl;panel.append(download);
    const url=URL.createObjectURL(new Blob([json],{type:'application/json'}));panel.querySelector('a').href=url;
    panel.querySelector('button').onclick=()=>{URL.revokeObjectURL(url);URL.revokeObjectURL(reportUrl);panel.remove();};
    document.getElementById('cluster-workspace').append(panel);
    panel.querySelector('textarea').focus();panel.querySelector('textarea').select();
  }

  function researchReportText(record){
    const lines=[record.brief,'','Question coverage requires review; successful retrieval does not establish an answer.',''];
    for(const task of record.tasks){
      lines.push('Question: '+task.query,'Worker status: '+task.status,'Coverage: '+(task.coverage||'unreviewed'),'Answer and gaps: '+(task.review_notes||'No review recorded.'),'');
      for(const source of task.report?.sources||[])lines.push(source.title,source.url,'Evidence: '+(source.evidence_type||'Legacy search snippet'),'Retrieved: '+(source.retrieved_at||'not recorded')+' | Revision: '+(source.revision_id??'not recorded'),source.excerpt,'');
      for(const gap of task.report?.gaps||[])lines.push('Retrieval gap: '+gap);
      if(task.error)lines.push('Worker error: '+task.error);
    }
    lines.push('This report retains collected evidence separately from the short video draft. Wikipedia introductions are secondary sources; check primary documentation for technical procedures.');
    return lines.join('\n');
  }

  function reviewedDraftRecord(record,value){
    if(record?.status!=='succeeded')throw new Error('Complete an AI draft first');
    if(!value||Array.isArray(value)||typeof value!=='object')throw new Error('Draft review must be a JSON object');
    if(typeof value.verification!=='string'||value.verification.length>1000||/[\x00-\x1f]/.test(value.verification))throw new Error('Verification notes must fit 1,000 characters on one line');
    const draft={title:value.title,points:value.points,verification:value.verification};
    const next=JSON.parse(JSON.stringify({...record,output:{...record.output,draft}}));
    researchEpisodeSpec(next);
    return next;
  }
  function openDraftReview(){
    if(workspace?.draft?.status!=='succeeded')return;
    const panel=document.getElementById('workspace-review-panel');panel.dataset.jobId=workspace.draft.job_id;panel.hidden=false;
    document.getElementById('workspace-review-json').value=JSON.stringify(workspace.draft.output.draft,null,2);
    document.getElementById('workspace-review-error').textContent='';
    document.getElementById('workspace-review-json').focus();
  }
  function saveDraftReview(){
    try{
      if(workspaceBusy)throw new Error('Wait for the current workspace action');
      const panel=document.getElementById('workspace-review-panel'),record=workspace?.draft;
      if(panel.dataset.jobId!==record?.job_id)throw new Error('The draft changed. Reopen draft review before saving');
      const next=reviewedDraftRecord(record,JSON.parse(document.getElementById('workspace-review-json').value));
      next.original_draft=record.original_draft||record.output.draft;
      next.reviewed_at=new Date().toISOString();next.review_revision=(record.review_revision||0)+1;
      const input=document.getElementById('swarm-job-cmd');
      if(workspace.episode&&input.value===JSON.stringify(workspace.episode.spec))input.value='';
      workspace.draft=next;delete workspace.publishing;delete workspace.episode;saveWorkspace();
      panel.hidden=true;document.getElementById('workspace-episode-state').textContent='Draft edits saved. Rebuild captions or reload video JSON to use this revision.';
      renderAI(current?.results||[]);notify('Draft edits saved; older captions and video settings cleared.');
    }catch(error){document.getElementById('workspace-review-error').textContent=error instanceof SyntaxError?'Enter valid draft JSON.':error.message;}
  }

  function researchEpisodeSpec(record){
    const draft=record?.output?.draft;
    if(record?.status!=='succeeded'||!draft||!Array.isArray(draft.points)||draft.points.length<1||draft.points.length>3)throw new Error('Complete an AI draft first');
    if(typeof draft.title!=='string'||!draft.title.trim()||draft.title.length>75||/[\x00-\x1f]/.test(draft.title))throw new Error('Episode title must fit 75 characters on one line; revise the draft');
    const ids=new Set((record.sources||[]).map(s=>s.id));
    const scenes=[{heading:'Research notes',caption:'Source-based draft · review before publishing',narration:`This research draft is titled ${draft.title}. Here are the notes collected from the supplied sources.`,visual:'circuit'}];
    for(const [index,point] of draft.points.entries()){
      if(typeof point.text!=='string'||!point.text.trim()||point.text.length>180||/[\x00-\x1f]/.test(point.text))throw new Error('Each draft point must fit 180 characters on one line; request a shorter draft');
      if(!Array.isArray(point.sources)||!point.sources.length||point.sources.some(id=>!ids.has(id)))throw new Error('Draft contains an unknown source reference');
      const visual=/\b(torque|calibrat\w*|measure\w*)\b/i.test(point.text)?'meter':/\b(socket|wrench)\b/i.test(point.text)?'socket':/\b(gear|transmission)\b/i.test(point.text)?'gear':'circuit';
      const sentence=point.text.match(/^.*?[.!?](?:\s|$)/)?.[0].trim()||point.text;
      const caption=sentence.length<=90?sentence:sentence.slice(0,87).replace(/\s+\S*$/,'')+'…';
      scenes.push({heading:`Research point ${index+1} · ${[...new Set(point.sources)].join(', ')}`,caption,narration:point.text,visual});
    }
    scenes.push({heading:'What supports this?',caption:'Read the full articles before using these claims',narration:'These notes use short source excerpts. The source list and verification notes are saved with the combined report.',visual:'meter'},
      {heading:'Check the gaps',caption:'Short excerpts do not establish every detail',narration:'Read the verification notes in the combined report. Check the full sources before treating this draft as finished reporting.',visual:'meter'},
      {heading:'Keep the sources',caption:'Review the draft, sources and final edit together',narration:'The combined report preserves the source links and draft. Review the claims and finished video before publishing.',visual:'circuit'});
    const duration=scenes.length===5?12:10;
    const spec={title:draft.title,scenes:scenes.map(scene=>({...scene,duration}))};
    if(spec.scenes.some(scene=>['heading','caption','narration'].some(k=>scene[k].length>180)))throw new Error('Scene text exceeds renderer limits');
    if(JSON.stringify(spec).length>4000)throw new Error('Episode settings exceed the queue limit');
    return spec;
  }
  function researchPublishingPackage(record){
    const spec=researchEpisodeSpec(record),draft=record.output.draft;
    const used=new Set(draft.points.flatMap(point=>point.sources));
    const sources=(record.sources||[]).filter(source=>used.has(source.id));
    if(sources.some(source=>typeof source.title!=='string'||!/^https:\/\/en\.wikipedia\.org\/wiki\/[^\s]+$/.test(source.url)))throw new Error('Publishing sources must have valid Wikipedia links');
    const tags=[...new Set(draft.title.match(/[A-Za-z][A-Za-z0-9]{3,}/g)||[])].slice(0,3).map(word=>'#'+word);
    const hashtags=[...new Set([...tags,'#Explained','#Research'])].join(' ');
    const credits=sources.map(source=>`${source.id}: ${source.title} — ${source.url}`).join('\n');
    const disclosure='AI-assisted source research and narration. Draft: review claims before publishing.';
    const description=`${draft.points.map(point=>point.text).join('\n\n')}\n\n${disclosure}\n\nSources:\n${credits}`;
    return {title:spec.title,source_job_id:record.job_id,review_required:true,
      duration_seconds:spec.scenes.reduce((total,scene)=>total+scene.duration,0),
      platforms:{
        youtube:{title:spec.title,description:description+'\n\n'+hashtags},
        tiktok:{caption:`${spec.title}\n${draft.points[0].text}\n\n${disclosure}\n\n${hashtags}`},
        instagram:{caption:description+'\n\n'+hashtags},
        facebook:{caption:description+'\n\n'+hashtags}},
      hashtags,sources,verification:draft.verification||'',
      media_note:'Original narrated diagram video; links credit research sources. No third-party footage is included.'};
  }
  function renderPublishingPackage(pack){
    const host=document.getElementById('workspace-publish-report');
    host.replaceChildren();host.dataset.jobId=pack.source_job_id;
    const heading=document.createElement('h4');heading.textContent='Publishing package';host.append(heading);
    const note=document.createElement('p');note.textContent='Review the video and claims, then copy a caption. Topic hashtags are included. Saved with your combined report.';host.append(note);
    const names={youtube:'YouTube',tiktok:'TikTok',instagram:'Instagram',facebook:'Facebook'};
    for(const [name,value] of Object.entries(pack.platforms)){
      const label=document.createElement('label');label.textContent=names[name]||name;label.htmlFor='publish-'+name;
      const field=document.createElement('textarea');field.id=label.htmlFor;field.readOnly=true;field.rows=5;field.style.width='100%';field.value=Object.values(value).join('\n\n');
      const button=document.createElement('button');button.type='button';button.textContent='Copy '+label.textContent;button.style.cssText='padding:8px 12px;margin:6px 0;border:1px solid var(--color-border);border-radius:5px;cursor:pointer';
      button.onclick=async()=>{try{await navigator.clipboard.writeText(field.value);notify(label.textContent+' caption copied.');}catch{field.focus();field.select();notify('Select and copy the caption manually; clipboard access is unavailable.','error');}};
      host.append(label,field,button);
    }
    const label=document.createElement('label');label.textContent='Publishing package JSON';label.htmlFor='publish-json';
    const field=document.createElement('textarea');field.id='publish-json';field.readOnly=true;field.rows=8;field.style.width='100%';field.value=JSON.stringify(pack,null,2);
    host.append(label,field);
  }
  function showPublishingPackage(){
    try{
      const pack=researchPublishingPackage(workspace?.draft);
      renderPublishingPackage(pack);
      workspace.publishing=pack;saveWorkspace();notify('Publishing package ready with source credits.');
    }catch(error){notify(error.message,'error');}
  }
  function loadResearchEpisode(){
    try{
      const spec=researchEpisodeSpec(workspace?.draft);
      document.getElementById('swarm-job-type').value='episode-create';syncJobInput();
    ensureDisplayControls();
      document.getElementById('swarm-job-cmd').value=JSON.stringify(spec);
      document.getElementById('swarm-job-device').value='RenderRig';
      workspace.episode={spec,source_job_id:workspace.draft.job_id,sources:workspace.draft.sources,created_at:new Date().toISOString(),review_required:true};saveWorkspace();
      document.getElementById('workspace-episode-state').textContent=`Loaded ${spec.scenes.length} scenes · ${spec.scenes.reduce((n,s)=>n+s.duration,0)} seconds · diagram-based preview. Review the JSON, then press Start in the job form.`;
      notify('Research episode JSON loaded for RenderRig. Review it before publishing.');
    }catch(error){notify(error.message,'error');}
  }

  function mediaCommand(query, kind, offset, limit) {
    // UTF-8 encoded query remains data; no user-controlled text enters the shell syntax.
    const bytes = new TextEncoder().encode(query);
    const encoded = btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
    return `curl -fLsS --max-time 20 '${MEDIA_SCRIPT_URL}' -o "$HOME/cluster-media-discover.py" && { if command -v python3 >/dev/null 2>&1; then P=python3; else P=python; fi; "$P" "$HOME/cluster-media-discover.py" --query "$(printf %s '${encoded}' | base64 -d)" --kind '${kind}' --offset ${offset} --limit ${limit}; }`;
  }

  async function dispatchMediaDiscovery() {
    const button = document.getElementById('cluster-media-run');
    const state = document.getElementById('cluster-media-state');
    button.disabled = true;
    try {
      const spec = JSON.parse(document.getElementById('cluster-media-settings').value);
      if (!spec || Array.isArray(spec) || typeof spec.query !== 'string' || !/^.{2,100}$/.test(spec.query.trim()) ||
          !['image','video','any'].includes(spec.kind) || !Number.isInteger(spec.per_worker) || spec.per_worker < 1 || spec.per_worker > 4 ||
          !Number.isInteger(spec.workers) || spec.workers < 1 || spec.workers > 12) {
        throw new Error('Use JSON with query (2–100 characters), kind (image/video/any), per_worker (1–4), and workers (1–12).');
      }
      if (!current) await load();
      const targets = current.nodes.filter(n => n.online && n.id !== 'RenderRig' && IDS.has(n.id)).slice(0, spec.workers);
      if (!targets.length) throw new Error('No phone or Linux workers are online.');
      // Each worker receives a different search page, so workers do real parallel discovery.
      const batchId = `media-v1-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
      let queued = 0;
      for (const [i, node] of targets.entries()) {
        const job = {id:`${batchId}-${i}`, type:'shell', cmd:mediaCommand(spec.query.trim(), spec.kind, i * spec.per_worker * 6, spec.per_worker)};
        job.command = job.cmd;
        if (job.cmd.length > 4000) throw new Error('Media query is too long.');
        await swarmApi('enqueue', 'POST', {job, target_device_ids:[node.id]});
        queued++;
        state.textContent = `Queued ${queued}/${targets.length} workers`;
      }
      notify(`Media discovery queued on ${queued} workers`);
      await load(true);
    } catch (error) {
      state.textContent = error.message;
      notify(`Media discovery: ${error.message}`, 'error');
    } finally { button.disabled = false; }
  }

  function renderMediaDiscovery(results) {
    const host = document.getElementById('cluster-media-results');
    const state = document.getElementById('cluster-media-state');
    if (!host) return;
    const byHash = new Map();
    let failures = 0, completed = 0;
    for (const result of results) {
      if (!String(result.job_id || '').startsWith('media-v1-')) continue;
      completed++;
      if (Number(result.exit_code) !== 0) { failures++; continue; }
      try {
        const batch = JSON.parse(result.stdout);
        if (batch.source !== 'Wikimedia Commons' || !Array.isArray(batch.items)) continue;
        for (const item of batch.items) {
          if (item.sha1 && item.url?.startsWith('https://upload.wikimedia.org/') && item.page?.startsWith('https://commons.wikimedia.org/')) byHash.set(item.sha1, item);
        }
      } catch { failures++; }
    }
    const items = [...byHash.values()];
    if (state && completed) state.textContent = `${items.length} unique candidates · ${completed} workers finished${failures ? ` · ${failures} failed` : ''}`;
    host.innerHTML = items.length ? items.map(item => `<label style="display:flex;gap:8px;align-items:flex-start;background:var(--color-bg);padding:8px;border-radius:5px">
      <input type="checkbox" data-media-sha="${esc(item.sha1)}" ${mediaSelected.has(item.sha1) ? 'checked' : ''} aria-label="Select ${esc(item.title)}">
      <span><a href="${esc(item.page)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a> · ${esc(item.mime)} · ${esc(item.width)}×${esc(item.height)} · <strong>${esc(item.license)}</strong><br><span style="color:var(--color-muted)">${esc(item.author || 'Author on source page')}</span></span>
    </label>`).join('') : (completed ? 'No matching files. Try a broader query or change image/video.' : 'Start a search to collect media candidates.');
    host.querySelectorAll('[data-media-sha]').forEach(box => box.addEventListener('change', () => {
      const item = byHash.get(box.dataset.mediaSha);
      if (box.checked && item) mediaSelected.set(item.sha1, item);
      else mediaSelected.delete(box.dataset.mediaSha);
    }));
  }

  function exportMediaManifest() {
    if (!mediaSelected.size) return notify('Select media candidates first', 'error');
    const manifest = {schema:1, exported_at:new Date().toISOString(), review_required:true,
      source:'Wikimedia Commons', items:[...mediaSelected.values()]};
    const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], {type:'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = `cluster-media-${Date.now()}.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify(`Exported ${mediaSelected.size} media candidates with license credits`);
  }

  function loadMediaEpisodeDraft() {
    const assets = [...mediaSelected.values()];
    if (assets.length < 3 || assets.length > 5) return notify('Select 3–5 distinct images or videos first', 'error');
    if (assets.some(item => item.license?.startsWith('CC BY') && !item.author)) {
      return notify('Review author credits on the selected CC BY source pages first', 'error');
    }
    const scenes = Array.from({length:5}, (_, index) => {
      const item = assets[index % assets.length];
      return {heading:`Beat ${index + 1}`,caption:'REWRITE: your observation',
        narration:'REWRITE: original narration and insight.',
        visual:'media',duration:12,
        media:{url:new URL(item.url).origin + new URL(item.url).pathname,
          page:item.page,license:item.license,license_url:item.license_url,mime:item.mime,bytes:item.bytes,
          title:item.title,author:item.author || 'See source page'}};
    });
    const spec = {title:'REWRITE: original episode title',scenes};
    const pretty = JSON.stringify(spec, null, 2);
    const draft = pretty.length <= 4000 ? pretty : JSON.stringify(spec);
    if (draft.length > 4000) return notify('Selection makes a job over 4,000 characters; choose shorter source titles', 'error');
    const type = document.getElementById('swarm-job-type');
    type.value = 'episode-create'; syncJobInput();
    ensureDisplayControls();
    document.getElementById('swarm-job-cmd').value = draft;
    document.getElementById('swarm-job-device').value = 'RenderRig';
    notify('Episode JSON loaded. Rewrite every beat with original narration, then start the RenderRig job.');
  }

  async function copyMediaCredits() {
    if (!mediaSelected.size) return notify('Select media sources first', 'error');
    const credits = [...mediaSelected.values()].map(item =>
      `${item.title} — ${item.author || 'author on file page'} — ${item.license}${item.license_url ? ` (${item.license_url})` : ''}\n${item.page}\nEdited, cropped, narrated and captioned for this episode.`);
    try { await navigator.clipboard.writeText(credits.join('\n\n')); notify(`Copied credits for ${credits.length} source files`); }
    catch { notify('Clipboard unavailable; export the manifest for credits', 'error'); }
  }

  function validateEpisodeForBatch(spec) {
    const cmd = JSON.stringify(spec);
    if (cmd.length > 4000 || !spec || typeof spec.title !== 'string' || !spec.title.trim() ||
        /REWRITE/i.test(spec.title) || !Array.isArray(spec.scenes) || spec.scenes.length < 5 || spec.scenes.length > 8) {
      throw new Error('Each episode needs a distinct title, 5–8 scenes, and at most 4,000 JSON characters.');
    }
    const duration = spec.scenes.reduce((sum, s) => sum + Number(s?.duration || 0), 0);
    if (duration < 60 || duration > 90 || spec.scenes.some(s =>
      !['heading','caption','narration','visual'].every(k => typeof s?.[k] === 'string' && s[k].trim()) ||
      /REWRITE/i.test(`${s.heading} ${s.caption} ${s.narration}`) ||
      (s.visual === 'media' && (!s.media || !['CC0','Public domain','CC BY 3.0','CC BY 4.0'].includes(s.media.license))))) {
      throw new Error('Each scene needs reviewed media, original narration and 60–90 seconds per episode.');
    }
    return cmd;
  }

  function addEpisodeToBatch() {
    try {
      const input = document.getElementById('swarm-job-cmd').value;
      const episode = JSON.parse(input);
      validateEpisodeForBatch(episode);
      const batchInput = document.getElementById('cluster-episode-batch');
      const batch = JSON.parse(batchInput.value);
      if (!Array.isArray(batch) || batch.length >= 5) throw new Error('Batch must contain at most 5 episodes.');
      if (batch.some(item => item.title?.trim().toLowerCase() === episode.title.trim().toLowerCase())) throw new Error('Use a different title for each episode.');
      batch.push(episode); batchInput.value = JSON.stringify(batch, null, 2);
      document.getElementById('cluster-batch-state').textContent = `${batch.length}/5 episodes ready`;
    } catch (error) { notify(`Batch: ${error.message}`, 'error'); }
  }

  async function dispatchEpisodeBatch() {
    const button = document.getElementById('cluster-batch-run');
    const state = document.getElementById('cluster-batch-state');
    button.disabled = true;
    try {
      const batch = JSON.parse(document.getElementById('cluster-episode-batch').value);
      if (!Array.isArray(batch) || batch.length < 1 || batch.length > 5) throw new Error('Provide 1–5 finished episodes as a JSON array.');
      const commands = batch.map(validateEpisodeForBatch);
      if (new Set(batch.map(x => x.title.trim().toLowerCase())).size !== batch.length) throw new Error('Episode titles must differ.');
      if (new Set(batch.map(x => x.scenes.map(s => s.narration).join('|'))).size !== batch.length) throw new Error('Episode narration must differ.');
      if (!current) await load();
      const rig = current.nodes.find(n => n.id === 'RenderRig');
      if (!rig?.online) throw new Error('RenderRig is offline.');
      if (batch.some(x => x.scenes.some(s => s.visual === 'media')) && !versionAtLeast(rig.agent_version, MEDIA_EPISODE_WINDOWS_AGENT)) {
        throw new Error(`RenderRig needs agent ${MEDIA_EPISODE_WINDOWS_AGENT} for sourced media.`);
      }
      for (const [index, cmd] of commands.entries()) {
        await enqueueSwarm('episode-create', cmd, ['RenderRig']);
        state.textContent = `Queued ${index + 1}/${commands.length} episodes`;
      }
      notify(`Queued ${commands.length} original episodes on RenderRig`);
      await load(true);
    } catch (error) { state.textContent = error.message; notify(`Episode batch: ${error.message}`, 'error'); }
    finally { button.disabled = false; }
  }

  function updateTargets(nodes) {
    const select = document.getElementById('swarm-job-device');
    if (!select || select.tagName !== 'SELECT') return;
    const previous = select.value || '__pcs__';
    select.innerHTML = `
      <option value="RenderRig">RenderRig (RTX, hybrid Salad)</option>
      <option value="__pcs__">All online PCs</option>
      <option value="__all__">All online workers</option>
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
    renderMediaDiscovery(d.results);
    renderWebsiteAudit(d.results);
    renderWorkspace(d.results);
    renderFleetHealth(d.results);
    renderChangeMonitor(d.results);
    renderSiteTest(d.results);
    renderBrowserOpen(d.results);
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
    note += ' · mining disabled by policy';
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
        const color = !n.online ? 'var(--color-red)' : n.busy ? 'var(--color-yellow)' : 'var(--color-green)';
        const label = !n.online ? 'OFFLINE' : n.busy ? 'BUSY' : 'ONLINE';
        const active = (n.active_jobs || []).map(esc).join(', ');
        const ctl = !n.online ? 'No worker heartbeat; check power, Wi-Fi and SSH'
          : PHONE_IDS.has(n.id) ? 'Android / Termux'
          : versionAtLeast(n.agent_version, REQUIRED_AGENT) ? 'worker ready' : 'agent update needed';
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
        if (item?.type === 'episode-create' && Number(item.exit_code) === 0 && item.job_id) {
          const preview = document.createElement('button');
          preview.type = 'button';
          preview.textContent = 'Preview Episode';
          preview.addEventListener('click', () => openEpisode(item.job_id));
          actions.appendChild(preview);
          let delivered;
          try { delivered = JSON.parse(item.stdout || '{}'); } catch { delivered = {}; }
          if (Array.isArray(delivered.sources) && delivered.sources.length) {
            const credits = document.createElement('button');
            credits.type = 'button';
            credits.textContent = 'Copy episode credits';
            credits.addEventListener('click', async () => {
              const text = delivered.sources.map(s =>
                `${s.title} — ${s.author} — ${s.license}${s.license_url ? ` (${s.license_url})` : ''}\n${s.page}\nEdited, cropped, narrated and captioned for this episode.`).join('\n\n');
              try { await navigator.clipboard.writeText(text); notify('Source credits copied for the video description'); }
              catch { notify('Clipboard unavailable; use the exported source manifest', 'error'); }
            });
            actions.appendChild(credits);
          }
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

  async function episodeBlob(jobId, variant) {
    const base = `/api/episode-media?id=${encodeURIComponent(jobId)}&variant=${variant}`;
    const headers = { Authorization:`Bearer ${token()}` };
    const metadata = await fetch(`${base}&manifest=1`, { headers, cache:'no-store' });
    if (!metadata.ok) throw new Error((await metadata.json().catch(() => ({}))).error || 'Episode unavailable');
    const manifest = await metadata.json();
    if (!Number.isInteger(manifest.parts) || manifest.parts < 1 || manifest.parts > 16) throw new Error('Invalid media manifest');
    const parts = [];
    for (let part = 0; part < manifest.parts; part++) {
      const response = await fetch(`${base}&part=${part}`, { headers, cache:'no-store' });
      if (!response.ok) throw new Error(`Missing episode part ${part}`);
      parts.push(await response.arrayBuffer());
    }
    const blob = new Blob(parts, { type:'video/mp4' });
    if (blob.size !== manifest.bytes) throw new Error('Episode file size does not match its manifest');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())))
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== manifest.sha256) throw new Error('Episode file integrity check failed');
    return blob;
  }

  async function downloadEpisodeFile(jobId,variant) {
    const response=await fetch(`/api/episode-media?id=${encodeURIComponent(jobId)}&variant=${variant}&download-ticket=1`,{method:'POST',headers:{Authorization:`Bearer ${token()}`},cache:'no-store'});
    const data=await response.json();
    if(!response.ok||!data.ok)throw new Error(data.error||'Download could not be prepared');
    const a=document.createElement('a');a.href=data.path;a.download=`${jobId}-${variant}.mp4`;a.referrerPolicy='no-referrer';document.body.append(a);a.click();a.remove();
  }

  async function openEpisode(jobId) {
    try {
      notify('Loading episode preview…');
      const shortUrl = URL.createObjectURL(await episodeBlob(jobId, 'short'));
      let masterUrl = null;
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:#000d;display:flex;align-items:center;justify-content:center;padding:16px';
      const panel = document.createElement('div');
      panel.style.cssText = 'background:var(--color-panel);color:var(--color-text);padding:16px;border-radius:10px;width:min(100%,440px);max-height:100%;overflow:auto';
      const title = document.createElement('h3');
      title.textContent = 'Episode · short cut';
      const video = document.createElement('video');
      video.src = shortUrl;
      video.controls = true;
      video.playsInline = true;
      video.style.cssText = 'display:block;width:100%;max-height:65vh;background:#000';
      const shortDownload = document.createElement('a');
      shortDownload.href = '#';
      shortDownload.addEventListener('click',async event=>{event.preventDefault();try{await downloadEpisodeFile(jobId,'short');}catch(error){notify(error.message,'error');}});
      shortDownload.download = `${jobId}-short.mp4`;
      shortDownload.textContent = 'Download short';
      shortDownload.style.cssText = 'display:inline-block;margin:12px 12px 0 0;color:var(--color-brand)';
      const master = document.createElement('button');
      master.type = 'button';
      master.textContent = 'Load full episode';
      master.addEventListener('click', async () => {
        master.disabled = true;
        master.textContent = 'Loading full episode…';
        try {
          masterUrl = URL.createObjectURL(await episodeBlob(jobId, 'master'));
          video.pause();
          video.src = masterUrl;
          title.textContent = 'Episode · full video';
          const download = document.createElement('a');
          download.href = '#';
          download.addEventListener('click',async event=>{event.preventDefault();try{await downloadEpisodeFile(jobId,'master');}catch(error){notify(error.message,'error');}});
          download.download = `${jobId}-master.mp4`;
          download.textContent = 'Download full episode';
          download.style.cssText = shortDownload.style.cssText;
          master.replaceWith(download);
        } catch (error) {
          master.disabled = false;
          master.textContent = 'Retry full episode';
          notify(error.message, 'error');
        }
      });
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = 'Close';
      const dismiss = () => {
        video.pause(); overlay.remove(); URL.revokeObjectURL(shortUrl);
        if (masterUrl) URL.revokeObjectURL(masterUrl);
        document.removeEventListener('keydown', onKey);
      };
      const onKey = (event) => { if (event.key === 'Escape') dismiss(); };
      close.addEventListener('click', dismiss);
      overlay.addEventListener('click', (event) => { if (event.target === overlay) dismiss(); });
      document.addEventListener('keydown', onKey);
      panel.append(title, video, shortDownload, master, close);
      overlay.append(panel);
      document.body.append(overlay);
    } catch (error) { notify(`Episode preview failed: ${error.message}`, 'error'); }
  }

  function markConnectionStale(message) {
    setState(message, 'var(--color-yellow)');
    const grid = document.getElementById('swarm-nodes');
    if (grid) {
      grid.dataset.connection = 'stale';
      grid.style.opacity = '0.65';
    }
    const count = document.getElementById('swarm-nodes-online');
    if (count) count.textContent = 'Unverified';
  }

  function load(force=false) {
    if (!token()) return Promise.resolve(null);
    if (pendingLoad) return pendingLoad;
    if (livePaused && !force) return Promise.resolve(current);
    if (document.hidden && !force) return Promise.resolve(current);
    requestBusy = true;
    pendingLoad = performLoad().finally(() => {
      requestBusy = false;
      pendingLoad = null;
    });
    return pendingLoad;
  }

  async function performLoad() {
    try {
      if (!current) setState(`Loading live ${FLEET.length}-node cluster state…`);
      const data = await swarmApi('queue-status');
      if (!Array.isArray(data?.nodes)) throw new Error('Worker status response is incomplete');
      render(data);
      lastSuccessfulLoad = Date.now();
      const grid = document.getElementById('swarm-nodes');
      if (grid) { grid.dataset.connection = 'live'; grid.style.opacity = ''; }
      void refreshPhoneRecovery();
      return current;
    } catch (error) {
      markConnectionStale(`Connection unavailable: ${error.message}. ${lastSuccessfulLoad ? 'Showing the last successful view; worker availability is unverified.' : 'Worker availability could not be verified.'} Retrying automatically.`);
      console.error('Swarm load failed', error);
      return null;
    }
  }

  function start() {
    if (!token()) return;
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
    const data = await swarmApi('enqueue', 'POST', { job, target_device_ids:targets });
    return { ...data, targets };
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
      if (!await load(true)) throw new Error('Cannot verify current workers. Refresh the connection before starting work.');
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
        if (type === 'episode-create' && !versionAtLeast(current?.nodes?.find((n) => n.id === 'RenderRig')?.agent_version, EPISODE_WINDOWS_AGENT)) {
          throw new Error(`Update RenderRig to ${EPISODE_WINDOWS_AGENT} to create episodes`);
        }
        if (GPU_SETTINGS_TYPES.has(type)) {
          let settings;
          try { settings = JSON.parse(cmd); } catch { throw new Error('Job settings must be JSON from the dashboard form.'); }
          if (!settings || Array.isArray(settings) || typeof settings !== 'object') {
            throw new Error('Job settings must be a JSON object from the dashboard form.');
          }
          if (type === 'reel-create' && !['input','hook','tip','cta'].every((key) => typeof settings[key] === 'string' && settings[key].trim())) {
            throw new Error('Reel settings require input, hook, tip, and cta text.');
          }
          if (type === 'episode-create') {
            if (cmd.length > 4000) throw new Error('Episode JSON must be 4,000 characters or fewer.');
            if (typeof settings.title !== 'string' || !Array.isArray(settings.scenes) || settings.scenes.length < 5 || settings.scenes.length > 8) {
              throw new Error('Episode settings require a title and 5–8 scenes.');
            }
            const total = settings.scenes.reduce((sum, scene) => sum + Number(scene?.duration || 0), 0);
            const hasMedia = settings.scenes.some(scene => scene?.visual === 'media');
            if (hasMedia && !versionAtLeast(current?.nodes?.find(n => n.id === 'RenderRig')?.agent_version, MEDIA_EPISODE_WINDOWS_AGENT)) {
              throw new Error(`Update RenderRig to ${MEDIA_EPISODE_WINDOWS_AGENT} for sourced-media episodes`);
            }
            if (hasMedia && settings.scenes.some(scene =>
              !scene.media || !['CC0','Public domain','CC BY 3.0','CC BY 4.0'].includes(scene.media.license) ||
              /REWRITE/i.test(`${settings.title} ${scene.heading} ${scene.caption} ${scene.narration}`))) {
              throw new Error('Review selected source licenses and replace every REWRITE placeholder with original copy.');
            }
            if (total < 60 || total > 90 || settings.scenes.some((scene) =>
              !['heading','caption','narration','visual'].every((key) => typeof scene?.[key] === 'string' && scene[key].trim()))) {
              throw new Error('Episode scenes need heading, caption, narration, visual, and 60–90 seconds total.');
            }
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
    if(jobSubmitting)return null;
    const type=document.getElementById('swarm-job-type')?.value||'transcribe';
    const cmd=document.getElementById('swarm-job-cmd')?.value?.trim()||'';
    const target=document.getElementById('swarm-job-device')?.value||'__pcs__';
    const button=document.getElementById('swarm-job-submit');
    const feedback=document.getElementById('swarm-job-feedback');
    const status=document.getElementById('swarm-job-status');
    const queue=document.getElementById('swarm-job-show-queue');
    jobSubmitting=true;
    if(button){button.disabled=true;button.textContent='Submitting…';}
    if(feedback){feedback.hidden=false;feedback.dataset.state='pending';}
    if(status)status.textContent='Submitting '+type+'…';
    if(queue)queue.hidden=true;
    try{
      const data=await runAction(type,target,cmd);
      if(feedback)feedback.dataset.state='success';
      const destination=data?.targets?.length?data.targets.join(', '):target==='__all__'?'matching online workers':target==='__pcs__'?'matching online PCs':target;
      if(status)status.textContent=`Submitted ${type} to ${destination}. Track completion in Queue & results.`;
      if(queue)queue.hidden=false;
      return data;
    }catch(error){
      if(feedback)feedback.dataset.state='error';
      if(status)status.textContent=String(error.message||'Submission failed. Check the queue before retrying.');
      if(queue)queue.hidden=false;
      return null;
    }finally{
      jobSubmitting=false;
      if(button){button.disabled=false;button.textContent='Start';}
    }
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
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && token()) {
      if (lastSuccessfulLoad && Date.now() - lastSuccessfulLoad > 30000) markConnectionStale('Checking connections after returning to the dashboard…');
      load();
    }
  });
  setInterval(() => {
    if (!token()) return;
    ensureUi();
    if (lastSuccessfulLoad && Date.now() - lastSuccessfulLoad > 30000 && document.getElementById('swarm-nodes')?.dataset.connection !== 'stale') {
      markConnectionStale(livePaused ? 'Live updates paused. Worker availability is unverified; resume updates to reconnect.' : 'Connection update is overdue. Worker availability is unverified; retrying automatically.');
    }
    if (!started && token()) start();
  }, 1000);
})();
