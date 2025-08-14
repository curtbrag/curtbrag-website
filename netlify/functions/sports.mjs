import { Blobs } from '@netlify/blobs';

/*
 * Public Netlify function that returns the cached sports data as JSON.
 *
 * The sports-refresh scheduled function populates Netlify Blobs with
 * `sports/boston.json`. This handler simply reads the stored JSON and
 * responds with it, adding sensible cache headers. If no data exists yet,
 * it returns an empty object instead of throwing an error.
 */
export const handler = async () => {
  const blobs = new Blobs();
  let body;
  try {
    body = await blobs.get('sports/boston.json');
  } catch (err) {
    // If the file doesn’t exist, return an empty JSON object. Netlify Blobs
    // will throw if the key hasn’t been set yet.
    body = '{}';
  }
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      // Cache for 5 minutes client-side.  Adjust max-age to taste.
      'Cache-Control': 'public, max-age=300',
    },
    body,
  };
};