import test from 'node:test';
import assert from 'node:assert/strict';
import {issueDisplayTicket, authorizeDisplay, DISPLAY_COOKIE, displayDigest} from '../netlify/edge-functions/lib/display-access.js';
import {createSiteLock} from '../netlify/edge-functions/lib/site-lock-core.js';
const HOST='https://curtbrag.com', PASSWORD='fixture-password';
function setup(){
 const entries=new Map();let time=100000,password=PASSWORD,calls=0;
 const store={get:async k=>entries.get(k)||null,setJSON:async(k,v)=>entries.set(k,v),delete:async k=>entries.delete(k)};
 const gate=createSiteLock({getPassword:async()=>password,getSessions:()=>store,getDisplaySessions:()=>store,now:()=>time});
 const context={next:async()=>{calls++;return new Response('display-content');}};
 const issue=()=>issueDisplayTicket({store,phone:'phone253',host:'curtbrag.com',password,now:time});
 return {store,entries,gate,context,issue,now:()=>time,advance:n=>time+=n,password:p=>password=p,calls:()=>calls};
}
async function connect(s){
 const ticket=await s.issue(), entry=HOST+'/cluster/display.html?mode=activity&name=phone253&display_ticket='+ticket;
 const response=await s.gate(new Request(entry),s.context);
 assert.equal(response.status,303);
 assert.equal(response.headers.get('location'),'/cluster/display.html?mode=activity&name=phone253');
 assert.equal(response.headers.get('location').includes(ticket),false);
 assert.match(response.headers.get('set-cookie'),new RegExp('^'+DISPLAY_COOKIE+'=[a-f0-9]{64}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Strict$'));
 assert.equal(s.calls(),0);
 return {cookie:response.headers.get('set-cookie').split(';')[0],entry};
}
test('a display ticket is hashed at rest, redeemed once and removed from the browser URL',async()=>{
 const s=setup(),{cookie,entry}=await connect(s);
 assert.equal(s.entries.size,1);
 assert.equal((await s.gate(new Request(entry),s.context)).status,401);
 const response=await s.gate(new Request(HOST+'/cluster/display.html?name=phone253',{headers:{cookie}}),s.context);
 assert.equal(response.status,200);assert.equal(response.headers.get('x-curtbrag-access'),'device-display');
 assert.equal(response.headers.get('x-frame-options'),'SAMEORIGIN');assert.match(response.headers.get('cache-control'),/no-store/);
 assert.equal([...s.entries.keys()].some(k=>k.includes(cookie.split('=')[1])),false);
});
test('a connected display can read only its own status and the animation page',async()=>{
 const s=setup(),{cookie}=await connect(s);
 for(const path of ['/cluster/display.html?name=phone253','/cluster/eyecandy.html','/.netlify/functions/phone-display?phone=phone253&activity=1']){
  assert.equal((await s.gate(new Request(HOST+path,{headers:{cookie}}),s.context)).status,200,path);
 }
 for(const path of ['/','/gallery/','/cluster/dashboard/','/api/cluster?action=queue-status','/.netlify/functions/cluster-api?action=devices','/.netlify/functions/phone-display?phone=phone191','/.netlify/functions/phone-display?phone=phone253&phone=phone191','/cluster/display.html?name=phone191','/cluster/display.html?name=phone253&name=phone191','/cluster/display.html','/scripts/cluster-swarm-live-v8.js']){
  assert.equal((await s.gate(new Request(HOST+path,{headers:{cookie}}),s.context)).status,401,path);
 }
 for(const method of ['POST','PUT','DELETE','HEAD']){
  assert.equal((await s.gate(new Request(HOST+'/.netlify/functions/phone-display?phone=phone253',{method,headers:{cookie}}),s.context)).status,401,method);
 }
});
test('ticket unit mismatch, duplicate, forged, cross-host and expired tickets grant no access',async()=>{
 const s=setup(),ticket=await s.issue();
 for(const url of [HOST+'/cluster/display.html?name=phone191&display_ticket='+ticket,HOST+'/cluster/display.html?name=phone253&display_ticket='+ticket+'&display_ticket='+ticket,'https://www.curtbrag.com/cluster/display.html?name=phone253&display_ticket='+ticket,HOST+'/cluster/display.html?name=phone253&display_ticket='+'a'.repeat(64)]){
  assert.equal((await s.gate(new Request(url),s.context)).status,401);
 }
 s.advance(300001);assert.equal((await s.gate(new Request(HOST+'/cluster/display.html?name=phone253&display_ticket='+ticket),s.context)).status,401);assert.equal(s.calls(),0);
});
test('password changes, cookie duplication, expiration and cross-host requests revoke display access',async()=>{
 const s=setup(),{cookie}=await connect(s),path='/cluster/display.html?name=phone253';
 assert.equal((await s.gate(new Request(HOST+path,{headers:{cookie:cookie+'; '+cookie}}),s.context)).status,401);
 assert.equal((await s.gate(new Request('https://www.curtbrag.com'+path,{headers:{cookie}}),s.context)).status,401);
 s.password('changed');assert.equal((await s.gate(new Request(HOST+path,{headers:{cookie}}),s.context)).status,401);
 s.password(PASSWORD);s.advance(86400001);assert.equal((await s.gate(new Request(HOST+path,{headers:{cookie}}),s.context)).status,401);
});
test('display-store failure never exposes protected content',async()=>{
 const s=setup(),{cookie}=await connect(s);s.store.get=async()=>{throw Error('unavailable');};
 assert.equal((await s.gate(new Request(HOST+'/cluster/display.html?name=phone253',{headers:{cookie}}),s.context)).status,503);
 assert.equal(s.calls(),0);
});
test('issue rejects unsupported units and missing password without writing a ticket',async()=>{
 const s=setup();
 for(const phone of ['RenderRig','phone237','other'])await assert.rejects(issueDisplayTicket({store:s.store,phone,host:'curtbrag.com',password:PASSWORD}));
 await assert.rejects(issueDisplayTicket({store:s.store,phone:'phone253',host:'curtbrag.com',password:''}));assert.equal(s.entries.size,0);
});
