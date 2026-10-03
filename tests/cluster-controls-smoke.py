#!/usr/bin/env python3
"""Responsive UI regression against published assets with isolated fixture API state.
No real dashboard credentials or API writes are used.
"""
import json
import os
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

NAMES=['phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254','Alina','Nexus','SteamDeck','viki','RenderRig']
DATA={'ok':True,'nodes':[{'id':n,'online':True,'busy':False,'agent_version':'3.7.0','last_seen':1790997000000} for n in NAMES],
      'jobs':[],'results':[],'devices':[],'profiles':[],'events':[],'alerts':[],'summary':{},'queued':0,'total_completed':0,'assignments_pending':0,'alive':False}

def isolated_api(route):
    path=urlsplit(route.request.url).path
    if path=='/scripts/cluster-swarm-live-v8.js' and os.environ.get('LOCAL_DASHBOARD_SCRIPT'):
        route.fulfill(path=os.environ['LOCAL_DASHBOARD_SCRIPT'],content_type='application/javascript')
    elif path.startswith('/api/cluster') or path.startswith('/.netlify/functions/'):
        route.fulfill(status=200,content_type='application/json',body=json.dumps(DATA))
    elif route.request.method in ['GET','HEAD']:
        route.continue_()
    else:
        route.abort()

checks=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,chromium_sandbox=True,channel=os.environ.get('BROWSER_CHANNEL'))
    for width,height in [(1366,900),(390,844)]:
        context=browser.new_context(viewport={'width':width,'height':height},service_workers='block')
        context.route('**/*',isolated_api)
        context.add_init_script("if(window===window.top)sessionStorage.setItem('cp_password','ui-fixture-only');")
        page=context.new_page()
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto(os.environ.get('DASHBOARD_URL','https://curtbrag.com/cluster/dashboard/'),wait_until='load')
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
        page.locator('#swarm-job-type').select_option('episode-create')
        page.locator('#swarm-job-device').select_option('RenderRig')
        page.locator('#swarm-job-cmd').fill('{bad')
        page.locator('#swarm-job-submit').click()
        expect(page.locator('#swarm-job-feedback')).to_have_attribute('data-state','error')
        expect(page.locator('#swarm-job-status')).to_contain_text('Job settings must be JSON')
        assert page.locator('#swarm-job-cmd').input_value()=='{bad'
        assert page.locator('#swarm-job-submit').is_enabled()
        page.locator('#swarm-job-type').select_option('status')
        assert not page.locator('#swarm-settings-field').is_visible()
        page.locator('#swarm-job-submit').click()
        expect(page.locator('#swarm-job-feedback')).to_have_attribute('data-state','success')
        expect(page.locator('#swarm-job-status')).to_contain_text('RenderRig')
        page.locator('#swarm-job-show-queue').click()
        assert page.locator('#cluster-view-results').is_visible()
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
        page.locator('#cluster-view-tab-research').click()
        page.locator('#workspace-brief').fill('Compare repair tools')
        page.locator('#workspace-questions').fill('Socket designs\n\nTorque wrench calibration')
        page.locator('#workspace-workers').select_option('2')
        spec=json.loads(page.locator('#workspace-json').input_value())
        assert spec=={'brief':'Compare repair tools','tasks':['Socket designs','Torque wrench calibration'],'workers':2}
        page.reload(wait_until='load')
        expect(page.locator('#workspace-brief')).to_have_value('Compare repair tools')
        page.get_by_text('Advanced research settings · JSON',exact=True).click()
        page.locator('#workspace-json').fill('{bad')
        page.locator('#workspace-run').click()
        expect(page.locator('#workspace-form-error')).not_to_have_text('')
        page.locator('#workspace-json').fill(json.dumps(spec))
        expect(page.locator('#workspace-questions')).to_have_value('Socket designs\nTorque wrench calibration')
        page.locator('#workspace-run').click()
        expect(page.locator('#workspace-state')).to_contain_text('Compare repair tools')
        research=page.evaluate('JSON.parse(localStorage.getItem("curt-swarm-workspace-v1"))')
        assert len(research['tasks'])==2 and all(t['status']=='queued' for t in research['tasks'])
        first,second=research['tasks']
        source={'title':'Socket wrench','url':'https://en.wikipedia.org/wiki/Socket_wrench','excerpt':'A socket wrench uses replaceable sockets.'}
        DATA['results']=[{'job_id':first['job_id'],'device_id':first['worker'],'exit_code':0,'stdout':json.dumps({'kind':'research-sources','query':first['query'],'sources':[source]})},{'job_id':second['job_id'],'device_id':second['worker'],'exit_code':1,'stdout':json.dumps({'kind':'research-error','error':'Fixture source service unavailable'})}]
        page.reload(wait_until='load')
        expect(page.locator('#workspace-state')).to_contain_text('1/2 completed · 1 failed')
        page.get_by_text('Collected source evidence',exact=True).click()
        expect(page.locator('#workspace-report')).to_contain_text('Socket wrench')
        expect(page.locator('#workspace-report')).to_contain_text('Fixture source service unavailable')
        assert page.locator('#workspace-report a').get_attribute('href')==source['url']
        page.locator('#research-coverage-0').select_option('partial')
        page.locator('#research-notes-0').fill('Definition supported; design comparison still unanswered.')
        page.get_by_role('button',name='Save coverage review',exact=True).first.click()
        DATA['results']=[]
        page.reload(wait_until='load')
        expect(page.locator('#workspace-state')).to_contain_text('1/2 completed · 1 failed')
        page.locator('#workspace-export').click()
        collected=json.loads(page.get_by_role('textbox',name='Combined report JSON',exact=True).input_value())
        report_text=page.get_by_role('textbox',name='Research report',exact=True).input_value()
        assert 'Coverage: unreviewed' in report_text and 'Coverage: partial' in report_text
        assert 'design comparison still unanswered' in report_text
        assert collected['tasks'][0]['report']['sources'][0]==source
        assert collected['tasks'][1]['status']=='failed'
        page.locator('#workspace-retry').click()
        expect(page.locator('#workspace-report')).to_contain_text('queued · attempt 2')
        retried=page.evaluate('JSON.parse(localStorage.getItem("curt-swarm-workspace-v1"))')
        assert retried['tasks'][0]['job_id']==first['job_id']
        assert retried['tasks'][1]['attempts']==2 and retried['tasks'][1]['status']=='queued'
        assert retried['tasks'][1]['job_id']!=second['job_id']
        page.get_by_text('Collected source evidence',exact=True).click()
        if width==390:
            page.screenshot(path=os.environ.get('RESEARCH_SCREENSHOT','research-form-test.png'),full_page=True)
        batch={'http_batch':'audit-v1-fixture','browser_batch':'browser-audit-v1-fixture','settings':{'paths':['/'],'browser_workers':[]},'tasks':[{'job_id':'audit-v1-fixture-0','worker':'phone173','status':'queued'}]}
        DATA['results']=[{'job_id':'audit-v1-fixture-0','device_id':'phone173','exit_code':0,'stdout':json.dumps({'kind':'website-audit','page':{'url':'https://curtbrag.com/','title':'Saved evidence fixture','issues':[]}})}]
        page.evaluate('(batch)=>localStorage.setItem("curt-website-audit-batch-v1",JSON.stringify(batch))',batch)
        page.reload(wait_until='load')
        page.locator('#cluster-view-tab-audit').click()
        expect(page.locator('#cluster-audit-state')).to_contain_text('1 / 1 page reports')
        assert len(page.evaluate('JSON.parse(localStorage.getItem("curt-website-audit-batch-v1")).reports'))==1
        DATA['results']=[]
        page.reload(wait_until='load')
        expect(page.locator('#cluster-audit-state')).to_contain_text('1 / 1 page reports')
        page.get_by_role('button',name='Build fix plan',exact=True).click()
        expect(page.locator('#cluster-audit-plan')).to_contain_text('no-detected-fixes')
        page.locator('#cluster-audit-export').click()
        exported=json.loads(page.locator('#cluster-audit-export-panel textarea').input_value())
        assert exported['reports'][0]['title']=='Saved evidence fixture'
        if width==390:
            page.screenshot(path=os.environ.get('AUDIT_SCREENSHOT','audit-evidence-test.png'),full_page=True)
        assert not errors,errors
        context.close()
    browser.close()
print(json.dumps({'kind':'dashboard-controls-smoke','fixture_api':True,'passed':True,'checks':checks,'form_feedback':True,'queue_shortcut':True,'form_preserved':True,'keyboard_tabs':True,'reload_restored_view':True}))
