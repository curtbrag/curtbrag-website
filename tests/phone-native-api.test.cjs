const assert = require('node:assert/strict');
const test = require('node:test');
const {fixture, STATE_KEY} = require('./control-command-api.test.cjs');
const NOW = Date.parse('2026-10-27T21:00:00Z');
const PHONES = ['phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254'];

function harness(options={}) {
  const f=fixture({now:NOW,bridge:{last_seen_at:new Date(NOW-1000).toISOString(),bridge_version:'2.6.0'},...options});
  let ready=false;
  return {f, state:()=>f.inspect('cp-commands',STATE_KEY), async post(action,body,auth=true){
    if(!ready){await f.ready();f.writes.length=0;ready=true;}
    return f.cp(action,body,{headers:{authorization:auth?'Bearer fixture-operator':''}});
  }};
}
function request(type='phone-back',target='phone253',extra={}){
  return {type,target,payload:type==='phone-open-website'?{url:'https://curtbrag.com/gallery/'}:{},request_id:'native-request-'+target,...extra};
}
function report(command,extra={}) {
  const action=command.type==='phone-back'?'back':'open-website';
  return {kind:'phone-controller-action',action,unit:command.target,...(action==='open-website'?{url:command.payload.url}:{}),
    state:action==='back'?'back-requested':'launch-requested',request_accepted:true,
    foreground_app_verified:false,visible_screen_verified:false,controller_state:'connected',error:null,...extra};
}
function completion(command,extra={}){
  return {id:command.id,type:command.type,target:command.target,status:'completed',output:JSON.stringify(report(command)),...extra};
}
test('only the eight worker phones receive typed bridge actions; personal controllers are excluded',async()=>{
  for(const type of ['phone-back','phone-open-website']) for(const unit of PHONES){
    const h=harness(),r=await h.post('queue-command',request(type,unit));assert.equal(r.status,200);
    const queued=h.state().queue;assert.equal(queued.length,1);assert.equal(queued[0].route,'bridge');
    assert.equal(queued[0].target,unit);assert.equal(queued[0].type,type);assert.equal(queued[0].request_id,'native-request-'+unit);
    assert.equal(h.f.inspect('cluster-control','queue').length,0);
  }
  for(const target of ['all','phones','pcs','s26ultra','Curtis S26 Ultra','RenderRig','Alina','Nexus','SteamDeck','viki','Phone253','phone252','phone253;input keyevent 4','192.168.1.253:39899']){
    const h=harness(),r=await h.post('queue-command',request('phone-back',target));assert.equal(r.status,400,target);assert.deepEqual(h.f.writes,[]);
  }
});
test('native actions require operator authentication, typed payloads, and request IDs',async()=>{
  const h=harness();assert.equal((await h.post('queue-command',request(),false)).status,401);assert.deepEqual(h.f.writes,[]);
  for(const payload of [undefined,null,[],{cmd:'input keyevent 4'},{endpoint:'192.168.1.253:39899'},{key:4},'back']){
    const h=harness();assert.equal((await h.post('queue-command',request('phone-back','phone253',{payload}))).status,400);assert.deepEqual(h.f.writes,[]);
  }
  for(const type of ['phone-back','phone-open-website']){
    const h=harness();assert.equal((await h.post('queue-command',request(type,'phone253',{request_id:undefined}))).status,400);
  }
  const bad=harness();assert.equal((await bad.post('queue-command',request('phone-open-website','phone253',{payload:{url:'https://example.com/',cmd:'unsafe'}}))).status,400);
});
test('URL validation rejects local, credential, port, control and injected non-URL inputs before writes',async()=>{
  for(const url of ['http://example.com/','javascript:alert(1)','file:///etc/passwd','https://user:pass@example.com/','https://example.com:8443/','https://localhost/','https://node.lan/','https://node.home/','https://127.0.0.1/','https://2130706433/','https://[::1]/','https://example.com./',' https://example.com/','https://example.com/a b','https://example.com/\nnext','https://example.com/\\path','https://example.com/'+ 'x'.repeat(2048)]){
    const h=harness();const r=await h.post('queue-command',request('phone-open-website','phone253',{payload:{url}}));assert.equal(r.status,400,url);assert.deepEqual(h.f.writes,[]);
  }
});
test('valid URL shell metacharacters remain typed navigation data and normalization is saved',async()=>{
  const h=harness(),url="https://EXAMPLE.com/page?q=$(touch%20sentinel)&a=';echo%20unsafe;#`id`";
  assert.equal((await h.post('queue-command',request('phone-open-website','phone253',{payload:{url}}))).status,200);
  const queued=h.state().queue[0];assert.deepEqual(queued.payload,{url:new URL(url).href});
  assert.equal(Object.hasOwn(queued,'cmd'),false);assert.equal(Object.hasOwn(queued.payload,'cmd'),false);
});
test('new actions require fresh online bridge2.6 while Return retains2.5 compatibility',async()=>{
  for(const bridge of [null,{}, {bridge_version:'2.5.0',last_seen_at:new Date(NOW).toISOString()},
    {bridge_version:'2.6',last_seen_at:new Date(NOW).toISOString()}, {bridge_version:'2.6.0',last_seen_at:new Date(NOW-60000).toISOString()},
    {bridge_version:'2.6.0',last_seen_at:new Date(NOW+1).toISOString()}]){
    const h=harness({bridge});assert.equal((await h.post('queue-command',request())).status,409);assert.deepEqual(h.f.writes,[]);
  }
  const h=harness({bridge:{bridge_version:'2.5.0',last_seen_at:new Date(NOW).toISOString()}});
  assert.equal((await h.post('queue-command',{type:'phone-return-termux',target:'phone253',payload:{}})).status,200);
});
test('duplicate request ID replays its receipt without another command and overlapping screen actions reject',async()=>{
  const h=harness(),body=request();const a=await h.post('queue-command',body),b=await h.post('queue-command',body);
  assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(a.body.command_id,b.body.command_id);assert.equal(h.state().queue.length,1);
  assert.equal((await h.post('queue-command',request('phone-open-website','phone253',{request_id:'another-request-253'}))).status,409);
  assert.equal((await h.post('queue-command',{type:'phone-return-termux',target:'phone253',payload:{}})).status,409);
  assert.equal((await h.post('queue-command',request('phone-back','phone191'))).status,200);
});
test('accepted native receipts preserve request identity and never assert screen or foreground success',async()=>{
  for(const type of ['phone-back','phone-open-website']){
    const h=harness();await h.post('queue-command',request(type));const c=h.state().queue[0];
    assert.equal((await h.post('bridge-complete',completion(c))).status,200);
    const archived=h.state().history[0];assert.equal(archived.status,'completed');assert.equal(archived.request_id,c.request_id);
    assert.deepEqual(JSON.parse(archived.output),report(c));assert.match(archived.result_summary,/unverified/);
    const writes=h.f.writes.length;assert.equal((await h.post('bridge-complete',completion(c))).status,200);assert.equal(h.state().history.length,1);
    assert.ok(h.f.writes.length>=writes);assert.equal(h.state().queue.length,0);
  }
});
test('unavailable authorization remains a failed native result',async()=>{
  const h=harness();await h.post('queue-command',request());const c=h.state().queue[0];
  const value=report(c,{state:'failed',request_accepted:false,controller_state:'unauthorized',error:'No authorized phone controller'});
  assert.equal((await h.post('bridge-complete',completion(c,{status:'failed',output:JSON.stringify(value)}))).status,200);
  assert.equal(h.state().history[0].status,'failed');assert.deepEqual(JSON.parse(h.state().history[0].output),value);
});
test('forged completion identity, URL, accepted state and screen proof are rejected without consuming queue',async()=>{
  const overrides=[{unit:'s26ultra'},{action:'back'},{url:'https://other.example.net/'},{state:'termux-foreground'},
    {request_accepted:false},{foreground_app_verified:true},{visible_screen_verified:true},{controller_state:'unauthorized'},
    {controller_state:'connected;input keyevent 4'},{error:'Success with error'}];
  for(const changes of overrides){
    const h=harness();await h.post('queue-command',request('phone-open-website'));const c=h.state().queue[0];
    assert.equal((await h.post('bridge-complete',completion(c,{output:JSON.stringify(report(c,changes))}))).status,400,JSON.stringify(changes));assert.equal(h.state().queue.length,1);assert.equal(h.state().history.length,0);
  }
  const h=harness();await h.post('queue-command',request());const c=h.state().queue[0];
  assert.equal((await h.post('bridge-complete',completion(c,{target:'phone191'}))).status,400);
  assert.equal((await h.post('bridge-complete',completion(c,{type:'phone-open-website'}))).status,400);
});
test('native history sanitizes untrusted extra report fields and enforces identical replay',async()=>{
  const h=harness();await h.post('queue-command',request());const c=h.state().queue[0];
  assert.equal((await h.post('bridge-complete',completion(c,{output:JSON.stringify(report(c,{command:'unsafe',debug:'private'})),result_summary:'untrusted'}))).status,200);
  assert.deepEqual(JSON.parse(h.state().history[0].output),report(c));
  assert.equal((await h.post('bridge-complete',completion(c,{output:JSON.stringify(report(c,{controller_state:'changed'}))}))).status,409);
});
