import { getStore } from "@netlify/blobs"; // v2

function jsonResponse(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization"
    }
  });
}

const store = () => getStore("swarm-queue");

async function readQueue() {
  try { return (await store().get("jobs", { type: "json" })) || []; }
  catch { return []; }
}

async function writeQueue(jobs) {
  try { await store().setJSON("jobs", jobs); return true; }
  catch { return false; }
}

async function readResults() {
  try { return (await store().get("results", { type: "json" })) || []; }
  catch { return []; }
}

async function appendResult(result) {
  try {
    const existing = await readResults();
    const trimmed = [...existing, result].slice(-100); // keep last 100
    await store().setJSON("results", trimmed);
  } catch {}
}

async function readNodes() {
  try { return (await store().get("nodes", { type: "json" })) || {}; }
  catch { return {}; }
}

async function updateNode(deviceId, data) {
  try {
    const nodes = await readNodes();
    nodes[deviceId] = { ...nodes[deviceId], ...data, last_seen: Date.now() };
    await store().setJSON("nodes", nodes);
  } catch {}
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("", {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Content-Type, Authorization"
      }
    });
  }

  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "";

  let body = {};
  try {
    body = request.method === "POST" ? await request.json() : {};
  } catch { body = {}; }

  // ── enqueue ────────────────────────────────────────────────────────────────
  if (request.method === "POST" && action === "enqueue") {
    const job = body.job;
    if (!job || typeof job !== "object" || !job.id || !job.type) {
      return jsonResponse(400, { ok: false, error: "invalid job payload" });
    }
    const jobs = await readQueue();
    const exists = jobs.some(j => j && j.id === job.id);
    if (!exists) {
      jobs.push({ ...job, queued_at: Date.now() });
      await writeQueue(jobs);
    }
    return jsonResponse(200, {
      ok: true, action: "enqueue",
      enqueued: !exists, already_present: exists,
      job_id: job.id, queue_count: jobs.length
    });
  }

  // ── swarm-poll ─────────────────────────────────────────────────────────────
  if (request.method === "GET" && action === "swarm-poll") {
    const deviceId = url.searchParams.get("device_id") || "";
    if (deviceId) await updateNode(deviceId, { polling: true });
    const jobs = (await readQueue()).filter(j => {
      if (!j || !j.id || !j.type) return false;
      return !j.device_id || j.device_id === deviceId;
    });
    return jsonResponse(200, {
      ok: true, action: "swarm-poll", jobs, queue_count: jobs.length
    });
  }

  // ── job-complete ───────────────────────────────────────────────────────────
  if (request.method === "POST" && action === "job-complete") {
    const { job_id, device_id, exit_code, stdout, ts } = body;
    if (job_id) {
      const jobs = await readQueue();
      const job = jobs.find(j => j && j.id === job_id);
      await writeQueue(jobs.filter(j => j && j.id !== job_id));
      await appendResult({
        job_id, device_id: device_id || "unknown",
        exit_code: exit_code ?? 0,
        stdout: (stdout || "").slice(0, 2000),
        cmd: job?.cmd || job?.command || "",
        type: job?.type || "",
        completed_at: ts ? ts * 1000 : Date.now()
      });
      if (device_id) await updateNode(device_id, { last_job: job_id, last_exit: exit_code });
    }
    return jsonResponse(200, { ok: true, action: "job-complete" });
  }

  // ── job-update (alias) ─────────────────────────────────────────────────────
  if (request.method === "POST" && action === "job-update") {
    const { job_id } = body;
    if (job_id) {
      const jobs = await readQueue();
      await writeQueue(jobs.filter(j => j && j.id !== job_id));
    }
    return jsonResponse(200, { ok: true, action: "job-update", received: true });
  }

  // ── heartbeat ──────────────────────────────────────────────────────────────
  if (request.method === "POST" && action === "heartbeat") {
    const { device_id, ts } = body;
    if (device_id) await updateNode(device_id, { heartbeat_ts: ts });
    return jsonResponse(200, { ok: true, action: "heartbeat", received: true });
  }

  // ── dashboard: queue status ────────────────────────────────────────────────
  if (request.method === "GET" && action === "queue-status") {
    const [jobs, results, nodes] = await Promise.all([readQueue(), readResults(), readNodes()]);
    const nodeList = Object.entries(nodes).map(([id, n]) => ({
      id, ...n,
      online: Date.now() - (n.last_seen || 0) < 90_000
    }));
    return jsonResponse(200, {
      ok: true, action: "queue-status",
      queued: jobs.length,
      jobs,
      nodes: nodeList,
      nodes_online: nodeList.filter(n => n.online).length,
      results: results.slice(-20).reverse(),
      total_completed: results.length
    });
  }

  // ── dashboard: flush queue ─────────────────────────────────────────────────
  if (request.method === "POST" && action === "flush-queue") {
    await writeQueue([]);
    return jsonResponse(200, { ok: true, action: "flush-queue" });
  }

  // ── dashboard: clear results ───────────────────────────────────────────────
  if (request.method === "POST" && action === "clear-results") {
    await store().setJSON("results", []);
    return jsonResponse(200, { ok: true, action: "clear-results" });
  }

  // ── default: basic status ──────────────────────────────────────────────────
  const queueCount = (await readQueue()).length;
  return jsonResponse(200, {
    ok: true, action, method: request.method, queue_count: queueCount
  });
};
