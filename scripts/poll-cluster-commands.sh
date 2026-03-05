#!/bin/sh
# Poll for queued commands from curtbrag.com and execute them
# Run on node1: nohup /home/user/poll-cluster-commands.sh &
# Or as a systemd service for auto-restart

set -u

# Source env file if CLUSTER_API_KEY not already set (systemd, cron, nohup contexts)
if [ -z "${CLUSTER_API_KEY:-}" ] && [ -f /home/user/.cluster-env ]; then
  . /home/user/.cluster-env
fi

API_URL="https://curtbrag.com/.netlify/functions/cluster-control"
API_KEY="${CLUSTER_API_KEY:?ERROR: CLUSTER_API_KEY environment variable must be set. Create /home/user/.cluster-env with: CLUSTER_API_KEY=your-key}"
POLL_INTERVAL=5  # seconds
SSH_PORT="${SSH_PORT:-22}"  # SSH port (default: 22, Termux uses 8022)
# Auto-detect our IP so local-exec works even if IP changes
LOCAL_IP=$(ip -4 addr show wlan0 2>/dev/null | grep -o 'inet [0-9.]*' | cut -d' ' -f2)
[ -z "$LOCAL_IP" ] && LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$LOCAL_IP" ] && LOCAL_IP="192.168.1.206"
# Collect all local IPs so is_local_ip works for Tailscale/USB interfaces too
ALL_LOCAL_IPS=$(ip -4 addr 2>/dev/null | grep -o 'inet [0-9.]*' | cut -d' ' -f2 | tr '\n' ' ')
trap 'kill $(jobs -p) 2>/dev/null; rm -rf /tmp/cmdres-* /tmp/sshout-* /tmp/screenshots-* /tmp/cmdstderr-*' EXIT INT TERM

# Check if an IP belongs to this machine
is_local_ip() {
  [ "$1" = "$LOCAL_IP" ] && return 0
  for _lip in $ALL_LOCAL_IPS; do
    [ "$1" = "$_lip" ] && return 0
  done
  return 1
}

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Check jq is available
if ! command -v jq >/dev/null 2>&1; then
  log "ERROR: jq not found"
  exit 1
fi

# Load node configuration from shared config file
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/cluster-nodes.conf" ]; then
  . "$SCRIPT_DIR/cluster-nodes.conf"
  load_node_config
else
  # Fallback if config file not found
  ALL_NODES="node1:192.168.1.206 node2:192.168.1.207 node3:192.168.1.208 node4:192.168.1.209 node5:192.168.1.210 node6:192.168.1.211 node7:192.168.1.212 node8:192.168.1.213 node9:192.168.1.214 node10:192.168.1.215"
  log "WARN: cluster-nodes.conf not found, using hardcoded IPs"
fi
# Ensure PHONE_NODES is populated; fall back to ALL_NODES if empty
[ -z "${PHONE_NODES:-}" ] && PHONE_NODES="$ALL_NODES"
# PC_NODES may be empty if no PCs configured — that's fine
[ -z "${PC_NODES:-}" ] && PC_NODES=""

# Resolve node name to IP
resolve_ip() {
  if [ -f "$SCRIPT_DIR/cluster-nodes.conf" ]; then
    resolve_ip_from_config "$1"
  else
    case "$1" in
      node1)  echo "192.168.1.206" ;; node2) echo "192.168.1.207" ;; node3) echo "192.168.1.208" ;;
      node4)  echo "192.168.1.209" ;; node5) echo "192.168.1.210" ;; node6) echo "192.168.1.211" ;;
      node7)  echo "192.168.1.212" ;; node8) echo "192.168.1.213" ;; node9) echo "192.168.1.214" ;;
      node10) echo "192.168.1.215" ;; *) echo "$1" ;;
    esac
  fi
}

# K3s service name — check if node is control-plane or agent
k3s_svc() {
  local name="$1"
  # Check CONTROL_PLANE_NODES from cluster-nodes.conf
  case " $CONTROL_PLANE_NODES " in
    *" ${name}:"*) echo "k3s" ;;
    *) echo "k3s-agent" ;;
  esac
}

# Execute a command on a node — locally if node1, SSH otherwise
# 30s timeout prevents commands from hanging the poller forever
run_on_node() {
  local ip="$1"
  local cmd="$2"
  local _stderr_tmp="/tmp/cmdstderr-$$"
  local _rc
  if is_local_ip "$ip"; then
    timeout 30 sh -c "$cmd" 2>"$_stderr_tmp"
    _rc=$?
  else
    timeout 30 ssh -p "$SSH_PORT" -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "user@$ip" "$cmd" 2>"$_stderr_tmp"
    _rc=$?
  fi
  if [ "$_rc" -ne 0 ] && [ -s "$_stderr_tmp" ]; then
    log "WARN: command on $ip exited $_rc: $(head -c 200 "$_stderr_tmp")"
  fi
  rm -f "$_stderr_tmp"
  return "$_rc"
}

# Execute on a node and capture both stdout+stderr
run_on_node_full() {
  local ip="$1"
  local cmd="$2"
  if is_local_ip "$ip"; then
    timeout 30 sh -c "$cmd" 2>&1
  else
    timeout 30 ssh -p "$SSH_PORT" -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "user@$ip" "$cmd" 2>&1
  fi
}

# Run on a node, tracking success/failure via temp file
run_on_node_tracked() {
  local ip="$1"
  local cmd="$2"
  local result_dir="$3"
  local label="$4"
  local _out
  _out=$(run_on_node "$ip" "$cmd" 2>&1)
  if [ $? -eq 0 ]; then
    echo "ok" > "$result_dir/$label"
  else
    log "WARN: tracked command failed on $label ($ip): $(printf '%.200s' "$_out")"
    echo "fail" > "$result_dir/$label"
  fi
}

# Collect results from temp dir and produce a result string
collect_results() {
  local result_dir="$1"
  local total=0
  local failed=0
  local failed_nodes=""
  for f in "$result_dir"/*; do
    [ -f "$f" ] || continue
    total=$((total + 1))
    if [ "$(cat "$f")" = "fail" ]; then
      failed=$((failed + 1))
      failed_nodes="$failed_nodes $(basename "$f")"
    fi
  done
  rm -rf "$result_dir"
  if [ "$total" -eq 0 ]; then
    echo "error: no nodes targeted"
  elif [ "$failed" -eq 0 ]; then
    echo "success"
  elif [ "$failed" -eq "$total" ]; then
    echo "error: all $total nodes failed"
  else
    echo "partial: $failed/$total failed ($(echo "$failed_nodes" | sed 's/^ //'))"
  fi
}

# Run command on all nodes in parallel with tracking
run_on_all_tracked() {
  local cmd="$1"
  local result_dir="$2"
  local nodes="${3:-$ALL_NODES}"
  for entry in $nodes; do
    local name="${entry%%:*}"
    local ip="${entry##*:}"
    run_on_node_tracked "$ip" "$cmd" "$result_dir" "$name" &
  done
  wait
}

report_result() {
  local cmd_id="$1"
  local result="$2"
  local output="$3"
  local cmd_name="$4"
  local cmd_target="$5"
  if [ -n "$output" ]; then
    curl -s -X POST "$API_URL" \
      -H "Content-Type: application/json" \
      -H "X-Cluster-Key: $API_KEY" \
      -d "$(jq -n --arg id "$cmd_id" --arg res "$result" --arg out "$output" --arg cmd "$cmd_name" --arg tgt "$cmd_target" \
        '{action:"complete",id:$id,result:$res,output:$out,command:$cmd,target:$tgt}')" >/dev/null 2>&1 || true
  else
    curl -s -X POST "$API_URL" \
      -H "Content-Type: application/json" \
      -H "X-Cluster-Key: $API_KEY" \
      -d "$(jq -n --arg id "$cmd_id" --arg res "$result" --arg cmd "$cmd_name" --arg tgt "$cmd_target" \
        '{action:"complete",id:$id,result:$res,command:$cmd,target:$tgt}')" >/dev/null 2>&1 || true
  fi
}

# Resolve target group to node list
# Usage: nodes=$(resolve_target_nodes "$target" "$scope")
#   scope: "all" = phones+PCs, "phones" = phones only
resolve_target_nodes() {
  local _target="$1"
  local _scope="${2:-all}"
  case "$_target" in
    all)
      if [ "$_scope" = "phones" ]; then
        echo "$PHONE_NODES"
      else
        echo "$ALL_NODES"
      fi
      ;;
    phones) echo "$PHONE_NODES" ;;
    pcs)    echo "$PC_NODES" ;;
    *)      echo "" ;;  # individual node, not a group
  esac
}

# Check if target is a group (all/phones/pcs) vs individual node
is_group_target() {
  case "$1" in
    all|phones|pcs) return 0 ;;
    *) return 1 ;;
  esac
}

execute_command() {
  local cmd="$1"
  local target="$2"
  local url="$3"
  local cmd_id="$4"
  local ssh_cmd="$5"
  local display_mode="${DISPLAY_MODE:-}"
  local mining_level="${MINING_LEVEL:-}"

  log "Executing: $cmd on $target"

  case "$cmd" in
    wake)
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      # Turn on backlight, disable Phosh lock screen via system dconf, unlock session
      WAKE_CMD='
# Create system-wide dconf overrides to disable Phosh lock screen
doas mkdir -p /etc/dconf/profile /etc/dconf/db/local.d
printf "user-db:user\nsystem-db:local\n" | doas tee /etc/dconf/profile/user >/dev/null
printf "[org/gnome/desktop/screensaver]\nlock-enabled=false\n\n[org/gnome/desktop/session]\nidle-delay=uint32 0\n\n[org/gnome/desktop/lockdown]\ndisable-lock-screen=true\n" | doas tee /etc/dconf/db/local.d/00-no-lock >/dev/null
doas dconf update 2>/dev/null

# Turn on backlight
doas sh -c '"'"'for f in /sys/class/backlight/*/bl_power; do echo 0 > "$f"; done'"'"'

# Unlock sessions and dismiss screensaver
doas loginctl unlock-sessions 2>/dev/null
UID_NUM=$(id -u)
export XDG_RUNTIME_DIR=/run/user/$UID_NUM
export WAYLAND_DISPLAY=wayland-0
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$UID_NUM/bus
dbus-send --session --dest=org.gnome.ScreenSaver --type=method_call /org/gnome/ScreenSaver org.gnome.ScreenSaver.SetActive boolean:false 2>/dev/null
true'
      if [ "$target" = "pcs" ]; then
        report_result "$cmd_id" "skipped: wake is phone-only" "" "$cmd" "$target"
        return
      fi
      NODES=$(resolve_target_nodes "$target" "phones")
      if [ -n "$NODES" ]; then
        run_on_all_tracked "$WAKE_CMD" "$RESULT_DIR" "$NODES"
      else
        run_on_node_tracked "$(resolve_ip "$target")" "$WAKE_CMD" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    sleep)
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      SLEEP_CMD="doas sh -c 'for f in /sys/class/backlight/*/bl_power; do echo 4 > \"\$f\"; done'"
      if [ "$target" = "pcs" ]; then
        report_result "$cmd_id" "skipped: sleep is phone-only" "" "$cmd" "$target"
        return
      fi
      NODES=$(resolve_target_nodes "$target" "phones")
      if [ -n "$NODES" ]; then
        run_on_all_tracked "$SLEEP_CMD" "$RESULT_DIR" "$NODES"
      else
        run_on_node_tracked "$(resolve_ip "$target")" "$SLEEP_CMD" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    restart)
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      NODES=$(resolve_target_nodes "$target" "all")
      if [ -n "$NODES" ]; then
        for entry in $NODES; do
          name="${entry%%:*}"; ip="${entry##*:}"
          SVC=$(k3s_svc "$name")
          run_on_node_tracked "$ip" "doas systemctl restart $SVC 2>/dev/null || doas rc-service $SVC restart" "$RESULT_DIR" "$name" &
        done
        wait
      else
        IP=$(resolve_ip "$target")
        SVC=$(k3s_svc "$target")
        run_on_node_tracked "$IP" "doas systemctl restart $SVC 2>/dev/null || doas rc-service $SVC restart" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    start)
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      NODES=$(resolve_target_nodes "$target" "all")
      if [ -n "$NODES" ]; then
        for entry in $NODES; do
          name="${entry%%:*}"; ip="${entry##*:}"
          SVC=$(k3s_svc "$name")
          run_on_node_tracked "$ip" "doas systemctl start $SVC 2>/dev/null || doas rc-service $SVC start" "$RESULT_DIR" "$name" &
        done
        wait
      else
        IP=$(resolve_ip "$target")
        SVC=$(k3s_svc "$target")
        run_on_node_tracked "$IP" "doas systemctl start $SVC 2>/dev/null || doas rc-service $SVC start" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    stop)
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      NODES=$(resolve_target_nodes "$target" "all")
      if [ -n "$NODES" ]; then
        for entry in $NODES; do
          name="${entry%%:*}"; ip="${entry##*:}"
          SVC=$(k3s_svc "$name")
          run_on_node_tracked "$ip" "doas systemctl stop $SVC 2>/dev/null || doas rc-service $SVC stop" "$RESULT_DIR" "$name" &
        done
        wait
      else
        IP=$(resolve_ip "$target")
        SVC=$(k3s_svc "$target")
        run_on_node_tracked "$IP" "doas systemctl stop $SVC 2>/dev/null || doas rc-service $SVC stop" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    mining-start)
      log "Starting miners..."
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      MINING_OUT_DIR="/tmp/miningout-$cmd_id"
      mkdir -p "$RESULT_DIR" "$MINING_OUT_DIR"
      # Start xmrig via systemctl (systemd) first, fall back to rc-service (OpenRC)
      MINING_START_CMD='
if ! command -v xmrig >/dev/null 2>&1 && [ ! -f /usr/local/bin/xmrig ]; then
  echo "xmrig not installed"; exit 1
fi
doas systemctl start xmrig 2>/dev/null || doas rc-service xmrig start 2>&1
sleep 2
if pgrep xmrig >/dev/null 2>&1; then
  echo "started (PID: $(pgrep xmrig | head -1))"
  exit 0
else
  echo "failed to start:"
  doas rc-service xmrig status 2>&1 || doas systemctl status xmrig 2>&1 || echo "no status available"
  exit 1
fi'
      # Mining is phone-only — use "phones" scope
      NODES=$(resolve_target_nodes "$target" "phones")
      if [ -n "$NODES" ]; then
        for entry in $NODES; do
          name="${entry%%:*}"; ip="${entry##*:}"
          (
            _out=$(run_on_node "$ip" "$MINING_START_CMD" 2>&1)
            if [ $? -eq 0 ]; then
              echo "ok" > "$RESULT_DIR/$name"
            else
              echo "fail" > "$RESULT_DIR/$name"
            fi
            echo "$_out" > "$MINING_OUT_DIR/$name.out"
          ) &
        done
        wait
      else
        _out=$(run_on_node "$(resolve_ip "$target")" "$MINING_START_CMD" 2>&1)
        if [ $? -eq 0 ]; then
          echo "ok" > "$RESULT_DIR/$target"
        else
          echo "fail" > "$RESULT_DIR/$target"
        fi
        echo "$_out" > "$MINING_OUT_DIR/$target.out"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      # Collect per-node output for debugging
      MINING_OUTPUT=""
      for f in "$MINING_OUT_DIR"/*.out; do
        [ -f "$f" ] || continue
        _name=$(basename "$f" .out)
        _content=$(cat "$f")
        MINING_OUTPUT="${MINING_OUTPUT}=== ${_name} ===
${_content}
"
      done
      rm -rf "$MINING_OUT_DIR"
      TRUNC_OUTPUT=$(printf '%.4000s' "$MINING_OUTPUT")
      report_result "$cmd_id" "$RESULT" "$TRUNC_OUTPUT" "$cmd" "$target"
      ;;
    mining-stop)
      log "Stopping miners..."
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      # Mining is phone-only — use "phones" scope
      NODES=$(resolve_target_nodes "$target" "phones")
      if [ -n "$NODES" ]; then
        run_on_all_tracked "doas systemctl stop xmrig 2>/dev/null || doas rc-service xmrig stop" "$RESULT_DIR" "$NODES"
      else
        run_on_node_tracked "$(resolve_ip "$target")" "doas systemctl stop xmrig 2>/dev/null || doas rc-service xmrig stop" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    mining-level)
      log "Setting mining level to $mining_level..."
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      # Mining levels: 0=off, 1=12% CPU, 2=25% CPU, 3=50% CPU, 4=100% CPU
      # Works on both systemd and OpenRC by modifying xmrig config directly
      case "$mining_level" in
        0)
          LEVEL_CMD="doas rc-service xmrig stop 2>/dev/null || doas systemctl stop xmrig 2>/dev/null; echo 'mining off'"
          ;;
        1|2|3|4)
          # Map level to xmrig max-threads-hint percentage
          case "$mining_level" in
            1) HINT=12 ;; 2) HINT=25 ;; 3) HINT=50 ;; 4) HINT=100 ;;
          esac
          # Use sed to modify config (works on all nodes without jq)
          LEVEL_CMD="CFG=/etc/xmrig/config.json
if [ -f \"\$CFG\" ]; then
  doas sed -i 's/\"max-threads-hint\":[0-9]*/\"max-threads-hint\":$HINT/' \"\$CFG\"
fi
doas rc-service xmrig restart 2>/dev/null || doas systemctl restart xmrig 2>/dev/null
echo \"mining level $mining_level (${HINT}% CPU)\""
          ;;
        *)
          report_result "$cmd_id" "error: invalid mining level $mining_level" "" "$cmd" "$target"
          return
          ;;
      esac
      # Mining is phone-only — use "phones" scope
      NODES=$(resolve_target_nodes "$target" "phones")
      if [ -n "$NODES" ]; then
        run_on_all_tracked "$LEVEL_CMD" "$RESULT_DIR" "$NODES"
      else
        run_on_node_tracked "$(resolve_ip "$target")" "$LEVEL_CMD" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    display-mode)
      log "Setting display mode to $display_mode..."
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      # These phones have NO framebuffer console. The only way to display is:
      #   greetd -> cage (Wayland compositor) -> foot -> script
      # Cage launched from SSH has no logind seat and cannot access DRM.
      # The ONLY way to change display is: write .mode, update greetd config, reboot.
      # IMPORTANT: edit /etc/greetd/config.toml (NOT /etc/phrog/greetd-config.toml)
      if [ "$display_mode" = "off" ]; then
        # Kill cage — greetd won't restart it if we mask the service
        DISPLAY_CMD='doas killall cage 2>/dev/null; echo "display off (screen will be black until reboot)"'
      else
        # Write the mode file, ensure greetd config points to the wrapper, and reboot
        # The wrapper reads .mode and launches the right display program
        DISPLAY_CMD="mkdir -p /home/user/display && echo '$display_mode' > /home/user/display/.mode && doas sh -c 'printf \"[terminal]\nvt = 7\n\n[default_session]\ncommand = \\\\\"cage -s -- foot -f monospace:size=18 -e /home/user/display/greetd-wrapper.sh\\\\\"\nuser = \\\\\"user\\\\\"\n\" > /etc/greetd/config.toml' && echo 'display mode set to $display_mode — rebooting' && doas reboot"
      fi
      if [ "$target" = "pcs" ]; then
        report_result "$cmd_id" "skipped: display-mode is phone-only" "" "$cmd" "$target"
        return
      fi
      NODES=$(resolve_target_nodes "$target" "phones")
      if [ -n "$NODES" ]; then
        run_on_all_tracked "$DISPLAY_CMD" "$RESULT_DIR" "$NODES"
      else
        run_on_node_tracked "$(resolve_ip "$target")" "$DISPLAY_CMD" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    worker-start)
      log "Starting workers on $target..."
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      WORKER_CMD='. /home/user/.worker-env 2>/dev/null; export REDIS_HOST NODE_NAME WORKER_QUEUES; pkill -f "worker.py" 2>/dev/null; sleep 1; nohup python3 /home/user/worker.py >> /home/user/worker.log 2>&1 & sleep 2; pgrep -f "worker.py" >/dev/null && echo "worker started (PID: $(pgrep -f worker.py | head -1))" || echo "worker failed to start"'
      NODES=$(resolve_target_nodes "$target" "all")
      if [ -n "$NODES" ]; then
        run_on_all_tracked "$WORKER_CMD" "$RESULT_DIR" "$NODES"
      else
        run_on_node_tracked "$(resolve_ip "$target")" "$WORKER_CMD" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    worker-stop)
      log "Stopping workers on $target..."
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      WORKER_CMD='pkill -f "worker.py" 2>/dev/null && echo "worker stopped" || echo "no worker running"'
      NODES=$(resolve_target_nodes "$target" "all")
      if [ -n "$NODES" ]; then
        run_on_all_tracked "$WORKER_CMD" "$RESULT_DIR" "$NODES"
      else
        run_on_node_tracked "$(resolve_ip "$target")" "$WORKER_CMD" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    worker-status)
      log "Checking worker status..."
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      STATUS_CMD='W_PID=$(pgrep -f "worker.py" 2>/dev/null | head -1); if [ -n "$W_PID" ]; then echo "running (PID: $W_PID)"; tail -5 /home/user/worker.log 2>/dev/null; else echo "not running"; fi'
      NODES=$(resolve_target_nodes "$target" "all")
      if [ -n "$NODES" ]; then
        run_on_all_tracked "$STATUS_CMD" "$RESULT_DIR" "$NODES"
      else
        run_on_node_tracked "$(resolve_ip "$target")" "$STATUS_CMD" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    queue-status)
      log "Checking job queue status..."
      REDIS_HOST="${REDIS_HOST:-10.0.0.1}"
      if command -v redis-cli >/dev/null 2>&1 && redis-cli -h "$REDIS_HOST" PING 2>/dev/null | grep -q PONG; then
        Q_SHELL=$(redis-cli -h "$REDIS_HOST" LLEN jobs:shell 2>/dev/null || echo 0)
        Q_WHISPER=$(redis-cli -h "$REDIS_HOST" LLEN jobs:whisper 2>/dev/null || echo 0)
        Q_LLM=$(redis-cli -h "$REDIS_HOST" LLEN jobs:llm 2>/dev/null || echo 0)
        Q_IMAGE=$(redis-cli -h "$REDIS_HOST" LLEN jobs:image 2>/dev/null || echo 0)
        Q_AUDIO=$(redis-cli -h "$REDIS_HOST" LLEN jobs:audio 2>/dev/null || echo 0)
        Q_GENERIC=$(redis-cli -h "$REDIS_HOST" LLEN jobs:generic 2>/dev/null || echo 0)
        R_SHELL=$(redis-cli -h "$REDIS_HOST" LLEN results:shell 2>/dev/null || echo 0)
        R_WHISPER=$(redis-cli -h "$REDIS_HOST" LLEN results:whisper 2>/dev/null || echo 0)
        R_IMAGE=$(redis-cli -h "$REDIS_HOST" LLEN results:image 2>/dev/null || echo 0)
        R_AUDIO=$(redis-cli -h "$REDIS_HOST" LLEN results:audio 2>/dev/null || echo 0)
        TOTAL=$(redis-cli -h "$REDIS_HOST" GET stats:total:jobs_done 2>/dev/null || echo 0)
        DISPATCHED=$(redis-cli -h "$REDIS_HOST" GET stats:total:dispatched 2>/dev/null || echo 0)
        [ -z "$TOTAL" ] && TOTAL=0
        [ -z "$DISPATCHED" ] && DISPATCHED=0
        QINFO="queued: shell=$Q_SHELL whisper=$Q_WHISPER llm=$Q_LLM image=$Q_IMAGE audio=$Q_AUDIO generic=$Q_GENERIC | results: shell=$R_SHELL whisper=$R_WHISPER image=$R_IMAGE audio=$R_AUDIO | dispatched=$DISPATCHED done=$TOTAL"
        report_result "$cmd_id" "$QINFO" "" "$cmd" "$target"
      else
        report_result "$cmd_id" "error: redis not reachable at $REDIS_HOST" "" "$cmd" "$target"
      fi
      ;;
    submit-job)
      log "Submitting job to queue..."
      REDIS_HOST="${REDIS_HOST:-10.0.0.1}"
      JOB_TYPE=$(echo "$extra" | jq -r '.job_type // "shell"' 2>/dev/null || echo "shell")
      JOB_DATA=$(echo "$extra" | jq -r '.job_data // empty' 2>/dev/null || echo "")
      if [ -z "$JOB_DATA" ]; then
        report_result "$cmd_id" "error: no job_data in extra fields" "" "$cmd" "$target"
      elif command -v redis-cli >/dev/null 2>&1; then
        redis-cli -h "$REDIS_HOST" LPUSH "jobs:$JOB_TYPE" "$JOB_DATA" >/dev/null 2>&1
        report_result "$cmd_id" "job submitted to jobs:$JOB_TYPE" "" "$cmd" "$target"
      else
        report_result "$cmd_id" "error: redis-cli not installed" "" "$cmd" "$target"
      fi
      ;;
    browse)
      if [ -z "$url" ]; then
        report_result "$cmd_id" "error: no URL specified" "" "$cmd" "$target"
        return
      fi
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      if [ -n "$url" ]; then
        # Sanitize URL: only allow safe URL characters (strip single/double quotes and backticks)
        safe_url=$(printf '%s' "$url" | sed "s/[^a-zA-Z0-9:\/._~?#@!\$&()*+,;=%-]//g" | sed "s/['\"\`]//g")
        log "Opening $safe_url on phones..."
        # Use cage (minimal kiosk Wayland compositor) instead of Phosh.
        # cage runs a single app fullscreen - no lock screen, no shell.
        # Install cage if missing, write greetd config, restart greetd.
        BROWSE_CMD="doas apk add --no-progress cage 2>/dev/null || true
cat <<'GREETDEOF' | doas tee /etc/greetd/config.toml >/dev/null
[terminal]
vt = 7

[default_session]
command = \"cage -- firefox-esr --kiosk $safe_url\"
user = \"user\"
GREETDEOF
doas systemctl restart greetd 2>/dev/null || doas rc-service greetd restart 2>/dev/null"
        if [ "$target" = "pcs" ]; then
          report_result "$cmd_id" "skipped: browse is phone-only" "" "$cmd" "$target"
          return
        fi
        NODES=$(resolve_target_nodes "$target" "phones")
        if [ -n "$NODES" ]; then
          run_on_all_tracked "$BROWSE_CMD" "$RESULT_DIR" "$NODES"
        else
          run_on_node_tracked "$(resolve_ip "$target")" "$BROWSE_CMD" "$RESULT_DIR" "$target"
        fi
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    update)
      log "Updating scripts from GitHub..."
      REPO_RAW="https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts"
      SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
      FAIL=""
      SELF_UPDATED="false"
      for SCRIPT in push-cluster-status.sh poll-cluster-commands.sh cluster-nodes.conf; do
        if curl -sfL "$REPO_RAW/$SCRIPT" -o "$SCRIPT_DIR/$SCRIPT.new"; then
          chmod +x "$SCRIPT_DIR/$SCRIPT.new"
          mv "$SCRIPT_DIR/$SCRIPT.new" "$SCRIPT_DIR/$SCRIPT"
          log "  Updated $SCRIPT"
          [ "$SCRIPT" = "poll-cluster-commands.sh" ] && SELF_UPDATED="true"
        else
          log "  Failed to download $SCRIPT"
          FAIL="$FAIL $SCRIPT"
          rm -f "$SCRIPT_DIR/$SCRIPT.new"
        fi
      done
      if [ -z "$FAIL" ]; then
        report_result "$cmd_id" "success: scripts updated" "" "$cmd" "$target"
      else
        report_result "$cmd_id" "partial: failed$FAIL" "" "$cmd" "$target"
      fi
      # Re-exec ourselves if the poller script was updated (picks up new code)
      if [ "$SELF_UPDATED" = "true" ]; then
        log "Poller script updated — restarting with exec..."
        exec "$SCRIPT_DIR/poll-cluster-commands.sh"
      fi
      ;;
    debug)
      # Diagnostic command: report internal state of the running poller
      DEBUG_INFO="LOCAL_IP=$LOCAL_IP
ALL_LOCAL_IPS=$ALL_LOCAL_IPS
SCRIPT_DIR=$SCRIPT_DIR
SCRIPT_PATH=$0
PID=$$
HOSTNAME=$(hostname 2>/dev/null)
IP_WLAN0=$(ip -4 addr show wlan0 2>/dev/null | grep -o 'inet [0-9.]*' | cut -d' ' -f2)
IP_ALL=$(ip -4 addr 2>/dev/null | grep -o 'inet [0-9.]*' | cut -d' ' -f2 | tr '\n' ' ')
HOSTNAME_I=$(hostname -I 2>/dev/null)
TEST_IS_LOCAL_206=$(is_local_ip 192.168.1.206 && echo YES || echo NO)
BUSYBOX=$(busybox --help 2>/dev/null | head -1)
HEAD_SCRIPT=$(head -15 "$0" 2>/dev/null)"
      report_result "$cmd_id" "debug info" "$DEBUG_INFO" "$cmd" "$target"
      ;;
    reboot)
      log "Rebooting $target..."
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      reboot_node() {
        local name="$1" ip="$2"
        if run_on_node "$ip" "echo ok" >/dev/null 2>&1; then
          echo "ok" > "$RESULT_DIR/$name"
          run_on_node "$ip" "doas reboot" >/dev/null 2>&1 || true
        else
          echo "fail" > "$RESULT_DIR/$name"
        fi
      }
      NODES=$(resolve_target_nodes "$target" "all")
      if [ -n "$NODES" ]; then
        for entry in $NODES; do
          name="${entry%%:*}"; ip="${entry##*:}"
          reboot_node "$name" "$ip" &
        done
        wait
      else
        IP=$(resolve_ip "$target")
        reboot_node "$target" "$IP"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      if [ "$RESULT" = "success" ]; then
        RESULT="success: reboot initiated"
      fi
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    ssh)
      if [ -z "$ssh_cmd" ]; then
        report_result "$cmd_id" "error: no command specified" "" "$cmd" "$target"
      # Block shell metacharacters that could enable injection (matches JS-side filter)
      elif printf '%s' "$ssh_cmd" | grep -qE '[;|&\$\`\\><\{\}\(\)!~\[\]*?]|\$\(|rm -rf /|mkfs|dd if=|:[(][)][{]|/dev/sd|shutdown|halt|poweroff|init 0|kill -9 1'; then
        log "BLOCKED dangerous SSH command: $ssh_cmd"
        report_result "$cmd_id" "error: command blocked for safety" "" "$cmd" "$target"
      else
        log "Running SSH command: $ssh_cmd"
        OUTPUT=""
        FAIL=0
        TOTAL=0
        NODES=$(resolve_target_nodes "$target" "all")
        if [ -n "$NODES" ]; then
          SSH_OUT_DIR="/tmp/sshout-$cmd_id"
          mkdir -p "$SSH_OUT_DIR"
          for entry in $NODES; do
            name="${entry%%:*}"; ip="${entry##*:}"
            TOTAL=$((TOTAL + 1))
            ( NODE_OUT=$(run_on_node_full "$ip" "$ssh_cmd")
              NODE_RC=$?
              if [ "$NODE_RC" -ne 0 ]; then
                NODE_OUT="[exit code $NODE_RC] $NODE_OUT"
                echo "fail" > "$SSH_OUT_DIR/${name}.rc"
              fi
              echo "$NODE_OUT" > "$SSH_OUT_DIR/${name}.out"
            ) &
          done
          wait
          for entry in $NODES; do
            name="${entry%%:*}"
            NODE_OUT=""
            [ -f "$SSH_OUT_DIR/${name}.out" ] && NODE_OUT=$(cat "$SSH_OUT_DIR/${name}.out")
            [ -f "$SSH_OUT_DIR/${name}.rc" ] && FAIL=$((FAIL + 1))
            OUTPUT="${OUTPUT}=== ${name} ===
${NODE_OUT}
"
          done
          rm -rf "$SSH_OUT_DIR"
        else
          IP=$(resolve_ip "$target")
          TOTAL=1
          OUTPUT=$(run_on_node_full "$IP" "$ssh_cmd")
          if [ $? -ne 0 ]; then FAIL=1; fi
        fi
        if [ "$FAIL" -eq 0 ]; then
          RESULT="success"
        elif [ "$FAIL" -eq "$TOTAL" ]; then
          RESULT="error: all $TOTAL nodes failed"
        else
          RESULT="partial: $FAIL/$TOTAL failed"
        fi
        # Truncate to 4000 chars for Netlify Blobs
        TRUNC_OUTPUT=$(printf '%.4000s' "$OUTPUT")
        report_result "$cmd_id" "$RESULT" "$TRUNC_OUTPUT" "$cmd" "$target"
      fi
      ;;
    screenshot)
      log "Capturing screenshots..."
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      SCREENSHOT_DIR="/tmp/screenshots-$cmd_id"
      mkdir -p "$RESULT_DIR" "$SCREENSHOT_DIR"

      # Screenshot capture command - tries grim (Wayland), fbgrab, screencap
      SCREEN_CMD='export XDG_RUNTIME_DIR=/run/user/$(id -u); export WAYLAND_DISPLAY=wayland-0; export DISPLAY=:0
OUT=/tmp/screen_capture.png; rm -f "$OUT" /tmp/screen_capture.jpg
if command -v grim >/dev/null 2>&1; then grim "$OUT" 2>/dev/null
elif command -v fbgrab >/dev/null 2>&1; then fbgrab "$OUT" 2>/dev/null
elif command -v screencap >/dev/null 2>&1; then screencap -p "$OUT" 2>/dev/null
else echo "NO_TOOL" && exit 1; fi
if [ -f "$OUT" ]; then
  if command -v convert >/dev/null 2>&1; then
    convert "$OUT" -resize 540x1080\> -quality 60 /tmp/screen_capture.jpg 2>/dev/null
    if [ -f /tmp/screen_capture.jpg ]; then base64 /tmp/screen_capture.jpg; rm -f "$OUT" /tmp/screen_capture.jpg; exit 0; fi
  fi
  if command -v pngquant >/dev/null 2>&1; then
    pngquant --quality=40-60 --speed=1 --output /tmp/screen_q.png "$OUT" 2>/dev/null
    if [ -f /tmp/screen_q.png ]; then base64 /tmp/screen_q.png; rm -f "$OUT" /tmp/screen_q.png; exit 0; fi
  fi
  base64 "$OUT"; rm -f "$OUT"
else echo "CAPTURE_FAILED" && exit 1; fi'

      capture_node() {
        local i="$1"
        local node_name="node$i"
        local ip=$(resolve_ip "$node_name")
        local outfile="$SCREENSHOT_DIR/${node_name}.b64"

        B64=$(run_on_node "$ip" "$SCREEN_CMD")

        if [ -n "$B64" ] && [ "$B64" != "NO_TOOL" ] && [ "$B64" != "CAPTURE_FAILED" ]; then
          # Validate size: base64 data should be under 1.5MB (2MB limit on Netlify side)
          B64_SIZE=$(printf '%s' "$B64" | wc -c)
          if [ "$B64_SIZE" -gt 1500000 ] 2>/dev/null; then
            log "  WARN: screenshot for $node_name too large (${B64_SIZE} bytes), skipping"
            echo "fail" > "$RESULT_DIR/$node_name"
          else
            echo "$B64" > "$outfile"
            echo "ok" > "$RESULT_DIR/$node_name"
          fi
        else
          echo "fail" > "$RESULT_DIR/$node_name"
        fi
      }

      if [ "$target" = "pcs" ]; then
        report_result "$cmd_id" "skipped: screenshot is phone-only" "" "$cmd" "$target"
        return
      fi
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        for i in $(seq 1 10); do capture_node "$i" & done
        wait
      else
        NODE_NUM=$(echo "$target" | sed 's/node//')
        capture_node "$NODE_NUM"
      fi

      # Upload each screenshot to Netlify Blobs
      for b64file in "$SCREENSHOT_DIR"/*.b64; do
        [ -f "$b64file" ] || continue
        NODE_NAME=$(basename "$b64file" .b64)
        B64_DATA=$(cat "$b64file")
        # Detect JPEG (starts with /9j/) vs PNG
        MIME="image/png"
        case "$B64_DATA" in /9j/*) MIME="image/jpeg" ;; esac
        curl -s -X POST "$API_URL" \
          -H "Content-Type: application/json" \
          -H "X-Cluster-Key: $API_KEY" \
          -d "$(jq -n --arg node "$NODE_NAME" --arg img "data:${MIME};base64,${B64_DATA}" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            '{action:"screenshot-upload",node:$node,image:$img,timestamp:$ts}')" >/dev/null 2>&1 || true
        log "  Uploaded screenshot for $NODE_NAME"
      done

      rm -rf "$SCREENSHOT_DIR"
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    brightness)
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      BRIGHTNESS_VAL="$ssh_cmd"
      # Validate brightness is a number 0-255
      if [ -z "$BRIGHTNESS_VAL" ]; then
        report_result "$cmd_id" "error: no brightness value" "" "$cmd" "$target"
      elif ! printf '%s' "$BRIGHTNESS_VAL" | grep -qE '^[0-9]+$' || [ "$BRIGHTNESS_VAL" -gt 255 ]; then
        report_result "$cmd_id" "error: brightness must be a number 0-255" "" "$cmd" "$target"
      else
        if [ "$target" = "pcs" ]; then
          report_result "$cmd_id" "skipped: brightness is phone-only" "" "$cmd" "$target"
          return
        fi
        log "Setting brightness to $BRIGHTNESS_VAL..."
        BRIGHT_CMD="doas sh -c 'for f in /sys/class/backlight/*/brightness; do echo $BRIGHTNESS_VAL > \"\$f\"; done' 2>/dev/null || doas sh -c 'echo $BRIGHTNESS_VAL > /sys/class/leds/lcd-backlight/brightness' 2>/dev/null"
        NODES=$(resolve_target_nodes "$target" "phones")
        if [ -n "$NODES" ]; then
          run_on_all_tracked "$BRIGHT_CMD" "$RESULT_DIR" "$NODES"
        else
          run_on_node_tracked "$(resolve_ip "$target")" "$BRIGHT_CMD" "$RESULT_DIR" "$target"
        fi
        RESULT=$(collect_results "$RESULT_DIR")
        report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      fi
      ;;
    pod-logs)
      # Fetch pod logs via kubectl (runs on node1 which has kubectl access)
      POD_NS="$NAMESPACE"
      POD_NAME="$POD_NAME_Q"
      POD_TAIL="$TAIL_LINES"
      if [ -z "$POD_NS" ] || [ -z "$POD_NAME" ]; then
        report_result "$cmd_id" "error: namespace and podName required" "" "$cmd" "$target"
      elif ! printf '%s' "$POD_NS" | grep -qE '^[a-zA-Z0-9._-]+$' || ! printf '%s' "$POD_NAME" | grep -qE '^[a-zA-Z0-9._-]+$'; then
        report_result "$cmd_id" "error: invalid namespace or pod name" "" "$cmd" "$target"
      else
        # Clamp tail lines
        [ "$POD_TAIL" -gt 500 ] 2>/dev/null && POD_TAIL=500
        [ "$POD_TAIL" -lt 1 ] 2>/dev/null && POD_TAIL=100
        LOG_OUTPUT=$(kubectl logs "$POD_NAME" -n "$POD_NS" --tail="$POD_TAIL" 2>&1)
        if [ $? -eq 0 ]; then
          TRUNC_LOG=$(printf '%.4000s' "$LOG_OUTPUT")
          report_result "$cmd_id" "success" "$TRUNC_LOG" "$cmd" "$target"
        else
          report_result "$cmd_id" "error: $LOG_OUTPUT" "" "$cmd" "$target"
        fi
      fi
      ;;
    *)
      log "Unknown command: $cmd"
      report_result "$cmd_id" "error: unknown command" "" "$cmd" "$target"
      ;;
  esac
}

log "Starting command poller (interval: ${POLL_INTERVAL}s)"

# Backoff state for API failures
CONSECUTIVE_FAILURES=0
MAX_BACKOFF=120  # max backoff interval in seconds

get_poll_delay() {
  if [ "$CONSECUTIVE_FAILURES" -eq 0 ]; then
    echo "$POLL_INTERVAL"
  else
    # Exponential backoff: 10, 20, 40, 80, 120 (capped)
    local delay=$((POLL_INTERVAL * 2 * CONSECUTIVE_FAILURES))
    [ "$delay" -gt "$MAX_BACKOFF" ] && delay=$MAX_BACKOFF
    echo "$delay"
  fi
}

# Schedule checking state
LAST_SCHED_CHECK=0

check_schedules() {
  NOW=$(date +%s)
  ELAPSED=$((NOW - LAST_SCHED_CHECK))

  # Only check every 60 seconds
  [ "$ELAPSED" -lt 60 ] && return
  LAST_SCHED_CHECK=$NOW

  LOCAL_TIME=$(date '+%H:%M')
  LOCAL_DATE=$(date '+%Y-%m-%d')
  SCHED_RESP=$(curl -s -X POST "$API_URL" \
    -H "Content-Type: application/json" \
    -H "X-Cluster-Key: $API_KEY" \
    -d "$(jq -n --arg t "$LOCAL_TIME" --arg d "$LOCAL_DATE" '{action:"check-schedule",localTime:$t,localDate:$d}')" 2>/dev/null || echo '{"commands":[]}')

  SCHED_COUNT=$(echo "$SCHED_RESP" | jq '.commands | length' 2>/dev/null || echo 0)

  if [ "$SCHED_COUNT" -gt 0 ]; then
    i=0
    while [ "$i" -lt "$SCHED_COUNT" ]; do
      SCHED_CMD=$(echo "$SCHED_RESP" | jq -r ".commands[$i].command")
      SCHED_TARGET=$(echo "$SCHED_RESP" | jq -r ".commands[$i].target")
      log "Scheduled command: $SCHED_CMD on $SCHED_TARGET"
      execute_command "$SCHED_CMD" "$SCHED_TARGET" "" "sched-$(date +%s)-$i" ""
      i=$((i + 1))
    done
  fi
}

while true; do
  # Check scheduled commands
  check_schedules

  # Poll for queued commands
  RESPONSE=$(curl -sL --max-time 15 "$API_URL?action=poll" \
    -H "X-Cluster-Key: $API_KEY" 2>/dev/null)
  CURL_RC=$?

  if [ "$CURL_RC" -ne 0 ] || [ -z "$RESPONSE" ]; then
    CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
    DELAY=$(get_poll_delay)
    log "WARN: API poll failed (attempt $CONSECUTIVE_FAILURES), backing off ${DELAY}s"
    sleep "$DELAY"
    continue
  fi

  # Reset backoff on successful response
  if [ "$CONSECUTIVE_FAILURES" -gt 0 ]; then
    log "API connection restored after $CONSECUTIVE_FAILURES failures"
  fi
  CONSECUTIVE_FAILURES=0

  CMD=$(echo "$RESPONSE" | jq -r '.command // empty')

  if [ -n "$CMD" ]; then
    TARGET=$(echo "$RESPONSE" | jq -r '.target // empty')
    URL=$(echo "$RESPONSE" | jq -r '.url // empty')
    CMD_ID=$(echo "$RESPONSE" | jq -r '.id // empty')
    SSH_CMD=$(echo "$RESPONSE" | jq -r '.sshCmd // empty')
    NAMESPACE=$(echo "$RESPONSE" | jq -r '.namespace // empty')
    POD_NAME_Q=$(echo "$RESPONSE" | jq -r '.podName // empty')
    TAIL_LINES=$(echo "$RESPONSE" | jq -r '.tail // "100"')
    DISPLAY_MODE=$(echo "$RESPONSE" | jq -r '.displayMode // empty')
    MINING_LEVEL=$(echo "$RESPONSE" | jq -r '.miningLevel // empty')
    log "Got command: $CMD target=$TARGET id=$CMD_ID"
    execute_command "$CMD" "$TARGET" "$URL" "$CMD_ID" "$SSH_CMD"
  fi

  sleep "$POLL_INTERVAL"
done
