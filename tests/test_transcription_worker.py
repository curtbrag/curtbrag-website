import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('transcriber', Path(__file__).resolve().parents[1] / 'scripts/cluster-transcribe.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class TranscriptionWorkerTest(unittest.TestCase):
    def test_transcript_outputs_are_complete_and_keep_timing(self):
        class Model:
            def __init__(self, name, **options):
                self.test_options = options
                assert options['local_files_only'] is True
                assert options['device'] == 'cpu'

            def transcribe(self, source, **options):
                rows = iter([types.SimpleNamespace(start=0.25, end=2.5, text=' Check the socket. '),
                             types.SimpleNamespace(start=3, end=6.01, text=' Seat it fully. ')])
                return rows, types.SimpleNamespace(language='en', duration=7)

        with tempfile.TemporaryDirectory() as folder, patch.dict(sys.modules, {'faster_whisper':types.SimpleNamespace(WhisperModel=Model)}):
            root = Path(folder)
            result = worker.transcribe(root/'clip.mp4', root/'out', 'small.en', root/'cache')
            self.assertEqual(result['segments'], 2)
            self.assertEqual(Path(result['files']['txt']).read_text(), 'Check the socket.\nSeat it fully.\n')
            self.assertIn('00:00:00,250 --> 00:00:02,500', Path(result['files']['srt']).read_text())
            data = json.loads(Path(result['files']['json']).read_text())
            self.assertEqual(data['segments'][1]['end'], 6.01)
            self.assertEqual(data['language'], 'en')
            with self.assertRaises(FileExistsError):
                worker.transcribe(root/'clip.mp4', root/'out', 'small.en', root/'cache')
            self.assertEqual(Path(result['files']['txt']).read_text(), 'Check the socket.\nSeat it fully.\n')


if __name__ == '__main__':
    unittest.main()
