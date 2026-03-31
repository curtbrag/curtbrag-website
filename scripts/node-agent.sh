#!/bin/sh
# node-agent.sh — Cluster Control Plane Node Agent
# Runs on each phone/PC. Registers with control plane, sends telemetry,
# enforces desired state, kills rogue processes, executes queued commands.
#
# Install:
#   scp node-agent.sh user@192.168.1.xxx:/home/user/node-agent.sh
#   ssh user@192.168.1.xxx 'chmod +x ~/node-agent.sh && nohup ~/node-agent.sh > /tmp/agent.log 2>&1 &'
#
# Config (saved after first registration):
#   ~/.cluster-agent-identity  — device_id + agent_token

set -u

CONTROL_PLANE="${CONTROL_PLANE_URL:-https://curtbrag.com}"
AGENT_API="$CONTROL_PLANE/api/agent"
IDENTITY_FILE="${HOME}/.cluster-agent-identity"
LOG_FILE="/tmp/agent.log"
AGENT_VERSION="1.0"

# ── Shared API key used only for initial registration ─────────────────────────
CLUSTER_API_KEY=""
for _f in "${HOME:-/home/user}/.cluster-env" /home/user/.cluster-env; do
  [ -f "$_f" ] && { . "$_f"; break; }
done

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

# ── Identity ──────────────────────────────────────────────────────────────────
DEVICE_ID=""
AGENT_TOKEN=""
TELEMETRY_INTERVAL=60

load_identity() {
  if [ -f "$IDENTITY_FILE" ]; then
    DEVICE_ID=$(grep '^DEVICE_ID=' "$IDENTITY_FILE" | cut -d= -f2-)
    AGENT_TOKEN=$(grep '^AGENT_TOKEN=' "$IDENTITY_FILE" | cut -d= -f2-)
  fi
}

save_identity() {
  printf 'DEVICE_ID=%s\nAGENT_TOKEN=%s\n' "$DEVICE_ID" "$AGENT_TOKEN" > "$IDENTITY_FILE"
  chmod 600 "$IDENTITY_FILE"
}

# ── Helpers ───────────────────────────────────────────────────────────────────
get_hostname() { hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null || echo "unknown"; }

get_primary_ip() {
  ip route get 1.1.1.1 2>/dev/null | awk '/src/ {for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1 \
  || hostname -I 2>/dev/null | awk '{print $1}'
}

get_interface_type() {
  local ip; ip=$(get_primary_ip)
  # Check if IP is a Tailscale address
  case "$ip" in 100.*) echo "tailscale"; return ;; esac
  # Find interface for this IP
  local iface; iface=$(ip route get 1.1.1.1 2>/dev/null | awk '/dev/ {for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' | head -1)
  case "$iface" in
    eth*|enp*|eno*|end*|lan*) echo "ethernet" ;;
    wlan*|wlp*|wifi*) echo "wifi" ;;
    tailscale*|ts*) echo "tailscale" ;;
    *) echo "unknown" ;;
  esac
}

get_device_class() {
  local host; host=$(get_hostname)
  case "$host" in
    node*) echo "phone" ;;
    steamdeck) echo "steamdeck" ;;
    nexus-prime|skynet|viki) echo "pc" ;;
    *) echo "unknown" ;;
  esac
}

get_load() { cat /proc/loadavg 2>/dev/null | awk '{print $1}'; }

get_mem() {
  awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{print t-a, t}' /proc/meminfo 2>/dev/null \
  | awk '{printf "%d %d", $1/1024, $2/1024}'
}

get_swap() {
  awk '/SwapTotal/{t=$2} /SwapFree/{f=$2} END{print t-f, t}' /proc/meminfo 2>/dev/null \
  | awk '{printf "%d %d", $1/1024, $2/1024}'
}

get_temp() {
  local max=0 t
  for f in /sys/class/thermal/thermal_zone*/temp; do
    [ -f "$f" ] || continue
    t=$(cat "$f" 2>/dev/null); t=${t:-0}
    t=$((t / 1000))
    [ "$t" -gt "$max" ] && max=$t
  done
  echo "$max"
}

get_battery() {
  local pct="" status=""
  for p in /sys/class/power_supply/battery /sys/class/power_supply/BAT0 /sys/class/power_supply/BAT1; do
    [ -d "$p" ] || continue
    pct=$(cat "$p/capacity" 2>/dev/null)
    status=$(cat "$p/status" 2>/dev/null)
    break
  done
  echo "${pct:-0} ${status:-unknown}"
}

get_storage_free() {
  df -m / 2>/dev/null | awk 'NR==2 {print $4}'
}

get_uptime_secs() {
  awk '{printf "%d", $1}' /proc/uptime 2>/dev/null
}

# ── Miner state ───────────────────────────────────────────────────────────────
APPROVED_BINARY="/home/user/xmrig-custom"

get_xmrig_pids() {
  # Returns: custom_pid rogue_pid
  local custom="" rogue=""
  # Find all xmrig processes
  for pid in $(pgrep -x xmrig 2>/dev/null || pgrep -f 'xmrig' 2>/dev/null); do
    local cmdline; cmdline=$(cat "/proc/$pid/cmdline" 2>/dev/null | tr '\0' ' ')
    local exe; exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null)
    if echo "$exe" | grep -q "xmrig-custom"; then
      custom="$pid"
    else
      rogue="$pid"
    fi
  done
  echo "$custom $rogue"
}

get_xmrig_stats() {
  # Try to get hashrate from log
  local hr10="" hr60="" hr15m="" accepted="" config_ver=""
  local logfile="/tmp/xmrig.log"
  if [ -f "$logfile" ]; then
    hr10=$(tail -50 "$logfile" 2>/dev/null | grep -o '[0-9.]\+ H/s' | tail -1 | awk '{print $1}')
    accepted=$(tail -100 "$logfile" 2>/dev/null | grep -o 'accepted [0-9]*' | tail -1 | awk '{print $2}')
  fi
  echo "${hr10:-0} ${hr60:-0} ${hr15m:-0} ${accepted:-0}"
}

hash_binary() {
  local path="$1"
  [ -f "$path" ] || { echo ""; return; }
  sha256sum "$path" 2>/dev/null | awk '{print $1}'
}

# ── Rogue process enforcement ─────────────────────────────────────────────────
check_and_kill_rogue() {
  local pids; pids=$(get_xmrig_pids)
  local rogue; rogue=$(echo "$pids" | awk '{print $2}')
  [ -z "$rogue" ] && return 0

  log "ROGUE xmrig detected: PID $rogue — killing"
  kill -9 "$rogue" 2>/dev/null
  doas kill -9 "$rogue" 2>/dev/null
  post_event "critical" "rogue_process_killed" "Killed rogue xmrig PID $rogue"
  return 1
}

check_blocked_paths() {
  for p in /usr/local/bin/xmrig /usr/bin/xmrig; do
    [ -f "$p" ] || continue
    log "ROGUE BINARY at $p — removing"
    rm -f "$p" 2>/dev/null || doas rm -f "$p" 2>/dev/null
    post_event "critical" "rogue_binary_removed" "Removed rogue binary at $p"
  done
}

check_cron_drift() {
  local bad=""
  # Check user crontab
  local ctab; ctab=$(crontab -l 2>/dev/null || true)
  if echo "$ctab" | grep -qE '(xmrig|start-xmrig)'; then
    bad="user crontab"
    crontab -l 2>/dev/null | grep -vE '(xmrig|start-xmrig)' | crontab - 2>/dev/null
    log "Removed unauthorized xmrig entries from user crontab"
  fi
  # Check root crontab files
  for f in /etc/crontabs/root /etc/cron.d/xmrig /etc/periodic/15min/start-xmrig \
            /etc/periodic/hourly/start-xmrig /etc/periodic/daily/start-xmrig; do
    [ -f "$f" ] || continue
    if grep -qE '(xmrig|start-xmrig)' "$f" 2>/dev/null; then
      bad="$bad $f"
      doas sed -i '/xmrig/d' "$f" 2>/dev/null || true
      doas sed -i '/start-xmrig/d' "$f" 2>/dev/null || true
      log "Removed unauthorized xmrig entries from $f"
    fi
  done
  [ -n "$bad" ] && post_event "warning" "cron_drift" "Unauthorized cron entries removed: $bad"
}

replace_wrapper_stub() {
  local stub="/home/user/start-xmrig.sh"
  if [ -f "$stub" ]; then
    local content; content=$(cat "$stub" 2>/dev/null)
    if echo "$content" | grep -qv '# STUB'; then
      log "Replacing start-xmrig.sh with harmless stub"
      printf '#!/bin/sh\n# STUB: managed by node-agent. Do not edit.\nexit 0\n' > "$stub"
      chmod +x "$stub"
      post_event "warning" "wrapper_stubbed" "Replaced start-xmrig.sh with stub"
    fi
  fi
}

# ── HTTP helpers ──────────────────────────────────────────────────────────────
http_post() {
  local url="$1" body="$2" extra_headers="${3:-}"
  curl -s -X POST "$url" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Token: $AGENT_TOKEN" \
    -H "X-Device-Id: $DEVICE_ID" \
    $extra_headers \
    --data "$body" \
    --max-time 15 2>/dev/null
}

http_get() {
  local url="$1"
  curl -s "$url" \
    -H "X-Agent-Token: $AGENT_TOKEN" \
    -H "X-Device-Id: $DEVICE_ID" \
    --max-time 15 2>/dev/null
}

post_event() {
  local severity="$1" type="$2" msg="$3"
  [ -z "$DEVICE_ID" ] && return
  local body; body=$(printf '{"severity":"%s","type":"%s","message":"%s"}' "$severity" "$type" "$msg")
  http_post "$AGENT_API/event" "$body" >/dev/null &
}

# ── Registration ──────────────────────────────────────────────────────────────
register() {
  local host; host=$(get_hostname)
  local ip; ip=$(get_primary_ip)
  local class; class=$(get_device_class)

  # CPU info
  local cpu_model; cpu_model=$(grep 'model name' /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2 | xargs)
  local cpu_cores; cpu_cores=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)
  local mem; mem=$(get_mem); local mem_used; mem_used=$(echo "$mem" | awk '{print $1}'); local mem_total; mem_total=$(echo "$mem" | awk '{print $2}')
  local arch; arch=$(uname -m 2>/dev/null)
  local kernel; kernel=$(uname -r 2>/dev/null)
  local os; os=$(cat /etc/os-release 2>/dev/null | grep '^PRETTY_NAME' | cut -d= -f2 | tr -d '"' || echo "Linux")

  local body; body=$(printf '{
    "hostname":"%s",
    "deviceClass":"%s",
    "agentVersion":"%s",
    "ips":{"primary":"%s"},
    "hardware":{"cpu":"%s","cores":%s,"ram_mb":%s,"arch":"%s"},
    "osInfo":{"os":"%s","kernel":"%s"}
  }' "$host" "$class" "$AGENT_VERSION" "$ip" \
     "${cpu_model:-unknown}" "${cpu_cores:-0}" "${mem_total:-0}" "$arch" \
     "$os" "$kernel")

  local resp; resp=$(curl -s -X POST "$AGENT_API/register" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Token: ${CLUSTER_API_KEY:-}" \
    --data "$body" \
    --max-time 20 2>/dev/null)

  local new_id; new_id=$(echo "$resp" | grep -o '"device_id":"[^"]*"' | cut -d'"' -f4)
  local new_token; new_token=$(echo "$resp" | grep -o '"agent_token":"[^"]*"' | cut -d'"' -f4)

  if [ -n "$new_id" ] && [ -n "$new_token" ]; then
    DEVICE_ID="$new_id"
    AGENT_TOKEN="$new_token"
    save_identity
    log "Registered as $DEVICE_ID"

    # Parse telemetry interval from desired state
    local interval; interval=$(echo "$resp" | grep -o '"telemetry_interval":[0-9]*' | cut -d: -f2)
    [ -n "$interval" ] && TELEMETRY_INTERVAL="$interval"
    return 0
  fi

  log "Registration failed: $resp"
  return 1
}

# ── Heartbeat ─────────────────────────────────────────────────────────────────
send_heartbeat() {
  local ip; ip=$(get_primary_ip)
  local body; body=$(printf '{"ip":"%s","agentVersion":"%s"}' "$ip" "$AGENT_VERSION")
  local resp; resp=$(http_post "$AGENT_API/heartbeat" "$body")

  # Parse updated telemetry_interval from desired state
  local interval; interval=$(echo "$resp" | grep -o '"telemetry_interval":[0-9]*' | cut -d: -f2)
  [ -n "$interval" ] && TELEMETRY_INTERVAL="$interval"
}

# ── Telemetry ─────────────────────────────────────────────────────────────────
send_telemetry() {
  local ip; ip=$(get_primary_ip)
  local iface_type; iface_type=$(get_interface_type)
  local load; load=$(get_load)
  local mem; mem=$(get_mem)
  local mem_used; mem_used=$(echo "$mem" | awk '{print $1}')
  local mem_total; mem_total=$(echo "$mem" | awk '{print $2}')
  local swap; swap=$(get_swap)
  local swap_used; swap_used=$(echo "$swap" | awk '{print $1}')
  local swap_total; swap_total=$(echo "$swap" | awk '{print $2}')
  local temp; temp=$(get_temp)
  local batt; batt=$(get_battery)
  local batt_pct; batt_pct=$(echo "$batt" | awk '{print $1}')
  local batt_status; batt_status=$(echo "$batt" | awk '{print $2}')
  local disk_free; disk_free=$(get_storage_free)
  local uptime; uptime=$(get_uptime_secs)

  # Miner state
  local pids; pids=$(get_xmrig_pids)
  local custom_pid; custom_pid=$(echo "$pids" | awk '{print $1}')
  local rogue_pid; rogue_pid=$(echo "$pids" | awk '{print $2}')
  local xmrig_running="false"
  [ -n "$custom_pid" ] && xmrig_running="true"

  local stats; stats=$(get_xmrig_stats)
  local hr10; hr10=$(echo "$stats" | awk '{print $1}')
  local accepted; accepted=$(echo "$stats" | awk '{print $4}')

  local binary_hash; binary_hash=$(hash_binary "$APPROVED_BINARY")

  # Check for rogue binary at blocked paths
  local rogue_binary="false"
  local rogue_binary_path=""
  for p in /usr/local/bin/xmrig /usr/bin/xmrig; do
    if [ -f "$p" ]; then
      rogue_binary="true"
      rogue_binary_path="$p"
      break
    fi
  done

  local body; body=$(printf '{
    "ip":"%s",
    "interface_type":"%s",
    "load_avg":"%s",
    "memory_used_mb":%s,
    "memory_total_mb":%s,
    "swap_used_mb":%s,
    "swap_total_mb":%s,
    "temp_peak":%s,
    "battery_pct":%s,
    "battery_status":"%s",
    "disk_free_mb":%s,
    "uptime_secs":%s,
    "xmrig_running":%s,
    "custom_pid":"%s",
    "rogue_pid":"%s",
    "hashrate_10s":%s,
    "accepted_shares":%s,
    "binary_hash":"%s",
    "rogue_binary_detected":%s,
    "rogue_binary_path":"%s"
  }' "$ip" "$iface_type" "$load" \
     "${mem_used:-0}" "${mem_total:-1}" \
     "${swap_used:-0}" "${swap_total:-0}" \
     "${temp:-0}" "${batt_pct:-0}" "${batt_status:-unknown}" \
     "${disk_free:-0}" "${uptime:-0}" \
     "$xmrig_running" "${custom_pid:-}" "${rogue_pid:-}" \
     "${hr10:-0}" "${accepted:-0}" \
     "${binary_hash:-}" \
     "$rogue_binary" "${rogue_binary_path:-}")

  http_post "$AGENT_API/state" "$body" >/dev/null
}

# ── Command execution ─────────────────────────────────────────────────────────
execute_command() {
  local cmd_id="$1" cmd_type="$2" payload="$3"
  log "Executing command: $cmd_type (id=$cmd_id)"

  local stdout="" stderr="" success="true" exit_code=0

  case "$cmd_type" in
    mining-start|start)
      if [ -f "$APPROVED_BINARY" ]; then
        nohup "$APPROVED_BINARY" --config=/etc/xmrig/config.json --no-color >> /tmp/xmrig.log 2>&1 &
        stdout="Mining started (PID $!)"
      else
        stdout="Approved binary not found at $APPROVED_BINARY"
        success="false"; exit_code=1
      fi
      ;;
    mining-stop|stop)
      pkill -f "xmrig-custom" 2>/dev/null && stdout="Mining stopped" || stdout="No miner running"
      ;;
    mining-status|status)
      stdout=$(ps aux 2>/dev/null | grep -i xmrig | grep -v grep || echo "no xmrig processes")
      ;;
    kill-rogue)
      check_and_kill_rogue
      check_blocked_paths
      stdout="Rogue process sweep complete"
      ;;
    reconcile)
      check_and_kill_rogue
      check_blocked_paths
      check_cron_drift
      replace_wrapper_stub
      stdout="Reconcile complete"
      ;;
    reboot)
      stdout="Rebooting in 5s..."
      ( sleep 5; doas reboot 2>/dev/null || reboot 2>/dev/null ) &
      ;;
    ssh)
      local sshcmd; sshcmd=$(echo "$payload" | grep -o '"command":"[^"]*"' | cut -d'"' -f4)
      if [ -n "$sshcmd" ]; then
        stdout=$(sh -c "$sshcmd" 2>&1) && exit_code=0 || exit_code=$?
        [ $exit_code -ne 0 ] && success="false"
      fi
      ;;
    fetch-logs)
      stdout=$(tail -100 /tmp/xmrig.log 2>/dev/null || echo "no log")
      ;;
    run-diagnostic)
      stdout=$(printf 'uptime: %s\nload: %s\ntemp: %s\nmem: %s\npids: %s\nbinary_hash: %s\n' \
        "$(uptime 2>/dev/null)" "$(get_load)" "$(get_temp)" "$(get_mem)" \
        "$(get_xmrig_pids)" "$(hash_binary "$APPROVED_BINARY")")
      ;;
    screenshot)
      # Capture framebuffer if available
      local scr="/tmp/screenshot.png"
      fbcat "$scr" 2>/dev/null || ffmpeg -f fbdev -i /dev/fb0 -vframes 1 "$scr" 2>/dev/null
      stdout="Screenshot captured: $scr"
      ;;
    *)
      stdout="Unknown command: $cmd_type"
      success="false"; exit_code=1
      ;;
  esac

  # Report result
  local stdout_esc; stdout_esc=$(printf '%s' "$stdout" | head -c 3000 | sed 's/"/\\"/g; s/\n/\\n/g')
  local body; body=$(printf '{"command_id":"%s","success":%s,"exit_code":%s,"stdout":"%s","stderr":""}' \
    "$cmd_id" "$success" "$exit_code" "$stdout_esc")
  http_post "$AGENT_API/command-result" "$body" >/dev/null
}

poll_and_execute_commands() {
  local resp; resp=$(http_get "$AGENT_API/commands")
  [ -z "$resp" ] && return

  # Parse command array (simple approach for POSIX sh without jq)
  # Each command is: {"id":"...","type":"...","payload":{...},...}
  # Extract IDs and types using grep
  local ids; ids=$(echo "$resp" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
  [ -z "$ids" ] && return

  # Process each command (requires jq if available, fallback to grep)
  if command -v jq >/dev/null 2>&1; then
    echo "$resp" | jq -c '.commands[]?' 2>/dev/null | while read -r cmd; do
      local cid; cid=$(echo "$cmd" | jq -r '.id')
      local ctype; ctype=$(echo "$cmd" | jq -r '.type')
      local cpayload; cpayload=$(echo "$cmd" | jq -c '.payload // {}')
      execute_command "$cid" "$ctype" "$cpayload"
    done
  else
    # Minimal fallback: just get first command id+type
    local cid; cid=$(echo "$resp" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    local ctype; ctype=$(echo "$resp" | grep -o '"type":"[^"]*"' | head -1 | cut -d'"' -f4)
    [ -n "$cid" ] && [ -n "$ctype" ] && execute_command "$cid" "$ctype" "{}"
  fi
}

# ── Desired-state reconcile loop ──────────────────────────────────────────────
reconcile_desired_state() {
  # Kill rogue processes
  check_and_kill_rogue
  # Remove rogue binaries
  check_blocked_paths
  # Fix cron drift
  check_cron_drift
  # Replace wrapper stub
  replace_wrapper_stub
}

# ── Main loop ─────────────────────────────────────────────────────────────────
main() {
  log "node-agent $AGENT_VERSION starting on $(get_hostname)"

  # Load saved identity
  load_identity

  # Register if no identity
  if [ -z "$DEVICE_ID" ] || [ -z "$AGENT_TOKEN" ]; then
    if [ -z "${CLUSTER_API_KEY:-}" ]; then
      log "ERROR: CLUSTER_API_KEY not set. Cannot register."
      log "Create ~/.cluster-env with: CLUSTER_API_KEY=your-key"
      exit 1
    fi
    log "No identity found — registering..."
    register || { log "Registration failed, retrying in 60s..."; sleep 60; exec "$0"; }
  fi

  log "Running as device: $DEVICE_ID"

  LAST_TELEMETRY=0
  LAST_RECONCILE=0

  while true; do
    NOW=$(date +%s)

    # Heartbeat every loop
    send_heartbeat 2>/dev/null || log "Heartbeat failed"

    # Telemetry every TELEMETRY_INTERVAL seconds
    if [ $((NOW - LAST_TELEMETRY)) -ge "${TELEMETRY_INTERVAL:-60}" ]; then
      send_telemetry 2>/dev/null || log "Telemetry failed"
      LAST_TELEMETRY=$NOW
    fi

    # Poll and execute commands
    poll_and_execute_commands 2>/dev/null

    # Reconcile desired state every 5 minutes
    if [ $((NOW - LAST_RECONCILE)) -ge 300 ]; then
      reconcile_desired_state 2>/dev/null
      LAST_RECONCILE=$NOW
    fi

    sleep 15
  done
}

main "$@"
