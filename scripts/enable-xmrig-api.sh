#!/bin/sh
# Enable xmrig HTTP API on all cluster nodes (no jq required)
# Run on node1: sh /home/user/enable-xmrig-api.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/cluster-nodes.conf" ]; then
  . "$SCRIPT_DIR/cluster-nodes.conf"
  load_node_config
elif [ -f /home/user/cluster-nodes.conf ]; then
  . /home/user/cluster-nodes.conf
  load_node_config
fi

SSH_PORT="${SSH_PORT:-22}"

log() { echo "[$(date '+%H:%M:%S')] $1"; }

# Uses sed only — no jq needed on worker nodes
ENABLE_CMD='
CONFIG="/etc/xmrig/config.json"
if [ ! -f "$CONFIG" ]; then
  echo "SKIP: no config found"
  exit 0
fi

# Check if http API is already enabled
if grep -q "\"http\"" "$CONFIG" && grep -q "\"enabled\": *true" "$CONFIG"; then
  # Verify it responds
  if curl -s --connect-timeout 2 http://127.0.0.1:18080/1/summary >/dev/null 2>&1; then
    echo "OK: already enabled and responding"
    exit 0
  fi
fi

doas cp "$CONFIG" "${CONFIG}.bak"

if grep -q "\"http\"" "$CONFIG"; then
  # http block exists — flip enabled to true
  doas sed -i "s/\"enabled\": *false/\"enabled\": true/" "$CONFIG"
  echo "Toggled enabled: false -> true"
else
  # No http block — inject one before the final closing brace
  doas sed -i "s/^}$/,\"http\":{\"enabled\":true,\"host\":\"127.0.0.1\",\"port\":18080,\"access-token\":null,\"restricted\":true}\n}/" "$CONFIG"
  echo "Injected http block"
fi

# Restart xmrig
doas pkill xmrig 2>/dev/null
sleep 2
if [ -f /etc/init.d/xmrig ]; then
  doas rc-service xmrig restart 2>/dev/null
elif command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files xmrig.service >/dev/null 2>&1; then
  doas systemctl restart xmrig 2>/dev/null
else
  doas /usr/bin/xmrig -c "$CONFIG" -B 2>/dev/null
fi
sleep 2

# Verify
if curl -s --connect-timeout 3 http://127.0.0.1:18080/1/summary 2>/dev/null | grep -q hashrate; then
  echo "OK: API enabled and responding"
else
  echo "WARN: restarted, API may need a moment to come up"
fi
'

log "Enabling xmrig HTTP API on all nodes..."

FAILED=""
for entry in $NODE_LIST; do
  name="${entry%%:*}"
  rest="${entry#*:}"
  ip="${rest%%:*}"

  if [ "$name" = "node1" ]; then
    log "$name ($ip): running locally..."
    RESULT=$(sh -c "$ENABLE_CMD" 2>&1)
  else
    log "$name ($ip): running via SSH..."
    RESULT=$(ssh -p "$SSH_PORT" -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
      "user@$ip" "$ENABLE_CMD" 2>&1)
  fi
  log "  $name: $RESULT"
  echo "$RESULT" | grep -qi "timeout\|refused\|No route" && FAILED="$FAILED $name"
done

if [ -n "$FAILED" ]; then
  log "Unreachable nodes:$FAILED (check if powered on / on WiFi)"
fi
log "Done! Hashrates should appear on next dashboard push (within 5 min)."
