'use strict';

const MAX_DATE_TIME = 8640000000000000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2}))?$/i;

function validTime(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 && value <= MAX_DATE_TIME ? value : 0;
  }
  if (typeof value !== 'string') return 0;
  const parts = ISO_DATE.exec(value);
  if (!parts) return 0;
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return 0;
  if (parts[4] !== undefined) {
    const hour = Number(parts[4]), minute = Number(parts[5]), second = Number(parts[6]);
    if (hour > 24 || minute > 59 || second > 59 || (hour === 24 && (minute || second || Number(parts[7] || 0)))) return 0;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 ? time : 0;
}

function firstTime(record, fields) {
  for (const field of fields) {
    const time = validTime(record[field]);
    if (time) return time;
  }
  return 0;
}

function isRecord(record) { return record !== null && typeof record === 'object' && !Array.isArray(record); }

function commandHistoryTime(record) {
  if (!isRecord(record)) return 0;
  const terminal = firstTime(record, ['finished_at', 'completedAt', 'completed_at']);
  const created = firstTime(record, ['created_at', 'queuedAt', 'timestamp']);
  return Math.max(terminal || created, validTime(record.pending_cancelled_at));
}

function normalizeCommandHistory(record) {
  if (!isRecord(record)) return record;
  const normalized = { ...record };
  if (!Object.prototype.hasOwnProperty.call(record, 'created_at') || record.created_at === undefined) {
    const created = validTime(record.queuedAt);
    if (created) normalized.created_at = created;
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'finished_at') || record.finished_at === undefined) {
    const finished = firstTime(record, ['completedAt', 'completed_at']);
    if (finished) normalized.finished_at = finished;
  }
  return normalized;
}

function orderCommandHistory(records) {
  if (!Array.isArray(records)) return [];
  return records.map((record, index) => ({ record, index, time: commandHistoryTime(record) }))
    .sort((a, b) => a.time - b.time || a.index - b.index)
    .map(entry => entry.record);
}

module.exports = { commandHistoryTime, normalizeCommandHistory, orderCommandHistory };
