const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('public/scripts/cluster-swarm-live-v8.js','utf8');
function harness(value){
 const elements={'change-paths':{value},'change-check':{disabled:false},'change-state':{textContent:''}};
 let calls=0;
 const context=vm.createContext({localStorage:{getItem:()=>null,setItem:()=>{}},document:{getElementById:id=>elements[id]},swarmApi:()=>{calls++;throw Error('Unexpected network request');}});
 const segment=source.slice(source.indexOf('  let changeMonitor ='),source.indexOf('  let browserOpenReport='));
 vm.runInContext(segment+'\nglobalThis.api={validatedChangePaths,dispatchChangeMonitor};',context);
 return {api:context.api,elements,calls:()=>calls};
}
test('supported paths match the production API and duplicate entries are removed',()=>{
 const h=harness('');
 const api=fs.readFileSync('netlify/functions/lib/site-audit-page.mjs','utf8');
 const paths=JSON.parse('['+api.match(/PUBLIC_PATHS = new Set\(\[([^\]]+)\]/)[1].replaceAll("'",'"')+']');
 for(const path of paths)assert.deepEqual(Array.from(h.api.validatedChangePaths(path)),[path]);
 assert.deepEqual(Array.from(h.api.validatedChangePaths('/\n/gallery/ /gallery/')),['/','/gallery/']);
 assert.throws(()=>h.api.validatedChangePaths(paths.join('\n')),/1–12/);
});
test('unsupported paths never reach the queue and explain the supported choices',async()=>{
 for(const path of ['/missing/','/gallery','/cluster/display/','/cluster/dashboard/','//example.com/','/shop/?q=x','']){
  const h=harness(path);await h.api.dispatchChangeMonitor();
  assert.equal(h.calls(),0);assert.equal(h.elements['change-check'].disabled,false);
  assert.match(h.elements['change-state'].textContent,path?/Supported paths:.*\/gallery\//:/1–12/);
 }
});
