#!/usr/bin/env sh
set -eu
RAW="https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts/cluster-job-agent.py"
BASE="${CLUSTER_AGENT_HOME:-$HOME/.curt-cluster}"
ENV_FILE="$BASE/job-agent.env"
AGENT="$BASE/cluster-job-agent.py"
LOG="$BASE/job-agent.log"
PID="$BASE/job-agent.pid"
mkdir -p "$BASE"
command -v python3 >/dev/null 2>&1 || { echo "python3 is required"; exit 1; }
if command -v curl >/dev/null 2>&1; then curl -fsSL "$RAW" -o "$AGENT"
elif command -v wget >/dev/null 2>&1; then wget -qO "$AGENT" "$RAW"
else echo "curl or wget is required"; exit 1; fi
chmod 700 "$AGENT"
NODE="${CLUSTER_NODE:-${1:-}}"
KEY="${CLUSTER_API_KEY:-}"
[ -f "$HOME/.cluster-env" ] && . "$HOME/.cluster-env"
NODE="${CLUSTER_NODE:-$NODE}"
KEY="${CLUSTER_API_KEY:-$KEY}"
if [ -z "$NODE" ]; then printf "Canonical node name: "; read -r NODE; fi
if [ -z "$KEY" ]; then printf "CLUSTER_API_KEY: "; stty -echo 2>/dev/null || true; read -r KEY; stty echo 2>/dev/null || true; printf "\n"; fi
[ -n "$NODE" ] && [ -n "$KEY" ] || { echo "Node name and API key are required"; exit 1; }
umask 077
cat > "$ENV_FILE" <<EOF
CLUSTER_NODE='$NODE'
CLUSTER_API_KEY='$KEY'
CLUSTER_JOBS_URL='https://curtbrag.com/api/jobs'
CLUSTER_JOB_POLL='10'
EOF
if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then kill "$(cat "$PID")" 2>/dev/null || true; fi
(set -a; . "$ENV_FILE"; set +a; nohup python3 "$AGENT" >> "$LOG" 2>&1 & echo $! > "$PID")
sleep 2
if kill -0 "$(cat "$PID")" 2>/dev/null; then echo "ONLINE: $NODE job agent (PID $(cat "$PID"))"; echo "Log: $LOG"
else echo "Agent failed to start. Log:"; tail -30 "$LOG" 2>/dev/null || true; exit 1; fi
