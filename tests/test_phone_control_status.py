import importlib.util
import pathlib
import subprocess
import unittest
from unittest.mock import Mock

spec=importlib.util.spec_from_file_location('phone_status',pathlib.Path(__file__).resolve().parents[1]/'scripts/cluster-phone-control-status.py')
helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
ENV={'PREFIX':'/data/data/com.termux/files/usr','PATH':'/data/data/com.termux/files/usr/bin'}

class StatusTests(unittest.TestCase):
    def inspect(self, code=1, stdout='', stderr=''):
        run=Mock(return_value=subprocess.CompletedProcess([],code,stdout,stderr))
        return helper.inspect_controls(ENV,run,lambda *a,**k:ENV['PREFIX']+'/bin/am'),run

    def test_missing_permission_is_reported_without_a_real_activity_or_grant(self):
        result,run=self.inspect(stderr='Error: The com.termux app requires the "Display over other apps" permission')
        self.assertEqual(result['permission'],'required')
        self.assertFalse(result['permissions_changed']);self.assertFalse(result['real_activity_requested'])
        args,kwargs=run.call_args
        self.assertEqual(args[0],[ENV['PREFIX']+'/bin/am','start','--user','0','--check-draw-over-apps-permission','-n',helper.PROBE_COMPONENT])
        self.assertFalse(kwargs['shell']);self.assertEqual(kwargs['timeout'],12)
        run.assert_called_once()

    def test_only_expected_nonexistent_component_failure_proves_permission_check_passed(self):
        result,_=self.inspect(stderr='Error: Activity class {'+helper.PROBE_COMPONENT+'} does not exist.')
        self.assertEqual(result['permission'],'allowed');self.assertFalse(result['screen_verified'])
        for stdout in ('Starting: Intent','Permission denial','Other activity does not exist'):
            result,_=self.inspect(0,stdout)
            self.assertEqual(result['permission'],'unknown')

    def test_wrong_platform_or_launcher_is_never_executed(self):
        run=Mock()
        self.assertEqual(helper.inspect_controls({},run)['permission'],'unknown')
        self.assertEqual(helper.inspect_controls(ENV,run,lambda *a,**k:'/system/bin/am')['permission'],'unknown')
        run.assert_not_called()

    def test_timeout_is_unknown_and_never_retried(self):
        run=Mock(side_effect=subprocess.TimeoutExpired('am',12))
        self.assertEqual(helper.inspect_controls(ENV,run,lambda *a,**k:ENV['PREFIX']+'/bin/am')['permission'],'unknown')
        run.assert_called_once()

if __name__=='__main__':unittest.main()
