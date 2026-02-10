#!/bin/bash
# Setup script for CurtBrag Cluster API Server
# Run this on AORUS (the control-plane PC)
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
PASSWORD="${CLUSTER_WEB_PASSWORD:-0735}"
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
NODE_VER=$(node -v | grep -oP '\d+' | head -1)
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
  ADB_DEVICES=$(adb devices -l 2>/dev/null | grep -c "device " || echo 0)
  # Subtract 1 for header line if present
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

# ─── Create systemd service ──────────────────────────────────────────────────

echo -e "${YELLOW}Creating systemd service...${NC}"

SERVICE_FILE="/etc/systemd/system/cluster-api.service"
CURRENT_USER=$(whoami)

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
Environment=CLUSTER_WEB_PASSWORD=${PASSWORD}
Environment=CLUSTER_API_TOKEN=${TOKEN}
Environment=XMR_WALLET=${WALLET}
Environment=CLUSTER_API_PORT=${PORT}

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable cluster-api
sudo systemctl restart cluster-api

echo -e "  ${GREEN}✓${NC} cluster-api.service created and started"

# Wait for it to start
sleep 2

if systemctl is-active --quiet cluster-api; then
  echo -e "  ${GREEN}✓${NC} Service is running"
else
  echo -e "  ${RED}✗${NC} Service failed to start"
  sudo journalctl -u cluster-api --no-pager -n 20
  exit 1
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

# ─── Cloudflare Tunnel ────────────────────────────────────────────────────────

echo -e "${YELLOW}Setting up Cloudflare tunnel...${NC}"

if ! command -v cloudflared &>/dev/null; then
  echo -e "  ${YELLOW}⚠${NC} cloudflared not installed. Installing..."
  # Try to install
  if command -v apt &>/dev/null; then
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
    sudo apt update && sudo apt install -y cloudflared
  elif command -v pacman &>/dev/null; then
    sudo pacman -S --noconfirm cloudflared
  else
    echo -e "  ${RED}✗${NC} Cannot auto-install cloudflared. Install manually:"
    echo "    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    echo ""
    echo -e "${YELLOW}Without cloudflared, start a tunnel manually:${NC}"
    echo "  cloudflared tunnel --url http://localhost:${PORT}"
    echo ""
    echo -e "${GREEN}API server is running on port ${PORT}${NC}"
    exit 0
  fi
fi

echo -e "  ${GREEN}✓${NC} cloudflared available"

# Start a quick tunnel (prints URL to stderr)
echo -e "\n${BLUE}Starting Cloudflare tunnel...${NC}"
echo -e "The tunnel URL will appear below. Paste it into the dashboard's API config bar."
echo -e "${YELLOW}Press Ctrl+C to stop the tunnel.${NC}\n"

cloudflared tunnel --url "http://localhost:${PORT}" 2>&1 | while read -r line; do
  if echo "$line" | grep -q "https://.*trycloudflare.com"; then
    TUNNEL_URL=$(echo "$line" | grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com')
    echo -e "\n${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}  Tunnel URL: ${TUNNEL_URL}${NC}"
    echo -e "${GREEN}  Paste this into your dashboard at curtbrag.com/cluster${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
  fi
  echo "$line"
done
