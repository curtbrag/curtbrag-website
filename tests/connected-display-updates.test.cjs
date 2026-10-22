const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.resolve(__dirname,'../public/scripts/cluster-swarm-live-v8.js'),'utf8');
const start=source.indexOf('  function ensureDisplayControls(){'),end=source.indexOf('\n  function ensureControlLayout()',start);
assert.ok(start>=0&&end>start);
const units=[173,174,176,177,191,195,253,254].map(n=>'phone'+n);
function harness({target='all',mode='activity',connect=false,nodes=[],failAvailability=false,failPhone=null,pauseFirst=false}={}){
 const elements={},requests=[],jobs=[],statusCalls=[],loads=[];
 let release;const gate=pauseFirst?new Promise(r=>{release=r;}):Promise.resolve();
 const element=id=>elements[id]||=( {id,disabled:false,value:id==='display-target'?target:id==='display-mode'?mode:'',checked:id==='display-connect'&&connect,textContent:'',href:''} );
 elements['cluster-view-fleet']={children:[{}],insertBefore(card){elements[card.id]=card;}};
 const document={getElementById:id=>elements[id]||null,createElement(){return {set innerHTML(html){for(const match of html.matchAll(/id="([^"]+)"/g))element(match[1]);}};}};
 const context=vm.createContext({document,Array,Set,URL,Error,location:{origin:'https://curtbrag.com'},PHONE_IDS:new Set(units),token:()=> 'fixture',setControlView(){},
  canonicalize:r=>r,
  swarmApi:async action=>{statusCalls.push(action);if(failAvailability)throw Error('Availability unavailable');return {nodes};},
  fetch:async(url,options)=>{const body=JSON.parse(options.body);requests.push({url,body});if(requests.length===1)await gate;return {ok:body.phone!==failPhone,json:async()=>({display_url:'https://curtbrag.com/cluster/display.html?mode='+body.mode+'&name='+body.phone+'&display_ticket='+'f'.repeat(64)})};},
  browserOpenCommand:url=>'browser '+url,
  enqueueSwarm:async(type,cmd,targets)=>jobs.push({type,cmd,targets}),load:async force=>loads.push(force),
 });
 vm.runInContext(source.slice(start,end)+'\nensureDisplayControls();',context);
 return {el:elements,requests,jobs,statusCalls,loads,release,update:()=>elements['display-update'].onclick(),open:()=>elements['display-send'].onclick(),sleep:()=>elements['display-sleep'].onclick()};
}

test('connected updates save exactly eight phone modes without browser jobs or new display credentials',async()=>{
 const h=harness({connect:true,failAvailability:true});await h.update();
 assert.deepEqual(h.requests.map(r=>r.body.phone),units);
 assert.ok(h.requests.every(r=>r.url==='/.netlify/functions/phone-display'&&r.body.mode==='activity'&&!('connect' in r.body)));
 assert.equal(h.jobs.length,0);assert.equal(h.statusCalls.length,0);assert.equal(h.loads.length,0);
 assert.match(h.el['display-state'].textContent,/Open display pages will update within 10 seconds/);
 assert.doesNotMatch(h.el['display-state'].textContent,/Browser launch queued|verified|all.*online/);
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
 assert.equal(h.requests.length,3);assert.match(h.el['display-state'].textContent,/Display mode saved: phone173, phone174/);
 assert.match(h.el['display-state'].textContent,/Could not save display mode for phone176/);assert.equal(h.jobs.length,0);
 for(const id of ['display-update','display-send','display-target','display-mode','display-connect'])assert.equal(h.el[id].disabled,false);
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
