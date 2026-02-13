#!/bin/sh
# Poll for queued commands from curtbrag.com and execute them
# Run on node1: nohup /home/user/poll-cluster-commands.sh &
# Or as a systemd service for auto-restart

API_URL="https://curtbrag.com/.netlify/functions/cluster-control"
API_KEY="${CLUSTER_API_KEY:-curtbrag-cluster-2024}"
POLL_INTERVAL=5  # seconds

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Check jq is available
if ! command -v jq >/dev/null 2>&1; then
  log "ERROR: jq not found"
  exit 1
fi

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

# K3s service name (control-plane vs agent)
k3s_svc() {
  case "$1" in
    node1|192.168.1.206) echo "k3s" ;;
    *) echo "k3s-agent" ;;
  esac
}

# Run SSH on a single node
ssh_node() {
  local ip="$1"
  local cmd="$2"
  ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes "user@$ip" "$cmd" 2>/dev/null
}

# Run on all phone nodes in parallel
all_phones() {
  local cmd="$1"
  for i in $(seq 1 10); do
    ssh_node "192.168.1.$((205+i))" "$cmd" &
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
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        all_phones "input keyevent KEYCODE_WAKEUP"
      else
        ssh_node "$(resolve_ip "$target")" "input keyevent KEYCODE_WAKEUP" || true
      fi
      report_result "$cmd_id" "success" "" "$cmd" "$target"
      ;;
    sleep)
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        all_phones "input keyevent KEYCODE_SLEEP"
      else
        ssh_node "$(resolve_ip "$target")" "input keyevent KEYCODE_SLEEP" || true
      fi
      report_result "$cmd_id" "success" "" "$cmd" "$target"
      ;;
    restart)
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        for i in $(seq 1 10); do
          IP="192.168.1.$((205+i))"
          SVC=$(k3s_svc "node$i")
          ssh_node "$IP" "doas systemctl restart $SVC" &
        done
        wait
      else
        IP=$(resolve_ip "$target")
        SVC=$(k3s_svc "$target")
        ssh_node "$IP" "doas systemctl restart $SVC" || true
      fi
      report_result "$cmd_id" "success" "" "$cmd" "$target"
      ;;
    start)
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        for i in $(seq 1 10); do
          IP="192.168.1.$((205+i))"
          SVC=$(k3s_svc "node$i")
          ssh_node "$IP" "doas systemctl start $SVC" &
        done
        wait
      else
        IP=$(resolve_ip "$target")
        SVC=$(k3s_svc "$target")
        ssh_node "$IP" "doas systemctl start $SVC" || true
      fi
      report_result "$cmd_id" "success" "" "$cmd" "$target"
      ;;
    stop)
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        for i in $(seq 1 10); do
          IP="192.168.1.$((205+i))"
          SVC=$(k3s_svc "node$i")
          ssh_node "$IP" "doas systemctl stop $SVC" &
        done
        wait
      else
        IP=$(resolve_ip "$target")
        SVC=$(k3s_svc "$target")
        ssh_node "$IP" "doas systemctl stop $SVC" || true
      fi
      report_result "$cmd_id" "success" "" "$cmd" "$target"
      ;;
    mining-start)
      log "Starting miners..."
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        all_phones "doas systemctl start xmrig"
      else
        ssh_node "$(resolve_ip "$target")" "doas systemctl start xmrig" || true
      fi
      report_result "$cmd_id" "success" "" "$cmd" "$target"
      ;;
    mining-stop)
      log "Stopping miners..."
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        all_phones "doas systemctl stop xmrig"
      else
        ssh_node "$(resolve_ip "$target")" "doas systemctl stop xmrig" || true
      fi
      report_result "$cmd_id" "success" "" "$cmd" "$target"
      ;;
    browse)
      if [ -n "$url" ]; then
        # Sanitize URL: only allow safe characters
        safe_url=$(printf '%s' "$url" | sed "s/[^a-zA-Z0-9:\/._~?#@!$&'()*+,;=%-]//g")
        log "Opening $safe_url on phones..."
        if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
          all_phones "am start -a android.intent.action.VIEW -d '$safe_url'"
        else
          ssh_node "$(resolve_ip "$target")" "am start -a android.intent.action.VIEW -d '$safe_url'" || true
        fi
      fi
      report_result "$cmd_id" "success" "" "$cmd" "$target"
      ;;
    update)
      log "Updating scripts from GitHub..."
      REPO_RAW="https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts"
      SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
      FAIL=""
      for SCRIPT in push-cluster-status.sh poll-cluster-commands.sh; do
        if curl -sfL "$REPO_RAW/$SCRIPT" -o "$SCRIPT_DIR/$SCRIPT.new"; then
          chmod +x "$SCRIPT_DIR/$SCRIPT.new"
          mv "$SCRIPT_DIR/$SCRIPT.new" "$SCRIPT_DIR/$SCRIPT"
          log "  Updated $SCRIPT"
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
      ;;
    reboot)
      log "Rebooting $target..."
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        for i in $(seq 1 10); do
          IP="192.168.1.$((205+i))"
          ssh_node "$IP" "doas reboot" &
        done
        wait
      else
        IP=$(resolve_ip "$target")
        ssh_node "$IP" "doas reboot" || true
      fi
      report_result "$cmd_id" "success: reboot initiated" "" "$cmd" "$target"
      ;;
    ssh)
      if [ -z "$ssh_cmd" ]; then
        report_result "$cmd_id" "error: no command specified" "" "$cmd" "$target"
      else
        log "Running SSH command: $ssh_cmd"
        OUTPUT=""
        if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
          for i in $(seq 1 10); do
            IP="192.168.1.$((205+i))"
            NODE_OUT=$(ssh_node "$IP" "$ssh_cmd" 2>&1 || echo "[error]")
            OUTPUT="${OUTPUT}=== node${i} ===
${NODE_OUT}
"
          done
        else
          IP=$(resolve_ip "$target")
          OUTPUT=$(ssh_node "$IP" "$ssh_cmd" 2>&1 || echo "[error]")
        fi
        # Truncate to 4000 chars for Netlify Blobs
        TRUNC_OUTPUT=$(printf '%.4000s' "$OUTPUT")
        report_result "$cmd_id" "success" "$TRUNC_OUTPUT" "$cmd" "$target"
      fi
      ;;
    update)
      log "Updating scripts from GitHub..."
      REPO_RAW="https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts"
      SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
      FAIL=""
      for SCRIPT in push-cluster-status.sh poll-cluster-commands.sh; do
        if curl -sfL "$REPO_RAW/$SCRIPT" -o "$SCRIPT_DIR/$SCRIPT.new"; then
          chmod +x "$SCRIPT_DIR/$SCRIPT.new"
          mv "$SCRIPT_DIR/$SCRIPT.new" "$SCRIPT_DIR/$SCRIPT"
          log "  Updated $SCRIPT"
        else
          log "  Failed to download $SCRIPT"
          FAIL="$FAIL $SCRIPT"
          rm -f "$SCRIPT_DIR/$SCRIPT.new"
        fi
      done
      if [ -z "$FAIL" ]; then
        report_result "$cmd_id" "success: scripts updated"
      else
        report_result "$cmd_id" "partial: failed$FAIL"
      fi
      ;;
    update)
      log "Updating scripts from GitHub..."
      REPO_RAW="https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts"
      SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
      FAIL=""
      for SCRIPT in push-cluster-status.sh poll-cluster-commands.sh; do
        if curl -sfL "$REPO_RAW/$SCRIPT" -o "$SCRIPT_DIR/$SCRIPT.new"; then
          chmod +x "$SCRIPT_DIR/$SCRIPT.new"
          mv "$SCRIPT_DIR/$SCRIPT.new" "$SCRIPT_DIR/$SCRIPT"
          log "  Updated $SCRIPT"
        else
          log "  Failed to download $SCRIPT"
          FAIL="$FAIL $SCRIPT"
          rm -f "$SCRIPT_DIR/$SCRIPT.new"
        fi
      done
      if [ -z "$FAIL" ]; then
        report_result "$cmd_id" "success: scripts updated"
      else
        report_result "$cmd_id" "partial: failed$FAIL"
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
  SCHED_RESP=$(curl -s -X POST "$API_URL" \
    -H "Content-Type: application/json" \
    -H "X-Cluster-Key: $API_KEY" \
    -d "$(jq -n --arg t "$LOCAL_TIME" '{action:"check-schedule",localTime:$t}')" 2>/dev/null || echo '{"commands":[]}')

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
