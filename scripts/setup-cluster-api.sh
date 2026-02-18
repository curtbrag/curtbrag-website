#!/bin/bash
# Setup script for CurtBrag Cluster API Server
# Run this on NEXUS-PRIME (the control-plane PC)
# Usage: bash setup-cluster-api.sh [--password PASSWORD] [--token TOKEN] [--wallet XMR_WALLET]

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(dirname "$SCRIPT_DIR")/cluster/api"
PORT=3847
PASSWORD="${CLUSTER_WEB_PASSWORD:-}"
TOKEN=""
WALLET=""

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --password) PASSWORD="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    --wallet) WALLET="$2"; shift 2;;
    *) shift;;
  esac
done

if [ -z "$PASSWORD" ]; then
  echo -e "${RED}ERROR: No password set. Use --password or CLUSTER_WEB_PASSWORD env var.${NC}"
  exit 1
fi

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  CurtBrag Cluster API Server Setup${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ─── Check Prerequisites ─────────────────────────────────────────────────────

echo -e "${YELLOW}Checking prerequisites...${NC}"

check_cmd() {
  if command -v "$1" &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} $1 found: $(command -v "$1")"
    return 0
  else
    echo -e "  ${RED}✗${NC} $1 not found"
    return 1
  fi
}

MISSING=0
check_cmd node || MISSING=1
check_cmd kubectl || MISSING=1
check_cmd adb || { echo -e "  ${YELLOW}⚠${NC} adb not found — screen capture will be unavailable"; }
check_cmd ssh || MISSING=1

if [ "$MISSING" -eq 1 ]; then
  echo -e "\n${RED}Missing required tools. Install them and re-run.${NC}"
  exit 1
fi

# Check Node version
NODE_VER=$(node -v | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_VER" -lt 18 ]; then
  echo -e "${RED}Node.js >= 18 required (found: $(node -v))${NC}"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"

# Check kubectl access
if kubectl cluster-info &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} kubectl connected to cluster"
else
  echo -e "  ${RED}✗${NC} kubectl cannot reach cluster"
  echo "    Copy kubeconfig from node1: scp user@192.168.1.206:~/.kube/config ~/.kube/config"
  exit 1
fi

echo ""

# ─── Discover ADB Devices ────────────────────────────────────────────────────

if command -v adb &>/dev/null; then
  echo -e "${YELLOW}Discovering ADB devices...${NC}"
  ADB_DEVICES=$(adb devices -l 2>/dev/null | grep -v "^List" | grep -c "device " || echo 0)
  echo -e "  Found ${GREEN}${ADB_DEVICES}${NC} ADB devices"
  adb devices -l 2>/dev/null | grep "device " | while read -r line; do
    SERIAL=$(echo "$line" | awk '{print $1}')
    HOSTNAME=$(adb -s "$SERIAL" shell hostname 2>/dev/null | tr -d '\r\n')
    echo -e "  ${GREEN}✓${NC} ${HOSTNAME:-unknown} -> ${SERIAL}"
  done
  echo ""
fi

# ─── Verify API server files ─────────────────────────────────────────────────

if [ ! -f "$API_DIR/server.js" ]; then
  echo -e "${RED}API server not found at $API_DIR/server.js${NC}"
  echo "Make sure you've cloned the repo and the cluster/api directory exists."
  exit 1
fi
echo -e "${GREEN}✓${NC} API server found at $API_DIR/server.js"
echo ""

# ─── Start API Server ─────────────────────────────────────────────────────────

export CLUSTER_WEB_PASSWORD="$PASSWORD"
export CLUSTER_API_TOKEN="$TOKEN"
export XMR_WALLET="$WALLET"
export CLUSTER_API_PORT="$PORT"

# Check if systemd is available (Linux) or not (Windows Git Bash / WSL without systemd)
if command -v systemctl &>/dev/null && systemctl --version &>/dev/null 2>&1; then
  echo -e "${YELLOW}Creating systemd service...${NC}"

  SERVICE_FILE="/etc/systemd/system/cluster-api.service"
  CURRENT_USER=$(whoami)

  # Write credentials to a separate file with restricted permissions
  ENV_FILE="/etc/cluster-api.env"
  sudo tee "$ENV_FILE" > /dev/null << EOF
CLUSTER_WEB_PASSWORD=${PASSWORD}
CLUSTER_API_TOKEN=${TOKEN}
XMR_WALLET=${WALLET}
CLUSTER_API_PORT=${PORT}
EOF
  sudo chmod 600 "$ENV_FILE"
  sudo chown "${CURRENT_USER}:${CURRENT_USER}" "$ENV_FILE" 2>/dev/null || true
  echo -e "  ${GREEN}✓${NC} Credentials written to $ENV_FILE (mode 600)"

  sudo tee "$SERVICE_FILE" > /dev/null << EOF
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
  sudo systemctl enable cluster-api
  sudo systemctl restart cluster-api
  echo -e "  ${GREEN}✓${NC} cluster-api.service created and started"
  sleep 2

  if systemctl is-active --quiet cluster-api; then
    echo -e "  ${GREEN}✓${NC} Service is running"
  else
    echo -e "  ${RED}✗${NC} Service failed to start"
    sudo journalctl -u cluster-api --no-pager -n 20
    exit 1
  fi
  USE_SYSTEMD=1
else
  echo -e "${YELLOW}No systemd found (Windows/Git Bash). Starting server directly...${NC}"
  # Start API server in background
  cd "$API_DIR"
  node server.js &
  SERVER_PID=$!
  cd - > /dev/null
  sleep 2

  if kill -0 "$SERVER_PID" 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Server started (PID: $SERVER_PID)"
  else
    echo -e "  ${RED}✗${NC} Server failed to start"
    exit 1
  fi
  USE_SYSTEMD=0
fi

echo ""

# ─── Test the API ─────────────────────────────────────────────────────────────

echo -e "${YELLOW}Testing API...${NC}"

HEALTH=$(curl -s "http://localhost:${PORT}/api/health" 2>/dev/null)
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  echo -e "  ${GREEN}✓${NC} Health check passed"
else
  echo -e "  ${RED}✗${NC} Health check failed: $HEALTH"
fi

STATUS=$(curl -s "http://localhost:${PORT}/api/status" 2>/dev/null | head -c 200)
if echo "$STATUS" | grep -q '"lastUpdate"'; then
  echo -e "  ${GREEN}✓${NC} Status endpoint returning data"
else
  echo -e "  ${YELLOW}⚠${NC} Status endpoint: $STATUS"
fi

echo ""

# ─── Tailscale Funnel (auto-exposes API to dashboard) ────────────────────────

echo -e "${YELLOW}Setting up Tailscale Funnel...${NC}"

if ! command -v tailscale &>/dev/null; then
  echo -e "  ${RED}✗${NC} Tailscale not installed"
  echo -e "  Install: ${GREEN}curl -fsSL https://tailscale.com/install.sh | sh${NC}"
  echo -e "  Then re-run this script."
  echo ""
  echo -e "${GREEN}API server is running on port ${PORT}.${NC}"
  echo -e "  Install Tailscale, then run: ${GREEN}tailscale funnel ${PORT}${NC}"
  exit 0
fi

echo -e "  ${GREEN}✓${NC} Tailscale installed"

# Check Tailscale is logged in
if ! tailscale status &>/dev/null; then
  echo -e "  ${RED}✗${NC} Tailscale not logged in"
  echo -e "  Run: ${GREEN}sudo tailscale up${NC}"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Tailscale connected"

# Get FQDN
TS_FQDN=$(tailscale status --self --json 2>/dev/null | grep -o '"DNSName":"[^"]*"' | head -1 | sed 's/"DNSName":"//;s/"//;s/\.$//')

# Set up funnel via serve + funnel (works on all Tailscale versions)
echo -e "  Setting up funnel on port ${PORT}..."
tailscale serve --bg --https 443 "http://localhost:${PORT}" 2>/dev/null \
  || tailscale serve --bg "${PORT}" 2>/dev/null \
  || { echo -e "  ${YELLOW}⚠${NC} 'tailscale serve --bg' not supported, using foreground"; }

tailscale funnel on 2>/dev/null || tailscale funnel "${PORT}" &>/dev/null &

FUNNEL_URL="https://${TS_FQDN}"

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Funnel URL: ${FUNNEL_URL}${NC}"
echo -e "${GREEN}  Dashboard will auto-detect this — no paste needed${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BLUE}How it works:${NC}"
echo -e "    1. API server runs on localhost:${PORT}"
echo -e "    2. Tailscale Funnel exposes it at ${FUNNEL_URL}"
echo -e "    3. node1's push script sees this in Tailscale peers"
echo -e "    4. Dashboard reads the URL from status data and auto-connects"
echo ""
echo -e "${GREEN}Done! Open curtbrag.com/cluster — it should connect automatically.${NC}"
