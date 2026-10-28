// Execute the production polling/login wiring with synthetic APIs and timers.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const page=fs.readFileSync(path.join(__dirname,'../src/pages/cluster/dashboard.astro'),'utf8');
function between(start,end,last=false){
  const from=last?page.lastIndexOf(start):page.indexOf(start),to=page.indexOf(end,from);
  assert.ok(from>=0&&to>from,`Production block exists: ${start}`);
  return page.slice(from,to);
}
const globals=between("let password = sessionStorage.getItem('cp_password');",'function toast(');
const login=between('async function login()','function logout()');
const polling=between('function startDashboardPolling()','function renderBridgeStatus()');
const tabs=between("document.querySelectorAll('.tab-btn').forEach(btn => btn.onclick", "document.getElementById('pwInput').onkeypress");
const restored=between('if (password) {','// Swarm tab behavior',true);
const renderNames=['renderSummary','renderFleet','renderDevicesTable','renderCommands','renderAlerts','renderAnalytics','renderThermalReport','renderProfiles','renderGroups','renderEvents','renderHashReport','renderCommandTargets','renderBridgeStatus'];

function harness(options={}){
  const calls=[],timers=[],notices=[],renders=[],storage=new Map(options.signedIn===false?[]:[['cp_password','fixture-owner']]);
  function button(tab,active=false){
    const classes=new Set(active?['active']:[]);
    return {dataset:{tab},classList:{add:value=>classes.add(value),remove:value=>classes.delete(value),contains:value=>classes.has(value)}};
  }
  const buttons=[button('swarm',options.active!=='devices'),button('devices',options.active==='devices'),button('alerts')];
  const elements={loginBtn:{disabled:false,textContent:'Sign in'},loginErr:{style:{},textContent:''},pwInput:{value:'fixture-owner'},loginGate:{style:{}},panel:{style:{}},
    'tab-swarm':{style:{}},'tab-devices':{style:{}},'tab-alerts':{style:{}}};
  if(options.adminExists!==false)elements['cluster-administration']={open:options.adminOpen===true};
  const document={hidden:options.hidden===true,getElementById:id=>elements[id]||null,
    querySelector:selector=>selector==='.tab-btn.active'?buttons.find(btn=>btn.classList.contains('active'))||null:null,
    querySelectorAll:selector=>selector==='.tab-btn'?buttons:selector==='.tab-content'?[elements['tab-swarm'],elements['tab-devices'],elements['tab-alerts']]:[]};
  const context=vm.createContext({document,Promise,sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    setInterval:(callback,ms)=>{const id=timers.length;timers.push({callback,ms});return id;},
    callApi:async action=>{calls.push(action);return options.callApi?options.callApi(action):{};},
    fetchDashboardApi:async()=>({ok:true,status:200,data:{ok:true}}),API:'/fixture-api',
    toast:(message,type)=>{notices.push({message,type});if(options.toast)options.toast(message,type);},
    ...Object.fromEntries(renderNames.map(name=>[name,()=>{renders.push(name);if(options.render)options.render(name);}]))});
  vm.runInContext([globals,polling,login,tabs,restored,
    'this.api={fetchAll,startDashboardPolling,login,pending:()=>dashboardFetchPending,state:()=>state};'].join('\n'),context);
  return {api:context.api,calls,timers,notices,renders,storage,document,elements,buttons,
    async finish(){const pending=context.api.pending();if(pending)await pending;},
    async tick(){assert.equal(timers.length,1);timers[0].callback();await this.finish();}};
}

test('restored sign-in fetches immediately and login reuses one sixty-second timer including timer ID zero',async()=>{
  const h=harness();await h.finish();
  assert.equal(h.calls.length,10);assert.equal(h.timers.length,1);assert.equal(h.timers[0].ms,60000);
  h.api.startDashboardPolling();h.api.startDashboardPolling();
  await h.api.login();await h.finish();
  assert.equal(h.calls.length,20);assert.equal(h.timers.length,1);
});

test('new sign-in starts initial data loading and the same singleton timer',async()=>{
  const h=harness({signedIn:false});
  assert.equal(h.calls.length,0);assert.equal(h.timers.length,0);
  await h.api.login();await h.finish();
  assert.equal(h.calls.length,10);assert.equal(h.timers.length,1);assert.equal(h.timers[0].ms,60000);
  assert.equal(h.elements.panel.style.display,'block');
});

test('restored-session initial fetch still runs while hidden but hidden automatic ticks send no requests',async()=>{
  const h=harness({hidden:true});await h.finish();
  assert.equal(h.calls.length,10);
  await h.tick();await h.tick();assert.equal(h.calls.length,10);
  h.document.hidden=false;h.elements['cluster-administration'].open=true;
  await h.tick();assert.equal(h.calls.length,20);
});

test('closed Administration suppresses automatic legacy polling while Workspace owns the visible view',async()=>{
  const h=harness();await h.finish();
  await h.tick();assert.equal(h.calls.length,10);
  h.elements['cluster-administration'].open=true;
  await h.tick();assert.equal(h.calls.length,20);
});

test('legacy fallback without an Administration wrapper continues automatic polling',async()=>{
  const h=harness({adminExists:false});await h.finish();await h.tick();
  assert.equal(h.calls.length,20);
});

test('visible legacy tabs poll even when the Administration details is closed',async()=>{
  const h=harness({active:'devices'});await h.finish();await h.tick();
  assert.equal(h.calls.length,20);
});

test('manual refresh and action follow-up fetches remain available in visible Workspace',async()=>{
  const h=harness();await h.finish();await h.tick();assert.equal(h.calls.length,10);
  await h.api.fetchAll();assert.equal(h.calls.length,20);
  await h.api.fetchAll();assert.equal(h.calls.length,30);
});

test('selecting a legacy administration tab fetches immediately without creating another timer',async()=>{
  const h=harness();await h.finish();
  h.buttons.find(btn=>btn.dataset.tab==='devices').onclick();await h.finish();
  assert.equal(h.calls.length,20);assert.equal(h.elements['tab-devices'].style.display,'block');assert.equal(h.timers.length,1);
  h.buttons.find(btn=>btn.dataset.tab==='swarm').onclick();await h.finish();
  assert.equal(h.calls.length,20,'Workspace selection leaves its own live polling in charge.');
});

test('overlapping automatic and manual refreshes share one pending batch and release it on completion',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});
  const h=harness({adminOpen:true,callApi:action=>action==='summary'?held:{}});
  assert.equal(h.calls.length,6);
  const first=h.api.pending(),manual=h.api.fetchAll();assert.equal(manual,first);
  h.timers[0].callback();h.api.fetchAll();assert.equal(h.calls.length,6);
  release({summary:{total:13}});await first;
  assert.equal(h.calls.length,10);assert.equal(h.api.pending(),null);
  await h.api.fetchAll();assert.equal(h.calls.length,20);
});

test('failed API batches release the guard and a later explicit refresh can recover',async()=>{
  let fail=true;
  const h=harness({callApi:action=>{if(fail&&action==='summary')throw Error('Fixture service unavailable');return {};}});
  await h.finish();assert.equal(h.api.pending(),null);assert.equal(h.calls.length,10);
  assert.match(h.notices[0].message,/Fixture service unavailable/);
  assert.ok(h.renders.includes('renderBridgeStatus'),'A failed summary does not suppress the working bridge.');
  fail=false;await h.api.fetchAll();
  assert.equal(h.calls.length,20);assert.equal(h.api.pending(),null);assert.ok(h.renders.length>0);
});

test('bridge and command results render before a stalled summary or optional report finishes',async()=>{
  let releaseSummary,releaseAnalytics;
  const summary=new Promise(resolve=>{releaseSummary=resolve;});
  const analytics=new Promise(resolve=>{releaseAnalytics=resolve;});
  const h=harness({callApi:action=>action==='summary'?summary:action==='fleet-analytics'?analytics:action==='bridge-status'?{alive:true}:action==='commands'?{history:[{id:'finished-command'}]}:{}});
  for(let i=0;i<8;i++)await Promise.resolve();
  assert.ok(h.renders.includes('renderBridgeStatus'));
  assert.ok(h.renders.includes('renderCommands'));
  assert.equal(h.api.state().bridge.alive,true);
  assert.equal(h.api.state().commands.history[0].id,'finished-command');
  assert.equal(h.renders.includes('renderSummary'),false);
  releaseSummary({summary:{total:13}});
  for(let i=0;i<12;i++)await Promise.resolve();
  assert.ok(h.renders.includes('renderSummary'));
  assert.ok(h.renders.includes('renderThermalReport'));
  assert.equal(h.renders.includes('renderAnalytics'),false);
  releaseAnalytics({ready:true});await h.finish();
  assert.ok(h.renders.includes('renderAnalytics'));assert.equal(h.api.pending(),null);
});

test('failed device refresh preserves the previous devices while other controls keep updating',async()=>{
  let failDevices=false,bridgeSequence=0;
  const h=harness({callApi:action=>{
    if(action==='devices'){if(failDevices)throw Error('Device read unavailable');return {devices:[{id:'phone253'}]};}
    return action==='bridge-status'?{alive:true,sequence:++bridgeSequence}:{};
  }});
  await h.finish();failDevices=true;await h.api.fetchAll();
  assert.equal(h.api.state().devices[0].id,'phone253');
  assert.equal(h.api.state().bridge.sequence,2);
  assert.match(h.notices.at(-1).message,/devices: Device read unavailable/);
  assert.equal(h.api.pending(),null);
});

test('group profile choices update when profiles arrive after groups',async()=>{
  let releaseProfiles;
  const profiles=new Promise(resolve=>{releaseProfiles=resolve;});
  const choices=[];
  const h=harness({
    callApi:action=>action==='profiles'?profiles:action==='groups'?{groups:[{id:'phones'}]}:{},
    render:name=>{if(name==='renderGroups')choices.push(Object.keys(h.api.state().profiles));},
  });
  for(let i=0;i<12;i++)await Promise.resolve();
  assert.equal(h.api.state().groups[0].id,'phones');
  assert.deepEqual(choices,[[]]);
  releaseProfiles({profiles:{'current-profile':{name:'Current profile'}}});
  await h.finish();
  assert.deepEqual(choices,[[],['current-profile']]);
  assert.equal(h.api.pending(),null);
});

test('even an unexpected error while reporting a failure releases the in-flight guard',async()=>{
  let failToast=true;
  const h=harness({signedIn:false,callApi:()=>{throw Error('Fixture failure');},toast:()=>{if(failToast)throw Error('Fixture toast failure');}});
  h.storage.set('cp_password','fixture-owner');
  await assert.rejects(h.api.fetchAll(),/Fixture toast failure/);
  assert.equal(h.api.pending(),null);
  failToast=false;await h.api.fetchAll();assert.equal(h.api.pending(),null);assert.equal(h.calls.length,12);
});

test('an expired dashboard sign-in makes subsequent automatic and manual reads no-ops',async()=>{
  const h=harness({adminOpen:true});await h.finish();h.storage.delete('cp_password');
  await h.tick();await h.api.fetchAll();assert.equal(h.calls.length,10);assert.equal(h.api.pending(),null);
});
