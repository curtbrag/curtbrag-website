#!/bin/sh
# ╔══════════════════════════════════════════════════════════════════════╗
# ║  K3s Cluster Recovery — Diagnose and Repair                        ║
# ║                                                                     ║
# ║  Usage:                                                             ║
# ║    sh recover-cluster.sh              # diagnose only (read-only)  ║
# ║    sh recover-cluster.sh --fix        # diagnose + repair          ║
# ║    sh recover-cluster.sh --fix --restart-mining   # + start miners ║
# ║    sh recover-cluster.sh --fix --push             # + push status  ║
# ║                                                                     ║
# ║  Run on node1 (control plane) or any machine with SSH access.      ║
# ║  Sources cluster-lib.sh for shared SSH/priv/node utilities.        ║
# ╚══════════════════════════════════════════════════════════════════════╝

# No set -e — we handle errors explicitly and want to report all issues
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIR="${HOME:-/home/user}"

# Source shared library
if [ -f "$SCRIPT_DIR/cluster-lib.sh" ]; then
  . "$SCRIPT_DIR/cluster-lib.sh"
elif [ -f "$DIR/cluster-lib.sh" ]; then
  SCRIPT_DIR="$DIR"
  . "$DIR/cluster-lib.sh"
else
  echo "ERROR: cluster-lib.sh not found in $SCRIPT_DIR or $DIR"
  echo "Download it: curl -sfL https://raw.githubusercontent.com/curtbrag/curtbrag-website/main/scripts/cluster-lib.sh -o $DIR/cluster-lib.sh"
  exit 1
fi

detect_priv
load_nodes || { log_err "Could not load node configuration"; exit 1; }

SSH_PORT="${SSH_PORT:-22}"

# K3s binary path — doas on postmarketOS uses a restricted PATH that
# may not include /usr/local/bin, so we discover the full path once.
# This runs on the control plane node (or locally if we ARE the CP).
find_k3s_bin() {
  _fkb_ip="$1"
  for _fkb_path in /usr/local/bin/k3s /usr/bin/k3s; do
    if run_on_node "$_fkb_ip" "[ -x $_fkb_path ]" 2>/dev/null; then
      echo "$_fkb_path"
      return
    fi
  done
  # Fallback: try command -v (works if PATH is ok)
  _fkb_found=$(run_on_node "$_fkb_ip" "command -v k3s 2>/dev/null" 2>/dev/null || echo "")
  if [ -n "$_fkb_found" ]; then
    echo "$_fkb_found"
  else
    echo "k3s"  # last resort, let it fail with a clear error
  fi
}

# ── Parse args ────────────────────────────────────────────────────────
DO_FIX=0
RESTART_MINING=0
PUSH_STATUS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --diagnose) shift;;  # diagnose is the default, accept for clarity
    --fix) DO_FIX=1; shift;;
    --restart-mining) RESTART_MINING=1; shift;;
    --push) PUSH_STATUS=1; shift;;
    --help|-h)
      echo "Usage: sh recover-cluster.sh [--fix] [--restart-mining] [--push]"
      echo "  --fix              Attempt to repair K3s cluster"
      echo "  --restart-mining   Also restart xmrig on all nodes"
      echo "  --push             Push fresh status to dashboard after repair"
      exit 0;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

# ── Tracking arrays (POSIX shell — no arrays, use files) ─────────────
DIAG_DIR="/tmp/cluster-diag-$$"
mkdir -p "$DIAG_DIR"
trap 'rm -rf "$DIAG_DIR"' EXIT

TOTAL_NODES=0
REACHABLE=0
UNREACHABLE=0
K3S_RUNNING=0
K3S_STOPPED=0
ISSUES=""

add_issue() {
  ISSUES="${ISSUES}  - $1\n"
}

# ══════════════════════════════════════════════════════════════════════
# PHASE 1: DIAGNOSE (read-only)
# ══════════════════════════════════════════════════════════════════════

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  K3s Cluster Recovery — Diagnostic Report               ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── Step 1: SSH Reachability ──────────────────────────────────────────
log_info "Step 1/7: SSH reachability sweep..."
echo ""

for entry in $NODE_LIST; do
  _name="${entry%%:*}"
  _rest="${entry#*:}"
  _ip="${_rest%%:*}"
  _role="${_rest#*:}"
  TOTAL_NODES=$((TOTAL_NODES + 1))

  if check_reachable "user@$_ip" "$SSH_PORT" 2>/dev/null; then
    printf "  ${GREEN}%-8s${NC} %-16s %s\n" "$_name" "$_ip" "reachable"
    echo "1" > "$DIAG_DIR/$_name.reachable"
    REACHABLE=$((REACHABLE + 1))
  else
    printf "  ${RED}%-8s${NC} %-16s %s\n" "$_name" "$_ip" "UNREACHABLE"
    UNREACHABLE=$((UNREACHABLE + 1))
    add_issue "$_name ($_ip) is unreachable via SSH"
  fi
done

echo ""
echo "  Result: $REACHABLE/$TOTAL_NODES nodes reachable"
echo ""

# ── Step 2: K3s Control Plane Check ──────────────────────────────────
log_info "Step 2/7: K3s control plane status..."
echo ""

# Find the control plane node
CP_NAME=""
CP_IP=""
for entry in $NODE_LIST; do
  _name="${entry%%:*}"
  _rest="${entry#*:}"
  _ip="${_rest%%:*}"
  _role="${_rest#*:}"
  if [ "$_role" = "control-plane" ]; then
    CP_NAME="$_name"
    CP_IP="$_ip"
    break
  fi
done

if [ -z "$CP_NAME" ]; then
  log_err "No control-plane node found in config"
  add_issue "No control-plane node defined in cluster-nodes.conf"
else
  echo "  Control plane: $CP_NAME ($CP_IP)"

  # Discover k3s binary path (doas PATH may not include /usr/local/bin)
  K3S_BIN="k3s"
  if [ -f "$DIAG_DIR/$CP_NAME.reachable" ]; then
    K3S_BIN=$(find_k3s_bin "$CP_IP")
    echo "  K3s binary:    $K3S_BIN"
  fi

  # Check if k3s service is running
  K3S_SVC_STATUS=$(run_on_node "$CP_IP" "$PRIV rc-service k3s status 2>/dev/null || $PRIV systemctl is-active k3s 2>/dev/null || echo stopped" 2>/dev/null || echo "unreachable")
  echo "  K3s service:   $K3S_SVC_STATUS"

  if echo "$K3S_SVC_STATUS" | grep -qi "started\|running" || { echo "$K3S_SVC_STATUS" | grep -qi "active" && ! echo "$K3S_SVC_STATUS" | grep -qi "inactive\|activating"; }; then
    echo "  ${GREEN}Control plane service is running${NC}"

    # Try kubectl get nodes (use discovered K3S_BIN path)
    KUBECTL_OUTPUT=$(run_on_node "$CP_IP" "$PRIV $K3S_BIN kubectl get nodes -o wide 2>&1" 2>/dev/null || echo "FAILED")
    if echo "$KUBECTL_OUTPUT" | grep -q "NAME.*STATUS"; then
      echo ""
      echo "  kubectl get nodes:"
      echo "$KUBECTL_OUTPUT" | while IFS= read -r line; do echo "    $line"; done
      echo ""

      # Count Ready vs NotReady
      READY_COUNT=$(echo "$KUBECTL_OUTPUT" | grep -c " Ready " || true)
      NOTREADY_COUNT=$(echo "$KUBECTL_OUTPUT" | grep -c "NotReady" || true)
      echo "  Ready: $READY_COUNT  NotReady: $NOTREADY_COUNT"

      if [ "$NOTREADY_COUNT" -gt 0 ]; then
        add_issue "$NOTREADY_COUNT nodes are NotReady in K3s"
      fi
    else
      echo "  ${RED}kubectl failed:${NC} $KUBECTL_OUTPUT"
      add_issue "kubectl get nodes failed — API server may be unhealthy"
    fi
  else
    echo "  ${RED}K3s control plane is NOT running${NC}"
    add_issue "K3s control plane ($CP_NAME) is not running"
  fi
fi
echo ""

# ── Step 3: Per-Node K3s Agent Status ─────────────────────────────────
log_info "Step 3/7: Per-node K3s agent status..."
echo ""

for entry in $NODE_LIST; do
  _name="${entry%%:*}"
  _rest="${entry#*:}"
  _ip="${_rest%%:*}"
  _role="${_rest#*:}"

  [ ! -f "$DIAG_DIR/$_name.reachable" ] && { printf "  %-8s SKIPPED (unreachable)\n" "$_name"; continue; }

  if [ "$_role" = "control-plane" ]; then
    SVC="k3s"
  else
    SVC="k3s-agent"
  fi

  STATUS=$(run_on_node "$_ip" "$PRIV rc-service $SVC status 2>/dev/null || $PRIV systemctl is-active $SVC 2>/dev/null || echo stopped" 2>/dev/null || echo "check-failed")

  if echo "$STATUS" | grep -qi "started\|running" || { echo "$STATUS" | grep -qi "active" && ! echo "$STATUS" | grep -qi "inactive\|activating"; }; then
    printf "  ${GREEN}%-8s${NC} %-12s %s\n" "$_name" "$SVC" "running"
    K3S_RUNNING=$((K3S_RUNNING + 1))
  else
    printf "  ${RED}%-8s${NC} %-12s %s\n" "$_name" "$SVC" "$STATUS"
    K3S_STOPPED=$((K3S_STOPPED + 1))
    add_issue "$_name: $SVC is $STATUS"
  fi

  # Check registered IP (if agent is running)
  # Handle both quoted (node-ip: "1.2.3.4") and unquoted (node-ip: 1.2.3.4) YAML
  REGISTERED_IP=$(run_on_node "$_ip" "grep 'node-ip' /etc/rancher/k3s/config.yaml 2>/dev/null | sed 's/.*: *//;s/\"//g' | tr -d ' ' || echo 'not-set'" 2>/dev/null || echo "unknown")
  if [ "$REGISTERED_IP" != "not-set" ] && [ "$REGISTERED_IP" != "unknown" ] && [ "$REGISTERED_IP" != "$_ip" ]; then
    printf "  ${YELLOW}         registered IP: %s (expected %s)${NC}\n" "$REGISTERED_IP" "$_ip"
    add_issue "$_name registered with wrong IP ($REGISTERED_IP, expected $_ip)"
  fi
done

echo ""
echo "  K3s agents: $K3S_RUNNING running, $K3S_STOPPED stopped"
echo ""

# ── Step 4: etcd Health ───────────────────────────────────────────────
log_info "Step 4/7: Embedded etcd health..."
echo ""

if [ -n "$CP_IP" ] && [ -f "$DIAG_DIR/$CP_NAME.reachable" ]; then
  ETCD_STATUS=$(run_on_node "$CP_IP" "$PRIV $K3S_BIN etcd-snapshot list 2>&1 | head -5" 2>/dev/null || echo "check-failed")
  if echo "$ETCD_STATUS" | grep -qi "error\|failed\|check-failed"; then
    echo "  ${RED}etcd health check failed${NC}"
    echo "  $ETCD_STATUS" | head -3 | while IFS= read -r line; do echo "    $line"; done
    add_issue "etcd health check failed on $CP_NAME"
  else
    echo "  ${GREEN}etcd responding${NC}"
    echo "$ETCD_STATUS" | head -3 | while IFS= read -r line; do echo "    $line"; done
  fi
else
  echo "  ${YELLOW}SKIPPED (control plane unreachable)${NC}"
fi
echo ""

# ── Step 5: Flannel Status ────────────────────────────────────────────
log_info "Step 5/7: Flannel network interface..."
echo ""

FLANNEL_OK=0
FLANNEL_MISSING=0
for entry in $NODE_LIST; do
  _name="${entry%%:*}"
  _rest="${entry#*:}"
  _ip="${_rest%%:*}"

  [ ! -f "$DIAG_DIR/$_name.reachable" ] && continue

  HAS_FLANNEL=$(run_on_node "$_ip" "ip link show flannel.1 2>/dev/null && echo yes || echo no" 2>/dev/null || echo "check-failed")
  if echo "$HAS_FLANNEL" | grep -q "yes"; then
    FLANNEL_OK=$((FLANNEL_OK + 1))
  else
    printf "  ${YELLOW}%-8s flannel.1 interface missing${NC}\n" "$_name"
    FLANNEL_MISSING=$((FLANNEL_MISSING + 1))
  fi
done

if [ "$FLANNEL_MISSING" -eq 0 ] && [ "$FLANNEL_OK" -gt 0 ]; then
  echo "  ${GREEN}All $FLANNEL_OK reachable nodes have flannel.1${NC}"
elif [ "$FLANNEL_OK" -eq 0 ]; then
  echo "  ${RED}No nodes have flannel.1 — cluster networking is down${NC}"
  add_issue "Flannel VXLAN interface missing on all nodes"
fi
echo ""

# ── Step 6: DNS Check ─────────────────────────────────────────────────
log_info "Step 6/7: Cluster DNS resolution..."
echo ""

if [ -n "$CP_IP" ] && [ -f "$DIAG_DIR/$CP_NAME.reachable" ]; then
  DNS_CHECK=$(run_on_node "$CP_IP" "$PRIV $K3S_BIN kubectl run dns-test --rm -i --restart=Never --image=busybox -- nslookup kubernetes.default.svc.cluster.local 2>&1 | tail -5" 2>/dev/null || echo "check-failed")
  if echo "$DNS_CHECK" | grep -qi "address\|server"; then
    echo "  ${GREEN}Cluster DNS is resolving${NC}"
  else
    echo "  ${YELLOW}DNS check inconclusive${NC} (K3s may be down)"
  fi
else
  echo "  ${YELLOW}SKIPPED (control plane unreachable)${NC}"
fi
echo ""

# ── Step 7: Certificate Expiry ────────────────────────────────────────
log_info "Step 7/7: K3s certificate status..."
echo ""

if [ -n "$CP_IP" ] && [ -f "$DIAG_DIR/$CP_NAME.reachable" ]; then
  CERT_CHECK=$(run_on_node "$CP_IP" "$PRIV $K3S_BIN certificate check 2>&1 || echo 'no cert check command'" 2>/dev/null || echo "check-failed")
  if echo "$CERT_CHECK" | grep -qi "expired"; then
    echo "  ${RED}CERTIFICATES EXPIRED${NC}"
    echo "$CERT_CHECK" | head -5 | while IFS= read -r line; do echo "    $line"; done
    add_issue "K3s certificates are expired — run: $PRIV $K3S_BIN certificate rotate"
  elif echo "$CERT_CHECK" | grep -qi "no cert check"; then
    echo "  ${YELLOW}Certificate check not available (older K3s version)${NC}"
  else
    echo "  ${GREEN}Certificates valid${NC}"
  fi
else
  echo "  ${YELLOW}SKIPPED (control plane unreachable)${NC}"
fi
echo ""

# ══════════════════════════════════════════════════════════════════════
# SUMMARY
# ══════════════════════════════════════════════════════════════════════

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Diagnostic Summary                                      ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  Nodes:       $REACHABLE/$TOTAL_NODES reachable via SSH"
echo "  K3s agents:  $K3S_RUNNING running, $K3S_STOPPED stopped"
echo "  Flannel:     $FLANNEL_OK with interface, $FLANNEL_MISSING missing"
echo ""

if [ -n "$ISSUES" ]; then
  echo "  ${RED}Issues found:${NC}"
  printf "$ISSUES"
  echo ""
else
  echo "  ${GREEN}No issues detected — cluster appears healthy${NC}"
  echo ""
fi

# ══════════════════════════════════════════════════════════════════════
# PHASE 2: REPAIR (only with --fix)
# ══════════════════════════════════════════════════════════════════════

if [ "$DO_FIX" -eq 0 ]; then
  echo "Run with --fix to attempt repairs:"
  echo "  sh recover-cluster.sh --fix"
  echo ""
  rm -rf "$DIAG_DIR"
  exit 0
fi

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Repair Phase                                            ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

FIXED=0
FAILED_FIX=0

# ── Fix 1: Start K3s control plane if down ────────────────────────────
if [ -n "$CP_IP" ] && [ -f "$DIAG_DIR/$CP_NAME.reachable" ]; then
  CP_SVC_STATUS=$(run_on_node "$CP_IP" "$PRIV rc-service k3s status 2>/dev/null || $PRIV systemctl is-active k3s 2>/dev/null || echo stopped" 2>/dev/null || echo "stopped")

  if ! { echo "$CP_SVC_STATUS" | grep -qi "started\|running" || { echo "$CP_SVC_STATUS" | grep -qi "active" && ! echo "$CP_SVC_STATUS" | grep -qi "inactive\|activating"; }; }; then
    log_info "Fix 1: Starting K3s control plane on $CP_NAME..."
    run_on_node "$CP_IP" "$PRIV rc-service k3s start 2>/dev/null || $PRIV systemctl start k3s 2>/dev/null" 2>/dev/null

    # Wait for API server (up to 60s)
    echo "  Waiting for API server..."
    _waited=0
    while [ "$_waited" -lt 60 ]; do
      if run_on_node "$CP_IP" "$PRIV $K3S_BIN kubectl get nodes >/dev/null 2>&1" 2>/dev/null; then
        echo "  ${GREEN}API server ready (${_waited}s)${NC}"
        FIXED=$((FIXED + 1))
        break
      fi
      sleep 5
      _waited=$((_waited + 5))
      printf "  ... %ds\n" "$_waited"
    done

    if [ "$_waited" -ge 60 ]; then
      log_err "API server did not come up within 60s"
      FAILED_FIX=$((FAILED_FIX + 1))
    fi
  else
    echo "  Control plane already running — skipping"
  fi
else
  log_warn "Control plane unreachable — cannot start K3s remotely"
fi
echo ""

# ── Fix 2: Get K3s token automatically ────────────────────────────────
log_info "Fix 2: Retrieving K3s join token..."
K3S_TOKEN=""
if [ -n "$CP_IP" ] && [ -f "$DIAG_DIR/$CP_NAME.reachable" ]; then
  K3S_TOKEN=$(run_on_node "$CP_IP" "$PRIV cat /var/lib/rancher/k3s/server/node-token 2>/dev/null" 2>/dev/null || echo "")
  if [ -n "$K3S_TOKEN" ]; then
    echo "  ${GREEN}Token retrieved${NC} (${#K3S_TOKEN} chars)"
  else
    log_warn "Could not read K3s token — worker node rejoin will be skipped"
  fi
fi
echo ""

# ── Fix 3: Repair worker nodes ───────────────────────────────────────
log_info "Fix 3: Repairing stopped/NotReady worker nodes..."
echo ""

for entry in $NODE_LIST; do
  _name="${entry%%:*}"
  _rest="${entry#*:}"
  _ip="${_rest%%:*}"
  _role="${_rest#*:}"

  # Skip control plane (handled above) and unreachable nodes
  [ "$_role" = "control-plane" ] && continue
  [ ! -f "$DIAG_DIR/$_name.reachable" ] && { printf "  %-8s SKIPPED (unreachable)\n" "$_name"; continue; }

  # Check if agent is running properly
  AGENT_STATUS=$(run_on_node "$_ip" "$PRIV rc-service k3s-agent status 2>/dev/null || $PRIV systemctl is-active k3s-agent 2>/dev/null || echo stopped" 2>/dev/null || echo "check-failed")

  if echo "$AGENT_STATUS" | grep -qi "started\|running" || { echo "$AGENT_STATUS" | grep -qi "active" && ! echo "$AGENT_STATUS" | grep -qi "inactive\|activating"; }; then
    # Check if registered with correct IP
    REGISTERED_IP=$(run_on_node "$_ip" "grep 'node-ip' /etc/rancher/k3s/config.yaml 2>/dev/null | sed 's/.*: *//;s/\"//g' | tr -d ' ' || echo ''" 2>/dev/null || echo "")
    if [ "$REGISTERED_IP" = "$_ip" ] || [ -z "$REGISTERED_IP" ]; then
      printf "  ${GREEN}%-8s${NC} agent running, IP correct\n" "$_name"
      continue
    else
      printf "  ${YELLOW}%-8s${NC} agent running but wrong IP (%s != %s) — fixing\n" "$_name" "$REGISTERED_IP" "$_ip"
    fi
  else
    printf "  ${RED}%-8s${NC} agent %s — fixing\n" "$_name" "$AGENT_STATUS"
  fi

  if [ -z "$K3S_TOKEN" ]; then
    printf "  %-8s SKIPPED (no token available)\n" "$_name"
    FAILED_FIX=$((FAILED_FIX + 1))
    continue
  fi

  # Stop agent
  run_on_node "$_ip" "$PRIV rc-service k3s-agent stop 2>/dev/null || $PRIV systemctl stop k3s-agent 2>/dev/null || true" 2>/dev/null

  # Clean stale agent data
  run_on_node "$_ip" "$PRIV rm -rf /var/lib/rancher/k3s/agent/* 2>/dev/null || true" 2>/dev/null

  # Write correct config with WiFi IP
  run_on_node "$_ip" "$PRIV mkdir -p /etc/rancher/k3s && printf 'server: \"https://${CP_IP}:6443\"\ntoken: \"${K3S_TOKEN}\"\nnode-name: \"${_name}\"\nnode-ip: \"${_ip}\"\n' | $PRIV tee /etc/rancher/k3s/config.yaml >/dev/null" 2>/dev/null

  # Start agent
  run_on_node "$_ip" "$PRIV rc-service k3s-agent start 2>/dev/null || $PRIV systemctl start k3s-agent 2>/dev/null" 2>/dev/null

  # Quick verify
  sleep 3
  NEW_STATUS=$(run_on_node "$_ip" "$PRIV rc-service k3s-agent status 2>/dev/null || $PRIV systemctl is-active k3s-agent 2>/dev/null || echo stopped" 2>/dev/null || echo "check-failed")
  if echo "$NEW_STATUS" | grep -qi "started\|running" || { echo "$NEW_STATUS" | grep -qi "active" && ! echo "$NEW_STATUS" | grep -qi "inactive\|activating"; }; then
    printf "  ${GREEN}%-8s${NC} agent restarted successfully\n" "$_name"
    FIXED=$((FIXED + 1))
  else
    printf "  ${RED}%-8s${NC} agent failed to start\n" "$_name"
    FAILED_FIX=$((FAILED_FIX + 1))
  fi
done

echo ""

# ── Fix 4: Verify cluster state ──────────────────────────────────────
log_info "Fix 4: Verifying cluster state..."
echo ""

# Wait a bit for nodes to register
sleep 10

if [ -n "$CP_IP" ] && [ -f "$DIAG_DIR/$CP_NAME.reachable" ]; then
  FINAL_NODES=$(run_on_node "$CP_IP" "$PRIV $K3S_BIN kubectl get nodes -o wide 2>&1" 2>/dev/null || echo "FAILED")
  if echo "$FINAL_NODES" | grep -q "NAME.*STATUS"; then
    echo "  Final cluster state:"
    echo "$FINAL_NODES" | while IFS= read -r line; do echo "    $line"; done
    echo ""

    FINAL_READY=$(echo "$FINAL_NODES" | grep -c " Ready " || true)
    FINAL_NOTREADY=$(echo "$FINAL_NODES" | grep -c "NotReady" || true)
    echo "  ${GREEN}Ready: $FINAL_READY${NC}  ${RED}NotReady: $FINAL_NOTREADY${NC}"
  else
    echo "  ${YELLOW}kubectl still not responding — cluster may need more time${NC}"
  fi
fi
echo ""

# ── Optional: Restart mining ──────────────────────────────────────────
if [ "$RESTART_MINING" -eq 1 ]; then
  log_info "Restarting mining on all nodes..."
  MINERS_STARTED=0
  for entry in $NODE_LIST; do
    _name="${entry%%:*}"
    _rest="${entry#*:}"
    _ip="${_rest%%:*}"
    [ ! -f "$DIAG_DIR/$_name.reachable" ] && continue

    RESULT=$(run_on_node "$_ip" "$PRIV rc-service xmrig start 2>/dev/null || $PRIV systemctl start xmrig 2>/dev/null; sleep 2; pgrep xmrig >/dev/null 2>&1 && echo MINING || echo FAILED" 2>/dev/null || echo "UNREACHABLE")
    printf "  %-8s %s\n" "$_name" "$RESULT"
    echo "$RESULT" | grep -q "MINING" && MINERS_STARTED=$((MINERS_STARTED + 1))
  done
  echo "  Mining: $MINERS_STARTED nodes started"
  echo ""
fi

# ── Optional: Push fresh status ───────────────────────────────────────
if [ "$PUSH_STATUS" -eq 1 ]; then
  log_info "Pushing fresh status to dashboard..."
  PUSH_SCRIPT=""
  for _try in "$DIR/push-cluster-status.sh" "$SCRIPT_DIR/push-cluster-status.sh"; do
    [ -f "$_try" ] && { PUSH_SCRIPT="$_try"; break; }
  done
  if [ -n "$PUSH_SCRIPT" ]; then
    if sh "$PUSH_SCRIPT" 2>&1; then
      echo "  ${GREEN}Status pushed${NC}"
    else
      echo "  ${YELLOW}Push had errors${NC}"
    fi
  else
    log_warn "push-cluster-status.sh not found"
  fi
  echo ""
fi

# ══════════════════════════════════════════════════════════════════════
# FINAL SUMMARY
# ══════════════════════════════════════════════════════════════════════

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Repair Summary                                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  Fixed:  $FIXED"
echo "  Failed: $FAILED_FIX"
echo ""
echo "  Dashboard: https://www.curtbrag.com/cluster"
echo ""

if [ "$FAILED_FIX" -gt 0 ]; then
  echo "  Some repairs failed. Try:"
  echo "    - Check physical power on unreachable nodes"
  echo "    - Verify WiFi connectivity"
  echo "    - SSH manually: ssh user@<node-ip>"
  echo "    - Check K3s logs: $PRIV journalctl -u k3s-agent -n 50"
  echo ""
fi

rm -rf "$DIAG_DIR"
