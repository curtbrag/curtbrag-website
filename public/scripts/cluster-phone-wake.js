/* On-demand display wake through the eight existing phone worker connections. */
(() => {
  const PHONES = new Set(['phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254']);
  const STORAGE = 'curt-phone-wake-v2', LIMIT = 180000;
  const RUNNER_BASE64 = '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';
  const STATES = ['queued','unconfirmed','already-on','woke','failed','expired','offline','busy','unknown'];
  let report = null, busy = false, poll = null, message = '';
  function validSaved(value) {
    const selected = value?.target === 'all' ? [...PHONES] : PHONES.has(value?.target) ? [value.target] : [];
    return selected.length && Array.isArray(value.phones) && value.phones.length === selected.length &&
      new Set(value.phones.map(p=>p?.unit)).size === selected.length &&
      value.phones.every(p=>selected.includes(p?.unit) && STATES.includes(p?.state)) &&
      typeof value.job_id === 'string' && /^phone-display-wake-[A-Za-z0-9-]{1,80}$/.test(value.job_id) &&
      Number.isFinite(Date.parse(value.created_at)) && Date.parse(value.created_at) <= Date.now()+5000;
  }
  try { report = JSON.parse(localStorage.getItem(STORAGE)); } catch {}
  if (!validSaved(report)) report = null;
  // Preserve an in-flight request from the previous one-phone control.
  if (!report) {
    try {
      const old = JSON.parse(localStorage.getItem('curt-phone253-wake-v1'));
      if (old?.unit === 'phone253' && ['queued','unconfirmed'].includes(old.state)) {
        const migrated = {target:'phone253',job_id:old.job_id,created_at:old.created_at,phones:[{unit:'phone253',state:old.state}]};
        if (validSaved(migrated)) report=migrated;
      }
    } catch {}
  }
  const pending = () => report?.phones.some(p=>['queued','unconfirmed'].includes(p.state));
  function save() { try { localStorage.setItem(STORAGE,JSON.stringify(report)); } catch {} }
  async function api(action,body) {
    const password = sessionStorage.getItem('cp_password');
    if (!password) throw Error('Sign in to use remote wake.');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(),12000);
    try {
      const response = await fetch('/api/cluster?action='+action,{
        method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',
        headers:{Authorization:'Bearer '+password,'Content-Type':'application/json'},
        body:body?JSON.stringify(body):undefined,signal:controller.signal,
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw Error(data.error || 'Phone connection unavailable.');
      return data;
    } finally { clearTimeout(timer); }
  }
  function render() {
    const button=document.getElementById('phone-wake-run'), output=document.getElementById('phone-wake-state');
    const details=document.getElementById('phone-wake-report'), select=document.getElementById('phone-wake-target');
    if (!button || !output || !details || !select) return;
    button.disabled=busy || !!pending(); select.disabled=button.disabled;
    if (message) { output.textContent=message; return; }
    if (!report) { output.textContent='Ready. No wake requested.';details.textContent='';return; }
    const count = state => report.phones.filter(p=>p.state===state).length;
    const completed=count('already-on')+count('woke')+count('failed'), skipped=count('offline')+count('busy')+count('unknown');
    output.textContent=completed+'/'+(report.phones.length-skipped)+' wake results; '+count('woke')+' off-to-on verified; '+count('already-on')+' already on; '+count('failed')+' failed; '+skipped+' skipped. Checked '+new Date(report.created_at).toLocaleString()+'.';
    const labels={queued:'Waiting for Android display state',unconfirmed:'Submission unconfirmed; checking this request before retrying',
      'already-on':'Android reports display already on; wake completed and lock released',woke:'Android confirmed screen off to on; wake lock released',
      failed:'Wake or display verification failed',expired:'No verified result; review Queue & results before retrying',
      offline:'Worker offline; skipped',busy:'Worker busy; skipped',unknown:'Connection or availability unverified; skipped'};
    details.textContent=report.phones.map(p=>p.unit+' - '+(p.hold_until_ms ?
      (Date.now()<p.hold_until_ms ? 'Screen-on hold verified; scheduled until '+new Date(p.hold_until_ms).toLocaleTimeString()+'. Phone may remain locked.' : 'Ten-minute screen hold ended; normal screen sleep allowed.') : labels[p.state])).join('\n');
  }
  function validResult(result) {
    let value; try { value = JSON.parse(result.stdout); } catch { return null; }
    const valid = result.exit_code === 0 && value?.kind === 'phone-display-wake' && !value.error &&
      Number.isInteger(value.uid) && value.uid >= 10000 && value.context_uid === value.uid &&
      value.context_package === 'com.termux' && value.op_package === 'com.termux' &&
      value.package_attribution_verified === true && value.existing_wake_lock_permission === true &&
      value.permissions_changed === false && value.lockscreen_unlocked === false &&
      value.wake_request_accepted === true &&
      typeof value.interactive_before_request === 'boolean' && value.interactive_after === true && value.display_state === 2 &&
      value.off_to_on_verified === !value.interactive_before_request;
    const held = value?.maximum_lock_ms === 600000 && value.hold_active === true && value.wake_lock_released === false &&
      Number.isInteger(value.holder_pid) && value.holder_pid > 1 && value.sustained_check_ms >= 4000 &&
      Number.isFinite(value.hold_started_ms) && value.hold_started_ms > 0 &&
      value.hold_started_ms <= Date.now()+60000 &&
      value.hold_until_ms === value.hold_started_ms+600000 &&
      value.hold_verified_at_ms >= value.hold_started_ms+4000 && value.hold_verified_at_ms < value.hold_until_ms;
    const legacy = !report?.hold_required && value?.maximum_lock_ms === 3000 && value.wake_lock_released === true;
    return valid && (held || legacy) ? value : null;
  }
  function collect(data) {
    if (!pending()) return;
    for (const phone of report.phones) {
      if (!['queued','unconfirmed'].includes(phone.state)) continue;
      const matches=(Array.isArray(data?.results)?data.results:[]).filter(r=>r.job_id===report.job_id && r.device_id===phone.unit);
      if (matches.length) {
        const value=matches.length===1 ? validResult(matches[0]) : null;
        phone.state=value ? value.off_to_on_verified ? 'woke' : 'already-on' : 'failed';
        if(value?.hold_active) phone.hold_until_ms=value.hold_until_ms;
      } else if (Date.now()-Date.parse(report.created_at)>LIMIT) phone.state='expired';
    }
    save();render();
    if (!pending() && poll) { clearInterval(poll);poll=null; }
  }
  async function refresh() {
    if (busy || document.hidden || !pending()) return;
    try { collect(await api('queue-status')); }
    catch { if (Date.now()-Date.parse(report.created_at)>LIMIT) collect({}); }
  }
  async function wake() {
    if (busy || pending()) return;
    busy=true;message='Checking selected phones...';render();
    try {
      const target=document.getElementById('phone-wake-target').value;
      const selected=target==='all'?[...PHONES]:PHONES.has(target)?[target]:[];
      if (!selected.length) throw Error('Choose all eight phones or one listed phone.');
      const data=await api('queue-status');
      if (!Array.isArray(data.nodes)) throw Error('Phone availability could not be verified.');
      const phones=selected.map(unit=>{
        const nodes=data.nodes.filter(n=>n.id===unit),node=nodes[0];
        const state=nodes.length!==1?'unknown':node.online===false?'offline':node.online!==true?'unknown':node.busy===true?'busy':node.busy!==false?'unknown':'queued';
        return {unit,state};
      });
      report={target,job_id:'phone-display-wake-'+crypto.randomUUID(),created_at:new Date().toISOString(),phones,hold_required:true};
      message='';save();render();
      const targets=phones.filter(p=>p.state==='queued').map(p=>p.unit);
      if (targets.length) {
        const command="python -c 'import base64,zlib;exec(zlib.decompress(base64.b64decode(\""+RUNNER_BASE64+"\")))'";
        try { await api('enqueue',{job:{id:report.job_id,type:'shell',cmd:command,command},target_device_ids:targets}); }
        catch { for (const p of phones) if (p.state==='queued') p.state='unconfirmed'; }
        save();if (!poll) poll=setInterval(refresh,5000);
      }
    } catch (error) { message=error.message || 'Remote wake unavailable.'; }
    finally { busy=false;render(); }
  }
  function mount() {
    const fleet=document.getElementById('cluster-view-fleet');
    if (!fleet || document.getElementById('cluster-phone-wake')) return;
    const card=document.createElement('section');card.id='cluster-phone-wake';card.className='cluster-control-card';
    card.innerHTML='<h3>Remote screen wake</h3><p>Wake selected phones and keep their screens on for ten minutes. The hold ends automatically; pressing the power button can end it sooner. Locked phones remain on their lock screen.</p><label for="phone-wake-target">Phones to wake</label> <select id="phone-wake-target"><option value="all">All eight phones</option>'+[...PHONES].map(unit=>'<option value="'+unit+'">'+unit+'</option>').join('')+'</select><div class="cluster-action-row"><button id="phone-wake-run" type="button" class="cluster-primary-action">Wake for 10 minutes</button></div><p id="phone-wake-state" role="status" aria-live="polite"></p><pre id="phone-wake-report" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>';
    fleet.prepend(card);card.querySelector('#phone-wake-run').onclick=wake;
    if (report) card.querySelector('#phone-wake-target').value=report.target;
    render();if (pending()) { poll=setInterval(refresh,5000);void refresh(); }
  }
  mount();
  setInterval(render,1000);
  const mounting=setInterval(()=>{mount();if(document.getElementById('cluster-phone-wake'))clearInterval(mounting);},1000);
})();
