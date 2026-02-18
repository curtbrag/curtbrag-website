#!/bin/sh
# Enable xmrig HTTP API on all cluster nodes
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

log() { echo "[$(date '+%H:%M:%S')] $1"; }

# jq command to enable the HTTP API in xmrig config
ENABLE_CMD='
CONFIG="/etc/xmrig/config.json"
if [ ! -f "$CONFIG" ]; then
  echo "SKIP: no config found"
  exit 0
fi

# Check if http API is already enabled
CURRENT=$(cat "$CONFIG" | jq -r ".http.enabled // false" 2>/dev/null)
if [ "$CURRENT" = "true" ]; then
  echo "OK: already enabled"
  exit 0
fi

# Enable http API (bind to localhost only)
doas cp "$CONFIG" "${CONFIG}.bak"
doas sh -c "jq '"'"'.http = {"enabled":true,"host":"127.0.0.1","port":18080,"access-token":null,"restricted":true}'"'"' \"${CONFIG}.bak\" > \"$CONFIG\""

# Restart xmrig
doas pkill xmrig 2>/dev/null; sleep 2
if [ -f /etc/init.d/xmrig ]; then
  doas rc-service xmrig restart 2>/dev/null
elif command -v systemctl >/dev/null 2>&1; then
  doas systemctl restart xmrig 2>/dev/null
else
  doas /usr/bin/xmrig -c "$CONFIG" -B 2>/dev/null
fi
sleep 1

# Verify
if curl -s --connect-timeout 3 http://127.0.0.1:18080/1/summary | jq .hashrate.total[0] >/dev/null 2>&1; then
  echo "OK: API enabled and responding"
else
  echo "WARN: API enabled but not yet responding (may need a moment)"
fi
'

log "Enabling xmrig HTTP API on all nodes..."

for entry in $NODE_LIST; do
  name="${entry%%:*}"
  rest="${entry#*:}"
  ip="${rest%%:*}"

  if [ "$name" = "node1" ]; then
    log "$name ($ip): running locally..."
    RESULT=$(sh -c "$ENABLE_CMD" 2>&1)
  else
    log "$name ($ip): running via SSH..."
    RESULT=$(ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
      "user@$ip" "$ENABLE_CMD" 2>&1)
  fi
  log "  $name: $RESULT"
done

log "Done! Hashrates should appear on next dashboard push (within 5 min)."
