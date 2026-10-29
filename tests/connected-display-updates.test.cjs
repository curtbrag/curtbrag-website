const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.resolve(__dirname,'../public/scripts/cluster-swarm-live-v8.js'),'utf8');
const start=source.indexOf('  function ensureDisplayControls(){'),end=source.indexOf('\n  function ensureControlLayout()',start);
assert.ok(start>=0&&end>start);
const units=[173,174,176,177,191,195,253,254].map(n=>'phone'+n);
const revision='11111111-1111-4111-8111-111111111111';
const savedReceipt=body=>({ok:true,phone:body.phone,mode:body.mode,revision,...(body.sleepTest?{sleepTest:{id:revision,expiresAt:Date.now()+120000}}:{})});
function harness({target='all',mode='activity',connect=false,nodes=[],failAvailability=false,failPhone=null,pauseFirst=false,fetch:customFetch}={}){
 const elements={},requests=[],jobs=[],statusCalls=[],loads=[],timers=[];
 let release;const gate=pauseFirst?new Promise(r=>{release=r;}):Promise.resolve();
 const element=id=>elements[id]||=( {id,disabled:false,value:id==='display-target'?target:id==='display-mode'?mode:'',checked:id==='display-connect'&&connect,textContent:'',href:''} );
 elements['cluster-view-fleet']={children:[{}],insertBefore(card){elements[card.id]=card;}};
 const document={getElementById:id=>elements[id]||null,createElement(){return {set innerHTML(html){for(const match of html.matchAll(/id="([^"]+)"/g))element(match[1]);}};}};
 const context=vm.createContext({document,Array,Set,URL,Error,AbortController,setTimeout:(callback,ms)=>{timers.push({callback,ms,cleared:false});return timers.length-1;},clearTimeout:id=>{timers[id].cleared=true;},location:{origin:'https://curtbrag.com'},PHONE_IDS:new Set(units),token:()=> 'fixture',setControlView(){},
  canonicalize:r=>r,
  swarmApi:async action=>{statusCalls.push(action);if(failAvailability)throw Error('Availability unavailable');return {nodes};},
  fetch:async(url,options)=>{const body=options.body?JSON.parse(options.body):null;requests.push({url,method:options.method,body,signal:options.signal});if(requests.length===1)await gate;if(customFetch)return customFetch(url,options,body);const phone=body?.phone||new URL(url,'https://curtbrag.com').searchParams.get('phone');return {ok:phone!==failPhone,status:phone===failPhone?503:200,json:async()=>body?{...savedReceipt(body),display_url:'https://curtbrag.com/cluster/display.html?mode='+body.mode+'&name='+body.phone+'&display_ticket='+'f'.repeat(64)}:{mode:'activity',revision,activity:{unit:phone}}};},
  browserOpenCommand:url=>'browser '+url,
  enqueueSwarm:async(type,cmd,targets)=>jobs.push({type,cmd,targets}),load:async force=>loads.push(force),
 });
 vm.runInContext(source.slice(start,end)+'\nensureDisplayControls();',context);
 return {el:elements,requests,jobs,statusCalls,loads,release,timers,update:()=>elements['display-update'].onclick(),check:()=>elements['display-check'].onclick(),open:()=>elements['display-send'].onclick(),sleep:()=>elements['display-sleep'].onclick(),expire(){const t=timers.find(t=>!t.cleared);assert.ok(t);assert.equal(t.ms,12000);t.callback();}};
}

test('connected updates save exactly eight phone modes without browser jobs or new display credentials',async()=>{
 const h=harness({connect:true,failAvailability:true});await h.update();
 assert.deepEqual(h.requests.map(r=>r.body.phone),units);
 assert.ok(h.requests.every(r=>r.url==='/.netlify/functions/phone-display'&&r.body.mode==='activity'&&!('connect' in r.body)));
 assert.equal(h.jobs.length,0);assert.equal(h.statusCalls.length,0);assert.equal(h.loads.length,0);
 assert.match(h.el['display-state'].textContent,/Open display pages check for changes every 10 seconds/);
 assert.doesNotMatch(h.el['display-state'].textContent,/Browser launch queued|verified|all.*online/);assert.match(h.el['display-state'].textContent,/do not confirm the screens changed/);
});
test('one selected phone changes without touching other devices or requiring a fresh worker heartbeat',async()=>{
 const h=harness({target:'phone253',mode:'clock',failAvailability:true});await h.update();
 assert.deepEqual(h.requests.map(r=>r.body),[{phone:'phone253',mode:'clock'}]);assert.equal(h.jobs.length,0);
});

test('sleep test uses connected pages only and cannot issue credentials or browser jobs',async()=>{
 const h=harness({target:'phone253',mode:'clock',connect:true,failAvailability:true});await h.sleep();
 assert.deepEqual(h.requests.map(r=>r.body),[{phone:'phone253',mode:'dashboard',sleepTest:true}]);assert.equal(h.jobs.length,0);assert.equal(h.statusCalls.length,0);
 assert.match(h.el['display-state'].textContent,/does not force screens off or verify a wake/);
 assert.equal(h.el['display-sleep'].disabled,false);
});
test('partial configuration failures name saved phones and do not dispatch fallback browser launches',async()=>{
 const h=harness({failPhone:'phone176'});await h.update();
 assert.deepEqual(h.requests.map(r=>r.body.phone),units);assert.match(h.el['display-state'].textContent,/Display mode saved: phone173, phone174, phone177, phone191, phone195, phone253, phone254/);
 assert.match(h.el['display-report'].textContent,/phone176 · Save unconfirmed/);assert.equal(h.jobs.length,0);assert.equal(h.requests.filter(r=>r.body.phone==='phone176').length,1);
 for(const id of ['display-update','display-check','display-send','display-target','display-mode','display-connect'])assert.equal(h.el[id].disabled,false);
});
test('concurrent clicks cannot reopen browsers or duplicate an in-flight connected update',async()=>{
 const h=harness({pauseFirst:true});const first=h.update();
 assert.equal(h.el['display-send'].disabled,true);assert.equal(h.el['display-target'].disabled,true);
 await h.open();await h.update();assert.equal(h.requests.length,1);assert.equal(h.statusCalls.length,0);
 h.el['display-target'].value='phone253';h.el['display-mode'].value='clock';h.release();await first;
 assert.deepEqual(h.requests.map(r=>r.body.phone),units);assert.ok(h.requests.every(r=>r.body.mode==='activity'));assert.equal(h.jobs.length,0);
});
test('open/reconnect preserves availability checks and launches only idle online selected workers',async()=>{
 const h=harness({connect:true,nodes:[{id:'phone173',online:true,busy:false},{id:'phone174',online:true,busy:true},{id:'phone176',online:false,busy:false}]});await h.open();
 assert.deepEqual(h.statusCalls,['queue-status']);assert.equal(h.requests.length,8);assert.equal(h.jobs.length,1);
 assert.deepEqual(Array.from(h.jobs[0].targets),['phone173']);assert.equal(h.jobs[0].type,'shell');assert.equal(h.requests[0].body.connect,true);
 assert.ok(h.requests.slice(1).every(r=>!('connect' in r.body)));assert.match(h.el['display-state'].textContent,/phone174 \(busy\)/);assert.deepEqual(h.loads,[true]);
});
test('failed launch availability cannot silently become a connected update',async()=>{
 const h=harness({failAvailability:true});await h.open();assert.equal(h.requests.length,0);assert.equal(h.jobs.length,0);assert.match(h.el['display-state'].textContent,/Availability unavailable/);
});
test('out-of-fleet targets and invalid modes are rejected before any write or launch',async()=>{
 for(const options of [{target:'RenderRig'},{target:'personal'},{target:'phone253;id'},{mode:'invalid'}]){
  const h=harness(options);await h.update();assert.equal(h.requests.length,0);assert.equal(h.jobs.length,0);assert.equal(h.statusCalls.length,0);
 }
});


test('a rejected middle-phone save does not abandon the other selected mode updates',async()=>{
 const h=harness({fetch:async(url,request,body)=>body.phone==='phone176'?{ok:false,status:401}:{ok:true,json:async()=>savedReceipt(body)}});await h.update();
 assert.deepEqual(h.requests.map(r=>r.body.phone),units);assert.equal(h.jobs.length,0);
 assert.match(h.el['display-report'].textContent,/phone176 · Save rejected/);assert.match(h.el['display-report'].textContent,/phone254 · Activity saved/);
 assert.match(h.el['display-state'].textContent,/1\/8 saves failed or unconfirmed/);assert.match(h.el['display-state'].textContent,/No requests were repeated/);
});

test('ordinary mode saves reject malformed, wrong-unit and wrong-mode successful receipts',async()=>{
 for(const change of [r=>({...r,ok:false}),r=>({...r,phone:'phone191'}),r=>({...r,phone:undefined}),r=>({...r,mode:'clock'}),r=>({...r,revision:'invalid'}),r=>({...r,sleepTest:{id:r.revision,expiresAt:Date.now()+120000}})]){
  const h=harness({fetch:async(url,request,body)=>({ok:true,json:async()=>body.phone==='phone176'?change(savedReceipt(body)):savedReceipt(body)})});await h.update();
  assert.deepEqual(h.requests.map(r=>r.body.phone),units);assert.equal(h.jobs.length,0);assert.match(h.el['display-report'].textContent,/phone176 · Save unconfirmed/);
  assert.doesNotMatch(h.el['display-report'].textContent,/phone176 · Activity saved/);assert.match(h.el['display-report'].textContent,/phone254 · Activity saved/);
 }
});

test('malformed JSON is an uncertain save, not a successful setting or automatic retry',async()=>{
 const h=harness({fetch:async(url,request,body)=>({ok:true,json:async()=>{if(body.phone==='phone176')throw Error('bad JSON containing a private URL');return savedReceipt(body);}})});await h.update();
 assert.equal(h.requests.length,8);assert.equal(h.requests.filter(r=>r.body.phone==='phone176').length,1);assert.equal(h.jobs.length,0);
 assert.match(h.el['display-report'].textContent,/phone176 · Save unconfirmed/);assert.doesNotMatch(h.el['display-report'].textContent,/private URL/);
});

test('a mode-save JSON-body timeout does not replay that phone or block later distinct phones',async()=>{
 let started;const entered=new Promise(r=>started=r);
 const h=harness({fetch:async(url,request,body)=>({ok:true,json:()=>body.phone==='phone173'?(started(),new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))):Promise.resolve(savedReceipt(body))})});
 const pending=h.update();await entered;await h.check();await h.open();assert.equal(h.requests.length,1);h.expire();await pending;
 assert.deepEqual(h.requests.map(r=>r.body.phone),units);assert.equal(h.jobs.length,0);assert.match(h.el['display-report'].textContent,/phone173 · Save unconfirmed/);assert.match(h.el['display-report'].textContent,/phone254 · Activity saved/);
 assert.ok(h.timers.every(t=>t.cleared));for(const id of ['display-update','display-check','display-send','display-sleep','display-target','display-mode','display-connect'])assert.equal(h.el[id].disabled,false);
});

test('a failed sleep setting leaves later selected phones eligible for their one update',async()=>{
 const h=harness({failPhone:'phone176',connect:true});await h.sleep();
 assert.deepEqual(h.requests.map(r=>r.body.phone),units);assert.ok(h.requests.every(r=>r.body.mode==='dashboard'&&r.body.sleepTest===true&&!('connect' in r.body)));
 assert.equal(h.jobs.length,0);assert.match(h.el['display-report'].textContent,/phone254 · Sleep test saved/);
});

test('Check saved settings makes only own-unit GET reads and never changes or launches anything',async()=>{
 const h=harness({connect:true,mode:'clock',failAvailability:true});await h.check();
 assert.equal(h.requests.length,8);assert.ok(h.requests.every(r=>r.method==='GET'&&r.body===null));
 assert.deepEqual(h.requests.map(r=>{const u=new URL(r.url,'https://curtbrag.com');assert.equal(u.pathname,'/.netlify/functions/phone-display');assert.equal(u.searchParams.get('activity'),'1');assert.equal(u.searchParams.has('connect'),false);return u.searchParams.get('phone');}),units);
 assert.equal(h.statusCalls.length,0);assert.equal(h.jobs.length,0);assert.equal(h.loads.length,0);assert.equal(h.el['display-mode'].value,'clock');assert.equal(h.el['display-connect'].checked,true);
 assert.match(h.el['display-state'].textContent,/8\/8 saved settings checked/);assert.match(h.el['display-state'].textContent,/not what the screens show/);assert.match(h.el['display-state'].textContent,/No settings were changed or pages opened/);
 assert.ok(h.timers.every(t=>t.cleared));
});

test('saved-state checks accept unconfigured settings and the server expired-sleep revision format',async()=>{
 for(const data of [{mode:null,revision:null,activity:{unit:'phone253'}},{mode:'activity',revision:revision+':expired',activity:{unit:'phone253'}}]){
  const h=harness({target:'phone253',fetch:async()=>({ok:true,json:async()=>data})});await h.check();assert.equal(h.requests.length,1);assert.match(h.el['display-state'].textContent,/1\/1 saved settings checked/);
  assert.match(h.el['display-report'].textContent,data.mode===null?/No display setting saved/:/Activity saved/);assert.equal(h.jobs.length,0);
 }
});

test('saved-state checks reject another unit, unknown modes and malformed revisions without printing response data',async()=>{
 const base={mode:'activity',revision,activity:{unit:'phone253'}};
 for(const data of [{...base,activity:{unit:'phone191'}},{...base,mode:'<script>private-value</script>'},{...base,revision:null},{...base,revision:'invalid'},{...base,mode:null}]){
  const h=harness({target:'phone253',fetch:async()=>({ok:true,json:async()=>data})});await h.check();assert.equal(h.requests.length,1);assert.match(h.el['display-state'].textContent,/0\/1 saved settings checked/);
  assert.match(h.el['display-report'].textContent,/Could not read saved settings for phone253/);assert.doesNotMatch(h.el['display-report'].textContent,/private-value/);assert.equal(h.jobs.length,0);
 }
});

test('a failed saved-state read does not prevent checking the other phones or retry itself',async()=>{
 const h=harness({failPhone:'phone176'});await h.check();assert.equal(h.requests.length,8);
 assert.equal(h.requests.filter(r=>new URL(r.url,'https://curtbrag.com').searchParams.get('phone')==='phone176').length,1);
 assert.match(h.el['display-report'].textContent,/phone176 · Could not read saved settings/);assert.match(h.el['display-report'].textContent,/phone254 · Activity saved/);assert.match(h.el['display-state'].textContent,/7\/8 saved settings checked/);
});

test('read-body timeout releases controls, preserves captured target and prevents concurrent screen actions',async()=>{
 let started;const entered=new Promise(r=>started=r);
 const h=harness({fetch:async(url,request)=>{const phone=new URL(url,'https://curtbrag.com').searchParams.get('phone');return {ok:true,json:()=>phone==='phone173'?(started(),new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))):Promise.resolve({mode:'activity',revision,activity:{unit:phone}})};}});
 const pending=h.check();await entered;await h.update();await h.open();await h.check();assert.equal(h.requests.length,1);
 h.el['display-target'].value='phone253';h.expire();await pending;
 assert.equal(h.requests.length,8);assert.ok(h.requests.every(r=>r.method==='GET'));assert.equal(h.jobs.length,0);assert.match(h.el['display-report'].textContent,/phone173: check timed out/);
 assert.match(h.el['display-state'].textContent,/7\/8 saved settings checked/);assert.ok(h.timers.every(t=>t.cleared));
 for(const id of ['display-update','display-check','display-send','display-sleep','display-target','display-mode','display-connect'])assert.equal(h.el[id].disabled,false);
});

test('a malformed launch receipt stops at that phone and never opens later phones',async()=>{
 const h=harness({nodes:units.map(id=>({id,online:true,busy:false})),fetch:async(url,request,body)=>({ok:true,json:async()=>({...savedReceipt(body),phone:body.phone==='phone174'?'phone253':body.phone})})});await h.open();
 assert.deepEqual(h.requests.map(r=>r.body.phone),['phone173','phone174']);assert.deepEqual(h.jobs.map(j=>Array.from(j.targets)),[['phone173']]);
 assert.match(h.el['display-report'].textContent,/phone174 · Save unconfirmed/);assert.equal(h.el['display-check'].disabled,false);
});


test('expired, overlong and mismatched sleep receipts remain unconfirmed while later phones continue',async()=>{
 for(const patch of [{expiresAt:0},{expiresAt:Date.now()-1000},{expiresAt:Date.now()+180000},{expiresAt:String(Date.now()+120000)},{id:'22222222-2222-4222-8222-222222222222'}]){
  const h=harness({fetch:async(url,request,body)=>({ok:true,json:async()=>{const r=savedReceipt(body);return body.phone==='phone176'?{...r,sleepTest:{...r.sleepTest,...patch}}:r;}})});await h.sleep();
  assert.equal(h.requests.length,8);assert.equal(h.jobs.length,0);assert.match(h.el['display-report'].textContent,/phone176 · Save unconfirmed/);assert.match(h.el['display-report'].textContent,/phone254 · Sleep test saved/);
 }
});

test('when every sleep save fails the summary does not promise any screen will sleep',async()=>{
 const h=harness({fetch:async()=>({ok:false,status:503})});await h.sleep();assert.equal(h.requests.length,8);assert.equal(h.jobs.length,0);
 assert.match(h.el['display-state'].textContent,/8\/8 saves failed or unconfirmed/);assert.match(h.el['display-state'].textContent,/No sleep test was confirmed/);assert.doesNotMatch(h.el['display-state'].textContent,/will allow normal screen sleep/);
});
