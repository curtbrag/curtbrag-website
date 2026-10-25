#!/usr/bin/env python3
"""Bounded text snapshot of one public CurtBrag page; no login or form actions."""
import argparse, base64, gzip, hashlib, importlib.util, json, pathlib, re
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.request import Request, urlopen
from urllib.parse import urlsplit

_spec=importlib.util.spec_from_file_location('curt_site_read',pathlib.Path(__file__).with_name('cluster-site-read.py'))
site_read=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(site_read)

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
    if path not in site_read.PUBLIC_PATHS: raise ValueError('Use an allowed CurtBrag page path; dashboards and controls are excluded.')
    url='https://curtbrag.com'+path
    result=site_read.page(path)
    if len(result['html'].encode('utf-8'))>300000: raise ValueError('Page exceeds snapshot size limit.')
    parser=TextPage();parser.feed(result['html'])
    lines=[' '.join(line.split()) for line in ''.join(parser.parts).splitlines()]
    text='\n'.join(line for line in lines if line)
    if len(text)>60000: raise ValueError('Page text exceeds snapshot size limit.')
    if not text: raise ValueError('Page has no readable HTML text.')
    return {'kind':'page-snapshot','path':path,'url':url,'title':' '.join(''.join(parser.titles).split()),'text':text,
            'sha256':hashlib.sha256(text.encode()).hexdigest(),'checked_at':datetime.now(timezone.utc).isoformat(),
            'scope':'HTML text only; scripts, images, styling and dynamic browser content are excluded.'}

def snapshot_receipt(report):
    """Keep a complete verifiable snapshot inside the worker's 4000-byte receipt."""
    encode=lambda value:json.dumps(value,ensure_ascii=True,separators=(',',':'))
    encoded=encode(report)
    if len(encoded.encode('utf-8'))<=3800: return encoded
    text=report['text'];raw=text.encode('utf-8')
    if len(raw)>240000 or len(text.encode('utf-16-le'))//2>60000: raise ValueError('Page text exceeds the snapshot display limit')
    compact={key:value for key,value in report.items() if key!='text'}
    compact.update(text_encoding='gzip-base64',text_gzip=base64.b64encode(gzip.compress(raw,mtime=0)).decode('ascii'),text_bytes=len(raw),text_chars=len(text.encode('utf-16-le'))//2)
    encoded=encode(compact)
    if len(encoded.encode('utf-8'))>3800: raise ValueError('Complete page text cannot fit the worker result limit; reduce the monitored page text before retrying')
    return encoded

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--path',required=True);args=parser.parse_args()
    try: print(snapshot_receipt(snapshot(args.path)))
    except Exception as error:
        print(json.dumps({'kind':'page-snapshot-error','path':args.path,'error':str(error)}));raise SystemExit(1)

