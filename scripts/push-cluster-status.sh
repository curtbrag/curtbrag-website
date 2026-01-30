#!/bin/sh
# Push K3s cluster status to curtbrag.com
# Run this on node1 via cron: */5 * * * * /home/user/push-cluster-status.sh

API_URL="https://www.curtbrag.com/.netlify/functions/cluster-status"
API_KEY="curtbrag-cluster-2024"  # Change this and set in Netlify env vars

# Get node status
NODES_JSON=$(kubectl get nodes -o json 2>/dev/null | jq -c '[.items[] | {
  name: .metadata.name,
  status: (if .status.conditions[] | select(.type=="Ready") | .status == "True" then "Ready" else "NotReady" end),
  role: (if .metadata.labels["node-role.kubernetes.io/control-plane"] then "control-plane" else "worker" end),
  ip: (.status.addresses[] | select(.type=="InternalIP") | .address)
}]')

# Get pod status
PODS_JSON=$(kubectl get pods -A -o json 2>/dev/null | jq -c '[.items[] | {
  name: .metadata.name,
  namespace: .metadata.namespace,
  status: .status.phase,
  node: .spec.nodeName
}]')

# Get services
SERVICES_JSON=$(kubectl get svc -A -o json 2>/dev/null | jq -c '[.items[] | {
  name: .metadata.name,
  namespace: .metadata.namespace,
  type: .spec.type,
  clusterIP: .spec.clusterIP,
  ports: [.spec.ports[]? | "\(.port):\(.nodePort // .targetPort)"]
}]')

# Calculate summary
NODES_READY=$(echo "$NODES_JSON" | jq '[.[] | select(.status=="Ready")] | length')
NODES_TOTAL=$(echo "$NODES_JSON" | jq 'length')
PODS_RUNNING=$(echo "$PODS_JSON" | jq '[.[] | select(.status=="Running")] | length')
PODS_TOTAL=$(echo "$PODS_JSON" | jq 'length')

# Build payload
PAYLOAD=$(jq -n \
  --argjson nodes "$NODES_JSON" \
  --argjson pods "$PODS_JSON" \
  --argjson services "$SERVICES_JSON" \
  --argjson nodesReady "$NODES_READY" \
  --argjson nodesTotal "$NODES_TOTAL" \
  --argjson podsRunning "$PODS_RUNNING" \
  --argjson podsTotal "$PODS_TOTAL" \
  '{
    nodes: $nodes,
    pods: $pods,
    services: $services,
    summary: {
      nodesReady: $nodesReady,
      nodesTotal: $nodesTotal,
      podsRunning: $podsRunning,
      podsTotal: $podsTotal
    }
  }')

# Push to API
curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "X-Cluster-Key: $API_KEY" \
  -d "$PAYLOAD"

echo "Cluster status pushed at $(date)"
