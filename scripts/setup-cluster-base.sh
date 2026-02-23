#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════════╗
# ║  Phase 1, Step 1: Standardize All Phone Nodes                      ║
# ║  Run from any machine with SSH access to the phones:               ║
# ║    bash scripts/setup-cluster-base.sh --password 0735              ║
# ║                                                                     ║
# ║  What it does:                                                      ║
# ║    - Sets hostname on each node (node1..node10)                    ║
# ║    - Installs baseline packages (git, curl, htop, tmux, etc.)     ║
# ║    - Copies SSH public key for passwordless access                 ║
# ║    - Verifies OS version and shell environment                     ║
# ║    - Reports per-node inventory (CPU, RAM, disk, OS)              ║
# ╚══════════════════════════════════════════════════════════════════════╝

set -e

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

# Baseline packages for Alpine/postmarketOS
BASE_PACKAGES="git curl htop tmux build-base cmake python3 py3-pip jq"

# Parse args
SSH_PORT="${SSH_PORT:-22}"
while [[ $# -gt 0 ]]; do
  case $1 in
    --password) SSH_PASS="$2"; shift 2;;
    --ssh-port) SSH_PORT="$2"; shift 2;;
    --ssh-key) SSH_KEY="$2"; shift 2;;
    --skip-packages) SKIP_PACKAGES=1; shift;;
    --inventory-only) INVENTORY_ONLY=1; shift;;
    -h|--help)
      echo "Usage: $0 [options]"
      echo "  --password PASS     SSH password for phone nodes"
      echo "  --ssh-port PORT     SSH port (default: 22)"
      echo "  --ssh-key PATH      SSH public key to install (default: ~/.ssh/id_ed25519.pub)"
      echo "  --skip-packages     Skip package installation"
      echo "  --inventory-only    Just report node inventory, don't change anything"
      exit 0;;
    *) shift;;
  esac
done

# SSH wrapper
ssh_cmd() {
  local target="$1"; shift
  if [ -n "${SSH_PASS:-}" ]; then
    sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "$target" "$@"
  else
    ssh -p "$SSH_PORT" -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$target" "$@"
  fi
}

banner() {
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${CYAN}  $1${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Node inventory
# ═══════════════════════════════════════════════════════════════════════════════

collect_inventory() {
  banner "Cluster Node Inventory"
  echo ""
  printf "  ${YELLOW}%-8s %-16s %-10s %-8s %-8s %-8s %-20s${NC}\n" \
    "NODE" "IP" "STATUS" "CPU" "RAM" "DISK" "OS"
  printf "  ${YELLOW}%-8s %-16s %-10s %-8s %-8s %-8s %-20s${NC}\n" \
    "────" "──" "──────" "───" "───" "────" "──"

  for entry in $ALL_NODES; do
    NAME="${entry%%:*}"
    IP="${entry#*:}"
    SSH_TARGET="user@${IP}"

    if ! ssh_cmd "$SSH_TARGET" "echo ok" &>/dev/null; then
      printf "  %-8s %-16s ${RED}%-10s${NC}\n" "$NAME" "$IP" "OFFLINE"
      continue
    fi

    INFO=$(ssh_cmd "$SSH_TARGET" '
      CPUS=$(nproc 2>/dev/null || echo "?")
      RAM=$(free -m 2>/dev/null | awk "/Mem:/{printf \"%dMB\", \$2}" || echo "?")
      DISK=$(df -h / 2>/dev/null | awk "NR==2{print \$4}" || echo "?")
      OS=$(cat /etc/os-release 2>/dev/null | grep ^PRETTY_NAME | cut -d= -f2 | tr -d "\"" || echo "unknown")
      HOSTNAME=$(hostname 2>/dev/null || echo "?")
      echo "$CPUS|$RAM|$DISK|$OS|$HOSTNAME"
    ' 2>/dev/null || echo "?|?|?|?|?")

    CPUS=$(echo "$INFO" | cut -d'|' -f1)
    RAM=$(echo "$INFO" | cut -d'|' -f2)
    DISK=$(echo "$INFO" | cut -d'|' -f3)
    OS=$(echo "$INFO" | cut -d'|' -f4 | cut -c1-20)
    CUR_HOST=$(echo "$INFO" | cut -d'|' -f5)

    printf "  %-8s %-16s ${GREEN}%-10s${NC} %-8s %-8s %-8s %-20s\n" \
      "$NAME" "$IP" "ONLINE" "${CPUS}c" "$RAM" "$DISK" "$OS"
  done
  echo ""
}

# Run inventory
collect_inventory

if [ -n "${INVENTORY_ONLY:-}" ]; then
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Step 1: Set hostnames
# ═══════════════════════════════════════════════════════════════════════════════

banner "Step 1/3 — Set Hostnames"

for entry in $ALL_NODES; do
  NAME="${entry%%:*}"
  IP="${entry#*:}"
  SSH_TARGET="user@${IP}"

  if ! ssh_cmd "$SSH_TARGET" "echo ok" &>/dev/null; then
    echo -e "  ${RED}[${NAME}]${NC} Offline — skipping"
    continue
  fi

  CUR_HOST=$(ssh_cmd "$SSH_TARGET" "hostname" 2>/dev/null)
  if [ "$CUR_HOST" = "$NAME" ]; then
    echo -e "  ${GREEN}[${NAME}]${NC} Hostname already set"
  else
    ssh_cmd "$SSH_TARGET" "echo '$NAME' | doas tee /etc/hostname >/dev/null && doas hostname '$NAME'" 2>/dev/null
    echo -e "  ${GREEN}[${NAME}]${NC} Hostname set (was: $CUR_HOST)"
  fi
done

# ═══════════════════════════════════════════════════════════════════════════════
# Step 2: Install baseline packages
# ═══════════════════════════════════════════════════════════════════════════════

if [ -z "${SKIP_PACKAGES:-}" ]; then
  banner "Step 2/3 — Install Baseline Packages"
  echo -e "  Packages: ${BASE_PACKAGES}"
  echo ""

  for entry in $ALL_NODES; do
    NAME="${entry%%:*}"
    IP="${entry#*:}"
    SSH_TARGET="user@${IP}"

    if ! ssh_cmd "$SSH_TARGET" "echo ok" &>/dev/null; then
      echo -e "  ${RED}[${NAME}]${NC} Offline — skipping"
      continue
    fi

    echo -ne "  ${YELLOW}[${NAME}]${NC} Installing... "

    RESULT=$(ssh_cmd "$SSH_TARGET" "
      # Enable community repo if not already
      if ! grep -q '^[^#].*community' /etc/apk/repositories 2>/dev/null; then
        MIRROR=\$(grep -m1 '^http' /etc/apk/repositories | sed 's|/[^/]*/[^/]*$||')
        ALPINE_VER=\$(cat /etc/alpine-release 2>/dev/null | cut -d. -f1,2)
        [ -n \"\$MIRROR\" ] && [ -n \"\$ALPINE_VER\" ] && echo \"\${MIRROR}/v\${ALPINE_VER}/community\" | doas tee -a /etc/apk/repositories >/dev/null
      fi
      doas apk update >/dev/null 2>&1
      doas apk add $BASE_PACKAGES 2>&1 | tail -1
    " 2>/dev/null || echo "FAILED")

    if echo "$RESULT" | grep -qi "error\|failed"; then
      echo -e "${RED}FAILED${NC}: $RESULT"
    else
      echo -e "${GREEN}OK${NC}"
    fi
  done
else
  echo -e "${YELLOW}Skipping package installation (--skip-packages)${NC}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Step 3: SSH key setup
# ═══════════════════════════════════════════════════════════════════════════════

banner "Step 3/3 — SSH Key Setup"

# Find SSH public key
SSH_KEY="${SSH_KEY:-}"
if [ -z "$SSH_KEY" ]; then
  for keyfile in ~/.ssh/id_ed25519.pub ~/.ssh/id_rsa.pub; do
    if [ -f "$keyfile" ]; then
      SSH_KEY="$keyfile"
      break
    fi
  done
fi

if [ -z "$SSH_KEY" ] || [ ! -f "$SSH_KEY" ]; then
  echo -e "  ${YELLOW}No SSH public key found. Generating one...${NC}"
  ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" -q
  SSH_KEY=~/.ssh/id_ed25519.pub
fi

PUBKEY=$(cat "$SSH_KEY")
echo -e "  Key: ${SSH_KEY}"
echo ""

for entry in $ALL_NODES; do
  NAME="${entry%%:*}"
  IP="${entry#*:}"
  SSH_TARGET="user@${IP}"

  if ! ssh_cmd "$SSH_TARGET" "echo ok" &>/dev/null; then
    echo -e "  ${RED}[${NAME}]${NC} Offline — skipping"
    continue
  fi

  HAS_KEY=$(ssh_cmd "$SSH_TARGET" "grep -c '$(echo "$PUBKEY" | awk '{print $2}')' ~/.ssh/authorized_keys 2>/dev/null" 2>/dev/null || echo "0")

  if [ "$HAS_KEY" != "0" ]; then
    echo -e "  ${GREEN}[${NAME}]${NC} Key already installed"
  else
    ssh_cmd "$SSH_TARGET" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '$PUBKEY' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys" 2>/dev/null
    echo -e "  ${GREEN}[${NAME}]${NC} Key installed"
  fi
done

# ═══════════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                 CLUSTER BASE SETUP COMPLETE                 ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Next steps:"
echo -e "    bash scripts/setup-networking.sh     # Fix persistent networking"
echo -e "    bash scripts/setup-redis.sh          # Install job queue"
echo -e "    bash scripts/deploy-workers.sh       # Deploy AI workers"
echo ""
