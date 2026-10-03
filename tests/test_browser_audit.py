import importlib.util
import unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('audit',Path(__file__).resolve().parents[1]/'scripts/cluster-browser-audit.py')
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)

class AuditTests(unittest.TestCase):
    def test_public_scope(self):
        self.assertEqual(audit.page_url('/shop/'),'https://curtbrag.com/shop/')
        for path in ['//evil.com/','/../private','/x?token=secret']:
            with self.assertRaises(ValueError):audit.page_url(path)
        self.assertFalse(audit.allowed_request('http://192.168.1.1/','GET'))
        self.assertFalse(audit.allowed_request('https://curtbrag.com/api/contact','POST'))
        self.assertFalse(audit.allowed_request('https://fonts.googleapis.com/a','GET',True))
        self.assertTrue(audit.allowed_request('https://curtbrag.com/shop/','GET',True))
    def test_evidence_and_proposals(self):
        metrics={'overflow_px':20,'overflow_elements':['div#wide'],'broken_images':['/missing.png']}
        results=audit.suggestions(metrics,['ReferenceError: missing'])
        self.assertEqual([r['check'] for r in results],['horizontal-overflow','broken-images','javascript-error'])
        self.assertTrue(all(r['evidence'] and r['proposal'] for r in results))
        self.assertEqual(audit.suggestions({'overflow_px':0,'overflow_elements':[],'broken_images':[]},[]),[])

if __name__=='__main__':unittest.main()
