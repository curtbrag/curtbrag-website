#!/usr/bin/env python3
"""Retrieve bounded Wikipedia source excerpts for one swarm research task."""
import argparse
import html
import json
import re
from urllib.parse import urlencode, quote
from urllib.request import Request, urlopen


def fetch(params):
    url = 'https://en.wikipedia.org/w/api.php?' + urlencode({
        'action': 'query', 'format': 'json', 'formatversion': 2, **params})
    with urlopen(Request(url, headers={'User-Agent':
            'CurtClusterResearch/1.0 (https://curtbrag.com/cluster/dashboard/)'}), timeout=20) as response:
        return json.loads(response.read(1_000_001))


def research(query, fetcher=fetch):
    if not isinstance(query, str) or not 1 <= len(query.strip()) <= 240:
        raise ValueError('Query must contain 1–240 characters')
    found = fetcher({'list': 'search', 'srsearch': query, 'srlimit': 3})
    rows = found.get('query', {}).get('search', [])
    sources = []
    for row in rows[:3]:
        title = str(row.get('title', ''))[:160]
        if not title:
            continue
        excerpt = html.unescape(re.sub(r'<[^>]*>', '', str(row.get('snippet', ''))))
        sources.append({'title': title, 'url': 'https://en.wikipedia.org/wiki/' +
                        quote(title.replace(' ', '_'), safe=''), 'excerpt': excerpt[:450]})
    result = {'kind': 'research-sources', 'query': query, 'sources': sources,
              'scope': 'Wikipedia search excerpts; verify sources before publication'}
    while len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > 3800:
        longest = max(sources, key=lambda source: len(source['excerpt']))
        if longest['excerpt']:
            longest['excerpt'] = longest['excerpt'][:len(longest['excerpt']) // 2]
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
