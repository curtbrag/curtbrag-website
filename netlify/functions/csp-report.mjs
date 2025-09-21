export async function handler(event, context) {
  // Accept CSP reports and drop. Keep it 204 so browsers don't whine.
  return { statusCode: 204, headers: { 'content-type': 'text/plain' }, body: '' };
}