// Netlify Function: Agent-facing Control Plane API
// Handles: device registration, heartbeats, telemetry ingestion, config retrieval,
//          command queue polling, command result upload, event reporting
//
// Agent authenticates with X-Agent-Token header (shared API key on register;
// per-device token returned after registration for all subsequent calls).
// Device identity passed via X-Device-Id header.

const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

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

// ─── Credential helpers ──────────────────────────────────────────────────────

async function getApiKey() {
  const env = process.env.CLUSTER_API_KEY;
  if (env) return env;
  try {
    const store = getStore("cluster-config");
    return (await store.get("api-key", { type: "text" })) || null;
  } catch {
    return null;
  }
}

// ─── Device store ────────────────────────────────────────────────────────────

async function getDevice(deviceId) {
  try {
    return await getStore("cp-devices").get(deviceId, { type: "json" });
  } catch {
    return null;
  }
}

async function saveDevice(deviceId, device) {
  try {
    await getStore("cp-devices").setJSON(deviceId, device);
  } catch (e) {
    console.warn("saveDevice:", e.message);
  }
}

async function findDeviceByHostname(hostname) {
  try {
    const store = getStore("cp-devices");
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
    return await getStore("cp-desired").get(deviceId, { type: "json" });
  } catch {
    return null;
  }
}

async function saveObservedState(deviceId, state) {
  try {
    await getStore("cp-observed").setJSON(deviceId, {
      ...state,
      timestamp: Date.now(),
    });
  } catch (e) {
    console.warn("saveObservedState:", e.message);
  }
}

// ─── Command queue ───────────────────────────────────────────────────────────

async function getPendingCommandsForDevice(deviceId, deviceClass) {
  try {
    const store = getStore("cp-commands");
    const queue = (await store.get("queue", { type: "json" })) || [];
    const isPhone =
      deviceClass === "phone" ||
      (deviceId && /^node\d+$/.test(deviceId));
    const isPC =
      deviceClass === "pc" ||
      (deviceId &&
        ["nexus-prime", "viki", "skynet", "steamdeck"].includes(deviceId));

    return queue.filter((cmd) => {
      if (cmd.status !== "queued") return false;
      const t = cmd.target;
      if (t === "all") return true;
      if (t === "phones" && isPhone) return true;
      if (t === "pcs" && isPC) return true;
      if (t === deviceId) return true;
      return false;
    });
  } catch {
    return [];
  }
}

async function ackCommand(commandId, deviceId) {
  try {
    const store = getStore("cp-commands");
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
    const store = getStore("cp-commands");
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
    const evStore = getStore("cp-events");
    const alertStore = getStore("cp-alerts");
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

  if (desired.miner_enabled && !observed.xmrig_running) {
    promises.push(
      addEvent(deviceId, {
        severity: "warning",
        type: "miner_stopped",
        message: `Miner should be running on ${deviceId} but isn't`,
        data: {},
      })
    );
  }

  if (observed.temp_peak && Number(observed.temp_peak) > 75) {
    promises.push(
      addEvent(deviceId, {
        severity: "warning",
        type: "high_temperature",
        message: `High temp on ${deviceId}: ${observed.temp_peak}°C`,
        data: { temp: observed.temp_peak },
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
    miner_enabled: isPhone,
    approved_binary_path: "/home/user/xmrig-custom",
    approved_binary_hash: null,
    approved_config_version: "1",
    blocked_paths: ["/usr/local/bin/xmrig", "/usr/bin/xmrig"],
    blocked_cron_patterns: ["xmrig", "start-xmrig"],
    allowed_cron_entries: [],
    telemetry_interval: 60,
    remediation_mode: isPhone ? "aggressive" : "passive",
    reboot_policy: "never",
    network_preference: "any",
    performance_profile: isPhone ? "phone-default" : "default",
    config_version: "1",
    updated_at: Date.now(),
  };
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
  const origin = event.headers.origin || "";
  const hdrs = corsHeaders(origin);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: hdrs, body: "" };
  }

  // Extract action from path: /.netlify/functions/agent-api/register → "register"
  const rawPath =
    event.path.replace(/.*\/agent-api/, "") || "";
  const segments = rawPath.split("/").filter(Boolean);
  const action = segments[0] || "";
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
        await getStore("cp-desired").setJSON(newId, ds);

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
        device.device_class
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
          profileConfig = await getStore("cp-profiles").get(
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
        device.device_class
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

    return json(404, hdrs, { error: "not found" });
  } catch (e) {
    console.error("agent-api error:", e);
    return json(500, hdrs, { error: "internal error", message: e.message });
  }
};
