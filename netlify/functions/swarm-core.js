const { connectLambda, getStore } = require("@netlify/blobs");

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization"
    },
    body: JSON.stringify(body)
  };
}

function openStore() {
  const siteID =
    process.env.NETLIFY_BLOBS_SITE_ID ||
    process.env.SITE_ID ||
    undefined;
  const token =
    process.env.NETLIFY_BLOBS_TOKEN ||
    process.env.NETLIFY_ACCESS_TOKEN ||
    process.env.NETLIFY_TOKEN ||
    undefined;
  if (siteID && token) return getStore("swarm-queue", { siteID, token });
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

exports.handler = async (event) => {
  connectLambda(event);

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Content-Type, Authorization"
      },
      body: ""
    };
  }

  const qs = event.queryStringParameters || {};
  const action = qs.action || "";

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    body = {};
  }

  if (event.httpMethod === "POST" && action === "enqueue") {
    const job = body.job;
    if (!job || typeof job !== "object" || !job.id || !job.type) {
      return json(400, { ok: false, error: "invalid job payload" });
    }

    const jobs = await readQueue();
    const exists = jobs.some(j => j && j.id === job.id);

    if (!exists) {
      jobs.push({ ...job, queued_at: Date.now() });
      await writeQueue(jobs);
    }

    return json(200, {
      ok: true,
      message: "swarm-core live",
      action: "enqueue",
      enqueued: !exists,
      already_present: exists,
      job_id: job.id,
      queue_count: (await readQueue()).length
    });
  }

  if (event.httpMethod === "GET" && action === "swarm-poll") {
    const deviceId = qs.device_id || "";
    const jobs = (await readQueue()).filter(j => {
      if (!j || typeof j !== "object") return false;
      if (!j.id || !j.type) return false;
      if (!j.device_id) return true;
      return j.device_id === deviceId;
    });

    return json(200, {
      ok: true,
      message: "swarm-core live",
      action: "swarm-poll",
      jobs,
      queue_count: jobs.length
    });
  }

  if (event.httpMethod === "POST" && action === "job-complete") {
    const { job_id } = body;
    if (job_id) {
      const jobs = await readQueue();
      await writeQueue(jobs.filter(j => j && j.id !== job_id));
    }
    return json(200, { ok: true, message: "swarm-core live", action: "job-complete" });
  }

  if (event.httpMethod === "POST" && action === "job-update") {
    return json(200, { ok: true, message: "swarm-core live", received: true, action: "job-update" });
  }

  if (event.httpMethod === "POST" && action === "heartbeat") {
    return json(200, { ok: true, message: "swarm-core live", received: true, action: "heartbeat" });
  }

  // Default: status + queue count
  const queueCount = (await readQueue()).length;
  return json(200, {
    ok: true,
    message: "swarm-core live",
    action,
    method: event.httpMethod,
    queue_count: queueCount
  });
};
