const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'netlify/functions/phone-display.js'),'utf8');
function api(){
 let now=1000000;const values=new Map(),writes=[];
 const context=vm.createContext({Set,Buffer,crypto,process:{env:{CLUSTER_WEB_PASSWORD:'fixture'}},Date:{now:()=>now},
  getStore:options=>({get:async(key)=>values.get((options.name||options)+':'+key)||null,setJSON:async(key,value)=>{values.set((options.name||options)+':'+key,value);writes.push(value);}}),
  issueDisplayTicket:async()=>{throw Error('Sleep tests must not issue credentials');}});
 vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').split('export default')[0]+';globalThis.handle=handle;',context);
 const call=(method,body={},auth=true,activity='1')=>context.handle({httpMethod:method,host:'curtbrag.com',headers:auth?{authorization:'Bearer fixture'}:{},body:JSON.stringify(body),queryStringParameters:{phone:body.phone||'phone253',activity}}).then(r=>({status:r.statusCode,data:JSON.parse(r.body)}));
 return {call,writes,advance:ms=>now+=ms,values};
}
test('sleep command requires existing authentication and an exact worker phone',async()=>{
 const a=api();assert.equal((await a.call('POST',{phone:'phone253',mode:'dashboard',sleepTest:true},false)).status,401);
 for(const body of [{phone:'personal',mode:'dashboard',sleepTest:true},{phone:'phone253',mode:'clock',sleepTest:true},{phone:'phone253',mode:'dashboard',sleepTest:'true'},{phone:'phone253',mode:'dashboard',sleepTest:true,connect:true}])assert.equal((await a.call('POST',body)).status,400);
 assert.equal(a.writes.length,0);
});
test('command has a server-bounded deadline and returns to activity when expired without a GET write',async()=>{
 const a=api(),receipt=await a.call('POST',{phone:'phone253',mode:'dashboard',sleepTest:true});
 assert.equal(receipt.status,200);assert.equal(receipt.data.sleepTest.expiresAt,1120000);
 const active=await a.call('GET');assert.equal(active.data.mode,'dashboard');assert.equal(active.data.sleepTest.id,receipt.data.revision);
 a.advance(120000);const expired=await a.call('GET');assert.equal(expired.data.mode,'activity');assert.equal(expired.data.sleepTest,undefined);assert.match(expired.data.revision,/:expired$/);assert.equal(a.writes.length,1);
 assert.equal((await a.call('GET',{},true,'0')).data.mode,'dashboard');
});
test('an ordinary connected mode update cancels the test immediately',async()=>{
 const a=api();await a.call('POST',{phone:'phone253',mode:'dashboard',sleepTest:true});await a.call('POST',{phone:'phone253',mode:'clock'});
 const response=await a.call('GET');assert.equal(response.data.mode,'clock');assert.equal(response.data.sleepTest,undefined);
});
test('malformed or unbounded stored test cannot disable sleep protection',async()=>{
 for(const sleepTest of [{id:'bad',expiresAt:1120000},{id:crypto.randomUUID(),expiresAt:999999999},{id:crypto.randomUUID(),expiresAt:'1120000'}]){
  const a=api();a.values.set('phone-display:phone253',{mode:'dashboard',revision:'fixture',sleepTest});const r=await a.call('GET');assert.equal(r.data.mode,'activity');assert.equal(r.data.sleepTest,undefined);
 }
});

const html=fs.readFileSync(path.join(root,'public/cluster/display.html'),'utf8');
const helper=html.slice(html.indexOf('let remoteSleepTestId='),html.indexOf('async function syncDisplay(){'));
const command={mode:'dashboard',sleepTest:{id:crypto.randomUUID(),expiresAt:1120000}};
function page({embedded=true,parentName='phone253',unit='phone253',crossOrigin=false}={}){
 const calls={ownSleep:0,ownRestore:0,parentSleep:0,parentRestore:0},frame={},listeners={};
 const parent={location:{href:crossOrigin?'https://example.com/cluster/display.html':'https://curtbrag.com/cluster/display.html'},document:{getElementById:id=>id==='name'?{value:parentName}:id==='dashboard'?{querySelector:()=>frame}:null},startSleepTest:()=>calls.parentSleep++,finishSleepTest:()=>calls.parentRestore++};
 const context=vm.createContext({Date:{now:()=>1000000},Number,URL,params:{get:()=>embedded?'1':null},location:{origin:'https://curtbrag.com'},window:{parent,frameElement:frame,addEventListener:(name,f)=>listeners[name]=f},$:()=>({value:unit}),startSleepTest:()=>calls.ownSleep++,finishSleepTest:()=>calls.ownRestore++});
 vm.runInContext(helper+';globalThis.apply=applyRemoteSleepTest;',context);
 return {calls,listeners,apply:d=>context.apply(d)};
}
test('a fresh embedded display releases its own lock and the matching legacy parent once',()=>{
 const p=page();p.apply(command);p.apply(command);assert.deepEqual(p.calls,{ownSleep:1,ownRestore:0,parentSleep:1,parentRestore:0});
 p.apply({mode:'activity'});assert.equal(p.calls.ownRestore,1);assert.equal(p.calls.parentRestore,1);
 p.listeners.pagehide();assert.equal(p.calls.parentRestore,1);
});
test('removing the embedded page restores the parent before the bounded timer',()=>{
 const p=page();p.apply(command);p.listeners.pagehide();assert.equal(p.calls.parentRestore,1);
});
test('embedded cooperation cannot control another unit or origin',()=>{
 for(const options of [{parentName:'phone191'},{crossOrigin:true},{embedded:false}]){const p=page(options);p.apply(command);assert.equal(p.calls.parentSleep,0);}
 for(const options of [{unit:'personal'},{unit:'RenderRig'}]){const p=page(options);p.apply(command);assert.equal(p.calls.ownSleep,0);assert.equal(p.calls.parentSleep,0);}
});
test('expired, malformed and overlong commands do not release any lock',()=>{
 for(const patch of [{id:'bad'},{expiresAt:1000000},{expiresAt:1120001},{expiresAt:'1120000'}]){const p=page();p.apply({mode:'dashboard',sleepTest:{...command.sleepTest,...patch}});assert.equal(p.calls.ownSleep,0);assert.equal(p.calls.parentSleep,0);}
 const p=page();p.apply({...command,mode:'clock'});assert.equal(p.calls.ownSleep,0);
});
