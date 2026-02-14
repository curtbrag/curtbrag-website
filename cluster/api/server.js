#!/usr/bin/env node
// CurtBrag Cluster API Server
// Runs on AORUS control-plane — serves live kubectl data, phone screenshots, and commands
// Zero npm dependencies — uses only Node.js built-in modules

const http = require('http');
const https = require('https');
const { execSync, exec } = require('child_process');
const url = require('url');
const os = require('os');

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  port: parseInt(process.env.CLUSTER_API_PORT) || 3847,
  password: process.env.CLUSTER_WEB_PASSWORD || '073588',
  apiToken: process.env.CLUSTER_API_TOKEN || 'curtbrag-cluster-2024',
  allowedOrigins: ['https://www.curtbrag.com', 'https://curtbrag.com', 'http://localhost'],

  // Monero mining
  xmrWallet: process.env.XMR_WALLET || '',
  xmrPool: 'supportxmr.com',
  xmrigPort: 18080,
  xmrigToken: process.env.XMRIG_TOKEN || '',

  // Phone nodes (USB+WiFi connected to AORUS)
  phoneNodes: {
    node1:  { ip: '192.168.1.206', ssh: 'user@192.168.1.206', role: 'control-plane', adb: null },
    node2:  { ip: '192.168.1.207', ssh: 'user@192.168.1.207', role: 'worker', adb: null },
    node3:  { ip: '192.168.1.208', ssh: 'user@192.168.1.208', role: 'worker', adb: null },
    node4:  { ip: '192.168.1.209', ssh: 'user@192.168.1.209', role: 'worker', adb: null },
    node5:  { ip: '192.168.1.210', ssh: 'user@192.168.1.210', role: 'worker', adb: null },
    node6:  { ip: '192.168.1.211', ssh: 'user@192.168.1.211', role: 'worker', adb: null },
    node7:  { ip: '192.168.1.212', ssh: 'user@192.168.1.212', role: 'worker', adb: null },
    node8:  { ip: '192.168.1.213', ssh: 'user@192.168.1.213', role: 'worker', adb: null },
    node9:  { ip: '192.168.1.214', ssh: 'user@192.168.1.214', role: 'worker', adb: null },
    node10: { ip: '192.168.1.215', ssh: 'user@192.168.1.215', role: 'worker', adb: null },
  },
  phoneNodeNames: ['node1','node2','node3','node4','node5','node6','node7','node8','node9','node10'],
  otherNodes: ['neo', 'vikixii', 'aorus-node', 'steamdeck', 'pikvm-main', 'pikvm-2'],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function run(cmd, timeoutMs = 10000) {
  try {
    const stdout = execSync(cmd, { timeout: timeoutMs, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, stdout: stdout.trim(), stderr: '' };
  } catch (e) {
    return { ok: false, stdout: (e.stdout || '').toString().trim(), stderr: (e.stderr || e.message || '').toString().trim() };
  }
}

function runBinary(cmd, timeoutMs = 10000) {
  try {
    const stdout = execSync(cmd, { timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, data: stdout };
  } catch (e) {
    return { ok: false, data: null, stderr: (e.stderr || e.message || '').toString().trim() };
  }
}

function runAsync(cmd, timeoutMs = 10000) {
  return new Promise(resolve => {
    exec(cmd, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, stdout: (stdout || '').trim(), stderr: (stderr || err.message || '').trim() });
      else resolve({ ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

function runAsyncBinary(cmd, timeoutMs = 10000) {
  return new Promise(resolve => {
    exec(cmd, { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, data: null, stderr: (stderr || err.message || '').toString().trim() });
      else resolve({ ok: true, data: stdout });
    });
  });
}

function shellEscape(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function sshExec(nodeKey, cmd) {
  const node = CONFIG.phoneNodes[nodeKey];
  if (!node) return { ok: false, stderr: 'Unknown node: ' + nodeKey };
  return run(`ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o BatchMode=yes ${node.ssh} ${shellEscape(cmd)}`, 15000);
}

function sshExecAsync(nodeKey, cmd) {
  const node = CONFIG.phoneNodes[nodeKey];
  if (!node) return Promise.resolve({ ok: false, stderr: 'Unknown node: ' + nodeKey });
  return runAsync(`ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o BatchMode=yes ${node.ssh} ${shellEscape(cmd)}`, 15000);
}

function adbExec(nodeKey, cmd) {
  const node = CONFIG.phoneNodes[nodeKey];
  if (!node) return { ok: false, stderr: 'Unknown node' };
  if (node.adb) return run(`adb -s ${node.adb} ${cmd}`, 10000);
  return run(`adb -s ${node.ip}:5555 ${cmd}`, 10000);
}

function adbExecAsync(nodeKey, cmd) {
  const node = CONFIG.phoneNodes[nodeKey];
  if (!node) return Promise.resolve({ ok: false, stderr: 'Unknown node' });
  const serial = node.adb || `${node.ip}:5555`;
  return runAsync(`adb -s ${serial} ${cmd}`, 10000);
}

function adbExecAsyncBinary(nodeKey, cmd) {
  const node = CONFIG.phoneNodes[nodeKey];
  if (!node) return Promise.resolve({ ok: false, data: null });
  const serial = node.adb || `${node.ip}:5555`;
  return runAsyncBinary(`adb -s ${serial} ${cmd}`, 10000);
}

function httpGetJson(hostname, port, path, timeoutMs = 5000) {
  return new Promise(resolve => {
    const proto = port === 443 ? https : http;
    const req = proto.get({ hostname, port, path, timeout: timeoutMs, headers: { 'Accept': 'application/json' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ ok: true, data: JSON.parse(data) }); }
        catch { resolve({ ok: false, data: null, error: 'Invalid JSON' }); }
      });
    });
    req.on('error', e => resolve({ ok: false, data: null, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, data: null, error: 'Timeout' }); });
  });
}

// ─── ADB Device Discovery ───────────────────────────────────────────────────

function initAdbDevices() {
  console.log('[ADB] Discovering devices...');
  const result = run('adb devices -l', 5000);
  if (!result.ok) {
    console.log('[ADB] adb not available:', result.stderr);
    return;
  }

  const lines = result.stdout.split('\n').filter(l => l.includes('\tdevice'));
  console.log(`[ADB] Found ${lines.length} connected devices`);

  for (const line of lines) {
    const serial = line.split(/\s+/)[0];
    const hostResult = run(`adb -s ${serial} shell hostname`, 3000);
    if (hostResult.ok) {
      const hostname = hostResult.stdout.trim();
      if (CONFIG.phoneNodes[hostname]) {
        CONFIG.phoneNodes[hostname].adb = serial;
        console.log(`[ADB]   ${hostname} -> ${serial}`);
      } else {
        console.log(`[ADB]   Unknown hostname "${hostname}" for serial ${serial}`);
      }
    } else {
      console.log(`[ADB]   Could not get hostname for ${serial}`);
    }
  }

  const mapped = CONFIG.phoneNodeNames.filter(n => CONFIG.phoneNodes[n].adb);
  console.log(`[ADB] Mapped ${mapped.length}/${CONFIG.phoneNodeNames.length} phone nodes`);
}

// ─── Data Stores (In-Memory) ────────────────────────────────────────────────

// Status cache
let statusCache = { data: null, timestamp: 0 };
const STATUS_CACHE_TTL = 5000;

let screensCache = { data: null, timestamp: 0 };
const SCREENS_CACHE_TTL = 15000;

// Command history log (ring buffer, last 100 commands)
const MAX_COMMAND_LOG = 100;
const commandLog = [];

function logCommand(entry) {
  commandLog.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    ...entry,
  });
  if (commandLog.length > MAX_COMMAND_LOG) commandLog.shift();
}

// Node uptime tracking
const nodeHistory = {};  // { nodeName: { lastSeen, uptimeStart, downtimeEvents: [{start, end}], totalUptime } }

function updateNodeTracking(nodes) {
  const now = Date.now();
  for (const node of nodes) {
    if (!nodeHistory[node.name]) {
      nodeHistory[node.name] = {
        lastSeen: now,
        lastStatus: node.status,
        uptimeStart: node.status === 'Ready' ? now : null,
        downtimeEvents: [],
        statusChanges: [],
      };
    }
    const h = nodeHistory[node.name];
    // Detect status change
    if (h.lastStatus !== node.status) {
      h.statusChanges.push({ from: h.lastStatus, to: node.status, at: new Date().toISOString() });
      if (h.statusChanges.length > 50) h.statusChanges.shift();

      if (node.status === 'Ready') {
        // Node came back up
        h.uptimeStart = now;
        if (h.downtimeEvents.length > 0) {
          const last = h.downtimeEvents[h.downtimeEvents.length - 1];
          if (!last.end) last.end = new Date().toISOString();
        }
      } else {
        // Node went down
        h.uptimeStart = null;
        h.downtimeEvents.push({ start: new Date().toISOString(), end: null });
        if (h.downtimeEvents.length > 20) h.downtimeEvents.shift();
      }
    }
    h.lastSeen = now;
    h.lastStatus = node.status;
  }
}

// Pod restart tracking
const podRestartHistory = {};  // { podKey: { lastRestarts, spikes: [{at, count}] } }

function trackPodRestarts(pods) {
  for (const pod of pods) {
    const key = pod.namespace + '/' + pod.name;
    if (!podRestartHistory[key]) {
      podRestartHistory[key] = { lastRestarts: pod.restarts, spikes: [] };
      continue;
    }
    const h = podRestartHistory[key];
    if (pod.restarts > h.lastRestarts) {
      h.spikes.push({ at: new Date().toISOString(), count: pod.restarts - h.lastRestarts });
      if (h.spikes.length > 20) h.spikes.shift();
    }
    h.lastRestarts = pod.restarts;
  }
}

// Mining hashrate history (ring buffer, stores every poll for 24h at 30s intervals = ~2880 entries)
const MAX_MINING_HISTORY = 2880;
const miningHistory = [];

function recordMiningSnapshot(stats) {
  miningHistory.push({
    timestamp: new Date().toISOString(),
    totalHashrate: stats.totalHashrateRaw || 0,
    minersRunning: stats.minersRunning || 0,
    workers: (stats.workers || []).map(w => ({ name: w.name, hashrate: w.hashrateRaw, status: w.status })),
  });
  if (miningHistory.length > MAX_MINING_HISTORY) miningHistory.shift();
}

// Alert system
const MAX_ALERTS = 50;
const alerts = [];
let lastAlertCheck = {};

function addAlert(severity, title, message, nodeOrPod) {
  const key = `${title}:${nodeOrPod || ''}`;
  const now = Date.now();
  // Deduplicate: don't fire the same alert within 5 minutes
  if (lastAlertCheck[key] && (now - lastAlertCheck[key]) < 300000) return;
  lastAlertCheck[key] = now;

  alerts.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    severity, // 'critical', 'warning', 'info'
    title,
    message,
    node: nodeOrPod || null,
    acknowledged: false,
  });
  if (alerts.length > MAX_ALERTS) alerts.shift();
}

function checkAlerts(data) {
  // Node down alerts
  for (const node of (data.nodes || [])) {
    if (node.status !== 'Ready') {
      addAlert('critical', 'Node Down', `${node.name} is ${node.status}`, node.name);
    }
  }

  // Pod crash loop detection
  for (const pod of (data.pods || [])) {
    if (pod.restarts > 10) {
      addAlert('warning', 'Pod CrashLoop', `${pod.name} has ${pod.restarts} restarts`, pod.name);
    }
    if (pod.status === 'Failed') {
      addAlert('warning', 'Pod Failed', `${pod.name} in ${pod.namespace} is Failed`, pod.name);
    }
  }

  // Mining alerts
  if (data.mining) {
    if (data.mining.minersRunning === 0 && data.mining.minersTotal > 0) {
      addAlert('warning', 'Mining Stopped', 'All miners are offline');
    }
    // Hashrate drop detection
    if (miningHistory.length > 10) {
      const recent = miningHistory[miningHistory.length - 1];
      const earlier = miningHistory[miningHistory.length - 10];
      if (earlier && earlier.totalHashrate > 0 && recent.totalHashrate < earlier.totalHashrate * 0.5) {
        addAlert('warning', 'Hashrate Drop', `Hashrate dropped >50%: ${formatHashrate(earlier.totalHashrate)} -> ${formatHashrate(recent.totalHashrate)}`);
      }
    }
  }
}

// ─── Resource Metrics ────────────────────────────────────────────────────────

let metricsCache = { data: null, timestamp: 0 };
const METRICS_CACHE_TTL = 10000;

async function gatherNodeMetrics() {
  const now = Date.now();
  if (metricsCache.data && (now - metricsCache.timestamp) < METRICS_CACHE_TTL) {
    return metricsCache.data;
  }

  const metrics = {};

  // Gather metrics from all phone nodes in parallel
  const phoneMetrics = await Promise.all(
    CONFIG.phoneNodeNames.map(async name => {
      const m = { cpu: null, memory: null, temp: null, battery: null, storage: null };

      // CPU + Memory + Temp via SSH (single command for efficiency)
      const sshResult = await sshExecAsync(name,
        'echo "CPU:$(top -bn1 2>/dev/null | head -3 | grep -i cpu | head -1)"; ' +
        'echo "MEM:$(free -m 2>/dev/null | grep Mem)"; ' +
        'echo "TEMP:$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo 0)"; ' +
        'echo "DISK:$(df -m / 2>/dev/null | tail -1)"'
      );

      if (sshResult.ok) {
        const lines = sshResult.stdout.split('\n');
        for (const line of lines) {
          if (line.startsWith('CPU:')) {
            // Parse top output for CPU usage
            const cpuMatch = line.match(/(\d+)%\s*(idle|id)/i);
            if (cpuMatch) m.cpu = { usage: 100 - parseInt(cpuMatch[1]), cores: null };
            else {
              const usrMatch = line.match(/(\d+)%\s*usr/i);
              const sysMatch = line.match(/(\d+)%\s*sys/i);
              if (usrMatch || sysMatch) {
                m.cpu = { usage: (parseInt(usrMatch?.[1] || 0)) + (parseInt(sysMatch?.[1] || 0)), cores: null };
              }
            }
          }
          if (line.startsWith('MEM:')) {
            const parts = line.replace('MEM:', '').trim().split(/\s+/);
            if (parts.length >= 3) {
              m.memory = { totalMB: parseInt(parts[1]) || 0, usedMB: parseInt(parts[2]) || 0 };
              if (m.memory.totalMB > 0) m.memory.percent = Math.round((m.memory.usedMB / m.memory.totalMB) * 100);
            }
          }
          if (line.startsWith('TEMP:')) {
            const rawTemp = parseInt(line.replace('TEMP:', '').trim());
            if (rawTemp > 0) m.temp = { celsius: rawTemp > 1000 ? Math.round(rawTemp / 1000) : rawTemp };
          }
          if (line.startsWith('DISK:')) {
            const parts = line.replace('DISK:', '').trim().split(/\s+/);
            if (parts.length >= 4) {
              m.storage = {
                totalMB: parseInt(parts[1]) || 0,
                usedMB: parseInt(parts[2]) || 0,
                availMB: parseInt(parts[3]) || 0,
                percent: parseInt(parts[4]) || 0,
              };
            }
          }
        }
      }

      // Battery via ADB (phones only)
      const battResult = await adbExecAsync(name, 'shell dumpsys battery 2>/dev/null');
      if (battResult.ok && battResult.stdout) {
        const levelMatch = battResult.stdout.match(/level:\s*(\d+)/);
        const statusMatch = battResult.stdout.match(/status:\s*(\d+)/);
        const tempMatch = battResult.stdout.match(/temperature:\s*(\d+)/);
        if (levelMatch) {
          const statusCode = parseInt(statusMatch?.[1] || 0);
          m.battery = {
            level: parseInt(levelMatch[1]),
            charging: statusCode === 2 || statusCode === 5, // 2=Charging, 5=Full
            temperature: tempMatch ? Math.round(parseInt(tempMatch[1]) / 10) : null,
          };
        }
      }

      return { name, metrics: m };
    })
  );

  for (const pm of phoneMetrics) {
    metrics[pm.name] = pm.metrics;
  }

  // AORUS (local) metrics
  const localCpu = run("top -bn1 | head -3 | grep -i cpu | head -1", 5000);
  const localMem = run("free -m | grep Mem", 3000);
  const localTemp = run("cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo 0", 3000);
  const localDisk = run("df -m / | tail -1", 3000);

  const aorus = { cpu: null, memory: null, temp: null, storage: null };
  if (localCpu.ok) {
    const cpuMatch = localCpu.stdout.match(/(\d+[\.,]\d+)\s*(idle|id)/i);
    if (cpuMatch) aorus.cpu = { usage: Math.round(100 - parseFloat(cpuMatch[1].replace(',', '.'))), cores: os.cpus().length };
  }
  if (localMem.ok) {
    const parts = localMem.stdout.split(/\s+/);
    if (parts.length >= 3) {
      aorus.memory = { totalMB: parseInt(parts[1]) || 0, usedMB: parseInt(parts[2]) || 0 };
      if (aorus.memory.totalMB > 0) aorus.memory.percent = Math.round((aorus.memory.usedMB / aorus.memory.totalMB) * 100);
    }
  }
  if (localTemp.ok) {
    const rawTemp = parseInt(localTemp.stdout);
    if (rawTemp > 0) aorus.temp = { celsius: rawTemp > 1000 ? Math.round(rawTemp / 1000) : rawTemp };
  }
  if (localDisk.ok) {
    const parts = localDisk.stdout.split(/\s+/);
    if (parts.length >= 4) {
      aorus.storage = { totalMB: parseInt(parts[1]) || 0, usedMB: parseInt(parts[2]) || 0, availMB: parseInt(parts[3]) || 0, percent: parseInt(parts[4]) || 0 };
    }
  }
  metrics['aorus-node'] = aorus;

  metricsCache = { data: metrics, timestamp: now };
  return metrics;
}

// ─── Endpoint Handlers ──────────────────────────────────────────────────────

async function handleHealth(req, res) {
  sendJson(res, 200, {
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
}

async function handleStatus(req, res) {
  const now = Date.now();
  if (statusCache.data && (now - statusCache.timestamp) < STATUS_CACHE_TTL) {
    return sendJson(res, 200, statusCache.data);
  }

  const errors = [];
  let nodes = [], pods = [], services = [];

  // Kubectl: nodes
  const nodesResult = run('kubectl get nodes -o json', 15000);
  if (nodesResult.ok) {
    try {
      const parsed = JSON.parse(nodesResult.stdout);
      nodes = parsed.items.map(n => {
        const ready = (n.status.conditions || []).find(c => c.type === 'Ready');
        const roles = Object.keys(n.metadata.labels || {})
          .filter(l => l.startsWith('node-role.kubernetes.io/'))
          .map(l => l.replace('node-role.kubernetes.io/', ''));
        return {
          name: n.metadata.name,
          status: ready && ready.status === 'True' ? 'Ready' : 'NotReady',
          role: roles.includes('control-plane') || roles.includes('master') ? 'control-plane' : 'worker',
          ip: ((n.status.addresses || []).find(a => a.type === 'InternalIP') || {}).address || '',
          kubeletVersion: (n.status.nodeInfo || {}).kubeletVersion || '',
          osImage: (n.status.nodeInfo || {}).osImage || '',
          arch: (n.status.nodeInfo || {}).architecture || '',
          age: n.metadata.creationTimestamp || null,
        };
      });
    } catch (e) { errors.push('Failed to parse nodes: ' + e.message); }
  } else {
    errors.push('kubectl get nodes failed: ' + nodesResult.stderr);
  }

  // Track node uptime
  updateNodeTracking(nodes);

  // Kubectl: pods
  const podsResult = run('kubectl get pods -A -o json', 15000);
  if (podsResult.ok) {
    try {
      const parsed = JSON.parse(podsResult.stdout);
      pods = parsed.items.map(p => ({
        name: p.metadata.name,
        namespace: p.metadata.namespace,
        status: (p.status.phase || 'Unknown'),
        node: (p.spec.nodeName || ''),
        restarts: ((p.status.containerStatuses || [])[0] || {}).restartCount || 0,
        ready: (p.status.containerStatuses || []).every(c => c.ready) ? 'True' : 'False',
        containers: (p.spec.containers || []).map(c => c.name),
        age: p.metadata.creationTimestamp || null,
      }));
    } catch (e) { errors.push('Failed to parse pods: ' + e.message); }
  } else {
    errors.push('kubectl get pods failed: ' + podsResult.stderr);
  }

  // Track pod restart spikes
  trackPodRestarts(pods);

  // Kubectl: services
  const svcResult = run('kubectl get svc -A -o json', 15000);
  if (svcResult.ok) {
    try {
      const parsed = JSON.parse(svcResult.stdout);
      services = parsed.items.map(s => ({
        name: s.metadata.name,
        namespace: s.metadata.namespace,
        type: s.spec.type || 'ClusterIP',
        clusterIP: s.spec.clusterIP || '',
        externalIP: ((s.status.loadBalancer || {}).ingress || []).map(i => i.ip || i.hostname).join(', ') || '',
        ports: (s.spec.ports || []).map(p => `${p.port}:${p.targetPort || p.port}${p.nodePort ? ':' + p.nodePort : ''}`),
      }));
    } catch (e) { errors.push('Failed to parse services: ' + e.message); }
  } else {
    errors.push('kubectl get svc failed: ' + svcResult.stderr);
  }

  // Network: Tailscale
  let tailscale = null;
  const tsResult = run('tailscale status --json', 5000);
  if (tsResult.ok) {
    try {
      const ts = JSON.parse(tsResult.stdout);
      const self = ts.Self || {};
      const peers = Object.values(ts.Peer || {}).map(p => ({
        name: p.HostName || '',
        ip: (p.TailscaleIPs || [])[0] || '',
        online: p.Online || false,
      }));
      tailscale = {
        ip: (self.TailscaleIPs || [])[0] || '',
        hostname: self.HostName || '',
        connected: true,
        peers,
      };
    } catch { /* ignore */ }
  }

  // Network: WiFi (from node1)
  let wifi = { ssid: '', signal: '', connected: false };
  const wifiResult = sshExec('node1', 'iw dev wlan0 link 2>/dev/null || echo disconnected');
  if (wifiResult.ok && !wifiResult.stdout.includes('Not connected') && !wifiResult.stdout.includes('disconnected')) {
    const ssidMatch = wifiResult.stdout.match(/SSID:\s*(.+)/);
    const signalMatch = wifiResult.stdout.match(/signal:\s*(-?\d+)/);
    wifi = {
      ssid: ssidMatch ? ssidMatch[1].trim() : '',
      signal: signalMatch ? signalMatch[1] : '',
      connected: true,
    };
  }

  // Network: local IP
  let localIP = '';
  const ipResult = run("ip -4 addr show | grep -oP '192\\.168\\.\\d+\\.\\d+' | head -1", 3000);
  if (ipResult.ok) localIP = ipResult.stdout;

  // Mining stats
  const mining = await gatherMiningStats();
  recordMiningSnapshot(mining);

  // Resource metrics (gathered async in background, use cached or fetch)
  const metrics = await gatherNodeMetrics();

  // Summary
  const nodesReady = nodes.filter(n => n.status === 'Ready').length;
  const podsRunning = pods.filter(p => p.status === 'Running').length;
  const podsFailed = pods.filter(p => p.status === 'Failed').length;
  const podsPending = pods.filter(p => p.status === 'Pending').length;
  const totalRestarts = pods.reduce((sum, p) => sum + (p.restarts || 0), 0);

  // Calculate health score (0-100)
  let healthScore = 100;
  if (nodes.length > 0) {
    const nodeHealth = (nodesReady / nodes.length) * 40; // 40% weight
    healthScore = nodeHealth;
  }
  if (pods.length > 0) {
    const podHealth = (podsRunning / pods.length) * 30; // 30% weight
    healthScore += podHealth;
  } else {
    healthScore += 30;
  }
  if (podsFailed === 0) healthScore += 15; // 15% for no failures
  else healthScore += Math.max(0, 15 - (podsFailed * 3));
  if (totalRestarts < 10) healthScore += 15; // 15% for low restarts
  else if (totalRestarts < 50) healthScore += 8;
  else healthScore += 2;
  healthScore = Math.min(100, Math.max(0, Math.round(healthScore)));

  const data = {
    lastUpdate: new Date().toISOString(),
    nodes,
    pods,
    services,
    network: { tailscale, wifi, localIP },
    mining,
    metrics,
    summary: {
      nodesReady,
      nodesTotal: nodes.length,
      podsRunning,
      podsTotal: pods.length,
      podsFailed,
      podsPending,
      totalRestarts,
      healthScore,
    },
    errors: errors.length > 0 ? errors : undefined,
  };

  // Check for alerts
  checkAlerts(data);

  statusCache = { data, timestamp: now };
  sendJson(res, 200, data);
}

async function handleScreen(req, res, deviceName) {
  if (!CONFIG.phoneNodes[deviceName]) {
    return sendJson(res, 404, { error: 'Unknown device: ' + deviceName });
  }

  const node = CONFIG.phoneNodes[deviceName];
  const serial = node.adb || `${node.ip}:5555`;

  // Try ADB screencap
  const result = runBinary(`adb -s ${serial} exec-out screencap -p`, 10000);
  if (result.ok && result.data && result.data.length > 100) {
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-cache',
      'X-Device': deviceName,
      'X-Screen-Status': 'ok',
    });
    res.end(result.data);
    return;
  }

  // Fallback: SSH framebuffer grab
  const fbResult = runBinary(`ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o BatchMode=yes ${node.ssh} 'fbgrab -' 2>/dev/null`, 10000);
  if (fbResult.ok && fbResult.data && fbResult.data.length > 100) {
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-cache',
      'X-Device': deviceName,
      'X-Screen-Status': 'ok',
    });
    res.end(fbResult.data);
    return;
  }

  sendJson(res, 503, { error: 'Could not capture screen', device: deviceName, status: 'offline' });
}

async function handleScreens(req, res) {
  const now = Date.now();
  if (screensCache.data && (now - screensCache.timestamp) < SCREENS_CACHE_TTL) {
    return sendJson(res, 200, screensCache.data);
  }

  const captures = await Promise.all(
    CONFIG.phoneNodeNames.map(async name => {
      const node = CONFIG.phoneNodes[name];
      const serial = node.adb || `${node.ip}:5555`;

      const result = await runAsyncBinary(`adb -s ${serial} exec-out screencap -p`, 8000);
      if (result.ok && result.data && result.data.length > 100) {
        return {
          device: name,
          status: 'ok',
          image: 'data:image/png;base64,' + result.data.toString('base64'),
          timestamp: new Date().toISOString(),
        };
      }

      const fbResult = await runAsyncBinary(
        `ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o BatchMode=yes ${node.ssh} 'fbgrab -' 2>/dev/null`, 8000
      );
      if (fbResult.ok && fbResult.data && fbResult.data.length > 100) {
        return {
          device: name,
          status: 'ok',
          image: 'data:image/png;base64,' + fbResult.data.toString('base64'),
          timestamp: new Date().toISOString(),
        };
      }

      return { device: name, status: 'offline', image: null, timestamp: new Date().toISOString() };
    })
  );

  const data = { screens: captures };
  screensCache = { data, timestamp: now };
  sendJson(res, 200, data);
}

async function handleCommand(req, res, body) {
  const { command, target, password: pwd, url: browseUrl } = body;

  if (pwd !== CONFIG.password) {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const rateEntry = getRateLimit(clientIp, true);
    if (rateEntry.failedAuth > RATE_LIMIT_AUTH_MAX) {
      return sendJson(res, 429, { error: 'Too many failed attempts' });
    }
    logCommand({ command, target, status: 'denied', reason: 'Invalid password' });
    return sendJson(res, 401, { error: 'Invalid password' });
  }

  const validCommands = ['start', 'stop', 'restart', 'wake', 'sleep', 'mining-start', 'mining-stop', 'browse', 'refresh-adb', 'custom', 'reboot', 'screenshot', 'brightness', 'ssh'];
  if (!validCommands.includes(command)) {
    return sendJson(res, 400, { error: 'Invalid command: ' + command });
  }

  if (command === 'browse' && !browseUrl) {
    return sendJson(res, 400, { error: 'URL required for browse command' });
  }

  // Custom command: SSH into target and run a sanitized command
  if (command === 'custom') {
    const { customCmd } = body;
    if (!customCmd || typeof customCmd !== 'string') {
      return sendJson(res, 400, { error: 'customCmd is required for custom command' });
    }
    // Sanitize: only allow alphanumeric, spaces, dashes, underscores, dots, slashes, colons, equals
    if (!/^[a-zA-Z0-9 _.\-/:=,+@]+$/.test(customCmd)) {
      logCommand({ command: 'custom', target, status: 'denied', reason: 'Invalid characters in customCmd' });
      return sendJson(res, 400, { error: 'customCmd contains disallowed characters. Only alphanumeric, spaces, and common safe characters (- _ . / : = , + @) are allowed.' });
    }
    // Block dangerous commands even if they pass the character filter
    const dangerousPatterns = [/^rm\s/, /^dd\s/, /^mkfs/, /^shutdown/, /^halt/, /^poweroff/, /^kill\s+-9\s+1$/, /^init\s+0/, /^reboot$/];
    if (dangerousPatterns.some(p => p.test(customCmd.trim()))) {
      logCommand({ command: 'custom', target, status: 'denied', reason: 'Blocked dangerous command' });
      return sendJson(res, 400, { error: 'Command blocked for safety' });
    }
    if (customCmd.length > 200) {
      return sendJson(res, 400, { error: 'customCmd too long (max 200 characters)' });
    }
    const customTarget = target;
    if (!customTarget) {
      return sendJson(res, 400, { error: 'Target is required for custom command' });
    }
    let r;
    if (CONFIG.phoneNodes[customTarget]) {
      r = await sshExecAsync(customTarget, customCmd);
    } else if (CONFIG.otherNodes.includes(customTarget)) {
      r = await runAsync(`ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes ${customTarget} ${shellEscape(customCmd)}`, 15000);
    } else {
      return sendJson(res, 400, { error: 'Unknown target node: ' + customTarget });
    }
    logCommand({
      command: 'custom',
      target: customTarget,
      customCmd,
      status: r.ok ? 'success' : 'failed',
      message: r.ok ? r.stdout : r.stderr,
    });
    return sendJson(res, 200, { success: r.ok, output: r.stdout || r.stderr });
  }

  // SSH command: same as custom but uses sshCmd field (sent by dashboard Netlify-relay path)
  if (command === 'ssh') {
    const sshCmd = body.sshCmd;
    if (!sshCmd || typeof sshCmd !== 'string') {
      return sendJson(res, 400, { error: 'sshCmd is required for ssh command' });
    }
    if (!/^[a-zA-Z0-9 _.\-/:=,+@]+$/.test(sshCmd)) {
      logCommand({ command: 'ssh', target, status: 'denied', reason: 'Invalid characters in sshCmd' });
      return sendJson(res, 400, { error: 'sshCmd contains disallowed characters' });
    }
    const dangerousPatterns = [/^rm\s/, /^dd\s/, /^mkfs/, /^shutdown/, /^halt/, /^poweroff/, /^kill\s+-9\s+1$/, /^init\s+0/, /^reboot$/];
    if (dangerousPatterns.some(p => p.test(sshCmd.trim()))) {
      logCommand({ command: 'ssh', target, status: 'denied', reason: 'Blocked dangerous command' });
      return sendJson(res, 400, { error: 'Command blocked for safety' });
    }
    if (sshCmd.length > 200) {
      return sendJson(res, 400, { error: 'sshCmd too long (max 200 characters)' });
    }
    if (!target) {
      return sendJson(res, 400, { error: 'Target is required for ssh command' });
    }
    let r;
    if (CONFIG.phoneNodes[target]) {
      r = await sshExecAsync(target, sshCmd);
    } else if (CONFIG.otherNodes.includes(target)) {
      r = await runAsync(`ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes ${target} ${shellEscape(sshCmd)}`, 15000);
    } else {
      return sendJson(res, 400, { error: 'Unknown target node: ' + target });
    }
    logCommand({ command: 'ssh', target, customCmd: sshCmd, status: r.ok ? 'success' : 'failed', message: r.ok ? r.stdout : r.stderr });
    return sendJson(res, 200, { success: r.ok, output: r.stdout || r.stderr });
  }

  // Brightness: set screen brightness via ADB
  if (command === 'brightness') {
    const level = body.sshCmd || body.level;
    if (level === undefined || level === null || !/^\d+$/.test(String(level))) {
      return sendJson(res, 400, { error: 'Brightness level must be a number (0-255)' });
    }
    const brightnessVal = parseInt(level, 10);
    if (brightnessVal < 0 || brightnessVal > 255) {
      return sendJson(res, 400, { error: 'Brightness must be between 0 and 255' });
    }
    // Brightness is handled per-node via executeOnNode, let it fall through to resolveTargets
  }

  // Special: refresh-adb
  if (command === 'refresh-adb') {
    initAdbDevices();
    const mapped = CONFIG.phoneNodeNames.filter(n => CONFIG.phoneNodes[n].adb);
    logCommand({ command, target: 'adb', status: 'success', message: `${mapped.length} devices found` });
    return sendJson(res, 200, { success: true, message: `ADB refreshed: ${mapped.length} devices found`, devices: mapped });
  }

  // Resolve targets
  const targets = resolveTargets(target || 'all', command);

  // Execute on all targets in parallel
  const results = {};
  await Promise.all(targets.map(async name => {
    try {
      results[name] = await executeOnNode(name, command, browseUrl, body);
    } catch (e) {
      results[name] = { ok: false, error: e.message };
    }
  }));

  const succeeded = Object.values(results).filter(r => r.ok).length;
  const msg = `${command} executed on ${succeeded}/${targets.length} nodes`;

  logCommand({
    command,
    target: target || 'all',
    url: browseUrl || undefined,
    status: succeeded > 0 ? 'success' : 'failed',
    message: msg,
    succeeded,
    total: targets.length,
  });

  sendJson(res, 200, {
    success: succeeded > 0,
    message: msg,
    results,
  });
}

function resolveTargets(target, command) {
  const miningBrowseCommands = ['mining-start', 'mining-stop', 'browse', 'wake', 'sleep', 'screenshot', 'brightness'];

  if (target === 'all') {
    return miningBrowseCommands.includes(command) ? [...CONFIG.phoneNodeNames] : [...CONFIG.phoneNodeNames, ...CONFIG.otherNodes];
  }
  if (target === 'phones') return [...CONFIG.phoneNodeNames];
  if (target === 'pcs') return [...CONFIG.otherNodes];
  if (CONFIG.phoneNodes[target] || CONFIG.otherNodes.includes(target)) return [target];
  return [];
}

async function executeOnNode(name, command, browseUrl, body) {
  const isPhone = CONFIG.phoneNodeNames.includes(name);

  switch (command) {
    case 'start': {
      const svc = name === 'node1' ? 'k3s' : 'k3s-agent';
      const r = await sshExecAsync(name, `doas rc-service ${svc} start`);
      return { ok: r.ok, output: r.stdout || r.stderr };
    }
    case 'stop': {
      const svc = name === 'node1' ? 'k3s' : 'k3s-agent';
      const r = await sshExecAsync(name, `doas rc-service ${svc} stop`);
      return { ok: r.ok, output: r.stdout || r.stderr };
    }
    case 'restart': {
      const svc = name === 'node1' ? 'k3s' : 'k3s-agent';
      const r = await sshExecAsync(name, `doas rc-service ${svc} restart`);
      return { ok: r.ok, output: r.stdout || r.stderr };
    }
    case 'wake': {
      if (!isPhone) return { ok: false, error: 'Not a phone node' };
      const r = await adbExecAsync(name, 'shell input keyevent KEYCODE_WAKEUP');
      return { ok: r.ok, output: r.stdout || r.stderr };
    }
    case 'sleep': {
      if (!isPhone) return { ok: false, error: 'Not a phone node' };
      const r = await adbExecAsync(name, 'shell input keyevent KEYCODE_SLEEP');
      return { ok: r.ok, output: r.stdout || r.stderr };
    }
    case 'mining-start': {
      if (!isPhone) return { ok: false, error: 'Not a phone node' };
      const r = await sshExecAsync(name, 'doas rc-service xmrig start');
      return { ok: r.ok, output: r.stdout || r.stderr };
    }
    case 'mining-stop': {
      if (!isPhone) return { ok: false, error: 'Not a phone node' };
      const r = await sshExecAsync(name, 'doas rc-service xmrig stop');
      return { ok: r.ok, output: r.stdout || r.stderr };
    }
    case 'browse': {
      if (!isPhone) return { ok: false, error: 'Not a phone node' };
      try { new URL(browseUrl); } catch { return { ok: false, error: 'Invalid URL' }; }
      const safeUrl = browseUrl.replace(/[^a-zA-Z0-9:/.?&=%#@+~_-]/g, '');
      let r = await adbExecAsync(name, `shell am start -a android.intent.action.VIEW -d ${shellEscape(safeUrl)}`);
      if (r.ok) return { ok: true, output: r.stdout };
      r = await sshExecAsync(name, `DISPLAY=:0 xdg-open ${shellEscape(safeUrl)} 2>/dev/null || firefox ${shellEscape(safeUrl)} 2>/dev/null &`);
      return { ok: r.ok, output: r.stdout || r.stderr };
    }
    case 'reboot': {
      const r = await sshExecAsync(name, 'doas reboot');
      return { ok: true, output: r.stdout || 'Reboot initiated' };
    }
    case 'screenshot': {
      if (!isPhone) return { ok: false, error: 'Not a phone node' };
      const r = await adbExecAsync(name, 'exec-out screencap -p /dev/null');
      return { ok: true, output: 'Screenshot captured for ' + name };
    }
    case 'brightness': {
      if (!isPhone) return { ok: false, error: 'Not a phone node' };
      const level = parseInt(body && (body.sshCmd || body.level) || '128', 10);
      const r = await adbExecAsync(name, 'shell settings put system screen_brightness ' + Math.max(0, Math.min(255, level)));
      return { ok: r.ok, output: r.stdout || r.stderr || 'Brightness set to ' + level };
    }
    default:
      return { ok: false, error: 'Unhandled command' };
  }
}

// ─── Pod Management ──────────────────────────────────────────────────────────

async function handlePodLogs(req, res, namespace, podName, query) {
  // Validate names to prevent injection
  if (!/^[a-zA-Z0-9._-]+$/.test(namespace) || !/^[a-zA-Z0-9._-]+$/.test(podName)) {
    return sendJson(res, 400, { error: 'Invalid pod or namespace name' });
  }

  const tail = Math.min(parseInt(query.tail) || 100, 500);
  const container = query.container || '';
  const containerArg = container && /^[a-zA-Z0-9._-]+$/.test(container) ? `-c ${container}` : '';

  const result = await runAsync(`kubectl logs ${podName} -n ${namespace} --tail=${tail} ${containerArg}`, 15000);

  if (result.ok) {
    sendJson(res, 200, {
      pod: podName,
      namespace,
      container: container || 'default',
      lines: result.stdout.split('\n'),
      tail,
    });
  } else {
    sendJson(res, 500, { error: 'Failed to get logs', details: result.stderr });
  }
}

async function handlePodDescribe(req, res, namespace, podName) {
  if (!/^[a-zA-Z0-9._-]+$/.test(namespace) || !/^[a-zA-Z0-9._-]+$/.test(podName)) {
    return sendJson(res, 400, { error: 'Invalid pod or namespace name' });
  }

  const result = await runAsync(`kubectl describe pod ${podName} -n ${namespace}`, 15000);
  if (result.ok) {
    sendJson(res, 200, { pod: podName, namespace, describe: result.stdout });
  } else {
    sendJson(res, 500, { error: 'Failed to describe pod', details: result.stderr });
  }
}

async function handlePodDelete(req, res, body) {
  const { namespace, pod, password: pwd, gracePeriod } = body;

  if (pwd !== CONFIG.password) {
    logCommand({ command: 'pod-delete', target: `${namespace}/${pod}`, status: 'denied' });
    return sendJson(res, 401, { error: 'Invalid password' });
  }

  if (!namespace || !pod) {
    return sendJson(res, 400, { error: 'Namespace and pod name required' });
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(namespace) || !/^[a-zA-Z0-9._-]+$/.test(pod)) {
    return sendJson(res, 400, { error: 'Invalid pod or namespace name' });
  }

  const grace = Math.min(Math.max(parseInt(gracePeriod) || 30, 0), 300);
  const result = await runAsync(`kubectl delete pod ${pod} -n ${namespace} --grace-period=${grace}`, 30000);

  logCommand({
    command: 'pod-delete',
    target: `${namespace}/${pod}`,
    status: result.ok ? 'success' : 'failed',
    message: result.ok ? 'Pod deleted' : result.stderr,
  });

  if (result.ok) {
    sendJson(res, 200, { success: true, message: `Pod ${pod} deleted`, output: result.stdout });
  } else {
    sendJson(res, 500, { error: 'Failed to delete pod', details: result.stderr });
  }
}

// ─── Deployment Scaling ─────────────────────────────────────────────────────

async function handleScale(req, res, body) {
  const { namespace, deployment, replicas, password: pwd } = body;

  if (pwd !== CONFIG.password) {
    return sendJson(res, 401, { error: 'Invalid password' });
  }

  if (!namespace || !deployment || replicas === undefined) {
    return sendJson(res, 400, { error: 'Namespace, deployment, and replicas required' });
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(namespace) || !/^[a-zA-Z0-9._-]+$/.test(deployment)) {
    return sendJson(res, 400, { error: 'Invalid deployment or namespace name' });
  }

  const replicaCount = Math.min(Math.max(parseInt(replicas) || 0, 0), 50);
  const result = await runAsync(`kubectl scale deployment ${deployment} -n ${namespace} --replicas=${replicaCount}`, 15000);

  logCommand({
    command: 'scale',
    target: `${namespace}/${deployment}`,
    status: result.ok ? 'success' : 'failed',
    message: `Scaled to ${replicaCount} replicas`,
  });

  if (result.ok) {
    sendJson(res, 200, { success: true, message: `Scaled ${deployment} to ${replicaCount} replicas` });
  } else {
    sendJson(res, 500, { error: 'Failed to scale', details: result.stderr });
  }
}

// ─── Node Operations ────────────────────────────────────────────────────────

async function handleNodeDrain(req, res, body) {
  const { node, password: pwd } = body;

  if (pwd !== CONFIG.password) {
    return sendJson(res, 401, { error: 'Invalid password' });
  }

  if (!node || !/^[a-zA-Z0-9._-]+$/.test(node)) {
    return sendJson(res, 400, { error: 'Invalid node name' });
  }

  const result = await runAsync(`kubectl drain ${node} --ignore-daemonsets --delete-emptydir-data --timeout=60s`, 90000);

  logCommand({
    command: 'node-drain',
    target: node,
    status: result.ok ? 'success' : 'failed',
    message: result.ok ? 'Node drained' : result.stderr,
  });

  sendJson(res, result.ok ? 200 : 500, {
    success: result.ok,
    message: result.ok ? `Node ${node} drained` : 'Failed to drain node',
    output: result.stdout || result.stderr,
  });
}

async function handleNodeUncordon(req, res, body) {
  const { node, password: pwd } = body;

  if (pwd !== CONFIG.password) {
    return sendJson(res, 401, { error: 'Invalid password' });
  }

  if (!node || !/^[a-zA-Z0-9._-]+$/.test(node)) {
    return sendJson(res, 400, { error: 'Invalid node name' });
  }

  const result = await runAsync(`kubectl uncordon ${node}`, 15000);

  logCommand({
    command: 'node-uncordon',
    target: node,
    status: result.ok ? 'success' : 'failed',
  });

  sendJson(res, result.ok ? 200 : 500, {
    success: result.ok,
    message: result.ok ? `Node ${node} uncordoned` : 'Failed to uncordon node',
  });
}

// ─── History & Alerts Endpoints ─────────────────────────────────────────────

function handleCommandLog(req, res) {
  sendJson(res, 200, { commands: [...commandLog].reverse() });
}

function handleAlerts(req, res) {
  sendJson(res, 200, { alerts: [...alerts].reverse() });
}

function handleAlertAck(req, res, body) {
  const { id } = body;
  const alert = alerts.find(a => a.id === id);
  if (alert) {
    alert.acknowledged = true;
    sendJson(res, 200, { success: true });
  } else {
    sendJson(res, 404, { error: 'Alert not found' });
  }
}

function handleMiningHistory(req, res) {
  sendJson(res, 200, { history: miningHistory });
}

function handleNodeHistory(req, res) {
  const summary = {};
  for (const [name, h] of Object.entries(nodeHistory)) {
    summary[name] = {
      lastStatus: h.lastStatus,
      lastSeen: new Date(h.lastSeen).toISOString(),
      statusChanges: h.statusChanges,
      downtimeEvents: h.downtimeEvents,
    };
  }
  sendJson(res, 200, { nodes: summary });
}

// ─── Export ──────────────────────────────────────────────────────────────────

async function handleExport(req, res) {
  const data = statusCache.data || {};
  const exportData = {
    exportedAt: new Date().toISOString(),
    cluster: data,
    commandLog: [...commandLog].reverse().slice(0, 50),
    alerts: [...alerts].reverse(),
    miningHistory: miningHistory.slice(-100),
    nodeHistory: {},
  };
  for (const [name, h] of Object.entries(nodeHistory)) {
    exportData.nodeHistory[name] = {
      lastStatus: h.lastStatus,
      statusChanges: h.statusChanges,
    };
  }
  sendJson(res, 200, exportData);
}

// ─── Mining Stats ────────────────────────────────────────────────────────────

async function handleMiningStats(req, res) {
  const stats = await gatherMiningStats();
  sendJson(res, 200, stats);
}

async function gatherMiningStats() {
  const workers = await Promise.all(
    CONFIG.phoneNodeNames.map(async name => {
      const node = CONFIG.phoneNodes[name];
      const result = await httpGetJson(node.ip, CONFIG.xmrigPort, '/1/summary', 3000);

      if (result.ok && result.data) {
        const d = result.data;
        const hashrate = d.hashrate ? (d.hashrate.total || [])[0] || 0 : 0;
        return {
          name,
          hashrate: formatHashrate(hashrate),
          hashrateRaw: hashrate,
          status: 'mining',
          uptime: d.uptime ? formatUptime(d.uptime) : null,
          accepted: d.results ? d.results.shares_good || 0 : 0,
          rejected: d.results ? d.results.shares_total - d.results.shares_good || 0 : 0,
          algo: d.algo || null,
          threads: d.cpu ? d.cpu.threads || null : null,
        };
      }

      return { name, hashrate: '0 H/s', hashrateRaw: 0, status: 'offline', uptime: null, accepted: 0 };
    })
  );

  const minersRunning = workers.filter(w => w.status === 'mining').length;
  const totalHashrate = workers.reduce((sum, w) => sum + w.hashrateRaw, 0);
  const totalAccepted = workers.reduce((sum, w) => sum + (w.accepted || 0), 0);
  const totalRejected = workers.reduce((sum, w) => sum + (w.rejected || 0), 0);

  // Query pool API for earnings
  let poolBalance = null;
  let totalPaid = null;
  let poolHashrate = null;
  if (CONFIG.xmrWallet) {
    const poolResult = await httpGetJson('supportxmr.com', 443, `/api/miner/${CONFIG.xmrWallet}/stats`, 5000);
    if (poolResult.ok && poolResult.data) {
      const pd = poolResult.data;
      poolBalance = pd.amtDue ? (pd.amtDue / 1e12).toFixed(6) + ' XMR' : null;
      totalPaid = pd.amtPaid ? (pd.amtPaid / 1e12).toFixed(6) + ' XMR' : null;
      poolHashrate = pd.hash ? formatHashrate(pd.hash) : null;
    }
  }

  const dailyUsd = totalHashrate * 0.00005;
  const monthlyUsd = dailyUsd * 30;

  return {
    enabled: minersRunning > 0,
    minersRunning,
    minersTotal: CONFIG.phoneNodeNames.length,
    totalHashrate: formatHashrate(totalHashrate),
    totalHashrateRaw: totalHashrate,
    totalAccepted,
    totalRejected,
    coin: 'XMR',
    pool: CONFIG.xmrPool,
    poolHashrate,
    estimatedDaily: '$' + dailyUsd.toFixed(2),
    estimatedMonthly: '$' + monthlyUsd.toFixed(2),
    poolBalance,
    totalPaid,
    workers,
  };
}

function formatHashrate(h) {
  if (h >= 1000000) return (h / 1000000).toFixed(2) + ' MH/s';
  if (h >= 1000) return (h / 1000).toFixed(2) + ' KH/s';
  return Math.round(h) + ' H/s';
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ─── Battery Endpoint ─────────────────────────────────────────────────────────

let batteryCache = { data: null, timestamp: 0 };
const BATTERY_CACHE_TTL = 10000;

async function handleBattery(req, res) {
  const now = Date.now();
  if (batteryCache.data && now - batteryCache.timestamp < BATTERY_CACHE_TTL) {
    return sendJson(res, 200, batteryCache.data);
  }

  const results = await Promise.all(CONFIG.phoneNodeNames.map(async (name) => {
    const node = CONFIG.phoneNodes[name];
    const battResult = await sshExecAsync(name, 'cat /sys/class/power_supply/battery/capacity 2>/dev/null; echo "|"; cat /sys/class/power_supply/battery/status 2>/dev/null; echo "|"; cat /sys/class/power_supply/battery/temp 2>/dev/null; echo "|"; cat /sys/class/power_supply/battery/voltage_now 2>/dev/null; echo "|"; cat /sys/class/power_supply/battery/current_now 2>/dev/null; echo "|"; cat /sys/class/power_supply/battery/health 2>/dev/null');
    if (!battResult.ok) return { name, online: false };
    const parts = battResult.stdout.split('|').map(s => s.trim());
    const level = parseInt(parts[0]) || 0;
    const status = parts[1] || 'Unknown';
    const tempRaw = parseInt(parts[2]) || 0;
    const voltageRaw = parseInt(parts[3]) || 0;
    const currentRaw = parseInt(parts[4]) || 0;
    const health = parts[5] || 'Unknown';
    return {
      name, online: true, level, status,
      charging: status === 'Charging' || status === 'Full',
      temp: (tempRaw / 10).toFixed(1),
      voltage: (voltageRaw / 1000000).toFixed(2),
      current: (Math.abs(currentRaw) / 1000).toFixed(0),
      health,
    };
  }));

  const online = results.filter(r => r.online);
  const avgLevel = online.length > 0 ? Math.round(online.reduce((s, r) => s + r.level, 0) / online.length) : 0;
  const charging = online.filter(r => r.charging).length;
  const low = online.filter(r => r.level < 20).length;
  const critical = online.filter(r => r.level < 10).length;

  const data = {
    phones: results,
    summary: { avgLevel, charging, low, critical, online: online.length, total: CONFIG.phoneNodeNames.length }
  };
  batteryCache = { data, timestamp: now };
  sendJson(res, 200, data);
}

// ─── Connectivity Endpoint ───────────────────────────────────────────────────

async function handleConnectivity(req, res) {
  const allNodes = [...CONFIG.phoneNodeNames, ...CONFIG.otherNodes];
  const results = await Promise.all(allNodes.map(async (name) => {
    const node = CONFIG.phoneNodes[name];
    if (node) {
      const r = await runAsync(`ping -c 1 -W 2 ${node.ip}`, 5000);
      const latencyMatch = r.stdout.match(/time=([\d.]+)/);
      return { name, reachable: r.ok, latency: latencyMatch ? parseFloat(latencyMatch[1]) : null, ip: node.ip };
    }
    const r = await runAsync(`ping -c 1 -W 2 ${name}`, 5000);
    const latencyMatch = r.stdout.match(/time=([\d.]+)/);
    return { name, reachable: r.ok, latency: latencyMatch ? parseFloat(latencyMatch[1]) : null };
  }));

  const reachable = results.filter(r => r.reachable).length;
  sendJson(res, 200, { nodes: results, summary: { reachable, total: allNodes.length } });
}

// ─── Latency Endpoint (lightweight for connection quality) ───────────────────

async function handleLatency(req, res) {
  const start = process.hrtime.bigint();
  sendJson(res, 200, { ts: Date.now(), serverUptime: process.uptime(), latencyTest: true });
}

// ─── SSH Presets ──────────────────────────────────────────────────────────────

function handleSshPresets(req, res) {
  sendJson(res, 200, {
    presets: [
      { id: 'uptime', label: 'Uptime', icon: 'fa-clock', cmd: 'uptime' },
      { id: 'memory', label: 'Memory', icon: 'fa-memory', cmd: 'free -m' },
      { id: 'disk', label: 'Disk', icon: 'fa-hard-drive', cmd: 'df -h /' },
      { id: 'top', label: 'Top Procs', icon: 'fa-list-ol', cmd: 'top -bn1 | head -15' },
      { id: 'temp', label: 'Temperature', icon: 'fa-temperature-half', cmd: 'cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null | awk \'{printf "%.1f°C\\n", $1/1000}\'' },
      { id: 'network', label: 'Network', icon: 'fa-wifi', cmd: 'ip -br addr | head -5' },
      { id: 'processes', label: 'Processes', icon: 'fa-gears', cmd: 'ps aux --sort=-%cpu | head -10' },
      { id: 'k3s-status', label: 'K3s Status', icon: 'fa-dharmachakra', cmd: 'rc-service k3s-agent status 2>/dev/null || systemctl status k3s-agent 2>/dev/null | head -5' },
      { id: 'battery', label: 'Battery', icon: 'fa-battery-three-quarters', cmd: 'echo "Level: $(cat /sys/class/power_supply/battery/capacity 2>/dev/null || echo N/A)% Status: $(cat /sys/class/power_supply/battery/status 2>/dev/null || echo N/A)"' },
      { id: 'logs', label: 'Recent Logs', icon: 'fa-scroll', cmd: 'dmesg | tail -15' },
    ]
  });
}

// ─── Server-Sent Events (SSE) ─────────────────────────────────────────────

const sseClients = new Set();

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('data: {"type":"connected","ts":' + Date.now() + '}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

function broadcastSSE(event, data) {
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

// Broadcast status every 10s to SSE clients
setInterval(async () => {
  if (sseClients.size === 0) return;
  try {
    const status = statusCache.data || {};
    const summary = status.summary || {};
    broadcastSSE('status', {
      ts: Date.now(),
      nodesReady: summary.nodesReady || 0,
      nodesTotal: summary.nodesTotal || 0,
      podsRunning: summary.podsRunning || 0,
      podsTotal: summary.podsTotal || 0,
      healthScore: summary.healthScore || 0,
    });
  } catch (e) { /* ignore */ }
}, 10000);

// ─── Health History ──────────────────────────────────────────────────────────

const healthHistory = [];
const MAX_HEALTH_HISTORY = 288; // 24h at 5min intervals

function recordHealthSnapshot() {
  const status = statusCache.data || {};
  const summary = status.summary || {};
  healthHistory.push({
    ts: Date.now(),
    score: summary.healthScore || 0,
    nodesReady: summary.nodesReady || 0,
    nodesTotal: summary.nodesTotal || 0,
    podsRunning: summary.podsRunning || 0,
    podsTotal: summary.podsTotal || 0,
  });
  if (healthHistory.length > MAX_HEALTH_HISTORY) healthHistory.shift();
}

setInterval(recordHealthSnapshot, 300000); // Every 5 min

function handleHealthHistory(req, res) {
  sendJson(res, 200, { history: healthHistory });
}

// ─── Pod Resource Usage ─────────────────────────────────────────────────────

let podResourceCache = { data: null, timestamp: 0 };

async function handlePodResources(req, res) {
  const now = Date.now();
  if (podResourceCache.data && (now - podResourceCache.timestamp) < 15000) {
    return sendJson(res, 200, podResourceCache.data);
  }

  const result = await runAsync('kubectl top pods -A --no-headers 2>/dev/null', 15000);
  const resources = {};

  if (result.ok && result.stdout) {
    for (const line of result.stdout.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4) {
        const ns = parts[0];
        const name = parts[1];
        const cpuRaw = parts[2]; // e.g. "12m" or "250m"
        const memRaw = parts[3]; // e.g. "64Mi" or "1Gi"

        let cpuMillis = 0;
        if (cpuRaw.endsWith('m')) cpuMillis = parseInt(cpuRaw);
        else if (cpuRaw.endsWith('n')) cpuMillis = Math.round(parseInt(cpuRaw) / 1000000);
        else cpuMillis = parseInt(cpuRaw) * 1000;

        let memMi = 0;
        if (memRaw.endsWith('Mi')) memMi = parseInt(memRaw);
        else if (memRaw.endsWith('Gi')) memMi = Math.round(parseFloat(memRaw) * 1024);
        else if (memRaw.endsWith('Ki')) memMi = Math.round(parseInt(memRaw) / 1024);

        resources[ns + '/' + name] = { cpu: cpuMillis, mem: memMi };
      }
    }
  }

  const response = { resources, timestamp: new Date().toISOString() };
  podResourceCache = { data: response, timestamp: now };
  sendJson(res, 200, response);
}

// ─── Service Health Check ───────────────────────────────────────────────────

async function handleServiceHealth(req, res) {
  const svcResult = await runAsync('kubectl get svc -A -o json 2>/dev/null', 15000);
  if (!svcResult.ok) return sendJson(res, 500, { error: 'Failed to get services' });

  let services = [];
  try {
    const parsed = JSON.parse(svcResult.stdout);
    services = parsed.items || [];
  } catch { return sendJson(res, 500, { error: 'Parse error' }); }

  const checks = await Promise.all(
    services
      .filter(s => s.spec.clusterIP && s.spec.clusterIP !== 'None')
      .slice(0, 30) // limit to 30 services
      .map(async svc => {
        const ip = svc.spec.clusterIP;
        const port = (svc.spec.ports || [])[0]?.port || 80;
        const name = svc.metadata.name;
        const ns = svc.metadata.namespace;
        const start = Date.now();
        const pingResult = await runAsync(`curl -sf -m 3 -o /dev/null -w '%{http_code}' http://${ip}:${port}/ 2>/dev/null || echo 'fail'`, 5000);
        const elapsed = Date.now() - start;
        const code = pingResult.ok ? pingResult.stdout.trim() : 'fail';
        return {
          name, namespace: ns, ip, port,
          healthy: code !== 'fail' && code !== '000',
          statusCode: code,
          latencyMs: elapsed,
        };
      })
  );

  sendJson(res, 200, { services: checks, timestamp: new Date().toISOString() });
}

// ─── Node Annotations ───────────────────────────────────────────────────────

async function handleNodeAnnotations(req, res, nodeName) {
  if (!/^[a-zA-Z0-9._-]+$/.test(nodeName)) return sendJson(res, 400, { error: 'Invalid node name' });

  const result = await runAsync(`kubectl get node ${nodeName} -o json 2>/dev/null`, 10000);
  if (!result.ok) return sendJson(res, 500, { error: 'Failed to get node' });

  try {
    const node = JSON.parse(result.stdout);
    const annotations = node.metadata?.annotations || {};
    const labels = node.metadata?.labels || {};
    sendJson(res, 200, { node: nodeName, annotations, labels });
  } catch { sendJson(res, 500, { error: 'Parse error' }); }
}

// ─── Metrics History (sparklines) ───────────────────────────────────────────

const metricsHistory = {}; // { nodeName: [{ ts, cpu, mem, temp }] }
const METRICS_HISTORY_MAX = 60; // 60 data points

function recordMetricsSnapshot() {
  const data = metricsCache.data;
  if (!data) return;
  const ts = Date.now();
  for (const [name, m] of Object.entries(data)) {
    if (!metricsHistory[name]) metricsHistory[name] = [];
    metricsHistory[name].push({
      ts,
      cpu: m.cpu?.usage ?? null,
      mem: m.memory?.percent ?? null,
      temp: m.temp?.celsius ?? null,
    });
    if (metricsHistory[name].length > METRICS_HISTORY_MAX) {
      metricsHistory[name] = metricsHistory[name].slice(-METRICS_HISTORY_MAX);
    }
  }
}

// Record metrics every 30 seconds
setInterval(recordMetricsSnapshot, 30000);

function handleMetricsHistory(req, res) {
  sendJson(res, 200, { history: metricsHistory });
}

// ─── Pod YAML ───────────────────────────────────────────────────────────────

async function handlePodYaml(req, res, namespace, podName) {
  if (!/^[a-zA-Z0-9._-]+$/.test(namespace) || !/^[a-zA-Z0-9._-]+$/.test(podName)) {
    return sendJson(res, 400, { error: 'Invalid names' });
  }
  const result = await runAsync(`kubectl get pod ${podName} -n ${namespace} -o yaml 2>/dev/null`, 10000);
  if (!result.ok) return sendJson(res, 500, { error: 'Failed to get pod YAML' });
  sendJson(res, 200, { yaml: result.stdout });
}

// ─── Node Scheduling Status ─────────────────────────────────────────────────

async function handleNodeScheduling(req, res) {
  const result = await runAsync('kubectl get nodes -o json 2>/dev/null', 10000);
  if (!result.ok) return sendJson(res, 500, { error: 'Failed' });
  try {
    const parsed = JSON.parse(result.stdout);
    const nodes = (parsed.items || []).map(n => ({
      name: n.metadata.name,
      unschedulable: n.spec?.unschedulable || false,
      taints: (n.spec?.taints || []).map(t => t.key + '=' + (t.value || '') + ':' + t.effect),
      conditions: (n.status?.conditions || []).filter(c => c.type === 'Ready').map(c => ({ status: c.status, reason: c.reason })),
    }));
    sendJson(res, 200, { nodes });
  } catch { sendJson(res, 500, { error: 'Parse error' }); }
}

// ─── Namespace Resource Quotas ──────────────────────────────────────────────

async function handleResourceQuotas(req, res) {
  const result = await runAsync('kubectl get resourcequota -A -o json 2>/dev/null', 10000);
  const quotas = [];
  if (result.ok) {
    try {
      const parsed = JSON.parse(result.stdout);
      (parsed.items || []).forEach(q => {
        quotas.push({
          name: q.metadata.name,
          namespace: q.metadata.namespace,
          hard: q.status?.hard || {},
          used: q.status?.used || {},
        });
      });
    } catch { /* ignore */ }
  }
  sendJson(res, 200, { quotas });
}

// ─── ConfigMaps & Secrets ────────────────────────────────────────────────────

async function handleConfigMaps(req, res) {
  const [cmResult, secResult] = await Promise.all([
    runAsync('kubectl get configmap -A -o json 2>/dev/null', 10000),
    runAsync('kubectl get secret -A -o json 2>/dev/null', 10000),
  ]);

  const items = [];
  if (cmResult.ok) {
    try {
      const parsed = JSON.parse(cmResult.stdout);
      (parsed.items || []).forEach(cm => {
        items.push({
          name: cm.metadata.name,
          namespace: cm.metadata.namespace,
          type: 'configmap',
          keys: Object.keys(cm.data || {}),
          dataSize: JSON.stringify(cm.data || {}).length,
        });
      });
    } catch { /* ignore */ }
  }
  if (secResult.ok) {
    try {
      const parsed = JSON.parse(secResult.stdout);
      (parsed.items || []).forEach(sec => {
        items.push({
          name: sec.metadata.name,
          namespace: sec.metadata.namespace,
          type: 'secret',
          secretType: sec.type || 'Opaque',
          keys: Object.keys(sec.data || {}),
          dataSize: Object.keys(sec.data || {}).length,
        });
      });
    } catch { /* ignore */ }
  }

  sendJson(res, 200, { items });
}

// ─── CronJobs & Jobs ────────────────────────────────────────────────────────

async function handleCronJobs(req, res) {
  const [cronResult, jobResult] = await Promise.all([
    runAsync('kubectl get cronjob -A -o json 2>/dev/null', 10000),
    runAsync('kubectl get jobs -A -o json 2>/dev/null', 10000),
  ]);

  const cronjobs = [];
  if (cronResult.ok) {
    try {
      const parsed = JSON.parse(cronResult.stdout);
      (parsed.items || []).forEach(cj => {
        cronjobs.push({
          name: cj.metadata.name,
          namespace: cj.metadata.namespace,
          schedule: cj.spec?.schedule || '-',
          suspend: cj.spec?.suspend || false,
          active: (cj.status?.active || []).length,
          lastSchedule: cj.status?.lastScheduleTime || null,
          lastSuccessful: cj.status?.lastSuccessfulTime || null,
        });
      });
    } catch { /* ignore */ }
  }

  const jobs = [];
  if (jobResult.ok) {
    try {
      const parsed = JSON.parse(jobResult.stdout);
      (parsed.items || []).forEach(j => {
        const conditions = j.status?.conditions || [];
        const complete = conditions.find(c => c.type === 'Complete' && c.status === 'True');
        const failed = conditions.find(c => c.type === 'Failed' && c.status === 'True');
        jobs.push({
          name: j.metadata.name,
          namespace: j.metadata.namespace,
          status: complete ? 'Complete' : failed ? 'Failed' : 'Running',
          completions: `${j.status?.succeeded || 0}/${j.spec?.completions || 1}`,
          duration: j.status?.completionTime && j.status?.startTime ?
            Math.round((new Date(j.status.completionTime) - new Date(j.status.startTime)) / 1000) + 's' : '-',
          startTime: j.status?.startTime || null,
        });
      });
    } catch { /* ignore */ }
  }

  sendJson(res, 200, { cronjobs, jobs });
}

// ─── API Latency Tracking ───────────────────────────────────────────────────

const apiLatencyHistory = []; // { ts, endpoint, durationMs }
const API_LATENCY_MAX = 100;

function recordApiLatency(endpoint, durationMs) {
  apiLatencyHistory.push({ ts: Date.now(), endpoint, durationMs: Math.round(durationMs) });
  if (apiLatencyHistory.length > API_LATENCY_MAX) {
    apiLatencyHistory.splice(0, apiLatencyHistory.length - API_LATENCY_MAX);
  }
}

function handleApiLatencyHistory(req, res) {
  sendJson(res, 200, { history: apiLatencyHistory });
}

// ─── Cluster Snapshot/Backup ────────────────────────────────────────────────

async function handleClusterSnapshot(req, res, body) {
  const { password: pwd } = body;
  if (pwd !== CONFIG.password) return sendJson(res, 401, { error: 'Invalid password' });

  // Gather a full snapshot of the cluster state
  const [nodes, pods, svcs, deploys, cms] = await Promise.all([
    runAsync('kubectl get nodes -o json 2>/dev/null', 15000),
    runAsync('kubectl get pods -A -o json 2>/dev/null', 15000),
    runAsync('kubectl get svc -A -o json 2>/dev/null', 15000),
    runAsync('kubectl get deploy -A -o json 2>/dev/null', 15000),
    runAsync('kubectl get configmap -A -o json 2>/dev/null', 15000),
  ]);

  const snapshot = {
    timestamp: new Date().toISOString(),
    nodes: nodes.ok ? nodes.stdout : null,
    pods: pods.ok ? pods.stdout : null,
    services: svcs.ok ? svcs.stdout : null,
    deployments: deploys.ok ? deploys.stdout : null,
    configmaps: cms.ok ? cms.stdout : null,
  };

  sendJson(res, 200, { snapshot, sizeBytes: JSON.stringify(snapshot).length });
}

// ─── Persistent Volume Claims ───────────────────────────────────────────────

async function handlePVCs(req, res) {
  const [pvcResult, pvResult] = await Promise.all([
    runAsync('kubectl get pvc -A -o json 2>/dev/null', 10000),
    runAsync('kubectl get pv -o json 2>/dev/null', 10000),
  ]);

  const pvcs = [];
  if (pvcResult.ok) {
    try {
      const parsed = JSON.parse(pvcResult.stdout);
      (parsed.items || []).forEach(pvc => {
        pvcs.push({
          name: pvc.metadata.name, namespace: pvc.metadata.namespace,
          status: pvc.status?.phase || 'Unknown',
          capacity: pvc.status?.capacity?.storage || '-',
          accessModes: (pvc.status?.accessModes || []).join(', '),
          storageClass: pvc.spec?.storageClassName || '-',
          volumeName: pvc.spec?.volumeName || '-',
        });
      });
    } catch { /* ignore */ }
  }

  const pvs = [];
  if (pvResult.ok) {
    try {
      const parsed = JSON.parse(pvResult.stdout);
      (parsed.items || []).forEach(pv => {
        pvs.push({
          name: pv.metadata.name, capacity: pv.spec?.capacity?.storage || '-',
          status: pv.status?.phase || 'Unknown',
          reclaimPolicy: pv.spec?.persistentVolumeReclaimPolicy || '-',
          storageClass: pv.spec?.storageClassName || '-',
        });
      });
    } catch { /* ignore */ }
  }

  sendJson(res, 200, { pvcs, pvs });
}

// ─── Ingress/Routes ─────────────────────────────────────────────────────────

async function handleIngresses(req, res) {
  const result = await runAsync('kubectl get ingress -A -o json 2>/dev/null', 10000);
  const ingresses = [];
  if (result.ok) {
    try {
      const parsed = JSON.parse(result.stdout);
      (parsed.items || []).forEach(ing => {
        const rules = (ing.spec?.rules || []).map(r => ({
          host: r.host || '*',
          paths: (r.http?.paths || []).map(p => ({
            path: p.path || '/',
            backend: p.backend?.service ? p.backend.service.name + ':' + (p.backend.service.port?.number || '80') : '-',
          })),
        }));
        ingresses.push({
          name: ing.metadata.name, namespace: ing.metadata.namespace,
          className: ing.spec?.ingressClassName || '-', rules,
          tls: (ing.spec?.tls || []).length > 0,
        });
      });
    } catch { /* ignore */ }
  }
  sendJson(res, 200, { ingresses });
}

// ─── Node Detail ─────────────────────────────────────────────────────────────

async function handleNodeDetail(req, res, nodeName) {
  if (!/^[a-zA-Z0-9._-]+$/.test(nodeName)) {
    return sendJson(res, 400, { error: 'Invalid node name' });
  }

  const metrics = (metricsCache.data || {})[nodeName] || null;

  const statusData = statusCache.data || {};
  const pods = (statusData.pods || []).filter(p => p.node === nodeName);

  const history = nodeHistory[nodeName] || null;

  sendJson(res, 200, { metrics, pods, history });
}

// ─── Deployments ─────────────────────────────────────────────────────────────

async function handleDeployments(req, res) {
  const result = await runAsync('kubectl get deployments -A -o json', 15000);
  if (!result.ok) {
    return sendJson(res, 500, { error: 'Failed to get deployments', details: result.stderr });
  }

  const deployments = [];
  try {
    const parsed = JSON.parse(result.stdout);
    (parsed.items || []).forEach(d => {
      const containers = (d.spec?.template?.spec?.containers || []);
      deployments.push({
        name: d.metadata.name,
        namespace: d.metadata.namespace,
        replicas: d.spec?.replicas || 0,
        available: d.status?.availableReplicas || 0,
        image: containers.length > 0 ? containers[0].image : '',
        strategy: d.spec?.strategy?.type || 'RollingUpdate',
      });
    });
  } catch (e) {
    return sendJson(res, 500, { error: 'Failed to parse deployments', details: e.message });
  }

  sendJson(res, 200, { deployments });
}

// ─── Events ──────────────────────────────────────────────────────────────────

async function handleEvents(req, res) {
  const result = await runAsync('kubectl get events -A --sort-by=.lastTimestamp -o json', 15000);
  if (!result.ok) {
    return sendJson(res, 500, { error: 'Failed to get events', details: result.stderr });
  }

  const events = [];
  try {
    const parsed = JSON.parse(result.stdout);
    const items = (parsed.items || []).slice(-50).reverse();
    for (const ev of items) {
      events.push({
        type: ev.type || 'Normal',
        reason: ev.reason || '',
        message: ev.message || '',
        object: ev.involvedObject ? (ev.involvedObject.kind || '') + '/' + (ev.involvedObject.name || '') : '',
        namespace: ev.metadata?.namespace || '',
        timestamp: ev.lastTimestamp || ev.metadata?.creationTimestamp || '',
        count: ev.count || 1,
      });
    }
  } catch (e) {
    return sendJson(res, 500, { error: 'Failed to parse events', details: e.message });
  }

  sendJson(res, 200, { events });
}

// ─── Namespace Usage ─────────────────────────────────────────────────────────

async function handleNamespaceUsage(req, res) {
  const [nsResult, podResult] = await Promise.all([
    runAsync('kubectl get namespaces -o json', 10000),
    runAsync('kubectl get pods -A -o json', 15000),
  ]);

  if (!nsResult.ok) {
    return sendJson(res, 500, { error: 'Failed to get namespaces', details: nsResult.stderr });
  }

  const namespaces = [];
  try {
    const nsParsed = JSON.parse(nsResult.stdout);
    const podsParsed = podResult.ok ? JSON.parse(podResult.stdout) : { items: [] };

    const podsByNs = {};
    for (const pod of (podsParsed.items || [])) {
      const ns = pod.metadata?.namespace || 'default';
      podsByNs[ns] = (podsByNs[ns] || 0) + 1;
    }

    for (const ns of (nsParsed.items || [])) {
      const name = ns.metadata?.name || '';
      namespaces.push({
        name,
        status: ns.status?.phase || 'Active',
        pods: podsByNs[name] || 0,
      });
    }
  } catch (e) {
    return sendJson(res, 500, { error: 'Failed to parse namespace data', details: e.message });
  }

  sendJson(res, 200, { namespaces });
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (CONFIG.allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function checkAuth(req) {
  if (!CONFIG.apiToken) return true;
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7) === CONFIG.apiToken;
  }
  const parsed = url.parse(req.url, true);
  return parsed.query.token === CONFIG.apiToken;
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('Body too large')); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data.trim()) return reject(new Error('Empty body'));
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ─── Rate Limiting ───────────────────────────────────────────────────────────

const rateLimitMap = new Map(); // ip -> { count, resetTime }
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 120; // max requests per minute per IP
const RATE_LIMIT_AUTH_MAX = 10; // max failed auth per minute per IP

function getRateLimit(ip, isFailed) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetTime) {
    entry = { count: 0, failedAuth: 0, resetTime: now + RATE_LIMIT_WINDOW };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  if (isFailed) entry.failedAuth++;
  return entry;
}

// Clean up stale rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetTime) rateLimitMap.delete(ip);
  }
}, 300000);

const server = http.createServer(async (req, res) => {
  const reqStart = Date.now();
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Rate limiting
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const rateEntry = getRateLimit(clientIp, false);
  if (rateEntry.count > RATE_LIMIT_MAX) {
    return sendJson(res, 429, { error: 'Too many requests' });
  }

  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;

  // Track latency for non-stream endpoints
  res.on('finish', () => {
    if (path !== '/api/stream' && path !== '/api/health') {
      recordApiLatency(path, Date.now() - reqStart);
    }
  });

  try {
    // Health — no auth required
    if (req.method === 'GET' && path === '/api/health') {
      return await handleHealth(req, res);
    }

    // All other endpoints require token auth (if configured)
    if (!checkAuth(req)) {
      return sendJson(res, 401, { error: 'Invalid or missing API token' });
    }

    // ─── GET endpoints ───
    if (req.method === 'GET') {
      if (path === '/api/status') return await handleStatus(req, res);
      if (path.startsWith('/api/screen/')) {
        const device = path.split('/api/screen/')[1];
        return await handleScreen(req, res, device);
      }
      if (path === '/api/screens') return await handleScreens(req, res);
      if (path === '/api/mining/stats') return await handleMiningStats(req, res);
      if (path === '/api/mining/history') return handleMiningHistory(req, res);
      if (path === '/api/metrics') {
        const metrics = await gatherNodeMetrics();
        return sendJson(res, 200, { metrics });
      }
      if (path === '/api/commands/log') return handleCommandLog(req, res);
      if (path === '/api/alerts') return handleAlerts(req, res);
      if (path === '/api/nodes/history') return handleNodeHistory(req, res);
      if (path === '/api/export') return await handleExport(req, res);

      // Pod logs: /api/pods/:namespace/:pod/logs?tail=100&container=name
      const logMatch = path.match(/^\/api\/pods\/([^/]+)\/([^/]+)\/logs$/);
      if (logMatch) return await handlePodLogs(req, res, logMatch[1], logMatch[2], parsed.query);

      // Pod describe: /api/pods/:namespace/:pod/describe
      const descMatch = path.match(/^\/api\/pods\/([^/]+)\/([^/]+)\/describe$/);
      if (descMatch) return await handlePodDescribe(req, res, descMatch[1], descMatch[2]);

      // Pod YAML: /api/pod-yaml/:namespace/:pod
      const yamlMatch = path.match(/^\/api\/pod-yaml\/([^/]+)\/([^/]+)$/);
      if (yamlMatch) return await handlePodYaml(req, res, yamlMatch[1], yamlMatch[2]);

      // Node annotations: /api/node-annotations/:node
      const annotMatch = path.match(/^\/api\/node-annotations\/([^/]+)$/);
      if (annotMatch) return await handleNodeAnnotations(req, res, annotMatch[1]);

      if (path === '/api/battery') return await handleBattery(req, res);
      if (path === '/api/connectivity') return await handleConnectivity(req, res);
      if (path === '/api/latency') return await handleLatency(req, res);
      if (path === '/api/ssh/presets') return handleSshPresets(req, res);
      if (path === '/api/stream') return handleSSE(req, res);
      if (path === '/api/health-history') return handleHealthHistory(req, res);
      if (path === '/api/pod-resources') return await handlePodResources(req, res);
      if (path === '/api/service-health') return await handleServiceHealth(req, res);
      if (path === '/api/metrics-history') return handleMetricsHistory(req, res);
      if (path === '/api/node-scheduling') return await handleNodeScheduling(req, res);
      if (path === '/api/resource-quotas') return await handleResourceQuotas(req, res);
      if (path === '/api/configmaps') return await handleConfigMaps(req, res);
      if (path === '/api/cronjobs') return await handleCronJobs(req, res);
      if (path === '/api/api-latency') return handleApiLatencyHistory(req, res);
      if (path === '/api/pvcs') return await handlePVCs(req, res);
      if (path === '/api/ingresses') return await handleIngresses(req, res);
      if (path === '/api/deployments') return await handleDeployments(req, res);
      if (path === '/api/events') return await handleEvents(req, res);
      if (path === '/api/namespaces/usage') return await handleNamespaceUsage(req, res);

      // Node detail: /api/nodes/:name/detail
      const nodeDetailMatch = path.match(/^\/api\/nodes\/([^/]+)\/detail$/);
      if (nodeDetailMatch) return await handleNodeDetail(req, res, nodeDetailMatch[1]);
    }

    // ─── POST endpoints ───
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (path === '/api/command') return await handleCommand(req, res, body);
      if (path === '/api/pods/delete') return await handlePodDelete(req, res, body);
      if (path === '/api/scale') return await handleScale(req, res, body);
      if (path === '/api/nodes/drain') return await handleNodeDrain(req, res, body);
      if (path === '/api/nodes/uncordon') return await handleNodeUncordon(req, res, body);
      if (path === '/api/alerts/ack') return handleAlertAck(req, res, body);
      if (path === '/api/cluster-snapshot') return await handleClusterSnapshot(req, res, body);
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error('[ERROR]', req.method, path, e.message);
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

// ─── Startup ─────────────────────────────────────────────────────────────────

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CLUSTER-API] Unhandled promise rejection:', reason);
});

initAdbDevices();

server.listen(CONFIG.port, () => {
  console.log(`[CLUSTER-API] Server running on port ${CONFIG.port}`);
  console.log(`[CLUSTER-API] Token auth: ${CONFIG.apiToken ? 'enabled' : 'disabled'}`);
  console.log(`[CLUSTER-API] XMR wallet: ${CONFIG.xmrWallet || 'not configured'}`);
  const mapped = CONFIG.phoneNodeNames.filter(n => CONFIG.phoneNodes[n].adb);
  console.log(`[CLUSTER-API] ADB devices: ${mapped.length}/${CONFIG.phoneNodeNames.length}`);
  console.log('[CLUSTER-API] New endpoints: /api/metrics, /api/commands/log, /api/alerts, /api/mining/history, /api/nodes/history, /api/pods/:ns/:pod/logs, /api/pods/delete, /api/scale, /api/nodes/drain, /api/export');
});
