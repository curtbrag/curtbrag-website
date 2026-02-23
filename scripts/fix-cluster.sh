#!/bin/sh
# One-command fix for curtbrag cluster
# Run on node1: curl -sSL https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts/fix-cluster.sh | sh
# Or: sh fix-cluster.sh
# Works with systemd, OpenRC, or bare Alpine (no init system)

# Bootstrap: busybox ash has pipe-buffering bugs that corrupt parsing when
# a script is piped via curl|sh. Detect piped execution, re-download to a
# temp file, and exec from there so the shell reads from a seekable file.
if [ ! -t 0 ] && [ "${_FCS:-}" != "1" ]; then
  _f="/tmp/fix-cluster.sh"
  curl -sfL "https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts/fix-cluster.sh" -o "$_f"
  if [ -s "$_f" ]; then
    _FCS=1 exec sh "$_f"
  fi
  echo "Bootstrap download failed" >&2
  exit 1
fi

set -e
BRANCH="main"
BASE="https://raw.githubusercontent.com/curtbrag/curtbrag-website/$BRANCH/scripts"
DIR="${HOME:-/home/user}"
ENV_FILE="$DIR/.cluster-env"
SCRIPT_DIR="$DIR"

echo "=== Fixing curtbrag cluster ==="

# Source shared library (download if missing)
if [ ! -f "$DIR/cluster-lib.sh" ]; then
  curl -sfL "$BASE/cluster-lib.sh" -o "$DIR/cluster-lib.sh" 2>/dev/null || true
fi
if [ -f "$DIR/cluster-lib.sh" ]; then
  . "$DIR/cluster-lib.sh"
  detect_priv
  load_nodes || true
else
  # Fallback: inline priv detection if lib unavailable
  if command -v doas >/dev/null 2>&1; then PRIV="doas"
  elif command -v sudo >/dev/null 2>&1; then PRIV="sudo"
  else PRIV=""; fi
fi

# Detect init system
INIT_SYSTEM=$(detect_init 2>/dev/null || echo "none")
echo "Init system: $INIT_SYSTEM"

# ── Ensure CLUSTER_API_KEY is available ──────────────────────────
# Priority: current env > .cluster-env file > running poller process > prompt
echo ""
echo "[0/5] Checking API key..."
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

if [ -z "${CLUSTER_API_KEY:-}" ]; then
  # Try to recover from a running poller process (it has the key in its env)
  POLLER_PID=$(pgrep -f "poll-cluster-commands" 2>/dev/null | head -1 || true)
  if [ -n "$POLLER_PID" ] && [ -r "/proc/$POLLER_PID/environ" ]; then
    RECOVERED_KEY=$(tr '\0' '\n' < "/proc/$POLLER_PID/environ" 2>/dev/null | grep '^CLUSTER_API_KEY=' | cut -d= -f2-)
    if [ -n "$RECOVERED_KEY" ]; then
      export CLUSTER_API_KEY="$RECOVERED_KEY"
      echo "  Recovered API key from running poller (PID $POLLER_PID)"
    fi
  fi
fi

if [ -z "${CLUSTER_API_KEY:-}" ]; then
  # Try to fetch API key using the web dashboard password
  echo "  API key not found locally. Trying to fetch from API..."
  if [ -n "${CLUSTER_WEB_PASSWORD:-}" ]; then
    WEB_PW="$CLUSTER_WEB_PASSWORD"
  else
    printf "  Enter dashboard password (or Ctrl+C to cancel): "
    read -r WEB_PW
  fi
  if [ -n "$WEB_PW" ]; then
    # URL-encode the password for the query parameter
    ENCODED_PW=$(printf '%s' "$WEB_PW" | curl -Gso /dev/null -w '%{url_effective}' --data-urlencode @- '' 2>/dev/null | cut -c3- || printf '%s' "$WEB_PW")
    FETCH_RESP=$(curl -sf "https://curtbrag.com/.netlify/functions/cluster-control?action=get-api-key&password=$ENCODED_PW" 2>/dev/null)
    FETCHED_KEY=$(echo "$FETCH_RESP" | jq -r '.apiKey // empty' 2>/dev/null)
    if [ -n "$FETCHED_KEY" ]; then
      export CLUSTER_API_KEY="$FETCHED_KEY"
      echo "  Retrieved API key from server"
    else
      ERROR_MSG=$(echo "$FETCH_RESP" | jq -r '.error // empty' 2>/dev/null)
      echo "  Failed to retrieve key: ${ERROR_MSG:-no response}"
    fi
  fi
fi

if [ -z "${CLUSTER_API_KEY:-}" ]; then
  echo "  ERROR: CLUSTER_API_KEY not found"
  echo ""
  echo "  Options:"
  echo "    export CLUSTER_API_KEY=your-key && sh fix-cluster.sh"
  echo "    CLUSTER_WEB_PASSWORD=your-pw sh fix-cluster.sh"
  echo "    Check Netlify site settings for the key value"
  exit 1
fi

# Save/update the env file (no 'export' — systemd EnvironmentFile can't parse it)
echo "CLUSTER_API_KEY=\"$CLUSTER_API_KEY\"" > "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "  API key saved to $ENV_FILE"

# Bootstrap credentials into Netlify Blobs if web password is available
# Without this, Netlify functions return 401/503 (no env vars set on Netlify)
if [ -n "${CLUSTER_WEB_PASSWORD:-}" ]; then
  echo "  Bootstrapping credentials into Netlify..."
  BOOTSTRAP_RESP=$(curl -sf -X POST "https://curtbrag.com/.netlify/functions/cluster-control" \
    -H "Content-Type: application/json" \
    -d "{\"action\":\"setup-credentials\",\"apiKey\":\"${CLUSTER_API_KEY}\",\"webPassword\":\"${CLUSTER_WEB_PASSWORD}\"}" 2>/dev/null || echo "")
  if echo "$BOOTSTRAP_RESP" | grep -q '"success"'; then
    echo "  Credentials stored in Netlify Blobs"
  elif echo "$BOOTSTRAP_RESP" | grep -q 'already configured'; then
    echo "  Credentials already configured"
  else
    echo "  Note: Credential bootstrap response: ${BOOTSTRAP_RESP:-no response}"
  fi
fi

# Step 1: Download fixed scripts
echo "[1/5] Downloading fixed scripts..."
for s in cluster-lib.sh push-cluster-status.sh poll-cluster-commands.sh cluster-nodes.conf; do
  curl -sfL "$BASE/$s" -o "$DIR/$s.new" && chmod +x "$DIR/$s.new" && mv "$DIR/$s.new" "$DIR/$s" && echo "  Updated $s" || echo "  FAILED: $s"
done

# Step 2: Restart poller (init-system-aware)
echo "[2/5] Restarting poller..."
pkill -f "poll-cluster-commands" 2>/dev/null || true
sleep 1

if [ "$INIT_SYSTEM" = "systemd" ]; then
  # Always write service file (ensures EnvironmentFile is present)
  # NOTE: using printf instead of heredoc because heredocs break in busybox ash
  # when the script is piped through curl | sh (pipe buffering issue)
  printf '%s\n' '[Unit]' 'Description=curtbrag.com Cluster Command Poller' 'After=network-online.target' 'Wants=network-online.target' '' '[Service]' 'Type=simple' 'User=user' 'EnvironmentFile=-/home/user/.cluster-env' 'ExecStart=/home/user/poll-cluster-commands.sh' 'Restart=always' 'RestartSec=5' 'StandardOutput=append:/home/user/cluster-poll.log' 'StandardError=append:/home/user/cluster-poll.log' '' '[Install]' 'WantedBy=multi-user.target' | $PRIV tee /etc/systemd/system/cluster-poll.service > /dev/null

  # Also fix the push timer service to include EnvironmentFile
  printf '%s\n' '[Unit]' 'Description=curtbrag.com Cluster Status Push' 'After=network-online.target' 'Wants=network-online.target' '' '[Service]' 'Type=oneshot' 'User=user' 'EnvironmentFile=-/home/user/.cluster-env' 'ExecStart=/home/user/push-cluster-status.sh' 'StandardOutput=append:/home/user/cluster-push.log' 'StandardError=append:/home/user/cluster-push.log' | $PRIV tee /etc/systemd/system/cluster-push.service > /dev/null

  $PRIV systemctl daemon-reload
  $PRIV systemctl enable cluster-poll 2>/dev/null || true
  $PRIV systemctl restart cluster-poll
  echo "  Poller restarted (systemd)"
elif [ "$INIT_SYSTEM" = "openrc" ]; then
  $PRIV rc-service cluster-poll restart 2>/dev/null || {
    # Service might not exist yet — start manually
    nohup "$DIR/poll-cluster-commands.sh" >> "$DIR/cluster-poll.log" 2>&1 &
  }
  echo "  Poller restarted (openrc)"
else
  # No init system — use nohup
  (
    [ -f "$ENV_FILE" ] && . "$ENV_FILE"
    exec "$DIR/poll-cluster-commands.sh"
  ) >> "$DIR/cluster-poll.log" 2>&1 &
  disown 2>/dev/null || true
  echo "  Poller restarted (nohup, PID: $!)"
fi

# Step 3: Restart push loop
echo "[3/5] Restarting push schedule..."
pkill -f "cluster-push-loop" 2>/dev/null || true

if [ "$INIT_SYSTEM" = "systemd" ]; then
  $PRIV systemctl restart cluster-push.timer 2>/dev/null || true
  echo "  Push timer restarted (systemd)"
else
  # Create/update the push loop wrapper
  printf '%s\n' '#!/bin/sh' '[ -f /home/user/.cluster-env ] && . /home/user/.cluster-env' 'while true; do' '  /home/user/push-cluster-status.sh >> /home/user/cluster-push.log 2>&1 || true' '  sleep 300' 'done' > "$DIR/cluster-push-loop.sh"
  chmod +x "$DIR/cluster-push-loop.sh"
  nohup "$DIR/cluster-push-loop.sh" >> "$DIR/cluster-push.log" 2>&1 &
  echo "  Push loop started (PID: $!)"
fi

# Step 4: Check xmrig on all nodes
echo "[4/5] Diagnosing xmrig on all nodes..."
# Start xmrig command that works across init systems (uses remote priv detection)
XMRIG_DIAG_CMD='
  HAS_BIN="no"; { command -v xmrig >/dev/null 2>&1 || [ -f /usr/local/bin/xmrig ]; } && HAS_BIN="yes"
  HAS_SVC="no"; { [ -f /etc/init.d/xmrig ] || [ -f /etc/systemd/system/xmrig.service ]; } && HAS_SVC="yes"
  HAS_CFG="no"; [ -f /etc/xmrig/config.json ] && HAS_CFG="yes"
  IS_RUN="no"; pgrep xmrig >/dev/null 2>&1 && IS_RUN="yes"
  echo "binary=$HAS_BIN service=$HAS_SVC config=$HAS_CFG running=$IS_RUN"
'
for entry in $ALL_NODES; do
  NODE="${entry%%:*}"
  NODE_IP="${entry#*:}"
  DIAG=$(run_on_node "$NODE_IP" "$XMRIG_DIAG_CMD" 2>/dev/null || echo "UNREACHABLE")
  echo "  $NODE: $DIAG"
done

# Step 5: Start mining on all nodes
echo "[5/5] Starting mining on all nodes..."
START_XMRIG_CMD='P=$(command -v doas >/dev/null 2>&1 && echo doas || echo sudo); $P rc-service xmrig start 2>/dev/null || $P systemctl start xmrig 2>/dev/null || true; sleep 2; pgrep xmrig >/dev/null 2>&1 && echo MINING || echo FAILED'
STARTED=0
FAILED=0
for entry in $ALL_NODES; do
  NODE="${entry%%:*}"
  NODE_IP="${entry#*:}"
  RESULT=$(run_on_node "$NODE_IP" "$START_XMRIG_CMD" 2>/dev/null || echo "UNREACHABLE")
  echo "  $NODE: $RESULT"
  case "$RESULT" in
    *MINING*) STARTED=$((STARTED + 1)) ;;
    *) FAILED=$((FAILED + 1)) ;;
  esac
done

echo ""
echo "Mining: $STARTED running, $FAILED failed"

# Push fresh status
echo ""
echo "Pushing fresh status..."
if "$DIR/push-cluster-status.sh" 2>&1; then
  echo "  Status pushed!"
else
  echo "  Status push had errors (check $DIR/cluster-push.log)"
fi

# Verify services are running
echo ""
echo "=== Service Status ==="
sleep 2
POLL_PID=$(pgrep -f "poll-cluster-commands" 2>/dev/null | head -1 || echo "NOT RUNNING")
echo "Poller PID:    $POLL_PID"
if [ "$INIT_SYSTEM" = "systemd" ]; then
  PUSH_STATUS=$(systemctl is-active cluster-push.timer 2>/dev/null || echo "inactive")
  echo "Push timer:    $PUSH_STATUS"
else
  PUSH_PID=$(pgrep -f "cluster-push-loop" 2>/dev/null | head -1 || echo "NOT RUNNING")
  echo "Push loop PID: $PUSH_PID"
fi
echo "Env file:      $ENV_FILE ($([ -f "$ENV_FILE" ] && echo "exists" || echo "MISSING"))"
echo "API key:       $(printf '%.8s' "$CLUSTER_API_KEY")..."

echo ""
echo "=== Done ==="
echo "Dashboard: https://www.curtbrag.com/cluster"
echo ""
echo "If miners show FAILED, run setup-mining.sh to install xmrig:"
echo "  bash scripts/setup-mining.sh --wallet YOUR_XMR_WALLET"
