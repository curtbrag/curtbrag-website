// Netlify Function: Cluster Control API
// Queues commands for the cluster to execute

let commandQueue = [];
let commandHistory = [];

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
      const cmd = commandQueue.shift();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(cmd || {})
      };
    }

    // Dashboard getting queue status
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        pending: commandQueue.length,
        queue: commandQueue,
        history: commandHistory.slice(-10)
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
      commandHistory.push({
        id: body.id,
        result: body.result,
        completedAt: new Date().toISOString()
      });
      // Keep only last 20
      if (commandHistory.length > 20) commandHistory = commandHistory.slice(-20);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true })
      };
    }

    // New command from dashboard
    const { command, target, password } = body;

    // Simple password protection for web commands
    const webPassword = process.env.CLUSTER_WEB_PASSWORD || 'phonecluster';
    if (password !== webPassword) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid password' }) };
    }

    const validCommands = ['start', 'stop', 'restart', 'wake', 'sleep', 'mining-start', 'mining-stop'];
    if (!validCommands.includes(command)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid command' }) };
    }

    const cmdId = Date.now().toString(36);
    const newCmd = {
      id: cmdId,
      command,
      target: target || 'all',
      queuedAt: new Date().toISOString()
    };

    commandQueue.push(newCmd);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: `Command '${command}' queued for ${target || 'all'}`,
        id: cmdId,
        position: commandQueue.length
      })
    };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
