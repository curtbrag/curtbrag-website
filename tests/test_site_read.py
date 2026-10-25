import base64, gzip, hashlib, importlib.util, json, pathlib, random, tempfile, types, unittest
from urllib.error import HTTPError
from urllib.parse import urlencode
from unittest.mock import patch

ROOT=pathlib.Path(__file__).resolve().parents[1]
def load(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'scripts'/name)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
reader=load('cluster-site-read.py')
web=load('cluster-web-audit.py')
snapshot=load('cluster-page-snapshot.py')
browser=load('cluster-browser-audit.py')

class Reply:
    status=200
    headers={'Content-Type':'application/json'}
    def __init__(self,request,value,url=None,headers=None):
        self.url=url or request.full_url;self.raw=json.dumps(value).encode();self.headers=self.headers if headers is None else headers
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def read(self,limit): return self.raw[:limit]
class Opener:
    def __init__(self,value,**options):self.value=value;self.options=options;self.calls=[]
    def open(self,request,timeout):self.calls.append(request);return Reply(request,self.value,**self.options)
def page(path='/',html='<title>Real site</title><h1>Hi</h1>'):
    return {'ok':True,'kind':'site-audit-page','path':path,'url':reader.ORIGIN+path,'status':200,'content_type':'text/html; charset=utf-8','html':html,'bytes':len(html.encode())}

class ProtectedSiteTests(unittest.TestCase):
    def test_uses_existing_worker_environment_or_private_simple_assignments(self):
        self.assertEqual(reader.worker_key({'CLUSTER_API_KEY':'fixture-key'}),'fixture-key')
        self.assertEqual(reader.worker_key({'SWARM_TOKEN':'fixture-swarm'}),'fixture-swarm')
        self.assertEqual(reader.worker_key({'CLUSTER_API_KEY':'fixture-old','SWARM_TOKEN':'fixture-current'}),'fixture-current')
        with tempfile.TemporaryDirectory(dir=ROOT) as folder:
            env=pathlib.Path(folder)/'.cluster-env'
            env.write_text("OTHER=ignored\nexport CLUSTER_API_KEY='fixture-from-file' # comment\n")
            env.chmod(0o600)
            self.assertEqual(reader.worker_key({},folder),'fixture-from-file')
            env.write_text("echo secret\nCLUSTER_API_KEY='$(touch /tmp/not-executed)'\n")
            with self.assertRaises(ValueError):reader.worker_key({},folder)
    def test_rejects_nonregular_existing_configuration_without_reading_it(self):
        class FakeFile:
            def lstat(self):return types.SimpleNamespace(st_mode=0o120777,st_size=4)
            def read_text(self,**kwargs):raise AssertionError('Must not read symlink or special file')
        class FakeHome:
            def __truediv__(self,name):self.name=name;return FakeFile()
        with patch.object(reader.pathlib,'Path',return_value=FakeHome()):
            with self.assertRaises(ValueError):reader.worker_key({},'fixture')
    def test_only_fixed_endpoint_receives_existing_token_and_response_identity_is_checked(self):
        opener=Opener(page());result,data=reader.resource('/',opener,'fixture-key')
        request=opener.calls[0]
        self.assertEqual(request.full_url,reader.PAGE_API+'?'+urlencode({'path':'/'}))
        self.assertEqual(request.get_header('Authorization'),'Bearer fixture-key')
        self.assertEqual(data,page()['html'].encode())
        for value in [{**page(),'url':'https://evil.example/'},{**page(),'status':401},{**page(),'path':'/shop/'},{**page(),'bytes':1},{**page(),'html':'<title>CurtBrag · Private site</title>'},{**page(),'html':'<form action="/_site/login">'}]:
            with self.assertRaises(ValueError):reader.resource('/',Opener(value),'fixture-key')
        with self.assertRaises(ValueError):reader.resource('/',Opener(page(),url='https://evil.example/'),'fixture-key')
        with self.assertRaises(ValueError):reader.resource('/',Opener(page(),headers={'Content-Type':'text/html'}),'fixture-key')
    def test_private_paths_queries_traversal_and_redirects_are_rejected(self):
        for path in ['/cluster/dashboard/','/cluster/control/','/cluster/display.html','/api/cluster','/.netlify/functions/cluster-api','/assets/../private.png','/assets/%2e%2e/private.png','https://evil.example/','//evil.example/','/shop/?token=secret']:
            self.assertIsNone(reader.allowed_resource(path),path)
            opener=Opener(page())
            with self.assertRaises(ValueError):reader.resource(path,opener,'fixture-key')
            self.assertFalse(opener.calls)
        with self.assertRaises(ValueError):reader.NoRedirect().redirect_request(None,None,302,'',{},'https://evil.example/')
    def test_asset_decoding_content_type_and_size_are_verified(self):
        asset={'ok':True,'kind':'site-audit-asset','path':'/_astro/style.css','url':reader.ORIGIN+'/_astro/style.css','status':200,'content_type':'text/css','encoding':'base64','data':base64.b64encode(b'body{}').decode(),'bytes':6}
        self.assertEqual(reader.resource('/_astro/style.css',Opener(asset),'fixture')[1],b'body{}')
        for value in [{**asset,'content_type':'text/html'},{**asset,'data':'invalid'},{**asset,'bytes':7}]:
            with self.assertRaises(ValueError):reader.resource('/_astro/style.css',Opener(value),'fixture')
    def test_web_audit_uses_actual_page_and_skips_private_links(self):
        html='<title>Real site</title><meta name="description" content="Description"><meta name="viewport" content="width=device-width"><h1>Hi</h1><a href="/shop/">Shop</a><a href="/cluster/dashboard/">Private</a>'
        with patch.object(web.site_read,'page',side_effect=lambda path:page(path,html)):
            result=web.audit('/')
        self.assertEqual(result['title'],'Real site');self.assertEqual(result['status'],200)
        self.assertEqual(result['links_checked'],1);self.assertFalse(result['issues'])
        error=HTTPError(reader.PAGE_API,401,'Unauthorized',{},None)
        with patch.object(web.site_read,'page',side_effect=error):result=web.audit('/')
        self.assertEqual(result['status'],401);self.assertIn('Page did not return HTTP 200',result['issues']);self.assertNotIn('title',result)
    def test_snapshot_hashes_actual_site_text(self):
        with patch.object(snapshot.site_read,'page',return_value=page(html='<title>Actual</title><h1>Worker page</h1><script>secret script</script>')):
            result=snapshot.snapshot('/')
        self.assertEqual(result['title'],'Actual');self.assertEqual(result['text'],'Worker page');self.assertEqual(len(result['sha256']),64)
        with self.assertRaises(ValueError):snapshot.snapshot('/cluster/control/')
    def test_snapshot_receipt_keeps_full_long_unicode_text_inside_the_worker_limit(self):
        text=('Complete 日本語 🔧 lines\n'*1600)
        value={'kind':'page-snapshot','path':'/cluster/','url':reader.ORIGIN+'/cluster/','title':'Compute Cluster','text':text,'sha256':hashlib.sha256(text.encode()).hexdigest(),'checked_at':'2026-10-25T00:00:00+00:00','scope':'HTML text'}
        encoded=snapshot.snapshot_receipt(value);self.assertLessEqual(len(encoded.encode()),3800)
        wire=json.loads(encoded);self.assertEqual(wire['text_encoding'],'gzip-base64');self.assertNotIn('text',wire)
        original=gzip.decompress(base64.b64decode(wire['text_gzip'])).decode();self.assertEqual(original,text);self.assertEqual(hashlib.sha256(original.encode()).hexdigest(),wire['sha256']);self.assertEqual(wire['text_bytes'],len(text.encode()));self.assertEqual(wire['text_chars'],len(text.encode('utf-16-le'))//2)
        short={**value,'text':'Short page','sha256':hashlib.sha256(b'Short page').hexdigest()}
        self.assertEqual(json.loads(snapshot.snapshot_receipt(short)),short)
    def test_incompressible_snapshot_returns_an_explicit_limit_error_before_worker_truncation(self):
        rng=random.Random(3);text=''.join(rng.choice('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') for _ in range(20000))
        value={'kind':'page-snapshot','path':'/cluster/','url':reader.ORIGIN+'/cluster/','title':'Compute Cluster','text':text,'sha256':hashlib.sha256(text.encode()).hexdigest()}
        with self.assertRaisesRegex(ValueError,'cannot fit the worker result limit'):snapshot.snapshot_receipt(value)
    def test_browser_receives_only_content_never_reader_credentials(self):
        class Request:
            url=reader.ORIGIN+'/';method='GET'
            def is_navigation_request(self):return True
        class Route:
            def __init__(self,url=None,method='GET',navigation=True):
                self.request=Request();self.request.url=url or Request.url;self.request.method=method;self.request.is_navigation_request=lambda:navigation;self.result=None
            def fulfill(self,**kwargs):self.result=('fulfilled',kwargs)
            def abort(self):self.result=('aborted',None)
            def continue_(self):self.result=('continued',None)
        seen=[]
        def read(path):seen.append(path);return page(path),b'<title>Actual page</title>'
        blocked=[];errors=[];cache={};handler=browser.protected_routes(blocked,errors,cache,read)
        root=Route();handler(root);self.assertEqual(root.result[0],'fulfilled')
        self.assertEqual(set(root.result[1]['headers']),{'content-type','cache-control'});self.assertNotIn('Authorization',str(root.result))
        handler(Route());self.assertEqual(seen,['/'])
        spaced=Route(reader.ORIGIN+'/gallery/snapon/Mobile%20uploads.jpg',navigation=False);handler(spaced);self.assertEqual(spaced.result[0],'fulfilled');self.assertEqual(seen[-1],'/gallery/snapon/Mobile uploads.jpg')
        for url,method in [(reader.ORIGIN+'/api/cluster','GET'),(reader.ORIGIN+'/cluster/dashboard/','GET'),(reader.ORIGIN+'/','POST'),('https://evil.example/','GET'),(reader.ORIGIN+'/gallery/cars/%2e%2e/private.jpg','GET'),(reader.ORIGIN+'/gallery/cars/%252e%252e/private.jpg','GET')]:
            route=Route(url,method);handler(route);self.assertEqual(route.result[0],'aborted')
        external=Route('https://fonts.googleapis.com/css',navigation=False);handler(external);self.assertEqual(external.result[0],'continued')
        self.assertEqual(seen,['/','/gallery/snapon/Mobile uploads.jpg']);self.assertFalse(errors)
    def test_browser_cache_does_not_insert_or_render_a_resource_exceeding_total_budget(self):
        class ExistingBytes:
            def __len__(self):return 33554430
        class Route:
            request=types.SimpleNamespace(url=reader.ORIGIN+'/assets/logo.png',method='GET',is_navigation_request=lambda:False)
            def fulfill(self,**kwargs):self.result='fulfilled'
            def abort(self):self.result='aborted'
        cache={'existing':({},ExistingBytes())};errors=[];calls=[]
        def oversized(path):calls.append(path);return {'content_type':'image/png'},b'123'
        route=Route();browser.protected_routes([],errors,cache,oversized)(route)
        self.assertEqual(route.result,'aborted');self.assertNotIn('/assets/logo.png',cache);self.assertEqual(len(calls),1);self.assertTrue(errors)
        def fits(path):return {'content_type':'image/png'},b'12'
        route=Route();browser.protected_routes([],[],cache,fits)(route)
        self.assertEqual(route.result,'fulfilled');self.assertEqual(sum(len(item[1]) for item in cache.values()),33554432)

if __name__=='__main__':unittest.main()
