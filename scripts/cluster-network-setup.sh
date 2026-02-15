#!/bin/sh
# Setup all cluster nodes with Tailscale and networking
# Run from node1 (control plane) which has SSH access to all nodes

set -e

log() {
  echo "[$(date '+%H:%M:%S')] $1"
}

# Node IPs (adjust these to match your network)
NODES="
node1:192.168.1.206
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

# Tailscale auth key (get from https://login.tailscale.com/admin/settings/keys)
TS_AUTHKEY="${TS_AUTHKEY:-}"

# WiFi config
WIFI_SSID="${WIFI_SSID:-}"
WIFI_PASSWORD="${WIFI_PASSWORD:-}"

usage() {
  cat <<EOF
Cluster Network Setup - Configure Tailscale and networking on all nodes

Usage: $0 <command> [options]

Commands:
  tailscale   Setup Tailscale on all nodes
  wifi        Configure WiFi on all nodes
  status      Show network status of all nodes
  ping        Test connectivity to all nodes

Options:
  --authkey KEY       Tailscale auth key for headless setup
  --wifi-ssid SSID    WiFi network name
  --wifi-pass PASS    WiFi password
  --node NODE         Only run on specific node (e.g., node3)

Examples:
  # Setup Tailscale on all nodes with auth key
  TS_AUTHKEY=tskey-xxx $0 tailscale

  # Configure WiFi on all nodes
  WIFI_SSID="MyNetwork" WIFI_PASSWORD="secret" $0 wifi

  # Check status of all nodes
  $0 status
EOF
}

# Run command on a single node via SSH
run_on_node() {
  node_name="$1"
  node_ip="$2"
  cmd="$3"

  log "[$node_name] Running: $cmd"
  ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "user@$node_ip" "$cmd" 2>&1 || {
    log "[$node_name] Failed to connect"
    return 1
  }
}

# Run command on all nodes
run_on_all() {
  cmd="$1"
  echo "$NODES" | while IFS=: read -r name ip; do
    [ -z "$name" ] && continue
    run_on_node "$name" "$ip" "$cmd" &
  done
  wait
}

# Setup Tailscale on a node
setup_tailscale() {
  node_name="$1"
  node_ip="$2"

  log "[$node_name] Installing Tailscale..."

  ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "user@$node_ip" <<EOF
    sudo apk add tailscale 2>/dev/null || true
    sudo rc-update add tailscale default 2>/dev/null || true
    sudo rc-service tailscale start 2>/dev/null || true
    sleep 2
    if [ -n "$TS_AUTHKEY" ]; then
      sudo tailscale up --hostname=$node_name --authkey=$TS_AUTHKEY --accept-routes
    else
      echo "No auth key - run manually: sudo tailscale up --hostname=$node_name"
    fi
    tailscale status 2>/dev/null || echo "Not connected yet"
EOF
}

# Configure WiFi on a node
setup_wifi() {
  node_name="$1"
  node_ip="$2"

  log "[$node_name] Configuring WiFi..."

  # Generate hashed PSK locally, then deploy to node
  local hashed_conf
  if command -v wpa_passphrase >/dev/null 2>&1; then
    hashed_conf=$(wpa_passphrase "$WIFI_SSID" "$WIFI_PASSWORD" | grep -v '#psk=')
    hashed_conf="ctrl_interface=/var/run/wpa_supplicant
update_config=1
country=US
$hashed_conf"
  else
    hashed_conf="ctrl_interface=/var/run/wpa_supplicant
update_config=1
country=US
network={
    ssid=\"$WIFI_SSID\"
    psk=\"$WIFI_PASSWORD\"
    key_mgmt=WPA-PSK
}"
  fi
  printf '%s\n' "$hashed_conf" | ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "user@$node_ip" "
    sudo apk add wpa_supplicant 2>/dev/null || true
    sudo mkdir -p /etc/wpa_supplicant
    sudo tee /etc/wpa_supplicant/wpa_supplicant.conf > /dev/null
    sudo chmod 600 /etc/wpa_supplicant/wpa_supplicant.conf
    sudo rc-update add wpa_supplicant default 2>/dev/null || true
    sudo rc-service wpa_supplicant restart 2>/dev/null || true
    sleep 3
    iw dev wlan0 link 2>/dev/null || echo 'WiFi status unknown'
  "
}

# Show network status
show_status() {
  node_name="$1"
  node_ip="$2"

  log "[$node_name @ $node_ip]"
  ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "user@$node_ip" 2>/dev/null <<'EOF' || echo "  Connection failed"
    echo "  Interfaces: $(ip -br addr | grep -v lo | tr '\n' ' ')"
    echo "  Tailscale: $(tailscale status --self 2>/dev/null | head -1 || echo 'Not running')"
    echo "  WiFi: $(iw dev wlan0 link 2>/dev/null | grep SSID || echo 'Not connected')"
EOF
}

# Test ping to all nodes
test_ping() {
  echo "$NODES" | while IFS=: read -r name ip; do
    [ -z "$name" ] && continue
    if ping -c 1 -W 2 "$ip" >/dev/null 2>&1; then
      echo "[$name] $ip - OK"
    else
      echo "[$name] $ip - UNREACHABLE"
    fi
  done
}

# Main
case "${1:-}" in
  tailscale)
    log "Setting up Tailscale on all nodes..."
    if [ -z "$TS_AUTHKEY" ]; then
      log "WARNING: No TS_AUTHKEY set. Manual auth required on each node."
    fi
    echo "$NODES" | while IFS=: read -r name ip; do
      [ -z "$name" ] && continue
      setup_tailscale "$name" "$ip"
    done
    ;;
  wifi)
    if [ -z "$WIFI_SSID" ] || [ -z "$WIFI_PASSWORD" ]; then
      log "ERROR: Set WIFI_SSID and WIFI_PASSWORD"
      exit 1
    fi
    log "Configuring WiFi on all nodes..."
    echo "$NODES" | while IFS=: read -r name ip; do
      [ -z "$name" ] && continue
      setup_wifi "$name" "$ip"
    done
    ;;
  status)
    log "Checking network status of all nodes..."
    echo ""
    echo "$NODES" | while IFS=: read -r name ip; do
      [ -z "$name" ] && continue
      show_status "$name" "$ip"
      echo ""
    done
    ;;
  ping)
    log "Testing connectivity to all nodes..."
    echo ""
    test_ping
    ;;
  *)
    usage
    ;;
esac
