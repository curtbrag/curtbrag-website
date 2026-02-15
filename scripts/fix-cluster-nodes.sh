#!/bin/sh
# Fix K3s cluster nodes 8-10 that registered with wrong IPs (10.0.0.x instead of 192.168.1.x)
# Run this from your Windows machine or node1

# Configuration
SERVER_IP="192.168.1.206"
NODES="8 9 10"
# NODE_IPS no longer needed — IPs are resolved in the case statement below

echo "=== K3s Node Fix Script ==="
echo "This will fix nodes 8-10 to use WiFi IPs instead of USB IPs"
echo ""

# Get token from server (run on node1)
echo "First, get the join token from node1:"
echo "  ssh user@192.168.1.206"
echo "  doas cat /var/lib/rancher/k3s/server/node-token"
echo ""
read -p "Paste the token here: " TOKEN

if [ -z "$TOKEN" ]; then
    echo "No token provided. Exiting."
    exit 1
fi

# Fix each node
for i in 8 9 10; do
    case $i in
        8) IP="192.168.1.213" ;;
        9) IP="192.168.1.214" ;;
        10) IP="192.168.1.215" ;;
    esac

    echo ""
    echo "=== Fixing node$i ($IP) ==="

    # SSH and fix the node
    ssh "user@$IP" "
echo 'Stopping k3s-agent...'
doas rc-service k3s-agent stop 2>/dev/null || true

echo 'Cleaning old agent data...'
doas rm -rf /var/lib/rancher/k3s/agent/* 2>/dev/null || true

echo 'Creating k3s config...'
doas mkdir -p /etc/rancher/k3s
printf '%s\n' \"server: \\\"https://${SERVER_IP}:6443\\\"\" \"token: \\\"${TOKEN}\\\"\" \"node-name: \\\"node${i}\\\"\" \"node-ip: \\\"${IP}\\\"\" | doas tee /etc/rancher/k3s/config.yaml

echo 'Starting k3s-agent...'
doas rc-service k3s-agent start

echo 'Node${i} fix complete!'
"

done

echo ""
echo "=== Fix Complete ==="
echo "Check cluster status with:"
echo "  ssh user@192.168.1.206 'doas kubectl get nodes -o wide'"
