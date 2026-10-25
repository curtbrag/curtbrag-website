(() => {
  const panel=document.getElementById('panel');
  if(!panel) return;
  const card=document.createElement('section');
  card.id='fleet-email-controls';
  card.style.cssText='background:var(--color-panel);border:1px solid var(--color-border);border-radius:12px;padding:20px;margin:20px 0;overflow:auto';
  card.innerHTML='<h2 style="font-size:20px;font-weight:bold">Fleet email</h2><p>Each unit has its own @curtbrag.com inbox and outgoing login. Device checks run through the main PC. No passwords are shown here.</p><div style="display:flex;gap:10px;margin:12px 0;flex-wrap:wrap"><button id="mail-refresh" type="button">Refresh email status</button><button id="mail-check-all" type="button">Check connected mailboxes</button><button id="mail-test-all" type="button">Send one test to each connected mailbox</button></div><p id="mail-state" role="status" aria-live="polite">Email status has not been checked.</p><table style="width:100%;text-align:left"><thead><tr><th>Unit / address</th><th>Device setup</th><th>Last result</th><th>Controls</th></tr></thead><tbody id="mail-units"></tbody></table><p>Checks do not read email contents. Tests send only to the unit’s own address. Sending accepted is separate from delivery confirmation. Offline devices are skipped. A test is never automatically retried.</p>';
  panel.append(card);
  const shortcut=document.createElement('a');shortcut.href='#fleet-email-controls';shortcut.textContent='Fleet email';shortcut.style.cssText='display:inline-block;margin-top:8px;text-decoration:underline';
  panel.querySelector('h1')?.parentElement.append(shortcut);
  let snapshot=null, busy=false;
  const state=card.querySelector('#mail-state');
  async function api(action,body) {
    const token=sessionStorage.getItem('cp_password');
    if(!token) throw Error('Sign in to use email controls');
    const response=await fetch('/.netlify/functions/fleet-email?action='+action,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(15000)});
    const data=await response.json();
    if(!response.ok) throw Error(data.error||'Email connection unavailable');
    return data;
  }
  function resultText(job) {
    if(!job) return 'Not checked on device';
    if(job.action==='test' && job.result?.accepted===true) return job.result.delivery_verified?'Test sent and received':'Test accepted; delivery unconfirmed';
    if(job.status==='interrupted') return job.action==='test'?'Interrupted; sending outcome unconfirmed. It was not replayed.':'Check interrupted; run Check again.';
    if(job.status==='expired') return 'Expired before execution';
    if(job.result) return job.result.ok?'Incoming and outgoing login verified':'Failed: '+(job.result.error||'connection error');
    if(job.status==='running' && Date.now()-job.started_at>120000) return 'Still running; interrupted requests unlock after five minutes';
    return job.status;
  }
  function render() {
    const tbody=card.querySelector('#mail-units'); tbody.replaceChildren();
    const age=Date.now()-(snapshot.bridge?.at||0), live=age>=0&&age<120000;
    for(const unit of snapshot.units) {
      const tr=document.createElement('tr');
      const latest=snapshot.jobs.filter(j=>j.unit===unit.unit).sort((a,b)=>b.created_at-a.created_at)[0];
      const active=snapshot.jobs.some(j=>j.unit===unit.unit && ['queued','running'].includes(j.status));
      const result=resultText(latest);
      for(const text of [unit.unit+' · '+unit.address,unit.installed?(live&&unit.connected?'Installed · connected':'Installed · disconnected'):'Setup pending',result]) {
        const td=document.createElement('td');td.style.cssText='padding:10px 6px;border-top:1px solid var(--color-border);overflow-wrap:anywhere';td.textContent=text;tr.append(td);
      }
      const controls=document.createElement('td');
      for(const [action,label] of [['check','Check'],['test','Test to self']]) {
        const button=document.createElement('button');button.type='button';button.textContent=label;button.disabled=busy||!live||!unit.installed||!unit.connected||active;button.style.margin='4px';button.onclick=()=>submit([unit.unit],action);controls.append(button);
      }
      tr.append(controls);tbody.append(tr);
    }
    const available=live&&snapshot.units.some(unit=>unit.installed&&unit.connected&&!snapshot.jobs.some(job=>job.unit===unit.unit&&['queued','running'].includes(job.status)));
    card.querySelector('#mail-check-all').disabled=busy||!available;
    card.querySelector('#mail-test-all').disabled=busy||!available;
    state.textContent=live?'Main PC email connection is online.':'Main PC email connection is offline or not installed. No requests will be queued.';
  }
  async function refresh() {
    if(!sessionStorage.getItem('cp_password')) return;
    try {snapshot=await api('status');render();} catch(error) {state.textContent=error.message;}
  }
  async function submit(units,action) {
    if(busy) return;
    if(!units.length){state.textContent='No connected mailboxes are available for this request.';return;}
    const uncertain=units.some(unit=>{const latest=snapshot.jobs.filter(job=>job.unit===unit&&job.action==='test').sort((a,b)=>b.created_at-a.created_at)[0];return latest?.status==='interrupted'&&latest.result?.delivery_verified!==true;});
    const notice=uncertain?'An earlier test has an unconfirmed sending outcome. This sends a new test; it does not retry the earlier request. ':'';
    if(action==='test' && !confirm(notice+'Send one test email to each of these '+units.length+' selected units’ own inboxes?')) return;
    busy=true;render();
    card.querySelectorAll('button').forEach(b=>b.disabled=true);
    const outcomes=[];
    try {
      for(const unit of units) {
        try {await api('enqueue',{id:crypto.randomUUID(),unit,action});outcomes.push(unit+': queued');}
        catch(error) {outcomes.push(unit+': '+error.message);}
      }
    } finally {busy=false;card.querySelector('#mail-refresh').disabled=false;await refresh();if(snapshot)render();state.textContent=outcomes.join(' · ');}
  }
  const connected=()=>snapshot?.units.filter(u=>u.installed&&u.connected&&!snapshot.jobs.some(j=>j.unit===u.unit&&['queued','running'].includes(j.status))).map(u=>u.unit)||[];
  card.querySelector('#mail-refresh').onclick=refresh;
  card.querySelector('#mail-check-all').onclick=()=>submit(connected(),'check');
  card.querySelector('#mail-test-all').onclick=()=>submit(connected(),'test');
  refresh();setInterval(()=>{if(!document.hidden&&!busy)refresh();},30000);
})();

