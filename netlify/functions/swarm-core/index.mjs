import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const STORE_NAME = "swarm-queue";
const ONLINE_MS = 90_000;
const MAX_STDOUT = 4000;
const MAX_CMD = 4000;
const AGENT_SCHEMA = 2;
const MAX_RESULT_LOOKUPS = 16;
const MAX_RESULT_LOOKUP_KEYS = 5000;

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

const store = () => getStore({ name: STORE_NAME, consistency: "strong" });

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
    return (await getStore("cluster-config").get(blobKey, { type: "text", consistency: "strong" })) || "";
  } catch {
    return "";
  }
}

async function authorized(request, kind) {
  // Operator actions are always protected because they can enqueue shell work.
  // Worker auth stays in compatibility mode until every deployed v2 agent is
  // confirmed to have CLUSTER_API_KEY/SWARM_TOKEN available.
  if (kind === "worker" && process.env.SWARM_ENFORCE_AUTH !== "1") return true;

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
const keyResultIndex = (jobId, deviceId) => `result-index--${safePart(jobId)}--${safePart(deviceId)}`;

function resultLookupRequests(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !Array.isArray(body.requests) ||
      body.requests.length < 1 || body.requests.length > MAX_RESULT_LOOKUPS) return null;
  const requests = [];
  const seen = new Set();
  for (const entry of body.requests) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).length !== 2 ||
        ![entry.job_id, entry.device_id].every(value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value))) return null;
    const identity = JSON.stringify([entry.job_id, entry.device_id]);
    if (!seen.has(identity)) {
      seen.add(identity);
      requests.push({ job_id: entry.job_id, device_id: entry.device_id });
    }
  }
  return requests;
}

function matchingResultKey(key, request) {
  return typeof key === "string" && /^result--\d{13}--/.test(key) &&
    key.endsWith(`--${request.job_id}--${request.device_id}`);
}

function reportedExitCode(value) {
  if (Number.isSafeInteger(value)) return value;
  // Older workers may send an integer as text. Missing values, booleans and
  // blank strings are unknown, never successful exits.
  if (typeof value === "string" && /^-?(?:0|[1-9][0-9]{0,15})$/.test(value)) {
    const code = Number(value);
    if (Number.isSafeInteger(code)) return code;
  }
  return null;
}

function resultForRequest(value, request) {
  if (!value || value.job_id !== request.job_id || value.device_id !== request.device_id) return null;
  // A launch report needs its receipt, not the original shell command. Return
  // only the fields consumed by the dashboard for the explicitly named pair.
  return {
    job_id: value.job_id, device_id: value.device_id,
    type: String(value.type || "").slice(0, 96),
    exit_code: reportedExitCode(value.exit_code),
    stdout: String(value.stdout || "").slice(0, MAX_STDOUT),
    stderr: String(value.stderr || "").slice(0, MAX_STDOUT),
    completed_at: Number(value.completed_at) || null,
    schema: AGENT_SCHEMA
  };
}

async function lookupJobResults(requests) {
  const database = store();
  const found = new Map();
  const identity = entry => JSON.stringify([entry.job_id, entry.device_id]);
  const missingIndex = [];
  await Promise.all(requests.map(async entry => {
    const index = await database.get(keyResultIndex(entry.job_id, entry.device_id), { type: "json" });
    if (index?.job_id === entry.job_id && index?.device_id === entry.device_id && matchingResultKey(index.result_key, entry)) {
      const value = resultForRequest(await database.get(index.result_key, { type: "json" }), entry);
      if (value) { found.set(identity(entry), value); return; }
    }
    missingIndex.push(entry);
  }));

  let examined = 0;
  let complete = true;
  if (missingIndex.length) {
    // Old receipts predate the per-pair index. Bound this compatibility scan to
    // key metadata; never fetch unrelated result bodies or auto-page all history.
    const candidates = new Map();
    history: for await (const page of database.list({ prefix: "result--", paginate: true })) {
      for (const blob of page.blobs || []) {
        if (examined >= MAX_RESULT_LOOKUP_KEYS) { complete = false; break history; }
        examined++;
        for (const entry of missingIndex) {
          if (matchingResultKey(blob.key, entry)) {
            const id = identity(entry);
            if (!candidates.has(id) || blob.key > candidates.get(id)) candidates.set(id, blob.key);
          }
        }
      }
      if (examined >= MAX_RESULT_LOOKUP_KEYS) { complete = false; break; }
    }
    await Promise.all(missingIndex.map(async entry => {
      const key = candidates.get(identity(entry));
      if (!key) return;
      const value = resultForRequest(await database.get(key, { type: "json" }), entry);
      if (value) found.set(identity(entry), value);
    }));
  }

  const pending = [], missing = [];
  await Promise.all(requests.filter(entry => !found.has(identity(entry))).map(async entry => {
    const assignment = await database.get(keyAssignment(entry.job_id, entry.device_id), { type: "json" });
    (assignment?.job_id === entry.job_id && assignment?.device_id === entry.device_id ? pending : missing).push(entry);
  }));
  return { results: requests.map(entry => found.get(identity(entry))).filter(Boolean),
    pending, missing, complete, history_keys_examined: examined, lookup_limit: MAX_RESULT_LOOKUPS };
}

function lookupResponse(status, body) {
  const response = jsonResponse(status, body);
  response.headers.set("cache-control", "no-store");
  return response;
}

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

async function readEntries(entries, strict = false) {
  const out = [];
  for (let offset = 0; offset < entries.length; offset += 16) {
    const batch = await Promise.all(entries.slice(offset, offset + 16).map(async entry => {
      const value = strict
        ? await store().get(entry.key, { type: "json" })
        : await getJson(entry.key, null);
      return value ? { key: entry.key, value } : null;
    }));
    out.push(...batch.filter(Boolean));
  }
  return out;
}

async function listEntries(prefix, strict = false) {
  try {
    const listing = await store().list({ prefix });
    // Fleet status includes result history. Serial blob reads can exceed the
    // Windows bridge's 20-second timeout as that history grows. Limit parallel
    // reads to avoid an unbounded burst while retaining listing order.
    const entries = listing.blobs || [];
    return await readEntries(entries, strict);
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

async function readNodes(strict = false) {
  const entries = await listEntries("node--", strict);
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

function selectedJobTargets(job, explicitTargets) {
  const validId = value => typeof value === "string" && /^[A-Za-z0-9._-]{1,96}$/.test(value);
  for (const value of [explicitTargets, job.target_device_ids]) {
    if (value !== undefined && (!Array.isArray(value) || !value.length || !value.every(validId))) {
      throw new TypeError("target_device_ids must be a non-empty array of device IDs; no job was queued");
    }
  }
  if (job.device_id !== undefined && !validId(job.device_id)) {
    throw new TypeError("device_id must be a valid device ID; no job was queued");
  }
  // Only completely omitted targeting retains the legacy online-fleet default.
  // A malformed or empty selection must never turn into a fleet-wide command.
  return explicitTargets ?? job.target_device_ids ?? (job.device_id === undefined ? null : [job.device_id]);
}

async function createV2Job(job, explicitTargets) {
  const jobId = String(job.id || "").trim();
  const type = String(job.type || "").trim();
  if (!jobId || !type) throw new Error("invalid job payload");
  const selected = selectedJobTargets(job, explicitTargets);

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
  let targets = selected ?? onlineNodeIds(nodes);

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
  const [jobEntries, assignmentEntries, resultListing, nodes] = await Promise.all([
    listEntries("job--", true),
    listEntries("assignment--", true),
    store().list({ prefix: "result--" }),
    readNodes(true)
  ]);

  // Result keys include a fixed-width completion timestamp. Read only the
  // newest history plus results needed to count currently queued jobs. Old
  // result bodies must not delay worker availability or a command receipt.
  const resultKeys = resultListing.blobs || [];
  const newest = [...resultKeys].sort((a, b) => b.key.localeCompare(a.key));
  const selected = new Map(newest.slice(0, 50).map(entry => [entry.key, entry]));
  for (const entry of resultKeys) {
    const tail = entry.key.replace(/^result--\d{13}--/, "");
    if (jobEntries.some(job => tail.startsWith(safePart(job.value.id) + "--"))) {
      selected.set(entry.key, entry);
    }
  }
  const resultEntries = await readEntries([...selected.values()], true);

  const jobs = jobEntries.map(entry => {
    const job = entry.value;
    const pending = assignmentEntries.filter(a => a.value?.job_id === job.id);
    const completed = resultEntries.filter(r => r.value?.job_id === job.id);
    return {
      ...job,
      pending_count: pending.length,
      pending_device_ids: pending.map(a => a.value.device_id),
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
    results,
    total_completed: resultKeys.length
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

  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "";

  let body = {};
  try {
    body = request.method === "POST" ? await request.json() : {};
  } catch {
    body = {};
  }

  const workerActions = new Set(["swarm-poll", "job-complete", "job-update", "heartbeat"]);
  const operatorActions = new Set(["enqueue", "queue-status", "job-results", "cancel-job", "flush-queue", "clear-results"]);

  if (workerActions.has(action) && !(await authorized(request, "worker"))) {
    return jsonResponse(401, { ok: false, error: "unauthorized worker" });
  }
  if (operatorActions.has(action) && !(await authorized(request, "operator"))) {
    return jsonResponse(401, { ok: false, error: "unauthorized operator" });
  }

  if (action === "job-results") {
    if (request.method !== "POST") return lookupResponse(405, { ok: false, error: "Use POST for explicit job result lookups." });
    const requests = resultLookupRequests(body);
    if (!requests) return lookupResponse(400, { ok: false, error: "Provide one to sixteen exact job_id/device_id request pairs." });
    try {
      return lookupResponse(200, { ok: true, action, ...await lookupJobResults(requests), schema: AGENT_SCHEMA });
    } catch {
      return lookupResponse(503, { ok: false, error: "Launch results are temporarily unavailable. No request was sent or retried." });
    }
  }

  // Receipt reconciliation is read-only, including on a store awaiting legacy
  // migration. Other actions retain their existing migration behavior.
  if (request.method === "POST" && action === "enqueue") {
    try { selectedJobTargets(body.job || {}, body.target_device_ids); }
    catch (error) { return jsonResponse(400, { ok: false, error: error.message }); }
  }
  await migrateLegacy();

  if (request.method === "POST" && action === "enqueue") {
    const job = body.job;
    if (!job || typeof job !== "object" || !job.id || !job.type) {
      return jsonResponse(400, { ok: false, error: "invalid job payload" });
    }

    try {
      const created = await createV2Job(job, body.target_device_ids);
      // The job and its assignments are durable at this point. Do not make
      // acknowledgment depend on an unrelated full history/status read.
      return jsonResponse(200, {
        ok: true,
        action: "enqueue",
        enqueued: created.enqueued,
        already_present: !created.enqueued,
        job_id: created.job.id,
        target_count: created.job.target_count,
        target_device_ids: created.job.target_device_ids
      });
    } catch (error) {
      return jsonResponse(409, { ok: false, error: error?.message || "enqueue failed" });
    }
  }

  if (request.method === "GET" && action === "swarm-poll") {
    const deviceId = (
      url.searchParams.get("device_id") ||
      request.headers.get("x-device-id") ||
      ""
    ).trim();
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
      exit_code: reportedExitCode(body.exit_code),
      stdout: String(body.stdout || "").slice(0, MAX_STDOUT),
      stderr: String(body.stderr || "").slice(0, MAX_STDOUT),
      cmd: job?.cmd || "",
      type: job?.type || body.type || "",
      completed_at: completedAt,
      schema: AGENT_SCHEMA
    };

    await setJson(keyResult(completedAt, jobId, deviceId), result);
    try {
      await setJson(keyResultIndex(jobId, deviceId), {
        job_id: jobId, device_id: deviceId, completed_at: completedAt,
        result_key: keyResult(completedAt, jobId, deviceId), schema: AGENT_SCHEMA
      });
    } catch {
      // The receipt is already durable. An index outage must not repeat device
      // work; the bounded metadata fallback can still retrieve the receipt.
      console.warn("swarm result index unavailable; receipt remains in history");
    }
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
    let snap;
    try { snap = await queueSnapshot(); }
    catch {
      return jsonResponse(503, { ok: false, error: "Worker status is temporarily unavailable. No offline state was inferred." });
    }
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
      total_completed: snap.total_completed,
      schema: AGENT_SCHEMA,
      auth_enforced: true,
      worker_auth_enforced: process.env.SWARM_ENFORCE_AUTH === "1"
    });
  }

  if (request.method === "POST" && action === "cancel-job") {
    const jobId = String(body.job_id || "").trim();
    if (!jobId) return jsonResponse(400, { ok: false, error: "job_id required" });

    const job = await getJson(keyJob(jobId), null);
    const assignments = (await listEntries("assignment--"))
      .filter(a => a.value?.job_id === jobId);
    if (!job && !assignments.length) {
      return jsonResponse(404, { ok: false, error: "job not found" });
    }

    // Completed results remain in history; only unfinished work is cancelled.
    for (const assignment of assignments) await deleteKey(assignment.key);
    await deleteKey(keyJob(jobId));
    return jsonResponse(200, {
      ok: true,
      action: "cancel-job",
      job_id: jobId,
      assignments_removed: assignments.length,
      results_preserved: true
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
    const indexes = await listEntries("result-index--");
    for (const entry of indexes) await deleteKey(entry.key);
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
