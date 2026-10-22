const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'public/scripts/cluster-phone-wake.js'),'utf8');
function harness({nodes=[{id:'phone253',online:true,busy:false}],failPost=false,saved=null}={}) {
 const el={'phone253-wake-run':{disabled:false},'phone253-wake-state':{textContent:''}},calls=[];
 const storage=new Map(saved?[['curt-phone253-wake-v1',JSON.stringify(saved)]]:[]);
 const context=vm.createContext({Date,JSON,Number,AbortController,crypto:{randomUUID:()=> 'fixture'},
  localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},sessionStorage:{getItem:()=> 'fixture'},
  document:{hidden:false,getElementById:id=>el[id]||null},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},
  fetch:async(url,options)=>{calls.push({url,...options});if(failPost&&options.method==='POST')throw Error('Receipt lost');return {ok:true,json:async()=>({ok:true,nodes,results:[]})};},
 });
 vm.runInContext(source.slice(0,source.indexOf('\n  mount();'))+'\n globalThis.api={wake,collect,render,validResult,pending,get:()=>report};})();',context);
 return {api:context.api,el,calls};
}
function result(h,patch={},envelope={}) {
 return {job_id:h.api.get().job_id,device_id:'phone253',exit_code:0,stdout:JSON.stringify({kind:'phone-display-wake',uid:10191,context_uid:10191,context_package:'com.termux',op_package:'com.termux',package_attribution_verified:true,existing_wake_lock_permission:true,permissions_changed:false,lockscreen_unlocked:false,wake_request_accepted:true,maximum_lock_ms:3000,wake_lock_released:true,interactive_before_request:true,interactive_after:true,display_state:2,off_to_on_verified:false,...patch}),...envelope};
}
test('wake uses one fixed reviewed helper, targets only phone253, and cannot double-submit',async()=>{
 const h=harness();await h.api.wake();await h.api.wake();
 const posts=h.calls.filter(c=>c.method==='POST');assert.equal(posts.length,1);
 const body=JSON.parse(posts[0].body);assert.deepEqual(body.target_device_ids,['phone253']);assert.equal(body.job.cmd,body.job.command);
 const encoded=body.job.cmd.match(/decode\("([A-Za-z0-9+/=]+)"\)/)[1];
 assert.equal(Buffer.from(encoded,'base64').toString(),fs.readFileSync(path.join(root,'scripts/cluster-phone253-wake.py'),'utf8'));
 assert.equal(h.el['phone253-wake-run'].disabled,true);
});
test('offline, busy, unknown and duplicate availability never send a wake',async()=>{
 for (const nodes of [[],[{id:'phone253',online:false,busy:false}],[{id:'phone253',online:true,busy:true}],[{id:'phone253',online:true}], [{id:'phone253',online:true,busy:false},{id:'phone253',online:true,busy:false}]]) {
  const h=harness({nodes});await h.api.wake();assert.equal(h.calls.some(c=>c.method==='POST'),false);
 }
});
test('an already-on result does not claim an off-to-on transition or unlock',async()=>{
 const h=harness();await h.api.wake();h.api.collect({results:[result(h)]});
 assert.equal(h.api.get().state,'already-on');assert.match(h.el['phone253-wake-state'].textContent,/already on/);
 assert.doesNotMatch(h.el['phone253-wake-state'].textContent,/changed from screen off/);
 assert.equal(h.el['phone253-wake-run'].disabled,false);
});
test('only a matching successful Android off-to-on report can confirm wake',async()=>{
 const h=harness();await h.api.wake();
 h.api.collect({results:[result(h,{}, {job_id:'other'}),result(h,{}, {device_id:'phone191'})]});assert.equal(h.api.get().state,'queued');
 h.api.collect({results:[result(h,{interactive_before_request:false,off_to_on_verified:true})]});
 assert.equal(h.api.get().state,'woke');assert.match(h.el['phone253-wake-state'].textContent,/Android confirmed/);
});
test('wrong identity, permissions, display state, leaked lock and inconsistent transition fail closed',async()=>{
 for (const patch of [{context_uid:0},{op_package:'android'},{uid:0},{package_attribution_verified:false},{existing_wake_lock_permission:false},{permissions_changed:true},{lockscreen_unlocked:true},{wake_request_accepted:false},{maximum_lock_ms:30000},{wake_lock_released:false},{interactive_after:false},{display_state:1},{interactive_before_request:undefined},{off_to_on_verified:true},{error:'Denied'}]) {
  const h=harness();await h.api.wake();h.api.collect({results:[result(h,patch)]});assert.equal(h.api.get().state,'failed',JSON.stringify(patch));
 }
 for (const exit_code of [null,'0',1]) {const h=harness();await h.api.wake();h.api.collect({results:[result(h,{}, {exit_code})]});assert.equal(h.api.get().state,'failed');}
});
test('ambiguous submission persists without replay, expires, and can still collect its real result',async()=>{
 const h=harness({failPost:true});await h.api.wake();await h.api.wake();assert.equal(h.api.get().state,'unconfirmed');assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
 h.api.collect({results:[result(h)]});assert.equal(h.api.get().state,'already-on');
 const pending=harness();await pending.api.wake();pending.api.get().created_at=new Date(Date.now()-181000).toISOString();pending.api.collect({});assert.equal(pending.api.get().state,'expired');
});
test('invalid saved reports cannot queue wakes or leave the control locked',()=>{
 for (const saved of [{unit:'phone191'},{unit:'phone253',state:'queued',job_id:'phone-display-wake-fixture',created_at:new Date(Date.now()+60000).toISOString()}]) {
  const h=harness({saved});h.api.render();assert.equal(h.api.get(),null);assert.equal(h.calls.length,0);assert.equal(h.el['phone253-wake-run'].disabled,false);
 }
});
