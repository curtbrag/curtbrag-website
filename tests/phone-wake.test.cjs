const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'public/scripts/cluster-phone-wake.js'),'utf8');
const units=[173,174,176,177,191,195,253,254].map(n=>'phone'+n);
const online=units.map(id=>({id,online:true,busy:false}));
function harness({nodes=online,failPost=false,failGet=false,saved=null,legacy=null,target='all'}={}) {
 const el={'phone-wake-run':{disabled:false},'phone-wake-state':{textContent:''},'phone-wake-report':{textContent:''},'phone-wake-target':{value:target,disabled:false}},calls=[];
 const storage=new Map();if(saved)storage.set('curt-phone-wake-v2',JSON.stringify(saved));if(legacy)storage.set('curt-phone253-wake-v1',JSON.stringify(legacy));
 const context=vm.createContext({Set,Date,JSON,Number,AbortController,crypto:{randomUUID:()=> 'fixture'},
  localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},sessionStorage:{getItem:()=> 'fixture'},
  document:{hidden:false,getElementById:id=>el[id]||null},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},
  fetch:async(url,options)=>{calls.push({url,...options});if((failPost&&options.method==='POST')||(failGet&&options.method==='GET'))throw Error('Connection lost');return {ok:true,json:async()=>({ok:true,nodes,results:[]})};},
 });
 vm.runInContext(source.slice(0,source.indexOf('\n  mount();'))+'\n globalThis.api={wake,collect,render,validResult,pending,get:()=>report};})();',context);
 return {api:context.api,el,calls};
}
function result(h,unit='phone253',patch={},envelope={}) {
 const now=Date.now();return {job_id:h.api.get().job_id,device_id:unit,exit_code:0,stdout:JSON.stringify({kind:'phone-display-wake',uid:10191,context_uid:10191,context_package:'com.termux',op_package:'com.termux',package_attribution_verified:true,existing_wake_lock_permission:true,permissions_changed:false,lockscreen_unlocked:false,wake_request_accepted:true,maximum_lock_ms:600000,wake_lock_released:false,hold_active:true,holder_pid:1234,hold_started_ms:now-5000,hold_until_ms:now+595000,hold_verified_at_ms:now,sustained_check_ms:4000,interactive_before_request:true,interactive_after:true,display_state:2,off_to_on_verified:false,...patch}),...envelope};
}
const states=h=>h.api.get().phones.map(p=>p.state);
test('one fixed reviewed batch targets exactly all eight phones and cannot double-submit',async()=>{
 const h=harness({nodes:[...online,{id:'RenderRig',online:true,busy:false},{id:'personal',online:true,busy:false}]});await h.api.wake();await h.api.wake();
 const posts=h.calls.filter(c=>c.method==='POST');assert.equal(posts.length,1);
 const body=JSON.parse(posts[0].body);assert.deepEqual(body.target_device_ids,units);assert.equal(body.job.cmd,body.job.command);
 const encoded=body.job.cmd.match(/decode\("([A-Za-z0-9+/=]+)"\)/)[1];
 assert.ok(body.job.cmd.length<=4000,'command must fit the production queue without truncation');
 assert.equal(require('node:zlib').inflateSync(Buffer.from(encoded,'base64')).toString(),fs.readFileSync(path.join(root,'scripts/cluster-phone-wake-hold.py'),'utf8'));
 assert.equal(h.el['phone-wake-run'].disabled,true);assert.equal(h.el['phone-wake-target'].disabled,true);
});
test('each individual listed phone can be selected, without changing other targets',async()=>{
 for(const target of units){const h=harness({target});await h.api.wake();const body=JSON.parse(h.calls.find(c=>c.method==='POST').body);assert.deepEqual(body.target_device_ids,[target]);assert.equal(h.api.get().phones.length,1);}
 for(const target of ['personal','RenderRig','phone253;id']){const h=harness({target});await h.api.wake();assert.equal(h.calls.length,0);}
});
test('busy, offline, missing, duplicate and unknown availability are individually skipped',async()=>{
 const h=harness({nodes:[{id:'phone173',online:false,busy:false},{id:'phone174',online:true,busy:true},{id:'phone176',online:true},{id:'phone177',online:true,busy:false},{id:'phone177',online:true,busy:false},...online.slice(4)]});await h.api.wake();
 assert.deepEqual(JSON.parse(h.calls.find(c=>c.method==='POST').body).target_device_ids,units.slice(4));
 assert.deepEqual(Array.from(states(h)).slice(0,4),['offline','busy','unknown','unknown']);
 for(const options of [{nodes:[]},{failGet:true}]){const empty=harness(options);await empty.api.wake();assert.equal(empty.calls.some(c=>c.method==='POST'),false);}
});
test('each already-on result is matched to its own phone without claiming a wake transition',async()=>{
 const h=harness();await h.api.wake();h.api.collect({results:units.map(unit=>result(h,unit))});
 assert.ok(states(h).every(s=>s==='already-on'));assert.match(h.el['phone-wake-state'].textContent,/8\/8 wake results; 0 off-to-on verified; 8 already on/);
 assert.equal(h.el['phone-wake-run'].disabled,false);assert.equal(h.el['phone-wake-report'].textContent.split('\n').length,8);
});
test('one phone waking and another failing do not change the other six results',async()=>{
 const h=harness();await h.api.wake();h.api.collect({results:[result(h,'phone173',{interactive_before_request:false,off_to_on_verified:true}),result(h,'phone174',{wake_lock_released:true}),...units.slice(2).map(unit=>result(h,unit))]});
 assert.equal(states(h)[0],'woke');assert.equal(states(h)[1],'failed');assert.ok(states(h).slice(2).every(s=>s==='already-on'));
 assert.match(h.el['phone-wake-state'].textContent,/1 off-to-on verified; 6 already on; 1 failed/);
});
test('unrelated jobs, unknown units and duplicate results cannot confirm a wake',async()=>{
 const h=harness();await h.api.wake();h.api.collect({results:[result(h,'phone173',{}, {job_id:'other'}),result(h,'personal')]});assert.ok(states(h).every(s=>s==='queued'));
 h.api.collect({results:[result(h,'phone173'),result(h,'phone173')]});assert.equal(states(h)[0],'failed');
});
test('incorrect identity, permissions, display, lock or inconsistent transition fails closed',async()=>{
 for(const patch of [{context_uid:0},{op_package:'android'},{uid:0},{package_attribution_verified:false},{existing_wake_lock_permission:false},{permissions_changed:true},{lockscreen_unlocked:true},{wake_request_accepted:false},{maximum_lock_ms:30000},{wake_lock_released:true},{interactive_after:false},{display_state:1},{interactive_before_request:undefined},{off_to_on_verified:true},{error:'Denied'}]){
  const h=harness({target:'phone253'});await h.api.wake();h.api.collect({results:[result(h,'phone253',patch)]});assert.equal(states(h)[0],'failed',JSON.stringify(patch));
 }
 for(const exit_code of [null,'0',1]){const h=harness({target:'phone253'});await h.api.wake();h.api.collect({results:[result(h,'phone253',{}, {exit_code})]});assert.equal(states(h)[0],'failed');}
});
test('ambiguous batch is never replayed and can collect later real results',async()=>{
 const h=harness({failPost:true});await h.api.wake();await h.api.wake();assert.ok(states(h).every(s=>s==='unconfirmed'));assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
 h.api.collect({results:units.map(unit=>result(h,unit))});assert.ok(states(h).every(s=>s==='already-on'));
 const missing=harness();await missing.api.wake();missing.api.get().created_at=new Date(Date.now()-181000).toISOString();missing.api.collect({});assert.ok(states(missing).every(s=>s==='expired'));assert.equal(missing.api.pending(),false);
});
test('an in-flight legacy phone253 request migrates without dispatch or replay',async()=>{
 const legacy={unit:'phone253',job_id:'phone-display-wake-old',created_at:new Date().toISOString(),state:'unconfirmed'};
 const h=harness({legacy});assert.equal(h.api.get().target,'phone253');await h.api.wake();assert.equal(h.calls.length,0);
 h.api.collect({results:[result(h)]});assert.equal(states(h)[0],'already-on');
});
test('malformed, future, duplicate or out-of-scope saved records are discarded',()=>{
 const base={target:'all',job_id:'phone-display-wake-fixture',created_at:new Date().toISOString(),phones:units.map(unit=>({unit,state:'queued'}))};
 for(const saved of [{unit:'phone191'},{...base,created_at:new Date(Date.now()+60000).toISOString()},{...base,phones:units.map(()=>({unit:'phone253',state:'queued'}))},{...base,target:'phone253'}]){
  const h=harness({saved});h.api.render();assert.equal(h.api.get(),null);assert.equal(h.calls.length,0);assert.equal(h.el['phone-wake-run'].disabled,false);
 }
});
test('a brief screen flash cannot satisfy a new ten-minute hold request',async()=>{
 const h=harness({target:'phone253'});await h.api.wake();
 assert.equal(h.api.get().hold_required,true);
 h.api.collect({results:[result(h,'phone253',{maximum_lock_ms:3000,wake_lock_released:true,hold_active:false})]});
 assert.equal(states(h)[0],'failed');
});
test('missing hold proof, short observation and invalid expiry fail closed',async()=>{
 for(const patch of [{hold_active:false},{holder_pid:undefined},{sustained_check_ms:1000},{hold_started_ms:0},{hold_until_ms:Date.now()+86400000},{hold_verified_at_ms:0}]){
  const h=harness({target:'phone253'});await h.api.wake();h.api.collect({results:[result(h,'phone253',patch)]});
  assert.equal(states(h)[0],'failed',JSON.stringify(patch));
 }
});
test('the displayed hold expires instead of permanently claiming an awake screen',async()=>{
 const h=harness({target:'phone253'});await h.api.wake();h.api.collect({results:[result(h)]});
 assert.match(h.el['phone-wake-report'].textContent,/scheduled until/);
 h.api.get().phones[0].hold_until_ms=Date.now()-1;h.api.render();
 assert.match(h.el['phone-wake-report'].textContent,/hold ended/);
 assert.doesNotMatch(h.el['phone-wake-report'].textContent,/scheduled until/);
});
