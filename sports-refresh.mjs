import { Blobs } from '@netlify/blobs';

/*
 * Scheduled Netlify function to refresh sports data for Boston teams.
 * Runs hourly (configured in netlify.toml). This implementation fetches
 * real standings and upcoming match information from ESPN’s public APIs.
 * If any request fails the default values are retained so the
 * scoreboard is never empty. ESPN’s endpoints are free and do not
 * currently require an API key (as of August 2025), but this may
 * change. If you have your own sports data provider, modify the
 * `teamConfigs` array accordingly.
 */
export const handler = async () => {
  const blobs = new Blobs();
  const now = new Date();

  // Define each team with a human‑readable name and the ESPN API
  // endpoint for their franchise. These URLs return JSON objects
  // describing the team record and next scheduled event.
  const teamConfigs = [
    {
      id: 'celtics',
      name: 'Boston Celtics',
      url: 'https://site.api.espn.com/apis/v2/sports/basketball/nba/teams/bos'
    },
    {
      id: 'bruins',
      name: 'Boston Bruins',
      url: 'https://site.api.espn.com/apis/v2/sports/hockey/nhl/teams/bos'
    },
    {
      id: 'patriots',
      name: 'New England Patriots',
      url: 'https://site.api.espn.com/apis/v2/sports/football/nfl/teams/ne'
    },
    {
      id: 'redsox',
      name: 'Boston Red Sox',
      url: 'https://site.api.espn.com/apis/v2/sports/baseball/mlb/teams/bos'
    },
    {
      id: 'revolution',
      name: 'New England Revolution',
      url: 'https://site.api.espn.com/apis/v2/sports/soccer/mls/teams/ne'
    }
  ];

  const teams = [];
  for (const cfg of teamConfigs) {
    let record = '0-0';
    let nextGame = 'TBD';
    try {
      const resp = await fetch(cfg.url);
      if (resp.ok) {
        const json = await resp.json();
        // Pull the overall record summary from the API response. The
        // record object lives at `team.record.items[0].summary` for the
        // majority of ESPN endpoints. See ESPN’s API docs for details.
        const recObj = json.team?.record?.items?.[0];
        if (recObj && typeof recObj.summary === 'string') {
          record = recObj.summary;
        }
        // Determine the next game from `team.nextEvent[0]`. Each event
        // includes a `competitions` array containing the competitors and
        // the scheduled date. We derive the opponent and format the date.
        const nextEvent = json.team?.nextEvent?.[0];
        if (nextEvent?.date) {
          const comp = nextEvent.competitions?.[0];
          const competitor = comp?.competitors?.find(c => !c.homeAway || c.homeAway.toLowerCase() !== json.team?.team?.homeAway?.toLowerCase());
          const opponentName = competitor?.team?.displayName;
          const gameDate = new Date(nextEvent.date);
          const formattedDate = gameDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          nextGame = (opponentName ? `vs ${opponentName}` : 'Next game') + ` on ${formattedDate}`;
        }
      }
    } catch (err) {
      // If any error occurs leave defaults. Logging could be added here.
    }
    teams.push({ id: cfg.id, name: cfg.name, record, nextGame });
  }

  const data = {
    updatedAt: now.toISOString(),
    teams
  };
  // Persist the refreshed data to Netlify Blobs so the public
  // function can serve it to the front‑end without recomputing on
  // every request.
  await blobs.set('sports/boston.json', JSON.stringify(data));

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Sports data refreshed', updatedAt: data.updatedAt, teamCount: data.teams.length })
  };
};