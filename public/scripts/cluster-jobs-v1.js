(() => {
  const API='/api/jobs';
  const NODES=['phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254','Alina','Nexus','SteamDeck'];
  const PHONES=new Set(NODES.filter(n=>n.startsWith('phone')));
  const $=id=>document.getElementById(id);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const auth=()=>sessionStorage.getItem('cp_password')||'';
  async function api(action,method='GET',body=null){
    const r=await fetch(API+'?action='+encodeURIComponent(action),{method,headers:{Authorization:'Bearer '+auth(),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    const data=await r.json().catch(()=>({}));
    if(!r.ok||data.ok===false) throw new Error(data.error||('HTTP '+r.status));
    return data;
  }
  function targets(){
    const v=$('jobTarget').value;
    if(v==='all') return NODES;
    if(v==='phones') return NODES.filter(n=>PHONES.has(n));
    if(v==='pcs') return NODES.filter(n=>!PHONES.has(n));
    return [v];
  }
  function statusColor(s){return s==='completed'?'#22c55e':s==='failed'?'#ef4444':s==='running'?'#3b82f6':s==='cancelled'?'#8a8a8a':'#eab308';}
  function render(jobs){
    const root=$('jobsList'); if(!root)return;
    if(!jobs.length){root.innerHTML='<div style="color:var(--color-muted);padding:24px;text-align:center">No jobs yet. Queue one above.</div>';return;}
    root.innerHTML=jobs.map(j=>{
      const total=j.targets.length, done=j.counts.completed||0, failed=j.counts.failed||0;
      const pct=total?Math.round(((done+failed)/total)*100):0;
      const detail=Object.entries(j.tasks||{}).map(([n,t])=>'<div style="display:grid;grid-template-columns:110px 90px 1fr;gap:8px;padding:5px 0;border-top:1px solid var(--color-border);font-size:12px"><strong>'+esc(n)+'</strong><span style="color:'+statusColor(t.status)+'">'+esc(t.status)+'</span><span style="color:var(--color-muted);white-space:pre-wrap;overflow-wrap:anywhere">'+esc(t.message||t.error||t.output||((t.progress||0)+'%'))+'</span></div>').join('');
      return '<details style="background:var(--color-panel);border:1px solid var(--color-border);border-radius:8px;padding:14px;margin-bottom:10px"><summary style="cursor:pointer;list-style:none"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><div><strong>'+esc(j.name)+'</strong><div style="font-size:11px;color:var(--color-muted)">'+esc(j.type)+' · '+total+' targets · '+new Date(j.createdAt).toLocaleString()+'</div></div><span style="color:'+statusColor(j.status)+';font-weight:700">'+esc(j.status)+'</span></div><div style="height:5px;background:var(--color-surface);border-radius:9px;margin-top:10px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:'+statusColor(j.status)+'"></div></div></summary><div style="margin-top:10px">'+detail+'<div style="display:flex;gap:8px;margin-top:10px">'+(j.status==='failed'||j.status==='cancelled'?'<button class="jobRetry" data-id="'+esc(j.id)+'">Retry failed</button>':'')+(j.status==='queued'||j.status==='running'?'<button class="jobCancel" data-id="'+esc(j.id)+'">Cancel</button>':'')+'</div></div></details>';
    }).join('');
    root.querySelectorAll('.jobCancel').forEach(b=>b.onclick=()=>mutate('cancel',b.dataset.id));
    root.querySelectorAll('.jobRetry').forEach(b=>b.onclick=()=>mutate('retry',b.dataset.id));
  }
  async function mutate(action,jobId){try{await api(action,'POST',{jobId,node:'phone173'});await load();}catch(e){alert(e.message);}}
  async function load(){if(!$('jobsList')||!auth())return;try{const d=await api('list');render(d.jobs||[]);const running=(d.jobs||[]).filter(j=>j.status==='running').length;$('jobsLiveCount').textContent=running+' running';}catch(e){$('jobsList').innerHTML='<div style="color:#ef4444">'+esc(e.message)+'</div>';}}
  async function submit(){
    const btn=$('queueJobBtn'); btn.disabled=true;
    try{
      const type=$('jobType').value, source=$('jobSource').value.trim(), destination=$('jobDestination').value.trim();
      const d=await api('create','POST',{type,name:$('jobName').value.trim(),targets:targets(),input:{source,destination,options:{}}});
      $('jobName').value=''; await load();
      if(window.toast) window.toast('Queued '+d.job.id);
    }catch(e){if(window.toast)window.toast(e.message,'error');else alert(e.message);}finally{btn.disabled=false;}
  }
  function init(){
    if(!$('queueJobBtn'))return;
    $('queueJobBtn').onclick=submit; $('refreshJobsBtn').onclick=load;
    $('jobType').onchange=()=>{
      const t=$('jobType').value;
      $('jobSourceWrap').style.display=t==='health-audit'?'none':'block';
      $('jobDestinationWrap').style.display=['archive','backup','download','media-convert','transcribe'].includes(t)?'block':'none';
    };
    $('jobType').dispatchEvent(new Event('change'));
    load(); setInterval(load,10000);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
  window.loadClusterJobs=load;
})();
