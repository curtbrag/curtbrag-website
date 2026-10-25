/* On-demand display wake through the eight existing phone worker connections. */
(() => {
  const PHONES = new Set(['phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254']);
  const STORAGE = 'curt-phone-wake-v2', LIMIT = 180000;
  const RUNNER_BASE64 = 'IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiJSdW4gdGhlIGFwcHJvdmVkIHBob25lIHdvcmtlcidzIHJldmlld2VkLCBhbHJlYWR5LWluc3RhbGxlZCBkaXNwbGF5IGhlbHBlci4gTm8gaW5zdGFsbGVyLiIiIgppbXBvcnQgaGFzaGxpYgppbXBvcnQganNvbgppbXBvcnQgb3MKaW1wb3J0IHBhdGhsaWIKaW1wb3J0IHN0YXQKaW1wb3J0IHN1YnByb2Nlc3MKaW1wb3J0IHN5cwoKSEVMUEVSID0gcGF0aGxpYi5QYXRoKCcvZGF0YS9kYXRhL2NvbS50ZXJtdXgvZmlsZXMvaG9tZS9jbHVzdGVyL2NvbnRyb2wvZGlzcGxheS13YWtlLTIwMjYxMDIyL2N1cnQtZGlzcGxheS0zZjM4N2YyNWY2ZTguZGV4JykKU0hBMjU2ID0gJzNmMzg3ZjI1ZjZlODk1ZTI5NmFhYTQ4MjA2YjViZDE0N2NmNmM1MWRkZmUxNGU0Y2ZhODAxNGMxYjdhMGQzYWUnCgoKZGVmIHdha2UoKToKICAgIGlmIGxlbihzeXMuYXJndikgIT0gMSBvciBvcy5nZXR1aWQoKSA8IDEwMDAwOgogICAgICAgIHJhaXNlIFZhbHVlRXJyb3IoJ1J1biB0aHJvdWdoIHRoZSBleGlzdGluZyBUZXJtdXggd29ya2VyIG9ubHkuJykKICAgIGluZm8gPSBIRUxQRVIubHN0YXQoKQogICAgaWYgbm90IHN0YXQuU19JU1JFRyhpbmZvLnN0X21vZGUpIG9yIGluZm8uc3RfdWlkICE9IG9zLmdldHVpZCgpIG9yIGluZm8uc3RfbW9kZSAmIDBvMDc3OgogICAgICAgIHJhaXNlIFZhbHVlRXJyb3IoJ1RoZSBwcml2YXRlIGRpc3BsYXkgaGVscGVyIGhhcyB1bmV4cGVjdGVkIG93bmVyc2hpcCBvciBhY2Nlc3MuJykKICAgIGlmIGluZm8uc3Rfc2l6ZSAhPSA5ODg0IG9yIGhhc2hsaWIuc2hhMjU2KEhFTFBFUi5yZWFkX2J5dGVzKCkpLmhleGRpZ2VzdCgpICE9IFNIQTI1NjoKICAgICAgICByYWlzZSBWYWx1ZUVycm9yKCdUaGUgaW5zdGFsbGVkIGRpc3BsYXkgaGVscGVyIGRvZXMgbm90IG1hdGNoIHRoZSByZXZpZXdlZCB2ZXJzaW9uLicpCiAgICByZXN1bHQgPSBzdWJwcm9jZXNzLnJ1bigKICAgICAgICBbJy9zeXN0ZW0vYmluL2FwcF9wcm9jZXNzJywgJy8nLCAnQ3VydFBob25lRGlzcGxheScsICd3YWtlJ10sCiAgICAgICAgZW52PXsqKm9zLmVudmlyb24sICdDTEFTU1BBVEgnOiBzdHIoSEVMUEVSKX0sIHN0ZGluPXN1YnByb2Nlc3MuREVWTlVMTCwKICAgICAgICBjYXB0dXJlX291dHB1dD1UcnVlLCB0ZXh0PVRydWUsIHRpbWVvdXQ9MTIsIGNoZWNrPUZhbHNlLAogICAgKQogICAgdmFsdWUgPSBqc29uLmxvYWRzKHJlc3VsdC5zdGRvdXQpCiAgICBpZiBub3QgaXNpbnN0YW5jZSh2YWx1ZSwgZGljdCkgb3IgdmFsdWUuZ2V0KCdraW5kJykgIT0gJ3Bob25lLWRpc3BsYXktd2FrZSc6CiAgICAgICAgcmFpc2UgVmFsdWVFcnJvcignVGhlIHBob25lIHJldHVybmVkIGFuIHVuZXhwZWN0ZWQgZGlzcGxheSByZXBvcnQuJykKICAgIHByaW50KGpzb24uZHVtcHModmFsdWUsIHNlcGFyYXRvcnM9KCcsJywgJzonKSkpCiAgICByZXR1cm4gcmVzdWx0LnJldHVybmNvZGUKCgppZiBfX25hbWVfXyA9PSAnX19tYWluX18nOgogICAgdHJ5OgogICAgICAgIHN5cy5leGl0KHdha2UoKSkKICAgIGV4Y2VwdCAoT1NFcnJvciwgVmFsdWVFcnJvciwgc3VicHJvY2Vzcy5UaW1lb3V0RXhwaXJlZCk6CiAgICAgICAgcHJpbnQoanNvbi5kdW1wcyh7J2tpbmQnOiAncGhvbmUtZGlzcGxheS13YWtlJywgJ2Vycm9yJzogJ0Rpc3BsYXkgd2FrZSBjb3VsZCBub3QgYmUgdmVyaWZpZWQuIENoZWNrIHRoZSBpbnN0YWxsZWQgZGlzcGxheSBoZWxwZXIgYW5kIGV4aXN0aW5nIGNvbm5lY3Rpb24uJ30pKQogICAgICAgIHN5cy5leGl0KDIpCg==';
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
    details.textContent=report.phones.map(p=>p.unit+' - '+labels[p.state]).join('\n');
  }
  function validResult(result) {
    let value; try { value = JSON.parse(result.stdout); } catch { return null; }
    const valid = result.exit_code === 0 && value?.kind === 'phone-display-wake' && !value.error &&
      Number.isInteger(value.uid) && value.uid >= 10000 && value.context_uid === value.uid &&
      value.context_package === 'com.termux' && value.op_package === 'com.termux' &&
      value.package_attribution_verified === true && value.existing_wake_lock_permission === true &&
      value.permissions_changed === false && value.lockscreen_unlocked === false &&
      value.wake_request_accepted === true && value.maximum_lock_ms === 3000 && value.wake_lock_released === true &&
      typeof value.interactive_before_request === 'boolean' && value.interactive_after === true && value.display_state === 2 &&
      value.off_to_on_verified === !value.interactive_before_request;
    return valid ? value : null;
  }
  function collect(data) {
    if (!pending()) return;
    for (const phone of report.phones) {
      if (!['queued','unconfirmed'].includes(phone.state)) continue;
      const matches=(Array.isArray(data?.results)?data.results:[]).filter(r=>r.job_id===report.job_id && r.device_id===phone.unit);
      if (matches.length) {
        const value=matches.length===1 ? validResult(matches[0]) : null;
        phone.state=value ? value.off_to_on_verified ? 'woke' : 'already-on' : 'failed';
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
      report={target,job_id:'phone-display-wake-'+crypto.randomUUID(),created_at:new Date().toISOString(),phones};
      message='';save();render();
      const targets=phones.filter(p=>p.state==='queued').map(p=>p.unit);
      if (targets.length) {
        const command="python -c 'import base64;exec(base64.b64decode(\""+RUNNER_BASE64+"\"))'";
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
    card.innerHTML='<h3>Remote screen wake</h3><p>Wake all eight phones or one selected phone remotely. Each result checks the display state. This does not unlock phones or change their apps.</p><label for="phone-wake-target">Phones to wake</label> <select id="phone-wake-target"><option value="all">All eight phones</option>'+[...PHONES].map(unit=>'<option value="'+unit+'">'+unit+'</option>').join('')+'</select><div class="cluster-action-row"><button id="phone-wake-run" type="button" class="cluster-primary-action">Wake selected phones</button></div><p id="phone-wake-state" role="status" aria-live="polite"></p><pre id="phone-wake-report" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>';
    fleet.prepend(card);card.querySelector('#phone-wake-run').onclick=wake;
    if (report) card.querySelector('#phone-wake-target').value=report.target;
    render();if (pending()) { poll=setInterval(refresh,5000);void refresh(); }
  }
  mount();
  const mounting=setInterval(()=>{mount();if(document.getElementById('cluster-phone-wake'))clearInterval(mounting);},1000);
})();
