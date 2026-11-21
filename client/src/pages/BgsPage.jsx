import { useEffect, useState } from 'react';
import { deleteJson } from '../api.js';
import { copyToClipboard } from '../clipboard.js';
import { ADJUSTMENT_FIELDS } from '../bgs-adjustment-fields.js';
import BgsAdjustmentDialog from '../components/BgsAdjustmentDialog.jsx';
import CopyableText from '../components/CopyableText.jsx';
import DataTable from '../components/DataTable.jsx';
import SearchInput from '../components/SearchInput.jsx';
import { Badge, LoadingState, Section, StatCard, StatGrid } from '../components/ui.jsx';
import { useApi } from '../hooks/use-api.js';
import { buildReport, buildSystemReport, CZ_OBJECTIVES, formatBgsNumber, getInfluenceLabel, getInfluenceTotal } from '../bgs-report.js';
import { formatDateTime, formatFullCredits, formatRelativeTime, formatSystemName } from '../format.js';

const SECONDARY_INF_STORAGE_KEY = 'bgs.includeSecondaryInf';
const COPIED_MESSAGE_MS = 1500;
const CONFLICT_BADGE_TONES = { War: 'danger', CivilWar: 'danger', Election: 'warning' };
const CONFLICT_LABELS = { War: 'War', CivilWar: 'Civil War', Election: 'Election' };

/**
 * Activity columns, each shown only when some faction in the system has a value for it.
 * getValue(totals, includeSecondaryInf) -> number; isCredits values show abbreviated with the full amount on hover.
 */
const ACTIVITY_COLUMNS = [
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
function filterSystems(systems, { searchText, selectedTypes, includeSecondaryInf }) {
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

function readStoredFlag(storageKey, defaultValue) {
  try {
    const storedValue = localStorage.getItem(storageKey);
    return storedValue === null ? defaultValue : storedValue === 'true';
  } catch {
    return defaultValue;
  }
}

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
function buildPeriodGroups(ticks, customRange) {
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

export default function BgsPage({ commanderFilter, commanders }) {
  const ticksRequest = useApi('/api/stats/bgs/ticks', {}, ['ticks']);
  const [customRange, setCustomRange] = useState({ from: '', to: '' });
  const periodGroups = buildPeriodGroups(ticksRequest.data?.ticks ?? [], customRange);
  const periods = periodGroups.flatMap((group) => group.periods);
  const [selectedPeriodId, setSelectedPeriodId] = useState('current');
  // Falls back to the first period (the current tick, or all time before any tick is seen).
  const period = periods.find((candidate) => candidate.id === selectedPeriodId) ?? periods[0];
  const [includeSecondaryInf, setIncludeSecondaryInf] = useState(() => readStoredFlag(SECONDARY_INF_STORAGE_KEY, true));
  const [searchText, setSearchText] = useState('');
  // Contribution types to show (ACTIVITY_COLUMNS keys); empty means all.
  const [selectedTypes, setSelectedTypes] = useState(() => new Set());
  // Systems left out of "Copy All" for this visit.
  const [excludedSystems, setExcludedSystems] = useState(() => new Set());
  // The open adjustment dialog: { tick, target } (target null to add activity), or null when closed.
  const [adjustmentDialog, setAdjustmentDialog] = useState(null);
  // Manual adjustments belong to one tick, so they can only be made while a single tick is shown.
  const editableTick = period.id === 'current' || period.id.startsWith('tick:') ? period.from : null;
  const canAdjust = Boolean(editableTick) && commanders.length > 0;
  const adjustTitle = canAdjust ? undefined : 'Choose the current tick or a single past tick to adjust activity';

  const activityRequest = useApi(
    '/api/stats/bgs/activity',
    { commander: commanderFilter, from: period.from ?? '', to: period.to ?? '' },
    ['stats', 'ticks', 'adjustments'],
  );

  const changeIncludeSecondaryInf = (isIncluded) => {
    setIncludeSecondaryInf(isIncluded);
    try {
      localStorage.setItem(SECONDARY_INF_STORAGE_KEY, String(isIncluded));
    } catch {
      // Storage may be unavailable; the choice still applies for this visit.
    }
  };

  const toggleSystemIncluded = (systemAddress) => {
    setExcludedSystems((currentExcluded) => {
      const nextExcluded = new Set(currentExcluded);
      if (nextExcluded.has(systemAddress)) nextExcluded.delete(systemAddress);
      else nextExcluded.add(systemAddress);
      return nextExcluded;
    });
  };

  const toggleType = (typeKey) => {
    setSelectedTypes((currentTypes) => {
      const nextTypes = new Set(currentTypes);
      if (nextTypes.has(typeKey)) nextTypes.delete(typeKey);
      else nextTypes.add(typeKey);
      return nextTypes;
    });
  };

  const reportHeading = period.heading;
  const isFiltered = Boolean(searchText.trim()) || selectedTypes.size > 0;
  const filteredSystems = filterSystems(activityRequest.data?.systems ?? [], { searchText, selectedTypes, includeSecondaryInf });

  return (
    <>
      <Section
        title="BGS Activity"
        description="Contributions to the background simulation per system and faction, in the style of BGS-Tally. Copy a system, or all of them, to paste into Discord."
        actions={(
          <>
            <select aria-label="Time period" value={period.id} onChange={(changeEvent) => setSelectedPeriodId(changeEvent.target.value)}>
              {periodGroups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.periods.map((periodOption) => <option key={periodOption.id} value={periodOption.id}>{periodOption.label}</option>)}
                </optgroup>
              ))}
            </select>
            {period.id === 'custom' && (
              <>
                <label className="filter-date">
                  From <input type="date" value={customRange.from} max={customRange.to || undefined} onChange={(changeEvent) => setCustomRange({ ...customRange, from: changeEvent.target.value })} />
                </label>
                <label className="filter-date">
                  To <input type="date" value={customRange.to} min={customRange.from || undefined} onChange={(changeEvent) => setCustomRange({ ...customRange, to: changeEvent.target.value })} />
                </label>
              </>
            )}
            <button type="button" disabled={!canAdjust} title={adjustTitle ?? 'Add activity the app didn’t track, for any system and faction'} onClick={() => setAdjustmentDialog({ tick: editableTick, target: null })}>
              Add Activity
            </button>
            <label className="checkbox" title="Count influence missions give factions other than the mission giver">
              <input type="checkbox" checked={includeSecondaryInf} onChange={(changeEvent) => changeIncludeSecondaryInf(changeEvent.target.checked)} />
              Include Secondary INF
            </label>
          </>
        )}
      >
        <div className="filter-bar">
          <SearchInput className="filter-search" placeholder="Search system or faction…" value={searchText} onChange={setSearchText} />
        </div>
        <div className="filter-bar" role="group" aria-label="Contribution types">
          {ACTIVITY_COLUMNS.map((column) => {
            const isSelected = selectedTypes.has(column.key);
            return (
              <button
                key={column.key}
                type="button"
                className={isSelected ? 'toggle-chip toggle-chip-active' : 'toggle-chip'}
                aria-pressed={isSelected}
                onClick={() => toggleType(column.key)}
              >
                {column.label}
              </button>
            );
          })}
          {selectedTypes.size > 0 && <button type="button" className="link-button" onClick={() => setSelectedTypes(new Set())}>Show All Types</button>}
        </div>
        <LoadingState requestState={activityRequest}>
          {() => {
            const systems = filteredSystems;
            const includedSystems = systems.filter((system) => !excludedSystems.has(system.systemKey));
            const allFactions = systems.flatMap((system) => system.factions);
            const totalInfluence = allFactions.reduce((total, faction) => total + getInfluenceTotal(faction.totals, includeSecondaryInf), 0);
            return (
              <>
                <StatGrid>
                  <StatCard label="Systems" value={systems.length} />
                  <StatCard label="Factions" value={allFactions.length} />
                  <StatCard label="Influence" value={totalInfluence > 0 ? `+${totalInfluence}` : totalInfluence} tone="accent" />
                  <StatCard label="Bounties" value={formatBgsNumber(sumTotals(allFactions, 'bounties'))} />
                  <StatCard label="Trade Profit" value={formatBgsNumber(sumTotals(allFactions, 'tradeProfit'))} />
                  <StatCard label="Exploration" value={formatBgsNumber(sumTotals(allFactions, 'exploration'))} />
                </StatGrid>
                {systems.length === 0 ? <div className="notice">{isFiltered ? 'No BGS activity matches the filters in this period.' : 'No BGS activity in this period.'}</div> : (
                  <div className="bgs-copy-all">
                    <CopyReportButton
                      label={`Copy All for Discord (${includedSystems.length} of ${systems.length} systems)`}
                      getReport={() => buildReport(includedSystems, { heading: reportHeading, includeSecondaryInf })}
                      isPrimary
                      isDisabled={includedSystems.length === 0}
                    />
                  </div>
                )}
              </>
            );
          }}
        </LoadingState>
        {!ticksRequest.data?.ticks?.length && (
          <p className="muted small">
            Ticks are recorded while the app is running, so activity can only be split by tick from when it first sees one.
          </p>
        )}
      </Section>

      {filteredSystems.map((system) => (
        <SystemSection
          key={system.systemKey}
          system={system}
          includeSecondaryInf={includeSecondaryInf}
          isIncluded={!excludedSystems.has(system.systemKey)}
          onToggleIncluded={() => toggleSystemIncluded(system.systemKey)}
          adjustTitle={adjustTitle}
          onAdjust={canAdjust ? (faction) => setAdjustmentDialog({
            tick: editableTick,
            target: { systemAddress: system.systemAddress, starSystem: system.starSystem, faction: faction.name },
          }) : null}
        />
      ))}

      <TickHistorySection
        ticksRequest={ticksRequest}
        selectedPeriodId={period.id}
        onShowActivity={(periodId) => {
          setSelectedPeriodId(periodId);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
      />

      <AdjustmentsSection
        commanderFilter={commanderFilter}
        onEdit={(adjustment) => setAdjustmentDialog({
          tick: adjustment.tick,
          target: { systemAddress: adjustment.systemAddress, starSystem: adjustment.starSystem, faction: adjustment.faction, commanderId: adjustment.commanderId },
        })}
      />

      {adjustmentDialog && (
        <BgsAdjustmentDialog
          tick={adjustmentDialog.tick}
          target={adjustmentDialog.target}
          commanders={commanders}
          commanderFilter={commanderFilter}
          onClose={() => setAdjustmentDialog(null)}
        />
      )}
    </>
  );
}

function SystemSection({ system, includeSecondaryInf, isIncluded, onToggleIncluded, adjustTitle, onAdjust }) {
  const visibleColumns = ACTIVITY_COLUMNS.filter((column) => system.factions.some((faction) => column.getValue(faction.totals, includeSecondaryInf)));
  const systemName = system.starSystem ?? `System #${system.systemAddress}`;

  return (
    <Section
      title={formatSystemName(systemName)}
      description={`Last activity ${formatDateTime(system.lastActivityAt)}`}
      actions={(
        <>
          <label className="checkbox" title="Include this system in Copy All">
            <input type="checkbox" checked={isIncluded} onChange={onToggleIncluded} />
            Include in Copy All
          </label>
          <CopyReportButton label="Copy" getReport={() => buildSystemReport(system, { includeSecondaryInf }) ?? ''} />
        </>
      )}
    >
      <DataTable
        tableId="bgs.factions"
        rowKey="name"
        rows={system.factions}
        emptyMessage="No faction activity."
        columns={[
          {
            key: 'name',
            label: 'Faction',
            render: (faction) => (
              <>
                {faction.name}
                {faction.state && <> <Badge tone={CONFLICT_BADGE_TONES[faction.state]}>{CONFLICT_LABELS[faction.state]}</Badge></>}
              </>
            ),
          },
          ...visibleColumns.map((column) => ({
            key: column.key,
            label: column.key === 'inf' ? 'INF' : column.label,
            align: 'right',
            sortValue: (faction) => column.getValue(faction.totals, includeSecondaryInf) ?? null,
            render: (faction) => renderActivityValue(column, faction, includeSecondaryInf),
          })),
          {
            key: 'adjust',
            label: '',
            shrink: true,
            align: 'right',
            render: (faction) => (
              <button
                type="button"
                className="icon-button"
                aria-label={`Edit ${faction.name} activity`}
                title={adjustTitle ?? 'Edit activity totals'}
                disabled={!onAdjust}
                onClick={() => onAdjust(faction)}
              >
                ✎
              </button>
            ),
          },
        ]}
      />
    </Section>
  );
}

/** A faction's value for one column. Values that include manual adjustments are marked, with the breakdown on hover. */
function renderActivityValue(column, faction, includeSecondaryInf) {
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

function sumTotals(factions, totalsKey) {
  return factions.reduce((total, faction) => total + (faction.totals[totalsKey] ?? 0), 0);
}

/** "2026-11-20T16:52:46Z" -> "2026-11-20 16:52:46", the way BGS-Tally titles its reports. */
function formatTickTime(tickTime) {
  return tickTime.replace('T', ' ').replace(/\.\d+Z$|Z$/, '');
}

const TICKS_PER_PAGE = 10;
const ADJUSTMENTS_PER_PAGE = 20;

/** Every manual adjustment, newest tick first, with a way to edit or delete it. */
function AdjustmentsSection({ commanderFilter, onEdit }) {
  const adjustmentsRequest = useApi('/api/bgs-adjustments', { commander: commanderFilter }, ['adjustments']);
  const [deleteError, setDeleteError] = useState(null);

  const deleteAdjustment = async (adjustment) => {
    const fieldLabel = ADJUSTMENT_FIELDS[adjustment.field]?.fullLabel ?? adjustment.field;
    if (!window.confirm(`Delete the ${fieldLabel} adjustment for ${adjustment.faction} in ${adjustment.starSystem}?`)) return;
    try {
      setDeleteError(null);
      await deleteJson(`/api/bgs-adjustments/${adjustment.id}`);
    } catch (error) {
      setDeleteError(error.message);
    }
  };

  return (
    <Section
      id="bgs-adjustments"
      title="Manual Adjustments"
      description="Corrections entered by hand, added on top of the tracked activity for their tick. Use the ✎ button on a faction, or Add Activity, to make them."
    >
      {deleteError && <div className="notice notice-error">{deleteError}</div>}
      <LoadingState requestState={adjustmentsRequest}>
        {({ adjustments }) => (
          <DataTable
            tableId="bgs.adjustments"
            rowKey="id"
            rows={adjustments}
            pageSize={ADJUSTMENTS_PER_PAGE}
            emptyMessage="No manual adjustments."
            columns={[
              { key: 'tick', label: 'Tick', render: (adjustment) => formatDateTime(adjustment.tick) },
              ...(commanderFilter === 'all' ? [{ key: 'commanderName', label: 'Commander', render: (adjustment) => `CMDR ${adjustment.commanderName}` }] : []),
              { key: 'starSystem', label: 'System', render: (adjustment) => formatSystemName(adjustment.starSystem) },
              { key: 'faction', label: 'Faction' },
              { key: 'field', label: 'Type', sortValue: (adjustment) => getFieldLabel(adjustment.field), render: (adjustment) => getFieldLabel(adjustment.field) },
              {
                key: 'value',
                label: 'Adjustment',
                align: 'right',
                render: (adjustment) => {
                  const isCredits = ADJUSTMENT_FIELDS[adjustment.field]?.isCredits;
                  const text = isCredits ? formatBgsNumber(adjustment.value) : String(adjustment.value);
                  return <span title={isCredits ? formatFullCredits(adjustment.value) : undefined}>{adjustment.value > 0 ? `+${text}` : text}</span>;
                },
              },
              { key: 'updatedAt', label: 'Updated', render: (adjustment) => formatDateTime(adjustment.updatedAt) },
              {
                key: 'actions',
                label: '',
                align: 'right',
                shrink: true,
                render: (adjustment) => (
                  <span className="bgs-row-actions">
                    <button type="button" className="icon-button" aria-label="Edit" title="Edit this faction's totals for the tick" onClick={() => onEdit(adjustment)}>✎</button>
                    <button type="button" className="icon-button icon-button-danger" aria-label="Delete" title="Delete this adjustment" onClick={() => deleteAdjustment(adjustment)}>✕</button>
                  </span>
                ),
              },
            ]}
          />
        )}
      </LoadingState>
    </Section>
  );
}

function getFieldLabel(field) {
  return ADJUSTMENT_FIELDS[field]?.fullLabel ?? field;
}

/**
 * Saved ticks, newest first, with how long each tick period lasted. "Show Activity" switches the
 * page to that tick's period; clicking the tick time copies a Discord timestamp of it.
 */
function TickHistorySection({ ticksRequest, selectedPeriodId, onShowActivity }) {
  return (
    <Section
      id="bgs-tick-history"
      title="Tick History"
      description={(
        <>
          BGS ticks seen while the app was running (from <a href="http://tick.infomancer.uk/" target="_blank" rel="noreferrer">tick.infomancer.uk</a>).
          {' '}Times are in your local time zone. Click a tick time to copy it as a Discord timestamp.
        </>
      )}
    >
      <LoadingState requestState={ticksRequest}>
        {({ ticks }) => {
          const rows = ticks.map((tickTime, tickIndex) => ({
            tickTime,
            periodId: tickIndex === 0 ? 'current' : `tick:${tickTime}`,
            // The newest tick's period is still running, so it has no end yet.
            durationMs: tickIndex === 0 ? null : Date.parse(ticks[tickIndex - 1]) - Date.parse(tickTime),
          }));
          return (
            <DataTable
              tableId="bgs.ticks"
              rowKey="tickTime"
              rows={rows}
              pageSize={TICKS_PER_PAGE}
              emptyMessage="No ticks seen yet."
              columns={[
                {
                  key: 'tickTime',
                  label: 'Tick',
                  render: (row) => (
                    <>
                      <CopyableText copyText={`<t:${Math.floor(Date.parse(row.tickTime) / 1000)}:f>`} title="Copies a Discord timestamp">
                        {formatDateTime(row.tickTime)}
                      </CopyableText>
                      {row.periodId === 'current' && <> <Badge tone="accent">Current</Badge></>}
                    </>
                  ),
                },
                { key: 'age', label: 'Age', sortValue: (row) => row.tickTime, render: (row) => formatRelativeTime(row.tickTime) },
                {
                  key: 'durationMs',
                  label: 'Tick Length',
                  align: 'right',
                  sortValue: (row) => row.durationMs,
                  render: (row) => (row.durationMs === null ? 'In Progress' : formatTickLength(row.durationMs)),
                },
                {
                  key: 'actions',
                  label: '',
                  align: 'right',
                  shrink: true,
                  render: (row) => (
                    <button type="button" disabled={row.periodId === selectedPeriodId} onClick={() => onShowActivity(row.periodId)}>
                      {row.periodId === selectedPeriodId ? 'Showing' : 'Show Activity'}
                    </button>
                  ),
                },
              ]}
            />
          );
        }}
      </LoadingState>
    </Section>
  );
}

/** Tick period length as "23 h 58 m". */
function formatTickLength(durationMs) {
  const totalMinutes = Math.round(durationMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} h ${minutes} m` : `${minutes} m`;
}

/** A button that copies a Discord report, briefly confirming. */
function CopyReportButton({ label, getReport, isPrimary = false, isDisabled = false }) {
  const [copyStatus, setCopyStatus] = useState(null); // null | 'copied' | 'failed'

  useEffect(() => {
    if (!copyStatus) return undefined;
    const resetTimer = setTimeout(() => setCopyStatus(null), COPIED_MESSAGE_MS);
    return () => clearTimeout(resetTimer);
  }, [copyStatus]);

  const handleClick = async () => {
    const report = getReport();
    setCopyStatus(report && (await copyToClipboard(report)) ? 'copied' : 'failed');
  };

  return (
    <button type="button" className={isPrimary ? 'button-primary' : undefined} disabled={isDisabled} onClick={handleClick}>
      {copyStatus === 'copied' ? 'Copied!' : copyStatus === 'failed' ? 'Copy Failed' : label}
    </button>
  );
}
