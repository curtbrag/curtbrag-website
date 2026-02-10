// K3s Phone Cluster API Server
// Runs on AORUS control-plane node, serves live cluster data
// Exposed via Cloudflare tunnel to the dashboard

const http = require('http');
const { execSync } = require('child_process');
const os = require('os');

const PORT = process.env.PORT || 3847;
const API_TOKEN = process.env.API_TOKEN || '';

function jsonResponse(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(JSON.stringify(data));
}

function checkAuth(req) {
  if (!API_TOKEN) return true;
  const auth = req.headers.authorization || '';
  return auth === 'Bearer ' + API_TOKEN;
}

function run(cmd, timeout = 10000) {
  return execSync(cmd, { timeout, encoding: 'utf8' }).trim();
}

function getClusterStatus() {
  // Nodes
  const nodesRaw = run('kubectl get nodes -o json');
  const nodesData = JSON.parse(nodesRaw);
  const nodes = nodesData.items.map(item => ({
    name: item.metadata.name,
    status: (item.status.conditions.find(c => c.type === 'Ready') || {}).status === 'True' ? 'Ready' : 'NotReady',
    role: item.metadata.labels['node-role.kubernetes.io/control-plane'] !== undefined ? 'control-plane' : 'worker',
    ip: (item.status.addresses.find(a => a.type === 'InternalIP') || {}).address || 'Unknown',
    kubeletVersion: (item.status.nodeInfo || {}).kubeletVersion,
    osImage: (item.status.nodeInfo || {}).osImage,
    arch: (item.status.nodeInfo || {}).architecture,
    cpu: (item.status.capacity || {}).cpu,
    memory: (item.status.capacity || {}).memory
  }));

  // Pods
  const podsRaw = run('kubectl get pods -A -o json');
  const podsData = JSON.parse(podsRaw);
  const pods = podsData.items.map(item => ({
    name: item.metadata.name,
    namespace: item.metadata.namespace,
    status: item.status.phase,
    node: (item.spec || {}).nodeName || 'unscheduled',
    restarts: (item.status.containerStatuses || []).reduce((sum, c) => sum + (c.restartCount || 0), 0),
    ready: item.status.containerStatuses
      ? item.status.containerStatuses.filter(c => c.ready).length + '/' + item.status.containerStatuses.length
      : '0/0'
  }));

  // Services
  const svcRaw = run('kubectl get svc -A -o json');
  const svcData = JSON.parse(svcRaw);
  const services = svcData.items.map(item => ({
    name: item.metadata.name,
    namespace: item.metadata.namespace,
    type: item.spec.type,
    clusterIP: item.spec.clusterIP,
    ports: (item.spec.ports || []).map(p => p.port + ':' + (p.nodePort || p.targetPort))
  }));

  // Summary
  const nodesReady = nodes.filter(n => n.status === 'Ready').length;
  const podsRunning = pods.filter(p => p.status === 'Running').length;

  // Network (optional, best-effort)
  let network = { tailscale: null, wifi: null, localIP: null };
  try {
    const tsRaw = run('tailscale status --json 2>/dev/null', 5000);
    const ts = JSON.parse(tsRaw);
    if (ts.Self) {
      network.tailscale = {
        ip: (ts.Self.TailscaleIPs || [])[0],
        hostname: ts.Self.HostName,
        connected: true,
        peers: Object.values(ts.Peer || {}).map(p => ({
          name: p.HostName,
          ip: (p.TailscaleIPs || [])[0],
          online: p.Online
        }))
      };
    }
  } catch (e) {}
  try {
    network.localIP = run("ip -4 addr show | grep -oP '(?<=inet\\s)192\\.168\\.\\d+\\.\\d+' | head -1", 3000);
  } catch (e) {}
  try {
    const ssid = run("iw dev wlan0 link 2>/dev/null | grep SSID | awk '{print $2}'", 3000);
    const signal = run("iw dev wlan0 link 2>/dev/null | grep signal | awk '{print $2}'", 3000);
    if (ssid) network.wifi = { ssid, signal, connected: true };
  } catch (e) {}

  return {
    lastUpdate: new Date().toISOString(),
    nodes, pods, services, network,
    summary: {
      nodesReady,
      nodesTotal: nodes.length,
      podsRunning,
      podsTotal: pods.length
    }
  };
}

function executeNodeCommand(command, target, url) {
  // Get target nodes
  let targetNodes = [];
  if (target === 'all' || target === 'phones') {
    try {
      const raw = run('kubectl get nodes -l "!node-role.kubernetes.io/control-plane" -o jsonpath="{.items[*].metadata.name}"', 5000);
      targetNodes = raw.split(/\s+/).filter(Boolean);
    } catch (e) {
      return { success: false, error: 'Failed to get node list: ' + e.message };
    }
  } else {
    targetNodes = [target];
  }

  // Build shell command
  let cmdStr;
  switch (command) {
    case 'start':
      cmdStr = 'sudo rc-service k3s-agent start 2>&1 || sudo systemctl start k3s-agent 2>&1';
      break;
    case 'stop':
      cmdStr = 'sudo rc-service k3s-agent stop 2>&1 || sudo systemctl stop k3s-agent 2>&1';
      break;
    case 'restart':
      cmdStr = 'sudo rc-service k3s-agent restart 2>&1 || sudo systemctl restart k3s-agent 2>&1';
      break;
    case 'wake':
      cmdStr = 'echo "wake OK"';
      break;
    case 'sleep':
      cmdStr = 'sudo loginctl suspend 2>&1 || echo "suspend sent"';
      break;
    case 'browse':
      // Try multiple browser approaches for postmarketOS phones
      cmdStr = 'DISPLAY=:0 xdg-open "' + url + '" 2>&1 || DISPLAY=:0 firefox "' + url + '" 2>&1 || echo "browser launched"';
      break;
    default:
      return { success: false, error: 'Unknown command: ' + command };
  }

  const hostname = os.hostname();
  const results = [];
  for (const node of targetNodes) {
    try {
      let output;
      if (node === hostname) {
        output = run(cmdStr, 15000);
      } else {
        output = run('ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ' + node + " '" + cmdStr + "'", 15000);
      }
      results.push({ node, status: 'ok', output });
    } catch (e) {
      results.push({ node, status: 'error', message: e.message.split('\n')[0] });
    }
  }

  return {
    success: true,
    message: "Command '" + command + "' sent to " + targetNodes.length + ' node(s)',
    results
  };
}

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return jsonResponse(res, 200, {});
  }

  const url = req.url.split('?')[0];

  // Health check (no auth)
  if (url === '/api/health' && req.method === 'GET') {
    return jsonResponse(res, 200, {
      status: 'ok',
      hostname: os.hostname(),
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  }

  // Auth check for everything else
  if (!checkAuth(req)) {
    return jsonResponse(res, 401, { error: 'Unauthorized' });
  }

  // Cluster status
  if (url === '/api/status' && req.method === 'GET') {
    try {
      const data = getClusterStatus();
      return jsonResponse(res, 200, data);
    } catch (e) {
      return jsonResponse(res, 500, { error: 'Failed to get cluster status', details: e.message });
    }
  }

  // Phone/node commands
  if (url === '/api/phone/command' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { command, target, url: browseUrl } = JSON.parse(body);
        const valid = ['start', 'stop', 'restart', 'wake', 'sleep', 'browse'];
        if (!valid.includes(command)) {
          return jsonResponse(res, 400, { error: 'Invalid command. Valid: ' + valid.join(', ') });
        }
        if (command === 'browse' && !browseUrl) {
          return jsonResponse(res, 400, { error: 'URL required for browse command' });
        }
        const result = executeNodeCommand(command, target || 'all', browseUrl);
        return jsonResponse(res, result.success ? 200 : 500, result);
      } catch (e) {
        return jsonResponse(res, 400, { error: 'Invalid request: ' + e.message });
      }
    });
    return;
  }

  jsonResponse(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Cluster API running on port ' + PORT);
  console.log('Endpoints:');
  console.log('  GET  /api/health        - Health check');
  console.log('  GET  /api/status        - Live cluster status');
  console.log('  POST /api/phone/command - Send commands to nodes');
  if (API_TOKEN) console.log('Auth: Bearer token required');
  else console.log('Auth: DISABLED (set API_TOKEN env var to enable)');
});
