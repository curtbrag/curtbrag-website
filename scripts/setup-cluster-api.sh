#!/bin/bash
# Setup: Cluster API server + Cloudflare tunnel
# Run on AORUS control-plane node:
#   git clone https://github.com/curtbrag/curtbrag-website.git
#   cd curtbrag-website
#   bash scripts/setup-cluster-api.sh
#
# After running, copy the tunnel URL and paste it into curtbrag.com/cluster

set -e

API_PORT="${API_PORT:-3847}"
API_TOKEN="${API_TOKEN:-}"
INSTALL_DIR="$HOME/cluster-api"

echo "================================================"
echo "  K3s Phone Cluster API + Cloudflare Tunnel"
echo "================================================"
echo ""

# Check prerequisites
echo "[1/5] Checking prerequisites..."
for cmd in kubectl node; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd not found. Install it first."
    exit 1
  fi
done

# Test kubectl access
if ! kubectl cluster-info &>/dev/null 2>&1; then
  echo "ERROR: kubectl cannot reach the cluster."
  echo "Make sure KUBECONFIG is set or you're on the control-plane node."
  exit 1
fi
echo "  kubectl: OK ($(kubectl get nodes --no-headers 2>/dev/null | wc -l) nodes)"
echo "  node:    OK ($(node --version))"

# Install cloudflared if needed
echo ""
echo "[2/5] Checking cloudflared..."
if ! command -v cloudflared &>/dev/null; then
  echo "  Installing cloudflared..."
  if command -v apt-get &>/dev/null; then
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-archive-keyring.gpg >/dev/null
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-archive-keyring.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
    sudo apt-get update -qq && sudo apt-get install -y -qq cloudflared
  elif command -v apk &>/dev/null; then
    sudo apk add cloudflared
  else
    echo "  Downloading binary..."
    curl -fsSL -o /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
    chmod +x /tmp/cloudflared
    sudo mv /tmp/cloudflared /usr/local/bin/
  fi
fi
echo "  cloudflared: OK ($(cloudflared --version 2>&1 | head -1))"

# Deploy API server
echo ""
echo "[3/5] Deploying API server to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp "$(dirname "$0")/../cluster/api/server.js" "$INSTALL_DIR/"
cp "$(dirname "$0")/../cluster/api/package.json" "$INSTALL_DIR/"
echo "  Files copied."

# Create systemd service
echo ""
echo "[4/5] Creating systemd service..."
sudo tee /etc/systemd/system/cluster-api.service >/dev/null <<EOF
[Unit]
Description=K3s Cluster API Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) server.js
Restart=always
RestartSec=5
Environment=PORT=$API_PORT
Environment=API_TOKEN=$API_TOKEN
Environment=KUBECONFIG=${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable cluster-api
sudo systemctl restart cluster-api
sleep 2

# Verify API is running
if curl -sf "http://localhost:$API_PORT/api/health" >/dev/null 2>&1; then
  echo "  API server running on port $API_PORT"
else
  echo "  WARNING: API server may not have started. Check: sudo journalctl -u cluster-api -f"
fi

# Start Cloudflare tunnel
echo ""
echo "[5/5] Starting Cloudflare tunnel..."
echo ""
echo "================================================"
echo "  COPY THE TUNNEL URL BELOW"
echo "  Paste it into curtbrag.com/cluster API bar"
echo "================================================"
echo ""

cloudflared tunnel --url "http://localhost:$API_PORT"
