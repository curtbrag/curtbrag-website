import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const STORE_NAME = "swarm-queue";
const ONLINE_MS = 90_000;
const MAX_STDOUT = 4000;
const MAX_CMD = 4000;
const AGENT_SCHEMA = 2;

function jsonResponse(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization, X-Cluster-Key"
    }
  });
}

const store = () => getStore(STORE_NAME);

function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function bearerToken(request) {
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return (request.headers.get("x-cluster-key") || "").trim();
}

async function configValue(envName, blobKey) {
  if (process.env[envName]) return process.env[envName];
  try {
    return (await getStore("cluster-config").get(blobKey, { type: "text" })) || "";
  } catch {
    return "";
  }
}

async function authorized(request, kind) {
  // Compatibility mode is intentional until the dashboard is switched to
  // authenticated Swarm requests. Set SWARM_ENFORCE_AUTH=1 after that patch.
  if (process.env.SWARM_ENFORCE_AUTH !== "1") return true;
  const expected = kind === "worker"
    ? await configValue("CLUSTER_API_KEY", "api-key")
    : await configValue("CLUSTER_WEB_PASSWORD", "web-password");
  const token = bearerToken(request);
  return !!expected && !!token && safeCompare(token, expected);
}

function safePart(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96);
}

const keyJob = id => `job--${safePart(id)}`;
const keyAssignment = (jobId, deviceId) => `assignment--${safePart(jobId)}--${safePart(deviceId)}`;
const keyNode = id => `node--${safePart(id)}`;
const keyResult = (ts, jobId, deviceId) => `result--${String(ts).padStart(13, "0")}--${safePart(jobId)}--${safePart(deviceId)}`;

async function getJson(key, fallback = null) {
  try {
    const value = await store().get(key, { type: "json" });
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

async function setJson(key, value) {
  await store().setJSON(key, value);
}

async function deleteKey(key) {
  try { await store().delete(key); } catch {}
}

async function listEntries(prefix) {
  try {
    const listing = await store().list();
    const hits = (listing.blobs || []).filter(entry => entry.key.startsWith(prefix));
    const out = [];
    for (const entry of hits) {
      const value = await getJson(entry.key, null);
      if (value) out.push({ key: entry.key, value });
    }
    return out;
  } catch {
    return [];
  }
}

async function readNodes() {
  const entries = await listEntries("node--");
  const nodes = {};
  for (const entry of entries) {
    const n = entry.value;
    if (n?.id) nodes[n.id] = n;
  }
  return nodes;
}

async function updateNode(deviceId, data) {
  if (!deviceId) return;
  const current = await getJson(keyNode(deviceId), { id: deviceId });
  await setJson(keyNode(deviceId), {
    ...current,
    ...data,
    id: deviceId,
    last_seen: Date.now(),
    schema: AGENT_SCHEMA
  });
}

function onlineNodeIds(nodes) {
  const now = Date.now();
  return Object.values(nodes)
    .filter(n => now - (n.last_seen || 0) < ONLINE_MS)
    .map(n => n.id);
}

async function createV2Job(job, explicitTargets = null) {
  const jobId = String(job.id || "").trim();
  const type = String(job.type || "").trim();
  if (!jobId || !type) throw new Error("invalid job payload");

  const existing = await getJson(keyJob(jobId), null);
  if (existing) {
    const pending = await listEntries("assignment--");
    return {
      job: existing,
      enqueued: false,
      queue_count: pending.filter(x => x.value?.job_id === jobId).length
    };
  }

  const nodes = await readNodes();
  let targets = Array.isArray(explicitTargets) ? explicitTargets.filter(Boolean) : [];

  if (!targets.length && Array.isArray(job.target_device_ids)) {
    targets = job.target_device_ids.filter(Boolean);
  }
  if (!targets.length && job.device_id) targets = [job.device_id];
  if (!targets.length) targets = onlineNodeIds(nodes);

  targets = [...new Set(targets.map(String))];
  if (!targets.length) throw new Error("no online swarm nodes available for this job");

  const now = Date.now();
  const normalized = {
    id: jobId,
    type,
    cmd: String(job.cmd ?? job.command ?? "").slice(0, MAX_CMD),
    command: String(job.command ?? job.cmd ?? "").slice(0, MAX_CMD),
    queued_at: Number(job.queued_at) || now,
    target_device_ids: targets,
    target_count: targets.length,
    schema: AGENT_SCHEMA
  };

  await setJson(keyJob(jobId), normalized);
  for (const deviceId of targets) {
    await setJson(keyAssignment(jobId, deviceId), {
      job_id: jobId,
      device_id: deviceId,
      assigned_at: now,
      job: normalized,
      schema: AGENT_SCHEMA
    });
  }

  return { job: normalized, enqueued: true, queue_count: targets.length };
}

async function migrateLegacy() {
  const marker = await getJson("migration--v2", null);
  if (marker?.done) return;

  try {
    const legacyNodes = await getJson("nodes", {});
    if (legacyNodes && typeof legacyNodes === "object" && !Array.isArray(legacyNodes)) {
      for (const [id, node] of Object.entries(legacyNodes)) {
        await setJson(keyNode(id), { id, ...node, schema: AGENT_SCHEMA });
      }
    }

    const legacyResults = await getJson("results", []);
    if (Array.isArray(legacyResults)) {
      let i = 0;
      for (const result of legacyResults) {
        const ts = Number(result.completed_at) || (Date.now() + i++);
        await setJson(keyResult(ts, result.job_id || `legacy-${i}`, result.device_id || "unknown"), {
          ...result,
          completed_at: ts,
          schema: AGENT_SCHEMA
        });
      }
    }

    const legacyJobs = await getJson("jobs", []);
    if (Array.isArray(legacyJobs) && legacyJobs.length) {
      for (const job of legacyJobs) {
        try { await createV2Job(job); } catch {}
      }
    }

    await setJson("jobs", []);
    await setJson("results", []);
    await setJson("nodes", {});
    await setJson("migration--v2", { done: true, at: Date.now() });
  } catch (error) {
    console.warn("swarm migration:", error?.message || error);
  }
}

async function queueSnapshot() {
  const [jobEntries, assignmentEntries, resultEntries, nodes] = await Promise.all([
    listEntries("job--"),
    listEntries("assignment--"),
    listEntries("result--"),
    readNodes()
  ]);

  const jobs = jobEntries.map(entry => {
    const job = entry.value;
    const pending = assignmentEntries.filter(a => a.value?.job_id === job.id);
    const completed = resultEntries.filter(r => r.value?.job_id === job.id);
    return {
      ...job,
      pending_count: pending.length,
      completed_count: completed.length,
      progress: `${completed.length}/${job.target_count || (pending.length + completed.length)}`
    };
  }).sort((a, b) => (a.queued_at || 0) - (b.queued_at || 0));

  const now = Date.now();
  const nodeList = Object.values(nodes).map(n => {
    const active = assignmentEntries.filter(a => a.value?.device_id === n.id);
    return {
      ...n,
      online: now - (n.last_seen || 0) < ONLINE_MS,
      busy: active.length > 0,
      active_jobs: active.map(a => a.value?.job_id).filter(Boolean)
    };
  }).sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const results = resultEntries
    .map(entry => entry.value)
    .sort((a, b) => (b.completed_at || 0) - (a.completed_at || 0));

  return {
    jobs,
    assignments: assignmentEntries.map(x => x.value),
    nodes: nodeList,
    results
  };
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("", {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Content-Type, Authorization, X-Cluster-Key"
      }
    });
  }

  await migrateLegacy();

  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "";

  let body = {};
  try {
    body = request.method === "POST" ? await request.json() : {};
  } catch {
    body = {};
  }

  const workerActions = new Set(["swarm-poll", "job-complete", "job-update", "heartbeat"]);
  const operatorActions = new Set(["enqueue", "queue-status", "flush-queue", "clear-results"]);

  if (workerActions.has(action) && !(await authorized(request, "worker"))) {
    return jsonResponse(401, { ok: false, error: "unauthorized worker" });
  }
  if (operatorActions.has(action) && !(await authorized(request, "operator"))) {
    return jsonResponse(401, { ok: false, error: "unauthorized operator" });
  }

  if (request.method === "POST" && action === "enqueue") {
    const job = body.job;
    if (!job || typeof job !== "object" || !job.id || !job.type) {
      return jsonResponse(400, { ok: false, error: "invalid job payload" });
    }

    try {
      const created = await createV2Job(job, body.target_device_ids || null);
      const snap = await queueSnapshot();
      return jsonResponse(200, {
        ok: true,
        action: "enqueue",
        enqueued: created.enqueued,
        already_present: !created.enqueued,
        job_id: created.job.id,
        target_count: created.job.target_count,
        target_device_ids: created.job.target_device_ids,
        queue_count: snap.jobs.length,
        assignments_pending: snap.assignments.length
      });
    } catch (error) {
      return jsonResponse(409, { ok: false, error: error?.message || "enqueue failed" });
    }
  }

  if (request.method === "GET" && action === "swarm-poll") {
    const deviceId = (url.searchParams.get("device_id") || "").trim();
    if (!deviceId) return jsonResponse(400, { ok: false, error: "device_id required" });

    await updateNode(deviceId, { polling: true });
    const assignments = await listEntries("assignment--");
    const jobs = assignments
      .map(x => x.value)
      .filter(a => a?.device_id === deviceId && a.job)
      .map(a => a.job);

    return jsonResponse(200, {
      ok: true,
      action: "swarm-poll",
      jobs,
      queue_count: jobs.length,
      schema: AGENT_SCHEMA
    });
  }

  if (request.method === "POST" && action === "job-complete") {
    const jobId = String(body.job_id || "").trim();
    const deviceId = String(body.device_id || "").trim();
    if (!jobId || !deviceId) {
      return jsonResponse(400, { ok: false, error: "job_id and device_id required" });
    }

    const job = await getJson(keyJob(jobId), null);
    const completedAt = body.ts ? Number(body.ts) * 1000 : Date.now();
    const result = {
      job_id: jobId,
      device_id: deviceId,
      exit_code: Number.isFinite(Number(body.exit_code)) ? Number(body.exit_code) : 0,
      stdout: String(body.stdout || "").slice(0, MAX_STDOUT),
      stderr: String(body.stderr || "").slice(0, MAX_STDOUT),
      cmd: job?.cmd || "",
      type: job?.type || body.type || "",
      completed_at: completedAt,
      schema: AGENT_SCHEMA
    };

    await setJson(keyResult(completedAt, jobId, deviceId), result);
    await deleteKey(keyAssignment(jobId, deviceId));
    await updateNode(deviceId, {
      last_job: jobId,
      last_exit: result.exit_code,
      last_completed_at: completedAt,
      polling: true
    });

    const assignments = await listEntries("assignment--");
    const remaining = assignments.filter(a => a.value?.job_id === jobId).length;
    if (remaining === 0) await deleteKey(keyJob(jobId));

    return jsonResponse(200, {
      ok: true,
      action: "job-complete",
      job_id: jobId,
      device_id: deviceId,
      remaining
    });
  }

  if (request.method === "POST" && action === "job-update") {
    const jobId = String(body.job_id || "").trim();
    const deviceId = String(body.device_id || "").trim();
    if (jobId && deviceId) await deleteKey(keyAssignment(jobId, deviceId));
    return jsonResponse(200, { ok: true, action: "job-update", received: true });
  }

  if (request.method === "POST" && action === "heartbeat") {
    const deviceId = String(body.device_id || "").trim();
    if (!deviceId) return jsonResponse(400, { ok: false, error: "device_id required" });

    await updateNode(deviceId, {
      heartbeat_ts: body.ts || Math.floor(Date.now() / 1000),
      hostname: body.hostname || deviceId,
      platform: body.platform || "unknown",
      node_class: body.node_class || "unknown",
      agent_version: body.agent_version || "unknown",
      agent_pid: body.pid || null
    });

    return jsonResponse(200, { ok: true, action: "heartbeat", received: true });
  }

  if (request.method === "GET" && action === "queue-status") {
    const snap = await queueSnapshot();
    return jsonResponse(200, {
      ok: true,
      action: "queue-status",
      queued: snap.jobs.length,
      assignments_pending: snap.assignments.length,
      jobs: snap.jobs,
      nodes: snap.nodes,
      nodes_online: snap.nodes.filter(n => n.online).length,
      nodes_busy: snap.nodes.filter(n => n.busy).length,
      results: snap.results.slice(0, 50),
      total_completed: snap.results.length,
      schema: AGENT_SCHEMA,
      auth_enforced: process.env.SWARM_ENFORCE_AUTH === "1"
    });
  }

  if (request.method === "POST" && action === "flush-queue") {
    const [jobs, assignments] = await Promise.all([
      listEntries("job--"),
      listEntries("assignment--")
    ]);
    for (const entry of [...jobs, ...assignments]) await deleteKey(entry.key);
    return jsonResponse(200, {
      ok: true,
      action: "flush-queue",
      jobs_removed: jobs.length,
      assignments_removed: assignments.length
    });
  }

  if (request.method === "POST" && action === "clear-results") {
    const results = await listEntries("result--");
    for (const entry of results) await deleteKey(entry.key);
    return jsonResponse(200, {
      ok: true,
      action: "clear-results",
      removed: results.length
    });
  }

  const snap = await queueSnapshot();
  return jsonResponse(200, {
    ok: true,
    action,
    method: request.method,
    queue_count: snap.jobs.length,
    assignments_pending: snap.assignments.length,
    schema: AGENT_SCHEMA
  });
};