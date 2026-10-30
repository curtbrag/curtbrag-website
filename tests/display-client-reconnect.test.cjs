const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test'),assert=require('node:assert/strict');
const html=fs.readFileSync(path.join(__dirname,'../public/cluster/display.html'),'utf8');
const helper=html.slice(html.indexOf('let upgradingLegacyParent='),html.indexOf('// New embedded pages can cooperate'));
const modes=['home','dashboard','visuals','clock','test','activity'];
function page({parentURL='https://curtbrag.com/cluster/display.html?name=phone253&immersive=1',parentName='phone253',unit='phone253',embedded=true,current=false,owned=true,top=false,throws=false}={}){
 const calls=[],frame={},parent={__curtDisplayClientVersion:current?78:undefined,location:{href:parentURL,replace:url=>{calls.push(url);if(throws)throw Error('Navigation unavailable');}},document:{getElementById:id=>id==='name'?{value:parentName}:id==='dashboard'?{querySelector:()=>owned?frame:{}}:null}};
 const window={parent,frameElement:frame};if(top)window.parent=window;
 const context=vm.createContext({URL,Number,modes,window,location:{origin:'https://curtbrag.com'},params:new URLSearchParams(embedded?'embedded=1':''),$:()=>({value:unit})});
 vm.runInContext(helper+';globalThis.upgrade=upgradeLegacyDisplayParent;',context);
 return {calls,upgrade:data=>context.upgrade(data)};
}
const data={mode:'clock',activity:{unit:'phone253'}};
test('a fresh own-status child refreshes only its matching legacy display once',()=>{
 const p=page();assert.equal(p.upgrade(data),true);assert.equal(p.upgrade(data),false);assert.equal(p.calls.length,1);
 const url=new URL(p.calls[0],'https://curtbrag.com');assert.equal(url.pathname,'/cluster/display.html');assert.equal(url.searchParams.get('name'),'phone253');assert.equal(url.searchParams.get('mode'),'clock');assert.equal(url.searchParams.get('immersive'),'1');assert.equal(url.searchParams.get('v'),'78');assert.equal(url.searchParams.has('embedded'),false);
});
test('a current parent is not repeatedly reloaded when dashboard embeds activity',()=>{
 const p=page({current:true});assert.equal(p.upgrade({...data,mode:'dashboard'}),false);assert.equal(p.upgrade(data),false);assert.equal(p.calls.length,0);
});
test('foreign origins, paths, names and unowned frames cannot be navigated',()=>{
 for(const options of [{parentURL:'https://example.com/cluster/display.html'},{parentURL:'https://curtbrag.com/cluster/dashboard/'},{parentName:'phone191'},{owned:false},{embedded:false},{top:true},{unit:'RenderRig'},{unit:'personal'}]){const p=page(options);assert.equal(p.upgrade(data),false);assert.equal(p.calls.length,0);}
});
test('an own-status response and known mode are required before refreshing',()=>{
 for(const response of [{...data,activity:{unit:'phone191'}},{mode:'clock'},{...data,mode:'https://example.com/'},null]){const p=page();assert.equal(p.upgrade(response),false);assert.equal(p.calls.length,0);}
});
test('old query credentials and fragment are not copied into the refreshed page',()=>{
 const p=page({parentURL:'https://curtbrag.com/cluster/display.html?name=phone253&display_ticket=old-secret&embedded=1#old'});assert.equal(p.upgrade(data),true);assert.doesNotMatch(p.calls[0],/secret|ticket|embedded|#old/);
});
test('a failed navigation is not retried repeatedly by polling',()=>{
 const p=page({throws:true});assert.equal(p.upgrade(data),false);assert.equal(p.upgrade(data),false);assert.equal(p.calls.length,1);
});
test('a top-level page with an old embedded flag still applies remote modes',async()=>{
 const sync=html.slice(html.indexOf('async function syncDisplay(){'),html.indexOf('\ntick();'));
 for(const top of [true,false]){
  const shown=[],window={};window.parent=top?window:{};
  const context=vm.createContext({window,URL,AbortController,modes,params:new URLSearchParams('embedded=1'),unitPattern:/^phone253$/,document:{hidden:false},$:id=>id==='name'?{value:'phone253'}:{textContent:''},setTimeout:()=>1,clearTimeout(){},fetch:async()=>({ok:true,json:async()=>({...data,revision:'new-revision'})}),renderActivity(){},upgradeLegacyDisplayParent:()=>false,applyRemoteSleepTest(){},show:mode=>shown.push(mode)});
  vm.runInContext('let displayPolling=false,displayRevision=null;'+sync+';globalThis.sync=syncDisplay;',context);await context.sync();assert.deepEqual(shown,top?['clock']:[]);
 }
});
