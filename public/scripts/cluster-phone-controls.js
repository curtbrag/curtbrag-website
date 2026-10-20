/* Phone screen access is separate from worker connectivity. No grants or pairing. */
(() => {
  const PHONES = new Set(['phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254']);
  const MAX_AGE = 30 * 60 * 1000;
  const STORAGE = 'curt-phone-control-check-v1';
  const PROBE_BASE64 = 'IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiJJbnNwZWN0IHRoZSBjdXJyZW50IFRlcm11eCBsYXVuY2ggcGVybWlzc2lvbiB3aXRob3V0IG9wZW5pbmcgYSByZWFsIGFjdGl2aXR5LiIiIgppbXBvcnQganNvbgppbXBvcnQgb3MKaW1wb3J0IHNodXRpbAppbXBvcnQgc3VicHJvY2VzcwoKUFJPQkVfQ09NUE9ORU5UID0gJ2NvbS50ZXJtdXgvY29tLnRlcm11eC5DdXJ0Q2x1c3Rlck1pc3NpbmdQZXJtaXNzaW9uUHJvYmUnCgoKZGVmIGluc3BlY3RfY29udHJvbHMoZW52aXJvbj1Ob25lLCBydW49Tm9uZSwgd2hpY2g9Tm9uZSk6CiAgICBlbnZpcm9uID0gZGljdChvcy5lbnZpcm9uIGlmIGVudmlyb24gaXMgTm9uZSBlbHNlIGVudmlyb24pCiAgICBydW4gPSBzdWJwcm9jZXNzLnJ1biBpZiBydW4gaXMgTm9uZSBlbHNlIHJ1bgogICAgd2hpY2ggPSBzaHV0aWwud2hpY2ggaWYgd2hpY2ggaXMgTm9uZSBlbHNlIHdoaWNoCiAgICByZXBvcnQgPSBkaWN0KGtpbmQ9J3Bob25lLWNvbnRyb2wtcmVhZGluZXNzJywgcGVybWlzc2lvbj0ndW5rbm93bicsCiAgICAgICAgICAgICAgICAgIHNjcmVlbl92ZXJpZmllZD1GYWxzZSwgcGVybWlzc2lvbnNfY2hhbmdlZD1GYWxzZSwKICAgICAgICAgICAgICAgICAgcmVhbF9hY3Rpdml0eV9yZXF1ZXN0ZWQ9RmFsc2UsIGVycm9yPU5vbmUpCiAgICBwcmVmaXggPSBlbnZpcm9uLmdldCgnUFJFRklYJywgJycpCiAgICBleHBlY3RlZCA9IHByZWZpeCArICcvYmluL2FtJwogICAgaWYgbm90IChwcmVmaXguc3RhcnRzd2l0aCgnL2RhdGEvJykgYW5kIHByZWZpeC5lbmRzd2l0aCgnL2NvbS50ZXJtdXgvZmlsZXMvdXNyJykpOgogICAgICAgIHJlcG9ydFsnZXJyb3InXSA9ICdUaGlzIGNoZWNrIHJ1bnMgb25seSBpbiB0aGUgZXhpc3RpbmcgVGVybXV4IHdvcmtlci4nCiAgICAgICAgcmV0dXJuIHJlcG9ydAogICAgaWYgd2hpY2goJ2FtJywgcGF0aD1lbnZpcm9uLmdldCgnUEFUSCcpKSAhPSBleHBlY3RlZDoKICAgICAgICByZXBvcnRbJ2Vycm9yJ10gPSAnVGhlIGluc3RhbGxlZCBUZXJtdXggbGF1bmNoZXIgaXMgdW5hdmFpbGFibGUuJwogICAgICAgIHJldHVybiByZXBvcnQKICAgIHRyeToKICAgICAgICByZXN1bHQgPSBydW4oW2V4cGVjdGVkLCAnc3RhcnQnLCAnLS11c2VyJywgJzAnLCAnLS1jaGVjay1kcmF3LW92ZXItYXBwcy1wZXJtaXNzaW9uJywKICAgICAgICAgICAgICAgICAgICAgICctbicsIFBST0JFX0NPTVBPTkVOVF0sIGNhcHR1cmVfb3V0cHV0PVRydWUsIHRleHQ9VHJ1ZSwKICAgICAgICAgICAgICAgICAgICAgdGltZW91dD0xMiwgY2hlY2s9RmFsc2UsIHNoZWxsPUZhbHNlLCBlbnY9ZW52aXJvbikKICAgICAgICBvdXRwdXQgPSBzdHIocmVzdWx0LnN0ZG91dCBvciAnJykgKyAnXG4nICsgc3RyKHJlc3VsdC5zdGRlcnIgb3IgJycpCiAgICAgICAgaWYgJ3JlcXVpcmVzIHRoZSAiRGlzcGxheSBvdmVyIG90aGVyIGFwcHMiIHBlcm1pc3Npb24nIGluIG91dHB1dDoKICAgICAgICAgICAgcmVwb3J0WydwZXJtaXNzaW9uJ10gPSAncmVxdWlyZWQnCiAgICAgICAgZWxpZiAnZG9lcyBub3QgZXhpc3QnIGluIG91dHB1dCBhbmQgUFJPQkVfQ09NUE9ORU5UIGluIG91dHB1dDoKICAgICAgICAgICAgcmVwb3J0WydwZXJtaXNzaW9uJ10gPSAnYWxsb3dlZCcKICAgICAgICBlbHNlOgogICAgICAgICAgICByZXBvcnRbJ2Vycm9yJ10gPSAnQW5kcm9pZCBkaWQgbm90IHJldHVybiBhIGNvbmNsdXNpdmUgcGVybWlzc2lvbiBjaGVjay4nCiAgICBleGNlcHQgKE9TRXJyb3IsIHN1YnByb2Nlc3MuVGltZW91dEV4cGlyZWQpOgogICAgICAgIHJlcG9ydFsnZXJyb3InXSA9ICdUaGUgcGVybWlzc2lvbiBjaGVjayBkaWQgbm90IGZpbmlzaC4nCiAgICByZXR1cm4gcmVwb3J0CgoKaWYgX19uYW1lX18gPT0gJ19fbWFpbl9fJzoKICAgIHByaW50KGpzb24uZHVtcHMoaW5zcGVjdF9jb250cm9scygpLCBzZXBhcmF0b3JzPSgnLCcsICc6JykpKQo=';
  let report = null, busy = false, poll = null, message = '';
  try { report = JSON.parse(localStorage.getItem(STORAGE)); } catch {}
  if (!report || !Array.isArray(report.phones) || report.phones.length !== PHONES.size ||
      new Set(report.phones.map(p => p?.unit)).size !== PHONES.size ||
      report.phones.some(p => !PHONES.has(p?.unit) || typeof p.state !== 'string') ||
      !Number.isFinite(Date.parse(report.checked_at)) || Date.parse(report.checked_at) > Date.now()+5000 ||
      typeof report.job_id !== 'string' || !/^phone-control-check-[A-Za-z0-9-]{1,80}$/.test(report.job_id)) report = null;

  async function api(action, body) {
    const password = sessionStorage.getItem('cp_password');
    if (!password) throw Error('Sign in to check phone controls.');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch('/api/cluster?action=' + action, {
        method: body ? 'POST' : 'GET', credentials:'same-origin', cache:'no-store',
        headers:{Authorization:'Bearer ' + password,'Content-Type':'application/json'},
        body:body ? JSON.stringify(body) : undefined, signal:controller.signal,
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw Error(data.error || 'Connection check failed.');
      return data;
    } finally { clearTimeout(timer); }
  }
  function save() { try { localStorage.setItem(STORAGE, JSON.stringify(report)); } catch {} }
  function pending() { return report?.phones?.some(p => ['queued','unconfirmed'].includes(p.state)); }
  function render() {
    const output = document.getElementById('phone-control-status'), button = document.getElementById('phone-control-check');
    if (!output || !button) return;
    button.disabled = busy || !!pending();
    if (message) { output.textContent = message; return; }
    if (!report?.checked_at || !Array.isArray(report.phones)) { output.textContent = 'Not checked. Online workers do not prove screen control is available.'; return; }
    const age = Date.now() - Date.parse(report.checked_at), stale = !Number.isFinite(age) || age < 0 || age > MAX_AGE;
    const lines = report.phones.filter(p => PHONES.has(p.unit)).map(p => {
      const labels = {required:'Needs Android approval: allow Termux to display over other apps',allowed:'Background launch permission allowed; screen switching is not verified',unknown:'Permission could not be verified',queued:'Checking\u2026',unconfirmed:'Submission unconfirmed; checking results before any retry',offline:'Worker offline; screen access unknown',busy:'Worker busy; check skipped',failed:'Check failed; screen access unknown',expired:'No result received; check again'};
      return p.unit + ' \u00b7 ' + (stale ? 'Previous check expired; check again' : labels[p.state] || labels.unknown);
    });
    output.textContent = 'Checked ' + new Date(report.checked_at).toLocaleString() + '\n\n' + lines.join('\n\n');
  }
  function collect(data) {
    if (!report?.job_id) return;
    const results = Array.isArray(data?.results) ? data.results : [];
    for (const phone of report.phones) {
      if (!['queued','unconfirmed'].includes(phone.state)) continue;
      const result = results.find(r => r.job_id === report.job_id && r.device_id === phone.unit);
      if (!result) continue;
      let value; try { value = JSON.parse(result.stdout); } catch {}
      const valid = Number(result.exit_code) === 0 && value?.kind === 'phone-control-readiness' &&
        value.screen_verified === false && value.permissions_changed === false &&
        value.real_activity_requested === false && ['required','allowed','unknown'].includes(value.permission);
      phone.state = valid ? value.permission : 'failed';
    }
    const age = Date.now() - Date.parse(report.checked_at);
    if (age > 180000) for (const p of report.phones) if (['queued','unconfirmed'].includes(p.state)) p.state = 'expired';
    save(); render();
    if (!pending() && poll) { clearInterval(poll); poll = null; }
  }
  async function refresh() {
    if (busy || document.hidden || !pending()) return;
    try { collect(await api('queue-status')); }
    catch { if(Date.now()-Date.parse(report.checked_at)>180000)collect({results:[]}); }
  }
  async function check() {
    if (busy || pending()) return;
    busy = true; message = 'Checking available phones...'; render();
    try {
      const data = await api('queue-status');
      if (!Array.isArray(data?.nodes)) throw Error('Worker availability is unverified.');
      const nodes = new Map(data.nodes.map(n => [n.id, n]));
      const targets = [...PHONES].filter(id => nodes.get(id)?.online === true && !nodes.get(id)?.busy);
      message = '';
      report = {checked_at:new Date().toISOString(), job_id:'phone-control-check-' + crypto.randomUUID(),
        phones:[...PHONES].map(unit => ({unit,state:targets.includes(unit)?'queued':nodes.get(unit)?.online===true?'busy':'offline'}))};
      save(); render();
      if (targets.length) {
        // The source is fixed, reviewed and encoded; no form input enters a shell.
        const command = "python -c 'import base64;exec(base64.b64decode(\"" + PROBE_BASE64 + "\"))'";
        try { await api('enqueue',{job:{id:report.job_id,type:'shell',cmd:command,command},target_device_ids:targets}); }
        catch { for (const p of report.phones) if(p.state==='queued')p.state='unconfirmed'; }
        save();
        if (!poll) poll = setInterval(refresh,5000);
      }
    } catch (error) { message = error.message || 'Connection check failed.'; }
    finally { busy = false; render(); }
  }
  function mount() {
    const fleet = document.getElementById('cluster-view-fleet');
    if (!fleet || document.getElementById('cluster-phone-controls')) return;
    const card = document.createElement('section');card.id='cluster-phone-controls';card.className='cluster-control-card';
    card.innerHTML='<h3>Phone screen controls</h3><p>Check all eight worker phones without moving their screens. Worker access and permission to switch apps are separate.</p><button id="phone-control-check" type="button" class="cluster-primary-action">Check phone controls</button><pre id="phone-control-status" role="status" aria-live="polite" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:340px;overflow:auto"></pre><details><summary>One-time Android setup</summary><p>On each affected phone: Settings \u2192 Apps \u2192 Special app access \u2192 Display over other apps \u2192 Termux \u2192 Allow. This permission lets Termux open websites while another app is visible. Then check again here. Back and verified Return to Termux also need the PC\u2019s authorized wireless debugging connection.</p><p>This check does not grant permissions, pair devices, install software or prove that a physical screen changed.</p></details>';
    fleet.prepend(card);card.querySelector('#phone-control-check').onclick=check;render();
    if (pending()) { poll=setInterval(refresh,5000);void refresh(); }
  }
  mount();
  const mounting = setInterval(() => { mount();if(document.getElementById('cluster-phone-controls'))clearInterval(mounting); },1000);
})();
