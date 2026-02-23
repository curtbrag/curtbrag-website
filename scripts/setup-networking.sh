#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════════╗
# ║  Phase 1, Step 2: Fix Persistent Networking                        ║
# ║  Run from NEXUS-PRIME:                                             ║
# ║    bash scripts/setup-networking.sh --password 0735                ║
# ║                                                                     ║
# ║  What it does:                                                      ║
# ║    - Makes NEXUS eno2 IP (10.0.0.1/24) persistent                ║
# ║    - Configures node1 r8152 USB ethernet auto-load               ║
# ║    - Sets static IPs on the ethernet subnet for all nodes         ║
# ║    - Tests connectivity on both subnets                            ║
# ╚══════════════════════════════════════════════════════════════════════╝

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Node ethernet IPs (10.0.0.x subnet)
declare -A ETH_IPS=(
  [node1]="10.0.0.11"   [node2]="10.0.0.2"    [node3]="10.0.0.3"
  [node4]="10.0.0.4"    [node5]="10.0.0.5"    [node6]="10.0.0.6"
  [node7]="10.0.0.7"    [node8]="10.0.0.8"    [node9]="10.0.0.9"
  [node10]="10.0.0.10"
)

# Node WiFi IPs for SSH fallback
declare -A WIFI_IPS=(
  [node1]="192.168.1.206"  [node2]="192.168.1.207"  [node3]="192.168.1.208"
  [node4]="192.168.1.209"  [node5]="192.168.1.210"  [node6]="192.168.1.211"
  [node7]="192.168.1.212"  [node8]="192.168.1.213"  [node9]="192.168.1.214"
  [node10]="192.168.1.215"
)

# Nodes with known ethernet issues
ETH_BROKEN="node6"  # USB adapter dead
ETH_NEEDS_MODULE="node1"  # needs modprobe r8152

SSH_PORT="${SSH_PORT:-22}"
while [[ $# -gt 0 ]]; do
  case $1 in
    --password) SSH_PASS="$2"; shift 2;;
    --ssh-port) SSH_PORT="$2"; shift 2;;
    --nexus-only) NEXUS_ONLY=1; shift;;
    --phones-only) PHONES_ONLY=1; shift;;
    -h|--help)
      echo "Usage: $0 [options]"
      echo "  --password PASS     SSH password for phone nodes"
      echo "  --nexus-only        Only fix NEXUS networking"
      echo "  --phones-only       Only fix phone networking"
      exit 0;;
    *) shift;;
  esac
done

ssh_cmd() {
  local target="$1"; shift
  if [ -n "${SSH_PASS:-}" ]; then
    sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "$target" "$@"
  else
    ssh -p "$SSH_PORT" -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$target" "$@"
  fi
}

banner() {
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${CYAN}  $1${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# ═══════════════════════════════════════════════════════════════════════════════
# NEXUS-PRIME: Make eno2 IP persistent
# ═══════════════════════════════════════════════════════════════════════════════

setup_nexus_networking() {
  banner "NEXUS-PRIME — Persistent eno2 (10.0.0.1/24)"

  # Detect network manager
  if command -v nmcli &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} NetworkManager detected"

    # Check if connection already exists
    if nmcli con show "cluster-eth" &>/dev/null; then
      echo -e "  ${GREEN}✓${NC} 'cluster-eth' connection already configured"
    else
      echo -e "  ${YELLOW}Creating 'cluster-eth' connection...${NC}"
      sudo nmcli con add type ethernet con-name "cluster-eth" ifname eno2 \
        ipv4.addresses "10.0.0.1/24" \
        ipv4.method manual \
        connection.autoconnect yes 2>/dev/null
      sudo nmcli con up "cluster-eth" 2>/dev/null || true
      echo -e "  ${GREEN}✓${NC} Connection created and activated"
    fi

  elif command -v systemctl &>/dev/null && systemctl list-unit-files systemd-networkd.service &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} systemd-networkd detected"

    NETFILE="/etc/systemd/network/10-cluster-eth.network"
    if [ -f "$NETFILE" ]; then
      echo -e "  ${GREEN}✓${NC} Network config already exists"
    else
      echo -e "  ${YELLOW}Creating $NETFILE...${NC}"
      sudo tee "$NETFILE" > /dev/null << 'EOF'
[Match]
Name=eno2

[Network]
Address=10.0.0.1/24
EOF
      sudo systemctl enable systemd-networkd 2>/dev/null
      sudo systemctl restart systemd-networkd
      echo -e "  ${GREEN}✓${NC} Config created, networkd restarted"
    fi

  else
    echo -e "  ${YELLOW}⚠${NC} No supported network manager found"
    echo -e "  ${YELLOW}  Falling back to /etc/network/interfaces...${NC}"

    if grep -q "eno2" /etc/network/interfaces 2>/dev/null; then
      echo -e "  ${GREEN}✓${NC} eno2 already in /etc/network/interfaces"
    else
      sudo tee -a /etc/network/interfaces > /dev/null << 'EOF'

# Cluster ethernet backbone
auto eno2
iface eno2 inet static
    address 10.0.0.1
    netmask 255.255.255.0
EOF
      sudo ifup eno2 2>/dev/null || sudo ip addr add 10.0.0.1/24 dev eno2
      echo -e "  ${GREEN}✓${NC} Added to /etc/network/interfaces"
    fi
  fi

  # Verify
  if ip addr show eno2 2>/dev/null | grep -q "10.0.0.1"; then
    echo -e "  ${GREEN}✓${NC} eno2 has 10.0.0.1/24"
  else
    echo -e "  ${YELLOW}⚠${NC} eno2 doesn't have 10.0.0.1 yet — may need reboot"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Phone nodes: ethernet setup
# ═══════════════════════════════════════════════════════════════════════════════

setup_phone_networking() {
  banner "Phone Nodes — Ethernet Configuration"

  for name in $(echo "${!WIFI_IPS[@]}" | tr ' ' '\n' | sort); do
    local WIFI_IP="${WIFI_IPS[$name]}"
    local ETH_IP="${ETH_IPS[$name]}"
    local SSH_TARGET="user@${WIFI_IP}"
    local NODE_NUM="${name#node}"

    echo -e "\n${YELLOW}  [${name}]${NC} WiFi: ${WIFI_IP}, Target eth: ${ETH_IP}"

    # Skip known-broken ethernet
    if [[ " $ETH_BROKEN " == *" $name "* ]]; then
      echo -e "    ${YELLOW}⚠${NC} Known broken ethernet — WiFi only"
      continue
    fi

    if ! ssh_cmd "$SSH_TARGET" "echo ok" &>/dev/null; then
      echo -e "    ${RED}✗${NC} Cannot SSH via WiFi — skipping"
      continue
    fi

    # Special handling for node1 (needs r8152 module)
    if [[ " $ETH_NEEDS_MODULE " == *" $name "* ]]; then
      echo -ne "    Loading r8152 module... "
      ssh_cmd "$SSH_TARGET" "
        doas modprobe r8152 2>/dev/null
        # Make persistent
        echo 'r8152' | doas tee -a /etc/modules >/dev/null 2>&1
        # Deduplicate
        doas sort -u /etc/modules -o /etc/modules 2>/dev/null
      " 2>/dev/null
      echo -e "${GREEN}OK${NC}"
    fi

    # Configure static IP on eth0
    echo -ne "    Configuring eth0 (${ETH_IP}/24)... "
    ssh_cmd "$SSH_TARGET" "
      # Check if eth0 exists
      if ip link show eth0 >/dev/null 2>&1; then
        # Add static IP if not already set
        if ! ip addr show eth0 2>/dev/null | grep -q '${ETH_IP}'; then
          doas ip addr add ${ETH_IP}/24 dev eth0 2>/dev/null || true
          doas ip link set eth0 up 2>/dev/null || true
        fi

        # Make persistent via /etc/network/interfaces if available
        if [ -d /etc/network ]; then
          if ! grep -q 'eth0' /etc/network/interfaces 2>/dev/null; then
            printf '\nauto eth0\niface eth0 inet static\n    address ${ETH_IP}\n    netmask 255.255.255.0\n    gateway 10.0.0.1\n' | doas tee -a /etc/network/interfaces >/dev/null
          fi
        fi
        echo 'OK'
      else
        echo 'NO_ETH0'
      fi
    " 2>/dev/null | {
      read -r status
      if [ "$status" = "OK" ]; then
        echo -e "${GREEN}OK${NC}"
      elif [ "$status" = "NO_ETH0" ]; then
        echo -e "${YELLOW}no eth0 interface${NC}"
      else
        echo -e "${RED}FAILED${NC}"
      fi
    }
  done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Connectivity test
# ═══════════════════════════════════════════════════════════════════════════════

test_connectivity() {
  banner "Connectivity Test"

  printf "  ${YELLOW}%-8s %-16s %-10s %-16s %-10s${NC}\n" "NODE" "ETH IP" "ETH" "WIFI IP" "WIFI"
  printf "  ${YELLOW}%-8s %-16s %-10s %-16s %-10s${NC}\n" "────" "──────" "───" "───────" "────"

  for name in $(echo "${!WIFI_IPS[@]}" | tr ' ' '\n' | sort); do
    local ETH="${ETH_IPS[$name]}"
    local WIFI="${WIFI_IPS[$name]}"

    ETH_STATUS="${RED}DOWN${NC}"
    WIFI_STATUS="${RED}DOWN${NC}"

    ping -c1 -W2 "$ETH" &>/dev/null && ETH_STATUS="${GREEN}UP${NC}"
    ping -c1 -W2 "$WIFI" &>/dev/null && WIFI_STATUS="${GREEN}UP${NC}"

    printf "  %-8s %-16s ${ETH_STATUS}%-1s  %-16s ${WIFI_STATUS}%-1s\n" \
      "$name" "$ETH" "" "$WIFI" ""
  done
  echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════════

if [ -z "${PHONES_ONLY:-}" ]; then
  setup_nexus_networking
fi

if [ -z "${NEXUS_ONLY:-}" ]; then
  setup_phone_networking
fi

test_connectivity

echo -e "${GREEN}Networking setup complete.${NC}"
echo ""
