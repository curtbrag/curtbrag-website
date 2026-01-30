#!/bin/sh
# Push K3s cluster status to curtbrag.com
# Run this on node1 via cron: */5 * * * * /home/user/push-cluster-status.sh >> /var/log/cluster-push.log 2>&1

set -e

API_URL="https://www.curtbrag.com/.netlify/functions/cluster-status"
API_KEY="${CLUSTER_API_KEY:-curtbrag-cluster-2024}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "Starting cluster status push..."

# Check if kubectl is available
if ! command -v kubectl >/dev/null 2>&1; then
  log "ERROR: kubectl not found"
  exit 1
fi

# Check if jq is available
if ! command -v jq >/dev/null 2>&1; then
  log "ERROR: jq not found"
  exit 1
fi

# Check cluster connectivity
if ! kubectl cluster-info >/dev/null 2>&1; then
  log "ERROR: Cannot connect to cluster"
  exit 1
fi

log "Connected to cluster, gathering data..."


# Check cluster connectivity
if ! kubectl cluster-info >/dev/null 2>&1; then
  log "ERROR: Cannot connect to cluster"
  exit 1
fi

log "Connected to cluster, gathering data..."

# Get node status with more details
NODES_JSON=$(kubectl get nodes -o json 2>/dev/null | jq -c '[.items[] | {
  name: .metadata.name,
  status: (if (.status.conditions[] | select(.type=="Ready") | .status) == "True" then "Ready" else "NotReady" end),
  role: (if .metadata.labels["node-role.kubernetes.io/control-plane"] then "control-plane" else "worker" end),
  ip: (.status.addresses[] | select(.type=="InternalIP") | .address),
  kubeletVersion: .status.nodeInfo.kubeletVersion,
  osImage: .status.nodeInfo.osImage,
  arch: .status.nodeInfo.architecture
}]')

log "Got $(echo "$NODES_JSON" | jq 'length') nodes"

# Get resource metrics from metrics-server if available
METRICS_JSON='[]'
if kubectl top nodes >/dev/null 2>&1; then
  log "Gathering node metrics..."
  METRICS_JSON=$(kubectl top nodes --no-headers 2>/dev/null | awk '{
    name=$1; cpu=$2; cpuPct=$3; mem=$4; memPct=$5;
    gsub(/%/, "", cpuPct); gsub(/%/, "", memPct);
    printf "{\"name\":\"%s\",\"cpu\":\"%s\",\"cpuPercent\":%s,\"memory\":\"%s\",\"memoryPercent\":%s}\n", name, cpu, cpuPct, mem, memPct
  }' | jq -s '.')
  log "Got metrics for $(echo "$METRICS_JSON" | jq 'length') nodes"
fi

# Merge node info with metrics
NODES_WITH_METRICS=$(echo "$NODES_JSON" | jq --argjson metrics "$METRICS_JSON" '
  [.[] | . as $node |
    ($metrics[] | select(.name == $node.name)) as $m |
    $node + (if $m then {cpu: $m.cpu, cpuPercent: $m.cpuPercent, memory: $m.memory, memoryPercent: $m.memoryPercent} else {} end)
  ]
')

# Get local node resources (CPU, memory, battery for node1)
log "Gathering local node resources..."
RESOURCES_JSON='{}'

# CPU usage
if [ -f /proc/stat ]; then
  CPU_IDLE=$(awk '/^cpu / {print $5}' /proc/stat)
  CPU_TOTAL=$(awk '/^cpu / {sum=0; for(i=2;i<=NF;i++) sum+=$i; print sum}' /proc/stat)
  # Simple approximation
  CPU_USED=$((100 - (CPU_IDLE * 100 / CPU_TOTAL)))
  RESOURCES_JSON=$(echo "$RESOURCES_JSON" | jq --argjson cpu "$CPU_USED" '.cpuPercent = $cpu')
fi

# Memory usage
if [ -f /proc/meminfo ]; then
  MEM_TOTAL=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  MEM_AVAIL=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  MEM_USED=$((MEM_TOTAL - MEM_AVAIL))
  MEM_PERCENT=$((MEM_USED * 100 / MEM_TOTAL))
  MEM_USED_MB=$((MEM_USED / 1024))
  MEM_TOTAL_MB=$((MEM_TOTAL / 1024))
  RESOURCES_JSON=$(echo "$RESOURCES_JSON" | jq \
    --argjson memPercent "$MEM_PERCENT" \
    --argjson memUsedMB "$MEM_USED_MB" \
    --argjson memTotalMB "$MEM_TOTAL_MB" \
    '.memoryPercent = $memPercent | .memoryUsedMB = $memUsedMB | .memoryTotalMB = $memTotalMB')
fi

# Battery (for phones running postmarketOS)
if [ -d /sys/class/power_supply/battery ]; then
  BATTERY_LEVEL=$(cat /sys/class/power_supply/battery/capacity 2>/dev/null || echo "0")
  BATTERY_STATUS=$(cat /sys/class/power_supply/battery/status 2>/dev/null || echo "Unknown")
  RESOURCES_JSON=$(echo "$RESOURCES_JSON" | jq \
    --argjson level "$BATTERY_LEVEL" \
    --arg status "$BATTERY_STATUS" \
    '.battery = {level: $level, status: $status}')
  log "Battery: ${BATTERY_LEVEL}% ($BATTERY_STATUS)"
elif [ -d /sys/class/power_supply/BAT0 ]; then
  BATTERY_LEVEL=$(cat /sys/class/power_supply/BAT0/capacity 2>/dev/null || echo "0")
  BATTERY_STATUS=$(cat /sys/class/power_supply/BAT0/status 2>/dev/null || echo "Unknown")
  RESOURCES_JSON=$(echo "$RESOURCES_JSON" | jq \
    --argjson level "$BATTERY_LEVEL" \
    --arg status "$BATTERY_STATUS" \
    '.battery = {level: $level, status: $status}')
fi

# Temperature (if available)
if [ -f /sys/class/thermal/thermal_zone0/temp ]; then
  TEMP_RAW=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo "0")
  TEMP_C=$((TEMP_RAW / 1000))
  RESOURCES_JSON=$(echo "$RESOURCES_JSON" | jq --argjson temp "$TEMP_C" '.temperature = $temp')
  log "Temperature: ${TEMP_C}°C"
fi

# Uptime
UPTIME_SECS=$(awk '{print int($1)}' /proc/uptime 2>/dev/null || echo "0")
UPTIME_HOURS=$((UPTIME_SECS / 3600))
RESOURCES_JSON=$(echo "$RESOURCES_JSON" | jq --argjson uptime "$UPTIME_HOURS" '.uptimeHours = $uptime')

log "Resources gathered"

# Get pod status with restart counts
PODS_JSON=$(kubectl get pods -A -o json 2>/dev/null | jq -c '[.items[] | {
  name: .metadata.name,
  namespace: .metadata.namespace,
  status: .status.phase,
  node: (.spec.nodeName // "unscheduled"),
  restarts: ([.status.containerStatuses[]?.restartCount] | add // 0),
  ready: (if .status.containerStatuses then ([.status.containerStatuses[] | select(.ready == true)] | length | tostring) + "/" + ([.status.containerStatuses[]] | length | tostring) else "0/0" end)
}]')

log "Got $(echo "$PODS_JSON" | jq 'length') pods"

# Get services with external IPs if available
SERVICES_JSON=$(kubectl get svc -A -o json 2>/dev/null | jq -c '[.items[] | {
  name: .metadata.name,
  namespace: .metadata.namespace,
  type: .spec.type,
  clusterIP: .spec.clusterIP,
  externalIP: ((.status.loadBalancer.ingress[0].ip // .spec.externalIPs[0]) // null),
  ports: [.spec.ports[]? | "\(.port):\(.nodePort // .targetPort)"]
}]')

log "Got $(echo "$SERVICES_JSON" | jq 'length') services"

# Get network status (Tailscale and local interfaces)
log "Gathering network info..."
NETWORK_JSON='{"tailscale":null,"wifi":null,"localIP":null}'

# Get Tailscale status if available
if command -v tailscale >/dev/null 2>&1; then
  TS_STATUS=$(tailscale status --json 2>/dev/null || echo '{}')
  TS_SELF=$(echo "$TS_STATUS" | jq -c '.Self // null')
  TS_PEERS=$(echo "$TS_STATUS" | jq -c '[.Peer // {} | to_entries[] | {name: .value.HostName, ip: .value.TailscaleIPs[0], online: .value.Online, lastSeen: .value.LastSeen}]')

  if [ "$TS_SELF" != "null" ]; then
    TS_IP=$(echo "$TS_SELF" | jq -r '.TailscaleIPs[0] // empty')
    TS_NAME=$(echo "$TS_SELF" | jq -r '.HostName // empty')
    NETWORK_JSON=$(echo "$NETWORK_JSON" | jq --arg ip "$TS_IP" --arg name "$TS_NAME" --argjson peers "$TS_PEERS" '.tailscale = {ip: $ip, hostname: $name, connected: true, peers: $peers}')
    log "Tailscale: $TS_NAME ($TS_IP)"
  fi
fi

# Get WiFi info if available
if command -v iw >/dev/null 2>&1; then
  WIFI_SSID=$(iw dev wlan0 link 2>/dev/null | grep SSID | awk '{print $2}' || echo "")
  WIFI_SIGNAL=$(iw dev wlan0 link 2>/dev/null | grep signal | awk '{print $2}' || echo "")

  if [ -n "$WIFI_SSID" ]; then
    NETWORK_JSON=$(echo "$NETWORK_JSON" | jq --arg ssid "$WIFI_SSID" --arg signal "$WIFI_SIGNAL" '.wifi = {ssid: $ssid, signal: $signal, connected: true}')
    log "WiFi: $WIFI_SSID (${WIFI_SIGNAL}dBm)"
  fi
fi

# Get local IP
LOCAL_IP=$(ip -4 addr show | grep -oP '(?<=inet\s)192\.168\.\d+\.\d+' | head -1 || echo "")
if [ -n "$LOCAL_IP" ]; then
  NETWORK_JSON=$(echo "$NETWORK_JSON" | jq --arg ip "$LOCAL_IP" '.localIP = $ip')
fi

log "Network info gathered"

# Calculate summary
NODES_READY=$(echo "$NODES_WITH_METRICS" | jq '[.[] | select(.status=="Ready")] | length')
NODES_TOTAL=$(echo "$NODES_WITH_METRICS" | jq 'length')
PODS_RUNNING=$(echo "$PODS_JSON" | jq '[.[] | select(.status=="Running")] | length')
PODS_TOTAL=$(echo "$PODS_JSON" | jq 'length')
PODS_PENDING=$(echo "$PODS_JSON" | jq '[.[] | select(.status=="Pending")] | length')
PODS_FAILED=$(echo "$PODS_JSON" | jq '[.[] | select(.status=="Failed")] | length')

log "Summary: $NODES_READY/$NODES_TOTAL nodes ready, $PODS_RUNNING/$PODS_TOTAL pods running"

# Build payload
PAYLOAD=$(jq -n \
  --argjson nodes "$NODES_WITH_METRICS" \
  --argjson pods "$PODS_JSON" \
  --argjson services "$SERVICES_JSON" \
  --argjson network "$NETWORK_JSON" \
  --argjson resources "$RESOURCES_JSON" \
  --argjson nodesReady "$NODES_READY" \
  --argjson nodesTotal "$NODES_TOTAL" \
  --argjson podsRunning "$PODS_RUNNING" \
  --argjson podsTotal "$PODS_TOTAL" \
  --argjson podsPending "$PODS_PENDING" \
  --argjson podsFailed "$PODS_FAILED" \
  '{
    nodes: $nodes,
    pods: $pods,
    services: $services,
    network: $network,
    resources: $resources,
    summary: {
      nodesReady: $nodesReady,
      nodesTotal: $nodesTotal,
      podsRunning: $podsRunning,
      podsTotal: $podsTotal,
      podsPending: $podsPending,
      podsFailed: $podsFailed
    }
  }')

# Push to API
log "Pushing to API..."
RESPONSE=$(curl -sL -w "\n%{http_code}" -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "X-Cluster-Key: $API_KEY" \
  -d "$PAYLOAD")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  log "SUCCESS: Status pushed successfully"
  log "Response: $BODY"
else
  log "ERROR: HTTP $HTTP_CODE - $BODY"
  exit 1
fi

log "Done!"
