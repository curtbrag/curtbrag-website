#!/bin/bash
# Submit jobs to the phone cluster and optionally wait for results
#
# Usage:
#   bash submit-job.sh shell "uname -a"           # Shell command
#   bash submit-job.sh shell "free -h" --wait      # Wait for result
#   bash submit-job.sh whisper /path/to/audio.wav   # Transcription
#   bash submit-job.sh llm "Summarize: ..."         # LLM inference
#   bash submit-job.sh status                       # Show queue status
#   bash submit-job.sh results shell                # Read results
#   bash submit-job.sh workers                      # List active workers

set -e

REDIS_HOST="${REDIS_HOST:-10.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"
WAIT=0
WAIT_TIMEOUT=60

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

rcli() {
  redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" "$@" 2>/dev/null
}

usage() {
  echo "Usage: $0 <command> [args] [--wait] [--timeout N]"
  echo ""
  echo "Commands:"
  echo "  shell <cmd>           Submit shell command to all workers"
  echo "  whisper <file>        Submit audio file for transcription"
  echo "  llm <prompt>          Submit prompt for LLM inference"
  echo "  broadcast <cmd>       Submit shell command, one per node"
  echo "  status                Show queue depths and worker count"
  echo "  results [type]        Show results (default: all types)"
  echo "  workers               List active workers"
  echo "  flush                 Clear all queues and results"
  echo ""
  echo "Options:"
  echo "  --wait                Wait for result after submitting"
  echo "  --timeout N           Wait timeout in seconds (default: 60)"
  echo "  --redis-host HOST     Redis host (default: 10.0.0.1)"
  exit 1
}

# Parse trailing flags
ARGS=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --wait) WAIT=1; shift;;
    --timeout) WAIT_TIMEOUT="$2"; shift 2;;
    --redis-host) REDIS_HOST="$2"; shift 2;;
    -h|--help) usage;;
    *) ARGS+=("$1"); shift;;
  esac
done
set -- "${ARGS[@]}"

CMD="${1:-}"
shift 2>/dev/null || true

# ── Check Redis connectivity ──────────────────────────────────────────

if ! command -v redis-cli &>/dev/null; then
  echo -e "${RED}redis-cli not found. Install: sudo apt install redis-tools${NC}"
  exit 1
fi

if ! rcli PING | grep -q PONG; then
  echo -e "${RED}Cannot connect to Redis at ${REDIS_HOST}:${REDIS_PORT}${NC}"
  exit 1
fi

# ── Commands ──────────────────────────────────────────────────────────

case "$CMD" in

  shell)
    TASK="${*:-}"
    [ -z "$TASK" ] && { echo "Usage: $0 shell <command>"; exit 1; }
    rcli LPUSH jobs:shell "$TASK" >/dev/null
    echo -e "${GREEN}Submitted:${NC} shell → $TASK"

    if [ $WAIT -eq 1 ]; then
      echo -ne "${YELLOW}Waiting for result...${NC} "
      BEFORE=$(rcli LLEN results:shell)
      ELAPSED=0
      while [ $ELAPSED -lt $WAIT_TIMEOUT ]; do
        AFTER=$(rcli LLEN results:shell)
        if [ "$AFTER" -gt "$BEFORE" ]; then
          echo ""
          rcli LINDEX results:shell -1
          exit 0
        fi
        sleep 1
        ELAPSED=$((ELAPSED + 1))
        echo -ne "."
      done
      echo ""
      echo -e "${RED}Timeout after ${WAIT_TIMEOUT}s${NC}"
    fi
    ;;

  whisper)
    FILE="${1:-}"
    [ -z "$FILE" ] && { echo "Usage: $0 whisper <audio-file>"; exit 1; }
    PAYLOAD="{\"file\":\"$FILE\"}"
    rcli LPUSH jobs:whisper "$PAYLOAD" >/dev/null
    echo -e "${GREEN}Submitted:${NC} whisper → $FILE"
    ;;

  llm)
    PROMPT="${*:-}"
    [ -z "$PROMPT" ] && { echo "Usage: $0 llm <prompt>"; exit 1; }
    PAYLOAD="{\"prompt\":$(echo "$PROMPT" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read().strip()))' 2>/dev/null || echo "\"$PROMPT\"")}"
    rcli LPUSH jobs:llm "$PAYLOAD" >/dev/null
    echo -e "${GREEN}Submitted:${NC} llm → ${PROMPT:0:80}..."
    ;;

  broadcast)
    TASK="${*:-}"
    [ -z "$TASK" ] && { echo "Usage: $0 broadcast <command>"; exit 1; }
    # Push one job per worker — each worker pulls exactly one
    WORKERS=$(rcli KEYS "worker:node*" 2>/dev/null | grep -c "worker:node" || echo "0")
    [ "$WORKERS" -eq 0 ] && WORKERS=10
    for i in $(seq 1 "$WORKERS"); do
      rcli LPUSH jobs:shell "$TASK" >/dev/null
    done
    echo -e "${GREEN}Broadcast:${NC} $WORKERS jobs → $TASK"
    ;;

  status)
    echo -e "${CYAN}═══ Cluster Job Queue Status ═══${NC}"
    echo ""
    echo -e "${YELLOW}Queues:${NC}"
    for q in shell whisper llm generic; do
      DEPTH=$(rcli LLEN "jobs:$q" 2>/dev/null || echo "0")
      printf "  jobs:%-10s %s jobs\n" "$q" "$DEPTH"
    done
    echo ""
    echo -e "${YELLOW}Results:${NC}"
    for q in shell whisper llm log; do
      COUNT=$(rcli LLEN "results:$q" 2>/dev/null || echo "0")
      printf "  results:%-7s %s entries\n" "$q" "$COUNT"
    done
    echo ""
    echo -e "${YELLOW}Workers:${NC}"
    WORKER_KEYS=$(rcli KEYS "worker:node*" 2>/dev/null | grep -v heartbeat | grep -v active || true)
    if [ -n "$WORKER_KEYS" ]; then
      echo "$WORKER_KEYS" | while read -r key; do
        [ -z "$key" ] && continue
        INFO=$(rcli GET "$key" 2>/dev/null)
        HEARTBEAT=$(rcli GET "${key}:heartbeat" 2>/dev/null)
        ACTIVE=$(rcli GET "${key}:active" 2>/dev/null)
        NODE=$(echo "$INFO" | python3 -c "import json,sys;print(json.loads(sys.stdin.read()).get('node','?'))" 2>/dev/null || echo "?")
        if [ -n "$HEARTBEAT" ]; then
          AGO=$(( $(date +%s) - HEARTBEAT ))
          echo -e "  ${GREEN}${NODE}${NC}: heartbeat ${AGO}s ago"
        else
          echo -e "  ${YELLOW}${NODE}${NC}: no heartbeat"
        fi
        if [ -n "$ACTIVE" ] && [ "$ACTIVE" != "" ] && [ "$ACTIVE" != '""' ]; then
          echo "    active: $ACTIVE"
        fi
      done
    else
      echo -e "  ${RED}No workers registered${NC}"
    fi
    echo ""
    TOTAL_DONE=$(rcli GET "stats:total:jobs_done" 2>/dev/null || echo "0")
    echo -e "Total jobs completed: ${GREEN}${TOTAL_DONE}${NC}"
    ;;

  results)
    TYPE="${1:-shell}"
    COUNT="${2:-10}"
    echo -e "${CYAN}═══ Last $COUNT results ($TYPE) ═══${NC}"
    echo ""
    rcli LRANGE "results:$TYPE" "-$COUNT" -1 | while read -r line; do
      if command -v python3 &>/dev/null; then
        echo "$line" | python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    node = d.get('node', '?')
    status = d.get('status', '?')
    elapsed = d.get('elapsed_seconds', '?')
    ts = d.get('timestamp', '')
    stdout = d.get('stdout', d.get('transcript', d.get('response', '')))[:200]
    print(f'  [{node}] {status} ({elapsed}s) {ts}')
    if stdout:
        print(f'    {stdout}')
except: print(f'  {sys.stdin.read()[:200]}')" 2>/dev/null
      else
        echo "  $line" | head -c 200
        echo ""
      fi
    done
    ;;

  workers)
    echo -e "${CYAN}═══ Active Workers ═══${NC}"
    echo ""
    rcli KEYS "worker:node*" 2>/dev/null | grep -v heartbeat | grep -v active | sort | while read -r key; do
      [ -z "$key" ] && continue
      INFO=$(rcli GET "$key" 2>/dev/null)
      JOBS=$(rcli GET "stats:${key#worker:}:jobs_done" 2>/dev/null || echo "0")
      echo -e "  ${GREEN}${key}${NC}: $INFO (jobs: $JOBS)"
    done
    ;;

  flush)
    echo -ne "${YELLOW}Flush all queues and results? [y/N] ${NC}"
    read -r CONFIRM
    if [ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ]; then
      for q in shell whisper llm generic; do
        rcli DEL "jobs:$q" >/dev/null
      done
      for q in shell whisper llm log; do
        rcli DEL "results:$q" >/dev/null
      done
      rcli DEL "stats:total:jobs_done" >/dev/null
      echo -e "${GREEN}Flushed.${NC}"
    else
      echo "Cancelled."
    fi
    ;;

  *)
    usage
    ;;
esac
