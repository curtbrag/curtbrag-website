// Netlify Function: /stocks/sna
export async function handler() {
  try {
    const key = process.env.ALPHAVANTAGE_KEY;
    if (!key) throw new Error("Missing ALPHAVANTAGE_KEY");

    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=SNA&apikey=${key}`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`AlphaVantage HTTP ${r.status}`);
    const j = await r.json();
    const q = j["Global Quote"] || {};

    const price = Number(q["05. price"]);
    const change = Number(q["09. change"]);
    const pct = Number((q["10. change percent"] || "").replace("%", ""));

    if (!Number.isFinite(price)) throw new Error("Invalid quote data");

    return json({ quote: price, change: Number.isFinite(change) ? change : null, percent: Number.isFinite(pct) ? pct : null });
  } catch (err) {
    return json({ quote: null, change: null, percent: null, error: err.message });
  }
}

function json(obj, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj)
  };
}
