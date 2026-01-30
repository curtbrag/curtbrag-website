// Cluster Status API for K3s Phone Cluster Dashboard
// Receives status updates from cluster and serves to website

// In-memory storage (resets on cold start, but good for demo)
// For production, use Netlify Blobs, FaunaDB, or similar
let clusterStatus = {
  lastUpdate: null,
  nodes: [],
  pods: [],
  services: [],
  network: null,
  summary: {
    nodesReady: 0,
    nodesTotal: 0,
    podsRunning: 0,
    podsTotal: 0
  }
};

// Demo data for when no live data is available
const DEMO_DATA = {
  nodes: [
    { name: 'node1', status: 'Ready', role: 'control-plane', ip: '192.168.1.206' },
    { name: 'node2', status: 'Ready', role: 'worker', ip: '192.168.1.207' },
    { name: 'node3', status: 'Ready', role: 'worker', ip: '192.168.1.208' },
    { name: 'node4', status: 'Ready', role: 'worker', ip: '192.168.1.209' },
    { name: 'node5', status: 'Ready', role: 'worker', ip: '192.168.1.210' },
    { name: 'node6', status: 'Ready', role: 'worker', ip: '192.168.1.211' },
    { name: 'node7', status: 'Ready', role: 'worker', ip: '192.168.1.212' },
    { name: 'node8', status: 'NotReady', role: 'worker', ip: '192.168.1.213' },
    { name: 'node9', status: 'NotReady', role: 'worker', ip: '192.168.1.214' },
    { name: 'node10', status: 'NotReady', role: 'worker', ip: '192.168.1.215' }
  ],
  pods: [
    { name: 'nginx-deployment-7c5b4f9d8-x2k9m', namespace: 'default', status: 'Running', node: 'node2' },
    { name: 'nginx-deployment-7c5b4f9d8-h7n3p', namespace: 'default', status: 'Running', node: 'node3' },
    { name: 'nginx-deployment-7c5b4f9d8-q4w8r', namespace: 'default', status: 'Running', node: 'node4' },
    { name: 'redis-master-0', namespace: 'default', status: 'Running', node: 'node5' },
    { name: 'redis-replica-5d8c7b6f4-m2k8n', namespace: 'default', status: 'Running', node: 'node6' },
    { name: 'redis-replica-5d8c7b6f4-p9x3v', namespace: 'default', status: 'Running', node: 'node7' },
    { name: 'coredns-5dd5756b68-4z7wp', namespace: 'kube-system', status: 'Running', node: 'node1' },
    { name: 'coredns-5dd5756b68-8m2nq', namespace: 'kube-system', status: 'Running', node: 'node2' },
    { name: 'local-path-provisioner-957fdf8bc-v7k2m', namespace: 'kube-system', status: 'Running', node: 'node1' },
    { name: 'metrics-server-648b5df564-x9p3k', namespace: 'kube-system', status: 'Running', node: 'node3' },
    { name: 'traefik-97b44b794-h8m2n', namespace: 'kube-system', status: 'Running', node: 'node4' },
    { name: 'svclb-traefik-2k8m9', namespace: 'kube-system', status: 'Running', node: 'node5' }
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
    wifi: {
      ssid: 'BragdonCluster',
      signal: '-45',
      connected: true
    },
    localIP: '192.168.1.206'
  },
  summary: {
    nodesReady: 7,
    nodesTotal: 10,
    podsRunning: 12,
    podsTotal: 12
  }
};

exports.handler = async function(event, context) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Cluster-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // POST - Update cluster status (from node1 cron job)
  if (event.httpMethod === 'POST') {
    try {
      // Simple API key check (set in Netlify env vars)
      const apiKey = event.headers['x-cluster-key'];
      const expectedKey = process.env.CLUSTER_API_KEY || 'curtbrag-cluster-2024';

      if (apiKey !== expectedKey) {
        return {
          statusCode: 401,
          headers,
          body: JSON.stringify({ error: 'Invalid API key' })
        };
      }

      const data = JSON.parse(event.body);
      clusterStatus = {
        lastUpdate: new Date().toISOString(),
        nodes: data.nodes || [],
        pods: data.pods || [],
        services: data.services || [],
        network: data.network || null,
        summary: data.summary || {
          nodesReady: 0,
          nodesTotal: 0,
          podsRunning: 0,
          podsTotal: 0
        }
      };

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, lastUpdate: clusterStatus.lastUpdate })
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
    // If no data yet, return demo/placeholder data
    if (!clusterStatus.lastUpdate) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          lastUpdate: null,
          message: 'No cluster data received yet. Waiting for first update from node1.',
          demo: true,
          ...DEMO_DATA
        })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(clusterStatus)
    };
  }

  return {
    statusCode: 405,
    headers,
    body: JSON.stringify({ error: 'Method not allowed' })
  };
};
