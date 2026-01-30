#!/bin/sh
# Network setup for postmarketOS cluster nodes
# Configures WiFi and static IP for K3s cluster

set -e

log() {
  echo "[$(date '+%H:%M:%S')] $1"
}

# Configuration
WIFI_SSID="${WIFI_SSID:-}"
WIFI_PASSWORD="${WIFI_PASSWORD:-}"
STATIC_IP="${STATIC_IP:-}"
GATEWAY="${GATEWAY:-192.168.1.1}"
DNS="${DNS:-8.8.8.8 8.8.4.4}"
INTERFACE="${INTERFACE:-wlan0}"

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --wifi-ssid SSID       WiFi network name
  --wifi-password PASS   WiFi password
  --static-ip IP/CIDR    Static IP address (e.g., 192.168.1.206/24)
  --gateway IP           Gateway IP (default: 192.168.1.1)
  --interface NAME       Network interface (default: wlan0)
  --show                 Show current network config
  --help                 Show this help

Examples:
  # Configure WiFi with DHCP
  $0 --wifi-ssid "MyNetwork" --wifi-password "secret123"

  # Configure WiFi with static IP
  $0 --wifi-ssid "MyNetwork" --wifi-password "secret123" --static-ip 192.168.1.206/24

  # Show current config
  $0 --show
EOF
}

show_config() {
  log "Current Network Configuration:"
  echo ""
  echo "=== Interfaces ==="
  ip -br addr
  echo ""
  echo "=== Default Route ==="
  ip route | grep default || echo "No default route"
  echo ""
  echo "=== WiFi Status ==="
  if command -v iw >/dev/null 2>&1; then
    iw dev wlan0 link 2>/dev/null || echo "Not connected to WiFi"
  fi
  echo ""
  echo "=== Tailscale Status ==="
  if command -v tailscale >/dev/null 2>&1; then
    tailscale status 2>/dev/null || echo "Tailscale not running"
  else
    echo "Tailscale not installed"
  fi
}

# Parse arguments
while [ $# -gt 0 ]; do
  case "$1" in
    --wifi-ssid) WIFI_SSID="$2"; shift 2 ;;
    --wifi-password) WIFI_PASSWORD="$2"; shift 2 ;;
    --static-ip) STATIC_IP="$2"; shift 2 ;;
    --gateway) GATEWAY="$2"; shift 2 ;;
    --interface) INTERFACE="$2"; shift 2 ;;
    --show) show_config; exit 0 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# Check if running as root
if [ "$(id -u)" != "0" ]; then
  log "ERROR: Run as root (sudo)"
  exit 1
fi

# Install required packages
log "Installing network tools..."
apk add --no-cache wpa_supplicant iw dhcpcd 2>/dev/null || true

# Configure WiFi if SSID provided
if [ -n "$WIFI_SSID" ]; then
  log "Configuring WiFi: $WIFI_SSID"

  # Create wpa_supplicant config
  WPA_CONF="/etc/wpa_supplicant/wpa_supplicant.conf"
  mkdir -p /etc/wpa_supplicant

  cat > "$WPA_CONF" <<EOF
ctrl_interface=/var/run/wpa_supplicant
update_config=1
country=US

network={
    ssid="$WIFI_SSID"
    psk="$WIFI_PASSWORD"
    key_mgmt=WPA-PSK
    priority=1
}
EOF
  chmod 600 "$WPA_CONF"

  # Enable wpa_supplicant service
  rc-update add wpa_supplicant default 2>/dev/null || true

  # Stop any existing wpa_supplicant
  killall wpa_supplicant 2>/dev/null || true
  sleep 1

  # Start wpa_supplicant
  wpa_supplicant -B -i "$INTERFACE" -c "$WPA_CONF"
  log "WiFi connecting..."
  sleep 5
fi

# Configure static IP if provided
if [ -n "$STATIC_IP" ]; then
  log "Configuring static IP: $STATIC_IP"

  # Parse IP and CIDR
  IP_ADDR="${STATIC_IP%/*}"
  CIDR="${STATIC_IP#*/}"
  [ "$CIDR" = "$STATIC_IP" ] && CIDR="24"

  # Configure interface
  ip addr flush dev "$INTERFACE" 2>/dev/null || true
  ip addr add "$IP_ADDR/$CIDR" dev "$INTERFACE"
  ip link set "$INTERFACE" up

  # Add default route
  ip route del default 2>/dev/null || true
  ip route add default via "$GATEWAY" dev "$INTERFACE"

  # Configure DNS
  echo "nameserver 8.8.8.8" > /etc/resolv.conf
  echo "nameserver 8.8.4.4" >> /etc/resolv.conf

  # Create persistent config for /etc/network/interfaces
  IFACE_CONF="/etc/network/interfaces"
  cat >> "$IFACE_CONF" <<EOF

auto $INTERFACE
iface $INTERFACE inet static
    address $IP_ADDR
    netmask 255.255.255.0
    gateway $GATEWAY
EOF

  log "Static IP configured"
else
  # Use DHCP
  log "Starting DHCP client..."
  dhcpcd -b "$INTERFACE" 2>/dev/null || true
  sleep 3
fi

# Verify connectivity
log "Testing connectivity..."
if ping -c 1 -W 3 8.8.8.8 >/dev/null 2>&1; then
  log "SUCCESS: Internet connectivity verified"
else
  log "WARNING: No internet connectivity"
fi

# Show final config
echo ""
show_config
