// Netlify Function: Agent-facing Control Plane API
// Handles: device registration, heartbeats, telemetry ingestion, config retrieval,
//          command queue polling, command result upload, event reporting
//
// Agent authenticates with X-Agent-Token header (shared API key on register;
// per-device token returned after registration for all subsequent calls).
// Device identity passed via X-Device-Id header.

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
// ─── Helpers ────────────────────────────────────────────────────────────────

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
    "Access-Control-Allow-Headers": "Content-Type, X-Agent-Token, X-Device-Id",
    "Content-Type": "application/json",
  };
}

function json(statusCode, headers, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}


function getActionFromEvent(event) {
  const path = event.path || "";
  const rawUrl = event.rawUrl || "";
  let pathname = "";

  try {
    pathname = rawUrl ? new URL(rawUrl).pathname : "";
  } catch {}

  const candidates = [path, pathname];

  for (const p of candidates) {
    if (!p) continue;

    if (p.startsWith("/.netlify/functions/agent-api/")) {
      return p.replace("/.netlify/functions/agent-api/", "").split("/")[0] || "";
    }

    if (p.startsWith("/api/agent/")) {
      return p.replace("/api/agent/", "").split("/")[0] || "";
    }

    if (p.startsWith("/agent-api/")) {
      return p.replace("/agent-api/", "").split("/")[0] || "";
    }
  }

  return "";
}
// ─── Credential helpers ──────────────────────────────────────────────────────

async function getApiKey() {
  const env = process.env.CLUSTER_API_KEY;
  if (env) return env;
  try {
    const store = openStore("cluster-config");
    return (await store.get("api-key", { type: "text" })) || null;
  } catch {
    return null;
  }
}

// ─── Device store ────────────────────────────────────────────────────────────

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

async function findDeviceByHostname(hostname) {
  try {
    const store = openStore("cp-devices");
    const list = await store.list();
    for (const entry of list.blobs) {
      const d = await store.get(entry.key, { type: "json" });
      if (d && d.hostname === hostname) return d;
    }
  } catch {}
  return null;
}

// ─── Desired / observed state ────────────────────────────────────────────────

async function getDesiredState(deviceId) {
  try {
    return await openStore("cp-desired").get(deviceId, { type: "json" });
  } catch {
    return null;
  }
}

async function saveObservedState(deviceId, state) {
  try {
    await openStore("cp-observed").setJSON(deviceId, {
      ...state,
      timestamp: Date.now(),
    });
  } catch (e) {
    console.warn("saveObservedState:", e.message);
  }
}

// ─── Command queue ───────────────────────────────────────────────────────────

async function getPendingCommandsForDevice(deviceId, deviceClass, hostname) {
  try {
    const store = openStore("cp-commands");
    const queue = (await store.get("queue", { type: "json" })) || [];
    const isPhone = deviceClass === "phone";
    const isPC = deviceClass === "pc" || deviceClass === "steamdeck";

    return queue.filter((cmd) => {
      if (cmd.status !== "queued") return false;
      const t = cmd.target;
      if (t === "all") return true;
      if (t === "phones" && isPhone) return true;
      if (t === "pcs" && isPC) return true;
      if (t === deviceId) return true;
      if (hostname && t === hostname) return true;
      return false;
    });
  } catch {
    return [];
  }
}

async function ackCommand(commandId, deviceId) {
  try {
    const store = openStore("cp-commands");
    const queue = (await store.get("queue", { type: "json" })) || [];
    const updated = queue.map((cmd) =>
      cmd.id === commandId
        ? { ...cmd, status: "running", acked_by: deviceId, acked_at: Date.now() }
        : cmd
    );
    await store.setJSON("queue", updated);
  } catch (e) {
    console.warn("ackCommand:", e.message);
  }
}

async function completeCommand(commandId, result) {
  try {
    const store = openStore("cp-commands");
    const queue = (await store.get("queue", { type: "json" })) || [];
    const history = (await store.get("history", { type: "json" })) || [];

    const cmd = queue.find((c) => c.id === commandId);
    if (cmd) {
      const completed = {
        ...cmd,
        ...result,
        status: result.success !== false ? "succeeded" : "failed",
        finished_at: Date.now(),
      };
      await store.setJSON("queue", queue.filter((c) => c.id !== commandId));
      await store.setJSON("history", [...history, completed].slice(-100));
    }
  } catch (e) {
    console.warn("completeCommand:", e.message);
  }
}

// ─── Events & alerts ─────────────────────────────────────────────────────────

async function addEvent(deviceId, event) {
  try {
    const evStore = openStore("cp-events");
    const alertStore = openStore("cp-alerts");
    const ts = Date.now();
    const base = {
      id: genId(),
      device_id: deviceId,
      created_at: ts,
      ...event,
    };

    // Per-device log (last 100)
    const devEvents = (await evStore.get(deviceId, { type: "json" })) || [];
    await evStore.setJSON(deviceId, [...devEvents, base].slice(-100));

    // Global recent log (last 500)
    const allEvents = (await evStore.get("all", { type: "json" })) || [];
    await evStore.setJSON("all", [...allEvents, base].slice(-500));

    // Alerts for warning/critical
    if (event.severity === "critical" || event.severity === "warning") {
      const alerts = (await alertStore.get("active", { type: "json" })) || [];
      const alert = {
        id: genId(),
        device_id: deviceId,
        severity: event.severity,
        type: event.type,
        message: event.message,
        data: event.data || {},
        created_at: ts,
        acknowledged: false,
      };
      await alertStore.setJSON("active", [...alerts, alert].slice(-200));
    }
  } catch (e) {
    console.warn("addEvent:", e.message);
  }
}

// ─── Drift detection ─────────────────────────────────────────────────────────

async function checkDrift(deviceId, desired, observed) {
  const promises = [];

  if (observed.rogue_pid && observed.rogue_pid !== observed.custom_pid) {
    promises.push(
      addEvent(deviceId, {
        severity: "critical",
        type: "rogue_process_detected",
        message: `Rogue xmrig PID ${observed.rogue_pid} on ${deviceId}`,
        data: { pid: observed.rogue_pid, cmd: observed.rogue_cmd },
      })
    );
  }

  // Only fire miner_stopped if not blocked by a known gate (preflight, thermal, battery)
  const blockedByGate = observed.preflight_status?.startsWith("blocked")
    || observed.preflight_status === "blocked_hash_mismatch"
    || observed.workload_enabled === false;
  if (desired.miner_enabled && !observed.xmrig_running && !blockedByGate) {
    promises.push(
      addEvent(deviceId, {
        severity: "warning",
        type: "miner_stopped",
        message: `Miner should be running on ${deviceId} but isn't`,
        data: { preflight_status: observed.preflight_status },
      })
    );
  }

  // Thermal policy violations
  const tempC = Number(observed.temp_peak || observed.temp_current || 0);
  const maxTempC = Number(desired.max_temp_celsius || 80);
  if (tempC > maxTempC) {
    promises.push(
      addEvent(deviceId, {
        severity: "critical",
        type: "thermal_policy_violation",
        message: `Temp ${tempC}°C exceeds limit ${maxTempC}°C on ${deviceId}`,
        data: { current: tempC, max: maxTempC, policy_action: "pause_mining" },
      })
    );
  } else if (tempC > maxTempC * 0.9) {
    promises.push(
      addEvent(deviceId, {
        severity: "warning",
        type: "high_temperature",
        message: `High temp on ${deviceId}: ${tempC}°C (limit ${maxTempC}°C)`,
        data: { current: tempC, max: maxTempC },
      })
    );
  }

  // Battery policy violations
  if (desired.pause_on_battery && observed.battery_on_battery) {
    promises.push(
      addEvent(deviceId, {
        severity: "warning",
        type: "battery_policy_violation",
        message: `Device on battery but mining enabled on ${deviceId}`,
        data: { battery_percent: observed.battery_percent },
      })
    );
  }

  // Restart failures
  if (observed.restart_count && observed.restart_count > desired.restart_threshold) {
    promises.push(
      addEvent(deviceId, {
        severity: "critical",
        type: "restart_threshold_exceeded",
        message: `${observed.restart_count} restarts exceed threshold ${desired.restart_threshold} on ${deviceId}`,
        data: { restarts: observed.restart_count, threshold: desired.restart_threshold },
      })
    );
  }

  if (
    desired.approved_binary_hash &&
    observed.binary_hash &&
    desired.approved_binary_hash !== observed.binary_hash
  ) {
    promises.push(
      addEvent(deviceId, {
        severity: "critical",
        type: "binary_hash_mismatch",
        message: `Binary hash mismatch on ${deviceId}`,
        data: {
          expected: desired.approved_binary_hash,
          actual: observed.binary_hash,
        },
      })
    );
  }

  if (observed.cron_drift_detected) {
    promises.push(
      addEvent(deviceId, {
        severity: "warning",
        type: "cron_drift",
        message: `Unauthorized cron entry detected on ${deviceId}`,
        data: { entries: observed.cron_drift_entries },
      })
    );
  }

  if (observed.rogue_binary_detected) {
    promises.push(
      addEvent(deviceId, {
        severity: "critical",
        type: "rogue_binary",
        message: `Rogue xmrig binary at blocked path on ${deviceId}`,
        data: { path: observed.rogue_binary_path },
      })
    );
  }

  await Promise.all(promises);
}

// ─── Default desired state ───────────────────────────────────────────────────

function defaultDesiredState(deviceClass, deviceId) {
  const isPhone =
    deviceClass === "phone" || (deviceId && /^node\d+$/.test(deviceId));
  return {
    // ── Workload (top-level abstraction) ────────────────────────────
    workload_type: "mining",        // mining | idle | custom
    workload_enabled: isPhone,      // master on/off
    workload_profile: isPhone ? "phone-mining" : "default",

    // ── Miner control ───────────────────────────────────────────────
    miner_enabled: isPhone,
    mining_level: isPhone ? 3 : 2, // 0=off, 1=low, 2=medium, 3=high, 4=max

    // ── Pool (local Nexus by default) ───────────────────────────────
    pool_url: "192.168.1.179",      // local Nexus — must be up before mining
    pool_port: 10128,
    pool_user: "44Ris5ep9FE6hmwAbi7CtAV5NexMuZixhKeGk8xDFHNYWi57TjsMXEyEFQyVWNQxLkaPY1xVPjoTY2yaTfkTzkCMRur3PwT",
    pool_pass: "x",
    pool_tls: false,

    // ── Thread/resource config (node1-proven baseline) ──────────────
    thread_count: isPhone ? 6 : 4, // proven ~525 H/s @ 6 threads on node1
    force_threads: false,
    huge_pages: false,              // not available in Termux
    randomx_mode: "light",
    affinity: "",

    // ── Thermal/battery ─────────────────────────────────────────────
    max_temp_celsius: 60,           // tightened for phones; was 80
    pause_on_battery: isPhone,
    pause_on_high_temp: true,
    temp_check_interval: 10,

    // ── Logging (Termux-compatible path) ────────────────────────────
    log_path: "~/cluster/logs/xmrig.log",   // agent expands ~ to $HOME
    print_interval: 60,

    // ── Preflight ───────────────────────────────────────────────────
    preflight_required: true,       // must pass before mining-start
    preflight_pool_check: true,     // TCP check pool_url:pool_port
    preflight_binary_check: true,   // binary must exist + hash match

    // ── Restart policy ──────────────────────────────────────────────
    restart_threshold: 5,
    restart_cooldown: 300,

    // ── Security ────────────────────────────────────────────────────
    approved_binary_path: "~/xmrig-custom",  // agent expands ~ to $HOME
    approved_binary_hash: null,              // set after first fleet deploy
    approved_config_version: "1",
    blocked_paths: ["/usr/local/bin/xmrig", "/usr/bin/xmrig"],
    blocked_cron_patterns: ["xmrig", "start-xmrig"],
    allowed_cron_entries: [],

    // ── Operational ─────────────────────────────────────────────────
    telemetry_interval: 60,
    remediation_mode: isPhone ? "aggressive" : "passive",
    reboot_policy: "never",
    network_preference: "any",
    performance_profile: isPhone ? "phone-mining" : "default",
    config_version: "1",
    updated_at: Date.now(),
  };
}

// ─── xmrig config generation ────────────────────────────────────────────────

function generateXmrigConfig(desired, device) {
  if (!desired) return null;

  const config = {
    api: { id: null, worker_id: null },
    http: { enabled: false, host: "127.0.0.1", port: 0, access_token: null, restricted: true },
    autosave: true,
    background: true,
    colors: true,
    title: true,
    randomx: { init: -1, mode: desired.randomx_mode || "light", "1gb-pages": desired.huge_pages },
    cpu: { enabled: true, huge_pages: desired.huge_pages, hw_aes: true, priority: null },
    donate_level: 1,
    donate_over_proxy: 1,
    log_file: desired.log_path || "/tmp/xmrig.log",
    print_time_interval: desired.print_interval || 60,
    health_print_interval: 60,
    retries: 5,
    retry_pause: 5,
    syslog: false,
    user_agent: null,
    verbose: 0,
    watch: true,
    pools: [
      {
        algo: "rx/0",
        coin: "monero",
        url: `${desired.pool_tls ? "tls://" : ""}${desired.pool_url}:${desired.pool_port || 10128}`,
        user: desired.pool_user || "YOUR_WALLET",
        pass: desired.pool_pass || "x",
        rig_id: null,
        nicehash: false,
        keepalive: false,
        enabled: true,
        tls: desired.pool_tls || false,
        tls_fingerprint: null,
        daemon: false,
        socks5: null,
        self_select: null,
        submit_to_origin: false,
      }
    ],
  };

  // Add thread config if specified
  if (desired.thread_count || desired.affinity) {
    config.cpu.threads = [];
    const threads = parseInt(desired.thread_count) || 2;
    for (let i = 0; i < threads; i++) {
      config.cpu.threads.push({
        cv: 2,
        affinity: desired.affinity ? `${i % parseInt(desired.affinity.split(',').length)}` : null,
        asm: "auto",
        argon2_impl: null,
        astrobwt_impl: null,
        cn_0: null,
        cn_1: null,
        cn_2: null,
        cn_msr: null,
        cn_sse41: null,
        cn_zen: null,
      });
    }
  }

  return config;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function validateAgent(headers, deviceId) {
  const token =
    headers["x-agent-token"] || headers["X-Agent-Token"] || "";
  if (!token) return false;

  // Shared API key always works
  const apiKey = await getApiKey();
  if (apiKey && safeCompare(token, apiKey)) return true;

  // Per-device token
  if (deviceId) {
    const device = await getDevice(deviceId);
    if (device && device.agent_token && safeCompare(token, device.agent_token))
      return true;
  }

  return false;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event, context) => {
  connectLambda(event);
  const origin = event.headers.origin || "";
  const hdrs = corsHeaders(origin);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: hdrs, body: "" };
  }

  // Extract action from path: /.netlify/functions/agent-api/register → "register"
  const action = getActionFromEvent(event);
  const deviceId =
    event.headers["x-device-id"] || event.headers["X-Device-Id"] || "";

  try {
    // ── REGISTER ──────────────────────────────────────────────────────────────
    if (action === "register" && event.httpMethod === "POST") {
      const apiKey = await getApiKey();
      const token =
        event.headers["x-agent-token"] ||
        event.headers["X-Agent-Token"] ||
        "";
      if (!apiKey || !safeCompare(token, apiKey)) {
        return json(401, hdrs, { error: "unauthorized" });
      }

      const body = JSON.parse(event.body || "{}");
      const { hostname, deviceClass, ips, osInfo, hardware, agentVersion } =
        body;

      if (!hostname) return json(400, hdrs, { error: "hostname required" });

      // Re-registration: find by hostname
      let device = await findDeviceByHostname(hostname);

      if (!device) {
        // New device
        const newId = `${hostname.replace(/[^a-z0-9-]/gi, "-")}-${genId().slice(0, 8)}`;
        const agentToken = genId();
        device = {
          id: newId,
          hostname,
          device_class: deviceClass || "unknown",
          status: "online",
          cluster_role: body.clusterRole || "worker",
          registered_at: Date.now(),
          last_seen_at: Date.now(),
          current_ip: ips?.primary || "",
          ips: ips || {},
          os_info: osInfo || {},
          hardware: hardware || {},
          agent_token: agentToken,
          agent_version: agentVersion || "1.0",
          miner_profile:
            (deviceClass === "phone" || /^node\d+$/.test(hostname))
              ? "phone-default"
              : "default",
          quarantined: false,
          notes: "",
          group: body.group || "",
        };
        await saveDevice(newId, device);

        // Seed desired state
        const ds = defaultDesiredState(deviceClass, hostname);
        await openStore("cp-desired").setJSON(newId, ds);

        return json(200, hdrs, {
          device_id: newId,
          agent_token: agentToken,
          registered: true,
          desired_state: ds,
        });
      } else {
        // Update metadata
        device = {
          ...device,
          last_seen_at: Date.now(),
          status: "online",
          current_ip: ips?.primary || device.current_ip,
          ips: ips || device.ips,
          os_info: osInfo || device.os_info,
          hardware: hardware || device.hardware,
          agent_version: agentVersion || device.agent_version,
        };
        await saveDevice(device.id, device);

        const desired =
          (await getDesiredState(device.id)) ||
          defaultDesiredState(device.device_class, device.hostname);
        return json(200, hdrs, {
          device_id: device.id,
          agent_token: device.agent_token,
          registered: false,
          desired_state: desired,
        });
      }
    }

    // ── HEARTBEAT ─────────────────────────────────────────────────────────────
    if (action === "heartbeat" && event.httpMethod === "POST") {
      if (!(await validateAgent(event.headers, deviceId)))
        return json(401, hdrs, { error: "unauthorized" });

      const device = await getDevice(deviceId);
      if (!device) return json(404, hdrs, { error: "device not found" });

      const body = JSON.parse(event.body || "{}");
      await saveDevice(deviceId, {
        ...device,
        status: "online",
        last_seen_at: Date.now(),
        current_ip: body.ip || device.current_ip,
        agent_version: body.agentVersion || device.agent_version,
      });

      const desired = await getDesiredState(deviceId);
      const pending = await getPendingCommandsForDevice(
        deviceId,
        device.device_class,
        device.hostname
      );

      return json(200, hdrs, {
        ok: true,
        desired_state: desired,
        pending_commands: pending.length,
        server_time: Date.now(),
      });
    }

    // ── STATE (telemetry) ─────────────────────────────────────────────────────
    if (action === "state" && event.httpMethod === "POST") {
      if (!(await validateAgent(event.headers, deviceId)))
        return json(401, hdrs, { error: "unauthorized" });

      const device = await getDevice(deviceId);
      if (!device) return json(404, hdrs, { error: "device not found" });

      const body = JSON.parse(event.body || "{}");
      await saveObservedState(deviceId, body);
      await saveDevice(deviceId, {
        ...device,
        status: "online",
        last_seen_at: Date.now(),
        current_ip: body.ip || device.current_ip,
      });

      const desired = await getDesiredState(deviceId);
      if (desired) await checkDrift(deviceId, desired, body);

      return json(200, hdrs, { ok: true });
    }

    // ── CONFIG/RENDER-XMRIG (must be before generic /config check) ───────────
    if (action === "config" && segments[1] === "render-xmrig" && event.httpMethod === "GET") {
      if (!(await validateAgent(event.headers, deviceId)))
        return json(401, hdrs, { error: "unauthorized" });

      const device = await getDevice(deviceId);
      if (!device) return json(404, hdrs, { error: "device not found" });

      const desired =
        (await getDesiredState(deviceId)) ||
        defaultDesiredState(device.device_class, device.hostname);

      const xmrigConfig = generateXmrigConfig(desired, device);
      return json(200, hdrs, {
        config: xmrigConfig,
        version: desired.config_version || "1",
        generated_at: Date.now(),
      });
    }

    // ── CONFIG ────────────────────────────────────────────────────────────────
    if (action === "config" && event.httpMethod === "GET") {
      if (!(await validateAgent(event.headers, deviceId)))
        return json(401, hdrs, { error: "unauthorized" });

      const device = await getDevice(deviceId);
      if (!device) return json(404, hdrs, { error: "device not found" });

      const desired =
        (await getDesiredState(deviceId)) ||
        defaultDesiredState(device.device_class, device.hostname);

      let profileConfig = null;
      if (device.miner_profile) {
        try {
          profileConfig = await openStore("cp-profiles").get(
            device.miner_profile,
            { type: "json" }
          );
        } catch {}
      }

      return json(200, hdrs, {
        desired_state: desired,
        profile: profileConfig,
        device_class: device.device_class,
        config_version: desired.config_version || "1",
      });
    }

    // ── COMMANDS ──────────────────────────────────────────────────────────────
    if (action === "commands" && event.httpMethod === "GET") {
      if (!(await validateAgent(event.headers, deviceId)))
        return json(401, hdrs, { error: "unauthorized" });

      const device = await getDevice(deviceId);
      if (!device) return json(404, hdrs, { error: "device not found" });

      const cmds = await getPendingCommandsForDevice(
        deviceId,
        device.device_class,
        device.hostname
      );
      for (const cmd of cmds) {
        await ackCommand(cmd.id, deviceId);
      }

      return json(200, hdrs, { commands: cmds });
    }

    // ── COMMAND-RESULT ────────────────────────────────────────────────────────
    if (action === "command-result" && event.httpMethod === "POST") {
      if (!(await validateAgent(event.headers, deviceId)))
        return json(401, hdrs, { error: "unauthorized" });

      const body = JSON.parse(event.body || "{}");
      if (!body.command_id)
        return json(400, hdrs, { error: "command_id required" });

      await completeCommand(body.command_id, {
        success: body.success !== false,
        stdout: String(body.stdout || "").slice(0, 4000),
        stderr: String(body.stderr || "").slice(0, 2000),
        exit_code: body.exit_code ?? 0,
        node: deviceId,
      });

      return json(200, hdrs, { ok: true });
    }

    // ── EVENT ─────────────────────────────────────────────────────────────────
    if (action === "event" && event.httpMethod === "POST") {
      if (!(await validateAgent(event.headers, deviceId)))
        return json(401, hdrs, { error: "unauthorized" });

      const body = JSON.parse(event.body || "{}");
      await addEvent(deviceId, {
        severity: body.severity || "info",
        type: body.type || "generic",
        message: String(body.message || "").slice(0, 500),
        data: body.data || {},
      });

      return json(200, hdrs, { ok: true });
    }

    // ── TELEMETRY (detailed metrics) ──────────────────────────────────────────
    if (action === "telemetry" && event.httpMethod === "POST") {
      if (!(await validateAgent(event.headers, deviceId)))
        return json(401, hdrs, { error: "unauthorized" });

      const device = await getDevice(deviceId);
      if (!device) return json(404, hdrs, { error: "device not found" });

      const body = JSON.parse(event.body || "{}");
      const metricsStore = openStore("cp-metrics");

      // Store detailed telemetry history per device (last 1000 samples)
      try {
        const history = (await metricsStore.get(deviceId, { type: "json" })) || [];
        const sample = {
          timestamp: Date.now(),
          hashrate_10s: body.hashrate_10s || 0,
          hashrate_60s: body.hashrate_60s || 0,
          hashrate_15m: body.hashrate_15m || 0,
          accepted_shares: body.accepted_shares || 0,
          rejected_shares: body.rejected_shares || 0,
          invalid_shares: body.invalid_shares || 0,
          temp_current: body.temp_current || 0,
          temp_peak: body.temp_peak || 0,
          load_average: body.load_average || [0, 0, 0],
          memory_used_mb: body.memory_used_mb || 0,
          memory_total_mb: body.memory_total_mb || 0,
          battery_percent: body.battery_percent,
          cpu_affinity: body.cpu_affinity || [],
          huge_pages_enabled: body.huge_pages_enabled || false,
          randomx_mode: body.randomx_mode || "",
          thread_count: body.thread_count || 0,
        };
        await metricsStore.setJSON(deviceId, [...history, sample].slice(-1000));
      } catch (e) {
        console.warn("telemetry storage error:", e.message);
      }

      // Update device with latest metrics
      await saveDevice(deviceId, {
        ...device,
        last_hashrate: body.hashrate_60s || 0,
        last_temp: body.temp_current || 0,
        last_telemetry: Date.now(),
      });

      return json(200, hdrs, { ok: true });
    }

    return json(404, hdrs, { error: "not found" });
  } catch (e) {
    console.error("agent-api error:", e);
    return json(500, hdrs, { error: "internal error", message: e.message });
  }
};
