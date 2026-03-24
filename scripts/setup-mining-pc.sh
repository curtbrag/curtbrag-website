#!/bin/bash
# Setup xmrig Monero mining on PC cluster nodes (nexus-prime, coffee-table, steamdeck)
# Usage: sh setup-mining-pc.sh [--node NODE_NAME] [--cpu PERCENT]
#
# Runs from node1. SSHes into each PC node and:
#   - steamdeck:       downloads xmrig binary to ~/bin, user systemd service (survives SteamOS updates)
#   - Linux PCs:       installs via pacman/apt, system systemd service with sudo
#
# SSH keys must be set up first:
#   ssh-copy-id neo@192.168.1.179   (nexus-prime)
#   ssh-copy-id neo@192.168.1.228   (coffee-table)
#   (steamdeck key already set up)

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

WALLET="44Ris5ep9FE6hmwAbi7CtAV5NexMuZixhKeGk8xDFHNYWi57TjsMXEyEFQyVWNQxLkaPY1xVPjoTY2yaTfkTzkCMRur3PwT"
POOL="gulf.moneroocean.stream:20128"
CPU_HINT=75
TARGET_NODE=""

# Load PC node list from cluster-nodes.conf
SCRIPT_DIR="$(dirname "$0")"
# shellcheck source=cluster-nodes.conf
. "${SCRIPT_DIR}/cluster-nodes.conf" 2>/dev/null || . "/home/user/cluster-nodes.conf" 2>/dev/null || true
load_node_config 2>/dev/null || true

while [ $# -gt 0 ]; do
  case $1 in
    --node) TARGET_NODE="$2"; shift 2 ;;
    --cpu)  CPU_HINT="$2";  shift 2 ;;
    --wallet) WALLET="$2"; shift 2 ;;
    --pool)   POOL="$2";   shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--node NAME] [--cpu PERCENT] [--wallet ADDR] [--pool HOST:PORT]"
      echo ""
      echo "PC nodes (from cluster-nodes.conf):"
      for e in ${PC_NODE_LIST:-}; do
        name="${e%%:*}"; rest="${e#*:}"; ip="${rest%%:*}"
        echo "  $name  $ip"
      done
      exit 0 ;;
    *) shift ;;
  esac
done

ssh_pc() {
  local name="$1" ip="$2" user="$3"
  shift 3
  ssh -p 22 -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "${user}@${ip}" "$@"
}

# ── steamdeck: binary in ~/bin, user systemd ────────────────────────────────
setup_steamdeck() {
  local name="$1" ip="$2" user="$3"
  echo -e "${YELLOW}[${name}]${NC} SteamOS — installing xmrig to ~/bin with user systemd..."

  if ! ssh_pc "$name" "$ip" "$user" "echo ok" &>/dev/null; then
    echo -e "  ${RED}✗${NC} Cannot SSH to ${name} (${ip}) — run: ssh-copy-id ${user}@${ip}"
    return 1
  fi

  # Download latest xmrig x86_64 static binary
  echo -e "  Fetching latest xmrig release..."
  ssh_pc "$name" "$ip" "$user" '
    set -e
    XMRIG_URL=$(curl -s https://api.github.com/repos/xmrig/xmrig/releases/latest \
      | grep "browser_download_url" \
      | grep "linux-static-x64" \
      | grep "\.tar\.gz" \
      | head -1 \
      | cut -d\" -f4)
    if [ -z "$XMRIG_URL" ]; then
      echo "ERROR: could not determine xmrig download URL"
      exit 1
    fi
    echo "Downloading: $XMRIG_URL"
    mkdir -p ~/bin ~/tmp-xmrig
    cd ~/tmp-xmrig
    curl -sL "$XMRIG_URL" | tar -xz --strip-components=1
    mv xmrig ~/bin/xmrig
    chmod +x ~/bin/xmrig
    cd ~
    rm -rf ~/tmp-xmrig
    echo "xmrig version: $(~/bin/xmrig --version 2>/dev/null | head -1)"
  '
  echo -e "  ${GREEN}✓${NC} xmrig binary installed to ~/bin"

  # Write config
  echo -e "  Writing config..."
  ssh_pc "$name" "$ip" "$user" "mkdir -p ~/.config/xmrig && cat > ~/.config/xmrig/config.json" << XMRIG_CONFIG
{
  "autosave": true,
  "cpu": {
    "enabled": true,
    "huge-pages": false,
    "max-threads-hint": ${CPU_HINT}
  },
  "opencl": false,
  "cuda": false,
  "donate-level": 1,
  "pools": [
    {
      "url": "${POOL}",
      "user": "${WALLET}",
      "pass": "${name}",
      "keepalive": true,
      "tls": true
    }
  ],
  "http": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 18080,
    "restricted": true
  },
  "log-file": null,
  "print-time": 60
}
XMRIG_CONFIG
  echo -e "  ${GREEN}✓${NC} Config written to ~/.config/xmrig/config.json"

  # User systemd service (survives SteamOS updates, no sudo needed)
  echo -e "  Creating user systemd service..."
  ssh_pc "$name" "$ip" "$user" '
    mkdir -p ~/.config/systemd/user
    cat > ~/.config/systemd/user/xmrig.service << EOF
[Unit]
Description=XMRig Monero Miner
After=network-online.target

[Service]
Type=simple
ExecStart=%h/bin/xmrig --config=%h/.config/xmrig/config.json --no-color
Restart=always
RestartSec=15
Nice=10

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable xmrig
    systemctl --user restart xmrig
    sleep 2
    systemctl --user is-active xmrig
  '
  echo -e "  ${GREEN}✓${NC} User systemd service enabled and started"

  sleep 4
  PROC=$(ssh_pc "$name" "$ip" "$user" "pgrep -x xmrig >/dev/null 2>&1 && echo RUNNING || echo NOT_RUNNING" 2>/dev/null)
  if [ "$PROC" = "RUNNING" ]; then
    echo -e "  ${GREEN}✓${NC} xmrig process running on ${name}"
  else
    echo -e "  ${RED}✗${NC} xmrig not running — check: ssh ${user}@${ip} 'journalctl --user -u xmrig -n 20'"
    return 1
  fi
  echo ""
}

# ── Linux PC: pacman/apt, system systemd with sudo ──────────────────────────
setup_linux_pc() {
  local name="$1" ip="$2" user="$3"
  echo -e "${YELLOW}[${name}]${NC} Linux PC — installing xmrig via package manager..."

  if ! ssh_pc "$name" "$ip" "$user" "echo ok" &>/dev/null; then
    echo -e "  ${RED}✗${NC} Cannot SSH to ${name} (${ip})"
    echo -e "  ${YELLOW}Fix:${NC} On node1, run: ssh-copy-id ${user}@${ip}"
    return 1
  fi

  ARCH=$(ssh_pc "$name" "$ip" "$user" "uname -m" 2>/dev/null)
  echo -e "  Architecture: ${ARCH}"

  # Detect distro and install xmrig
  INSTALL_RESULT=$(ssh_pc "$name" "$ip" "$user" '
    if command -v xmrig >/dev/null 2>&1; then
      echo "already-installed"
      xmrig --version 2>/dev/null | head -1
    elif command -v pacman >/dev/null 2>&1; then
      echo "using-pacman"
      sudo pacman -Sy --noconfirm xmrig 2>&1 && echo "pacman-ok" || echo "pacman-failed"
    elif command -v apt-get >/dev/null 2>&1; then
      echo "using-apt"
      sudo apt-get update -qq 2>&1 && sudo apt-get install -y xmrig 2>&1 && echo "apt-ok" || echo "apt-failed"
    else
      echo "no-pkg-manager"
    fi
  ' 2>/dev/null)

  if echo "$INSTALL_RESULT" | grep -q "already-installed\|pacman-ok\|apt-ok"; then
    echo -e "  ${GREEN}✓${NC} xmrig installed"
  elif echo "$INSTALL_RESULT" | grep -q "no-pkg-manager\|pacman-failed\|apt-failed"; then
    # Fallback: download static binary
    echo -e "  ${YELLOW}⚠${NC} Package install failed — trying static binary download..."
    ssh_pc "$name" "$ip" "$user" '
      set -e
      XMRIG_URL=$(curl -s https://api.github.com/repos/xmrig/xmrig/releases/latest \
        | grep "browser_download_url" \
        | grep "linux-static-x64" \
        | grep "\.tar\.gz" \
        | head -1 \
        | cut -d\" -f4)
      [ -z "$XMRIG_URL" ] && echo "ERROR: no URL" && exit 1
      echo "Downloading: $XMRIG_URL"
      mkdir -p ~/bin ~/tmp-xmrig
      cd ~/tmp-xmrig
      curl -sL "$XMRIG_URL" | tar -xz --strip-components=1
      sudo mv xmrig /usr/local/bin/xmrig
      sudo chmod +x /usr/local/bin/xmrig
      cd ~
      rm -rf ~/tmp-xmrig
      echo "xmrig version: $(xmrig --version 2>/dev/null | head -1)"
    '
    echo -e "  ${GREEN}✓${NC} Static binary installed to /usr/local/bin/xmrig"
  fi

  XMRIG_BIN=$(ssh_pc "$name" "$ip" "$user" "command -v xmrig 2>/dev/null || echo /usr/local/bin/xmrig" 2>/dev/null)
  echo -e "  Binary: ${XMRIG_BIN}"

  # Write config
  echo -e "  Writing config..."
  ssh_pc "$name" "$ip" "$user" "sudo mkdir -p /etc/xmrig && sudo tee /etc/xmrig/config.json > /dev/null" << XMRIG_CONFIG
{
  "autosave": true,
  "cpu": {
    "enabled": true,
    "huge-pages": true,
    "max-threads-hint": ${CPU_HINT}
  },
  "opencl": false,
  "cuda": false,
  "donate-level": 1,
  "pools": [
    {
      "url": "${POOL}",
      "user": "${WALLET}",
      "pass": "${name}",
      "keepalive": true,
      "tls": true
    }
  ],
  "http": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 18080,
    "restricted": true
  },
  "log-file": "/var/log/xmrig.log",
  "print-time": 60
}
XMRIG_CONFIG
  echo -e "  ${GREEN}✓${NC} Config written to /etc/xmrig/config.json"

  # System systemd service
  echo -e "  Creating systemd service..."
  ssh_pc "$name" "$ip" "$user" "sudo tee /etc/systemd/system/xmrig.service > /dev/null" << 'SVCUNIT'
[Unit]
Description=XMRig Monero Miner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/xmrig --config=/etc/xmrig/config.json --no-color
Restart=always
RestartSec=15
Nice=10

[Install]
WantedBy=multi-user.target
SVCUNIT
  ssh_pc "$name" "$ip" "$user" "
    sudo systemctl daemon-reload
    sudo systemctl enable xmrig
    sudo systemctl restart xmrig
    sleep 2
    sudo systemctl is-active xmrig
  " 2>/dev/null
  echo -e "  ${GREEN}✓${NC} systemd service enabled and started"

  sleep 4
  PROC=$(ssh_pc "$name" "$ip" "$user" "pgrep -x xmrig >/dev/null 2>&1 && echo RUNNING || echo NOT_RUNNING" 2>/dev/null)
  if [ "$PROC" = "RUNNING" ]; then
    echo -e "  ${GREEN}✓${NC} xmrig running on ${name}"
  else
    echo -e "  ${RED}✗${NC} xmrig not running — check: ssh ${user}@${ip} 'sudo journalctl -u xmrig -n 20'"
    return 1
  fi
  echo ""
}

# ── Dispatch ────────────────────────────────────────────────────────────────

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  XMR Mining Setup — PC Nodes${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  Pool:   ${POOL}"
echo -e "  Wallet: ${WALLET:0:12}...${WALLET: -8}"
echo -e "  CPU:    ${CPU_HINT}%"
echo ""

SUCCESSES=0
FAILURES=0

run_node() {
  local entry="$1"
  local name="${entry%%:*}"
  local rest="${entry#*:}"
  local ip="${rest%%:*}"
  local pc_user
  pc_user=$(get_pc_ssh_user "$name" 2>/dev/null || echo "neo")

  # Skip if --node filter specified and doesn't match
  if [ -n "$TARGET_NODE" ] && [ "$name" != "$TARGET_NODE" ]; then
    return 0
  fi

  if [ "$name" = "steamdeck" ]; then
    if setup_steamdeck "$name" "$ip" "$pc_user"; then
      SUCCESSES=$((SUCCESSES + 1))
    else
      FAILURES=$((FAILURES + 1))
    fi
  else
    if setup_linux_pc "$name" "$ip" "$pc_user"; then
      SUCCESSES=$((SUCCESSES + 1))
    else
      FAILURES=$((FAILURES + 1))
    fi
  fi
}

for pc_entry in ${PC_NODE_LIST:-"nexus-prime:192.168.1.179:pc coffee-table:192.168.1.228:pc vikixii:192.168.1.180:pc steamdeck:192.168.1.171:pc:deck"}; do
  run_node "$pc_entry"
done

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "Results: ${GREEN}${SUCCESSES} succeeded${NC}, ${RED}${FAILURES} failed${NC}"
if [ "$FAILURES" -gt 0 ]; then
  echo ""
  echo -e "${YELLOW}For nodes that failed SSH:${NC}"
  echo -e "  ssh-copy-id neo@192.168.1.179   # nexus-prime"
  echo -e "  ssh-copy-id neo@192.168.1.228   # coffee-table"
  echo -e "  ssh-copy-id neo@192.168.1.180   # vikixii"
  echo -e "Then re-run: sh setup-mining-pc.sh"
fi
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
