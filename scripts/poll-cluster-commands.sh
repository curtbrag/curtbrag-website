#!/bin/sh
# Poll for queued commands from curtbrag.com and execute them
# Run on node1: nohup /home/user/poll-cluster-commands.sh &
# Or as a systemd service for auto-restart

API_URL="https://curtbrag.com/.netlify/functions/cluster-control"
API_KEY="${CLUSTER_API_KEY:-curtbrag-cluster-2024}"
POLL_INTERVAL=5  # seconds
trap 'rm -rf /tmp/cmdres-*' EXIT INT TERM

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

# Run SSH on a single node, tracking success/failure via temp file
ssh_node_tracked() {
  local ip="$1"
  local cmd="$2"
  local result_dir="$3"
  local label="$4"
  if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes "user@$ip" "$cmd" >/dev/null 2>&1; then
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

# Run command on all 10 phone nodes in parallel with tracking
run_on_all_tracked() {
  local cmd="$1"
  local result_dir="$2"
  for i in $(seq 1 10); do
    ssh_node_tracked "192.168.1.$((205+i))" "$cmd" "$result_dir" "node$i" &
  done
  wait
}

# Run on all phone nodes in parallel (fire-and-forget)
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
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        run_on_all_tracked "input keyevent KEYCODE_WAKEUP" "$RESULT_DIR"
      else
        ssh_node_tracked "$(resolve_ip "$target")" "input keyevent KEYCODE_WAKEUP" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    sleep)
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        run_on_all_tracked "input keyevent KEYCODE_SLEEP" "$RESULT_DIR"
      else
        ssh_node_tracked "$(resolve_ip "$target")" "input keyevent KEYCODE_SLEEP" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    restart)
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        for i in $(seq 1 10); do
          IP="192.168.1.$((205+i))"
          SVC=$(k3s_svc "node$i")
          ssh_node_tracked "$IP" "doas systemctl restart $SVC" "$RESULT_DIR" "node$i" &
        done
        wait
      else
        IP=$(resolve_ip "$target")
        SVC=$(k3s_svc "$target")
        ssh_node_tracked "$IP" "doas systemctl restart $SVC" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    start)
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        for i in $(seq 1 10); do
          IP="192.168.1.$((205+i))"
          SVC=$(k3s_svc "node$i")
          ssh_node_tracked "$IP" "doas systemctl start $SVC" "$RESULT_DIR" "node$i" &
        done
        wait
      else
        IP=$(resolve_ip "$target")
        SVC=$(k3s_svc "$target")
        ssh_node_tracked "$IP" "doas systemctl start $SVC" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    stop)
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        for i in $(seq 1 10); do
          IP="192.168.1.$((205+i))"
          SVC=$(k3s_svc "node$i")
          ssh_node_tracked "$IP" "doas systemctl stop $SVC" "$RESULT_DIR" "node$i" &
        done
        wait
      else
        IP=$(resolve_ip "$target")
        SVC=$(k3s_svc "$target")
        ssh_node_tracked "$IP" "doas systemctl stop $SVC" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    mining-start)
      log "Starting miners..."
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        run_on_all_tracked "doas systemctl start xmrig" "$RESULT_DIR"
      else
        ssh_node_tracked "$(resolve_ip "$target")" "doas systemctl start xmrig" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    mining-stop)
      log "Stopping miners..."
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        run_on_all_tracked "doas systemctl stop xmrig" "$RESULT_DIR"
      else
        ssh_node_tracked "$(resolve_ip "$target")" "doas systemctl stop xmrig" "$RESULT_DIR" "$target"
      fi
      RESULT=$(collect_results "$RESULT_DIR")
      report_result "$cmd_id" "$RESULT" "" "$cmd" "$target"
      ;;
    browse)
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      if [ -n "$url" ]; then
        # Sanitize URL: only allow safe characters
        safe_url=$(printf '%s' "$url" | sed "s/[^a-zA-Z0-9:\/._~?#@!$&'()*+,;=%-]//g")
        log "Opening $safe_url on phones..."
        if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
          run_on_all_tracked "am start -a android.intent.action.VIEW -d '$safe_url'" "$RESULT_DIR"
        else
          ssh_node_tracked "$(resolve_ip "$target")" "am start -a android.intent.action.VIEW -d '$safe_url'" "$RESULT_DIR" "$target"
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
      RESULT_DIR="/tmp/cmdres-$cmd_id"
      mkdir -p "$RESULT_DIR"
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        for i in $(seq 1 10); do
          IP="192.168.1.$((205+i))"
          (
            if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes "user@$IP" "echo ok" >/dev/null 2>&1; then
              echo "ok" > "$RESULT_DIR/node$i"
              ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes "user@$IP" "doas reboot" >/dev/null 2>&1 || true
            else
              echo "fail" > "$RESULT_DIR/node$i"
            fi
          ) &
        done
        wait
      else
        IP=$(resolve_ip "$target")
        if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes "user@$IP" "echo ok" >/dev/null 2>&1; then
          echo "ok" > "$RESULT_DIR/$target"
          ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes "user@$IP" "doas reboot" >/dev/null 2>&1 || true
        else
          echo "fail" > "$RESULT_DIR/$target"
        fi
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
      else
        log "Running SSH command: $ssh_cmd"
        OUTPUT=""
        FAIL=0
        TOTAL=0
        if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
          for i in $(seq 1 10); do
            IP="192.168.1.$((205+i))"
            TOTAL=$((TOTAL + 1))
            NODE_OUT=$(ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes "user@$IP" "$ssh_cmd" 2>&1)
            NODE_RC=$?
            if [ "$NODE_RC" -ne 0 ]; then
              FAIL=$((FAIL + 1))
              NODE_OUT="[exit code $NODE_RC] $NODE_OUT"
            fi
            OUTPUT="${OUTPUT}=== node${i} ===
${NODE_OUT}
"
          done
        else
          IP=$(resolve_ip "$target")
          TOTAL=1
          OUTPUT=$(ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes "user@$IP" "$ssh_cmd" 2>&1)
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
