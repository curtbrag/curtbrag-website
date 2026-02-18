#!/bin/bash
# Setup xmrig Monero mining on phone cluster nodes
# Usage: bash setup-mining.sh --wallet <XMR_ADDRESS> [--pool POOL:PORT] [--node NODE_NAME] [--token HTTP_TOKEN]
#
# This script runs FROM a control machine (NEXUS-PRIME/node1 or any host with SSH access).
# It SSHes into each phone node and:
#   1. Enables Alpine community repo (required — xmrig is not in the default repos)
#   2. Installs xmrig via apk (the only reliable method for Linux ARM64)
#   3. Deploys xmrig config with wallet/pool/worker settings
#   4. Creates and starts an OpenRC service (uses start-stop-daemon for proper daemonization)
#
# Why OpenRC and not nohup/disown/setsid?
#   The phones run postmarketOS (Alpine Linux) with BusyBox ash.
#   - disown: doesn't exist in BusyBox ash
#   - nohup + &: gets killed when SSH session closes
#   - setsid: detaches but doas still reaps it
#   - start-stop-daemon: BusyBox built-in, designed exactly for this. OpenRC wraps it.

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

WALLET=""
POOL="gulf.moneroocean.stream:20128"
TARGET_NODE=""
HTTP_TOKEN=""
CPU_HINT=75  # Max 75% CPU to avoid thermal throttle
SSH_PASS=""  # Optional: SSH/doas password for phone nodes
USE_TLS=true # MoneroOcean uses TLS by default on port 20128

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
    --password) SSH_PASS="$2"; shift 2;;
    --no-tls) USE_TLS=false; shift;;
    -h|--help)
      echo "Usage: $0 --wallet <XMR_ADDRESS> [options]"
      echo "  --wallet     Monero wallet address (REQUIRED)"
      echo "  --pool       Mining pool (default: gulf.moneroocean.stream:20128)"
      echo "  --node       Target single node (default: all phones)"
      echo "  --token      xmrig HTTP API access token"
      echo "  --cpu        CPU usage hint % (default: 75)"
      echo "  --password   SSH/doas password for phone nodes"
      echo "  --no-tls     Disable TLS for pool connection"
      exit 0;;
    *) shift;;
  esac
done

if [ -z "$WALLET" ]; then
  echo -e "${RED}Error: --wallet is required${NC}"
  echo "Usage: $0 --wallet <XMR_ADDRESS>"
  echo ""
  echo "You must provide YOUR Monero wallet address."
  echo "Generate one at: https://www.getmonero.org/downloads/"
  exit 1
fi

# Validate CPU_HINT is numeric 1-100
case "$CPU_HINT" in
  ''|*[!0-9]*) echo -e "${RED}Error: --cpu must be a number (1-100)${NC}"; exit 1;;
esac
if [ "$CPU_HINT" -lt 1 ] || [ "$CPU_HINT" -gt 100 ]; then
  echo -e "${RED}Error: --cpu must be between 1 and 100${NC}"; exit 1
fi

# SSH wrapper — uses sshpass if --password was provided, otherwise BatchMode
ssh_cmd() {
  local target="$1"
  shift
  if [ -n "$SSH_PASS" ]; then
    if ! command -v sshpass &>/dev/null; then
      echo -e "${RED}Error: sshpass required when using --password (install: apk add sshpass / apt install sshpass)${NC}" >&2
      return 1
    fi
    sshpass -p "$SSH_PASS" ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "$target" "$@"
  else
    ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$target" "$@"
  fi
}

# TLS setting for pool config
TLS_SETTING="false"
[ "$USE_TLS" = "true" ] && TLS_SETTING="true"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  XMR Mining Setup — Phone Cluster${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  Pool:   ${POOL}"
echo -e "  TLS:    ${USE_TLS}"
echo -e "  Wallet: ${WALLET:0:12}...${WALLET: -8}"
echo -e "  CPU:    ${CPU_HINT}%"
echo -e "  Auth:   $([ -n "$SSH_PASS" ] && echo "password" || echo "SSH keys")"
echo ""

setup_node() {
  local NAME="$1"
  local IP="${NODES[$NAME]}"
  local SSH_TARGET="user@${IP}"

  echo -e "${YELLOW}[${NAME}]${NC} Setting up xmrig on ${IP}..."

  # Check SSH access
  if ! ssh_cmd "$SSH_TARGET" "echo ok" &>/dev/null; then
    echo -e "  ${RED}✗${NC} Cannot SSH to ${NAME} (${IP})"
    return 1
  fi

  # Check architecture
  ARCH=$(ssh_cmd "$SSH_TARGET" "uname -m" 2>/dev/null)
  echo -e "  Architecture: ${ARCH}"

  # Step 1: Enable Alpine community repo (xmrig is NOT in default repos)
  echo -e "  Enabling community repo..."
  ssh_cmd "$SSH_TARGET" "
    # Enable community repo if not already enabled
    if ! grep -q '^[^#].*community' /etc/apk/repositories 2>/dev/null; then
      # Find the base Alpine mirror URL from existing repos
      MIRROR=\$(grep -m1 '^http' /etc/apk/repositories | sed 's|/[^/]*/[^/]*$||')
      ALPINE_VER=\$(cat /etc/alpine-release 2>/dev/null | cut -d. -f1,2)
      if [ -n \"\$MIRROR\" ] && [ -n \"\$ALPINE_VER\" ]; then
        echo \"\${MIRROR}/v\${ALPINE_VER}/community\" | doas tee -a /etc/apk/repositories >/dev/null
        echo 'community repo enabled'
      else
        # Fallback: try to uncomment existing community line
        doas sed -i 's|^#\(.*community\)|\1|' /etc/apk/repositories 2>/dev/null
        echo 'community repo uncommented'
      fi
    else
      echo 'community repo already enabled'
    fi
    doas apk update >/dev/null 2>&1
  " 2>/dev/null
  echo -e "  ${GREEN}✓${NC} Repos configured"

  # Step 2: Install xmrig via apk
  echo -e "  Installing xmrig..."
  INSTALL_RESULT=$(ssh_cmd "$SSH_TARGET" "
    if command -v xmrig >/dev/null 2>&1; then
      echo 'already-installed'
      xmrig --version 2>/dev/null | head -1
    else
      if doas apk add xmrig 2>&1; then
        echo 'apk-success'
      else
        echo 'apk-failed'
      fi
    fi
  " 2>/dev/null)

  if echo "$INSTALL_RESULT" | grep -q "already-installed\|apk-success\|Installing\|OK"; then
    echo -e "  ${GREEN}✓${NC} xmrig installed via apk"
  elif echo "$INSTALL_RESULT" | grep -q "apk-failed"; then
    echo -e "  ${RED}✗${NC} apk install failed. Output:"
    echo "    $INSTALL_RESULT"
    echo -e "  ${YELLOW}NOTE:${NC} xmrig has NO pre-built Linux ARM64 binary on GitHub."
    echo -e "  ${YELLOW}NOTE:${NC} You must fix the Alpine repos or build from source."
    return 1
  fi

  # Verify xmrig binary exists at a known path
  XMRIG_BIN=$(ssh_cmd "$SSH_TARGET" "command -v xmrig 2>/dev/null || echo ''" 2>/dev/null)
  if [ -z "$XMRIG_BIN" ]; then
    # Check common paths
    XMRIG_BIN=$(ssh_cmd "$SSH_TARGET" "
      for p in /usr/bin/xmrig /usr/local/bin/xmrig /usr/sbin/xmrig; do
        [ -x \"\$p\" ] && echo \"\$p\" && break
      done
    " 2>/dev/null)
  fi

  if [ -z "$XMRIG_BIN" ]; then
    echo -e "  ${RED}✗${NC} xmrig binary not found after install"
    return 1
  fi
  echo -e "  ${GREEN}✓${NC} xmrig binary at: ${XMRIG_BIN}"

  # Ensure /usr/local/bin/xmrig symlink exists (some configs reference this path)
  if [ "$XMRIG_BIN" != "/usr/local/bin/xmrig" ]; then
    ssh_cmd "$SSH_TARGET" "
      [ ! -e /usr/local/bin/xmrig ] && doas ln -sf $XMRIG_BIN /usr/local/bin/xmrig
    " 2>/dev/null
  fi

  # Step 3: Write xmrig config
  echo -e "  Writing config..."
  ssh_cmd "$SSH_TARGET" "doas mkdir -p /etc/xmrig && doas tee /etc/xmrig/config.json > /dev/null" << XMRIG_CONFIG
{
  "autosave": true,
  "cpu": {
    "enabled": true,
    "huge-pages": true,
    "max-threads-hint": ${CPU_HINT}
  },
  "opencl": false,
  "cuda": false,
  "donate-level": 1,
  "pools": [
    {
      "url": "${POOL}",
      "user": "${WALLET}",
      "pass": "${NAME}",
      "keepalive": true,
      "tls": ${TLS_SETTING}
    }
  ],
  "http": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 18080,
    "access-token": "${HTTP_TOKEN}",
    "restricted": true
  },
  "log-file": "/var/log/xmrig.log",
  "print-time": 60
}
XMRIG_CONFIG
  echo -e "  ${GREEN}✓${NC} Config written to /etc/xmrig/config.json"

  # Step 4: Create and start OpenRC service
  # (postmarketOS uses OpenRC, not systemd)
  INIT_SYS=$(ssh_cmd "$SSH_TARGET" "command -v rc-service >/dev/null 2>&1 && echo openrc || { command -v systemctl >/dev/null 2>&1 && echo systemd; } || echo none" 2>/dev/null)
  echo -e "  Init system: ${INIT_SYS}"

  if [ "$INIT_SYS" = "openrc" ]; then
    echo -e "  Creating OpenRC service..."
    ssh_cmd "$SSH_TARGET" "doas tee /etc/init.d/xmrig > /dev/null && doas chmod +x /etc/init.d/xmrig" << 'OPENRC_SVC'
#!/sbin/openrc-run
name="xmrig"
description="XMRig Monero Miner"
command="/usr/local/bin/xmrig"
command_args="--config=/etc/xmrig/config.json"
command_background="yes"
pidfile="/run/xmrig.pid"
output_log="/var/log/xmrig.log"
error_log="/var/log/xmrig.log"
start_stop_daemon_args="--nicelevel 10"

depend() {
  need net
  after firewall
}
OPENRC_SVC
    # Stop any existing xmrig (cleanup from manual runs)
    ssh_cmd "$SSH_TARGET" "doas killall xmrig 2>/dev/null; sleep 1; true" 2>/dev/null
    ssh_cmd "$SSH_TARGET" "doas rc-update add xmrig default 2>/dev/null; doas rc-service xmrig restart" 2>/dev/null
    SVC_STATUS=$(ssh_cmd "$SSH_TARGET" "doas rc-service xmrig status 2>&1" 2>/dev/null)
    echo -e "  Service: ${SVC_STATUS}"
  elif [ "$INIT_SYS" = "systemd" ]; then
    echo -e "  Creating systemd service..."
    ssh_cmd "$SSH_TARGET" "doas tee /etc/systemd/system/xmrig.service > /dev/null" << 'SVCUNIT'
[Unit]
Description=XMRig Monero Miner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/xmrig --config=/etc/xmrig/config.json
Restart=always
RestartSec=10
Nice=10

[Install]
WantedBy=multi-user.target
SVCUNIT
    ssh_cmd "$SSH_TARGET" "doas systemctl daemon-reload; doas systemctl enable xmrig 2>/dev/null; doas systemctl restart xmrig" 2>/dev/null
  else
    echo -e "  ${RED}✗${NC} No init system found — cannot create service"
    return 1
  fi
  echo -e "  ${GREEN}✓${NC} Service enabled and started"

  # Step 5: Verify mining is running
  sleep 3
  PROC_CHECK=$(ssh_cmd "$SSH_TARGET" "pgrep -x xmrig >/dev/null 2>&1 && echo RUNNING || echo NOT_RUNNING" 2>/dev/null)
  if [ "$PROC_CHECK" = "RUNNING" ]; then
    echo -e "  ${GREEN}✓${NC} xmrig process is running"
  else
    echo -e "  ${RED}✗${NC} xmrig process NOT running — checking logs..."
    LOG_TAIL=$(ssh_cmd "$SSH_TARGET" "tail -5 /var/log/xmrig.log 2>/dev/null" 2>/dev/null)
    echo -e "  Log: ${LOG_TAIL}"
    return 1
  fi

  # Check HTTP API
  VERIFY=$(ssh_cmd "$SSH_TARGET" "curl -s --connect-timeout 3 http://localhost:18080/1/summary 2>/dev/null | head -c 100" 2>/dev/null)
  if echo "$VERIFY" | grep -q "hashrate\|worker_id"; then
    echo -e "  ${GREEN}✓${NC} xmrig HTTP API responding"
  else
    echo -e "  ${YELLOW}⚠${NC} HTTP API not responding yet (xmrig may still be initializing RandomX dataset)"
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
  SUCCESSES=0
  FAILURES=0
  for name in $(echo "${!NODES[@]}" | tr ' ' '\n' | sort); do
    if setup_node "$name"; then
      SUCCESSES=$((SUCCESSES + 1))
    else
      FAILURES=$((FAILURES + 1))
    fi
  done
  echo ""
  echo -e "${BLUE}Results: ${GREEN}${SUCCESSES} succeeded${NC}, ${RED}${FAILURES} failed${NC}"
fi

echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Mining setup complete!${NC}"
echo -e "${GREEN}  Pool:    ${POOL}${NC}"
echo -e "${GREEN}  Workers: node1, node2, ... node10${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BLUE}Control mining via:${NC}"
echo -e "    Start all:  curl http://localhost:3847/api/commands -d '{\"command\":\"mining-start\",\"target\":\"all\"}'"
echo -e "    Stop all:   curl http://localhost:3847/api/commands -d '{\"command\":\"mining-stop\",\"target\":\"all\"}'"
echo -e "    Status:     curl http://localhost:3847/api/mining/stats"
