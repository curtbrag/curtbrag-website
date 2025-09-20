export async function handler(event, context) {
  const isScheduled =
    (event && event.headers && event.headers["x-netlify-scheduled-function"] === "true") ||
    (event && event.type === "scheduled") ||
    (event && typeof event.cron === "string");

  try {
    // TODO: your real refresh logic here
    // await refreshScores();

    const payload = {
      ok: true,
      mode: isScheduled ? "scheduled" : "http",
      when: new Date().toISOString()
    };

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    };
  } catch (err) {
    console.error("sports-refresh error:", err);
    return {
      statusCode: 500,
      headers: { "content-type": "text/plain" },
      body: "sports-refresh failed"
    };
  }
}