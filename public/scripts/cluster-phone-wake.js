/* On-demand display wake, initially available only on the tested phone253. */
(() => {
  const UNIT = 'phone253', STORAGE = 'curt-phone253-wake-v1', LIMIT = 180000;
  const RUNNER_BASE64 = 'IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiJSdW4gb25seSBwaG9uZTI1MydzIHJldmlld2VkLCBhbHJlYWR5LWluc3RhbGxlZCBkaXNwbGF5IGhlbHBlci4gTm8gaW5zdGFsbGVyLiIiIgppbXBvcnQgaGFzaGxpYgppbXBvcnQganNvbgppbXBvcnQgb3MKaW1wb3J0IHBhdGhsaWIKaW1wb3J0IHN0YXQKaW1wb3J0IHN1YnByb2Nlc3MKaW1wb3J0IHN5cwoKSEVMUEVSID0gcGF0aGxpYi5QYXRoKCcvZGF0YS9kYXRhL2NvbS50ZXJtdXgvZmlsZXMvaG9tZS9jbHVzdGVyL2NvbnRyb2wvZGlzcGxheS13YWtlLTIwMjYxMDIyL2N1cnQtZGlzcGxheS00ODdkMzBjNTc0N2UuZGV4JykKU0hBMjU2ID0gJzQ4N2QzMGM1NzQ3ZWVjOTBmNTA2YjEyZTA4MWY0OGE1MTgxNWRjZDgzMDIwMzIxYjM5Yjk1ZGZkNjc1YmNjZjQnCgoKZGVmIHdha2UoKToKICAgIGlmIGxlbihzeXMuYXJndikgIT0gMSBvciBvcy5nZXR1aWQoKSA8IDEwMDAwOgogICAgICAgIHJhaXNlIFZhbHVlRXJyb3IoJ1J1biB0aHJvdWdoIHRoZSBleGlzdGluZyBwaG9uZTI1MyB3b3JrZXIgb25seS4nKQogICAgaW5mbyA9IEhFTFBFUi5sc3RhdCgpCiAgICBpZiBub3Qgc3RhdC5TX0lTUkVHKGluZm8uc3RfbW9kZSkgb3IgaW5mby5zdF91aWQgIT0gb3MuZ2V0dWlkKCkgb3IgaW5mby5zdF9tb2RlICYgMG8wNzc6CiAgICAgICAgcmFpc2UgVmFsdWVFcnJvcignVGhlIHByaXZhdGUgZGlzcGxheSBoZWxwZXIgaGFzIHVuZXhwZWN0ZWQgb3duZXJzaGlwIG9yIGFjY2Vzcy4nKQogICAgaWYgaW5mby5zdF9zaXplICE9IDgxOTIgb3IgaGFzaGxpYi5zaGEyNTYoSEVMUEVSLnJlYWRfYnl0ZXMoKSkuaGV4ZGlnZXN0KCkgIT0gU0hBMjU2OgogICAgICAgIHJhaXNlIFZhbHVlRXJyb3IoJ1RoZSBpbnN0YWxsZWQgZGlzcGxheSBoZWxwZXIgZG9lcyBub3QgbWF0Y2ggdGhlIHJldmlld2VkIHZlcnNpb24uJykKICAgIHJlc3VsdCA9IHN1YnByb2Nlc3MucnVuKAogICAgICAgIFsnL3N5c3RlbS9iaW4vYXBwX3Byb2Nlc3MnLCAnLycsICdDdXJ0UGhvbmVEaXNwbGF5JywgJ3dha2UnXSwKICAgICAgICBlbnY9eyoqb3MuZW52aXJvbiwgJ0NMQVNTUEFUSCc6IHN0cihIRUxQRVIpfSwgc3RkaW49c3VicHJvY2Vzcy5ERVZOVUxMLAogICAgICAgIGNhcHR1cmVfb3V0cHV0PVRydWUsIHRleHQ9VHJ1ZSwgdGltZW91dD0xMiwgY2hlY2s9RmFsc2UsCiAgICApCiAgICB2YWx1ZSA9IGpzb24ubG9hZHMocmVzdWx0LnN0ZG91dCkKICAgIGlmIG5vdCBpc2luc3RhbmNlKHZhbHVlLCBkaWN0KSBvciB2YWx1ZS5nZXQoJ2tpbmQnKSAhPSAncGhvbmUtZGlzcGxheS13YWtlJzoKICAgICAgICByYWlzZSBWYWx1ZUVycm9yKCdUaGUgcGhvbmUgcmV0dXJuZWQgYW4gdW5leHBlY3RlZCBkaXNwbGF5IHJlcG9ydC4nKQogICAgcHJpbnQoanNvbi5kdW1wcyh2YWx1ZSwgc2VwYXJhdG9ycz0oJywnLCAnOicpKSkKICAgIHJldHVybiByZXN1bHQucmV0dXJuY29kZQoKCmlmIF9fbmFtZV9fID09ICdfX21haW5fXyc6CiAgICB0cnk6CiAgICAgICAgc3lzLmV4aXQod2FrZSgpKQogICAgZXhjZXB0IChPU0Vycm9yLCBWYWx1ZUVycm9yLCBzdWJwcm9jZXNzLlRpbWVvdXRFeHBpcmVkKToKICAgICAgICBwcmludChqc29uLmR1bXBzKHsna2luZCc6ICdwaG9uZS1kaXNwbGF5LXdha2UnLCAnZXJyb3InOiAnRGlzcGxheSB3YWtlIGNvdWxkIG5vdCBiZSB2ZXJpZmllZC4gQ2hlY2sgdGhlIGluc3RhbGxlZCBwaG9uZTI1MyBoZWxwZXIgYW5kIGV4aXN0aW5nIGNvbm5lY3Rpb24uJ30pKQogICAgICAgIHN5cy5leGl0KDIpCg==';
  const STATES = ['queued','unconfirmed','already-on','woke','failed','expired'];
  let report = null, busy = false, poll = null, message = '';
  try { report = JSON.parse(localStorage.getItem(STORAGE)); } catch {}
  if (!report || report.unit !== UNIT || !STATES.includes(report.state) ||
      typeof report.job_id !== 'string' || !/^phone-display-wake-[A-Za-z0-9-]{1,80}$/.test(report.job_id) ||
      !Number.isFinite(Date.parse(report.created_at)) || Date.parse(report.created_at) > Date.now()+5000) report = null;
  const pending = () => report && ['queued','unconfirmed'].includes(report.state);
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
    const button = document.getElementById('phone253-wake-run'), output = document.getElementById('phone253-wake-state');
    if (!button || !output) return;
    button.disabled = busy || !!pending();
    const labels = {
      queued:'Wake requested. Waiting for Android display state.',
      unconfirmed:'Submission unconfirmed. Checking this request before any retry.',
      'already-on':'Android reports phone253 was already on. Wake request completed; lock released.',
      woke:'Android confirmed phone253 changed from screen off to on. Wake lock released.',
      failed:'Wake failed or its display result could not be verified.',
      expired:'No verified result received. Check Queue & results before sending another request.',
    };
    output.textContent = message || (report ? labels[report.state]+' Checked '+new Date(report.created_at).toLocaleString()+'.' : 'Ready on phone253. No wake requested.');
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
    const result = (Array.isArray(data?.results)?data.results:[]).find(r => r.job_id === report.job_id && r.device_id === UNIT);
    if (result) {
      const value = validResult(result);
      report.state = value ? value.off_to_on_verified ? 'woke' : 'already-on' : 'failed';
    } else if (Date.now()-Date.parse(report.created_at)>LIMIT) report.state='expired';
    save(); render();
    if (!pending() && poll) { clearInterval(poll); poll=null; }
  }
  async function refresh() {
    if (busy || document.hidden || !pending()) return;
    try { collect(await api('queue-status')); }
    catch { if (Date.now()-Date.parse(report.created_at)>LIMIT) collect({}); }
  }
  async function wake() {
    if (busy || pending()) return;
    busy=true; message='Checking phone253 availability...'; render();
    try {
      const data=await api('queue-status');
      if (!Array.isArray(data.nodes)) throw Error('Phone availability could not be verified.');
      const matches=data.nodes.filter(n=>n.id===UNIT);
      if (matches.length !== 1 || matches[0].online !== true) throw Error('phone253 is offline or its connection is unverified.');
      if (matches[0].busy !== false) throw Error('phone253 is busy or its availability is unverified. Wake skipped.');
      report={unit:UNIT,job_id:'phone-display-wake-'+crypto.randomUUID(),created_at:new Date().toISOString(),state:'queued'};
      message='';save();render();
      const command="python -c 'import base64;exec(base64.b64decode(\""+RUNNER_BASE64+"\"))'";
      try { await api('enqueue',{job:{id:report.job_id,type:'shell',cmd:command,command},target_device_ids:[UNIT]}); }
      catch { report.state='unconfirmed'; }
      save(); if (!poll) poll=setInterval(refresh,5000);
    } catch (error) { message=error.message || 'Remote wake unavailable.'; }
    finally { busy=false;render(); }
  }
  function mount() {
    const fleet=document.getElementById('cluster-view-fleet');
    if (!fleet || document.getElementById('cluster-phone-wake')) return;
    const card=document.createElement('section');card.id='cluster-phone-wake';card.className='cluster-control-card';
    card.innerHTML='<h3>Remote screen wake</h3><p>Wake phone253 through its existing connection. Wakes the display only; it does not unlock the phone or change apps. Other phones are not enabled for this wake method yet.</p><button id="phone253-wake-run" type="button" class="cluster-primary-action">Wake phone253</button><p id="phone253-wake-state" role="status" aria-live="polite"></p>';
    fleet.prepend(card);card.querySelector('#phone253-wake-run').onclick=wake;render();
    if (pending()) { poll=setInterval(refresh,5000);void refresh(); }
  }
  mount();
  const mounting=setInterval(()=>{mount();if(document.getElementById('cluster-phone-wake'))clearInterval(mounting);},1000);
})();
