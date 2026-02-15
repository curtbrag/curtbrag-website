#!/bin/sh
# One-command fix for curtbrag cluster
# Run on node1: curl -sSL https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts/fix-cluster.sh | sh
# Or: sh fix-cluster.sh

set -e
BRANCH="main"
BASE="https://raw.githubusercontent.com/curtbrag/curtbrag-website/$BRANCH/scripts"
DIR="/home/user"

echo "=== Fixing curtbrag cluster ==="

# Step 1: Download fixed scripts
echo "[1/5] Downloading fixed scripts..."
for s in push-cluster-status.sh poll-cluster-commands.sh; do
  curl -sfL "$BASE/$s" -o "$DIR/$s.new" && chmod +x "$DIR/$s.new" && mv "$DIR/$s.new" "$DIR/$s" && echo "  Updated $s" || echo "  FAILED: $s"
done

# Step 2: Create systemd service for poller (survives reboot)
echo "[2/5] Creating poller service..."
if [ ! -f /etc/systemd/system/cluster-poll.service ]; then
  doas tee /etc/systemd/system/cluster-poll.service > /dev/null << 'SVC'
[Unit]
Description=curtbrag.com Cluster Command Poller
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
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
  echo "  Service created and enabled"
else
  echo "  Service already exists"
fi

# Step 3: Kill old poller, start via service
echo "[3/5] Restarting poller..."
pkill -f "poll-cluster-commands" 2>/dev/null || true
sleep 1
doas systemctl restart cluster-poll
echo "  Poller restarted"

# Step 4: Check xmrig on all nodes
echo "[4/5] Diagnosing xmrig on all nodes..."
for i in $(seq 1 10); do
  NODE_IP="192.168.1.$((205 + i))"
  NODE="node$i"
  if [ "$i" = "1" ]; then
    # Local check
    HAS_BIN="no"; { command -v xmrig >/dev/null 2>&1 || [ -f /usr/local/bin/xmrig ]; } && HAS_BIN="yes"
    HAS_SVC="no"; [ -f /etc/systemd/system/xmrig.service ] && HAS_SVC="yes"
    HAS_CFG="no"; [ -f /etc/xmrig/config.json ] && HAS_CFG="yes"
    IS_RUN="no"; pgrep xmrig >/dev/null 2>&1 && IS_RUN="yes"
    echo "  $NODE: binary=$HAS_BIN service=$HAS_SVC config=$HAS_CFG running=$IS_RUN"
  else
    DIAG=$(ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "user@$NODE_IP" '
      HAS_BIN="no"; { command -v xmrig >/dev/null 2>&1 || [ -f /usr/local/bin/xmrig ]; } && HAS_BIN="yes"
      HAS_SVC="no"; [ -f /etc/systemd/system/xmrig.service ] && HAS_SVC="yes"
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
    doas systemctl start xmrig 2>/dev/null || true
    sleep 1
    if pgrep xmrig >/dev/null 2>&1; then
      STARTED=$((STARTED + 1))
      echo "  $NODE: MINING"
    else
      FAILED=$((FAILED + 1))
      echo "  $NODE: FAILED (check /var/log/xmrig.log)"
    fi
  else
    REMOTE_RESULT=$(ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "user@$NODE_IP" \
      "doas systemctl start xmrig 2>/dev/null; sleep 2; pgrep xmrig >/dev/null 2>&1 && echo MINING || echo FAILED" 2>/dev/null || echo "UNREACHABLE")
    echo "  $NODE: $REMOTE_RESULT"
    case "$REMOTE_RESULT" in
      *MINING*) STARTED=$((STARTED + 1)) ;;
      *) FAILED=$((FAILED + 1)) ;;
    esac
  fi
done

# Push fresh status
echo ""
echo "Pushing fresh status..."
"$DIR/push-cluster-status.sh" 2>/dev/null && echo "Status pushed!" || echo "Status push had errors"

echo ""
echo "=== Done ==="
echo "Dashboard: https://www.curtbrag.com/cluster"
echo ""
echo "If miners show FAILED, run setup-mining.sh to install xmrig:"
echo "  bash scripts/setup-mining.sh --wallet YOUR_XMR_WALLET"
