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

function harness(options={}){
  const storage=options.storage||new Map(),calls=[],loads=[],exports=[];
  if(Object.prototype.hasOwnProperty.call(options,'saved'))storage.set(KEY,JSON.stringify(options.saved));
  const elements=Object.fromEntries(['fleet-health-run','fleet-health-retry','fleet-health-export','fleet-health-state','fleet-health-report'].map(id=>[id,{id,disabled:false,textContent:''}]));
  let card=null,random=0;
  elements['cluster-view-fleet']={prepend:value=>{card=value;elements['fleet-health']=value;}};
  const fresh=options.fresh===undefined?{nodes:options.nodes||[node()],results:options.results||[]}:options.fresh;
  class Clock extends Date{constructor(...args){super(...(args.length?args:[NOW]));}static now(){return NOW;}}
  const context=vm.createContext({
    IDS,Date:Clock,Math:Object.assign(Object.create(Math),{random:()=>0.123456+(random++)/10000}),
    DIAGNOSTIC_WINDOWS_AGENT:'3.3.0',DIAGNOSTIC_LINUX_AGENT:'2.2.0',
    DIAGNOSTIC_FALLBACK:{'storage-status':'df -hP "$HOME"','network-check':'curl -sS -o /dev/null --max-time 12 https://curtbrag.com/'},
    current:options.current||{nodes:[node()],results:[]},
    versionAtLeast:(a,r)=>{const x=String(a||'0.0.0').split('.').map(Number),y=r.split('.').map(Number);for(let i=0;i<3;i++){if((x[i]||0)>(y[i]||0))return true;if((x[i]||0)<(y[i]||0))return false;}return true;},
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},
    document:{getElementById:id=>elements[id]||null,createElement:tag=>tag==='section'?{id:'',className:'',innerHTML:'',querySelector:selector=>elements[selector.slice(1)]}:{click(){exports.push(this);}}},
    Blob,URL:{createObjectURL:blob=>{exports.push(blob);return 'blob:fixture';},revokeObjectURL(){}},setTimeout:fn=>fn(),
    load:async force=>{loads.push(force);return options.load?options.load(loads.length):fresh;},
    swarmApi:async(...args)=>{calls.push(args);return options.api?options.api(...args):{ok:true};},
  });
  vm.runInContext(source+'\nglobalThis.api={ensureFleetHealth,renderFleetHealth,dispatchFleetHealth,retryFleetHealth,normalizeHealthRun,healthCanRetry,updateHealthButtons,get:()=>healthRun,busy:()=>healthSubmitting};',context);
  return {api:context.api,elements,storage,calls,loads,exports,card:()=>card};
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
  h.api.renderFleetHealth([receipt({exit_code:0,stdout:'Old success'}),receipt({job_id:latest,exit_code:0,stdout:'Recovered',stderr:''})]);
  assert.equal(h.api.get().tasks[0].state,'passed');assert.equal(h.api.get().tasks[0].output,'Recovered');
  h.api.renderFleetHealth([receipt({exit_code:99,stdout:'Old late failure'}),receipt({job_id:latest,exit_code:9,stdout:'Contradictory duplicate'})]);
  assert.equal(h.api.get().tasks[0].state,'passed');assert.equal(h.api.get().tasks[0].output,'Recovered');assert.equal(h.api.get().tasks[0].attempts[0].output,'First output');
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
  h.api.renderFleetHealth([receipt({exit_code:null})]);h.api.renderFleetHealth([receipt({exit_code:0,stdout:'Valid output'})]);
  assert.equal(h.api.get().tasks[0].state,'passed');assert.equal(h.api.get().tasks[0].output,'Valid output');assert.equal(h.calls.length,0);
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

test('legacy successes remain in the combined report and saved attempt history survives reload',async()=>{
  const passed=task({unit:'phone191',state:'passed',output:'Saved success'});delete passed.exit_code;
  const h=harness({saved:saved([task(),passed]),nodes:[node(),node('phone191')]});await h.api.retryFleetHealth();
  const reloaded=harness({storage:h.storage});assert.equal(reloaded.api.get().tasks[1].state,'passed');assert.equal(reloaded.api.get().tasks[1].output,'Saved success');
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
  const h=harness({saved:saved([task({state:'passed',exit_code:0,error:''})])});const before=plain(h.api.get());
  await h.api.retryFleetHealth();assert.equal(h.calls.length,0);assert.deepEqual(plain(h.api.get()),before);
  assert.match(h.elements['fleet-health-report'].textContent,/passed · attempt 1\/3/);
});
