import { useState } from 'react';
import { buildReport, formatBgsNumber, getInfluenceTotal } from '../bgs-report.js';
import BgsAdjustmentDialog from '../components/BgsAdjustmentDialog.jsx';
import SearchInput from '../components/SearchInput.jsx';
import { LoadingState, Section, StatCard, StatGrid } from '../components/ui.jsx';
import { useApi } from '../hooks/use-api.js';
import { STORED_BOOLEAN, useStoredState } from '../hooks/use-stored-state.js';
import { AdjustmentsSection } from './bgs/AdjustmentsSection.jsx';
import { ACTIVITY_COLUMNS, filterSystems, sumTotals } from './bgs/bgs-activity.jsx';
import { buildPeriodGroups } from './bgs/bgs-periods.js';
import { CopyReportButton } from './bgs/CopyReportButton.jsx';
import { SystemSection } from './bgs/SystemSection.jsx';
import { TickHistorySection } from './bgs/TickHistorySection.jsx';
import './bgs/bgs.css';

const SECONDARY_INF_STORAGE_KEY = 'bgs.includeSecondaryInf';

export default function BgsPage({ commanderFilter, commanders }) {
  const ticksRequest = useApi('/api/stats/bgs/ticks', {}, ['ticks']);
  const [customRange, setCustomRange] = useState({ from: '', to: '' });
  const periodGroups = buildPeriodGroups(ticksRequest.data?.ticks ?? [], customRange);
  const periods = periodGroups.flatMap((group) => group.periods);
  const [selectedPeriodId, setSelectedPeriodId] = useState('current');
  // Falls back to the first period (the current tick, or all time before any tick is seen).
  const period = periods.find((candidate) => candidate.id === selectedPeriodId) ?? periods[0];
  const [includeSecondaryInf, changeIncludeSecondaryInf] = useStoredState(SECONDARY_INF_STORAGE_KEY, true, STORED_BOOLEAN);
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
