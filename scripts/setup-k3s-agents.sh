#!/usr/bin/env bash
set -euo pipefail

# =========================
# k3s agent join helper
# Run from node1 or Steam Deck
# =========================

SCRIPTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOTDIR="$(cd "$SCRIPTDIR/.." && pwd)"

ELEVATE=""
if command -v doas >/dev/null 2>&1; then
  ELEVATE="doas"
elif command -v sudo >/dev/null 2>&1; then
  ELEVATE="sudo"
fi
# ELEVATE may be empty if running remotely (Steam Deck without doas/sudo).
# read_token will fall through to SSH in that case.

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
# Supports BOTH:
#  1) scripts/cluster-nodes.conf with NODE_LIST="node1:192.168.1.206:control-plane node2:192.168.1.207:worker ..."
#     (shell sourced)
#  2) simple lines: "node2 192.168.1.207" (any file)
declare -A NODE_IP=()

CONF_CANDIDATES=(
  "${SCRIPTDIR}/cluster-nodes.conf"
  "${ROOTDIR}/cluster-nodes.conf"
)

load_from_node_list() {
  local f="$1"
  # shellcheck disable=SC1090
  source "$f"

  # NODE_LIST expected as space-separated entries: name:ip:role
  if [[ -z "${NODE_LIST:-}" ]]; then
    return 1
  fi

  local entry name ip role
  for entry in $NODE_LIST; do
    IFS=':' read -r name ip role <<< "$entry"
    [[ -z "${name:-}" || -z "${ip:-}" ]] && continue
    NODE_IP["$name"]="$ip"
  done

  [[ ${#NODE_IP[@]} -gt 0 ]]
}

load_from_lines() {
  local f="$1"
  local name ip
  while read -r name ip; do
    [[ -z "${name:-}" || -z "${ip:-}" ]] && continue
    [[ "$name" =~ ^# ]] && continue
    NODE_IP["$name"]="$ip"
  done < <(grep -v '^\s*$' "$f" || true)

  [[ ${#NODE_IP[@]} -gt 0 ]]
}

for f in "${CONF_CANDIDATES[@]}"; do
  [[ -f "$f" ]] || continue

  if grep -qE '^\s*NODE_LIST=' "$f"; then
    load_from_node_list "$f" && break
  else
    load_from_lines "$f" && break
  fi
done

# Fallback if no conf found / parsed
if [[ ${#NODE_IP[@]} -eq 0 ]]; then
  for i in {2..10}; do
    NODE_IP["node${i}"]="192.168.1.$((205+i))"  # node2=207 .. node10=215
  done
fi

# Derive SERVER_IP from config if node1 was loaded (avoids hardcoded default going stale)
if [[ -n "${NODE_IP[node1]:-}" ]]; then
  SERVER_IP="${NODE_IP[node1]}"
  K3S_URL="https://${SERVER_IP}:6443"
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

# --- ssh helper (defined early: read_token needs it for remote fallback) ---
ssh_run() {
  local host="$1"; shift
  timeout "$SSH_TIMEOUT" ssh -i "$SSH_KEY" "${SSH_OPTS[@]}" "${SSH_USER}@${host}" "$@"
}

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

  # root-only: use doas/sudo (skip if ELEVATE is empty — no local privilege escalation)
  if [[ -n "$ELEVATE" ]]; then
    if $ELEVATE test -r /var/lib/rancher/k3s/server/agent-token 2>/dev/null; then
      $ELEVATE cat /var/lib/rancher/k3s/server/agent-token
      return 0
    fi

    # fallback to server token (works, but not ideal)
    if $ELEVATE test -r /var/lib/rancher/k3s/server/token 2>/dev/null; then
      $ELEVATE cat /var/lib/rancher/k3s/server/token
      return 0
    fi
  fi

  # Remote: SSH to node1 (when running from Steam Deck / other machine)
  local remote_token
  remote_token=$(ssh_run "$SERVER_IP" "doas cat /var/lib/rancher/k3s/server/agent-token 2>/dev/null" 2>/dev/null) || true
  if [[ -n "$remote_token" ]]; then
    echo "$remote_token"
    return 0
  fi
  remote_token=$(ssh_run "$SERVER_IP" "doas cat /var/lib/rancher/k3s/server/token 2>/dev/null" 2>/dev/null) || true
  if [[ -n "$remote_token" ]]; then
    echo "$remote_token"
    return 0
  fi

  echo "ERROR: cannot read agent-token or server token (tried local + SSH to $SERVER_IP)" >&2
  exit 1
}

TOKEN="$(read_token | tr -d '\r\n')"
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: token empty" >&2
  exit 1
fi

if [[ ${#TOKEN} -lt 20 ]]; then
  echo "ERROR: token looks too short (${#TOKEN} chars). Read failed?" >&2
  exit 1
fi

echo "[node1] server: $K3S_URL"
echo "[node1] token: (hidden) length=${#TOKEN}"
echo

# --- helpers ---
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

# --- pre-flight: warn about missing IPs ---
for node in "${TARGET_NODES[@]}"; do
  [[ -n "${NODE_IP[$node]:-}" ]] || echo "WARN: $node has no IP in config" >&2
done

# --- main ---
for node in "${TARGET_NODES[@]}"; do
  ip="${NODE_IP[$node]:-}"
  if [[ -z "$ip" ]]; then
    echo "Skipping $node (no IP known)" >&2
    continue
  fi

  echo "===== $node ($ip) ====="

  # SSH precheck
  if ! ssh_run "$ip" "echo ok" >/dev/null 2>&1; then
    echo "[$node] SSH failed — skipping."
    echo
    continue
  fi

  if [[ $DIAGNOSE_ONLY -eq 1 ]]; then
    remote_status "$ip" || true
    echo
    continue
  fi

  # Make sure worker can curl/https
  remote_install_prereqs "$ip" || true

  # Reachability precheck: can the worker reach the API server?
  if ! ssh_run "$ip" "curl -ks --max-time 8 ${K3S_URL}/readyz >/dev/null 2>&1"; then
    echo "[$node] cannot reach ${K3S_URL}/readyz — skipping (check network/firewall)."
    echo
    continue
  fi

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
if command -v k3s >/dev/null 2>&1; then
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
  k3s kubectl get nodes -o wide || true
else
  ssh_run "$SERVER_IP" "doas k3s kubectl get nodes -o wide" || true
fi
