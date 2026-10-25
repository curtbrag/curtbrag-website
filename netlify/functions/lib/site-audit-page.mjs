import crypto from 'node:crypto';

export const ORIGIN = 'https://curtbrag.com';
export const PUBLIC_PATHS = new Set(['/', '/gallery/', '/gallery/cars/', '/gallery/snapon/', '/shop/', '/rig/', '/cluster/', '/contact/', '/addyourride/', '/yougood/', '/zelle/', '/privacy/', '/terms/', '/thanks/']);
const MAX_BYTES = 1048576;
const MAX_ASSET_BYTES = 4194304;
const ASSET_TYPES = {'.css':'text/css','.js':'application/javascript','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf'};
const COOKIE = '__Host-curtbrag_access';
const HEADERS = {'content-type':'application/json; charset=utf-8', 'cache-control':'private, no-store, max-age=0', 'netlify-cdn-cache-control':'no-store', 'x-content-type-options':'nosniff'};
const json = (status, value) => new Response(JSON.stringify(value), {status, headers:HEADERS});
export function createDeploymentHandler({context, ...dependencies}) {
  if(context!=='production') return async()=>json(503,{ok:false,error:'Protected site reads are available on the production site only'});
  return createHandler(dependencies);
}
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const left=Buffer.from(a), right=Buffer.from(b);
  return left.length===right.length && crypto.timingSafeEqual(left,right);
}
export function allowedResource(path) {
  if(PUBLIC_PATHS.has(path)) return 'page';
  if(typeof path!=='string' || path.length>256 || !/^\/[A-Za-z0-9_./ -]+$/.test(path) || path.includes('//') || path.split('/').some(part=>part==='.' || part==='..')) return null;
  const extension=path.slice(path.lastIndexOf('.')).toLowerCase();
  if(!Object.hasOwn(ASSET_TYPES,extension)) return null;
  if(path.startsWith('/_astro/') && ['.css','.js'].includes(extension)) return 'asset';
  if(path.startsWith('/scripts/') && extension==='.js') return 'asset';
  if(path.startsWith('/styles/') && extension==='.css') return 'asset';
  if(['/assets/','/gallery/cars/','/gallery/snapon/'].some(prefix=>path.startsWith(prefix)) && !['.css','.js'].includes(extension)) return 'asset';
  return null;
}
async function boundedBody(response, limit) {
  const reader=response.body?.getReader();
  if (!reader) return '';
  const chunks=[]; let bytes=0;
  try {
    while (true) {
      const {done,value}=await reader.read(); if(done) break;
      bytes+=value.byteLength;
      if(bytes>limit) {await reader.cancel();throw Error('Page exceeded the audit size limit');}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  return Buffer.concat(chunks);
}

export function createHandler({credentials, createSession, fetchImpl=fetch, now=()=>Date.now()}) {
  // The server creates an ordinary one-hour site-access session after validating
  // existing cluster auth. The token stays in this process; only its hash is in
  // the existing session store. The unchanged edge checks the ordinary contract.
  let session=null, signIn=null;
  async function cookieFor(password) {
    const revision=crypto.createHash('sha256').update(password).digest('hex');
    if(session?.revision===revision && session.expires>now()) return session.cookie;
    if(!signIn) signIn=(async()=>{
      const token=crypto.randomBytes(32).toString('hex'), expires=now()+3600000;
      const key=crypto.createHash('sha256').update(token).digest('hex');
      await createSession(key,{version:1,host:new URL(ORIGIN).hostname,expires,passwordRevision:revision});
      session={revision,cookie:COOKIE+'='+token,expires};
      return session.cookie;
    })().finally(()=>{signIn=null;});
    await signIn;
    // A concurrent request using rotated credentials must obtain its own session.
    return session?.revision===revision ? session.cookie : cookieFor(password);
  }
  return async request => {
    try {
      if(request.method!=='GET') return json(405,{ok:false,error:'Only read-only page requests are supported'});
      const input=new URL(request.url), values=[...input.searchParams];
      if(values.length!==1 || values[0][0]!=='path' || !allowedResource(values[0][1])) return json(400,{ok:false,error:'Choose an allowed CurtBrag page or static asset path'});
      const supplied=(request.headers.get('authorization')||'').match(/^Bearer ([^\r\n]{1,512})$/)?.[1]||'';
      if(!supplied) return json(401,{ok:false,error:'An existing cluster login is required'});
      const {workerKey,webPassword}=await credentials();
      if(!sameSecret(supplied,workerKey) && !sameSecret(supplied,webPassword)) return json(401,{ok:false,error:'An existing cluster login is required'});
      if(typeof webPassword!=='string' || !webPassword) return json(503,{ok:false,error:'Site authentication unavailable'});
      const path=values[0][1], kind=allowedResource(path), url=ORIGIN+path, fetchURL=new URL(url).href, started=now();
      let response;
      for(let attempt=0;attempt<2;attempt++) {
        const cookie=await cookieFor(webPassword);
        response=await fetchImpl(fetchURL,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{cookie,accept:kind==='page'?'text/html':'*/*','user-agent':'CurtClusterAudit/2.0'}});
        if(response.status!==401 || attempt===1) break;
        await response.body?.cancel(); session=null;
      }
      if(response.status>=300 && response.status<400 || response.url && response.url!==fetchURL) {await response.body?.cancel();return json(502,{ok:false,error:'Page redirects are excluded from audit reads'});}
      if(response.status!==200) {await response.body?.cancel();return json(502,{ok:false,error:'Site page did not return HTTP 200',page_status:response.status});}
      const type=(response.headers.get('content-type')||'').toLowerCase();
      if(response.headers.get('x-curtbrag-access')==='password-required') {await response.body?.cancel();return json(502,{ok:false,error:'Site resource could not be authenticated'});}
      if(kind==='asset') {
        const expected=ASSET_TYPES[path.slice(path.lastIndexOf('.')).toLowerCase()];
        const valid=type.split(';')[0].trim()===expected || expected==='application/javascript' && type.startsWith('text/javascript') || expected.startsWith('font/') && /^(font\/|application\/(font|x-font|octet-stream))/.test(type) || expected==='image/x-icon' && type.startsWith('image/vnd.microsoft.icon');
        if(!valid) {await response.body?.cancel();return json(502,{ok:false,error:'Static asset returned an unexpected content type'});}
        const bytes=await boundedBody(response,MAX_ASSET_BYTES);
        return json(200,{ok:true,kind:'site-audit-asset',path,url,status:200,content_type:expected,encoding:'base64',data:bytes.toString('base64'),bytes:bytes.length,ms:Math.max(0,now()-started)});
      }
      if(!type.includes('text/html')) {await response.body?.cancel();return json(502,{ok:false,error:'Site page could not be authenticated as HTML'});}
      const html=(await boundedBody(response,MAX_BYTES)).toString('utf8');
      if(/<title>\s*CurtBrag\s*[·|]\s*Private site\s*<\/title>/i.test(html) || /<form\b[^>]*action=["']\/_site\/login["']/i.test(html)) return json(502,{ok:false,error:'The site returned its sign-in screen instead of the page'});
      return json(200,{ok:true,kind:'site-audit-page',path,url,status:200,content_type:'text/html; charset=utf-8',html,bytes:Buffer.byteLength(html),ms:Math.max(0,now()-started)});
    } catch (_) {
      // Upstream exception messages can contain request details; keep them private.
      return json(502,{ok:false,error:'The protected site page could not be read. Try again later.'});
    }
  };
}
