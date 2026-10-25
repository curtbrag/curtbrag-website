import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler,validateJob,UNITS} from '../netlify/functions/lib/fleet-email.mjs';
function fixture() {
  const records=new Map(),versions=new Map();
  const store={get:async k=>records.get(k)??null,list:async({prefix})=>({blobs:[...records.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key}))}),setJSON:async(k,v)=>{records.set(k,v);versions.set(k,(versions.get(k)||0)+1);},getWithMetadata:async k=>records.has(k)?{data:records.get(k),etag:String(versions.get(k))}:null,set:async(k,v,o)=>{if(o.onlyIfNew&&records.has(k)||o.onlyIfMatch&&o.onlyIfMatch!==String(versions.get(k)))return {modified:false};records.set(k,JSON.parse(v));versions.set(k,(versions.get(k)||0)+1);return {modified:true};}};
  const handle=createHandler({store,password:async()=>'test-operator',now:()=>200000});
  const request=(action,body,token='test-operator')=>handle(new Request('https://example.com/mail?action='+action,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token},body:body?JSON.stringify(body):undefined}));
  return {records,request};
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
