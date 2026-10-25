const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),vm=require('node:vm');
const {createHash,webcrypto}=require('node:crypto'),{gzipSync}=require('node:zlib');
const source=fs.readFileSync('public/scripts/cluster-swarm-live-v8.js','utf8');
const segment=source.slice(source.indexOf('  let changeMonitor ='),source.indexOf('  let browserOpenReport='));
function harness({defer=false}={}){
 const elements=Object.fromEntries(['change-state','change-baseline','change-export','change-report'].map(id=>[id,{textContent:'',disabled:false}])),saved=[],pending=[];
 const context=vm.createContext({Blob,DecompressionStream,TextEncoder,TextDecoder,atob,Uint8Array,Set,Date,JSON,Number,Array,Promise,
  crypto:{subtle:{digest:async(...args)=>{if(defer)await new Promise(resolve=>pending.push(resolve));return webcrypto.subtle.digest(...args);}}},
  localStorage:{getItem:()=>null,setItem:(key,value)=>saved.push(JSON.parse(value))},document:{getElementById:id=>elements[id]||null}});
 vm.runInContext(segment+'\nglobalThis.api={decodeChangeSnapshot,renderChangeMonitor,set:value=>changeMonitor=value,get:()=>changeMonitor};',context);
 return {api:context.api,elements,saved,pending};
}
const sha=text=>createHash('sha256').update(text).digest('hex');
const task=(extra={})=>({path:'/cluster/',worker:'phone177',job_id:'change-monitor-fixture-3',state:'queued',...extra});
const report=(text,extra={})=>({kind:'page-snapshot',path:'/cluster/',url:'https://curtbrag.com/cluster/',title:'Compute Cluster',text,sha256:sha(text),...extra});
const result=(value,extra={})=>({job_id:'change-monitor-fixture-3',device_id:'phone177',exit_code:0,stdout:JSON.stringify(value),...extra});
function packed(text,extra={}){const value=report(text);delete value.text;return {...value,text_encoding:'gzip-base64',text_gzip:gzipSync(text).toString('base64'),text_bytes:Buffer.byteLength(text),text_chars:text.length,...extra};}
test('legacy complete receipts remain compatible and their checksum is verified',async()=>{
 const h=harness(),text='Existing complete baseline\nSecond line';
 const decoded=await h.api.decodeChangeSnapshot(result(report(text)),task());assert.equal(decoded.text,text);assert.equal(decoded.sha256,sha(text));
 await assert.rejects(h.api.decodeChangeSnapshot(result(report(text,{sha256:'a'.repeat(64)})),task()),/checksum/);
});
test('long non-ASCII page snapshots survive the worker result limit without dropping text',async()=>{
 const h=harness(),text='Socket repair 日本語 🔧\n'.repeat(1600),wire=packed(text);
 assert.ok(Buffer.byteLength(JSON.stringify(wire))<=3800);assert.ok(Buffer.byteLength(text)>4000);
 const decoded=await h.api.decodeChangeSnapshot(result(wire),task());assert.equal(decoded.text,text);assert.equal(decoded.sha256,sha(text));assert.equal(Object.hasOwn(decoded,'text_gzip'),false);
});
test('truncated JSON, worker errors, unrelated reports and corrupt compressed evidence stay explicit failures',async()=>{
 const h=harness();
 await assert.rejects(h.api.decodeChangeSnapshot({exit_code:0,stdout:'{"kind":"page-snapshot","text":"'+ 'x'.repeat(3950)},task()),/incomplete snapshot JSON/);
 await assert.rejects(h.api.decodeChangeSnapshot(result({kind:'page-snapshot-error',error:'Complete page text cannot fit the worker result limit'},{exit_code:1}),task()),/cannot fit the worker result limit/);
 for(const value of [packed('full text',{kind:'website-audit'}),packed('full text',{path:'/shop/'}),packed('full text',{url:'https://evil.example/cluster/'}),packed('full text',{text:'ambiguous'}),packed('full text',{text_encoding:'unknown'}),packed('full text',{text_chars:1}),packed('full text',{text_bytes:1}),packed('full text',{text_gzip:'invalid'}),packed('full text',{sha256:'0'.repeat(64)})]) await assert.rejects(h.api.decodeChangeSnapshot(result(value),task()));
});
test('a compressed receipt cannot inflate past its declared size or the bounded display budget',async()=>{
 const h=harness(),bomb=packed('x'.repeat(240001),{text_bytes:240000,text_chars:60000});
 await assert.rejects(h.api.decodeChangeSnapshot(result(bomb),task()),/exceeded its result limit/);
 await assert.rejects(h.api.decodeChangeSnapshot(result(packed('x',{text_bytes:240001})),task()),/metadata/);
 await assert.rejects(h.api.decodeChangeSnapshot(result(packed('x',{text_chars:60001})),task()),/metadata/);
});
test('a snapshot finishing after the current batch changes cannot overwrite the new batch or baseline',async()=>{
 const h=harness({defer:true}),old={baselines:{},batch:{id:'old',tasks:[task()]}};
 h.api.set(old);const pending=h.api.renderChangeMonitor([result(report('Old batch text'))]);assert.equal(h.pending.length,1);
 const current={baselines:{},batch:{id:'new',tasks:[task({job_id:'change-monitor-new-0'})]}};h.api.set(current);await h.api.renderChangeMonitor([]);
 h.pending[0]();await pending;
 assert.equal(h.api.get().batch.id,'new');assert.equal(h.api.get().batch.tasks[0].state,'queued');assert.equal(Object.keys(h.api.get().baselines).length,0);assert.match(h.elements['change-state'].textContent,/0\/1 pages checked/);
});
test('current compressed evidence becomes a complete baseline and is retained for full report export',async()=>{
 const h=harness(),text='All original lines retained\n'.repeat(500),state={baselines:{},batch:{id:'current',tasks:[task()]}};
 h.api.set(state);await h.api.renderChangeMonitor([result(packed(text))]);
 assert.equal(h.api.get().batch.tasks[0].state,'complete');assert.equal(h.api.get().baselines['/cluster/'].text,text);assert.equal(h.api.get().batch.tasks[0].report.text,text);assert.match(h.elements['change-state'].textContent,/1\/1 pages checked/);assert.equal(h.saved.at(-1).batch.tasks[0].report.text,text);
});
