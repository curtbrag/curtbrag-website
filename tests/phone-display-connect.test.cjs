const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const code=fs.readFileSync(path.join(__dirname,'../netlify/functions/phone-display.js'),'utf8').replace(/^import .*;\r?$/gm,'').replace('export default async request=>','return async request=>');
function setup(){
 const writes=[],tickets=[];
 const getStore=()=>({get:async()=> 'fixture-password',setJSON:async(k,v)=>writes.push([k,v])});
 const issueDisplayTicket=async options=>{tickets.push(options);return 'a'.repeat(64);};
 const handler=new Function('getStore','crypto','issueDisplayTicket',code)(getStore,crypto,issueDisplayTicket);
 return {writes,tickets,handler};
}
const request=(body,password='fixture-password')=>new Request('https://curtbrag.com/.netlify/functions/phone-display',{method:'POST',headers:{authorization:'Bearer '+password,'content-type':'application/json'},body:JSON.stringify(body)});
test('normal mode changes never create browser access without an explicit connection selection',async()=>{
 for(const extra of [{},{connect:false}]){const s=setup(),r=await s.handler(request({phone:'phone253',mode:'activity',...extra}));assert.equal(r.status,200);assert.equal((await r.json()).display_url,undefined);assert.equal(s.tickets.length,0);assert.equal(s.writes.length,1);}
});
test('an authenticated explicit connection receives a ticket for only its selected phone and host',async()=>{
 const s=setup(),r=await s.handler(request({phone:'phone253',mode:'clock',connect:true}));assert.equal(r.status,200);
 const data=await r.json(),url=new URL(data.display_url);assert.equal(url.origin,'https://curtbrag.com');assert.equal(url.pathname,'/cluster/display.html');assert.equal(url.searchParams.get('name'),'phone253');assert.equal(url.searchParams.get('mode'),'clock');assert.match(url.searchParams.get('display_ticket'),/^[a-f0-9]{64}$/);
 assert.equal(s.tickets.length,1);assert.equal(s.tickets[0].phone,'phone253');assert.equal(s.tickets[0].host,'curtbrag.com');
});
test('wrong authentication and invalid selections cannot create display tickets',async()=>{
 for(const [body,password,status] of [[{phone:'phone253',mode:'clock',connect:true},'wrong',401],[{phone:'phone253',mode:'clock',connect:'true'},'fixture-password',400],[{phone:'RenderRig',mode:'clock',connect:true},'fixture-password',400]]){
  const s=setup(),r=await s.handler(request(body,password));assert.equal(r.status,status);assert.equal(s.tickets.length,0);assert.equal(s.writes.length,0);
 }
});
