#!/usr/bin/env python3
"""Transcribe local media with a prepared local faster-whisper model."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys


def timestamp(seconds):
    millis = max(0, round(seconds * 1000))
    hours, millis = divmod(millis, 3600000)
    minutes, millis = divmod(millis, 60000)
    seconds, millis = divmod(millis, 1000)
    return f'{hours:02}:{minutes:02}:{seconds:02},{millis:03}'


def transcribe(source, output_dir, model_name, model_cache):
    from faster_whisper import WhisperModel
    output_dir.mkdir(parents=True, exist_ok=True)
    paths = {kind: output_dir / (source.stem + '.' + kind) for kind in ('txt', 'json', 'srt')}
    if any(path.exists() for path in paths.values()):
        raise FileExistsError('Transcript output already exists; choose a new output directory.')
    model = WhisperModel(model_name, device='cpu', compute_type='int8',
                         download_root=str(model_cache), local_files_only=True, cpu_threads=4)
    segments, info = model.transcribe(str(source), beam_size=5, vad_filter=True,
                                      condition_on_previous_text=False)
    rows = [{'start':s.start, 'end':s.end, 'text':s.text.strip()} for s in segments]
    text = '\n'.join(row['text'] for row in rows)
    result = {'source':str(source), 'model':model_name, 'device':'cpu',
              'compute_type':'int8', 'language':info.language, 'duration':info.duration,
              'segments':rows, 'text':text}
    paths['txt'].write_text(text + '\n', encoding='utf-8')
    paths['json'].write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    subtitles = '\n\n'.join(f"{i}\n{timestamp(row['start'])} --> {timestamp(row['end'])}\n{row['text']}"
                            for i, row in enumerate(rows, 1))
    paths['srt'].write_text(subtitles + '\n', encoding='utf-8')
    return {'ok':True, 'model':model_name, 'device':'cpu', 'language':info.language,
            'duration':info.duration, 'segments':len(rows), 'text':text[:1800],
            'files':{kind:str(path) for kind,path in paths.items()}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--model', choices=('tiny.en','base.en','small.en'), default='small.en')
    parser.add_argument('--model-cache', type=Path, default=Path(__file__).resolve().parent / 'transcription-models')
    args = parser.parse_args()
    source = args.input.expanduser().resolve()
    if not source.is_file():
        parser.error('Input must be an existing local media file.')
    if importlib.util.find_spec('faster_whisper') is None:
        prepared = Path(__file__).resolve().parent / 'transcription-venv' / 'Scripts' / 'python.exe'
        if not prepared.is_file() or prepared.resolve() == Path(sys.executable).resolve():
            parser.error('Local transcription environment is missing. Prepare faster-whisper first.')
        result = subprocess.run([str(prepared), str(Path(__file__).resolve()), *sys.argv[1:]],
                                capture_output=True, text=True, encoding='utf-8',
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        return result.returncode
    try:
        print(json.dumps(transcribe(source, args.output_dir.expanduser().resolve(), args.model,
                                    args.model_cache.expanduser().resolve()), ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({'ok':False, 'error':str(error)}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
