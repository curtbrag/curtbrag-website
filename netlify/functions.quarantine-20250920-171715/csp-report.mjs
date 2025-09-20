export async function handler(event, context) {
  // Accept CSP violation reports silently
  return { statusCode: 204, headers: { 'content-type': 'text/plain' }, body: '' };
}