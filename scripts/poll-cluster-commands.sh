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
  curl -s -X POST "$API_URL" \
    -H "Content-Type: application/json" \
    -H "X-Cluster-Key: $API_KEY" \
    -d "$(jq -n --arg id "$cmd_id" --arg res "$result" '{action:"complete",id:$id,result:$res}')" >/dev/null 2>&1 || true
}

execute_command() {
  local cmd="$1"
  local target="$2"
  local url="$3"
  local cmd_id="$4"

  log "Executing: $cmd on $target"

  case "$cmd" in
    wake)
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        all_phones "input keyevent KEYCODE_WAKEUP"
      else
        ssh_node "$(resolve_ip "$target")" "input keyevent KEYCODE_WAKEUP" || true
      fi
      report_result "$cmd_id" "success"
      ;;
    sleep)
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        all_phones "input keyevent KEYCODE_SLEEP"
      else
        ssh_node "$(resolve_ip "$target")" "input keyevent KEYCODE_SLEEP" || true
      fi
      report_result "$cmd_id" "success"
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
      report_result "$cmd_id" "success"
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
      report_result "$cmd_id" "success"
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
      report_result "$cmd_id" "success"
      ;;
    mining-start)
      log "Starting miners..."
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        all_phones "doas systemctl start xmrig"
      else
        ssh_node "$(resolve_ip "$target")" "doas systemctl start xmrig" || true
      fi
      report_result "$cmd_id" "success"
      ;;
    mining-stop)
      log "Stopping miners..."
      if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
        all_phones "doas systemctl stop xmrig"
      else
        ssh_node "$(resolve_ip "$target")" "doas systemctl stop xmrig" || true
      fi
      report_result "$cmd_id" "success"
      ;;
    browse)
      if [ -n "$url" ]; then
        log "Opening $url on phones..."
        if [ "$target" = "all" ] || [ "$target" = "phones" ]; then
          all_phones "am start -a android.intent.action.VIEW -d \"$url\""
        else
          ssh_node "$(resolve_ip "$target")" "am start -a android.intent.action.VIEW -d \"$url\"" || true
        fi
      fi
      report_result "$cmd_id" "success"
      ;;
    *)
      log "Unknown command: $cmd"
      report_result "$cmd_id" "error: unknown command"
      ;;
  esac
}

log "Starting command poller (interval: ${POLL_INTERVAL}s)"

while true; do
  RESPONSE=$(curl -sL "$API_URL?action=poll" \
    -H "X-Cluster-Key: $API_KEY" 2>/dev/null || echo '{}')

  CMD=$(echo "$RESPONSE" | jq -r '.command // empty')

  if [ -n "$CMD" ]; then
    TARGET=$(echo "$RESPONSE" | jq -r '.target // empty')
    URL=$(echo "$RESPONSE" | jq -r '.url // empty')
    CMD_ID=$(echo "$RESPONSE" | jq -r '.id // empty')
    log "Got command: $CMD target=$TARGET id=$CMD_ID"
    execute_command "$CMD" "$TARGET" "$URL" "$CMD_ID"
  fi

  sleep "$POLL_INTERVAL"
done
