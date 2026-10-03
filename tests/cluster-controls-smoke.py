#!/usr/bin/env python3
"""Responsive UI regression against published assets with isolated fixture API state.
No real dashboard credentials or API writes are used.
"""
import json
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

NAMES=['phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254','Alina','Nexus','SteamDeck','viki','RenderRig']
DATA={'ok':True,'nodes':[{'id':n,'online':True,'busy':False,'agent_version':'3.7.0','last_seen':1790997000000} for n in NAMES],
      'jobs':[],'results':[],'devices':[],'profiles':[],'events':[],'alerts':[],'summary':{},'queued':0,'total_completed':0,'assignments_pending':0,'alive':False}

def isolated_api(route):
    path=urlsplit(route.request.url).path
    if path.startswith('/api/cluster') or path.startswith('/.netlify/functions/'):
        route.fulfill(status=200,content_type='application/json',body=json.dumps(DATA))
    elif route.request.method in ['GET','HEAD']:
        route.continue_()
    else:
        route.abort()

checks=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,chromium_sandbox=True)
    for width,height in [(1366,900),(390,844)]:
        context=browser.new_context(viewport={'width':width,'height':height},service_workers='block')
        context.route('**/*',isolated_api)
        context.add_init_script("sessionStorage.setItem('cp_password','ui-fixture-only');")
        page=context.new_page()
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto('https://curtbrag.com/cluster/dashboard/',wait_until='load')
        page.locator('#cluster-work-navigation').wait_for(state='visible',timeout=15000)
        assert page.locator('#swarm-nodes-online').inner_text()=='13 / 13'
        for name in ['fleet','audit','research','media','results']:
            page.locator('#cluster-view-tab-'+name).click()
            assert page.locator('#cluster-view-'+name).is_visible()
            assert page.locator('.cluster-work-view:visible').count()==1
            overflow=page.evaluate('Math.max(0,document.documentElement.scrollWidth-innerWidth)')
            checks.append({'viewport':width,'view':name,'overflow_px':overflow})
            assert overflow<=2,(name,width,overflow)
        page.locator('#cluster-view-tab-audit').click()
        page.get_by_text('Audit settings · JSON',exact=True).click()
        page.locator('#cluster-audit-settings').fill('{bad')
        page.locator('#cluster-audit-run').click()
        assert page.locator('#cluster-audit-run').is_enabled()
        assert not page.locator('#cluster-audit-state').inner_text().startswith('12 /')
        page.locator('#cluster-view-tab-media').click()
        page.locator('#swarm-job-type').select_option('shell')
        page.locator('#swarm-job-cmd').fill('echo ui-fixture-only')
        page.locator('#cluster-view-tab-fleet').click()
        page.locator('#cluster-view-tab-media').click()
        assert page.locator('#swarm-job-cmd').input_value()=='echo ui-fixture-only'
        page.locator('#cluster-view-tab-media').press('ArrowRight')
        assert page.locator('#cluster-view-tab-results').get_attribute('aria-selected')=='true'
        page.reload(wait_until='load')
        page.locator('#cluster-work-navigation').wait_for(state='visible')
        assert page.locator('#cluster-view-tab-results').get_attribute('aria-selected')=='true'
        assert not errors,errors
        context.close()
    browser.close()
print(json.dumps({'kind':'dashboard-controls-smoke','fixture_api':True,'passed':True,'checks':checks,'form_preserved':True,'keyboard_tabs':True,'reload_restored_view':True}))
