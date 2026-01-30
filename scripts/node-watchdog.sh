#!/bin/sh
# Node Watchdog - Auto-recovery service for K3s cluster nodes
# Run on node1: ./node-watchdog.sh start
# Or install as service: ./node-watchdog.sh install

CHECK_INTERVAL="${CHECK_INTERVAL:-300}"  # 5 minutes
MAX_RETRIES="${MAX_RETRIES:-3}"
LOGFILE="/var/log/node-watchdog.log"
PIDFILE="/var/run/node-watchdog.pid"

# Node configuration
NODES="
node2:192.168.1.207
node3:192.168.1.208
node4:192.168.1.209
node5:192.168.1.210
node6:192.168.1.211
node7:192.168.1.212
node8:192.168.1.213
node9:192.168.1.214
node10:192.168.1.215
"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOGFILE"
}

# Check if a node is Ready
is_node_ready() {
  node_name="$1"
  status=$(kubectl get node "$node_name" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)
  [ "$status" = "True" ]
}

# Check SSH connectivity
check_ssh() {
  node_ip="$1"
  ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=no "user@$node_ip" "echo ok" >/dev/null 2>&1
}

# Restart K3s agent on a node
restart_k3s_agent() {
  node_name="$1"
  node_ip="$2"

  log "Attempting to restart K3s agent on $node_name ($node_ip)..."

  if ! check_ssh "$node_ip"; then
    log "ERROR: Cannot SSH to $node_name - node may be offline"
    return 1
  fi

  ssh -o StrictHostKeyChecking=no "user@$node_ip" "sudo rc-service k3s-agent restart" 2>/dev/null

  # Wait and check
  sleep 30
  if is_node_ready "$node_name"; then
    log "SUCCESS: $node_name is now Ready"
    return 0
  else
    log "WARNING: $node_name still not Ready after restart"
    return 1
  fi
}

# Main watchdog loop
watchdog_loop() {
  log "Starting node watchdog (interval: ${CHECK_INTERVAL}s)"

  while true; do
    log "Checking node health..."

    echo "$NODES" | while IFS=: read -r name ip; do
      [ -z "$name" ] && continue

      if ! is_node_ready "$name"; then
        log "ALERT: $name is NotReady"

        # Try to recover
        for attempt in $(seq 1 $MAX_RETRIES); do
          log "Recovery attempt $attempt/$MAX_RETRIES for $name"

          if restart_k3s_agent "$name" "$ip"; then
            log "Recovery successful for $name"
            break
          fi

          if [ "$attempt" -lt "$MAX_RETRIES" ]; then
            log "Waiting 60s before next attempt..."
            sleep 60
          fi
        done

        if ! is_node_ready "$name"; then
          log "CRITICAL: Failed to recover $name after $MAX_RETRIES attempts"
          # Could add notification here (Telegram, email, etc.)
        fi
      fi
    done

    log "Health check complete. Sleeping ${CHECK_INTERVAL}s..."
    sleep "$CHECK_INTERVAL"
  done
}

# Start watchdog in background
start_watchdog() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    log "Watchdog already running (PID: $(cat "$PIDFILE"))"
    return 1
  fi

  log "Starting watchdog daemon..."
  watchdog_loop &
  echo $! > "$PIDFILE"
  log "Watchdog started (PID: $!)"
}

# Stop watchdog
stop_watchdog() {
  if [ -f "$PIDFILE" ]; then
    pid=$(cat "$PIDFILE")
    if kill -0 "$pid" 2>/dev/null; then
      log "Stopping watchdog (PID: $pid)..."
      kill "$pid"
      rm -f "$PIDFILE"
      log "Watchdog stopped"
    else
      log "Watchdog not running (stale PID file)"
      rm -f "$PIDFILE"
    fi
  else
    log "Watchdog not running"
  fi
}

# Check status
status_watchdog() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "Watchdog is running (PID: $(cat "$PIDFILE"))"
    return 0
  else
    echo "Watchdog is not running"
    return 1
  fi
}

# Install as OpenRC service (postmarketOS)
install_service() {
  log "Installing watchdog as OpenRC service..."

  # Copy script
  cp "$0" /usr/local/bin/node-watchdog
  chmod +x /usr/local/bin/node-watchdog

  # Create init script
  cat > /etc/init.d/node-watchdog <<'INITEOF'
#!/sbin/openrc-run

name="node-watchdog"
description="K3s Node Auto-Recovery Watchdog"
command="/usr/local/bin/node-watchdog"
command_args="run"
command_background="yes"
pidfile="/var/run/node-watchdog.pid"
output_log="/var/log/node-watchdog.log"
error_log="/var/log/node-watchdog.log"

depend() {
    need net
    after k3s
}
INITEOF

  chmod +x /etc/init.d/node-watchdog
  rc-update add node-watchdog default

  log "Service installed. Start with: rc-service node-watchdog start"
}

# Run in foreground (for service)
run_foreground() {
  watchdog_loop
}

# Usage
usage() {
  cat <<EOF
Node Watchdog - Auto-recovery for K3s cluster

Usage: $0 <command>

Commands:
  start     Start watchdog in background
  stop      Stop watchdog
  status    Check if watchdog is running
  run       Run in foreground (for services)
  install   Install as OpenRC service
  check     Run one health check (no loop)

Environment:
  CHECK_INTERVAL  Seconds between checks (default: 300)
  MAX_RETRIES     Recovery attempts (default: 3)

Examples:
  $0 start                    # Start daemon
  CHECK_INTERVAL=60 $0 start  # Check every minute
  $0 install                  # Install as service
EOF
}

# Single check (no loop)
single_check() {
  log "Running single health check..."

  echo "$NODES" | while IFS=: read -r name ip; do
    [ -z "$name" ] && continue

    if is_node_ready "$name"; then
      echo "$name: Ready"
    else
      echo "$name: NotReady (IP: $ip)"
    fi
  done
}

# Main
case "${1:-}" in
  start)
    start_watchdog
    ;;
  stop)
    stop_watchdog
    ;;
  status)
    status_watchdog
    ;;
  run)
    run_foreground
    ;;
  install)
    install_service
    ;;
  check)
    single_check
    ;;
  *)
    usage
    ;;
esac
