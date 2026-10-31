// Production request helpers only, with virtual clocks/timers and fake fetch.
// No network, actual sign-in, queues, or device controllers are accessed.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const ROOT=path.resolve(__dirname,'..');
const CONTROL_API='/.netlify/functions/cluster-api',SWARM_API='/api/cluster';
const workspace=fs.readFileSync(path.join(ROOT,'public/scripts/cluster-swarm-live-v8.js'),'utf8');
const legacy=fs.readFileSync(path.join(ROOT,'src/pages/cluster/dashboard.astro'),'utf8');
function slice(source,start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a);
  assert.ok(a>=0&&b>a,'Production request helper must be present');
  return source.slice(a,b);
}
const source={
  workspace:slice(workspace,'  async function request(','  const swarmApi ='),
  legacy:slice(legacy,'async function fetchDashboardApi(','async function callApi('),
};
const response=(status=200,data={ok:true},extra={})=>({status,data,...extra});

function harness(kind,replies,options={}){
  const calls=[],timers=[],controllers=[],removed=[],redirects=[],clock={now:Date.parse('2026-10-27T23:00:00Z')};
  class Clock extends Date {static now(){return clock.now;}}
  class FakeSignal {
    constructor(){this.aborted=false;this.listeners=[];}
    addEventListener(name,callback,settings){if(name==='abort')this.listeners.push({callback,once:settings?.once});}
    removeEventListener(name,callback){if(name==='abort')this.listeners=this.listeners.filter(row=>row.callback!==callback);}
  }
  class FakeAbortController {
    constructor(){this.signal=new FakeSignal();controllers.push(this);}
    abort(){if(this.signal.aborted)return;this.signal.aborted=true;for(const row of [...this.signal.listeners])row.callback();this.signal.listeners=this.signal.listeners.filter(row=>!row.once);}
  }
  function advance(ms){
    const until=clock.now+ms;
    for(;;){
      const next=timers.filter(row=>!row.cleared&&!row.fired&&row.at<=until).sort((a,b)=>a.at-b.at||a.id-b.id)[0];
      if(!next)break;
      clock.now=next.at;next.fired=true;next.callback();
    }
    clock.now=until;
  }
  const context=vm.createContext({URLSearchParams,Date:Clock,Promise,Error,TypeError,AbortController:FakeAbortController,
    CONTROL_API,SWARM_API,API:CONTROL_API,token:()=>options.token===false?'':'fixture-session',
    sessionStorage:{removeItem:key=>removed.push(key)},window:{location:{replace:url=>redirects.push(url)}},
    setTimeout:(callback,ms)=>{
      const row={id:timers.length+1,callback,ms,at:clock.now+ms,cleared:false,fired:false};timers.push(row);
      if(ms===200&&!options.holdBackoff)queueMicrotask(()=>{if(!row.cleared&&!row.fired)advance(Math.max(0,row.at-clock.now));});
      return row.id;
    },
    clearTimeout:id=>{const row=timers.find(row=>row.id===id);if(row)row.cleared=true;},
    fetch:async(url,settings={})=>{
      calls.push({url,settings:{...settings},at:clock.now});
      if(!replies.length)throw Error('Unexpected additional fetch in offline fixture');
      const reply=replies.shift();
      if(reply instanceof Error)throw reply;
      if(reply.advanceMs)advance(reply.advanceMs);
      if(reply.abort)controllers[0].abort();
      return {status:reply.status,ok:reply.status>=200&&reply.status<300,json:async()=>{
        if(reply.jsonError)throw Error('Fixture malformed JSON');
        return reply.data;
      }};
    }});
  vm.runInContext(source[kind]+'\nthis.read='+(kind==='workspace'?'request':'fetchDashboardApi')+';',context);
  return {calls,timers,controllers,removed,redirects,clock,advance,
    read(action='bridge-status',settings={}){
      return kind==='workspace'
        ?context.read(settings.base||CONTROL_API,action,settings.method||'GET',settings.body??null)
        :context.read(settings.url||CONTROL_API+'?action='+action,settings);
    },
    async backoffReady(){for(let i=0;i<12;i++){if(timers.some(row=>row.ms===200&&!row.fired))return;await Promise.resolve();}throw Error('Expected bounded backoff was not scheduled');},
  };
}

for(const kind of ['workspace','legacy']){
  test(`${kind}: one transient status read recovers after exactly one 200ms pause`,async()=>{
    const h=harness(kind,[response(503,{error:'usage_exceeded'}),response(200,{ok:true,alive:true})]);
    const value=await h.read();
    assert.equal(kind==='workspace'?value.alive:value.data.alive,true);
    assert.equal(h.calls.length,2);assert.equal(h.calls[1].at-h.calls[0].at,200);
    assert.equal(h.timers.filter(row=>row.ms===200).length,1);
    assert.equal(h.timers.filter(row=>row.ms===12000).length,1);
    assert.equal(h.timers.find(row=>row.ms===12000).cleared,true);
  });

  test(`${kind}: HTTP502,503 and504 are the only transient server statuses retried`,async()=>{
    for(const status of [502,503,504]){
      const h=harness(kind,[response(status,{error:'temporary'}),response(200,{ok:true,marker:status})]);
      const value=await h.read('commands');assert.equal(kind==='workspace'?value.marker:value.data.marker,status);assert.equal(h.calls.length,2);
    }
    for(const status of [400,401,403,404,409,429,500]){
      const h=harness(kind,[response(status,{error:'fixed rejection'})]);
      if(kind==='workspace')await assert.rejects(h.read('commands'));
      else assert.equal((await h.read('commands')).status,status);
      assert.equal(h.calls.length,1,status);assert.equal(h.timers.some(row=>row.ms===200),false);
    }
  });

  test(`${kind}: two transient failures remain bounded without a third fetch`,async()=>{
    const h=harness(kind,[response(503,{error:'first failure'}),response(504,{error:'second failure'})]);
    if(kind==='workspace')await assert.rejects(h.read(),/second failure/);
    else {const value=await h.read();assert.equal(value.ok,false);assert.equal(value.status,504);assert.equal(value.data.error,'second failure');}
    assert.equal(h.calls.length,2);assert.equal(h.timers.filter(row=>row.ms===200).length,1);
    assert.equal(h.timers.find(row=>row.ms===12000).cleared,true);
  });

  test(`${kind}: POSTs and requests carrying a body never receive this read retry`,async()=>{
    for(const settings of [{method:'POST',body:JSON.stringify({action:'check'})},{method:'POST'},{method:'GET',body:{}},{method:'GET',body:''}]){
      const h=harness(kind,[response(503,{error:'temporary'})]);
      if(kind==='workspace')await assert.rejects(h.read('bridge-status',settings),/temporary/);
      else assert.equal((await h.read('bridge-status',settings)).status,503);
      assert.equal(h.calls.length,1);assert.equal(h.timers.some(row=>row.ms===200),false);
    }
  });

  test(`${kind}: unknown reads and worker polling never receive an automatic retry`,async()=>{
    for(const action of ['swarm-poll','poll','auth-check','queue-command','phone-follow-status','arbitrary-action']){
      const h=harness(kind,[response(503,{error:'not allowlisted'})]);
      if(kind==='workspace')await assert.rejects(h.read(action),/not allowlisted/);
      else assert.equal((await h.read(action)).status,503);
      assert.equal(h.calls.length,1,action);assert.equal(h.timers.some(row=>row.ms===200),false);
    }
  });

  test(`${kind}: HTTP200 application errors are not mistaken for transient transport failures`,async()=>{
    const h=harness(kind,[response(200,{ok:false,error:'application failure'})]);
    if(kind==='workspace')await assert.rejects(h.read(),/application failure/);
    else {const value=await h.read();assert.equal(value.status,200);assert.equal(value.data.ok,false);}
    assert.equal(h.calls.length,1);assert.equal(h.timers.some(row=>row.ms===200),false);
  });

  test(`${kind}: malformed transient error JSON can recover with one read retry`,async()=>{
    const h=harness(kind,[response(503,undefined,{jsonError:true}),response(200,{ok:true,marker:'recovered'})]);
    const value=await h.read('devices');assert.equal(kind==='workspace'?value.marker:value.data.marker,'recovered');assert.equal(h.calls.length,2);
  });

  test(`${kind}: both fetch attempts share the original controller signal and twelve-second budget`,async()=>{
    const h=harness(kind,[response(503),response(200,{ok:true})]);await h.read();
    assert.equal(h.controllers.length,1);assert.equal(h.calls[0].settings.signal,h.calls[1].settings.signal);
    assert.equal(h.calls[0].settings.signal,h.controllers[0].signal);
    assert.equal(h.timers.filter(row=>row.ms===12000).length,1);
    assert.equal(h.calls[1].settings.body,undefined);
  });

  test(`${kind}: an abort during backoff prevents any second fetch`,async()=>{
    const h=harness(kind,[response(503)],{holdBackoff:true});
    const pending=h.read();await h.backoffReady();h.controllers[0].abort();h.advance(200);
    await assert.rejects(pending,/Connection timed out/);
    assert.equal(h.calls.length,1);assert.equal(h.timers.find(row=>row.ms===12000).cleared,true);
  });

  test(`${kind}: remaining budget cannot be renewed by the retry backoff`,async()=>{
    const h=harness(kind,[response(503,{error:'temporary'},{advanceMs:11900})]);
    await assert.rejects(h.read(),/Connection timed out/);
    assert.equal(h.calls.length,1);assert.equal(h.controllers[0].signal.aborted,true);
    assert.equal(h.timers.filter(row=>row.ms===12000).length,1);
  });

  test(`${kind}: network TypeErrors and timed-out fetches do not get status-read retries`,async()=>{
    const network=harness(kind,[new TypeError('Fixture offline')]);
    await assert.rejects(network.read(),/Fixture offline/);assert.equal(network.calls.length,1);
    const timeout=harness(kind,[response(503,undefined,{abort:true,jsonError:true})]);
    await assert.rejects(timeout.read(),/Connection timed out/);assert.equal(timeout.calls.length,1);
    assert.equal(timeout.timers.some(row=>row.ms===200),false);
  });
}

test('workspace: all explicit read base/action pairs recover but aliases and mismatched endpoints do not',async()=>{
  for(const [base,action] of [[CONTROL_API,'bridge-status'],[CONTROL_API,'commands'],[CONTROL_API,'devices'],[SWARM_API,'queue-status']]){
    const h=harness('workspace',[response(503),response(200,{ok:true})]);await h.read(action,{base});assert.equal(h.calls.length,2);
    assert.equal(h.calls.every(call=>call.url.startsWith(base+'?action='+action+'&_=')),true);
  }
  for(const [base,action] of [[CONTROL_API,'queue-status'],[SWARM_API,'commands'],['/api/cluster-api','bridge-status'],['https://other.invalid/api/cluster','queue-status']]){
    const h=harness('workspace',[response(503,{error:'wrong endpoint'})]);await assert.rejects(h.read(action,{base}),/wrong endpoint/);assert.equal(h.calls.length,1);
  }
});

test('legacy: the exact operator relative URL and read action allowlist bound recovery',async()=>{
  for(const action of ['summary','devices','alerts','commands','events','bridge-status','fleet-analytics','thermal-report','profiles','groups','device-logs']){
    const h=harness('legacy',[response(503),response(200,{ok:true})]);const value=await h.read(action);assert.equal(value.status,200);assert.equal(h.calls.length,2,action);
  }
  for(const url of ['https://other.invalid'+CONTROL_API+'?action=commands','https://curtbrag.com'+CONTROL_API+'?action=commands',SWARM_API+'?action=queue-status',CONTROL_API+'/other?action=commands','/api/cluster-api?action=commands']){
    const h=harness('legacy',[response(503)]);assert.equal((await h.read('commands',{url})).status,503);assert.equal(h.calls.length,1,url);
  }
});

test('workspace: HTTP401 still removes the dashboard session and returns to sign-in without retrying',async()=>{
  const h=harness('workspace',[response(401,{error:'unauthorized'})]);await assert.rejects(h.read(),/Session expired/);
  assert.deepEqual(h.removed,['cp_password']);assert.deepEqual(h.redirects,['/cluster/dashboard/?signedout=1']);assert.equal(h.calls.length,1);
});

test('workspace: missing session never sends a status request',async()=>{
  const h=harness('workspace',[],{token:false});await assert.rejects(h.read(),/not authenticated/);
  assert.equal(h.calls.length,0);assert.equal(h.controllers.length,0);
});

test('workspace: only a matching explicit pre-enqueue rejection proves that no job was queued',async()=>{
  const rejected={ok:false,error:'Command rejected',code:'enqueue-validation-rejected',enqueued:false,job_id:'fixture-job'};
  const settings={base:SWARM_API,method:'POST',body:{job:{id:'fixture-job'}}};
  const h=harness('workspace',[response(400,rejected)]);
  await assert.rejects(h.read('enqueue',settings),error=>error.notQueued===true&&/Command rejected/.test(error.message));
  assert.equal(h.calls.length,1,'Rejections must not trigger automatic retries');
  for(const [status,data,options,action] of [
    [409,rejected,settings,'enqueue'],[503,rejected,settings,'enqueue'],
    [400,{...rejected,job_id:'other'},settings,'enqueue'],
    [400,{...rejected,enqueued:undefined},settings,'enqueue'],
    [400,{...rejected,code:undefined},settings,'enqueue'],
    [400,{...rejected,ok:true},settings,'enqueue'],
    [400,rejected,{...settings,base:CONTROL_API},'enqueue'],
    [400,rejected,{...settings,method:'GET'},'enqueue'],
    [400,rejected,settings,'queue-command']
  ]){
    const candidate=harness('workspace',[response(status,data)]);
    await assert.rejects(candidate.read(action,options),error=>error.notQueued!==true);
    assert.equal(candidate.calls.length,1);
  }
  const offline=harness('workspace',[new TypeError('Connection lost')]);
  await assert.rejects(offline.read('enqueue',settings),error=>error.notQueued!==true);
});
