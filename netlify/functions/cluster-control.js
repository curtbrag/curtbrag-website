// Netlify Function: Cluster Control API
// Queues commands for the cluster to execute
// Uses Netlify Blobs for persistence across cold starts

const { getStore, connectLambda } = require("@netlify/blobs");

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
    // Keep only last 50
    const trimmed = history.slice(-50);
    await store.setJSON("history", trimmed);
  } catch (e) {
    console.warn("Failed to save history:", e.message);
  }
}

async function getSchedules() {
  try {
    const store = getStore("cluster-control");
    const data = await store.get("schedules", { type: "json" });
    return data || {};
  } catch (e) {
    console.warn("Failed to read schedules:", e.message);
    return {};
  }
}

async function saveSchedules(schedules) {
  try {
    const store = getStore("cluster-control");
    await store.setJSON("schedules", schedules);
  } catch (e) {
    console.warn("Failed to save schedules:", e.message);
  }
}

async function getScheduleExec() {
  try {
    const store = getStore("cluster-control");
    const data = await store.get("schedule-last-exec", { type: "json" });
    return data || {};
  } catch (e) { return {}; }
}

async function saveScheduleExec(data) {
  try {
    const store = getStore("cluster-control");
    await store.setJSON("schedule-last-exec", data);
  } catch (e) { /* silent */ }
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

  // Initialize Netlify Blobs for Lambda compatibility mode
  connectLambda(event);

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

    // Schedule retrieval
    if (params.action === 'schedules') {
      const schedules = await getSchedules();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ schedules })
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
        command: body.command || null,
        target: body.target || null,
        result: body.result,
        output: body.output || null,
        completedAt: new Date().toISOString()
      });
      await saveHistory(history);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true })
      };
    }

    // Save schedules from dashboard
    if (body.action === 'save-schedules') {
      const webPassword = process.env.CLUSTER_WEB_PASSWORD || '0735';
      if (body.password !== webPassword) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid password' }) };
      }
      await saveSchedules(body.schedules || {});
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, message: 'Schedules saved' })
      };
    }

    // Schedule check from poll script
    if (body.action === 'check-schedule') {
      if (apiKey !== validKey) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
      }
      const schedules = await getSchedules();
      const timeStr = body.localTime || new Date().toISOString().slice(11, 16);
      const lastExec = await getScheduleExec();
      const commands = [];

      for (const [id, sched] of Object.entries(schedules)) {
        if (!sched.enabled) continue;
        const rules = sched.rules || [];
        // Legacy format support: wake/sleep times
        if (sched.wake) rules.push({ time: sched.wake, command: 'wake' });
        if (sched.sleep) rules.push({ time: sched.sleep, command: 'sleep' });

        for (const rule of rules) {
          if (rule.time === timeStr) {
            const key = rule.command + ':' + id + ':' + timeStr;
            if (!lastExec[key]) {
              commands.push({ command: rule.command, target: id });
              lastExec[key] = true;
            }
          }
        }
      }

      if (commands.length > 0) {
        await saveScheduleExec(lastExec);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ commands, checkedAt: new Date().toISOString() })
      };
    }

    // New command from dashboard
    const { command, target, password } = body;

    // Simple password protection for web commands
    const webPassword = process.env.CLUSTER_WEB_PASSWORD || '0735';
    if (password !== webPassword) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid password' }) };
    }

    const validCommands = ['start', 'stop', 'restart', 'wake', 'sleep', 'mining-start', 'mining-stop', 'browse', 'update', 'reboot', 'ssh'];
    if (!validCommands.includes(command)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid command' }) };
    }

    // Validate URL for browse command
    if (command === 'browse' && !body.url) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'URL required for browse command' }) };
    }

    // Validate and sanitize SSH command
    if (command === 'ssh') {
      if (!body.sshCmd) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'SSH command required' }) };
      }
      const dangerous = ['rm -rf /', 'mkfs', 'dd if=', ':(){', '> /dev/sd'];
      const lowerCmd = body.sshCmd.toLowerCase();
      if (dangerous.some(d => lowerCmd.includes(d))) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Command blocked for safety' }) };
      }
    }

    const cmdId = Date.now().toString(36);
    const newCmd = {
      id: cmdId,
      command,
      target: target || 'all',
      url: body.url || null,
      sshCmd: body.sshCmd || null,
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
