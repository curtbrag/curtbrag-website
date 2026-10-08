const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLegacyFunction, toLegacyEvent, toWebResponse } = require('../netlify/functions/lib/control-http-adapter.cjs');

test('modern request maps exact path, query repetitions, body and authentication headers', async () => {
  const body = '{"action":"complete","output":"line\\nvalue"}';
  const request = new Request('https://fixture.invalid/api/agent/command-result?action=complete&target=phone253&target=phone191&empty=', {
    method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Agent-Token': 'fixture-agent', 'X-Device-Id': 'fixture-phone' },
  });
  const event = await toLegacyEvent(request);
  assert.equal(event.path, '/api/agent/command-result');
  assert.equal(event.rawQuery, 'action=complete&target=phone253&target=phone191&empty=');
  assert.equal(event.rawUrl, request.url);
  assert.equal(event.httpMethod, 'POST');
  assert.equal(event.headers['x-agent-token'], 'fixture-agent');
  assert.equal(event.headers['x-device-id'], 'fixture-phone');
  assert.deepEqual({ ...event.queryStringParameters }, { action: 'complete', target: 'phone191', empty: '' });
  assert.deepEqual(event.multiValueQueryStringParameters.target, ['phone253', 'phone191']);
  assert.equal(event.body, body);
  assert.equal(event.isBase64Encoded, false);
  assert.equal(event.blobs, undefined);
});

test('query names matching object properties remain ordinary values and comma headers stay intact', async () => {
  const event = await toLegacyEvent(new Request('https://fixture.invalid/?constructor=one&constructor=two&toString=three&__proto__=four', {
    headers: { 'X-Fixture': 'one, two', 'Constructor': 'header-value' },
  }));
  assert.deepEqual({ ...event.queryStringParameters }, { constructor: 'two', toString: 'three', ['__proto__']: 'four' });
  assert.deepEqual(event.multiValueQueryStringParameters.constructor, ['one', 'two']);
  assert.deepEqual(event.multiValueQueryStringParameters.toString, ['three']);
  assert.deepEqual(event.multiValueQueryStringParameters.__proto__, ['four']);
  assert.equal(Object.getPrototypeOf(event.queryStringParameters), null);
  assert.equal(event.headers.constructor, 'header-value');
  assert.deepEqual(event.multiValueHeaders['x-fixture'], ['one, two']);
});

test('wrapper passes modern context without legacy runtime fields and preserves HTTP response', async () => {
  const context = { requestId: 'fixture-request', ip: '192.0.2.1' };
  const handler = createLegacyFunction(async (event, received) => {
    assert.equal(received, context);
    assert.equal(event.body, null);
    assert.equal(event.queryStringParameters, null);
    assert.equal(event.blobs, undefined);
    return { statusCode: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://curtbrag.com' }, body: '{"error":"Unauthorized"}' };
  });
  const response = await handler(new Request('https://fixture.invalid/.netlify/functions/agent-api/commands'), context);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://curtbrag.com');
  assert.equal(await response.text(), '{"error":"Unauthorized"}');
});

test('malformed JSON reaches existing handler unchanged and its error response is preserved', async () => {
  const malformed = '{"action":';
  const handler = createLegacyFunction(async event => {
    assert.equal(event.body, malformed);
    try { JSON.parse(event.body); } catch (_) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: '{"error":"Invalid JSON"}' };
    }
    assert.fail('Malformed JSON must not be repaired by the wrapper');
  });
  const response = await handler(new Request('https://fixture.invalid/.netlify/functions/cluster-control', { method: 'POST', body: malformed }));
  assert.equal(response.status, 400);
  assert.equal(await response.text(), '{"error":"Invalid JSON"}');
});

test('empty OPTIONS/204 responses use null bodies and retain CORS headers', async () => {
  const handler = createLegacyFunction(async event => {
    assert.equal(event.httpMethod, 'OPTIONS');
    return { statusCode: 204, headers: { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }, body: '' };
  });
  const response = await handler(new Request('https://fixture.invalid/.netlify/functions/cluster-api', { method: 'OPTIONS' }));
  assert.equal(response.status, 204);
  assert.equal(response.body, null);
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
});

test('binary response and multiple cookies are preserved; HEAD suppresses response body', async () => {
  const response = toWebResponse({ statusCode: 200, headers: { 'Content-Type': 'application/octet-stream' },
    multiValueHeaders: { 'Set-Cookie': ['fixture-a=1; HttpOnly', 'fixture-b=2; Secure'] }, body: 'AP8B', isBase64Encoded: true }, 'GET');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 255, 1]);
  assert.deepEqual(response.headers.getSetCookie(), ['fixture-a=1; HttpOnly', 'fixture-b=2; Secure']);
  assert.equal(toWebResponse({ statusCode: 200, body: 'suppressed' }, 'HEAD').body, null);
});

test('unexpected handler exceptions propagate without conversion to an accepted response', async () => {
  const failure = new Error('fixture-storage-unavailable');
  const handler = createLegacyFunction(async () => { throw failure; });
  await assert.rejects(handler(new Request('https://fixture.invalid/.netlify/functions/cluster-control')), error => error === failure);
});

test('each public function has only a modern default entrypoint and its retained implementation', () => {
  const functions = path.join(__dirname, '../netlify/functions');
  for (const name of ['agent-api', 'cluster-control']) {
    assert.equal(fs.existsSync(path.join(functions, name + '.js')), false);
    assert.ok(fs.existsSync(path.join(functions, 'lib', name + '.cjs')));
    const source = fs.readFileSync(path.join(functions, name + '.mjs'), 'utf8');
    assert.ok(source.includes("import legacy from './lib/" + name + ".cjs'"));
    assert.ok(source.includes('export default adapter.createLegacyFunction(legacy.handler)'));
    assert.equal(source.includes('connectLambda'), false);
  }
});
