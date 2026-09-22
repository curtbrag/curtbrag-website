// Universal distributed job queue for the Curt Cluster.
// Operator endpoints use CLUSTER_WEB_PASSWORD; agents use CLUSTER_API_KEY.
const { connectLambda, getStore } = require("@netlify/blobs");
const crypto = require("crypto");

const NODES = ["phone173","phone174","phone176","phone177","phone191","phone195","phone253","phone254","Alina","Nexus","SteamDeck"];
const TEMPLATES = {
  "health-audit": { label:"Health audit", fields:[], description:"CPU, memory, disk, temperature and uptime" },
  "inventory": { label:"File inventory", fields:["source"], description:"Count and summarize files beneath a path" },
  "checksum": { label:"SHA-256 checksums", fields:["source"], description:"Hash a file or directory tree" },
  "archive": { label:"Create archive", fields:["source","destination"], description:"Create a compressed tar archive" },
  "backup": { label:"Incremental backup", fields:["source","destination"], description:"Copy a directory with rsync" },
  "download": { label:"Media download", fields:["source","destination"], description:"Download a URL with yt-dlp" },
  "media-probe": { label:"Inspect media", fields:["source"], description:"Read media metadata with ffprobe" },
  "media-convert": { label:"Convert media", fields:["source","destination"], description:"Convert media with ffmpeg" },
  "transcribe": { label:"Transcribe audio/video", fields:["source","destination"], description:"Create a searchable transcript with Whisper" }
};
const MAX_JOBS = 100;
const LEASE_MS = 5 * 60 * 1000;

function store(name) {
  const siteID = process.env.NETLIFY_BLOBS_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_ACCESS_TOKEN || process.env.NETLIFY_TOKEN;
  return siteID && token ? getStore(name, { siteID, token }) : getStore(name);
}
function headers(origin="") {
  const allowed = ["https://curtbrag.com","https://www.curtbrag.com"];
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : "https://curtbrag.com",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Content-Type": "application/json"
  };
}
function response(statusCode, h, body) { return { statusCode, headers:h, body:JSON.stringify(body) }; }
function tokenOf(event) {
  const value = event.headers.authorization || event.headers.Authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7) : value;
}
function same(a,b) {
  if (!a || !b) return false;
  const aa=Buffer.from(String(a)), bb=Buffer.from(String(b));
  return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);
}
function cleanText(v,max=2048) { return String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,"").slice(0,max); }
function cleanNode(v) {
  const q=String(v||"").toLowerCase();
  return NODES.find(n=>n.toLowerCase()===q) || null;
}
async function ids() {
  try { return (await store("cluster-jobs").get("index",{type:"json"})) || []; } catch { return []; }
}
async function saveIndex(list) { await store("cluster-jobs").setJSON("index", list.slice(0,MAX_JOBS)); }
async function getJob(id) { return await store("cluster-jobs").get("job-"+id,{type:"json"}); }
async function putJob(job) { job.updatedAt=new Date().toISOString(); await store("cluster-jobs").setJSON("job-"+job.id,job); }
function summarize(job) {
  const tasks=Object.values(job.tasks||{});
  const counts={queued:0,running:0,completed:0,failed:0,cancelled:0};
  tasks.forEach(t=>{ if (counts[t.status] !== undefined) counts[t.status]++; });
  let status="queued";
  if (tasks.length && counts.completed===tasks.length) status="completed";
  else if (tasks.length && counts.cancelled===tasks.length) status="cancelled";
  else if (counts.running) status="running";
  else if (counts.queued) status="queued";
  else if (counts.failed) status="failed";
  return {...job,status,counts};
}
function publicJob(job) {
  const x=summarize(job);
  return {...x, tasks:Object.fromEntries(Object.entries(x.tasks||{}).map(([n,t])=>[n,{...t,output:cleanText(t.output,12000),error:cleanText(t.error,3000)}]))};
}
function parseBody(event) { try { return JSON.parse(event.body||"{}"); } catch { return {}; } }

exports.handler = async (event) => {
  connectLambda(event);
  const h=headers(event.headers.origin||"");
  if (event.httpMethod==="OPTIONS") return {statusCode:204,headers:h,body:""};
  const action=(event.queryStringParameters||{}).action||"list";
  const agentActions=new Set(["claim","progress","complete","fail"]);
  const expected=agentActions.has(action) ? process.env.CLUSTER_API_KEY : process.env.CLUSTER_WEB_PASSWORD;
  if (!expected) return response(503,h,{ok:false,error:"Job service credentials are not configured"});
  if (!same(tokenOf(event),expected)) return response(401,h,{ok:false,error:"Unauthorized"});

  const db=store("cluster-jobs");
  if (action==="templates") return response(200,h,{ok:true,templates:TEMPLATES,nodes:NODES});

  if (action==="list" || action==="stats") {
    const list=await ids();
    const jobs=(await Promise.all(list.slice(0,50).map(getJob))).filter(Boolean).map(publicJob);
    if (action==="stats") {
      const counts={queued:0,running:0,completed:0,failed:0,cancelled:0};
      jobs.forEach(j=>counts[j.status]=(counts[j.status]||0)+1);
      return response(200,h,{ok:true,counts,total:jobs.length});
    }
    return response(200,h,{ok:true,jobs});
  }

  const body=parseBody(event);
  if (action==="create") {
    const type=String(body.type||"");
    if (!TEMPLATES[type]) return response(400,h,{ok:false,error:"Unknown workload type"});
    const targets=[...new Set((Array.isArray(body.targets)?body.targets:[]).map(cleanNode).filter(Boolean))];
    if (!targets.length) return response(400,h,{ok:false,error:"Choose at least one valid target"});
    const input={
      source:cleanText(body.input?.source,1500),
      destination:cleanText(body.input?.destination,1500),
      options:body.input?.options && typeof body.input.options==="object" ? body.input.options : {}
    };
    for (const field of TEMPLATES[type].fields) if (!input[field]) return response(400,h,{ok:false,error:"Missing "+field});
    const id="job-"+Date.now().toString(36)+"-"+crypto.randomBytes(3).toString("hex");
    const now=new Date().toISOString();
    const tasks=Object.fromEntries(targets.map(node=>[node,{node,status:"queued",attempts:0,progress:0,createdAt:now}]));
    const job={id,name:cleanText(body.name||TEMPLATES[type].label,120),type,input,targets,tasks,createdAt:now,updatedAt:now};
    await putJob(job);
    const list=(await ids()).filter(x=>x!==id);
    list.unshift(id); await saveIndex(list);
    return response(201,h,{ok:true,job:publicJob(job)});
  }

  if (action==="claim") {
    const node=cleanNode(body.node);
    if (!node) return response(400,h,{ok:false,error:"Unknown node"});
    const now=Date.now();
    for (const id of await ids()) {
      const job=await getJob(id); if (!job || !job.tasks?.[node]) continue;
      const task=job.tasks[node];
      const expired=task.status==="running" && task.leaseUntil && Date.parse(task.leaseUntil)<now;
      if (task.status!=="queued" && !expired) continue;
      task.status="running"; task.attempts=(task.attempts||0)+1; task.startedAt=task.startedAt||new Date().toISOString();
      task.claimedAt=new Date().toISOString(); task.leaseUntil=new Date(now+LEASE_MS).toISOString(); task.progress=task.progress||0;
      await putJob(job);
      return response(200,h,{ok:true,job:{id:job.id,type:job.type,name:job.name,input:job.input},task});
    }
    return response(200,h,{ok:true,job:null});
  }

  const id=cleanText(body.jobId,120);
  const job=id ? await getJob(id) : null;
  if (!job) return response(404,h,{ok:false,error:"Job not found"});

  if (action==="cancel" || action==="retry") {
    for (const t of Object.values(job.tasks || {})) {
      if (action==="cancel" && (t.status==="queued" || t.status==="running")) {
        t.status="cancelled"; t.completedAt=new Date().toISOString(); delete t.leaseUntil;
      }
      if (action==="retry" && (t.status==="failed" || t.status==="cancelled")) {
        t.status="queued"; t.progress=0; delete t.error; delete t.output; delete t.completedAt; delete t.leaseUntil;
      }
    }
    await putJob(job);
    return response(200,h,{ok:true,job:publicJob(job)});
  }

  const node=cleanNode(body.node);
  if (!node || !job.tasks?.[node]) return response(404,h,{ok:false,error:"Job task not found"});
  const task=job.tasks[node];

  if (action==="progress") {
    task.status="running"; task.progress=Math.max(0,Math.min(99,Number(body.progress)||0));
    task.message=cleanText(body.message,500); task.leaseUntil=new Date(Date.now()+LEASE_MS).toISOString();
  } else if (action==="complete") {
    task.status="completed"; task.progress=100; task.output=cleanText(body.output,12000); task.completedAt=new Date().toISOString(); delete task.leaseUntil;
  } else if (action==="fail") {
    task.status="failed"; task.error=cleanText(body.error||"Workload failed",3000); task.completedAt=new Date().toISOString(); delete task.leaseUntil;
  } else return response(400,h,{ok:false,error:"Unknown action"});

  await putJob(job);
  return response(200,h,{ok:true,job:publicJob(job)});
};
