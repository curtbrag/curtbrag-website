import { getStore } from "@netlify/blobs";

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

function openStore() {
  return getStore("swarm-queue");
}

async function readQueue() {
  try {
    return (await openStore().get("jobs", { type: "json" })) || [];
  } catch {
    return [];
  }
}

async function writeQueue(jobs) {
  try {
    await openStore().setJSON("jobs", jobs);
    return true;
  } catch {
    return false;
  }
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
  } catch {
    body = {};
  }

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
      ok: true,
      message: "swarm-core live",
      action: "enqueue",
      enqueued: !exists,
      already_present: exists,
      job_id: job.id,
      queue_count: (await readQueue()).length
    });
  }

  // ── swarm-poll ─────────────────────────────────────────────────────────────
  if (request.method === "GET" && action === "swarm-poll") {
    const deviceId = url.searchParams.get("device_id") || "";
    const jobs = (await readQueue()).filter(j => {
      if (!j || typeof j !== "object") return false;
      if (!j.id || !j.type) return false;
      if (!j.device_id) return true;
      return j.device_id === deviceId;
    });

    return jsonResponse(200, {
      ok: true,
      message: "swarm-core live",
      action: "swarm-poll",
      jobs,
      queue_count: jobs.length
    });
  }

  // ── job-complete (posted by node-swarm.sh after execution) ────────────────
  if (request.method === "POST" && action === "job-complete") {
    const { job_id } = body;
    if (job_id) {
      const jobs = await readQueue();
      await writeQueue(jobs.filter(j => j && j.id !== job_id));
    }
    return jsonResponse(200, {
      ok: true,
      message: "swarm-core live",
      action: "job-complete"
    });
  }

  // ── job-update (alias for job-complete, dequeues by job_id) ───────────────
  if (request.method === "POST" && action === "job-update") {
    const { job_id } = body;
    if (job_id) {
      const jobs = await readQueue();
      await writeQueue(jobs.filter(j => j && j.id !== job_id));
    }
    return jsonResponse(200, {
      ok: true,
      message: "swarm-core live",
      action: "job-update",
      received: true
    });
  }

  // ── heartbeat ──────────────────────────────────────────────────────────────
  if (request.method === "POST" && action === "heartbeat") {
    return jsonResponse(200, {
      ok: true,
      message: "swarm-core live",
      action: "heartbeat",
      received: true
    });
  }

  // ── default: status ────────────────────────────────────────────────────────
  const queueCount = (await readQueue()).length;
  return jsonResponse(200, {
    ok: true,
    message: "swarm-core live",
    action,
    method: request.method,
    queue_count: queueCount
  });
};
