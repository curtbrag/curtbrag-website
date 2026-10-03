#!/usr/bin/env python3
"""Public-site Chromium checks; isolated profile, no form submissions."""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

ORIGIN = 'https://curtbrag.com'
RUNTIME = Path.home() / 'cluster' / 'browser-audit-venv'
VIEWPORTS = [('desktop', 1366, 900), ('mobile', 390, 844)]

def page_url(path):
    if not isinstance(path, str) or not re.fullmatch(r'/(?!/)[A-Za-z0-9/_-]*', path):
        raise ValueError('Use a public curtbrag.com path starting with /')
    return ORIGIN + path

def allowed_request(url, method, navigation=False):
    p = urlsplit(url)
    allowed = {'curtbrag.com', 'www.curtbrag.com', 'fonts.googleapis.com',
               'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net',
               'images.unsplash.com', 'i.ytimg.com', 'www.youtube.com'}
    return (method in ('GET', 'HEAD') and p.scheme == 'https' and p.hostname in allowed
            and not p.username and p.port in (None, 443)
            and (not navigation or p.hostname in ('curtbrag.com', 'www.curtbrag.com')))

def suggestions(metrics, errors):
    findings = []
    if metrics['overflow_px'] > 2:
        findings.append({'check': 'horizontal-overflow', 'evidence': f"{metrics['overflow_px']}px beyond viewport; {', '.join(metrics['overflow_elements'])}",
                         'proposal': 'Inspect these elements; constrain widths and wrap long text at this viewport.'})
    if metrics['broken_images']:
        findings.append({'check': 'broken-images', 'evidence': ', '.join(metrics['broken_images']),
                         'proposal': 'Verify the image paths and files; replace or repair missing assets.'})
    if metrics.get('missing_fragments'):
        findings.append({'check': 'missing-fragment-target', 'evidence': ', '.join(metrics['missing_fragments']),
                         'proposal': 'Correct these in-page navigation links or add the intended target IDs.'})
    for error in errors[:2]:
        findings.append({'check': 'javascript-error', 'evidence': error[:140],
                         'proposal': 'Reproduce this exception and guard the failing initialization or event handler.'})
    return findings

DOM_CHECKS = """() => {
 const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
 const tag=e=>e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+(typeof e.className==='string'?'.'+e.className.trim().split(/\\s+/).slice(0,2).join('.'):'');
 const n=performance.getEntriesByType('navigation')[0];
 const links=Array.from(document.querySelectorAll('a[href]')).filter(visible);
 const fragments=links.map(e=>new URL(e.href,location.href)).filter(u=>u.origin===location.origin&&u.pathname===location.pathname&&u.search===location.search&&u.hash.length>1);
 const missing=fragments.filter(u=>{let id;try{id=decodeURIComponent(u.hash.slice(1));}catch{return true;}return !document.getElementById(id)&&!Array.from(document.getElementsByName(id)).length;}).map(u=>u.hash);
 return {title:document.title.slice(0,150),overflow_px:Math.max(0,document.documentElement.scrollWidth-innerWidth),
 overflow_elements:Array.from(document.querySelectorAll('body *')).filter(e=>visible(e)&&e.getBoundingClientRect().right>innerWidth+2).slice(0,3).map(tag),
 broken_images:Array.from(document.images).filter(e=>visible(e)&&e.complete&&e.naturalWidth===0).slice(0,3).map(e=>new URL(e.currentSrc||e.src).pathname.slice(0,100)),
 navigation_links_checked:links.length,missing_fragments:[...new Set(missing)].slice(0,5),
 pending_images:Array.from(document.images).filter(e=>visible(e)&&!e.complete).length,
 timings:n?{dom_content_loaded_ms:Math.round(n.domContentLoadedEventEnd),load_ms:Math.round(n.loadEventEnd)}:null};
}"""

SCROLL_IMAGES = """async () => {
 let steps=0;
 for(;steps<20;steps++){
  const bottom=Math.max(0,document.documentElement.scrollHeight-innerHeight);
  if(scrollY>=bottom)break;
  scrollTo({top:Math.min(bottom,scrollY+Math.max(200,innerHeight*0.8)),behavior:'instant'});
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 }
 const complete=scrollY>=Math.max(0,document.documentElement.scrollHeight-innerHeight)-2;
 scrollTo({top:0,behavior:'instant'});
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 return {scroll_steps:steps,scroll_complete:complete};
}"""

def prepare():
    if not (RUNTIME / 'bin/python').is_file():
        subprocess.run([sys.executable, '-m', 'venv', str(RUNTIME)], check=True, capture_output=True, timeout=60)
    python = str(RUNTIME / 'bin/python')
    subprocess.run([python, '-m', 'pip', 'install', '--disable-pip-version-check', 'playwright==1.55.0'], check=True, capture_output=True, timeout=180)
    subprocess.run([python, '-m', 'playwright', 'install', 'chromium'], check=True, capture_output=True, timeout=180)
    subprocess.run([python, str(Path(__file__).resolve()), '--probe'], check=True, capture_output=True, timeout=30)
    return {'v': 1, 'kind': 'browser-runtime', 'ready': True, 'runtime': str(RUNTIME), 'browser': 'Chromium'}

def audit(path):
    from playwright.sync_api import sync_playwright
    url = page_url(path)
    reports = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, chromium_sandbox=True)
        try:
            for name, width, height in VIEWPORTS:
                context = browser.new_context(viewport={'width': width, 'height': height}, service_workers='block')
                blocked = []
                def route_handler(route):
                    request = route.request
                    if allowed_request(request.url, request.method, request.is_navigation_request()):
                        route.continue_()
                    else:
                        blocked.append(urlsplit(request.url).hostname or 'unknown')
                        route.abort()
                context.route('**/*', route_handler)
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                item = {'viewport': name, 'width': width, 'height': height}
                try:
                    response = page.goto(url, wait_until='load', timeout=25000)
                    item['status'] = response.status if response else 0
                    item.update(page.evaluate(SCROLL_IMAGES))
                    try:
                        page.wait_for_function('() => Array.from(document.images).every(e => e.complete || e.getBoundingClientRect().width === 0)', timeout=5000)
                    except Exception:
                        pass  # Pending image counts remain explicit evidence, not a clean pass.
                    page.wait_for_function("() => document.getAnimations().every(a => a.playState !== 'running' || a.effect.getTiming().iterations === Infinity)", timeout=5000)
                    metrics = page.evaluate(DOM_CHECKS)
                    item.update(metrics)
                    item['findings'] = suggestions(metrics, errors)
                    if item['status'] != 200:
                        item['findings'].append({'check': 'http-status', 'evidence': str(item['status']), 'proposal': 'Check the route and hosting response.'})
                    item['blocked_resource_hosts'] = sorted(set(blocked))[:4]
                except Exception as error:
                    item.update(error=str(error)[:220], findings=[{'check': 'incomplete-browser-check', 'evidence': str(error)[:160], 'proposal': 'Resolve the browser/navigation error and rerun; no layout conclusion is available.'}])
                finally:
                    context.close()
                reports.append(item)
        finally:
            browser.close()
    return {'v': 1, 'kind': 'website-browser-audit', 'page': {'url': url, 'viewports': reports,
            'scope': 'Public Chromium desktop/mobile checks, bounded lazy-image scrolling and in-page navigation targets; no clicks, login or form submissions. Timings are single-run observations, not Core Web Vitals.'}}

def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--prepare', action='store_true')
    mode.add_argument('--probe', action='store_true')
    mode.add_argument('--path')
    args = parser.parse_args()
    try:
        if args.prepare:
            result = prepare()
        elif args.probe:
            from playwright.sync_api import sync_playwright
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True, chromium_sandbox=True)
                browser.close()
            result = {'kind': 'browser-runtime', 'ready': True}
        else:
            result = audit(args.path)
        print(json.dumps(result, separators=(',', ':')))
    except Exception as error:
        if isinstance(error, subprocess.CalledProcessError):
            detail = (error.stderr or error.stdout or b'').decode('utf-8', 'replace')[-600:]
        else:
            detail = str(error)[:600]
        print(json.dumps({'kind': 'browser-audit-error', 'error': detail, 'ready': False}))
        sys.exit(1)

if __name__ == '__main__':
    main()
