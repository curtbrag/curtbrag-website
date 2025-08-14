import { schedule } from '@netlify/functions';
import { Blobs } from '@netlify/blobs';

/*
 * Scheduled Netlify function to refresh sports data for Boston teams.
 *
 * The cron expression "0 7 * * *" runs the task daily at 07:00 UTC (≈3 AM ET in summer).
 * Each run fetches the latest game results and standings for the Boston
 * teams and stores them in Netlify Blobs storage under `sports/boston.json`.
 *
 * NOTE: In this sample implementation, the API calls are stubbed out. You
 * should replace the placeholder data with real requests to your chosen
 * sports API (e.g. MLB Stats API, ESPN endpoints). The structure of the
 * stored JSON should remain consistent so that the frontend can render
 * correctly.
 */
export const handler = schedule('0 7 * * *', async () => {
  const blobs = new Blobs();

  // Placeholder data — update this section to fetch real data from your sports API.
  const now = new Date();
  const data = {
    updatedAt: now.toISOString(),
    teams: [
      {
        id: 'celtics',
        name: 'Boston Celtics',
        record: '0‑0',
        nextGame: 'TBD',
      },
      {
        id: 'bruins',
        name: 'Boston Bruins',
        record: '0‑0',
        nextGame: 'TBD',
      },
      {
        id: 'patriots',
        name: 'New England Patriots',
        record: '0‑0',
        nextGame: 'TBD',
      },
      {
        id: 'redsox',
        name: 'Boston Red Sox',
        record: '0‑0',
        nextGame: 'TBD',
      },
      {
        id: 'revolution',
        name: 'New England Revolution',
        record: '0‑0',
        nextGame: 'TBD',
      },
    ],
  };

  // Serialize and store the JSON data in Netlify Blobs.  The key name
  // determines the path from which the public function will retrieve it.
  await blobs.set('sports/boston.json', JSON.stringify(data));
});