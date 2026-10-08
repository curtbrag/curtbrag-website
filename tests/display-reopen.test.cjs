const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');
const {TextEncoder}=require('node:util');
const source=fs.readFileSync(path.join(__dirname,'../public/scripts/cluster-swarm-live-v8.js'),'utf8').replace(/\r\n/g,'\n');
const phones=['phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254'];
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,'Actual candidate section must exist: '+start);return source.slice(a,b);}
const handlerStart="document.getElementById('display-send').onclick=async()=>{";
const handler=section(handlerStart,'\n    };\n  }').slice(handlerStart.indexOf('async()=>'))+'\n    }';
const canonicalize=section('  function canonicalize(raw) {','\n  function ensureStateNote()');
const browserCommand=section('  function browserOpenCommand(url){','\n  async function dispatchBrowserOpen()');
const fleetExpression=source.match(/const FLEET = (\[[\s\S]*?\]);/)[1];

function harness(options={}){
  const elements={'display-send':{disabled:false},'display-state':{textContent:''},'display-target':{value:options.target||'phone253'},'display-mode':{value:options.mode||'activity'}};
  const events=[],saves=[],enqueues=[];let loads=0;
  const context=vm.createContext({
    document:{getElementById:id=>elements[id]},TextEncoder,btoa:value=>Buffer.from(value,'binary').toString('base64'),
    PHONE_IDS:new Set(phones),token:()=> 'test-operator-session',
    swarmApi:async(...args)=>{events.push({kind:'availability',args});if(options.api)return options.api(...args);return {nodes:options.nodes||[{id:'phone253',online:true,busy:false}],jobs:[],results:[]};},
    fetch:async(url,request)=>{const body=JSON.parse(request.body);saves.push({url,request,body});events.push({kind:'save',phone:body.phone});return options.fetch?options.fetch(url,request,body):{ok:true};},
    enqueueSwarm:async(type,cmd,targets)=>{const launch={type,cmd,targets:Array.from(targets)};enqueues.push(launch);events.push({kind:'launch',phone:launch.targets[0]});if(options.enqueue)return options.enqueue(launch);return {ok:true};},
    load:async force=>{loads++;events.push({kind:'load',force});},
  });
  vm.runInContext('const FLEET='+fleetExpression+';const IDS=new Set(FLEET.map(([id])=>id));\n'+canonicalize+'\n'+browserCommand+'\nglobalThis.applyDisplay='+handler+';',context);
  return {apply:context.applyDisplay,elements,events,saves,enqueues,loads:()=>loads};
}
function launchUrl(launch){
  const match=launch.cmd.match(/--settings-b64 '([A-Za-z0-9+/=]+)'/);assert.ok(match,'Candidate launch must use the actual base64 helper command');
  return new URL(JSON.parse(Buffer.from(match[1],'base64').toString('utf8')).url);
}

test('phone253 selection saves only its mode and queues only its correctly named unit display',async()=>{
  const h=harness();await h.apply();
  assert.deepEqual(h.saves.map(s=>s.body),[{phone:'phone253',mode:'activity'}]);
  assert.equal(h.saves[0].url,'/.netlify/functions/phone-display');assert.equal(h.saves[0].request.method,'POST');
  assert.equal(h.saves[0].request.headers.Authorization,'Bearer test-operator-session');
  assert.equal(h.enqueues.length,1);assert.equal(h.enqueues[0].type,'shell');assert.deepEqual(h.enqueues[0].targets,['phone253']);
  const url=launchUrl(h.enqueues[0]);assert.equal(url.origin,'https://curtbrag.com');assert.equal(url.pathname,'/cluster/display.html');
  assert.deepEqual(Object.fromEntries(url.searchParams),{mode:'activity',name:'phone253',immersive:'1',v:'63'});
  assert.match(h.enqueues[0].cmd,/\/[a-f0-9]{40}\/scripts\/cluster-browser-open\.py/);
  assert.match(h.elements['display-state'].textContent,/Browser launch queued for phone253/);
  assert.equal(h.elements['display-send'].disabled,false);assert.equal(h.loads(),1);
});

test('all eight phones receive distinct correct names in decoded URLs and modes are saved before each launch',async()=>{
  const h=harness({target:'all',mode:'clock',nodes:phones.map(id=>({id,online:true,busy:false}))});await h.apply();
  assert.deepEqual(h.saves.map(s=>s.body.phone),phones);assert.equal(h.enqueues.length,8);
  for(let i=0;i<phones.length;i++){
    assert.deepEqual(h.enqueues[i].targets,[phones[i]]);const url=launchUrl(h.enqueues[i]);
    assert.deepEqual(Object.fromEntries(url.searchParams),{mode:'clock',name:phones[i],immersive:'1',v:'63'});
    const saveIndex=h.events.findIndex(e=>e.kind==='save'&&e.phone===phones[i]),launchIndex=h.events.findIndex(e=>e.kind==='launch'&&e.phone===phones[i]);
    assert.ok(saveIndex>=0&&saveIndex<launchIndex,'Mode must be saved first for '+phones[i]);
  }
  assert.equal(h.events[0].kind,'availability');assert.equal(h.events.at(-1).kind,'load');
});

test('busy, offline and missing phones have desired mode saved but no browser launch',async()=>{
  const h=harness({target:'all',nodes:[{id:'phone253',online:true,busy:false},{id:'phone191',online:true,busy:true},{id:'phone176',online:false,busy:false}]});await h.apply();
  assert.equal(h.saves.length,8);assert.deepEqual(h.enqueues.map(e=>e.targets),[['phone253']]);
  assert.match(h.elements['display-state'].textContent,/phone191 \(busy\)/);assert.match(h.elements['display-state'].textContent,/phone176 \(offline\)/);
  assert.match(h.elements['display-state'].textContent,/phone174 \(offline\)/);
});

test('a failed or incomplete fresh availability response prevents saves and launches',async()=>{
  for(const api of [async()=>({ok:true}),async()=>({nodes:null}),async()=>{throw Error('Availability timed out');}]){
    const h=harness({api});await h.apply();assert.equal(h.saves.length,0);assert.equal(h.enqueues.length,0);assert.equal(h.loads(),0);
    assert.equal(h.elements['display-send'].disabled,false);assert.match(h.elements['display-state'].textContent,/availability|Availability/);
  }
});

test('a rejected authenticated mode save never queues that phone or subsequent phones',async()=>{
  const h=harness({target:'all',nodes:phones.map(id=>({id,online:true,busy:false})),fetch:async()=>({ok:false,status:401})});await h.apply();
  assert.equal(h.saves.length,1);assert.equal(h.enqueues.length,0);assert.equal(h.loads(),0);
  assert.match(h.elements['display-state'].textContent,/Could not save display mode for phone173/);assert.equal(h.elements['display-send'].disabled,false);
});

test('a blocked save displays progress, disables Apply and waits before queueing a browser launch',async()=>{
  let release,entered;const blocked=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const h=harness({fetch:async()=>{entered();return blocked;}});const pending=h.apply();await started;
  assert.equal(h.elements['display-send'].disabled,true);assert.equal(h.elements['display-state'].textContent,'Saving display for phone253…');assert.equal(h.enqueues.length,0);
  release({ok:true});await pending;assert.equal(h.enqueues.length,1);assert.equal(h.elements['display-send'].disabled,false);
});

test('a later save failure reports earlier saves and queued launches without claiming a complete batch',async()=>{
  const h=harness({target:'all',nodes:phones.map(id=>({id,online:true,busy:false})),fetch:async(url,request,body)=>({ok:body.phone!=='phone174'})});await h.apply();
  assert.deepEqual(h.saves.map(s=>s.body.phone),['phone173','phone174']);assert.deepEqual(h.enqueues.map(e=>e.targets),[['phone173']]);
  assert.match(h.elements['display-state'].textContent,/Display mode saved: phone173/);assert.match(h.elements['display-state'].textContent,/Browser launch queued: phone173/);
  assert.match(h.elements['display-state'].textContent,/Could not save display mode for phone174/);assert.equal(h.elements['display-send'].disabled,false);
});

test('an uncertain enqueue preserves the saved mode, stops the batch and restores the control',async()=>{
  const h=harness({target:'all',nodes:phones.map(id=>({id,online:true,busy:false})),enqueue:async()=>{throw Error('Submission is unconfirmed');}});await h.apply();
  assert.equal(h.saves.length,1);assert.equal(h.enqueues.length,1);assert.equal(h.loads(),0);
  assert.match(h.elements['display-state'].textContent,/Display mode saved: phone173/);assert.match(h.elements['display-state'].textContent,/Submission is unconfirmed/);
  assert.equal(h.elements['display-state'].textContent.includes('Browser launch queued:'),false);assert.equal(h.elements['display-send'].disabled,false);
});

test('a non-phone target causes no mode save or browser launch',async()=>{
  const h=harness({target:'Nexus'});await h.apply();assert.equal(h.saves.length,0);assert.equal(h.enqueues.length,0);assert.match(h.elements['display-state'].textContent,/Select a phone/);
});
