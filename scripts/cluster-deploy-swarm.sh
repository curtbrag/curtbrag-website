#!/bin/bash
# cluster-deploy-swarm.sh — deploy/restart Swarm v2 across the canonical fleet
#
# Usage:
#   bash scripts/cluster-deploy-swarm.sh
#   bash scripts/cluster-deploy-swarm.sh --phones-only
#   bash scripts/cluster-deploy-swarm.sh --nodes phone173,Alina,SteamDeck
#   bash scripts/cluster-deploy-swarm.sh --dry-run
#
# Default: all 11 registered Linux/Termux nodes.

set -u

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$SCRIPT_DIR/cluster-nodes.conf"
SWARM_SCRIPT="$SCRIPT_DIR/node-swarm.sh"

[ -f "$CONF" ] || { echo "ERROR: $CONF not found"; exit 1; }
[ -f "$SWARM_SCRIPT" ] || { echo "ERROR: $SWARM_SCRIPT not found"; exit 1; }

. "$CONF"
load_node_config

SSH_PASS=""
TARGET_NODES=""
SWARM_URL="${SWARM_URL:-https://curtbrag.com/api/cluster}"
POLL_INTERVAL="${POLL_INTERVAL:-60}"
DRY_RUN=0
PHONES_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --password)    SSH_PASS="$2"; shift 2 ;;
    --nodes)       TARGET_NODES="$2"; shift 2 ;;
    --swarm-url)   SWARM_URL="$2"; shift 2 ;;
    --poll)        POLL_INTERVAL="$2"; shift 2 ;;
    --phones-only) PHONES_ONLY=1; shift ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)
      echo "Usage: $0 [--phones-only] [--nodes name1,name2] [--swarm-url URL] [--poll SEC] [--dry-run]"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done

ssh_cmd() {
  local target="$1" port="$2"; shift 2
  local timeout_sec="${SSH_CMD_TIMEOUT:-60}"
  if [ -n "$SSH_PASS" ]; then
    timeout "$timeout_sec" sshpass -p "$SSH_PASS" \
      ssh -p "$port" -o ConnectTimeout=8 -o ServerAliveInterval=15 \
      -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new \
      "$target" "$@"
  else
    timeout "$timeout_sec" \
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

if ! sh -n "$SWARM_SCRIPT"; then
  echo -e "${RED}ERROR:${NC} local node-swarm.sh syntax check failed"
  exit 1
fi

if [ -n "$TARGET_NODES" ]; then
  DEPLOY_NODES=""
  for wanted in $(echo "$TARGET_NODES" | tr ',' ' '); do
    found=""
    for entry in $ALL_NODES; do
      name="${entry%%:*}"
      if [ "$name" = "$wanted" ]; then
        DEPLOY_NODES="${DEPLOY_NODES:+$DEPLOY_NODES }$entry"
        found=1
        break
      fi
    done
    [ -n "$found" ] || echo -e "${YELLOW}WARN:${NC} unknown node '$wanted'"
  done
elif [ "$PHONES_ONLY" -eq 1 ]; then
  DEPLOY_NODES="$PHONE_NODES"
else
  DEPLOY_NODES="$ALL_NODES"
fi

TOTAL=$(printf '%s\n' $DEPLOY_NODES | grep -c . || true)

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║         CURT CLUSTER — SWARM V2 DEPLOY                    ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "  Nodes:  $TOTAL"
echo "  API:    $SWARM_URL"
echo "  Poll:   ${POLL_INTERVAL}s"
echo "  Script: $SWARM_SCRIPT"
[ "$DRY_RUN" -eq 1 ] && echo -e "  ${YELLOW}DRY RUN${NC}"
echo ""

OK=0
FAIL=0
SKIP=0

for entry in $DEPLOY_NODES; do
  NAME="${entry%%:*}"
  IP="${entry#*:}"
  PORT="$(get_node_ssh_port "$IP")"
  SSH_USER="$(get_node_ssh_user "$IP")"
  ROLE="$(get_node_role "$IP")"
  SSH_TARGET="${SSH_USER}@${IP}"

  echo -e "${CYAN}━━━ ${NAME} ${IP}  ${ROLE}  ${SSH_USER}:${PORT} ━━━━━━━━━━━━━━━━━${NC}"

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  would copy/start DEVICE_ID=$NAME NODE_CLASS=$ROLE"
    SKIP=$((SKIP + 1))
    continue
  fi

  if ! ssh_cmd "$SSH_TARGET" "$PORT" "printf CONNECT_OK" 2>/dev/null | grep -q CONNECT_OK; then
    echo -e "  ${RED}✗ SSH unreachable${NC}"
    FAIL=$((FAIL + 1))
    continue
  fi

  echo -ne "  [1/5] copy ... "
  if scp_cmd "$SWARM_SCRIPT" "${SSH_TARGET}:~/node-swarm.sh" "$PORT"; then
    echo -e "${GREEN}OK${NC}"
  else
    echo -e "${RED}FAIL${NC}"
    FAIL=$((FAIL + 1))
    continue
  fi

  echo -ne "  [2/5] syntax ... "
  if ssh_cmd "$SSH_TARGET" "$PORT" 'sh -n "$HOME/node-swarm.sh"' >/dev/null 2>&1; then
    echo -e "${GREEN}OK${NC}"
  else
    echo -e "${RED}FAIL${NC}"
    FAIL=$((FAIL + 1))
    continue
  fi

  echo -ne "  [3/5] stop old ... "
  STOP_CMD='STATE="$HOME/cluster/state/node-swarm.pid"; if [ -f "$STATE" ]; then P=$(cat "$STATE" 2>/dev/null); case "$P" in *[!0-9]*|"") ;; *) if [ -r "/proc/$P/cmdline" ]; then C=$(tr "\000" "\n" < "/proc/$P/cmdline" 2>/dev/null); printf "%s\n" "$C" | grep -F "$HOME/node-swarm.sh" >/dev/null 2>&1 && kill "$P" 2>/dev/null || true; fi ;; esac; fi; sleep 1; true'
  ssh_cmd "$SSH_TARGET" "$PORT" "$STOP_CMD" >/dev/null 2>&1 || true
  echo -e "${GREEN}done${NC}"

  echo -ne "  [4/5] launch ... "
  LAUNCH_CMD="mkdir -p \"\${HOME}/cluster/logs\" \"\${HOME}/cluster/state\"; DEVICE_ID='${NAME}' NODE_CLASS='${ROLE}' SWARM_URL='${SWARM_URL}' POLL_INTERVAL='${POLL_INTERVAL}' nohup sh \"\${HOME}/node-swarm.sh\" >> \"\${HOME}/cluster/logs/swarm-agent.log\" 2>&1 </dev/null &"
  if ssh_cmd "$SSH_TARGET" "$PORT" "$LAUNCH_CMD" >/dev/null 2>&1; then
    echo -e "${GREEN}sent${NC}"
  else
    echo -e "${YELLOW}ssh returned non-zero; verifying anyway${NC}"
  fi

  echo -ne "  [5/5] verify ... "
  sleep 3
  VERIFY_CMD='P=$(cat "$HOME/cluster/state/node-swarm.pid" 2>/dev/null || true); case "$P" in *[!0-9]*|"") exit 1 ;; esac; [ -d "/proc/$P" ] || exit 1; C=$(tr "\000" "\n" < "/proc/$P/cmdline" 2>/dev/null); printf "%s\n" "$C" | grep -F "$HOME/node-swarm.sh" >/dev/null'
  if SSH_CMD_TIMEOUT=12 ssh_cmd "$SSH_TARGET" "$PORT" "$VERIFY_CMD" >/dev/null 2>&1; then
    PID=$(ssh_cmd "$SSH_TARGET" "$PORT" 'cat "$HOME/cluster/state/node-swarm.pid"' 2>/dev/null || echo "?")
    echo -e "${GREEN}RUNNING pid=$PID${NC}"
    OK=$((OK + 1))
  else
    echo -e "${RED}FAILED${NC}"
    echo "  last log lines:"
    ssh_cmd "$SSH_TARGET" "$PORT" 'tail -n 8 "$HOME/cluster/logs/swarm-agent.log" 2>/dev/null' 2>/dev/null | sed 's/^/    /' || true
    FAIL=$((FAIL + 1))
  fi

done

echo ""
echo -e "${GREEN}Running: $OK${NC}   ${RED}Failed: $FAIL${NC}   ${YELLOW}Skipped: $SKIP${NC}"
echo ""
echo "Swarm status endpoint:"
echo "  ${SWARM_URL}?action=queue-status"
echo ""
