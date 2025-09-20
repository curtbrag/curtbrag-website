export async function handler(event, context) {
  // Accept CSP violation reports via POST; no-op otherwise.
  if (event && event.httpMethod && event.httpMethod.toUpperCase() !== "POST") {
    return { statusCode: 405, headers: { "Allow": "POST" }, body: "" };
  }
  try { const data = event && event.body ? JSON.parse(event.body) : null; void data; } catch {}
  return { statusCode: 204, body: "" };
}