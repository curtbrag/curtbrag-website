#!/bin/sh
# Fix and recover K3s cluster nodes
# Run from node1 (control plane)

set -e

log() {
  echo "[$(date '+%H:%M:%S')] $1"
}

# Node configuration
NODES="
node1:192.168.1.206:control-plane
node2:192.168.1.207:worker
node3:192.168.1.208:worker
node4:192.168.1.209:worker
node5:192.168.1.210:worker
node6:192.168.1.211:worker
node7:192.168.1.212:worker
node8:192.168.1.213:worker
node9:192.168.1.214:worker
node10:192.168.1.215:worker
"

K3S_TOKEN="${K3S_TOKEN:-}"
K3S_URL="${K3S_URL:-https://192.168.1.206:6443}"

usage() {
  cat <<EOF
K3s Node Recovery Tool

Usage: $0 <command> [node]

Commands:
  status          Show status of all nodes
  check           Check which nodes need fixing
  fix <node>      Fix a specific node
  fix-all         Fix all NotReady nodes
  restart <node>  Restart K3s on a node
  rejoin <node>   Remove and rejoin node to cluster
  logs <node>     Show K3s logs from a node

Examples:
  $0 status              # Show all node status
  $0 fix node8           # Fix node8
  $0 fix-all             # Fix all broken nodes
  $0 rejoin node10       # Rejoin node10 to cluster
EOF
}

# Get node info
get_node() {
  name="$1"
  echo "$NODES" | grep "^$name:" | head -1
}

# Check if node is reachable via SSH
check_ssh() {
  node_ip="$1"
  ssh -o ConnectTimeout=5 -o BatchMode=yes -o StrictHostKeyChecking=no "user@$node_ip" "echo ok" 2>/dev/null
}

# Check if node is Ready in K3s
check_k3s_status() {
  node_name="$1"
  kubectl get node "$node_name" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null
}

# Show status of all nodes
show_status() {
  log "Checking cluster node status..."
  echo ""
  printf "%-10s %-15s %-12s %-10s %-10s\n" "NODE" "IP" "K3S STATUS" "SSH" "ROLE"
  printf "%-10s %-15s %-12s %-10s %-10s\n" "----" "--" "----------" "---" "----"

  echo "$NODES" | while IFS=: read -r name ip role; do
    [ -z "$name" ] && continue

    # Check K3s status
    k3s_status=$(check_k3s_status "$name" 2>/dev/null || echo "Unknown")
    [ "$k3s_status" = "True" ] && k3s_status="Ready" || k3s_status="NotReady"

    # Check SSH
    if check_ssh "$ip" >/dev/null 2>&1; then
      ssh_status="OK"
    else
      ssh_status="FAIL"
    fi

    printf "%-10s %-15s %-12s %-10s %-10s\n" "$name" "$ip" "$k3s_status" "$ssh_status" "$role"
  done
}

# Find nodes that need fixing
check_broken() {
  log "Finding broken nodes..."
  echo ""

  broken=""
  echo "$NODES" | while IFS=: read -r name ip role; do
    [ -z "$name" ] && continue
    [ "$role" = "control-plane" ] && continue  # Skip control plane

    k3s_status=$(check_k3s_status "$name" 2>/dev/null || echo "Unknown")
    if [ "$k3s_status" != "True" ]; then
      echo "$name ($ip) - NotReady"
    fi
  done
}

# Fix a single node
fix_node() {
  node_name="$1"
  node_info=$(get_node "$node_name")

  if [ -z "$node_info" ]; then
    log "ERROR: Node $node_name not found"
    exit 1
  fi

  node_ip=$(echo "$node_info" | cut -d: -f2)
  node_role=$(echo "$node_info" | cut -d: -f3)

  log "Fixing $node_name ($node_ip)..."

  # Check SSH connectivity
  if ! check_ssh "$node_ip" >/dev/null 2>&1; then
    log "ERROR: Cannot SSH to $node_name. Node may be offline."
    log "Try: Wake up the phone, check WiFi, or physically restart it."
    return 1
  fi

  log "SSH connection OK"

  # Check and restart K3s agent
  log "Checking K3s agent status..."
  ssh -o StrictHostKeyChecking=no "user@$node_ip" <<'EOF'
    echo "Checking K3s agent..."

    # Check if k3s-agent is running
    if rc-service k3s-agent status >/dev/null 2>&1; then
      echo "K3s agent is running"
    else
      echo "K3s agent not running, starting..."
      sudo rc-service k3s-agent start
    fi

    # Check for common issues
    echo "Checking disk space..."
    df -h / | tail -1

    echo "Checking memory..."
    free -m | head -2

    echo "Checking network..."
    ip route | head -1

    # Restart if needed
    echo "Restarting K3s agent..."
    sudo rc-service k3s-agent restart

    sleep 5
    rc-service k3s-agent status
EOF

  log "Waiting for node to become Ready..."
  for i in 1 2 3 4 5 6; do
    sleep 10
    status=$(check_k3s_status "$node_name" 2>/dev/null || echo "Unknown")
    if [ "$status" = "True" ]; then
      log "SUCCESS: $node_name is now Ready!"
      return 0
    fi
    log "Still waiting... ($i/6)"
  done

  log "WARNING: Node still not Ready after 60 seconds"
  log "Try: $0 rejoin $node_name"
  return 1
}

# Fix all broken nodes
fix_all() {
  log "Fixing all broken nodes..."

  echo "$NODES" | while IFS=: read -r name ip role; do
    [ -z "$name" ] && continue
    [ "$role" = "control-plane" ] && continue

    k3s_status=$(check_k3s_status "$name" 2>/dev/null || echo "Unknown")
    if [ "$k3s_status" != "True" ]; then
      log "Fixing $name..."
      fix_node "$name" || true
      echo ""
    fi
  done

  log "Done. Checking final status..."
  show_status
}

# Restart K3s on a node
restart_node() {
  node_name="$1"
  node_info=$(get_node "$node_name")
  node_ip=$(echo "$node_info" | cut -d: -f2)

  log "Restarting K3s on $node_name..."
  ssh -o StrictHostKeyChecking=no "user@$node_ip" "sudo rc-service k3s-agent restart"
  log "Done. Wait ~30 seconds for node to rejoin."
}

# Rejoin a node to the cluster
rejoin_node() {
  node_name="$1"
  node_info=$(get_node "$node_name")
  node_ip=$(echo "$node_info" | cut -d: -f2)

  if [ -z "$K3S_TOKEN" ]; then
    log "Getting K3s token from control plane..."
    K3S_TOKEN=$(sudo cat /var/lib/rancher/k3s/server/node-token 2>/dev/null || echo "")
    if [ -z "$K3S_TOKEN" ]; then
      log "ERROR: Cannot get K3s token. Set K3S_TOKEN environment variable."
      exit 1
    fi
  fi

  log "Removing $node_name from cluster..."
  kubectl delete node "$node_name" 2>/dev/null || true

  log "Reinstalling K3s agent on $node_name..."
  ssh -o StrictHostKeyChecking=no "user@$node_ip" <<EOF
    # Stop existing K3s
    sudo rc-service k3s-agent stop 2>/dev/null || true

    # Clean up
    sudo rm -rf /var/lib/rancher/k3s/agent

    # Reinstall K3s agent
    curl -sfL https://get.k3s.io | K3S_URL=$K3S_URL K3S_TOKEN=$K3S_TOKEN sh -s - agent

    # Start agent
    sudo rc-update add k3s-agent default
    sudo rc-service k3s-agent start
EOF

  log "Waiting for $node_name to rejoin..."
  sleep 30

  if [ "$(check_k3s_status "$node_name")" = "True" ]; then
    log "SUCCESS: $node_name rejoined the cluster!"
  else
    log "WARNING: Node may still be joining. Check: kubectl get nodes"
  fi
}

# Show logs from a node
show_logs() {
  node_name="$1"
  node_info=$(get_node "$node_name")
  node_ip=$(echo "$node_info" | cut -d: -f2)

  log "Fetching K3s logs from $node_name..."
  ssh -o StrictHostKeyChecking=no "user@$node_ip" "sudo journalctl -u k3s-agent -n 50 --no-pager"
}

# Main
case "${1:-}" in
  status)
    show_status
    ;;
  check)
    check_broken
    ;;
  fix)
    [ -z "$2" ] && { log "ERROR: Specify node name"; exit 1; }
    fix_node "$2"
    ;;
  fix-all)
    fix_all
    ;;
  restart)
    [ -z "$2" ] && { log "ERROR: Specify node name"; exit 1; }
    restart_node "$2"
    ;;
  rejoin)
    [ -z "$2" ] && { log "ERROR: Specify node name"; exit 1; }
    rejoin_node "$2"
    ;;
  logs)
    [ -z "$2" ] && { log "ERROR: Specify node name"; exit 1; }
    show_logs "$2"
    ;;
  *)
    usage
    ;;
esac
