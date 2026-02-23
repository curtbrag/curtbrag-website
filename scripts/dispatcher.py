#!/usr/bin/env python3
"""
Cluster AI Dispatcher — watches ~/cluster/inbox and creates jobs automatically.

Runs on NEXUS-PRIME (or any machine with Redis access).
Watches the inbox folder for new files, determines job type by extension,
creates structured jobs, and pushes them to Redis queues on the phone cluster.

Folder layout:
  ~/cluster/inbox/    ← Drop files here
  ~/cluster/work/     ← Files being processed (moved from inbox)
  ~/cluster/done/     ← Originals after processing
  ~/cluster/results/  ← Output files (transcripts, webp, summaries, etc.)
  ~/cluster/logs/     ← Dispatcher + worker logs
  ~/cluster/models/   ← Shared AI models (whisper, llama)

Usage:
  python3 dispatcher.py                          # Watch ~/cluster/inbox
  python3 dispatcher.py --inbox /path/to/inbox   # Custom inbox
  python3 dispatcher.py --once                   # Process inbox once, then exit
  REDIS_HOST=10.0.0.1 python3 dispatcher.py      # Custom Redis host
"""

import hashlib
import json
import os
import shutil
import signal
import socket
import sys
import time

# ── Configuration ─────────────────────────────────────────────────────────────

REDIS_HOST = os.environ.get("REDIS_HOST", "10.0.0.1")
REDIS_PORT = int(os.environ.get("REDIS_PORT", "6379"))

BASE_DIR = os.environ.get("CLUSTER_DIR", os.path.expanduser("~/cluster"))
INBOX = os.environ.get("CLUSTER_INBOX", os.path.join(BASE_DIR, "inbox"))
WORK = os.path.join(BASE_DIR, "work")
DONE = os.path.join(BASE_DIR, "done")
RESULTS = os.path.join(BASE_DIR, "results")
LOGS = os.path.join(BASE_DIR, "logs")

POLL_INTERVAL = int(os.environ.get("DISPATCH_INTERVAL", "3"))

# File type → pipeline mapping
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff", ".tif", ".webp", ".heic", ".heif", ".avif"}
AUDIO_EXTS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".wma", ".opus"}
VIDEO_EXTS = {".mp4", ".mkv", ".avi", ".mov", ".webm", ".flv", ".wmv", ".m4v", ".ts"}
TEXT_EXTS = {".txt", ".md", ".html", ".htm", ".csv", ".json", ".xml", ".log", ".rst"}
DOC_EXTS = {".pdf", ".doc", ".docx", ".rtf", ".odt"}

running = True


def signal_handler(sig, frame):
    global running
    running = False
    log("Shutting down dispatcher...")


signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)


def log(msg):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] [dispatcher] {msg}"
    print(line, flush=True)
    try:
        os.makedirs(LOGS, exist_ok=True)
        with open(os.path.join(LOGS, "dispatcher.log"), "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


# ── Minimal Redis client (same as worker.py — no dependencies) ───────────────

class MinimalRedis:
    def __init__(self, host, port):
        self.host = host
        self.port = port
        self.sock = None
        self._connect()

    def _connect(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.settimeout(10)
        self.sock.connect((self.host, self.port))

    def _send(self, *args):
        cmd = f"*{len(args)}\r\n"
        for a in args:
            s = str(a)
            cmd += f"${len(s.encode())}\r\n{s}\r\n"
        self.sock.sendall(cmd.encode())

    def _read_line(self):
        buf = b""
        while not buf.endswith(b"\r\n"):
            chunk = self.sock.recv(1)
            if not chunk:
                raise ConnectionError("Redis connection closed")
            buf += chunk
        return buf[:-2].decode()

    def _read_response(self):
        line = self._read_line()
        if line.startswith("+"):
            return line[1:]
        elif line.startswith("-"):
            raise Exception(f"Redis error: {line[1:]}")
        elif line.startswith(":"):
            return int(line[1:])
        elif line.startswith("$"):
            length = int(line[1:])
            if length == -1:
                return None
            data = b""
            while len(data) < length + 2:
                data += self.sock.recv(length + 2 - len(data))
            return data[:-2].decode()
        elif line.startswith("*"):
            count = int(line[1:])
            if count == -1:
                return None
            return [self._read_response() for _ in range(count)]
        return line

    def lpush(self, key, *values):
        self._send("LPUSH", key, *values)
        return self._read_response()

    def rpush(self, key, *values):
        self._send("RPUSH", key, *values)
        return self._read_response()

    def set(self, key, value):
        self._send("SET", key, value)
        return self._read_response()

    def get(self, key):
        self._send("GET", key)
        return self._read_response()

    def incr(self, key):
        self._send("INCR", key)
        return self._read_response()

    def llen(self, key):
        self._send("LLEN", key)
        return self._read_response()

    def ping(self):
        self._send("PING")
        return self._read_response()

    def close(self):
        if self.sock:
            self.sock.close()


# ── Try redis-py first, fall back to socket client ───────────────────────────

try:
    import redis as redis_module
    HAS_REDIS = True
except ImportError:
    HAS_REDIS = False


def get_redis():
    if HAS_REDIS:
        return redis_module.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
    return MinimalRedis(REDIS_HOST, REDIS_PORT)


# ── Job creation ─────────────────────────────────────────────────────────────

def file_hash(path):
    """Quick hash for dedup."""
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()[:12]


def make_job_id(filename):
    ts = int(time.time())
    return f"{ts}-{filename.replace(' ', '_')}"


def classify_file(filename):
    """Determine pipeline type from file extension."""
    ext = os.path.splitext(filename)[1].lower()
    if ext in IMAGE_EXTS:
        return "image"
    elif ext in AUDIO_EXTS:
        return "audio"
    elif ext in VIDEO_EXTS:
        return "video"
    elif ext in TEXT_EXTS:
        return "text"
    elif ext in DOC_EXTS:
        return "document"
    return "unknown"


def create_image_jobs(filepath, filename, job_id):
    """Create jobs for image pipeline: resize + webp + alt-text."""
    base = os.path.splitext(filename)[0]
    results_dir = os.path.join(RESULTS, "images")
    return [
        {
            "queue": "jobs:image",
            "payload": {
                "id": f"{job_id}-resize",
                "type": "image_resize",
                "input": filepath,
                "output": os.path.join(results_dir, f"{base}-2000.jpg"),
                "max_dimension": 2000,
                "quality": 85,
                "strip_metadata": True,
            },
        },
        {
            "queue": "jobs:image",
            "payload": {
                "id": f"{job_id}-webp",
                "type": "image_webp",
                "input": filepath,
                "output": os.path.join(results_dir, f"{base}.webp"),
                "quality": 82,
                "strip_metadata": True,
            },
        },
        {
            "queue": "jobs:image",
            "payload": {
                "id": f"{job_id}-alttext",
                "type": "image_alttext",
                "input": filepath,
                "output": os.path.join(results_dir, f"{base}-alttext.txt"),
            },
        },
    ]


def create_audio_jobs(filepath, filename, job_id):
    """Create jobs for audio pipeline: wav conversion + transcription."""
    base = os.path.splitext(filename)[0]
    results_dir = os.path.join(RESULTS, "audio")
    wav_path = os.path.join(WORK, f"{base}.wav")
    return [
        {
            "queue": "jobs:audio",
            "payload": {
                "id": f"{job_id}-wav",
                "type": "audio_to_wav",
                "input": filepath,
                "output": wav_path,
            },
        },
        {
            "queue": "jobs:whisper",
            "payload": {
                "id": f"{job_id}-transcribe",
                "type": "whisper",
                "file": wav_path,
                "output_txt": os.path.join(results_dir, f"{base}.txt"),
                "output_vtt": os.path.join(results_dir, f"{base}.vtt"),
                "depends_on": f"{job_id}-wav",
            },
        },
    ]


def create_video_jobs(filepath, filename, job_id):
    """Create jobs for video pipeline: extract audio + transcribe + thumbnail."""
    base = os.path.splitext(filename)[0]
    audio_results = os.path.join(RESULTS, "audio")
    image_results = os.path.join(RESULTS, "images")
    wav_path = os.path.join(WORK, f"{base}.wav")
    return [
        {
            "queue": "jobs:audio",
            "payload": {
                "id": f"{job_id}-extract",
                "type": "video_extract_audio",
                "input": filepath,
                "output": wav_path,
            },
        },
        {
            "queue": "jobs:whisper",
            "payload": {
                "id": f"{job_id}-transcribe",
                "type": "whisper",
                "file": wav_path,
                "output_txt": os.path.join(audio_results, f"{base}.txt"),
                "output_vtt": os.path.join(audio_results, f"{base}.vtt"),
                "depends_on": f"{job_id}-extract",
            },
        },
        {
            "queue": "jobs:image",
            "payload": {
                "id": f"{job_id}-thumb",
                "type": "video_thumbnail",
                "input": filepath,
                "output": os.path.join(image_results, f"{base}-thumb.jpg"),
                "timestamp": "00:00:03",
            },
        },
    ]


def create_text_jobs(filepath, filename, job_id):
    """Create jobs for text pipeline: summarize + SEO + cleanup."""
    base = os.path.splitext(filename)[0]
    results_dir = os.path.join(RESULTS, "text")
    return [
        {
            "queue": "jobs:llm",
            "payload": {
                "id": f"{job_id}-summarize",
                "type": "text_summarize",
                "input": filepath,
                "output": os.path.join(results_dir, f"{base}-summary.md"),
            },
        },
        {
            "queue": "jobs:llm",
            "payload": {
                "id": f"{job_id}-seo",
                "type": "text_seo",
                "input": filepath,
                "output": os.path.join(results_dir, f"{base}-seo.json"),
            },
        },
    ]


PIPELINE_MAP = {
    "image": create_image_jobs,
    "audio": create_audio_jobs,
    "video": create_video_jobs,
    "text": create_text_jobs,
    "document": create_text_jobs,  # Same pipeline for now
}


# ── Main dispatcher loop ────────────────────────────────────────────────────

def ensure_dirs():
    for d in [INBOX, WORK, DONE, RESULTS, LOGS,
              os.path.join(RESULTS, "images"),
              os.path.join(RESULTS, "audio"),
              os.path.join(RESULTS, "text")]:
        os.makedirs(d, exist_ok=True)


def process_inbox(r):
    """Scan inbox, create jobs, move files to work/."""
    files = []
    try:
        files = sorted(os.listdir(INBOX))
    except OSError as e:
        log(f"Cannot read inbox: {e}")
        return 0

    if not files:
        return 0

    jobs_created = 0
    for filename in files:
        filepath = os.path.join(INBOX, filename)

        # Skip directories, hidden files, partial uploads
        if os.path.isdir(filepath):
            continue
        if filename.startswith("."):
            continue

        file_type = classify_file(filename)
        if file_type == "unknown":
            log(f"Skipping unknown file type: {filename}")
            continue

        job_id = make_job_id(filename)
        pipeline_fn = PIPELINE_MAP.get(file_type)
        if not pipeline_fn:
            continue

        # Move to work/
        work_path = os.path.join(WORK, filename)
        try:
            shutil.move(filepath, work_path)
        except OSError as e:
            log(f"Cannot move {filename} to work/: {e}")
            continue

        # Create jobs
        jobs = pipeline_fn(work_path, filename, job_id)
        for job in jobs:
            queue = job["queue"]
            payload = json.dumps(job["payload"])
            r.lpush(queue, payload)
            jobs_created += 1

        # Track the batch
        batch_info = json.dumps({
            "id": job_id,
            "file": filename,
            "type": file_type,
            "jobs": len(jobs),
            "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
        })
        r.rpush("dispatch:log", batch_info)
        r.incr("stats:total:dispatched")

        log(f"Dispatched {filename} → {file_type} pipeline ({len(jobs)} jobs)")

    return jobs_created


def main():
    # Parse CLI args
    one_shot = False
    for i, arg in enumerate(sys.argv[1:], 1):
        if arg == "--inbox" and i < len(sys.argv):
            global INBOX
            INBOX = sys.argv[i + 1]
        elif arg == "--once":
            one_shot = True
        elif arg in ("-h", "--help"):
            print(__doc__)
            sys.exit(0)

    ensure_dirs()

    log(f"Dispatcher starting")
    log(f"  Inbox:   {INBOX}")
    log(f"  Work:    {WORK}")
    log(f"  Results: {RESULTS}")
    log(f"  Redis:   {REDIS_HOST}:{REDIS_PORT}")

    r = None
    backoff = 1

    while running:
        # Connect to Redis
        if r is None:
            try:
                r = get_redis()
                r.ping()
                log(f"Connected to Redis at {REDIS_HOST}:{REDIS_PORT}")
                backoff = 1
            except Exception as e:
                log(f"Redis connection failed: {e} (retry in {backoff}s)")
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)
                continue

        try:
            jobs = process_inbox(r)
            if jobs > 0:
                log(f"Created {jobs} jobs this cycle")
        except (ConnectionError, BrokenPipeError, OSError) as e:
            log(f"Redis lost: {e}")
            r = None
            backoff = 1
            continue
        except Exception as e:
            log(f"Error: {e}")

        if one_shot:
            break

        time.sleep(POLL_INTERVAL)

    log("Dispatcher stopped")


if __name__ == "__main__":
    main()
