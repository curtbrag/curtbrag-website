export async function handler(event, context) {
  // Stub CSP report endpoint. Accept and drop.
  return { statusCode: 204, headers: { 'content-type': 'text/plain' }, body: '' };
}
