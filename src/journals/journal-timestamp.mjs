/**
 * Journal timestamps are ISO 8601 in UTC to the second ("2026-01-01T12:34:56Z"), so they sort and
 * compare as plain strings. This turns any date (a Date, a millisecond count or an ISO string,
 * with or without milliseconds) into that form.
 * @param {Date | number | string} value
 */
export function toJournalTimestamp(value) {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
