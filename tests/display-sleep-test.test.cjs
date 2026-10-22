const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test'),assert=require('node:assert/strict');
const html=fs.readFileSync(path.resolve(__dirname,'../public/cluster/display.html'),'utf8');
const core=html.slice(html.indexOf('function wakeStatus('),html.indexOf("$('full').onclick"));
const save=html.split(/\r?\n/).find(l=>l.startsWith('function save()'));
function harness({wanted=true,hidden=false}={}) {
 let now=10000,requests=0;const timers=[],storage=new Map(),locks=[];
 const elements=new Map();const element=id=>{if(!elements.has(id))elements.set(id,{value:id==='name'?'phone253':'',textContent:'',attrs:{},setAttribute(k,v){this.attrs[k]=v;}});return elements.get(id);};
 const doc={hidden};
 const context=vm.createContext({Date:{now:()=>now},Promise,document:doc,getEl:element,
  localStorage:{setItem:(k,v)=>storage.set(k,v)},
  setTimeout:(callback,ms)=>{timers.push({callback,ms});return timers.length;},clearTimeout(){},
  navigator:{wakeLock:{request:async()=>{requests++;const listeners=[];const lock={released:false,addEventListener:(event,f)=>listeners.push(f),release:async()=>{lock.released=true;listeners.forEach(f=>f());}};locks.push(lock);return lock;}}},
 });
 vm.runInContext('const $=getEl;let mode="activity",lock=null,wantsAwake='+wanted+',wakeRequestPending=false,wakeRetryTimer=null,sleepTestUntil=0,sleepTestRestoreAwake=false;'+save+core+';globalThis.api={awake,startSleepTest,finishSleepTest,get:()=>({wantsAwake,sleepTestUntil,sleepTestRestoreAwake})};',context);
 return {api:context.api,timers,storage,locks,doc,element,requests:()=>requests,advance:ms=>{now+=ms;}};
}
test('sleep test releases the current browser wake lock and prevents interval reacquisition',async()=>{
 const h=harness();await h.api.awake();assert.equal(h.requests(),1);h.api.startSleepTest();await h.api.awake();await h.api.awake();
 assert.equal(h.locks[0].released,true);assert.equal(h.requests(),1);assert.equal(h.api.get().wantsAwake,false);
 assert.match(h.element('screen-state').textContent,/normal screen sleep/);
 assert.deepEqual(h.timers.map(t=>t.ms),[120000]);
});
test('temporary test does not persist disabled protection and restores it after two minutes',async()=>{
 const h=harness();h.api.startSleepTest();
 h.api.finishSleepTest();await Promise.resolve();await Promise.resolve();
 assert.equal(h.api.get().wantsAwake,true);assert.equal(h.api.get().sleepTestUntil,0);assert.equal(h.requests(),1);
 assert.equal(JSON.parse(h.storage.get('curt-display-v1')).keepAwake,true);
});
test('an already-disabled preference remains disabled after the bounded test',async()=>{
 const h=harness({wanted:false});h.api.startSleepTest();h.timers[0].callback();await Promise.resolve();
 assert.equal(h.api.get().wantsAwake,false);assert.equal(h.requests(),0);assert.equal(JSON.parse(h.storage.get('curt-display-v1')).keepAwake,false);
});
test('a suspended page restores normal protection after its deadline when visible again',async()=>{
 const h=harness();h.api.startSleepTest();h.doc.hidden=true;h.advance(120001);await h.api.awake();assert.equal(h.requests(),0);
 assert.equal(h.api.get().sleepTestUntil,0);h.doc.hidden=false;await h.api.awake();assert.equal(h.requests(),1);
});
test('manual keep-awake control cancels the test without leaving protection disabled',async()=>{
 const h=harness();h.api.startSleepTest();await h.element('awake').onclick();await Promise.resolve();
 assert.equal(h.api.get().wantsAwake,true);assert.equal(h.api.get().sleepTestUntil,0);assert.equal(h.requests(),1);
});
test('ordinary display use still holds one wake lock and recovers normal released locks',async()=>{
 const h=harness();await h.api.awake();await h.api.awake();assert.equal(h.requests(),1);
 await h.locks[0].release();await h.api.awake();assert.equal(h.requests(),2);assert.equal(h.api.get().sleepTestUntil,0);
});
