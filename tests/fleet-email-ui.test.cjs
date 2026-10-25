const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../public/scripts/cluster-email.js'),'utf8');
function harness() {
  class Element {
    constructor(){this.children=[];this.fields=new Map();this.style={};this.disabled=false;this.textContent='';}
    append(value){this.children.push(value);}
    replaceChildren(){this.children=[];}
    querySelector(selector){if(selector==='h1')return null;if(!this.fields.has(selector))this.fields.set(selector,new Element());return this.fields.get(selector);}
  }
  const panel=new Element(),ctx=vm.createContext({Date,Set,console,document:{getElementById:id=>id==='panel'?panel:null,createElement:()=>new Element()}});
  vm.runInContext(source.slice(0,source.indexOf('  refresh();setInterval'))+'globalThis.emailApi={render,resultText,set:value=>snapshot=value,card};})();',ctx);
  return ctx.emailApi;
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
