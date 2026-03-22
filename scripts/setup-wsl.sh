#!/bin/bash
# One-command WSL cluster setup — run once from WSL to make everything passwordless
# Usage: bash setup-wsl.sh
# Optional env vars:
#   NODE1_PASS=...   NODE_PASS=...   PC_PASS=...   DECK_PASS=...
#   SKIP_KEYDIST=1   (skip distributing node1's key to workers)
#   DEV_BRANCH=1     (pull scripts from dev branch instead of main)
set -euo pipefail

BOLD='\033[1m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; RESET='\033[0m'
info()    { echo -e "${GREEN}✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}!${RESET} $*"; }
section() { echo -e "\n${BOLD}=== $* ===${RESET}"; }

# ── Node definitions ──────────────────────────────────────────────────────────
NODE1_IP="192.168.1.206"
NODE1_PORT=22
NODE1_USER="user"

# All phone/postmarketOS nodes — SSH on port 22 (NOT Termux 8022)
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
PHONE_PORT=22
PHONE_USER="user"

# PC nodes — SSH on port 22
PC_NODES="
nexus-prime:192.168.1.179:neo
coffee-table:192.168.1.228:neo
vikixii:192.168.1.180:neo
steamdeck:100.102.66.70:deck
"
PC_PORT=22

DEV_BRANCH_NAME="claude/setup-cluster-advanced-t3WV0"
BRANCH="${DEV_BRANCH:+$DEV_BRANCH_NAME}"
BRANCH="${BRANCH:-main}"

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

# ── Helper: test if SSH key works ─────────────────────────────────────────────
ssh_works() {
  local port="$1" user="$2" ip="$3"
  ssh -p "$port" -o BatchMode=yes -o ConnectTimeout=3 -o StrictHostKeyChecking=accept-new \
    "$user@$ip" "echo ok" >/dev/null 2>&1
}

# ── Helper: copy SSH key, with optional password via sshpass ─────────────────
copy_key() {
  local port="$1" user="$2" ip="$3" name="$4" pass="${5:-}"
  if ssh_works "$port" "$user" "$ip"; then
    info "$name ($ip:$port): already passwordless"
    echo "$name:$ip:$port:$user"
    return 0
  fi
  echo ""
  echo "  Installing key → $name ($user@$ip:$port)"
  if [ -n "$pass" ] && command -v sshpass >/dev/null 2>&1; then
    sshpass -p "$pass" ssh-copy-id -p "$port" $SSH_OPTS -i "${SSH_KEY}.pub" "$user@$ip" 2>/dev/null && {
      info "$name: key installed"
      echo "$name:$ip:$port:$user"
      return 0
    }
  fi
  ssh-copy-id -p "$port" $SSH_OPTS -i "${SSH_KEY}.pub" "$user@$ip" 2>&1 && {
    info "$name: key installed"
    echo "$name:$ip:$port:$user"
    return 0
  } || {
    warn "$name: unreachable or wrong password — skipping"
    return 1
  }
}

# ── Step 2: Install WSL key on all nodes ─────────────────────────────────────
section "Step 2/5: Copy WSL key to all nodes"
echo "You'll be prompted for each node's SSH password if key isn't installed yet."
echo ""

REACHABLE=""

# node1
if out=$(copy_key "$NODE1_PORT" "$NODE1_USER" "$NODE1_IP" "node1" "${NODE1_PASS:-}" 2>&1); then
  echo "$out" | grep -E "^node" && REACHABLE="$REACHABLE node1:$NODE1_IP:$NODE1_PORT:$NODE1_USER" || true
fi

# phone workers
for entry in $PHONE_NODES; do
  [ -z "$entry" ] && continue
  name="${entry%%:*}"; ip="${entry##*:}"
  if copy_key "$PHONE_PORT" "$PHONE_USER" "$ip" "$name" "${NODE_PASS:-}" >/dev/null 2>&1; then
    REACHABLE="$REACHABLE $name:$ip:$PHONE_PORT:$PHONE_USER"
    info "$name ($ip): passwordless"
  fi
done

# PC nodes (each has its own user)
for entry in $PC_NODES; do
  [ -z "$entry" ] && continue
  name="${entry%%:*}"; rest="${entry#*:}"; ip="${rest%%:*}"; pcuser="${rest##*:}"
  pass_var=""
  case "$name" in
    steamdeck) pass_var="${DECK_PASS:-}" ;;
    *)         pass_var="${PC_PASS:-}" ;;
  esac
  if copy_key "$PC_PORT" "$pcuser" "$ip" "$name" "$pass_var" >/dev/null 2>&1; then
    REACHABLE="$REACHABLE $name:$ip:$PC_PORT:$pcuser"
    info "$name ($ip): passwordless"
  fi
done

# ── Step 3: Write ~/.ssh/config ───────────────────────────────────────────────
section "Step 3/5: SSH config"
SSH_CONFIG="$HOME/.ssh/config"
touch "$SSH_CONFIG"
chmod 600 "$SSH_CONFIG"

# Remove old curtbrag cluster block
if grep -q "# curtbrag-cluster-start" "$SSH_CONFIG" 2>/dev/null; then
  sed -i '/# curtbrag-cluster-start/,/# curtbrag-cluster-end/d' "$SSH_CONFIG"
fi

{
  echo ""
  echo "# curtbrag-cluster-start — managed by setup-wsl.sh"
  echo "Host node1"
  echo "  HostName $NODE1_IP"
  echo "  Port $NODE1_PORT"
  echo "  User $NODE1_USER"
  echo "  IdentityFile $SSH_KEY"
  echo "  StrictHostKeyChecking accept-new"
  echo ""
  i=2
  for entry in $PHONE_NODES; do
    [ -z "$entry" ] && continue
    name="${entry%%:*}"; ip="${entry##*:}"
    echo "Host $name"
    echo "  HostName $ip"
    echo "  Port $PHONE_PORT"
    echo "  User $PHONE_USER"
    echo "  IdentityFile $SSH_KEY"
    echo "  StrictHostKeyChecking accept-new"
    echo ""
  done
  for entry in $PC_NODES; do
    [ -z "$entry" ] && continue
    name="${entry%%:*}"; rest="${entry#*:}"; ip="${rest%%:*}"; pcuser="${rest##*:}"
    echo "Host $name"
    echo "  HostName $ip"
    echo "  Port $PC_PORT"
    echo "  User $pcuser"
    echo "  IdentityFile $SSH_KEY"
    echo "  StrictHostKeyChecking accept-new"
    echo ""
  done
  echo "# curtbrag-cluster-end"
} >> "$SSH_CONFIG"

info "~/.ssh/config updated"

# ── Step 4: Distribute node1's key to all workers ────────────────────────────
section "Step 4/5: Distribute node1→workers key"

if [ "${SKIP_KEYDIST:-0}" = "1" ]; then
  warn "SKIP_KEYDIST=1 — skipping"
elif ! ssh_works "$NODE1_PORT" "$NODE1_USER" "$NODE1_IP"; then
  warn "node1 ($NODE1_IP) is offline — key distribution skipped"
  echo "  Once node1 is back: ssh node1 'sh /home/user/setup-wsl.sh' is not needed,"
  echo "  just run:  bash scripts/setup-wsl.sh  again from WSL"
else
  echo "Getting node1's public key..."
  ssh -p "$NODE1_PORT" $SSH_OPTS "$NODE1_USER@$NODE1_IP" '
    [ ! -f ~/.ssh/id_ed25519 ] && ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" -C "node1-cluster" >/dev/null 2>&1
  '
  NODE1_PUBKEY=$(ssh -p "$NODE1_PORT" $SSH_OPTS "$NODE1_USER@$NODE1_IP" 'cat ~/.ssh/id_ed25519.pub' 2>/dev/null || echo "")

  if [ -z "$NODE1_PUBKEY" ]; then
    warn "Could not read node1 public key"
  else
    info "Got node1 public key"
    DIST_OK=0; DIST_FAIL=0
    for entry in $PHONE_NODES; do
      [ -z "$entry" ] && continue
      name="${entry%%:*}"; ip="${entry##*:}"
      # Check if node1 can already SSH to this worker
      CAN=$(ssh -p "$NODE1_PORT" $SSH_OPTS "$NODE1_USER@$NODE1_IP" \
        "ssh -p 22 -o BatchMode=yes -o ConnectTimeout=3 -o StrictHostKeyChecking=accept-new user@$ip 'echo ok' 2>/dev/null && echo yes || echo no" 2>/dev/null || echo no)
      if [ "$CAN" = "yes" ]; then
        info "$name: node1 already has access"
        DIST_OK=$((DIST_OK+1))
      elif ssh_works "$PHONE_PORT" "$PHONE_USER" "$ip"; then
        # Install via WSL
        KEY_SHORT=$(echo "$NODE1_PUBKEY" | cut -d' ' -f1-2)
        ssh -p "$PHONE_PORT" $SSH_OPTS "$PHONE_USER@$ip" \
          "mkdir -p ~/.ssh; chmod 700 ~/.ssh; grep -qF '$KEY_SHORT' ~/.ssh/authorized_keys 2>/dev/null || echo '$NODE1_PUBKEY' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys" 2>/dev/null && {
          info "$name: node1 key installed via WSL"
          DIST_OK=$((DIST_OK+1))
        } || {
          warn "$name: key install failed"
          DIST_FAIL=$((DIST_FAIL+1))
        }
      else
        warn "$name: unreachable from WSL"
        DIST_FAIL=$((DIST_FAIL+1))
      fi
    done
    echo "  Result: $DIST_OK ok, $DIST_FAIL skipped/failed"
  fi
fi

# ── Step 5: Deploy latest scripts to node1 ───────────────────────────────────
section "Step 5/5: Deploy scripts to node1"

if ! ssh_works "$NODE1_PORT" "$NODE1_USER" "$NODE1_IP"; then
  warn "node1 is offline — cannot deploy scripts now"
  echo ""
  echo "  When node1 comes back online, run:"
  echo "    bash scripts/setup-wsl.sh"
  echo "  OR manually:"
  echo "    ssh node1 'sh /home/user/update-from-dev.sh'"
else
  echo "Deploying to node1..."
  ssh -p "$NODE1_PORT" $SSH_OPTS "$NODE1_USER@$NODE1_IP" "
    set -e
    echo '[1/3] Fetching update-from-dev.sh...'
    wget -q -O /tmp/update-from-dev.sh \
      'https://raw.githubusercontent.com/curtbrag/curtbrag-website/${DEV_BRANCH_NAME}/scripts/update-from-dev.sh' \
      || curl -sSL 'https://raw.githubusercontent.com/curtbrag/curtbrag-website/${DEV_BRANCH_NAME}/scripts/update-from-dev.sh' \
           -o /tmp/update-from-dev.sh
    cp /tmp/update-from-dev.sh /home/user/update-from-dev.sh
    chmod +x /home/user/update-from-dev.sh
    echo '[2/3] Running update-from-dev.sh...'
    sh /home/user/update-from-dev.sh
    echo '[3/3] Done!'
  " && info "Scripts deployed and poller restarted on node1" \
    || warn "Deployment had errors (check node1 logs: ssh node1 'tail -20 /home/user/cluster-poll.log')"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
section "Done"
echo ""
echo "Reachable nodes this run:"
for n in $REACHABLE; do
  name="${n%%:*}"; rest="${n#*:}"; ip="${rest%%:*}"
  printf "  %-14s %s\n" "$name" "$ip"
done

echo ""
echo "Quick SSH:"
echo "  ssh node1        # control plane  (user@$NODE1_IP)"
echo "  ssh node2        # worker         (user@192.168.1.207)"
echo "  ssh nexus-prime  # PC             (neo@192.168.1.179)"
echo "  ssh coffee-table # PC             (neo@192.168.1.228)"
echo "  ssh vikixii      # PC             (neo@192.168.1.180)"
echo "  ssh steamdeck    # PC             (deck@100.102.66.70 via Tailscale)"
echo ""
echo "Re-run anytime a node comes back online or changes IP:"
echo "  bash scripts/setup-wsl.sh"
echo ""
echo "Dashboard: https://www.curtbrag.com/cluster"
