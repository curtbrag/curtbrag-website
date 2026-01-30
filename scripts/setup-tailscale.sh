#!/bin/sh
# Setup Tailscale on postmarketOS cluster nodes
# Run on each node: curl -sSL https://curtbrag.com/scripts/setup-tailscale.sh | sh

set -e

log() {
  echo "[$(date '+%H:%M:%S')] $1"
}

NODE_NAME="${1:-$(hostname)}"

log "Setting up Tailscale on $NODE_NAME..."

# Check if running as root
if [ "$(id -u)" != "0" ]; then
  log "ERROR: Run as root (sudo)"
  exit 1
fi

# Install Tailscale on postmarketOS (Alpine-based)
log "Installing Tailscale..."
if ! command -v tailscale >/dev/null 2>&1; then
  # Add community repo if not present
  if ! grep -q "community" /etc/apk/repositories; then
    echo "http://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories
  fi

  apk update
  apk add tailscale
else
  log "Tailscale already installed"
fi

# Enable and start tailscaled
log "Starting Tailscale daemon..."
rc-update add tailscale default 2>/dev/null || true
service tailscale start 2>/dev/null || rc-service tailscale start

# Wait for daemon to be ready
sleep 2

# Check if already authenticated
if tailscale status >/dev/null 2>&1; then
  log "Tailscale already connected:"
  tailscale status
else
  log "Authenticate with Tailscale:"
  echo ""
  echo "Run this command and follow the URL to authenticate:"
  echo ""
  echo "  tailscale up --hostname=$NODE_NAME --accept-routes"
  echo ""
  echo "For headless auth with auth key:"
  echo "  tailscale up --hostname=$NODE_NAME --authkey=tskey-xxx"
  echo ""
fi

log "Done! Tailscale setup complete for $NODE_NAME"
