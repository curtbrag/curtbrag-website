export const DISPLAY_COOKIE = '__Host-curtbrag_display';
export const DISPLAY_SESSION_SECONDS = 86400;
export const DISPLAY_TICKET_SECONDS = 300;
const UNITS = new Set(['phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254']);
const VALID_TOKEN = /^[a-f0-9]{64}$/;
export async function displayDigest(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2,'0')).join('');
}
const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2,'0')).join('');
function cookieToken(header) {
  const parts = String(header || '').split(';').map(s => s.trim()).filter(s => s.startsWith(DISPLAY_COOKIE+'='));
  if(parts.length !== 1) return null;
  const value = parts[0].slice(DISPLAY_COOKIE.length+1);
  return VALID_TOKEN.test(value) ? value : null;
}
export function displayScope(request, unit) {
  if(request.method !== 'GET' || !UNITS.has(unit)) return false;
  const url = new URL(request.url);
  if(url.pathname === '/cluster/display.html') return url.searchParams.getAll('name').length === 1 && url.searchParams.get('name') === unit;
  if(url.pathname === '/cluster/eyecandy.html') return true;
  return url.pathname === '/.netlify/functions/phone-display' && url.searchParams.getAll('phone').length === 1 && url.searchParams.get('phone') === unit;
}
function valid(record, kind, host, now, maxAge) {
  return record?.version === 1 && record.kind === kind && UNITS.has(record.unit) && record.host === host &&
    Number.isFinite(record.expires) && record.expires > now && record.expires <= now + maxAge * 1000 &&
    VALID_TOKEN.test(record.passwordRevision || '');
}
export async function issueDisplayTicket({store, phone, host, password, now = Date.now()}) {
  if(!UNITS.has(phone) || !password) throw new Error('Invalid display connection');
  const token = newToken();
  await store.setJSON('ticket--'+await displayDigest(token), {
    version:1,kind:'ticket',unit:phone,host,expires:now+DISPLAY_TICKET_SECONDS*1000,passwordRevision:await displayDigest(password),
  });
  return token;
}
export async function authorizeDisplay({request,store,password,now = Date.now()}) {
  const url = new URL(request.url), ticket = url.searchParams.get('display_ticket');
  if(ticket !== null) {
    if(request.method !== 'GET' || url.pathname !== '/cluster/display.html' || url.searchParams.getAll('display_ticket').length !== 1 || !VALID_TOKEN.test(ticket)) return null;
    const key = 'ticket--'+await displayDigest(ticket), record = await store.get(key,{type:'json',consistency:'strong'});
    if(!valid(record,'ticket',url.hostname,now,DISPLAY_TICKET_SECONDS) || !displayScope(request,record.unit) || !password || record.passwordRevision !== await displayDigest(password)) return null;
    // Remove the short-lived ticket before creating a cookie. Later retries
    // cannot reuse it; the cookie grants only this unit's display GET requests.
    await store.delete(key);
    const session = newToken();
    await store.setJSON('session--'+await displayDigest(session), {...record,kind:'session',expires:now+DISPLAY_SESSION_SECONDS*1000});
    url.searchParams.delete('display_ticket');
    return {redirect:url.pathname+url.search, cookie:`${DISPLAY_COOKIE}=${session}; Path=/; Max-Age=${DISPLAY_SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`};
  }
  const token = cookieToken(request.headers.get('cookie'));
  if(!token) return null;
  const record = await store.get('session--'+await displayDigest(token),{type:'json',consistency:'strong'});
  if(!valid(record,'session',url.hostname,now,DISPLAY_SESSION_SECONDS) || !displayScope(request,record.unit) || !password || record.passwordRevision !== await displayDigest(password)) return null;
  return {authorized:true,unit:record.unit};
}
