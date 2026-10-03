import importlib.util,json,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('worker',Path(__file__).resolve().parents[1]/'scripts/cluster-research.py')
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
class EvidenceTests(unittest.TestCase):
    def test_article_passages_and_metadata(self):
        def api(params):
            if 'list' in params:return {'query':{'search':[{'title':'Example','snippet':'Misleading search snippet'}]}}
            return {'query':{'pages':[{'title':'Example','extract':'Evidence sentence. '*100,'lastrevid':123}]}}
        result=worker.research('Question',api)
        self.assertEqual(result['coverage'],'unreviewed')
        source=result['sources'][0]
        self.assertNotIn('Misleading',source['excerpt'])
        self.assertEqual(source['revision_id'],123)
        self.assertTrue(source['retrieved_at'])
        self.assertTrue(source['excerpt'].endswith('.'))
        self.assertLessEqual(len(json.dumps(result,ensure_ascii=False).encode()),3800)
    def test_missing_article_is_a_gap(self):
        result=worker.research('Question',lambda p:{'query':{'search':[{'title':'Missing'}]}} if 'list' in p else {'query':{'pages':[{'missing':True}]}})
        self.assertEqual(result['sources'],[])
        self.assertIn('Missing',result['gaps'][0])
    def test_invalid_query(self):
        for query in ['',None,'x'*241]:
            with self.assertRaises(ValueError):worker.research(query)
if __name__=='__main__':unittest.main()
