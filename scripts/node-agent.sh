#!/bin/sh
# node-agent.sh — Cluster Control Plane Node Agent
# Runs on each phone/PC (Linux + Termux/Android compatible).
# Registers with control plane, sends telemetry, enforces desired state,
# runs preflight before mining, kills rogue processes, executes commands.
#
# Install (Termux):
#   scp node-agent.sh user@192.168.1.191:~/node-agent.sh
#   ssh user@192.168.1.191 'chmod +x ~/node-agent.sh && nohup ~/node-agent.sh > ~/cluster/logs/agent.log 2>&1 &'
#
# Config:
#   ~/.cluster-env              — CLUSTER_API_KEY + CONTROL_PLANE_URL
#   ~/.cluster-agent-identity   — device_id + agent_token (written on first registration)

set -u

CONTROL_PLANE="${CONTROL_PLANE_URL:-https://curtbrag.com}"
AGENT_API="$CONTROL_PLANE/api/agent"
IDENTITY_FILE="${HOME}/.cluster-agent-identity"
AGENT_VERSION="1.1"

# Ensure log directory exists
mkdir -p "${HOME}/cluster/logs" 2>/dev/null || true
LOG_FILE="${HOME}/cluster/logs/agent.log"

# ── Shared API key (registration only) ───────────────────────────────────────
CLUSTER_API_KEY=""
for _f in "${HOME}/.cluster-env" /home/user/.cluster-env /data/data/com.termux/files/home/.cluster-env; do
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

# ── Helpers (Android/Termux-safe) ────────────────────────────────────────────
get_hostname() {
  hostname 2>/dev/null \
  || cat /proc/sys/kernel/hostname 2>/dev/null \
  || getprop ro.product.device 2>/dev/null \
  || echo "unknown"
}

get_primary_ip() {
  # Try ip first (Linux), fall back to ifconfig (Termux/Android)
  ip route get 1.1.1.1 2>/dev/null \
    | awk '/src/ {for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1 \
  || ifconfig 2>/dev/null \
    | awk '/inet /{print $2}' | grep -v '127\.' | head -1 \
  || echo "unknown"
}

get_interface_type() {
  local ip; ip=$(get_primary_ip)
  case "$ip" in 100.*) echo "tailscale"; return ;; esac
  # Try ip route first, fallback to ifconfig parse
  local iface
  iface=$(ip route get 1.1.1.1 2>/dev/null \
    | awk '/dev/ {for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' | head -1)
  [ -z "$iface" ] && iface=$(ifconfig 2>/dev/null | awk '/inet /{print iface} {iface=$1}' \
    | grep -v lo | head -1 | tr -d ':')
  case "$iface" in
    eth*|enp*|eno*|end*|lan*) echo "ethernet" ;;
    wlan*|wlp*|wifi*|wl*) echo "wifi" ;;
    tailscale*|ts*) echo "tailscale" ;;
    *) echo "wifi" ;;  # default for phones
  esac
}

get_device_class() {
  local host; host=$(get_hostname)
  case "$host" in
    node*) echo "phone" ;;
    steamdeck) echo "steamdeck" ;;
    nexus-prime|skynet|viki) echo "pc" ;;
    *) echo "phone" ;;  # default assumption for Termux devices
  esac
}

get_load() { cat /proc/loadavg 2>/dev/null | awk '{print $1}' || echo "0"; }

get_mem() {
  awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{if(t>0) printf "%d %d", (t-a)/1024, t/1024; else print "0 0"}' \
    /proc/meminfo 2>/dev/null || echo "0 0"
}

get_swap() {
  awk '/SwapTotal/{t=$2} /SwapFree/{f=$2} END{printf "%d %d", (t-f)/1024, t/1024}' \
    /proc/meminfo 2>/dev/null || echo "0 0"
}

get_temp() {
  local max=0 t
  # Standard Linux thermal zones
  for f in /sys/class/thermal/thermal_zone*/temp; do
    [ -f "$f" ] || continue
    t=$(cat "$f" 2>/dev/null); t=${t:-0}
    # Values > 1000 are millidegrees
    [ "$t" -gt 1000 ] && t=$((t / 1000))
    [ "$t" -gt "$max" ] && max=$t
  done
  # Termux/Android battery temperature as fallback
  if [ "$max" -eq 0 ]; then
    local batt_temp
    batt_temp=$(cat /sys/class/power_supply/battery/temp 2>/dev/null || echo "0")
    [ "$batt_temp" -gt 0 ] && max=$((batt_temp / 10))
  fi
  echo "$max"
}

get_battery() {
  local pct="" status=""
  for p in /sys/class/power_supply/battery /sys/class/power_supply/Battery \
           /sys/class/power_supply/BAT0 /sys/class/power_supply/BAT1; do
    [ -d "$p" ] || continue
    pct=$(cat "$p/capacity" 2>/dev/null)
    status=$(cat "$p/status" 2>/dev/null)
    break
  done
  echo "${pct:-0} ${status:-unknown}"
}

get_storage_free() {
  df -m "${HOME}" 2>/dev/null | awk 'NR==2 {print $4}' || echo "0"
}

get_uptime_secs() {
  awk '{printf "%d", $1}' /proc/uptime 2>/dev/null || echo "0"
}

# ── Miner state ───────────────────────────────────────────────────────────────
# Use $HOME so path works on both Linux (/home/user) and Termux
APPROVED_BINARY="${HOME}/xmrig-custom"
MINER_LOG="${HOME}/cluster/logs/xmrig.log"

# expand_path: replace ~ or $HOME prefix in a path string
expand_path() {
  echo "$1" | sed "s|^~/|${HOME}/|; s|^\$HOME/|${HOME}/|"
}

get_xmrig_pids() {
  # Returns: custom_pid rogue_pid
  local custom="" rogue=""
  local approved approved_resolved
  approved=$(expand_path "$APPROVED_BINARY")
  approved_resolved=$(readlink -f "$approved" 2>/dev/null || echo "$approved")

  local pids
  pids=$(pgrep -f 'xmrig' 2>/dev/null \
    || ps -A 2>/dev/null | grep -i xmrig | grep -v grep | awk '{print $1}' \
    || echo "")

  for pid in $pids; do
    local exe; exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null || echo "")
    local cmdline; cmdline=$(cat "/proc/$pid/cmdline" 2>/dev/null | tr '\0' ' ' || echo "")

    if [ -n "$exe" ] && [ "$exe" = "$approved_resolved" ]; then
      custom="$pid"
    elif echo "$cmdline" | grep -Fq -- "$approved"; then
      custom="$pid"
    elif echo "$cmdline" | grep -Fq -- "$approved_resolved"; then
      custom="$pid"
    elif echo "$exe$cmdline" | grep -q "xmrig-custom"; then
      custom="$pid"
    else
      rogue="$pid"
    fi
  done

  echo "$custom $rogue"
}

stop_custom_miner() {
  local pids custom
  pids=$(get_xmrig_pids)
  custom=$(echo "$pids" | awk '{print $1}')
  if [ -n "$custom" ]; then
    kill "$custom" 2>/dev/null || true
    sleep 1
    kill -9 "$custom" 2>/dev/null || true
  fi
}

get_xmrig_stats() {
  # Read from MINER_LOG ($HOME/cluster/logs/xmrig.log)
  local hr10="" accepted="" last_share_age=""
  local logfile="$MINER_LOG"
  if [ -f "$logfile" ]; then
    hr10=$(tail -50 "$logfile" 2>/dev/null | grep -o '[0-9.]\+ H/s' | tail -1 | awk '{print $1}')
    accepted=$(tail -100 "$logfile" 2>/dev/null | grep -o 'accepted [0-9]*' | tail -1 | awk '{print $2}')
    # Last share timestamp line
    local last_share_line
    last_share_line=$(grep -i 'accepted\|share' "$logfile" 2>/dev/null | tail -1)
  fi
  echo "${hr10:-0} 0 0 ${accepted:-0}"
}

hash_binary() {
  local path="$1"
  path=$(expand_path "$path")
  [ -f "$path" ] || { echo ""; return; }
  sha256sum "$path" 2>/dev/null | awk '{print $1}'
}

# ── Preflight checks ──────────────────────────────────────────────────────────
# Returns 0 (pass) or 1 (fail). Sets PREFLIGHT_STATUS and PREFLIGHT_REASON.
PREFLIGHT_STATUS="unknown"
PREFLIGHT_REASON=""

run_preflight() {
  local pool_url="$1" pool_port="$2" binary_path="$3"
  binary_path=$(expand_path "$binary_path")

  # 1. Binary exists
  if [ ! -f "$binary_path" ]; then
    PREFLIGHT_STATUS="blocked_no_binary"
    PREFLIGHT_REASON="Binary not found: $binary_path"
    post_event "critical" "preflight_fail" "$PREFLIGHT_REASON"
    return 1
  fi

  # 2. Control plane reachable (already proven if we got desired state)
  # 3. Pool TCP reachable
  local pool_ok=0
  # Try nc (netcat) — available in Termux via 'netcat' package
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 3 "$pool_url" "$pool_port" 2>/dev/null && pool_ok=1
  elif command -v curl >/dev/null 2>&1; then
    # curl TCP probe fallback
    curl -s --connect-timeout 3 "telnet://${pool_url}:${pool_port}" >/dev/null 2>&1 && pool_ok=1
    # curl returns non-zero for telnet but connects — check differently
    curl -s --max-time 3 -o /dev/null "http://${pool_url}:${pool_port}" 2>/dev/null
    [ $? -ne 7 ] && pool_ok=1  # exit 7 = couldn't connect
  fi

  if [ "$pool_ok" -eq 0 ]; then
    PREFLIGHT_STATUS="blocked_by_pool"
    PREFLIGHT_REASON="Pool unreachable: ${pool_url}:${pool_port}"
    log "PREFLIGHT FAIL: $PREFLIGHT_REASON"
    post_event "warning" "preflight_pool_unreachable" "$PREFLIGHT_REASON"
    return 1
  fi

  PREFLIGHT_STATUS="ok"
  PREFLIGHT_REASON="all checks passed"
  log "Preflight OK: binary exists, pool ${pool_url}:${pool_port} reachable"
  return 0
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

  # Persist full response so apply_desired_state() can read desired fields
  [ -n "$resp" ] && printf '%s' "$resp" > /tmp/desired-state.json 2>/dev/null || true
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
    "rogue_binary_path":"%s",
    "preflight_status":"%s",
    "preflight_reason":"%s",
    "workload_type":"mining",
    "agent_version":"%s"
  }' "$ip" "$iface_type" "$load" \
     "${mem_used:-0}" "${mem_total:-1}" \
     "${swap_used:-0}" "${swap_total:-0}" \
     "${temp:-0}" "${batt_pct:-0}" "${batt_status:-unknown}" \
     "${disk_free:-0}" "${uptime:-0}" \
     "$xmrig_running" "${custom_pid:-}" "${rogue_pid:-}" \
     "${hr10:-0}" "${accepted:-0}" \
     "${binary_hash:-}" \
     "$rogue_binary" "${rogue_binary_path:-}" \
     "${PREFLIGHT_STATUS:-unknown}" "${PREFLIGHT_REASON:-}" \
     "$AGENT_VERSION")

  http_post "$AGENT_API/state" "$body" >/dev/null
}

# ── Command execution ─────────────────────────────────────────────────────────
execute_command() {
  local cmd_id="$1" cmd_type="$2" payload="$3"
  log "Executing command: $cmd_type (id=$cmd_id)"

  local stdout="" stderr="" success="true" exit_code=0

  case "$cmd_type" in
    mining-start|start)
      local bin; bin=$(expand_path "$APPROVED_BINARY")
      if [ ! -f "$bin" ]; then
        stdout="Binary not found: $bin"; success="false"; exit_code=1
      else
        local ds="/tmp/desired-state.json"
        local p_url; p_url=$(grep -o '"pool_url":"[^"]*"' "$ds" 2>/dev/null | cut -d'"' -f4)
        local p_port; p_port=$(grep -o '"pool_port":[0-9]*' "$ds" 2>/dev/null | cut -d: -f2)
        local p_user; p_user=$(grep -o '"pool_user":"[^"]*"' "$ds" 2>/dev/null | cut -d'"' -f4)
        local p_req; p_req=$(grep -o '"preflight_required":[a-z]*' "$ds" 2>/dev/null | cut -d: -f2)
        local tcount; tcount=$(grep -o '"thread_count":[0-9]*' "$ds" 2>/dev/null | cut -d: -f2)
        local rx_mode; rx_mode=$(grep -o '"randomx_mode":"[^"]*"' "$ds" 2>/dev/null | cut -d'"' -f4)
        local log_path_raw; log_path_raw=$(grep -o '"log_path":"[^"]*"' "$ds" 2>/dev/null | cut -d'"' -f4)
        local log_path; log_path=$(expand_path "${log_path_raw:-~/cluster/logs/xmrig.log}")

        if [ "${p_req:-true}" = "true" ]; then
          if ! run_preflight "${p_url:-192.168.1.179}" "${p_port:-10128}" "$bin"; then
            stdout="BLOCKED: $PREFLIGHT_REASON"
            success="false"; exit_code=1
            break
          fi
        fi

        # Hash verification for manual mining-start command
        local p_hash; p_hash=$(grep -o '"approved_binary_hash":"[^"]*"' "$ds" 2>/dev/null | cut -d'"' -f4)
        if [ -n "$p_hash" ]; then
          local actual_h; actual_h=$(hash_binary "$bin")
          if [ "$actual_h" != "$p_hash" ]; then
            stdout="BLOCKED: binary hash mismatch (got ${actual_h:0:12}…)"
            success="false"; exit_code=1
            post_event "critical" "hash_mismatch" "mining-start blocked: hash mismatch"
            break
          fi
        fi

        mkdir -p "$(dirname "$log_path")" 2>/dev/null || true
        local cfg; cfg=$(render_xmrig_config "${p_url:-192.168.1.179}" "${p_port:-10128}" "${p_user:-wallet}" "${tcount:-6}" "${rx_mode:-light}" "$log_path")
        nohup "$bin" --config="$cfg" --no-color >> "$log_path" 2>&1 &
        local mpid=$!
        sleep 3
        if kill -0 "$mpid" 2>/dev/null; then
          stdout="Mining started (PID $mpid)"
        else
          stdout="Mining failed to stay alive"
          success="false"; exit_code=1
        fi
      fi
      ;;    mining-stop|stop)
      stop_custom_miner; stdout="Mining stopped"
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
      local lf; lf=$(expand_path "$MINER_LOG")
      [ -f "$lf" ] || lf="/tmp/xmrig.log"
      stdout=$(tail -40 "$lf" 2>/dev/null || echo "no log at $lf")
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
    mining-level)
      local level; level=$(echo "$payload" | grep -o '"level":[0-9]' | cut -d: -f2)
      if [ -z "$level" ]; then
        stdout="Invalid level"
        success="false"; exit_code=1
      elif [ "$level" -eq 0 ]; then
        stop_custom_miner
        stdout="Mining disabled (level 0)"
      else
        # Level 1-4: start/resume mining (would need desired state config)
        stdout="Mining level set to $level"
      fi
      ;;
    pool-change)
      local pool_url pool_port pool_user
      pool_url=$(echo "$payload" | grep -o '"url":"[^"]*"' | cut -d'"' -f4)
      pool_port=$(echo "$payload" | grep -o '"port":[0-9]*' | cut -d: -f2)
      pool_user=$(echo "$payload" | grep -o '"user":"[^"]*"' | cut -d'"' -f4)
      if [ -n "$pool_url" ]; then
        # Restart miner with new pool config
        stop_custom_miner
        local config; config=$(render_xmrig_config "$pool_url" "${pool_port:-10128}" "${pool_user:-wallet}" "2" "light")
        nohup "$APPROVED_BINARY" --config="$config" --no-color >> /tmp/xmrig.log 2>&1 &
        stdout="Pool changed to $pool_url:$pool_port"
      else
        stdout="Invalid pool config"
        success="false"; exit_code=1
      fi
      ;;
    profile-switch)
      # Load profile from desired state and apply
      stdout="Profile switched (profile support TBD)"
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

# ── Config rendering and enforcement ──────────────────────────────────────────

render_xmrig_config() {
  local pool_url="$1" pool_port="$2" pool_user="$3" threads="$4" mode="$5"
  local log_file="${6:-}"
  log_file=$(expand_path "${log_file:-~/cluster/logs/xmrig.log}")
  mkdir -p "$(dirname "$log_file")" 2>/dev/null || true
  mkdir -p "${HOME}/cluster/config" 2>/dev/null || true
  local config_file="${HOME}/cluster/config/xmrig-runtime.json"

  cat > "$config_file" << EOF
{
  "api": { "id": null, "worker-id": null },
  "http": { "enabled": false, "host": "127.0.0.1", "port": 0 },
  "autosave": false,
  "background": false,
  "colors": false,
  "randomx": { "init": -1, "mode": "$mode", "1gb-pages": false },
  "cpu": { "enabled": true, "huge-pages": false, "hw-aes": true, "priority": 2, "threads": $threads },
  "donate-level": 1,
  "log-file": "$log_file",
  "print-time": 60,
  "retries": 5,
  "retry-pause": 5,
  "watch": false,
  "pools": [
    {
      "algo": "rx/0",
      "coin": "monero",
      "url": "$pool_url:$pool_port",
      "user": "$pool_user",
      "pass": "x",
      "tls": false,
      "keepalive": true,
      "enabled": true
    }
  ]
}
EOF

  echo "$config_file"
}

enforce_thermal_policy() {
  local max_temp="$1" current_temp="$2"
  [ -z "$max_temp" ] && max_temp=80
  [ -z "$current_temp" ] && current_temp=$(get_temp)

  if [ "$current_temp" -gt "$max_temp" ]; then
    log "THERMAL LIMIT: temp $current_temp > max $max_temp — pausing miner"
    stop_custom_miner
    post_event "warning" "thermal_throttle" "Mining paused: temp $current_temp°C > max $max_temp°C"
    return 1
  fi
  return 0
}

track_restart_state() {
  local restart_state_file="/tmp/xmrig-restart-state.txt"
  local restart_threshold="${1:-5}"
  local restart_cooldown="${2:-300}"
  local now; now=$(date +%s)

  if [ ! -f "$restart_state_file" ]; then
    printf "count=0\nlast_restart=$now\ncooldown_until=0\n" > "$restart_state_file"
    return 0
  fi

  local count; count=$(grep '^count=' "$restart_state_file" | cut -d= -f2)
  local cooldown_until; cooldown_until=$(grep '^cooldown_until=' "$restart_state_file" | cut -d= -f2)

  if [ "$now" -lt "$cooldown_until" ]; then
    log "Restart cooldown active until $((cooldown_until - now))s"
    return 1
  fi

  # Increment count
  count=$((count + 1))
  [ "$count" -gt "$restart_threshold" ] && {
    log "Restart threshold exceeded ($count > $restart_threshold)"
    post_event "critical" "restart_threshold_exceeded" "Too many restarts ($count)"
    cooldown_until=$((now + restart_cooldown))
  }

  printf "count=$count\nlast_restart=$now\ncooldown_until=$cooldown_until\n" > "$restart_state_file"
}

# ── Apply desired state ───────────────────────────────────────────────────────
apply_desired_state() {
  local desired_file="/tmp/desired-state.json"
  [ -f "$desired_file" ] || return 0

  # Parse desired fields
  local workload_enabled; workload_enabled=$(grep -o '"workload_enabled":[a-z]*' "$desired_file" | cut -d: -f2)
  local miner_enabled; miner_enabled=$(grep -o '"miner_enabled":[a-z]*' "$desired_file" | cut -d: -f2)
  local max_temp; max_temp=$(grep -o '"max_temp_celsius":[0-9]*' "$desired_file" | cut -d: -f2)
  local pause_on_battery; pause_on_battery=$(grep -o '"pause_on_battery":[a-z]*' "$desired_file" | cut -d: -f2)
  local pool_url; pool_url=$(grep -o '"pool_url":"[^"]*"' "$desired_file" | cut -d'"' -f4)
  local pool_port; pool_port=$(grep -o '"pool_port":[0-9]*' "$desired_file" | cut -d: -f2)
  local pool_user; pool_user=$(grep -o '"pool_user":"[^"]*"' "$desired_file" | cut -d'"' -f4)
  local thread_count; thread_count=$(grep -o '"thread_count":[0-9]*' "$desired_file" | cut -d: -f2)
  local randomx_mode; randomx_mode=$(grep -o '"randomx_mode":"[^"]*"' "$desired_file" | cut -d'"' -f4)
  local log_path_raw; log_path_raw=$(grep -o '"log_path":"[^"]*"' "$desired_file" | cut -d'"' -f4)
  local preflight_req; preflight_req=$(grep -o '"preflight_required":[a-z]*' "$desired_file" | cut -d: -f2)
  local binary_path_raw; binary_path_raw=$(grep -o '"approved_binary_path":"[^"]*"' "$desired_file" | cut -d'"' -f4)
  local restart_threshold; restart_threshold=$(grep -o '"restart_threshold":[0-9]*' "$desired_file" | cut -d: -f2)
  local restart_cooldown; restart_cooldown=$(grep -o '"restart_cooldown":[0-9]*' "$desired_file" | cut -d: -f2)
  local approved_hash; approved_hash=$(grep -o '"approved_binary_hash":"[^"]*"' "$desired_file" | cut -d'"' -f4)

  # Expand ~ / $HOME in paths
  local binary_path; binary_path=$(expand_path "${binary_path_raw:-~/xmrig-custom}")
  local log_path; log_path=$(expand_path "${log_path_raw:-~/cluster/logs/xmrig.log}")
  mkdir -p "$(dirname "$log_path")" 2>/dev/null || true

  # Update APPROVED_BINARY from desired state
  APPROVED_BINARY="$binary_path"
  MINER_LOG="$log_path"

  # workload_enabled=false overrides miner_enabled
  local should_mine="$miner_enabled"
  [ "$workload_enabled" = "false" ] && should_mine="false"

  # Thermal policy enforcement
  local current_temp; current_temp=$(get_temp)
  if ! enforce_thermal_policy "${max_temp:-60}" "$current_temp"; then
    return 0  # paused for thermal
  fi

  # Battery policy enforcement
  if [ "$pause_on_battery" = "true" ]; then
    local batt_status; batt_status=$(get_battery | awk '{print $2}')
    if [ "$batt_status" = "Discharging" ]; then
      stop_custom_miner
      post_event "info" "battery_pause" "Mining paused: on battery"
      return 0
    fi
  fi

  local pids; pids=$(get_xmrig_pids)
  local custom_pid; custom_pid=$(echo "$pids" | awk '{print $1}')
  local is_running="false"
  [ -n "$custom_pid" ] && is_running="true"

  if [ "$should_mine" = "true" ] && [ "$is_running" = "false" ]; then
    # Preflight gate before starting
    if [ "${preflight_req:-true}" = "true" ]; then
      if ! run_preflight "${pool_url:-192.168.1.179}" "${pool_port:-10128}" "$binary_path"; then
        log "Mining blocked: $PREFLIGHT_REASON"
        # Report blocked status via state
        post_event "warning" "mining_blocked" "$PREFLIGHT_REASON"
        return 0
      fi
    fi

    # Binary hash verification (only if desired state specifies a hash)
    if [ -n "$approved_hash" ]; then
      local actual_hash; actual_hash=$(hash_binary "$binary_path")
      if [ "$actual_hash" != "$approved_hash" ]; then
        PREFLIGHT_STATUS="blocked_hash_mismatch"
        PREFLIGHT_REASON="Binary hash mismatch: expected ${approved_hash:0:12}… got ${actual_hash:0:12}…"
        log "Mining blocked: $PREFLIGHT_REASON"
        post_event "critical" "hash_mismatch" "$PREFLIGHT_REASON"
        return 0
      fi
    fi

    # Render xmrig config with current desired values
    render_xmrig_config \
      "${pool_url:-192.168.1.179}" "${pool_port:-10128}" "${pool_user:-wallet}" \
      "${thread_count:-6}" "${randomx_mode:-light}" "$log_path" >/dev/null

    # Check restart throttle
    if track_restart_state "${restart_threshold:-5}" "${restart_cooldown:-300}"; then
      local cfg="${HOME}/cluster/config/xmrig-runtime.json"
      if [ -f "$cfg" ]; then
        nohup "$APPROVED_BINARY" --config="$cfg" --no-color >> "$log_path" 2>&1 &
      else
        nohup "$APPROVED_BINARY" --no-color >> "$log_path" 2>&1 &
      fi
      log "Started miner per desired state (PID $!)"
      post_event "info" "miner_started" "Miner started by desired-state enforcement"
    fi
  elif [ "$should_mine" = "false" ] && [ "$is_running" = "true" ]; then
    stop_custom_miner
    log "Stopped miner per desired state"
    post_event "info" "miner_stopped" "Miner stopped by desired-state enforcement"
  fi
}

# ── Detailed telemetry (hashrate history) ─────────────────────────────────────
send_detailed_telemetry() {
  local pids; pids=$(get_xmrig_pids)
  local custom_pid; custom_pid=$(echo "$pids" | awk '{print $1}')
  local stats; stats=$(get_xmrig_stats)
  local hr10; hr10=$(echo "$stats" | awk '{print $1}')
  local accepted; accepted=$(echo "$stats" | awk '{print $4}')
  local temp; temp=$(get_temp)
  local mem; mem=$(get_mem)
  local mem_used; mem_used=$(echo "$mem" | awk '{print $1}')
  local mem_total; mem_total=$(echo "$mem" | awk '{print $2}')
  local batt; batt=$(get_battery)
  local batt_pct; batt_pct=$(echo "$batt" | awk '{print $1}')
  local load; load=$(get_load)

  local thread_count; thread_count=$(grep -o '"thread_count":[0-9]*' /tmp/desired-state.json 2>/dev/null | cut -d: -f2)
  local randomx_mode; randomx_mode=$(grep -o '"randomx_mode":"[^"]*"' /tmp/desired-state.json 2>/dev/null | cut -d'"' -f4)

  local body; body=$(printf '{
    "hashrate_10s":%s,
    "hashrate_60s":%s,
    "hashrate_15m":%s,
    "accepted_shares":%s,
    "rejected_shares":0,
    "invalid_shares":0,
    "temp_current":%s,
    "temp_peak":%s,
    "load_average":[%s,0,0],
    "memory_used_mb":%s,
    "memory_total_mb":%s,
    "battery_percent":%s,
    "cpu_affinity":[],
    "huge_pages_enabled":false,
    "randomx_mode":"%s",
    "thread_count":%s
  }' "${hr10:-0}" "${hr10:-0}" "${hr10:-0}" \
     "${accepted:-0}" \
     "${temp:-0}" "${temp:-0}" \
     "${load:-0}" \
     "${mem_used:-0}" "${mem_total:-1}" \
     "${batt_pct:-0}" \
     "${randomx_mode:-light}" "${thread_count:-2}")

  http_post "$AGENT_API/telemetry" "$body" >/dev/null
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
  # Apply desired state (start/stop miner, thermal enforcement)
  apply_desired_state
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
      send_detailed_telemetry 2>/dev/null || true
      apply_desired_state 2>/dev/null || true
      LAST_TELEMETRY=$NOW
    fi

    # Poll and execute commands
    poll_and_execute_commands 2>/dev/null

    # Full reconcile (rogue kill, cron, binary checks) every 5 minutes
    if [ $((NOW - LAST_RECONCILE)) -ge 300 ]; then
      reconcile_desired_state 2>/dev/null
      LAST_RECONCILE=$NOW
    fi

    sleep 15
  done
}

main "$@"
