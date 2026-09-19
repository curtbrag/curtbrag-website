#!/bin/sh
# node-swarm.sh — Curt Cluster Swarm worker agent v2
# Polls curtbrag.com Swarm, executes assigned jobs, and reports results.
# Works on Termux and Linux. Requires curl + sh; jq or python3 recommended.

set -u

AGENT_VERSION="2.0.0"
SWARM_URL="${SWARM_URL:-https://curtbrag.com/api/cluster}"
POLL_INTERVAL="${POLL_INTERVAL:-10}"
DEVICE_ID="${DEVICE_ID:-}"
NODE_CLASS="${NODE_CLASS:-unknown}"
LOG_DIR="${HOME}/cluster/logs"
STATE_DIR="${HOME}/cluster/state"
LOG_FILE="${LOG_DIR}/swarm-agent.log"
STATE_FILE="${STATE_DIR}/last_response.json"
PID_FILE="${STATE_DIR}/node-swarm.pid"
PENDING_RESULT_FILE="${STATE_DIR}/pending-result.json"

mkdir -p "$LOG_DIR" "$STATE_DIR"

if [ -z "${CLUSTER_API_KEY:-}" ]; then
  for _f in "${HOME}/.cluster-env" /home/user/.cluster-env; do
    if [ -f "$_f" ]; then
      . "$_f"
      break
    fi
  done
fi
SWARM_TOKEN="${SWARM_TOKEN:-${CLUSTER_API_KEY:-}}"

if [ -z "$DEVICE_ID" ]; then
  _host=$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null || echo "unknown")
  DEVICE_ID=$(printf '%s' "$_host" | tr -cd 'A-Za-z0-9._-' | cut -c1-48)
fi
[ -n "$DEVICE_ID" ] || DEVICE_ID="unknown"

PLATFORM=$(uname -s 2>/dev/null || echo unknown)
HOSTNAME_NOW=$(hostname 2>/dev/null || echo "$DEVICE_ID")

echo $$ > "$PID_FILE" 2>/dev/null || true

log() {
  printf '[%s] [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$DEVICE_ID" "$1"
}

cleanup() {
  rm -f "$PID_FILE" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

http_get() {
  _url="$1"
  if [ -n "$SWARM_TOKEN" ]; then
    curl -fsS --max-time 15 -H "Authorization: Bearer $SWARM_TOKEN" "$_url" 2>/dev/null
  else
    curl -fsS --max-time 15 "$_url" 2>/dev/null
  fi
}

http_post() {
  _url="$1"
  _body="$2"
  if [ -n "$SWARM_TOKEN" ]; then
    curl -fsS -X POST -H "Content-Type: application/json" \
      -H "Authorization: Bearer $SWARM_TOKEN" \
      --max-time 20 --data "$_body" "$_url" 2>/dev/null
  else
    curl -fsS -X POST -H "Content-Type: application/json" \
      --max-time 20 --data "$_body" "$_url" 2>/dev/null
  fi
}

json_escape() {
  printf '%s' "$1" \
    | tr -d '\000-\010\013\014\016-\037' \
    | head -c 4000 \
    | sed 's/\\/\\\\/g; s/"/\\"/g' \
    | tr '\n' ' '
}

send_heartbeat() {
  _body=$(printf '{"device_id":"%s","ts":%s,"hostname":"%s","platform":"%s","node_class":"%s","agent_version":"%s","pid":%s}' \
    "$(json_escape "$DEVICE_ID")" \
    "$(date +%s)" \
    "$(json_escape "$HOSTNAME_NOW")" \
    "$(json_escape "$PLATFORM")" \
    "$(json_escape "$NODE_CLASS")" \
    "$AGENT_VERSION" \
    "$$")
  http_post "${SWARM_URL}?action=heartbeat" "$_body" >/dev/null 2>&1
}

report_result() {
  _job_id="$1"
  _job_type="$2"
  _exit_code="$3"
  _stdout="$4"
  _stderr="$5"

  _out_esc=$(json_escape "$_stdout")
  _err_esc=$(json_escape "$_stderr")
  _body=$(printf '{"job_id":"%s","device_id":"%s","type":"%s","exit_code":%s,"stdout":"%s","stderr":"%s","ts":%s}' \
    "$(json_escape "$_job_id")" \
    "$(json_escape "$DEVICE_ID")" \
    "$(json_escape "$_job_type")" \
    "$_exit_code" \
    "$_out_esc" \
    "$_err_esc" \
    "$(date +%s)")

  if http_post "${SWARM_URL}?action=job-complete" "$_body" >/dev/null 2>&1; then
    rm -f "$PENDING_RESULT_FILE" 2>/dev/null || true
    return 0
  fi

  printf '%s' "$_body" > "$PENDING_RESULT_FILE" 2>/dev/null || true
  return 1
}

retry_pending_result() {
  [ -s "$PENDING_RESULT_FILE" ] || return 0
  _pending=$(cat "$PENDING_RESULT_FILE" 2>/dev/null || true)
  [ -n "$_pending" ] || return 0
  if http_post "${SWARM_URL}?action=job-complete" "$_pending" >/dev/null 2>&1; then
    log "pending job result delivered"
    rm -f "$PENDING_RESULT_FILE" 2>/dev/null || true
    return 0
  fi
  log "pending result retry failed; delaying new work"
  return 1
}

execute_job() {
  job_id="$1"
  job_type="$2"
  job_cmd="$3"

  log "executing job_id=$job_id type=$job_type"

  stdout=""
  stderr=""
  exit_code=0
  err_file="${STATE_DIR}/stderr-$$.txt"
  rm -f "$err_file" 2>/dev/null || true

  case "$job_type" in
    shell|cmd|exec)
      if [ -z "$job_cmd" ]; then
        stdout="no cmd provided"
        exit_code=1
      else
        stdout=$(sh -c "$job_cmd" 2>"$err_file" </dev/null)
        exit_code=$?
        stderr=$(cat "$err_file" 2>/dev/null || true)
      fi
      ;;

    echo|ping)
      stdout="pong from $DEVICE_ID at $(date '+%Y-%m-%d %H:%M:%S')"
      exit_code=0
      ;;

    status)
      _uptime=$(awk '{printf "%dd %dh %dm", $1/86400, ($1%86400)/3600, ($1%3600)/60}' /proc/uptime 2>/dev/null || echo "?")
      _load=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo "?")
      _mem=$(awk '/MemAvailable:/ {printf "%.0fMB", $2/1024}' /proc/meminfo 2>/dev/null || echo "?")
      stdout="device=$DEVICE_ID platform=$PLATFORM class=$NODE_CLASS uptime=$_uptime load=$_load mem_available=$_mem agent=$AGENT_VERSION pid=$$"
      exit_code=0
      ;;

    *)
      stdout="unsupported job type: $job_type"
      exit_code=1
      ;;
  esac

  rm -f "$err_file" 2>/dev/null || true
  log "job $job_id done (exit=$exit_code)"

  if report_result "$job_id" "$job_type" "$exit_code" "${stdout:-}" "${stderr:-}"; then
    log "job $job_id result reported"
  else
    log "job $job_id result queued locally for retry"
  fi
}

process_with_jq() {
  printf '%s' "$RESP" | jq -c '.jobs[]?' 2>/dev/null | while IFS= read -r job; do
    JOB_ID=$(printf '%s' "$job" | jq -r '.id // empty')
    JOB_TYPE=$(printf '%s' "$job" | jq -r '.type // empty')
    JOB_CMD=$(printf '%s' "$job" | jq -r '.cmd // .command // empty')
    [ -n "$JOB_ID" ] && execute_job "$JOB_ID" "$JOB_TYPE" "$JOB_CMD"
  done
}

process_with_python() {
  printf '%s' "$RESP" | python3 -c '
import sys, json, base64
try:
    data = json.load(sys.stdin)
    for job in data.get("jobs", []):
        jid = str(job.get("id", ""))
        typ = str(job.get("type", ""))
        cmd = str(job.get("cmd", job.get("command", "")))
        if jid:
            print(base64.b64encode(jid.encode()).decode() + "|" + base64.b64encode(typ.encode()).decode() + "|" + base64.b64encode(cmd.encode()).decode())
except Exception:
    pass
' 2>/dev/null | while IFS='|' read -r B64_ID B64_TYPE B64_CMD; do
    JOB_ID=$(printf '%s' "$B64_ID" | base64 -d 2>/dev/null || true)
    JOB_TYPE=$(printf '%s' "$B64_TYPE" | base64 -d 2>/dev/null || true)
    JOB_CMD=$(printf '%s' "$B64_CMD" | base64 -d 2>/dev/null || true)
    [ -n "$JOB_ID" ] && execute_job "$JOB_ID" "$JOB_TYPE" "$JOB_CMD"
  done
}

log "node-swarm v$AGENT_VERSION started (pid=$$, device=$DEVICE_ID, class=$NODE_CLASS, auth=$([ -n "$SWARM_TOKEN" ] && echo token || echo compatibility))"

LAST_HEARTBEAT=0
CYCLE=0

while true; do
  CYCLE=$((CYCLE + 1))
  NOW=$(date +%s)

  if [ $((NOW - LAST_HEARTBEAT)) -ge 60 ]; then
    send_heartbeat || true
    LAST_HEARTBEAT=$NOW
  fi

  if ! retry_pending_result; then
    sleep "$POLL_INTERVAL"
    continue
  fi

  RESP=$(http_get "${SWARM_URL}?action=swarm-poll&device_id=${DEVICE_ID}" || true)

  if [ -z "$RESP" ]; then
    log "poll_fail: no response (cycle=$CYCLE)"
    sleep "$POLL_INTERVAL"
    continue
  fi

  printf '%s' "$RESP" > "$STATE_FILE" 2>/dev/null || true

  QCOUNT=$(printf '%s' "$RESP" | grep -o '"queue_count":[0-9]*' | head -1 | grep -o '[0-9]*' || true)
  [ -n "$QCOUNT" ] || QCOUNT=0
  log "poll_ok bytes=$(printf '%s' "$RESP" | wc -c | tr -d ' ') queue=$QCOUNT"

  if [ "$QCOUNT" -gt 0 ] 2>/dev/null; then
    if command -v jq >/dev/null 2>&1; then
      process_with_jq
    elif command -v python3 >/dev/null 2>&1; then
      process_with_python
    else
      log "cannot process jobs: jq/python3 missing"
    fi
  fi

  sleep "$POLL_INTERVAL"
done