import crypto from 'node:crypto';

export const UNITS = ['phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254','Alina','Nexus','SteamDeck','viki','RenderRig','s26ultra'];
const ID = /^[a-zA-Z0-9-]{8,80}$/;
export function validateJob(value) {
  if (!value || !ID.test(value.id || '') || !UNITS.includes(value.unit) || !['check','test'].includes(value.action)) throw Error('Invalid email request');
  if(Object.keys(value).some(key=>!['id','unit','action'].includes(key))) throw Error('Only mailbox health and test-to-self are supported');
  return {id:value.id,unit:value.unit,action:value.action};
}
export function createHandler({store, password, now=()=>Date.now()}) {
  const json = (status,body) => new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
  const get = async (key, fallback=null) => (await store.get(key,{type:'json'})) ?? fallback;
  return async request => {
    const expected=await password(), supplied=(request.headers.get('authorization')||'').replace(/^Bearer /,'');
    const a=Buffer.from(expected||''), b=Buffer.from(supplied);
    if(!a.length || a.length!==b.length || !crypto.timingSafeEqual(a,b)) return json(401,{error:'Sign in to the dashboard'});
    try {
      const action=new URL(request.url).searchParams.get('action')||'status';
      if(request.method==='GET' && action==='status') {
        const bridge=await get('bridge',{}), listed=await store.list({prefix:'job-'});
        const jobs=await Promise.all(listed.blobs.map(x=>get(x.key)));
        return json(200,{ok:true,bridge,units:UNITS.map(unit=>({unit,address:unit.toLowerCase()+'@curtbrag.com',...(bridge.devices?.[unit]||{installed:false})})),jobs:jobs.filter(Boolean).sort((a,b)=>b.created_at-a.created_at).slice(0,100)});
      }
      if(request.method!=='POST') return json(405,{error:'Method not allowed'});
      const raw=await request.text();
      if(raw.length>9000) return json(413,{error:'Request too large'});
      const body=JSON.parse(raw);
      if(action==='enqueue') {
        const job=validateJob(body), key='job-'+job.id, existing=await get(key);
        if(existing) {
          if(existing.unit!==job.unit || existing.action!==job.action) return json(409,{error:'Request ID already used for a different operation'});
          return json(200,{ok:true,job_id:existing.id,status:existing.status});
        }
        const bridge=await get('bridge',{});
        if(now()-(bridge.at||0)>120000) return json(409,{error:'Main PC email connection is offline. Nothing was queued.'});
        if(!bridge.devices?.[job.unit]?.installed || !bridge.devices[job.unit].connected) return json(409,{error:'This device needs its email connection restored first'});
        const saved=await store.set(key,JSON.stringify({...job,status:'queued',created_at:now()}),{onlyIfNew:true});
        if(!saved || typeof saved.modified!=='boolean') throw Error('Email request was not confirmed');
        return json(200,{ok:true,job_id:job.id,status:'queued'});
      }
      if(action==='heartbeat') {
        const devices={};
        for(const unit of UNITS) if(body.devices?.[unit]) devices[unit]={installed:body.devices[unit].installed===true,connected:body.devices[unit].connected===true};
        await store.setJSON('bridge',{at:now(),devices});
        return json(200,{ok:true});
      }
      if(action==='poll') {
        const listed=await store.list({prefix:'job-'}), jobs=await Promise.all(listed.blobs.map(x=>get(x.key)));
        const job=jobs.filter(x=>x?.status==='queued').sort((a,b)=>a.created_at-b.created_at)[0];
        if(!job) return json(200,{ok:true,job:null});
        if(now()-job.created_at>1800000) {await store.setJSON('job-'+job.id,{...job,status:'expired'});return json(200,{ok:true,job:null});}
        const fresh=await store.getWithMetadata('job-'+job.id,{type:'json'});
        if(!fresh || fresh.data?.status!=='queued' || !fresh.etag) return json(200,{ok:true,job:null});
        const saved=await store.set('job-'+job.id,JSON.stringify({...job,status:'running',started_at:now()}),{onlyIfMatch:fresh.etag});
        if(saved?.modified!==true) return json(200,{ok:true,job:null});
        return json(200,{ok:true,job});
      }
      if(action==='complete') {
        if(!ID.test(body.id||'')) throw Error('Invalid job ID');
        const job=await get('job-'+body.id);
        if(!job || !['running','complete','failed'].includes(job.status)) return json(409,{error:'Job is not running'});
        if(job.status!=='running') return json(200,{ok:true});
        const result=body.result;
        if(!result || typeof result!=='object') throw Error('Invalid result');
        const clean={};
        for(const field of ['ok','imap_verified','smtp_verified','accepted','delivery_verified']) if(typeof result[field]==='boolean') clean[field]=result[field];
        for(const field of ['address','checked_at','error']) if(typeof result[field]==='string') clean[field]=result[field].slice(0,200);
        await store.setJSON('job-'+job.id,{...job,status:result.ok?'complete':'failed',finished_at:now(),result:clean});
        return json(200,{ok:true});
      }
      return json(400,{error:'Unknown action'});
    } catch(error) {return json(400,{error:error instanceof SyntaxError?'Invalid request':error.message});}
  };
}
