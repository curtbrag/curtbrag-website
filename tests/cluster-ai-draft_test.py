import copy
import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('worker', Path(__file__).parents[1] / 'scripts/cluster-ai-draft.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class DraftTests(unittest.TestCase):
    def setUp(self):
        self.spec = {'brief': 'Explain batteries', 'sources': [{'id': 'S1', 'title': 'Battery',
            'url': 'https://en.wikipedia.org/wiki/Battery', 'excerpt': 'A battery stores energy.'}]}
        self.output = {'title': 'Battery basics', 'points': [{'text': 'A battery stores energy.', 'sources': ['S1']}],
                       'verification': 'Check the full article before publishing.'}
    def call(self, path, body):
        self.assertEqual(path, '/api/generate')
        self.assertFalse(body['stream'])
        self.assertEqual(body['keep_alive'], 0)
        self.assertIn('untrusted data', body['system'])
        return {'done': True, 'response': json.dumps(self.output)}
    def test_cited_draft(self):
        result = worker.draft(self.spec, self.call)
        self.assertTrue(result['review_required'])
        self.assertEqual(result['source_ids'], ['S1'])
    def test_unknown_source_rejected(self):
        self.output['points'][0]['sources'] = ['S9']
        with self.assertRaises(ValueError): worker.draft(self.spec, self.call)
    def test_missing_citation_rejected(self):
        self.output['points'][0]['sources'] = []
        with self.assertRaises(ValueError): worker.draft(self.spec, self.call)
    def test_incomplete_model_output(self):
        with self.assertRaises(ValueError): worker.draft(self.spec, lambda *_: {'done': False})
    def test_truncated_model_output(self):
        with self.assertRaises(ValueError): worker.draft(self.spec, lambda *_: {'done': True, 'done_reason': 'length'})
    def test_invalid_sources(self):
        for update in [{'id':'S9'}, {'url':'http://localhost/private'}, {'excerpt':'x'*451}]:
            value = copy.deepcopy(self.spec); value['sources'][0].update(update)
            with self.assertRaises(ValueError): worker.validate_spec(value)
    def test_duplicate_sources(self):
        self.spec['sources'] *= 2
        with self.assertRaises(ValueError): worker.validate_spec(self.spec)

if __name__ == '__main__': unittest.main()
