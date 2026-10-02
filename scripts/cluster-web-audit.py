#!/usr/bin/env python3
"""Read-only HTTP/HTML audit of curtbrag.com; bounded public-page checks."""
import argparse, concurrent.futures, json, time
from html.parser import HTMLParser
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit, urldefrag

ORIGIN = 'https://curtbrag.com'
class Page(HTMLParser):
    def __init__(self):
        super().__init__(); self.title = ''; self.in_title = False
        self.description = ''; self.viewport = False; self.h1 = 0
        self.images = 0; self.missing_alt = 0; self.links = []
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'title': self.in_title = True
        if tag == 'h1': self.h1 += 1
        if tag == 'img':
            self.images += 1; self.missing_alt += int('alt' not in a)
        if tag == 'meta':
            if a.get('name','').lower() == 'description': self.description = a.get('content','')
            if a.get('name','').lower() == 'viewport': self.viewport = True
        if tag == 'a' and a.get('href'): self.links.append(a['href'])
    def handle_endtag(self, tag):
        if tag == 'title': self.in_title = False
    def handle_data(self, data):
        if self.in_title: self.title += data

def owned(url):
    p = urlsplit(url)
    return p.scheme == 'https' and p.netloc == 'curtbrag.com' and not p.username

def fetch(url):
    start=time.monotonic()
    try:
        # Redirects are checked before following, including link checks.
        from urllib.request import HTTPRedirectHandler, build_opener
        class Redirect(HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                if not owned(newurl): raise ValueError('redirect outside audit site')
                return super().redirect_request(req,fp,code,msg,headers,newurl)
        with build_opener(Redirect()).open(Request(url,headers={'User-Agent':'CurtClusterAudit/1.0'}),timeout=8) as r:
            body=r.read(1048577)
            return {'url':r.url,'status':r.status,'ms':round((time.monotonic()-start)*1000),'body':body[:1048576].decode('utf-8','replace'),'truncated':len(body)>1048576,'html':'text/html' in r.headers.get('Content-Type','')}
    except HTTPError as e: return {'url':url,'status':e.code,'ms':round((time.monotonic()-start)*1000),'error':'HTTP error'}
    except Exception as e: return {'url':url,'status':0,'error':str(e)[:160]}

def audit(path, max_links=8):
    url=urljoin(ORIGIN,path)
    if not owned(url): raise ValueError('Only HTTPS curtbrag.com pages can be audited')
    r=fetch(url); issues=[]; checks=[]
    if r['status'] != 200: issues.append('Page did not return HTTP 200')
    if r.get('body') and r.get('html'):
        p=Page(); p.feed(r.pop('body')); r.update(title=p.title.strip()[:150],description=p.description[:180],h1=p.h1,missing_alt=p.missing_alt,viewport=p.viewport)
        if not p.title.strip(): issues.append('Missing page title')
        if not p.description.strip(): issues.append('Missing meta description')
        if not p.viewport: issues.append('Missing mobile viewport metadata')
        if p.h1 != 1: issues.append('Expected one H1; found %s' % p.h1)
        if p.missing_alt: issues.append('%s images lack an alt attribute' % p.missing_alt)
        urls=[]
        for link in p.links:
            u=urldefrag(urljoin(r['url'],link))[0]
            if owned(u) and len(u) <= 200 and not urlsplit(u).query and u not in urls and not urlsplit(u).path.startswith('/api/'):
                urls.append(u)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            for result in pool.map(fetch,urls[:max_links]):
                item={k:result[k] for k in ('url','status','ms','error') if k in result}; checks.append(item)
                if result['status']>=400: issues.append('Broken internal link: '+result['url'])
                elif result['status']==0: issues.append('Unverified link: '+result['url'])
        r['links_checked']=len(checks);r['links_available']=len(urls)
    else: r.pop('body',None)
    if r.get('truncated'): issues.append('HTML exceeded 1 MiB; checks are partial')
    r.update(issues=issues,links=checks)
    return r

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--path',required=True);args=parser.parse_args()
    report={'v':1,'kind':'website-audit','page':audit(args.path)}
    encoded=json.dumps(report,separators=(',',':'))
    if len(encoded)>3800:
        report['page']['links']=[]
        report['page']['link_details_omitted']=True
        encoded=json.dumps(report,separators=(',',':'))
    print(encoded)
