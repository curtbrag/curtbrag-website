@echo off
echo === Setting up Cluster Dashboard on node1 ===
echo.
echo Enter password 0735 when prompted
echo.

echo [1/4] Creating push script on node1...
ssh user@192.168.1.206 "echo '#!/bin/sh' > ~/push-cluster-status.sh"
ssh user@192.168.1.206 "echo 'API_URL=\"https://www.curtbrag.com/.netlify/functions/cluster-status\"' >> ~/push-cluster-status.sh"
ssh user@192.168.1.206 "echo 'API_KEY=\"curtbrag-cluster-2024\"' >> ~/push-cluster-status.sh"
ssh user@192.168.1.206 "echo 'NODES_JSON=$(doas kubectl get nodes -o json 2>/dev/null | jq -c \"[.items[] | {name: .metadata.name, status: (if .status.conditions[] | select(.type==\\\"Ready\\\") | .status == \\\"True\\\" then \\\"Ready\\\" else \\\"NotReady\\\" end), role: (if .metadata.labels[\\\"node-role.kubernetes.io/control-plane\\\"] then \\\"control-plane\\\" else \\\"worker\\\" end), ip: (.status.addresses[] | select(.type==\\\"InternalIP\\\") | .address)}]\")' >> ~/push-cluster-status.sh"
ssh user@192.168.1.206 "echo 'NODES_READY=$(echo \"$NODES_JSON\" | jq \"[.[] | select(.status==\\\"Ready\\\")] | length\")' >> ~/push-cluster-status.sh"
ssh user@192.168.1.206 "echo 'NODES_TOTAL=$(echo \"$NODES_JSON\" | jq \"length\")' >> ~/push-cluster-status.sh"
ssh user@192.168.1.206 "echo 'PODS_RUNNING=$(doas kubectl get pods -A --no-headers 2>/dev/null | grep -c Running)' >> ~/push-cluster-status.sh"
ssh user@192.168.1.206 "echo 'PODS_TOTAL=$(doas kubectl get pods -A --no-headers 2>/dev/null | wc -l)' >> ~/push-cluster-status.sh"
ssh user@192.168.1.206 "echo 'PAYLOAD=$(jq -n --argjson nodes \"$NODES_JSON\" --argjson nodesReady \"$NODES_READY\" --argjson nodesTotal \"$NODES_TOTAL\" --argjson podsRunning \"$PODS_RUNNING\" --argjson podsTotal \"$PODS_TOTAL\" \"{nodes: \\$nodes, summary: {nodesReady: \\$nodesReady, nodesTotal: \\$nodesTotal, podsRunning: \\$podsRunning, podsTotal: \\$podsTotal}}\")' >> ~/push-cluster-status.sh"
ssh user@192.168.1.206 "echo 'curl -s -X POST \"$API_URL\" -H \"Content-Type: application/json\" -H \"X-Cluster-Key: $API_KEY\" -d \"$PAYLOAD\"' >> ~/push-cluster-status.sh"
ssh user@192.168.1.206 "chmod +x ~/push-cluster-status.sh"

echo [2/4] Installing jq...
ssh user@192.168.1.206 "doas apk add jq curl"

echo [3/4] Running first push...
ssh user@192.168.1.206 "doas sh ~/push-cluster-status.sh"

echo [4/4] Setting up cron...
ssh user@192.168.1.206 "echo '*/5 * * * * doas sh /home/user/push-cluster-status.sh' | doas crontab -"

echo.
echo === Done! Check https://curtbrag.com/cluster ===
pause
