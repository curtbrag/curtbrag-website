# Cluster Control Plane — Deployment Guide

Complete guide for deploying and testing the 3-layer cluster control plane.

## Prerequisites

- **Netlify deployment**: curtbrag.com with custom functions
- **Node devices**: node1-10 (IPs 192.168.1.206-215), or PC nodes (nexus-prime, viki, skynet, steamdeck)
- **Credentials**: Set CLUSTER_API_KEY and CLUSTER_WEB_PASSWORD in Netlify environment

## Phase 1: Netlify Environment Setup

Set these environment variables in Netlify Site Settings → Build & Deploy → Environment:

```
CLUSTER_API_KEY=<generate-random-key>
CLUSTER_WEB_PASSWORD=<your-dashboard-password>
```

Example key generation:
```bash
openssl rand -hex 32
# Output: a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6
```

Verify deployment at: `https://curtbrag.com/api/cluster?action=summary`

## Phase 2: Deploy Agent to Test Device (node1)

### Step 1: Create cluster config on node1

SSH into node1 (192.168.1.206):
```bash
ssh user@192.168.1.206
```

Create `~/.cluster-env`:
```bash
cat > ~/.cluster-env << EOF
CLUSTER_API_KEY=a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6
CONTROL_PLANE_URL=https://curtbrag.com
EOF
chmod 600 ~/.cluster-env
```

### Step 2: Deploy node-agent.sh

From your local machine:
```bash
scp scripts/node-agent.sh user@192.168.1.206:~/node-agent.sh
ssh user@192.168.1.206 'chmod +x ~/node-agent.sh && nohup ~/node-agent.sh > /tmp/agent.log 2>&1 &'
```

### Step 3: Verify Registration (wait 60 seconds)

Check agent log:
```bash
ssh user@192.168.1.206 'tail -20 /tmp/agent.log'
```

Expected output:
```
[2026-04-02 12:34:56] node-agent 1.0 starting on node1
[2026-04-02 12:34:57] No identity found — registering...
[2026-04-02 12:34:58] Registered as node1-a1b2c3d4
[2026-04-02 12:34:58] Running as device: node1-a1b2c3d4
```

## Phase 3: Test Dashboard

### Access Control Plane

Open: `https://curtbrag.com/cluster/dashboard`

Login with: `CLUSTER_WEB_PASSWORD` (set in Netlify)

Expected dashboard state:
- **Fleet tab**: node1 card appears with status "ONLINE"
- **Devices tab**: node1 in table with status indicator
- **Summary stats**: Total=1, Online=1

### Test Device Detail

1. Click on node1 card to open detail drawer
2. Verify hardware info displays (CPU, cores, RAM)
3. Check miner state section

## Phase 4: Test Mining Controls

### Test Mining Level Slider

1. Open device detail drawer for node1
2. Drag "Mining Level" slider to level 3
3. Check agent log: `tail -f /tmp/agent.log`
4. Expected: Miner should start after ~5 seconds

### Test Pool Change Command

1. Go to **Commands** tab
2. Click "Queue Command" (if UI available) or use curl:
```bash
curl -X POST https://curtbrag.com/api/cluster \
  -H "Authorization: Bearer $CLUSTER_WEB_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "queue-command",
    "target": "node1-a1b2c3d4",
    "type": "pool-change",
    "payload": {
      "url": "gulf.moneroocean.stream",
      "port": 10128,
      "user": "YOUR_WALLET"
    }
  }'
```

3. Check agent log for command execution:
```bash
ssh user@192.168.1.206 'tail -f /tmp/agent.log | grep -i pool'
```

## Phase 5: Monitor Analytics

### Fleet Analytics

1. Go to **Analytics** tab
2. Verify metrics display:
   - Total Devices: 1
   - Mining: 0 or 1 (depends on state)
   - Avg Hashrate: > 0 if mining
   - Peak Temp: device temperature

### Thermal Report

1. Still in **Analytics** tab
2. View thermal status for node1
3. Compare Current Temp vs Max Allowed
4. Verify color indicator (green if OK, red if high)

### Event Log

1. Go to **Events** tab
2. Filter by "Rogue" or "Thermal" to see recent drift detection
3. Expected events for first run:
   - "Device registered"
   - "Desired state reconciled"

## Phase 6: Multi-Device Deployment

Once node1 is stable, deploy to other devices:

```bash
#!/bin/bash
# Deploy to all phone nodes (node2-10)

for node in {2..10}; do
  ip="192.168.1.$((205+node))"
  echo "Deploying to node$node ($ip)..."
  scp scripts/node-agent.sh user@$ip:~/node-agent.sh
  ssh user@$ip 'chmod +x ~/node-agent.sh && nohup ~/node-agent.sh > /tmp/agent.log 2>&1 &'
  sleep 2
done

# Deploy to PC nodes
for node in "nexus-prime" "viki" "skynet" "steamdeck"; do
  echo "Deploying to $node..."
  scp scripts/node-agent.sh user@$node:~/node-agent.sh
  ssh user@$node 'chmod +x ~/node-agent.sh && nohup ~/node-agent.sh > /tmp/agent.log 2>&1 &'
  sleep 2
done
```

Wait 60 seconds, then view fleet dashboard to see all devices register.

## Troubleshooting

### Agent not registering
```bash
ssh user@192.168.1.206 'cat /tmp/agent.log | grep -i error'
# Check if CLUSTER_API_KEY is correct
```

### Dashboard not responding
```bash
curl -I https://curtbrag.com/cluster/dashboard
# Verify Netlify deployment completed
```

### Commands not executing
```bash
# Check device is online (last_seen_at < 5min)
curl -H "Authorization: Bearer $PASSWORD" \
  "https://curtbrag.com/api/cluster?action=device&id=node1-xxxxx"
```

### Mining not starting
1. Check desired state is `miner_enabled: true`
2. Check approved binary exists: `/home/user/xmrig-custom`
3. Check thermal policy: temp < max_temp_celsius

## Next Steps

1. **Deploy to all devices** using the multi-device script above
2. **Configure mining profiles** via Config tab
3. **Set up device groups** for batch operations
4. **Monitor thermal policy** enforcement via Analytics tab
5. **Test command queue** with various command types (pool-change, mining-level, etc.)
6. **Track performance metrics** via fleet analytics
