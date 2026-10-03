const fs=require('fs'),vm=require('vm'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const bytes=Buffer.from('0000ftyp-video');const manifest={parts:1,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
const store={get:async key=>key.endsWith('manifest')?manifest:bytes};
const context={getStore:()=>store,crypto,Buffer,Response,Request,URL,ReadableStream,Date,process:{env:{CLUSTER_WEB_PASSWORD:'test-password'}}};vm.createContext(context);
vm.runInContext(fs.readFileSync('netlify/functions/episode-media.mjs','utf8').replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler'),context);
(async()=>{
 const base='https://example.test/api/episode-media?id=web-v8-1790987712221-jdikyw&variant=master';
 assert.equal((await context.handler(new Request(base+'&download-ticket=1',{method:'POST'}))).status,401);
 const r=await context.handler(new Request(base+'&download-ticket=1',{method:'POST',headers:{authorization:'Bearer test-password'}}));assert.equal(r.status,200);const {path}=await r.json();
 const download=await context.handler(new Request('https://example.test'+path));assert.equal(download.status,200);assert(download.headers.get('content-disposition').includes('attachment'));assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
 assert.equal((await context.handler(new Request('https://example.test'+path.replace('variant=master','variant=short')))).status,401);
 assert.equal((await context.handler(new Request('https://example.test'+path,{method:'POST'}))).status,401);
 const old=Date.now;Date.now=()=>old()+121000;assert.equal((await context.handler(new Request('https://example.test'+path))).status,401);Date.now=old;
 manifest.sha256='0'.repeat(64);assert.equal((await context.handler(new Request('https://example.test'+path))).status,422);
 console.log('Authenticated ticket issuance, scoped download, expiry, upload isolation and integrity checks passed');
})().catch(e=>{console.error(e);process.exitCode=1});
