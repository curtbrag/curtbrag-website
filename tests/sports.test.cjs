const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../netlify/functions/sports.mjs'), 'utf8')
  .replace('export async function handler', 'async function handler');
function match(home, away, date = '2026-10-24T21:30:00Z') {
  return { date, status: { type: { state: 'pre' } }, competitions: [{ competitors: [
    { homeAway: 'home', team: home }, { homeAway: 'away', team: away },
  ] }] };
}
async function request(responder) {
  const handler = vm.runInNewContext(source + ';handler', {
    fetch: responder, AbortSignal, Date, console: { error() {} },
  });
  const result = await handler({ headers: {} });
  assert.equal(result.statusCode, 200);
  return JSON.parse(result.body);
}
test('Revolution does not match New York or another team containing NE', async () => {
  const wrong = match({ displayName: 'New York Red Bulls', abbreviation: 'RBNY' },
    { displayName: 'Inter Miami CF', abbreviation: 'MIA' });
  const data = await request(async url => ({ ok: true, json: async () => ({ events: url.includes('usa.1') ? [wrong] : [] }) }));
  assert.equal(data.teams.revolution, 'No game scheduled');
});
test('exact abbreviation matches and scheduled time is shown in Boston time', async () => {
  const game = match({ displayName: 'New England Revolution', abbreviation: 'NE' },
    { displayName: 'Inter Miami CF', abbreviation: 'MIA' });
  const data = await request(async () => ({ ok: true, json: async () => ({ events: [game] }) }));
  assert.match(data.teams.revolution, /MIA @ NE/);
  assert.match(data.teams.revolution, /5:30 PM EDT/);
});
test('HTTP, network and malformed responses are unavailable, never no-game results', async () => {
  for (const responder of [async () => ({ ok: false }), async () => { throw new Error('offline'); },
    async () => ({ ok: true, json: async () => ({ error: 'bad data' }) })]) {
    const data = await request(responder);
    assert.equal(data.unavailable.length, 5);
    assert.equal(Object.values(data.teams).every(x => x === 'Scores temporarily unavailable'), true);
  }
});
test('one failed source preserves the other four leagues and bounds each request', async () => {
  const data = await request(async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: !url.includes('/nba/'), json: async () => ({ events: [] }) };
  });
  assert.deepEqual(data.unavailable, ['celtics']);
  assert.equal(data.teams.patriots, 'No game scheduled');
});
