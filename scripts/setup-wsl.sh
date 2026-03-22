#!/bin/bash
# One-command WSL cluster setup — run once from WSL to make everything passwordless
# Usage: bash setup-wsl.sh
# Optional env vars:
#   NODE1_PASS=... NODE_PASS=... PC_PASS=...  (skip password prompts)
#   SKIP_KEYDIST=1                             (skip distributing node1's key to workers)
#   DEV_BRANCH=1                               (pull from dev branch instead of main)
set -euo pipefail

BOLD='\033[1m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; RESET='\033[0m'
info()    { echo -e "${GREEN}✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}!${RESET} $*"; }
error()   { echo -e "${RED}✗${RESET} $*"; }
section() { echo -e "\n${BOLD}=== $* ===${RESET}"; }

# ── Node definitions (mirrors cluster-nodes.conf) ────────────────────────────
NODE1_IP="192.168.1.206"
NODE1_PORT=22          # node1 uses standard SSH (not Termux)
NODE1_USER="user"

# Phone worker nodes (Termux SSH on port 8022)
PHONE_NODES="
node2:192.168.1.207
node3:192.168.1.208
node4:192.168.1.209
node5:192.168.1.210
node6:192.168.1.211
node7:192.168.1.212
node8:192.168.1.213
node9:192.168.1.214
node10:192.168.1.215
"
PHONE_PORT=8022
PHONE_USER="user"

# PC nodes (standard SSH on port 22)
PC_NODES="
nexus-prime:192.168.1.178
vikixii:192.168.1.180
steamdeck:100.102.66.70
"
PC_PORT=22
PC_USER="neo"

BRANCH="${DEV_BRANCH:+claude/setup-cluster-advanced-t3WV0}"
BRANCH="${BRANCH:-main}"
SCRIPT_BASE="https://raw.githubusercontent.com/curtbrag/curtbrag-website/$BRANCH/scripts"

SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=5"
SSH_KEY="$HOME/.ssh/id_ed25519"

section "curtbrag cluster WSL setup"
echo "Branch: $BRANCH"
echo ""

# ── Step 1: Generate SSH key ─────────────────────────────────────────────────
section "Step 1/5: SSH key"
if [ ! -f "$SSH_KEY" ]; then
  echo "Generating new ED25519 SSH key..."
  ssh-keygen -t ed25519 -f "$SSH_KEY" -N "" -C "curtbrag-cluster-wsl"
  info "Key created: $SSH_KEY"
else
  info "Key exists: $SSH_KEY"
fi
PUBKEY=$(cat "${SSH_KEY}.pub")

# ── Helper: test if SSH key works (passwordless) ─────────────────────────────
ssh_works() {
  local port="$1" user="$2" ip="$3"
  ssh -p "$port" -o BatchMode=yes -o ConnectTimeout=3 -o StrictHostKeyChecking=accept-new \
    "$user@$ip" "echo ok" >/dev/null 2>&1
}

# ── Helper: copy SSH key (uses ssh-copy-id, prompts for password if needed) ──
copy_key() {
  local port="$1" user="$2" ip="$3" name="$4" pass="${5:-}"
  if ssh_works "$port" "$user" "$ip"; then
    info "$name ($ip:$port): already passwordless"
    return 0
  fi
  echo ""
  echo "  Installing key → $name ($user@$ip:$port)"
  if [ -n "$pass" ]; then
    if command -v sshpass >/dev/null 2>&1; then
      sshpass -p "$pass" ssh-copy-id -p "$port" $SSH_OPTS -i "${SSH_KEY}.pub" "$user@$ip" 2>/dev/null && {
        info "$name: key installed"
        return 0
      }
    else
      warn "sshpass not found — ignoring $name password var, prompting manually"
    fi
  fi
  ssh-copy-id -p "$port" $SSH_OPTS -i "${SSH_KEY}.pub" "$user@$ip" && {
    info "$name: key installed"
    return 0
  } || {
    warn "$name: FAILED (offline or wrong password — skipping)"
    return 1
  }
}

# ── Step 2: Install WSL key on all nodes ────────────────────────────────────
section "Step 2/5: Copy WSL key to all nodes"
echo "For each unreachable node you'll be prompted for the SSH password."
echo "Press Ctrl+C to skip a node, or just Enter if password is blank."
echo ""

REACHABLE_NODES=()

# node1
if copy_key "$NODE1_PORT" "$NODE1_USER" "$NODE1_IP" "node1" "${NODE1_PASS:-}"; then
  REACHABLE_NODES+=("node1:$NODE1_IP:$NODE1_PORT:$NODE1_USER")
fi

# phone workers
for entry in $PHONE_NODES; do
  [ -z "$entry" ] && continue
  name="${entry%%:*}"; ip="${entry##*:}"
  if copy_key "$PHONE_PORT" "$PHONE_USER" "$ip" "$name" "${NODE_PASS:-}"; then
    REACHABLE_NODES+=("$name:$ip:$PHONE_PORT:$PHONE_USER")
  fi
done

# PC nodes
for entry in $PC_NODES; do
  [ -z "$entry" ] && continue
  name="${entry%%:*}"; ip="${entry##*:}"
  if copy_key "$PC_PORT" "$PC_USER" "$ip" "$name" "${PC_PASS:-}"; then
    REACHABLE_NODES+=("$name:$ip:$PC_PORT:$PC_USER")
  fi
done

# ── Step 3: Write ~/.ssh/config ───────────────────────────────────────────────
section "Step 3/5: SSH config"
SSH_CONFIG="$HOME/.ssh/config"
touch "$SSH_CONFIG"
chmod 600 "$SSH_CONFIG"

# Remove old curtbrag cluster block if present
if grep -q "# curtbrag-cluster-start" "$SSH_CONFIG" 2>/dev/null; then
  sed -i '/# curtbrag-cluster-start/,/# curtbrag-cluster-end/d' "$SSH_CONFIG"
fi

cat >> "$SSH_CONFIG" << EOF

# curtbrag-cluster-start — managed by setup-wsl.sh, do not edit manually
Host node1
  HostName $NODE1_IP
  Port $NODE1_PORT
  User $NODE1_USER
  IdentityFile $SSH_KEY
  StrictHostKeyChecking accept-new

EOF

for entry in $PHONE_NODES; do
  [ -z "$entry" ] && continue
  name="${entry%%:*}"; ip="${entry##*:}"
  cat >> "$SSH_CONFIG" << EOF
Host $name
  HostName $ip
  Port $PHONE_PORT
  User $PHONE_USER
  IdentityFile $SSH_KEY
  StrictHostKeyChecking accept-new

EOF
done

cat >> "$SSH_CONFIG" << EOF
Host nexus-prime
  HostName 192.168.1.178
  Port $PC_PORT
  User $PC_USER
  IdentityFile $SSH_KEY
  StrictHostKeyChecking accept-new

Host vikixii
  HostName 192.168.1.180
  Port $PC_PORT
  User $PC_USER
  IdentityFile $SSH_KEY
  StrictHostKeyChecking accept-new

Host steamdeck
  HostName 100.102.66.70
  Port $PC_PORT
  User $PC_USER
  IdentityFile $SSH_KEY
  StrictHostKeyChecking accept-new
# curtbrag-cluster-end
EOF

info "~/.ssh/config updated"

# ── Step 4: Distribute node1's key to all workers ───────────────────────────
section "Step 4/5: Distribute node1→workers key"

if [ "${SKIP_KEYDIST:-0}" = "1" ]; then
  warn "SKIP_KEYDIST=1 — skipping key distribution"
elif ! ssh_works "$NODE1_PORT" "$NODE1_USER" "$NODE1_IP"; then
  warn "node1 unreachable — cannot distribute node1's key to workers"
  echo "  When node1 is back online, run: ssh node1 'sh /home/user/dist-ssh-key.sh'"
else
  echo "Connecting to node1 to distribute its key to worker phones..."

  # Generate node1's key if it doesn't exist
  ssh -p "$NODE1_PORT" $SSH_OPTS "$NODE1_USER@$NODE1_IP" '
    if [ ! -f ~/.ssh/id_ed25519 ]; then
      ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" -C "node1-cluster" >/dev/null 2>&1
      echo "KEY_GENERATED"
    else
      echo "KEY_EXISTS"
    fi
  ' && true

  NODE1_PUBKEY=$(ssh -p "$NODE1_PORT" $SSH_OPTS "$NODE1_USER@$NODE1_IP" 'cat ~/.ssh/id_ed25519.pub' 2>/dev/null || echo "")

  if [ -z "$NODE1_PUBKEY" ]; then
    warn "Could not read node1's public key"
  else
    info "Got node1 public key"

    # Install node1's key on each worker phone
    WORKER_IPS=""
    for entry in $PHONE_NODES; do
      [ -z "$entry" ] && continue
      name="${entry%%:*}"; ip="${entry##*:}"
      WORKER_IPS="$WORKER_IPS $name:$ip"
    done

    DIST_OK=0; DIST_FAIL=0
    for entry in $WORKER_IPS; do
      [ -z "$entry" ] && continue
      name="${entry%%:*}"; ip="${entry##*:}"
      # Skip node1 itself
      [ "$ip" = "$NODE1_IP" ] && continue

      # Check if node1 can already SSH to this worker
      CAN_SSH=$(ssh -p "$NODE1_PORT" $SSH_OPTS "$NODE1_USER@$NODE1_IP" \
        "ssh -p 8022 -o BatchMode=yes -o ConnectTimeout=3 -o StrictHostKeyChecking=accept-new user@$ip 'echo ok' 2>/dev/null && echo yes || echo no" 2>/dev/null || echo "no")

      if [ "$CAN_SSH" = "yes" ]; then
        info "$name ($ip): node1 already has passwordless access"
        DIST_OK=$((DIST_OK + 1))
      else
        # Try to install via WSL (since we may have key access from WSL)
        if ssh_works "$PHONE_PORT" "$PHONE_USER" "$ip"; then
          ssh -p "$PHONE_PORT" $SSH_OPTS "$PHONE_USER@$ip" \
            "mkdir -p ~/.ssh; chmod 700 ~/.ssh; \
             grep -qF '$(echo $NODE1_PUBKEY | cut -d' ' -f1-2)' ~/.ssh/authorized_keys 2>/dev/null || \
             echo '$NODE1_PUBKEY' >> ~/.ssh/authorized_keys; \
             chmod 600 ~/.ssh/authorized_keys" 2>/dev/null && {
            info "$name ($ip): node1 key installed via WSL"
            DIST_OK=$((DIST_OK + 1))
          } || {
            warn "$name ($ip): failed to install key"
            DIST_FAIL=$((DIST_FAIL + 1))
          }
        else
          warn "$name ($ip): unreachable from WSL, skipping"
          DIST_FAIL=$((DIST_FAIL + 1))
        fi
      fi
    done
    echo "  Key distribution: $DIST_OK ok, $DIST_FAIL failed/skipped"
  fi
fi

# ── Step 5: Deploy latest scripts to node1 and restart services ──────────────
section "Step 5/5: Deploy scripts to node1"

if ! ssh_works "$NODE1_PORT" "$NODE1_USER" "$NODE1_IP"; then
  warn "node1 unreachable — cannot deploy scripts"
  echo ""
  echo "  When node1 is back online, SSH in and run:"
  echo "    ssh node1"
  echo "    sh /home/user/update-from-dev.sh"
else
  echo "Deploying latest scripts to node1..."

  # Upload update-from-dev.sh directly to ensure it has correct branch
  DEV_BRANCH_NAME="claude/setup-cluster-advanced-t3WV0"
  ssh -p "$NODE1_PORT" $SSH_OPTS "$NODE1_USER@$NODE1_IP" "
    set -e
    echo '[1/3] Downloading update script...'
    wget -q -O /home/user/update-from-dev.sh.new \
      'https://raw.githubusercontent.com/curtbrag/curtbrag-website/${DEV_BRANCH_NAME}/scripts/update-from-dev.sh' \
      && mv /home/user/update-from-dev.sh.new /home/user/update-from-dev.sh \
      && chmod +x /home/user/update-from-dev.sh \
      && echo '  update-from-dev.sh downloaded' \
      || { echo '  WARN: wget failed, trying curl'; \
           curl -sSL 'https://raw.githubusercontent.com/curtbrag/curtbrag-website/${DEV_BRANCH_NAME}/scripts/update-from-dev.sh' \
             -o /home/user/update-from-dev.sh && chmod +x /home/user/update-from-dev.sh; }

    echo '[2/3] Running update-from-dev.sh...'
    sh /home/user/update-from-dev.sh

    echo '[3/3] Done!'
  " && info "Scripts deployed and poller restarted on node1" \
    || warn "Deployment had errors (check node1 logs)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
section "Summary"
echo ""
echo "Reachable nodes:"
for n in "${REACHABLE_NODES[@]}"; do
  name="${n%%:*}"
  printf "  %-14s %s\n" "$name" "(passwordless)"
done

echo ""
echo "Quick SSH access (use aliases from ~/.ssh/config):"
echo "  ssh node1          # control plane"
echo "  ssh node2          # worker phone"
echo "  ssh nexus-prime    # PC"
echo ""
echo "To redeploy scripts to node1 at any time:"
echo "  ssh node1 'sh /home/user/update-from-dev.sh'"
echo ""
echo "To re-run this setup (e.g. after adding new node):"
echo "  bash scripts/setup-wsl.sh"
echo ""
echo "Dashboard: https://www.curtbrag.com/cluster"
