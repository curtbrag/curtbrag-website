// Cluster Status API for K3s Phone Cluster Dashboard
// Receives status updates from cluster and serves to website
// Uses Netlify Blobs for persistence across cold starts

const { getStore, connectLambda } = require("@netlify/blobs");
const crypto = require("crypto");

// Timing-safe string comparison to prevent timing attacks on credentials
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Credential helper — check env var first, fall back to Netlify Blobs
async function getApiKey() {
  const env = process.env.CLUSTER_API_KEY;
  if (env) return env;
  try {
    const store = getStore("cluster-config");
    return await store.get("api-key", { type: "text" }) || null;
  } catch { return null; }
}

// Demo data for when no live data is available
const DEMO_DATA = {
  nodes: [
    { name: 'node1', status: 'Ready', role: 'control-plane', ip: '192.168.1.206', kubeletVersion: 'v1.28.4+k3s1', osImage: 'Alpine Linux', arch: 'aarch64' },
    { name: 'node2', status: 'Ready', role: 'worker', ip: '192.168.1.207', kubeletVersion: 'v1.28.4+k3s1', osImage: 'Alpine Linux', arch: 'aarch64' },
    { name: 'node3', status: 'Ready', role: 'worker', ip: '192.168.1.208', kubeletVersion: 'v1.28.4+k3s1', osImage: 'Alpine Linux', arch: 'aarch64' },
    { name: 'node4', status: 'Ready', role: 'worker', ip: '192.168.1.209', kubeletVersion: 'v1.28.4+k3s1', osImage: 'Alpine Linux', arch: 'aarch64' },
    { name: 'node5', status: 'Ready', role: 'worker', ip: '192.168.1.210', kubeletVersion: 'v1.28.4+k3s1', osImage: 'Alpine Linux', arch: 'aarch64' },
    { name: 'node6', status: 'Ready', role: 'worker', ip: '192.168.1.211', kubeletVersion: 'v1.28.4+k3s1', osImage: 'Alpine Linux', arch: 'aarch64' },
    { name: 'node7', status: 'Ready', role: 'worker', ip: '192.168.1.212', kubeletVersion: 'v1.28.4+k3s1', osImage: 'Alpine Linux', arch: 'aarch64' },
    { name: 'node8', status: 'NotReady', role: 'worker', ip: '192.168.1.213', kubeletVersion: 'v1.28.4+k3s1', osImage: 'Alpine Linux', arch: 'aarch64' },
    { name: 'node9', status: 'NotReady', role: 'worker', ip: '192.168.1.214', kubeletVersion: 'v1.28.4+k3s1', osImage: 'Alpine Linux', arch: 'aarch64' },
    { name: 'node10', status: 'NotReady', role: 'worker', ip: '192.168.1.215', kubeletVersion: 'v1.28.4+k3s1', osImage: 'Alpine Linux', arch: 'aarch64' }
  ],
  pods: [
    { name: 'nginx-deployment-7c5b4f9d8-x2k9m', namespace: 'default', status: 'Running', node: 'node2', restarts: 0, ready: '1/1' },
    { name: 'nginx-deployment-7c5b4f9d8-h7n3p', namespace: 'default', status: 'Running', node: 'node3', restarts: 0, ready: '1/1' },
    { name: 'nginx-deployment-7c5b4f9d8-q4w8r', namespace: 'default', status: 'Running', node: 'node4', restarts: 1, ready: '1/1' },
    { name: 'redis-master-0', namespace: 'default', status: 'Running', node: 'node5', restarts: 0, ready: '1/1' },
    { name: 'redis-replica-5d8c7b6f4-m2k8n', namespace: 'default', status: 'Running', node: 'node6', restarts: 0, ready: '1/1' },
    { name: 'redis-replica-5d8c7b6f4-p9x3v', namespace: 'default', status: 'Running', node: 'node7', restarts: 2, ready: '1/1' },
    { name: 'coredns-5dd5756b68-4z7wp', namespace: 'kube-system', status: 'Running', node: 'node1', restarts: 0, ready: '1/1' },
    { name: 'coredns-5dd5756b68-8m2nq', namespace: 'kube-system', status: 'Running', node: 'node2', restarts: 0, ready: '1/1' },
    { name: 'local-path-provisioner-957fdf8bc-v7k2m', namespace: 'kube-system', status: 'Running', node: 'node1', restarts: 0, ready: '1/1' },
    { name: 'metrics-server-648b5df564-x9p3k', namespace: 'kube-system', status: 'Running', node: 'node3', restarts: 0, ready: '1/1' },
    { name: 'traefik-97b44b794-h8m2n', namespace: 'kube-system', status: 'Running', node: 'node4', restarts: 0, ready: '1/1' },
    { name: 'svclb-traefik-2k8m9', namespace: 'kube-system', status: 'Running', node: 'node5', restarts: 0, ready: '1/1' }
  ],
  services: [
    { name: 'kubernetes', namespace: 'default', type: 'ClusterIP', clusterIP: '10.43.0.1', ports: ['443:6443'] },
    { name: 'nginx-service', namespace: 'default', type: 'NodePort', clusterIP: '10.43.128.45', ports: ['80:30080'] },
    { name: 'redis-master', namespace: 'default', type: 'ClusterIP', clusterIP: '10.43.89.12', ports: ['6379:6379'] },
    { name: 'redis-replica', namespace: 'default', type: 'ClusterIP', clusterIP: '10.43.156.78', ports: ['6379:6379'] },
    { name: 'kube-dns', namespace: 'kube-system', type: 'ClusterIP', clusterIP: '10.43.0.10', ports: ['53:53', '9153:9153'] },
    { name: 'metrics-server', namespace: 'kube-system', type: 'ClusterIP', clusterIP: '10.43.45.67', ports: ['443:443'] },
    { name: 'traefik', namespace: 'kube-system', type: 'LoadBalancer', clusterIP: '10.43.200.100', ports: ['80:80', '443:443'] }
  ],
  network: {
    tailscale: {
      ip: '100.64.0.1',
      hostname: 'node1',
      connected: true,
      peers: [
        { name: 'node2', ip: '100.64.0.2', online: true },
        { name: 'node3', ip: '100.64.0.3', online: true },
        { name: 'node4', ip: '100.64.0.4', online: true },
        { name: 'node5', ip: '100.64.0.5', online: true },
        { name: 'node6', ip: '100.64.0.6', online: true },
        { name: 'node7', ip: '100.64.0.7', online: true },
        { name: 'node8', ip: '100.64.0.8', online: false },
        { name: 'node9', ip: '100.64.0.9', online: false },
        { name: 'node10', ip: '100.64.0.10', online: false }
      ]
    },
    wifi: { ssid: 'BragdonCluster', signal: '-45', connected: true },
    localIP: '192.168.1.206'
  },
  metrics: {
    node1:  { cpu: { usage: 23, cores: 8 }, memory: { totalMB: 3800, usedMB: 1900, percent: 50 }, temp: { celsius: 42 }, storage: { totalMB: 29000, usedMB: 12000, availMB: 17000, percent: 41 }, battery: { level: 78, charging: true, temperature: 31 } },
    node2:  { cpu: { usage: 45, cores: 8 }, memory: { totalMB: 3800, usedMB: 2400, percent: 63 }, temp: { celsius: 44 }, storage: { totalMB: 29000, usedMB: 14000, availMB: 15000, percent: 48 }, battery: { level: 65, charging: false, temperature: 33 } },
    node3:  { cpu: { usage: 38, cores: 8 }, memory: { totalMB: 3800, usedMB: 2100, percent: 55 }, temp: { celsius: 40 }, storage: { totalMB: 29000, usedMB: 11000, availMB: 18000, percent: 38 }, battery: { level: 82, charging: true, temperature: 30 } },
    node4:  { cpu: { usage: 55, cores: 8 }, memory: { totalMB: 3800, usedMB: 2800, percent: 74 }, temp: { celsius: 47 }, storage: { totalMB: 29000, usedMB: 16000, availMB: 13000, percent: 55 }, battery: { level: 91, charging: true, temperature: 29 } },
    node5:  { cpu: { usage: 12, cores: 8 }, memory: { totalMB: 3800, usedMB: 1500, percent: 39 }, temp: { celsius: 38 }, storage: { totalMB: 29000, usedMB: 10000, availMB: 19000, percent: 34 }, battery: { level: 44, charging: false, temperature: 32 } },
    node6:  { cpu: { usage: 67, cores: 8 }, memory: { totalMB: 3800, usedMB: 3000, percent: 79 }, temp: { celsius: 50 }, storage: { totalMB: 29000, usedMB: 18000, availMB: 11000, percent: 62 }, battery: { level: 55, charging: false, temperature: 35 } },
    node7:  { cpu: { usage: 31, cores: 8 }, memory: { totalMB: 3800, usedMB: 1800, percent: 47 }, temp: { celsius: 39 }, storage: { totalMB: 29000, usedMB: 13000, availMB: 16000, percent: 45 }, battery: { level: 72, charging: true, temperature: 31 } },
    node8:  { cpu: { usage: 0, cores: null }, memory: { totalMB: 0, usedMB: 0, percent: 0 }, temp: null, storage: { totalMB: 0, usedMB: 0, availMB: 0, percent: 0 } },
    node9:  { cpu: { usage: 0, cores: null }, memory: { totalMB: 0, usedMB: 0, percent: 0 }, temp: null, storage: { totalMB: 0, usedMB: 0, availMB: 0, percent: 0 } },
    node10: { cpu: { usage: 0, cores: null }, memory: { totalMB: 0, usedMB: 0, percent: 0 }, temp: null, storage: { totalMB: 0, usedMB: 0, availMB: 0, percent: 0 } }
  },
  battery: {
    phones: [
      { name: 'node1', online: true, level: 78, status: 'Charging', charging: true, temp: '31', voltage: '4.15', health: 'Good' },
      { name: 'node2', online: true, level: 65, status: 'Discharging', charging: false, temp: '33', voltage: '3.92', health: 'Good' },
      { name: 'node3', online: true, level: 82, status: 'Charging', charging: true, temp: '30', voltage: '4.20', health: 'Good' },
      { name: 'node4', online: true, level: 91, status: 'Charging', charging: true, temp: '29', voltage: '4.30', health: 'Good' },
      { name: 'node5', online: true, level: 44, status: 'Discharging', charging: false, temp: '32', voltage: '3.78', health: 'Good' },
      { name: 'node6', online: true, level: 55, status: 'Discharging', charging: false, temp: '35', voltage: '3.85', health: 'Good' },
      { name: 'node7', online: true, level: 72, status: 'Charging', charging: true, temp: '31', voltage: '4.10', health: 'Good' },
      { name: 'node8', online: false },
      { name: 'node9', online: false },
      { name: 'node10', online: false }
    ],
    summary: { avgLevel: 70, charging: 4, low: 0, critical: 0, online: 7, total: 10 }
  },
  events: [
    { type: 'Normal', reason: 'Scheduled', message: 'Successfully assigned default/nginx-deployment-7c5b4f9d8-x2k9m to node2', object: 'Pod/nginx-deployment-7c5b4f9d8-x2k9m', namespace: 'default', count: 1, timestamp: new Date(Date.now() - 120000).toISOString() },
    { type: 'Normal', reason: 'Pulled', message: 'Container image \"nginx:1.25\" already present on machine', object: 'Pod/nginx-deployment-7c5b4f9d8-x2k9m', namespace: 'default', count: 1, timestamp: new Date(Date.now() - 115000).toISOString() },
    { type: 'Normal', reason: 'Started', message: 'Started container nginx', object: 'Pod/nginx-deployment-7c5b4f9d8-x2k9m', namespace: 'default', count: 1, timestamp: new Date(Date.now() - 110000).toISOString() },
    { type: 'Warning', reason: 'NodeNotReady', message: 'Node node8 status is now: NodeNotReady', object: 'Node/node8', namespace: '', count: 3, timestamp: new Date(Date.now() - 300000).toISOString() },
    { type: 'Warning', reason: 'NodeNotReady', message: 'Node node9 status is now: NodeNotReady', object: 'Node/node9', namespace: '', count: 2, timestamp: new Date(Date.now() - 240000).toISOString() },
    { type: 'Normal', reason: 'NodeReady', message: 'Node node7 status is now: NodeReady', object: 'Node/node7', namespace: '', count: 1, timestamp: new Date(Date.now() - 60000).toISOString() }
  ],
  nodeScheduling: [
    { name: 'node1', unschedulable: false, taints: [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }] },
    { name: 'node2', unschedulable: false, taints: [] },
    { name: 'node3', unschedulable: false, taints: [] },
    { name: 'node4', unschedulable: false, taints: [] },
    { name: 'node5', unschedulable: false, taints: [] },
    { name: 'node6', unschedulable: false, taints: [] },
    { name: 'node7', unschedulable: false, taints: [] },
    { name: 'node8', unschedulable: false, taints: [] },
    { name: 'node9', unschedulable: false, taints: [] },
    { name: 'node10', unschedulable: false, taints: [] }
  ],
  mining: {
    enabled: true,
    minersRunning: 3,
    minersTotal: 10,
    totalHashrate: '~1.5 KH/s',
    totalHashrateRaw: 1500,
    coin: 'XMR',
    pool: 'moneroocean.stream',
    estimatedDaily: '$0.08',
    estimatedMonthly: '$2.25',
    workers: [
      { name: 'node1', hashrate: '145 H/s', hashrateRaw: 145, status: 'mining', accepted: 234, rejected: 2 },
      { name: 'node2', hashrate: '152 H/s', hashrateRaw: 152, status: 'mining', accepted: 198, rejected: 1 },
      { name: 'node3', hashrate: '148 H/s', hashrateRaw: 148, status: 'mining', accepted: 210, rejected: 3 },
      { name: 'node4', hashrate: '155 H/s', hashrateRaw: 155, status: 'mining', accepted: 187, rejected: 0 },
      { name: 'node5', hashrate: '140 H/s', hashrateRaw: 140, status: 'mining', accepted: 175, rejected: 1 },
      { name: 'node6', hashrate: '150 H/s', hashrateRaw: 150, status: 'mining', accepted: 220, rejected: 2 },
      { name: 'node7', hashrate: '142 H/s', hashrateRaw: 142, status: 'mining', accepted: 195, rejected: 0 },
      { name: 'node8', hashrate: '0 H/s', hashrateRaw: 0, status: 'offline', accepted: 0 },
      { name: 'node9', hashrate: '0 H/s', hashrateRaw: 0, status: 'offline', accepted: 0 },
      { name: 'node10', hashrate: '0 H/s', hashrateRaw: 0, status: 'offline', accepted: 0 }
    ]
  },
  summary: {
    nodesReady: 7,
    nodesTotal: 10,
    podsRunning: 12,
    podsTotal: 12,
    podsPending: 0,
    podsFailed: 0,
    totalRestarts: 3,
    healthScore: 72
  }
};

// In-memory cache to avoid hitting Blobs on every request
let cachedStatus = null;
let cacheTime = 0;
const CACHE_TTL = 5000; // 5 seconds

async function getStatus() {
  if (cachedStatus && Date.now() - cacheTime < CACHE_TTL) {
    return JSON.parse(JSON.stringify(cachedStatus));
  }

  try {
    const store = getStore("cluster-data");
    const data = await store.get("status", { type: "json" });
    if (data && data.lastUpdate) {
      cachedStatus = data;
      cacheTime = Date.now();
      return data;
    }
  } catch (e) {
    console.warn("Blobs read failed, using fallback:", e.message);
  }

  return null;
}

async function saveStatus(data) {
  cachedStatus = data;
  cacheTime = Date.now();

  try {
    const store = getStore("cluster-data");
    await store.setJSON("status", data);
  } catch (e) {
    console.warn("Blobs write failed:", e.message);
  }
}

const ALLOWED_ORIGINS = ['https://www.curtbrag.com', 'https://curtbrag.com'];

function getCorsOrigin(event) {
  const origin = (event.headers || {}).origin || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

exports.handler = async function(event, context) {
  const corsOrigin = getCorsOrigin(event);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Headers': 'Content-Type, X-Cluster-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };
  if (corsOrigin) headers['Access-Control-Allow-Origin'] = corsOrigin;

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Initialize Netlify Blobs for Lambda compatibility mode
  connectLambda(event);

  // POST - Update cluster status (from node1 cron job)
  if (event.httpMethod === 'POST') {
    try {
      const apiKey = event.headers['x-cluster-key'];
      const expectedKey = await getApiKey();
      if (!expectedKey || !safeCompare(apiKey || '', expectedKey)) {
        return {
          statusCode: 401,
          headers,
          body: JSON.stringify({ error: 'Invalid API key' })
        };
      }

      const data = JSON.parse(event.body);
      if (data.nodes && !Array.isArray(data.nodes)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'nodes must be an array' }) };
      }
      if (data.pods && !Array.isArray(data.pods)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'pods must be an array' }) };
      }
      if (data.summary && typeof data.summary !== 'object') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'summary must be an object' }) };
      }
      const statusData = {
        lastUpdate: new Date().toISOString(),
        nodes: data.nodes || [],
        pods: data.pods || [],
        services: data.services || [],
        network: data.network || null,
        metrics: data.metrics || null,
        battery: data.battery || null,
        mining: data.mining || null,
        events: data.events || null,
        nodeScheduling: data.nodeScheduling || null,
        summary: data.summary || {
          nodesReady: 0,
          nodesTotal: 0,
          podsRunning: 0,
          podsTotal: 0
        }
      };

      await saveStatus(statusData);

      // Append mining history point
      if (statusData.mining && statusData.mining.totalHashrateRaw > 0) {
        try {
          const histStore = getStore("cluster-data");
          const existing = await histStore.get("mining-history", { type: "json" }) || [];
          existing.push({
            timestamp: statusData.lastUpdate,
            totalHashrate: statusData.mining.totalHashrateRaw,
            miners: statusData.mining.minersRunning
          });
          // Keep last 288 entries (24 hours at 5-min intervals)
          const trimmed = existing.slice(-288);
          await histStore.setJSON("mining-history", trimmed);
        } catch (e) {
          console.warn("Mining history append failed:", e.message);
        }
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, lastUpdate: statusData.lastUpdate })
      };
    } catch (error) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid request body' })
      };
    }
  }

  // GET - Return current cluster status
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};

    // Mining history query
    if (params.type === 'mining-history') {
      try {
        const histStore = getStore("cluster-data");
        const history = await histStore.get("mining-history", { type: "json" }) || [];
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ history })
        };
      } catch (e) {
        return { statusCode: 200, headers, body: JSON.stringify({ history: [] }) };
      }
    }

    const rawStatus = await getStatus();

    if (rawStatus && rawStatus.lastUpdate) {
      // Clone to avoid mutating the cached object
      const status = JSON.parse(JSON.stringify(rawStatus));
      const parsedUpdate = new Date(status.lastUpdate).getTime();
      const age = isNaN(parsedUpdate) ? Infinity : Date.now() - parsedUpdate;
      const ageMinutes = isNaN(parsedUpdate) ? null : Math.round(age / 60000);
      // Stale after 6 minutes (one cron interval + 1 min buffer)
      if (age > 6 * 60 * 1000) {
        status.stale = true;
        status.ageMinutes = ageMinutes;
        // Severity levels for UI to display appropriately
        if (age > 2 * 60 * 60 * 1000) {
          status.staleLevel = 'dead';      // 2+ hours - cluster likely offline
        } else if (age > 30 * 60 * 1000) {
          status.staleLevel = 'critical';  // 30+ min - something is wrong
        } else {
          status.staleLevel = 'warning';   // 6-30 min - may be transient
        }
      }

      // Synthesize nodes from metrics/battery/tailscale when K3s is down
      // (push script sends metrics but nodes array is empty)
      if ((!status.nodes || status.nodes.length === 0) && status.metrics && Object.keys(status.metrics).length > 0) {
        const batteryMap = {};
        if (status.battery && status.battery.phones) {
          status.battery.phones.forEach(p => { batteryMap[p.name] = p; });
        }
        const tailscaleMap = {};
        if (status.network && status.network.tailscale && status.network.tailscale.peers) {
          status.network.tailscale.peers.forEach(p => { tailscaleMap[p.name] = p; });
        }

        const nodeIPs = {
          node1:'192.168.1.206', node2:'192.168.1.207', node3:'192.168.1.208',
          node4:'192.168.1.209', node5:'192.168.1.210', node6:'192.168.1.211',
          node7:'192.168.1.212', node8:'192.168.1.213', node9:'192.168.1.214',
          node10:'192.168.1.215',
          'nexus-prime':'192.168.1.179', 'viki':'192.168.1.217',
          'skynet':'192.168.1.218', 'steamdeck':'192.168.1.171'
        };

        const synthNodes = [];
        let nodesReady = 0;
        for (const [name, m] of Object.entries(status.metrics)) {
          const batt = batteryMap[name];
          const ts = tailscaleMap[name];
          // Node is \"Ready\" if it reported memory (always > 0 when alive), battery is online, or tailscale is online
          // CPU usage can be 0 during idle, so memory is a more reliable indicator
          const hasMetrics = m.memory && m.memory.totalMB > 0;
          const battOnline = batt && batt.online;
          const tsOnline = ts && ts.online;
          const isReady = hasMetrics || battOnline || tsOnline;
          if (isReady) nodesReady++;

          synthNodes.push({
            name,
            status: isReady ? 'Ready' : 'NotReady',
            role: name === 'node1' ? 'control-plane' : 'worker',
            ip: nodeIPs[name] || '',
            kubeletVersion: 'N/A (K3s down)',
            osImage: 'postmarketOS',
            arch: 'aarch64'
          });
        }

        // Sort by name (numeric for nodeN, alphabetical for others)
        synthNodes.sort((a, b) => {
          const na = parseInt(a.name.replace('node', ''));
          const nb = parseInt(b.name.replace('node', ''));
          if (!isNaN(na) && !isNaN(nb)) return na - nb;
          if (!isNaN(na)) return -1;
          if (!isNaN(nb)) return 1;
          return a.name.localeCompare(b.name);
        });

        status.nodes = synthNodes;
        status.summary = status.summary || {};
        status.summary.nodesReady = nodesReady;
        status.summary.nodesTotal = synthNodes.length;
        status.summary.healthScore = synthNodes.length > 0 ? Math.round(nodesReady * 100 / synthNodes.length) : 0;
        status.k3sDown = true;
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(status)
      };
    }

    // No data yet, return demo
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        lastUpdate: null,
        message: 'No cluster data received yet. Run push-cluster-status.sh on node1 to push live data.',
        demo: true,
        isDemo: true,
        ...DEMO_DATA
      })
    };
  }

  return {
    statusCode: 405,
    headers,
    body: JSON.stringify({ error: 'Method not allowed' })
  };
};