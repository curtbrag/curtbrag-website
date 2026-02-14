#!/bin/sh
# One-command fix for curtbrag cluster
# Run on node1: curl -sSL https://raw.githubusercontent.com/curtbrag/curtbrag-website/claude/cluster-capabilities-review-CNtba/scripts/fix-cluster.sh | sh
# Or: sh fix-cluster.sh

set -e
BRANCH="claude/cluster-capabilities-review-CNtba"
BASE="https://raw.githubusercontent.com/curtbrag/curtbrag-website/$BRANCH/scripts"
DIR="/home/user"

echo "=== Fixing curtbrag cluster ==="

# Step 1: Download fixed scripts
echo "[1/5] Downloading fixed scripts..."
for s in push-cluster-status.sh poll-cluster-commands.sh; do
  curl -sfL "$BASE/$s" -o "$DIR/$s.new" && chmod +x "$DIR/$s.new" && mv "$DIR/$s.new" "$DIR/$s" && echo "  Updated $s" || echo "  FAILED: $s"
done

# Step 2: Create OpenRC service for poller (survives reboot)
echo "[2/5] Creating poller service..."
if [ ! -f /etc/init.d/cluster-poll ]; then
  doas tee /etc/init.d/cluster-poll > /dev/null << 'SVC'
#!/sbin/openrc-run
name="cluster-poll"
description="curtbrag.com Cluster Command Poller"
command="/home/user/poll-cluster-commands.sh"
command_background=true
pidfile="/run/cluster-poll.pid"
output_log="/home/user/cluster-poll.log"
error_log="/home/user/cluster-poll.log"

depend() {
  need net
  after firewall
}
SVC
  doas chmod +x /etc/init.d/cluster-poll
  doas rc-update add cluster-poll default 2>/dev/null || true
  echo "  Service created and enabled"
else
  echo "  Service already exists"
fi

# Step 3: Kill old poller, start via service
echo "[3/5] Restarting poller..."
pkill -f "poll-cluster-commands" 2>/dev/null || true
sleep 1
doas rc-service cluster-poll restart 2>/dev/null || doas rc-service cluster-poll start
echo "  Poller restarted"

# Step 4: Check xmrig on all nodes
echo "[4/5] Diagnosing xmrig on all nodes..."
for i in $(seq 1 10); do
  NODE_IP="192.168.1.$((205 + i))"
  NODE="node$i"
  if [ "$i" = "1" ]; then
    # Local check
    HAS_BIN="no"; command -v xmrig >/dev/null 2>&1 || [ -f /usr/local/bin/xmrig ] && HAS_BIN="yes"
    HAS_SVC="no"; [ -f /etc/init.d/xmrig ] && HAS_SVC="yes"
    HAS_CFG="no"; [ -f /etc/xmrig/config.json ] && HAS_CFG="yes"
    IS_RUN="no"; pgrep -x xmrig >/dev/null 2>&1 && IS_RUN="yes"
    echo "  $NODE: binary=$HAS_BIN service=$HAS_SVC config=$HAS_CFG running=$IS_RUN"
  else
    DIAG=$(ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o BatchMode=yes "user@$NODE_IP" '
      HAS_BIN="no"; command -v xmrig >/dev/null 2>&1 || [ -f /usr/local/bin/xmrig ] && HAS_BIN="yes"
      HAS_SVC="no"; [ -f /etc/init.d/xmrig ] && HAS_SVC="yes"
      HAS_CFG="no"; [ -f /etc/xmrig/config.json ] && HAS_CFG="yes"
      IS_RUN="no"; pgrep -x xmrig >/dev/null 2>&1 && IS_RUN="yes"
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
    doas rc-service xmrig start 2>/dev/null || true
    sleep 1
    if pgrep -x xmrig >/dev/null 2>&1; then
      STARTED=$((STARTED + 1))
      echo "  $NODE: MINING"
    else
      FAILED=$((FAILED + 1))
      echo "  $NODE: FAILED (check /var/log/xmrig.log)"
    fi
  else
    ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o BatchMode=yes "user@$NODE_IP" \
      "doas rc-service xmrig start 2>/dev/null; sleep 2; pgrep -x xmrig >/dev/null 2>&1 && echo MINING || echo FAILED" 2>/dev/null | while read line; do
      echo "  $NODE: $line"
    done
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
