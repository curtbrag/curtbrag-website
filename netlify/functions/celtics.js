/* Netlify Function: /sports/celtics */
export async function handler() {
  try {
    const TEAM_ID = 2; // Boston Celtics
    const today = new Date().toISOString().slice(0, 10);
    const url = `https://www.balldontlie.io/api/v1/games?team_ids[]=${TEAM_ID}&dates[]=${today}&per_page=25`;

    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`balldontlie HTTP ${r.status}`);
    const j = await r.json();

    const g = (j.data || [])[0];
    if (!g) return json({ result: "No Celtics game today." });

    const homeTeam     = g.home_team?.abbreviation ?? g.home_team?.name ?? "HOME";
    const visitorTeam  = g.visitor_team?.abbreviation ?? g.visitor_team?.name ?? "AWAY";
    const homeScore    = Number(g.home_team_score ?? 0);
    const visitorScore = Number(g.visitor_team_score ?? 0);
    const status       = g.status || (g.period === 0 ? "Scheduled" : "Final");

    return json({ game: { homeTeam, homeScore, visitorTeam, visitorScore, status } });
  } catch (err) {
    return json({ score: "No game data", error: err.message });
  }
}
function json(obj, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj)
  };
}
