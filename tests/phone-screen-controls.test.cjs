const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'public/scripts/cluster-phone-controls.js'),'utf8');
function harness({nodes=[],saved=null,fail=false,failPost=false}={}){
 const el={'phone-control-status':{textContent:''},'phone-control-check':{disabled:false}},calls=[],storage=new Map(saved?[['curt-phone-control-check-v1',JSON.stringify(saved)]]:[]);
 let failNext=fail;
 const ctx=vm.createContext({Set,Map,Date,JSON,AbortController,crypto:{randomUUID:()=> 'test-id'},
  localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},sessionStorage:{getItem:()=> 'fixture'},
  document:{hidden:false,getElementById:id=>el[id]||null},setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1,clearInterval:()=>{},
  fetch:async(url,opts)=>{calls.push({url,...opts});if(failNext||(failPost&&opts.method==='POST'))throw Error('Network unavailable');return {ok:true,json:async()=>({nodes,results:[]})};}});
 vm.runInContext(source.slice(0,source.indexOf('\n  mount();'))+'\n globalThis.testApi={check,collect,render,pending,get:()=>report,set:r=>report=r};})();',ctx);
 return {api:ctx.testApi,el,calls,fail:()=>{failNext=true;}};
}
const units=[173,174,176,177,191,195,253,254].map(n=>'phone'+n);
const nodes=units.map(id=>({id,online:true,busy:false}));
function result(job,unit,permission='required',extra={}){return {job_id:job,device_id:unit,exit_code:0,stdout:JSON.stringify({kind:'phone-control-readiness',permission,screen_verified:false,permissions_changed:false,real_activity_requested:false,...extra})};}

test('only eight available worker phones receive one fixed read-only batch',async()=>{
 const h=harness({nodes:[...nodes,{id:'Curtis S26 Ultra',online:true},{id:'RenderRig',online:true}]});await h.api.check();
 const jobs=h.calls.filter(c=>c.method==='POST');assert.equal(jobs.length,1);
 const body=JSON.parse(jobs[0].body);assert.deepEqual(body.target_device_ids,units);
 const encoded=body.job.cmd.match(/decode\("([A-Za-z0-9+/=]+)"\)/)[1];
 const probe=Buffer.from(encoded,'base64').toString();assert.equal(probe,fs.readFileSync(path.join(root,'scripts/cluster-phone-control-status.py'),'utf8'));
 assert.match(probe,/CurtClusterMissingPermissionProbe/);assert.doesNotMatch(probe,/appops.*set|adb.*pair|pm.*grant/);
 await h.api.check();assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
});
test('busy and offline phones are skipped; availability errors remain visible',async()=>{
 const h=harness({nodes:[{id:'phone173',online:true,busy:true}]});await h.api.check();
 assert.equal(h.calls.length,1);assert.equal(h.api.get().phones[0].state,'busy');assert.equal(h.api.get().phones[1].state,'offline');
 const f=harness({fail:true});await f.api.check();assert.match(f.el['phone-control-status'].textContent,/Network unavailable/);
});
test('missing permission appears as required, never as control or screen success',async()=>{
 const h=harness({nodes});await h.api.check();const r=h.api.get();h.api.collect({results:units.map(u=>result(r.job_id,u))});
 assert.equal(h.api.pending(),false);assert.match(h.el['phone-control-status'].textContent,/Needs Android approval/);
 assert.equal(h.el['phone-control-check'].disabled,false);
});
test('mismatched and forged results cannot mark a phone as ready',async()=>{
 const h=harness({nodes});await h.api.check();const r=h.api.get();
 h.api.collect({results:[result('other-job','phone173','allowed'),result(r.job_id,'personal','allowed')]});assert.equal(r.phones[0].state,'queued');
 h.api.collect({results:[result(r.job_id,'phone173','allowed',{screen_verified:true})]});assert.equal(r.phones[0].state,'failed');
 h.api.collect({results:[result(r.job_id,'phone174','allowed')]});assert.equal(r.phones[1].state,'allowed');assert.match(h.el['phone-control-status'].textContent,/screen switching is not verified/);
});
test('unconfirmed submissions are not blindly retried and eventually expire',async()=>{
 const h=harness({nodes});await h.api.check();const r=h.api.get();r.checked_at=new Date(Date.now()-181000).toISOString();
 h.api.collect({results:[]});assert.equal(h.api.pending(),false);assert.equal(r.phones[0].state,'expired');
 r.checked_at=new Date(Date.now()-1900000).toISOString();h.api.render();assert.match(h.el['phone-control-status'].textContent,/Previous check expired/);
});
test('malformed saved checks cannot break or misidentify phone controls',()=>{
 const h=harness({saved:{phones:[null],checked_at:'invalid'}});h.api.render();assert.equal(h.api.get(),null);assert.match(h.el['phone-control-status'].textContent,/Not checked/);
});
test('publication labels stay intact through Windows source handling',()=>{
 assert.equal(/[^\x00-\x7f]/.test(source),false,'Use JavaScript unicode escapes, not locale-dependent source bytes');
});
test('ambiguous submission makes one attempt and cannot be replayed by another click',async()=>{
 const h=harness({nodes,failPost:true});await h.api.check();assert.ok(h.api.get().phones.every(p=>p.state==='unconfirmed'));
 await h.api.check();assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
 h.api.get().checked_at=new Date(Date.now()-181000).toISOString();h.api.collect({});assert.equal(h.api.pending(),false);
});
test('future saved checks are discarded rather than disabling controls forever',()=>{
 const h=harness({saved:{checked_at:new Date(Date.now()+60000).toISOString(),job_id:'phone-control-check-test',phones:units.map(unit=>({unit,state:'queued'}))}});
 assert.equal(h.api.get(),null);
});
