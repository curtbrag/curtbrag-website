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
NODES_READY=$(echo "$NODES_JSON" | jq '[.[] | select(.status=="Ready")] | length')
NODES_TOTAL=$(echo "$NODES_JSON" | jq 'length')
PODS_RUNNING=$(echo "$PODS_JSON" | jq '[.[] | select(.status=="Running")] | length')
PODS_TOTAL=$(echo "$PODS_JSON" | jq 'length')
PODS_PENDING=$(echo "$PODS_JSON" | jq '[.[] | select(.status=="Pending")] | length')
PODS_FAILED=$(echo "$PODS_JSON" | jq '[.[] | select(.status=="Failed")] | length')

log "Summary: $NODES_READY/$NODES_TOTAL nodes ready, $PODS_RUNNING/$PODS_TOTAL pods running"

# Build payload
PAYLOAD=$(jq -n \
  --argjson nodes "$NODES_JSON" \
  --argjson pods "$PODS_JSON" \
  --argjson services "$SERVICES_JSON" \
  --argjson network "$NETWORK_JSON" \
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
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL" \
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
