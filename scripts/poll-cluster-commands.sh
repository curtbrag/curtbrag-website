#!/bin/bash
# Poll for queued commands from curtbrag.com and execute them
# Run on node1: nohup /home/user/poll-cluster-commands.sh &
# Or as a systemd service for auto-restart

API_URL="https://curtbrag.com/.netlify/functions/cluster-control"
API_KEY="${CLUSTER_API_KEY:-curtbrag-cluster-2024}"
POLL_INTERVAL=5  # seconds
# Auto-detect our IP so local-exec works even if IP changes
LOCAL_IP=$(ip -4 addr show wlan0 2>/dev/null | grep -o 'inet [0-9.]*' | cut -d' ' -f2)
[ -z "$LOCAL_IP" ] && LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$LOCAL_IP" ] && LOCAL_IP="192.168.1.206"
trap 'rm -rf /tmp/cmdres-*' EXIT INT TERM

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

# Node registry: phones + laptops
# Format: name:ip
ALL_NODES="node1:192.168.1.206 node2:192.168.1.207 node3:192.168.1.208 node4:192.168.1.209 node5:192.168.1.210 node6:192.168.1.211 node7:192.168.1.212 node8:192.168.1.213 node9:192.168.1.214 node10:192.168.1.215"
PHONE_NODES="$ALL_NODES"

# Resolve node name to IP
resolve_ip() {
  case "$1" in
    node1)  echo "192.168.1.206" ;;
    node2)  echo "192.168.1.207" ;;
    node3)  echo "192.168.1.208" ;;
    node4)  echo "192.168.1.209" ;;
    node5)  echo "192.168.1.210" ;;
    node6)  echo "192.168.1.211" ;;
    node7)  echo "192.168.1.212" ;;
    node8)  echo "192.168.1.213" ;;
    node9)  echo "192.168.1.214" ;;
    node10) echo "192.168.1.215" ;;
    *)      echo "$1" ;;
  esac
}

# K3s service name — all phones are agents; control-plane is on AORUS (192.168.1.181)
k3s_svc() {
  echo "k3s-agent"
}

# Execute a command on a node — locally if node1, SSH otherwise
# 30s timeout prevents commands from hanging the poller forever
run_on_node() {
  local ip="$1"
  local cmd="$2"
  if is_local_ip "$ip"; then
    timeout 30 sh -c "$cmd" 2>/dev/null
  else
    timeout 30 ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes "user@$ip" "$cmd" 2>/dev/null
  fi
}

# Execute on a node and capture both stdout+stderr
run_on_node_full() {
  local ip="$1"
  local cmd="$2"
  if is_local_ip "$ip"; then
    timeout 30 sh -c "$cmd" 2>&1
  else
    timeout 30 ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes "user@$ip" "$cmd" 2>&1
  fi
}

# Run on a node, tracking success/failure via temp file
run_on_node_tracked() {
  local ip="$1"
  local cmd="$2"
  local result_dir="$3"
  local label="$4"
  if run_on_node "$ip" "$cmd" >/dev/null 2>&1; then
    echo "ok" > "$result_dir/$label"
  else
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

execute_command() {
  local cmd="$1"
  local target="$2"
  local url="$3"
  local cmd_id="$4"
  local ssh_cmd="$5"

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
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        run_on_all_tracked "$WAKE_CMD" "$RESULT_DIR" "$PHONE_NODES"
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
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        run_on_all_tracked "$SLEEP_CMD" "$RESULT_DIR" "$PHONE_NODES"
      else
        run_on_node_tracked "$(resolve_ip "$target")" "$SLEEP_CMD" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    restart)
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        for entry in $ALL_NODES; do
          name="${entry%%:*}"; ip="${entry##*:}"
          SVC=$(k3s_svc "$name")
          run_on_node_tracked "$ip" "doas rc-service $SVC restart 2>/dev/null || doas systemctl restart $SVC" "$RESULT_DIR" "$name" &
        done
        wait
      else
        IP=$(resolve_ip "$target")
        SVC=$(k3s_svc "$target")
        run_on_node_tracked "$IP" "doas rc-service $SVC restart 2>/dev/null || doas systemctl restart $SVC" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    start)
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        for entry in $ALL_NODES; do
          name="${entry%%:*}"; ip="${entry##*:}"
          SVC=$(k3s_svc "$name")
          run_on_node_tracked "$ip" "doas rc-service $SVC start 2>/dev/null || doas systemctl start $SVC" "$RESULT_DIR" "$name" &
        done
        wait
      else
        IP=$(resolve_ip "$target")
        SVC=$(k3s_svc "$target")
        run_on_node_tracked "$IP" "doas rc-service $SVC start 2>/dev/null || doas systemctl start $SVC" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    stop)
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        for entry in $ALL_NODES; do
          name="${entry%%:*}"; ip="${entry##*:}"
          SVC=$(k3s_svc "$name")
          run_on_node_tracked "$ip" "doas rc-service $SVC stop 2>/dev/null || doas systemctl stop $SVC" "$RESULT_DIR" "$name" &
        done
        wait
      else
        IP=$(resolve_ip "$target")
        SVC=$(k3s_svc "$target")
        run_on_node_tracked "$IP" "doas rc-service $SVC stop 2>/dev/null || doas systemctl stop $SVC" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    mining-start)
      log "Starting miners..."
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      # Start xmrig via rc-service (OpenRC) or systemctl, verify process is running
      MINING_START_CMD='
if ! command -v xmrig >/dev/null 2>&1 && [ ! -f /usr/local/bin/xmrig ]; then
  echo "xmrig not installed" >&2; exit 1
fi
doas rc-service xmrig start 2>/dev/null || doas systemctl start xmrig 2>&1
sleep 2
if pgrep xmrig >/dev/null 2>&1; then
  exit 0
else
  doas rc-service xmrig status 2>/dev/null || doas systemctl status xmrig >&2; exit 1
fi'
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        run_on_all_tracked "$MINING_START_CMD" "$RESULT_DIR"
      else
        run_on_node_tracked "$(resolve_ip "$target")" "$MINING_START_CMD" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    mining-stop)
      log "Stopping miners..."
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        run_on_all_tracked "doas rc-service xmrig stop 2>/dev/null || doas systemctl stop xmrig" "$RESULT_DIR"
      else
        run_on_node_tracked "$(resolve_ip "$target")" "doas rc-service xmrig stop 2>/dev/null || doas systemctl stop xmrig" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
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
        # Rewrite greetd config with env -u GREETD_SOCK so Phosh starts as a
        # regular session (not greeter mode) which skips the lock screen.
        # Uses heredoc to avoid nested quoting issues with printf.
        BROWSE_CMD="cat <<'GREETDEOF' | doas tee /etc/greetd/config.toml >/dev/null
[terminal]
vt = 7

[default_session]
command = \"env -u GREETD_SOCK phosh -E 'firefox-esr --kiosk $safe_url'\"
user = \"user\"
GREETDEOF
doas systemctl restart greetd"
        if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
          run_on_all_tracked "$BROWSE_CMD" "$RESULT_DIR" "$PHONE_NODES"
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
      for SCRIPT in push-cluster-status.sh poll-cluster-commands.sh; do
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
HEAD_SCRIPT=$(head -15 $0 2>/dev/null)"
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
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        for entry in $ALL_NODES; do
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
      # Block shell metacharacters that could enable injection
      elif printf '%s' "$ssh_cmd" | grep -qE '[;|&\$\`\\><]|\$\(|rm -rf /|mkfs|dd if=|:[(][)][{]|/dev/sd'; then
        log "BLOCKED dangerous SSH command: $ssh_cmd"
        report_result "$cmd_id" "error: command blocked for safety" "" "$cmd" "$target"
      else
        log "Running SSH command: $ssh_cmd"
        OUTPUT=""
        FAIL=0
        TOTAL=0
        if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
          SSH_OUT_DIR="/tmp/sshout-$cmd_id"
          mkdir -p "$SSH_OUT_DIR"
          for entry in $ALL_NODES; do
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
          for entry in $ALL_NODES; do
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
          echo "$B64" > "$outfile"
          echo "ok" > "$RESULT_DIR/$node_name"
        else
          echo "fail" > "$RESULT_DIR/$node_name"
        fi
      }

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
        log "Setting brightness to $BRIGHTNESS_VAL..."
        BRIGHT_CMD="doas sh -c 'for f in /sys/class/backlight/*/brightness; do echo $BRIGHTNESS_VAL > \"\$f\"; done' 2>/dev/null || doas sh -c 'echo $BRIGHTNESS_VAL > /sys/class/leds/lcd-backlight/brightness' 2>/dev/null"
        if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
          run_on_all_tracked "$BRIGHT_CMD" "$RESULT_DIR" "$PHONE_NODES"
        else
          run_on_node_tracked "$(resolve_ip "$target")" "$BRIGHT_CMD" "$RESULT_DIR" "$target"
        fi
        RESULT=$(collect_results "$RESULT_DIR")
        report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      fi
      ;;
    *)
      log "Unknown command: $cmd"
      report_result "$cmd_id" "error: unknown command" "" "$cmd" "$target"
      ;;
  esac
}

log "Starting command poller (interval: ${POLL_INTERVAL}s)"

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
  RESPONSE=$(curl -sL "$API_URL?action=poll" \
    -H "X-Cluster-Key: $API_KEY" 2>/dev/null || echo '{}')

  CMD=$(echo "$RESPONSE" | jq -r '.command // empty')

  if [ -n "$CMD" ]; then
    TARGET=$(echo "$RESPONSE" | jq -r '.target // empty')
    URL=$(echo "$RESPONSE" | jq -r '.url // empty')
    CMD_ID=$(echo "$RESPONSE" | jq -r '.id // empty')
    SSH_CMD=$(echo "$RESPONSE" | jq -r '.sshCmd // empty')
    log "Got command: $CMD target=$TARGET id=$CMD_ID"
    execute_command "$CMD" "$TARGET" "$URL" "$CMD_ID" "$SSH_CMD"
  fi

  sleep "$POLL_INTERVAL"
done
