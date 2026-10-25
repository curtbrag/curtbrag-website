const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../public/scripts/cluster-email.js'),'utf8');
function harness() {
  class Element {
    constructor(){this.children=[];this.fields=new Map();this.style={};this.disabled=false;this.textContent='';this.hidden=false;}
    append(...values){this.children.push(...values);}
    before(value){this.beforeElement=value;}
    replaceChildren(){this.children=[];}
    querySelector(selector){if(selector==='h1')return null;if(!this.fields.has(selector))this.fields.set(selector,new Element());return this.fields.get(selector);}
    querySelectorAll(){return [...this.fields.values(),...this.children.flatMap(child=>[child,...child.querySelectorAll()])];}
  }
  const panel=new Element(),requests=[];let responseSnapshot,ident=0;
  const ctx=vm.createContext({Date,Set,console,AbortSignal,sessionStorage:{getItem:()=> 'fixture'},crypto:{randomUUID:()=> 'test-id-'+(++ident)},
    fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>url.endsWith('action=status')?responseSnapshot:{ok:true,status:'queued'}};},
    document:{getElementById:id=>id==='panel'?panel:null,createElement:()=>new Element()}});
  vm.runInContext(source.slice(0,source.indexOf('  refresh();setInterval'))+'globalThis.emailApi={render,resultText,request,set:value=>snapshot=value,card,confirmation};})();',ctx);
  return {...ctx.emailApi,requests,set:value=>{responseSnapshot=value;ctx.emailApi.set(value);}};
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
