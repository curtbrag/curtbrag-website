async function handler(event, context) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, function: "chat", note: "temporary stub" })
  };
}
module.exports = { handler };