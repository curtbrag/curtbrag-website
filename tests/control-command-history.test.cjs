const test = require('node:test');
const assert = require('node:assert/strict');
const { commandHistoryTime, normalizeCommandHistory, orderCommandHistory } = require('../netlify/functions/lib/control-command-history.cjs');

const CREATED = Date.parse('2026-10-08T01:00:00.000Z');
const FINISHED = Date.parse('2026-10-08T02:00:00.000Z');
const CANCELLED = Date.parse('2026-10-08T03:00:00.000Z');

test('mixed snake and camel completion times order by valid completion rather than creation', () => {
  const records = [
    { id: 'legacy-new', queuedAt: '2026-10-08T00:00:00Z', completedAt: '2026-10-08T02:00:00Z' },
    { id: 'cp-old', created_at: CREATED, finished_at: CREATED + 1 },
    { id: 'snake-newest', created_at: 1, completed_at: CANCELLED },
  ];
  assert.deepEqual(orderCommandHistory(records).map(record => record.id), ['cp-old', 'legacy-new', 'snake-newest']);
});

test('canonical valid finish has precedence; invalid finish falls through camel then alternate snake', () => {
  assert.equal(commandHistoryTime({ finished_at: FINISHED, completedAt: CANCELLED, completed_at: CANCELLED + 1 }), FINISHED);
  assert.equal(commandHistoryTime({ finished_at: null, completedAt: FINISHED, completed_at: CANCELLED }), FINISHED);
  assert.equal(commandHistoryTime({ finished_at: 'bad', completedAt: false, completed_at: FINISHED }), FINISHED);
  assert.equal(commandHistoryTime({ finished_at: 0, completedAt: '', completed_at: NaN, created_at: CREATED }), CREATED);
});

test('valid ISO dates with offsets and fractional seconds preserve the actual instant', () => {
  assert.equal(commandHistoryTime({ completedAt: '2026-10-08T04:00:00+02:00' }), FINISHED);
  assert.equal(commandHistoryTime({ completedAt: '2026-10-08T02:00:00.123456Z' }), FINISHED + 123);
  assert.equal(commandHistoryTime({ queuedAt: '2026-10-08' }), Date.parse('2026-10-08T00:00:00Z'));
  assert.equal(commandHistoryTime({ queuedAt: '2024-02-29T00:00:00Z' }), Date.parse('2024-02-29T00:00:00Z'));
});

test('null empty boolean locale numeric-string and malformed dates do not become current timestamps', () => {
  const invalid = [undefined, null, '', ' ', false, true, 0, -1, NaN, Infinity, 1e30,
    String(FINISHED), '10/08/2026', '2026', '2026-02-30T00:00:00Z', '2023-02-29', '2026-13-08',
    '2026-10-08T02:00:00', '2026-10-08T25:00:00Z', '2026-10-08T24:01:00Z', '2026-10-08T02:00:60Z'];
  for (const value of invalid) {
    assert.equal(commandHistoryTime({ finished_at: value }), 0, 'Invalid finish: ' + String(value));
    assert.equal(commandHistoryTime({ finished_at: value, queuedAt: CREATED }), CREATED);
  }
});

test('normalization adds canonical legacy dates without mutating or dropping original metadata', () => {
  const result = { output: 'old result', exit_code: 7 };
  const legacy = { id: 'legacy', queuedAt: '2026-10-08T01:00:00Z', completedAt: '2026-10-08T02:00:00Z', result, source: 'legacy' };
  const normalized = normalizeCommandHistory(legacy);
  assert.notEqual(normalized, legacy);
  assert.deepEqual(normalized, { ...legacy, created_at: CREATED, finished_at: FINISHED });
  assert.equal(normalized.result, result);
  assert.equal(Object.hasOwn(legacy, 'created_at'), false);
  assert.equal(Object.hasOwn(legacy, 'finished_at'), false);
});

test('existing canonical fields remain unchanged including invalid values while sort uses valid fallback', () => {
  const record = { created_at: null, finished_at: 'invalid-original', queuedAt: CREATED, completedAt: FINISHED, error: 'legacy detail' };
  assert.deepEqual(normalizeCommandHistory(record), record);
  assert.equal(commandHistoryTime(normalizeCommandHistory(record)), FINISHED);
  const canonical = { created_at: CREATED, finished_at: FINISHED, completedAt: CANCELLED };
  assert.deepEqual(normalizeCommandHistory(canonical), canonical);
});

test('invalid legacy dates never create canonical fields', () => {
  const record = { id: 'unknown-date', queuedAt: '', completedAt: null, completed_at: 'bad' };
  assert.deepEqual(normalizeCommandHistory(record), record);
  assert.equal(commandHistoryTime(normalizeCommandHistory(record)), 0);
});

test('later pending cancellation determines chronology while preserving original terminal metadata', () => {
  const terminal = { id: 'same-id', status: 'completed', finished_at: FINISHED, output: 'original', pending_cancelled_at: CANCELLED,
    cancelled_pending_record: { status: 'held', id: 'same-id' } };
  assert.equal(commandHistoryTime(terminal), CANCELLED);
  assert.deepEqual(normalizeCommandHistory(terminal), terminal);
  assert.equal(orderCommandHistory([{ id: 'between', finished_at: FINISHED + 1 }, terminal])[1], terminal);
});

test('older or invalid cancellation cannot make a terminal result appear earlier', () => {
  assert.equal(commandHistoryTime({ finished_at: FINISHED, pending_cancelled_at: CREATED }), FINISHED);
  assert.equal(commandHistoryTime({ finished_at: FINISHED, pending_cancelled_at: '' }), FINISHED);
  assert.equal(commandHistoryTime({ created_at: CREATED, pending_cancelled_at: CANCELLED }), CANCELLED);
});

test('legacy timestamp is a last fallback after valid completion and creation metadata', () => {
  assert.equal(commandHistoryTime({ timestamp: FINISHED }), FINISHED);
  assert.equal(commandHistoryTime({ created_at: CREATED, timestamp: FINISHED }), CREATED);
  assert.equal(commandHistoryTime({ queuedAt: CREATED, timestamp: FINISHED }), CREATED);
  assert.equal(commandHistoryTime({ finished_at: FINISHED, timestamp: CANCELLED }), FINISHED);
  assert.equal(commandHistoryTime({ created_at: null, queuedAt: 'bad', timestamp: '2026-10-08T02:00:00Z' }), FINISHED);
  assert.deepEqual(normalizeCommandHistory({ timestamp: FINISHED }), { timestamp: FINISHED });
});

test('ordering is stable for ties and unknown timestamps without mutating input or record identity', () => {
  const missingA = { id: 'missing-a' }, missingB = { id: 'missing-b', finished_at: null };
  const tieA = { id: 'tie-a', finished_at: FINISHED }, tieB = { id: 'tie-b', completedAt: FINISHED };
  const records = [tieA, missingA, tieB, missingB], before = records.slice();
  const ordered = orderCommandHistory(records);
  assert.deepEqual(ordered, [missingA, missingB, tieA, tieB]);
  assert.deepEqual(records, before);
  assert.notEqual(ordered, records);
  assert.equal(ordered[2], tieA);
});

test('selecting last 200 after mixed history order retains newest canonical and legacy records', () => {
  const cp = [{ id: 'recent-cp', finished_at: CANCELLED }];
  const legacy = Array.from({ length: 210 }, (_, index) => ({ id: 'legacy-' + index, completedAt: CREATED + index }));
  const retained = orderCommandHistory([...cp, ...legacy]).slice(-200);
  assert.equal(retained.length, 200);
  assert.equal(retained.at(-1).id, 'recent-cp');
  assert.equal(retained[0].id, 'legacy-11');
});

test('non-record values remain untimed and cannot invent normalized metadata', () => {
  for (const value of [null, undefined, false, 'record', 42, []]) {
    assert.equal(commandHistoryTime(value), 0);
    assert.equal(normalizeCommandHistory(value), value);
  }
  assert.deepEqual(orderCommandHistory(null), []);
});
