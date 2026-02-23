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
WORKER_QUEUES = os.environ.get("WORKER_QUEUES", "shell,whisper,llm,generic,image,audio,web").split(",")

# AI binary paths
WHISPER_BIN = os.environ.get("WHISPER_BIN", "/home/user/whisper.cpp/main")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "/home/user/whisper.cpp/models/ggml-base.bin")
LLAMA_BIN = os.environ.get("LLAMA_BIN", "/home/user/llama.cpp/llama-cli")
LLAMA_MODEL = os.environ.get("LLAMA_MODEL", "/home/user/llama.cpp/models/model.gguf")

# Tool paths (ImageMagick, ffmpeg)
MAGICK_BIN = os.environ.get("MAGICK_BIN", "magick")
FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "ffmpeg")
FFPROBE_BIN = os.environ.get("FFPROBE_BIN", "ffprobe")

# Safety
MAX_CMD_TIMEOUT = 300  # 5 min max per job
MAX_IMAGE_TIMEOUT = 120  # 2 min for image ops
MAX_AUDIO_TIMEOUT = 600  # 10 min for audio/video conversion
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


# ── Image pipeline handlers ──────────────────────────────────────────────────

def ensure_dir(filepath):
    """Create parent directory if it doesn't exist."""
    d = os.path.dirname(filepath)
    if d:
        os.makedirs(d, exist_ok=True)


def has_tool(name):
    """Check if a CLI tool is available."""
    try:
        subprocess.run(["which", name], capture_output=True, timeout=5)
        return True
    except Exception:
        return False


def handle_image(task_data):
    """Route image jobs to the right sub-handler."""
    if isinstance(task_data, str):
        try:
            task_data = json.loads(task_data)
        except json.JSONDecodeError:
            return {"status": "error", "error": "invalid image job payload"}

    job_type = task_data.get("type", "image_resize")

    if job_type == "image_resize":
        return _image_resize(task_data)
    elif job_type == "image_webp":
        return _image_webp(task_data)
    elif job_type == "image_alttext":
        return _image_alttext(task_data)
    elif job_type == "video_thumbnail":
        return _video_thumbnail(task_data)
    else:
        return {"status": "error", "error": f"unknown image job type: {job_type}"}


def _image_resize(task_data):
    """Resize image to max dimension, strip metadata."""
    inp = task_data.get("input", "")
    out = task_data.get("output", "")
    max_dim = task_data.get("max_dimension", 2000)
    quality = task_data.get("quality", 85)
    strip = task_data.get("strip_metadata", True)

    if not os.path.isfile(inp):
        return {"status": "error", "error": f"input not found: {inp}"}

    ensure_dir(out)
    cmd = [MAGICK_BIN, inp]
    if strip:
        cmd.append("-strip")
    cmd.extend(["-resize", f"{max_dim}x{max_dim}>", "-quality", str(quality), out])

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=MAX_IMAGE_TIMEOUT)
        if result.returncode != 0:
            return {"status": "error", "error": result.stderr[:500]}
        size_in = os.path.getsize(inp)
        size_out = os.path.getsize(out) if os.path.exists(out) else 0
        return {
            "status": "ok",
            "output": out,
            "size_before": size_in,
            "size_after": size_out,
            "reduction_pct": round((1 - size_out / max(size_in, 1)) * 100, 1),
        }
    except subprocess.TimeoutExpired:
        return {"status": "error", "error": "image resize timeout"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def _image_webp(task_data):
    """Convert image to WebP format."""
    inp = task_data.get("input", "")
    out = task_data.get("output", "")
    quality = task_data.get("quality", 82)
    strip = task_data.get("strip_metadata", True)

    if not os.path.isfile(inp):
        return {"status": "error", "error": f"input not found: {inp}"}

    ensure_dir(out)
    cmd = [MAGICK_BIN, inp]
    if strip:
        cmd.append("-strip")
    cmd.extend(["-quality", str(quality), out])

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=MAX_IMAGE_TIMEOUT)
        if result.returncode != 0:
            return {"status": "error", "error": result.stderr[:500]}
        size_in = os.path.getsize(inp)
        size_out = os.path.getsize(out) if os.path.exists(out) else 0
        return {
            "status": "ok",
            "output": out,
            "format": "webp",
            "size_before": size_in,
            "size_after": size_out,
            "reduction_pct": round((1 - size_out / max(size_in, 1)) * 100, 1),
        }
    except subprocess.TimeoutExpired:
        return {"status": "error", "error": "webp conversion timeout"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def _image_alttext(task_data):
    """Generate alt-text for an image using LLM (or placeholder)."""
    inp = task_data.get("input", "")
    out = task_data.get("output", "")

    if not os.path.isfile(inp):
        return {"status": "error", "error": f"input not found: {inp}"}

    # Get basic image info for description
    info_cmd = [MAGICK_BIN, "identify", "-format", "%wx%h %m %b", inp]
    try:
        info = subprocess.run(info_cmd, capture_output=True, text=True, timeout=30)
        img_info = info.stdout.strip() if info.returncode == 0 else "unknown"
    except Exception:
        img_info = "unknown"

    # Try LLM-based alt text if llama.cpp is available
    if os.path.isfile(LLAMA_BIN) and os.path.isfile(LLAMA_MODEL):
        prompt = f"Generate a concise, descriptive alt-text for an image. Image metadata: {img_info}. Filename: {os.path.basename(inp)}. Respond with ONLY the alt text, no quotes or explanation."
        try:
            result = subprocess.run(
                [LLAMA_BIN, "-m", LLAMA_MODEL, "-p", prompt, "-n", "80", "--temp", "0.3", "--no-display-prompt"],
                capture_output=True, text=True, timeout=60
            )
            alt_text = result.stdout.strip()
        except Exception:
            alt_text = f"Image: {os.path.basename(inp)} ({img_info})"
    else:
        # Fallback: descriptive placeholder from filename
        basename = os.path.splitext(os.path.basename(inp))[0]
        alt_text = basename.replace("-", " ").replace("_", " ").title()

    if out:
        ensure_dir(out)
        with open(out, "w") as f:
            f.write(alt_text)

    return {
        "status": "ok",
        "alt_text": alt_text,
        "output": out,
        "image_info": img_info,
    }


def _video_thumbnail(task_data):
    """Extract a thumbnail frame from video."""
    inp = task_data.get("input", "")
    out = task_data.get("output", "")
    timestamp = task_data.get("timestamp", "00:00:03")

    if not os.path.isfile(inp):
        return {"status": "error", "error": f"input not found: {inp}"}

    ensure_dir(out)
    cmd = [FFMPEG_BIN, "-y", "-i", inp, "-ss", timestamp, "-frames:v", "1",
           "-q:v", "2", out]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=MAX_IMAGE_TIMEOUT)
        if result.returncode != 0:
            return {"status": "error", "error": result.stderr[:500]}
        return {
            "status": "ok",
            "output": out,
            "timestamp": timestamp,
        }
    except subprocess.TimeoutExpired:
        return {"status": "error", "error": "thumbnail extraction timeout"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


# ── Audio pipeline handlers ─────────────────────────────────────────────────

def handle_audio(task_data):
    """Route audio jobs to the right sub-handler."""
    if isinstance(task_data, str):
        try:
            task_data = json.loads(task_data)
        except json.JSONDecodeError:
            return {"status": "error", "error": "invalid audio job payload"}

    job_type = task_data.get("type", "audio_to_wav")

    if job_type == "audio_to_wav":
        return _audio_to_wav(task_data)
    elif job_type == "video_extract_audio":
        return _video_extract_audio(task_data)
    else:
        return {"status": "error", "error": f"unknown audio job type: {job_type}"}


def _audio_to_wav(task_data):
    """Convert audio to 16kHz mono WAV (whisper-ready)."""
    inp = task_data.get("input", "")
    out = task_data.get("output", "")

    if not os.path.isfile(inp):
        return {"status": "error", "error": f"input not found: {inp}"}

    ensure_dir(out)
    cmd = [FFMPEG_BIN, "-y", "-i", inp, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", out]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=MAX_AUDIO_TIMEOUT)
        if result.returncode != 0:
            return {"status": "error", "error": result.stderr[:500]}
        return {
            "status": "ok",
            "output": out,
            "format": "wav",
            "sample_rate": 16000,
        }
    except subprocess.TimeoutExpired:
        return {"status": "error", "error": "wav conversion timeout"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def _video_extract_audio(task_data):
    """Extract audio track from video as 16kHz mono WAV."""
    inp = task_data.get("input", "")
    out = task_data.get("output", "")

    if not os.path.isfile(inp):
        return {"status": "error", "error": f"input not found: {inp}"}

    ensure_dir(out)
    cmd = [FFMPEG_BIN, "-y", "-i", inp, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", out]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=MAX_AUDIO_TIMEOUT)
        if result.returncode != 0:
            return {"status": "error", "error": result.stderr[:500]}
        return {
            "status": "ok",
            "output": out,
            "format": "wav",
            "sample_rate": 16000,
        }
    except subprocess.TimeoutExpired:
        return {"status": "error", "error": "audio extraction timeout"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


# ── Enhanced whisper handler (with VTT output + file saving) ─────────────────

def handle_whisper_enhanced(task_data):
    """Transcribe audio with optional VTT subtitle output and file saving."""
    if isinstance(task_data, str):
        try:
            task_data = json.loads(task_data)
        except (json.JSONDecodeError, TypeError):
            task_data = {"file": task_data}

    # Support both old-style "file" key and new "input" key
    audio_file = task_data.get("file", task_data.get("input", ""))
    model = task_data.get("model", WHISPER_MODEL)
    language = task_data.get("language", "en")
    output_txt = task_data.get("output_txt", "")
    output_vtt = task_data.get("output_vtt", "")

    # Wait for dependency (audio conversion) — simple poll with timeout
    depends = task_data.get("depends_on", "")
    if depends and not os.path.isfile(audio_file):
        waited = 0
        while waited < 120 and not os.path.isfile(audio_file):
            time.sleep(5)
            waited += 5
        if not os.path.isfile(audio_file):
            return {"status": "error", "error": f"dependency not ready: {audio_file} (waited {waited}s)"}

    if not os.path.isfile(WHISPER_BIN):
        return {"status": "error", "error": f"whisper binary not found: {WHISPER_BIN}"}
    if not os.path.isfile(audio_file):
        return {"status": "error", "error": f"audio file not found: {audio_file}"}
    if not os.path.isfile(model):
        return {"status": "error", "error": f"model not found: {model}"}

    try:
        # Transcribe (plain text)
        result = subprocess.run(
            [WHISPER_BIN, "-m", model, "-f", audio_file, "-l", language, "--no-timestamps"],
            capture_output=True, text=True, timeout=MAX_AUDIO_TIMEOUT
        )
        transcript = result.stdout.strip()

        # Save transcript to file
        if output_txt:
            ensure_dir(output_txt)
            with open(output_txt, "w") as f:
                f.write(transcript)

        # Generate VTT subtitles
        vtt_content = ""
        if output_vtt:
            vtt_result = subprocess.run(
                [WHISPER_BIN, "-m", model, "-f", audio_file, "-l", language, "--output-vtt"],
                capture_output=True, text=True, timeout=MAX_AUDIO_TIMEOUT
            )
            vtt_content = vtt_result.stdout.strip()
            if vtt_content:
                ensure_dir(output_vtt)
                with open(output_vtt, "w") as f:
                    f.write(vtt_content)

        return {
            "status": "ok",
            "transcript": transcript[:5000],
            "transcript_length": len(transcript),
            "file": audio_file,
            "output_txt": output_txt,
            "output_vtt": output_vtt,
            "model": os.path.basename(model),
        }
    except subprocess.TimeoutExpired:
        return {"status": "error", "error": f"transcription timeout ({MAX_AUDIO_TIMEOUT}s)"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


# ── Enhanced LLM handler (with text file input + output saving) ──────────────

def handle_llm_enhanced(task_data):
    """LLM inference with file I/O for text pipelines."""
    if isinstance(task_data, str):
        try:
            task_data = json.loads(task_data)
        except (json.JSONDecodeError, TypeError):
            task_data = {"prompt": task_data}

    job_type = task_data.get("type", "llm")

    # Text pipeline types that read from a file
    if job_type == "text_summarize":
        return _text_summarize(task_data)
    elif job_type == "text_seo":
        return _text_seo(task_data)
    else:
        # Default: plain prompt inference (original behavior)
        return handle_llm(task_data)


def _read_text_file(filepath, max_chars=4000):
    """Read a text file with size limit."""
    if not os.path.isfile(filepath):
        return None, f"file not found: {filepath}"
    try:
        with open(filepath, "r", errors="replace") as f:
            content = f.read(max_chars)
        return content, None
    except Exception as e:
        return None, str(e)


def _text_summarize(task_data):
    """Summarize a text file using LLM."""
    inp = task_data.get("input", "")
    out = task_data.get("output", "")

    content, err = _read_text_file(inp)
    if err:
        return {"status": "error", "error": err}

    prompt = f"""Summarize the following text concisely. Include key points as bullet points.

TEXT:
{content}

SUMMARY:"""

    if not os.path.isfile(LLAMA_BIN) or not os.path.isfile(LLAMA_MODEL):
        # No LLM available — create a basic extractive summary
        lines = [l.strip() for l in content.split("\n") if l.strip()]
        summary = "\n".join(lines[:10]) + "\n\n[Auto-extracted first 10 lines — no LLM available]"
        if out:
            ensure_dir(out)
            with open(out, "w") as f:
                f.write(summary)
        return {"status": "ok", "summary": summary, "output": out, "method": "extractive"}

    try:
        result = subprocess.run(
            [LLAMA_BIN, "-m", LLAMA_MODEL, "-p", prompt, "-n", "512", "--temp", "0.3", "--no-display-prompt"],
            capture_output=True, text=True, timeout=MAX_CMD_TIMEOUT
        )
        summary = result.stdout.strip()
        if out:
            ensure_dir(out)
            with open(out, "w") as f:
                f.write(summary)
        return {
            "status": "ok",
            "summary": summary[:3000],
            "output": out,
            "input": inp,
            "method": "llm",
            "model": os.path.basename(LLAMA_MODEL),
        }
    except subprocess.TimeoutExpired:
        return {"status": "error", "error": "summarization timeout"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def _text_seo(task_data):
    """Generate SEO metadata (title, description, schema) for text content."""
    inp = task_data.get("input", "")
    out = task_data.get("output", "")

    content, err = _read_text_file(inp, max_chars=3000)
    if err:
        return {"status": "error", "error": err}

    prompt = f"""Analyze the following content and generate SEO metadata as JSON with these fields:
- "title": compelling page title (under 60 chars)
- "description": meta description (under 155 chars)
- "h1": suggested H1 heading
- "h2s": array of suggested H2 subheadings
- "keywords": array of 5-8 target keywords
- "faq": array of objects with "question" and "answer" fields (2-3 FAQs)

Respond with ONLY valid JSON, no explanation.

CONTENT:
{content}

JSON:"""

    if not os.path.isfile(LLAMA_BIN) or not os.path.isfile(LLAMA_MODEL):
        # Fallback: extract basic metadata without LLM
        lines = [l.strip() for l in content.split("\n") if l.strip()]
        title = lines[0][:60] if lines else "Untitled"
        desc = " ".join(lines[:3])[:155] if lines else ""
        seo = {
            "title": title,
            "description": desc,
            "h1": title,
            "h2s": [],
            "keywords": [],
            "faq": [],
            "method": "extractive",
        }
        if out:
            ensure_dir(out)
            with open(out, "w") as f:
                json.dump(seo, f, indent=2)
        return {"status": "ok", "seo": seo, "output": out}

    try:
        result = subprocess.run(
            [LLAMA_BIN, "-m", LLAMA_MODEL, "-p", prompt, "-n", "600", "--temp", "0.2", "--no-display-prompt"],
            capture_output=True, text=True, timeout=MAX_CMD_TIMEOUT
        )
        raw = result.stdout.strip()
        # Try to parse as JSON
        try:
            seo = json.loads(raw)
        except json.JSONDecodeError:
            # Try to extract JSON from response
            start = raw.find("{")
            end = raw.rfind("}") + 1
            if start >= 0 and end > start:
                seo = json.loads(raw[start:end])
            else:
                seo = {"raw": raw, "parse_error": True}

        seo["method"] = "llm"
        seo["model"] = os.path.basename(LLAMA_MODEL)

        if out:
            ensure_dir(out)
            with open(out, "w") as f:
                json.dump(seo, f, indent=2)

        return {"status": "ok", "seo": seo, "output": out, "input": inp}
    except subprocess.TimeoutExpired:
        return {"status": "error", "error": "SEO generation timeout"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def handle_site_audit(task_data):
    """Audit a URL list for broken links, missing OG tags, missing alt text, large images."""
    urls = task_data.get("urls", [])
    url = task_data.get("url", "")
    if url and not urls:
        urls = [url]
    if not urls:
        return {"status": "error", "error": "No URLs provided (set 'urls' or 'url')"}

    results = []
    for target_url in urls[:50]:  # Cap at 50 URLs per job
        audit = {"url": target_url, "issues": [], "ok": True}
        try:
            cmd = ["curl", "-sL", "-o", "/dev/null", "-w",
                   "%{http_code}\\n%{size_download}\\n%{time_total}\\n%{url_effective}",
                   "--max-time", "15", "--max-redirs", "5", target_url]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
            lines = result.stdout.strip().split("\n")
            status_code = int(lines[0]) if lines else 0
            size_bytes = int(lines[1]) if len(lines) > 1 else 0
            load_time = float(lines[2]) if len(lines) > 2 else 0

            audit["status_code"] = status_code
            audit["size_bytes"] = size_bytes
            audit["load_time_s"] = round(load_time, 2)

            if status_code >= 400:
                audit["issues"].append(f"HTTP {status_code}")
                audit["ok"] = False
            if load_time > 5:
                audit["issues"].append(f"Slow load: {load_time:.1f}s")

            # Fetch HTML for content checks
            html_cmd = ["curl", "-sL", "--max-time", "15", "--max-redirs", "5", target_url]
            html_result = subprocess.run(html_cmd, capture_output=True, text=True, timeout=20)
            html = html_result.stdout[:500000]  # Cap at 500KB

            if html:
                # Check for missing OG tags
                import re
                if not re.search(r'<meta\s+property=["\']og:title', html, re.IGNORECASE):
                    audit["issues"].append("Missing og:title")
                if not re.search(r'<meta\s+property=["\']og:description', html, re.IGNORECASE):
                    audit["issues"].append("Missing og:description")
                if not re.search(r'<meta\s+property=["\']og:image', html, re.IGNORECASE):
                    audit["issues"].append("Missing og:image")

                # Check for images without alt text
                imgs = re.findall(r'<img\s[^>]*>', html, re.IGNORECASE)
                imgs_no_alt = [i for i in imgs if not re.search(r'\balt\s*=\s*["\'][^"\']+', i)]
                if imgs_no_alt:
                    audit["issues"].append(f"{len(imgs_no_alt)} image(s) missing alt text")

                # Check for missing title
                if not re.search(r'<title[^>]*>[^<]+</title>', html, re.IGNORECASE):
                    audit["issues"].append("Missing <title>")

                # Check for missing meta description
                if not re.search(r'<meta\s+name=["\']description', html, re.IGNORECASE):
                    audit["issues"].append("Missing meta description")

                # Find large images (check src attributes)
                img_srcs = re.findall(r'<img\s[^>]*src=["\']([^"\']+)', html, re.IGNORECASE)
                for img_src in img_srcs[:20]:  # Check up to 20 images
                    if img_src.startswith("data:"):
                        continue
                    if not img_src.startswith("http"):
                        # Resolve relative URL
                        from urllib.parse import urljoin
                        img_src = urljoin(target_url, img_src)
                    try:
                        size_cmd = ["curl", "-sI", "--max-time", "5", img_src]
                        size_result = subprocess.run(size_cmd, capture_output=True, text=True, timeout=8)
                        cl_match = re.search(r'content-length:\s*(\d+)', size_result.stdout, re.IGNORECASE)
                        if cl_match and int(cl_match.group(1)) > 500000:  # > 500KB
                            size_kb = int(cl_match.group(1)) // 1024
                            audit["issues"].append(f"Large image ({size_kb}KB): {img_src.split('/')[-1][:40]}")
                    except Exception:
                        pass

                if audit["issues"]:
                    audit["ok"] = False

        except subprocess.TimeoutExpired:
            audit["issues"].append("Timeout fetching URL")
            audit["ok"] = False
        except Exception as e:
            audit["issues"].append(f"Error: {str(e)[:100]}")
            audit["ok"] = False

        results.append(audit)

    ok_count = sum(1 for r in results if r["ok"])
    total_issues = sum(len(r["issues"]) for r in results)

    return {
        "status": "ok",
        "summary": f"{ok_count}/{len(results)} URLs passed, {total_issues} issues found",
        "audits": results
    }


HANDLERS = {
    "shell": handle_shell,
    "whisper": handle_whisper_enhanced,
    "llm": handle_llm_enhanced,
    "generic": handle_generic,
    "image": handle_image,
    "audio": handle_audio,
    "web": handle_site_audit,
    "site-audit": handle_site_audit,
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
