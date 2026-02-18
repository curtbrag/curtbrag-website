#!/bin/bash
# ONE COMMAND TO RULE THEM ALL
# Run this on NEXUS-PRIME (or any machine with SSH access to the phones):
#
#   bash deploy-everything.sh
#
# It will:
#   1. Deploy xmrig to all 10 phones and start mining
#   2. Install the push-cluster-status.sh cron job on node1
#   3. Start the command poller on node1
#   4. Verify everything is working
#
# If you need to set the API key first:
#   echo "CLUSTER_API_KEY=your-key-here" > ~/.cluster-env
#   bash deploy-everything.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}  FULL CLUSTER DEPLOY — Mining + Dashboard + Controls${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Pre-flight checks ────────────────────────────────────────────────────────

echo -e "${BLUE}[PRE-FLIGHT]${NC} Checking requirements..."

# Check SSH access to at least node1
NODE1_IP="192.168.1.206"
if ! ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "user@$NODE1_IP" "echo ok" &>/dev/null; then
  echo -e "${RED}Cannot SSH to node1 ($NODE1_IP)${NC}"
  echo ""
  echo "Make sure you're running this from NEXUS-PRIME or a machine on the same network."
  echo "If you need password auth, set up SSH keys first:"
  echo "  ssh-copy-id user@$NODE1_IP"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} SSH to node1 works"

# Check for API key
if [ -z "${CLUSTER_API_KEY:-}" ] && [ -f "$HOME/.cluster-env" ]; then
  . "$HOME/.cluster-env"
fi
if [ -z "${CLUSTER_API_KEY:-}" ]; then
  echo -e "  ${YELLOW}!${NC} CLUSTER_API_KEY not set"
  echo ""
  echo "The push script and poller need this. Set it now:"
  echo "  echo 'CLUSTER_API_KEY=your-key-here' > ~/.cluster-env"
  echo ""
  echo "You can find/set the key at curtbrag.com dashboard settings."
  echo "Or check your Netlify environment variables."
  echo ""
  read -p "Enter your CLUSTER_API_KEY (or press Enter to skip dashboard sync): " INPUT_KEY
  if [ -n "$INPUT_KEY" ]; then
    export CLUSTER_API_KEY="$INPUT_KEY"
    echo "CLUSTER_API_KEY=$INPUT_KEY" > "$HOME/.cluster-env"
    echo -e "  ${GREEN}✓${NC} Saved to ~/.cluster-env"
  else
    echo -e "  ${YELLOW}!${NC} Skipping dashboard sync (mining will still work)"
    SKIP_DASHBOARD=true
  fi
fi
SKIP_DASHBOARD="${SKIP_DASHBOARD:-false}"

echo ""

# ── Step 1: Deploy xmrig to all phones ───────────────────────────────────────

echo -e "${BLUE}[STEP 1/4]${NC} Deploying xmrig to all phones..."
echo ""

if [ -f "$SCRIPT_DIR/setup-mining.sh" ]; then
  bash "$SCRIPT_DIR/setup-mining.sh" --stagger 15
else
  echo -e "${RED}setup-mining.sh not found at $SCRIPT_DIR${NC}"
  exit 1
fi

echo ""

# ── Step 2: Copy scripts to node1 ────────────────────────────────────────────

echo -e "${BLUE}[STEP 2/4]${NC} Deploying dashboard scripts to node1..."

# Copy the scripts node1 needs
scp -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
  "$SCRIPT_DIR/push-cluster-status.sh" \
  "$SCRIPT_DIR/poll-cluster-commands.sh" \
  "$SCRIPT_DIR/cluster-nodes.conf" \
  "user@$NODE1_IP:/home/user/" 2>/dev/null

echo -e "  ${GREEN}✓${NC} Scripts copied to node1"

# Copy the .cluster-env file so node1 has the API key
if [ -n "${CLUSTER_API_KEY:-}" ]; then
  ssh -o ConnectTimeout=5 -o BatchMode=yes "user@$NODE1_IP" \
    "echo 'CLUSTER_API_KEY=$CLUSTER_API_KEY' > /home/user/.cluster-env" 2>/dev/null
  echo -e "  ${GREEN}✓${NC} API key deployed to node1"
fi

echo ""

# ── Step 3: Set up cron job for push script ───────────────────────────────────

if [ "$SKIP_DASHBOARD" != "true" ]; then
  echo -e "${BLUE}[STEP 3/4]${NC} Setting up status push cron job on node1..."

  # Install jq + curl on node1 if missing (push script needs them)
  ssh -o ConnectTimeout=5 -o BatchMode=yes "user@$NODE1_IP" "
    for cmd in jq curl; do
      if ! command -v \$cmd >/dev/null 2>&1; then
        doas apk add \$cmd 2>/dev/null || true
      fi
    done
  " 2>/dev/null

  # Add cron job (idempotent — won't duplicate)
  ssh -o ConnectTimeout=5 -o BatchMode=yes "user@$NODE1_IP" "
    CRON_LINE='*/5 * * * * /home/user/push-cluster-status.sh >> /home/user/cluster-push.log 2>&1'
    if ! crontab -l 2>/dev/null | grep -qF 'push-cluster-status.sh'; then
      (crontab -l 2>/dev/null; echo \"\$CRON_LINE\") | crontab -
      echo 'cron-added'
    else
      echo 'cron-exists'
    fi
  " 2>/dev/null
  echo -e "  ${GREEN}✓${NC} Push cron job installed (runs every 5 minutes)"

  # Do an immediate push
  echo -e "  Running first push now..."
  ssh -o ConnectTimeout=10 -o BatchMode=yes "user@$NODE1_IP" \
    "CLUSTER_API_KEY='${CLUSTER_API_KEY}' /home/user/push-cluster-status.sh" 2>/dev/null &
  PUSH_PID=$!
else
  echo -e "${BLUE}[STEP 3/4]${NC} ${YELLOW}Skipped${NC} (no API key)"
fi

echo ""

# ── Step 4: Start command poller ──────────────────────────────────────────────

if [ "$SKIP_DASHBOARD" != "true" ]; then
  echo -e "${BLUE}[STEP 4/4]${NC} Starting command poller on node1..."

  # Kill any existing poller, then start fresh
  ssh -o ConnectTimeout=5 -o BatchMode=yes "user@$NODE1_IP" "
    pkill -f poll-cluster-commands 2>/dev/null || true
    sleep 1
    chmod +x /home/user/poll-cluster-commands.sh
    nohup sh -c 'CLUSTER_API_KEY=\"$CLUSTER_API_KEY\" /home/user/poll-cluster-commands.sh' > /home/user/poller.log 2>&1 &
    sleep 1
    if pgrep -f poll-cluster-commands >/dev/null 2>&1; then
      echo 'poller-running'
    else
      echo 'poller-failed'
    fi
  " 2>/dev/null
  echo -e "  ${GREEN}✓${NC} Command poller started"
else
  echo -e "${BLUE}[STEP 4/4]${NC} ${YELLOW}Skipped${NC} (no API key)"
fi

echo ""

# ── Verify ────────────────────────────────────────────────────────────────────

echo -e "${BLUE}[VERIFY]${NC} Checking miners across all nodes..."
echo ""

MINERS_OK=0
MINERS_FAIL=0
for i in $(seq 1 10); do
  NODE_IP="192.168.1.$((205 + i))"
  if [ "$i" = "1" ]; then
    CHECK=$(ssh -o ConnectTimeout=3 -o BatchMode=yes "user@$NODE_IP" "pgrep -x xmrig >/dev/null 2>&1 && echo MINING || echo DOWN" 2>/dev/null || echo "UNREACHABLE")
  else
    CHECK=$(ssh -o ConnectTimeout=3 -o BatchMode=yes "user@$NODE_IP" "pgrep -x xmrig >/dev/null 2>&1 && echo MINING || echo DOWN" 2>/dev/null || echo "UNREACHABLE")
  fi

  case "$CHECK" in
    MINING)
      echo -e "  node${i} (${NODE_IP}): ${GREEN}MINING${NC}"
      MINERS_OK=$((MINERS_OK + 1))
      ;;
    DOWN)
      echo -e "  node${i} (${NODE_IP}): ${RED}xmrig not running${NC}"
      MINERS_FAIL=$((MINERS_FAIL + 1))
      ;;
    *)
      echo -e "  node${i} (${NODE_IP}): ${YELLOW}unreachable${NC}"
      MINERS_FAIL=$((MINERS_FAIL + 1))
      ;;
  esac
done

# Wait for background push if it was started
if [ -n "${PUSH_PID:-}" ]; then
  wait "$PUSH_PID" 2>/dev/null || true
fi

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}  DEPLOY COMPLETE${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  Miners: ${GREEN}${MINERS_OK} running${NC}, ${RED}${MINERS_FAIL} failed${NC}"
echo ""
echo -e "  ${BLUE}What happens next:${NC}"
echo -e "    - Shares start appearing on MoneroOcean in ~10-15 min"
echo -e "    - Dashboard updates every 5 min at curtbrag.com/cluster"
echo -e "    - XMR pays out to your Cake Wallet at 0.003 XMR minimum"
echo ""
echo -e "  ${BLUE}Check your pool stats:${NC}"
echo -e "    https://moneroocean.stream/#/dashboard"
echo ""
echo -e "  ${BLUE}Check the dashboard:${NC}"
echo -e "    https://curtbrag.com/cluster"
echo ""
