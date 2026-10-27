// Synthetic operator login and in-memory stores only; no devices or network.
const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('./control-command-api.test.cjs');
const NOW = Date.parse('2026-10-27T22:00:00Z');
const PHONES = ['phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254'];

function snapshot(extra = {}) {
  return {schema:1, checked_at:new Date(NOW-1000).toISOString(), server_state:'available',
    devices:PHONES.map(unit => ({unit,state:unit==='phone253'?'connected':'disconnected'})), ...extra};
}
function heartbeat(phone_controller, extra = {}) {
  return {hostname:'fixture-pc',bridge_version:'2.6.1',summary:'Fixture bridge; mining disabled',phone_controller,...extra};
}
function harness(extra = {}) { return fixture({now:NOW,bridge:null,...extra}); }
async function stored(value, extra = {}) {
  const h=harness(extra), response=await h.cp('bridge-heartbeat',heartbeat(value));
  assert.equal(response.status,200);
  return {h,response,payload:h.inspect('cp-bridge','heartbeat')};
}

test('heartbeat stores and returns only the canonical eight-phone controller shape',async()=>{
  const raw=snapshot({serial:'private-transport',endpoint:'private-address',private_key:'private-credential',personal_phone:{secret:'private-personal'}});
  raw.devices.reverse();
  for (const row of raw.devices) Object.assign(row,{serial:'private-serial',endpoint:'private-endpoint',key:'private-key'});
  raw.devices.find(row=>row.unit==='phone173').state='unauthorized';
  raw.devices.find(row=>row.unit==='phone174').state='unknown';
  const expected=snapshot();
  expected.devices.find(row=>row.unit==='phone173').state='unauthorized';
  expected.devices.find(row=>row.unit==='phone174').state='unknown';
  const {h,response,payload}=await stored(raw);
  assert.deepEqual(payload.phone_controller,expected);
  assert.deepEqual(response.body.bridge.phone_controller,expected);
  const status=await h.cpGet('bridge-status');
  assert.equal(status.status,200);
  assert.deepEqual(status.body.phone_controller,expected);
  assert.equal(status.body.bridge_version,'2.6.1');
  assert.equal(status.body.alive,true);
  assert.doesNotMatch(JSON.stringify([payload,response.body,status.body]),/private-/);
});

test('round-trip PowerShell UTC timestamps are canonicalized without changing their millisecond instant',async()=>{
  for (const checked_at of ['2026-10-27T21:59:59.1234567+00:00','2026-10-27T21:59:59.1234567Z','2026-10-27T21:59:59Z']) {
    const {payload}=await stored(snapshot({checked_at}));
    assert.equal(payload.phone_controller.checked_at,new Date(checked_at).toISOString());
  }
});

test('old bridges and missing snapshots remain explicitly unknown rather than appearing connected',async()=>{
  const h=harness();
  const first=await h.cpGet('bridge-status');
  assert.equal(first.status,200);assert.equal(first.body.phone_controller,null);
  const result=await h.cp('bridge-heartbeat',{hostname:'fixture-pc',bridge_version:'2.6.0'});
  assert.equal(result.status,200);assert.equal(result.body.bridge.phone_controller,null);
  const read=await h.cpGet('bridge-status');
  assert.equal(read.body.bridge_version,'2.6.0');assert.equal(read.body.alive,true);assert.equal(read.body.phone_controller,null);
});

test('invalid snapshot containers, schema and scalar fields are discarded before storage',async()=>{
  for (const value of [null,undefined,[],false,1,'snapshot',{},snapshot({schema:'1'}),snapshot({schema:2}),
    snapshot({server_state:'connected'}),snapshot({server_state:1}),snapshot({checked_at:NOW}),
    snapshot({devices:{}}),snapshot({devices:null})]) {
    const {h,response,payload}=await stored(value);
    assert.equal(payload.phone_controller,null,JSON.stringify(value));
    assert.equal(response.body.bridge.phone_controller,null);
    assert.equal((await h.cpGet('bridge-status')).body.phone_controller,null);
  }
});

test('missing, duplicate, extra, personal and noncanonical phone rows cannot create availability',async()=>{
  const invalid=[];
  invalid.push(snapshot({devices:snapshot().devices.slice(1)}));
  invalid.push(snapshot({devices:[...snapshot().devices,{unit:'s26ultra',state:'connected'}]}));
  for (const replacement of [{unit:'phone173',state:'connected'},{unit:'s26ultra',state:'connected'},
    {unit:'Phone253',state:'connected'},{unit:'phone252',state:'connected'},{unit:'192.168.1.253:39899',state:'connected'},
    {unit:253,state:'connected'},null,[],false,'phone253',{}]) {
    const value=snapshot();value.devices[6]=replacement;invalid.push(value);
  }
  for (const value of invalid) assert.equal((await stored(value)).payload.phone_controller,null,JSON.stringify(value));
});

test('only fixed controller states are accepted for each exact unit',async()=>{
  for (const state of [undefined,null,false,1,'device','ready','CONNECTED','connected;input keyevent 4','']) {
    const value=snapshot();value.devices[0]={unit:'phone173',state};
    assert.equal((await stored(value)).payload.phone_controller,null,JSON.stringify(value));
  }
});

test('a connected phone requires an available server while unavailable and unknown metadata can remain unknown',async()=>{
  for (const server_state of ['unavailable','unknown']) {
    assert.equal((await stored(snapshot({server_state}))).payload.phone_controller,null);
    const value=snapshot({server_state,devices:PHONES.map(unit=>({unit,state:'unknown'}))});
    assert.deepEqual((await stored(value)).payload.phone_controller,value);
  }
});

test('malformed, rolled-over and non-UTC dates are rejected rather than normalized into a fresh snapshot',async()=>{
  for (const checked_at of ['', 'now', '2026-10-27', '2026-10-27 21:59:59Z','2026-10-27T21:59:59',
    '2026-10-27T17:59:59-04:00','2026-10-27T21:59:59+01:00','2026-10-27T21:59:59.12345678Z',
    '2026-02-30T21:59:59Z','2026-10-27T24:00:00Z','2026-10-27T21:59:60Z','2026-13-01T21:59:59Z']) {
    // Set the fixture near malformed calendar dates so age alone does not hide date validation.
    const parsed=Date.parse(checked_at),now=Number.isFinite(parsed)?parsed:NOW;
    assert.equal((await stored(snapshot({checked_at}),{now})).payload.phone_controller,null,checked_at);
  }
});

test('snapshot age and future skew use inclusive ninety-second and thirty-second bounds',async()=>{
  for (const delta of [-90000,-1,0,30000]) {
    const checked_at=new Date(NOW+delta).toISOString();
    assert.equal((await stored(snapshot({checked_at}))).payload.phone_controller.checked_at,checked_at);
  }
  for (const delta of [-90001,30001]) {
    const checked_at=new Date(NOW+delta).toISOString();
    assert.equal((await stored(snapshot({checked_at}))).payload.phone_controller,null);
  }
});

test('bridge status revalidates a previously accepted snapshot as time passes',async()=>{
  const {payload}=await stored(snapshot({checked_at:new Date(NOW).toISOString()}));
  const refreshedBridge={...payload,last_seen_at:new Date(NOW+90001).toISOString()};
  const expired=harness({now:NOW+90001,bridge:refreshedBridge});
  const read=await expired.cpGet('bridge-status');
  assert.equal(read.body.alive,true,'A new bridge heartbeat alone does not renew controller metadata.');
  assert.equal(read.body.phone_controller,null);
  assert.deepEqual(expired.inspect('cp-bridge','heartbeat'),refreshedBridge,'A read does not mutate stored metadata.');
});

test('bridge status sanitizes raw historical storage as well as new heartbeat bodies',async()=>{
  const raw=snapshot({private_key:'private-historical'});raw.devices[0].serial='private-historical-serial';
  const h=harness({bridge:heartbeat(raw,{last_seen_at:new Date(NOW).toISOString()})});
  const response=await h.cpGet('bridge-status');
  assert.deepEqual(response.body.phone_controller,snapshot());
  assert.doesNotMatch(JSON.stringify(response.body),/private-/);
});

test('fresh bridge metadata cannot make a corrupt saved controller snapshot valid',async()=>{
  for (const phone_controller of [snapshot({schema:2}),snapshot({checked_at:new Date(NOW-90001).toISOString()}),
    snapshot({server_state:'unavailable'}),snapshot({devices:[...snapshot().devices.slice(1),{unit:'s26ultra',state:'connected'}]})]) {
    const bridge=heartbeat(phone_controller,{last_seen_at:new Date(NOW).toISOString()});
    const h=harness({bridge}),read=await h.cpGet('bridge-status');
    assert.equal(read.status,200);assert.equal(read.body.alive,true);
    assert.equal(read.body.phone_controller,null);
    assert.deepEqual(h.inspect('cp-bridge','heartbeat'),bridge,'Reading corrupt metadata leaves the saved record untouched.');
  }
});

test('controller telemetry still requires existing operator authentication and does not change command queues',async()=>{
  const held={id:'112fe487d5ea83a1f265a74a72486ad6',type:'reconcile',target:'phones',route:'bridge',status:'queued',created_at:NOW-100000};
  const h=harness({queue:[held]});
  const denied=await h.cp('bridge-heartbeat',heartbeat(snapshot()),{headers:{authorization:''}});
  assert.equal(denied.status,401);assert.equal(h.inspect('cp-bridge','heartbeat'),null);
  assert.equal((await h.cpGet('bridge-status',{headers:{authorization:''}})).status,401);
  const good=await h.cp('bridge-heartbeat',heartbeat(snapshot()));assert.equal(good.status,200);
  assert.deepEqual(h.inspect('cp-commands','queue'),[held]);
  assert.deepEqual(h.inspect('cp-commands','history'),[]);
  assert.deepEqual(h.writes.filter(row=>row.committed).map(row=>row.name),['cp-bridge']);
});
