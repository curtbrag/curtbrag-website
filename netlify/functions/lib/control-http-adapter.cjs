'use strict';

// Keep the existing HTTP contract while using Netlify's modern function runtime.
async function toLegacyEvent(request) {
  const url = new URL(request.url);
  const headers = Object.create(null), multiValueHeaders = Object.create(null);
  request.headers.forEach((value, key) => {
    headers[key] = value;
    multiValueHeaders[key] = [value];
  });
  const queryStringParameters = Object.create(null), multiValueQueryStringParameters = Object.create(null);
  url.searchParams.forEach((value, key) => {
    queryStringParameters[key] = value;
    (multiValueQueryStringParameters[key] ||= []).push(value);
  });
  return {
    rawUrl: url.toString(), rawQuery: url.search.slice(1), path: url.pathname,
    httpMethod: request.method, headers, multiValueHeaders,
    queryStringParameters: Object.keys(queryStringParameters).length ? queryStringParameters : null,
    multiValueQueryStringParameters: Object.keys(multiValueQueryStringParameters).length ? multiValueQueryStringParameters : null,
    body: request.body ? await request.text() : null, isBase64Encoded: false,
  };
}

function toWebResponse(result, method) {
  const headers = new Headers(result.headers || {});
  for (const [key, values] of Object.entries(result.multiValueHeaders || {})) {
    headers.delete(key);
    for (const value of values) headers.append(key, value);
  }
  const status = result.statusCode;
  const body = method === 'HEAD' || [204, 205, 304].includes(status) ? null :
    result.isBase64Encoded ? Buffer.from(result.body || '', 'base64') : result.body ?? null;
  return new Response(body, { status, headers });
}

function createLegacyFunction(handler) {
  if (typeof handler !== 'function') throw new TypeError('A legacy request handler is required.');
  return async (request, context) => {
    const event = await toLegacyEvent(request);
    return toWebResponse(await handler(event, context), request.method);
  };
}

module.exports = { createLegacyFunction, toLegacyEvent, toWebResponse };
