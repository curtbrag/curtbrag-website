#!/usr/bin/env node
// CurtBrag Cluster API Server
// Runs on AORUS control-plane — serves live kubectl data, phone screenshots, and commands
// Zero npm dependencies — uses only Node.js built-in modules

const http = require('http');
const https = require('https');
const { execSync, exec } = require('child_process');
const url = require('url');

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  port: parseInt(process.env.CLUSTER_API_PORT) || 3847,
  password: process.env.CLUSTER_WEB_PASSWORD || '0735',
  apiToken: process.env.CLUSTER_API_TOKEN || '',
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
  otherNodes: ['neo', 'vikixii', 'aorus-node', 'steamdeck', 'pikvm-main'],
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
    const child = exec(cmd, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, stdout: (stdout || '').trim(), stderr: (stderr || err.message || '').trim() });
      else resolve({ ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

function runAsyncBinary(cmd, timeoutMs = 10000) {
  return new Promise(resolve => {
    const child = exec(cmd, { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, data: null, stderr: (stderr || err.message || '').toString().trim() });
      else resolve({ ok: true, data: stdout });
    });
  });
}

function shellEscape(s) {
  // Use single quotes and escape any embedded single quotes
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
  // Fallback: try TCP ADB
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

// ─── Status Cache ────────────────────────────────────────────────────────────

let statusCache = { data: null, timestamp: 0 };
const STATUS_CACHE_TTL = 5000; // 5 seconds

let screensCache = { data: null, timestamp: 0 };
const SCREENS_CACHE_TTL = 15000; // 15 seconds

// ─── Endpoint Handlers ──────────────────────────────────────────────────────

async function handleHealth(req, res) {
  sendJson(res, 200, { status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
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
        };
      });
    } catch (e) { errors.push('Failed to parse nodes: ' + e.message); }
  } else {
    errors.push('kubectl get nodes failed: ' + nodesResult.stderr);
  }

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
      }));
    } catch (e) { errors.push('Failed to parse pods: ' + e.message); }
  } else {
    errors.push('kubectl get pods failed: ' + podsResult.stderr);
  }

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

  // Summary
  const nodesReady = nodes.filter(n => n.status === 'Ready').length;
  const podsRunning = pods.filter(p => p.status === 'Running').length;

  const data = {
    lastUpdate: new Date().toISOString(),
    nodes,
    pods,
    services,
    network: { tailscale, wifi, localIP },
    mining,
    summary: {
      nodesReady,
      nodesTotal: nodes.length,
      podsRunning,
      podsTotal: pods.length,
    },
    errors: errors.length > 0 ? errors : undefined,
  };

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

  // Return error
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

      // Try ADB
      const result = await runAsyncBinary(`adb -s ${serial} exec-out screencap -p`, 8000);
      if (result.ok && result.data && result.data.length > 100) {
        return {
          device: name,
          status: 'ok',
          image: 'data:image/png;base64,' + result.data.toString('base64'),
          timestamp: new Date().toISOString(),
        };
      }

      // Fallback: SSH fbgrab
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

  // Validate password
  if (pwd !== CONFIG.password) {
    return sendJson(res, 401, { error: 'Invalid password' });
  }

  const validCommands = ['start', 'stop', 'restart', 'wake', 'sleep', 'mining-start', 'mining-stop', 'browse', 'refresh-adb'];
  if (!validCommands.includes(command)) {
    return sendJson(res, 400, { error: 'Invalid command: ' + command });
  }

  if (command === 'browse' && !browseUrl) {
    return sendJson(res, 400, { error: 'URL required for browse command' });
  }

  // Special: refresh-adb
  if (command === 'refresh-adb') {
    initAdbDevices();
    const mapped = CONFIG.phoneNodeNames.filter(n => CONFIG.phoneNodes[n].adb);
    return sendJson(res, 200, { success: true, message: `ADB refreshed: ${mapped.length} devices found`, devices: mapped });
  }

  // Resolve targets
  const targets = resolveTargets(target || 'all', command);

  // Execute on all targets in parallel
  const results = {};
  await Promise.all(targets.map(async name => {
    try {
      results[name] = await executeOnNode(name, command, browseUrl);
    } catch (e) {
      results[name] = { ok: false, error: e.message };
    }
  }));

  const succeeded = Object.values(results).filter(r => r.ok).length;
  sendJson(res, 200, {
    success: succeeded > 0,
    message: `${command} executed on ${succeeded}/${targets.length} nodes`,
    results,
  });
}

function resolveTargets(target, command) {
  // Mining and browse commands only apply to phone nodes
  const miningBrowseCommands = ['mining-start', 'mining-stop', 'browse', 'wake', 'sleep'];

  if (target === 'all') {
    return miningBrowseCommands.includes(command) ? [...CONFIG.phoneNodeNames] : [...CONFIG.phoneNodeNames, ...CONFIG.otherNodes];
  }
  if (target === 'phones') return [...CONFIG.phoneNodeNames];
  if (target === 'pcs') return [...CONFIG.otherNodes];
  if (CONFIG.phoneNodes[target] || CONFIG.otherNodes.includes(target)) return [target];
  return [];
}

async function executeOnNode(name, command, browseUrl) {
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
      // Validate URL to prevent injection
      try { new URL(browseUrl); } catch { return { ok: false, error: 'Invalid URL' }; }
      const safeUrl = browseUrl.replace(/[^a-zA-Z0-9:/.?&=%#@+~_-]/g, '');
      // Try ADB intent first
      let r = await adbExecAsync(name, `shell am start -a android.intent.action.VIEW -d '${safeUrl}'`);
      if (r.ok) return { ok: true, output: r.stdout };
      // Fallback: SSH launch browser
      r = await sshExecAsync(name, `DISPLAY=:0 xdg-open '${safeUrl}' 2>/dev/null || firefox '${safeUrl}' 2>/dev/null &`);
      return { ok: r.ok, output: r.stdout || r.stderr };
    }
    default:
      return { ok: false, error: 'Unhandled command' };
  }
}

async function handleMiningStats(req, res) {
  const stats = await gatherMiningStats();
  sendJson(res, 200, stats);
}

async function gatherMiningStats() {
  // Query xmrig HTTP API on each phone node
  const workers = await Promise.all(
    CONFIG.phoneNodeNames.map(async name => {
      const node = CONFIG.phoneNodes[name];
      const headers = CONFIG.xmrigToken ? { 'Authorization': 'Bearer ' + CONFIG.xmrigToken } : {};
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
        };
      }

      return { name, hashrate: '0 H/s', hashrateRaw: 0, status: 'offline', uptime: null, accepted: 0 };
    })
  );

  const minersRunning = workers.filter(w => w.status === 'mining').length;
  const totalHashrate = workers.reduce((sum, w) => sum + w.hashrateRaw, 0);

  // Query pool API for earnings
  let poolBalance = null;
  let totalPaid = null;
  if (CONFIG.xmrWallet) {
    const poolResult = await httpGetJson('supportxmr.com', 443, `/api/miner/${CONFIG.xmrWallet}/stats`, 5000);
    if (poolResult.ok && poolResult.data) {
      const pd = poolResult.data;
      poolBalance = pd.amtDue ? (pd.amtDue / 1e12).toFixed(6) + ' XMR' : null;
      totalPaid = pd.amtPaid ? (pd.amtPaid / 1e12).toFixed(6) + ' XMR' : null;
    }
  }

  // Estimate earnings (rough: ~$0.00005 per H/s per day at typical difficulty)
  const dailyUsd = totalHashrate * 0.00005;
  const monthlyUsd = dailyUsd * 30;

  return {
    enabled: minersRunning > 0,
    minersRunning,
    minersTotal: CONFIG.phoneNodeNames.length,
    totalHashrate: formatHashrate(totalHashrate),
    totalHashrateRaw: totalHashrate,
    coin: 'XMR',
    pool: CONFIG.xmrPool,
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
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function checkAuth(req) {
  if (!CONFIG.apiToken) return true; // No token configured = auth disabled
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7) === CONFIG.apiToken;
  }
  // Also check query param
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

const server = http.createServer(async (req, res) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;

  try {
    // Health — no auth required
    if (req.method === 'GET' && path === '/api/health') {
      return await handleHealth(req, res);
    }

    // All other endpoints require token auth (if configured)
    if (!checkAuth(req)) {
      return sendJson(res, 401, { error: 'Invalid or missing API token' });
    }

    if (req.method === 'GET' && path === '/api/status') {
      return await handleStatus(req, res);
    }

    if (req.method === 'GET' && path.startsWith('/api/screen/')) {
      const device = path.split('/api/screen/')[1];
      return await handleScreen(req, res, device);
    }

    if (req.method === 'GET' && path === '/api/screens') {
      return await handleScreens(req, res);
    }

    if (req.method === 'GET' && path === '/api/mining/stats') {
      return await handleMiningStats(req, res);
    }

    if (req.method === 'POST' && path === '/api/command') {
      const body = await readBody(req);
      return await handleCommand(req, res, body);
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error('[ERROR]', req.method, path, e.message);
    sendJson(res, 500, { error: 'Internal server error: ' + e.message });
  }
});

// ─── Startup ─────────────────────────────────────────────────────────────────

initAdbDevices();

server.listen(CONFIG.port, () => {
  console.log(`[CLUSTER-API] Server running on port ${CONFIG.port}`);
  console.log(`[CLUSTER-API] Password: ${CONFIG.password}`);
  console.log(`[CLUSTER-API] Token auth: ${CONFIG.apiToken ? 'enabled' : 'disabled'}`);
  console.log(`[CLUSTER-API] XMR wallet: ${CONFIG.xmrWallet || 'not configured'}`);
  const mapped = CONFIG.phoneNodeNames.filter(n => CONFIG.phoneNodes[n].adb);
  console.log(`[CLUSTER-API] ADB devices: ${mapped.length}/${CONFIG.phoneNodeNames.length}`);
});
