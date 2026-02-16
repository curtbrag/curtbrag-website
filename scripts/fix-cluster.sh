#!/bin/sh
# One-command fix for curtbrag cluster
# Run on node1: curl -sSL https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts/fix-cluster.sh | sh
# Or: sh fix-cluster.sh
# Works with systemd, OpenRC, or bare Alpine (no init system)

set -e
BRANCH="main"
BASE="https://raw.githubusercontent.com/curtbrag/curtbrag-website/$BRANCH/scripts"
DIR="/home/user"
ENV_FILE="$DIR/.cluster-env"

echo "=== Fixing curtbrag cluster ==="

# Detect init system
INIT_SYSTEM="none"
if command -v systemctl >/dev/null 2>&1 && systemctl --version >/dev/null 2>&1; then
  INIT_SYSTEM="systemd"
elif command -v rc-service >/dev/null 2>&1; then
  INIT_SYSTEM="openrc"
fi
echo "Init system: $INIT_SYSTEM"

# Load environment
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

# Step 1: Download fixed scripts
echo "[1/5] Downloading fixed scripts..."
for s in push-cluster-status.sh poll-cluster-commands.sh cluster-nodes.conf; do
  curl -sfL "$BASE/$s" -o "$DIR/$s.new" && chmod +x "$DIR/$s.new" && mv "$DIR/$s.new" "$DIR/$s" && echo "  Updated $s" || echo "  FAILED: $s"
done

# Step 2: Restart poller (init-system-aware)
echo "[2/5] Restarting poller..."
pkill -f "poll-cluster-commands" 2>/dev/null || true
sleep 1

if [ "$INIT_SYSTEM" = "systemd" ]; then
  if [ ! -f /etc/systemd/system/cluster-poll.service ]; then
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
RestartSec=5
StandardOutput=append:/home/user/cluster-poll.log
StandardError=append:/home/user/cluster-poll.log

[Install]
WantedBy=multi-user.target
SVC
    doas systemctl daemon-reload
    doas systemctl enable cluster-poll 2>/dev/null || true
  fi
  doas systemctl restart cluster-poll
  echo "  Poller restarted (systemd)"
elif [ "$INIT_SYSTEM" = "openrc" ]; then
  doas rc-service cluster-poll restart 2>/dev/null || {
    # Service might not exist yet — start manually
    nohup "$DIR/poll-cluster-commands.sh" >> "$DIR/cluster-poll.log" 2>&1 &
  }
  echo "  Poller restarted (openrc)"
else
  # No init system — use nohup
  (
    [ -f "$ENV_FILE" ] && . "$ENV_FILE"
    exec "$DIR/poll-cluster-commands.sh"
  ) >> "$DIR/cluster-poll.log" 2>&1 &
  disown 2>/dev/null || true
  echo "  Poller restarted (nohup, PID: $!)"
fi

# Step 3: Restart push loop
echo "[3/5] Restarting push schedule..."
pkill -f "cluster-push-loop" 2>/dev/null || true

if [ "$INIT_SYSTEM" = "systemd" ]; then
  doas systemctl restart cluster-push.timer 2>/dev/null || true
  echo "  Push timer restarted (systemd)"
else
  # Create/update the push loop wrapper
  cat > "$DIR/cluster-push-loop.sh" << 'LOOP'
#!/bin/sh
[ -f /home/user/.cluster-env ] && . /home/user/.cluster-env
while true; do
  /home/user/push-cluster-status.sh >> /home/user/cluster-push.log 2>&1 || true
  sleep 300
done
LOOP
  chmod +x "$DIR/cluster-push-loop.sh"
  nohup "$DIR/cluster-push-loop.sh" >> "$DIR/cluster-push.log" 2>&1 &
  echo "  Push loop started (PID: $!)"
fi

# Step 4: Check xmrig on all nodes
echo "[4/5] Diagnosing xmrig on all nodes..."
# Start xmrig command that works across init systems
START_XMRIG_CMD='doas rc-service xmrig start 2>/dev/null || doas systemctl start xmrig 2>/dev/null || true'
for i in $(seq 1 10); do
  NODE_IP="192.168.1.$((205 + i))"
  NODE="node$i"
  if [ "$i" = "1" ]; then
    HAS_BIN="no"; { command -v xmrig >/dev/null 2>&1 || [ -f /usr/local/bin/xmrig ]; } && HAS_BIN="yes"
    HAS_SVC="no"; { [ -f /etc/init.d/xmrig ] || [ -f /etc/systemd/system/xmrig.service ]; } && HAS_SVC="yes"
    HAS_CFG="no"; [ -f /etc/xmrig/config.json ] && HAS_CFG="yes"
    IS_RUN="no"; pgrep xmrig >/dev/null 2>&1 && IS_RUN="yes"
    echo "  $NODE: binary=$HAS_BIN service=$HAS_SVC config=$HAS_CFG running=$IS_RUN"
  else
    DIAG=$(ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "user@$NODE_IP" '
      HAS_BIN="no"; { command -v xmrig >/dev/null 2>&1 || [ -f /usr/local/bin/xmrig ]; } && HAS_BIN="yes"
      HAS_SVC="no"; { [ -f /etc/init.d/xmrig ] || [ -f /etc/systemd/system/xmrig.service ]; } && HAS_SVC="yes"
      HAS_CFG="no"; [ -f /etc/xmrig/config.json ] && HAS_CFG="yes"
      IS_RUN="no"; pgrep xmrig >/dev/null 2>&1 && IS_RUN="yes"
      echo "binary=$HAS_BIN service=$HAS_SVC config=$HAS_CFG running=$IS_RUN"
    ' 2>/dev/null || echo "UNREACHABLE")
    echo "  $NODE: $DIAG"
  fi
done

# Step 5: Start mining on all nodes
echo "[5/5] Starting mining on all nodes..."
STARTED=0
FAILED=0
for i in $(seq 1 10); do
  NODE_IP="192.168.1.$((205 + i))"
  NODE="node$i"
  if [ "$i" = "1" ]; then
    eval "$START_XMRIG_CMD"
    sleep 1
    if pgrep xmrig >/dev/null 2>&1; then
      STARTED=$((STARTED + 1))
      echo "  $NODE: MINING"
    else
      FAILED=$((FAILED + 1))
      echo "  $NODE: FAILED"
    fi
  else
    REMOTE_RESULT=$(ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "user@$NODE_IP" \
      "$START_XMRIG_CMD; sleep 2; pgrep xmrig >/dev/null 2>&1 && echo MINING || echo FAILED" 2>/dev/null || echo "UNREACHABLE")
    echo "  $NODE: $REMOTE_RESULT"
    case "$REMOTE_RESULT" in
      *MINING*) STARTED=$((STARTED + 1)) ;;
      *) FAILED=$((FAILED + 1)) ;;
    esac
  fi
done

echo ""
echo "Mining: $STARTED running, $FAILED failed"

# Push fresh status
echo ""
echo "Pushing fresh status..."
"$DIR/push-cluster-status.sh" 2>/dev/null && echo "Status pushed!" || echo "Status push had errors"

# Verify services are running
echo ""
echo "=== Service Status ==="
POLL_PID=$(pgrep -f "poll-cluster-commands" 2>/dev/null | head -1 || echo "NOT RUNNING")
PUSH_PID=$(pgrep -f "cluster-push-loop" 2>/dev/null | head -1 || echo "NOT RUNNING")
echo "Poller PID:    $POLL_PID"
echo "Push loop PID: $PUSH_PID"

echo ""
echo "=== Done ==="
echo "Dashboard: https://www.curtbrag.com/cluster"
echo ""
echo "If miners show FAILED, run setup-mining.sh to install xmrig:"
echo "  bash scripts/setup-mining.sh --wallet YOUR_XMR_WALLET"
