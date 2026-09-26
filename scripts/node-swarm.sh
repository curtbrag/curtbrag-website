#!/bin/sh
# node-swarm.sh — Curt Cluster Swarm worker agent v2.1.1
# Polls curtbrag.com Swarm, executes assigned jobs, and reports results.
# Works on Termux and Linux. Requires curl + sh; jq or python3 recommended.

set -u

AGENT_VERSION="2.1.1"
SWARM_URL="${SWARM_URL:-https://curtbrag.com/api/cluster}"
POLL_INTERVAL="${POLL_INTERVAL:-60}"
DEVICE_ID="${DEVICE_ID:-}"
NODE_CLASS="${NODE_CLASS:-unknown}"
LOG_DIR="${HOME}/cluster/logs"
STATE_DIR="${HOME}/cluster/state"
LOG_FILE="${LOG_DIR}/swarm-agent.log"
STATE_FILE="${STATE_DIR}/last_response.json"
PID_FILE="${STATE_DIR}/node-swarm.pid"
PENDING_RESULT_FILE="${STATE_DIR}/pending-result.json"
MINER_ARGV_FILE="${STATE_DIR}/miner-argv.bin"
MINER_SERVICE_FILE="${STATE_DIR}/miner-service.txt"
MINER_START_LOG="${LOG_DIR}/xmrig-swarm-start.log"

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

# A node must have exactly one Swarm poller. Older deployments could leave an
# earlier node-swarm.sh alive, which lets two versions race for the same job.
# The newest agent therefore takes ownership by terminating sibling agents that
# have this exact script path in argv. No pgrep -f is used because it can match
# the command doing the search.
SWARM_SCRIPT="$HOME/node-swarm.sh"
prune_other_swarm_agents() {
  for _d in /proc/[0-9]*; do
    [ -r "$_d/cmdline" ] || continue
    _p=${_d##*/}
    [ "$_p" = "$$" ] && continue
    _hit=0
    while IFS= read -r _arg; do
      [ "$_arg" = "$SWARM_SCRIPT" ] && _hit=1
    done <<EOF
$(tr '\0' '\n' < "$_d/cmdline" 2>/dev/null)
EOF
    [ "$_hit" -eq 1 ] && kill "$_p" 2>/dev/null || true
  done

  sleep 1

  for _d in /proc/[0-9]*; do
    [ -r "$_d/cmdline" ] || continue
    _p=${_d##*/}
    [ "$_p" = "$$" ] && continue
    _hit=0
    while IFS= read -r _arg; do
      [ "$_arg" = "$SWARM_SCRIPT" ] && _hit=1
    done <<EOF
$(tr '\0' '\n' < "$_d/cmdline" 2>/dev/null)
EOF
    [ "$_hit" -eq 1 ] && kill -9 "$_p" 2>/dev/null || true
  done
}

prune_other_swarm_agents
echo $$ > "$PID_FILE" 2>/dev/null || true

log() {
  printf '[%s] [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$DEVICE_ID" "$1"
}

cleanup() {
  _owner=$(cat "$PID_FILE" 2>/dev/null || true)
  [ "$_owner" = "$$" ] && rm -f "$PID_FILE" 2>/dev/null || true
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

# -----------------------------------------------------------------------------
# Miner control
# -----------------------------------------------------------------------------
# Miner operations intentionally use exact /proc argv matching. Do not use
# pgrep -f here: the command doing the search can match itself.

xmrig_pids() {
  for _d in /proc/[0-9]*; do
    [ -r "$_d/cmdline" ] || continue
    _first=$(tr '\0' '\n' < "$_d/cmdline" 2>/dev/null | head -1)
    [ -n "$_first" ] || continue
    _hit=0
    case "$_first" in
      "$HOME/bin/xmrig"|"$HOME/curt_abilities/ability1_mining/xmrig"|"$HOME/.local/opt/xmrig/xmrig"|/usr/bin/xmrig|/usr/local/bin/xmrig)
        _hit=1
        ;;
      */xmrig)
        _exe=$(readlink -f "$_d/exe" 2>/dev/null || true)
        case "$_exe" in */xmrig) _hit=1 ;; esac
        ;;
    esac
    [ "$_hit" -eq 1 ] && printf '%s\n' "${_d##*/}"
  done
}

save_miner_argv() {
  _pid=$(xmrig_pids | head -1)
  case "$_pid" in ''|*[!0-9]*) return 1 ;; esac
  [ -r "/proc/$_pid/cmdline" ] || return 1
  cat "/proc/$_pid/cmdline" > "$MINER_ARGV_FILE" 2>/dev/null || return 1
  chmod 600 "$MINER_ARGV_FILE" 2>/dev/null || true
  return 0
}

detect_miner_service() {
  command -v systemctl >/dev/null 2>&1 || return 1

  for _svc in curt-xmrig.service xmrig.service curt-miner.service miner.service; do
    if systemctl --user cat "$_svc" >/dev/null 2>&1; then
      printf '%s\n' "$_svc"
      return 0
    fi
  done

  for _unit in "$HOME/.config/systemd/user/"*.service /etc/systemd/user/*.service; do
    [ -f "$_unit" ] || continue
    if grep -qi 'xmrig' "$_unit" 2>/dev/null; then
      basename "$_unit"
      return 0
    fi
  done

  return 1
}

remember_miner_service() {
  _svc=$(detect_miner_service 2>/dev/null || true)
  [ -n "$_svc" ] || return 1
  printf '%s\n' "$_svc" > "$MINER_SERVICE_FILE" 2>/dev/null || true
  chmod 600 "$MINER_SERVICE_FILE" 2>/dev/null || true
  printf '%s\n' "$_svc"
}

miner_threads() {
  _pid="$1"
  _threads="?"
  _want_next=0
  while IFS= read -r _arg; do
    if [ "$_want_next" -eq 1 ]; then
      _threads="$_arg"
      _want_next=0
      continue
    fi
    case "$_arg" in
      --threads=*) _threads=${_arg#--threads=} ;;
      -t|--threads) _want_next=1 ;;
    esac
  done <<EOF
$(tr '\0' '\n' < "/proc/$_pid/cmdline" 2>/dev/null)
EOF
  printf '%s' "$_threads"
}

miner_status_text() {
  _pids=$(xmrig_pids | tr '\n' ' ' | sed 's/[[:space:]]*$//')
  _svc=""
  [ -s "$MINER_SERVICE_FILE" ] && _svc=$(head -1 "$MINER_SERVICE_FILE" 2>/dev/null || true)
  [ -n "$_svc" ] || _svc=$(detect_miner_service 2>/dev/null || true)
  _service_state="n/a"
  if [ -n "$_svc" ] && command -v systemctl >/dev/null 2>&1; then
    _service_state=$(systemctl --user is-active "$_svc" 2>/dev/null || true)
    [ -n "$_service_state" ] || _service_state="inactive"
  fi

  if [ -n "$_pids" ]; then
    _first_pid=$(printf '%s' "$_pids" | awk '{print $1}')
    _threads=$(miner_threads "$_first_pid")
    printf 'device=%s miner=RUNNING pid=%s threads=%s service=%s service_state=%s restart_snapshot=%s' \
      "$DEVICE_ID" "$_pids" "$_threads" "${_svc:-none}" "$_service_state" "$([ -s "$MINER_ARGV_FILE" ] && echo yes || echo no)"
  else
    printf 'device=%s miner=STOPPED pid=none threads=0 service=%s service_state=%s restart_snapshot=%s' \
      "$DEVICE_ID" "${_svc:-none}" "$_service_state" "$([ -s "$MINER_ARGV_FILE" ] && echo yes || echo no)"
  fi
}

stop_miner() {
  _before=$(xmrig_pids | tr '\n' ' ' | sed 's/[[:space:]]*$//')
  if [ -z "$_before" ]; then
    printf 'device=%s miner=STOPPED already_stopped=true' "$DEVICE_ID"
    return 0
  fi

  save_miner_argv >/dev/null 2>&1 || true
  _svc=$(remember_miner_service 2>/dev/null || true)
  if [ -n "$_svc" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl --user stop "$_svc" >/dev/null 2>&1 || true
  fi

  _pids=$(xmrig_pids)
  for _pid in $_pids; do
    kill "$_pid" 2>/dev/null || true
  done

  _i=0
  while [ "$_i" -lt 6 ]; do
    [ -z "$(xmrig_pids | head -1)" ] && break
    sleep 1
    _i=$((_i + 1))
  done

  _pids=$(xmrig_pids)
  for _pid in $_pids; do
    kill -9 "$_pid" 2>/dev/null || true
  done
  sleep 1

  _after=$(xmrig_pids | head -1)
  if [ -n "$_after" ]; then
    printf 'device=%s miner=STOP_FAILED pid=%s service=%s' "$DEVICE_ID" "$_after" "${_svc:-none}"
    return 1
  fi

  printf 'device=%s miner=STOPPED prior_pid=%s service=%s restart_snapshot=%s' \
    "$DEVICE_ID" "$_before" "${_svc:-none}" "$([ -s "$MINER_ARGV_FILE" ] && echo yes || echo no)"
  return 0
}

start_saved_argv() {
  [ -s "$MINER_ARGV_FILE" ] || return 1
  command -v python3 >/dev/null 2>&1 || return 1

  python3 - "$MINER_ARGV_FILE" "$HOME" "$MINER_START_LOG" <<'PY'
import os, subprocess, sys
path, home, log_path = sys.argv[1:4]
raw = open(path, 'rb').read().split(b'\0')
args = [x.decode('utf-8', 'surrogateescape') for x in raw if x]
if not args:
    raise SystemExit(2)
os.makedirs(os.path.dirname(log_path), exist_ok=True)
with open(log_path, 'ab', buffering=0) as log:
    subprocess.Popen(args, cwd=home, stdin=subprocess.DEVNULL,
                     stdout=log, stderr=log, start_new_session=True,
                     close_fds=True)
PY
}

start_miner() {
  case "$(printf '%s' "$DEVICE_ID" | tr '[:upper:]' '[:lower:]')" in
    nexus)
      printf 'device=Nexus miner=POLICY_BLOCKED reason=thermal_history_start_disabled'
      return 2
      ;;
  esac

  _running=$(xmrig_pids | head -1)
  if [ -n "$_running" ]; then
    printf 'device=%s miner=RUNNING already_running=true pid=%s' "$DEVICE_ID" "$_running"
    return 0
  fi

  _svc=""
  [ -s "$MINER_SERVICE_FILE" ] && _svc=$(head -1 "$MINER_SERVICE_FILE" 2>/dev/null || true)
  if [ -z "$_svc" ]; then
    _svc=$(remember_miner_service 2>/dev/null || true)
  fi

  if [ -n "$_svc" ] && command -v systemctl >/dev/null 2>&1; then
    if systemctl --user start "$_svc" >/dev/null 2>&1; then
      sleep 3
      _pid=$(xmrig_pids | head -1)
      if [ -n "$_pid" ]; then
        printf 'device=%s miner=RUNNING pid=%s service=%s launch=systemd' "$DEVICE_ID" "$_pid" "$_svc"
        return 0
      fi
    fi
  fi

  if start_saved_argv >/dev/null 2>&1; then
    sleep 3
    _pid=$(xmrig_pids | head -1)
    if [ -n "$_pid" ]; then
      printf 'device=%s miner=RUNNING pid=%s service=%s launch=saved_argv' "$DEVICE_ID" "$_pid" "${_svc:-none}"
      return 0
    fi
  fi

  printf 'device=%s miner=START_FAILED reason=no_working_service_or_restart_snapshot' "$DEVICE_ID"
  return 1
}

restart_miner() {
  case "$(printf '%s' "$DEVICE_ID" | tr '[:upper:]' '[:lower:]')" in
    nexus)
      printf 'device=Nexus miner=POLICY_BLOCKED reason=thermal_history_start_disabled'
      return 2
      ;;
  esac
  stop_miner >/dev/null 2>&1 || true
  start_miner
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

    mining-status|miner-status)
      stdout=$(miner_status_text)
      exit_code=0
      ;;

    mining-stop|miner-stop)
      stdout=$(stop_miner)
      exit_code=$?
      ;;

    mining-start|miner-start)
      stdout=$(start_miner)
      exit_code=$?
      ;;

    mining-restart|miner-restart)
      stdout=$(restart_miner)
      exit_code=$?
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
