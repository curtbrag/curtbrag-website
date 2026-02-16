// Netlify Function: Cluster Control API
// Queues commands for the cluster to execute
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

const VALID_NODE_NAMES = ['node1','node2','node3','node4','node5','node6','node7','node8','node9','node10'];
const MAX_QUEUE_SIZE = 100;

// Credential helpers — check env var first, fall back to Netlify Blobs
async function getWebPassword() {
  const env = process.env.CLUSTER_WEB_PASSWORD;
  if (env) return env;
  try {
    const store = getStore("cluster-config");
    return await store.get("web-password", { type: "text" }) || null;
  } catch { return null; }
}

async function getApiKey() {
  const env = process.env.CLUSTER_API_KEY;
  if (env) return env;
  try {
    const store = getStore("cluster-config");
    return await store.get("api-key", { type: "text" }) || null;
  } catch { return null; }
}

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

// Screenshot blob helpers
async function saveScreenshot(nodeName, imageData, timestamp) {
  try {
    const store = getStore("cluster-screenshots");
    await store.setJSON("screen-" + nodeName, { image: imageData, timestamp, status: 'ok' });
    const index = await store.get("screen-index", { type: "json" }) || {};
    index[nodeName] = { timestamp, status: 'ok' };
    await store.setJSON("screen-index", index);
  } catch (e) {
    console.warn("Failed to save screenshot for " + nodeName + ":", e.message);
  }
}

async function getScreenshot(nodeName) {
  try {
    const store = getStore("cluster-screenshots");
    return await store.get("screen-" + nodeName, { type: "json" });
  } catch (e) { return null; }
}

async function getScreenIndex() {
  try {
    const store = getStore("cluster-screenshots");
    return await store.get("screen-index", { type: "json" }) || {};
  } catch (e) { return {}; }
}

const ALLOWED_ORIGINS = ['https://www.curtbrag.com', 'https://curtbrag.com'];

function getCorsOrigin(event) {
  const origin = (event.headers || {}).origin || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

function normalizeTime(t) {
  const parts = String(t).split(':');
  return parts[0].padStart(2, '0') + ':' + (parts[1] || '00').padStart(2, '0');
}

exports.handler = async (event) => {
  const corsOrigin = getCorsOrigin(event);
  const headers = {
    'Access-Control-Allow-Headers': 'Content-Type, X-Cluster-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (corsOrigin) headers['Access-Control-Allow-Origin'] = corsOrigin;

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Initialize Netlify Blobs for Lambda compatibility mode
  connectLambda(event);

  const apiKey = event.headers['x-cluster-key'];

  // GET - Poll for commands (from node1) or get status (from dashboard)
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};

    // Node polling for commands
    if (params.action === 'poll') {
      const validKey = await getApiKey();
      if (!validKey || !safeCompare(apiKey || '', validKey)) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
      }
      // Record heartbeat so dashboard knows poller is alive
      try {
        const store = getStore("cluster-control");
        await store.setJSON("poller-heartbeat", { lastPoll: new Date().toISOString() });
      } catch (e) { /* best-effort */ }

      const queue = await getQueue();
      // Auto-expire commands older than 10 minutes
      const now = Date.now();
      const expiredIds = [];
      const liveQueue = queue.filter(c => {
        const age = now - new Date(c.queuedAt).getTime();
        if (age > 10 * 60 * 1000) { expiredIds.push(c.id); return false; }
        return true;
      });
      // Move expired commands to history
      if (expiredIds.length > 0) {
        const history = await getHistory();
        for (const c of queue) {
          if (expiredIds.includes(c.id)) {
            history.push({ id: c.id, command: c.command, target: c.target, result: 'expired: command timed out in queue', completedAt: new Date().toISOString() });
          }
        }
        await saveHistory(history);
      }
      const cmd = liveQueue.shift();
      await saveQueue(liveQueue);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(cmd || {})
      };
    }

    // Poller heartbeat check (for dashboard)
    if (params.action === 'poller-status') {
      try {
        const store = getStore("cluster-control");
        const heartbeat = await store.get("poller-heartbeat", { type: "json" });
        if (heartbeat && heartbeat.lastPoll) {
          const age = Date.now() - new Date(heartbeat.lastPoll).getTime();
          return {
            statusCode: 200, headers,
            body: JSON.stringify({ alive: age < 30000, lastPoll: heartbeat.lastPoll, ageSeconds: Math.round(age / 1000) })
          };
        }
      } catch (e) { /* fall through */ }
      return { statusCode: 200, headers, body: JSON.stringify({ alive: false, lastPoll: null }) };
    }

    // Flush stale commands from the queue (dashboard action)
    if (params.action === 'flush-queue') {
      const queue = await getQueue();
      if (queue.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ flushed: 0, message: 'Queue already empty' }) };
      }
      const history = await getHistory();
      for (const c of queue) {
        history.push({ id: c.id, command: c.command, target: c.target, result: 'flushed: manually cleared from queue', completedAt: new Date().toISOString() });
      }
      await saveHistory(history);
      await saveQueue([]);
      return { statusCode: 200, headers, body: JSON.stringify({ flushed: queue.length, message: `Flushed ${queue.length} commands from queue` }) };
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

    // Command status check by ID (for dashboard polling)
    if (params.action === 'command-status' && params.id) {
      const queue = await getQueue();
      const inQueue = queue.some(c => c.id === params.id);
      if (inQueue) {
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'queued' }) };
      }
      const history = await getHistory();
      const entry = history.find(h => h.id === params.id);
      if (entry) {
        return {
          statusCode: 200, headers,
          body: JSON.stringify({ status: 'completed', result: entry.result, output: entry.output || null, completedAt: entry.completedAt })
        };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'executing' }) };
    }

    // Screenshot index (metadata only)
    if (params.action === 'screenshot-index') {
      const index = await getScreenIndex();
      return { statusCode: 200, headers, body: JSON.stringify({ screens: index }) };
    }

    // Single node screenshot
    if (params.action === 'screenshot' && params.node) {
      const screenshot = await getScreenshot(params.node);
      return {
        statusCode: 200, headers,
        body: JSON.stringify(screenshot || { status: 'not-found', node: params.node })
      };
    }

    // All screenshots (parallelized for performance)
    if (params.action === 'screenshots') {
      const index = await getScreenIndex();
      const screens = await Promise.all(VALID_NODE_NAMES.map(async (n) => {
        if (index[n]) {
          const data = await getScreenshot(n);
          return { device: n, ...(data || { status: 'offline', image: null }) };
        }
        return { device: n, status: 'never-captured', image: null };
      }));
      return { statusCode: 200, headers, body: JSON.stringify({ screens }) };
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
      const validKey = await getApiKey();
      if (!validKey || !safeCompare(apiKey || '', validKey)) {
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

    // Screenshot upload from node1
    if (body.action === 'screenshot-upload') {
      const validKey = await getApiKey();
      if (!validKey || !safeCompare(apiKey || '', validKey)) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
      }
      if (!body.node || !body.image) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing node or image' }) };
      }
      // Validate node name against allowlist to prevent blob key injection
      if (!VALID_NODE_NAMES.includes(body.node)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid node name' }) };
      }
      if (body.image.length > 2 * 1024 * 1024) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Image too large (max 2MB)' }) };
      }
      await saveScreenshot(body.node, body.image, body.timestamp || new Date().toISOString());
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, node: body.node }) };
    }

    // Save schedules from dashboard
    if (body.action === 'save-schedules') {
      const webPassword = await getWebPassword();
      if (!webPassword) {
        return { statusCode: 503, headers, body: JSON.stringify({ error: 'Server not configured' }) };
      }
      if (!safeCompare(body.password || '', webPassword)) {
        console.warn(`[AUTH] Failed schedule auth attempt`);
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid password' }) };
      }
      await saveSchedules(body.schedules || {});
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, message: 'Schedules saved' })
      };
    }

    // One-time credential setup — only works when credentials are missing
    if (body.action === 'setup-credentials') {
      const existingPassword = await getWebPassword();
      const existingKey = await getApiKey();
      const store = getStore("cluster-config");
      let set = [];
      if (!existingPassword && body.webPassword) {
        await store.set("web-password", body.webPassword);
        set.push('webPassword');
      }
      if (!existingKey && body.apiKey) {
        await store.set("api-key", body.apiKey);
        set.push('apiKey');
      }
      if (set.length === 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Credentials already configured or no values provided' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, configured: set }) };
    }

    // Schedule check from poll script
    if (body.action === 'check-schedule') {
      const validKey = await getApiKey();
      if (!validKey || !safeCompare(apiKey || '', validKey)) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
      }
      const schedules = await getSchedules();
      const now = new Date();
      const timeStr = normalizeTime(body.localTime || now.toISOString().slice(11, 16));
      const dateStr = body.localDate || now.toISOString().slice(0, 10);
      let lastExec = await getScheduleExec();
      const commands = [];

      // Clear stale entries from previous days to prevent unbounded growth
      const staleKeys = Object.keys(lastExec).filter(k => !k.endsWith(':' + dateStr));
      if (staleKeys.length > 0) {
        for (const k of staleKeys) delete lastExec[k];
      }

      for (const [id, sched] of Object.entries(schedules)) {
        if (!sched.enabled) continue;
        const rules = sched.rules || [];
        // Legacy format support: wake/sleep times
        if (sched.wake) rules.push({ time: sched.wake, command: 'wake' });
        if (sched.sleep) rules.push({ time: sched.sleep, command: 'sleep' });

        for (const rule of rules) {
          if (normalizeTime(rule.time) === timeStr) {
            // Include date in key so schedules fire once per day, not once ever
            const key = rule.command + ':' + id + ':' + timeStr + ':' + dateStr;
            if (!lastExec[key]) {
              commands.push({ command: rule.command, target: id });
              lastExec[key] = true;
            }
          }
        }
      }

      if (commands.length > 0 || staleKeys.length > 0) {
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
    const webPassword = await getWebPassword();
    if (!webPassword) {
      return { statusCode: 503, headers, body: JSON.stringify({ error: 'Server not configured' }) };
    }
    if (!safeCompare(password || '', webPassword)) {
      console.warn(`[AUTH] Failed command auth attempt for command=${command}`);
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid password' }) };
    }

    const validCommands = ['start', 'stop', 'restart', 'wake', 'sleep', 'mining-start', 'mining-stop', 'browse', 'update', 'reboot', 'ssh', 'screenshot', 'brightness', 'debug', 'pod-logs'];
    if (!validCommands.includes(command)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid command' }) };
    }

    // Validate target node name
    if (target && target !== 'all' && !VALID_NODE_NAMES.includes(target)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid target node' }) };
    }

    // Validate URL for browse command
    if (command === 'browse' && !body.url) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'URL required for browse command' }) };
    }

    // Validate brightness command
    if (command === 'brightness') {
      if (!body.sshCmd || isNaN(parseInt(body.sshCmd))) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Brightness value (0-255) required' }) };
      }
    }

    // Validate pod-logs command
    if (command === 'pod-logs') {
      if (!body.namespace || !body.podName) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'namespace and podName required for pod-logs' }) };
      }
      if (!/^[a-zA-Z0-9._-]+$/.test(body.namespace) || !/^[a-zA-Z0-9._-]+$/.test(body.podName)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid namespace or pod name' }) };
      }
    }

    // Validate and sanitize SSH command
    if (command === 'ssh') {
      if (!body.sshCmd) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'SSH command required' }) };
      }
      // Block shell metacharacters that enable injection (includes globs, subshells, redirects)
      if (/[;|&$`\\><\{\}\(\)!~\[\]*?]|\$\(/.test(body.sshCmd)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Command contains disallowed shell characters' }) };
      }
      // Enforce max length
      if (body.sshCmd.length > 200) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Command too long (max 200 characters)' }) };
      }
      // Block dangerous commands
      const dangerousPatterns = [/\brm\s+(-[a-z]*\s+)*\//, /\bmkfs\b/, /\bdd\s+if=/, /:\(\)\{/, /\/dev\/sd/, /\bshutdown\b/, /\bhalt\b/, /\bpoweroff\b/, /\bfind\b.*-delete/, /\bkill\s+-9\s+1\b/, /\binit\s+0\b/, /\bcurl\b.*\|\s*\bsh\b/, /\bwget\b.*\|\s*\bsh\b/];
      const lowerCmd = body.sshCmd.toLowerCase();
      if (dangerousPatterns.some(p => p.test(lowerCmd))) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Command blocked for safety' }) };
      }
    }

    const cmdId = crypto.randomBytes(8).toString('hex');
    const newCmd = {
      id: cmdId,
      command,
      target: target || 'all',
      url: body.url || null,
      sshCmd: body.sshCmd || null,
      namespace: body.namespace || null,
      podName: body.podName || null,
      tail: body.tail || null,
      queuedAt: new Date().toISOString()
    };

    const queue = await getQueue();
    if (queue.length >= MAX_QUEUE_SIZE) {
      return { statusCode: 429, headers, body: JSON.stringify({ error: 'Command queue is full. Try again later.' }) };
    }
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
