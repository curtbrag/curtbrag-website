#!/bin/sh
# One-command setup for curtbrag.com cluster dashboard
# Run on node1 (postmarketOS — works with systemd, OpenRC, or bare Alpine)
# Usage: sh setup-node1.sh

set -e

INSTALL_DIR="/home/user"
PUSH_SCRIPT="$INSTALL_DIR/push-cluster-status.sh"
POLL_SCRIPT="$INSTALL_DIR/poll-cluster-commands.sh"
PUSH_LOG="$INSTALL_DIR/cluster-push.log"
POLL_LOG="$INSTALL_DIR/cluster-poll.log"
ENV_FILE="$INSTALL_DIR/.cluster-env"

echo "=== curtbrag.com Cluster Dashboard Setup ==="
echo ""

# ── Detect init system ────────────────────────────────────────────
INIT_SYSTEM="none"
if command -v systemctl >/dev/null 2>&1 && systemctl --version >/dev/null 2>&1; then
  INIT_SYSTEM="systemd"
elif command -v rc-service >/dev/null 2>&1; then
  INIT_SYSTEM="openrc"
fi
echo "Init system: $INIT_SYSTEM"

# Check if crontab works (some Alpine installs have broken suid)
CRON_WORKS="false"
if command -v crond >/dev/null 2>&1; then
  if crontab -l >/dev/null 2>&1 || doas crontab -l -u user >/dev/null 2>&1; then
    CRON_WORKS="true"
  fi
fi

# ── Step 1: Ensure scripts are in place ───────────────────────────
echo "[1/6] Checking scripts..."
if [ -f "$PUSH_SCRIPT" ] && [ -f "$POLL_SCRIPT" ]; then
  chmod +x "$PUSH_SCRIPT" "$POLL_SCRIPT"
  echo "  Found scripts at $INSTALL_DIR"
else
  echo "  Downloading scripts..."
  BRANCH="${BRANCH:-main}"
  BASE_URL="https://raw.githubusercontent.com/curtbrag/curtbrag-website/$BRANCH/scripts"
  for s in push-cluster-status.sh poll-cluster-commands.sh cluster-nodes.conf; do
    curl -sSL -o "$INSTALL_DIR/$s" "$BASE_URL/$s" 2>/dev/null || \
      wget -q -O "$INSTALL_DIR/$s" "$BASE_URL/$s" 2>/dev/null || \
      echo "  WARN: could not download $s"
  done
  chmod +x "$PUSH_SCRIPT" "$POLL_SCRIPT"
  echo "  Downloaded to $INSTALL_DIR"
fi

# ── Step 2: Set up kubeconfig if K3s is installed ─────────────────
echo "[2/6] Setting up kubeconfig..."
if [ -f /etc/rancher/k3s/k3s.yaml ] || doas test -f /etc/rancher/k3s/k3s.yaml 2>/dev/null; then
  mkdir -p "$INSTALL_DIR/.kube"
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

# ── Step 3: Persist environment variables ─────────────────────────
echo "[3/6] Setting up environment..."

# Try to find CLUSTER_API_KEY: env > file > running poller process
if [ -z "${CLUSTER_API_KEY:-}" ] && [ -f "$ENV_FILE" ]; then
  . "$ENV_FILE"
  [ -n "${CLUSTER_API_KEY:-}" ] && echo "  Loaded from $ENV_FILE"
fi
if [ -z "${CLUSTER_API_KEY:-}" ]; then
  # Recover from a running poller that has the key in its env
  POLLER_PID=$(pgrep -f "poll-cluster-commands" 2>/dev/null | head -1 || true)
  if [ -n "$POLLER_PID" ] && [ -r "/proc/$POLLER_PID/environ" ]; then
    RECOVERED_KEY=$(tr '\0' '\n' < "/proc/$POLLER_PID/environ" 2>/dev/null | grep '^CLUSTER_API_KEY=' | cut -d= -f2-)
    if [ -n "$RECOVERED_KEY" ]; then
      export CLUSTER_API_KEY="$RECOVERED_KEY"
      echo "  Recovered API key from running poller (PID $POLLER_PID)"
    fi
  fi
fi

if [ -z "${CLUSTER_API_KEY:-}" ]; then
  # Last resort: fetch via web dashboard password
  echo "  API key not found. Trying to fetch from API..."
  if [ -n "${CLUSTER_WEB_PASSWORD:-}" ]; then
    WEB_PW="$CLUSTER_WEB_PASSWORD"
  else
    printf "  Enter dashboard password (or Ctrl+C to skip): "
    read -r WEB_PW || true
  fi
  if [ -n "${WEB_PW:-}" ]; then
    ENCODED_PW=$(printf '%s' "$WEB_PW" | curl -Gso /dev/null -w '%{url_effective}' --data-urlencode @- '' 2>/dev/null | cut -c3- || printf '%s' "$WEB_PW")
    FETCHED_KEY=$(curl -sf "https://curtbrag.com/.netlify/functions/cluster-control?action=get-api-key&password=$ENCODED_PW" 2>/dev/null | jq -r '.apiKey // empty' 2>/dev/null)
    if [ -n "$FETCHED_KEY" ]; then
      export CLUSTER_API_KEY="$FETCHED_KEY"
      echo "  Retrieved API key from server"
    fi
  fi
fi

if [ -n "${CLUSTER_API_KEY:-}" ]; then
  echo "export CLUSTER_API_KEY=\"$CLUSTER_API_KEY\"" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "  Saved to $ENV_FILE"
else
  echo "  WARNING: CLUSTER_API_KEY not found"
  echo "  Options:"
  echo "    export CLUSTER_API_KEY=your-key && sh setup-node1.sh"
  echo "    CLUSTER_WEB_PASSWORD=your-pw sh setup-node1.sh"
fi

# Ensure .profile sources the env file on login
if ! grep -q "cluster-env" "$INSTALL_DIR/.profile" 2>/dev/null; then
  echo '[ -f ~/.cluster-env ] && . ~/.cluster-env' >> "$INSTALL_DIR/.profile"
  echo "  Added to .profile"
fi

# Bootstrap credentials on Netlify Blobs (one-time setup)
# Without this, push-cluster-status.sh gets 401 and dashboard commands get 503
echo "[3b/6] Bootstrapping Netlify credentials..."
if [ -n "${CLUSTER_API_KEY:-}" ]; then
  CRED_PAYLOAD="{\"action\":\"setup-credentials\",\"apiKey\":\"${CLUSTER_API_KEY}\""
  if [ -n "${CLUSTER_WEB_PASSWORD:-}" ]; then
    CRED_PAYLOAD="${CRED_PAYLOAD},\"webPassword\":\"${CLUSTER_WEB_PASSWORD}\""
  fi
  CRED_PAYLOAD="${CRED_PAYLOAD}}"
  CRED_RESP=$(curl -sf -X POST "https://curtbrag.com/.netlify/functions/cluster-control" \
    -H "Content-Type: application/json" \
    -d "$CRED_PAYLOAD" 2>/dev/null || echo '{}')
  if echo "$CRED_RESP" | grep -q '"success"' 2>/dev/null; then
    echo "  Netlify credentials configured"
  elif echo "$CRED_RESP" | grep -q 'already configured' 2>/dev/null; then
    echo "  Netlify credentials already set"
  else
    echo "  WARNING: Could not set Netlify credentials"
    echo "  Set CLUSTER_API_KEY and CLUSTER_WEB_PASSWORD in Netlify env vars if push fails"
  fi
else
  echo "  Skipping (no CLUSTER_API_KEY available)"
fi

# ── Step 4: Set up status push (every 5 minutes) ─────────────────
echo "[4/6] Setting up status push..."
PUSH_METHOD=""

if [ "$INIT_SYSTEM" = "systemd" ]; then
  doas tee /etc/systemd/system/cluster-push.service > /dev/null << 'SVC'
[Unit]
Description=curtbrag.com Cluster Status Push
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=user
EnvironmentFile=-/home/user/.cluster-env
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
  PUSH_METHOD="systemd timer"

elif [ "$CRON_WORKS" = "true" ]; then
  CRON_LINE="*/5 * * * * . $ENV_FILE; $PUSH_SCRIPT >> $PUSH_LOG 2>&1"
  CRON_FILE="/etc/crontabs/user"
  if doas test -f "$CRON_FILE" 2>/dev/null; then
    doas sed -i '/push-cluster-status/d' "$CRON_FILE"
  fi
  echo "$CRON_LINE" | doas tee -a "$CRON_FILE" > /dev/null
  doas chmod 600 "$CRON_FILE" 2>/dev/null || true
  doas crond 2>/dev/null || true
  PUSH_METHOD="cron"

else
  # Ultimate fallback: run push in a background loop
  # Kill any existing push loop first
  pkill -f "cluster-push-loop" 2>/dev/null || true
  sleep 1

  # Create a named wrapper so we can identify and kill it later
  cat > "$INSTALL_DIR/cluster-push-loop.sh" << 'LOOP'
#!/bin/sh
# Auto-generated push loop (fallback when no cron/systemd available)
[ -f /home/user/.cluster-env ] && . /home/user/.cluster-env
while true; do
  /home/user/push-cluster-status.sh >> /home/user/cluster-push.log 2>&1 || true
  sleep 300
done
LOOP
  chmod +x "$INSTALL_DIR/cluster-push-loop.sh"
  nohup "$INSTALL_DIR/cluster-push-loop.sh" >> "$PUSH_LOG" 2>&1 &
  PUSH_METHOD="background loop (PID: $!)"
fi
echo "  $PUSH_METHOD: every 5 min"

# ── Step 5: Set up command poller (continuous) ────────────────────
echo "[5/6] Setting up command poller..."
POLL_METHOD=""

if [ "$INIT_SYSTEM" = "systemd" ]; then
  doas tee /etc/systemd/system/cluster-poll.service > /dev/null << 'SVC'
[Unit]
Description=curtbrag.com Cluster Command Poller
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=user
EnvironmentFile=-/home/user/.cluster-env
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
  POLL_METHOD="systemd service"

elif [ "$INIT_SYSTEM" = "openrc" ]; then
  doas tee /etc/init.d/cluster-poll > /dev/null << 'SVC'
#!/sbin/openrc-run
name="curtbrag cluster poller"
command="/home/user/poll-cluster-commands.sh"
command_user="user"
command_background="yes"
pidfile="/run/cluster-poll.pid"
output_log="/home/user/cluster-poll.log"
error_log="/home/user/cluster-poll.log"

depend() {
  need net
  after firewall
}

start_pre() {
  . /home/user/.cluster-env 2>/dev/null || true
}
SVC
  doas chmod +x /etc/init.d/cluster-poll
  doas rc-update add cluster-poll default 2>/dev/null || true
  doas rc-service cluster-poll restart 2>/dev/null || true
  POLL_METHOD="OpenRC service"

else
  # Fallback: nohup background process (kill existing first)
  pkill -f "poll-cluster-commands" 2>/dev/null || true
  sleep 1
  (
    [ -f "$ENV_FILE" ] && . "$ENV_FILE"
    exec "$POLL_SCRIPT"
  ) >> "$POLL_LOG" 2>&1 &
  disown 2>/dev/null || true
  POLL_METHOD="background process (PID: $!)"
fi
echo "  $POLL_METHOD"

# ── Step 5b: Boot persistence for background processes ────────────
if [ "$INIT_SYSTEM" = "none" ]; then
  echo "  Setting up boot persistence..."
  # Use /etc/local.d/ if available (Alpine), otherwise /etc/profile.d/
  BOOT_SCRIPT=""
  if [ -d /etc/local.d ] || doas test -d /etc/local.d 2>/dev/null; then
    BOOT_SCRIPT="/etc/local.d/cluster-dashboard.start"
    doas tee "$BOOT_SCRIPT" > /dev/null << BOOT
#!/bin/sh
# Start curtbrag cluster services on boot
su - user -c '
  [ -f /home/user/.cluster-env ] && . /home/user/.cluster-env
  # Start push loop if not running
  if ! pgrep -f "cluster-push-loop" >/dev/null 2>&1; then
    nohup /home/user/cluster-push-loop.sh >> /home/user/cluster-push.log 2>&1 &
  fi
  # Start poller if not running
  if ! pgrep -f "poll-cluster-commands" >/dev/null 2>&1; then
    nohup /home/user/poll-cluster-commands.sh >> /home/user/cluster-poll.log 2>&1 &
  fi
'
BOOT
    doas chmod +x "$BOOT_SCRIPT"
    # Ensure local service is enabled
    doas rc-update add local default 2>/dev/null || true
    echo "  Boot script: $BOOT_SCRIPT"
  else
    # Last resort: add to user's .profile (runs on SSH login)
    MARKER="# cluster-dashboard-autostart"
    if ! grep -q "$MARKER" "$INSTALL_DIR/.profile" 2>/dev/null; then
      cat >> "$INSTALL_DIR/.profile" << 'PROF'
# cluster-dashboard-autostart
if ! pgrep -f "cluster-push-loop" >/dev/null 2>&1; then
  nohup /home/user/cluster-push-loop.sh >> /home/user/cluster-push.log 2>&1 &
fi
if ! pgrep -f "poll-cluster-commands" >/dev/null 2>&1; then
  nohup /home/user/poll-cluster-commands.sh >> /home/user/cluster-poll.log 2>&1 &
fi
PROF
      echo "  Boot: .profile autostart (starts on next login)"
    fi
  fi
fi

# ── Step 6: Run first push immediately ────────────────────────────
echo "[6/6] Pushing first status update now..."
"$PUSH_SCRIPT" || echo "  Warning: First push had errors (will retry in 5 min)"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Init system:    $INIT_SYSTEM"
echo "Status push:    $PUSH_METHOD (every 5 min)"
echo "Command poller: $POLL_METHOD"
echo "Push logs:      $PUSH_LOG"
echo "Poller logs:    $POLL_LOG"
echo "Env file:       $ENV_FILE"
echo ""
echo "Dashboard: https://www.curtbrag.com/cluster"
echo ""
echo "To restart services manually:"
echo "  pkill -f cluster-push-loop; pkill -f poll-cluster-commands"
echo "  sh $INSTALL_DIR/setup-node1.sh"
