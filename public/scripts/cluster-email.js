(() => {
  const panel=document.getElementById('panel');
  if(!panel) return;
  const card=document.createElement('section');
  card.id='fleet-email-controls';
  card.style.cssText='background:var(--color-panel);border:1px solid var(--color-border);border-radius:12px;padding:20px;margin:20px 0;overflow:auto';
  card.innerHTML='<h2 style="font-size:20px;font-weight:bold">Fleet email</h2><p>Each unit has its own @curtbrag.com inbox and outgoing login. Device checks run through the main PC. No passwords are shown here.</p><div style="display:flex;gap:10px;margin:12px 0;flex-wrap:wrap"><button id="mail-refresh" type="button">Refresh email status</button><button id="mail-check-all" type="button">Check connected mailboxes</button><button id="mail-test-all" type="button">Send one test to each connected mailbox</button></div><p id="mail-state" role="status" aria-live="polite">Email status has not been checked.</p><table style="width:100%;text-align:left"><thead><tr><th>Unit / address</th><th>Device setup</th><th>Last result</th><th>Controls</th></tr></thead><tbody id="mail-units"></tbody></table><p>Checks do not read email contents. Tests send only to the unit’s own address. Sending accepted is separate from delivery confirmation. Offline devices are skipped. A test is never automatically retried.</p>';
  panel.append(card);
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
  function render() {
    const tbody=card.querySelector('#mail-units'); tbody.replaceChildren();
    const live=Date.now()-(snapshot.bridge?.at||0)<120000;
    for(const unit of snapshot.units) {
      const tr=document.createElement('tr');
      const latest=snapshot.jobs.filter(j=>j.unit===unit.unit).sort((a,b)=>b.created_at-a.created_at)[0];
      const active=snapshot.jobs.some(j=>j.unit===unit.unit && ['queued','running'].includes(j.status));
      let result='Not checked on device';
      if(latest) {
        result=latest.status;
        if(latest.status==='running' && Date.now()-latest.started_at>120000) result='Interrupted or still running; verify before retrying';
        if(latest.result) result=latest.result.ok?(latest.action==='test'?(latest.result.delivery_verified?'Test sent and received':'Test accepted; delivery unconfirmed'):'Incoming and outgoing login verified'):'Failed: '+(latest.result.error||'connection error');
      }
      for(const text of [unit.unit+' · '+unit.address,unit.installed?(live&&unit.connected?'Installed · connected':'Installed · disconnected'):'Setup pending',result]) {
        const td=document.createElement('td');td.style.cssText='padding:10px 6px;border-top:1px solid var(--color-border);overflow-wrap:anywhere';td.textContent=text;tr.append(td);
      }
      const controls=document.createElement('td');
      for(const [action,label] of [['check','Check'],['test','Test to self']]) {
        const button=document.createElement('button');button.type='button';button.textContent=label;button.disabled=busy||!live||!unit.installed||!unit.connected||active;button.style.margin='4px';button.onclick=()=>submit([unit.unit],action);controls.append(button);
      }
      tr.append(controls);tbody.append(tr);
    }
    state.textContent=live?'Main PC email connection is online.':'Main PC email connection is offline or not installed. No requests will be queued.';
  }
  async function refresh() {
    if(!sessionStorage.getItem('cp_password')) return;
    try {snapshot=await api('status');render();} catch(error) {state.textContent=error.message;}
  }
  async function submit(units,action) {
    if(busy) return;
    if(action==='test' && !confirm('Send one test email to each of these '+units.length+' selected units’ own inboxes?')) return;
    busy=true;render();
    card.querySelectorAll('button').forEach(b=>b.disabled=true);
    const outcomes=[];
    try {
      for(const unit of units) {
        try {await api('enqueue',{id:crypto.randomUUID(),unit,action});outcomes.push(unit+': queued');}
        catch(error) {outcomes.push(unit+': '+error.message);}
      }
    } finally {busy=false;card.querySelectorAll('button').forEach(b=>b.disabled=false);await refresh();state.textContent=outcomes.join(' · ');}
  }
  const connected=()=>snapshot?.units.filter(u=>u.installed&&u.connected&&!snapshot.jobs.some(j=>j.unit===u.unit&&['queued','running'].includes(j.status))).map(u=>u.unit)||[];
  card.querySelector('#mail-refresh').onclick=refresh;
  card.querySelector('#mail-check-all').onclick=()=>submit(connected(),'check');
  card.querySelector('#mail-test-all').onclick=()=>submit(connected(),'test');
  refresh();setInterval(()=>{if(!document.hidden&&!busy)refresh();},30000);
})();
