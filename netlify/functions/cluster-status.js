// Cluster Status API for K3s Phone Cluster Dashboard
// Receives status updates from cluster and serves to website

// In-memory storage (resets on cold start, but good for demo)
// For production, use Netlify Blobs, FaunaDB, or similar
let clusterStatus = {
  lastUpdate: null,
  nodes: [],
  pods: [],
  services: [],
  summary: {
    nodesReady: 0,
    nodesTotal: 0,
    podsRunning: 0,
    podsTotal: 0
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
          summary: {
            nodesReady: 7,
            nodesTotal: 10,
            podsRunning: 10,
            podsTotal: 12
          }
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
