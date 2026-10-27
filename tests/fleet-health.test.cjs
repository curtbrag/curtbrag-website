const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');

const dashboard=fs.readFileSync(path.join(__dirname,'../public/scripts/cluster-swarm-live-v8.js'),'utf8');
const start=dashboard.indexOf('  let healthRun ='),end=dashboard.indexOf('  let changeMonitor =',start);
assert.ok(start>=0&&end>start);
const source=dashboard.slice(start,end),KEY='curt-fleet-health-v1',NOW=Date.parse('2026-10-07T07:00:00.000Z');
const IDS=new Set(['phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254','Alina','Nexus','SteamDeck','viki','RenderRig']);
const plain=value=>JSON.parse(JSON.stringify(value));
const node=(id='phone253',extra={})=>({id,online:true,busy:false,active_jobs:[],agent_version:id==='RenderRig'?'3.3.0':'2.2.0',...extra});
const task=(extra={})=>({unit:'phone253',check:'network-check',job_id:'fleet-health-fixture-network-check-native',state:'failed',output:'First output',error:'Connection failed',exit_code:7,...extra});
const saved=(tasks=[task()],extra={})=>({id:'fleet-health-fixture',created_at:new Date(NOW-60000).toISOString(),tasks,skipped:[],scope:'Existing report scope',...extra});
const receipt=(extra={})=>({job_id:'fleet-health-fixture-network-check-native',device_id:'phone253',exit_code:7,stdout:'First output',stderr:'Connection failed',...extra});
const healthyNetwork='site=curtbrag.com http=401 dns_s=0.001 connect_s=0.01 total_s=0.1';

function harness(options={}){
  const storage=options.storage||new Map(),calls=[],loads=[],exports=[],revoked=[],copied=[],storageWrites=[];
  if(Object.prototype.hasOwnProperty.call(options,'saved'))storage.set(KEY,JSON.stringify(options.saved));
  const elements=Object.fromEntries(['fleet-health-run','fleet-health-retry','fleet-health-export','fleet-health-state','fleet-health-report'].map(id=>[id,{id,disabled:false,textContent:''}]));
  let card=null,random=0,autoClicks=0;
  const register=element=>{if(element.id)elements[element.id]=element;for(const child of element.children||[])register(child);};
  function element(tag){
    return {tagName:tag.toUpperCase(),id:'',className:'',innerHTML:'',textContent:'',children:[],attributes:{},style:{},disabled:false,
      append(...children){for(const child of children){child.parent=this;this.children.push(child);register(child);}},
      remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);if(this.id)delete elements[this.id];this.removed=true;},
      setAttribute(name,value){this.attributes[name]=value;},
      querySelector:selector=>elements[selector.slice(1)]||null,
      focus(){this.focused=true;},select(){this.selected=true;},click(){autoClicks++;},
    };
  }
  elements['cluster-view-fleet']={prepend:value=>{card=value;elements['fleet-health']=value;}};
  const fresh=options.fresh===undefined?{nodes:options.nodes||[node()],results:options.results||[]}:options.fresh;
  class Clock extends Date{constructor(...args){super(...(args.length?args:[NOW]));}static now(){return NOW;}}
  const context=vm.createContext({
    IDS,Date:Clock,Math:Object.assign(Object.create(Math),{random:()=>0.123456+(random++)/10000}),
    DIAGNOSTIC_WINDOWS_AGENT:'3.3.0',DIAGNOSTIC_LINUX_AGENT:'2.2.0',
    DIAGNOSTIC_FALLBACK:{'storage-status':'df -hP "$HOME"','network-check':'curl -sS -o /dev/null --max-time 12 https://curtbrag.com/'},
    current:options.current||{nodes:[node()],results:[]},
    versionAtLeast:(a,r)=>{const x=String(a||'0.0.0').split('.').map(Number),y=r.split('.').map(Number);for(let i=0;i<3;i++){if((x[i]||0)>(y[i]||0))return true;if((x[i]||0)<(y[i]||0))return false;}return true;},
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storageWrites.push({key,value});storage.set(key,value);}},
    document:{getElementById:id=>elements[id]||null,createElement:element},
    navigator:{clipboard:{writeText:async value=>{if(options.clipboardDenied)throw new Error('Clipboard unavailable');copied.push(value);}}},
    Blob,URL:{createObjectURL:blob=>{exports.push(blob);return 'blob:fixture-'+exports.length;},revokeObjectURL:url=>revoked.push(url)},setTimeout:fn=>fn(),
    load:async force=>{loads.push(force);return options.load?options.load(loads.length):fresh;},
    swarmApi:async(...args)=>{calls.push(args);return options.api?options.api(...args):{ok:true};},
  });
  vm.runInContext(source+'\nglobalThis.api={ensureFleetHealth,renderFleetHealth,dispatchFleetHealth,retryFleetHealth,normalizeHealthRun,healthCanRetry,updateHealthButtons,openHealthExport,closeHealthExport,get:()=>healthRun,busy:()=>healthSubmitting};',context);
  return {api:context.api,elements,storage,storageWrites,calls,loads,exports,revoked,copied,autoClicks:()=>autoClicks,card:()=>card};
}

test('UI exposes explicit retry and exports the combined attempt history',async()=>{
  const h=harness({saved:saved()});h.api.ensureFleetHealth();
  assert.match(h.card().innerHTML,/Retry failed checks/);assert.equal(typeof h.elements['fleet-health-retry'].onclick,'function');
  assert.equal(h.elements['fleet-health-retry'].disabled,false);
  await h.elements['fleet-health-export'].onclick();
  const exported=JSON.parse(await h.exports.find(value=>value instanceof Blob).text());
  assert.equal(exported.tasks[0].attempts.length,1);assert.equal(exported.tasks[0].attempts[0].output,'First output');
});

test('retry sends only confirmed failures and preserves successful checks and earlier output',async()=>{
  const passed=task({unit:'phone191',check:'storage-status',job_id:'passed-storage',state:'passed',exit_code:0,output:'Healthy disk',error:''});
  const h=harness({saved:saved([task(),passed]),nodes:[node(),node('phone191')]});
  await h.api.retryFleetHealth();assert.equal(h.calls.length,1);
  const body=h.calls[0][2];assert.equal(body.job.type,'network-check');assert.deepEqual(plain(body.target_device_ids),['phone253']);
  const report=plain(h.api.get());assert.equal(report.tasks[0].attempts.length,2);assert.equal(report.tasks[0].attempts[0].output,'First output');
  assert.equal(report.tasks[0].attempts[0].error,'Connection failed');assert.equal(report.tasks[0].state,'queued');
  assert.equal(report.tasks[1].state,'passed');assert.equal(report.tasks[1].output,'Healthy disk');assert.equal(report.tasks[1].attempts.length,1);
});

test('queued, submitting and uncertain checks are never replayed by retries',async()=>{
  const tasks=['queued','submitting','unconfirmed'].map((state,i)=>task({unit:['phone191','phone195','phone253'][i],state,exit_code:null,job_id:'pending-'+i}));
  const h=harness({saved:saved(tasks),nodes:[node('phone191'),node('phone195'),node()]});await h.api.retryFleetHealth();
  assert.equal(h.calls.length,0);assert.deepEqual(plain(h.api.get().tasks.map(t=>t.state)),['queued','submitting','unconfirmed']);
});

test('initial batches use native checks or fixed Linux fallback and skip unsupported Windows agents',async()=>{
  const h=harness({nodes:[node(),node('Nexus',{agent_version:'2.1.1'}),node('RenderRig',{agent_version:'3.2.0'}),node('unknown')]});
  await h.api.dispatchFleetHealth();assert.equal(h.calls.length,4);
  assert.deepEqual(h.calls.map(c=>c[2].job.type),['storage-status','shell','network-check','shell']);
  for(const call of h.calls){assert.equal(call[0],'enqueue');assert.equal(call[1],'POST');assert.ok(call[2].target_device_ids.every(id=>['phone253','Nexus'].includes(id)));}
  assert.match(h.calls[1][2].job.cmd,/^df -hP/);assert.match(h.calls[3][2].job.cmd,/^curl /);
  assert.equal(h.api.get().tasks.length,4);assert.deepEqual(plain(h.api.get().skipped),[{unit:'RenderRig',reason:'agent update required'}]);
});

test('legacy Linux agent failures retry through the correct fixed fallback only',async()=>{
  for(const check of ['storage-status','network-check']){
    const h=harness({saved:saved([task({check})]),nodes:[node('phone253',{agent_version:'2.1.0'})]});await h.api.retryFleetHealth();
    assert.equal(h.calls.length,1);const job=h.calls[0][2].job;assert.equal(job.type,'shell');assert.equal(job.cmd,job.command);
    assert.match(job.cmd,check==='storage-status'?/^df /:/^curl /);
  }
});

test('offline, busy, active-job and outdated Windows failures stay failed with a visible skip reason',async()=>{
  for(const [unit,worker,reason] of [
    ['phone253',node('phone253',{online:false}),'offline'],['phone253',node('phone253',{busy:true}),'busy'],
    ['phone253',node('phone253',{active_jobs:['other-job']}),'busy'],['RenderRig',node('RenderRig',{agent_version:'3.2.0'}),'agent update required'],
  ]){
    const h=harness({saved:saved([task({unit})]),nodes:[worker]});await h.api.retryFleetHealth();
    assert.equal(h.calls.length,0);assert.equal(h.api.get().tasks[0].state,'failed');assert.equal(h.api.get().tasks[0].attempts.length,1);
    assert.equal(h.api.get().tasks[0].retry_skip_reason,reason);assert.match(h.elements['fleet-health-report'].textContent,new RegExp(reason));
  }
});

test('a third failure reaches the cap and additional retry clicks preserve counts and history',async()=>{
  const h=harness({saved:saved()});await h.api.retryFleetHealth();
  let latest=h.api.get().tasks[0].job_id;h.api.renderFleetHealth([receipt({job_id:latest})]);await h.api.retryFleetHealth();
  latest=h.api.get().tasks[0].job_id;h.api.renderFleetHealth([receipt({job_id:latest})]);
  const before=plain(h.api.get());await h.api.retryFleetHealth();await h.api.retryFleetHealth();
  assert.equal(h.calls.length,2);assert.deepEqual(plain(h.api.get()),before);assert.equal(h.api.get().tasks[0].attempts.length,3);
  assert.match(h.elements['fleet-health-report'].textContent,/retry limit reached/);assert.equal(h.elements['fleet-health-retry'].disabled,true);
  assert.equal(new Set(h.api.get().tasks[0].attempts.map(a=>a.job_id)).size,3);
});

test('old out-of-order receipts cannot overwrite the latest retry state or output',async()=>{
  const h=harness({saved:saved()});await h.api.retryFleetHealth();const latest=h.api.get().tasks[0].job_id;
  h.api.renderFleetHealth([receipt({exit_code:0,stdout:'Old success'}),receipt({job_id:latest,exit_code:0,stdout:healthyNetwork,stderr:''})]);
  assert.equal(h.api.get().tasks[0].state,'passed');assert.equal(h.api.get().tasks[0].output,healthyNetwork);
  h.api.renderFleetHealth([receipt({exit_code:99,stdout:'Old late failure'}),receipt({job_id:latest,exit_code:9,stdout:'Contradictory duplicate'})]);
  assert.equal(h.api.get().tasks[0].state,'passed');assert.equal(h.api.get().tasks[0].output,healthyNetwork);assert.equal(h.api.get().tasks[0].attempts[0].output,'First output');
});

test('receipts require matching worker and job identity',async()=>{
  const h=harness({saved:saved([task({state:'queued',exit_code:null})])});
  h.api.renderFleetHealth([receipt({job_id:'other-job',exit_code:0}),receipt({device_id:'phone191',exit_code:0})]);
  assert.equal(h.api.get().tasks[0].state,'queued');
});

test('null, empty, string, boolean and fractional exit codes never pass and block replay',async()=>{
  for(const exit_code of [null,undefined,'',false,true,'0','7',0.5,NaN,Infinity]){
    const h=harness({saved:saved([task({state:'queued',exit_code:null})])});
    h.api.renderFleetHealth([receipt({exit_code})]);assert.equal(h.api.get().tasks[0].state,'unconfirmed',String(exit_code));
    assert.equal(h.api.get().tasks[0].exit_code,null);assert.match(h.elements['fleet-health-report'].textContent,/invalid exit status/);
    await h.api.retryFleetHealth();assert.equal(h.calls.length,0);
    await h.api.dispatchFleetHealth();assert.equal(h.calls.length,0);assert.match(h.elements['fleet-health-state'].textContent,/pending checks/);
  }
});

test('a later valid numeric receipt can resolve an uncertain result without replay',()=>{
  const h=harness({saved:saved([task({state:'queued',exit_code:null})])});
  h.api.renderFleetHealth([receipt({exit_code:null})]);h.api.renderFleetHealth([receipt({exit_code:0,stdout:healthyNetwork})]);
  assert.equal(h.api.get().tasks[0].state,'passed');assert.equal(h.api.get().tasks[0].output,healthyNetwork);assert.equal(h.calls.length,0);
});

test('legacy failed reports without a numeric receipt show why retry is unavailable',async()=>{
  const old=task();delete old.exit_code;const h=harness({saved:saved([old])});h.api.renderFleetHealth([]);
  assert.equal(h.api.get().tasks[0].state,'failed');assert.match(h.elements['fleet-health-report'].textContent,/older failure has no confirmed numeric receipt/);
  assert.equal(h.elements['fleet-health-retry'].disabled,true);await h.api.retryFleetHealth();assert.equal(h.calls.length,0);
  assert.equal(h.api.get().tasks[0].output,'First output');
});

test('fresh matching numeric failure safely enables one legacy retry',async()=>{
  const old=task();delete old.exit_code;const h=harness({saved:saved([old]),results:[receipt()]});
  await h.api.retryFleetHealth();assert.equal(h.calls.length,1);assert.equal(h.api.get().tasks[0].attempts.length,2);
  assert.equal(h.api.get().tasks[0].attempts[0].exit_code,7);
});

test('legacy success without a numeric receipt stays unconfirmed and saved attempt history survives reload',async()=>{
  const passed=task({unit:'phone191',state:'passed',output:'Saved success'});delete passed.exit_code;
  const h=harness({saved:saved([task(),passed]),nodes:[node(),node('phone191')]});await h.api.retryFleetHealth();
  const reloaded=harness({storage:h.storage});assert.equal(reloaded.api.get().tasks[1].state,'unconfirmed');assert.equal(reloaded.api.get().tasks[1].output,'Saved success');
  assert.equal(reloaded.api.get().tasks[0].attempts.length,2);assert.equal(reloaded.api.get().tasks[0].attempts[0].error,'Connection failed');
});

test('migration rejects arbitrary checks and units, deduplicates rows and bounds oversized attempt history',async()=>{
  const repeated={...task(),attempts:Array.from({length:5},(_,i)=>({...task(),job_id:'attempt-'+i}))};
  const h=harness({saved:saved([repeated,task(),task({unit:'unknown'}),task({unit:'phone191',check:'shell'})])});
  assert.equal(h.api.get().tasks.length,1);assert.equal(h.api.get().tasks[0].attempts.length,3);assert.equal(h.api.get().tasks[0].attempt_limit_reached,true);
  await h.api.retryFleetHealth();assert.equal(h.calls.length,0);
});

test('saved batch and job identifiers are bounded before any retry submission',async()=>{
  for(const invalid of [saved([task()],{id:'other-id'}),saved([task()],{id:'fleet-health-'+ 'x'.repeat(121)}),saved([task({job_id:'unsafe;command'})])]){
    const h=harness({saved:invalid});await h.api.retryFleetHealth();assert.equal(h.calls.length,0);
  }
  const h=harness({saved:saved([task()],{id:'fleet-health-'+ 'x'.repeat(120)})});await h.api.retryFleetHealth();
  assert.equal(h.calls.length,1);assert.ok(h.calls[0][2].job.id.length<=220);
});

test('fresh load failure never reuses stale workers for new checks or retries',async()=>{
  for(const retry of [false,true]){
    const h=harness({saved:saved(),fresh:null,current:{nodes:[node()],results:[]}});const before=plain(h.api.get());
    await (retry?h.api.retryFleetHealth():h.api.dispatchFleetHealth());assert.equal(h.calls.length,0);assert.deepEqual(plain(h.api.get()),before);
    assert.match(h.elements['fleet-health-state'].textContent,/Fresh worker status is unavailable/);
  }
});

test('a stale passed view cannot replace pending checks with a new batch',async()=>{
  const h=harness({saved:saved([task({state:'queued',exit_code:null})])});const before=plain(h.api.get());
  await h.api.dispatchFleetHealth();assert.equal(h.calls.length,0);assert.deepEqual(plain(h.api.get()),before);
  assert.match(h.elements['fleet-health-state'].textContent,/pending checks/);assert.equal(h.elements['fleet-health-run'].disabled,true);
});

test('partial uncertain retry dispatch preserves completed submissions and does not replay them',async()=>{
  const tasks=[task(),task({unit:'phone191',job_id:'failed-191'}),task({unit:'phone195',job_id:'failed-195'})];
  const h=harness({saved:saved(tasks),nodes:[node(),node('phone191'),node('phone195')],api:async()=>{if(h.calls.length===2)throw new Error('Timeout');return {ok:true};}});
  await h.api.retryFleetHealth();assert.equal(h.calls.length,2);assert.deepEqual(plain(h.api.get().tasks.map(t=>t.state)),['queued','unconfirmed','failed']);
  assert.deepEqual(plain(h.api.get().tasks.map(t=>t.attempts.length)),[2,2,1]);assert.match(h.elements['fleet-health-report'].textContent,/unconfirmed/);
  await h.api.retryFleetHealth();assert.equal(h.calls.length,3);assert.deepEqual(plain(h.api.get().tasks.map(t=>t.attempts.length)),[2,2,2]);
});

test('partial initial enqueue uncertainty prevents a replacement batch and automatic replay',async()=>{
  const h=harness({api:async()=>{throw new Error('Timeout');}});await h.api.dispatchFleetHealth();assert.equal(h.calls.length,1);
  assert.equal(h.api.get().tasks[0].state,'unconfirmed');await h.api.dispatchFleetHealth();await h.api.retryFleetHealth();assert.equal(h.calls.length,1);
});

test('both dispatch buttons and export stay disabled during an outstanding submission',async()=>{
  let release;const wait=new Promise(resolve=>{release=resolve;});
  const h=harness({saved:saved(),api:async()=>wait});const pending=h.api.retryFleetHealth();await new Promise(resolve=>setImmediate(resolve));
  for(const id of ['fleet-health-run','fleet-health-retry','fleet-health-export'])assert.equal(h.elements[id].disabled,true,id);
  await h.api.retryFleetHealth();await h.api.dispatchFleetHealth();assert.equal(h.calls.length,1);
  release({ok:true});await pending;assert.equal(h.api.busy(),false);assert.equal(h.elements['fleet-health-export'].disabled,false);
  assert.equal(h.elements['fleet-health-run'].disabled,true);assert.equal(h.elements['fleet-health-retry'].disabled,true);
});

test('no eligible failures do not change successful counts, outputs or attempt history',async()=>{
  const h=harness({saved:saved([task({state:'passed',exit_code:0,output:healthyNetwork,error:''})])});const before=plain(h.api.get());
  await h.api.retryFleetHealth();assert.equal(h.calls.length,0);assert.deepEqual(plain(h.api.get()),before);
  assert.match(h.elements['fleet-health-report'].textContent,/passed · attempt 1\/3/);
});

function exportParts(h){
  const panel=h.elements['fleet-health-export-panel'];assert.ok(panel,'Visible export panel exists');
  const details=panel.children.find(e=>e.tagName==='DETAILS');
  return {panel,details,data:details.children.find(e=>e.tagName==='TEXTAREA'),
    heading:panel.children.find(e=>e.tagName==='H4'),download:panel.children.find(e=>e.tagName==='A'),
    copy:panel.children.find(e=>e.textContent==='Copy report data'),close:panel.children.find(e=>e.textContent==='Close export'),
    status:panel.children.find(e=>e.attributes.role==='status')};
}

test('export opens a visible immutable JSON snapshot with explicit download and complete attempts',async()=>{
  const h=harness({saved:saved()});h.api.ensureFleetHealth();await h.api.retryFleetHealth();
  const original=h.api.get(),before=plain(original),calls=h.calls.length;
  h.elements['fleet-health-export'].onclick();const parts=exportParts(h),snapshot=JSON.parse(parts.data.value);
  assert.equal(parts.heading.textContent,'Combined health report');assert.equal(parts.heading.tabIndex,-1);assert.equal(parts.heading.focused,true);assert.equal(parts.download.textContent,'Download report');
  assert.equal(parts.download.download,before.id+'.json');assert.match(parts.download.href,/^blob:fixture-/);
  assert.equal(parts.details.children[0].textContent,'Report data');assert.equal(parts.data.readOnly,true);
  assert.equal(parts.data.attributes['aria-label'],'Complete health report JSON');assert.deepEqual(snapshot,before);
  assert.equal(snapshot.tasks[0].attempts.length,2);assert.equal(snapshot.tasks[0].attempts[0].job_id,'fleet-health-fixture-network-check-native');
  assert.equal(snapshot.tasks[0].attempts[1].job_id,h.calls[0][2].job.id);assert.equal(snapshot.tasks[0].attempts[0].error,'Connection failed');
  assert.equal(h.api.get(),original);assert.equal(h.calls.length,calls);assert.equal(h.autoClicks(),0);
  assert.deepEqual(JSON.parse(await h.exports.at(-1).text()),snapshot);
  h.api.renderFleetHealth([receipt({job_id:before.tasks[0].job_id,exit_code:0,stdout:healthyNetwork,stderr:''})]);
  assert.equal(h.api.get().tasks[0].state,'passed');assert.deepEqual(JSON.parse(parts.data.value),snapshot);
});

test('closing and reopening export remove old panels and revoke their report URLs',()=>{
  const h=harness({saved:saved()});h.api.ensureFleetHealth();h.api.openHealthExport();
  const first=exportParts(h),url=first.download.href;first.close.onclick();
  assert.equal(first.panel.removed,true);assert.equal(h.elements['fleet-health-export-panel'],undefined);assert.deepEqual(h.revoked,[url]);
  h.api.openHealthExport();const second=exportParts(h);assert.notEqual(second.download.href,url);assert.equal(h.card().children.length,1);
  h.api.openHealthExport();const third=exportParts(h);assert.equal(second.panel.removed,true);assert.equal(h.card().children.length,1);
  assert.deepEqual(h.revoked,[url,second.download.href]);third.close.onclick();h.api.closeHealthExport();
  assert.deepEqual(h.revoked,[url,second.download.href,third.download.href]);assert.equal(h.card().children.length,0);assert.equal(h.autoClicks(),0);
});

test('copy exports the exact report snapshot through the clipboard without rerunning workers',async()=>{
  const h=harness({saved:saved()});h.api.ensureFleetHealth();h.api.openHealthExport();const parts=exportParts(h);
  await parts.copy.onclick();assert.deepEqual(h.copied,[parts.data.value]);assert.equal(parts.status.textContent,'Report data copied.');
  assert.equal(parts.copy.disabled,false);assert.equal(h.calls.length,0);assert.equal(h.autoClicks(),0);
});

test('clipboard denial opens report data and selects the complete read-only JSON as a fallback',async()=>{
  const h=harness({saved:saved(),clipboardDenied:true});h.api.ensureFleetHealth();h.api.openHealthExport();const parts=exportParts(h);
  await parts.copy.onclick();assert.equal(parts.details.open,true);assert.equal(parts.data.focused,true);assert.equal(parts.data.selected,true);
  assert.equal(parts.data.readOnly,true);assert.deepEqual(JSON.parse(parts.data.value),plain(h.api.get()));
  assert.match(parts.status.textContent,/Report data is selected/);assert.equal(parts.copy.disabled,false);assert.deepEqual(h.copied,[]);assert.equal(h.calls.length,0);
});

test('export stays available for queued work but is blocked while submission is changing the report',async()=>{
  let release;const wait=new Promise(resolve=>{release=resolve;});
  const h=harness({saved:saved(),api:async()=>wait});h.api.ensureFleetHealth();const dispatch=h.api.retryFleetHealth();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(h.api.busy(),true);assert.equal(h.elements['fleet-health-export'].disabled,true);
  h.api.openHealthExport();h.elements['fleet-health-export'].onclick();assert.equal(h.exports.length,0);assert.equal(h.elements['fleet-health-export-panel'],undefined);
  release({ok:true});await dispatch;assert.equal(h.api.get().tasks[0].state,'queued');assert.equal(h.elements['fleet-health-export'].disabled,false);
  h.elements['fleet-health-export'].onclick();assert.equal(JSON.parse(exportParts(h).data.value).tasks[0].state,'queued');assert.equal(h.calls.length,1);
});

test('export displays report content as text and does not replace or modify the saved report',()=>{
  const h=harness({saved:saved([task({output:'<img src=x onerror="run()"> & plain report text'})])});h.api.ensureFleetHealth();
  const original=h.api.get(),stored=h.storage.get(KEY);h.api.openHealthExport();const parts=exportParts(h);
  assert.ok(parts.data.value.includes('<img src=x onerror=\\"run()\\">'));assert.equal(parts.data.innerHTML,'');
  assert.equal(h.api.get(),original);assert.equal(h.storage.get(KEY),stored);assert.equal(h.calls.length,0);
});

const curlStatus=status=>'site=curtbrag.com http='+String(status).padStart(3,'0')+' dns_s=0.001 connect_s=0.01 total_s=0.1';
const windowsStatus=status=>JSON.stringify({site:'curtbrag.com',http:status,total_ms:68,reachable:true,protected:status===401});
function queuedHealth(){return harness({saved:saved([task({state:'queued',exit_code:null,output:'',error:''})])});}

test('zero-exit HTTP 503 is failed while its raw receipt and stderr remain intact',()=>{
  const h=queuedHealth(),stdout=curlStatus(503),stderr='curl diagnostic warning';
  h.api.renderFleetHealth([receipt({exit_code:0,stdout,stderr})]);
  const actual=h.api.get().tasks[0],attempt=actual.attempts[0];
  assert.equal(actual.state,'failed');assert.equal(actual.http_status,503);assert.match(actual.health_error,/HTTP 503/);
  for(const record of [actual,attempt]){
    assert.equal(record.exit_code,0);assert.equal(record.output,stdout);assert.equal(record.error,stderr);
  }
  assert.equal(h.api.healthCanRetry(actual),true);assert.equal(h.elements['fleet-health-retry'].disabled,false);
  assert.match(h.elements['fleet-health-state'].textContent,/1\/1 checks returned · 1 failed · 1 can retry/);
  assert.equal(h.calls.length,0);
});

test('canonical Linux and Windows site receipts pass only successful redirects or expected private 401',()=>{
  for(const status of [200,204,299,300,301,399,401])for(const format of [curlStatus,windowsStatus]){
    const h=queuedHealth(),stdout=format(status);h.api.renderFleetHealth([receipt({exit_code:0,stdout,stderr:''})]);
    const actual=h.api.get().tasks[0];assert.equal(actual.state,'passed',stdout);assert.equal(actual.http_status,status);
    assert.equal(actual.health_error,'');assert.equal(actual.exit_code,0);assert.equal(actual.output,stdout);
    assert.equal(h.api.healthCanRetry(actual),false);assert.equal(h.elements['fleet-health-retry'].disabled,true);
  }
});

test('zero-exit HTTP failures including 000 remain confirmed failures in both worker formats',()=>{
  for(const status of [0,100,199,400,402,403,404,429,500,503,504,999])for(const format of [curlStatus,windowsStatus]){
    const h=queuedHealth(),stdout=format(status);h.api.renderFleetHealth([receipt({exit_code:0,stdout,stderr:''})]);
    const actual=h.api.get().tasks[0];assert.equal(actual.state,'failed',stdout);assert.equal(actual.http_status,status);
    assert.equal(actual.exit_code,0);assert.equal(actual.output,stdout);assert.match(actual.health_error,/expected HTTP 200–399/);
    assert.equal(h.api.healthCanRetry(actual),true,stdout);
  }
});

test('nonzero numeric process failure is retained even when HTTP succeeds or cannot be parsed',()=>{
  for(const stdout of [curlStatus(401),windowsStatus(200),'no HTTP result']){
    const h=queuedHealth();h.api.renderFleetHealth([receipt({exit_code:7,stdout,stderr:'Connection failed'})]);
    const actual=h.api.get().tasks[0];assert.equal(actual.state,'failed');assert.equal(actual.exit_code,7);
    assert.equal(actual.output,stdout);assert.equal(actual.error,'Connection failed');assert.equal(actual.health_error,'');
    assert.equal(h.api.healthCanRetry(actual),true);
  }
});

test('missing malformed embedded foreign or ambiguous HTTP reports remain unconfirmed with no replay',async()=>{
  const outputs=[
    '', 'HTTP 200', 'prefix site=curtbrag.com http=200', ' site=curtbrag.com http=200',
    'site=example.com http=200', 'site=curtbrag.com.evil.test http=200', 'site=curtbrag.com http=20',
    'site=curtbrag.com http=2000', 'site=curtbrag.com http=200http=503',
    curlStatus(200)+'\n'+curlStatus(503),curlStatus(200)+'\n '+curlStatus(200),
    curlStatus(200)+' http=503',curlStatus(200)+' site=example.com',curlStatus(200)+'\n'+windowsStatus(401),
    '{"site":"curtbrag.com","http":', '[{"site":"curtbrag.com","http":200}]',
    '{"site":"example.com","http":200}', '{"site":"curtbrag.com","http":"401"}',
    '{"site":"curtbrag.com","http":true}', '{"site":"curtbrag.com","http":200.5}',
    '{"site":"curtbrag.com","http":-1}', '{"site":"curtbrag.com","http":1000}',
    '{"site":"curtbrag.com","http":null}', '{"http":200}', '{"site":"curtbrag.com"}',
    '{"nested":{"site":"curtbrag.com","http":200}}',
  ];
  for(const stdout of outputs){
    const h=queuedHealth();h.api.renderFleetHealth([receipt({exit_code:0,stdout,stderr:'raw warning'})]);
    const actual=h.api.get().tasks[0];assert.equal(actual.state,'unconfirmed',stdout);assert.equal(actual.http_status,null);
    assert.equal(actual.exit_code,0);assert.equal(actual.output,stdout);assert.equal(actual.error,'raw warning');
    assert.match(actual.health_error,/missing, malformed or ambiguous/);assert.equal(h.api.healthCanRetry(actual),false);
    await h.api.retryFleetHealth();await h.api.dispatchFleetHealth();assert.equal(h.calls.length,0,stdout);
  }
});

test('duplicate JSON status or site keys including escaped names can never hide an HTTP failure',()=>{
  for(const stdout of [
    '{"site":"curtbrag.com","http":503,"http":401}',
    '{"site":"example.com","site":"curtbrag.com","http":401}',
    '{"site":"curtbrag.com","http":401,"http":401}',
    '{"site":"curtbrag.com","http":503,"h\\u0074tp":401}',
    '{"site":"example.com","si\\u0074e":"curtbrag.com","http":401}',
  ]){
    const h=queuedHealth();h.api.renderFleetHealth([receipt({exit_code:0,stdout,stderr:''})]);
    assert.equal(h.api.get().tasks[0].state,'unconfirmed',stdout);assert.equal(h.api.get().tasks[0].http_status,null);
    assert.equal(h.api.healthCanRetry(h.api.get().tasks[0]),false);
  }
});

test('JSON key detection ignores nested metadata and quoted punctuation in Windows output',()=>{
  const stdout=JSON.stringify({site:'curtbrag.com',http:401,metadata:{site:'elsewhere',http:503},note:'a quoted "http":503 value and } punctuation'});
  const h=queuedHealth();h.api.renderFleetHealth([receipt({exit_code:0,stdout,stderr:''})]);
  assert.equal(h.api.get().tasks[0].state,'passed');assert.equal(h.api.get().tasks[0].http_status,401);
});

test('explicit retry enqueues a known zero-exit HTTP failure exactly once and preserves its first receipt',async()=>{
  const first=task({state:'passed',exit_code:0,output:curlStatus(503),error:'raw first warning'});
  const h=harness({saved:saved([first])}),before=plain(h.api.get().tasks[0].attempts[0]);
  assert.equal(before.state,'failed');await h.api.retryFleetHealth();assert.equal(h.calls.length,1);
  assert.equal(h.calls[0][2].job.type,'network-check');assert.deepEqual(plain(h.calls[0][2].target_device_ids),['phone253']);
  assert.deepEqual(plain(h.api.get().tasks[0].attempts[0]),before);assert.equal(h.api.get().tasks[0].attempts.length,2);
  await h.api.retryFleetHealth();assert.equal(h.calls.length,1);assert.equal(h.api.get().tasks[0].state,'queued');
  const latest=h.api.get().tasks[0].job_id;h.api.renderFleetHealth([receipt({job_id:latest,exit_code:0,stdout:windowsStatus(401),stderr:''})]);
  assert.equal(h.api.get().tasks[0].state,'passed');assert.deepEqual(plain(h.api.get().tasks[0].attempts[0]),before);
});

test('three confirmed HTTP failures exhaust retries without treating their numeric zero as success',async()=>{
  const h=harness({saved:saved([task({state:'failed',exit_code:0,output:curlStatus(503),error:''})])});
  for(let attempt=2;attempt<=3;attempt++){
    await h.api.retryFleetHealth();const actual=h.api.get().tasks[0];
    h.api.renderFleetHealth([receipt({job_id:actual.job_id,exit_code:0,stdout:windowsStatus(503),stderr:''})]);
    assert.equal(actual.state,'failed');assert.equal(actual.attempts.length,attempt);
  }
  const before=plain(h.api.get());await h.api.retryFleetHealth();await h.api.retryFleetHealth();
  assert.equal(h.calls.length,2);assert.deepEqual(plain(h.api.get()),before);
  assert.equal(h.api.healthCanRetry(h.api.get().tasks[0]),false);assert.match(h.elements['fleet-health-report'].textContent,/retry limit reached/);
});

test('saved terminal HTTP false passes are corrected and persisted once without submitting jobs',()=>{
  const h=harness({saved:saved([task({state:'passed',exit_code:0,output:curlStatus(503),error:'Original stderr',http_status:401,health_error:'old label'})])});
  assert.equal(h.api.get().tasks[0].state,'failed');assert.equal(h.storageWrites.length,0);
  h.api.renderFleetHealth([]);const stored=JSON.parse(h.storage.get(KEY));
  assert.equal(stored.tasks[0].state,'failed');assert.equal(stored.tasks[0].http_status,503);
  assert.equal(stored.tasks[0].attempts[0].exit_code,0);assert.equal(stored.tasks[0].attempts[0].error,'Original stderr');
  assert.equal(h.storageWrites.length,1);assert.equal(h.calls.length,0);
  const snapshot=h.storage.get(KEY),view=h.elements['fleet-health-report'].textContent;
  for(let i=0;i<5;i++)h.api.renderFleetHealth([]);
  assert.equal(h.storageWrites.length,1);assert.equal(h.storage.get(KEY),snapshot);assert.equal(h.elements['fleet-health-report'].textContent,view);
  const reload=harness({storage:h.storage});reload.api.renderFleetHealth([]);
  assert.equal(reload.api.get().tasks[0].state,'failed');assert.equal(reload.storageWrites.length,0);assert.equal(reload.calls.length,0);
});

test('render rederives a terminal result from its raw receipt without trusting saved HTTP fields or late duplicates',()=>{
  const h=harness({saved:saved([task({state:'passed',exit_code:0,output:curlStatus(401),error:'keep raw'})])});h.api.renderFleetHealth([]);
  const actual=h.api.get().tasks[0],attempt=actual.attempts[0];
  attempt.output=curlStatus(503);attempt.http_status=401;attempt.health_error='';
  h.api.renderFleetHealth([receipt({exit_code:0,stdout:curlStatus(200),stderr:'contradictory later duplicate'})]);
  assert.equal(actual.state,'failed');assert.equal(actual.http_status,503);assert.equal(actual.output,curlStatus(503));assert.equal(actual.error,'keep raw');
  assert.equal(h.calls.length,0);assert.equal(h.api.healthCanRetry(actual),true);
});

test('retry authority is rederived from the latest raw receipt and never from stored HTTP labels',()=>{
  const h=harness({saved:saved()});const base=plain(h.api.get().tasks[0]);
  for(const [state,exit_code,output] of [
    ['failed',0,curlStatus(401)],['failed',0,'no HTTP receipt'],['unconfirmed',0,curlStatus(503)],['failed',null,curlStatus(503)],
  ]){
    const forged={...base,state:'failed',exit_code:7,http_status:503,health_error:'failed',attempts:[{...base.attempts[0],state,exit_code,output,http_status:503,health_error:'failed'}]};
    assert.equal(h.api.healthCanRetry(forged),false,JSON.stringify({state,exit_code,output}));
  }
  const known={...base,state:'failed',http_status:401,attempts:[{...base.attempts[0],state:'failed',exit_code:0,output:curlStatus(503),http_status:401,health_error:''}]};
  assert.equal(h.api.healthCanRetry(known),true);
});

test('a complete saved 26-check report corrects only its HTTP 503 false pass without a new fleet batch',()=>{
  const tasks=[...IDS].flatMap(unit=>['storage-status','network-check'].map(check=>task({
    unit,check,job_id:'fleet-health-'+unit+'-'+check,state:'passed',exit_code:0,error:'',
    output:check==='storage-status'?'Filesystem size available':unit==='Alina'?curlStatus(503):windowsStatus(401),
  })));
  const h=harness({saved:saved(tasks)});h.api.renderFleetHealth([]);
  assert.equal(h.api.get().tasks.length,26);assert.equal(h.api.get().tasks.filter(t=>t.state==='failed').length,1);
  assert.equal(h.api.get().tasks.filter(t=>t.state==='passed').length,25);
  const failed=h.api.get().tasks.find(t=>t.state==='failed');assert.equal(failed.unit,'Alina');assert.equal(failed.check,'network-check');
  assert.equal(failed.http_status,503);assert.equal(failed.exit_code,0);assert.equal(failed.attempts.length,1);
  assert.match(h.elements['fleet-health-state'].textContent,/26\/26 checks returned · 1 failed · 1 can retry/);assert.equal(h.calls.length,0);
});

test('repeated matching unknown receipts retain raw evidence and render idempotently until a valid receipt arrives',()=>{
  const h=queuedHealth(),unknown=receipt({exit_code:0,stdout:'HTTP report unavailable',stderr:'one raw warning'});
  h.api.renderFleetHealth([unknown]);const before=plain(h.api.get()),writes=h.storageWrites.length,view=h.elements['fleet-health-report'].textContent;
  for(let i=0;i<5;i++)h.api.renderFleetHealth([unknown]);
  assert.deepEqual(plain(h.api.get()),before);assert.equal(h.storageWrites.length,writes);assert.equal(h.elements['fleet-health-report'].textContent,view);
  assert.equal(h.api.get().tasks[0].error,'one raw warning');assert.equal((view.match(/missing, malformed or ambiguous/g)||[]).length,1);
  h.api.renderFleetHealth([receipt({exit_code:0,stdout:windowsStatus(401),stderr:''})]);
  assert.equal(h.api.get().tasks[0].state,'passed');assert.equal(h.api.get().tasks[0].health_error,'');assert.equal(h.calls.length,0);
});

test('saved uncertain submissions with raw HTTP failures remain uncertain until a matching receipt resolves them',async()=>{
  const h=harness({saved:saved([task({state:'unconfirmed',exit_code:0,output:curlStatus(503),error:'kept',http_status:503})])});
  h.api.renderFleetHealth([]);assert.equal(h.api.get().tasks[0].state,'unconfirmed');assert.equal(h.api.get().tasks[0].http_status,503);
  await h.api.retryFleetHealth();assert.equal(h.calls.length,0);assert.equal(h.api.get().tasks[0].attempts.length,1);
  h.api.renderFleetHealth([receipt({exit_code:0,stdout:curlStatus(503),stderr:'kept'})]);
  assert.equal(h.api.get().tasks[0].state,'failed');assert.equal(h.api.healthCanRetry(h.api.get().tasks[0]),true);assert.equal(h.calls.length,0);
});

test('export preserves raw zero-exit HTTP failure plus a successful retry and its separate derived fields',async()=>{
  const h=harness({saved:saved([task({state:'passed',exit_code:0,output:curlStatus(503),error:'raw stderr'})])});h.api.ensureFleetHealth();
  await h.api.retryFleetHealth();const job_id=h.api.get().tasks[0].job_id;
  h.api.renderFleetHealth([receipt({job_id,exit_code:0,stdout:windowsStatus(401),stderr:''})]);h.api.openHealthExport();
  const exported=JSON.parse(exportParts(h).data.value),history=exported.tasks[0].attempts;
  assert.equal(exported.tasks[0].state,'passed');assert.equal(history.length,2);
  assert.equal(history[0].state,'failed');assert.equal(history[0].exit_code,0);assert.equal(history[0].output,curlStatus(503));assert.equal(history[0].error,'raw stderr');
  assert.equal(history[0].http_status,503);assert.match(history[0].health_error,/HTTP 503/);
  assert.equal(history[1].state,'passed');assert.equal(history[1].exit_code,0);assert.equal(history[1].http_status,401);assert.equal(history[1].health_error,'');
  assert.equal(h.calls.length,1);assert.deepEqual(JSON.parse(await h.exports.at(-1).text()),exported);
});
