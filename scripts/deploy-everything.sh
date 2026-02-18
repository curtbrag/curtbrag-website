#!/bin/bash
# ============================================================================
# deploy-everything.sh — One-command full cluster deployment
# ============================================================================
# Run this ON NEXUS-PRIME. It does everything:
#   1. Starts the Cluster API server on NEXUS-PRIME (port 3847)
#   2. Sets up Tailscale Funnel so the dashboard can reach the API
#   3. Deploys xmrig to all 10 phone nodes and starts mining
#   4. Deploys push + poller scripts to node1
#   5. Sets up cron job on node1 for live dashboard data
#   6. Verifies everything is running
#
# Usage:
#   bash deploy-everything.sh --password <WEB_PASSWORD> --api-key <NETLIFY_KEY> [--wallet <XMR>]
#
# The --password is for the cluster dashboard login.
# The --api-key is the Netlify function key for push-cluster-status.sh.
# ============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

WALLET="44Ris5ep9FE6hmwAbi7CtAV5NexMuZixhKeGk8xDFHNYWi57TjsMXEyEFQyVWNQxLkaPY1xVPjoTY2yaTfkTzkCMRur3PwT"
POOL="gulf.moneroocean.stream:20128"
PASSWORD=""
API_KEY=""
HTTP_TOKEN=""
CPU_HINT=75
SSH_PASS=""
USE_TLS=true
STAGGER_SECS=30
PORT=3847
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
API_DIR="${REPO_DIR}/cluster/api"

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
    --password) PASSWORD="$2"; shift 2;;
    --api-key) API_KEY="$2"; shift 2;;
    --wallet) WALLET="$2"; shift 2;;
    --pool) POOL="$2"; shift 2;;
    --token) HTTP_TOKEN="$2"; shift 2;;
    --cpu) CPU_HINT="$2"; shift 2;;
    --ssh-password) SSH_PASS="$2"; shift 2;;
    --no-tls) USE_TLS=false; shift;;
    --stagger) STAGGER_SECS="$2"; shift 2;;
    -h|--help)
      echo "Usage: $0 --password <WEB_PASSWORD> --api-key <NETLIFY_KEY> [options]"
      echo ""
      echo "Required:"
      echo "  --password    Dashboard login password"
      echo "  --api-key     Netlify function API key (for push-cluster-status.sh)"
      echo ""
      echo "Optional:"
      echo "  --wallet      XMR wallet address (default: hardcoded)"
      echo "  --pool        Mining pool (default: gulf.moneroocean.stream:20128)"
      echo "  --token       xmrig HTTP API token"
      echo "  --cpu         CPU usage hint % (default: 75)"
      echo "  --ssh-password  SSH/doas password for phone nodes"
      echo "  --no-tls      Disable TLS for pool connection"
      echo "  --stagger N   Seconds between starting each phone (default: 30)"
      exit 0;;
    *) shift;;
  esac
done

# ─── Prompt for missing required values ─────────────────────────────────────

if [ -z "$PASSWORD" ]; then
  echo -ne "${YELLOW}Enter dashboard password: ${NC}"
  read -r PASSWORD
  if [ -z "$PASSWORD" ]; then
    echo -e "${RED}Password is required.${NC}"
    exit 1
  fi
fi

if [ -z "$API_KEY" ]; then
  echo -ne "${YELLOW}Enter Netlify API key (CLUSTER_API_KEY): ${NC}"
  read -r API_KEY
  if [ -z "$API_KEY" ]; then
    echo -e "${RED}API key is required.${NC}"
    exit 1
  fi
fi

TLS_SETTING="false"
[ "$USE_TLS" = "true" ] && TLS_SETTING="true"

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   CurtBrag Cluster — Full Deployment                   ║${NC}"
echo -e "${CYAN}╠══════════════════════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║${NC}  Wallet:  ${WALLET:0:12}...${WALLET: -8}           ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  Pool:    ${POOL}                    ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  TLS:     ${USE_TLS}                                        ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  CPU:     ${CPU_HINT}%                                          ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  Phones:  ${#NODES[@]} nodes                                      ${CYAN}║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

# SSH wrapper
ssh_cmd() {
  local target="$1"; shift
  if [ -n "$SSH_PASS" ]; then
    command -v sshpass &>/dev/null || { echo -e "${RED}sshpass required with --ssh-password${NC}" >&2; return 1; }
    sshpass -p "$SSH_PASS" ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "$target" "$@"
  else
    ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$target" "$@"
  fi
}

# ============================================================================
# STEP 1: NEXUS-PRIME — Cluster API Server
# ============================================================================
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  STEP 1: Setting up NEXUS-PRIME API server${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check node.js
if ! command -v node &>/dev/null; then
  echo -e "${RED}Node.js not found. Install it first:${NC}"
  echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "  sudo apt-get install -y nodejs"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"

# Check API server files
if [ ! -f "$API_DIR/server.js" ]; then
  echo -e "${RED}API server not found at $API_DIR/server.js${NC}"
  echo "Make sure you're running this from the curtbrag-website repo."
  exit 1
fi
echo -e "  ${GREEN}✓${NC} API server found at $API_DIR/server.js"

# Write env file
ENV_FILE="/etc/cluster-api.env"
sudo tee "$ENV_FILE" > /dev/null << EOF
CLUSTER_WEB_PASSWORD=${PASSWORD}
CLUSTER_API_TOKEN=${HTTP_TOKEN}
XMR_WALLET=${WALLET}
CLUSTER_API_PORT=${PORT}
EOF
sudo chmod 600 "$ENV_FILE"
echo -e "  ${GREEN}✓${NC} Credentials written to $ENV_FILE"

# Create systemd service for the API server
if command -v systemctl &>/dev/null && systemctl --version &>/dev/null 2>&1; then
  CURRENT_USER=$(whoami)
  sudo tee /etc/systemd/system/cluster-api.service > /dev/null << EOF
[Unit]
Description=CurtBrag Cluster API Server
After=network.target

[Service]
Type=simple
User=${CURRENT_USER}
WorkingDirectory=${API_DIR}
ExecStart=$(which node) server.js
Restart=always
RestartSec=5
EnvironmentFile=${ENV_FILE}

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable cluster-api 2>/dev/null
  sudo systemctl restart cluster-api
  sleep 2
  if systemctl is-active --quiet cluster-api; then
    echo -e "  ${GREEN}✓${NC} cluster-api.service running"
  else
    echo -e "  ${RED}✗${NC} cluster-api.service failed — checking logs..."
    sudo journalctl -u cluster-api --no-pager -n 10
  fi
else
  # No systemd — start directly
  export CLUSTER_WEB_PASSWORD="$PASSWORD"
  export XMR_WALLET="$WALLET"
  export CLUSTER_API_PORT="$PORT"
  cd "$API_DIR"
  node server.js &
  API_PID=$!
  cd - > /dev/null
  sleep 2
  if kill -0 "$API_PID" 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} API server started (PID: $API_PID)"
  else
    echo -e "  ${RED}✗${NC} API server failed to start"
  fi
fi

# Quick health check
HEALTH=$(curl -s "http://localhost:${PORT}/api/health" 2>/dev/null)
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  echo -e "  ${GREEN}✓${NC} API health check passed"
else
  echo -e "  ${YELLOW}⚠${NC} API health check: $HEALTH"
fi
echo ""

# ============================================================================
# STEP 2: NEXUS-PRIME — Tailscale Funnel
# ============================================================================
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  STEP 2: Setting up Tailscale Funnel${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if command -v tailscale &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} Tailscale installed"
  if tailscale status &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Tailscale connected"
    TS_FQDN=$(tailscale status --self --json 2>/dev/null | grep -o '"DNSName":"[^"]*"' | head -1 | sed 's/"DNSName":"//;s/"//;s/\.$//')
    tailscale serve --bg --https 443 "http://localhost:${PORT}" 2>/dev/null \
      || tailscale serve --bg "${PORT}" 2>/dev/null \
      || echo -e "  ${YELLOW}⚠${NC} tailscale serve failed — try manually: tailscale serve ${PORT}"
    tailscale funnel on 2>/dev/null || tailscale funnel "${PORT}" &>/dev/null &
    echo -e "  ${GREEN}✓${NC} Funnel URL: https://${TS_FQDN}"
  else
    echo -e "  ${YELLOW}⚠${NC} Tailscale not logged in — run: sudo tailscale up"
  fi
else
  echo -e "  ${YELLOW}⚠${NC} Tailscale not installed"
  echo -e "  Install: curl -fsSL https://tailscale.com/install.sh | sh"
  echo -e "  Dashboard will work on LAN at http://$(hostname -I | awk '{print $1}'):${PORT}"
fi
echo ""

# ============================================================================
# STEP 3: Deploy xmrig to all phone nodes
# ============================================================================
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  STEP 3: Deploying xmrig to phone nodes${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

setup_mining_node() {
  local NAME="$1"
  local IP="${NODES[$NAME]}"
  local SSH_TARGET="user@${IP}"

  echo -e "${YELLOW}[${NAME}]${NC} ${IP}..."

  # Check SSH
  if ! ssh_cmd "$SSH_TARGET" "echo ok" &>/dev/null; then
    echo -e "  ${RED}✗${NC} Cannot SSH to ${NAME}"
    return 1
  fi

  # Enable community repo + install xmrig
  ssh_cmd "$SSH_TARGET" "
    if ! grep -q '^[^#].*community' /etc/apk/repositories 2>/dev/null; then
      MIRROR=\$(grep -m1 '^http' /etc/apk/repositories | sed 's|/[^/]*/[^/]*$||')
      ALPINE_VER=\$(cat /etc/alpine-release 2>/dev/null | cut -d. -f1,2)
      if [ -n \"\$MIRROR\" ] && [ -n \"\$ALPINE_VER\" ]; then
        echo \"\${MIRROR}/v\${ALPINE_VER}/community\" | doas tee -a /etc/apk/repositories >/dev/null
      else
        doas sed -i 's|^#\(.*community\)|\1|' /etc/apk/repositories 2>/dev/null
      fi
    fi
    doas apk update >/dev/null 2>&1
    command -v xmrig >/dev/null 2>&1 || doas apk add xmrig >/dev/null 2>&1
  " 2>/dev/null
  echo -e "  ${GREEN}✓${NC} xmrig installed"

  # Get xmrig path and symlink
  XMRIG_BIN=$(ssh_cmd "$SSH_TARGET" "command -v xmrig 2>/dev/null || for p in /usr/bin/xmrig /usr/local/bin/xmrig; do [ -x \"\$p\" ] && echo \"\$p\" && break; done" 2>/dev/null)
  if [ -z "$XMRIG_BIN" ]; then
    echo -e "  ${RED}✗${NC} xmrig binary not found"
    return 1
  fi
  ssh_cmd "$SSH_TARGET" "[ ! -e /usr/local/bin/xmrig ] && [ '$XMRIG_BIN' != '/usr/local/bin/xmrig' ] && doas ln -sf $XMRIG_BIN /usr/local/bin/xmrig; true" 2>/dev/null

  # Write config
  ssh_cmd "$SSH_TARGET" "doas mkdir -p /etc/xmrig && doas tee /etc/xmrig/config.json > /dev/null" << XMRIG_EOF
{
  "autosave": true,
  "cpu": { "enabled": true, "huge-pages": true, "max-threads-hint": ${CPU_HINT} },
  "opencl": false,
  "cuda": false,
  "donate-level": 1,
  "pools": [{
    "url": "${POOL}",
    "user": "${WALLET}",
    "pass": "${NAME}",
    "keepalive": true,
    "tls": ${TLS_SETTING}
  }],
  "http": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 18080,
    "access-token": "${HTTP_TOKEN}",
    "restricted": true
  },
  "log-file": "/var/log/xmrig.log",
  "print-time": 60
}
XMRIG_EOF
  echo -e "  ${GREEN}✓${NC} Config written"

  # Stop existing, create service, start
  ssh_cmd "$SSH_TARGET" "doas killall xmrig 2>/dev/null; sleep 1; true" 2>/dev/null
  INIT_SYS=$(ssh_cmd "$SSH_TARGET" "command -v systemctl >/dev/null 2>&1 && systemctl --version >/dev/null 2>&1 && echo systemd || { command -v rc-service >/dev/null 2>&1 && echo openrc; } || echo none" 2>/dev/null)

  if [ "$INIT_SYS" = "systemd" ]; then
    ssh_cmd "$SSH_TARGET" "doas systemctl unmask xmrig.service 2>/dev/null; true" 2>/dev/null
    ssh_cmd "$SSH_TARGET" "doas tee /etc/systemd/system/xmrig.service > /dev/null" << 'SVC_EOF'
[Unit]
Description=XMRig Monero Miner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/xmrig --config=/etc/xmrig/config.json --no-color
Restart=always
RestartSec=15
Nice=10

[Install]
WantedBy=multi-user.target
SVC_EOF
    ssh_cmd "$SSH_TARGET" "doas systemctl daemon-reload; doas systemctl enable xmrig 2>/dev/null; doas systemctl restart xmrig" 2>/dev/null
  elif [ "$INIT_SYS" = "openrc" ]; then
    ssh_cmd "$SSH_TARGET" "doas tee /etc/init.d/xmrig > /dev/null && doas chmod +x /etc/init.d/xmrig" << 'ORC_EOF'
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
depend() { need net; after firewall; }
ORC_EOF
    ssh_cmd "$SSH_TARGET" "doas rc-update add xmrig default 2>/dev/null; doas rc-service xmrig restart" 2>/dev/null
  else
    echo -e "  ${RED}✗${NC} No init system found"
    return 1
  fi

  # Verify
  sleep 3
  PROC=$(ssh_cmd "$SSH_TARGET" "pgrep -x xmrig >/dev/null && echo RUNNING || echo DEAD" 2>/dev/null)
  if [ "$PROC" = "RUNNING" ]; then
    echo -e "  ${GREEN}✓${NC} xmrig RUNNING"
  else
    echo -e "  ${RED}✗${NC} xmrig NOT running"
    ssh_cmd "$SSH_TARGET" "tail -3 /var/log/xmrig.log 2>/dev/null" 2>/dev/null
    return 1
  fi
}

MINE_OK=0
MINE_FAIL=0
NODE_NUM=0
for name in $(echo "${!NODES[@]}" | tr ' ' '\n' | sort); do
  NODE_NUM=$((NODE_NUM + 1))
  if [ "$NODE_NUM" -gt 1 ] && [ "$STAGGER_SECS" -gt 0 ]; then
    echo -e "  ${BLUE}Waiting ${STAGGER_SECS}s (RandomX dataset allocation)...${NC}"
    sleep "$STAGGER_SECS"
  fi
  if setup_mining_node "$name"; then
    MINE_OK=$((MINE_OK + 1))
  else
    MINE_FAIL=$((MINE_FAIL + 1))
  fi
done

echo ""
echo -e "  Mining: ${GREEN}${MINE_OK} running${NC}, ${RED}${MINE_FAIL} failed${NC}"
echo ""

# ============================================================================
# STEP 4: Deploy push + poller scripts to node1
# ============================================================================
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  STEP 4: Setting up node1 (push + poller)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

NODE1_IP="${NODES[node1]}"
NODE1_SSH="user@${NODE1_IP}"

if ! ssh_cmd "$NODE1_SSH" "echo ok" &>/dev/null; then
  echo -e "  ${RED}✗${NC} Cannot SSH to node1 (${NODE1_IP})"
  echo -e "  ${YELLOW}Skipping push/poller setup. Set up manually later.${NC}"
else
  echo -e "  ${GREEN}✓${NC} SSH to node1 OK"

  # Copy scripts
  echo -e "  Copying scripts to node1..."
  scp -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
    "$SCRIPT_DIR/push-cluster-status.sh" \
    "$SCRIPT_DIR/poll-cluster-commands.sh" \
    "$SCRIPT_DIR/cluster-nodes.conf" \
    "${NODE1_SSH}:/home/user/" 2>/dev/null
  echo -e "  ${GREEN}✓${NC} Scripts copied"

  # Write env file on node1
  ssh_cmd "$NODE1_SSH" "cat > /home/user/.cluster-env << EOF
CLUSTER_API_KEY=${API_KEY}
EOF
chmod 600 /home/user/.cluster-env" 2>/dev/null
  echo -e "  ${GREEN}✓${NC} API key written to node1"

  # Set up cron job for push script
  ssh_cmd "$NODE1_SSH" "
    CRON_LINE='*/5 * * * * /home/user/push-cluster-status.sh >> /home/user/cluster-push.log 2>&1'
    crontab -l 2>/dev/null | grep -v push-cluster-status | { cat; echo \"\$CRON_LINE\"; } | crontab -
  " 2>/dev/null
  echo -e "  ${GREEN}✓${NC} Cron job installed (push every 5 min)"

  # Start poller
  ssh_cmd "$NODE1_SSH" "
    pkill -f poll-cluster-commands 2>/dev/null
    sleep 1
    nohup /home/user/poll-cluster-commands.sh > /home/user/cluster-poller.log 2>&1 &
    echo \$!
  " 2>/dev/null
  echo -e "  ${GREEN}✓${NC} Command poller started"

  # Do an immediate push
  echo -e "  Running initial status push..."
  PUSH_RESULT=$(ssh_cmd "$NODE1_SSH" "CLUSTER_API_KEY=${API_KEY} /home/user/push-cluster-status.sh 2>&1 | tail -5" 2>/dev/null)
  if echo "$PUSH_RESULT" | grep -qi "success\|200\|ok"; then
    echo -e "  ${GREEN}✓${NC} Initial push succeeded"
  else
    echo -e "  ${YELLOW}⚠${NC} Initial push result: ${PUSH_RESULT}"
  fi
fi

echo ""

# ============================================================================
# STEP 5: Final verification
# ============================================================================
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  STEP 5: Final verification${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Check API
API_OK="no"
HEALTH=$(curl -s "http://localhost:${PORT}/api/health" 2>/dev/null)
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  echo -e "  ${GREEN}✓${NC} NEXUS-PRIME API: running on port ${PORT}"
  API_OK="yes"
else
  echo -e "  ${RED}✗${NC} NEXUS-PRIME API: not responding"
fi

# Check Tailscale
TS_OK="no"
if command -v tailscale &>/dev/null && tailscale status &>/dev/null; then
  TS_FQDN=$(tailscale status --self --json 2>/dev/null | grep -o '"DNSName":"[^"]*"' | head -1 | sed 's/"DNSName":"//;s/"//;s/\.$//')
  echo -e "  ${GREEN}✓${NC} Tailscale Funnel: https://${TS_FQDN}"
  TS_OK="yes"
else
  echo -e "  ${YELLOW}⚠${NC} Tailscale: not available"
fi

# Check mining nodes
echo -e "  Checking miners..."
MINERS_RUNNING=0
for name in $(echo "${!NODES[@]}" | tr ' ' '\n' | sort); do
  IP="${NODES[$name]}"
  HASH=$(curl -s --connect-timeout 2 "http://${IP}:18080/1/summary" 2>/dev/null | grep -o '"hashrate"' || echo "")
  if [ -n "$HASH" ]; then
    MINERS_RUNNING=$((MINERS_RUNNING + 1))
    echo -e "    ${GREEN}✓${NC} ${name} (${IP}) — mining"
  else
    # Fallback: check via SSH
    PROC=$(ssh_cmd "user@${IP}" "pgrep -x xmrig >/dev/null && echo Y || echo N" 2>/dev/null)
    if [ "$PROC" = "Y" ]; then
      MINERS_RUNNING=$((MINERS_RUNNING + 1))
      echo -e "    ${GREEN}✓${NC} ${name} (${IP}) — running (API not ready yet)"
    else
      echo -e "    ${RED}✗${NC} ${name} (${IP}) — not running"
    fi
  fi
done

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║                  DEPLOYMENT COMPLETE                    ║${NC}"
echo -e "${CYAN}╠══════════════════════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║${NC}  API Server:    $([ "$API_OK" = "yes" ] && echo "${GREEN}RUNNING${NC}" || echo "${RED}DOWN${NC}")    (port ${PORT})               ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  Tailscale:     $([ "$TS_OK" = "yes" ] && echo "${GREEN}ACTIVE${NC} " || echo "${YELLOW}UNAVAIL${NC}")                            ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  Miners:        ${GREEN}${MINERS_RUNNING}/${#NODES[@]}${NC} running                           ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  Pool:          ${POOL}               ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  Wallet:        ${WALLET:0:12}...${WALLET: -8}          ${CYAN}║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${GREEN}What happens next:${NC}"
echo -e "    • Shares appear on MoneroOcean in ~15 minutes"
echo -e "    • Dashboard at curtbrag.com/cluster gets live data every 5 min"
echo -e "    • XMR accumulates → auto-payout at 0.003 XMR → Cake Wallet"
echo ""
echo -e "  ${BLUE}Check mining status:${NC}"
echo -e "    Pool:      https://moneroocean.stream/#/dashboard?addr=${WALLET:0:12}..."
echo -e "    Dashboard: https://curtbrag.com/cluster"
echo -e "    API:       curl http://localhost:${PORT}/api/health"
echo ""
