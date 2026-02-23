#!/usr/bin/env bash
set -euo pipefail

# =========================
# k3s agent join helper
# Run from node1 (server)
# =========================

SCRIPTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOTDIR="$(cd "$SCRIPTDIR/.." && pwd)"

# Conf file: try scripts/cluster-nodes.conf first (existing repo format),
# then repo root (simple "name ip" format)
CONF_FILE=""
for f in "$SCRIPTDIR/cluster-nodes.conf" "$ROOTDIR/cluster-nodes.conf"; do
  [[ -f "$f" ]] && CONF_FILE="$f" && break
done

ELEVATE=""
if command -v doas >/dev/null 2>&1; then
  ELEVATE="doas"
elif command -v sudo >/dev/null 2>&1; then
  ELEVATE="sudo"
else
  echo "ERROR: need doas or sudo on node1" >&2
  exit 1
fi

SERVER_IP="${SERVER_IP:-192.168.1.206}"
K3S_URL="${K3S_URL:-https://${SERVER_IP}:6443}"
SSH_USER="${SSH_USER:-user}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=7 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
SSH_TIMEOUT="${SSH_TIMEOUT:-300}"

NODES_CSV=""
FORCE_INSTALL=0
DIAGNOSE_ONLY=0
TOKEN_OVERRIDE=""

usage() {
  cat <<EOF
Usage:
  bash scripts/setup-k3s-agents.sh [--nodes node2,node3] [--install-agents] [--diagnose] [--token TOKEN]
Env:
  SERVER_IP=192.168.1.206 (default)
  K3S_URL=https://192.168.1.206:6443 (default)
  SSH_USER=user (default)
  SSH_KEY=~/.ssh/id_ed25519 (default)
  SSH_TIMEOUT=300 (default)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --nodes) NODES_CSV="${2:-}"; shift 2 ;;
    --install-agents) FORCE_INSTALL=1; shift ;;
    --diagnose) DIAGNOSE_ONLY=1; shift ;;
    --token) TOKEN_OVERRIDE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

# --- discover nodes ---
declare -A NODE_IP=()

if [[ -n "$CONF_FILE" ]]; then
  # Detect format: existing repo uses NODE_LIST="name:ip:role ..." as shell variable
  if grep -q '^NODE_LIST=' "$CONF_FILE" 2>/dev/null; then
    # Source it to get NODE_LIST, then parse colon-separated entries
    # shellcheck disable=SC1090
    . "$CONF_FILE"
    for entry in $NODE_LIST; do
      name="${entry%%:*}"
      rest="${entry#*:}"
      ip="${rest%%:*}"
      [[ -z "$name" || -z "$ip" ]] && continue
      NODE_IP["$name"]="$ip"
    done
  else
    # Simple "name ip" format
    while read -r name ip; do
      [[ -z "${name:-}" || -z "${ip:-}" ]] && continue
      [[ "$name" =~ ^# ]] && continue
      NODE_IP["$name"]="$ip"
    done < <(grep -v '^\s*$' "$CONF_FILE" || true)
  fi
fi

# Fallback: node2..node10 with 192.168.1.207..215 (matches existing cluster-nodes.conf)
if [[ ${#NODE_IP[@]} -eq 0 ]]; then
  for i in {2..10}; do
    NODE_IP["node${i}"]="192.168.1.$((205+i))"
  done
fi

# Apply --nodes filter
TARGET_NODES=()
if [[ -n "$NODES_CSV" ]]; then
  IFS=',' read -r -a TARGET_NODES <<< "$NODES_CSV"
else
  # default: all known nodes except node1
  for n in "${!NODE_IP[@]}"; do
    [[ "$n" == "node1" ]] && continue
    TARGET_NODES+=("$n")
  done
  # stable ordering
  IFS=$'\n' TARGET_NODES=($(printf "%s\n" "${TARGET_NODES[@]}" | sort -V))
fi

# --- read token on node1 (root-only) ---
read_token() {
  if [[ -n "$TOKEN_OVERRIDE" ]]; then
    echo "$TOKEN_OVERRIDE"
    return 0
  fi

  # Agent token is what you want for workers
  if [[ -r /var/lib/rancher/k3s/server/agent-token ]]; then
    cat /var/lib/rancher/k3s/server/agent-token
    return 0
  fi

  # root-only: use doas/sudo
  if $ELEVATE test -r /var/lib/rancher/k3s/server/agent-token 2>/dev/null; then
    $ELEVATE cat /var/lib/rancher/k3s/server/agent-token
    return 0
  fi

  # fallback to server token (works, but not ideal)
  if $ELEVATE test -r /var/lib/rancher/k3s/server/token 2>/dev/null; then
    $ELEVATE cat /var/lib/rancher/k3s/server/token
    return 0
  fi

  echo "ERROR: cannot read agent-token or server token on node1" >&2
  exit 1
}

TOKEN="$(read_token | tr -d '\r\n')"
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: token empty" >&2
  exit 1
fi

echo "[node1] server: $K3S_URL"
echo "[node1] token: (hidden) length=${#TOKEN}"
echo

# --- helpers ---
ssh_run() {
  local host="$1"; shift
  timeout "$SSH_TIMEOUT" ssh -i "$SSH_KEY" "${SSH_OPTS[@]}" "${SSH_USER}@${host}" "$@"
}

remote_detect_init() {
  local ip="$1"
  ssh_run "$ip" "if command -v systemctl >/dev/null 2>&1; then echo systemd; else echo openrc; fi"
}

remote_install_prereqs() {
  local ip="$1"
  ssh_run "$ip" "doas apk add --no-cache curl ca-certificates >/dev/null 2>&1 || true"
}

remote_stop_k3s() {
  local ip="$1"
  ssh_run "$ip" '
    set +e
    if command -v systemctl >/dev/null 2>&1; then
      doas systemctl stop k3s-agent 2>/dev/null || true
      doas systemctl stop k3s 2>/dev/null || true
    else
      doas rc-service k3s-agent stop 2>/dev/null || true
      doas rc-service k3s stop 2>/dev/null || true
    fi
    doas pkill -f "k3s agent|k3s-agent|k3s " 2>/dev/null || true
    exit 0
  '
}

remote_status() {
  local ip="$1"
  ssh_run "$ip" '
    set +e
    echo "hostname: $(hostname)"
    echo -n "k3s binary: "; command -v k3s >/dev/null 2>&1 && echo yes || echo no
    echo -n "k3s-agent svc: "
    if command -v systemctl >/dev/null 2>&1; then
      systemctl is-active k3s-agent 2>/dev/null || true
    else
      rc-service k3s-agent status 2>/dev/null || true
    fi
    echo -n "ports 10250/8472? (best-effort): "
    command -v ss >/dev/null 2>&1 && ss -lntu 2>/dev/null | awk "NR==1||/:(10250|8472)\b/" || echo "ss not present"
    exit 0
  '
}

remote_write_config() {
  local ip="$1"
  local nodename="$2"
  local nodeip="$3"
  local token="$4"
  local url="$5"

  # For Alpine: config.yaml is standard
  ssh_run "$ip" "doas mkdir -p /etc/rancher/k3s && doas sh -c 'cat > /etc/rancher/k3s/config.yaml <<EOF
server: \"$url\"
token: \"$token\"
node-name: \"$nodename\"
node-ip: \"$nodeip\"
# prefer bundled binaries when available
prefer-bundled-bin: true
EOF
chmod 600 /etc/rancher/k3s/config.yaml
'"
}

remote_start_agent() {
  local ip="$1"
  ssh_run "$ip" '
    set +e
    if command -v systemctl >/dev/null 2>&1; then
      doas systemctl enable --now k3s-agent 2>/dev/null || doas systemctl restart k3s-agent 2>/dev/null || true
    else
      doas rc-update add k3s-agent default 2>/dev/null || true
      doas rc-service k3s-agent start 2>/dev/null || doas rc-service k3s-agent restart 2>/dev/null || true
    fi
    exit 0
  '
}

remote_force_install_agent() {
  local ip="$1"
  local nodename="$2"
  local nodeip="$3"
  local token="$4"
  local url="$5"

  # Uses official install script; for Alpine this is generally fine.
  # INSTALL_K3S_EXEC gets baked into service
  ssh_run "$ip" "doas sh -c '
    set -e
    apk add --no-cache curl ca-certificates >/dev/null 2>&1 || true
    # uninstall if present
    if [ -x /usr/local/bin/k3s-agent-uninstall.sh ]; then /usr/local/bin/k3s-agent-uninstall.sh || true; fi
    if [ -x /usr/local/bin/k3s-uninstall.sh ]; then /usr/local/bin/k3s-uninstall.sh || true; fi
    rm -rf /etc/rancher/k3s /var/lib/rancher/k3s 2>/dev/null || true

    export K3S_URL=\"$url\"
    export K3S_TOKEN=\"$token\"
    export INSTALL_K3S_EXEC=\"agent --node-ip=$nodeip --node-name=$nodename --prefer-bundled-bin\"

    curl -sfL https://get.k3s.io | sh -
  '"
}

# --- main ---
for node in "${TARGET_NODES[@]}"; do
  ip="${NODE_IP[$node]:-}"
  if [[ -z "$ip" ]]; then
    echo "Skipping $node (no IP known)" >&2
    continue
  fi

  echo "===== $node ($ip) ====="

  if [[ $DIAGNOSE_ONLY -eq 1 ]]; then
    remote_status "$ip" || true
    echo
    continue
  fi

  # Make sure worker can curl/https
  remote_install_prereqs "$ip" || true

  # stop any running agent/server bits
  remote_stop_k3s "$ip" || true

  if [[ $FORCE_INSTALL -eq 1 ]]; then
    echo "[$node] force install k3s agent..."
    remote_force_install_agent "$ip" "$node" "$ip" "$TOKEN" "$K3S_URL"
  else
    # If k3s missing, do install anyway
    if ! ssh_run "$ip" "command -v k3s >/dev/null 2>&1"; then
      echo "[$node] k3s missing, installing agent..."
      remote_force_install_agent "$ip" "$node" "$ip" "$TOKEN" "$K3S_URL"
    else
      echo "[$node] k3s present, writing config + starting agent..."
      remote_write_config "$ip" "$node" "$ip" "$TOKEN" "$K3S_URL"
      remote_start_agent "$ip"
    fi
  fi

  echo "[$node] status after change:"
  remote_status "$ip" || true
  echo
done

echo "===== cluster view from node1 ====="
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
k3s kubectl get nodes -o wide || true
