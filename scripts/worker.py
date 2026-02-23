#!/usr/bin/env python3
"""
Phone Cluster Worker — Redis-based job executor
Runs on each phone node, pulls jobs from Redis, executes them, pushes results.

Job queues:
  jobs:shell     — Shell command execution
  jobs:whisper   — Audio transcription (whisper.cpp)
  jobs:llm       — LLM inference (llama.cpp)
  jobs:generic   — Any command with JSON payload

Result queues:
  results:<type> — Results from each job type
  results:log    — Execution log entries

Usage:
  python3 worker.py                        # Default: all queues
  python3 worker.py --queues shell         # Shell jobs only
  python3 worker.py --queues whisper,llm   # AI jobs only
  REDIS_HOST=10.0.0.1 python3 worker.py   # Custom Redis host
"""

import json
import os
import signal
import socket
import subprocess
import sys
import time

# Redis connection — try native redis module, fall back to socket-based client
try:
    import redis
    HAS_REDIS_MODULE = True
except ImportError:
    HAS_REDIS_MODULE = False

# ── Configuration ─────────────────────────────────────────────────────────────

REDIS_HOST = os.environ.get("REDIS_HOST", "10.0.0.1")
REDIS_PORT = int(os.environ.get("REDIS_PORT", "6379"))
NODE_NAME = os.environ.get("NODE_NAME", socket.gethostname())
WORKER_QUEUES = os.environ.get("WORKER_QUEUES", "shell,whisper,llm,generic").split(",")

# AI binary paths
WHISPER_BIN = os.environ.get("WHISPER_BIN", "/home/user/whisper.cpp/main")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "/home/user/whisper.cpp/models/ggml-base.bin")
LLAMA_BIN = os.environ.get("LLAMA_BIN", "/home/user/llama.cpp/llama-cli")
LLAMA_MODEL = os.environ.get("LLAMA_MODEL", "/home/user/llama.cpp/models/model.gguf")

# Safety
MAX_CMD_TIMEOUT = 300  # 5 min max per job
DANGEROUS_PATTERNS = [
    "rm -rf /", "mkfs", "dd if=", "> /dev/sd", ":(){ :", "chmod -R 777 /",
    "wget|sh", "curl|sh", "wget|bash", "curl|bash",
]

running = True


def signal_handler(sig, frame):
    global running
    running = False
    log("Shutting down...")


signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)


def log(msg):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] [{NODE_NAME}] {msg}", flush=True)


# ── Minimal Redis client (no dependencies) ────────────────────────────────────

class MinimalRedis:
    """Socket-based Redis client for environments without the redis-py package."""

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
            cmd += f"${len(s)}\r\n{s}\r\n"
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

    def blpop(self, keys, timeout=0):
        if isinstance(keys, str):
            keys = [keys]
        self.sock.settimeout(timeout + 5 if timeout else None)
        self._send("BLPOP", *keys, str(timeout))
        result = self._read_response()
        if result and len(result) == 2:
            return (result[0].encode(), result[1].encode())
        return None

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

    def ping(self):
        self._send("PING")
        return self._read_response()

    def close(self):
        if self.sock:
            self.sock.close()


# ── Connect to Redis ──────────────────────────────────────────────────────────

def get_redis():
    if HAS_REDIS_MODULE:
        return redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=False)
    else:
        return MinimalRedis(REDIS_HOST, REDIS_PORT)


def is_dangerous(cmd):
    cmd_lower = cmd.lower()
    for pattern in DANGEROUS_PATTERNS:
        if pattern in cmd_lower:
            return True
    return False


# ── Job handlers ──────────────────────────────────────────────────────────────

def handle_shell(task_data):
    """Execute a shell command and return output."""
    cmd = task_data if isinstance(task_data, str) else task_data.get("cmd", "")
    if not cmd:
        return {"status": "error", "error": "empty command"}
    if is_dangerous(cmd):
        return {"status": "error", "error": f"blocked dangerous command: {cmd[:50]}"}

    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True,
            timeout=MAX_CMD_TIMEOUT
        )
        return {
            "status": "ok",
            "stdout": result.stdout[:10000],
            "stderr": result.stderr[:2000],
            "returncode": result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"status": "error", "error": f"timeout after {MAX_CMD_TIMEOUT}s"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def handle_whisper(task_data):
    """Transcribe audio using whisper.cpp."""
    if isinstance(task_data, str):
        task_data = {"file": task_data}

    audio_file = task_data.get("file", "")
    model = task_data.get("model", WHISPER_MODEL)
    language = task_data.get("language", "en")

    if not os.path.isfile(WHISPER_BIN):
        return {"status": "error", "error": f"whisper binary not found: {WHISPER_BIN}"}
    if not os.path.isfile(audio_file):
        return {"status": "error", "error": f"audio file not found: {audio_file}"}
    if not os.path.isfile(model):
        return {"status": "error", "error": f"model not found: {model}"}

    try:
        result = subprocess.run(
            [WHISPER_BIN, "-m", model, "-f", audio_file, "-l", language, "--no-timestamps"],
            capture_output=True, text=True, timeout=MAX_CMD_TIMEOUT
        )
        # whisper.cpp outputs transcription to stdout
        transcript = result.stdout.strip()
        return {
            "status": "ok",
            "transcript": transcript,
            "file": audio_file,
            "model": os.path.basename(model),
        }
    except subprocess.TimeoutExpired:
        return {"status": "error", "error": f"transcription timeout ({MAX_CMD_TIMEOUT}s)"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def handle_llm(task_data):
    """Run LLM inference using llama.cpp."""
    if isinstance(task_data, str):
        task_data = {"prompt": task_data}

    prompt = task_data.get("prompt", "")
    model = task_data.get("model", LLAMA_MODEL)
    max_tokens = task_data.get("max_tokens", 256)
    temperature = task_data.get("temperature", 0.7)

    if not os.path.isfile(LLAMA_BIN):
        return {"status": "error", "error": f"llama binary not found: {LLAMA_BIN}"}
    if not os.path.isfile(model):
        return {"status": "error", "error": f"model not found: {model}"}
    if not prompt:
        return {"status": "error", "error": "empty prompt"}

    try:
        result = subprocess.run(
            [LLAMA_BIN, "-m", model, "-p", prompt,
             "-n", str(max_tokens), "--temp", str(temperature),
             "--no-display-prompt"],
            capture_output=True, text=True, timeout=MAX_CMD_TIMEOUT
        )
        return {
            "status": "ok",
            "response": result.stdout.strip(),
            "model": os.path.basename(model),
            "tokens": max_tokens,
        }
    except subprocess.TimeoutExpired:
        return {"status": "error", "error": f"inference timeout ({MAX_CMD_TIMEOUT}s)"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def handle_generic(task_data):
    """Handle generic JSON jobs with a command field."""
    if isinstance(task_data, str):
        try:
            task_data = json.loads(task_data)
        except json.JSONDecodeError:
            return handle_shell(task_data)

    job_type = task_data.get("type", "shell")
    if job_type == "whisper":
        return handle_whisper(task_data)
    elif job_type == "llm":
        return handle_llm(task_data)
    else:
        return handle_shell(task_data.get("cmd", ""))


HANDLERS = {
    "shell": handle_shell,
    "whisper": handle_whisper,
    "llm": handle_llm,
    "generic": handle_generic,
}


# ── Main loop ─────────────────────────────────────────────────────────────────

def main():
    log(f"Starting worker on {NODE_NAME}")
    log(f"Redis: {REDIS_HOST}:{REDIS_PORT}")
    log(f"Queues: {', '.join(WORKER_QUEUES)}")

    # Parse CLI args
    queues = WORKER_QUEUES
    for i, arg in enumerate(sys.argv[1:], 1):
        if arg == "--queues" and i < len(sys.argv):
            queues = sys.argv[i + 1].split(",")

    queue_keys = [f"jobs:{q.strip()}" for q in queues]
    log(f"Listening on: {', '.join(queue_keys)}")

    r = None
    backoff = 1
    jobs_done = 0

    while running:
        # Connect/reconnect to Redis
        if r is None:
            try:
                r = get_redis()
                pong = r.ping()
                log(f"Connected to Redis ({pong})")
                backoff = 1

                # Register this worker
                worker_info = json.dumps({
                    "node": NODE_NAME,
                    "queues": queues,
                    "pid": os.getpid(),
                    "started": time.strftime("%Y-%m-%dT%H:%M:%S"),
                })
                r.set(f"worker:{NODE_NAME}", worker_info)

            except Exception as e:
                log(f"Redis connection failed: {e} (retry in {backoff}s)")
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)
                continue

        # Pull next job (blocking, 5s timeout)
        try:
            result = r.blpop(queue_keys, timeout=5)
            if result is None:
                # Heartbeat
                r.set(f"worker:{NODE_NAME}:heartbeat", str(int(time.time())))
                continue

            queue_name = result[0].decode() if isinstance(result[0], bytes) else result[0]
            raw_task = result[1].decode() if isinstance(result[1], bytes) else result[1]
            job_type = queue_name.replace("jobs:", "")

            log(f"Job [{job_type}]: {raw_task[:100]}...")

            # Track active job
            r.set(f"worker:{NODE_NAME}:active", json.dumps({
                "type": job_type, "task": raw_task[:200], "started": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }))

            # Parse task data
            try:
                task_data = json.loads(raw_task)
            except (json.JSONDecodeError, TypeError):
                task_data = raw_task

            # Execute
            start_time = time.time()
            handler = HANDLERS.get(job_type, handle_generic)
            job_result = handler(task_data)
            elapsed = round(time.time() - start_time, 2)

            # Enrich result
            job_result["node"] = NODE_NAME
            job_result["type"] = job_type
            job_result["elapsed_seconds"] = elapsed
            job_result["timestamp"] = time.strftime("%Y-%m-%dT%H:%M:%S")

            # Push result
            r.rpush(f"results:{job_type}", json.dumps(job_result))
            r.rpush("results:log", json.dumps(job_result))

            # Update stats
            jobs_done += 1
            r.set(f"worker:{NODE_NAME}:active", "")
            r.incr(f"stats:{NODE_NAME}:jobs_done")
            r.incr(f"stats:total:jobs_done")

            status = job_result.get("status", "unknown")
            log(f"Done [{job_type}] → {status} ({elapsed}s) | total: {jobs_done}")

        except (ConnectionError, BrokenPipeError, OSError) as e:
            log(f"Redis connection lost: {e}")
            r = None
            backoff = 1
        except Exception as e:
            log(f"Error processing job: {e}")
            time.sleep(1)

    # Cleanup
    if r:
        try:
            r.set(f"worker:{NODE_NAME}:active", "")
            if hasattr(r, 'close'):
                r.close()
        except Exception:
            pass

    log(f"Worker stopped. Jobs completed: {jobs_done}")


if __name__ == "__main__":
    main()
