import {getStore} from '@netlify/blobs';
import crypto from 'node:crypto';
const phones=new Set(['phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254']);
const units=new Set([...phones,'Alina','Nexus','SteamDeck','viki','RenderRig']);
const modes=new Set(['home','clock','visuals','test','dashboard','activity']);
const taskNames={'network-check':'Checking website connectivity','storage-status':'Checking storage','process-snapshot':'Checking processes','browser-audit':'Testing a website in the browser','website-audit':'Auditing a website','research':'Researching','shell':'Custom task','mining-status':'Checking mining status','mining-stop':'Stopping mining','mining-start':'Starting mining','gpu-status':'Checking GPU','blender-render':'Rendering','ffmpeg-transcode':'Converting media','whisper-transcribe':'Transcribing audio','reel-create':'Creating a video','episode-create':'Creating an episode'};
const taskName=type=>taskNames[type]||'Cluster task';
async function activity(unit){
 const queue=store('swarm-queue');
 const node=await queue.get('node--'+unit,{type:'json',consistency:'strong'});
 if(!node)return {unit,state:'unknown',tasks:[],lastSeen:null,lastResult:null,checkedAt:Date.now()};
 const listing=await queue.list({prefix:'assignment--'});
 const own=(listing.blobs||[]).filter(b=>b.key.endsWith('--'+unit));
 const assignments=await Promise.all(own.map(b=>queue.get(b.key,{type:'json',consistency:'strong'})));
 const tasks=assignments.filter(a=>a?.device_id===unit).map(a=>({label:taskName(a.job?.type)}));
 const seen=Number(node.last_seen)||null,online=seen!==null&&Date.now()-seen<90000;
 let lastResult=null;
 if(node.last_completed_at&&node.last_job){
  const result=await queue.get('result--'+String(node.last_completed_at).padStart(13,'0')+'--'+String(node.last_job).replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,96)+'--'+unit,{type:'json',consistency:'strong'});
  if(result&&result.device_id===unit)lastResult={label:taskName(result.type),success:result.exit_code===0,completedAt:Number(result.completed_at)||null};
 }
 return {unit,state:!online?'offline':tasks.length?'assigned':'idle',tasks,lastSeen:seen,lastResult,checkedAt:Date.now()};
}
function store(name){const siteID=process.env.NETLIFY_BLOBS_SITE_ID||process.env.SITE_ID;const token=process.env.NETLIFY_BLOBS_TOKEN||process.env.NETLIFY_ACCESS_TOKEN||process.env.NETLIFY_TOKEN;return siteID&&token?getStore({name,siteID,token}):getStore(name);}
async function handle(event){
 const response=(statusCode,data)=>({statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(data)});
 try{

  if(event.httpMethod==='GET'){
   const phone=event.queryStringParameters?.phone;if(!units.has(phone))return response(400,{error:'Invalid unit'});
   const desired=await store('phone-display').get(phone,{type:'json'});
   const view=event.queryStringParameters?.activity==='1'?await activity(phone):undefined;
   return response(200,{mode:desired?.mode||null,revision:desired?.revision||null,...(view?{activity:view}:{})});
  }
  if(event.httpMethod!=='POST')return response(405,{error:'Method not allowed'});
  const auth=event.headers?.authorization||event.headers?.Authorization||'';
  const password=process.env.CLUSTER_WEB_PASSWORD||await store('cluster-config').get('web-password',{type:'text'});
  const supplied=auth.startsWith('Bearer ')?auth.slice(7):'';
  const a=Buffer.from(supplied),b=Buffer.from(password||'');
  if(!password||a.length!==b.length||!crypto.timingSafeEqual(a,b))return response(401,{error:'Sign in required'});
  let body;try{body=JSON.parse(event.body||'{}');}catch{return response(400,{error:'Invalid JSON'});}
  if(!phones.has(body.phone)||!modes.has(body.mode))return response(400,{error:'Invalid display selection'});
  const value={mode:body.mode,revision:crypto.randomUUID()};await store('phone-display').setJSON(body.phone,value);
  return response(200,{ok:true,...value});
 }catch{return response(503,{error:'Display service unavailable'});}
};
export default async request=>{
 const event={httpMethod:request.method,headers:Object.fromEntries(request.headers),queryStringParameters:Object.fromEntries(new URL(request.url).searchParams),body:request.method==='POST'?await request.text():''};
 const r=await handle(event);return new Response(r.body,{status:r.statusCode,headers:r.headers});
};
