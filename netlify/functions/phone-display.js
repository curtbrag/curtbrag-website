const {connectLambda,getStore}=require('@netlify/blobs');
const crypto=require('crypto');
const phones=new Set(['phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254']);
const modes=new Set(['home','clock','visuals','test','dashboard']);
function store(name){const siteID=process.env.NETLIFY_BLOBS_SITE_ID||process.env.SITE_ID;const token=process.env.NETLIFY_BLOBS_TOKEN||process.env.NETLIFY_ACCESS_TOKEN||process.env.NETLIFY_TOKEN;return siteID&&token?getStore(name,{siteID,token}):getStore(name);}
exports.handler=async event=>{
 const response=(statusCode,data)=>({statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(data)});
 try{
  connectLambda(event);
  if(event.httpMethod==='GET'){
   const phone=event.queryStringParameters?.phone;if(!phones.has(phone))return response(400,{error:'Invalid phone'});
   const desired=await store('phone-display').get(phone,{type:'json'});
   return response(200,desired?{mode:desired.mode,revision:desired.revision}:{mode:null,revision:null});
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

