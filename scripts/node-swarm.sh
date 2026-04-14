#!/bin/sh
# node-swarm.sh — Swarm worker agent
# Polls curtbrag.com/api/cluster for jobs, executes them, reports results.
# Works on Termux (Android) and Linux. Requires: curl, sh.
# Run: nohup sh ~/node-swarm.sh > ~/cluster/logs/swarm-agent.log 2>&1 &

set -u

# ── Config ────────────────────────────────────────────────────────────────────
SWARM_URL="${SWARM_URL:-https://curtbrag.com/api/cluster}"
POLL_INTERVAL="${POLL_INTERVAL:-10}"
DEVICE_ID="${DEVICE_ID:-}"
LOG_DIR="${HOME}/cluster/logs"
STATE_DIR="${HOME}/cluster/state"
LOG_FILE="${LOG_DIR}/swarm-agent.log"
STATE_FILE="${STATE_DIR}/last_response.json"
PID_FILE="${TMPDIR:-/tmp}/node-swarm.pid"

# ── Bootstrap ─────────────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR" "$STATE_DIR"

# Derive stable device ID from hostname if not set
if [ -z "$DEVICE_ID" ]; then
  _host=$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null || echo "unknown")
  DEVICE_ID=$(echo "$_host" | tr -cd 'a-z0-9-' | cut -c1-32)
fi

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [${DEVICE_ID}] $1"; }

# Write PID for process-based health checks
echo $$ > "$PID_FILE" 2>/dev/null || true

log "node-swarm started (pid=$$, device=$DEVICE_ID)"

# ── HTTP helpers ──────────────────────────────────────────────────────────────
http_get() {
  curl -s --max-time 15 "$1" 2>/dev/null
}

http_post() {
  curl -s -X POST -H "Content-Type: application/json" \
    --max-time 15 --data "$2" "$1" 2>/dev/null
}

# ── Heartbeat ─────────────────────────────────────────────────────────────────
send_heartbeat() {
  local body
  body=$(printf '{"device_id":"%s","ts":%s}' "$DEVICE_ID" "$(date +%s)")
  http_post "${SWARM_URL}?action=heartbeat" "$body" >/dev/null
}

# ── Job execution ─────────────────────────────────────────────────────────────
execute_job() {
  local job_id="$1" job_type="$2" job_cmd="$3"
  local stdout stderr exit_code

  log "executing job_id=$job_id type=$job_type"

  case "$job_type" in
    shell|cmd|exec)
      if [ -z "$job_cmd" ]; then
        stdout="no cmd provided"; exit_code=1
      else
        stdout=$(sh -c "$job_cmd" 2>/tmp/swarm-stderr-$$ </dev/null)
        exit_code=$?
        stderr=$(cat /tmp/swarm-stderr-$$ 2>/dev/null || echo "")
        rm -f /tmp/swarm-stderr-$$
      fi
      ;;
    echo|ping)
      stdout="pong from $DEVICE_ID at $(date '+%Y-%m-%d %H:%M:%S')"
      exit_code=0
      ;;
    status)
      stdout=$(printf 'device=%s uptime=%s load=%s' \
        "$DEVICE_ID" \
        "$(awk '{printf "%dd %dh %dm", $1/86400, ($1%86400)/3600, ($1%3600)/60}' /proc/uptime 2>/dev/null || echo "?")" \
        "$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo "?")")
      exit_code=0
      ;;
    *)
      stdout="unsupported job type: $job_type"
      exit_code=1
      ;;
  esac

  log "job $job_id done (exit=$exit_code)"

  # Escape stdout for JSON (strip non-printable, truncate, escape quotes)
  local out_esc
  out_esc=$(printf '%s' "${stdout:-}" | tr -d '\000-\010\013\014\016-\037' \
    | head -c 3000 | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')

  local result_body
  result_body=$(printf '{"job_id":"%s","device_id":"%s","exit_code":%d,"stdout":"%s","ts":%s}' \
    "$job_id" "$DEVICE_ID" "$exit_code" "$out_esc" "$(date +%s)")

  http_post "${SWARM_URL}?action=job-complete" "$result_body" >/dev/null
}

# ── Poll loop ─────────────────────────────────────────────────────────────────
LAST_HEARTBEAT=0
CYCLE=0

while true; do
  CYCLE=$((CYCLE + 1))
  NOW=$(date +%s)

  # Heartbeat every 60s
  if [ $((NOW - LAST_HEARTBEAT)) -ge 60 ]; then
    send_heartbeat
    LAST_HEARTBEAT=$NOW
  fi

  # Poll for jobs
  RESP=$(http_get "${SWARM_URL}?action=swarm-poll&device_id=${DEVICE_ID}")

  if [ -z "$RESP" ]; then
    log "poll_fail: no response (cycle=$CYCLE)"
    sleep "$POLL_INTERVAL"
    continue
  fi

  # Save state snapshot
  printf '%s' "$RESP" > "$STATE_FILE" 2>/dev/null || true

  # Extract queue_count quickly
  QCOUNT=$(echo "$RESP" | grep -o '"queue_count":[0-9]*' | grep -o '[0-9]*' || echo "0")
  log "poll_ok bytes=$(printf '%s' "$RESP" | wc -c) queue=$QCOUNT"

  # Process jobs if any returned
  if echo "$RESP" | grep -q '"jobs":\[.\|"jobs":\[{'; then
    # Try jq first
    if command -v jq >/dev/null 2>&1; then
      echo "$RESP" | jq -c '.jobs[]?' 2>/dev/null | while IFS= read -r job; do
        JOB_ID=$(echo "$job" | jq -r '.id // empty')
        JOB_TYPE=$(echo "$job" | jq -r '.type // empty')
        JOB_CMD=$(echo "$job" | jq -r '.cmd // .command // empty')
        [ -n "$JOB_ID" ] && execute_job "$JOB_ID" "$JOB_TYPE" "$JOB_CMD"
      done
    elif command -v python3 >/dev/null 2>&1; then
      echo "$RESP" | python3 -c '
import sys, json
try:
  data = json.load(sys.stdin)
  for job in data.get("jobs", []):
    jid = job.get("id","")
    jtype = job.get("type","")
    cmd = job.get("cmd", job.get("command",""))
    if jid:
      print(jid + "|" + jtype + "|" + cmd)
except: pass
' 2>/dev/null | while IFS='|' read -r JOB_ID JOB_TYPE JOB_CMD; do
        [ -n "$JOB_ID" ] && execute_job "$JOB_ID" "$JOB_TYPE" "$JOB_CMD"
      done
    else
      # Grep fallback: extract simple id/type pairs (no cmd support)
      JOB_ID=$(echo "$RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
      JOB_TYPE=$(echo "$RESP" | grep -o '"type":"[^"]*"' | head -1 | cut -d'"' -f4)
      [ -n "$JOB_ID" ] && execute_job "$JOB_ID" "${JOB_TYPE:-ping}" ""
    fi
  fi

  sleep "$POLL_INTERVAL"
done
