// Boston Sports Tracker - Fetches live scores from ESPN API

function getLeagueSport(league) {
  const sports = {
    mlb: 'baseball',
    nfl: 'football',
    nba: 'basketball',
    nhl: 'hockey'
  };
  return sports[league] || league;
}

async function fetchScoreboard(league) {
  try {
    const sport = getLeagueSport(league);
    const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return data.events || [];
  } catch (e) {
    console.error(`Error fetching ${league}:`, e);
    return [];
  }
}

async function fetchMLSScoreboard() {
  try {
    const url = 'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard';
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return data.events || [];
  } catch (e) {
    console.error('Error fetching MLS:', e);
    return [];
  }
}

function findTeamGame(events, teamNames) {
  if (!events || !events.length) return null;

  for (const event of events) {
    const competitors = event.competitions?.[0]?.competitors || [];
    const found = competitors.some(c => {
      const name = (c.team?.displayName || '').toLowerCase();
      const shortName = (c.team?.shortDisplayName || '').toLowerCase();
      const abbrev = (c.team?.abbreviation || '').toLowerCase();
      return teamNames.some(tn =>
        name.includes(tn.toLowerCase()) ||
        shortName.includes(tn.toLowerCase()) ||
        abbrev === tn.toLowerCase()
      );
    });
    if (found) return event;
  }
  return null;
}

function formatGame(event) {
  if (!event) return 'No game scheduled';

  const competition = event.competitions?.[0];
  if (!competition) return 'No game data';

  const competitors = competition.competitors || [];
  const home = competitors.find(c => c.homeAway === 'home');
  const away = competitors.find(c => c.homeAway === 'away');

  if (!home || !away) return 'Game data unavailable';

  const status = event.status?.type?.shortDetail || event.status?.type?.description || '';
  const homeScore = home.score || '0';
  const awayScore = away.score || '0';
  const homeName = home.team?.abbreviation || home.team?.shortDisplayName || 'Home';
  const awayName = away.team?.abbreviation || away.team?.shortDisplayName || 'Away';

  // Check if game is live, final, or scheduled
  const state = event.status?.type?.state || '';

  if (state === 'pre') {
    const gameDate = new Date(event.date);
    const options = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    return `Next: ${awayName} @ ${homeName} - ${gameDate.toLocaleDateString('en-US', options)}`;
  }

  return `${awayName} ${awayScore} @ ${homeName} ${homeScore} (${status})`;
}

async function fetchTeamRecord(league, teamId) {
  try {
    const sport = getLeagueSport(league);
    const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${teamId}`;
    const res = await fetch(url);
    if (!res.ok) return '';
    const data = await res.json();
    const record = data.team?.record?.items?.[0]?.summary;
    return record ? ` | Record: ${record}` : '';
  } catch (e) {
    return '';
  }
}

export async function handler(event, context) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300'
  };

  try {
    // Fetch all scoreboards in parallel
    const [mlbGames, nflGames, nbaGames, nhlGames, mlsGames] = await Promise.all([
      fetchScoreboard('mlb'),
      fetchScoreboard('nfl'),
      fetchScoreboard('nba'),
      fetchScoreboard('nhl'),
      fetchMLSScoreboard()
    ]);

    // Find Boston team games
    const redsoxGame = findTeamGame(mlbGames, ['Red Sox', 'Boston', 'BOS']);
    const patriotsGame = findTeamGame(nflGames, ['Patriots', 'New England', 'NE']);
    const celticsGame = findTeamGame(nbaGames, ['Celtics', 'Boston', 'BOS']);
    const bruinsGame = findTeamGame(nhlGames, ['Bruins', 'Boston', 'BOS']);
    const revolutionGame = findTeamGame(mlsGames, ['Revolution', 'New England', 'NE']);

    const results = {
      redsox: formatGame(redsoxGame),
      patriots: formatGame(patriotsGame),
      celtics: formatGame(celticsGame),
      bruins: formatGame(bruinsGame),
      revolution: formatGame(revolutionGame)
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        updated: new Date().toISOString(),
        teams: results
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: error.message,
        teams: {
          redsox: 'Data unavailable',
          patriots: 'Data unavailable',
          celtics: 'Data unavailable',
          bruins: 'Data unavailable',
          revolution: 'Data unavailable'
        }
      })
    };
  }
}
