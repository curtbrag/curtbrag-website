/* Netlify Function: /stocks/health */
export async function handler() {
  try {
    const key = process.env.ALPHAVANTAGE_KEY || "";
    const context = process.env.CONTEXT || null;

    const result = {
      env: { hasKey: Boolean(key), context },
      alpha: null
    };

    if (key) {
      const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=SNA&apikey=${key}`;
      const r = await fetch(url, { cache: "no-store" });
      result.alpha = { ok: r.ok, status: r.status };
    }

    return json(result);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
function json(obj, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj)
  };
}
