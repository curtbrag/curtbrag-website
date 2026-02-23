#!/bin/sh
# ╔══════════════════════════════════════════════════════════════════════╗
# ║  Cluster Shared Library                                             ║
# ║  Source this from any cluster script:                               ║
# ║    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"                     ║
# ║    . "$SCRIPT_DIR/cluster-lib.sh"                                  ║
# ║                                                                     ║
# ║  Provides: detect_priv, ssh_retry, load_nodes, resolve_ip,        ║
# ║            log_info, log_warn, log_err, check_reachable            ║
# ╚══════════════════════════════════════════════════════════════════════╝

# Guard against double-sourcing
[ "${_CLUSTER_LIB_LOADED:-}" = "1" ] && return 0 2>/dev/null || true
_CLUSTER_LIB_LOADED=1

# ── Colors ────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── Logging ───────────────────────────────────────────────────────────
log_info()  { printf "${GREEN}[INFO]${NC}  %s\n" "$*"; }
log_warn()  { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
log_err()   { printf "${RED}[ERROR]${NC} %s\n" "$*" >&2; }

# ── Privilege Escalation ──────────────────────────────────────────────
# Detects doas or sudo. Sets $PRIV globally.
# Phone nodes (postmarketOS) use doas; PCs typically use sudo.
detect_priv() {
  if command -v doas >/dev/null 2>&1; then
    PRIV="doas"
  elif command -v sudo >/dev/null 2>&1; then
    PRIV="sudo"
  else
    PRIV=""
    log_warn "Neither doas nor sudo found — privilege escalation unavailable"
  fi
  export PRIV
}

# Detect priv on the remote end via SSH.
# Usage: REMOTE_PRIV=$(detect_remote_priv user@host)
detect_remote_priv() {
  _rp_target="$1"
  _rp_port="${2:-${SSH_PORT:-22}}"
  ssh -n -p "$_rp_port" -o ConnectTimeout=5 -o BatchMode=yes \
    -o StrictHostKeyChecking=accept-new "$_rp_target" \
    'command -v doas >/dev/null 2>&1 && echo doas || { command -v sudo >/dev/null 2>&1 && echo sudo || echo ""; }' 2>/dev/null
}

# ── Node Configuration ────────────────────────────────────────────────
# Source cluster-nodes.conf and populate node arrays.
# Sets: ALL_NODES, PHONE_NODES, CONTROL_PLANE_NODES, NODE_COUNT
# Each entry in the lists is "name:ip"
load_nodes() {
  _ln_conf="${1:-}"
  if [ -z "$_ln_conf" ]; then
    # Auto-detect: look relative to calling script, then common locations
    for _ln_try in \
      "${SCRIPT_DIR:-}/cluster-nodes.conf" \
      "$(dirname "$0")/cluster-nodes.conf" \
      "/home/user/cluster-nodes.conf" \
      "/home/user/curtbrag-website/scripts/cluster-nodes.conf"; do
      if [ -f "$_ln_try" ]; then
        _ln_conf="$_ln_try"
        break
      fi
    done
  fi

  if [ -z "$_ln_conf" ] || [ ! -f "$_ln_conf" ]; then
    log_err "cluster-nodes.conf not found"
    return 1
  fi

  # Source the config (defines NODE_LIST and load_node_config)
  . "$_ln_conf"

  # Call the config's own loader if it exists
  if command -v load_node_config >/dev/null 2>&1; then
    load_node_config
  fi

  # Ensure NODE_COUNT is set
  if [ "${NODE_COUNT:-0}" -eq 0 ] && [ -n "${ALL_NODES:-}" ]; then
    NODE_COUNT=0
    for _ln_entry in $ALL_NODES; do
      NODE_COUNT=$((NODE_COUNT + 1))
    done
  fi
}

# Resolve node name to IP from loaded config.
# Usage: IP=$(resolve_ip node3)
resolve_ip() {
  _ri_name="$1"
  if command -v resolve_ip_from_config >/dev/null 2>&1; then
    resolve_ip_from_config "$_ri_name"
    return
  fi
  # Fallback: scan ALL_NODES
  for _ri_entry in $ALL_NODES; do
    _ri_n="${_ri_entry%%:*}"
    _ri_ip="${_ri_entry#*:}"
    if [ "$_ri_name" = "$_ri_n" ]; then
      echo "$_ri_ip"
      return
    fi
  done
  # If not found, return the input (might already be an IP)
  echo "$_ri_name"
}

# Iterate all nodes. Callback receives: name ip role
# Usage: for_each_node my_callback
for_each_node() {
  _fen_callback="$1"
  for _fen_entry in $NODE_LIST; do
    _fen_name="${_fen_entry%%:*}"
    _fen_rest="${_fen_entry#*:}"
    _fen_ip="${_fen_rest%%:*}"
    _fen_role="${_fen_rest#*:}"
    "$_fen_callback" "$_fen_name" "$_fen_ip" "$_fen_role"
  done
}

# ── SSH with Retry ────────────────────────────────────────────────────
# SSH wrapper with 3 retries and exponential backoff (2s/4s/8s).
# Usage: ssh_retry user@host "command to run"
#   or:  ssh_retry -p 22 user@host "command to run"
# Returns the exit code of the SSH command.
ssh_retry() {
  _sr_port="${SSH_PORT:-22}"
  _sr_timeout="${SSH_TIMEOUT:-30}"

  # Parse optional -p flag
  if [ "$1" = "-p" ]; then
    _sr_port="$2"
    shift 2
  fi

  _sr_target="$1"
  shift
  _sr_cmd="$*"

  _sr_attempt=0
  _sr_max=3
  _sr_delay=2

  while [ "$_sr_attempt" -lt "$_sr_max" ]; do
    _sr_attempt=$((_sr_attempt + 1))

    _sr_output=$(timeout "$_sr_timeout" ssh -n -p "$_sr_port" \
      -o ConnectTimeout=5 \
      -o BatchMode=yes \
      -o StrictHostKeyChecking=accept-new \
      "$_sr_target" "$_sr_cmd" 2>/dev/null)
    _sr_rc=$?

    if [ "$_sr_rc" -eq 0 ]; then
      printf '%s' "$_sr_output"
      return 0
    fi

    if [ "$_sr_attempt" -lt "$_sr_max" ]; then
      sleep "$_sr_delay"
      _sr_delay=$((_sr_delay * 2))
    fi
  done

  # All retries failed
  printf '%s' "$_sr_output"
  return "$_sr_rc"
}

# SCP with retry. Same backoff pattern.
# Usage: scp_retry localfile user@host:/remote/path
scp_retry() {
  _scr_port="${SSH_PORT:-22}"

  # Parse optional -P flag
  if [ "$1" = "-P" ]; then
    _scr_port="$2"
    shift 2
  fi

  _scr_attempt=0
  _scr_max=3
  _scr_delay=2

  while [ "$_scr_attempt" -lt "$_scr_max" ]; do
    _scr_attempt=$((_scr_attempt + 1))

    scp -P "$_scr_port" -o ConnectTimeout=5 -o BatchMode=yes \
      -o StrictHostKeyChecking=accept-new "$@" 2>/dev/null
    _scr_rc=$?

    if [ "$_scr_rc" -eq 0 ]; then
      return 0
    fi

    if [ "$_scr_attempt" -lt "$_scr_max" ]; then
      sleep "$_scr_delay"
      _scr_delay=$((_scr_delay * 2))
    fi
  done

  return "$_scr_rc"
}

# ── Reachability Check ────────────────────────────────────────────────
# Check if a node is reachable via SSH.
# Usage: check_reachable user@host  (returns 0 if reachable, 1 if not)
check_reachable() {
  _cr_target="$1"
  _cr_port="${2:-${SSH_PORT:-22}}"

  timeout 5 ssh -n -p "$_cr_port" \
    -o ConnectTimeout=3 \
    -o BatchMode=yes \
    -o StrictHostKeyChecking=accept-new \
    "$_cr_target" "echo ok" >/dev/null 2>&1
}

# ── Local IP Detection ────────────────────────────────────────────────
# Check if an IP belongs to this machine.
# Usage: is_local_ip 192.168.1.206
is_local_ip() {
  _ili_target="$1"
  # Check all local interfaces
  _ili_local_ips=$(ip -4 addr show 2>/dev/null | grep -oP 'inet \K[\d.]+' 2>/dev/null || ifconfig 2>/dev/null | grep -oP 'inet (addr:)?[\d.]+' | grep -oP '[\d.]+')
  for _ili_ip in $_ili_local_ips; do
    [ "$_ili_target" = "$_ili_ip" ] && return 0
  done
  return 1
}

# Run a command on a node — local execution if it's us, SSH otherwise.
# Usage: run_on_node node_ip "command"
run_on_node() {
  _ron_ip="$1"
  shift
  _ron_cmd="$*"

  if is_local_ip "$_ron_ip"; then
    timeout "${SSH_TIMEOUT:-30}" sh -c "$_ron_cmd" 2>/dev/null
  else
    ssh_retry "user@$_ron_ip" "$_ron_cmd"
  fi
}

# ── Init System Detection ────────────────────────────────────────────
# Returns: systemd, openrc, or none
detect_init() {
  if command -v systemctl >/dev/null 2>&1 && systemctl --version >/dev/null 2>&1; then
    echo "systemd"
  elif command -v rc-service >/dev/null 2>&1; then
    echo "openrc"
  else
    echo "none"
  fi
}
