import { CZ_OBJECTIVES, formatBgsNumber, getInfluenceLabel, getInfluenceTotal } from '../../bgs-report.js';
import { formatFullCredits, formatSystemName } from '../../format.js';

/**
 * BGS activity: the columns shown per faction, how values are totalled and rendered, and the
 * system filter.
 */

export const CONFLICT_BADGE_TONES = { War: 'danger', CivilWar: 'danger', Election: 'warning' };

export const CONFLICT_LABELS = { War: 'War', CivilWar: 'Civil War', Election: 'Election' };

/**
 * Activity columns, each shown only when some faction in the system has a value for it.
 * getValue(totals, includeSecondaryInf) -> number; isCredits values show abbreviated with the full amount on hover.
 */
export const ACTIVITY_COLUMNS = [
  { key: 'inf', label: 'INF', getValue: (totals, includeSecondaryInf) => getInfluenceTotal(totals, includeSecondaryInf) },
  { key: 'bounties', label: 'Bounties', getValue: (totals) => totals.bounties, isCredits: true },
  { key: 'combatBonds', label: 'Combat Bonds', getValue: (totals) => totals.combatBonds, isCredits: true },
  { key: 'tradeBuy', label: 'Trade Buy', getValue: (totals) => totals.tradeBuy, isCredits: true },
  { key: 'tradeProfit', label: 'Trade Profit', getValue: (totals) => totals.tradeProfit, isCredits: true },
  { key: 'blackMarketProfit', label: 'Black Market Profit', getValue: (totals) => totals.blackMarketProfit, isCredits: true },
  { key: 'exploration', label: 'Exploration', getValue: (totals) => totals.exploration, isCredits: true },
  { key: 'organic', label: 'Exobiology', getValue: (totals) => totals.organic, isCredits: true },
  { key: 'murders', label: 'Murders', getValue: (totals) => totals.murders },
  { key: 'groundMurders', label: 'Ground Murders', getValue: (totals) => totals.groundMurders },
  { key: 'scenarios', label: 'Scenarios', getValue: (totals) => totals.scenarios },
  { key: 'missionsFailed', label: 'Failed Missions', getValue: (totals) => totals.missionsFailed },
  {
    key: 'spaceCz',
    label: 'Space CZs',
    getValue: (totals) => sumConflictZones(totals.spaceCz) + sumConflictZones(totals.spaceCzObjectives),
    getText: (totals) => {
      const sizes = formatConflictZones(totals.spaceCz);
      const objectives = renderObjectives(totals.spaceCzObjectives);
      return <>{sizes}{sizes && objectives && ' '}{objectives}</>;
    },
  },
  { key: 'groundCz', label: 'Ground CZs', getValue: (totals) => sumConflictZones(totals.groundCz), getText: (totals) => formatConflictZones(totals.groundCz) },
  { key: 'searchAndRescue', label: 'Search & Rescue', getValue: (totals) => totals.searchAndRescue },
];

// Which faction totals each contribution type covers, for filtering by type.
const TOTALS_KEYS_BY_TYPE = {
  inf: ['infPrimary', 'infSecondary'],
  spaceCz: ['spaceCz', 'spaceCzObjectives'],
};

/**
 * Narrows the systems to the search text and contribution types. A system whose name (or N
 * designation) matches keeps all its factions; otherwise only factions whose name matches stay.
 * With types selected, each faction keeps only those totals. Factions left with nothing to show,
 * and systems left with no factions, are dropped. Copied reports are built from the result.
 */
export function filterSystems(systems, { searchText, selectedTypes, includeSecondaryInf }) {
  const search = searchText.trim().toLowerCase();
  const keepTotalsKeys = selectedTypes.size > 0
    ? new Set([...selectedTypes].flatMap((type) => TOTALS_KEYS_BY_TYPE[type] ?? [type]))
    : null;
  const hasActivity = (totals) => ACTIVITY_COLUMNS.some((column) => column.getValue(totals, includeSecondaryInf));

  return systems
    .map((system) => {
      const systemName = system.starSystem ?? '';
      const isSystemMatch = !search || formatSystemName(systemName).toLowerCase().includes(search);
      const factions = system.factions
        .filter((faction) => isSystemMatch || faction.name.toLowerCase().includes(search))
        .map((faction) => (keepTotalsKeys
          ? { ...faction, totals: Object.fromEntries(Object.entries(faction.totals).filter(([totalsKey]) => keepTotalsKeys.has(totalsKey))) }
          : faction))
        .filter((faction) => hasActivity(faction.totals));
      return { ...system, factions };
    })
    .filter((system) => system.factions.length > 0);
}

function sumConflictZones(sizeCounts) {
  return Object.values(sizeCounts ?? {}).reduce((total, count) => total + count, 0);
}

function formatConflictZones(sizeCounts) {
  return [['l', 'L'], ['m', 'M'], ['h', 'H']]
    .filter(([size]) => sizeCounts?.[size])
    .map(([size, label]) => `${label} × ${sizeCounts[size]}`)
    .join(' ');
}

/**
 * The objectives completed, with the same symbols as the copied report: "(👑:1 👨‍✈️:1)". Each
 * symbol's name shows on hover. Null when there are none.
 */
function renderObjectives(objectiveCounts) {
  const completedObjectives = CZ_OBJECTIVES.filter(([objective]) => objectiveCounts?.[objective]);
  if (completedObjectives.length === 0) return null;
  return (
    <span className="cz-objectives">
      (
      {completedObjectives.map(([objective, symbol, label], index) => (
        <span key={objective} title={`${label}: ${objectiveCounts[objective]}`}>
          {index > 0 && ' '}{symbol}:{objectiveCounts[objective]}
        </span>
      ))}
      )
    </span>
  );
}

/** A faction's value for one column. Values that include manual adjustments are marked, with the breakdown on hover. */
export function renderActivityValue(column, faction, includeSecondaryInf) {
  const value = column.getValue(faction.totals, includeSecondaryInf) ?? 0;
  const manualValue = faction.manual ? column.getValue(faction.manual, includeSecondaryInf) ?? 0 : 0;
  if (!value && !manualValue) return <span className="muted">—</span>;

  let content = value.toLocaleString();
  let title = null;
  if (column.key === 'inf') {
    const label = getInfluenceLabel(faction.state);
    const breakdown = `Primary ${faction.totals.infPrimary ?? 0}, secondary ${faction.totals.infSecondary ?? 0}`;
    content = value > 0 ? `+${value}` : String(value);
    title = label === 'INF' ? breakdown : `${label} · ${breakdown}`;
  } else if (column.getText) {
    content = column.getText(faction.totals);
  } else if (column.isCredits) {
    content = formatBgsNumber(value);
    title = formatFullCredits(value);
  }

  if (!manualValue) return title ? <span title={title}>{content}</span> : content;
  const formatPart = column.isCredits ? formatBgsNumber : String;
  const manualBreakdown = `Tracked ${formatPart(value - manualValue)} · Manual ${manualValue > 0 ? '+' : ''}${formatPart(manualValue)}`;
  return (
    <span className="bgs-adjusted" title={[title, manualBreakdown].filter(Boolean).join('\n')}>
      {content}
      <span className="bgs-adjusted-mark" aria-label="includes a manual adjustment">●</span>
    </span>
  );
}

export function sumTotals(factions, totalsKey) {
  return factions.reduce((total, faction) => total + (faction.totals[totalsKey] ?? 0), 0);
}
