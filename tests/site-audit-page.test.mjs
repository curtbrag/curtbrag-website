import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createHandler, createDeploymentHandler, ORIGIN, PUBLIC_PATHS, allowedResource} from '../netlify/functions/lib/site-audit-page.mjs';
import {createSiteLock} from '../netlify/edge-functions/lib/site-lock-core.js';

function fixture({pageStatus=200,pageHeaders={},html='<title>Actual page</title><h1>Hello</h1>',sessionFails=false,throwPage=false}={}) {
  const requests=[],sessions=[]; let time=1000000;
  const handler=createHandler({credentials:async()=>({workerKey:'fixture-worker',webPassword:'fixture-operator'}),now:()=>time,
    createSession:async(key,value)=>{if(sessionFails) throw Error('session storage unavailable');sessions.push({key,value});},
    fetchImpl:async(url,options)=>{
      requests.push({url,options});
      if(throwPage) throw Error('fixture-operator cookie=secret Authorization=fixture-worker');
      return new Response(html,{status:pageStatus,headers:{'content-type':'text/html','x-curtbrag-access':'authenticated',...pageHeaders}});
    }});
  return {requests,sessions,handler,advance:ms=>time+=ms};
}
const request=(path='/',token='fixture-worker',extra='')=>new Request(ORIGIN+'/.netlify/functions/site-audit-page?path='+encodeURIComponent(path)+extra,{headers:{authorization:'Bearer '+token}});

test('the deployed factory rejects previews before reading credentials, storing sessions or fetching production',async()=>{
  for(const context of ['deploy-preview','branch-deploy','dev','',undefined]) {
    const calls=[];
    const handler=createDeploymentHandler({context,credentials:async()=>{calls.push('credentials');return {};},createSession:async()=>calls.push('session'),fetchImpl:async()=>calls.push('fetch')});
    const response=await handler(request());assert.equal(response.status,503);assert.match((await response.json()).error,/production site only/);assert.deepEqual(calls,[]);
  }
  let credentialsRead=0;
  const production=createDeploymentHandler({context:'production',credentials:async()=>{credentialsRead++;return {workerKey:'expected',webPassword:'operator'};},createSession:async()=>{throw Error('Wrong token cannot create a session');},fetchImpl:async()=>{throw Error('Wrong token cannot fetch');}});
  assert.equal((await production(request('/','wrong'))).status,401);assert.equal(credentialsRead,1);
});

test('unauthenticated, wrong-token, unsupported-path and write requests never fetch',async()=>{
  const f=fixture();
  assert.equal((await f.handler(new Request(ORIGIN+'/.netlify/functions/site-audit-page?path=%2F'))).status,401);
  assert.equal((await f.handler(request('/','wrong'))).status,401);
  for(const path of ['/cluster/dashboard/','/cluster/control/','/cluster/display.html','/api/cluster','/.netlify/functions/cluster-api','/_site/logout','//evil.example/','https://evil.example/','/gallery/../cluster/dashboard/','/%2e%2e/','/gallery/?secret=value']) assert.equal((await f.handler(request(path))).status,400,path);
  assert.equal((await f.handler(request('/','fixture-worker','&path=%2Fshop%2F'))).status,400);
  assert.equal((await f.handler(request('/','fixture-worker','&target=https%3A%2F%2Fevil.example'))).status,400);
  assert.equal((await f.handler(new Request(ORIGIN+'/.netlify/functions/site-audit-page?path=%2F',{method:'POST',headers:{authorization:'Bearer fixture-worker'}}))).status,405);
  assert.equal(f.requests.length,0);
  assert.equal(f.sessions.length,0);
});
test('all allowed pages use an ordinary internal site session and return bounded HTML without credentials',async()=>{
  const f=fixture();
  for(const path of PUBLIC_PATHS) {
    const response=await f.handler(request(path)); assert.equal(response.status,200,path);
    assert.equal(response.headers.get('cache-control'),'private, no-store, max-age=0'); assert.equal(response.headers.has('set-cookie'),false);
    const result=await response.json();assert.equal(result.url,ORIGIN+path);assert.equal(result.path,path);assert.equal(result.status,200);assert.equal(result.html,'<title>Actual page</title><h1>Hello</h1>');
    assert.equal(JSON.stringify(result).includes('fixture-operator'),false);assert.equal(JSON.stringify(result).includes('fixture-worker'),false);assert.equal(JSON.stringify(result).includes('a'.repeat(64)),false);
  }
  assert.equal(f.sessions.length,1);assert.equal(f.sessions[0].value.version,1);assert.equal(f.sessions[0].value.host,'curtbrag.com');assert.equal(f.sessions[0].value.expires,4600000);
  assert.equal(f.sessions[0].value.passwordRevision,createHash('sha256').update('fixture-operator').digest('hex'));
  for(const item of f.requests) {
    assert.equal(item.options.redirect,'manual');assert.ok(item.url.startsWith(ORIGIN+'/'));
    assert.equal(item.options.headers.authorization,undefined);assert.equal(item.options.headers.Authorization,undefined);
    assert.match(item.options.headers.cookie,/^__Host-curtbrag_access=[a-f0-9]{64}$/);
  }
  assert.equal((await f.handler(request('/','fixture-operator'))).status,200);
});
test('expired server session is replaced and simultaneous reads share one stored session',async()=>{
  const f=fixture();
  const first=await Promise.all(['/','/shop/','/contact/'].map(p=>f.handler(request(p))));assert.ok(first.every(r=>r.status===200));
  assert.equal(f.sessions.length,1);
  f.advance(3600001);assert.equal((await f.handler(request())).status,200);
  assert.equal(f.sessions.length,2);
});
test('redirects, password pages, non-HTML, oversized bodies and private upstream errors fail closed',async()=>{
  for(const options of [{pageStatus:302,pageHeaders:{location:'https://evil.example'}},{pageStatus:401},{pageHeaders:{'x-curtbrag-access':'password-required'}},{pageHeaders:{'content-type':'application/json'}},{html:'<title>CurtBrag · Private site</title>'},{html:'<form method="post" action="/_site/login">'},{html:'x'.repeat(1048577)},{sessionFails:true},{throwPage:true}]) {
    const f=fixture(options),response=await f.handler(request());assert.equal(response.status,502,JSON.stringify(Object.keys(options)));
    const text=await response.text();assert.equal(text.includes('fixture-operator'),false);assert.equal(text.includes('fixture-worker'),false);assert.equal(text.includes('cookie=secret'),false);
    assert.ok(f.requests.every(r=>r.url.startsWith(ORIGIN+'/')));
  }
});
test('upstream redirects reported in response URL cannot escape the fixed original page',async()=>{
  const handler=createHandler({credentials:async()=>({workerKey:'fixture-worker',webPassword:'fixture-operator'}),createSession:async()=>{},fetchImpl:async url=>{
    const response=url.endsWith('/_site/login')?new Response('{"ok":true}',{headers:{'set-cookie':'__Host-curtbrag_access='+'a'.repeat(64)+';'}}):new Response('<h1>Outside</h1>',{headers:{'content-type':'text/html'}});
    Object.defineProperty(response,'url',{value:url.endsWith('/_site/login')?url:'https://evil.example/'});return response;
  }});
  assert.equal((await handler(request())).status,502);
});
test('only fixed static asset prefixes/extensions are returned as bounded data with no cookies',async()=>{
  for(const path of ['/_astro/page.css','/_astro/page.js','/scripts/site.js','/styles/site.css','/assets/logo.png','/assets/fonts/main.woff2','/gallery/cars/car.webp','/gallery/snapon/truck.jpg','/gallery/snapon/Mobile uploads.jpg']) assert.equal(allowedResource(path),'asset',path);
  for(const path of ['/assets/private.json','/scripts/secret.py','/scripts/helper.sh','/netlify/config.json','/assets/a/../../secret.png','/assets/%2fsecret.png','/assets//secret.png','/scripts/cluster-api.js?token=secret','/_astro/file.html','/gallery/cars/private.html']) assert.equal(allowedResource(path),null,path);
  const calls=[];
  const handler=createHandler({credentials:async()=>({workerKey:'fixture-worker',webPassword:'fixture-operator'}),createSession:async()=>{},fetchImpl:async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/_site/login')) return new Response('{"ok":true}',{headers:{'set-cookie':'__Host-curtbrag_access='+'a'.repeat(64)+';'}});
    const response=new Response(Buffer.from([137,80,78,71]),{headers:{'content-type':url.endsWith('.jpg')?'image/jpeg':'image/png'}});
    Object.defineProperty(response,'url',{value:url});return response;
  }});
  const response=await handler(request('/assets/logo.png'));assert.equal(response.status,200);assert.equal(response.headers.has('set-cookie'),false);
  const result=await response.json();assert.equal(result.kind,'site-audit-asset');assert.equal(result.content_type,'image/png');assert.equal(result.bytes,4);assert.deepEqual(Buffer.from(result.data,'base64'),Buffer.from([137,80,78,71]));
  assert.equal(calls.length,1);assert.equal(calls[0].options.headers.authorization,undefined);
  const spaced=await handler(request('/gallery/snapon/Mobile uploads.jpg'));assert.equal(spaced.status,200);assert.equal((await spaced.json()).url,ORIGIN+'/gallery/snapon/Mobile uploads.jpg');assert.equal(calls.at(-1).url,ORIGIN+'/gallery/snapon/Mobile%20uploads.jpg');
  const badType=fixture({pageHeaders:{'content-type':'text/html'}});assert.equal((await badType.handler(request('/assets/logo.png'))).status,502);
});
test('internal session is accepted by the unchanged site lock and only its hash is stored',async()=>{
  const entries=new Map(),time=1000000;
  const lock=createSiteLock({getPassword:async()=> 'fixture-operator',getSessions:()=>({get:async key=>entries.get(key)}),now:()=>time});
  const handler=createHandler({credentials:async()=>({workerKey:'fixture-worker',webPassword:'fixture-operator'}),now:()=>time,
    createSession:async(key,value)=>entries.set(key,value),fetchImpl:async(url,options)=>lock(new Request(url,{headers:options.headers}),{next:async()=>new Response('<h1>Actual site content</h1>',{headers:{'content-type':'text/html'}})})});
  const response=await handler(request());assert.equal(response.status,200);assert.equal((await response.json()).html,'<h1>Actual site content</h1>');
  assert.equal(entries.size,1);assert.match([...entries.keys()][0],/^[a-f0-9]{64}$/);assert.equal([...entries.values()][0].passwordRevision,createHash('sha256').update('fixture-operator').digest('hex'));
  assert.equal((await handler(request('/','wrong'))).status,401);assert.equal(entries.size,1);
});
