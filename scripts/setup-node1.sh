#!/bin/sh
# One-command setup for curtbrag.com cluster dashboard
# Run on node1 (postmarketOS with systemd)
# Usage: sh setup-node1.sh

set -e

INSTALL_DIR="/home/user"

echo "=== curtbrag.com Cluster Dashboard Setup ==="
echo ""

# Step 1: Ensure scripts are in place
echo "[1/5] Checking scripts..."
if [ -f "$INSTALL_DIR/push-cluster-status.sh" ] && [ -f "$INSTALL_DIR/poll-cluster-commands.sh" ]; then
  chmod +x "$INSTALL_DIR/push-cluster-status.sh"
  chmod +x "$INSTALL_DIR/poll-cluster-commands.sh"
  echo "  Found scripts at $INSTALL_DIR"
else
  echo "  Downloading scripts..."
  BRANCH="${BRANCH:-main}"
  BASE_URL="https://raw.githubusercontent.com/curtbrag/curtbrag-website/$BRANCH/scripts"
  curl -sSL -o "$INSTALL_DIR/push-cluster-status.sh" "$BASE_URL/push-cluster-status.sh" || \
    wget -q -O "$INSTALL_DIR/push-cluster-status.sh" "$BASE_URL/push-cluster-status.sh"
  curl -sSL -o "$INSTALL_DIR/poll-cluster-commands.sh" "$BASE_URL/poll-cluster-commands.sh" || \
    wget -q -O "$INSTALL_DIR/poll-cluster-commands.sh" "$BASE_URL/poll-cluster-commands.sh"
  chmod +x "$INSTALL_DIR/push-cluster-status.sh"
  chmod +x "$INSTALL_DIR/poll-cluster-commands.sh"
  echo "  Downloaded to $INSTALL_DIR"
fi

# Step 2: Set up kubeconfig if K3s is installed
echo "[2/5] Setting up kubeconfig..."
if [ -f /etc/rancher/k3s/k3s.yaml ] || doas test -f /etc/rancher/k3s/k3s.yaml 2>/dev/null; then
  mkdir -p "$INSTALL_DIR/.kube"
  # Get K3s server IP from config (replace 127.0.0.1 with actual server)
  K3S_SERVER_IP=$(doas cat /etc/rancher/k3s/config.yaml 2>/dev/null | grep "^server:" | grep -o '[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*' || echo "")
  if [ -n "$K3S_SERVER_IP" ] && [ "$K3S_SERVER_IP" != "127.0.0.1" ]; then
    doas cat /etc/rancher/k3s/k3s.yaml | sed "s/127.0.0.1/$K3S_SERVER_IP/" > "$INSTALL_DIR/.kube/config"
    echo "  Kubeconfig set (server: $K3S_SERVER_IP)"
  else
    doas cat /etc/rancher/k3s/k3s.yaml > "$INSTALL_DIR/.kube/config"
    echo "  Kubeconfig set (localhost)"
  fi
  chmod 600 "$INSTALL_DIR/.kube/config"
else
  echo "  No K3s config found, skipping"
fi

# Step 3: Set up cron job for status push (every 5 minutes)
echo "[3/5] Setting up cron job for status push..."
CRON_LINE="*/5 * * * * $INSTALL_DIR/push-cluster-status.sh >> $INSTALL_DIR/cluster-push.log 2>&1"
# Try systemd timer first, fall back to crontab methods
if command -v systemctl >/dev/null 2>&1; then
  # Use systemd timer instead of cron
  doas tee /etc/systemd/system/cluster-push.service > /dev/null << 'SVC'
[Unit]
Description=curtbrag.com Cluster Status Push
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=user
ExecStart=/home/user/push-cluster-status.sh
StandardOutput=append:/home/user/cluster-push.log
StandardError=append:/home/user/cluster-push.log
SVC

  doas tee /etc/systemd/system/cluster-push.timer > /dev/null << 'TMR'
[Unit]
Description=Push cluster status every 5 minutes

[Timer]
OnBootSec=60
OnUnitActiveSec=300
AccuracySec=30

[Install]
WantedBy=timers.target
TMR

  doas systemctl daemon-reload
  doas systemctl enable cluster-push.timer
  doas systemctl start cluster-push.timer
  echo "  Systemd timer: every 5 min"
else
  # Fallback: write directly to cron file
  CRON_FILE="/etc/crontabs/user"
  if doas test -f "$CRON_FILE" 2>/dev/null; then
    doas sed -i '/push-cluster-status/d' "$CRON_FILE"
  fi
  echo "$CRON_LINE" | doas tee -a "$CRON_FILE" > /dev/null
  doas chmod 600 "$CRON_FILE" 2>/dev/null || true
  doas crond 2>/dev/null || true
  echo "  Cron: every 5 min"
fi

# Step 4: Create service for command poller
echo "[4/5] Creating service for command poller..."
if command -v systemctl >/dev/null 2>&1; then
  doas tee /etc/systemd/system/cluster-poll.service > /dev/null << 'SVC'
[Unit]
Description=curtbrag.com Cluster Command Poller
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=user
ExecStart=/home/user/poll-cluster-commands.sh
Restart=always
RestartSec=10
StandardOutput=append:/home/user/cluster-poll.log
StandardError=append:/home/user/cluster-poll.log

[Install]
WantedBy=multi-user.target
SVC

  doas systemctl daemon-reload
  doas systemctl enable cluster-poll
  doas systemctl restart cluster-poll
  echo "  Systemd service: cluster-poll (enabled + started)"
else
  # Fallback: nohup background process
  nohup "$INSTALL_DIR/poll-cluster-commands.sh" >> "$INSTALL_DIR/cluster-poll.log" 2>&1 &
  echo "  Background process started (PID: $!)"
fi

# Step 5: Run first push immediately
echo "[5/5] Pushing first status update now..."
"$INSTALL_DIR/push-cluster-status.sh" || echo "  Warning: First push had errors (will retry in 5 min)"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Status push:    every 5 min"
echo "Command poller: running as service"
echo "Push logs:      $INSTALL_DIR/cluster-push.log"
echo "Poller logs:    $INSTALL_DIR/cluster-poll.log"
echo ""
echo "Dashboard: https://www.curtbrag.com/cluster"
