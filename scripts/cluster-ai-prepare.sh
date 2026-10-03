#!/bin/sh
# User-local runtime, fixed official download and fixed model; no root access.
set -eu
[ "$(uname -m)" = x86_64 ] || { echo 'An x86_64 Linux worker is required'; exit 1; }
command -v zstd >/dev/null || { echo 'Install zstd on this worker before preparing AI'; exit 1; }
command -v flock >/dev/null || { echo 'flock is required'; exit 1; }
AI_DIR="$HOME/.local/share/curt-cluster-ai"
mkdir -p "$AI_DIR"
exec 9>"$AI_DIR/prepare.lock"
flock -n 9 || { echo 'AI preparation is already running'; exit 1; }
if ! curl -fsS --max-time 5 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  if [ ! -x "$AI_DIR/runtime/bin/ollama" ]; then
    FREE_KB=$(df -Pk "$AI_DIR" | awk 'END {print $4}')
    [ "$FREE_KB" -ge 6291456 ] || { echo 'At least 6 GiB of free space is required'; exit 1; }
    mkdir -p "$AI_DIR/runtime"
    curl -fLSs --max-time 1200 https://ollama.com/download/ollama-linux-amd64.tar.zst -o "$AI_DIR/runtime.tar.zst"
    tar --zstd -xf "$AI_DIR/runtime.tar.zst" -C "$AI_DIR/runtime"
    rm "$AI_DIR/runtime.tar.zst"
  fi
  # Bind only to loopback; the dashboard uses the existing worker queue.
  OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MODELS="$AI_DIR/models" \
    nohup "$AI_DIR/runtime/bin/ollama" serve >"$AI_DIR/server.log" 2>&1 < /dev/null 9>&- &
  READY=0
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then READY=1; break; fi
    sleep 1
  done
  [ "$READY" = 1 ] || { echo 'Model service failed to start; check server.log'; exit 1; }
fi
curl -fsS --max-time 1200 http://127.0.0.1:11434/api/pull \
  -H 'Content-Type: application/json' -d '{"model":"qwen3:4b","stream":false}'
printf '\n'
