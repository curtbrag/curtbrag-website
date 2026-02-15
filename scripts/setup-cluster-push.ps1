# Setup cluster status push on node1
# Run from Windows PowerShell

Write-Host "=== Setting up Cluster Dashboard Push on node1 ===" -ForegroundColor Cyan

$script = @'
#!/bin/sh
# Push K3s cluster status to curtbrag.com
API_URL="https://www.curtbrag.com/.netlify/functions/cluster-status"
API_KEY="${CLUSTER_API_KEY:-curtbrag-cluster-2024}"

NODES_JSON=$(doas kubectl get nodes -o json 2>/dev/null | jq -c '[.items[] | {
  name: .metadata.name,
  status: (if .status.conditions[] | select(.type=="Ready") | .status == "True" then "Ready" else "NotReady" end),
  role: (if .metadata.labels["node-role.kubernetes.io/control-plane"] then "control-plane" else "worker" end),
  ip: (.status.addresses[] | select(.type=="InternalIP") | .address)
}]')

PODS_JSON=$(doas kubectl get pods -A -o json 2>/dev/null | jq -c '[.items[] | {
  name: .metadata.name,
  namespace: .metadata.namespace,
  status: .status.phase,
  node: .spec.nodeName
}]')

NODES_READY=$(echo "$NODES_JSON" | jq '[.[] | select(.status=="Ready")] | length')
NODES_TOTAL=$(echo "$NODES_JSON" | jq 'length')
PODS_RUNNING=$(doas kubectl get pods -A --no-headers 2>/dev/null | grep -c Running || echo 0)
PODS_TOTAL=$(doas kubectl get pods -A --no-headers 2>/dev/null | wc -l)

PAYLOAD=$(jq -n \
  --argjson nodes "$NODES_JSON" \
  --argjson nodesReady "$NODES_READY" \
  --argjson nodesTotal "$NODES_TOTAL" \
  --argjson podsRunning "$PODS_RUNNING" \
  --argjson podsTotal "$PODS_TOTAL" \
  '{nodes: $nodes, summary: {nodesReady: $nodesReady, nodesTotal: $nodesTotal, podsRunning: $podsRunning, podsTotal: $podsTotal}}')

curl -s -X POST "$API_URL" -H "Content-Type: application/json" -H "X-Cluster-Key: $API_KEY" -d "$PAYLOAD" > /dev/null 2>&1
'@

Write-Host "`n[1/4] Connecting to node1..." -ForegroundColor Yellow

# Create the script on node1
$script | ssh user@192.168.1.206 "cat > ~/push-cluster-status.sh && chmod +x ~/push-cluster-status.sh"

Write-Host "[2/4] Installing dependencies (jq, curl)..." -ForegroundColor Yellow
ssh user@192.168.1.206 "doas apk add jq curl 2>/dev/null"

Write-Host "[3/4] Running first push..." -ForegroundColor Yellow
ssh user@192.168.1.206 "doas sh ~/push-cluster-status.sh"

Write-Host "[4/4] Setting up cron job (every 5 min)..." -ForegroundColor Yellow
ssh user@192.168.1.206 "echo '*/5 * * * * /home/user/push-cluster-status.sh' | doas crontab -"

Write-Host "`n=== Setup Complete! ===" -ForegroundColor Green
Write-Host "Dashboard: https://www.curtbrag.com/cluster" -ForegroundColor Cyan
Write-Host "Status will update every 5 minutes automatically." -ForegroundColor Gray
