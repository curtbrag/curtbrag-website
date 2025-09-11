// Netlify Function: /sports/celtics
export async function handler() {
  try {
    // Cache team id across invocations
    if (!globalThis.__CELTICS_ID__) {
      const tResp = await fetch("https://www.balldontlie.io/api/v1/teams?search=boston%20celtics", { cache: "no-store" });
      if (!tResp.ok) throw new Error(`team search HTTP ${tResp.status}`);
      const t = await tResp.json();
      const team = (t.data || [])[0];
      if (!team) throw new Error("Celtics team not found");
      globalThis.__CELTICS_ID__ = team.id;
    }
    const teamId = globalThis.__CELTICS_ID__;

    const today = new Date().toISOString().slice(0, 10);
    const url = `https://www.balldontlie.io/api/v1/games?team_ids[]=${teamId}&dates[]=${today}&per_page=25`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`games HTTP ${r.status}`);
    const j = await r.json();
    const g = (j.data || [])[0];

    if (!g) return json({ result: "No Celtics game today." });

    const homeTeam = g.home_team.abbreviation;
    const visitorTeam = g.visitor_team.abbreviation;
    const homeScore = g.home_team_score;
    const visitorScore = g.visitor_team_score;
    const status = g.status || (g.period === 0 ? "Scheduled" : "Final");

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
