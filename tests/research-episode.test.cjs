const fs=require('fs'), vm=require('vm'), assert=require('node:assert/strict');
const src=fs.readFileSync('public/scripts/cluster-swarm-live-v8.js','utf8');
const code=src.slice(src.indexOf('  function researchEpisodeSpec('),src.indexOf('  function loadResearchEpisode('));
const context={};vm.createContext(context);vm.runInContext(code,context);
const record=n=>({status:'succeeded',sources:[{id:'S1'}],output:{draft:{title:'Battery research',points:Array.from({length:n},()=>({text:'A battery stores energy.',sources:['S1']}))}}});
for(const n of [1,2,3]){const r=record(n),s=context.researchEpisodeSpec(r);assert(s.scenes.length>=5&&s.scenes.length<=8);const duration=s.scenes.reduce((t,x)=>t+x.duration,0);assert(duration>=60&&duration<=90);assert.equal(s.scenes[2].narration,r.output.draft.points[0].text);assert(s.scenes.slice(0,2).reduce((t,x)=>t+x.duration,0)<=30);assert(JSON.stringify(s).length<4000);}
let r=record(3);r.output.draft.points[0].text='x'.repeat(181);assert.throws(()=>context.researchEpisodeSpec(r),/180 characters/);
r=record(3);r.output.draft.points[0].sources=['S9'];assert.throws(()=>context.researchEpisodeSpec(r),/unknown source/);
r=record(3);r.status='queued';assert.throws(()=>context.researchEpisodeSpec(r),/Complete/);
console.log('Episode duration, faithful narration, queue bounds, long text and source-reference validation passed');
