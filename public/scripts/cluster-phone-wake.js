/* On-demand display wake through the eight existing phone worker connections. */
(() => {
  const PHONES = new Set(['phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254']);
  const STORAGE = 'curt-phone-wake-v2', LIMIT = 180000;
  const RUNNER_BASE64 = 'IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiJLZWVwIHRoZSBzZWxlY3RlZCBwaG9uZSBkaXNwbGF5IG9uIGZvciB0ZW4gbWludXRlcywgd2l0aG91dCB1bmxvY2tpbmcgaXQuIiIiCmltcG9ydCBmY250bAppbXBvcnQgaGFzaGxpYgppbXBvcnQganNvbgppbXBvcnQgb3MKaW1wb3J0IHBhdGhsaWIKaW1wb3J0IHN0YXQKaW1wb3J0IHN1YnByb2Nlc3MKaW1wb3J0IHN5cwppbXBvcnQgdGltZQoKRk9MREVSID0gcGF0aGxpYi5QYXRoKCcvZGF0YS9kYXRhL2NvbS50ZXJtdXgvZmlsZXMvaG9tZS9jbHVzdGVyL2NvbnRyb2wvZGlzcGxheS13YWtlLTIwMjYxMDIyJykKSEVMUEVSID0gRk9MREVSIC8gJ2N1cnQtZGlzcGxheS0wYjEyNGRmYmNjNWMuZGV4JwpTSEEyNTYgPSAnMGIxMjRkZmJjYzVjMzA4ZGZkMzZjNDgyNDhhYTA5YjE2ODYzYmJlZmU3MTRkN2JlZmFiNTAwYTAzNTFmNmIwYycKSE9MRF9NUyA9IDYwMDAwMAoKCmRlZiBwcml2YXRlX2ZpbGUocGF0aCk6CiAgICBmZCA9IG9zLm9wZW4ocGF0aCwgb3MuT19SRFdSIHwgb3MuT19DUkVBVCB8IG9zLk9fTk9GT0xMT1csIDBvNjAwKQogICAgaW5mbyA9IG9zLmZzdGF0KGZkKQogICAgaWYgbm90IHN0YXQuU19JU1JFRyhpbmZvLnN0X21vZGUpIG9yIGluZm8uc3RfdWlkICE9IG9zLmdldHVpZCgpIG9yIGluZm8uc3RfbW9kZSAmIDBvMDc3OgogICAgICAgIG9zLmNsb3NlKGZkKQogICAgICAgIHJhaXNlIFZhbHVlRXJyb3IoJ1VuZXhwZWN0ZWQgZGlzcGxheSBzdGF0ZSBmaWxlIG93bmVyc2hpcCBvciBhY2Nlc3MuJykKICAgIHJldHVybiBmZAoKCmRlZiByZWFkX3JlY2VpcHQoZmQpOgogICAgb3MubHNlZWsoZmQsIDAsIG9zLlNFRUtfU0VUKQogICAgdHJ5OgogICAgICAgIHJldHVybiBqc29uLmxvYWRzKG9zLnJlYWQoZmQsIDgxOTIpLnNwbGl0KGInXG4nLCAxKVswXSkKICAgIGV4Y2VwdCAoVmFsdWVFcnJvciwgSW5kZXhFcnJvcik6CiAgICAgICAgcmV0dXJuIHt9CgoKZGVmIGhvbGRlcl9hbGl2ZSh2YWx1ZSk6CiAgICBwaWQgPSB2YWx1ZS5nZXQoJ2hvbGRlcl9waWQnKQogICAgc3RhcnRlZCA9IHZhbHVlLmdldCgnaG9sZF9zdGFydGVkX21zJykKICAgIGlmICh0eXBlKHBpZCkgaXMgbm90IGludCBvciBwaWQgPD0gMSBvciB0eXBlKHN0YXJ0ZWQpIGlzIG5vdCBpbnQgb3IKICAgICAgICAgICAgbm90IDAgPD0gdGltZS50aW1lKCkgKiAxMDAwIC0gc3RhcnRlZCA8IEhPTERfTVMgb3IKICAgICAgICAgICAgdmFsdWUuZ2V0KCdob2xkX2FjdGl2ZScpIGlzIG5vdCBUcnVlIG9yIHZhbHVlLmdldCgnbWF4aW11bV9sb2NrX21zJykgIT0gSE9MRF9NUyk6CiAgICAgICAgcmV0dXJuIEZhbHNlCiAgICB0cnk6CiAgICAgICAgcHJvY2VzcyA9IHBhdGhsaWIuUGF0aCgnL3Byb2MnKSAvIHN0cihwaWQpCiAgICAgICAgY29tbWFuZCA9IChwcm9jZXNzIC8gJ2NtZGxpbmUnKS5yZWFkX2J5dGVzKCkuc3BsaXQoYidcMCcpCiAgICAgICAgcmV0dXJuIChwcm9jZXNzLnN0YXQoKS5zdF91aWQgPT0gb3MuZ2V0dWlkKCkgYW5kIGInQ3VydFBob25lRGlzcGxheScgaW4gY29tbWFuZAogICAgICAgICAgICAgICAgYW5kIGInd2FrZS1ob2xkJyBpbiBjb21tYW5kKQogICAgZXhjZXB0IE9TRXJyb3I6CiAgICAgICAgcmV0dXJuIEZhbHNlCgoKZGVmIGluc3BlY3QoKToKICAgIHByb2Nlc3MgPSBzdWJwcm9jZXNzLnJ1bihbJy9zeXN0ZW0vYmluL2FwcF9wcm9jZXNzJywgJy8nLCAnQ3VydFBob25lRGlzcGxheScsICdpbnNwZWN0J10sCiAgICAgICAgZW52PXsqKm9zLmVudmlyb24sICdDTEFTU1BBVEgnOiBzdHIoSEVMUEVSKX0sIHN0ZGluPXN1YnByb2Nlc3MuREVWTlVMTCwKICAgICAgICBjYXB0dXJlX291dHB1dD1UcnVlLCB0ZXh0PVRydWUsIHRpbWVvdXQ9OCwgY2hlY2s9RmFsc2UpCiAgICB2YWx1ZSA9IGpzb24ubG9hZHMocHJvY2Vzcy5zdGRvdXQpCiAgICBpZiBwcm9jZXNzLnJldHVybmNvZGUgb3IgdmFsdWUuZ2V0KCdlcnJvcicpIG9yIHZhbHVlLmdldCgncGFja2FnZV9hdHRyaWJ1dGlvbl92ZXJpZmllZCcpIGlzIG5vdCBUcnVlOgogICAgICAgIHJhaXNlIFZhbHVlRXJyb3IoJ0luZGVwZW5kZW50IHNjcmVlbi1zdGF0ZSBjaGVjayBmYWlsZWQuJykKICAgIHJldHVybiB2YWx1ZQoKCmRlZiB3YWtlKCk6CiAgICBpZiBsZW4oc3lzLmFyZ3YpICE9IDEgb3Igb3MuZ2V0dWlkKCkgPCAxMDAwMDoKICAgICAgICByYWlzZSBWYWx1ZUVycm9yKCdSdW4gdGhyb3VnaCB0aGUgZXhpc3RpbmcgVGVybXV4IHdvcmtlciBvbmx5LicpCiAgICBpbmZvID0gSEVMUEVSLmxzdGF0KCkKICAgIGlmIG5vdCBzdGF0LlNfSVNSRUcoaW5mby5zdF9tb2RlKSBvciBpbmZvLnN0X3VpZCAhPSBvcy5nZXR1aWQoKSBvciBpbmZvLnN0X21vZGUgJiAwbzA3NzoKICAgICAgICByYWlzZSBWYWx1ZUVycm9yKCdUaGUgcHJpdmF0ZSBkaXNwbGF5IGhlbHBlciBoYXMgdW5leHBlY3RlZCBvd25lcnNoaXAgb3IgYWNjZXNzLicpCiAgICBpZiBpbmZvLnN0X3NpemUgIT0gMTEwMTIgb3IgaGFzaGxpYi5zaGEyNTYoSEVMUEVSLnJlYWRfYnl0ZXMoKSkuaGV4ZGlnZXN0KCkgIT0gU0hBMjU2OgogICAgICAgIHJhaXNlIFZhbHVlRXJyb3IoJ1RoZSBpbnN0YWxsZWQgZGlzcGxheSBoZWxwZXIgZG9lcyBub3QgbWF0Y2ggdGhlIHJldmlld2VkIHZlcnNpb24uJykKICAgIGd1YXJkID0gcHJpdmF0ZV9maWxlKEZPTERFUiAvICdob2xkLWNvbW1hbmQubG9jaycpCiAgICBsb2cgPSBOb25lCiAgICB0cnk6CiAgICAgICAgZmNudGwuZmxvY2soZ3VhcmQsIGZjbnRsLkxPQ0tfRVggfCBmY250bC5MT0NLX05CKQogICAgICAgIGxvZyA9IHByaXZhdGVfZmlsZShGT0xERVIgLyAnaG9sZC1yZWNlaXB0Lmpzb25sJykKICAgICAgICB2YWx1ZSA9IHJlYWRfcmVjZWlwdChsb2cpCiAgICAgICAgcmV1c2VkID0gaG9sZGVyX2FsaXZlKHZhbHVlKQogICAgICAgIGlmIG5vdCByZXVzZWQ6CiAgICAgICAgICAgIG9zLmZ0cnVuY2F0ZShsb2csIDApCiAgICAgICAgICAgIG9zLmxzZWVrKGxvZywgMCwgb3MuU0VFS19TRVQpCiAgICAgICAgICAgIGNoaWxkID0gc3VicHJvY2Vzcy5Qb3BlbihbJy9zeXN0ZW0vYmluL2FwcF9wcm9jZXNzJywgJy8nLCAnQ3VydFBob25lRGlzcGxheScsICd3YWtlLWhvbGQnXSwKICAgICAgICAgICAgICAgIGVudj17Kipvcy5lbnZpcm9uLCAnQ0xBU1NQQVRIJzogc3RyKEhFTFBFUil9LCBzdGRpbj1zdWJwcm9jZXNzLkRFVk5VTEwsCiAgICAgICAgICAgICAgICBzdGRvdXQ9bG9nLCBzdGRlcnI9c3VicHJvY2Vzcy5ERVZOVUxMLCBzdGFydF9uZXdfc2Vzc2lvbj1UcnVlLCBjbG9zZV9mZHM9VHJ1ZSkKICAgICAgICAgICAgZGVhZGxpbmUgPSB0aW1lLm1vbm90b25pYygpICsgOAogICAgICAgICAgICB3aGlsZSB0aW1lLm1vbm90b25pYygpIDwgZGVhZGxpbmU6CiAgICAgICAgICAgICAgICB2YWx1ZSA9IHJlYWRfcmVjZWlwdChsb2cpCiAgICAgICAgICAgICAgICBpZiBob2xkZXJfYWxpdmUodmFsdWUpOgogICAgICAgICAgICAgICAgICAgIGJyZWFrCiAgICAgICAgICAgICAgICBpZiBjaGlsZC5wb2xsKCkgaXMgbm90IE5vbmU6CiAgICAgICAgICAgICAgICAgICAgcmFpc2UgVmFsdWVFcnJvcignQW5kcm9pZCBkaWQgbm90IHN0YXJ0IHRoZSBib3VuZGVkIGRpc3BsYXkgaG9sZC4nKQogICAgICAgICAgICAgICAgdGltZS5zbGVlcCgwLjIpCiAgICAgICAgICAgIGVsc2U6CiAgICAgICAgICAgICAgICBjaGlsZC50ZXJtaW5hdGUoKQogICAgICAgICAgICAgICAgcmFpc2UgVmFsdWVFcnJvcignRGlzcGxheSBob2xkIGRpZCBub3QgcmVwb3J0IHJlYWRpbmVzcy4nKQogICAgICAgIHRpbWUuc2xlZXAoNCkKICAgICAgICBjdXJyZW50ID0gaW5zcGVjdCgpCiAgICAgICAgaWYgbm90IGhvbGRlcl9hbGl2ZSh2YWx1ZSkgb3IgY3VycmVudC5nZXQoJ2ludGVyYWN0aXZlX2FmdGVyJykgaXMgbm90IFRydWUgb3IgY3VycmVudC5nZXQoJ2Rpc3BsYXlfc3RhdGUnKSAhPSAyOgogICAgICAgICAgICByYWlzZSBWYWx1ZUVycm9yKCdUaGUgc2NyZWVuIGRpZCBub3QgcmVtYWluIG9uIGFmdGVyIHdha2UuJykKICAgICAgICBpZiByZXVzZWQ6CiAgICAgICAgICAgIHZhbHVlWydpbnRlcmFjdGl2ZV9iZWZvcmVfcmVxdWVzdCddID0gVHJ1ZQogICAgICAgICAgICB2YWx1ZVsnb2ZmX3RvX29uX3ZlcmlmaWVkJ10gPSBGYWxzZQogICAgICAgIHZhbHVlLnVwZGF0ZShob2xkX3JldXNlZD1yZXVzZWQsIGhvbGRfdmVyaWZpZWRfYXRfbXM9aW50KHRpbWUudGltZSgpKjEwMDApLAogICAgICAgICAgICBob2xkX3VudGlsX21zPXZhbHVlWydob2xkX3N0YXJ0ZWRfbXMnXSArIEhPTERfTVMsIHN1c3RhaW5lZF9jaGVja19tcz00MDAwKQogICAgICAgIHByaW50KGpzb24uZHVtcHModmFsdWUsIHNlcGFyYXRvcnM9KCcsJywgJzonKSkpCiAgICAgICAgcmV0dXJuIDAKICAgIGZpbmFsbHk6CiAgICAgICAgaWYgbG9nIGlzIG5vdCBOb25lOgogICAgICAgICAgICBvcy5jbG9zZShsb2cpCiAgICAgICAgb3MuY2xvc2UoZ3VhcmQpCgoKaWYgX19uYW1lX18gPT0gJ19fbWFpbl9fJzoKICAgIHRyeToKICAgICAgICBzeXMuZXhpdCh3YWtlKCkpCiAgICBleGNlcHQgKE9TRXJyb3IsIFZhbHVlRXJyb3IsIHN1YnByb2Nlc3MuVGltZW91dEV4cGlyZWQpIGFzIGVycm9yOgogICAgICAgIHByaW50KGpzb24uZHVtcHMoeydraW5kJzogJ3Bob25lLWRpc3BsYXktd2FrZScsICdlcnJvcic6IHN0cihlcnJvcilbOjI1MF19KSkKICAgICAgICBzeXMuZXhpdCgyKQo=';
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
    card.innerHTML='<h3>Remote screen wake</h3><p>Wake selected phones and keep their screens on for ten minutes. The hold ends automatically; pressing the power button can end it sooner. Locked phones remain on their lock screen.</p><label for="phone-wake-target">Phones to wake</label> <select id="phone-wake-target"><option value="all">All eight phones</option>'+[...PHONES].map(unit=>'<option value="'+unit+'">'+unit+'</option>').join('')+'</select><div class="cluster-action-row"><button id="phone-wake-run" type="button" class="cluster-primary-action">Wake for 10 minutes</button></div><p id="phone-wake-state" role="status" aria-live="polite"></p><pre id="phone-wake-report" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>';
    fleet.prepend(card);card.querySelector('#phone-wake-run').onclick=wake;
    if (report) card.querySelector('#phone-wake-target').value=report.target;
    render();if (pending()) { poll=setInterval(refresh,5000);void refresh(); }
  }
  mount();
  setInterval(render,1000);
  const mounting=setInterval(()=>{mount();if(document.getElementById('cluster-phone-wake'))clearInterval(mounting);},1000);
})();
