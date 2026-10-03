#!/usr/bin/env python3
"""Retrieve bounded Wikipedia source excerpts for one swarm research task."""
import argparse
import html
import json
import re
from datetime import datetime, timezone
from urllib.parse import urlencode, quote
from urllib.request import Request, urlopen


def fetch(params):
    url = 'https://en.wikipedia.org/w/api.php?' + urlencode({
        'action': 'query', 'format': 'json', 'formatversion': 2, **params})
    with urlopen(Request(url, headers={'User-Agent':
            'CurtClusterResearch/1.0 (https://curtbrag.com/cluster/dashboard/)'}), timeout=20) as response:
        raw=response.read(1_000_001)
        if len(raw)>1_000_000:
            raise ValueError('Source response exceeded limit')
        data=json.loads(raw)
        if data.get('error'):
            raise ValueError('Wikipedia returned an API error')
        return data


def passage(text, limit=650):
    text=re.sub(r'\s+', ' ', str(text)).strip()
    if len(text)<=limit:
        return text
    prefix=text[:limit]
    sentences=list(re.finditer(r'[.!?](?=\s|$)',prefix))
    return prefix[:sentences[-1].end()] if sentences else prefix.rsplit(' ',1)[0]+'…'


def research(query, fetcher=fetch):
    if not isinstance(query, str) or not 1 <= len(query.strip()) <= 240:
        raise ValueError('Query must contain 1–240 characters')
    found = fetcher({'list': 'search', 'srsearch': query, 'srlimit': 3})
    rows = found.get('query', {}).get('search', [])
    sources = []
    gaps=[]
    retrieved=datetime.now(timezone.utc).isoformat()
    for row in rows[:2]:
        title = str(row.get('title', ''))[:160]
        if not title:
            continue
        try:
            details=fetcher({'prop':'extracts|info','titles':title,'explaintext':1,'exintro':1,'exchars':1200,'inprop':'url','redirects':1})
            pages=details.get('query',{}).get('pages',[])
            page=next((p for p in pages if 'missing' not in p and p.get('extract')),None)
            if not page:
                raise ValueError('Article passage unavailable')
            resolved=str(page.get('title',title))[:160]
            sources.append({'title':resolved,'url':'https://en.wikipedia.org/wiki/'+quote(resolved.replace(' ','_'),safe=''),
                            'excerpt':passage(page['extract']),'retrieved_at':retrieved,'revision_id':page.get('lastrevid'),
                            'evidence_type':'article-introduction','review_required':True})
        except Exception as error:
            gaps.append(title+': '+str(error)[:100])
    result = {'kind': 'research-sources', 'query': query, 'sources': sources,
              'retrieved_at':retrieved,'coverage':'unreviewed','gaps':gaps,
              'scope': 'Wikipedia article introductions; relevance and question coverage require review'}
    while len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > 3800:
        longest = max(sources, key=lambda source: len(source['excerpt']))
        if longest['excerpt']:
            longest['excerpt'] = passage(longest['excerpt'],max(80,len(longest['excerpt'])//2))
        else:
            sources.pop()
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--query', required=True)
    args = parser.parse_args()
    try:
        result = research(args.query)
        if not result['sources']:
            raise ValueError('No sources found; revise this task query')
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'kind': 'research-error', 'error': str(error)[:300]}))
        raise SystemExit(1)
