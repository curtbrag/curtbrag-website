const fs = require("fs");
const path = require("path");

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "https://curtbrag.com",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization"
    },
    body: JSON.stringify(body)
  };
}

function readQueue() {
  try {
    const p = path.join(__dirname, "job-queue.json");
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch (e) {
    return [];
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "access-control-allow-origin": "https://curtbrag.com",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Content-Type, Authorization"
      },
      body: ""
    };
  }

  const qs = event.queryStringParameters || {};
  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (_) {
    body = {};
  }

  const action = qs.action || body.action || "";

  if (event.httpMethod === "GET" && action === "swarm-poll") {
    const deviceId = qs.device_id || "";
    const jobs = readQueue().filter((job) => {
      if (!job || typeof job !== "object") return false;
      if (!job.id || !job.type) return false;
      if (!job.device_id) return true;
      return job.device_id === deviceId;
    });
    return json(200, { jobs });
  }

  if (event.httpMethod === "POST" && action === "job-update") {
    return json(200, { ok: true, received: true, action: "job-update" });
  }

  if (event.httpMethod === "POST" && action === "heartbeat") {
    return json(200, { ok: true, received: true, action: "heartbeat" });
  }

  return json(200, {
    ok: true,
    message: "cluster-api2 alive",
    action,
    method: event.httpMethod
  });
};