import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, MagicMock

spec=importlib.util.spec_from_file_location('cluster_mail_bridge',Path(__file__).resolve().parents[1]/'scripts/cluster-mail-bridge.py')
bridge=importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.unit={'installed':True,'port':8022,'user':'fixture','host':'192.0.2.1','python':'python'}
        self.job={'id':'test-12345678','unit':'phone253','action':'test'}
        self.inventory={'phone253':self.unit}
        self.devices={'phone253':{'installed':True,'connected':True}}
        self.folder=tempfile.TemporaryDirectory(prefix='mail-bridge-test-',dir=Path(__file__).resolve().parent)
        self.addCleanup(self.folder.cleanup)
        self.root=Path(self.folder.name)
        self.root_patch=patch.object(bridge,'ROOT',self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

    def test_dispatch_ssh_and_probe_both_create_no_console_window(self):
        fake=MagicMock(stdout='{"ok":true}',returncode=0)
        with patch.object(bridge,'NO_WINDOW',0x08000000),patch.object(bridge.subprocess,'run',return_value=fake) as run:
            self.assertTrue(bridge.execute(self.unit,self.job)['ok'])
            self.assertTrue(bridge.inspect(('phone253',self.unit))[1]['connected'])
            self.assertEqual(run.call_count,2)
            for call in run.call_args_list:
                self.assertEqual(call.kwargs['creationflags'],0x08000000)
                self.assertEqual(call.kwargs['stdin'],bridge.subprocess.DEVNULL)
                self.assertTrue(call.kwargs['capture_output'])

    def test_recovery_does_not_reexecute_a_claimed_request(self):
        def interrupted_execute(*args):
            saved=json.loads((self.root/'inflight-request.json').read_text())
            self.assertEqual(saved,self.job)
            raise SystemExit('simulated process exit')
        with patch.object(bridge,'api',side_effect=lambda action,body=None:{'job':self.job} if action=='poll' else {'ok':True}),patch.object(bridge,'execute',side_effect=interrupted_execute):
            with self.assertRaises(SystemExit):bridge.cycle(self.inventory,self.devices)
        with patch.object(bridge,'api',return_value={'ok':True}) as api,patch.object(bridge,'execute') as execute:
            self.assertTrue(bridge.cycle(self.inventory,self.devices))
            execute.assert_not_called()
            self.assertEqual([call.args[0] for call in api.call_args_list],['heartbeat','complete'])
            receipt=api.call_args_list[-1].args[1]
            self.assertEqual(receipt['id'],self.job['id'])
            self.assertTrue(receipt['result']['interrupted'])
            self.assertTrue(receipt['result']['delivery_unconfirmed'])
            self.assertNotIn('accepted',receipt['result'])
        self.assertFalse((self.root/'inflight-request.json').exists())
        self.assertFalse((self.root/'pending-result.json').exists())

    def test_saved_result_wins_over_intent_after_upload_failure(self):
        result={'ok':True,'accepted':True,'delivery_verified':False}
        def api_first(action,body=None):
            if action=='poll':return {'job':self.job}
            if action=='complete':raise OSError('upload unavailable')
            return {'ok':True}
        with patch.object(bridge,'api',side_effect=api_first),patch.object(bridge,'execute',return_value=result) as execute:
            with self.assertRaises(OSError):bridge.cycle(self.inventory,self.devices)
            execute.assert_called_once()
        self.assertTrue((self.root/'inflight-request.json').exists())
        receipt=json.loads((self.root/'pending-result.json').read_text())
        self.assertEqual(receipt['result'],result)
        with patch.object(bridge,'api',return_value={'ok':True}) as api,patch.object(bridge,'execute') as execute:
            bridge.cycle(self.inventory,self.devices)
            execute.assert_not_called()
            self.assertEqual(api.call_args_list[-1].args,('complete',receipt))
        self.assertFalse((self.root/'inflight-request.json').exists())
        self.assertFalse((self.root/'pending-result.json').exists())

    def test_failure_to_save_result_does_not_allow_resend(self):
        real_save=bridge.save_record
        def fail_result(path,value):
            if path.name=='pending-result.json':raise OSError('disk unavailable')
            return real_save(path,value)
        with patch.object(bridge,'api',side_effect=lambda action,body=None:{'job':self.job} if action=='poll' else {'ok':True}),patch.object(bridge,'execute',return_value={'ok':True,'accepted':True}),patch.object(bridge,'save_record',side_effect=fail_result):
            with self.assertRaises(OSError):bridge.cycle(self.inventory,self.devices)
        with patch.object(bridge,'api',return_value={'ok':True}) as api,patch.object(bridge,'execute') as execute:
            bridge.cycle(self.inventory,self.devices)
            execute.assert_not_called()
            self.assertTrue(api.call_args_list[-1].args[1]['result']['interrupted'])

    def test_completion_cleanup_failure_keeps_receipt_for_safe_retry(self):
        bridge.save_record(self.root/'inflight-request.json',self.job)
        receipt={'id':self.job['id'],'result':{'ok':True,'accepted':True}}
        bridge.save_record(self.root/'pending-result.json',receipt)
        original_unlink=Path.unlink
        def fail_intent(path,*args,**kwargs):
            if path.name=='inflight-request.json':raise OSError('cleanup unavailable')
            return original_unlink(path,*args,**kwargs)
        with patch.object(bridge,'api',return_value={'ok':True}),patch.object(Path,'unlink',fail_intent),patch.object(bridge,'execute') as execute:
            with self.assertRaises(OSError):bridge.cycle(self.inventory,self.devices)
            execute.assert_not_called()
        self.assertTrue((self.root/'pending-result.json').exists())
        with patch.object(bridge,'api',return_value={'ok':True}) as api,patch.object(bridge,'execute') as execute:
            bridge.cycle(self.inventory,self.devices)
            execute.assert_not_called()
            self.assertEqual(api.call_args_list[-1].args,('complete',receipt))

    def test_existing_pending_receipt_is_completed_before_polling(self):
        receipt={'id':self.job['id'],'result':{'ok':True,'accepted':True}}
        bridge.save_record(self.root/'pending-result.json',receipt)
        with patch.object(bridge,'api',return_value={'ok':True}) as api,patch.object(bridge,'execute') as execute:
            bridge.cycle(self.inventory,self.devices)
            self.assertEqual([call.args[0] for call in api.call_args_list],['heartbeat','complete'])
            execute.assert_not_called()

    def test_action_never_executes_when_intent_cannot_be_saved(self):
        with patch.object(bridge,'api',side_effect=lambda action,body=None:{'job':self.job} if action=='poll' else {'ok':True}),patch.object(bridge,'save_record',side_effect=OSError('disk unavailable')),patch.object(bridge,'execute') as execute:
            with self.assertRaises(OSError):bridge.cycle(self.inventory,self.devices)
            execute.assert_not_called()

    def test_interrupted_check_does_not_claim_a_send_occurred(self):
        bridge.save_record(self.root/'inflight-request.json',{**self.job,'action':'check'})
        with patch.object(bridge,'api',return_value={'ok':True}) as api,patch.object(bridge,'execute') as execute:
            bridge.cycle(self.inventory,self.devices)
            execute.assert_not_called()
            result=api.call_args_list[-1].args[1]['result']
            self.assertTrue(result['interrupted'])
            self.assertFalse(result['delivery_unconfirmed'])
            self.assertNotIn('sending',result['error'])


if __name__=='__main__':unittest.main()
