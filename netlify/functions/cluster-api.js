// Netlify Function: Operator-facing Control Plane API
// Handles: device registry, desired state, config profiles, binary registry,
//          command queue, alerts, fleet summary, event logs
//
// All operator endpoints require Authorization: Bearer <web-password> header.

const { connectLambda, getStore } = require("@netlify/blobs");
const crypto = require("crypto");


function openStore(name) {
  const siteID =
    process.env.NETLIFY_BLOBS_SITE_ID ||
    process.env.SITE_ID ||
    undefined;

  const token =
    process.env.NETLIFY_BLOBS_TOKEN ||
    process.env.NETLIFY_ACCESS_TOKEN ||
    process.env.NETLIFY_TOKEN ||
    undefined;

  if (siteID && token) {
    return getStore(name, { siteID, token });
  }

  return getStore(name);
}
// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function genId() {
  return crypto.randomBytes(16).toString("hex");
}

function corsHeaders(origin) {
  const allowed = ["https://curtbrag.com", "https://www.curtbrag.com"];
  const o = allowed.includes(origin) ? origin : "https://curtbrag.com";
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

function json(statusCode, headers, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

// ─── Credentials ─────────────────────────────────────────────────────────────

async function getWebPassword() {
  const env = process.env.CLUSTER_WEB_PASSWORD;
  if (env) return env;
  try {
    return (
      (await openStore("cluster-config").get("web-password", {
        type: "text",
      })) || null
    );
  } catch {
    return null;
  }
}

async function getApiKey() {
  const env = process.env.CLUSTER_API_KEY;
  if (env) return env;
  try {
    return (
      (await openStore("cluster-config").get("api-key", { type: "text" })) ||
      null
    );
  } catch {
    return null;
  }
}

async function authOperator(headers) {
  const auth =
    headers["authorization"] || headers["Authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  if (!token) return false;
  const pw = await getWebPassword();
  return pw ? safeCompare(token, pw) : false;
}

// ─── Device helpers ───────────────────────────────────────────────────────────

async function getAllDevices() {
  try {
    const store = openStore("cp-devices");
    const list = await store.list();
    const devices = [];
    for (const entry of list.blobs) {
      const d = await store.get(entry.key, { type: "json" });
      if (d) devices.push(d);
    }
    return devices;
  } catch {
    return [];
  }
}

async function getDevice(deviceId) {
  try {
    return await openStore("cp-devices").get(deviceId, { type: "json" });
  } catch {
    return null;
  }
}

async function saveDevice(deviceId, device) {
  try {
    await openStore("cp-devices").setJSON(deviceId, device);
  } catch (e) {
    console.warn("saveDevice:", e.message);
  }
}

async function getDesiredState(deviceId) {
  try {
    return await openStore("cp-desired").get(deviceId, { type: "json" });
  } catch {
    return null;
  }
}

async function saveDesiredState(deviceId, state) {
  try {
    await openStore("cp-desired").setJSON(deviceId, {
      ...state,
      updated_at: Date.now(),
    });
  } catch (e) {
    console.warn("saveDesiredState:", e.message);
  }
}

async function getObservedState(deviceId) {
  try {
    return await openStore("cp-observed").get(deviceId, { type: "json" });
  } catch {
    return null;
  }
}

// ─── Command queue ────────────────────────────────────────────────────────────

async function getQueue() {
  try {
    return (await openStore("cp-commands").get("queue", { type: "json" })) || [];
  } catch {
    return [];
  }
}

async function getCommandHistory() {
  try {
    return (
      (await openStore("cp-commands").get("history", { type: "json" })) || []
    );
  } catch {
    return [];
  }
}

async function enqueueCommand(cmd) {
  try {
    // Write to new cp-commands store (for new node agents)
    const store = openStore("cp-commands");
    const queue = (await store.get("queue", { type: "json" })) || [];
    if (queue.length >= 200) queue.shift();
    queue.push(cmd);
    await store.setJSON("queue", queue);

    // Dual-write to legacy cluster-control queue so existing poll scripts
    // keep receiving commands during the transition to new agents
    try {
      const legacyStore = openStore("cluster-control");
      const legacyQueue =
        (await legacyStore.get("queue", { type: "json" })) || [];
      if (legacyQueue.length < 100) {
        // Map new command schema to old schema that poll-cluster-commands.sh expects
        const legacyCmd = {
          id: cmd.id,
          target: cmd.target,
          command: cmd.type,
          payload: cmd.payload || {},
          status: "queued",
          created_at: cmd.created_at,
        };
        legacyQueue.push(legacyCmd);
        await legacyStore.setJSON("queue", legacyQueue);
      }
    } catch (_) {
      // Legacy dual-write is best-effort; don't fail the whole enqueue
    }

    return true;
  } catch (e) {
    console.warn("enqueueCommand:", e.message);
    return false;
  }
}

async function flushQueue() {
  try {
    await openStore("cp-commands").setJSON("queue", []);
  } catch {}
}

// ─── Profiles ─────────────────────────────────────────────────────────────────

const DEFAULT_PROFILES = {
  "phone-mining": {
    id: "phone-mining",
    name: "Phone Mining (Proven)",
    description: "6-thread profile proven on node1 @ ~525 H/s. Local Nexus pool. 60°C limit.",
    device_class: "phone",
    config: {
      pools: [{ url: "192.168.1.179:10128", user: "44Ris5ep9FE6hmwAbi7CtAV5NexMuZixhKeGk8xDFHNYWi57TjsMXEyEFQyVWNQxLkaPY1xVPjoTY2yaTfkTzkCMRur3PwT", pass: "x", tls: false }],
      cpu: { enabled: true, "huge-pages": false, priority: 2, threads: 6 },
      randomx: { mode: "light" },
      "log-file": "~/cluster/logs/xmrig.log",
      "print-time": 60,
    },
    thread_count: 6,
    max_temp: 60,
    pause_on_battery: true,
    pause_on_high_temp: true,
    huge_pages: false,
    randomx_mode: "light",
    preflight_required: true,
    created_at: Date.now(),
    built_in: true,
  },
  "phone-default": {
    id: "phone-default",
    name: "Phone Default",
    description: "Conservative mining profile for OnePlus 6T phones",
    device_class: "phone",
    config: {
      pools: [
        {
          url: "192.168.1.179:10128",
          user: "44Ris5ep9FE6hmwAbi7CtAV5NexMuZixhKeGk8xDFHNYWi57TjsMXEyEFQyVWNQxLkaPY1xVPjoTY2yaTfkTzkCMRur3PwT",
          pass: "node-default",
          tls: false,
        },
      ],
      cpu: { enabled: true, "huge-pages": false, hw_aes: null, priority: 2, "memory-pool": false },
      randomx: { mode: "light", "1gb-pages": false, rdmsr: false, wrmsr: false },
      "log-file": "~/cluster/logs/xmrig.log",
      "print-time": 60,
      "health-print-time": 60,
    },
    thread_count: null,
    max_temp: 70,
    pause_on_battery: false,
    pause_on_high_temp: true,
    huge_pages: false,
    randomx_mode: "light",
    created_at: Date.now(),
    built_in: true,
  },
  "phone-cool": {
    id: "phone-cool",
    name: "Phone Cool",
    description: "Reduced-intensity profile for thermal management",
    device_class: "phone",
    config: {
      pools: [
        {
          url: "192.168.1.179:10128",
          user: "44Ris5ep9FE6hmwAbi7CtAV5NexMuZixhKeGk8xDFHNYWi57TjsMXEyEFQyVWNQxLkaPY1xVPjoTY2yaTfkTzkCMRur3PwT",
          pass: "node-cool",
          tls: false,
        },
      ],
      cpu: { enabled: true, "huge-pages": false, priority: 1, "memory-pool": false },
      randomx: { mode: "light" },
      "log-file": "~/cluster/logs/xmrig.log",
    },
    thread_count: 3,
    max_temp: 60,
    pause_on_battery: true,
    pause_on_high_temp: true,
    huge_pages: false,
    randomx_mode: "light",
    created_at: Date.now(),
    built_in: true,
  },
  "steamdeck-default": {
    id: "steamdeck-default",
    name: "Steam Deck Default",
    description: "Balanced profile for Steam Deck",
    device_class: "steamdeck",
    config: {
      pools: [
        {
          url: "192.168.1.179:10128",
          user: "44Ris5ep9FE6hmwAbi7CtAV5NexMuZixhKeGk8xDFHNYWi57TjsMXEyEFQyVWNQxLkaPY1xVPjoTY2yaTfkTzkCMRur3PwT",
          pass: "steamdeck",
          tls: true,
        },
      ],
      cpu: { enabled: true, "huge-pages": true, priority: 2, "max-threads-hint": 75 },
      randomx: { mode: "auto" },
      "log-file": "~/cluster/logs/xmrig.log",
    },
    thread_count: null,
    max_temp: 80,
    pause_on_battery: false,
    pause_on_high_temp: true,
    huge_pages: true,
    randomx_mode: "auto",
    created_at: Date.now(),
    built_in: true,
  },
  "controller-do-not-mine": {
    id: "controller-do-not-mine",
    name: "Controller (No Mining)",
    description: "Profile for control-plane node — mining disabled",
    device_class: "any",
    config: null,
    miner_enabled: false,
    created_at: Date.now(),
    built_in: true,
  },
};

async function getProfiles() {
  try {
    const store = openStore("cp-profiles");
    const list = await store.list();
    const profiles = { ...DEFAULT_PROFILES };
    for (const entry of list.blobs) {
      const p = await store.get(entry.key, { type: "json" });
      if (p && p.id) profiles[p.id] = p;
    }
    return profiles;
  } catch {
    return { ...DEFAULT_PROFILES };
  }
}

async function getProfile(profileId) {
  if (DEFAULT_PROFILES[profileId]) return DEFAULT_PROFILES[profileId];
  try {
    return await openStore("cp-profiles").get(profileId, { type: "json" });
  } catch {
    return null;
  }
}

async function saveProfile(profileId, profile) {
  try {
    await openStore("cp-profiles").setJSON(profileId, profile);
  } catch (e) {
    console.warn("saveProfile:", e.message);
  }
}

// ─── Binary registry ──────────────────────────────────────────────────────────

async function getBinaryRegistry() {
  try {
    return (
      (await openStore("cp-binaries").get("registry", { type: "json" })) || []
    );
  } catch {
    return [];
  }
}

async function saveBinaryRegistry(registry) {
  try {
    await openStore("cp-binaries").setJSON("registry", registry);
  } catch {}
}

// ─── Alerts ───────────────────────────────────────────────────────────────────

async function getAlerts() {
  try {
    return (
      (await openStore("cp-alerts").get("active", { type: "json" })) || []
    );
  } catch {
    return [];
  }
}

async function saveAlerts(alerts) {
  try {
    await openStore("cp-alerts").setJSON("active", alerts);
  } catch {}
}

// ─── Events ───────────────────────────────────────────────────────────────────

async function getEvents(deviceId) {
  try {
    const key = deviceId || "all";
    return (await openStore("cp-events").get(key, { type: "json" })) || [];
  } catch {
    return [];
  }
}

// ─── Fleet summary ────────────────────────────────────────────────────────────

async function buildSummary(devices, observedMap) {
  let online = 0,
    mining = 0,
    degraded = 0,
    quarantined = 0,
    rogueDetected = 0,
    totalHashrate = 0,
    hottest = null,
    hottestTemp = 0,
    wifiNodes = 0,
    unreachable = 0,
    acceptedToday = 0;

  const now = Date.now();
  for (const d of devices) {
    const obs = observedMap[d.id] || {};
    const age = now - (d.last_seen_at || 0);
    const isOnline = age < 5 * 60 * 1000; // 5 min

    if (d.quarantined) {
      quarantined++;
    } else if (!isOnline) {
      unreachable++;
    } else {
      online++;
      if (obs.xmrig_running) mining++;
      if (obs.rogue_pid) rogueDetected++;
      if (obs.interface_type === "wifi") wifiNodes++;

      const hr = parseFloat(obs.hashrate_60s || obs.hashrate_10s || 0);
      totalHashrate += isNaN(hr) ? 0 : hr;

      const temp = parseFloat(obs.temp_peak || 0);
      if (temp > hottestTemp) {
        hottestTemp = temp;
        hottest = d.hostname;
      }

      if (obs.accepted_shares) acceptedToday += obs.accepted_shares;
    }
  }

  const alerts = await getAlerts();
  const criticalAlerts = alerts.filter(
    (a) => !a.acknowledged && a.severity === "critical"
  ).length;

  return {
    total: devices.length,
    online,
    mining,
    degraded,
    quarantined,
    unreachable,
    rogue_detected: rogueDetected,
    wifi_nodes: wifiNodes,
    total_hashrate: totalHashrate.toFixed(1),
    accepted_today: acceptedToday,
    hottest_node: hottest,
    hottest_temp: hottestTemp,
    critical_alerts: criticalAlerts,
    active_alerts: alerts.filter((a) => !a.acknowledged).length,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event, context) => {

  const __swarmJson = (code, obj) => ({
    statusCode: code,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj)
  });

  const __swarmQs = event?.queryStringParameters || {};
  let __swarmBody = {};
  try {
    __swarmBody = event?.body ? JSON.parse(event.body) : {};
  } catch (_) {
    __swarmBody = {};
  }

  const __swarmAction = __swarmQs.action || __swarmBody.action || "";

  globalThis.__swarmTestState = {
    issued: false,
    updates: []
  };

  if (event?.httpMethod === "GET" && __swarmAction === "swarm-poll") {
  return __swarmJson(200, {
    jobs: [
      {
        id: "util-job-001",
        type: "utility",
        payload: {
          mode: "hash_text",
          text: "curtbrag cluster test"
        }
      }
    ]
  });
}
          }
        ]
      });
    }

    return __swarmJson(200, { jobs: [] });
  }

  if (event?.httpMethod === "POST" && __swarmAction === "job-update") {
    globalThis.__swarmTestState.updates.push({
      at: Date.now(),
      body: __swarmBody
    });

    return __swarmJson(200, {
      ok: true,
      received: true,
      updates: globalThis.__swarmTestState.updates
    });
  }

  connectLambda(event);
  const origin = event.headers.origin || "";
  const hdrs = corsHeaders(origin);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: hdrs, body: "" };
  }

  // ── auth-check (no auth required — just validates password) ──────────────
  const params = event.queryStringParameters || {};
  const action = params.action || "";

  if (action === "auth-check" && event.httpMethod === "POST") {
    const body = JSON.parse(event.body || "{}");
    const submitted = body.password || "";
    if (!submitted) return json(401, hdrs, { ok: false });

    let pw = await getWebPassword();

    // Bootstrap: if no password has ever been set, accept and store the first one
    if (!pw) {
      try {
        await openStore("cluster-config").set("web-password", submitted);
      } catch (_) {}
      return json(200, hdrs, { ok: true, bootstrapped: true });
    }

    if (safeCompare(submitted, pw)) {
      return json(200, hdrs, { ok: true });
    }
    return json(401, hdrs, { ok: false });
  }

  // ── all other routes require operator auth ───────────────────────────────
  if (!(await authOperator(event.headers))) {
    return json(401, hdrs, { error: "unauthorized" });
  }

  // ── GET routes ────────────────────────────────────────────────────────────
  if (event.httpMethod === "GET") {
    // Summary
    if (action === "summary") {
      const devices = await getAllDevices();
      const observedMap = {};
      for (const d of devices) {
        const obs = await getObservedState(d.id);
        if (obs) observedMap[d.id] = obs;
      }
      const summary = await buildSummary(devices, observedMap);
      return json(200, hdrs, { summary });
    }

    // All devices (with observed state merged in)
    if (action === "devices") {
      const devices = await getAllDevices();
      const now = Date.now();
      const enriched = await Promise.all(
        devices.map(async (d) => {
          const obs = (await getObservedState(d.id)) || {};
          const des = (await getDesiredState(d.id)) || {};
          const age = now - (d.last_seen_at || 0);
          return {
            ...d,
            agent_token: undefined, // strip secret
            online: age < 5 * 60 * 1000,
            observed: obs,
            desired: des,
          };
        })
      );
      return json(200, hdrs, { devices: enriched });
    }

    // Single device
    if (action === "device") {
      const id = params.id;
      if (!id) return json(400, hdrs, { error: "id required" });
      const device = await getDevice(id);
      if (!device) return json(404, hdrs, { error: "not found" });
      const obs = (await getObservedState(id)) || {};
      const des = (await getDesiredState(id)) || {};
      const events = await getEvents(id);
      return json(200, hdrs, {
        device: { ...device, agent_token: undefined },
        observed: obs,
        desired: des,
        events: events.slice(-50).reverse(),
      });
    }

    // Device logs
    if (action === "device-logs") {
      const id = params.id;
      if (!id) return json(400, hdrs, { error: "id required" });
      const events = await getEvents(id);
      return json(200, hdrs, { events: events.slice(-100).reverse() });
    }

    // Alerts
    if (action === "alerts") {
      const alerts = await getAlerts();
      return json(200, hdrs, {
        alerts: alerts.slice().reverse().slice(0, 200),
      });
    }

    // Profiles
    if (action === "profiles") {
      const profiles = await getProfiles();
      return json(200, hdrs, { profiles });
    }

    // Profile detail
    if (action === "profile") {
      const id = params.id;
      if (!id) return json(400, hdrs, { error: "id required" });
      const profile = await getProfile(id);
      if (!profile) return json(404, hdrs, { error: "not found" });
      return json(200, hdrs, { profile });
    }

    // Commands (queue + history)
    if (action === "commands") {
      const queue = await getQueue();
      const history = await getCommandHistory();
      return json(200, hdrs, {
        queue,
        history: history.slice().reverse().slice(0, 100),
      });
    }

    // Binary registry
    if (action === "binaries") {
      const registry = await getBinaryRegistry();
      return json(200, hdrs, { binaries: registry });
    }

    // Global events
    if (action === "events") {
      const events = await getEvents(null);
      return json(200, hdrs, { events: events.slice(-200).reverse() });
    }

    // Desired state for a device
    if (action === "desired") {
      const id = params.id;
      if (!id) return json(400, hdrs, { error: "id required" });
      const des = await getDesiredState(id);
      return json(200, hdrs, { desired: des });
    }

    // Device performance metrics
    if (action === "device-metrics") {
      const id = params.id;
      if (!id) return json(400, hdrs, { error: "device_id required" });
      try {
        const metricsStore = openStore("cp-metrics");
        const history = (await metricsStore.get(id, { type: "json" })) || [];
        const device = await getDevice(id);
        return json(200, hdrs, {
          device_id: id,
          device_hostname: device?.hostname || "unknown",
          samples: history.slice(-100),
          sample_count: history.length,
        });
      } catch (e) {
        return json(500, hdrs, { error: e.message });
      }
    }

    // Fleet-wide analytics
    if (action === "fleet-analytics") {
      try {
        const devices = await getAllDevices();
        const metricsStore = openStore("cp-metrics");
        const analytics = {
          devices_total: devices.length,
          devices_mining: 0,
          avg_hashrate: 0,
          peak_temp: 0,
          total_accepted: 0,
          device_samples: {},
        };

        for (const d of devices) {
          const history = (await metricsStore.get(d.id, { type: "json" })) || [];
          if (history.length > 0) {
            const latest = history[history.length - 1];
            if (latest.hashrate_60s > 0) analytics.devices_mining++;
            analytics.avg_hashrate += latest.hashrate_60s || 0;
            analytics.peak_temp = Math.max(analytics.peak_temp, latest.temp_peak || 0);
            analytics.total_accepted += latest.accepted_shares || 0;
            analytics.device_samples[d.id] = history.length;
          }
        }

        analytics.avg_hashrate = (analytics.avg_hashrate / Math.max(analytics.devices_mining, 1)).toFixed(2);
        return json(200, hdrs, analytics);
      } catch (e) {
        return json(500, hdrs, { error: e.message });
      }
    }

    // Thermal status report
    if (action === "thermal-report") {
      try {
        const devices = await getAllDevices();
        const metricsStore = openStore("cp-metrics");
        const report = {
          timestamp: Date.now(),
          nodes: [],
        };

        for (const d of devices) {
          const obs = (await getObservedState(d.id)) || {};
          const des = (await getDesiredState(d.id)) || {};
          const history = (await metricsStore.get(d.id, { type: "json" })) || [];
          const latest = history[history.length - 1] || {};

          report.nodes.push({
            device_id: d.id,
            hostname: d.hostname,
            current_temp: latest.temp_current || 0,
            peak_temp: latest.temp_peak || 0,
            max_allowed: des.max_temp_celsius || 80,
            status: obs.xmrig_running ? "mining" : "idle",
            policy_enforced: des.pause_on_high_temp,
          });
        }

        return json(200, hdrs, report);
      } catch (e) {
        return json(500, hdrs, { error: e.message });
      }
    }

    // Device groups list
    if (action === "groups") {
      try {
        const groupStore = openStore("cp-groups");
        const list = await groupStore.list();
        const groups = [];
        for (const entry of list.blobs) {
          const g = await groupStore.get(entry.key, { type: "json" });
          if (g) groups.push(g);
        }
        return json(200, hdrs, { groups });
      } catch {
        return json(200, hdrs, { groups: [] });
      }
    }

    return json(404, hdrs, { error: "unknown action" });
  }

  // ── POST routes ───────────────────────────────────────────────────────────
  if (event.httpMethod === "POST") {
    const body = JSON.parse(event.body || "{}");
    const postAction = body.action || action;

    // Queue a command
    if (postAction === "queue-command") {
      const VALID_TARGETS = [
        "all","phones","pcs",
        "node1","node2","node3","node4","node5","node6","node7","node8",
        "viki","nexus-prime",
      ];
      const VALID_COMMANDS = [
        "start","stop","restart","wake","sleep",
        "mining-start","mining-stop","mining-status",
        "mining-level","mining-pool","display-mode",
        "browse","update","reboot","ssh","screenshot",
        "brightness","debug","pod-logs",
        "kill-rogue","reconcile","fetch-logs",
        "disable-mining","quarantine","clear-quarantine",
        "run-diagnostic","switch-profile","force-binary-redeploy",
        "reset-restart-count",
      ];

      const target = body.target || "all";
      const type = body.type || body.command;

      // Accept fleet targets, plain hostnames, OR registered device IDs
      let targetValid = VALID_TARGETS.includes(target);
      if (!targetValid) {
        // Check if it's a registered device ID (e.g. "node1-abc12345")
        const targetDevice = await getDevice(target);
        targetValid = !!targetDevice;
      }
      if (!targetValid)
        return json(400, hdrs, { error: "invalid target" });
      if (!VALID_COMMANDS.includes(type))
        return json(400, hdrs, { error: "invalid command" });

      const cmd = {
        id: genId(),
        target,
        type,
        payload: body.payload || {},
        status: "queued",
        created_by: "operator",
        created_at: Date.now(),
        started_at: null,
        finished_at: null,
        result_summary: null,
      };

      await enqueueCommand(cmd);
      return json(200, hdrs, { ok: true, command_id: cmd.id });
    }

    // Flush command queue
    if (postAction === "flush-queue") {
      await flushQueue();
      return json(200, hdrs, { ok: true });
    }

    // Update desired state for a device
    if (postAction === "update-desired") {
      const { device_id, desired } = body;
      if (!device_id || !desired)
        return json(400, hdrs, { error: "device_id and desired required" });
      const current = (await getDesiredState(device_id)) || {};
      await saveDesiredState(device_id, { ...current, ...desired });
      return json(200, hdrs, { ok: true });
    }

    // Quarantine device
    if (postAction === "quarantine") {
      const { device_id } = body;
      if (!device_id) return json(400, hdrs, { error: "device_id required" });
      const device = await getDevice(device_id);
      if (!device) return json(404, hdrs, { error: "not found" });
      await saveDevice(device_id, {
        ...device,
        quarantined: true,
        quarantined_at: Date.now(),
        quarantine_reason: body.reason || "operator action",
      });
      // Also set desired state: disable mining
      const des = (await getDesiredState(device_id)) || {};
      await saveDesiredState(device_id, { ...des, miner_enabled: false, workload_enabled: false });
      return json(200, hdrs, { ok: true });
    }

    // Unquarantine device
    if (postAction === "unquarantine") {
      const { device_id } = body;
      if (!device_id) return json(400, hdrs, { error: "device_id required" });
      const device = await getDevice(device_id);
      if (!device) return json(404, hdrs, { error: "not found" });
      await saveDevice(device_id, {
        ...device,
        quarantined: false,
        quarantined_at: null,
        quarantine_reason: null,
      });
      return json(200, hdrs, { ok: true });
    }

    // Save / update a config profile
    if (postAction === "save-profile") {
      const { profile } = body;
      if (!profile || !profile.id)
        return json(400, hdrs, { error: "profile with id required" });
      if (DEFAULT_PROFILES[profile.id]?.built_in)
        return json(400, hdrs, { error: "cannot overwrite built-in profile" });
      await saveProfile(profile.id, {
        ...profile,
        updated_at: Date.now(),
      });
      return json(200, hdrs, { ok: true });
    }

    // Create new profile
    if (postAction === "create-profile") {
      const { profile } = body;
      if (!profile || !profile.name)
        return json(400, hdrs, { error: "profile.name required" });
      const id =
        profile.id ||
        profile.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32);
      const newProfile = {
        ...profile,
        id,
        built_in: false,
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      await saveProfile(id, newProfile);
      return json(200, hdrs, { ok: true, profile_id: id });
    }

    // Assign profile to device
    if (postAction === "assign-profile") {
      const { device_id, profile_id } = body;
      if (!device_id || !profile_id)
        return json(400, hdrs, { error: "device_id and profile_id required" });
      const device = await getDevice(device_id);
      if (!device) return json(404, hdrs, { error: "device not found" });
      await saveDevice(device_id, { ...device, miner_profile: profile_id });
      return json(200, hdrs, { ok: true });
    }

    // Rollout profile to group/all
    if (postAction === "rollout-profile") {
      const { profile_id, target, group_id } = body;
      if (!profile_id) return json(400, hdrs, { error: "profile_id required" });

      // Load the profile to get its settings
      const profile = await getProfile(profile_id);
      if (!profile) return json(404, hdrs, { error: "profile not found" });

      const devices = await getAllDevices();
      const affected = [];

      // Resolve group membership if group_id provided
      let groupDeviceIds = null;
      if (group_id) {
        const groupStore = openStore("cp-groups");
        const grp = await groupStore.get(group_id, { type: "json" }).catch(() => null);
        groupDeviceIds = grp?.device_ids || [];
      }

      for (const d of devices) {
        let match = false;
        if (groupDeviceIds !== null) {
          match = groupDeviceIds.includes(d.id);
        } else if (target === "all") match = true;
        else if (target === "phones" && d.device_class === "phone") match = true;
        else if (target === "pcs" && d.device_class !== "phone") match = true;
        else if (d.id === target || d.hostname === target) match = true;

        if (match) {
          // Mark profile on device record
          await saveDevice(d.id, { ...d, miner_profile: profile_id });
          // Push profile settings into desired state so agent acts on them
          const des = (await getDesiredState(d.id)) || {};
          const updates = { miner_profile: profile_id };
          if (profile.miner_enabled != null) {
            updates.miner_enabled = profile.miner_enabled;
            updates.workload_enabled = profile.miner_enabled; // keep in sync
          }
          if (profile.thread_count != null) updates.thread_count = profile.thread_count;
          if (profile.max_temp != null) updates.max_temp_celsius = profile.max_temp;
          if (profile.pause_on_battery != null) updates.pause_on_battery = profile.pause_on_battery;
          if (profile.pause_on_high_temp != null) updates.pause_on_high_temp = profile.pause_on_high_temp;
          if (profile.randomx_mode) updates.randomx_mode = profile.randomx_mode;
          if (profile.preflight_required != null) updates.preflight_required = profile.preflight_required;
          // Extract pool settings from profile.config if present
          const pool = profile.config?.pools?.[0];
          if (pool?.url) {
            // Strip protocol prefix (tls://, stratum+tcp://, etc.) before split
            const rawUrl = pool.url.replace(/^[a-z+]+:\/\//i, "");
            const colonIdx = rawUrl.lastIndexOf(":");
            if (colonIdx !== -1) {
              const poolHost = rawUrl.slice(0, colonIdx);
              const poolPort = parseInt(rawUrl.slice(colonIdx + 1));
              if (poolHost) updates.pool_url = poolHost;
              if (!isNaN(poolPort)) updates.pool_port = poolPort;
            }
          }
          await saveDesiredState(d.id, { ...des, ...updates });
          affected.push(d.id);
        }
      }

      return json(200, hdrs, { ok: true, affected });
    }

    // Acknowledge alert
    if (postAction === "ack-alert") {
      const { alert_id } = body;
      if (!alert_id) return json(400, hdrs, { error: "alert_id required" });
      const alerts = await getAlerts();
      const updated = alerts.map((a) =>
        a.id === alert_id ? { ...a, acknowledged: true, acked_at: Date.now() } : a
      );
      await saveAlerts(updated);
      return json(200, hdrs, { ok: true });
    }

    // Acknowledge all alerts
    if (postAction === "ack-all-alerts") {
      const alerts = await getAlerts();
      const now = Date.now();
      const updated = alerts.map((a) => ({
        ...a,
        acknowledged: true,
        acked_at: now,
      }));
      await saveAlerts(updated);
      return json(200, hdrs, { ok: true });
    }

    // Register binary hash
    if (postAction === "register-binary") {
      const { label, path: binPath, sha256, device_class } = body;
      if (!label || !sha256)
        return json(400, hdrs, { error: "label and sha256 required" });
      const registry = await getBinaryRegistry();
      const entry = {
        id: genId(),
        label,
        path: binPath || "~/xmrig-custom",
        sha256,
        device_class: device_class || "phone",
        enabled: true,
        created_at: Date.now(),
      };
      registry.push(entry);
      await saveBinaryRegistry(registry.slice(-50));
      return json(200, hdrs, { ok: true, binary_id: entry.id });
    }

    // Update device notes / labels
    if (postAction === "update-device") {
      const { device_id, updates } = body;
      if (!device_id) return json(400, hdrs, { error: "device_id required" });
      const device = await getDevice(device_id);
      if (!device) return json(404, hdrs, { error: "not found" });
      const ALLOWED = [
        "hostname",
        "notes",
        "group",
        "cluster_role",
        "miner_profile",
      ];
      const safe = {};
      for (const k of ALLOWED) {
        if (updates && updates[k] !== undefined) safe[k] = updates[k];
      }
      await saveDevice(device_id, { ...device, ...safe });
      return json(200, hdrs, { ok: true });
    }

    // Fleet-wide: disable all mining
    if (postAction === "fleet-disable-mining") {
      const devices = await getAllDevices();
      const target = body.target || "all";
      let count = 0;
      for (const d of devices) {
        const isPhone = d.device_class === "phone";
        const matches = target === "all" || (target === "phones" && isPhone) || (target === "pcs" && !isPhone);
        if (matches) {
          const des = (await getDesiredState(d.id)) || {};
          await saveDesiredState(d.id, { ...des, miner_enabled: false, workload_enabled: false });
          count++;
        }
      }
      return json(200, hdrs, { ok: true, affected: count });
    }

    // Fleet-wide: enable mining (phones only by default)
    if (postAction === "fleet-enable-mining") {
      const devices = await getAllDevices();
      const target = body.target || "phones";
      let count = 0;
      for (const d of devices) {
        const isPhone = d.device_class === "phone";
        if (target === "all" || (target === "phones" && isPhone) || (target === "pcs" && !isPhone)) {
          const des = (await getDesiredState(d.id)) || {};
          await saveDesiredState(d.id, { ...des, miner_enabled: true, workload_enabled: true });
          count++;
        }
      }
      return json(200, hdrs, { ok: true, affected: count });
    }

    // Delete device (remove from registry)
    if (postAction === "delete-device") {
      const { device_id } = body;
      if (!device_id) return json(400, hdrs, { error: "device_id required" });
      try {
        await openStore("cp-devices").delete(device_id);
        await openStore("cp-desired").delete(device_id);
        await openStore("cp-observed").delete(device_id);
        await openStore("cp-events").delete(device_id);
      } catch {}
      return json(200, hdrs, { ok: true });
    }

    // Device grouping: create/update group
    if (postAction === "save-group") {
      const { group_id, group_name, device_ids, description } = body;
      if (!group_id || !group_name)
        return json(400, hdrs, { error: "group_id and group_name required" });
      const groupStore = openStore("cp-groups");
      const existing = await groupStore.get(group_id, { type: "json" }).catch(() => null);
      const group = {
        id: group_id,
        name: group_name,
        description: description || existing?.description || "",
        device_ids: device_ids || existing?.device_ids || [],
        created_at: existing?.created_at || Date.now(),
        updated_at: Date.now(),
      };
      await groupStore.setJSON(group_id, group);
      return json(200, hdrs, { ok: true });
    }

    // Set restart policy for device
    if (postAction === "set-restart-policy") {
      const { device_id, threshold, cooldown } = body;
      if (!device_id || threshold === undefined || cooldown === undefined)
        return json(400, hdrs, { error: "device_id, threshold, cooldown required" });
      const des = (await getDesiredState(device_id)) || {};
      await saveDesiredState(device_id, {
        ...des,
        restart_threshold: threshold,
        restart_cooldown: cooldown,
      });
      return json(200, hdrs, { ok: true });
    }

    // Set approved binary hash (fleet-wide or per device)
    if (postAction === "set-binary-hash") {
      const { hash, target } = body; // target: "all" | "phones" | "pcs" | device_id
      if (!hash || !/^[a-f0-9]{64}$/i.test(hash))
        return json(400, hdrs, { error: "hash must be a 64-char hex SHA-256" });
      const devices = await getAllDevices();
      const affected = [];
      for (const d of devices) {
        let match = false;
        if (!target || target === "all") match = true;
        else if (target === "phones" && d.device_class === "phone") match = true;
        else if (target === "pcs" && d.device_class !== "phone") match = true;
        else if (d.id === target || d.hostname === target) match = true;
        if (match) {
          const des = (await getDesiredState(d.id)) || {};
          await saveDesiredState(d.id, { ...des, approved_binary_hash: hash.toLowerCase() });
          affected.push(d.id);
        }
      }
      return json(200, hdrs, { ok: true, affected: affected.length });
    }

    // Clear approved binary hash (removes enforcement)
    if (postAction === "clear-binary-hash") {
      const { target } = body;
      const devices = await getAllDevices();
      const affected = [];
      for (const d of devices) {
        let match = !target || target === "all"
          || (target === "phones" && d.device_class === "phone")
          || (target === "pcs" && d.device_class !== "phone")
          || d.id === target || d.hostname === target;
        if (match) {
          const des = await getDesiredState(d.id);
          if (des) {
            // eslint-disable-next-line no-unused-vars
            const { approved_binary_hash: _removed, ...rest } = des;
            await saveDesiredState(d.id, rest);
          }
          affected.push(d.id);
        }
      }
      return json(200, hdrs, { ok: true, affected: affected.length });
    }

    // Reset restart counter for device (queues a reconcile command)
    if (postAction === "reset-restart-count") {
      const { device_id } = body;
      if (!device_id) return json(400, hdrs, { error: "device_id required" });
      // Queue a reconcile command so the agent clears /tmp/xmrig-restart-state.txt
      const cmd = {
        id: genId(),
        target: device_id,
        type: "reset-restart-count",
        payload: {
              
              mode: "hash_text", text: "curtbrag cluster test"
            },
        status: "queued",
        created_by: "operator",
        created_at: Date.now(),
        started_at: null,
        finished_at: null,
      };
      await enqueueCommand(cmd);
      return json(200, hdrs, { ok: true });
    }

    // Set pool config for a device
    if (postAction === "set-pool-config") {
      const { device_id, pool_url, pool_port, thread_count, randomx_mode } = body;
      if (!device_id || !pool_url || !pool_port)
        return json(400, hdrs, { error: "device_id, pool_url, pool_port required" });
      const des = (await getDesiredState(device_id)) || {};
      await saveDesiredState(device_id, {
        ...des,
        pool_url,
        pool_port: parseInt(pool_port),
        ...(thread_count !== undefined && { thread_count: parseInt(thread_count) }),
        ...(randomx_mode && { randomx_mode }),
      });
      return json(200, hdrs, { ok: true });
    }

    // Set thermal policy for device
    if (postAction === "set-thermal-policy") {
      const { device_id, max_temp, pause_on_battery, pause_on_high_temp } = body;
      if (!device_id)
        return json(400, hdrs, { error: "device_id required" });
      const des = (await getDesiredState(device_id)) || {};
      await saveDesiredState(device_id, {
        ...des,
        max_temp_celsius: max_temp !== undefined ? max_temp : des.max_temp_celsius,
        pause_on_battery: pause_on_battery !== undefined ? pause_on_battery : des.pause_on_battery,
        pause_on_high_temp: pause_on_high_temp !== undefined ? pause_on_high_temp : des.pause_on_high_temp,
      });
      return json(200, hdrs, { ok: true });
    }

    // Set mining level for device
    if (postAction === "set-mining-level") {
      const { device_id, level } = body;
      if (!device_id || level === undefined)
        return json(400, hdrs, { error: "device_id and level (0-4) required" });
      if (level < 0 || level > 4)
        return json(400, hdrs, { error: "level must be 0-4" });
      const des = (await getDesiredState(device_id)) || {};
      await saveDesiredState(device_id, {
        ...des,
        mining_level: level,
        miner_enabled: level > 0,
        workload_enabled: level > 0,
      });
      return json(200, hdrs, { ok: true });
    }

    // Track binary deployment
    if (postAction === "deploy-binary") {
      const { binary_id, target, device_ids } = body;
      if (!binary_id)
        return json(400, hdrs, { error: "binary_id required" });
      const deployStore = openStore("cp-deployments");
      const deployment = {
        id: genId(),
        binary_id,
        target,
        device_ids: device_ids || [],
        status: "in_progress",
        created_at: Date.now(),
        completed_at: null,
        results: {},
      };
      const deployments = (await deployStore.get("deployments", { type: "json" })) || [];
      deployments.push(deployment);
      await deployStore.setJSON("deployments", deployments.slice(-100));
      return json(200, hdrs, { ok: true, deployment_id: deployment.id });
    }

    // Track profile rollout
    if (postAction === "track-rollout") {
      const { rollout_id, profile_id, target_devices, status } = body;
      if (!rollout_id || !profile_id)
        return json(400, hdrs, { error: "rollout_id and profile_id required" });
      const rolloutStore = openStore("cp-rollouts");
      const rollout = {
        id: rollout_id,
        profile_id,
        target_devices: target_devices || [],
        status: status || "in_progress",
        created_at: Date.now(),
        updated_at: Date.now(),
        results: {},
      };
      await rolloutStore.setJSON(rollout_id, rollout);
      return json(200, hdrs, { ok: true });
    }

    return json(404, hdrs, { error: "unknown action" });
  }

  return json(405, hdrs, { error: "method not allowed" });
};
