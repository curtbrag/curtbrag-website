export const COOKIE = '__Host-curtbrag_access';
export const LOGIN = '/_site/login';
export const LOGOUT = '/_site/logout';
const SESSION_SECONDS = 86400;
const PRIVATE_HEADERS = {
  'cache-control': 'private, no-store, max-age=0',
  'netlify-cdn-cache-control': 'no-store',
  'cdn-cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-curtbrag-access': 'password-required',
};

function escape(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function safeReturn(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//')) return '/';
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { return '/'; }
  if (decoded.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(decoded) || /^\/_site\/(login|logout)(?:[/?#]|$)/.test(decoded)) return '/';
  return value;
}
export function cookieToken(header) {
  const matches = String(header || '').split(';').map(s => s.trim()).filter(s => s.startsWith(COOKIE + '='));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}
function cookie(value, seconds) {
  return `${COOKIE}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;
}
function response(body, status, extra = {}) {
  return new Response(body, { status, headers: { ...PRIVATE_HEADERS, ...extra } });
}
const SUBMIT_SCRIPT = `document.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button'),message=document.getElementById('sign-in-message');button.disabled=true;button.textContent='Opening…';message.hidden=true;try{const res=await fetch(form.action,{method:'POST',credentials:'same-origin',headers:{Accept:'application/json'},body:new URLSearchParams(new FormData(form))});const result=await res.json();if(!res.ok||result.ok!==true)throw new Error(result.error||'Unable to sign in. Please try again.');window.location.assign(result.redirect);}catch(error){message.textContent=error.message||'Unable to sign in. Please try again.';message.hidden=false;button.disabled=false;button.textContent='Enter site';}});`;
function page(target, message = '', nonce = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>CurtBrag · Private site</title><style>body{margin:0;min-height:100svh;display:grid;place-items:center;background:#101113;color:#f5f5f5;font:16px system-ui,sans-serif}main{width:min(360px,calc(100% - 72px));padding:30px;background:#1b1c20;border:1px solid #34353a;border-radius:18px}h1{margin:0 0 12px;font-size:28px}p{color:#c5c7cb;line-height:1.5}label{display:block;margin-top:24px}input,button{box-sizing:border-box;width:100%;margin-top:10px;padding:14px;border-radius:9px;font:inherit}input{background:#101113;color:white;border:1px solid #62646a}button{background:#e51e2a;color:white;border:0;font-weight:700;cursor:pointer}.error{color:#ff9ea5}input:focus,button:focus{outline:3px solid #ffb1b6;outline-offset:3px}</style></head><body><main><h1>CurtBrag</h1><p>This site is private. Enter the password to continue.</p><p id="sign-in-message" class="error" role="alert"${message ? '' : ' hidden'}>${escape(message)}</p><form method="post" action="${LOGIN}"><input type="hidden" name="return" value="${escape(safeReturn(target))}"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus maxlength="256"><button type="submit">Enter site</button></form></main><script nonce="${nonce}">${SUBMIT_SCRIPT}</script></body></html>`;
}
function prompt(target, message = '', status = 401) {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');
  return response(page(target, message, nonce), status, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  });
}
async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
async function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}
function sameOrigin(request, url) {
  return request.headers.get('origin') === url.origin;
}

export function createSiteLock({ getPassword, getSessions, getAPIKey = async () => null, now = () => Date.now() }) {
  return async function siteLock(request, context) {
    const url = new URL(request.url);
    // Tea's separately hosted domain serves its own page, not CurtBrag content.
    if (url.hostname === 'teathetruth.com' || url.hostname === 'www.teathetruth.com') return context.next();
    const target = safeReturn(url.pathname + url.search);
    const token = cookieToken(request.headers.get('cookie'));
    try {
      if (url.pathname === LOGIN || url.pathname === LOGOUT) {
        if (request.method === 'GET' && url.pathname === LOGIN) return prompt(url.searchParams.get('return') || '/', '', 200);
        if (request.method !== 'POST') return response('Method not allowed', 405, { allow: url.pathname === LOGIN ? 'GET, POST' : 'POST' });
        if (!sameOrigin(request, url)) return response('Forbidden', 403);
        if (url.pathname === LOGOUT) {
          if (token) await getSessions().delete(await digest(token));
          return response(null, 303, { location: '/', 'set-cookie': cookie('', 0) });
        }
        if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return response('Unsupported form', 415);
        if (Number(request.headers.get('content-length') || 0) > 4096) return response('Form too large', 413);
        const body = await request.text();
        if (body.length > 4096) return response('Form too large', 413);
        const form = new URLSearchParams(body);
        const destination = safeReturn(form.get('return') || '/');
        const submitted = form.get('password');
        const wantsJSON = request.headers.get('accept')?.includes('application/json');
        const loginError = (error, status) => wantsJSON ? response(JSON.stringify({ ok: false, error }), status, { 'content-type': 'application/json' }) : prompt(destination, error, status);
        const password = await getPassword();
        if (typeof password !== 'string' || !password) return loginError('Sign-in is temporarily unavailable. Please try again later.', 503);
        if (!submitted || submitted.length > 256 || !await equal(submitted, password)) return loginError('Incorrect password. Please try again.', 401);
        const newToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
        const session = { version: 1, host: url.hostname, expires: now() + SESSION_SECONDS * 1000, passwordRevision: await digest(password) };
        await getSessions().setJSON(await digest(newToken), session);
        if (wantsJSON) return response(JSON.stringify({ ok: true, redirect: destination }), 200, { 'content-type': 'application/json', 'set-cookie': cookie(newToken, SESSION_SECONDS) });
        return response(null, 303, { location: destination, 'set-cookie': cookie(newToken, SESSION_SECONDS) });
      }
      // Existing authenticated service callers may reach APIs, never public pages or assets.
      const isAPI = url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/functions/');
      const auth = request.headers.get('authorization') || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const machineToken = bearer || request.headers.get('x-cluster-key') || request.headers.get('x-agent-token') || '';
      let machineAuthorized = false;
      if (isAPI && machineToken && machineToken.length <= 512) {
        const key = await getAPIKey();
        machineAuthorized = Boolean(key && await equal(machineToken, key));
      }
      if (!machineAuthorized) {
        if (!token) return prompt(target);
        const session = await getSessions().get(await digest(token), { type: 'json', consistency: 'strong' });
        if (!session || session.version !== 1 || session.host !== url.hostname || !Number.isFinite(session.expires) || session.expires <= now() || session.expires > now() + SESSION_SECONDS * 1000) return prompt(target);
        const password = await getPassword();
        if (!password || !await equal(session.passwordRevision, await digest(password))) return prompt(target);
      }
      const downstream = await context.next();
      const headers = new Headers(downstream.headers);
      for (const [name, value] of Object.entries(PRIVATE_HEADERS)) headers.set(name, value);
      headers.set('x-curtbrag-access', 'authenticated');
      headers.delete('surrogate-control');
      return new Response(downstream.body, { status: downstream.status, statusText: downstream.statusText, headers });
    } catch (_) {
      return prompt(target, 'Sign-in is temporarily unavailable. Please try again later.', 503);
    }
  };
}
