export async function handler(event, context) {
  // Temporary stub: keep build green. Replace with real refresh logic when ready.
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, function: "sports-refresh", note: "temporary stub" })
  };
}