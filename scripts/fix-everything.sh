#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════════╗
# ║  CurtBrag Cluster Recovery — Fix Everything                        ║
# ║  Run from node1 (or any machine with SSH+Tailscale to the phones)  ║
# ║    bash scripts/fix-everything.sh                                  ║
# ║                                                                     ║
# ║  What it does:                                                      ║
# ║    1. Discovers reachable phones (local WiFi + Tailscale fallback) ║
# ║    2. Updates cluster-nodes.conf with correct IPs if needed        ║
# ║    3. Restarts K3s on all reachable nodes                          ║
# ║    4. Starts xmrig mining on all reachable nodes                   ║
# ║    5. Restarts the command poller on node1                         ║
# ║    6. Pushes fresh status to curtbrag.com                          ║
# ╚══════════════════════════════════════════════════════════════════════╝

set -u

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_PORT="${SSH_PORT:-22}"
SSH_OPTS="-o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes"

# Known local IPs (may be stale)
declare -A LOCAL_IPS=(
  [node1]="192.168.1.206" [node2]="192.168.1.207" [node3]="192.168.1.208"
  [node4]="192.168.1.209" [node5]="192.168.1.210" [node6]="192.168.1.211"
  [node7]="192.168.1.212" [node8]="192.168.1.213" [node9]="192.168.1.214"
  [node10]="192.168.1.215"
)

# Tailscale hostnames (always work if Tailscale is up)
declare -A TS_NAMES=(
  [node1]="k3s-node1" [node2]="phone-node2" [node3]="phone-node3"
  [node4]="phone-node4" [node5]="phone-node5" [node6]="phone-node6"
  [node7]="phone-node7" [node8]="phone-node8" [node9]="phone-node9"
  [node10]="phone-node10"
)

# Will be populated with the working IP/hostname for each node
declare -A REACHABLE=()
declare -A REAL_WIFI_IPS=()

banner() { echo -e "\n${CYAN}═══ $1 ═══${NC}"; }
ok()     { echo -e "  ${GREEN}✓${NC} $1"; }
warn()   { echo -e "  ${YELLOW}!${NC} $1"; }
fail()   { echo -e "  ${RED}✗${NC} $1"; }

# ── Step 0: Detect if we're on node1 ─────────────────────────────────

AM_NODE1=false
MY_IP=$(ip -4 addr show wlan0 2>/dev/null | grep -o 'inet [0-9.]*' | cut -d' ' -f2)
[ -z "$MY_IP" ] && MY_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ "$MY_IP" = "192.168.1.206" ] || [ "$(hostname)" = "node1" ] || [ "$(hostname)" = "k3s-node1" ]; then
  AM_NODE1=true
fi

echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   CurtBrag Cluster Recovery                  ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
echo -e "  Running from: $(hostname) ($MY_IP)"
echo -e "  Node1 mode: $AM_NODE1"

# ── Step 1: Discover reachable phones ─────────────────────────────────

banner "STEP 1: Discovering reachable phones"

TOTAL_REACHED=0

for i in $(seq 1 10); do
  NODE="node$i"
  LOCAL_IP="${LOCAL_IPS[$NODE]}"
  TS_NAME="${TS_NAMES[$NODE]}"
  REACHED=false

  # Skip SSH for node1 if we ARE node1
  if [ "$i" = "1" ] && [ "$AM_NODE1" = "true" ]; then
    ok "$NODE — local (this machine)"
    REACHABLE[$NODE]="local"
    REAL_WIFI_IPS[$NODE]="$MY_IP"
    TOTAL_REACHED=$((TOTAL_REACHED + 1))
    continue
  fi

  # Try local WiFi IP first (faster)
  if ssh -p "$SSH_PORT" $SSH_OPTS "user@$LOCAL_IP" "echo ok" >/dev/null 2>&1; then
    ok "$NODE — reachable via WiFi ($LOCAL_IP)"
    REACHABLE[$NODE]="$LOCAL_IP"
    REAL_WIFI_IPS[$NODE]="$LOCAL_IP"
    TOTAL_REACHED=$((TOTAL_REACHED + 1))
    REACHED=true
  fi

  # If local IP failed, try Tailscale
  if [ "$REACHED" = "false" ]; then
    if ssh -p "$SSH_PORT" $SSH_OPTS "user@$TS_NAME" "echo ok" >/dev/null 2>&1; then
      # Get the phone's real WiFi IP via Tailscale
      WIFI_IP=$(ssh -p "$SSH_PORT" $SSH_OPTS "user@$TS_NAME" \
        "ip -4 addr show wlan0 2>/dev/null | grep -o 'inet [0-9.]*' | cut -d' ' -f2" 2>/dev/null)
      warn "$NODE — WiFi IP unreachable ($LOCAL_IP), reached via Tailscale ($TS_NAME)"
      [ -n "$WIFI_IP" ] && warn "  Real WiFi IP is: $WIFI_IP" && REAL_WIFI_IPS[$NODE]="$WIFI_IP"
      REACHABLE[$NODE]="$TS_NAME"
      TOTAL_REACHED=$((TOTAL_REACHED + 1))
    else
      fail "$NODE — UNREACHABLE (tried $LOCAL_IP and $TS_NAME)"
    fi
  fi
done

echo ""
echo -e "  Reached: ${GREEN}${TOTAL_REACHED}/10${NC} phones"

if [ "$TOTAL_REACHED" -eq 0 ]; then
  echo -e "\n${RED}No phones reachable. Check WiFi and Tailscale.${NC}"
  exit 1
fi

# ── Step 2: Update cluster-nodes.conf if IPs changed ─────────────────

banner "STEP 2: Checking if IPs need updating"

CONF_FILE="$SCRIPT_DIR/cluster-nodes.conf"
IPS_CHANGED=false

if [ -f "$CONF_FILE" ]; then
  for i in $(seq 1 10); do
    NODE="node$i"
    OLD_IP="${LOCAL_IPS[$NODE]}"
    NEW_IP="${REAL_WIFI_IPS[$NODE]:-}"
    if [ -n "$NEW_IP" ] && [ "$NEW_IP" != "$OLD_IP" ]; then
      warn "$NODE IP changed: $OLD_IP → $NEW_IP"
      IPS_CHANGED=true
    fi
  done

  if [ "$IPS_CHANGED" = "true" ]; then
    # Build new PHONE_NODE_LIST
    NEW_LIST=""
    for i in $(seq 1 10); do
      NODE="node$i"
      IP="${REAL_WIFI_IPS[$NODE]:-${LOCAL_IPS[$NODE]}}"
      ROLE="worker"
      [ "$i" = "1" ] && ROLE="control-plane"
      NEW_LIST="${NEW_LIST:+$NEW_LIST }${NODE}:${IP}:${ROLE}"
    done
    # Update the config file
    sed -i "s|^PHONE_NODE_LIST=.*|PHONE_NODE_LIST=\"$NEW_LIST\"|" "$CONF_FILE"
    ok "Updated cluster-nodes.conf with new IPs"
  else
    ok "All IPs match — no update needed"
  fi
else
  warn "cluster-nodes.conf not found at $CONF_FILE"
fi

# ── Helper: run command on a node ─────────────────────────────────────

run_on() {
  local node="$1"
  local cmd="$2"
  local target="${REACHABLE[$node]:-}"

  if [ -z "$target" ]; then
    return 1
  elif [ "$target" = "local" ]; then
    sh -c "$cmd" 2>&1
  else
    ssh -p "$SSH_PORT" $SSH_OPTS "user@$target" "$cmd" 2>&1
  fi
}

# ── Step 3: Restart K3s ──────────────────────────────────────────────

banner "STEP 3: Restarting K3s on all reachable nodes"

for i in $(seq 1 10); do
  NODE="node$i"
  [ -z "${REACHABLE[$NODE]:-}" ] && continue

  if [ "$i" = "1" ]; then
    K3S_SVC="k3s"
  else
    K3S_SVC="k3s-agent"
  fi

  # Try systemd first, then openrc
  RESULT=$(run_on "$NODE" "
    if command -v systemctl >/dev/null 2>&1; then
      doas systemctl restart $K3S_SVC 2>&1 && echo K3S_OK || echo K3S_FAIL
    elif command -v rc-service >/dev/null 2>&1; then
      doas rc-service $K3S_SVC restart 2>&1 && echo K3S_OK || echo K3S_FAIL
    else
      echo K3S_NOINIT
    fi
  " 2>&1)

  if echo "$RESULT" | grep -q "K3S_OK"; then
    ok "$NODE — $K3S_SVC restarted"
  elif echo "$RESULT" | grep -q "K3S_NOINIT"; then
    warn "$NODE — no init system found, skipping K3s"
  else
    fail "$NODE — $K3S_SVC failed to restart"
    echo "    $RESULT" | head -3
  fi
done

# Give K3s a moment to initialize
echo -e "\n  Waiting 10s for K3s to initialize..."
sleep 10

# Verify K3s on node1
if [ "$AM_NODE1" = "true" ]; then
  if command -v kubectl >/dev/null 2>&1 && timeout 10 kubectl get nodes >/dev/null 2>&1; then
    ok "K3s cluster is up!"
    kubectl get nodes 2>/dev/null | while read -r line; do echo "    $line"; done
  else
    warn "K3s not responding yet — may need more time"
  fi
fi

# ── Step 4: Start mining on all reachable nodes ──────────────────────

banner "STEP 4: Starting xmrig mining on all reachable nodes"

for i in $(seq 1 10); do
  NODE="node$i"
  [ -z "${REACHABLE[$NODE]:-}" ] && continue

  RESULT=$(run_on "$NODE" "
    # Check if already mining
    if pgrep xmrig >/dev/null 2>&1; then
      echo ALREADY_MINING
      exit 0
    fi
    # Check if xmrig is installed
    if ! command -v xmrig >/dev/null 2>&1 && [ ! -x /usr/local/bin/xmrig ]; then
      echo NO_XMRIG
      exit 1
    fi
    # Start via systemd or openrc
    if command -v systemctl >/dev/null 2>&1; then
      doas systemctl start xmrig 2>&1
    elif command -v rc-service >/dev/null 2>&1; then
      doas rc-service xmrig start 2>&1
    fi
    sleep 2
    if pgrep xmrig >/dev/null 2>&1; then
      echo MINING_STARTED
    else
      echo MINING_FAILED
    fi
  " 2>&1)

  if echo "$RESULT" | grep -q "ALREADY_MINING"; then
    ok "$NODE — already mining"
  elif echo "$RESULT" | grep -q "MINING_STARTED"; then
    ok "$NODE — xmrig started"
  elif echo "$RESULT" | grep -q "NO_XMRIG"; then
    fail "$NODE — xmrig not installed"
  else
    fail "$NODE — failed to start mining"
    echo "    $RESULT" | tail -3
  fi
done

# ── Step 5: Restart the command poller on node1 ──────────────────────

banner "STEP 5: Restarting command poller"

POLLER_SCRIPT="/home/user/poll-cluster-commands.sh"
# Also check the repo copy
[ ! -f "$POLLER_SCRIPT" ] && POLLER_SCRIPT="$SCRIPT_DIR/poll-cluster-commands.sh"

if [ "$AM_NODE1" = "true" ]; then
  # Kill existing poller
  EXISTING=$(pgrep -f "poll-cluster-commands" || true)
  if [ -n "$EXISTING" ]; then
    kill $EXISTING 2>/dev/null || true
    sleep 1
    warn "Killed old poller (PID: $EXISTING)"
  fi

  # Check if running as systemd service
  if systemctl is-active cluster-poller >/dev/null 2>&1; then
    doas systemctl restart cluster-poller 2>&1
    ok "Restarted cluster-poller systemd service"
  elif [ -f "$POLLER_SCRIPT" ]; then
    nohup "$POLLER_SCRIPT" >> /home/user/cluster-poll.log 2>&1 &
    NEWPID=$!
    sleep 2
    if kill -0 $NEWPID 2>/dev/null; then
      ok "Poller started (PID: $NEWPID)"
    else
      fail "Poller exited immediately — check /home/user/cluster-poll.log"
    fi
  else
    fail "Poller script not found at $POLLER_SCRIPT"
  fi
else
  # We're not on node1 — try to restart it remotely
  if [ -n "${REACHABLE[node1]:-}" ]; then
    run_on "node1" "
      pkill -f poll-cluster-commands 2>/dev/null; sleep 1
      if [ -f /home/user/poll-cluster-commands.sh ]; then
        nohup /home/user/poll-cluster-commands.sh >> /home/user/cluster-poll.log 2>&1 &
        echo POLLER_STARTED
      elif [ -f $SCRIPT_DIR/poll-cluster-commands.sh ]; then
        nohup $SCRIPT_DIR/poll-cluster-commands.sh >> /home/user/cluster-poll.log 2>&1 &
        echo POLLER_STARTED
      else
        echo POLLER_NOT_FOUND
      fi
    "
  else
    fail "Can't restart poller — node1 not reachable"
  fi
fi

# ── Step 6: Push fresh status ─────────────────────────────────────────

banner "STEP 6: Pushing fresh cluster status"

PUSH_SCRIPT="/home/user/push-cluster-status.sh"
[ ! -f "$PUSH_SCRIPT" ] && PUSH_SCRIPT="$SCRIPT_DIR/push-cluster-status.sh"

if [ "$AM_NODE1" = "true" ] && [ -f "$PUSH_SCRIPT" ]; then
  "$PUSH_SCRIPT" 2>&1 | tail -5
  ok "Status pushed to curtbrag.com"
elif [ -n "${REACHABLE[node1]:-}" ]; then
  run_on "node1" "
    if [ -f /home/user/push-cluster-status.sh ]; then
      /home/user/push-cluster-status.sh 2>&1 | tail -5
    fi
  "
  ok "Status push triggered on node1"
else
  warn "Can't push status — not on node1 and node1 unreachable"
fi

# ── Summary ──────────────────────────────────────────────────────────

banner "RECOVERY COMPLETE"
echo ""
echo -e "  Phones reached:  ${GREEN}${TOTAL_REACHED}/10${NC}"
echo -e "  IPs updated:     $([ "$IPS_CHANGED" = "true" ] && echo -e "${YELLOW}YES${NC}" || echo -e "${GREEN}no change needed${NC}")"
echo ""
echo -e "  ${CYAN}Dashboard:${NC} https://curtbrag.com/cluster"
echo -e "  ${CYAN}Status API:${NC} https://curtbrag.com/.netlify/functions/cluster-status"
echo ""
echo -e "  If phones are still unreachable, check:"
echo -e "    - WiFi connected to DontTouch?"
echo -e "    - Phone screens on? (press power button)"
echo -e "    - Router DHCP reservations set for .206-.215?"
echo ""
