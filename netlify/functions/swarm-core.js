const fs = require("fs");
const path = require("path");

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

function queuePath() {
  return path.join(__dirname, "job-queue.json");
}

function readQueue() {
  try {
    const raw = fs.readFileSync(queuePath(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch (e) {
    return [];
  }
}

function writeQueue(jobs) {
  try {
    fs.writeFileSync(queuePath(), JSON.stringify({ jobs }, null, 2), "utf8");
    return true;
  } catch (e) {
    return false;
  }
}

exports.handler = async (event) => {
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

    const jobs = readQueue();
    const exists = jobs.some(j => j && j.id === job.id);

    if (!exists) {
      jobs.push(job);
      writeQueue(jobs);
    }

    return json(200, {
      ok: true,
      message: "swarm-core live",
      action: "enqueue",
      enqueued: !exists,
      already_present: exists,
      job_id: job.id,
      queue_count: readQueue().length
    });
  }

  if (event.httpMethod === "GET" && action === "swarm-poll") {
    const deviceId = qs.device_id || "";
    const jobs = readQueue().filter(j => {
      if (!j || typeof j !== "object") return false;
      if (!j.id || !j.type) return false;
      if (!j.device_id) return true;
      return j.device_id === deviceId;
    });

    return json(200, {
      ok: true,
      message: "swarm-core live",
      action: "swarm-poll",
      jobs
    });
  }

  if (event.httpMethod === "POST" && action === "job-update") {
    return json(200, { ok: true, message: "swarm-core live", received: true, action: "job-update" });
  }

  if (event.httpMethod === "POST" && action === "heartbeat") {
    return json(200, { ok: true, message: "swarm-core live", received: true, action: "heartbeat" });
  }

  return json(200, {
    ok: true,
    message: "swarm-core live",
    action,
    method: event.httpMethod
  });
};