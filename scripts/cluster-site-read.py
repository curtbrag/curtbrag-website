#!/usr/bin/env python3
"""Read approved CurtBrag pages/assets through the existing cluster connection."""
import base64, json, os, pathlib, re, shlex, stat
from urllib.parse import urlencode
from urllib.request import Request, HTTPRedirectHandler, build_opener

ORIGIN = 'https://curtbrag.com'
PAGE_API = ORIGIN + '/.netlify/functions/site-audit-page'
PUBLIC_PATHS = {'/', '/gallery/', '/gallery/cars/', '/gallery/snapon/', '/shop/', '/rig/', '/cluster/', '/contact/', '/addyourride/', '/yougood/', '/zelle/', '/privacy/', '/terms/', '/thanks/'}
ASSET_TYPES = {'.css':'text/css','.js':'application/javascript','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf'}

def allowed_resource(path):
    if path in PUBLIC_PATHS: return 'page'
    if not isinstance(path,str) or len(path)>256 or not re.fullmatch(r'/[A-Za-z0-9_./ -]+',path) or '//' in path or any(part in ('.','..') for part in path.split('/')): return None
    extension=pathlib.PurePosixPath(path).suffix.lower()
    if extension not in ASSET_TYPES: return None
    if path.startswith('/_astro/') and extension in ('.css','.js'): return 'asset'
    if path.startswith('/scripts/') and extension=='.js': return 'asset'
    if path.startswith('/styles/') and extension=='.css': return 'asset'
    if path.startswith(('/assets/','/gallery/cars/','/gallery/snapon/')) and extension not in ('.css','.js'): return 'asset'
    return None

def worker_key(environ=None, home=None):
    """Use only existing worker auth; parse its own private file without execution."""
    environ = os.environ if environ is None else environ
    for name in ('SWARM_TOKEN', 'CLUSTER_API_KEY'):
        value=environ.get(name,'')
        if value and len(value)<=512 and not any(c.isspace() for c in value): return value
    path=(pathlib.Path.home() if home is None else pathlib.Path(home))/'.cluster-env'
    try:
        info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size>65536: raise ValueError('Worker configuration is unavailable')
        if os.name!='nt' and (info.st_uid!=os.getuid() or info.st_mode & 0o077): raise ValueError('Worker configuration must remain private')
        values={}
        for line in path.read_text(encoding='utf-8').splitlines():
            try: fields=shlex.split(line,comments=True)
            except ValueError: continue
            if fields[:1]==['export']: fields=fields[1:]
            if len(fields)!=1 or '=' not in fields[0]: continue
            name,value=fields[0].split('=',1)
            if name in ('CLUSTER_API_KEY','SWARM_TOKEN') and value and len(value)<=512 and not any(c.isspace() for c in value): values[name]=value
        for name in ('SWARM_TOKEN','CLUSTER_API_KEY'):
            if values.get(name): return values[name]
    except (OSError,UnicodeError): pass
    raise ValueError('Existing worker authentication is unavailable; no site password is needed on this device')

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        raise ValueError('Audit API redirects are excluded')

def resource(path, opener=None, token=None):
    kind=allowed_resource(path)
    if not kind: raise ValueError('Only allowed CurtBrag page and static asset paths can be read')
    opener=build_opener(NoRedirect()) if opener is None else opener
    # The user approved this exact endpoint and the existing worker credential.
    # No token is ever passed to browser pages, other origins, redirects or logs.
    request=Request(PAGE_API+'?'+urlencode({'path':path}),headers={'Authorization':'Bearer '+(worker_key() if token is None else token),'User-Agent':'CurtClusterAudit/2.0','Accept':'application/json'})
    with opener.open(request,timeout=25) as response:
        if response.url!=request.full_url or response.status!=200 or 'application/json' not in response.headers.get('Content-Type',''): raise ValueError('The protected audit API did not return page data')
        raw=response.read(7*1048576+1)
        if len(raw)>7*1048576: raise ValueError('Protected resource response exceeded its limit')
        result=json.loads(raw)
    if not isinstance(result,dict) or result.get('ok') is not True or result.get('path')!=path or result.get('url')!=ORIGIN+path or result.get('status')!=200: raise ValueError('The protected audit API did not return the requested resource')
    if kind=='page':
        if result.get('kind')!='site-audit-page' or not isinstance(result.get('html'),str) or 'text/html' not in result.get('content_type',''): raise ValueError('The protected audit API did not return HTML')
        data=result['html'].encode('utf-8')
        if len(data)>1048576: raise ValueError('Page exceeded the audit size limit')
        if re.search(r'<title>\s*CurtBrag\s*[·|]\s*Private site\s*</title>',result['html'],re.I) or re.search(r'<form\b[^>]*action=["\']/_site/login["\']',result['html'],re.I): raise ValueError('Site sign-in screen is not audit page content')
    else:
        if result.get('kind')!='site-audit-asset' or result.get('encoding')!='base64' or not isinstance(result.get('data'),str): raise ValueError('The protected audit API did not return a static asset')
        expected=ASSET_TYPES[pathlib.PurePosixPath(path).suffix.lower()]
        if result.get('content_type')!=expected: raise ValueError('Static asset content type did not match its path')
        data=base64.b64decode(result['data'],validate=True)
        if len(data)>4194304: raise ValueError('Static asset exceeded the audit size limit')
    if result.get('bytes')!=len(data): raise ValueError('Protected resource byte count did not match')
    return result,data

def page(path):
    if path not in PUBLIC_PATHS: raise ValueError('Use an allowed CurtBrag page path; dashboards and controls are excluded')
    result,_=resource(path)
    return result
