#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════════╗
# ║  Phase 2: Install Redis Job Queue                                   ║
# ║  Run on the control node (NEXUS-PRIME or node1):                   ║
# ║    bash scripts/setup-redis.sh                                      ║
# ║                                                                     ║
# ║  Redis is the job queue backbone. Workers on phone nodes connect   ║
# ║  to it to pull jobs and push results.                              ║
# ╚══════════════════════════════════════════════════════════════════════╝

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Detect privilege escalation command
PRIV="sudo"
command -v sudo &>/dev/null || PRIV="doas"

# Detect which node we're on
HOSTNAME=$(hostname 2>/dev/null || echo "unknown")
REDIS_BIND="${REDIS_BIND:-0.0.0.0}"
REDIS_PORT="${REDIS_PORT:-6379}"

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}  Redis Job Queue Setup (host: $HOSTNAME)${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Step 1: Install Redis ─────────────────────────────────────────────

echo "[1/4] Installing Redis..."

if command -v redis-server &>/dev/null; then
  REDIS_VER=$(redis-server --version 2>/dev/null | grep -o 'v=[0-9.]*' | cut -d= -f2)
  echo -e "  ${GREEN}✓${NC} Redis already installed (v${REDIS_VER})"
else
  # Detect OS and install
  if [ -f /etc/debian_version ]; then
    $PRIV apt-get update -qq
    $PRIV apt-get install -y redis-server redis-tools
  elif [ -f /etc/alpine-release ]; then
    $PRIV apk add redis
  elif [ -f /etc/fedora-release ] || [ -f /etc/redhat-release ]; then
    $PRIV dnf install -y redis
  elif [ -f /etc/arch-release ]; then
    $PRIV pacman -S --noconfirm redis
  else
    echo -e "  ${RED}✗${NC} Unsupported OS — install Redis manually"
    exit 1
  fi

  if command -v redis-server &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Redis installed"
  else
    echo -e "  ${RED}✗${NC} Redis installation failed"
    exit 1
  fi
fi

# ── Step 2: Configure Redis ───────────────────────────────────────────

echo "[2/4] Configuring Redis..."

REDIS_CONF=""
for f in /etc/redis/redis.conf /etc/redis.conf; do
  if [ -f "$f" ]; then
    REDIS_CONF="$f"
    break
  fi
done

if [ -n "$REDIS_CONF" ]; then
  # Bind to all interfaces so phone nodes can connect
  if grep -q "^bind 127.0.0.1" "$REDIS_CONF"; then
    $PRIV sed -i "s/^bind 127.0.0.1.*/bind $REDIS_BIND/" "$REDIS_CONF"
    echo -e "  ${GREEN}✓${NC} Bind address set to $REDIS_BIND"
  fi

  # Disable protected mode (cluster is on private network)
  if grep -q "^protected-mode yes" "$REDIS_CONF"; then
    $PRIV sed -i 's/^protected-mode yes/protected-mode no/' "$REDIS_CONF"
    echo -e "  ${GREEN}✓${NC} Protected mode disabled (private network)"
  fi

  # Set max memory for phone cluster workloads
  if ! grep -q "^maxmemory" "$REDIS_CONF"; then
    echo "maxmemory 256mb" | $PRIV tee -a "$REDIS_CONF" >/dev/null
    echo "maxmemory-policy allkeys-lru" | $PRIV tee -a "$REDIS_CONF" >/dev/null
    echo -e "  ${GREEN}✓${NC} Max memory set to 256MB"
  fi
else
  echo -e "  ${YELLOW}⚠${NC} Redis config not found — using defaults"
fi

# ── Step 3: Start Redis ───────────────────────────────────────────────

echo "[3/4] Starting Redis..."

STARTED=0

# Try systemd first
if command -v systemctl &>/dev/null && $PRIV systemctl --version &>/dev/null 2>&1; then
  $PRIV systemctl enable redis-server 2>/dev/null || $PRIV systemctl enable redis 2>/dev/null || true
  $PRIV systemctl restart redis-server 2>/dev/null || $PRIV systemctl restart redis 2>/dev/null || true
  sleep 1
  if redis-cli -p "$REDIS_PORT" ping 2>/dev/null | grep -q PONG; then
    STARTED=1
    echo -e "  ${GREEN}✓${NC} Redis running (systemd)"
  fi
fi

# Try OpenRC (also check /sbin/openrc-run for systems where rc-service isn't in PATH)
if [ "$STARTED" -eq 0 ] && { command -v rc-service &>/dev/null || test -f /sbin/openrc-run; }; then
  $PRIV rc-update add redis default 2>/dev/null || true
  $PRIV rc-service redis restart 2>/dev/null || true
  sleep 1
  if redis-cli -p "$REDIS_PORT" ping 2>/dev/null | grep -q PONG; then
    STARTED=1
    echo -e "  ${GREEN}✓${NC} Redis running (OpenRC)"
  fi
fi

# Fallback: direct daemonize
if [ "$STARTED" -eq 0 ]; then
  redis-server --daemonize yes --bind "$REDIS_BIND" --port "$REDIS_PORT" --maxmemory 256mb --maxmemory-policy allkeys-lru 2>/dev/null
  sleep 1
  if redis-cli -p "$REDIS_PORT" ping 2>/dev/null | grep -q PONG; then
    echo -e "  ${GREEN}✓${NC} Redis running (daemonized)"
  else
    echo -e "  ${RED}✗${NC} Redis failed to start via all methods"
    exit 1
  fi
fi

# ── Step 4: Verify ────────────────────────────────────────────────────

echo "[4/4] Verifying Redis..."

PONG=$(redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping 2>/dev/null)
if [ "$PONG" = "PONG" ]; then
  echo -e "  ${GREEN}✓${NC} redis-cli ping → PONG"
else
  echo -e "  ${RED}✗${NC} Redis not responding on port $REDIS_PORT"
  exit 1
fi

# Create initial queue structure
redis-cli -p "$REDIS_PORT" SET "cluster:queue:info" '{"created":"'"$(date -Iseconds)"'","version":"1.0"}' EX 0 >/dev/null 2>&1

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                   REDIS SETUP COMPLETE                      ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Redis:    ${REDIS_BIND}:${REDIS_PORT}"
echo -e "  Config:   ${REDIS_CONF:-defaults}"
echo ""
echo -e "  Test from a phone node:"
echo -e "    redis-cli -h 10.0.0.1 ping"
echo ""
echo -e "  Submit a job:"
echo -e "    redis-cli LPUSH jobs:shell 'uname -a'"
echo -e "    redis-cli LRANGE results:shell 0 -1"
echo ""
