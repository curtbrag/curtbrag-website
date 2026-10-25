import crypto from 'node:crypto';

export const UNITS = ['phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254','Alina','Nexus','SteamDeck','viki','RenderRig','s26ultra'];
export const RUNNING_LEASE_MS = 300000;
const QUEUE_LIFETIME_MS = 1800000;
const ID = /^[a-zA-Z0-9-]{8,80}$/;
const active = job => ['queued','running'].includes(job?.status);
export function validateJob(value) {
  if (!value || !ID.test(value.id || '') || !UNITS.includes(value.unit) || !['check','test'].includes(value.action)) throw Error('Invalid email request');
  if(Object.keys(value).some(key=>!['id','unit','action'].includes(key))) throw Error('Only mailbox health and test-to-self are supported');
  return {id:value.id,unit:value.unit,action:value.action};
}
export function createHandler({store, password, now=()=>Date.now()}) {
  const json = (status,body) => new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
  const get = async (key, fallback=null) => (await store.get(key,{type:'json'})) ?? fallback;
  const compareSet = async (key, value, etag) => {
    const saved=await store.set(key,JSON.stringify(value),etag?{onlyIfMatch:etag}:{onlyIfNew:true});
    if(!saved || typeof saved.modified!=='boolean') throw Error('Email state could not be confirmed');
    return saved.modified;
  };
  async function readJob(key) {
    for(let attempt=0;attempt<4;attempt++) {
      const fresh=await store.getWithMetadata(key,{type:'json'});
      if(!fresh?.data) return null;
      const job=fresh.data, stamp=job.status==='running'?job.started_at:job.created_at;
      const expired=active(job) && (!Number.isFinite(stamp) || stamp>now()+5000 || now()-stamp>(job.status==='running'?RUNNING_LEASE_MS:QUEUE_LIFETIME_MS));
      if(!expired) return job;
      if(!fresh.etag) throw Error('Email state could not be confirmed');
      const settled=job.status==='running'
        ? {...job,status:'interrupted',interrupted_at:now(),interruption_reason:'lease-expired'}
        : {...job,status:'expired',finished_at:now()};
      // A concurrent completion must win over an old expiry observation.
      if(await compareSet(key,settled,fresh.etag)) return settled;
    }
    throw Error('Email state changed; refresh and try again');
  }
  async function listJobs() {
    const listed=await store.list({prefix:'job-'});
    return (await Promise.all(listed.blobs.map(x=>readJob(x.key)))).filter(Boolean);
  }
  async function reserveUnit(job) {
    const key='unit-'+job.unit;
    for(let attempt=0;attempt<4;attempt++) {
      const reservation=await store.getWithMetadata(key,{type:'json'});
      if(reservation?.data && reservation.data.id!==job.id) {
        const previous=await readJob('job-'+reservation.data.id);
        if(active(previous) || (!previous && now()-reservation.data.at<30000)) return false;
      }
      if(await compareSet(key,{id:job.id,at:now()},reservation?.etag)) return true;
    }
    return false;
  }
  return async request => {
    const expected=await password(), supplied=(request.headers.get('authorization')||'').replace(/^Bearer /,'');
    const a=Buffer.from(expected||''), b=Buffer.from(supplied);
    if(!a.length || a.length!==b.length || !crypto.timingSafeEqual(a,b)) return json(401,{error:'Sign in to the dashboard'});
    try {
      const action=new URL(request.url).searchParams.get('action')||'status';
      if(request.method==='GET' && action==='status') {
        const bridge=await get('bridge',{}), jobs=(await listJobs()).sort((a,b)=>b.created_at-a.created_at);
        const visible=[...jobs.slice(0,100)];
        for(const job of jobs) if(active(job) && !visible.some(x=>x.id===job.id)) visible.push(job);
        return json(200,{ok:true,bridge,units:UNITS.map(unit=>({unit,address:unit.toLowerCase()+'@curtbrag.com',...(bridge.devices?.[unit]||{installed:false})})),jobs:visible});
      }
      if(request.method!=='POST') return json(405,{error:'Method not allowed'});
      const raw=await request.text();
      if(raw.length>9000) return json(413,{error:'Request too large'});
      const body=JSON.parse(raw);
      if(action==='enqueue') {
        const job=validateJob(body), key='job-'+job.id, existing=await readJob(key);
        if(existing) {
          if(existing.unit!==job.unit || existing.action!==job.action) return json(409,{error:'Request ID already used for a different operation'});
          return json(200,{ok:true,job_id:existing.id,status:existing.status});
        }
        const bridge=await get('bridge',{}), age=now()-(bridge.at||0);
        if(age<0 || age>120000) return json(409,{error:'Main PC email connection is offline. Nothing was queued.'});
        if(!bridge.devices?.[job.unit]?.installed || !bridge.devices[job.unit].connected) return json(409,{error:'This device needs its email connection restored first'});
        // Also respect requests accepted before unit reservations were introduced.
        if((await listJobs()).some(previous=>previous.id!==job.id && previous.unit===job.unit && active(previous)) || !await reserveUnit(job)) return json(409,{error:'This mailbox already has a request in progress. Refresh its status.'});
        if(!await compareSet(key,{...job,status:'queued',created_at:now()})) {
          const replay=await readJob(key);
          if(!replay || replay.unit!==job.unit || replay.action!==job.action) return json(409,{error:'Request ID already used for a different operation'});
          return json(200,{ok:true,job_id:job.id,status:replay.status});
        }
        return json(200,{ok:true,job_id:job.id,status:'queued'});
      }
      if(action==='heartbeat') {
        const devices={};
        for(const unit of UNITS) if(body.devices?.[unit]) devices[unit]={installed:body.devices[unit].installed===true,connected:body.devices[unit].connected===true};
        await store.setJSON('bridge',{at:now(),devices});
        return json(200,{ok:true});
      }
      if(action==='poll') {
        const job=(await listJobs()).filter(x=>x.status==='queued').sort((a,b)=>a.created_at-b.created_at)[0];
        if(!job) return json(200,{ok:true,job:null});
        const fresh=await store.getWithMetadata('job-'+job.id,{type:'json'});
        if(!fresh || fresh.data?.status!=='queued' || !fresh.etag) return json(200,{ok:true,job:null});
        if(!await compareSet('job-'+job.id,{...fresh.data,status:'running',started_at:now()},fresh.etag)) return json(200,{ok:true,job:null});
        return json(200,{ok:true,job});
      }
      if(action==='complete') {
        if(!ID.test(body.id||'')) throw Error('Invalid job ID');
        const result=body.result;
        if(!result || typeof result!=='object' || Array.isArray(result)) throw Error('Invalid result');
        const clean={};
        for(const field of ['ok','imap_verified','smtp_verified','accepted','delivery_verified','delivery_unconfirmed','interrupted']) if(typeof result[field]==='boolean') clean[field]=result[field];
        for(const field of ['address','checked_at','error','delivery_error']) if(typeof result[field]==='string') clean[field]=result[field].replace(/[\u0000-\u001f\u007f]/g,'').slice(0,200);
        if(clean.accepted===true) clean.delivery_unconfirmed=clean.delivery_verified!==true;
        const key='job-'+body.id;
        for(let attempt=0;attempt<4;attempt++) {
          const fresh=await store.getWithMetadata(key,{type:'json'}), job=fresh?.data;
          if(!job || !['running','interrupted','complete','failed'].includes(job.status)) return json(409,{error:'Job is not running'});
          if(!fresh.etag) throw Error('Email state could not be confirmed');
          const final=job.status!=='running' && !(job.status==='interrupted' && job.interruption_reason==='lease-expired' && !job.result);
          let updated;
          if(final) {
            // A later exact-test receipt may add evidence, never alter or repeat the original send.
            if(job.action==='test' && job.result?.accepted===true && job.result.delivery_verified!==true && clean.delivery_verified===true)
              updated={...job,result:{...job.result,delivery_verified:true,delivery_unconfirmed:false},delivery_checked_at:now()};
            else return json(200,{ok:true});
          } else {
            const accepted=job.action==='test' && clean.accepted===true;
            updated={...job,status:accepted?'complete':clean.interrupted===true?'interrupted':clean.ok?'complete':'failed',finished_at:now(),result:clean};
            if(clean.interrupted===true && !accepted) updated.interruption_reason='relay-restarted';
          }
          if(await compareSet(key,updated,fresh.etag)) return json(200,{ok:true});
        }
        return json(409,{error:'Email result changed; refresh before retrying'});
      }
      return json(400,{error:'Unknown action'});
    } catch(error) {return json(400,{error:error instanceof SyntaxError?'Invalid request':error.message});}
  };
}
