// Netlify Function: Cluster Control API
// Queues commands for the cluster to execute
// Uses Netlify Blobs for persistence across cold starts

const { getStore, connectLambda } = require("@netlify/blobs");
const crypto = require("crypto");
const { getStore: controlGetStore } = require("@netlify/control-blobs");
const { openControlCommandStore, captureControlContext } = require("./lib/control-command-store.cjs");
const CONTROL_PROVIDER_CONTEXT = Symbol("controlProviderContext");

// Timing-safe string comparison to prevent timing attacks on credentials
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const VALID_NODE_NAMES = ['node1','node2','node3','node4','node5','node6','node7','node8','node9','node10','viki','nexus-prime','steamdeck','skynet'];
const VALID_GROUP_TARGETS = ['all', 'phones', 'pcs'];
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

const LEGACY_COMMAND_TYPES = new Set(["start","stop","restart","wake","sleep","mining-start","mining-stop","mining-status","mining-level","mining-pool","display-mode","browse","update","reboot","ssh","screenshot","brightness","debug","pod-logs"]);
function commandError(statusCode, message) {
  const error = new Error(message); error.statusCode = statusCode; return error;
}
function commandState(event) { return openControlCommandStore({ getStore: controlGetStore, event, providerContext: event[CONTROL_PROVIDER_CONTEXT] }); }
function operationId(prefix, value) {
  return prefix + ":" + crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function callerRequest(body) {
  if (body.request_id === undefined) return null;
  if (typeof body.request_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.request_id))
    throw commandError(400, "Invalid request_id");
  return body.request_id;
}
function legacyInput(command) {
  return {
    command: command.type || command.command, target: command.target,
    url: command.url ?? command.payload?.url ?? null,
    sshCmd: command.sshCmd ?? command.payload?.sshCmd ?? command.payload?.command ?? null,
    displayMode: command.displayMode ?? command.payload?.displayMode ?? command.payload?.mode ?? null,
    miningLevel: command.miningLevel ?? command.payload?.miningLevel ?? command.payload?.level ?? null,
    poolUrl: command.poolUrl ?? command.payload?.poolUrl ?? null,
    namespace: command.namespace ?? command.payload?.namespace ?? null,
    podName: command.podName ?? command.payload?.podName ?? null,
    tail: command.tail ?? command.payload?.tail ?? null,
  };
}
function legacyCommand(command) {
  const createdAt = command.created_at ?? command.queuedAt;
  return { id: command.id, ...legacyInput(command), status: command.status,
    queuedAt: command.queuedAt || new Date(createdAt).toISOString() };
}
function legacyHistory(command) {
  return { ...legacyCommand(command), result: command.result ?? command.result_summary ?? command.status,
    output: command.output || command.stdout || null,
    completedAt: command.completedAt || new Date(command.finished_at).toISOString() };
}
async function getQueue(event) {
  const { queue } = await commandState(event).snapshot();
  return queue.filter(command => command.route === "legacy").map(legacyCommand);
}
async function getHistory(event) {
  const { history } = await commandState(event).snapshot();
  return history.filter(command => command.route === "legacy").map(legacyHistory);
}
async function enqueueLegacy(command, requestId, event) {
  const transaction = await commandState(event).transact(({ queue, history }) => {
    const existing = [...queue, ...history].find(entry => entry.id === command.id);
    if (existing) {
      if (existing.route !== "legacy" || JSON.stringify(legacyInput(existing)) !== JSON.stringify(legacyInput(command)))
        throw commandError(409, "Request ID already belongs to different command settings");
      return { id: existing.id, position: Math.max(0, queue.indexOf(existing) + 1), duplicate: true };
    }
    if (queue.filter(entry => entry.route === "legacy").length >= MAX_QUEUE_SIZE)
      throw commandError(429, "Command queue is full. Try again later.");
    queue.push(command);
    return { id: command.id, position: queue.filter(entry => entry.route === "legacy").length, duplicate: false };
  }, { requestId });
  return transaction.result;
}
async function pollLegacy(event) {
  const startedAt = Date.now();
  const transaction = await commandState(event).transact(({ queue, history }) => {
    for (let index = queue.length - 1; index >= 0; index--) {
      const command = queue[index];
      if (command.route !== "legacy" || command.status !== "queued") continue;
      const createdAt = typeof command.created_at === "number" ? command.created_at : Date.parse(command.queuedAt || command.created_at);
      if (Number.isFinite(createdAt) && startedAt - createdAt > 24 * 60 * 60 * 1000) {
        queue.splice(index, 1);
        history.push({ ...command, status: "failed", finished_at: startedAt,
          result: "expired: command timed out in queue", result_summary: "Legacy command expired before claim" });
      }
    }
    const command = queue.find(entry => entry.route === "legacy" && entry.status === "queued" &&
      LEGACY_COMMAND_TYPES.has(entry.type || entry.command));
    if (!command) return {};
    command.status = "running"; command.claimed_by = "legacy-poller"; command.started_at = startedAt;
    return legacyCommand(command);
  });
  return transaction.result;
}
async function completeLegacy(body, event) {
  if (typeof body.id !== "string" || !body.id || body.id.length > 220 ||
      typeof body.command !== "string" || typeof body.target !== "string" || typeof body.result !== "string")
    throw commandError(400, "id, command, target and result are required");
  const output = String(body.output || "").slice(0, 12000);
  const result = body.result.slice(0, 4000);
  const finishedAt = Date.now();
  const transaction = await commandState(event).transact(({ queue, history }) => {
    const command = queue.find(entry => entry.id === body.id);
    const terminal = history.find(entry => entry.id === body.id);
    const matches = entry => entry && entry.route === "legacy" &&
      (entry.type || entry.command) === body.command && entry.target === body.target &&
      entry.claimed_by === "legacy-poller";
    if (!command) {
      if (matches(terminal) && terminal.result === result && terminal.output === output) return { duplicate: true };
      throw commandError(409, "No legacy claim matches this completion");
    }
    if (!matches(command) || command.status !== "running" || !LEGACY_COMMAND_TYPES.has(command.type || command.command))
      throw commandError(409, "No legacy claim matches this completion");
    queue.splice(queue.indexOf(command), 1);
    history.push({ ...command, status: /^(error|failed|failure|partial)\b/i.test(result) ? "failed" : "completed",
      finished_at: finishedAt, result, result_summary: result, output });
    return { duplicate: false };
  }, { requestId: operationId("legacy-complete", [body.id, body.command, body.target, result, output]) });
  return transaction.result;
}
async function flushLegacy(body, event) {
  const request = callerRequest(body) || crypto.randomBytes(16).toString("hex");
  const finishedAt = Date.now();
  const transaction = await commandState(event).transact(({ queue, history }) => {
    const selected = queue.filter(command => command.route === "legacy");
    for (const command of selected) history.push({ ...command, status: "cancelled", finished_at: finishedAt,
      result: "flushed: manually cleared from queue", result_summary: "Legacy command cancelled by operator" });
    for (let index = queue.length - 1; index >= 0; index--) if (queue[index].route === "legacy") queue.splice(index, 1);
    return { flushed: selected.length };
  }, { requestId: operationId("legacy-flush", request) });
  return transaction.result;
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
  const providerContext = captureControlContext();
  event = { ...event };
  Object.defineProperty(event, CONTROL_PROVIDER_CONTEXT, { value: providerContext });
  connectLambda(event);

  const apiKey = event.headers['x-cluster-key'];

  try {

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

      const command = await pollLegacy(event);
      return { statusCode: 200, headers, body: JSON.stringify(command) };
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
            body: JSON.stringify({ alive: age < 120000, lastPoll: heartbeat.lastPoll, ageSeconds: Math.round(age / 1000) })
          };
        }
      } catch (e) { /* fall through */ }
      return { statusCode: 200, headers, body: JSON.stringify({ alive: false, lastPoll: null }) };
    }

    // Bootstrap script — restarts poller + push loop on node1 without SSH
    // Usage: wget -qO- "https://curtbrag.com/.netlify/functions/cluster-control?action=bootstrap&password=PASS" | sh
    if (params.action === 'bootstrap') {
      const webPassword = await getWebPassword();
      if (webPassword) {
        const attemptedPassword = params.password || '';
        if (!safeCompare(attemptedPassword, webPassword)) {
          return { statusCode: 401, headers: { ...headers, 'Content-Type': 'text/plain' }, body: 'Unauthorized\n' };
        }
      }
      const DEV = 'claude/setup-cluster-advanced-t3WV0';
      const BASE = `https://raw.githubusercontent.com/curtbrag/curtbrag-website/${DEV}/scripts`;
      const script = [
        '#!/bin/sh',
        '# Bootstrap: update scripts, restart poller + push loop',
        '# Works for any user: user@node1, neo@desktop, deck@steamdeck, etc.',
        'DIR="${HOME:-/home/user}"',
        'mkdir -p "$DIR"',
        'if [ -f "$DIR/.cluster-env" ]; then . "$DIR/.cluster-env"; fi',
        'echo "Stopping old processes..."',
        'pkill -f poll-cluster-commands 2>/dev/null || true',
        'pkill -f push-cluster-status 2>/dev/null || true',
        'sleep 1',
        'echo "Downloading latest scripts..."',
        `BASE="${BASE}"`,
        'for s in poll-cluster-commands.sh cluster-nodes.conf push-cluster-status.sh deploy-keys.sh setup-mining-pc.sh update-from-dev.sh; do',
        '  wget -qO "$DIR/$s.new" "$BASE/$s" \\',
        '    && mv "$DIR/$s.new" "$DIR/$s" \\',
        '    && chmod +x "$DIR/$s" 2>/dev/null \\',
        '    && echo "  updated $s" || echo "  FAILED: $s"',
        'done',
        'echo "Starting poller..."',
        'unset CLUSTER_API_KEY',
        'if [ -f "$DIR/.cluster-env" ]; then . "$DIR/.cluster-env"; fi',
        'nohup sh "$DIR/poll-cluster-commands.sh" >> "$DIR/cluster-poll.log" 2>&1 &',
        'echo "Poller PID: $!"',
        'echo "Starting push loop..."',
        'nohup sh -c "while true; do sh \\"$DIR/push-cluster-status.sh\\" >> \\"$DIR/push-status.log\\" 2>&1; sleep 300; done" >> "$DIR/push-status.log" 2>&1 &',
        'echo "Push loop PID: $!"',
        'echo "Bootstrap complete! Check $DIR/cluster-poll.log for poller output."',
        ''
      ].join('\n');
      return { statusCode: 200, headers: { ...headers, 'Content-Type': 'text/plain' }, body: script };
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
      const queue = await getQueue(event);
      const inQueue = queue.some(c => c.id === params.id);
      if (inQueue) {
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'queued' }) };
      }
      const history = await getHistory(event);
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

    // Retrieve API key (authenticated by web password) — for node setup scripts
    // Accepts password via POST body (preferred) or GET query param (legacy)
    if (params.action === 'get-api-key') {
      const webPassword = await getWebPassword();
      if (!webPassword) {
        return { statusCode: 503, headers, body: JSON.stringify({ error: 'Server not configured' }) };
      }
      const attemptedPassword = (body && body.password) || params.password || '';
      if (!safeCompare(attemptedPassword, webPassword)) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid password' }) };
      }
      const key = await getApiKey();
      if (!key) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'API key not configured' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ apiKey: key }) };
    }

    // Dashboard getting queue status
    const queue = await getQueue(event);
    const history = await getHistory(event);
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
      await completeLegacy(body, event);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
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

    // Auth check (for dashboard login validation)
    if (body.action === 'auth-check') {
      const webPassword = await getWebPassword();
      if (!webPassword) {
        return { statusCode: 503, headers, body: JSON.stringify({ error: 'Server not configured' }) };
      }
      if (!safeCompare(body.password || '', webPassword)) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid password' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ authenticated: true }) };
    }

    // Flush stale commands from the queue (dashboard action, requires auth)
    if (body.action === 'flush-queue') {
      const webPassword = await getWebPassword();
      if (!webPassword) {
        return { statusCode: 503, headers, body: JSON.stringify({ error: 'Server not configured' }) };
      }
      if (!safeCompare(body.password || '', webPassword)) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid password' }) };
      }
      const result = await flushLegacy(body, event);
      return { statusCode: 200, headers, body: JSON.stringify({
        flushed: result.flushed,
        message: result.flushed ? "Flushed " + result.flushed + " commands from queue" : "Queue already empty"
      }) };
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
        const rules = [...(sched.rules || [])];
        // Legacy format support: wake/sleep times
        if (sched.wake) rules.push({ time: sched.wake, command: 'wake' });
        if (sched.sleep) rules.push({ time: sched.sleep, command: 'sleep' });

        for (const rule of rules) {
          if (normalizeTime(rule.time) === timeStr) {
            // Include date in key so schedules fire once per day, not once ever
            const key = rule.command + ':' + id + ':' + timeStr + ':' + dateStr;
            if (!lastExec[key]) {
              if (!LEGACY_COMMAND_TYPES.has(rule.command))
                throw commandError(409, "Unsupported legacy schedule command");
              const createdAt = Date.now();
              const commandId = "legacy-schedule-" + crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
              await enqueueLegacy({
                id: commandId, type: rule.command, command: rule.command, target: id,
                route: "legacy", status: "queued", created_at: createdAt,
                queuedAt: new Date(createdAt).toISOString(),
              }, operationId("legacy-schedule", key), event);
              commands.push({ id: commandId, command: rule.command, target: id });
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
        body: JSON.stringify({ commands: [], queued_commands: commands, checkedAt: new Date().toISOString() })
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

    const validCommands = ['start', 'stop', 'restart', 'wake', 'sleep', 'mining-start', 'mining-stop', 'mining-status', 'mining-level', 'mining-pool', 'display-mode', 'browse', 'update', 'reboot', 'ssh', 'screenshot', 'brightness', 'debug', 'pod-logs'];
    if (!validCommands.includes(command)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid command' }) };
    }

    // Validate target node name
    if (target && !VALID_GROUP_TARGETS.includes(target) && !VALID_NODE_NAMES.includes(target)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid target node' }) };
    }

    // Validate URL for browse command
    if (command === 'browse') {
      if (!body.url) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'URL required for browse command' }) };
      }
      if (!/^https?:\/\//i.test(body.url)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'URL must start with http:// or https://' }) };
      }
    }

    // Validate display-mode command
    if (command === 'display-mode') {
      const validModes = ['matrix', 'stats', 'bonsai', 'cycle', 'off'];
      if (!body.displayMode || !validModes.includes(body.displayMode)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'displayMode required, must be one of: ' + validModes.join(', ') }) };
      }
    }

    // Validate mining-level command
    if (command === 'mining-level') {
      const level = parseInt(body.miningLevel);
      if (isNaN(level) || level < 0 || level > 4) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'miningLevel required, must be 0-4' }) };
      }
    }

    // Validate brightness command
    if (command === 'brightness') {
      if (!body.sshCmd || isNaN(parseInt(body.sshCmd))) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Brightness value (0-255) required' }) };
      }
    }

    // Validate mining-pool command
    if (command === 'mining-pool') {
      if (!body.poolUrl || typeof body.poolUrl !== 'string') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'poolUrl required' }) };
      }
      // Allow host:port or stratum+tcp://host:port
      if (!/^[a-zA-Z0-9._-]+:\d+$/.test(body.poolUrl) && !/^stratum\+tcp:\/\//i.test(body.poolUrl)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'poolUrl must be host:port format' }) };
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
      const tailLines = parseInt(body.tail);
      if (body.tail != null && (isNaN(tailLines) || tailLines < 1 || tailLines > 9999)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'tail must be a number between 1 and 9999' }) };
      }
    }

    // Validate and sanitize SSH command
    if (command === 'ssh') {
      if (!body.sshCmd) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'SSH command required' }) };
      }
      // Block shell metacharacters that enable injection (subshells, redirects, pipes, etc.)
      // Backslash is allowed for sed/grep patterns; * allowed for glob-free contexts
      if (/[;|&$`><\{\}\(\)!~\[\]?]|\$\(/.test(body.sshCmd)) {
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

    const request = callerRequest(body);
    const cmdId = request ? "legacy-" + crypto.createHash("sha256").update(request).digest("hex").slice(0, 32)
      : crypto.randomBytes(8).toString("hex");
    const now = Date.now();
    const newCmd = {
      id: cmdId, type: command, command, target: target || 'all', route: "legacy", status: "queued",
      url: body.url || null, sshCmd: body.sshCmd || null, displayMode: body.displayMode || null,
      miningLevel: body.miningLevel != null ? parseInt(body.miningLevel) : null,
      poolUrl: body.poolUrl || null, namespace: body.namespace || null, podName: body.podName || null,
      tail: body.tail != null ? parseInt(body.tail) : null,
      created_at: now, queuedAt: new Date(now).toISOString(),
    };
    const queued = await enqueueLegacy(newCmd, operationId("legacy-enqueue", [request || cmdId, legacyInput(newCmd)]), event);
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        success: true, message: "Command '" + command + "' queued for " + (target || 'all'),
        id: queued.id, position: queued.position
      })
    };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (error) {
    return { statusCode: error.statusCode || 503, headers, body: JSON.stringify({ error: error.message || 'Command service unavailable' }) };
  }
};
