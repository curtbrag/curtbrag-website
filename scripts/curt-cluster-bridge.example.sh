#!/usr/bin/env bash
# Curt Cluster Bridge — runs on the controller machine.
# Polls curtbrag.com for queued commands, executes them via LAN SSH,
# reports completion. No phone-side daemons.
#
# Required env (e.g. via $HOME/.cluster-env, see install-cluster-bridge.sh):
#   WEB_PASSWORD       same password used at /cluster/dashboard
#                      (CLUSTER_WEB_PASSWORD also accepted)
#   WALLET             Monero wallet for mining commands
#
# Optional env:
#   API_URL            default https://curtbrag.com/.netlify/functions/cluster-api
#   POOL               default gulf.moneroocean.stream:10128
#   SSH_KEY            default $HOME/.ssh/id_ed25519
#   PHONE_USER         default u0_a191 (Termux uid)
#   PHONE_PORT         default 8022
#   PHONE_HINT         xmrig --cpu-max-threads-hint, default 90
#   PHONES             space-separated last octets, default "173 174 175 176 177 191 253 254"
#   NEXUS_USER/IP/THREADS, VIKI_*, STEAMDECK_*  PC fleet overrides
#   POLL_INTERVAL      seconds between polls when work was found, default 1
#   IDLE_INTERVAL      seconds between polls when queue empty,     default 3
#   LOG_FILE           default $HOME/curt_cluster_bridge.log

set +e

API_URL="${API_URL:-https://curtbrag.com/.netlify/functions/cluster-api}"
WEB_PASSWORD="${WEB_PASSWORD:-${CLUSTER_WEB_PASSWORD:-}}"
WALLET="${WALLET:-}"
POOL="${POOL:-gulf.moneroocean.stream:10128}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
PHONE_USER="${PHONE_USER:-u0_a191}"
PHONE_PORT="${PHONE_PORT:-8022}"
PHONE_HINT="${PHONE_HINT:-90}"
PHONES="${PHONES:-173 174 175 176 177 191 253 254}"
POLL_INTERVAL="${POLL_INTERVAL:-1}"
IDLE_INTERVAL="${IDLE_INTERVAL:-3}"
LOG_FILE="${LOG_FILE:-$HOME/curt_cluster_bridge.log}"

NEXUS_USER="${NEXUS_USER:-neo}"
NEXUS_IP="${NEXUS_IP:-192.168.1.178}"
NEXUS_THREADS="${NEXUS_THREADS:-6}"

VIKI_USER="${VIKI_USER:-neo}"
VIKI_IP="${VIKI_IP:-192.168.1.180}"
VIKI_THREADS="${VIKI_THREADS:-4}"

STEAMDECK_USER="${STEAMDECK_USER:-deck}"
STEAMDECK_IP="${STEAMDECK_IP:-192.168.1.166}"
STEAMDECK_THREADS="${STEAMDECK_THREADS:-6}"

[ -n "$WEB_PASSWORD" ] || { echo "ERROR: set WEB_PASSWORD or CLUSTER_WEB_PASSWORD" >&2; exit 1; }
[ -n "$WALLET" ]       || { echo "ERROR: set WALLET" >&2; exit 1; }
command -v jq    >/dev/null 2>&1 || { echo "ERROR: jq required"   >&2; exit 1; }
command -v curl  >/dev/null 2>&1 || { echo "ERROR: curl required" >&2; exit 1; }

log() { printf '[%(%F %T)T] %s\n' -1 "$*" | tee -a "$LOG_FILE" >&2; }

# Strict allowlist. Do not extend without auditing the SSH payload.
allowlisted() {
  case "$1" in
    mining-start|mining-stop|mining-status|fresh-connect|reboot|restart|verify-all|start|stop|status)
      return 0 ;;
    *) return 1 ;;
  esac
}

api_get() {
  curl -fsS --max-time 20 "$API_URL?action=$1" \
    -H "Authorization: Bearer $WEB_PASSWORD"
}

api_post() {
  curl -fsS --max-time 20 -X POST "$API_URL?action=$1" \
    -H "Authorization: Bearer $WEB_PASSWORD" \
    -H "Content-Type: application/json" \
    --data "$2"
}

heartbeat() {
  local body
  body="$(jq -nc \
    --arg h "$(hostname 2>/dev/null || echo controller)" \
    --arg s "$1" \
    '{hostname:$h, summary:$s}')"
  api_post bridge-heartbeat "$body" >/dev/null 2>&1 || true
}

complete_cmd() {
  local body
  body="$(jq -nc \
    --arg id "$1" --arg target "$2" --arg type "$3" \
    --arg rs "$4" --arg out "$5" \
    '{id:$id, target:$target, type:$type, result_summary:$rs, output:$out}')"
  api_post bridge-complete "$body" >/dev/null 2>&1 || true
}

phone_ssh() {
  local id="$1"; shift
  timeout 60 ssh -n -p "$PHONE_PORT" -i "$SSH_KEY" \
    -o BatchMode=yes -o ConnectTimeout=5 -o ConnectionAttempts=1 \
    -o ServerAliveInterval=2 -o ServerAliveCountMax=2 \
    -o StrictHostKeyChecking=no -o LogLevel=ERROR \
    "$PHONE_USER@192.168.1.$id" "$@"
}

linux_ssh() {
  local user="$1" ip="$2"; shift 2
  timeout 60 ssh -n -i "$SSH_KEY" \
    -o BatchMode=yes -o ConnectTimeout=5 -o ConnectionAttempts=1 \
    -o ServerAliveInterval=2 -o ServerAliveCountMax=2 \
    -o StrictHostKeyChecking=no -o LogLevel=ERROR \
    "$user@$ip" "$@"
}

phone_status() {
  phone_ssh "$1" '
    export HOME=/data/data/com.termux/files/home
    export PATH=/data/data/com.termux/files/usr/bin:$HOME/bin:$PATH
    echo "HOST=$(hostname 2>/dev/null || echo localhost)"
    echo "PROC:"
    pgrep -af xmrig | grep -v grep || echo NO_XMRIG
    echo "SPEED:"
    grep "miner    speed" "$HOME/xmrig.log" 2>/dev/null | tail -3 || echo NO_SPEED
  '
}

phone_start() {
  local id="$1" worker="phone$1"
  phone_ssh "$id" "
    export HOME=/data/data/com.termux/files/home
    export PATH=/data/data/com.termux/files/usr/bin:\$HOME/bin:\$PATH
    LOG=\$HOME/xmrig.log

    if   [ -x \"\$HOME/xmrig-custom\" ]; then BIN=\"\$HOME/xmrig-custom\"
    elif [ -x \"\$HOME/bin/xmrig\" ];    then BIN=\"\$HOME/bin/xmrig\"
    elif [ -x \"\$HOME/xmrig/xmrig\" ];  then BIN=\"\$HOME/xmrig/xmrig\"
    else echo NO_BIN; exit 0
    fi

    OLD=\$(pgrep -af xmrig | grep -v grep)
    if echo \"\$OLD\" | grep -q '$WALLET.$worker' && \
       echo \"\$OLD\" | grep -q 'cpu-max-threads-hint=$PHONE_HINT'; then
      echo ALREADY_RUNNING_CORRECT
    else
      pkill -9 xmrig 2>/dev/null || true
      sleep 2
      : > \"\$LOG\"
      nohup \"\$BIN\" \
        -o '$POOL' \
        -u '$WALLET.$worker' \
        -p x -k \
        --cpu-max-threads-hint='$PHONE_HINT' \
        --print-time=10 \
        --log-file=\"\$LOG\" \
        --no-color >/dev/null 2>&1 &
      sleep 20
    fi

    pgrep -af xmrig | grep -v grep || echo NO_PROCESS
    grep 'miner    speed' \"\$LOG\" 2>/dev/null | tail -3 || echo NO_SPEED
  "
}

phone_stop() {
  phone_ssh "$1" '
    export HOME=/data/data/com.termux/files/home
    export PATH=/data/data/com.termux/files/usr/bin:$HOME/bin:$PATH
    pkill -9 xmrig 2>/dev/null || true
    sleep 1
    pgrep -af xmrig | grep -v grep || echo STOPPED
  '
}

linux_status() {
  linux_ssh "$1" "$2" '
    echo "HOST=$(hostname 2>/dev/null || echo unknown)"
    echo "PROC:"
    pgrep -af xmrig | grep -v grep || echo NO_XMRIG
    echo "SPEED:"
    grep "miner    speed" "$HOME/xmrig.log" 2>/dev/null | tail -3 || echo NO_SPEED
  '
}

linux_start() {
  local name="$1" user="$2" ip="$3" threads="$4"
  linux_ssh "$user" "$ip" "
    export PATH=\$HOME/bin:/usr/local/bin:/usr/bin:/bin:\$PATH
    LOG=\$HOME/xmrig.log

    if   [ -x \"\$HOME/bin/xmrig\" ];          then BIN=\"\$HOME/bin/xmrig\"
    elif [ -x \"\$HOME/xmrig/xmrig\" ];        then BIN=\"\$HOME/xmrig/xmrig\"
    elif [ -x \"\$HOME/moneroocean/xmrig\" ];  then BIN=\"\$HOME/moneroocean/xmrig\"
    else echo NO_BIN; exit 0
    fi

    OLD=\$(pgrep -af xmrig | grep -v grep)
    if echo \"\$OLD\" | grep -q '$WALLET.$name'; then
      echo ALREADY_RUNNING_CORRECT
    else
      pkill -9 xmrig 2>/dev/null || true
      sleep 2
      : > \"\$LOG\"
      nohup \"\$BIN\" \
        -o '$POOL' \
        -u '$WALLET.$name' \
        -p x -k \
        --threads='$threads' \
        --print-time=10 \
        --log-file=\"\$LOG\" \
        --no-color >/dev/null 2>&1 &
      sleep 25
    fi

    pgrep -af xmrig | grep -v grep || echo NO_PROCESS
    grep 'miner    speed' \"\$LOG\" 2>/dev/null | tail -3 || echo NO_SPEED
  "
}

linux_stop() {
  linux_ssh "$1" "$2" '
    pkill -9 xmrig 2>/dev/null || true
    sleep 1
    pgrep -af xmrig | grep -v grep || echo STOPPED
  '
}

controller_status() {
  echo "HOST=$(hostname 2>/dev/null || echo controller)"
  echo "PROC:"
  pgrep -af xmrig | grep -v grep || echo NO_XMRIG
  echo "SPEED:"
  grep "miner    speed" "$HOME/xmrig.log" 2>/dev/null | tail -3 || echo NO_SPEED
}

controller_start() {
  local LOG="$HOME/xmrig.log" BIN

  if   [ -x "$HOME/bin/xmrig" ];         then BIN="$HOME/bin/xmrig"
  elif [ -x "$HOME/xmrig/xmrig" ];       then BIN="$HOME/xmrig/xmrig"
  elif [ -x "$HOME/moneroocean/xmrig" ]; then BIN="$HOME/moneroocean/xmrig"
  else echo NO_BIN; return
  fi

  local OLD; OLD="$(pgrep -af xmrig | grep -v grep)"
  if echo "$OLD" | grep -q "$WALLET.controller"; then
    echo ALREADY_RUNNING_CORRECT
  else
    pkill -9 xmrig 2>/dev/null || true
    sleep 2
    : > "$LOG"
    nohup "$BIN" \
      -o "$POOL" \
      -u "$WALLET.controller" \
      -p x -k \
      --print-time=10 \
      --log-file="$LOG" \
      --no-color >/dev/null 2>&1 &
    sleep 20
  fi

  controller_status
}

controller_stop() {
  pkill -9 xmrig 2>/dev/null || true
  sleep 1
  pgrep -af xmrig | grep -v grep || echo STOPPED
}

target_list() {
  case "$1" in
    all|"")   for p in $PHONES; do printf 'phone%s ' "$p"; done; echo "nexus viki steamdeck controller" ;;
    phones)   for p in $PHONES; do printf 'phone%s ' "$p"; done; echo ;;
    pcs)      echo "nexus viki steamdeck controller" ;;
    *)        echo "$1" ;;
  esac
}

run_node_cmd() {
  local node="$1" type="$2"
  case "$node" in
    phone*)
      local id="${node#phone}"
      case "$type" in
        mining-start|fresh-connect|start|restart) phone_start  "$id" ;;
        mining-stop|stop)                          phone_stop   "$id" ;;
        mining-status|verify-all|status)           phone_status "$id" ;;
        *) echo "UNSUPPORTED_COMMAND_FOR_PHONE $type" ;;
      esac
      ;;
    nexus)
      case "$type" in
        mining-start|fresh-connect|start|restart) linux_start  nexus "$NEXUS_USER" "$NEXUS_IP" "$NEXUS_THREADS" ;;
        mining-stop|stop)                          linux_stop   "$NEXUS_USER" "$NEXUS_IP" ;;
        mining-status|verify-all|status)           linux_status "$NEXUS_USER" "$NEXUS_IP" ;;
        *) echo "UNSUPPORTED_COMMAND_FOR_NEXUS $type" ;;
      esac
      ;;
    viki)
      case "$type" in
        mining-start|fresh-connect|start|restart) linux_start  viki "$VIKI_USER" "$VIKI_IP" "$VIKI_THREADS" ;;
        mining-stop|stop)                          linux_stop   "$VIKI_USER" "$VIKI_IP" ;;
        mining-status|verify-all|status)           linux_status "$VIKI_USER" "$VIKI_IP" ;;
        *) echo "UNSUPPORTED_COMMAND_FOR_VIKI $type" ;;
      esac
      ;;
    steamdeck)
      case "$type" in
        mining-start|fresh-connect|start|restart) linux_start  steamdeck "$STEAMDECK_USER" "$STEAMDECK_IP" "$STEAMDECK_THREADS" ;;
        mining-stop|stop)                          linux_stop   "$STEAMDECK_USER" "$STEAMDECK_IP" ;;
        mining-status|verify-all|status)           linux_status "$STEAMDECK_USER" "$STEAMDECK_IP" ;;
        *) echo "UNSUPPORTED_COMMAND_FOR_STEAMDECK $type" ;;
      esac
      ;;
    controller|skynet)
      case "$type" in
        mining-start|fresh-connect|start|restart) controller_start  ;;
        mining-stop|stop)                          controller_stop   ;;
        mining-status|verify-all|status)           controller_status ;;
        *) echo "UNSUPPORTED_COMMAND_FOR_CONTROLLER $type" ;;
      esac
      ;;
    *) echo "UNKNOWN_TARGET $node" ;;
  esac
}

# Push per-device observed state to the website (so the dashboard shows
# real online/mining/hashrate, not "unreachable: 11").
push_device_state() {
  local hostname="$1" running="$2" hashrate="$3" body
  body="$(jq -nc \
    --arg h "$hostname" \
    --argjson xmrig "$running" \
    --argjson hr "${hashrate:-0}" \
    '{hostname:$h, observed:{xmrig_running:$xmrig, hashrate_60s:$hr}}')"
  api_post bridge-touch-device "$body" >/dev/null 2>&1 || true
}

# Hostname mapping: bridge target name → device registry hostname
# (controller is local skynet, registered as itself if seeded; phones same name)
device_hostname_for() {
  case "$1" in
    controller|skynet) hostname 2>/dev/null || echo controller ;;
    *) echo "$1" ;;
  esac
}

# Best-effort parse of mining-status / mining-start output.
# Returns "running hashrate" as space-separated string.
parse_node_state() {
  local out="$1" running=false hr=0
  # If output is empty / SSH errored / no auth, skip — caller decides.
  if echo "$out" | grep -Eq 'Permission denied|No route to host|Connection refused|Connection timed out|UNREACHABLE|UNKNOWN_TARGET'; then
    echo "false 0"; return
  fi
  # xmrig running? Look for non-grep, non-tmux xmrig in PROC line.
  if echo "$out" | grep -E '\bxmrig\b' | grep -v 'pgrep' | grep -v 'tmux' | grep -qv 'NO_XMRIG'; then
    running=true
  fi
  # hashrate from "miner    speed 10s/60s/15m  X  Y  Z H/s" — Y is 60s avg.
  hr=$(echo "$out" | awk '/miner    speed/{a=$5} END{print (a==""||a=="n/a")?0:a}')
  echo "$running $hr"
}

execute_command() {
  local id="$1" target="$2" type="$3" output="" node node_out
  log "executing id=$id target=$target type=$type"

  for node in $(target_list "$target"); do
    node_out="$(run_node_cmd "$node" "$type" 2>&1)"
    output+=$'\n===== '"$node / $type"$' =====\n'"$node_out"$'\n'

    # Push observed state per device so the dashboard reflects reality.
    if ! echo "$node_out" | grep -Eq 'Permission denied|No route to host|UNKNOWN_TARGET|UNSUPPORTED_COMMAND'; then
      local dev_host state running hr
      dev_host="$(device_hostname_for "$node")"
      state="$(parse_node_state "$node_out")"
      running="${state% *}"; hr="${state##* }"
      push_device_state "$dev_host" "$running" "$hr"
    fi
  done

  printf '%s' "$output"
}

run_once() {
  heartbeat "polling website"

  local data cmd id target type
  data="$(api_get commands 2>/dev/null)" || { log "could not fetch command queue"; return 2; }

  cmd="$(printf '%s' "$data" | jq -c '.queue[0] // empty')"
  if [ -z "$cmd" ]; then return 1; fi

  id="$(printf '%s'     "$cmd" | jq -r '.id     // empty')"
  target="$(printf '%s' "$cmd" | jq -r '.target // "all"')"
  type="$(printf '%s'   "$cmd" | jq -r '.type   // .command // empty')"

  if [ -z "$id" ]; then
    log "bad command payload, no id (skipping forever; flush queue manually if stuck)"
    return 2
  fi
  if [ -z "$type" ]; then
    log "bad command id=$id, no type — completing as skipped"
    complete_cmd "$id" "$target" "unknown" "skipped: missing type" "no type field in payload"
    return 0
  fi

  if ! allowlisted "$type"; then
    log "skip non-allowlisted: $type (id=$id)"
    complete_cmd "$id" "$target" "$type" "skipped: not allowlisted" "Denied $type"
    return 0
  fi

  local output
  output="$(execute_command "$id" "$target" "$type")"
  complete_cmd "$id" "$target" "$type" "completed $type -> $target" "$output"
  log "completed id=$id"
  return 0
}

case "${1:---loop}" in
  --once)
    run_once
    ;;
  --loop)
    log "bridge loop starting (api=$API_URL)"
    while true; do
      run_once
      rc=$?
      if   [ "$rc" -eq 0 ]; then sleep "$POLL_INTERVAL"
      else                       sleep "$IDLE_INTERVAL"
      fi
    done
    ;;
  --install)
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    if command -v tmux >/dev/null 2>&1; then
      tmux kill-session -t curtbridge 2>/dev/null || true
      tmux new-session -d -s curtbridge "$SCRIPT_DIR/$(basename "$0") --loop"
      tmux ls
    elif command -v systemctl >/dev/null 2>&1; then
      "$SCRIPT_DIR/install-cluster-bridge.sh"
    else
      echo "Need tmux or systemctl for --install" >&2
      exit 2
    fi
    ;;
  *)
    echo "Usage: $0 [--once|--loop|--install]" >&2
    exit 2
    ;;
esac
