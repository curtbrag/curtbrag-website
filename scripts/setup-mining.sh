#!/bin/bash
# Setup xmrig Monero mining on phone cluster nodes
# Usage: bash setup-mining.sh --wallet <XMR_ADDRESS> [--pool POOL:PORT] [--node NODE_NAME] [--token HTTP_TOKEN]

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

WALLET=""
POOL="pool.supportxmr.com:3333"
TARGET_NODE=""
HTTP_TOKEN=""
CPU_HINT=75  # Max 75% CPU to avoid thermal throttle

# Node IPs
declare -A NODES=(
  [node1]="192.168.1.206"
  [node2]="192.168.1.207"
  [node3]="192.168.1.208"
  [node4]="192.168.1.209"
  [node5]="192.168.1.210"
  [node6]="192.168.1.211"
  [node7]="192.168.1.212"
  [node8]="192.168.1.213"
  [node9]="192.168.1.214"
  [node10]="192.168.1.215"
)

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --wallet) WALLET="$2"; shift 2;;
    --pool) POOL="$2"; shift 2;;
    --node) TARGET_NODE="$2"; shift 2;;
    --token) HTTP_TOKEN="$2"; shift 2;;
    --cpu) CPU_HINT="$2"; shift 2;;
    -h|--help)
      echo "Usage: $0 --wallet <XMR_ADDRESS> [options]"
      echo "  --wallet   Monero wallet address (required)"
      echo "  --pool     Mining pool (default: pool.supportxmr.com:3333)"
      echo "  --node     Target single node (default: all phones)"
      echo "  --token    xmrig HTTP API access token"
      echo "  --cpu      CPU usage hint % (default: 75)"
      exit 0;;
    *) shift;;
  esac
done

if [ -z "$WALLET" ]; then
  echo -e "${RED}Error: --wallet is required${NC}"
  echo "Usage: $0 --wallet <XMR_ADDRESS>"
  exit 1
fi

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  XMR Mining Setup — Phone Cluster${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  Pool:   ${POOL}"
echo -e "  Wallet: ${WALLET:0:12}...${WALLET: -8}"
echo -e "  CPU:    ${CPU_HINT}%"
echo ""

setup_node() {
  local NAME="$1"
  local IP="${NODES[$NAME]}"
  local SSH="user@${IP}"

  echo -e "${YELLOW}[${NAME}]${NC} Setting up xmrig on ${IP}..."

  # Check SSH access
  if ! ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o BatchMode=yes "$SSH" "echo ok" &>/dev/null; then
    echo -e "  ${RED}✗${NC} Cannot SSH to ${NAME} (${IP})"
    return 1
  fi

  # Check architecture
  ARCH=$(ssh -o ConnectTimeout=3 -o BatchMode=yes "$SSH" "uname -m" 2>/dev/null)
  echo -e "  Architecture: ${ARCH}"

  # Install xmrig
  echo -e "  Installing xmrig..."
  ssh -o BatchMode=yes "$SSH" "doas apk add xmrig 2>/dev/null || echo 'apk-failed'" | while read -r line; do
    if [ "$line" = "apk-failed" ]; then
      echo -e "  ${YELLOW}⚠${NC} apk install failed, downloading binary..."
      # Download xmrig ARM64 binary
      ssh -o BatchMode=yes "$SSH" bash -c "'
        cd /tmp
        XMRIG_VER=6.21.1
        wget -q https://github.com/xmrig/xmrig/releases/download/v\${XMRIG_VER}/xmrig-\${XMRIG_VER}-linux-static-aarch64.tar.gz -O xmrig.tar.gz
        tar xzf xmrig.tar.gz
        doas cp xmrig-\${XMRIG_VER}/xmrig /usr/local/bin/xmrig
        doas chmod +x /usr/local/bin/xmrig
        rm -rf xmrig.tar.gz xmrig-\${XMRIG_VER}
      '"
    fi
  done

  # Verify xmrig installed
  if ! ssh -o BatchMode=yes "$SSH" "which xmrig" &>/dev/null; then
    echo -e "  ${RED}✗${NC} xmrig installation failed"
    return 1
  fi
  echo -e "  ${GREEN}✓${NC} xmrig installed"

  # Write config
  echo -e "  Writing config..."
  ssh -o BatchMode=yes "$SSH" "doas mkdir -p /etc/xmrig && doas tee /etc/xmrig/config.json > /dev/null" << XMRIG_CONFIG
{
  "autosave": true,
  "cpu": {
    "enabled": true,
    "huge-pages": true,
    "max-threads-hint": ${CPU_HINT}
  },
  "opencl": false,
  "cuda": false,
  "pools": [
    {
      "url": "${POOL}",
      "user": "${WALLET}",
      "pass": "${NAME}",
      "keepalive": true,
      "tls": false
    }
  ],
  "http": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 18080,
    "access-token": "${HTTP_TOKEN}",
    "restricted": false
  },
  "log-file": "/var/log/xmrig.log",
  "print-time": 60
}
XMRIG_CONFIG
  echo -e "  ${GREEN}✓${NC} Config written"

  # Create OpenRC init script
  echo -e "  Creating service..."
  ssh -o BatchMode=yes "$SSH" "doas tee /etc/init.d/xmrig > /dev/null && doas chmod +x /etc/init.d/xmrig" << 'INITSCRIPT'
#!/sbin/openrc-run

name="xmrig"
description="XMRig Monero Miner"
command="/usr/local/bin/xmrig"
command_args="--config=/etc/xmrig/config.json"
command_background=true
pidfile="/run/xmrig.pid"
output_log="/var/log/xmrig.log"
error_log="/var/log/xmrig.log"

depend() {
  need net
  after firewall
}
INITSCRIPT

  # Also check if xmrig is at /usr/bin/xmrig (from apk)
  ssh -o BatchMode=yes "$SSH" "
    if [ -f /usr/bin/xmrig ] && [ ! -f /usr/local/bin/xmrig ]; then
      doas ln -sf /usr/bin/xmrig /usr/local/bin/xmrig
    fi
  " 2>/dev/null

  # Enable and start
  ssh -o BatchMode=yes "$SSH" "doas rc-update add xmrig default 2>/dev/null; doas rc-service xmrig restart" 2>/dev/null
  echo -e "  ${GREEN}✓${NC} Service enabled and started"

  # Verify
  sleep 2
  VERIFY=$(ssh -o BatchMode=yes "$SSH" "curl -s http://localhost:18080/1/summary 2>/dev/null | head -c 100" 2>/dev/null)
  if echo "$VERIFY" | grep -q "hashrate"; then
    echo -e "  ${GREEN}✓${NC} xmrig HTTP API responding"
  else
    echo -e "  ${YELLOW}⚠${NC} xmrig HTTP API not responding yet (may need a moment to start)"
  fi

  echo -e "  ${GREEN}Done!${NC}"
  echo ""
}

# ─── Main ─────────────────────────────────────────────────────────────────────

if [ -n "$TARGET_NODE" ]; then
  if [ -z "${NODES[$TARGET_NODE]}" ]; then
    echo -e "${RED}Unknown node: $TARGET_NODE${NC}"
    echo "Valid nodes: ${!NODES[*]}"
    exit 1
  fi
  setup_node "$TARGET_NODE"
else
  echo -e "${YELLOW}Setting up all ${#NODES[@]} phone nodes...${NC}\n"
  for name in $(echo "${!NODES[@]}" | tr ' ' '\n' | sort); do
    setup_node "$name" || true
  done
fi

echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Mining setup complete!${NC}"
echo -e "${GREEN}  Pool: ${POOL}${NC}"
echo -e "${GREEN}  Workers will show as node1, node2, etc. on the pool${NC}"
echo -e "${GREEN}  Check status: https://supportxmr.com/#/dashboard${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
