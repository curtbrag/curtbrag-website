#!/bin/sh
# Push K3s cluster status to curtbrag.com
# Run this on node1 via cron: */5 * * * * /home/user/push-cluster-status.sh >> /home/user/cluster-push.log 2>&1

set -u

# Source env file if CLUSTER_API_KEY not already set (systemd, cron, nohup contexts)
if [ -z "${CLUSTER_API_KEY:-}" ]; then
  for _f in "${HOME:-/home/user}/.cluster-env" /home/user/.cluster-env; do
    [ -f "$_f" ] && { . "$_f"; break; }
  done
fi

API_URL="https://curtbrag.com/.netlify/functions/cluster-status"
API_KEY="${CLUSTER_API_KEY:?ERROR: CLUSTER_API_KEY not set. Create ~/.cluster-env with: CLUSTER_API_KEY=your-key}"
HOME_DIR="${HOME:-/home/user}"
TMP_DIR="/tmp/cluster-push-$$"

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "Starting cluster status push..."

# SSH port — configurable via env, defaults to 22
# SSH port is determined per-node via get_node_ssh_port() from cluster-nodes.conf (phones=8022, PCs=22)
# SSH username for PC nodes (Linux PCs use 'neo', phones use 'user')
PC_SSH_USER="${PC_SSH_USER:-neo}"

# Load shared node configuration
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/cluster-nodes.conf" ]; then
  . "$SCRIPT_DIR/cluster-nodes.conf"
  load_node_config
  log "Loaded $NODE_COUNT nodes from cluster-nodes.conf"
  # Count PC nodes for dynamic minersTotal
  PC_COUNT=0
  for _pc in ${PC_NODES:-}; do PC_COUNT=$((PC_COUNT + 1)); done
else
  log "WARN: cluster-nodes.conf not found, using hardcoded IPs"
fi

# Check prerequisites
for cmd in jq curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log "ERROR: $cmd not found"
    exit 1
  fi
done

mkdir -p "$TMP_DIR"

# ── Kubernetes data (may be unavailable if K3s is down) ──────────

K3S_UP="false"
if command -v kubectl >/dev/null 2>&1 && timeout 10 kubectl cluster-info >/dev/null 2>&1; then
  K3S_UP="true"
fi

if [ "$K3S_UP" = "true" ]; then
  log "Connected to cluster, gathering K8s data..."

  # Nodes (save raw for reuse)
  NODES_RAW=$(kubectl get nodes -o json 2>/dev/null)
  NODES_JSON=$(echo "$NODES_RAW" | jq -c '[.items[] | {
    name: .metadata.name,
    status: (if (.status.conditions[] | select(.type=="Ready") | .status) == "True" then "Ready" else "NotReady" end),
    role: (if .metadata.labels["node-role.kubernetes.io/control-plane"] then "control-plane" else "worker" end),
    ip: (.status.addresses[] | select(.type=="InternalIP") | .address),
    kubeletVersion: .status.nodeInfo.kubeletVersion,
    osImage: .status.nodeInfo.osImage,
    arch: .status.nodeInfo.architecture
  }]')
  log "Got $(echo "$NODES_JSON" | jq 'length') nodes"

  # Node scheduling (cordon status, taints)
  NODE_SCHEDULING=$(echo "$NODES_RAW" | jq -c '[.items[] | {
    name: .metadata.name,
    unschedulable: (.spec.unschedulable // false),
    taints: [(.spec.taints // [])[] | {key: .key, effect: .effect}]
  }]')

  # Pods with resource requests
  PODS_JSON=$(kubectl get pods -A -o json 2>/dev/null | jq -c '[.items[] | {
    name: .metadata.name,
    namespace: .metadata.namespace,
    status: .status.phase,
    node: (.spec.nodeName // "unscheduled"),
    restarts: ([.status.containerStatuses[]?.restartCount] | add // 0),
    ready: (if .status.containerStatuses then ([.status.containerStatuses[] | select(.ready == true)] | length | tostring) + "/" + ([.status.containerStatuses[]] | length | tostring) else "0/0" end),
    containers: [.spec.containers[]? | .name],
    resources: {
      requests: { cpu: (.spec.containers[0].resources.requests.cpu // null), memory: (.spec.containers[0].resources.requests.memory // null) },
      limits: { cpu: (.spec.containers[0].resources.limits.cpu // null), memory: (.spec.containers[0].resources.limits.memory // null) }
    }
  }]')
  log "Got $(echo "$PODS_JSON" | jq 'length') pods"

  # Services
  SERVICES_JSON=$(kubectl get svc -A -o json 2>/dev/null | jq -c '[.items[] | {
    name: .metadata.name,
    namespace: .metadata.namespace,
    type: .spec.type,
    clusterIP: .spec.clusterIP,
    externalIP: ((.status.loadBalancer.ingress[0].ip // .spec.externalIPs[0]) // null),
    ports: [.spec.ports[]? | "\(.port):\(.nodePort // .targetPort)"]
  }]')
  log "Got $(echo "$SERVICES_JSON" | jq 'length') services"

  # Events (last 50)
  EVENTS_JSON=$(kubectl get events -A --sort-by=.lastTimestamp -o json 2>/dev/null | jq -c '[.items[-50:] | reverse[] | {
    type: (.type // "Normal"),
    reason: (.reason // ""),
    message: (.message // "")[0:200],
    object: ((.involvedObject.kind // "") + "/" + (.involvedObject.name // "")),
    namespace: (.metadata.namespace // ""),
    timestamp: (.lastTimestamp // .metadata.creationTimestamp // ""),
    count: (.count // 1)
  }]' 2>/dev/null || echo '[]')
  log "Got $(echo "$EVENTS_JSON" | jq 'length') events"
else
  log "WARNING: K3s unavailable — synthesizing nodes from SSH reachability"
  NODE_SCHEDULING='[]'
  PODS_JSON='[]'
  SERVICES_JSON='[]'
  EVENTS_JSON='[]'
  # Build a basic nodes array from what we know: 10 phones on 192.168.1.206-215
  NODES_JSON='[]'
  for i in $(seq 1 10); do
    NODE_IP="192.168.1.$((205 + i))"
    NODE_NAME="node$i"
    NODE_ROLE="worker"
    [ "$i" = "1" ] && NODE_ROLE="control-plane"
    # Check reachability: node1 locally, others via SSH (5s timeout)
    if [ "$i" = "1" ]; then
      # Actually verify node1 is functional instead of assuming Ready
      if [ -d /proc ] && [ -r /proc/uptime ]; then
        NODE_STATUS="Ready"
      else
        NODE_STATUS="NotReady"
      fi
    elif ssh -p "$(get_node_ssh_port "$NODE_IP")" -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "user@$NODE_IP" "echo ok" >/dev/null 2>&1; then
      NODE_STATUS="Ready"
    else
      NODE_STATUS="NotReady"
    fi
    NODES_JSON=$(echo "$NODES_JSON" | jq --arg name "$NODE_NAME" --arg status "$NODE_STATUS" --arg role "$NODE_ROLE" --arg ip "$NODE_IP" \
      '. + [{name:$name, status:$status, role:$role, ip:$ip, kubeletVersion:"N/A (K3s down)", osImage:"postmarketOS", arch:"aarch64"}]')
  done
  log "Synthesized $(echo "$NODES_JSON" | jq 'length') nodes from SSH"
fi

# ── Network ─────────────────────────────────────────────────────────

log "Gathering network info..."
NETWORK_JSON='{"tailscale":null,"wifi":null,"localIP":null}'

if command -v tailscale >/dev/null 2>&1; then
  TS_STATUS=$(tailscale status --json 2>/dev/null || echo '{}')
  TS_SELF=$(echo "$TS_STATUS" | jq -c '.Self // null')
  TS_PEERS=$(echo "$TS_STATUS" | jq -c '[.Peer // {} | to_entries[] | {name: .value.HostName, ip: .value.TailscaleIPs[0], online: .value.Online, lastSeen: .value.LastSeen}]')
  if [ "$TS_SELF" != "null" ]; then
    TS_IP=$(echo "$TS_SELF" | jq -r '.TailscaleIPs[0] // empty')
    TS_NAME=$(echo "$TS_SELF" | jq -r '.HostName // empty')
    NETWORK_JSON=$(echo "$NETWORK_JSON" | jq --arg ip "$TS_IP" --arg name "$TS_NAME" --argjson peers "$TS_PEERS" '.tailscale = {ip: $ip, hostname: $name, connected: true, peers: $peers}')
  fi
  # Find NEXUS-PRIME's Tailscale FQDN so the dashboard can auto-connect via funnel
  NP_FQDN=$(echo "$TS_STATUS" | jq -r '[.Peer // {} | to_entries[] | select(.value.HostName == "nexus-prime") | .value.DNSName][0] // empty' 2>/dev/null | sed 's/\.$//')
  if [ -n "$NP_FQDN" ]; then
    NETWORK_JSON=$(echo "$NETWORK_JSON" | jq --arg url "https://$NP_FQDN" '.apiServerUrl = $url')
    log "NEXUS-PRIME funnel URL: https://$NP_FQDN"
  fi
fi

if command -v iw >/dev/null 2>&1; then
  # Auto-detect wireless interface (wlan0, wlp*, mlan0, etc.)
  WIFI_IF=$(iw dev 2>/dev/null | awk '/Interface/{print $2; exit}')
  if [ -n "$WIFI_IF" ]; then
    WIFI_SSID=$(iw dev "$WIFI_IF" link 2>/dev/null | grep SSID | awk '{print $2}' || echo "")
    WIFI_SIGNAL=$(iw dev "$WIFI_IF" link 2>/dev/null | grep signal | awk '{print $2}' || echo "")
    if [ -n "$WIFI_SSID" ]; then
      NETWORK_JSON=$(echo "$NETWORK_JSON" | jq --arg ssid "$WIFI_SSID" --arg signal "$WIFI_SIGNAL" --arg iface "$WIFI_IF" '.wifi = {ssid: $ssid, signal: $signal, interface: $iface, connected: true}')
    fi
  fi
fi

LOCAL_IP=$(ip -4 addr show 2>/dev/null | awk '/inet 192\.168\./{gsub(/\/.*/, "", $2); print $2; exit}')
if [ -n "$LOCAL_IP" ]; then
  NETWORK_JSON=$(echo "$NETWORK_JSON" | jq --arg ip "$LOCAL_IP" '.localIP = $ip')
fi

# ── Per-node metrics + battery (parallel SSH) ───────────────────────

log "Gathering per-node metrics + battery..."
METRICS_JSON='{}'
BATTERY_PHONES='[]'

# Metrics command (shared between local and SSH execution)
METRICS_CMD='echo "CPU:$(top -bn1 2>/dev/null | head -3 | grep -i cpu | head -1)"
echo "MEM:$(free -m 2>/dev/null | grep Mem)"
echo "TEMP:$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo 0)"
echo "DISK:$(df -m / 2>/dev/null | tail -1)"
BD=""; for d in /sys/class/power_supply/*; do [ "$(cat "$d/type" 2>/dev/null)" = "Battery" ] && BD="$d" && break; done
_CAP=$(cat "$BD/capacity" 2>/dev/null || echo -1)
# If capacity > 100, device reports raw charge (µAh) — try to compute % from charge_now/charge_full
if [ "$_CAP" -gt 100 ] 2>/dev/null; then
  _CNOW=$(cat "$BD/charge_now" 2>/dev/null || echo 0)
  _CFULL=$(cat "$BD/charge_full" 2>/dev/null || echo 0)
  if [ "$_CFULL" -gt 0 ] 2>/dev/null; then
    _CAP=$(( _CNOW * 100 / _CFULL ))
  else
    _CAP=-1
  fi
fi
echo "BATT_CAP:$_CAP"
echo "BATT_STATUS:$(cat "$BD/status" 2>/dev/null || echo Unknown)"
echo "BATT_TEMP:$(cat "$BD/temp" 2>/dev/null || echo 0)"
echo "BATT_VOLT:$(cat "$BD/voltage_now" 2>/dev/null || echo 0)"
echo "BATT_HEALTH:$(cat "$BD/health" 2>/dev/null || echo Unknown)"
echo "DISPLAY_MODE:$(cat /home/user/display/.mode 2>/dev/null || echo unknown)"
echo "MINING_LEVEL:$(tr "," "\n" < /etc/xmrig/config.json 2>/dev/null | grep max-threads-hint | tr -cd "0-9" || echo unknown)"
echo "MINING_POOL:$(curl -s http://127.0.0.1:18080/1/summary 2>/dev/null | jq -r ".connection.pool // empty" 2>/dev/null || grep "\"url\"" /etc/xmrig/config.json 2>/dev/null | head -1 | cut -d"\"" -f4 || echo unknown)"'

# Gather from all phone nodes in parallel
for i in $(seq 1 10); do
  (
    set +e  # SSH failures are expected for unreachable nodes
    if [ "$i" = "1" ]; then
      # node1 is localhost — gather metrics locally
      RAW=$(sh -c "$METRICS_CMD" 2>/dev/null)
    else
      NODE_IP="192.168.1.$((205 + i))"
      RAW=$(ssh -p "$(get_node_ssh_port "$NODE_IP")" -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
        "user@$NODE_IP" "$METRICS_CMD" 2>/dev/null)
    fi
    echo "$RAW" > "$TMP_DIR/node${i}.tmp"
  ) &
done
wait || true

# Parse results sequentially
for i in $(seq 1 10); do
  NODE_NAME="node$i"
  TMPFILE="$TMP_DIR/node${i}.tmp"

  if [ ! -s "$TMPFILE" ]; then
    # Node unreachable
    METRICS_JSON=$(echo "$METRICS_JSON" | jq --arg n "$NODE_NAME" '.[$n] = {cpu:{usage:0,cores:null},memory:{totalMB:0,usedMB:0,percent:0},temp:null,storage:{totalMB:0,usedMB:0,availMB:0,percent:0}}')
    BATTERY_PHONES=$(echo "$BATTERY_PHONES" | jq --arg n "$NODE_NAME" '. + [{name:$n,online:false}]')
    continue
  fi

  RAW=$(cat "$TMPFILE")

  # CPU
  CPU_LINE=$(echo "$RAW" | grep "^CPU:" || echo "")
  IDLE=$(echo "$CPU_LINE" | sed -n 's/.*[^0-9]\([0-9][0-9]*\)% *id[le]*.*/\1/p' | head -1)
  if [ -n "$IDLE" ]; then
    CPU_USAGE=$((100 - IDLE))
  else
    USR=$(echo "$CPU_LINE" | sed -n 's/.*[^0-9]\([0-9][0-9]*\)% *usr.*/\1/p' | head -1)
    SYS=$(echo "$CPU_LINE" | sed -n 's/.*[^0-9]\([0-9][0-9]*\)% *sys.*/\1/p' | head -1)
    CPU_USAGE=$(( ${USR:-0} + ${SYS:-0} ))
  fi

  # Memory
  MEM_LINE=$(echo "$RAW" | grep "^MEM:" | sed 's/^MEM://')
  MEM_TOTAL=$(echo "$MEM_LINE" | awk '{print $2}')
  MEM_USED=$(echo "$MEM_LINE" | awk '{print $3}')
  MEM_PCT=0
  if [ -n "$MEM_TOTAL" ] && [ "$MEM_TOTAL" -gt 0 ] 2>/dev/null; then
    MEM_PCT=$((MEM_USED * 100 / MEM_TOTAL))
  fi

  # Temperature
  TEMP_RAW=$(echo "$RAW" | grep "^TEMP:" | sed 's/^TEMP://' | tr -d ' ')
  TEMP_C=0
  if [ -n "$TEMP_RAW" ] && [ "$TEMP_RAW" -gt 0 ] 2>/dev/null; then
    [ "$TEMP_RAW" -gt 1000 ] && TEMP_C=$((TEMP_RAW / 1000)) || TEMP_C="$TEMP_RAW"
  fi

  # Disk
  DISK_LINE=$(echo "$RAW" | grep "^DISK:" | sed 's/^DISK://')
  DISK_TOTAL=$(echo "$DISK_LINE" | awk '{print $2}')
  DISK_USED=$(echo "$DISK_LINE" | awk '{print $3}')
  DISK_AVAIL=$(echo "$DISK_LINE" | awk '{print $4}')
  DISK_PCT=$(echo "$DISK_LINE" | awk '{print $5}' | tr -d '%')

  # Battery
  BATT_CAP=$(echo "$RAW" | grep "^BATT_CAP:" | sed 's/^BATT_CAP://' | tr -d ' ')
  # Clamp to valid range (conversion from µAh is now done at collection time)
  if [ "${BATT_CAP:--1}" -gt 100 ] 2>/dev/null; then BATT_CAP="100"; fi
  BATT_STATUS=$(echo "$RAW" | grep "^BATT_STATUS:" | sed 's/^BATT_STATUS://' | tr -d ' ')
  BATT_TEMP_RAW=$(echo "$RAW" | grep "^BATT_TEMP:" | sed 's/^BATT_TEMP://' | tr -d ' ')
  BATT_VOLT=$(echo "$RAW" | grep "^BATT_VOLT:" | sed 's/^BATT_VOLT://' | tr -d ' ')
  BATT_HEALTH=$(echo "$RAW" | grep "^BATT_HEALTH:" | sed 's/^BATT_HEALTH://' | tr -d ' ')

  BATT_CHARGING="false"
  { [ "$BATT_STATUS" = "Charging" ] || [ "$BATT_STATUS" = "Full" ]; } && BATT_CHARGING="true"

  # Build metrics JSON for this node
  BATT_BLOCK="null"
  if [ "${BATT_CAP:--1}" != "-1" ]; then
    BATT_TEMP_C=0
    [ "${BATT_TEMP_RAW:-0}" -gt 0 ] 2>/dev/null && BATT_TEMP_C=$((BATT_TEMP_RAW / 10))
    BATT_BLOCK=$(jq -n --argjson lv "${BATT_CAP:-0}" --argjson ch "$BATT_CHARGING" --argjson bt "$BATT_TEMP_C" '{level:$lv,charging:$ch,temperature:$bt}')
  fi

  TEMP_BLOCK="null"
  [ "$TEMP_C" -gt 0 ] 2>/dev/null && TEMP_BLOCK=$(jq -n --argjson c "$TEMP_C" '{celsius:$c}')

  # Display mode
  DISP_MODE=$(echo "$RAW" | grep "^DISPLAY_MODE:" | sed 's/^DISPLAY_MODE://' | tr -d ' ')
  [ -z "$DISP_MODE" ] && DISP_MODE="unknown"

  # Mining config
  MINING_LVL=$(echo "$RAW" | grep "^MINING_LEVEL:" | sed 's/^MINING_LEVEL://' | tr -d ' ')
  [ -z "$MINING_LVL" ] && MINING_LVL="unknown"
  MINING_POOL_URL=$(echo "$RAW" | grep "^MINING_POOL:" | sed 's/^MINING_POOL://' | tr -d ' ')
  [ -z "$MINING_POOL_URL" ] && MINING_POOL_URL="unknown"

  NODE_M=$(jq -n \
    --argjson cu "${CPU_USAGE:-0}" \
    --argjson mt "${MEM_TOTAL:-0}" --argjson mu "${MEM_USED:-0}" --argjson mp "${MEM_PCT:-0}" \
    --argjson dt "${DISK_TOTAL:-0}" --argjson du "${DISK_USED:-0}" --argjson da "${DISK_AVAIL:-0}" --argjson dp "${DISK_PCT:-0}" \
    --argjson temp "$TEMP_BLOCK" --argjson batt "$BATT_BLOCK" --arg dm "$DISP_MODE" --arg ml "$MINING_LVL" --arg mp2 "$MINING_POOL_URL" \
    '{cpu:{usage:$cu,cores:null},memory:{totalMB:$mt,usedMB:$mu,percent:$mp},temp:$temp,storage:{totalMB:$dt,usedMB:$du,availMB:$da,percent:$dp},battery:$batt,displayMode:$dm,miningLevel:$ml,miningPool:$mp2}')

  METRICS_JSON=$(echo "$METRICS_JSON" | jq --arg n "$NODE_NAME" --argjson m "$NODE_M" '.[$n] = $m')

  # Battery array entry
  if [ "${BATT_CAP:--1}" != "-1" ]; then
    BATTERY_PHONES=$(echo "$BATTERY_PHONES" | jq \
      --arg n "$NODE_NAME" --argjson lv "${BATT_CAP:-0}" --arg st "$BATT_STATUS" --argjson ch "$BATT_CHARGING" \
      --argjson bt "${BATT_TEMP_RAW:-0}" --argjson vt "${BATT_VOLT:-0}" --arg hl "$BATT_HEALTH" \
      '. + [{name:$n, online:true, level:$lv, status:$st, charging:$ch, temp:(if $bt > 0 then ($bt/10|floor|tostring) else null end), voltage:(if $vt > 0 then (($vt/1000000*100|round)/100|tostring) else null end), health:$hl}]')
  else
    BATTERY_PHONES=$(echo "$BATTERY_PHONES" | jq --arg n "$NODE_NAME" '. + [{name:$n,online:true,level:null}]')
  fi

  log "  $NODE_NAME: CPU=${CPU_USAGE:-?}% MEM=${MEM_PCT:-?}% TEMP=${TEMP_C}C BATT=${BATT_CAP:--}%"
done
rm -f "$TMP_DIR"/node*.tmp

# Battery summary
BATT_ONLINE=$(echo "$BATTERY_PHONES" | jq '[.[] | select(.online and .level != null)] | length')
BATT_AVG=$(echo "$BATTERY_PHONES" | jq '[.[] | select(.online and .level != null) | .level] | if length > 0 then (add/length|round) else 0 end')
BATT_CHARGING_CT=$(echo "$BATTERY_PHONES" | jq '[.[] | select(.charging == true)] | length')
BATT_LOW=$(echo "$BATTERY_PHONES" | jq '[.[] | select(.online and .level != null and .level < 20)] | length')
BATT_CRIT=$(echo "$BATTERY_PHONES" | jq '[.[] | select(.online and .level != null and .level < 10)] | length')

BATTERY_DATA=$(jq -n \
  --argjson phones "$BATTERY_PHONES" \
  --argjson avg "$BATT_AVG" --argjson chg "$BATT_CHARGING_CT" \
  --argjson low "$BATT_LOW" --argjson crit "$BATT_CRIT" --argjson on "$BATT_ONLINE" \
  '{phones:$phones, summary:{avgLevel:$avg, charging:$chg, low:$low, critical:$crit, online:$on, total:10}}')
log "Battery: $BATT_ONLINE reporting, avg ${BATT_AVG}%"

# ── PC node metrics (CPU/memory/temp via SSH) ───────────────────────

PC_METRICS_CMD='echo "CPU:$(top -bn1 2>/dev/null | head -3 | grep -i cpu | head -1)"
echo "MEM:$(free -m 2>/dev/null | grep Mem)"
echo "TEMP:$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo 0)"
echo "DISK:$(df -m / 2>/dev/null | tail -1)"'

for pc_entry in ${PC_NODES:-}; do
  (
    set +e
    pc_name="${pc_entry%%:*}"
    pc_ip="${pc_entry#*:}"
    pc_user=$(get_pc_ssh_user "$pc_name")
    RAW=$(ssh -p "$(get_node_ssh_port "$pc_ip")" -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
      "${pc_user}@${pc_ip}" "$PC_METRICS_CMD" 2>/dev/null)
    echo "$RAW" > "$TMP_DIR/pcmetrics_${pc_name}.tmp"
  ) &
done
wait || true

for pc_entry in ${PC_NODES:-}; do
  pc_name="${pc_entry%%:*}"
  TMPFILE="$TMP_DIR/pcmetrics_${pc_name}.tmp"
  if [ ! -s "$TMPFILE" ]; then
    METRICS_JSON=$(echo "$METRICS_JSON" | jq --arg n "$pc_name" '.[$n] = {cpu:{usage:0,cores:null},memory:{totalMB:0,usedMB:0,percent:0},temp:null,storage:{totalMB:0,usedMB:0,availMB:0,percent:0}}')
    continue
  fi
  RAW=$(cat "$TMPFILE")
  CPU_LINE=$(echo "$RAW" | grep "^CPU:" || echo "")
  IDLE=$(echo "$CPU_LINE" | sed -n 's/.*[^0-9]\([0-9][0-9]*\)% *id[le]*.*/\1/p' | head -1)
  if [ -n "$IDLE" ]; then CPU_USAGE=$((100 - IDLE)); else CPU_USAGE=0; fi
  MEM_LINE=$(echo "$RAW" | grep "^MEM:" | sed 's/^MEM://')
  MEM_TOTAL=$(echo "$MEM_LINE" | awk '{print $2}')
  MEM_USED=$(echo "$MEM_LINE" | awk '{print $3}')
  MEM_PCT=0
  [ "${MEM_TOTAL:-0}" -gt 0 ] 2>/dev/null && MEM_PCT=$((MEM_USED * 100 / MEM_TOTAL))
  TEMP_RAW=$(echo "$RAW" | grep "^TEMP:" | sed 's/^TEMP://' | tr -d ' ')
  TEMP_C=0
  [ "${TEMP_RAW:-0}" -gt 1000 ] 2>/dev/null && TEMP_C=$((TEMP_RAW / 1000))
  DISK_LINE=$(echo "$RAW" | grep "^DISK:" | sed 's/^DISK://')
  DISK_TOTAL=$(echo "$DISK_LINE" | awk '{print $2}')
  DISK_USED=$(echo "$DISK_LINE" | awk '{print $3}')
  DISK_AVAIL=$(echo "$DISK_LINE" | awk '{print $4}')
  DISK_PCT=$(echo "$DISK_LINE" | awk '{print $5}' | tr -d '%')
  TEMP_BLOCK="null"
  [ "${TEMP_C:-0}" -gt 0 ] 2>/dev/null && TEMP_BLOCK=$(jq -n --argjson c "$TEMP_C" '{celsius:$c}')
  PC_M=$(jq -n \
    --argjson cu "${CPU_USAGE:-0}" \
    --argjson mt "${MEM_TOTAL:-0}" --argjson mu "${MEM_USED:-0}" --argjson mp "${MEM_PCT:-0}" \
    --argjson dt "${DISK_TOTAL:-0}" --argjson du "${DISK_USED:-0}" --argjson da "${DISK_AVAIL:-0}" --argjson dp "${DISK_PCT:-0}" \
    --argjson temp "$TEMP_BLOCK" \
    '{cpu:{usage:$cu,cores:null},memory:{totalMB:$mt,usedMB:$mu,percent:$mp},temp:$temp,storage:{totalMB:$dt,usedMB:$du,availMB:$da,percent:$dp}}')
  METRICS_JSON=$(echo "$METRICS_JSON" | jq --arg n "$pc_name" --argjson m "$PC_M" '.[$n] = $m')
  log "  $pc_name: CPU=${CPU_USAGE:-?}% MEM=${MEM_PCT:-?}% TEMP=${TEMP_C}C"
done
rm -f "$TMP_DIR"/pcmetrics_*.tmp

# ── Mining stats (curl xmrig API on each phone) ─────────────────────

log "Gathering mining stats..."
MINING_WORKERS='[]'
TOTAL_HR=0
TOTAL_ACC=0
TOTAL_REJ=0

# Check xmrig API on all nodes in parallel (faster than sequential)
for i in $(seq 1 10); do
  (
    set +e  # SSH/curl failures are expected for unreachable nodes
    NODE_IP="192.168.1.$((205 + i))"
    # Try local curl first (works for node1 where xmrig binds to 127.0.0.1)
    XMRIG=""
    if [ "$i" = "1" ]; then
      XMRIG=$(curl -s --connect-timeout 5 --max-time 8 "http://127.0.0.1:18080/1/summary" 2>/dev/null)
    else
      # xmrig binds to localhost, so query via SSH tunnel to the remote node
      XMRIG=$(ssh -p "$(get_node_ssh_port "$NODE_IP")" -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
        "user@$NODE_IP" "curl -s --connect-timeout 3 --max-time 5 http://127.0.0.1:18080/1/summary 2>/dev/null" 2>/dev/null)
    fi
    if [ -n "$XMRIG" ] && echo "$XMRIG" | jq . >/dev/null 2>&1; then
      echo "$XMRIG" > "$TMP_DIR/mining_node${i}.tmp"
    else
      # API failed — check if xmrig process is actually running
      PROC_CHECK=""
      if [ "$i" = "1" ]; then
        pgrep xmrig >/dev/null 2>&1 && PROC_CHECK="running"
      else
        ssh -p "$(get_node_ssh_port "$NODE_IP")" -o ConnectTimeout=3 -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
          "user@$NODE_IP" "pgrep xmrig >/dev/null 2>&1 && echo running" 2>/dev/null | grep -q running && PROC_CHECK="running"
      fi
      if [ "$PROC_CHECK" = "running" ]; then
        echo "PROC_RUNNING" > "$TMP_DIR/mining_node${i}.tmp"
      else
        echo "" > "$TMP_DIR/mining_node${i}.tmp"
      fi
    fi
  ) &
done

# Check xmrig API on PC nodes in parallel
for pc_entry in ${PC_NODES:-}; do
  (
    set +e
    pc_name="${pc_entry%%:*}"
    pc_ip="${pc_entry#*:}"
    pc_user=$(get_pc_ssh_user "$pc_name")
    XMRIG=$(ssh -p "$(get_node_ssh_port "$pc_ip")" -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
      "${pc_user}@$pc_ip" "curl -s --connect-timeout 3 --max-time 5 http://127.0.0.1:18080/1/summary 2>/dev/null" 2>/dev/null)
    if [ -n "$XMRIG" ] && echo "$XMRIG" | jq . >/dev/null 2>&1; then
      echo "$XMRIG" > "$TMP_DIR/mining_${pc_name}.tmp"
    else
      PROC_CHECK=""
      ssh -p "$(get_node_ssh_port "$pc_ip")" -o ConnectTimeout=3 -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
        "${pc_user}@$pc_ip" "pgrep xmrig >/dev/null 2>&1 && echo running" 2>/dev/null | grep -q running && PROC_CHECK="running"
      if [ "$PROC_CHECK" = "running" ]; then
        echo "PROC_RUNNING" > "$TMP_DIR/mining_${pc_name}.tmp"
      else
        echo "" > "$TMP_DIR/mining_${pc_name}.tmp"
      fi
    fi
  ) &
done

wait || true

for i in $(seq 1 10); do
  NODE_NAME="node$i"
  TMPFILE="$TMP_DIR/mining_node${i}.tmp"
  XMRIG=""
  [ -f "$TMPFILE" ] && XMRIG=$(cat "$TMPFILE")

  # Get mining level from already-collected metrics
  NODE_ML=$(echo "$METRICS_JSON" | jq -r --arg n "$NODE_NAME" '.[$n].miningLevel // "unknown"')

  if [ "$XMRIG" = "PROC_RUNNING" ]; then
    # Process is running but API didn't respond — report as mining with unknown hashrate
    MINING_WORKERS=$(echo "$MINING_WORKERS" | jq --arg n "$NODE_NAME" --arg ml "$NODE_ML" \
      '. + [{name:$n, hashrate:"? H/s", hashrateRaw:0, status:"mining", accepted:0, note:"api_timeout", miningLevel:$ml}]')
    log "  $NODE_NAME mining (process running, API unavailable)"
  elif [ -n "$XMRIG" ] && echo "$XMRIG" | jq . >/dev/null 2>&1; then
    HR=$(echo "$XMRIG" | jq '.hashrate.total[0] // 0')
    ACC=$(echo "$XMRIG" | jq '.results.shares_good // 0')
    TOT_SH=$(echo "$XMRIG" | jq '.results.shares_total // 0')
    REJ=$((TOT_SH - ACC))
    UPT=$(echo "$XMRIG" | jq '.uptime // 0')
    ALGO=$(echo "$XMRIG" | jq -r '.algo // "unknown"')
    THREADS=$(echo "$XMRIG" | jq '.cpu.threads // null')

    HR_INT=$(printf '%.0f' "$HR" 2>/dev/null || echo 0)
    if [ "$HR_INT" -ge 1000000 ] 2>/dev/null; then
      HR_FMT="$(awk "BEGIN{printf \"%.2f\", $HR/1000000}") MH/s"
    elif [ "$HR_INT" -ge 1000 ] 2>/dev/null; then
      HR_FMT="$(awk "BEGIN{printf \"%.2f\", $HR/1000}") KH/s"
    else
      HR_FMT="${HR_INT} H/s"
    fi

    MINING_WORKERS=$(echo "$MINING_WORKERS" | jq \
      --arg n "$NODE_NAME" --arg hr "$HR_FMT" --argjson hrr "$HR" \
      --argjson acc "$ACC" --argjson rej "$REJ" --argjson upt "$UPT" \
      --arg algo "$ALGO" --argjson thr "$THREADS" --arg ml "$NODE_ML" \
      '. + [{name:$n, hashrate:$hr, hashrateRaw:$hrr, status:"mining", accepted:$acc, rejected:$rej, uptime:$upt, algo:$algo, threads:$thr, miningLevel:$ml}]')

    TOTAL_HR=$(awk "BEGIN{printf \"%.2f\", $TOTAL_HR + $HR}")
    TOTAL_ACC=$((TOTAL_ACC + ACC))
    TOTAL_REJ=$((TOTAL_REJ + REJ))
    log "  $NODE_NAME mining: $HR_FMT"
  else
    MINING_WORKERS=$(echo "$MINING_WORKERS" | jq --arg n "$NODE_NAME" --arg ml "$NODE_ML" '. + [{name:$n, hashrate:"0 H/s", hashrateRaw:0, status:"offline", accepted:0, miningLevel:$ml}]')
  fi
done
# Parse PC node mining results
for pc_entry in ${PC_NODES:-}; do
  pc_name="${pc_entry%%:*}"
  TMPFILE="$TMP_DIR/mining_${pc_name}.tmp"
  XMRIG=""
  [ -f "$TMPFILE" ] && XMRIG=$(cat "$TMPFILE")

  if [ "$XMRIG" = "PROC_RUNNING" ]; then
    MINING_WORKERS=$(echo "$MINING_WORKERS" | jq --arg n "$pc_name" \
      '. + [{name:$n, hashrate:"? H/s", hashrateRaw:0, status:"mining", accepted:0, note:"api_timeout"}]')
    log "  $pc_name mining (process running, API unavailable)"
  elif [ -n "$XMRIG" ] && echo "$XMRIG" | jq . >/dev/null 2>&1; then
    HR=$(echo "$XMRIG" | jq '.hashrate.total[0] // 0')
    ACC=$(echo "$XMRIG" | jq '.results.shares_good // 0')
    TOT_SH=$(echo "$XMRIG" | jq '.results.shares_total // 0')
    REJ=$((TOT_SH - ACC))
    UPT=$(echo "$XMRIG" | jq '.uptime // 0')
    ALGO=$(echo "$XMRIG" | jq -r '.algo // "unknown"')
    THREADS=$(echo "$XMRIG" | jq '.cpu.threads // null')

    HR_INT=$(printf '%.0f' "$HR" 2>/dev/null || echo 0)
    if [ "$HR_INT" -ge 1000000 ] 2>/dev/null; then
      HR_FMT="$(awk "BEGIN{printf \"%.2f\", $HR/1000000}") MH/s"
    elif [ "$HR_INT" -ge 1000 ] 2>/dev/null; then
      HR_FMT="$(awk "BEGIN{printf \"%.2f\", $HR/1000}") KH/s"
    else
      HR_FMT="${HR_INT} H/s"
    fi

    MINING_WORKERS=$(echo "$MINING_WORKERS" | jq \
      --arg n "$pc_name" --arg hr "$HR_FMT" --argjson hrr "$HR" \
      --argjson acc "$ACC" --argjson rej "$REJ" --argjson upt "$UPT" \
      --arg algo "$ALGO" --argjson thr "$THREADS" \
      '. + [{name:$n, hashrate:$hr, hashrateRaw:$hrr, status:"mining", accepted:$acc, rejected:$rej, uptime:$upt, algo:$algo, threads:$thr}]')

    TOTAL_HR=$(awk "BEGIN{printf \"%.2f\", $TOTAL_HR + $HR}")
    TOTAL_ACC=$((TOTAL_ACC + ACC))
    TOTAL_REJ=$((TOTAL_REJ + REJ))
    log "  $pc_name mining: $HR_FMT"
  else
    MINING_WORKERS=$(echo "$MINING_WORKERS" | jq --arg n "$pc_name" \
      '. + [{name:$n, hashrate:"0 H/s", hashrateRaw:0, status:"offline", accepted:0}]')
    log "  $pc_name not mining"
  fi
done
rm -f "$TMP_DIR"/mining_*.tmp

MINERS_RUNNING=$(echo "$MINING_WORKERS" | jq '[.[] | select(.status=="mining")] | length')

# Format total hashrate
THR_INT=$(printf '%.0f' "$TOTAL_HR" 2>/dev/null || echo 0)
if [ "$THR_INT" -ge 1000000 ] 2>/dev/null; then
  THR_FMT="$(awk "BEGIN{printf \"%.2f\", $TOTAL_HR/1000000}") MH/s"
elif [ "$THR_INT" -ge 1000 ] 2>/dev/null; then
  THR_FMT="$(awk "BEGIN{printf \"%.2f\", $TOTAL_HR/1000}") KH/s"
else
  THR_FMT="${THR_INT:-0} H/s"
fi

# Estimate XMR earnings: (hashrate / network_hashrate) * daily_blocks * block_reward * xmr_price
# Try live network stats, fall back to approximate values
XMR_PRICE=150
NET_HR=2500000000
NET_STATS=$(curl -s --connect-timeout 5 --max-time 8 "https://moneroj.net/api/v1/network" 2>/dev/null)
if [ -n "$NET_STATS" ] && echo "$NET_STATS" | jq . >/dev/null 2>&1; then
  _DIFF=$(echo "$NET_STATS" | jq '.difficulty // 0')
  _PRICE=$(echo "$NET_STATS" | jq '.value // 0')
  [ "$_DIFF" -gt 0 ] 2>/dev/null && NET_HR=$(awk "BEGIN{printf \"%.0f\", $_DIFF / 120}")
  [ "$(echo "$_PRICE" | awk '{print ($1 > 0)}')" = "1" ] && XMR_PRICE="$_PRICE"
fi
DAILY_XMR=$(awk "BEGIN{printf \"%.8f\", ($TOTAL_HR / $NET_HR) * 720 * 0.6}")
DAILY_USD=$(awk "BEGIN{printf \"%.4f\", $DAILY_XMR * $XMR_PRICE}")
MONTHLY_USD=$(awk "BEGIN{printf \"%.2f\", $DAILY_USD * 30}")
DAILY_FMT=$(printf '$%.2f' "$DAILY_USD" 2>/dev/null || echo '$0.00')
MONTHLY_FMT=$(printf '$%.2f' "$MONTHLY_USD" 2>/dev/null || echo '$0.00')

MINING_ENABLED="false"
[ "$MINERS_RUNNING" -gt 0 ] && MINING_ENABLED="true"
MINERS_TOTAL=$((10 + ${PC_COUNT:-0}))

# Read pool URL dynamically from node1's metrics (already collected)
POOL_URL=$(echo "$METRICS_JSON" | jq -r '.node1.miningPool // "unknown"')
POOL_NAME="$POOL_URL"

MINING_JSON=$(jq -n \
  --argjson en "$MINING_ENABLED" --argjson mr "$MINERS_RUNNING" \
  --arg thr "$THR_FMT" --argjson thrr "$TOTAL_HR" \
  --argjson tacc "$TOTAL_ACC" --argjson trej "$TOTAL_REJ" \
  --arg ed "$DAILY_FMT" --arg em "$MONTHLY_FMT" \
  --argjson wk "$MINING_WORKERS" --arg pool "$POOL_NAME" --arg poolUrl "$POOL_URL" \
  --argjson mt "$MINERS_TOTAL" \
  '{enabled:$en, minersRunning:$mr, minersTotal:$mt, totalHashrate:$thr, totalHashrateRaw:$thrr, totalAccepted:$tacc, totalRejected:$trej, coin:"XMR", pool:$pool, poolUrl:$poolUrl, estimatedDaily:$ed, estimatedMonthly:$em, workers:$wk}')
log "Mining: $MINERS_RUNNING running, total $THR_FMT"

# ── Summary ─────────────────────────────────────────────────────────

if [ "$K3S_UP" = "true" ]; then
  NODES_READY=$(echo "$NODES_JSON" | jq '[.[] | select(.status=="Ready")] | length')
  NODES_TOTAL=$(echo "$NODES_JSON" | jq 'length')
  PODS_RUNNING=$(echo "$PODS_JSON" | jq '[.[] | select(.status=="Running")] | length')
  PODS_TOTAL=$(echo "$PODS_JSON" | jq 'length')
  PODS_PENDING=$(echo "$PODS_JSON" | jq '[.[] | select(.status=="Pending")] | length')
  PODS_FAILED=$(echo "$PODS_JSON" | jq '[.[] | select(.status=="Failed")] | length')
  TOTAL_RESTARTS=$(echo "$PODS_JSON" | jq '[.[].restarts] | add // 0')

  # Health score
  NODE_PCT=0; [ "$NODES_TOTAL" -gt 0 ] && NODE_PCT=$((NODES_READY * 100 / NODES_TOTAL))
  POD_PCT=0; [ "$PODS_TOTAL" -gt 0 ] && POD_PCT=$((PODS_RUNNING * 100 / PODS_TOTAL))
  HEALTH_SCORE=$(( (NODE_PCT * 60 + POD_PCT * 40) / 100 ))
  [ "$PODS_FAILED" -gt 0 ] && HEALTH_SCORE=$((HEALTH_SCORE - PODS_FAILED * 5))
  [ "$HEALTH_SCORE" -lt 0 ] && HEALTH_SCORE=0
else
  # Even without K3s, count synthesized nodes
  NODES_READY=$(echo "$NODES_JSON" | jq '[.[] | select(.status=="Ready")] | length')
  NODES_TOTAL=$(echo "$NODES_JSON" | jq 'length')
  PODS_RUNNING=0; PODS_TOTAL=0; PODS_PENDING=0; PODS_FAILED=0
  TOTAL_RESTARTS=0
  # Health score based on node reachability alone
  NODE_PCT=0; [ "$NODES_TOTAL" -gt 0 ] && NODE_PCT=$((NODES_READY * 100 / NODES_TOTAL))
  HEALTH_SCORE=$NODE_PCT
fi

log "Summary: $NODES_READY/$NODES_TOTAL nodes, $PODS_RUNNING/$PODS_TOTAL pods, health=$HEALTH_SCORE%"

# ── Job queue metrics (Redis workers) ─────────────────────────────────
# Collect worker status and queue depths if Redis is reachable

WORKERS_JSON="[]"
if command -v redis-cli >/dev/null 2>&1; then
  REDIS_HOST="${REDIS_HOST:-10.0.0.1}"
  if redis-cli -h "$REDIS_HOST" PING 2>/dev/null | grep -q PONG; then
    log "Collecting job queue metrics from Redis..."

    # Queue depths (all pipeline types)
    Q_SHELL=$(redis-cli -h "$REDIS_HOST" LLEN jobs:shell 2>/dev/null || echo 0)
    Q_WHISPER=$(redis-cli -h "$REDIS_HOST" LLEN jobs:whisper 2>/dev/null || echo 0)
    Q_LLM=$(redis-cli -h "$REDIS_HOST" LLEN jobs:llm 2>/dev/null || echo 0)
    Q_GENERIC=$(redis-cli -h "$REDIS_HOST" LLEN jobs:generic 2>/dev/null || echo 0)
    Q_IMAGE=$(redis-cli -h "$REDIS_HOST" LLEN jobs:image 2>/dev/null || echo 0)
    Q_AUDIO=$(redis-cli -h "$REDIS_HOST" LLEN jobs:audio 2>/dev/null || echo 0)
    R_SHELL=$(redis-cli -h "$REDIS_HOST" LLEN results:shell 2>/dev/null || echo 0)
    R_WHISPER=$(redis-cli -h "$REDIS_HOST" LLEN results:whisper 2>/dev/null || echo 0)
    R_LLM=$(redis-cli -h "$REDIS_HOST" LLEN results:llm 2>/dev/null || echo 0)
    R_IMAGE=$(redis-cli -h "$REDIS_HOST" LLEN results:image 2>/dev/null || echo 0)
    R_AUDIO=$(redis-cli -h "$REDIS_HOST" LLEN results:audio 2>/dev/null || echo 0)
    TOTAL_JOBS_DONE=$(redis-cli -h "$REDIS_HOST" GET stats:total:jobs_done 2>/dev/null || echo 0)
    [ -z "$TOTAL_JOBS_DONE" ] && TOTAL_JOBS_DONE=0
    TOTAL_DISPATCHED=$(redis-cli -h "$REDIS_HOST" GET stats:total:dispatched 2>/dev/null || echo 0)
    [ -z "$TOTAL_DISPATCHED" ] && TOTAL_DISPATCHED=0

    # Per-worker status
    WORKER_LIST=""
    for i in $(seq 1 10); do
      W_INFO=$(redis-cli -h "$REDIS_HOST" GET "worker:node${i}" 2>/dev/null)
      W_HB=$(redis-cli -h "$REDIS_HOST" GET "worker:node${i}:heartbeat" 2>/dev/null)
      W_ACTIVE=$(redis-cli -h "$REDIS_HOST" GET "worker:node${i}:active" 2>/dev/null)
      W_JOBS=$(redis-cli -h "$REDIS_HOST" GET "stats:node${i}:jobs_done" 2>/dev/null || echo 0)
      [ -z "$W_JOBS" ] && W_JOBS=0

      if [ -n "$W_INFO" ] && [ "$W_INFO" != "(nil)" ]; then
        HB_AGO=""
        if [ -n "$W_HB" ] && [ "$W_HB" != "(nil)" ]; then
          NOW=$(date +%s)
          HB_AGO=$((NOW - W_HB))
        fi
        WORKER_ENTRY=$(jq -n \
          --arg name "node${i}" \
          --arg info "$W_INFO" \
          --argjson heartbeat_age "${HB_AGO:-null}" \
          --arg active "${W_ACTIVE:-}" \
          --argjson jobs_done "$W_JOBS" \
          '{name: $name, heartbeat_age: $heartbeat_age, active: $active, jobs_done: $jobs_done}')
        WORKER_LIST="${WORKER_LIST:+$WORKER_LIST,}$WORKER_ENTRY"
      fi
    done

    WORKERS_JSON=$(jq -n \
      --argjson q_shell "$Q_SHELL" \
      --argjson q_whisper "$Q_WHISPER" \
      --argjson q_llm "$Q_LLM" \
      --argjson q_generic "$Q_GENERIC" \
      --argjson q_image "$Q_IMAGE" \
      --argjson q_audio "$Q_AUDIO" \
      --argjson r_shell "$R_SHELL" \
      --argjson r_whisper "$R_WHISPER" \
      --argjson r_llm "$R_LLM" \
      --argjson r_image "$R_IMAGE" \
      --argjson r_audio "$R_AUDIO" \
      --argjson total_done "${TOTAL_JOBS_DONE:-0}" \
      --argjson total_dispatched "${TOTAL_DISPATCHED:-0}" \
      "{
        queues: {shell: \$q_shell, whisper: \$q_whisper, llm: \$q_llm, generic: \$q_generic, image: \$q_image, audio: \$q_audio},
        results: {shell: \$r_shell, whisper: \$r_whisper, llm: \$r_llm, image: \$r_image, audio: \$r_audio},
        total_jobs_done: \$total_done,
        total_dispatched: \$total_dispatched,
        workers: [${WORKER_LIST}]
      }")

    log "Job queue: shell=$Q_SHELL whisper=$Q_WHISPER llm=$Q_LLM image=$Q_IMAGE audio=$Q_AUDIO | dispatched=$TOTAL_DISPATCHED done=$TOTAL_JOBS_DONE"
  else
    log "Redis not reachable at $REDIS_HOST — skipping job queue metrics"
  fi
else
  log "redis-cli not installed — skipping job queue metrics"
fi

# ── Build & push payload ────────────────────────────────────────────

PAYLOAD=$(jq -n \
  --argjson nodes "$NODES_JSON" \
  --argjson pods "$PODS_JSON" \
  --argjson services "$SERVICES_JSON" \
  --argjson network "$NETWORK_JSON" \
  --argjson metrics "$METRICS_JSON" \
  --argjson battery "$BATTERY_DATA" \
  --argjson mining "$MINING_JSON" \
  --argjson events "$EVENTS_JSON" \
  --argjson nodeScheduling "$NODE_SCHEDULING" \
  --argjson nodesReady "$NODES_READY" \
  --argjson nodesTotal "$NODES_TOTAL" \
  --argjson podsRunning "$PODS_RUNNING" \
  --argjson podsTotal "$PODS_TOTAL" \
  --argjson podsPending "$PODS_PENDING" \
  --argjson podsFailed "$PODS_FAILED" \
  --argjson totalRestarts "$TOTAL_RESTARTS" \
  --argjson healthScore "$HEALTH_SCORE" \
  --argjson jobQueue "$WORKERS_JSON" \
  '{
    nodes: $nodes,
    pods: $pods,
    services: $services,
    network: $network,
    metrics: $metrics,
    battery: $battery,
    mining: $mining,
    events: $events,
    nodeScheduling: $nodeScheduling,
    jobQueue: $jobQueue,
    summary: {
      nodesReady: $nodesReady,
      nodesTotal: $nodesTotal,
      podsRunning: $podsRunning,
      podsTotal: $podsTotal,
      podsPending: $podsPending,
      podsFailed: $podsFailed,
      totalRestarts: $totalRestarts,
      healthScore: $healthScore
    }
  }')

PAYLOAD_SIZE=$(echo "$PAYLOAD" | wc -c)
log "Payload size: ${PAYLOAD_SIZE} bytes"

log "Pushing to API..."
PUSH_OK="false"
PUSH_ATTEMPT=0
while [ "$PUSH_ATTEMPT" -lt 3 ]; do
  PUSH_ATTEMPT=$((PUSH_ATTEMPT + 1))
  RESPONSE=$(printf '%s' "$PAYLOAD" | curl -sL -w "\n%{http_code}" --max-time 30 -X POST "$API_URL" \
    -H "Content-Type: application/json" \
    -H "X-Cluster-Key: $API_KEY" \
    -d @-)

  HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" = "200" ]; then
    log "SUCCESS: Status pushed ($PAYLOAD_SIZE bytes)"
    PUSH_OK="true"
    break
  else
    log "WARN: Push attempt $PUSH_ATTEMPT failed (HTTP $HTTP_CODE)"
    [ "$PUSH_ATTEMPT" -lt 3 ] && sleep $((PUSH_ATTEMPT * 5))
  fi
done

if [ "$PUSH_OK" != "true" ]; then
  log "ERROR: All push attempts failed (last: HTTP $HTTP_CODE - $BODY)"
  exit 1
fi

log "Done!"

# ── Auto-heal: restart poller if it's not running ─────────────────
# The command poller must be running for the dashboard to send commands.
# Since this push script runs every 5 min via cron, use it as a watchdog.

if ! pgrep -f "poll-cluster-commands" >/dev/null 2>&1; then
  log "WARN: Command poller not running — restarting it..."

  # Prefer systemd if the service exists
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files cluster-poll.service >/dev/null 2>&1; then
    doas systemctl restart cluster-poll.service 2>/dev/null
    sleep 2
    if systemctl is-active --quiet cluster-poll.service 2>/dev/null; then
      log "Poller restarted via systemd (cluster-poll.service)"
    else
      log "WARN: systemd restart failed, falling back to nohup"
      nohup "$SCRIPT_DIR/poll-cluster-commands.sh" >> "$HOME_DIR/cluster-poll.log" 2>&1 &
      log "Poller restarted via nohup (PID: $!)"
    fi
  elif command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files cluster-poller.service >/dev/null 2>&1; then
    doas systemctl restart cluster-poller.service 2>/dev/null
    sleep 2
    if systemctl is-active --quiet cluster-poller.service 2>/dev/null; then
      log "Poller restarted via systemd (cluster-poller.service)"
    else
      nohup "$SCRIPT_DIR/poll-cluster-commands.sh" >> "$HOME_DIR/cluster-poll.log" 2>&1 &
      log "Poller restarted via nohup (PID: $!)"
    fi
  else
    nohup "$SCRIPT_DIR/poll-cluster-commands.sh" >> "$HOME_DIR/cluster-poll.log" 2>&1 &
    log "Poller restarted via nohup (PID: $!)"
  fi
else
  log "Poller alive (PID: $(pgrep -f 'poll-cluster-commands' | head -1))"
fi
