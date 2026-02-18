#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════════╗
# ║  CurtBrag Phone Cluster — Steam Deck One-Shot Setup                ║
# ║                                                                     ║
# ║  Run this ONCE on your Steam Deck to set up everything:            ║
# ║    bash scripts/setup-steamdeck.sh                                  ║
# ║                                                                     ║
# ║  Architecture:                                                      ║
# ║    NEXUS-PRIME  = headless API server (the brain)                  ║
# ║    Steam Deck   = deployment controller (you are here)             ║
# ║    10 phones    = pure mining workers                               ║
# ║                                                                     ║
# ║  What it does:                                                      ║
# ║    1. Installs Node.js (via nvm) on Steam Deck                    ║
# ║    2. Installs Tailscale (via deck-tailscale) on Steam Deck       ║
# ║    3. Generates SSH keys and pushes them to phones                 ║
# ║    4. SSHes into NEXUS-PRIME and sets up API server + funnel       ║
# ║    5. Deploys mining to all phones + sets up node1 push/poll       ║
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

banner "STEP 1/5 — Node.js"

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

banner "STEP 2/5 — Tailscale"

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

banner "STEP 3/5 — SSH Keys for Phone Nodes"

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
      if command -v pacman &>/dev/null; then
        # Steam Deck has a read-only root FS — must disable it first
        echo -e "  ${BLUE}Disabling read-only filesystem...${NC}"
        sudo steamos-readonly disable 2>/dev/null || true

        # Pacman keyring must be initialized or installs fail
        echo -e "  ${BLUE}Initializing pacman keyring...${NC}"
        sudo pacman-key --init 2>/dev/null
        sudo pacman-key --populate archlinux holo 2>/dev/null

        echo -e "  ${BLUE}Installing sshpass via pacman...${NC}"
        if sudo pacman -Sy --noconfirm sshpass; then
          echo -e "  ${GREEN}✓${NC} sshpass installed"
        else
          echo -e "  ${RED}✗${NC} sshpass install failed"
        fi

        # Re-enable read-only FS
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
          && echo -ne "${GREEN}done${NC}" \
          || { echo -e "${RED}failed${NC}"; continue; }

        # Verify key auth actually works
        if ssh -p "$port" -o ConnectTimeout=3 -o BatchMode=yes -o StrictHostKeyChecking=accept-new "user@$ip" "echo ok" &>/dev/null; then
          echo -e " ${GREEN}(verified)${NC}"
        else
          # Key was copied but auth still fails — fix permissions via password
          echo -ne " ${YELLOW}(fixing perms)${NC}"
          sshpass -p "$PHONE_PASS" ssh -p "$port" -o StrictHostKeyChecking=accept-new "user@$ip" "
            chmod 700 ~/.ssh 2>/dev/null
            chmod 600 ~/.ssh/authorized_keys 2>/dev/null
            # Fix home dir perms (sshd is strict about this)
            chmod 755 ~ 2>/dev/null
          " &>/dev/null
          # Retry verification
          if ssh -p "$port" -o ConnectTimeout=3 -o BatchMode=yes "user@$ip" "echo ok" &>/dev/null; then
            echo -e " ${GREEN}OK${NC}"
          else
            echo -e " ${RED}still failing${NC}"
          fi
        fi
      else
        echo -e "${YELLOW}skipped (no sshpass)${NC}"
        echo -e "    ${BLUE}Manual fix: ssh-copy-id -p $port user@$ip${NC}"
      fi
    done
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 4: Set up NEXUS-PRIME (headless API server)
# ═══════════════════════════════════════════════════════════════════════════════

banner "STEP 4/5 — NEXUS-PRIME (Headless API Server)"

echo -e "  ${BLUE}NEXUS-PRIME is the headless API server brain.${NC}"
echo -e "  ${BLUE}Setting it up remotely from this Steam Deck.${NC}"
echo ""

# Discover NEXUS-PRIME: try local hostname, mDNS, then Tailscale
NEXUS_HOST=""
for host in "nexus-prime" "nexus-prime.local"; do
  if ping -c 1 -W 3 "$host" &>/dev/null; then
    NEXUS_HOST="$host"
    echo -e "  ${GREEN}✓${NC} Found NEXUS-PRIME at ${NEXUS_HOST}"
    break
  fi
done

# Try Tailscale peer discovery
if [ -z "$NEXUS_HOST" ] && command -v tailscale &>/dev/null; then
  NP_TS_IP=$(tailscale status --json 2>/dev/null | grep -A5 '"nexus-prime"' | grep -o '"TailscaleIPs":\["[^"]*"' | sed 's/.*\["//' 2>/dev/null)
  if [ -n "$NP_TS_IP" ]; then
    NEXUS_HOST="$NP_TS_IP"
    echo -e "  ${GREEN}✓${NC} Found NEXUS-PRIME via Tailscale: ${NEXUS_HOST}"
  fi
fi

# Manual fallback
if [ -z "$NEXUS_HOST" ]; then
  echo -e "  ${YELLOW}Cannot auto-detect NEXUS-PRIME on the network.${NC}"
  echo -ne "  Enter NEXUS-PRIME IP/hostname (or press Enter to skip): "
  read -r NEXUS_HOST
fi

NEXUS_SETUP_OK=0
if [ -n "$NEXUS_HOST" ]; then
  # Get SSH user for NEXUS-PRIME
  echo -ne "  SSH user for NEXUS-PRIME [$(whoami)]: "
  read -r NP_USER
  NP_USER="${NP_USER:-$(whoami)}"
  NP_SSH="${NP_USER}@${NEXUS_HOST}"

  # Test SSH access
  if ! ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$NP_SSH" "echo ok" &>/dev/null; then
    echo -e "  ${YELLOW}SSH key not set up for NEXUS-PRIME. Trying ssh-copy-id...${NC}"
    ssh-copy-id -o StrictHostKeyChecking=accept-new "$NP_SSH" 2>/dev/null || true
  fi

  if ssh -o ConnectTimeout=5 -o BatchMode=yes "$NP_SSH" "echo ok" &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} SSH to NEXUS-PRIME OK"

    # Update repo on NEXUS-PRIME
    echo -e "\n  ${BLUE}Syncing repo on NEXUS-PRIME...${NC}"
    ssh -o ConnectTimeout=10 "$NP_SSH" "
      if [ -d ~/curtbrag-website ]; then
        cd ~/curtbrag-website && git pull origin main 2>&1 | tail -1
      else
        git clone https://github.com/curtbrag/curtbrag-website.git ~/curtbrag-website 2>&1 | tail -1
      fi
    " 2>/dev/null
    echo -e "  ${GREEN}✓${NC} Repo synced"

    # Get credentials (reuse for deploy step too)
    if [ -z "${CLUSTER_WEB_PASSWORD:-}" ]; then
      echo -n "  Dashboard password (CLUSTER_WEB_PASSWORD): "
      read -r CLUSTER_WEB_PASSWORD
      export CLUSTER_WEB_PASSWORD
    fi
    if [ -z "${CLUSTER_API_KEY:-}" ]; then
      echo -n "  API key (CLUSTER_API_KEY): "
      read -r CLUSTER_API_KEY
      export CLUSTER_API_KEY
    fi

    # Run API server + Tailscale funnel setup on NEXUS-PRIME (--api-only = no mining, no node1)
    echo -e "\n  ${BLUE}Setting up API server + Tailscale funnel on NEXUS-PRIME...${NC}"
    ssh -o ConnectTimeout=10 "$NP_SSH" "
      cd ~/curtbrag-website && \
      CLUSTER_WEB_PASSWORD='${CLUSTER_WEB_PASSWORD}' \
      CLUSTER_API_KEY='${CLUSTER_API_KEY}' \
      bash scripts/deploy-everything.sh --api-only
    "

    if [ $? -eq 0 ]; then
      echo -e "  ${GREEN}✓${NC} NEXUS-PRIME API server configured"
      NEXUS_SETUP_OK=1
    else
      echo -e "  ${RED}✗${NC} NEXUS-PRIME setup had errors (check output above)"
    fi

    # Also push NEXUS-PRIME's SSH key to phones so the API server can execute commands
    echo -e "\n  ${BLUE}Ensuring NEXUS-PRIME can SSH to phones...${NC}"
    NP_PUBKEY=$(ssh "$NP_SSH" "cat ~/.ssh/id_ed25519.pub 2>/dev/null || cat ~/.ssh/id_rsa.pub 2>/dev/null" 2>/dev/null)
    if [ -n "$NP_PUBKEY" ]; then
      NP_KEY_OK=0
      NP_KEY_FAIL=0
      for i in $(seq 1 10); do
        IP="192.168.1.$((205 + i))"
        if ssh -o ConnectTimeout=3 -o BatchMode=yes "user@$IP" "
          mkdir -p ~/.ssh && chmod 700 ~/.ssh
          grep -qF '${NP_PUBKEY}' ~/.ssh/authorized_keys 2>/dev/null || echo '${NP_PUBKEY}' >> ~/.ssh/authorized_keys
          chmod 600 ~/.ssh/authorized_keys
        " &>/dev/null; then
          NP_KEY_OK=$((NP_KEY_OK + 1))
        else
          NP_KEY_FAIL=$((NP_KEY_FAIL + 1))
        fi
      done
      echo -e "  ${GREEN}✓${NC} NEXUS-PRIME SSH key pushed to ${NP_KEY_OK} phones (${NP_KEY_FAIL} failed)"
    else
      echo -e "  ${YELLOW}⚠${NC} No SSH key found on NEXUS-PRIME — generate one later:"
      echo -e "    ssh ${NP_SSH} 'ssh-keygen -t ed25519 -N \"\"'"
    fi
  else
    echo -e "  ${RED}✗${NC} Cannot SSH to NEXUS-PRIME at ${NEXUS_HOST}"
    echo -e "    ${YELLOW}Fix: ssh-copy-id ${NP_SSH}${NC}"
    echo -e "    ${YELLOW}Then re-run this script.${NC}"
  fi
else
  echo -e "  ${YELLOW}Skipping NEXUS-PRIME setup.${NC}"
  echo -e "  ${YELLOW}Set it up later: ssh user@nexus-prime 'cd ~/curtbrag-website && bash scripts/deploy-everything.sh --api-only'${NC}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 5: Deploy mining + node1 push/poll (skip API — that's on NEXUS-PRIME)
# ═══════════════════════════════════════════════════════════════════════════════

banner "STEP 5/5 — Deploy Mining to Phones"

echo -e "  ${BLUE}Deploying xmrig to phones + setting up node1 push/poll...${NC}"
echo -e "  ${BLUE}(API server is on NEXUS-PRIME — skipping local API setup)${NC}"
echo ""

# Pass through any extra args, but always skip nexus (that's on NEXUS-PRIME now)
# Also pass phone password as fallback if SSH keys didn't take
PASS_ARGS="--skip-nexus"
if [ -n "${PHONE_PASS:-}" ]; then
  PASS_ARGS="$PASS_ARGS --password $PHONE_PASS"
fi
bash "$SCRIPT_DIR/deploy-everything.sh" $PASS_ARGS "$@"

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              STEAM DECK SETUP COMPLETE                      ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BLUE}Architecture:${NC}"
echo -e "    NEXUS-PRIME  = API server (headless, port 3847)"
echo -e "    Steam Deck   = deployment controller (this machine)"
echo -e "    10 phones    = mining workers"
echo ""
if [ "$NEXUS_SETUP_OK" -eq 1 ] 2>/dev/null; then
  echo -e "  ${GREEN}NEXUS-PRIME:${NC} API server + Tailscale funnel running"
else
  echo -e "  ${YELLOW}NEXUS-PRIME:${NC} Needs manual setup — see Step 4 output above"
fi
echo ""
echo -e "  ${BLUE}If phones were unreachable, make sure:${NC}"
echo -e "    1. Phones are powered on and connected to WiFi"
echo -e "    2. SSH is enabled (postmarketOS: sshd runs by default)"
echo -e "    3. SSH keys are copied: ssh-copy-id user@<phone-ip>"
echo ""
echo -e "  ${BLUE}Re-run mining deploy only:${NC}"
echo -e "    bash scripts/deploy-everything.sh --skip-nexus"
echo ""
echo -e "  ${BLUE}Re-run NEXUS-PRIME API setup:${NC}"
echo -e "    ssh ${NP_SSH:-user@nexus-prime} 'cd ~/curtbrag-website && bash scripts/deploy-everything.sh --api-only'"
echo ""
echo -e "  ${BLUE}Diagnose SSH issues:${NC}"
echo -e "    bash scripts/deploy-everything.sh --diagnose"
echo ""
