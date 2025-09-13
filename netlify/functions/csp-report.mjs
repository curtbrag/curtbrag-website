export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: { allow: "POST" }, body: "Method Not Allowed" };
  }

  const bodyText = event.body || "";
  let parsed;
  try { parsed = JSON.parse(bodyText); } catch { /* keep raw */ }

  // Handle both legacy { "csp-report": {...} } and L3 arrays
  const entries = [];
  if (parsed) {
    if (Array.isArray(parsed)) entries.push(...parsed);
    else if (parsed["csp-report"]) entries.push(parsed["csp-report"]);
    else entries.push(parsed);
  } else {
    entries.push({ raw: bodyText });
  }

  console.log("csp-report", {
    count: entries.length,
    entries,
    ua: event.headers?.["user-agent"],
    url: event.headers?.["referer"],
    ip: event.headers?.["x-nf-client-connection-ip"] || event.headers?.["client-ip"]
  });

  return { statusCode: 204 };
}