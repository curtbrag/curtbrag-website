#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════════╗
# ║  Deploy Worker System to Phone Cluster                              ║
# ║  Run from any machine with SSH access:                              ║
# ║    bash scripts/deploy-workers.sh --password 0735                   ║
# ║                                                                     ║
# ║  What it does:                                                      ║
# ║    - Deploys worker.py to all phone nodes                          ║
# ║    - Installs Python + Redis client                                 ║
# ║    - Optionally builds whisper.cpp and/or llama.cpp                ║
# ║    - Starts worker service on each node                             ║
# ║    - Configures auto-restart via init system                        ║
# ╚══════════════════════════════════════════════════════════════════════╝

# No set -e — we want to continue past failed nodes
# set -e

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
fi

# Redis host — auto-detect: use first non-loopback IP if running on the Redis host
if [ -z "${REDIS_HOST:-}" ]; then
  # If redis-cli works locally, we ARE the Redis host — use our WiFi IP so phones can reach us
  if redis-cli ping 2>/dev/null | grep -q PONG; then
    REDIS_HOST=$(ip -4 addr show wlan0 2>/dev/null | grep -oP 'inet \K[\d.]+' || echo "192.168.1.206")
  else
    REDIS_HOST="10.0.0.1"
  fi
fi
WORKER_QUEUES="${WORKER_QUEUES:-shell,whisper,llm,generic,image,audio}"

# Parse args
SSH_PORT="${SSH_PORT:-22}"
BUILD_WHISPER=0
BUILD_LLAMA=0
WHISPER_MODEL="base"
LLAMA_MODEL_URL=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --password) SSH_PASS="$2"; shift 2;;
    --ssh-port) SSH_PORT="$2"; shift 2;;
    --redis-host) REDIS_HOST="$2"; shift 2;;
    --queues) WORKER_QUEUES="$2"; shift 2;;
    --with-whisper) BUILD_WHISPER=1; shift;;
    --whisper-model) WHISPER_MODEL="$2"; shift 2;;
    --with-llama) BUILD_LLAMA=1; shift;;
    --llama-model-url) LLAMA_MODEL_URL="$2"; shift 2;;
    --with-ai) BUILD_WHISPER=1; BUILD_LLAMA=1; shift;;
    --nodes) TARGET_NODES="$2"; shift 2;;
    -h|--help)
      echo "Usage: $0 [options]"
      echo "  --password PASS         SSH password for phone nodes"
      echo "  --redis-host HOST       Redis server IP (default: 10.0.0.1)"
      echo "  --queues LIST           Comma-separated queue list (default: shell,whisper,llm,generic)"
      echo "  --with-whisper          Build whisper.cpp on each node"
      echo "  --whisper-model NAME    Whisper model: tiny|base|small (default: base)"
      echo "  --with-llama            Build llama.cpp on each node"
      echo "  --llama-model-url URL   Download GGUF model from URL"
      echo "  --with-ai               Enable both whisper and llama"
      echo "  --nodes LIST            Comma-separated node names (default: all)"
      exit 0;;
    *) shift;;
  esac
done

ssh_cmd() {
  local target="$1"; shift
  local cmd_timeout="${SSH_CMD_TIMEOUT:-120}"
  if [ -n "${SSH_PASS:-}" ]; then
    timeout "$cmd_timeout" sshpass -p "$SSH_PASS" ssh -p "$SSH_PORT" -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o StrictHostKeyChecking=accept-new "$target" "$@"
  else
    timeout "$cmd_timeout" ssh -p "$SSH_PORT" -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$target" "$@"
  fi
}

scp_cmd() {
  local src="$1" dst="$2"
  if [ -n "${SSH_PASS:-}" ]; then
    timeout 60 sshpass -p "$SSH_PASS" scp -P "$SSH_PORT" -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "$src" "$dst" 2>/dev/null
  else
    timeout 60 scp -P "$SSH_PORT" -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "$src" "$dst" 2>/dev/null
  fi
}

banner() {
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${CYAN}  $1${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Determine target nodes
# ═══════════════════════════════════════════════════════════════════════════════

if [ -n "${TARGET_NODES:-}" ]; then
  # Filter ALL_NODES to only requested ones
  DEPLOY_NODES=""
  for name in $(echo "$TARGET_NODES" | tr ',' ' '); do
    for entry in $ALL_NODES; do
      ENAME="${entry%%:*}"
      if [ "$ENAME" = "$name" ]; then
        DEPLOY_NODES="${DEPLOY_NODES:+$DEPLOY_NODES }${entry}"
      fi
    done
  done
else
  DEPLOY_NODES="$ALL_NODES"
fi

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║        PHONE CLUSTER — WORKER DEPLOYMENT                   ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Redis:   ${REDIS_HOST}"
echo -e "  Queues:  ${WORKER_QUEUES}"
echo -e "  Whisper: $([ $BUILD_WHISPER -eq 1 ] && echo "YES (model: $WHISPER_MODEL)" || echo "no")"
echo -e "  LLaMA:   $([ $BUILD_LLAMA -eq 1 ] && echo "YES" || echo "no")"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Deploy to each node
# ═══════════════════════════════════════════════════════════════════════════════

OK=0
FAIL=0

for entry in $DEPLOY_NODES; do
  NAME="${entry%%:*}"
  IP="${entry#*:}"
  SSH_TARGET="user@${IP}"

  banner "[${NAME}] ${IP}"

  if ! ssh_cmd "$SSH_TARGET" "echo ok" &>/dev/null; then
    echo -e "  ${RED}✗${NC} Cannot SSH — skipping"
    FAIL=$((FAIL + 1))
    continue
  fi

  # ── Step 1: Install Python + deps ────────────────────────────────────
  echo -e "  ${YELLOW}[1/4] Installing Python + Redis client...${NC}"
  ssh_cmd "$SSH_TARGET" "
    doas apk add python3 py3-pip 2>/dev/null
    pip install redis 2>/dev/null || pip3 install redis 2>/dev/null || true
  " 2>/dev/null
  echo -e "  ${GREEN}✓${NC} Python ready"

  # ── Step 2: Deploy worker.py ─────────────────────────────────────────
  echo -e "  ${YELLOW}[2/4] Deploying worker.py...${NC}"
  scp_cmd "$SCRIPT_DIR/worker.py" "${SSH_TARGET}:/home/user/worker.py"
  ssh_cmd "$SSH_TARGET" "chmod +x /home/user/worker.py" 2>/dev/null
  echo -e "  ${GREEN}✓${NC} worker.py deployed"

  # ── Step 3: Build AI runtimes (if requested) ─────────────────────────
  if [ $BUILD_WHISPER -eq 1 ] || [ $BUILD_LLAMA -eq 1 ]; then
    echo -e "  ${YELLOW}[3/4] Building AI runtimes...${NC}"

    if [ $BUILD_WHISPER -eq 1 ]; then
      echo -ne "    whisper.cpp... "
      scp_cmd "$SCRIPT_DIR/setup-whisper-node.sh" "${SSH_TARGET}:/tmp/setup-whisper-node.sh"
      WHISPER_RESULT=$(ssh_cmd "$SSH_TARGET" "sh /tmp/setup-whisper-node.sh --model $WHISPER_MODEL 2>&1 | tail -3" 2>/dev/null)
      if ssh_cmd "$SSH_TARGET" "test -f /home/user/whisper.cpp/main" 2>/dev/null; then
        echo -e "${GREEN}OK${NC}"
      else
        echo -e "${YELLOW}build may still be running${NC}"
      fi
    fi

    if [ $BUILD_LLAMA -eq 1 ]; then
      echo -ne "    llama.cpp... "
      LLAMA_ARGS=""
      [ -n "$LLAMA_MODEL_URL" ] && LLAMA_ARGS="--model-url $LLAMA_MODEL_URL"
      scp_cmd "$SCRIPT_DIR/setup-llama-node.sh" "${SSH_TARGET}:/tmp/setup-llama-node.sh"
      LLAMA_RESULT=$(ssh_cmd "$SSH_TARGET" "sh /tmp/setup-llama-node.sh $LLAMA_ARGS 2>&1 | tail -3" 2>/dev/null)
      if ssh_cmd "$SSH_TARGET" "test -f /home/user/llama.cpp/llama-cli" 2>/dev/null; then
        echo -e "${GREEN}OK${NC}"
      else
        echo -e "${YELLOW}build may still be running${NC}"
      fi
    fi
  else
    echo -e "  ${YELLOW}[3/4] AI runtimes: skipped (use --with-ai to enable)${NC}"
  fi

  # ── Step 4: Start worker service ─────────────────────────────────────
  echo -e "  ${YELLOW}[4/4] Starting worker service...${NC}"

  # Write env file for worker
  ssh_cmd "$SSH_TARGET" "cat > /home/user/.worker-env << WENV
REDIS_HOST=${REDIS_HOST}
REDIS_PORT=6379
NODE_NAME=${NAME}
WORKER_QUEUES=${WORKER_QUEUES}
WENV
chmod 600 /home/user/.worker-env" 2>/dev/null

  # Kill any existing worker
  ssh_cmd "$SSH_TARGET" "pkill -f 'worker.py' 2>/dev/null; sleep 1; true" 2>/dev/null

  # Detect init system and create service
  INIT_SYS=$(ssh_cmd "$SSH_TARGET" "command -v systemctl >/dev/null 2>&1 && systemctl --version >/dev/null 2>&1 && echo systemd || { { command -v rc-service >/dev/null 2>&1 || [ -f /sbin/openrc-run ]; } && echo openrc; } || echo none" 2>/dev/null)

  if [ "$INIT_SYS" = "systemd" ]; then
    ssh_cmd "$SSH_TARGET" "doas tee /etc/systemd/system/cluster-worker.service > /dev/null" << 'SVC'
[Unit]
Description=Phone Cluster Worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=user
EnvironmentFile=-/home/user/.worker-env
ExecStart=/usr/bin/python3 /home/user/worker.py
Restart=always
RestartSec=10
StandardOutput=append:/home/user/worker.log
StandardError=append:/home/user/worker.log

[Install]
WantedBy=multi-user.target
SVC
    ssh_cmd "$SSH_TARGET" "doas systemctl daemon-reload; doas systemctl enable cluster-worker; doas systemctl restart cluster-worker" 2>/dev/null
    echo -e "  ${GREEN}✓${NC} Worker running (systemd)"

  elif [ "$INIT_SYS" = "openrc" ]; then
    ssh_cmd "$SSH_TARGET" "doas tee /etc/init.d/cluster-worker > /dev/null && doas chmod +x /etc/init.d/cluster-worker" << 'ORCSVC'
#!/sbin/openrc-run
name="cluster-worker"
description="Phone Cluster Worker"
command="/usr/bin/python3"
command_args="/home/user/worker.py"
command_user="user"
command_background="yes"
pidfile="/run/cluster-worker.pid"
output_log="/home/user/worker.log"
error_log="/home/user/worker.log"

depend() { need net; }

start_pre() {
  . /home/user/.worker-env 2>/dev/null || true
  export REDIS_HOST NODE_NAME WORKER_QUEUES
}
ORCSVC
    ssh_cmd "$SSH_TARGET" "doas rc-update add cluster-worker default 2>/dev/null; doas rc-service cluster-worker restart 2>/dev/null || true" 2>/dev/null
    echo -e "  ${GREEN}✓${NC} Worker started (OpenRC)"

  else
    # Fallback: nohup
    ssh_cmd "$SSH_TARGET" "
      . /home/user/.worker-env 2>/dev/null
      export REDIS_HOST NODE_NAME WORKER_QUEUES
      nohup python3 /home/user/worker.py >> /home/user/worker.log 2>&1 &
    " 2>/dev/null
    echo -e "  ${GREEN}✓${NC} Worker running (nohup)"
  fi

  # Verify
  sleep 5
  if SSH_CMD_TIMEOUT=15 ssh_cmd "$SSH_TARGET" "pgrep -f 'worker.py' >/dev/null 2>&1" 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Worker verified running"
    OK=$((OK + 1))
  else
    echo -e "  ${RED}✗${NC} Worker not running — check: ssh $SSH_TARGET 'tail -20 /home/user/worker.log'"
    FAIL=$((FAIL + 1))
  fi
done

# ═══════════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              WORKER DEPLOYMENT COMPLETE                     ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Workers: ${GREEN}${OK} running${NC}, ${RED}${FAIL} failed${NC}"
echo -e "  Redis:   ${REDIS_HOST}:6379"
echo -e "  Queues:  ${WORKER_QUEUES}"
echo ""
echo -e "  ${BLUE}Submit a job:${NC}"
echo -e "    redis-cli -h ${REDIS_HOST} LPUSH jobs:shell 'uname -a'"
echo -e "    redis-cli -h ${REDIS_HOST} LPUSH jobs:shell 'free -h'"
echo ""
echo -e "  ${BLUE}Read results:${NC}"
echo -e "    redis-cli -h ${REDIS_HOST} LRANGE results:shell 0 -1"
echo ""
echo -e "  ${BLUE}Check worker status:${NC}"
echo -e "    redis-cli -h ${REDIS_HOST} KEYS 'worker:*'"
echo ""
echo -e "  ${BLUE}Submit AI jobs:${NC}"
echo -e "    redis-cli -h ${REDIS_HOST} LPUSH jobs:whisper '{\"file\":\"/path/to/audio.wav\"}'"
echo -e "    redis-cli -h ${REDIS_HOST} LPUSH jobs:llm '{\"prompt\":\"Summarize this:\"}'"
echo ""
echo -e "  ${BLUE}CLI tool:${NC}"
echo -e "    bash scripts/submit-job.sh shell 'uptime'"
echo -e "    bash scripts/submit-job.sh whisper /path/to/audio.wav"
echo ""
