#!/bin/sh
# Deploy node1's SSH public key to all phone nodes using sshpass, then start xmrig.
# Runs all nodes IN PARALLEL to fit within the 30-second poller timeout.
# Run: sh /home/user/deploy-keys.sh
# Override: SSH_PASS=xxxx sh /home/user/deploy-keys.sh

SSH_KEY="/home/user/.ssh/id_ed25519"
SSH_PUB="${SSH_KEY}.pub"
SSH_PASS="${SSH_PASS:-0735}"
SSH_PORT="${SSH_PORT:-22}"
WORK_DIR="/tmp/dkwork-$$"

mkdir -p "$WORK_DIR"

# ── Ensure SSH keypair exists on node1 ───────────────────────────────────────
mkdir -p /home/user/.ssh
chmod 700 /home/user/.ssh
if [ ! -f "$SSH_KEY" ]; then
  ssh-keygen -t ed25519 -f "$SSH_KEY" -N "" -q 2>/dev/null
fi

# ── Ensure sshpass is installed ───────────────────────────────────────────────
if ! command -v sshpass >/dev/null 2>&1; then
  doas apk add --no-progress sshpass 2>/dev/null || true
fi

# ── Phone nodes 2-9 ──────────────────────────────────────────────────────────
PHONE_NODES="node2:192.168.1.207 node3:192.168.1.208 node4:192.168.1.209 node5:192.168.1.210 node6:192.168.1.211 node7:192.168.1.212 node8:192.168.1.213 node9:192.168.1.214"

# Deploy key + start xmrig on each node concurrently (parallel = fast, under 30s)
for entry in $PHONE_NODES; do
  name="${entry%%:*}"
  ip="${entry##*:}"
  (
    # Step 1: ensure .ssh dir
    sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" \
      -o ConnectTimeout=4 -o StrictHostKeyChecking=accept-new -o BatchMode=no \
      "user@$ip" \
      "mkdir -p /home/user/.ssh && chmod 700 /home/user/.ssh" 2>/dev/null || true

    # Step 2: append pub key via stdin (avoids quoting issues)
    if sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" \
      -o ConnectTimeout=4 -o StrictHostKeyChecking=accept-new -o BatchMode=no \
      "user@$ip" \
      "cat >> /home/user/.ssh/authorized_keys && chmod 600 /home/user/.ssh/authorized_keys" \
      < "$SSH_PUB" 2>/dev/null; then
      echo "key_ok" > "$WORK_DIR/$name.key"
    else
      echo "key_fail" > "$WORK_DIR/$name.key"
    fi

    # Step 3: start xmrig (key should now work)
    MINE_RESULT=$(ssh -p "$SSH_PORT" \
      -o ConnectTimeout=4 -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
      "user@$ip" \
      "doas systemctl start xmrig 2>/dev/null || doas rc-service xmrig start 2>/dev/null; sleep 2; pgrep xmrig >/dev/null 2>&1 && echo RUNNING || echo NOT_RUNNING" 2>/dev/null || echo "SSH_FAILED")
    echo "$MINE_RESULT" > "$WORK_DIR/$name.mine"
  ) &
done

# Also ensure node1 is mining
(
  doas systemctl start xmrig 2>/dev/null || doas rc-service xmrig start 2>/dev/null || true
  sleep 2
  pgrep xmrig >/dev/null 2>&1 && echo "RUNNING" || echo "NOT_RUNNING"
) > "$WORK_DIR/node1.mine" 2>/dev/null &

wait

# Report results
OK_KEYS=""; FAIL_KEYS=""
OK_MINE=""; FAIL_MINE=""

for entry in node1 $PHONE_NODES; do
  name="${entry%%:*}"
  KEY_R=$(cat "$WORK_DIR/$name.key" 2>/dev/null || echo "n/a")
  MINE_R=$(cat "$WORK_DIR/$name.mine" 2>/dev/null || echo "unknown")
  case "$KEY_R" in key_ok) OK_KEYS="$OK_KEYS $name" ;; key_fail) FAIL_KEYS="$FAIL_KEYS $name" ;; esac
  case "$MINE_R" in *RUNNING*) OK_MINE="$OK_MINE $name" ;; *) FAIL_MINE="$FAIL_MINE $name" ;; esac
  echo "$name: key=$KEY_R mine=$MINE_R"
done

rm -rf "$WORK_DIR"

echo ""
echo "Keys OK: $OK_KEYS"
echo "Keys FAIL: $FAIL_KEYS"
echo "Mining OK: $OK_MINE"
echo "Mining FAIL: $FAIL_MINE"
