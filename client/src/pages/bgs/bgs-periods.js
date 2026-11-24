import { formatDateTime } from '../../format.js';

/**
 * BGS periods: the tick-to-tick ranges activity is grouped into, and how ticks are labelled.
 */

const HOUR_MS = 60 * 60 * 1000;

const RECENT_RANGES = [
  { id: 'last24h', label: 'Last 24 Hours', durationMs: 24 * HOUR_MS },
  { id: 'last48h', label: 'Last 48 Hours', durationMs: 48 * HOUR_MS },
  { id: 'last7d', label: 'Last 7 Days', durationMs: 7 * 24 * HOUR_MS },
  { id: 'last30d', label: 'Last 30 Days', durationMs: 30 * 24 * HOUR_MS },
  { id: 'last90d', label: 'Last 90 Days', durationMs: 90 * 24 * HOUR_MS },
];

const MULTI_TICK_SPANS = [2, 3, 7];

/** A Date (or ms) as a journal-style timestamp ("2026-11-20T16:52:46Z"), which the API compares against. */
function toJournalTimestamp(dateValue) {
  return new Date(dateValue).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** "2026-11-20" (a local date from a date input) -> the journal timestamp of that local midnight. */
function localDateToTimestamp(dateText, dayOffset = 0) {
  const [year, month, day] = dateText.split('-').map(Number);
  return toJournalTimestamp(new Date(year, month - 1, day + dayOffset));
}

/**
 * The periods activity can be shown for, in groups:
 * - Ticks: since the latest tick, each period between saved ticks, and before the earliest one
 *   (ticks are only known from when the app was running, so earlier activity falls there)
 * - Multiple ticks: everything since the 2nd/3rd/7th most recent tick
 * - Time ranges: rolling windows ending now, everything, or a custom date range
 * Rolling windows start on the current minute, so they refresh at most once a minute.
 * heading is the line put above the copied report, when the period has one.
 */
export function buildPeriodGroups(ticks, customRange) {
  const tickPeriods = [];
  if (ticks.length > 0) {
    tickPeriods.push({ id: 'current', label: `Current Tick (since ${formatDateTime(ticks[0])})`, from: ticks[0], to: null, heading: getTickHeading(ticks[0]) });
    for (let tickIndex = 1; tickIndex < ticks.length; tickIndex++) {
      tickPeriods.push({
        id: `tick:${ticks[tickIndex]}`,
        label: `${formatDateTime(ticks[tickIndex])} – ${formatDateTime(ticks[tickIndex - 1])}`,
        from: ticks[tickIndex],
        to: ticks[tickIndex - 1],
        heading: getTickHeading(ticks[tickIndex]),
      });
    }
    tickPeriods.push({ id: 'before', label: `Before ${formatDateTime(ticks.at(-1))}`, from: null, to: ticks.at(-1), heading: null });
  }

  const multiTickPeriods = MULTI_TICK_SPANS
    .filter((tickCount) => ticks.length >= tickCount)
    .map((tickCount) => ({
      id: `lastTicks:${tickCount}`,
      label: `Last ${tickCount} Ticks (since ${formatDateTime(ticks[tickCount - 1])})`,
      from: ticks[tickCount - 1],
      to: null,
      heading: getTickHeading(ticks[tickCount - 1]),
    }));

  const currentMinute = Math.floor(Date.now() / 60_000) * 60_000;
  const rangePeriods = [
    ...RECENT_RANGES.map((range) => ({ id: range.id, label: range.label, from: toJournalTimestamp(currentMinute - range.durationMs), to: null, heading: null })),
    { id: 'all', label: ticks.length > 0 ? 'All Time' : 'All Time (no tick seen yet)', from: null, to: null, heading: null },
    {
      id: 'custom',
      label: 'Custom Range…',
      from: customRange.from ? localDateToTimestamp(customRange.from) : null,
      // The "to" date is included, so the range ends at the following midnight.
      to: customRange.to ? localDateToTimestamp(customRange.to, 1) : null,
      heading: null,
    },
  ];

  return [
    { label: 'Ticks', periods: tickPeriods },
    { label: 'Multiple Ticks', periods: multiTickPeriods },
    { label: 'Time Ranges', periods: rangePeriods },
  ].filter((group) => group.periods.length > 0);
}

function getTickHeading(tickTime) {
  return `BGS Activity after Tick: ${formatTickTime(tickTime)}`;
}

/** "2026-11-20T16:52:46Z" -> "2026-11-20 16:52:46", the way BGS-Tally titles its reports. */
function formatTickTime(tickTime) {
  return tickTime.replace('T', ' ').replace(/\.\d+Z$|Z$/, '');
}

/** Tick period length as "23 h 58 m". */
export function formatTickLength(durationMs) {
  const totalMinutes = Math.round(durationMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} h ${minutes} m` : `${minutes} m`;
}
