import { Blobs } from '@netlify/blobs';

/*
 * Scheduled Netlify function to refresh sports data for Boston teams.
 * Runs daily at 07:00 UTC (configured in netlify.toml).
 * Replace the placeholder data with real API calls as needed.
 */
export const handler = async () => {
  const blobs = new Blobs();

  const now = new Date();
  const data = {
    updatedAt: now.toISOString(),
    teams: [
      { id: 'celtics',    name: 'Boston Celtics',         record: '0-0', nextGame: 'TBD' },
      { id: 'bruins',     name: 'Boston Bruins',          record: '0-0', nextGame: 'TBD' },
      { id: 'patriots',   name: 'New England Patriots',   record: '0-0', nextGame: 'TBD' },
      { id: 'redsox',     name: 'Boston Red Sox',         record: '0-0', nextGame: 'TBD' },
      { id: 'revolution', name: 'New England Revolution', record: '0-0', nextGame: 'TBD' }
    ]
  };

  await blobs.set('sports/boston.json', JSON.stringify(data));

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Sports data refreshed', updatedAt: data.updatedAt, teamCount: data.teams.length })
  };
};
