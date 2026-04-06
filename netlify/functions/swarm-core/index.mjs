import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function json(statusCode, body) {
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

function queuePath() {
  return path.join(__dirname, "job-queue.json");
}

function readQueue() {
  try {
    const raw = fs.readFileSync(queuePath(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch {
    return [];
  }
}

function writeQueue(jobs) {
  fs.writeFileSync(queuePath(), JSON.stringify({ jobs }, null, 2), "utf8");
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

  if (request.method === "GET" && action === "test") {
    return json(200, {
      ok: true,
      message: "swarm-core live",
      action: "test",
      method: request.method
    });
  }

  if (request.method === "POST" && action === "enqueue") {
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

  if (request.method === "GET" && action === "swarm-poll") {
    const deviceId = url.searchParams.get("device_id") || "";
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

  if (request.method === "POST" && action === "job-update") {
    return json(200, { ok: true, message: "swarm-core live", action: "job-update", received: true });
  }

  if (request.method === "POST" && action === "heartbeat") {
    return json(200, { ok: true, message: "swarm-core live", action: "heartbeat", received: true });
  }

  return json(200, {
    ok: true,
    message: "swarm-core live",
    action,
    method: request.method
  });
};