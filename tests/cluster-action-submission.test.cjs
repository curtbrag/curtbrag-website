const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('public/scripts/cluster-swarm-live-v8.js','utf8');
function setup(){
  const calls=[],notices=[];
  const context={DIAGNOSTIC_TYPES:new Set(),GPU_WORK_TYPES:new Set(),MINER_TYPES:new Set(),load:async()=>true,
    normalizeTarget:value=>value,resolveTarget:async value=>value,swarmTargets:()=>['Alina'],
    notify:message=>notices.push(message),enqueueSwarm:(type,cmd,targets)=>new Promise((resolve,reject)=>calls.push({type,cmd,targets,resolve,reject}))};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  const pendingActions='),source.indexOf('  window.fetchSwarmStatus =')),context);
  return {context,calls,notices};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('rapid identical actions share one enqueue and return the same receipt',async()=>{
  const {context,calls,notices}=setup();
  const first=context.runAction('status','all');const second=context.runAction('status','__all__');
  assert.equal(first,second);await tick();assert.equal(calls.length,1);
  calls[0].resolve({id:'one-receipt',target_count:1});
  assert.equal((await first).id,'one-receipt');assert.equal((await second).id,'one-receipt');
  assert.ok(notices.some(value=>value.includes('already being submitted')));
});
test('different commands are not merged and completed actions can be run again',async()=>{
  const {context,calls}=setup();
  const first=context.runAction('shell','Alina','uptime');const other=context.runAction('shell','Alina','date');
  await tick();assert.equal(calls.length,2);
  calls.forEach(call=>call.resolve({target_count:1}));await Promise.all([first,other]);
  const next=context.runAction('shell','Alina','uptime');await tick();assert.equal(calls.length,3);
  calls[2].resolve({target_count:1});await next;
});
test('an uncertain failure is not automatically retried and releases the in-flight guard',async()=>{
  const {context,calls}=setup();
  const first=context.runAction('status');const repeated=context.runAction('status');
  const failures=Promise.allSettled([first,repeated]);await tick();calls[0].reject(new Error('Response lost'));
  assert.deepEqual((await failures).map(value=>value.status),['rejected','rejected']);assert.equal(calls.length,1);
  const explicitRetry=context.runAction('status');await tick();assert.equal(calls.length,2);
  calls[1].resolve({target_count:1});await explicitRetry;
});
