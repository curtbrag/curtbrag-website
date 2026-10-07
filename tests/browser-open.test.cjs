const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const {TextEncoder}=require('node:util');
const dashboard=fs.readFileSync(path.join(__dirname,'../public/scripts/cluster-swarm-live-v8.js'),'utf8');
const start=dashboard.indexOf('  let browserOpenReport='),end=dashboard.indexOf('  let siteTest=',start);
assert.ok(start>=0&&end>start,'Published browser control must be present');
const source=dashboard.slice(start,end);
const key='curt-browser-open-v1';
const FLEET=[['phone173','worker'],['phone174','worker'],['phone176','worker'],['phone177','worker'],['phone191','worker'],['phone195','worker'],['phone253','worker'],['phone254','worker'],['Alina','pc'],['Nexus','pc'],['SteamDeck','pc'],['viki','pc'],['RenderRig','gpu-worker']];
const IDS=new Set(FLEET.map(([id])=>id));
const PHONE_IDS=new Set(FLEET.filter(([,kind])=>kind==='worker').map(([id])=>id));
const PC_IDS=new Set(FLEET.filter(([,kind])=>kind!=='worker').map(([id])=>id));
function harness(options={}){
  const storage=options.storage||new Map(),calls=[];
  const elements={
    'browser-open-run':{disabled:false},'browser-open-close':{disabled:true},
    'browser-open-url':{value:'https://curtbrag.com/'},'browser-open-target':{value:'all'},
    'browser-open-state':{textContent:''},'browser-open-report':{textContent:''},
    'termux-return-run':{disabled:false},'termux-return-close':{disabled:true},
    'termux-return-state':{textContent:''},'termux-return-report':{textContent:''},
  };
  let loads=0;
  const context=vm.createContext({
    URL,TextEncoder,FLEET,IDS,PHONE_IDS,PC_IDS,btoa:value=>Buffer.from(value,'binary').toString('base64'),
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},
    document:{getElementById:id=>elements[id]||null},current:{results:[]},
    canonicalize:raw=>({...raw,nodes:FLEET.map(([id,node_class])=>raw.nodes.find(n=>n.id===id)||{id,node_class,online:false,busy:false,active_jobs:[]}),jobs:raw.jobs||[],results:raw.results||[]}),
    versionAtLeast:(a,r)=>{const x=String(a||'0.0.0').split('.').map(Number),y=r.split('.').map(Number);for(let i=0;i<3;i++){if((x[i]||0)>(y[i]||0))return true;if((x[i]||0)<(y[i]||0))return false;}return true;},
    swarmApi:async(...args)=>{calls.push(args);if(options.api)return options.api(...args);return args[0]==='queue-status'?{nodes:options.nodes||[{id:'phone191',online:true,busy:false}],jobs:[],results:[]}:{ok:true};},
    controlApi:async(...args)=>{calls.push([args[0],args[1],args[2],'control']);if(options.controlApi)return options.controlApi(...args);if(args[0]==='bridge-status')return freshBridge();if(args[0]==='queue-command')return {ok:true,command_id:'controller-'+args[2].target};if(args[0]==='commands')return options.commands||{queue:[],history:[]};throw Error('Unexpected controller action');},
    load:async()=>{loads++;},
  });
  vm.runInContext(source+'\nglobalThis.api={validateBrowserOpenUrl,browserOpenCommand,dispatchBrowserOpen,closeBrowserOpen,renderBrowserOpen,dispatchTermuxReturn,closeTermuxReturn,renderTermuxReturn,get:()=>browserOpenReport,set:value=>browserOpenReport=value,busy:()=>browserOpenBusy,updateTermuxController,termuxControllerAvailable,getReturn:()=>termuxReturnReport,setReturn:value=>termuxReturnReport=value,returnBusy:()=>termuxReturnBusy};',context);
  return {api:context.api,elements,storage,calls,loads:()=>loads};
}
function report(state='queued'){
  return {id:'browser-open-fixture',url:'https://curtbrag.com/',target:'all',created_at:new Date(Date.now()-180000).toISOString(),tasks:[{unit:'phone191',job_id:'open-191',state}],skipped:[]};
}
function result(overrides={}){
  return {job_id:'open-191',device_id:'phone191',exit_code:0,stdout:JSON.stringify({kind:'website-browser-open',url:'https://curtbrag.com/',state:'launch-requested',launch_requested:true,visible_screen_verified:false,launcher:'termux-am'}),...overrides};
}

test('normal HTTPS navigation preserves query and fragment and rejects local, credential, port and control URLs',()=>{
  const h=harness();
  assert.equal(h.api.validateBrowserOpenUrl('https://example.com/page?q=tools#details'),'https://example.com/page?q=tools#details');
  for(const url of ['http://example.com/','javascript:alert(1)','file:///tmp/test','https://user:pass@example.com/','https://example.com:8443/','https://localhost/','https://node.local/','https://node.internal/','https://192.168.1.191/','https://127.0.0.1/','https://2130706433/','https://[::1]/','https://example.com/\nnext','https://example.com/\u0000','https://example.com/'+ 'x'.repeat(2048)])assert.throws(()=>h.api.validateBrowserOpenUrl(url),undefined,url);
});

test('URL shell metacharacters remain base64 data and never enter the generated command',()=>{
  const h=harness();
  const url=h.api.validateBrowserOpenUrl("https://example.com/page?q=$(touch%20sentinel)&x=';echo%20unsafe;#`id`");
  const cmd=h.api.browserOpenCommand(url),encoded=cmd.match(/--settings-b64 '([A-Za-z0-9+/=]+)'/)[1];
  assert.deepEqual(JSON.parse(Buffer.from(encoded,'base64').toString()),{url});
  assert.equal(cmd.includes('$(touch'),false);
  assert.equal(cmd.includes('echo%20unsafe'),false);
  assert.equal(cmd.includes('`id`'),false);
  assert.match(cmd,/\/(?:[a-f0-9]{40}|f6f01768fdda090564a3f7237d97606a8f01bf4e)\/scripts\/cluster-browser-open\.py/);
  assert.match(cmd,/--max-time 20/);
});

test('raw spaces and backslashes are rejected before URL normalization while encoded spaces remain navigation data',()=>{
  const h=harness();
  for(const value of [' https://example.com/','https://example.com/ ','https://example.com/a b','https://example.com/\\path','https://example.com\\@other.com/'])assert.throws(()=>h.api.validateBrowserOpenUrl(value),/spaces, control characters or backslashes/);
  assert.equal(h.api.validateBrowserOpenUrl('https://example.com/search?q=socket%20set#section'),'https://example.com/search?q=socket%20set#section');
});

test('trailing-dot hostnames and all reserved helper suffixes are rejected consistently',()=>{
  const h=harness();
  for(const value of ['https://example.com./','https://example.com%2e/'])assert.throws(()=>h.api.validateBrowserOpenUrl(value));
  for(const suffix of ['localhost','local','localdomain','lan','internal','test','invalid','onion','example','home'])assert.throws(()=>h.api.validateBrowserOpenUrl('https://unit.'+suffix+'/'),undefined,suffix);
  assert.equal(h.api.validateBrowserOpenUrl('https://example.com/'),'https://example.com/');
});

test('control characters in form input are rejected before any availability or launch request',async()=>{
  for(const value of ['\nhttps://example.com/','https://example.com/\r','https://example.com/\t']){
    const h=harness();h.elements['browser-open-url'].value=value;await h.api.dispatchBrowserOpen();
    assert.equal(h.calls.length,0);assert.match(h.elements['browser-open-state'].textContent,/control characters/);
  }
});

test('all-device selection uses the canonical fleet, skips busy/offline, and uses native Windows jobs',async()=>{
  const h=harness({nodes:[{id:'phone191',online:true,busy:false},{id:'Nexus',online:true,busy:false},{id:'RenderRig',online:true,busy:false,agent_version:'3.7.2'},{id:'phone253',online:true,busy:true},{id:'unregisteredLaptop',online:true,busy:false}]});
  await h.api.dispatchBrowserOpen();
  const jobs=h.calls.filter(c=>c[0]==='enqueue');
  assert.deepEqual(jobs.map(c=>Array.from(c[2].target_device_ids)),[['phone191'],['Nexus'],['RenderRig']]);
  assert.equal(jobs[0][2].job.type,'shell');assert.equal(jobs[2][2].job.type,'website-open');
  assert.deepEqual(JSON.parse(jobs[2][2].job.cmd),{url:'https://curtbrag.com/'});
  assert.equal(jobs[2][2].job.command,jobs[2][2].job.cmd);
  assert.equal(new Set(jobs.map(c=>c[2].job.id)).size,3);
  assert.ok(h.api.get().skipped.some(n=>n.unit==='phone253'&&n.reason==='busy'));
  assert.ok(h.api.get().skipped.some(n=>n.unit==='viki'&&n.reason==='offline'));
  assert.equal(h.api.get().tasks.some(t=>t.unit==='unregisteredLaptop'),false);
  assert.equal(h.loads(),1);
});

test('individual target selection queues exactly that unit and rejects an injected target',async()=>{
  const h=harness({nodes:[{id:'phone191',online:true,busy:false},{id:'Nexus',online:true,busy:false}]});
  h.elements['browser-open-target'].value='Nexus';await h.api.dispatchBrowserOpen();
  assert.deepEqual(h.calls.filter(c=>c[0]==='enqueue').map(c=>Array.from(c[2].target_device_ids)),[['Nexus']]);
  const invalid=harness();invalid.elements['browser-open-target'].value='unknown';await invalid.api.dispatchBrowserOpen();
  assert.equal(invalid.calls.length,0);assert.match(invalid.elements['browser-open-state'].textContent,/canonical cluster unit/);
});

test('old or missing Windows agent versions are skipped rather than sent unsupported jobs',async()=>{
  for(const agent_version of [undefined,'','3.7.1']){
    const h=harness({nodes:[{id:'RenderRig',online:true,busy:false,agent_version}]});h.elements['browser-open-target'].value='RenderRig';
    await h.api.dispatchBrowserOpen();
    assert.equal(h.calls.filter(c=>c[0]==='enqueue').length,0);
    assert.equal(h.api.get().skipped[0].reason,'agent update required');
    assert.match(h.elements['browser-open-state'].textContent,/No available selected devices/);
  }
});

test('busy or offline individual units make no launch request',async()=>{
  for(const node of [{id:'phone191',online:true,busy:true},{id:'phone191',online:false,busy:false}]){
    const h=harness({nodes:[node]});h.elements['browser-open-target'].value='phone191';await h.api.dispatchBrowserOpen();
    assert.equal(h.calls.filter(c=>c[0]==='enqueue').length,0);
    assert.equal(h.api.get().skipped[0].reason,node.online?'busy':'offline');
  }
});

test('a pending availability check shows progress and ignores concurrent clicks',async()=>{
  let release;const blocked=new Promise(resolve=>{release=resolve;});
  const h=harness({api:async action=>action==='queue-status'?blocked:{ok:true}});
  const pending=h.api.dispatchBrowserOpen();
  assert.equal(h.elements['browser-open-state'].textContent,'Checking available devices…');
  assert.equal(h.elements['browser-open-run'].disabled,true);assert.equal(h.elements['browser-open-close'].disabled,true);
  await h.api.dispatchBrowserOpen();assert.equal(h.calls.length,1);
  release({nodes:[{id:'phone191',online:true,busy:false}],jobs:[],results:[]});await pending;
  assert.equal(h.calls.filter(c=>c[0]==='enqueue').length,1);assert.equal(h.api.busy(),false);
});

test('results settle only matching job/unit and persist as launch-requested with explicit visibility limits',()=>{
  const h=harness();h.api.set(report());
  h.api.renderBrowserOpen([result({job_id:'other'}),result({device_id:'Nexus'})]);assert.equal(h.api.get().tasks[0].state,'queued');
  h.api.renderBrowserOpen([result()]);assert.equal(h.api.get().tasks[0].state,'launch-requested');
  assert.match(h.elements['browser-open-state'].textContent,/Browser launch requested; screen\/page visibility unverified/);
  assert.equal(h.elements['browser-open-report'].textContent.includes('passed'),false);
  const reload=harness({storage:h.storage});assert.equal(reload.api.get().tasks[0].state,'launch-requested');
});

test('HTTP success, mismatched URLs and claims of verified physical screens cannot become launch results',()=>{
  for(const parsed of [
    {kind:'website-load-test',url:'https://curtbrag.com/',ok:true,status:200,total_ms:1},
    {kind:'website-browser-open',url:'https://other.example/',launch_requested:true,state:'launch-requested',visible_screen_verified:false},
    {kind:'website-browser-open',url:'https://curtbrag.com/',launch_requested:true,state:'launch-requested',visible_screen_verified:true},
    {kind:'website-browser-open',url:'https://curtbrag.com/',state:'launch-requested',visible_screen_verified:false},
  ]){const h=harness();h.api.set(report());h.api.renderBrowserOpen([result({stdout:JSON.stringify(parsed)})]);assert.equal(h.api.get().tasks[0].state,'failed');}
});

test('worker launch errors, nonzero exits and malformed output remain failures',()=>{
  for(const r of [result({exit_code:1}),result({stdout:'not JSON',stderr:'worker broke'}),result({stdout:JSON.stringify({kind:'website-browser-open',url:'https://curtbrag.com/',launch_requested:false,state:'failed',visible_screen_verified:false,error:'No graphical desktop session'})})]){
    const h=harness();h.api.set(report());h.api.renderBrowserOpen([r]);assert.equal(h.api.get().tasks[0].state,'failed');assert.ok(h.api.get().tasks[0].error);
  }
});

test('persisted queued or ambiguous requests block a new batch without replay',async()=>{
  for(const state of ['queued','submitting','unconfirmed']){
    const h=harness({storage:new Map([[key,JSON.stringify(report(state))]])});await h.api.dispatchBrowserOpen();
    assert.equal(h.calls.length,0);assert.match(h.elements['browser-open-state'].textContent,/Previous launch requests are pending/);
  }
});

test('an enqueue connection failure persists ambiguity and blocks automatic resubmission',async()=>{
  const h=harness({api:async action=>{if(action==='queue-status')return {nodes:[{id:'phone191',online:true,busy:false}]};throw Error('Disconnected');}});
  await h.api.dispatchBrowserOpen();assert.equal(h.api.get().tasks[0].state,'unconfirmed');assert.equal(JSON.parse(h.storage.get(key)).tasks[0].state,'unconfirmed');
  await h.api.dispatchBrowserOpen();assert.equal(h.calls.filter(c=>c[0]==='enqueue').length,1);assert.match(h.elements['browser-open-state'].textContent,/pending/);
});

test('closing refuses active, queued and unknown-status own jobs',async()=>{
  for(const fixture of [
    {nodes:[],jobs:[{id:'open-191',status:'queued'}],results:[]},
    {nodes:[],jobs:[{id:'open-191'}],results:[]},
    {nodes:[{id:'phone191',active_jobs:['open-191']}],jobs:[],results:[]},
    {nodes:[{id:'phone191',active_jobs:[{job_id:'open-191'}]}],jobs:[],results:[]},
  ]){const h=harness({api:async()=>fixture});h.api.set(report());await h.api.closeBrowserOpen();assert.equal(h.api.get().tasks[0].state,'queued');assert.equal(h.api.get().closed_at,undefined);}
});

test('young missing submissions cannot be closed before the ambiguity waiting period',async()=>{
  const h=harness();const saved=report('unconfirmed');saved.created_at=new Date().toISOString();h.api.set(saved);await h.api.closeBrowserOpen();
  assert.equal(h.api.get().tasks[0].state,'unconfirmed');assert.match(h.elements['browser-open-state'].textContent,/at least two minutes/);
});

test('manual closing collects fresh results and closes only old missing tasks without cancelling or retrying',async()=>{
  const h=harness({api:async()=>({nodes:[],jobs:[{id:'open-191',status:'completed'}],results:[result()]})});
  const saved=report();saved.tasks.push({unit:'phone253',job_id:'open-253',state:'planned'});h.api.set(saved);await h.api.closeBrowserOpen();
  assert.deepEqual(Array.from(h.api.get().tasks,t=>t.state),['launch-requested','closed']);assert.ok(h.api.get().closed_at);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'queue-status');assert.equal(h.calls[0][1],undefined);
  assert.match(h.elements['browser-open-state'].textContent,/1 closed/);
  const reload=harness({storage:h.storage});assert.equal(reload.api.get().tasks[1].state,'closed');
});

test('old absent ambiguous tasks close and permit only the next explicit launch action',async()=>{
  const h=harness();h.api.set(report('unconfirmed'));await h.api.closeBrowserOpen();assert.equal(h.api.get().tasks[0].state,'closed');
  assert.equal(h.calls.filter(c=>c[0]==='enqueue').length,0);
  h.api.renderBrowserOpen([result()]);assert.equal(h.api.get().tasks[0].state,'closed');
  await h.api.dispatchBrowserOpen();assert.equal(h.calls.filter(c=>c[0]==='enqueue').length,1);
});

test('a failed close check preserves the report instead of assuming the queue is empty',async()=>{
  const h=harness({api:async()=>{throw Error('Connection timed out');}});h.api.set(report('unconfirmed'));const before=JSON.stringify(h.api.get());await h.api.closeBrowserOpen();
  assert.equal(JSON.stringify(h.api.get()),before);assert.equal(h.calls.length,1);assert.match(h.elements['browser-open-state'].textContent,/timed out/);
  assert.equal(h.elements['browser-open-run'].disabled,false);assert.equal(h.elements['browser-open-close'].disabled,false);
});

function returnReport(state='queued'){
  return {id:'termux-return-fixture',target:'all',created_at:new Date(Date.now()-180000).toISOString(),tasks:[{unit:'phone191',job_id:'return-191',state}],skipped:[]};
}
function returnResult(overrides={}){
  return {job_id:'return-191',device_id:'phone191',exit_code:0,stdout:JSON.stringify({kind:'phone-termux-return',state:'return-requested',return_requested:true,request_completed:true,visible_screen_verified:false}),...overrides};
}

test('computers and laptops selection includes viki and all known PCs, without sending phone jobs',async()=>{
  const h=harness({nodes:FLEET.map(([id])=>({id,online:true,busy:false,agent_version:'3.7.2'})).concat({id:'unregisteredLaptop',online:true,busy:false})});
  h.elements['browser-open-target'].value='computers';await h.api.dispatchBrowserOpen();
  assert.deepEqual(h.calls.filter(c=>c[0]==='enqueue').map(c=>Array.from(c[2].target_device_ids)),[['Alina'],['Nexus'],['SteamDeck'],['viki'],['RenderRig']]);
  assert.equal(h.api.get().tasks.some(t=>PHONE_IDS.has(t.unit)||t.unit==='unregisteredLaptop'),false);
  assert.match(source,/<option value="computers">Computers &amp; laptops<\/option>/);
});

function controllerReport(state='queued'){
  return {id:'controller-fixture',target:'phone191',transport:'pc-controller',created_at:new Date(Date.now()-180000).toISOString(),tasks:[{unit:'phone191',command_id:'control-191',state}],skipped:[]};
}
function controllerResult(overrides={}){
  return {id:'control-191',target:'phone191',type:'phone-return-termux',status:'completed',output:JSON.stringify({kind:'phone-controller-return',unit:'phone191',state:'termux-foreground',foreground_app_verified:true,visible_screen_verified:false,error:null,controller_state:'connected'}),...overrides};
}
function freshBridge(overrides={}){return {alive:true,bridge_version:'2.5.0',last_seen_at:new Date().toISOString(),...overrides};}

test('return uses one fixed PC-controller command per available phone without phone shell jobs',async()=>{
  const h=harness({nodes:[{id:'phone191',online:true,busy:false},{id:'phone253',online:true,busy:true},{id:'Nexus',online:true,busy:false}]});
  const saved=report('launch-requested');h.api.set(saved);await h.api.dispatchTermuxReturn();
  const requests=h.calls.filter(c=>c[0]==='queue-command');
  assert.equal(requests.length,1);assert.equal(requests[0][3],'control');
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0][2])),{target:'phone191',type:'phone-return-termux',payload:{}});
  assert.equal(h.calls.some(c=>c[0]==='enqueue'),false);
  assert.equal(h.api.getReturn().transport,'pc-controller');assert.equal(h.api.getReturn().tasks[0].command_id,'controller-phone191');
  assert.ok(h.api.getReturn().skipped.some(t=>t.unit==='phone253'&&t.reason==='busy'));
  assert.ok(h.api.getReturn().skipped.some(t=>t.unit==='phone173'&&t.reason==='offline'));
  assert.equal(h.api.get(),saved);assert.equal(h.loads(),0);
});

test('individual return selects only that phone; PC and injected selections make no API calls',async()=>{
  const h=harness({nodes:[{id:'phone191',online:true,busy:false},{id:'phone253',online:true,busy:false}]});
  h.elements['browser-open-target'].value='phone253';await h.api.dispatchTermuxReturn();
  assert.deepEqual(h.calls.filter(c=>c[0]==='queue-command').map(c=>c[2].target),['phone253']);
  for(const target of ['computers',...PC_IDS,'phone999','phone253;id']){
    const bad=harness();bad.elements['browser-open-target'].value=target;await bad.api.dispatchTermuxReturn();
    assert.equal(bad.calls.length,0);assert.equal(bad.api.getReturn(),null);
  }
});

test('offline, outdated, malformed, stale or future PC-controller heartbeats block all return submissions',async()=>{
  for(const bridge of [freshBridge({alive:false}),freshBridge({bridge_version:'2.4.0'}),freshBridge({bridge_version:'2.5.x'}),freshBridge({last_seen_at:'invalid'}),freshBridge({last_seen_at:new Date(Date.now()-60000).toISOString()}),freshBridge({last_seen_at:new Date(Date.now()+60000).toISOString()})]){
    const h=harness({controlApi:async()=>bridge});await h.api.dispatchTermuxReturn();
    assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'bridge-status');
    assert.equal(h.api.getReturn(),null);assert.equal(h.elements['termux-return-run'].disabled,true);
    assert.match(h.elements['termux-return-state'].textContent,/Remote return unavailable/);
  }
});

test('return remains disabled through rendering until a valid controller is observed and disables on connection loss',()=>{
  const h=harness();h.api.renderTermuxReturn([]);h.api.renderBrowserOpen([]);
  assert.equal(h.elements['termux-return-run'].disabled,true);
  h.api.updateTermuxController(freshBridge(),{queue:[],history:[]});assert.equal(h.elements['termux-return-run'].disabled,false);
  h.api.updateTermuxController(null,null);h.api.renderBrowserOpen([]);assert.equal(h.elements['termux-return-run'].disabled,true);
});

test('a pending controller check prevents concurrent returns and website launches',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const h=harness({controlApi:async(action,method,body)=>action==='bridge-status'?pending:action==='queue-command'?{ok:true,command_id:'controller-'+body.target}:{queue:[],history:[]}});
  const first=h.api.dispatchTermuxReturn();assert.equal(h.elements['browser-open-run'].disabled,true);assert.equal(h.elements['termux-return-run'].disabled,true);
  await h.api.dispatchTermuxReturn();await h.api.dispatchBrowserOpen();assert.equal(h.calls.length,1);
  release(freshBridge());await first;assert.equal(h.calls.filter(c=>c[0]==='queue-command').length,1);
});

test('pending old or new returns block new batches without changing the existing report',async()=>{
  for(const state of ['queued','submitting','unconfirmed'])for(const saved of [returnReport(state),controllerReport(state)]){
    const h=harness();h.api.setReturn(saved);await h.api.dispatchTermuxReturn();await h.api.dispatchBrowserOpen();
    assert.equal(h.calls.length,0);assert.equal(h.api.getReturn(),saved);
  }
});

test('controller results require command ID, phone, type and foreground evidence; physical screens stay unverified',()=>{
  const h=harness();h.api.setReturn(controllerReport());
  for(const bad of [controllerResult({id:'wrong'}),controllerResult({target:'phone253'}),controllerResult({type:'other'})])h.api.renderTermuxReturn([],{queue:[],history:[bad]});
  assert.equal(h.api.getReturn().tasks[0].state,'queued');
  h.api.renderTermuxReturn([],{queue:[],history:[controllerResult()]});assert.equal(h.api.getReturn().tasks[0].state,'termux-foreground');
  assert.equal(h.api.getReturn().tasks[0].report.visible_screen_verified,false);
  assert.match(h.elements['termux-return-state'].textContent,/1 Termux foreground verified/);
  assert.match(h.elements['termux-return-state'].textContent,/Screen visibility is unverified/);
  const reload=harness({storage:h.storage});assert.equal(reload.api.getReturn().tasks[0].state,'termux-foreground');
  for(const report of [
    {kind:'phone-termux-return',return_requested:true},
    {kind:'phone-controller-return',unit:'phone253',state:'termux-foreground',foreground_app_verified:true,visible_screen_verified:false,error:null,controller_state:'connected'},
    {kind:'phone-controller-return',unit:'phone191',state:'termux-foreground',foreground_app_verified:true,visible_screen_verified:true,error:null,controller_state:'connected'},
    {kind:'phone-controller-return',unit:'phone191',state:'termux-foreground',foreground_app_verified:false,visible_screen_verified:false,error:null,controller_state:'connected'},
    {kind:'phone-controller-return',unit:'phone191',state:'termux-foreground',foreground_app_verified:true,visible_screen_verified:false,error:null,controller_state:'disconnected'},
  ]){const bad=harness();bad.api.setReturn(controllerReport());bad.api.renderTermuxReturn([],{queue:[],history:[controllerResult({output:JSON.stringify(report)})]});assert.equal(bad.api.getReturn().tasks[0].state,'failed');}
});

test('no controller connection or unchanged foreground is displayed as failed',()=>{
  for(const error of ['No authorized Android connection for phone191.','Android did not bring Termux to the foreground.']){
    const h=harness();h.api.setReturn(controllerReport());
    h.api.renderTermuxReturn([],{queue:[],history:[controllerResult({status:'failed',output:JSON.stringify({kind:'phone-controller-return',unit:'phone191',state:'failed',foreground_app_verified:false,visible_screen_verified:false,error,controller_state:'disconnected'})})]});
    assert.equal(h.api.getReturn().tasks[0].state,'failed');assert.equal(h.api.getReturn().tasks[0].error,error);
    assert.match(h.elements['termux-return-report'].textContent,/failed/);
  }
});

test('ambiguous controller submission never replays and blocks the next navigation',async()=>{
  const h=harness({controlApi:async action=>{if(action==='bridge-status')return freshBridge();throw Error('Disconnected');}});
  await h.api.dispatchTermuxReturn();assert.equal(h.api.getReturn().tasks[0].state,'unconfirmed');
  assert.equal(JSON.parse(h.storage.get('curt-termux-return-v1')).tasks[0].state,'unconfirmed');
  await h.api.dispatchTermuxReturn();await h.api.dispatchBrowserOpen();assert.equal(h.calls.filter(c=>c[0]==='queue-command').length,1);
});

test('closing controller reports checks controller queue, including missing receipt IDs, without cancelling commands',async()=>{
  for(const missing of [false,true]){
    const saved=controllerReport('unconfirmed');if(missing)saved.tasks[0].command_id=null;
    const h=harness({commands:{queue:[{id:'control-191',target:'phone191',type:'phone-return-termux'}],history:[]}});h.api.setReturn(saved);await h.api.closeTermuxReturn();
    assert.equal(saved.closed_at,undefined);assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'commands');
  }
  const h=harness();h.api.setReturn(controllerReport('unconfirmed'));await h.api.closeTermuxReturn();
  assert.equal(h.api.getReturn().tasks[0].state,'closed');assert.ok(h.api.getReturn().closed_at);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'commands');assert.equal(h.calls[0][1],undefined);
  const young=harness();const recent=controllerReport('unconfirmed');recent.created_at=new Date().toISOString();young.api.setReturn(recent);await young.api.closeTermuxReturn();assert.equal(recent.closed_at,undefined);
});

test('closing reads verified results and preserves foreground evidence; incomplete controller snapshots cannot close',async()=>{
  const h=harness({commands:{queue:[],history:[controllerResult()]}});h.api.setReturn(controllerReport());await h.api.closeTermuxReturn();
  assert.equal(h.api.getReturn().tasks[0].state,'termux-foreground');assert.ok(h.api.getReturn().closed_at);
  const bad=harness({controlApi:async()=>({queue:[]})});bad.api.setReturn(controllerReport());await bad.api.closeTermuxReturn();assert.equal(bad.api.getReturn().closed_at,undefined);
});

test('return acceptance requires matching job, phone, contract and zero exit without claiming screen success',()=>{
  const h=harness();h.api.setReturn(returnReport());h.api.set(report('launch-requested'));
  h.api.renderTermuxReturn([returnResult({job_id:'other'}),returnResult({device_id:'phone253'})]);assert.equal(h.api.getReturn().tasks[0].state,'queued');
  h.api.renderTermuxReturn([returnResult()]);assert.equal(h.api.getReturn().tasks[0].state,'return-requested');
  assert.match(h.elements['termux-return-state'].textContent,/Screen visibility is unverified/);
  assert.equal(h.elements['termux-return-report'].textContent.includes('success'),false);assert.equal(h.api.get().tasks[0].state,'launch-requested');
  const reload=harness({storage:h.storage});assert.equal(reload.api.getReturn().tasks[0].state,'return-requested');
  for(const parsed of [
    {kind:'website-browser-open',state:'launch-requested',launch_requested:true,visible_screen_verified:false},
    {kind:'phone-termux-return',state:'return-requested',return_requested:true,request_completed:true,visible_screen_verified:true},
    {kind:'phone-termux-return',state:'return-requested',return_requested:true,visible_screen_verified:false},
    {kind:'phone-termux-return',state:'return-requested',return_requested:false,request_completed:true,visible_screen_verified:false},
  ]){const bad=harness();bad.api.setReturn(returnReport());bad.api.renderTermuxReturn([returnResult({stdout:JSON.stringify(parsed)})]);assert.equal(bad.api.getReturn().tasks[0].state,'failed');}
  const failed=harness();failed.api.setReturn(returnReport());failed.api.renderTermuxReturn([returnResult({exit_code:1})]);assert.equal(failed.api.getReturn().tasks[0].state,'failed');
  const pc=harness();const injected=returnReport();injected.tasks[0].unit='Nexus';pc.api.setReturn(injected);pc.api.renderTermuxReturn([returnResult({device_id:'Nexus'})]);assert.equal(pc.api.getReturn().tasks[0].state,'failed');
});

test('closing return reports refuses active jobs and closes old missing jobs without cancellation or retry',async()=>{
  for(const fixture of [
    {nodes:[],jobs:[{id:'return-191',status:'queued'}],results:[]},
    {nodes:[{id:'phone191',active_jobs:['return-191']}],jobs:[],results:[]},
  ]){const h=harness({api:async()=>fixture});h.api.setReturn(returnReport());await h.api.closeTermuxReturn();assert.equal(h.api.getReturn().closed_at,undefined);assert.equal(h.calls.filter(c=>c[0]==='enqueue').length,0);}
  const h=harness({api:async()=>({nodes:[],jobs:[],results:[]})});h.api.setReturn(returnReport('unconfirmed'));await h.api.closeTermuxReturn();
  assert.equal(h.api.getReturn().tasks[0].state,'closed');assert.ok(h.api.getReturn().closed_at);assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'queue-status');
  const young=harness();const recent=returnReport('unconfirmed');recent.created_at=new Date().toISOString();young.api.setReturn(recent);await young.api.closeTermuxReturn();
  assert.equal(young.api.getReturn().closed_at,undefined);assert.match(young.elements['termux-return-state'].textContent,/at least two minutes/);
});
