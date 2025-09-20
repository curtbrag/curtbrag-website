export async function handler(event, context) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, function: "sports", note: "temporary stub" })
  };
}