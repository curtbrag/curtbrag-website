#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════════╗
# ║  Join Worker Nodes to K3s Cluster                                   ║
# ║  Run from node1 (control plane) or any machine with SSH access:     ║
# ║    bash scripts/setup-k3s-agents.sh                                 ║
# ║    bash scripts/setup-k3s-agents.sh --install-agents                ║
# ║    bash scripts/setup-k3s-agents.sh --nodes node2,node3             ║
# ║                                                                     ║
# ║  What it does:                                                      ║
# ║    - Reads K3s agent token from node1 (or --token flag)            ║
# ║    - SSHs to each worker node                                      ║
# ║    - Installs K3s in agent mode if binary is missing               ║
# ║    - Configures node-ip and node-name                              ║
# ║    - Starts/restarts k3s-agent service                             ║
# ║    - Verifies nodes join the cluster                               ║
# ╚══════════════════════════════════════════════════════════════════════╝

# No set -e — we want to continue past failed nodes

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source node config
if [ -f "$SCRIPT_DIR/cluster-nodes.conf" ]; then
  . "$SCRIPT_DIR/cluster-nodes.conf"
  load_node_config
else
  echo "ERROR: cluster-nodes.conf not found"
  exit 1
fi

# Defaults
SERVER_IP="192.168.1.206"
SERVER_PORT="6443"
SSH_PORT="${SSH_PORT:-22}"
INSTALL_AGENTS=0
DIAGNOSE_ONLY=0
K3S_TOKEN=""
K3S_INSTALL_TIMEOUT=300

# Parse args
while [ $# -gt 0 ]; do
  case $1 in
    --token)         K3S_TOKEN="$2"; shift 2;;
    --server-ip)     SERVER_IP="$2"; shift 2;;
    --password)      SSH_PASS="$2"; shift 2;;
    --ssh-port)      SSH_PORT="$2"; shift 2;;
    --nodes)         TARGET_NODES="$2"; shift 2;;
    --install-agents) INSTALL_AGENTS=1; shift;;
    --diagnose)      DIAGNOSE_ONLY=1; shift;;
    -h|--help)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --token TOKEN         K3s agent token (auto-detected from node1 if omitted)"
      echo "  --server-ip IP        K3s server IP (default: 192.168.1.206)"
      echo "  --password PASS       SSH password for phone nodes"
      echo "  --ssh-port PORT       SSH port (default: 22)"
      echo "  --nodes LIST          Comma-separated node names (default: all workers)"
      echo "  --install-agents      Force fresh K3s install on all workers"
      echo "  --diagnose            Just check K3s status on each node, don't change anything"
      echo ""
      echo "Examples:"
      echo "  $0                           # Auto-detect token, join all workers"
      echo "  $0 --install-agents          # Fresh install on all workers"
      echo "  $0 --nodes node2,node3       # Only join specific nodes"
      echo "  $0 --diagnose                # Check K3s status on all nodes"
      echo "  $0 --token 'K10abc...'       # Use explicit token"
      exit 0;;
    *) shift;;
  esac
done

# SSH wrapper (with configurable timeout)
ssh_cmd() {
  local target="$1"; shift
  local cmd_timeout="${SSH_CMD_TIMEOUT:-30}"
  if [ -n "${SSH_PASS:-}" ]; then
    timeout "$cmd_timeout" sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" \
      -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
      -o StrictHostKeyChecking=accept-new "$target" "$@"
  else
    timeout "$cmd_timeout" ssh -p "$SSH_PORT" \
      -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
      -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$target" "$@"
  fi
}

banner() {
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${CYAN}  $1${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Determine target nodes (workers only)
# ═══════════════════════════════════════════════════════════════════════════════

if [ -n "${TARGET_NODES:-}" ]; then
  DEPLOY_NODES=""
  for name in $(echo "$TARGET_NODES" | tr ',' ' '); do
    for entry in $ALL_NODES; do
      ENAME="${entry%%:*}"
      if [ "$ENAME" = "$name" ]; then
        DEPLOY_NODES="${DEPLOY_NODES:+$DEPLOY_NODES }${entry}"
      fi
    done
  done
else
  # Default: all worker nodes (skip control plane)
  DEPLOY_NODES="$PHONE_NODES"
fi

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║        K3S AGENT — WORKER NODE SETUP                       ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Server:  https://${SERVER_IP}:${SERVER_PORT}"
echo -e "  Mode:    $([ $INSTALL_AGENTS -eq 1 ] && echo 'FRESH INSTALL (--install-agents)' || echo 'join / restart existing')"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Step 1: Get K3s agent token
# ═══════════════════════════════════════════════════════════════════════════════

if [ -z "$K3S_TOKEN" ]; then
  banner "Step 1: Reading agent token from node1"

  # Try local first (if we're running on node1)
  if [ -f /var/lib/rancher/k3s/server/agent-token ]; then
    K3S_TOKEN=$(cat /var/lib/rancher/k3s/server/agent-token 2>/dev/null)
  fi

  # Try with doas locally
  if [ -z "$K3S_TOKEN" ]; then
    K3S_TOKEN=$(doas cat /var/lib/rancher/k3s/server/agent-token 2>/dev/null || true)
  fi

  # Try via SSH to node1
  if [ -z "$K3S_TOKEN" ]; then
    echo -e "  ${YELLOW}Not running on node1 — trying SSH...${NC}"
    K3S_TOKEN=$(ssh_cmd "user@${SERVER_IP}" "doas cat /var/lib/rancher/k3s/server/agent-token 2>/dev/null" 2>/dev/null || true)
  fi

  # Fall back to server token
  if [ -z "$K3S_TOKEN" ]; then
    echo -e "  ${YELLOW}agent-token not found, trying server token...${NC}"
    K3S_TOKEN=$(doas cat /var/lib/rancher/k3s/server/token 2>/dev/null || true)
    if [ -z "$K3S_TOKEN" ]; then
      K3S_TOKEN=$(ssh_cmd "user@${SERVER_IP}" "doas cat /var/lib/rancher/k3s/server/token 2>/dev/null" 2>/dev/null || true)
    fi
  fi

  if [ -z "$K3S_TOKEN" ]; then
    echo -e "  ${RED}ERROR: Could not read K3s token${NC}"
    echo ""
    echo "  Options:"
    echo "    Run this script on node1 (where K3s server runs)"
    echo "    Use --token flag: $0 --token 'K10abc...'"
    echo "    Read manually: doas cat /var/lib/rancher/k3s/server/agent-token"
    exit 1
  fi

  echo -e "  ${GREEN}✓${NC} Token: ${K3S_TOKEN:0:20}..."
else
  echo -e "  Token provided via --token flag"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Step 2: Diagnose K3s status on each worker
# ═══════════════════════════════════════════════════════════════════════════════

banner "Step 2: Checking K3s status on workers"
echo ""
printf "  ${YELLOW}%-8s %-16s %-12s %-10s %-10s${NC}\n" \
  "NODE" "IP" "K3S_BIN" "AGENT_SVC" "RUNNING"
printf "  ${YELLOW}%-8s %-16s %-12s %-10s %-10s${NC}\n" \
  "────" "──" "───────" "─────────" "───────"

for entry in $DEPLOY_NODES; do
  NAME="${entry%%:*}"
  IP="${entry#*:}"
  SSH_TARGET="user@${IP}"

  if ! ssh_cmd "$SSH_TARGET" "echo ok" &>/dev/null; then
    printf "  %-8s %-16s ${RED}%-12s${NC}\n" "$NAME" "$IP" "OFFLINE"
    continue
  fi

  DIAG=$(ssh_cmd "$SSH_TARGET" '
    HAS_BIN="no"; command -v k3s >/dev/null 2>&1 && HAS_BIN="yes"
    HAS_SVC="no"; { [ -f /etc/init.d/k3s-agent ] || [ -f /etc/systemd/system/k3s-agent.service ]; } && HAS_SVC="yes"
    IS_RUN="no"; pgrep -f "k3s agent" >/dev/null 2>&1 && IS_RUN="yes"
    echo "$HAS_BIN|$HAS_SVC|$IS_RUN"
  ' 2>/dev/null || echo "ERR|ERR|ERR")

  HAS_BIN=$(echo "$DIAG" | cut -d'|' -f1)
  HAS_SVC=$(echo "$DIAG" | cut -d'|' -f2)
  IS_RUN=$(echo "$DIAG" | cut -d'|' -f3)

  BIN_COLOR="$RED"; [ "$HAS_BIN" = "yes" ] && BIN_COLOR="$GREEN"
  SVC_COLOR="$RED"; [ "$HAS_SVC" = "yes" ] && SVC_COLOR="$GREEN"
  RUN_COLOR="$RED"; [ "$IS_RUN" = "yes" ] && RUN_COLOR="$GREEN"

  printf "  %-8s %-16s ${BIN_COLOR}%-12s${NC} ${SVC_COLOR}%-10s${NC} ${RUN_COLOR}%-10s${NC}\n" \
    "$NAME" "$IP" "$HAS_BIN" "$HAS_SVC" "$IS_RUN"
done

echo ""

if [ $DIAGNOSE_ONLY -eq 1 ]; then
  echo "Diagnosis complete (--diagnose mode). To join workers, run without --diagnose."
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Step 3: Install/configure K3s agent on each worker
# ═══════════════════════════════════════════════════════════════════════════════

banner "Step 3: Joining workers to cluster"

OK=0
FAIL=0
SKIP=0

for entry in $DEPLOY_NODES; do
  NAME="${entry%%:*}"
  IP="${entry#*:}"
  SSH_TARGET="user@${IP}"

  echo ""
  echo -e "  ${BLUE}[${NAME}]${NC} ${IP}"

  # Check SSH connectivity
  if ! ssh_cmd "$SSH_TARGET" "echo ok" &>/dev/null; then
    echo -e "    ${RED}✗${NC} Cannot SSH — skipping"
    FAIL=$((FAIL + 1))
    continue
  fi

  # Check if K3s binary exists
  HAS_K3S=$(ssh_cmd "$SSH_TARGET" "command -v k3s >/dev/null 2>&1 && echo yes || echo no" 2>/dev/null)

  if [ "$HAS_K3S" = "no" ] || [ $INSTALL_AGENTS -eq 1 ]; then
    # ── Fresh install path ──────────────────────────────────────────
    echo -e "    ${YELLOW}Installing K3s agent (curl | sh)...${NC}"

    # Clean any remnants first
    ssh_cmd "$SSH_TARGET" "
      doas k3s-agent-uninstall.sh 2>/dev/null || true
      doas rm -rf /var/lib/rancher/k3s/agent 2>/dev/null || true
      doas rm -f /etc/rancher/k3s/config.yaml 2>/dev/null || true
    " 2>/dev/null

    # Install K3s via official installer — needs longer timeout for download
    SSH_CMD_TIMEOUT=$K3S_INSTALL_TIMEOUT ssh_cmd "$SSH_TARGET" "
      export INSTALL_K3S_EXEC='agent --node-ip=${IP} --node-name=${NAME} --prefer-bundled-bin'
      export K3S_URL='https://${SERVER_IP}:${SERVER_PORT}'
      export K3S_TOKEN='${K3S_TOKEN}'
      curl -sfL https://get.k3s.io | doas sh -
    " 2>/dev/null
    INSTALL_RC=$?

    if [ $INSTALL_RC -ne 0 ]; then
      echo -e "    ${RED}✗${NC} K3s install failed (exit $INSTALL_RC)"
      echo -e "    ${YELLOW}Try manually:${NC} ssh $SSH_TARGET"
      echo -e "      curl -sfL https://get.k3s.io | K3S_URL=https://${SERVER_IP}:${SERVER_PORT} K3S_TOKEN=... doas sh -"
      FAIL=$((FAIL + 1))
      continue
    fi

    echo -e "    ${GREEN}✓${NC} K3s installed"

  else
    # ── Existing install: reconfigure + restart ─────────────────────
    echo -e "    ${YELLOW}K3s binary found — reconfiguring agent...${NC}"

    # Stop existing agent
    ssh_cmd "$SSH_TARGET" "
      doas rc-service k3s-agent stop 2>/dev/null || true
      doas systemctl stop k3s-agent 2>/dev/null || true
      doas pkill -f 'k3s agent' 2>/dev/null || true
      sleep 2
    " 2>/dev/null

    # Clean stale agent state
    ssh_cmd "$SSH_TARGET" "
      doas rm -rf /var/lib/rancher/k3s/agent/*.kubeconfig 2>/dev/null || true
      doas rm -rf /var/lib/rancher/k3s/agent/client-ca.crt 2>/dev/null || true
    " 2>/dev/null

    # Write config
    ssh_cmd "$SSH_TARGET" "
      doas mkdir -p /etc/rancher/k3s
      printf '%s\n' \
        'server: \"https://${SERVER_IP}:${SERVER_PORT}\"' \
        'token: \"${K3S_TOKEN}\"' \
        'node-name: \"${NAME}\"' \
        'node-ip: \"${IP}\"' \
        'prefer-bundled-bin: true' \
        | doas tee /etc/rancher/k3s/config.yaml > /dev/null
    " 2>/dev/null

    # Start agent
    ssh_cmd "$SSH_TARGET" "
      doas rc-service k3s-agent start 2>/dev/null || \
      doas systemctl start k3s-agent 2>/dev/null || \
      doas k3s agent --config /etc/rancher/k3s/config.yaml &
    " 2>/dev/null

    echo -e "    ${GREEN}✓${NC} Agent reconfigured and started"
  fi

  # Verify agent process is running (give it a moment)
  sleep 3
  AGENT_RUNNING=$(ssh_cmd "$SSH_TARGET" "pgrep -f 'k3s agent' >/dev/null 2>&1 && echo yes || echo no" 2>/dev/null)
  if [ "$AGENT_RUNNING" = "yes" ]; then
    echo -e "    ${GREEN}✓${NC} Agent process running"
    OK=$((OK + 1))
  else
    echo -e "    ${RED}✗${NC} Agent not running — check: ssh $SSH_TARGET 'doas journalctl -u k3s-agent --no-pager -n 20'"
    FAIL=$((FAIL + 1))
  fi
done

# ═══════════════════════════════════════════════════════════════════════════════
# Step 4: Verify cluster membership
# ═══════════════════════════════════════════════════════════════════════════════

banner "Step 4: Verifying cluster membership"
echo ""
echo -e "  ${YELLOW}Waiting 15s for nodes to register...${NC}"
sleep 15

# Get node list from control plane
NODE_STATUS=$(doas kubectl get nodes -o wide 2>/dev/null || \
  ssh_cmd "user@${SERVER_IP}" "doas kubectl get nodes -o wide" 2>/dev/null || \
  echo "ERROR: Could not reach kubectl")

echo ""
echo "$NODE_STATUS"

# ═══════════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              K3S AGENT SETUP COMPLETE                       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Agents: ${GREEN}${OK} joined${NC}, ${RED}${FAIL} failed${NC}"
echo -e "  Server: https://${SERVER_IP}:${SERVER_PORT}"
echo ""
echo -e "  ${BLUE}Check cluster:${NC}"
echo -e "    doas kubectl get nodes -o wide"
echo -e "    doas kubectl get pods -A"
echo ""
echo -e "  ${BLUE}If nodes show NotReady:${NC}"
echo -e "    ssh user@<node-ip> 'doas journalctl -u k3s-agent --no-pager -n 30'"
echo -e "    ssh user@<node-ip> 'doas rc-service k3s-agent restart'"
echo ""
echo -e "  ${BLUE}Force reinstall on all workers:${NC}"
echo -e "    bash scripts/setup-k3s-agents.sh --install-agents"
echo ""
