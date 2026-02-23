#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════════╗
# ║  Phone Cluster AI Kit — One-Command Setup                           ║
# ║                                                                     ║
# ║  Sets up the complete AI content pipeline:                          ║
# ║    1. Folder structure on NEXUS (inbox/work/done/results)          ║
# ║    2. Redis job queue on NEXUS                                     ║
# ║    3. Worker deps on all phones (python, ffmpeg, imagemagick)      ║
# ║    4. Enhanced worker.py deployed to all phones                    ║
# ║    5. Dispatcher on NEXUS (inbox watcher)                          ║
# ║    6. Optional: whisper.cpp + llama.cpp on phones                  ║
# ║                                                                     ║
# ║  Usage:                                                             ║
# ║    bash scripts/setup-ai-kit.sh --password 0735                    ║
# ║    bash scripts/setup-ai-kit.sh --password 0735 --with-ai          ║
# ║    bash scripts/setup-ai-kit.sh --password 0735 --nodes node2,node5 ║
# ╚══════════════════════════════════════════════════════════════════════╝

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER_DIR="${CLUSTER_DIR:-$HOME/cluster}"

# Source node config
if [ -f "$SCRIPT_DIR/cluster-nodes.conf" ]; then
  . "$SCRIPT_DIR/cluster-nodes.conf"
  load_node_config
fi

# Parse args
SSH_PORT="${SSH_PORT:-22}"
BUILD_WHISPER=0
BUILD_LLAMA=0
WHISPER_MODEL="base"
SKIP_REDIS=0
SKIP_PHONES=0
SKIP_DISPATCHER=0
TARGET_NODES=""
REDIS_HOST=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --password) SSH_PASS="$2"; shift 2;;
    --ssh-port) SSH_PORT="$2"; shift 2;;
    --cluster-dir) CLUSTER_DIR="$2"; shift 2;;
    --redis-host) REDIS_HOST="$2"; shift 2;;
    --with-whisper) BUILD_WHISPER=1; shift;;
    --whisper-model) WHISPER_MODEL="$2"; shift 2;;
    --with-llama) BUILD_LLAMA=1; shift;;
    --with-ai) BUILD_WHISPER=1; BUILD_LLAMA=1; shift;;
    --skip-redis) SKIP_REDIS=1; shift;;
    --skip-phones) SKIP_PHONES=1; shift;;
    --skip-dispatcher) SKIP_DISPATCHER=1; shift;;
    --nodes) TARGET_NODES="$2"; shift 2;;
    -h|--help)
      echo "Usage: $0 [options]"
      echo ""
      echo "Setup options:"
      echo "  --password PASS       SSH password for phone nodes"
      echo "  --cluster-dir DIR     Base directory (default: ~/cluster)"
      echo "  --redis-host IP       Redis host IP (default: auto-detect local IP)"
      echo "  --nodes LIST          Comma-separated node names: node2,node5 (default: all workers)"
      echo ""
      echo "Skip steps:"
      echo "  --skip-redis          Skip Redis setup (already installed)"
      echo "  --skip-phones         Skip phone deployment (NEXUS-only setup)"
      echo "  --skip-dispatcher     Skip dispatcher setup"
      echo ""
      echo "AI options:"
      echo "  --with-whisper        Build whisper.cpp on phone nodes"
      echo "  --whisper-model NAME  Whisper model: tiny|base|small (default: base)"
      echo "  --with-llama          Build llama.cpp on phone nodes"
      echo "  --with-ai             Enable both whisper and llama"
      exit 0;;
    *) shift;;
  esac
done

# Auto-detect Redis host if not specified — use this machine's IP on the cluster network
if [ -z "$REDIS_HOST" ]; then
  REDIS_HOST=$(ip -4 addr show eth0 2>/dev/null | grep -o 'inet [0-9.]*' | cut -d' ' -f2)
  [ -z "$REDIS_HOST" ] && REDIS_HOST=$(ip -4 addr show wlan0 2>/dev/null | grep -o 'inet [0-9.]*' | cut -d' ' -f2)
  [ -z "$REDIS_HOST" ] && REDIS_HOST="127.0.0.1"
fi

ssh_cmd() {
  local target="$1"; shift
  if [ -n "${SSH_PASS:-}" ]; then
    sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "$target" "$@"
  else
    ssh -p "$SSH_PORT" -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$target" "$@"
  fi
}

scp_cmd() {
  local src="$1" dst="$2"
  if [ -n "${SSH_PASS:-}" ]; then
    sshpass -p "$SSH_PASS" scp -P "$SSH_PORT" -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "$src" "$dst" 2>/dev/null
  else
    scp -P "$SSH_PORT" -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "$src" "$dst" 2>/dev/null
  fi
}

banner() {
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${CYAN}  $1${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║         PHONE CLUSTER AI KIT — SETUP                       ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Base dir:    ${CLUSTER_DIR}"
echo -e "  Redis host:  ${REDIS_HOST}"
echo -e "  Whisper:     $([ $BUILD_WHISPER -eq 1 ] && echo "YES (model: $WHISPER_MODEL)" || echo "no")"
echo -e "  LLaMA:       $([ $BUILD_LLAMA -eq 1 ] && echo "YES" || echo "no")"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Step 1: Create folder structure on NEXUS
# ═══════════════════════════════════════════════════════════════════════════════

banner "Step 1/5: Folder Structure"

mkdir -p "$CLUSTER_DIR"/{inbox,work,done,results/{images,audio,text},logs,models}

echo -e "  ${GREEN}✓${NC} $CLUSTER_DIR/inbox/         ← Drop files here"
echo -e "  ${GREEN}✓${NC} $CLUSTER_DIR/work/          ← Files being processed"
echo -e "  ${GREEN}✓${NC} $CLUSTER_DIR/done/          ← Originals after processing"
echo -e "  ${GREEN}✓${NC} $CLUSTER_DIR/results/images/ ← Resized, WebP, thumbnails"
echo -e "  ${GREEN}✓${NC} $CLUSTER_DIR/results/audio/  ← Transcripts, VTT subtitles"
echo -e "  ${GREEN}✓${NC} $CLUSTER_DIR/results/text/   ← Summaries, SEO metadata"
echo -e "  ${GREEN}✓${NC} $CLUSTER_DIR/logs/          ← Dispatcher + worker logs"
echo -e "  ${GREEN}✓${NC} $CLUSTER_DIR/models/        ← Shared AI models"

# ═══════════════════════════════════════════════════════════════════════════════
# Step 2: Redis
# ═══════════════════════════════════════════════════════════════════════════════

banner "Step 2/5: Redis Job Queue"

if [ $SKIP_REDIS -eq 1 ]; then
  echo -e "  ${YELLOW}Skipped (--skip-redis)${NC}"
elif command -v redis-server &>/dev/null && redis-cli ping 2>/dev/null | grep -q PONG; then
  echo -e "  ${GREEN}✓${NC} Redis already running"
else
  echo -e "  Installing Redis..."
  bash "$SCRIPT_DIR/setup-redis.sh"
fi

# Verify Redis
if redis-cli ping 2>/dev/null | grep -q PONG; then
  echo -e "  ${GREEN}✓${NC} Redis: PONG"
else
  echo -e "  ${RED}✗${NC} Redis not responding — phone workers won't be able to connect"
  echo -e "  ${YELLOW}  Run: bash scripts/setup-redis.sh${NC}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Step 3: Deploy to phone nodes
# ═══════════════════════════════════════════════════════════════════════════════

banner "Step 3/5: Phone Node Setup"

if [ $SKIP_PHONES -eq 1 ]; then
  echo -e "  ${YELLOW}Skipped (--skip-phones)${NC}"
else
  # Build deploy args — pass redis-host so workers connect to the right place
  DEPLOY_ARGS="--password ${SSH_PASS:-} --redis-host $REDIS_HOST"
  [ $BUILD_WHISPER -eq 1 ] && DEPLOY_ARGS="$DEPLOY_ARGS --with-whisper --whisper-model $WHISPER_MODEL"
  [ $BUILD_LLAMA -eq 1 ] && DEPLOY_ARGS="$DEPLOY_ARGS --with-llama"
  [ -n "$TARGET_NODES" ] && DEPLOY_ARGS="$DEPLOY_ARGS --nodes $TARGET_NODES"

  # Install ffmpeg + imagemagick on phone nodes (content pipeline deps)
  # deploy-workers.sh handles python, worker.py, and service setup
  echo -e "  ${YELLOW}Installing content pipeline dependencies on phones...${NC}"

  # Use PHONE_NODES from cluster-nodes.conf (filtered by TARGET_NODES if specified)
  DEPS_NODES="$PHONE_NODES"
  if [ -n "$TARGET_NODES" ]; then
    DEPS_NODES=""
    for tname in $(echo "$TARGET_NODES" | tr ',' ' '); do
      for entry in $PHONE_NODES; do
        ENAME="${entry%%:*}"
        if [ "$ENAME" = "$tname" ]; then
          DEPS_NODES="${DEPS_NODES:+$DEPS_NODES }${entry}"
        fi
      done
    done
  fi

  for entry in $DEPS_NODES; do
    NAME="${entry%%:*}"
    IP="${entry#*:}"

    printf "  %-8s (%s): " "$NAME" "$IP"

    if ! timeout 10 ssh_cmd "user@$IP" "echo ok" &>/dev/null; then
      echo -e "${RED}unreachable${NC}"
      continue
    fi

    # Install ffmpeg + imagemagick (content pipeline deps) — 90s timeout
    if ! timeout 90 ssh_cmd "user@$IP" "doas apk add ffmpeg imagemagick python3 2>/dev/null" &>/dev/null; then
      echo -e "${YELLOW}timeout/failed${NC}"
      continue
    fi

    echo -e "${GREEN}deps installed${NC}"
  done

  echo ""
  echo -e "  ${YELLOW}Deploying workers...${NC}"
  bash "$SCRIPT_DIR/deploy-workers.sh" $DEPLOY_ARGS || echo -e "  ${RED}Worker deployment had errors — check output above${NC}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Step 4: Dispatcher setup on NEXUS
# ═══════════════════════════════════════════════════════════════════════════════

banner "Step 4/5: Dispatcher (Inbox Watcher)"

if [ $SKIP_DISPATCHER -eq 1 ]; then
  echo -e "  ${YELLOW}Skipped (--skip-dispatcher)${NC}"
else
  # Copy dispatcher to cluster dir
  cp "$SCRIPT_DIR/dispatcher.py" "$CLUSTER_DIR/dispatcher.py"
  chmod +x "$CLUSTER_DIR/dispatcher.py"
  echo -e "  ${GREEN}✓${NC} Dispatcher copied to $CLUSTER_DIR/dispatcher.py"

  # Detect privilege escalation command
  PRIV="sudo"
  command -v sudo &>/dev/null || PRIV="doas"

  # Create service for dispatcher
  if command -v systemctl &>/dev/null; then
    $PRIV tee /etc/systemd/system/cluster-dispatcher.service > /dev/null << DSVC
[Unit]
Description=Cluster AI Dispatcher — inbox watcher
After=network-online.target redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=$USER
Environment=CLUSTER_DIR=$CLUSTER_DIR
Environment=REDIS_HOST=$REDIS_HOST
ExecStart=/usr/bin/python3 $CLUSTER_DIR/dispatcher.py
Restart=always
RestartSec=10
StandardOutput=append:$CLUSTER_DIR/logs/dispatcher.log
StandardError=append:$CLUSTER_DIR/logs/dispatcher.log

[Install]
WantedBy=multi-user.target
DSVC
    $PRIV systemctl daemon-reload
    $PRIV systemctl enable cluster-dispatcher
    $PRIV systemctl restart cluster-dispatcher
    sleep 2

    if systemctl is-active --quiet cluster-dispatcher; then
      echo -e "  ${GREEN}✓${NC} Dispatcher running (systemd)"
    else
      echo -e "  ${RED}✗${NC} Dispatcher failed to start"
      echo -e "  ${YELLOW}  Check: sudo journalctl -u cluster-dispatcher -n 20${NC}"
    fi
  elif command -v rc-service &>/dev/null || test -f /sbin/openrc-run; then
    # OpenRC (postmarketOS / Alpine)
    $PRIV tee /etc/init.d/cluster-dispatcher > /dev/null << 'ORCSVC'
#!/sbin/openrc-run
name="cluster-dispatcher"
description="Cluster AI Dispatcher — inbox watcher"
command="/usr/bin/python3"
command_args="CLUSTER_DIR_PLACEHOLDER/dispatcher.py"
command_user="user"
command_background="yes"
pidfile="/run/cluster-dispatcher.pid"
output_log="CLUSTER_DIR_PLACEHOLDER/logs/dispatcher.log"
error_log="CLUSTER_DIR_PLACEHOLDER/logs/dispatcher.log"

depend() { need net; }

start_pre() {
  export CLUSTER_DIR="CLUSTER_DIR_PLACEHOLDER"
  export REDIS_HOST="REDIS_HOST_PLACEHOLDER"
}
ORCSVC
    # Replace placeholders with actual values
    $PRIV sed -i "s|CLUSTER_DIR_PLACEHOLDER|$CLUSTER_DIR|g" /etc/init.d/cluster-dispatcher
    $PRIV sed -i "s|REDIS_HOST_PLACEHOLDER|$REDIS_HOST|g" /etc/init.d/cluster-dispatcher
    $PRIV chmod +x /etc/init.d/cluster-dispatcher
    $PRIV rc-update add cluster-dispatcher default 2>/dev/null || true
    $PRIV rc-service cluster-dispatcher restart 2>/dev/null || true
    sleep 2
    if pgrep -f "dispatcher.py" >/dev/null 2>&1; then
      echo -e "  ${GREEN}✓${NC} Dispatcher running (OpenRC)"
    else
      echo -e "  ${RED}✗${NC} Dispatcher failed to start"
      echo -e "  ${YELLOW}  Check: tail -20 $CLUSTER_DIR/logs/dispatcher.log${NC}"
    fi
  else
    # Fallback: start with nohup
    pkill -f "dispatcher.py" 2>/dev/null || true
    sleep 1
    cd "$CLUSTER_DIR"
    CLUSTER_DIR="$CLUSTER_DIR" REDIS_HOST="$REDIS_HOST" \
      nohup python3 "$CLUSTER_DIR/dispatcher.py" >> "$CLUSTER_DIR/logs/dispatcher.log" 2>&1 &
    echo -e "  ${GREEN}✓${NC} Dispatcher running (nohup, PID: $!)"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Step 5: Verify
# ═══════════════════════════════════════════════════════════════════════════════

banner "Step 5/5: Verification"

# Check Redis
echo -ne "  Redis:       "
if redis-cli ping 2>/dev/null | grep -q PONG; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${RED}FAIL${NC}"
fi

# Check dispatcher
echo -ne "  Dispatcher:  "
if pgrep -f "dispatcher.py" >/dev/null 2>&1; then
  echo -e "${GREEN}running${NC}"
else
  echo -e "${RED}not running${NC}"
fi

# Check worker count
echo -ne "  Workers:     "
if command -v redis-cli &>/dev/null; then
  WORKERS=$(redis-cli KEYS "worker:node*" 2>/dev/null | grep -c "worker:node" | grep -v heartbeat | head -1 || echo "0")
  echo -e "${GREEN}${WORKERS} registered${NC}"
else
  echo -e "${YELLOW}unknown (no redis-cli)${NC}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Done
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║               AI KIT SETUP COMPLETE                         ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BLUE}How to use:${NC}"
echo ""
echo -e "  ${YELLOW}Drop files:${NC}"
echo -e "    cp photo.jpg $CLUSTER_DIR/inbox/"
echo -e "    cp recording.mp3 $CLUSTER_DIR/inbox/"
echo -e "    cp article.md $CLUSTER_DIR/inbox/"
echo ""
echo -e "  ${YELLOW}Results appear in:${NC}"
echo -e "    $CLUSTER_DIR/results/images/   (resized, webp, alt-text)"
echo -e "    $CLUSTER_DIR/results/audio/    (transcripts, subtitles)"
echo -e "    $CLUSTER_DIR/results/text/     (summaries, SEO metadata)"
echo ""
echo -e "  ${YELLOW}Manual jobs:${NC}"
echo -e "    bash scripts/submit-job.sh shell 'uname -a'"
echo -e "    bash scripts/submit-job.sh whisper /path/to/audio.wav"
echo -e "    bash scripts/submit-job.sh status"
echo ""
echo -e "  ${YELLOW}Monitor:${NC}"
echo -e "    tail -f $CLUSTER_DIR/logs/dispatcher.log"
echo -e "    bash scripts/submit-job.sh status"
echo -e "    Visit: https://curtbrag.com/cluster"
echo ""
