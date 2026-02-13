// Netlify Function: Cluster Control API
// Queues commands for the cluster to execute
// Uses Netlify Blobs for persistence across cold starts

const { getStore } = require("@netlify/blobs");

async function getQueue() {
  try {
    const store = getStore("cluster-control");
    const data = await store.get("queue", { type: "json" });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn("Failed to read queue:", e.message);
    return [];
  }
}

async function saveQueue(queue) {
  try {
    const store = getStore("cluster-control");
    await store.setJSON("queue", queue);
  } catch (e) {
    console.warn("Failed to save queue:", e.message);
  }
}

async function getHistory() {
  try {
    const store = getStore("cluster-control");
    const data = await store.get("history", { type: "json" });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn("Failed to read history:", e.message);
    return [];
  }
}

async function saveHistory(history) {
  try {
    const store = getStore("cluster-control");
    // Keep only last 20
    const trimmed = history.slice(-20);
    await store.setJSON("history", trimmed);
  } catch (e) {
    console.warn("Failed to save history:", e.message);
  }
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Cluster-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const apiKey = event.headers['x-cluster-key'];
  const validKey = process.env.CLUSTER_API_KEY || 'curtbrag-cluster-2024';

  // GET - Poll for commands (from node1) or get status (from dashboard)
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};

    // Node polling for commands
    if (params.action === 'poll') {
      if (apiKey !== validKey) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
      }
      const queue = await getQueue();
      const cmd = queue.shift();
      if (cmd) {
        await saveQueue(queue);
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(cmd || {})
      };
    }

    // Dashboard getting queue status
    const queue = await getQueue();
    const history = await getHistory();
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        pending: queue.length,
        queue: queue,
        history: history.slice(-10)
      })
    };
  }

  // POST - Queue a command (from dashboard) or report completion (from node1)
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    // Command completion report from node1
    if (body.action === 'complete') {
      if (apiKey !== validKey) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
      }
      const history = await getHistory();
      history.push({
        id: body.id,
        result: body.result,
        completedAt: new Date().toISOString()
      });
      await saveHistory(history);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true })
      };
    }

    // New command from dashboard
    const { command, target, password } = body;

    // Simple password protection for web commands
    const webPassword = process.env.CLUSTER_WEB_PASSWORD || '0735';
    if (password !== webPassword) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid password' }) };
    }

    const validCommands = ['start', 'stop', 'restart', 'wake', 'sleep', 'mining-start', 'mining-stop', 'browse'];
    if (!validCommands.includes(command)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid command' }) };
    }

    // Validate URL for browse command
    if (command === 'browse' && !body.url) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'URL required for browse command' }) };
    }

    const cmdId = Date.now().toString(36);
    const newCmd = {
      id: cmdId,
      command,
      target: target || 'all',
      url: body.url || null,
      queuedAt: new Date().toISOString()
    };

    const queue = await getQueue();
    queue.push(newCmd);
    await saveQueue(queue);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: `Command '${command}' queued for ${target || 'all'}`,
        id: cmdId,
        position: queue.length
      })
    };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
