const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../netlify/functions/swarm-core/index.mjs'),'utf8');
function harness({count=1200,failList=null,failRead=null}={}) {
  const values=new Map([['migration--v2',{done:true}],['node--phone253',{id:'phone253',last_seen:Date.now()}]]),reads=[],lists=[],writes=[];
  for(let i=0;i<count;i++) values.set(`result--${String(1700000000000+i).padStart(13,'0')}--old-${i}--phone253`,{job_id:`old-${i}`,device_id:'phone253',completed_at:1700000000000+i,exit_code:0});
  const store={
    get:async key=>{reads.push(key);if(key===failRead)throw Error('Storage read unavailable');return values.get(key)||null;},
    list:async({prefix})=>{lists.push(prefix);if(prefix===failList)throw Error('Storage list unavailable');return {blobs:[...values.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key}))};},
    setJSON:async(key,value)=>{values.set(key,value);writes.push(key);},delete:async key=>values.delete(key),
  };
  const context=vm.createContext({getStore:()=>store,crypto,console,Response,URL,Buffer,Date,process:{env:{CLUSTER_WEB_PASSWORD:'fixture'}}});
  vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace('export default async (request) => {','globalThis.handler = async (request) => {'),context);
  const call=async(action,body)=>{
    const r=await context.handler({url:'https://curtbrag.com/api/cluster?action='+action,method:body?'POST':'GET',headers:new Headers({authorization:'Bearer fixture'}),json:async()=>body});
    return {status:r.status,data:await r.json()};
  };
  return {call,values,reads,lists,writes};
}
test('status reads fifty recent result bodies as history grows, preserving the full completed count',async()=>{
  const h=harness();const r=await h.call('queue-status');
  assert.equal(r.status,200);assert.equal(r.data.total_completed,1200);assert.equal(r.data.results.length,50);
  assert.equal(h.reads.filter(k=>k.startsWith('result--')).length,50);
  assert.equal(r.data.results[0].job_id,'old-1199');assert.equal(r.data.results[49].job_id,'old-1150');
  assert.equal(r.data.nodes[0].online,true);assert.equal(h.writes.length,0);
});
test('queued-job progress includes older completions beyond the fifty-result window',async()=>{
  const h=harness();h.values.set('job--old-1',{id:'old-1',target_count:2});
  h.values.set('assignment--old-1--phone174',{job_id:'old-1',device_id:'phone174'});
  const r=await h.call('queue-status');assert.equal(r.data.jobs[0].completed_count,1);
  assert.equal(r.data.jobs[0].progress,'1/2');assert.equal(r.data.jobs[0].pending_count,1);
  assert.equal(h.reads.filter(k=>k.startsWith('result--')).length,51);
});
test('command acknowledgment does not depend on any historical result listing or reads',async()=>{
  const h=harness({failList:'result--'});const r=await h.call('enqueue',{job:{id:'status-test',type:'status'},target_device_ids:['phone253']});
  assert.equal(r.status,200);assert.equal(r.data.enqueued,true);assert.deepEqual(r.data.target_device_ids,['phone253']);
  assert.equal(h.lists.includes('result--'),false);assert.equal(h.reads.some(k=>k.startsWith('result--')),false);
  assert.ok(h.values.has('assignment--status-test--phone253'));
  const again=await h.call('enqueue',{job:{id:'status-test',type:'status'},target_device_ids:['phone253']});
  assert.equal(again.data.already_present,true);assert.equal(h.writes.filter(k=>k==='assignment--status-test--phone253').length,1);
});
test('status storage failures produce an unavailable response instead of reporting an empty offline fleet',async()=>{
  for(const config of [{failList:'node--'},{failList:'assignment--'},{failList:'result--'},{failRead:'node--phone253'},{failRead:'result--1700000001199--old-1199--phone253'}]){
    const h=harness(config),r=await h.call('queue-status');assert.equal(r.status,503);
    assert.equal(r.data.ok,false);assert.equal(r.data.nodes,undefined);assert.equal(h.writes.length,0);
  }
});
test('small and empty histories retain the same status contract',async()=>{
  for(const count of [0,1,49,50]){
    const h=harness({count}),r=await h.call('queue-status');assert.equal(r.status,200);
    assert.equal(r.data.results.length,count);assert.equal(r.data.total_completed,count);assert.equal(r.data.nodes.length,1);
  }
});

test('malformed explicit selections cannot expand into commands for every online device',async()=>{
  for(const targets of ['phone253',null,false,0,[],[''],[null],[123],['phone253',''],['../phone253'],{},['x'.repeat(97)]]){
    const h=harness({count:0});h.values.delete('migration--v2');
    h.values.set('node--RenderRig',{id:'RenderRig',last_seen:Date.now()});
    const r=await h.call('enqueue',{job:{id:'scoped',type:'status'},target_device_ids:targets});
    assert.equal(r.status,400,JSON.stringify(targets));assert.equal(r.data.ok,false);
    assert.equal(h.writes.length,0,'Reject before migration, job or assignment writes');
    assert.equal(h.lists.length,0,'Do not enumerate the fleet to replace an invalid selection');
  }
});

test('nested target lists and single-device targets reject malformed values too',async()=>{
  for(const fields of [{target_device_ids:'phone253'},{target_device_ids:[]},{target_device_ids:null},{device_id:[]},{device_id:''},{device_id:null},{device_id:253}]){
    const h=harness({count:0}),r=await h.call('enqueue',{job:{id:'nested',type:'status',...fields}});
    assert.equal(r.status,400);assert.equal(h.writes.length,0);
  }
});

test('valid single-device selections assign only that device with other online workers present',async()=>{
  for(const fields of [{target_device_ids:['phone253']},{job:{target_device_ids:['phone253']}},{job:{device_id:'phone253'}}]){
    const h=harness({count:0});h.values.set('node--RenderRig',{id:'RenderRig',last_seen:Date.now()});
    const r=await h.call('enqueue',{...fields,job:{id:'scoped',type:'status',...fields.job}});
    assert.equal(r.status,200);assert.deepEqual(r.data.target_device_ids,['phone253']);
    assert.equal(h.values.has('assignment--scoped--RenderRig'),false);
    assert.equal(h.values.has('assignment--scoped--phone253'),true);
  }
});

test('valid fleet lists deduplicate and fully omitted targeting retains legacy behavior',async()=>{
  for(const fields of [{target_device_ids:['phone253','RenderRig','phone253']},{}]){
    const h=harness({count:0});h.values.set('node--RenderRig',{id:'RenderRig',last_seen:Date.now()});
    const r=await h.call('enqueue',{job:{id:'fleet',type:'status'},...fields});
    assert.equal(r.status,200);assert.deepEqual(r.data.target_device_ids.sort(),['RenderRig','phone253']);
    assert.equal(h.writes.filter(key=>key.startsWith('assignment--')).length,2);
  }
});

test('oversized commands are rejected before any migration, reads or assignments',async()=>{
  for(const fields of [{cmd:'x'.repeat(4001)},{command:'x'.repeat(4001)},
    {cmd:'echo valid',command:'x'.repeat(4001)},{cmd:'x'.repeat(4001),command:'echo valid'}]){
    const h=harness({count:0});h.values.delete('migration--v2');
    const r=await h.call('enqueue',{job:{id:'too-long',type:'shell',...fields},target_device_ids:['phone253']});
    assert.equal(r.status,400);assert.equal(r.data.ok,false);
    assert.match(r.data.error,/4000-character limit; no job was queued/);
    assert.equal(r.data.code,'enqueue-validation-rejected');assert.equal(r.data.enqueued,false);assert.equal(r.data.job_id,'too-long');
    assert.equal(h.reads.length,0);assert.equal(h.lists.length,0);assert.equal(h.writes.length,0);
  }
});

test('commands at the length limit and shell quoting arrive unchanged at the worker',async()=>{
  for(const text of ['x'.repeat(3999),'x'.repeat(4000),'é'.repeat(4000),"printf '%s\\n' 'a&b'\necho \"$HOME\""]){
    for(const field of ['cmd','command']){
      const h=harness({count:0});
      const r=await h.call('enqueue',{job:{id:'exact-command',type:'shell',[field]:text},target_device_ids:['phone253']});
      assert.equal(r.status,200);
      const stored=h.values.get('assignment--exact-command--phone253').job;
      assert.equal(stored.cmd,text);assert.equal(stored.command,text);
    }
  }
});

test('non-text commands cannot be coerced into executable instructions',async()=>{
  for(const value of [[],{},true,123]){
    for(const field of ['cmd','command']){
      const h=harness({count:0});
      const r=await h.call('enqueue',{job:{id:'wrong-command',type:'shell',[field]:value},target_device_ids:['phone253']});
      assert.equal(r.status,400);assert.match(r.data.error,/must be text; no job was queued/);
      assert.equal(h.writes.length,0);assert.equal(h.reads.length,0);
    }
  }
});
