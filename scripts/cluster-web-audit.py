#!/usr/bin/env python3
"""Read-only HTTP/HTML audit of curtbrag.com; bounded public-page checks."""
import argparse, concurrent.futures, importlib.util, json, pathlib, time
from html.parser import HTMLParser
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit, urldefrag

ORIGIN = 'https://curtbrag.com'
_spec=importlib.util.spec_from_file_location('curt_site_read',pathlib.Path(__file__).with_name('cluster-site-read.py'))
site_read=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(site_read)
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
        parsed=urlsplit(url)
        if not owned(url) or parsed.query or parsed.fragment: raise ValueError('Only allowed CurtBrag page URLs can be read')
        result=site_read.page(parsed.path)
        return {'url':result['url'],'status':result['status'],'ms':round((time.monotonic()-start)*1000),'body':result['html'],'truncated':False,'html':True}
    except HTTPError as e: return {'url':url,'status':e.code,'ms':round((time.monotonic()-start)*1000),'error':'HTTP error'}
    except Exception: return {'url':url,'status':0,'error':'Authenticated page read was unavailable. Check the existing worker connection.'}

def audit(path, max_links=8):
    url=urljoin(ORIGIN,path)
    if not owned(url) or urlsplit(url).path not in site_read.PUBLIC_PATHS or urlsplit(url).query or urlsplit(url).fragment: raise ValueError('Only allowed CurtBrag page paths can be audited')
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
            if owned(u) and len(u) <= 200 and not urlsplit(u).query and u not in urls and urlsplit(u).path in site_read.PUBLIC_PATHS:
                urls.append(u)
        # Keep each worker's protected reads sequential so an eight-phone batch
        # does not create dozens of simultaneous server sign-in sessions.
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
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
