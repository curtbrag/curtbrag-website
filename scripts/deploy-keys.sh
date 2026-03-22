#!/bin/sh
# Deploy node1's SSH public key to all phone nodes using sshpass (password auth)
# Then verify/start xmrig on each node.
# Run: sh /home/user/deploy-keys.sh
# Password can be overridden: SSH_PASS=xxxx sh /home/user/deploy-keys.sh

SSH_KEY="/home/user/.ssh/id_ed25519"
SSH_PUB="${SSH_KEY}.pub"
SSH_PASS="${SSH_PASS:-0735}"
SSH_PORT="${SSH_PORT:-22}"
LOG="/home/user/deploy-keys.log"

_log() { echo "$(date '+%H:%M:%S') $*" | tee -a "$LOG"; }

_log "=== deploy-keys.sh START ==="

# ── Ensure SSH keypair exists on node1 ───────────────────────────────────────
mkdir -p /home/user/.ssh
chmod 700 /home/user/.ssh

if [ ! -f "$SSH_KEY" ]; then
  _log "Generating SSH key..."
  ssh-keygen -t ed25519 -f "$SSH_KEY" -N "" -q
  _log "Generated $SSH_KEY"
fi

PUBKEY=$(cat "$SSH_PUB")
_log "Public key: $(echo "$PUBKEY" | awk '{print $3}')"

# ── Ensure sshpass is installed ───────────────────────────────────────────────
if ! command -v sshpass >/dev/null 2>&1; then
  _log "Installing sshpass..."
  doas apk add --no-progress sshpass 2>/dev/null && _log "sshpass installed" \
    || _log "WARN: sshpass install failed — continuing anyway"
fi

# ── Phone nodes 2-9 (node1=us, node10=offline) ───────────────────────────────
PHONE_NODES="node2:192.168.1.207 node3:192.168.1.208 node4:192.168.1.209 node5:192.168.1.210 node6:192.168.1.211 node7:192.168.1.212 node8:192.168.1.213 node9:192.168.1.214"

OK_KEYS=""
FAIL_KEYS=""

_log "--- Phase 1: Deploy SSH keys ---"
for entry in $PHONE_NODES; do
  name="${entry%%:*}"
  ip="${entry##*:}"
  _log "  [$name $ip] Deploying key..."

  # Create .ssh dir and set permissions
  sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" \
    -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o BatchMode=no \
    "user@$ip" \
    "mkdir -p /home/user/.ssh && chmod 700 /home/user/.ssh" 2>>"$LOG" || true

  # Append public key via stdin (avoids shell quoting issues with key content)
  if sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" \
    -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o BatchMode=no \
    "user@$ip" \
    "cat >> /home/user/.ssh/authorized_keys && chmod 600 /home/user/.ssh/authorized_keys" \
    < "$SSH_PUB" 2>>"$LOG"; then
    _log "  [$name] KEY DEPLOYED"
    OK_KEYS="$OK_KEYS $name"
  else
    _log "  [$name] KEY FAILED"
    FAIL_KEYS="$FAIL_KEYS $name"
  fi
done

_log "Key results: OK=$OK_KEYS FAIL=$FAIL_KEYS"

# ── Phase 2: Start xmrig on all phones (including node1) ─────────────────────
_log "--- Phase 2: Start/verify xmrig ---"

# node1 is local
_log "  [node1 local] Starting xmrig..."
doas systemctl start xmrig 2>/dev/null || doas rc-service xmrig start 2>/dev/null || true
sleep 2
if pgrep xmrig >/dev/null 2>&1; then
  _log "  [node1] MINING (PID: $(pgrep xmrig | head -1))"
else
  _log "  [node1] NOT RUNNING"
fi

# Nodes 2-9 via SSH (now with keys deployed)
OK_MINE=""
FAIL_MINE=""
for entry in $PHONE_NODES; do
  name="${entry%%:*}"
  ip="${entry##*:}"
  _log "  [$name] Starting xmrig..."
  RESULT=$(ssh -p "$SSH_PORT" \
    -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "user@$ip" \
    "doas systemctl start xmrig 2>/dev/null || doas rc-service xmrig start 2>/dev/null; sleep 2; pgrep xmrig >/dev/null 2>&1 && echo RUNNING || echo NOT_RUNNING" 2>/dev/null || echo "SSH_FAILED")
  _log "  [$name] $RESULT"
  case "$RESULT" in
    *RUNNING*) OK_MINE="$OK_MINE $name" ;;
    *) FAIL_MINE="$FAIL_MINE $name" ;;
  esac
done

_log "Mining results: OK=$OK_MINE FAIL=$FAIL_MINE"
_log "=== deploy-keys.sh DONE ==="

echo ""
echo "Key deploy:  OK=$OK_KEYS  FAIL=$FAIL_KEYS"
echo "Mining:      OK=$OK_MINE  FAIL=$FAIL_MINE"
echo "Full log:    $LOG"
