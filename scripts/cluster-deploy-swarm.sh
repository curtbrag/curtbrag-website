#!/bin/bash
# cluster-deploy-swarm.sh — Deploy and restart node-swarm.sh across the cluster
#
# Usage:
#   bash scripts/cluster-deploy-swarm.sh [--password PASS] [--nodes node1,node2] [--swarm-url URL]
#
# Copies node-swarm.sh to each node, stops any old instance, starts fresh via nohup.
# Works for phones (user@IP) and PCs (neo@IP or per-node user from cluster-nodes.conf).

set -u

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
fi

# ── Defaults ──────────────────────────────────────────────────────────────────
SSH_PORT="${SSH_PORT:-22}"
SSH_PASS=""
TARGET_NODES=""
SWARM_URL="${SWARM_URL:-https://curtbrag.com/api/cluster}"
POLL_INTERVAL="${POLL_INTERVAL:-10}"
DRY_RUN=0

# ── Arg parsing ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --password)   SSH_PASS="$2"; shift 2 ;;
    --nodes)      TARGET_NODES="$2"; shift 2 ;;
    --swarm-url)  SWARM_URL="$2"; shift 2 ;;
    --poll)       POLL_INTERVAL="$2"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --ssh-port)   SSH_PORT="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [options]"
      echo "  --password PASS     SSH password"
      echo "  --nodes LIST        Comma-separated node names (default: all)"
      echo "  --swarm-url URL     Override swarm API URL"
      echo "  --poll SECONDS      Poll interval (default: 10)"
      echo "  --dry-run           Show what would happen, no SSH"
      exit 0 ;;
    *) shift ;;
  esac
done

# ── SSH helpers ───────────────────────────────────────────────────────────────
ssh_cmd() {
  local target="$1" port="$2"; shift 2
  local timeout="${SSH_CMD_TIMEOUT:-60}"
  if [ -n "$SSH_PASS" ]; then
    timeout "$timeout" sshpass -p "$SSH_PASS" \
      ssh -p "$port" -o ConnectTimeout=8 -o ServerAliveInterval=15 \
      -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new \
      "$target" "$@"
  else
    timeout "$timeout" \
      ssh -p "$port" -o ConnectTimeout=8 -o ServerAliveInterval=15 \
      -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new \
      -o BatchMode=yes "$target" "$@"
  fi
}

scp_cmd() {
  local src="$1" dst="$2" port="$3"
  if [ -n "$SSH_PASS" ]; then
    timeout 60 sshpass -p "$SSH_PASS" \
      scp -P "$port" -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new \
      "$src" "$dst" 2>/dev/null
  else
    timeout 60 scp -P "$port" -o ConnectTimeout=8 \
      -o StrictHostKeyChecking=accept-new "$src" "$dst" 2>/dev/null
  fi
}

# ── Determine deploy set ───────────────────────────────────────────────────────
if [ -n "$TARGET_NODES" ]; then
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
  DEPLOY_NODES="$ALL_NODES"
fi

SWARM_SCRIPT="$SCRIPT_DIR/node-swarm.sh"
if [ ! -f "$SWARM_SCRIPT" ]; then
  echo -e "${RED}ERROR:${NC} $SWARM_SCRIPT not found"
  exit 1
fi

# ── Banner ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║         CLUSTER — SWARM WORKER DEPLOY                      ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Script:  ${SWARM_SCRIPT}"
echo -e "  API:     ${SWARM_URL}"
echo -e "  Poll:    ${POLL_INTERVAL}s"
[ $DRY_RUN -eq 1 ] && echo -e "  ${YELLOW}DRY RUN — no SSH will be executed${NC}"
echo ""

# ── Deploy loop ────────────────────────────────────────────────────────────────
OK=0
FAIL=0
SKIP=0

for entry in $DEPLOY_NODES; do
  NAME="${entry%%:*}"
  IP="${entry#*:}"
  PORT="$(get_node_ssh_port "$IP")"
  SSH_USER="$(get_node_ssh_user "$IP")"
  SSH_TARGET="${SSH_USER}@${IP}"

  echo -e "${CYAN}━━━ [${NAME}] ${IP} (${SSH_USER} :${PORT}) ━━━━━━━━━━━━━━━━━━━━━━${NC}"

  if [ $DRY_RUN -eq 1 ]; then
    echo -e "  ${YELLOW}dry-run:${NC} would deploy to ${SSH_TARGET}:${PORT}"
    SKIP=$((SKIP + 1))
    continue
  fi

  # ── Connectivity check ───────────────────────────────────────────────────
  if ! ssh_cmd "$SSH_TARGET" "$PORT" "echo ok" &>/dev/null; then
    echo -e "  ${RED}✗${NC} SSH unreachable — skipping"
    FAIL=$((FAIL + 1))
    continue
  fi

  # ── Syntax check locally before copying ──────────────────────────────────
  if ! sh -n "$SWARM_SCRIPT" 2>/dev/null; then
    echo -e "  ${RED}✗${NC} Local syntax check failed — aborting deploy to this node"
    FAIL=$((FAIL + 1))
    continue
  fi

  # ── Copy script ───────────────────────────────────────────────────────────
  echo -ne "  ${YELLOW}[1/4]${NC} Copying node-swarm.sh ... "
  if scp_cmd "$SWARM_SCRIPT" "${SSH_TARGET}:/home/${SSH_USER}/node-swarm.sh" "$PORT"; then
    echo -e "${GREEN}OK${NC}"
  else
    echo -e "${RED}FAIL${NC} — skipping"
    FAIL=$((FAIL + 1))
    continue
  fi

  # ── Remote syntax check ───────────────────────────────────────────────────
  echo -ne "  ${YELLOW}[2/4]${NC} Remote syntax check ... "
  if ssh_cmd "$SSH_TARGET" "$PORT" "sh -n \"/home/${SSH_USER}/node-swarm.sh\"" 2>/dev/null; then
    echo -e "${GREEN}PARSE_OK${NC}"
  else
    echo -e "${RED}PARSE_FAIL${NC} — not starting"
    FAIL=$((FAIL + 1))
    continue
  fi

  # ── Stop old instance ─────────────────────────────────────────────────────
  echo -ne "  ${YELLOW}[3/4]${NC} Stopping old node-swarm ... "
  ssh_cmd "$SSH_TARGET" "$PORT" "pkill -f 'node-swarm.sh' 2>/dev/null; sleep 1; true" &>/dev/null
  echo -e "${GREEN}done${NC}"

  # ── Start fresh via nohup ─────────────────────────────────────────────────
  echo -ne "  ${YELLOW}[4/4]${NC} Starting node-swarm (nohup) ... "
  LAUNCH_CMD="mkdir -p \"\${HOME}/cluster/logs\"; SWARM_URL='${SWARM_URL}' POLL_INTERVAL='${POLL_INTERVAL}' nohup sh \"\${HOME}/node-swarm.sh\" >> \"\${HOME}/cluster/logs/swarm-agent.log\" 2>&1 &"
  if ssh_cmd "$SSH_TARGET" "$PORT" "$LAUNCH_CMD" &>/dev/null; then
    echo -e "${GREEN}launched${NC}"
  else
    echo -e "${YELLOW}launch returned non-zero (nohup may still have worked)${NC}"
  fi

  # ── Verify ────────────────────────────────────────────────────────────────
  sleep 3
  if SSH_CMD_TIMEOUT=10 ssh_cmd "$SSH_TARGET" "$PORT" "pgrep -f 'node-swarm.sh' >/dev/null 2>&1"; then
    PID=$(ssh_cmd "$SSH_TARGET" "$PORT" "pgrep -f 'node-swarm.sh' | head -1" 2>/dev/null || echo "?")
    echo -e "  ${GREEN}✓${NC} SWARM_RUNNING (pid=$PID)"
    OK=$((OK + 1))
  else
    echo -e "  ${RED}✗${NC} Not running — check: ssh ${SSH_TARGET} 'tail -20 ~/cluster/logs/swarm-agent.log'"
    FAIL=$((FAIL + 1))
  fi
done

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          SWARM DEPLOY COMPLETE                             ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${GREEN}Running:  ${OK}${NC}   ${RED}Failed: ${FAIL}${NC}   ${YELLOW}Skipped: ${SKIP}${NC}"
echo ""
echo -e "  ${BLUE}Tail logs on a node:${NC}"
echo -e "    ssh user@<IP> 'tail -f ~/cluster/logs/swarm-agent.log'"
echo ""
echo -e "  ${BLUE}Verify all workers:${NC}"
echo -e "    for ip in \$(grep -oP '(?<=:)[\d.]+' scripts/cluster-nodes.conf | sort -u); do"
echo -e "      ssh -o ConnectTimeout=3 user@\$ip 'echo \"\$ip \$(pgrep -f node-swarm.sh && echo RUNNING || echo STOPPED)\"' 2>/dev/null; done"
echo ""
echo -e "  ${BLUE}Enqueue a test job:${NC}"
echo -e "    curl -X POST '${SWARM_URL}?action=enqueue' \\"
echo -e "      -H 'Content-Type: application/json' \\"
echo -e "      -d '{\"job\":{\"id\":\"test-1\",\"type\":\"echo\"}}'"
echo ""
