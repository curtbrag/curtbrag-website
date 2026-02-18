#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════════╗
# ║  CurtBrag Phone Cluster — Steam Deck One-Shot Setup                ║
# ║                                                                     ║
# ║  Run this ONCE on your Steam Deck to set up everything:            ║
# ║    bash scripts/setup-steamdeck.sh                                  ║
# ║                                                                     ║
# ║  What it does:                                                      ║
# ║    1. Installs Node.js (via nvm)                                   ║
# ║    2. Installs Tailscale (via deck-tailscale)                      ║
# ║    3. Generates SSH keys and helps you push them to phones         ║
# ║    4. Runs deploy-everything.sh                                     ║
# ╚══════════════════════════════════════════════════════════════════════╝

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

banner() {
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${CYAN}  $1${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║        STEAM DECK — CLUSTER SETUP                          ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 1: Node.js via nvm
# ═══════════════════════════════════════════════════════════════════════════════

banner "STEP 1/4 — Node.js"

if command -v node &>/dev/null; then
  NODE_VER=$(node --version 2>/dev/null)
  echo -e "  ${GREEN}✓${NC} Node.js already installed: ${NODE_VER}"
else
  echo -e "  ${YELLOW}Installing Node.js via nvm...${NC}"

  # Install nvm if not present
  if [ ! -d "$HOME/.nvm" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi

  # Load nvm
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

  # Install Node 20 LTS
  nvm install 20
  nvm use 20

  if command -v node &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Node.js installed: $(node --version)"
  else
    echo -e "  ${RED}✗${NC} Node.js install failed"
    exit 1
  fi
fi

# Ensure nvm is loaded for the rest of the script
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 2: Tailscale
# ═══════════════════════════════════════════════════════════════════════════════

banner "STEP 2/4 — Tailscale"

# Ensure DNS works for root (Steam Deck issue)
if ! sudo grep -q nameserver /etc/resolv.conf 2>/dev/null; then
  echo -e "  ${YELLOW}Fixing DNS for root...${NC}"
  echo -e "nameserver 8.8.8.8\nnameserver 1.1.1.1" | sudo tee /etc/resolv.conf >/dev/null
  echo -e "  ${GREEN}✓${NC} DNS fixed"
fi

if command -v tailscale &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} Tailscale already installed"
else
  echo -e "  ${YELLOW}Installing Tailscale for Steam Deck...${NC}"

  if [ ! -d "$HOME/deck-tailscale" ]; then
    git clone https://github.com/tailscale-dev/deck-tailscale.git "$HOME/deck-tailscale"
  fi

  (cd "$HOME/deck-tailscale" && sudo bash tailscale.sh)

  # Add to PATH
  if [ -f /etc/profile.d/tailscale.sh ]; then
    source /etc/profile.d/tailscale.sh 2>/dev/null || export PATH="$PATH:/opt/tailscale"
  else
    export PATH="$PATH:/opt/tailscale"
  fi

  if command -v tailscale &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Tailscale installed"
  else
    echo -e "  ${RED}✗${NC} Tailscale install failed"
    echo -e "  ${YELLOW}You can skip this and set it up later.${NC}"
  fi
fi

# Login to Tailscale if not already
if command -v tailscale &>/dev/null; then
  if tailscale status &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Tailscale connected"
  else
    echo -e "  ${YELLOW}Tailscale needs authentication.${NC}"
    echo -e "  ${BLUE}A URL will appear — open it in a browser to log in.${NC}"
    echo ""
    sudo tailscale up --operator="$(whoami)" --ssh --qr || {
      echo -e "  ${YELLOW}⚠${NC} Tailscale login deferred. Run later:"
      echo -e "    sudo tailscale up --operator=$(whoami) --ssh"
    }
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 3: SSH Keys
# ═══════════════════════════════════════════════════════════════════════════════

banner "STEP 3/4 — SSH Keys for Phone Nodes"

# Generate SSH key if none exists
if [ ! -f "$HOME/.ssh/id_ed25519" ] && [ ! -f "$HOME/.ssh/id_rsa" ]; then
  echo -e "  ${YELLOW}Generating SSH key...${NC}"
  ssh-keygen -t ed25519 -f "$HOME/.ssh/id_ed25519" -N "" -q
  echo -e "  ${GREEN}✓${NC} SSH key generated"
else
  echo -e "  ${GREEN}✓${NC} SSH key exists"
fi

# Source node config
source "$SCRIPT_DIR/cluster-nodes.conf" 2>/dev/null
load_node_config 2>/dev/null

echo ""
echo -e "  ${BLUE}Checking SSH access to phone nodes...${NC}"
echo ""

SSH_OK=0
SSH_FAIL=0
NEED_KEY_COPY=""

for i in $(seq 1 10); do
  NODE_IP="192.168.1.$((205 + i))"
  NODE_NAME="node$i"
  echo -ne "  ${YELLOW}[${NODE_NAME}]${NC} ${NODE_IP} ... "

  # Ping test
  if ! ping -c 1 -W 2 "$NODE_IP" &>/dev/null; then
    echo -e "${RED}unreachable${NC}"
    SSH_FAIL=$((SSH_FAIL + 1))
    continue
  fi

  # SSH test (try port 22 first, then 8022)
  SSH_PORT=22
  if ssh -p 22 -o ConnectTimeout=3 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "user@$NODE_IP" "echo ok" &>/dev/null; then
    echo -e "${GREEN}SSH OK (port 22)${NC}"
    SSH_OK=$((SSH_OK + 1))
  elif ssh -p 8022 -o ConnectTimeout=3 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "user@$NODE_IP" "echo ok" &>/dev/null; then
    echo -e "${GREEN}SSH OK (port 8022)${NC}"
    SSH_OK=$((SSH_OK + 1))
    SSH_PORT=8022
  else
    # Port is open but auth fails — need key copy
    if timeout 3 bash -c "echo >/dev/tcp/$NODE_IP/22" 2>/dev/null; then
      echo -e "${YELLOW}auth failed (port 22 open)${NC}"
      NEED_KEY_COPY="$NEED_KEY_COPY $NODE_NAME:$NODE_IP:22"
    elif timeout 3 bash -c "echo >/dev/tcp/$NODE_IP/8022" 2>/dev/null; then
      echo -e "${YELLOW}auth failed (port 8022 open)${NC}"
      NEED_KEY_COPY="$NEED_KEY_COPY $NODE_NAME:$NODE_IP:8022"
    else
      echo -e "${RED}no SSH port open${NC}"
    fi
    SSH_FAIL=$((SSH_FAIL + 1))
  fi
done

echo ""
echo -e "  SSH: ${GREEN}${SSH_OK} OK${NC}, ${RED}${SSH_FAIL} failed${NC}"

# Offer to copy SSH keys
if [ -n "$NEED_KEY_COPY" ]; then
  echo ""
  echo -e "  ${YELLOW}Some nodes need SSH key setup.${NC}"
  echo -ne "  Enter the phone password to push SSH keys (or press Enter to skip): "
  read -r PHONE_PASS

  if [ -n "$PHONE_PASS" ]; then
    if ! command -v sshpass &>/dev/null; then
      echo -e "  ${YELLOW}Installing sshpass...${NC}"
      # On Steam Deck, sshpass might not be available via pacman
      # Try to compile from source as a fallback
      if command -v pacman &>/dev/null; then
        sudo steamos-readonly disable 2>/dev/null || true
        sudo pacman -Sy --noconfirm sshpass 2>/dev/null || true
        sudo steamos-readonly enable 2>/dev/null || true
      fi
    fi

    for entry in $NEED_KEY_COPY; do
      name="${entry%%:*}"
      rest="${entry#*:}"
      ip="${rest%%:*}"
      port="${rest##*:}"
      echo -ne "  ${YELLOW}[${name}]${NC} Copying key to ${ip}:${port} ... "
      if command -v sshpass &>/dev/null; then
        sshpass -p "$PHONE_PASS" ssh-copy-id -p "$port" -o StrictHostKeyChecking=accept-new "user@$ip" &>/dev/null \
          && echo -e "${GREEN}done${NC}" \
          || echo -e "${RED}failed${NC}"
      else
        echo -e "${YELLOW}skipped (no sshpass)${NC}"
        echo -e "    ${BLUE}Manual fix: ssh-copy-id -p $port user@$ip${NC}"
      fi
    done
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 4: Run full deploy
# ═══════════════════════════════════════════════════════════════════════════════

banner "STEP 4/4 — Full Cluster Deploy"

echo -e "  ${BLUE}Running deploy-everything.sh...${NC}"
echo ""

# Pass through any extra args
bash "$SCRIPT_DIR/deploy-everything.sh" "$@"

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              STEAM DECK SETUP COMPLETE                      ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BLUE}If phones were unreachable, make sure:${NC}"
echo -e "    1. Phones are powered on and connected to WiFi"
echo -e "    2. SSH is enabled (postmarketOS: sshd runs by default)"
echo -e "    3. SSH keys are copied: ssh-copy-id user@<phone-ip>"
echo ""
echo -e "  ${BLUE}Re-run deploy after fixing phones:${NC}"
echo -e "    bash scripts/deploy-everything.sh"
echo ""
echo -e "  ${BLUE}Diagnose SSH issues:${NC}"
echo -e "    bash scripts/deploy-everything.sh --diagnose"
echo ""
