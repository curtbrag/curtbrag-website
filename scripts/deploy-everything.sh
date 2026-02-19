#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════════╗
# ║  CurtBrag Phone Cluster — ONE COMMAND DEPLOY                       ║
# ║  Run from any machine with SSH access to the phones:               ║
# ║    bash scripts/deploy-everything.sh                                ║
# ║                                                                     ║
# ║  Works from: Steam Deck, NEXUS-PRIME, any Linux/Mac with SSH keys  ║
# ║                                                                     ║
# ║  What it does (in order):                                           ║
# ║    1. Sets up THIS machine as the cluster brain (API server)        ║
# ║    2. Exposes API via Tailscale Funnel                              ║
# ║    3. SSHes into all 10 phones and deploys xmrig                   ║
# ║    4. Sets up push cron + command poller on node1                   ║
# ║    5. Verifies everything is running                                ║
# ╚══════════════════════════════════════════════════════════════════════╝

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
API_DIR="$REPO_DIR/cluster/api"

WALLET="44Ris5ep9FE6hmwAbi7CtAV5NexMuZixhKeGk8xDFHNYWi57TjsMXEyEFQyVWNQxLkaPY1xVPjoTY2yaTfkTzkCMRur3PwT"
POOL="gulf.moneroocean.stream:20128"
API_PORT=3847
CPU_HINT=75
STAGGER_SECS=5

# Node IPs — same as setup-mining.sh and cluster-nodes.conf
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

# ─── Parse args ──────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case $1 in
    --wallet) WALLET="$2"; shift 2;;
    --pool) POOL="$2"; shift 2;;
    --cpu) CPU_HINT="$2"; shift 2;;
    --password) SSH_PASS="$2"; shift 2;;
    --stagger) STAGGER_SECS="$2"; shift 2;;
    --skip-mining) SKIP_MINING=1; shift;;
    --skip-nexus) SKIP_NEXUS=1; shift;;
    --api-only) API_ONLY=1; shift;;
    --ssh-port) SSH_PORT="$2"; shift 2;;
    --diagnose) DIAGNOSE=1; shift;;
    -h|--help)
      echo "Usage: $0 [options]"
      echo "  --wallet ADDR     XMR wallet address"
      echo "  --password PASS   SSH password for phone nodes"
      echo "  --cpu N            CPU % hint for miners (default: 75)"
      echo "  --stagger N        Seconds between starting each miner (default: 30)"
      echo "  --skip-mining      Skip mining setup on phones"
      echo "  --skip-nexus       Skip API server setup on this machine"
      echo "  --api-only         Only set up API server + Tailscale (no mining, no node1)"
      echo "  --ssh-port PORT    SSH port (default: 22, Termux uses 8022)"
      echo "  --diagnose         Run SSH diagnostics on all nodes"
      exit 0;;
    *) shift;;
  esac
done

banner() {
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${CYAN}  $1${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# SSH wrapper — supports custom port via SSH_PORT env (default: 22)
SSH_PORT="${SSH_PORT:-22}"

# Common SSH options — keep connections lean to avoid overwhelming phone sshd
SSH_OPTS="-o ConnectTimeout=5 -o ServerAliveInterval=10 -o ServerAliveCountMax=2 -o StrictHostKeyChecking=accept-new"

ssh_cmd() {
  local target="$1"; shift
  if [ -n "${SSH_PASS:-}" ]; then
    # Password mode: use sshpass, try pubkey first then password
    sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" $SSH_OPTS -o PreferredAuthentications=publickey,keyboard-interactive,password "$target" "$@"
  else
    ssh -p "$SSH_PORT" $SSH_OPTS -o BatchMode=yes "$target" "$@"
  fi
}

scp_cmd() {
  local src="$1" dst="$2"
  if [ -n "${SSH_PASS:-}" ]; then
    sshpass -p "$SSH_PASS" scp -P "$SSH_PORT" $SSH_OPTS "$src" "$dst" 2>/dev/null
  else
    scp -P "$SSH_PORT" $SSH_OPTS "$src" "$dst" 2>/dev/null
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 0: SSH Diagnostics (--diagnose)
# ═══════════════════════════════════════════════════════════════════════════════

diagnose_ssh() {
  banner "SSH Diagnostics"
  echo -e "  SSH port: ${SSH_PORT}"
  echo ""
  for name in $(echo "${!NODES[@]}" | tr ' ' '\n' | sort); do
    IP="${NODES[$name]}"
    echo -ne "  ${YELLOW}[${name}]${NC} ${IP}:${SSH_PORT} ... "

    # Step 1: ping
    if ping -c 1 -W 2 "$IP" &>/dev/null; then
      echo -ne "${GREEN}ping OK${NC} → "
    else
      echo -e "${RED}ping FAILED${NC} (host unreachable or not on network)"
      continue
    fi

    # Step 2: port open
    if timeout 3 bash -c "echo >/dev/tcp/$IP/$SSH_PORT" 2>/dev/null; then
      echo -ne "${GREEN}port open${NC} → "
    else
      echo -e "${RED}port ${SSH_PORT} closed${NC} (sshd not running or wrong port)"
      # Try common alternate ports
      for alt_port in 22 8022 2222; do
        [ "$alt_port" = "$SSH_PORT" ] && continue
        if timeout 3 bash -c "echo >/dev/tcp/$IP/$alt_port" 2>/dev/null; then
          echo -e "    ${YELLOW}→ port ${alt_port} IS open. Try: --ssh-port ${alt_port}${NC}"
        fi
      done
      continue
    fi

    # Step 3: SSH auth
    if ssh_cmd "user@${IP}" "echo ok" &>/dev/null; then
      echo -e "${GREEN}SSH OK${NC}"
    else
      echo -e "${RED}SSH auth FAILED${NC} (need key setup or --password)"
      echo -e "    ${YELLOW}→ Fix: ssh-copy-id -p ${SSH_PORT} user@${IP}${NC}"
    fi
  done
  echo ""
}

# Run diagnostics if requested
if [ -n "${DIAGNOSE:-}" ]; then
  diagnose_ssh
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 1: NEXUS-PRIME — Cluster API Server
# ═══════════════════════════════════════════════════════════════════════════════

setup_nexus_prime() {
  banner "STEP 1/4 — Cluster API Server (this machine)"

  # Prompt for credentials if not set
  if [ -z "${CLUSTER_WEB_PASSWORD:-}" ]; then
    echo -n "  Dashboard password (CLUSTER_WEB_PASSWORD): "
    read -r CLUSTER_WEB_PASSWORD
    export CLUSTER_WEB_PASSWORD
  fi
  if [ -z "${CLUSTER_API_KEY:-}" ]; then
    echo -n "  API key for push/poller (CLUSTER_API_KEY): "
    read -r CLUSTER_API_KEY
    export CLUSTER_API_KEY
  fi

  # Check prerequisites
  echo -e "\n${YELLOW}  Checking prerequisites...${NC}"
  local MISSING=0
  for cmd in node ssh; do
    if command -v "$cmd" &>/dev/null; then
      echo -e "  ${GREEN}✓${NC} $cmd"
    else
      echo -e "  ${RED}✗${NC} $cmd missing"; MISSING=1
    fi
  done
  command -v kubectl &>/dev/null && echo -e "  ${GREEN}✓${NC} kubectl" || echo -e "  ${YELLOW}⚠${NC} kubectl not found (optional)"
  command -v adb &>/dev/null && echo -e "  ${GREEN}✓${NC} adb" || echo -e "  ${YELLOW}⚠${NC} adb not found (optional)"
  [ "$MISSING" -eq 1 ] && { echo -e "${RED}  Missing required tools.${NC}"; return 1; }

  # Verify API server files exist
  if [ ! -f "$API_DIR/server.js" ]; then
    echo -e "  ${RED}✗${NC} server.js not found at $API_DIR"
    return 1
  fi
  echo -e "  ${GREEN}✓${NC} server.js found"

  # Write env file
  ENV_FILE="/etc/cluster-api.env"
  sudo tee "$ENV_FILE" > /dev/null << EOF
CLUSTER_WEB_PASSWORD=${CLUSTER_WEB_PASSWORD}
CLUSTER_API_KEY=${CLUSTER_API_KEY}
XMR_WALLET=${WALLET}
CLUSTER_API_PORT=${API_PORT}
EOF
  sudo chmod 600 "$ENV_FILE"
  echo -e "  ${GREEN}✓${NC} Credentials saved to $ENV_FILE"

  # Create and start systemd service
  if command -v systemctl &>/dev/null; then
    echo -e "\n${YELLOW}  Creating systemd service...${NC}"
    sudo tee /etc/systemd/system/cluster-api.service > /dev/null << EOF
[Unit]
Description=CurtBrag Cluster API Server
After=network.target

[Service]
Type=simple
User=$(whoami)
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
      echo -e "  ${GREEN}✓${NC} cluster-api service running"
    else
      echo -e "  ${RED}✗${NC} Service failed — check: sudo journalctl -u cluster-api -n 20"
      return 1
    fi
  else
    echo -e "\n${YELLOW}  No systemd — starting server directly...${NC}"
    cd "$API_DIR"
    CLUSTER_WEB_PASSWORD="$CLUSTER_WEB_PASSWORD" CLUSTER_API_KEY="$CLUSTER_API_KEY" \
      XMR_WALLET="$WALLET" CLUSTER_API_PORT="$API_PORT" \
      nohup node server.js > /var/log/cluster-api.log 2>&1 &
    cd - > /dev/null
    sleep 2
    echo -e "  ${GREEN}✓${NC} Server started (PID: $!)"
  fi

  # Quick health check
  HEALTH=$(curl -s "http://localhost:${API_PORT}/api/health" 2>/dev/null)
  if echo "$HEALTH" | grep -q '"status"'; then
    echo -e "  ${GREEN}✓${NC} API health check passed"
  else
    echo -e "  ${YELLOW}⚠${NC} API didn't respond yet (may need a moment)"
  fi

  echo -e "\n  ${GREEN}API server is live on port ${API_PORT}${NC}"
}

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 2: Tailscale Funnel — expose API to the internet
# ═══════════════════════════════════════════════════════════════════════════════

setup_tailscale_funnel() {
  banner "STEP 2/4 — Tailscale Funnel"

  if ! command -v tailscale &>/dev/null; then
    echo -e "  ${YELLOW}⚠${NC} Tailscale not installed. Attempting auto-install..."
    # Detect platform and install
    if [ -f /etc/steamos-release ] || uname -a | grep -qi steamdeck 2>/dev/null; then
      # Steam Deck — use deck-tailscale installer
      echo -e "  ${BLUE}Detected Steam Deck — using deck-tailscale installer${NC}"
      if [ ! -d "$HOME/deck-tailscale" ]; then
        git clone https://github.com/tailscale-dev/deck-tailscale.git "$HOME/deck-tailscale" 2>/dev/null
      fi
      # deck-tailscale needs sudo and working DNS — ensure resolv.conf is set
      if ! sudo cat /etc/resolv.conf 2>/dev/null | grep -q nameserver; then
        echo -e "  ${YELLOW}Fixing DNS for root...${NC}"
        echo -e "nameserver 8.8.8.8\nnameserver 1.1.1.1" | sudo tee /etc/resolv.conf >/dev/null
      fi
      (cd "$HOME/deck-tailscale" && sudo bash tailscale.sh) 2>&1
      if [ -f /etc/profile.d/tailscale.sh ]; then
        source /etc/profile.d/tailscale.sh 2>/dev/null || export PATH="$PATH:/opt/tailscale"
      fi
    elif [ -f /etc/alpine-release ]; then
      # Alpine/postmarketOS
      sudo apk add tailscale 2>/dev/null || doas apk add tailscale 2>/dev/null
      sudo rc-update add tailscale default 2>/dev/null || true
      sudo service tailscale start 2>/dev/null || true
    else
      # Generic Linux
      curl -fsSL https://tailscale.com/install.sh | sh
    fi

    if ! command -v tailscale &>/dev/null; then
      echo -e "  ${RED}✗${NC} Tailscale install failed. Install manually:"
      echo -e "    Steam Deck: cd ~/deck-tailscale && sudo bash tailscale.sh"
      echo -e "    Linux:      curl -fsSL https://tailscale.com/install.sh | sh"
      echo -e "  ${YELLOW}Skipping funnel setup.${NC}"
      return 0
    fi
    echo -e "  ${GREEN}✓${NC} Tailscale installed"
  fi

  if ! tailscale status &>/dev/null; then
    echo -e "  ${YELLOW}⚠${NC} Tailscale not logged in."
    echo -e "  ${BLUE}Attempting: sudo tailscale up --operator=$(whoami) --ssh${NC}"
    sudo tailscale up --operator="$(whoami)" --ssh --qr 2>&1 || {
      echo -e "  ${RED}✗${NC} Tailscale login failed. Run manually:"
      echo -e "    sudo tailscale up --operator=$(whoami) --ssh"
      return 0
    }
  fi

  echo -e "  ${GREEN}✓${NC} Tailscale connected"

  TS_FQDN=$(tailscale status --self --json 2>/dev/null | grep -o '"DNSName":"[^"]*"' | head -1 | sed 's/"DNSName":"//;s/"//;s/\.$//')

  tailscale serve --bg --https 443 "http://localhost:${API_PORT}" 2>/dev/null \
    || tailscale serve --bg "${API_PORT}" 2>/dev/null \
    || echo -e "  ${YELLOW}⚠${NC} tailscale serve failed — set up manually: tailscale funnel ${API_PORT}"

  tailscale funnel on 2>/dev/null || true

  echo -e "  ${GREEN}✓${NC} Funnel URL: https://${TS_FQDN}"
  echo -e "  Dashboard at curtbrag.com/cluster will auto-detect this."
}

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 3: Deploy xmrig mining to all phones
# ═══════════════════════════════════════════════════════════════════════════════

setup_mining_node() {
  local NAME="$1"
  local IP="${NODES[$NAME]}"
  local SSH_TARGET="user@${IP}"

  echo -e "${YELLOW}  [${NAME}]${NC} ${IP}"

  # Single SSH session: install, configure, start xmrig — all in one connection
  # This prevents WiFi drops between steps from leaving partial deployments
  DEPLOY_OUT=$(ssh_cmd "$SSH_TARGET" "bash -s" 2>&1 << DEPLOY_SCRIPT
set -e

# --- Detect OS ---
if [ -f /etc/alpine-release ]; then
  OS=alpine
  PRIV="doas"
elif command -v apt-get >/dev/null 2>&1; then
  OS=debian
  PRIV="sudo"
else
  OS=unknown
  PRIV="sudo"
fi
echo "OS:\$OS"

# --- Install xmrig ---
XMRIG_BIN=\$(command -v xmrig 2>/dev/null)
if [ -n "\$XMRIG_BIN" ]; then
  echo "INSTALL:already-installed"
elif [ "\$OS" = "alpine" ]; then
  # Enable community repo if needed
  if ! grep -q '^[^#].*community' /etc/apk/repositories 2>/dev/null; then
    MIRROR=\$(grep -m1 '^http' /etc/apk/repositories | sed 's|/[^/]*/[^/]*$||')
    ALPINE_VER=\$(cat /etc/alpine-release 2>/dev/null | cut -d. -f1,2)
    [ -n "\$MIRROR" ] && [ -n "\$ALPINE_VER" ] && echo "\${MIRROR}/v\${ALPINE_VER}/community" | \$PRIV tee -a /etc/apk/repositories >/dev/null
  fi
  \$PRIV apk update >/dev/null 2>&1
  \$PRIV apk add xmrig 2>&1 | tail -3
  echo "INSTALL:done"
elif [ "\$OS" = "debian" ]; then
  \$PRIV apt-get update -qq 2>&1 | tail -1
  \$PRIV apt-get install -y xmrig 2>&1 | tail -3
  echo "INSTALL:done"
else
  echo "INSTALL:ERROR unsupported OS"
  exit 1
fi

# --- Verify binary exists ---
XMRIG_BIN=\$(command -v xmrig 2>/dev/null)
if [ -z "\$XMRIG_BIN" ]; then
  echo "INSTALL:FAILED - xmrig binary not found"
  exit 1
fi
echo "BIN:\$XMRIG_BIN"

# --- Write config (huge-pages OFF for phone ARM CPUs) ---
\$PRIV mkdir -p /etc/xmrig
\$PRIV tee /etc/xmrig/config.json > /dev/null << 'XMRIG_CONF'
{
  "autosave": true,
  "cpu": { "enabled": true, "huge-pages": false, "max-threads-hint": ${CPU_HINT} },
  "opencl": false, "cuda": false, "donate-level": 1,
  "pools": [{
    "url": "${POOL}", "user": "${WALLET}", "pass": "${NAME}",
    "keepalive": true, "tls": true
  }],
  "http": { "enabled": true, "host": "127.0.0.1", "port": 18080, "restricted": true },
  "log-file": "/tmp/xmrig.log", "print-time": 60
}
XMRIG_CONF
echo "CONFIG:written"

# --- Kill any stale process ---
\$PRIV killall xmrig 2>/dev/null || true
sleep 1

# --- Create service and start ---
# Detect init system: Alpine always uses OpenRC (even if systemctl shim exists).
# For non-Alpine, verify PID 1 is actually systemd before using it.
if [ "\$OS" = "alpine" ]; then
  INIT=openrc
  # Remove broken systemd service file + stale PID file
  \$PRIV rm -f /etc/systemd/system/xmrig.service /run/xmrig.pid 2>/dev/null || true
  # Write OpenRC service file
  \$PRIV tee /etc/init.d/xmrig > /dev/null << ORCSVC || true
#!/sbin/openrc-run
name="xmrig"
description="XMRig Miner"
command="\$XMRIG_BIN"
command_args="--config=/etc/xmrig/config.json --no-color"
command_background="yes"
pidfile="/run/xmrig.pid"
output_log="/tmp/xmrig.log"
error_log="/tmp/xmrig.log"
depend() { need net; }
ORCSVC
  \$PRIV chmod +x /etc/init.d/xmrig || true
  \$PRIV rc-update add xmrig default 2>/dev/null || true
  # Stop old service cleanly, then start fresh (restart can fail if stop fails)
  \$PRIV rc-service xmrig stop 2>/dev/null || true
  sleep 1
  SVC_OUT=\$(\$PRIV rc-service xmrig start 2>&1) || true
  echo "SVC_OUT:\$SVC_OUT"
  # Fallback: if rc-service failed, start xmrig directly via start-stop-daemon
  sleep 2
  if ! pgrep -x xmrig >/dev/null 2>&1; then
    echo "DEBUG:rc-service-failed-trying-direct-start"
    \$PRIV start-stop-daemon --start --background --make-pidfile \
      --pidfile /run/xmrig.pid \
      --exec \$XMRIG_BIN -- --config=/etc/xmrig/config.json --no-color 2>&1 || true
  fi
elif command -v systemctl >/dev/null 2>&1 && [ "\$(cat /proc/1/comm 2>/dev/null)" = "systemd" ]; then
  INIT=systemd
  \$PRIV systemctl unmask xmrig.service 2>/dev/null || true
  \$PRIV tee /etc/systemd/system/xmrig.service > /dev/null << SYSD
[Unit]
Description=XMRig Miner
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=\$XMRIG_BIN --config=/etc/xmrig/config.json --no-color
Restart=always
RestartSec=15
Nice=10
[Install]
WantedBy=multi-user.target
SYSD
  \$PRIV systemctl daemon-reload
  \$PRIV systemctl enable xmrig 2>/dev/null
  \$PRIV systemctl restart xmrig
else
  INIT=none
  # Direct start as fallback
  \$PRIV nohup \$XMRIG_BIN --config=/etc/xmrig/config.json --no-color > /tmp/xmrig.log 2>&1 &
fi
echo "SERVICE:\$INIT"

# --- Verify (wait for startup — ARM phones are slow) ---
sleep 5
if pgrep -x xmrig >/dev/null 2>&1; then
  echo "STATUS:RUNNING"
else
  # Show last few lines of log for debugging
  echo "STATUS:NOT_RUNNING"
  echo "LOG_TAIL:\$(tail -5 /tmp/xmrig.log 2>/dev/null || echo 'no log file')"
fi
DEPLOY_SCRIPT
  )

  DEPLOY_RC=$?

  # Parse the output
  local REMOTE_OS=$(echo "$DEPLOY_OUT" | grep "^OS:" | head -1 | cut -d: -f2)
  local INSTALL_STATUS=$(echo "$DEPLOY_OUT" | grep "^INSTALL:" | tail -1 | cut -d: -f2-)
  local XMRIG_BIN=$(echo "$DEPLOY_OUT" | grep "^BIN:" | head -1 | cut -d: -f2)
  local CONFIG_STATUS=$(echo "$DEPLOY_OUT" | grep "^CONFIG:" | head -1 | cut -d: -f2)
  local SERVICE_TYPE=$(echo "$DEPLOY_OUT" | grep "^SERVICE:" | head -1 | cut -d: -f2)
  local STATUS=$(echo "$DEPLOY_OUT" | grep "^STATUS:" | head -1 | cut -d: -f2)
  local LOG_TAIL=$(echo "$DEPLOY_OUT" | grep "^LOG_TAIL:" | head -1 | cut -d: -f2-)
  local SVC_OUT=$(echo "$DEPLOY_OUT" | grep "^SVC_OUT:" | head -1 | cut -d: -f2-)
  local DEBUG_LINES=$(echo "$DEPLOY_OUT" | grep "^DEBUG:" | cut -d: -f2-)

  # Handle SSH failure (complete or partial)
  if [ $DEPLOY_RC -ne 0 ] && [ -z "$REMOTE_OS" ]; then
    SSH_ERR_SHORT=$(echo "$DEPLOY_OUT" | grep -v "^$" | tail -2 | tr '\n' ' ')
    echo -e "    ${RED}✗${NC} Cannot SSH — ${SSH_ERR_SHORT:-unknown error}"
    echo -e "    ${YELLOW}Tip: ssh-copy-id -p ${SSH_PORT} user@${IP} or re-run with --password${NC}"
    return 1
  fi

  # Handle partial SSH failure (connection dropped mid-deploy)
  if [ -z "$SERVICE_TYPE" ] && [ -n "$REMOTE_OS" ]; then
    echo -e "    ${YELLOW}⚠${NC} SSH connection dropped during service setup"
    [ -n "$DEBUG_LINES" ] && echo -e "    ${YELLOW}Debug: ${DEBUG_LINES}${NC}"
  fi

  echo -e "    OS: ${REMOTE_OS:-unknown}"

  # Check install
  if [ "$INSTALL_STATUS" = "FAILED - xmrig binary not found" ]; then
    echo -e "    ${RED}✗${NC} xmrig install failed"
    return 1
  fi
  echo -e "    ${GREEN}✓${NC} xmrig installed (${XMRIG_BIN:-unknown})"
  echo -e "    ${GREEN}✓${NC} Config written (huge-pages: off, log: /tmp/xmrig.log)"

  # Check service
  if [ "$STATUS" = "RUNNING" ]; then
    echo -e "    ${GREEN}✓${NC} xmrig RUNNING (${SERVICE_TYPE:-direct})"
    return 0
  else
    echo -e "    ${RED}✗${NC} xmrig NOT running (${SERVICE_TYPE:-unknown})"
    if [ -n "$SVC_OUT" ]; then
      echo -e "    ${YELLOW}rc-service: ${SVC_OUT}${NC}"
    fi
    if [ -n "$DEBUG_LINES" ]; then
      echo -e "    ${YELLOW}Debug: ${DEBUG_LINES}${NC}"
    fi
    if [ -n "$LOG_TAIL" ] && [ "$LOG_TAIL" != "no log file" ]; then
      echo -e "    ${YELLOW}Log: ${LOG_TAIL}${NC}"
    fi
    return 1
  fi
}

deploy_mining() {
  banner "STEP 3/4 — Deploy xmrig to All Phones"
  echo -e "  Pool:   ${POOL}"
  echo -e "  Wallet: ${WALLET:0:12}...${WALLET: -8}"
  echo -e "  CPU:    ${CPU_HINT}%"
  echo ""

  # PHASE 1: Wake up all phones' WiFi radios with parallel pings
  echo -e "  ${BLUE}Waking phone WiFi radios...${NC}"
  for name in $(echo "${!NODES[@]}" | tr ' ' '\n' | sort); do
    ping -c 3 -i 0.3 "${NODES[$name]}" &>/dev/null &
  done
  wait
  sleep 2

  # PHASE 2: Parallel SSH pre-check — test all nodes simultaneously
  # This avoids the sequential timeout problem (10s x 10 nodes = 100s)
  echo -e "  ${BLUE}Testing SSH to all nodes (parallel)...${NC}"
  local PRECHECK_DIR="/tmp/cluster-precheck-$$"
  mkdir -p "$PRECHECK_DIR"

  for name in $(echo "${!NODES[@]}" | tr ' ' '\n' | sort); do
    local IP="${NODES[$name]}"
    (
      if ssh_cmd "user@${IP}" "echo ok" &>/dev/null; then
        echo "OK" > "$PRECHECK_DIR/$name"
      else
        # Capture the actual error
        ERR=$(ssh_cmd "user@${IP}" "echo ok" 2>&1 | tail -1)
        echo "FAIL:${ERR}" > "$PRECHECK_DIR/$name"
      fi
    ) &
  done
  wait

  # Collect results
  local REACHABLE="" UNREACHABLE=""
  for name in $(echo "${!NODES[@]}" | tr ' ' '\n' | sort); do
    local IP="${NODES[$name]}"
    local RESULT=$(cat "$PRECHECK_DIR/$name" 2>/dev/null || echo "FAIL:no response")
    if [ "$RESULT" = "OK" ]; then
      echo -e "    ${YELLOW}[${name}]${NC} ${IP} ... ${GREEN}OK${NC}"
      REACHABLE="$REACHABLE $name"
    else
      local ERR_MSG="${RESULT#FAIL:}"
      echo -e "    ${YELLOW}[${name}]${NC} ${IP} ... ${RED}FAILED${NC} — ${ERR_MSG:-unknown}"
      UNREACHABLE="$UNREACHABLE $name"
    fi
  done
  rm -rf "$PRECHECK_DIR"

  local REACH_COUNT=$(echo $REACHABLE | wc -w)
  local UNREACH_COUNT=$(echo $UNREACHABLE | wc -w)
  echo ""
  echo -e "  SSH: ${GREEN}${REACH_COUNT} reachable${NC}, ${RED}${UNREACH_COUNT} unreachable${NC}"

  # PHASE 2b: If low success rate, retry once after short pause
  if [ "$REACH_COUNT" -lt 5 ] && [ "$REACH_COUNT" -lt "${#NODES[@]}" ]; then
    echo -e "  ${YELLOW}Low success rate — retrying failed nodes in 5s...${NC}"
    sleep 5

    # Re-ping to wake WiFi
    for name in $UNREACHABLE; do
      ping -c 2 -i 0.3 "${NODES[$name]}" &>/dev/null &
    done
    wait
    sleep 1

    local RETRY_OK=""
    for name in $UNREACHABLE; do
      local IP="${NODES[$name]}"
      echo -ne "    ${YELLOW}[${name}]${NC} ${IP} retry ... "
      if ssh_cmd "user@${IP}" "echo ok" &>/dev/null; then
        echo -e "${GREEN}OK${NC}"
        REACHABLE="$REACHABLE $name"
        RETRY_OK="$RETRY_OK $name"
      else
        echo -e "${RED}still failed${NC}"
      fi
    done

    # Remove retried-OK nodes from UNREACHABLE
    for ok_name in $RETRY_OK; do
      UNREACHABLE=$(echo "$UNREACHABLE" | sed "s/ $ok_name//g")
    done

    REACH_COUNT=$(echo $REACHABLE | wc -w)
    UNREACH_COUNT=$(echo $UNREACHABLE | wc -w)
    echo ""
    echo -e "  SSH after retry: ${GREEN}${REACH_COUNT} reachable${NC}, ${RED}${UNREACH_COUNT} unreachable${NC}"
  fi

  if [ "$REACH_COUNT" -eq 0 ]; then
    echo -e "  ${RED}No nodes reachable — cannot deploy mining.${NC}"
    echo -e "  ${YELLOW}Run: bash scripts/deploy-everything.sh --diagnose${NC}"
    return 1
  fi

  # PHASE 3: Deploy to reachable nodes
  echo ""
  echo -e "  ${BLUE}Deploying to ${REACH_COUNT} reachable nodes...${NC}"
  echo ""

  local OK=0 FAIL=0 STARTED=0
  for name in $REACHABLE; do
    # Only stagger after a successful xmrig start (RandomX memory needs time)
    if [ "$STARTED" -gt 0 ] && [ "$STAGGER_SECS" -gt 0 ]; then
      echo -e "  ${BLUE}Waiting ${STAGGER_SECS}s (RandomX memory)...${NC}"
      sleep "$STAGGER_SECS"
    fi
    if setup_mining_node "$name"; then
      OK=$((OK + 1))
      STARTED=$((STARTED + 1))
    else
      FAIL=$((FAIL + 1))
    fi
  done

  # Count unreachable as failed too
  FAIL=$((FAIL + UNREACH_COUNT))

  echo ""
  echo -e "  Mining: ${GREEN}${OK} running${NC}, ${RED}${FAIL} failed${NC}"
  if [ -n "$UNREACHABLE" ]; then
    echo -e "  ${YELLOW}Unreachable (skipped):${UNREACHABLE}${NC}"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 4: node1 — Push script + Command poller
# ═══════════════════════════════════════════════════════════════════════════════

setup_node1_services() {
  banner "STEP 4/4 — node1: Push Script + Command Poller"

  local NODE1_IP="${NODES[node1]}"
  local NODE1_SSH="user@${NODE1_IP}"

  if ! ssh_cmd "$NODE1_SSH" "echo ok" &>/dev/null; then
    echo -e "  ${RED}✗${NC} Cannot SSH to node1 (${NODE1_IP})"
    return 1
  fi
  echo -e "  ${GREEN}✓${NC} SSH to node1 OK"

  # Copy scripts to node1
  echo -e "\n${YELLOW}  Copying scripts to node1...${NC}"
  for script in push-cluster-status.sh poll-cluster-commands.sh cluster-nodes.conf; do
    scp_cmd "$SCRIPT_DIR/$script" "${NODE1_SSH}:/home/user/$script" \
      && echo -e "  ${GREEN}✓${NC} $script" \
      || echo -e "  ${RED}✗${NC} Failed to copy $script"
  done

  # Write env file on node1
  ssh_cmd "$NODE1_SSH" "cat > /home/user/.cluster-env << 'ENVEOF'
CLUSTER_API_KEY=${CLUSTER_API_KEY:-changeme}
ENVEOF
chmod 600 /home/user/.cluster-env" 2>/dev/null
  echo -e "  ${GREEN}✓${NC} .cluster-env written on node1"

  # Make scripts executable
  ssh_cmd "$NODE1_SSH" "chmod +x /home/user/push-cluster-status.sh /home/user/poll-cluster-commands.sh" 2>/dev/null

  # Set up push cron job (every 5 min)
  echo -e "\n${YELLOW}  Setting up cron job...${NC}"
  ssh_cmd "$NODE1_SSH" "
    CRON_LINE='*/5 * * * * /home/user/push-cluster-status.sh >> /home/user/cluster-push.log 2>&1'
    (crontab -l 2>/dev/null | grep -v push-cluster-status; echo \"\$CRON_LINE\") | crontab -
  " 2>/dev/null
  echo -e "  ${GREEN}✓${NC} Cron: push-cluster-status.sh every 5 min"

  # Start command poller (kill old one first)
  echo -e "\n${YELLOW}  Starting command poller...${NC}"
  ssh_cmd "$NODE1_SSH" "
    pkill -f poll-cluster-commands 2>/dev/null; sleep 1
    nohup /home/user/poll-cluster-commands.sh > /home/user/cluster-poller.log 2>&1 &
    sleep 1
    if pgrep -f poll-cluster-commands >/dev/null 2>&1; then
      echo RUNNING
    else
      echo FAILED
    fi
  " 2>/dev/null | grep -q RUNNING \
    && echo -e "  ${GREEN}✓${NC} Command poller running" \
    || echo -e "  ${RED}✗${NC} Command poller failed to start"

  # Do an immediate push test
  echo -e "\n${YELLOW}  Running first push...${NC}"
  ssh_cmd "$NODE1_SSH" "/home/user/push-cluster-status.sh" 2>/dev/null \
    && echo -e "  ${GREEN}✓${NC} First push sent" \
    || echo -e "  ${YELLOW}⚠${NC} First push failed (API key may need updating)"
}

# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║        CURTBRAG PHONE CLUSTER — FULL DEPLOY                ║${NC}"
echo -e "${CYAN}║  API Server + Tailscale + Mining + Dashboard Push          ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Wallet: ${WALLET:0:12}...${WALLET: -8}"
echo -e "  Pool:   ${POOL}"
echo -e "  Phones: ${#NODES[@]} nodes (192.168.1.206-215)"
echo ""

# Step 1: API server on this machine
if [ -z "${SKIP_NEXUS:-}" ]; then
  setup_nexus_prime
else
  echo -e "${YELLOW}Skipping API server setup (--skip-nexus)${NC}"
fi

# Step 2: Tailscale Funnel
if [ -z "${SKIP_NEXUS:-}" ]; then
  setup_tailscale_funnel
fi

# If --api-only, skip mining and node1 services
if [ -n "${API_ONLY:-}" ]; then
  echo -e "${YELLOW}API-only mode — skipping mining and node1 setup${NC}"
else
  # Step 3: Mining
  if [ -z "${SKIP_MINING:-}" ]; then
    deploy_mining
  else
    echo -e "${YELLOW}Skipping mining setup (--skip-mining)${NC}"
  fi

  # Step 4: node1 push + poller
  setup_node1_services
fi

# ═══════════════════════════════════════════════════════════════════════════════
# FINAL SUMMARY
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                    DEPLOY COMPLETE                          ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${GREEN}API Server:${NC}   Running on this machine, port ${API_PORT}"
echo -e "  ${GREEN}Tailscale:${NC}    Funnel exposing API to internet"
echo -e "  ${GREEN}Mining:${NC}       xmrig on all phones -> MoneroOcean"
echo -e "  ${GREEN}Dashboard:${NC}    node1 pushing status every 5 min"
echo -e "  ${GREEN}Poller:${NC}       node1 polling for commands"
echo ""
echo -e "  ${BLUE}Check mining:${NC}"
echo -e "    https://moneroocean.stream/#/dashboard?addr=${WALLET}"
echo -e "    (first shares appear in ~15 min)"
echo ""
echo -e "  ${BLUE}Check dashboard:${NC}"
echo -e "    https://curtbrag.com/cluster"
echo ""
echo -e "  ${BLUE}Manage:${NC}"
if command -v systemctl &>/dev/null; then
  echo -e "    sudo systemctl status cluster-api   # API server"
  echo -e "    sudo journalctl -u cluster-api -f   # API logs"
else
  echo -e "    curl http://localhost:${API_PORT}/api/health  # API health"
fi
echo -e "    ssh -p ${SSH_PORT} user@192.168.1.206 'tail -f /tmp/xmrig.log'  # Mining logs"
echo ""
echo -e "  ${BLUE}Diagnostics:${NC}"
echo -e "    bash scripts/deploy-everything.sh --diagnose    # Check SSH to all phones"
echo ""
