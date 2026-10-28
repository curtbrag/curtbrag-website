const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../public/scripts/cluster-email.js'),'utf8');
function harness(options={}) {
  class Element {
    constructor(){this.children=[];this.fields=new Map();this.style={};this.disabled=false;this.textContent='';this.hidden=false;}
    append(...values){this.children.push(...values);}
    before(value){this.beforeElement=value;}
    replaceChildren(){this.children=[];}
    querySelector(selector){if(selector==='h1')return null;if(!this.fields.has(selector))this.fields.set(selector,new Element());return this.fields.get(selector);}
    querySelectorAll(){return [...this.fields.values(),...this.children.flatMap(child=>[child,...child.querySelectorAll()])];}
  }
  const panel=new Element(),requests=[],timers=new Map();let responseSnapshot,ident=0,timerId=0,clock=Date.now();
  class Clock extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
  const ctx=vm.createContext({Date:Clock,Set,console,AbortController,sessionStorage:{getItem:()=> 'fixture'},crypto:{randomUUID:()=> 'test-id-'+(++ident)},
    setTimeout:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,at:clock+delay});return id;},clearTimeout:id=>timers.delete(id),
    fetch:async(url,requestOptions)=>{requests.push({url,options:requestOptions});return options.fetch?options.fetch(url,requestOptions,requests.length):{ok:true,json:async()=>url.endsWith('action=status')?responseSnapshot:{ok:true,status:'queued'}};},
    document:{getElementById:id=>id==='panel'?panel:null,createElement:()=>new Element()}});
  const end=source.indexOf('  render();refresh();setInterval');assert.ok(end>0);
  vm.runInContext(source.slice(0,end)+'globalThis.emailApi={render,resultText,request,refresh,submit,set:value=>{snapshot=value;statusAvailable=true;},card,confirmation,busy:()=>busy,refreshing:()=>refreshing};})();',ctx);
  return {...ctx.emailApi,requests,timers,respond:value=>{responseSnapshot=value;},set:value=>{responseSnapshot=value;ctx.emailApi.set(value);},advance:async ms=>{clock+=ms;for(const [id,timer] of [...timers])if(timer.at<=clock){timers.delete(id);timer.callback();}for(let i=0;i<20;i++)await Promise.resolve();}};
}
const unit={unit:'phone253',address:'phone253@curtbrag.com',installed:true,connected:true};
function render(job,stamp=Date.now()) {
  const h=harness();h.set({bridge:{at:stamp},units:[unit],jobs:job?[{id:'test-12345678',unit:unit.unit,action:'test',created_at:1,...job}]:[]});h.render();
  const row=h.card.querySelector('#mail-units').children[0];return {h,label:row.children[2].textContent,buttons:row.children[3].children};
}
test('accepted mail stays accepted when delivery checking reports a timeout',()=>{
  const r=render({status:'complete',result:{ok:false,accepted:true,delivery_verified:false,error:'TimeoutError'}});
  assert.equal(r.label,'Test accepted; delivery unconfirmed');assert.ok(r.buttons.every(b=>!b.disabled));
});
test('interrupted tests state uncertainty and unlock Check and deliberate new tests',()=>{
  const r=render({status:'interrupted',result:{ok:false,interrupted:true,delivery_unconfirmed:true,error:'Previous request interrupted'}});
  assert.match(r.label,/sending outcome unconfirmed/);assert.match(r.label,/not replayed/);assert.ok(r.buttons.every(b=>!b.disabled));
  assert.equal(r.h.card.querySelector('#mail-check-all').disabled,false);
});
test('a live running claim stays disabled and an expired unsent job is accurately labelled',()=>{
  const running=render({status:'running',started_at:Date.now()});assert.ok(running.buttons.every(b=>b.disabled));
  assert.equal(running.h.card.querySelector('#mail-test-all').disabled,true);
  const expired=render({status:'expired'});assert.equal(expired.label,'Expired before execution');assert.ok(expired.buttons.every(b=>!b.disabled));
});
test('offline and future relay heartbeats disable individual and bulk controls',()=>{
  for(const stamp of [Date.now()-120001,Date.now()+60000]){
    const r=render(null,stamp);assert.ok(r.buttons.every(b=>b.disabled));
    assert.equal(r.h.card.querySelector('#mail-check-all').disabled,true);assert.equal(r.h.card.querySelector('#mail-test-all').disabled,true);
  }
});
test('test preview and cancel never open a blocking modal or enqueue an email',async()=>{
  const h=harness();h.set({bridge:{at:Date.now()},units:[unit],jobs:[]});h.render();
  await h.card.querySelector('#mail-test-all').onclick();
  assert.equal(h.confirmation.hidden,false);assert.equal(h.requests.length,0);
  assert.match(h.confirmation.querySelector('#mail-confirm-message').textContent,/1 units’ own inboxes/);
  assert.equal(h.confirmation.querySelector('#mail-confirm-units').textContent,'phone253 → phone253@curtbrag.com');
  h.confirmation.querySelector('#mail-confirm-cancel').onclick();
  assert.equal(h.confirmation.hidden,true);assert.equal(h.requests.length,0);
  assert.match(h.card.querySelector('#mail-state').textContent,/No email was queued/);
  await h.confirmation.querySelector('#mail-confirm-send').onclick();assert.equal(h.requests.length,0);
});
test('inline confirmation sends exactly the selected units once despite a double click',async()=>{
  const h=harness(),second={...unit,unit:'phone191',address:'phone191@curtbrag.com'};
  h.set({bridge:{at:Date.now()},units:[unit,second],jobs:[]});h.render();
  await h.card.querySelector('#mail-test-all').onclick();
  assert.equal(h.confirmation.querySelector('#mail-confirm-send').textContent,'Send 2 test emails');
  assert.equal(h.confirmation.querySelector('#mail-confirm-units').textContent,'phone253 → phone253@curtbrag.com\nphone191 → phone191@curtbrag.com');
  const send=h.confirmation.querySelector('#mail-confirm-send').onclick;
  await Promise.all([send(),send()]);
  const posts=h.requests.filter(row=>row.options.method==='POST');assert.equal(posts.length,2);
  assert.deepEqual(posts.map(row=>JSON.parse(row.options.body).unit),['phone253','phone191']);
  assert.ok(posts.every(row=>JSON.parse(row.options.body).action==='test'));assert.equal(h.confirmation.hidden,true);
  await h.card.querySelector('#mail-test-all').onclick();
  assert.equal(h.confirmation.querySelector('#mail-confirm-cancel').disabled,false);
  h.confirmation.querySelector('#mail-confirm-cancel').onclick();
  assert.equal(h.requests.filter(row=>row.options.method==='POST').length,2);
});
test('per-unit test previews only its own inbox and preserves uncertain-outcome warning',async()=>{
  const r=render({status:'interrupted',result:{interrupted:true}});
  await r.buttons[1].onclick();
  assert.equal(r.h.requests.length,0);assert.equal(r.h.confirmation.querySelector('#mail-confirm-send').textContent,'Send 1 test email');
  assert.match(r.h.confirmation.querySelector('#mail-confirm-message').textContent,/unconfirmed sending outcome/);
  await r.h.confirmation.querySelector('#mail-confirm-send').onclick();
  const posts=r.h.requests.filter(row=>row.options.method==='POST');assert.equal(posts.length,1);
  assert.equal(JSON.parse(posts[0].options.body).unit,'phone253');
});

const pending=()=>new Promise(()=>{});
const response=value=>({ok:true,status:200,json:async()=>value});
const ready=(units=[unit],jobs=[])=>({bridge:{at:Date.now()-1000},units,jobs});
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const postRequests=h=>h.requests.filter(row=>row.options.method==='POST');
const unitButtons=h=>h.card.querySelector('#mail-units').children[0]?.children[3].children||[];

test('a hung status fetch has one bounded request, aborts and permits a later manual recovery',async()=>{
  let hung=true;const h=harness({fetch:()=>hung?pending():response(ready())});h.render();
  assert.equal(h.card.querySelector('#mail-check-all').disabled,true);assert.equal(h.card.querySelector('#mail-test-all').disabled,true);
  const first=h.refresh(),second=h.refresh();assert.equal(first,second);assert.equal(h.requests.length,1);
  const signal=h.requests[0].options.signal;assert.equal(signal.aborted,false);
  await h.advance(15000);await first;
  assert.equal(signal.aborted,true);assert.equal(h.refreshing(),null);assert.equal(h.timers.size,0);
  assert.equal(h.card.querySelector('#mail-refresh').disabled,false);assert.match(h.card.querySelector('#mail-state').textContent,/status timed out/);
  assert.equal(h.card.querySelector('#mail-check-all').disabled,true);assert.equal(postRequests(h).length,0);
  hung=false;await h.refresh();
  assert.equal(h.requests.length,2);assert.equal(h.card.querySelector('#mail-check-all').disabled,false);
  assert.ok(unitButtons(h).every(button=>!button.disabled));assert.equal(h.timers.size,0);
});

test('status JSON decoding shares the same deadline and a late response cannot replace recovered data',async()=>{
  let release,first=true;const body=new Promise(resolve=>{release=resolve;});
  const h=harness({fetch:()=>first?(first=false,{ok:true,status:200,json:()=>body}):response(ready())});
  const old=h.refresh();await flush();await h.advance(15000);await old;
  assert.equal(h.requests[0].options.signal.aborted,true);assert.match(h.card.querySelector('#mail-state').textContent,/status timed out/);
  await h.refresh();const state=h.card.querySelector('#mail-state').textContent;
  release({bridge:{at:0},units:[],jobs:[]});await flush();
  assert.equal(h.card.querySelector('#mail-state').textContent,state);assert.equal(h.card.querySelector('#mail-units').children.length,1);
  assert.equal(h.card.querySelector('#mail-check-all').disabled,false);assert.equal(h.requests.length,2);
});

test('a timed-out Check enqueue is unconfirmed and a later status read restores responsive controls without replay',async()=>{
  let status=ready();const h=harness({fetch:(url,options)=>options.method==='POST'?pending():response(status)});h.set(status);h.render();
  const check=h.request([unit.unit],'check');await flush();assert.equal(h.busy(),true);assert.equal(postRequests(h).length,1);
  const id=JSON.parse(postRequests(h)[0].options.body).id;
  await h.advance(15000);await check;
  assert.equal(postRequests(h).length,1);assert.equal(postRequests(h)[0].options.signal.aborted,true);assert.equal(h.busy(),false);
  assert.equal(h.card.querySelector('#mail-refresh').disabled,false);assert.ok(unitButtons(h).every(button=>!button.disabled));
  assert.match(h.card.querySelector('#mail-state').textContent,/timed out.*Queueing outcome unconfirmed/);
  assert.match(h.card.querySelector('#mail-units').children[0].children[2].textContent,/Queueing outcome unconfirmed/);
  status=ready([unit],[{id,unit:unit.unit,action:'check',status:'complete',created_at:1,result:{ok:true}}]);
  // Change only the status response; the uncertain POST is never repeated.
  await h.refresh();assert.equal(h.card.querySelector('#mail-units').children[0].children[2].textContent,'Incoming and outgoing login verified');
  assert.equal(postRequests(h).length,1);assert.equal(h.timers.size,0);
});

test('a timed-out test stops the remaining bulk submissions and warns before any deliberate new test',async()=>{
  const second={...unit,unit:'phone191',address:'phone191@curtbrag.com'};
  const h=harness({fetch:(url,options)=>options.method==='POST'?pending():response(ready([unit,second]))});h.set(ready([unit,second]));h.render();
  h.request([unit.unit,second.unit],'test');const send=h.confirmation.querySelector('#mail-confirm-send').onclick;
  const sent=send();await flush();await send();assert.equal(postRequests(h).length,1);
  await h.advance(15000);await sent;
  assert.equal(h.busy(),false);assert.equal(postRequests(h).length,1);assert.equal(h.confirmation.hidden,true);
  assert.match(h.card.querySelector('#mail-state').textContent,/phone253:.*unconfirmed.*phone191: not submitted/);
  assert.ok(h.card.querySelector('#mail-units').children.every(row=>row.children[3].children.every(button=>!button.disabled)));
  h.request([unit.unit],'test');assert.equal(h.confirmation.hidden,false);assert.match(h.confirmation.querySelector('#mail-confirm-message').textContent,/earlier test has an unconfirmed sending outcome/);
  h.confirmation.querySelector('#mail-confirm-cancel').onclick();assert.equal(postRequests(h).length,1);
});

test('an uncertain enqueue is reconciled by its own request ID and never falsely called delivered',async()=>{
  let requestId;const h=harness({fetch:(url,options)=>{
    if(options.method==='POST'){requestId=JSON.parse(options.body).id;return pending();}
    return response(ready([unit],[{id:requestId,unit:unit.unit,action:'test',status:'queued',created_at:1}]));
  }});h.set(ready());h.render();h.request([unit.unit],'test');const sent=h.confirmation.querySelector('#mail-confirm-send').onclick();
  await h.advance(15000);await sent;
  assert.equal(postRequests(h).length,1);assert.match(h.card.querySelector('#mail-state').textContent,/queued \(confirmed by refreshed status\)/);
  assert.equal(h.card.querySelector('#mail-units').children[0].children[2].textContent,'queued');assert.ok(unitButtons(h).every(button=>button.disabled));
  assert.doesNotMatch(h.card.querySelector('#mail-state').textContent,/sent and received/);
});

test('hung enqueue and hung follow-up status both settle and a later manual refresh recovers',async()=>{
  let recovered=false;const h=harness({fetch:()=>recovered?response(ready()):pending()});h.set(ready());h.render();
  const check=h.request([unit.unit],'check');await flush();await h.advance(15000);
  assert.equal(h.requests.length,2);assert.equal(h.busy(),true);await h.advance(15000);await check;
  assert.equal(h.busy(),false);assert.equal(h.refreshing(),null);assert.equal(h.timers.size,0);assert.equal(postRequests(h).length,1);
  assert.equal(h.card.querySelector('#mail-refresh').disabled,false);assert.equal(h.card.querySelector('#mail-check-all').disabled,true);
  assert.match(h.card.querySelector('#mail-state').textContent,/Queueing outcome unconfirmed/);assert.match(h.card.querySelector('#mail-state').textContent,/status is unavailable/);
  h.request([unit.unit],'check');assert.equal(postRequests(h).length,1);assert.match(h.card.querySelector('#mail-state').textContent,/Refresh email status/);
  recovered=true;await h.refresh();assert.equal(h.card.querySelector('#mail-check-all').disabled,false);assert.ok(unitButtons(h).every(button=>!button.disabled));
  assert.equal(postRequests(h).length,1);
});

test('POST response-body timeout is also unconfirmed and does not wait forever after headers',async()=>{
  const h=harness({fetch:(url,options)=>options.method==='POST'?{ok:true,status:200,json:pending}:response(ready())});h.set(ready());h.render();
  const check=h.request([unit.unit],'check');await flush();await h.advance(15000);await check;
  assert.equal(h.busy(),false);assert.equal(postRequests(h).length,1);assert.equal(h.timers.size,0);
  assert.match(h.card.querySelector('#mail-state').textContent,/Queueing outcome unconfirmed/);assert.equal(h.card.querySelector('#mail-refresh').disabled,false);
});

test('transport errors or malformed successful enqueue replies never claim queued or retry',async()=>{
  for(const reply of [()=>Promise.reject(new TypeError('Failed to fetch')),()=>({ok:true,status:200,json:async()=>{throw new SyntaxError('Invalid JSON');}}),()=>response({ok:false,error:'Malformed success'})]){
    const h=harness({fetch:(url,options)=>options.method==='POST'?reply():response(ready())});h.set(ready());h.render();
    await h.request([unit.unit],'check');assert.equal(postRequests(h).length,1);assert.equal(h.busy(),false);
    assert.match(h.card.querySelector('#mail-state').textContent,/Queueing outcome unconfirmed/);assert.equal(h.timers.size,0);
  }
});

test('explicit server rejection remains a rejection and later manual requests can succeed',async()=>{
  let reject=true;const h=harness({fetch:(url,options)=>options.method==='POST'?(reject?{ok:false,status:409,json:async()=>({error:'This mailbox already has a request in progress. Refresh its status.'})}:response({ok:true,status:'queued'})):response(ready())});
  h.set(ready());h.render();await h.request([unit.unit],'check');
  assert.match(h.card.querySelector('#mail-state').textContent,/already has a request in progress/);assert.doesNotMatch(h.card.querySelector('#mail-state').textContent,/unconfirmed/);
  assert.equal(h.busy(),false);assert.equal(postRequests(h).length,1);assert.equal(h.timers.size,0);
  reject=false;await h.request([unit.unit],'check');assert.equal(postRequests(h).length,2);assert.match(h.card.querySelector('#mail-state').textContent,/phone253: queued/);
});

test('malformed status keeps the last report but disables stale actions until a valid refresh',async()=>{
  let valid=false;const h=harness({fetch:()=>response(valid?ready():{units:[null],jobs:[]})});h.set(ready());h.render();await h.refresh();
  assert.equal(h.card.querySelector('#mail-units').children.length,1);assert.equal(h.card.querySelector('#mail-check-all').disabled,true);
  assert.ok(unitButtons(h).every(button=>button.disabled));assert.match(h.card.querySelector('#mail-state').textContent,/could not be confirmed/);
  assert.equal(h.card.querySelector('#mail-refresh').disabled,false);assert.equal(h.timers.size,0);
  valid=true;await h.refresh();assert.equal(h.card.querySelector('#mail-check-all').disabled,false);assert.equal(postRequests(h).length,0);
});

test('a pre-submit background read cannot unlock controls before a fresh post-enqueue status confirms the queued job',async()=>{
  let oldRead,freshRead,reads=0,jobId;
  const previous=new Promise(resolve=>{oldRead=resolve;}),after=new Promise(resolve=>{freshRead=resolve;});
  const h=harness({fetch:(url,options)=>{
    if(options.method==='POST'){jobId=JSON.parse(options.body).id;return response({ok:true,job_id:jobId,status:'queued'});}
    return ++reads===1?previous:after;
  }});h.set(ready());h.render();
  const background=h.refresh(),submit=h.request([unit.unit],'check');await flush();
  assert.equal(h.requests.length,2);assert.equal(postRequests(h).length,1);assert.equal(h.busy(),true);
  oldRead(response(ready()));await background;await flush();
  assert.equal(h.requests.length,3);assert.equal(reads,2);assert.equal(h.busy(),true);
  assert.equal(h.card.querySelector('#mail-check-all').disabled,true);assert.ok(unitButtons(h).every(button=>button.disabled));
  const concurrent=h.refresh();assert.equal(h.requests.length,3,'Manual refresh shares the new post-submit status read');
  freshRead(response(ready([unit],[{id:jobId,unit:unit.unit,action:'check',status:'queued',created_at:1}])));await concurrent;await submit;
  assert.equal(h.busy(),false);assert.equal(postRequests(h).length,1);assert.equal(h.timers.size,0);
  assert.equal(h.card.querySelector('#mail-refresh').disabled,false);assert.equal(h.card.querySelector('#mail-check-all').disabled,true);
  assert.ok(unitButtons(h).every(button=>button.disabled));assert.equal(h.card.querySelector('#mail-units').children[0].children[2].textContent,'queued');
});
