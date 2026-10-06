#!/usr/bin/env python3
"""Bounded text snapshot of one public CurtBrag page; no login or form actions."""
import argparse, hashlib, json, re
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.request import Request, urlopen
from urllib.parse import urlsplit

class TextPage(HTMLParser):
    def __init__(self):
        super().__init__(); self.hidden=0; self.title=False; self.titles=[]; self.parts=[]
    def handle_starttag(self, tag, attrs):
        if tag in ('script','style','noscript','template'): self.hidden+=1
        if tag=='title': self.title=True
        if tag in ('p','div','li','h1','h2','h3','br','section'): self.parts.append('\n')
    def handle_endtag(self, tag):
        if tag in ('script','style','noscript','template'): self.hidden=max(0,self.hidden-1)
        if tag=='title': self.title=False
        if tag in ('p','div','li','h1','h2','h3','section'): self.parts.append('\n')
    def handle_data(self, value):
        if self.hidden: return
        if self.title: self.titles.append(value)
        else: self.parts.append(value)

def snapshot(path):
    if not re.fullmatch(r'/(?!/)[A-Za-z0-9/_-]*',path) or path.startswith('/cluster/dashboard'):
        raise ValueError('Use a public site path; dashboard pages are excluded.')
    url='https://curtbrag.com'+path
    with urlopen(Request(url,headers={'User-Agent':'CurtClusterChangeMonitor/1.0'}),timeout=15) as response:
        final=urlsplit(response.url)
        if final.scheme!='https' or final.hostname!='curtbrag.com': raise ValueError('Page redirected outside this site.')
        if 'text/html' not in response.headers.get('Content-Type',''): raise ValueError('Page is not HTML.')
        raw=response.read(300001)
        if len(raw)>300000: raise ValueError('Page exceeds snapshot size limit.')
        parser=TextPage();parser.feed(raw.decode(response.headers.get_content_charset() or 'utf-8',errors='replace'))
    lines=[' '.join(line.split()) for line in ''.join(parser.parts).splitlines()]
    text='\n'.join(line for line in lines if line)
    if len(text)>60000: raise ValueError('Page text exceeds snapshot size limit.')
    if not text: raise ValueError('Page has no readable HTML text.')
    return {'kind':'page-snapshot','path':path,'url':url,'title':' '.join(''.join(parser.titles).split()),'text':text,
            'sha256':hashlib.sha256(text.encode()).hexdigest(),'checked_at':datetime.now(timezone.utc).isoformat(),
            'scope':'HTML text only; scripts, images, styling and dynamic browser content are excluded.'}

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--path',required=True);args=parser.parse_args()
    try: print(json.dumps(snapshot(args.path)))
    except Exception as error:
        print(json.dumps({'kind':'page-snapshot-error','path':args.path,'error':str(error)}));raise SystemExit(1)

