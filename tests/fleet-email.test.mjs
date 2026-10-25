import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler,validateJob,UNITS,RUNNING_LEASE_MS} from '../netlify/functions/lib/fleet-email.mjs';
function fixture() {
  const records=new Map(),versions=new Map(),hooks={};let clock=200000;
  const store={get:async k=>records.get(k)??null,list:async({prefix})=>({blobs:[...records.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key}))}),setJSON:async(k,v)=>{records.set(k,v);versions.set(k,(versions.get(k)||0)+1);},getWithMetadata:async k=>records.has(k)?{data:records.get(k),etag:String(versions.get(k))}:null,set:async(k,v,o)=>{if(hooks.beforeSet)await hooks.beforeSet(k,JSON.parse(v));if(o.onlyIfNew&&records.has(k)||o.onlyIfMatch&&o.onlyIfMatch!==String(versions.get(k)))return {modified:false};records.set(k,JSON.parse(v));versions.set(k,(versions.get(k)||0)+1);return {modified:true};}};
  const handle=createHandler({store,password:async()=>'test-operator',now:()=>clock});
  const request=(action,body,token='test-operator')=>handle(new Request('https://example.com/mail?action='+action,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token},body:body?JSON.stringify(body):undefined}));
  return {records,request,store,hooks,advance:ms=>{clock+=ms;}};
}
const job={id:'test-12345678',unit:'phone253',action:'test'};
test('all fourteen units have distinct addresses',()=>{assert.equal(UNITS.length,14);assert.equal(new Set(UNITS.map(x=>x.toLowerCase())).size,14);});
test('no arbitrary recipient, shell, credential or mail-reading action is accepted',()=>{
  for(const addition of [{action:'send'},{action:'inbox'},{to:'other@example.com'},{cmd:'anything'},{password:'secret'}]) assert.throws(()=>validateJob({...job,...addition}));
});
test('every route rejects signed-out users before reading or changing data',async()=>{
  const f=fixture();for(const action of ['status','enqueue','heartbeat','poll','complete']) assert.equal((await f.request(action,action==='status'?null:job,'wrong')).status,401);assert.equal(f.records.size,0);
});
test('offline bridge and uninstalled devices cannot receive queued tests',async()=>{
  const f=fixture();assert.equal((await f.request('enqueue',job)).status,409);
  await f.request('heartbeat',{devices:{phone253:{installed:false,connected:true}}});assert.equal((await f.request('enqueue',job)).status,409);
});
test('a queued test is claimed once and completing it is idempotent',async()=>{
  const f=fixture();await f.request('heartbeat',{devices:{phone253:{installed:true,connected:true}}});
  assert.equal((await f.request('enqueue',job)).status,200);await f.request('enqueue',job);
  const claims=await Promise.all([f.request('poll',{}),f.request('poll',{})]);const bodies=await Promise.all(claims.map(r=>r.json()));assert.equal(bodies.filter(x=>x.job).length,1);
  await f.request('complete',{id:job.id,result:{ok:true,accepted:true,password:'must-not-persist'}});
  await f.request('complete',{id:job.id,result:{ok:false}});
  const saved=f.records.get('job-'+job.id);assert.equal(saved.status,'complete');assert.equal(saved.result.password,undefined);assert.equal((await(await f.request('poll',{})).json()).job,null);
  await f.request('complete',{id:job.id,result:{delivery_verified:true,ok:false,address:'wrong@example.com'}});
  const confirmed=f.records.get('job-'+job.id);assert.equal(confirmed.result.delivery_verified,true);assert.equal(confirmed.result.ok,true);assert.equal(confirmed.result.address,undefined);
});

async function ready(f) {await f.request('heartbeat',{devices:{phone253:{installed:true,connected:true}}});}
async function running(f,value=job) {await ready(f);await f.request('enqueue',value);await f.request('poll',{});}
test('a five-minute abandoned claim becomes interrupted without being resent and allows a new check',async()=>{
  const f=fixture();await running(f);f.advance(RUNNING_LEASE_MS+1);
  const status=await(await f.request('status')).json();
  assert.equal(status.jobs[0].status,'interrupted');assert.equal(status.jobs[0].interruption_reason,'lease-expired');
  assert.equal((await(await f.request('poll',{})).json()).job,null);
  await ready(f);assert.equal((await f.request('enqueue',{...job,id:'check-12345678',action:'check'})).status,200);
  assert.equal((await(await f.request('poll',{})).json()).job.id,'check-12345678');
  assert.equal(f.records.get('job-'+job.id).status,'interrupted');
});
test('late original completion replaces only an expired lease and preserves accepted delivery evidence',async()=>{
  const f=fixture();await running(f);f.advance(RUNNING_LEASE_MS+1);await f.request('status');
  await f.request('complete',{id:job.id,result:{ok:true,accepted:true,delivery_verified:false,delivery_unconfirmed:true,delivery_error:'TimeoutError'}});
  const saved=f.records.get('job-'+job.id);assert.equal(saved.status,'complete');assert.equal(saved.result.accepted,true);
  assert.equal(saved.result.delivery_error,'TimeoutError');assert.equal(saved.result.delivery_unconfirmed,true);
  await f.request('complete',{id:job.id,result:{ok:false,interrupted:true}});
  assert.deepEqual(f.records.get('job-'+job.id),saved);
  await f.request('complete',{id:job.id,result:{delivery_verified:true,error:'cannot replace original result'}});
  assert.equal(f.records.get('job-'+job.id).result.delivery_verified,true);
  assert.equal(f.records.get('job-'+job.id).result.delivery_unconfirmed,false);
  assert.equal(f.records.get('job-'+job.id).result.error,undefined);
});
test('relay restart reports unknown sending outcome as interrupted and never requeues it',async()=>{
  const f=fixture();await running(f);
  await f.request('complete',{id:job.id,result:{ok:false,interrupted:true,delivery_unconfirmed:true,error:'Sending outcome unconfirmed; request was not replayed'}});
  const saved=f.records.get('job-'+job.id);assert.equal(saved.status,'interrupted');assert.equal(saved.result.accepted,undefined);
  await f.request('complete',{id:job.id,result:{ok:true,accepted:true}});
  assert.deepEqual(f.records.get('job-'+job.id),saved);
  assert.equal((await(await f.request('poll',{})).json()).job,null);
  assert.equal((await f.request('enqueue',{...job,id:'check-12345678',action:'check'})).status,200);
});
test('SMTP acceptance cannot become failed when only delivery checking failed',async()=>{
  const f=fixture();await running(f);
  await f.request('complete',{id:job.id,result:{ok:false,accepted:true,delivery_verified:false,error:'TimeoutError'}});
  const saved=f.records.get('job-'+job.id);assert.equal(saved.status,'complete');assert.equal(saved.result.accepted,true);
});
test('completion racing lease expiry is not overwritten by interrupted status',async()=>{
  const f=fixture();await running(f);f.advance(RUNNING_LEASE_MS+1);let raced=false;
  f.hooks.beforeSet=async(key,value)=>{if(key==='job-'+job.id&&value.interruption_reason==='lease-expired'&&!raced){raced=true;await f.request('complete',{id:job.id,result:{ok:true,accepted:true,delivery_verified:true}});}};
  const status=await(await f.request('status')).json();assert.equal(status.jobs[0].status,'complete');assert.equal(status.jobs[0].result.delivery_verified,true);
});
test('concurrent distinct requests for the same mailbox accept at most one',async()=>{
  const f=fixture();await ready(f);
  const replies=await Promise.all([f.request('enqueue',job),f.request('enqueue',{...job,id:'test-87654321'})]);
  assert.deepEqual(replies.map(x=>x.status).sort(),[200,409]);assert.equal([...f.records.keys()].filter(x=>x.startsWith('job-')).length,1);
});
test('concurrent replay of the same request ID remains idempotent',async()=>{
  const f=fixture();await ready(f);
  const replies=await Promise.all([f.request('enqueue',job),f.request('enqueue',job)]);
  assert.deepEqual(replies.map(x=>x.status),[200,200]);assert.equal([...f.records.keys()].filter(x=>x.startsWith('job-')).length,1);
});
test('queued requests expire without sending and release the unit reservation',async()=>{
  const f=fixture();await ready(f);await f.request('enqueue',job);f.advance(1800001);
  assert.equal((await(await f.request('poll',{})).json()).job,null);assert.equal(f.records.get('job-'+job.id).status,'expired');
  await ready(f);assert.equal((await f.request('enqueue',{...job,id:'test-87654321'})).status,200);
});
test('a crash between unit reservation and job creation cannot block a mailbox forever',async()=>{
  const f=fixture();await ready(f);await f.store.setJSON('unit-phone253',{id:'orphan-12345678',at:200000});
  assert.equal((await f.request('enqueue',job)).status,409);assert.equal(f.records.has('job-'+job.id),false);
  f.advance(30001);assert.equal((await f.request('enqueue',job)).status,200);
  assert.equal(f.records.get('job-'+job.id).status,'queued');
});
test('an older active request cannot disappear behind the hundred newest results',async()=>{
  const f=fixture();await running(f);
  for(let i=0;i<101;i++)await f.store.setJSON('job-history-'+i,{id:'history-'+i,unit:'phone173',action:'check',status:'complete',created_at:200001+i,result:{ok:true}});
  const status=await(await f.request('status')).json();assert.ok(status.jobs.some(x=>x.id===job.id&&x.status==='running'));
});
