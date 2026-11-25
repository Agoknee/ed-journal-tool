import { lazy, Suspense, useState } from 'react';
import ChoiceSelect from '../components/ChoiceSelect.jsx';
import DataTable from '../components/DataTable.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { Badge, LoadingState, Section, StatCard, StatGrid } from '../components/ui.jsx';
import { useApi } from '../hooks/use-api.js';
import { useListFilters, useTableState } from '../hooks/use-list-filters.js';
import { STORED_BOOLEAN, useStoredState } from '../hooks/use-stored-state.js';
import { formatDateTime, formatLightYears, formatNumber, formatSystemName } from '../format.js';
import { describeStarClass, getStarClassLabel } from './travel/star-classes.js';
import './travel/travel.css';

// three.js is big; it's only fetched once the map is opened.
const GalaxyMap = lazy(() => import('./travel/GalaxyMap.jsx'));

const JUMP_TYPE_OPTIONS = [
  { value: '', label: 'All Jumps' },
  { value: 'fsd', label: 'Non-Carrier Jumps' },
  { value: 'own', label: 'Own Ship Jumps' },
  { value: 'normal', label: 'Normal FSD Jumps' },
  { value: 'supercharged', label: 'Supercharged Jumps' },
  { value: 'synthesis', label: 'Synthesis-Boosted Jumps' },
  { value: 'taxi', label: 'Taxi Jumps' },
  { value: 'multicrew', label: 'Multicrew Jumps' },
  { value: 'carrier', label: 'Carrier Jumps' },
];

const NO_CHOICE_FILTERS = { ship: '', starClass: '', allegiance: '', economy: '', government: '', security: '' };

export default function TravelPage({ commanderFilter }) {
  const { filters, updateFilter, queryParams } = useListFilters();
  const [jumpType, setJumpType] = useState('fsd');
  const [choiceFilters, setChoiceFilters] = useState(NO_CHOICE_FILTERS);
  const [isFirstVisitOnly, setIsFirstVisitOnly] = useState(false);
  const [isMapShown, setIsMapShown] = useStoredState('travel.map.shown', false, STORED_BOOLEAN);

  const rangeParams = { commander: commanderFilter, period: queryParams.period, from: queryParams.from, to: queryParams.to };
  const filterParams = {
    commander: commanderFilter,
    ...queryParams,
    type: jumpType,
    ...choiceFilters,
    firstVisit: isFirstVisitOnly ? '1' : '',
  };
  const tableState = useTableState({ tableId: 'travel.jumps', defaultSort: 'timestamp', resetKey: JSON.stringify(filterParams) });

  const summaryRequest = useApi('/api/stats/travel/summary', filterParams);
  const choicesRequest = useApi('/api/stats/travel/filters', rangeParams);
  const jumpsRequest = useApi('/api/stats/travel/jumps', { ...filterParams, ...tableState.queryParams });
  const selectedJumpTypeLabel = JUMP_TYPE_OPTIONS.find((option) => option.value === jumpType).label;
  const choices = choicesRequest.data;

  const updateChoiceFilter = (name, value) => setChoiceFilters((current) => ({ ...current, [name]: value }));
  const hasExtraFilters = isFirstVisitOnly || Object.values(choiceFilters).some(Boolean);
  const clearExtraFilters = () => {
    setChoiceFilters(NO_CHOICE_FILTERS);
    setIsFirstVisitOnly(false);
  };

  return (
    <Section title="Jumps" description="Supercharged jumps use a neutron star or white dwarf FSD boost. Synthesis-boosted jumps used FSD injection. A first visit is the commander’s first jump into a system in these journals.">
      <FilterBar filters={filters} updateFilter={updateFilter} searchPlaceholder="Search system…">
        <select value={jumpType} onChange={(changeEvent) => setJumpType(changeEvent.target.value)} aria-label="Jump type">
          {JUMP_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </FilterBar>
      <div className="travel-filters">
        <ChoiceSelect label="All Ships" value={choiceFilters.ship} choices={choices?.ships} onChange={(value) => updateChoiceFilter('ship', value)} />
        <ChoiceSelect label="All Stars" value={choiceFilters.starClass} choices={choices?.starClasses} onChange={(value) => updateChoiceFilter('starClass', value)} formatLabel={getStarClassLabel} />
        <ChoiceSelect label="All Allegiances" value={choiceFilters.allegiance} choices={choices?.allegiances} onChange={(value) => updateChoiceFilter('allegiance', value)} />
        <ChoiceSelect label="All Economies" value={choiceFilters.economy} choices={choices?.economies} onChange={(value) => updateChoiceFilter('economy', value)} />
        <ChoiceSelect label="All Governments" value={choiceFilters.government} choices={choices?.governments} onChange={(value) => updateChoiceFilter('government', value)} />
        <ChoiceSelect label="All Security" value={choiceFilters.security} choices={choices?.securities} onChange={(value) => updateChoiceFilter('security', value)} />
        <label className="checkbox">
          <input type="checkbox" checked={isFirstVisitOnly} onChange={(changeEvent) => setIsFirstVisitOnly(changeEvent.target.checked)} />
          First visits only
        </label>
        {hasExtraFilters && <button type="button" onClick={clearExtraFilters}>Clear filters</button>}
      </div>

      <LoadingState requestState={summaryRequest}>
        {({ combined, perCommander }) => (
          <>
            <StatGrid>
              <StatCard label={jumpType ? selectedJumpTypeLabel : 'Total jumps'} value={formatNumber(combined.total_jumps)} detail={formatLightYears(combined.total_distance_ly)} />
              <StatCard label="Normal jumps" value={formatNumber(combined.normal_jumps)} detail={combined.taxi_jumps ? `${formatNumber(combined.taxi_jumps)} by taxi` : null} />
              <StatCard label="Supercharged" value={formatNumber(combined.supercharged_jumps)} tone="accent"
                detail={combined.fsd_jumps ? `${Math.round((combined.supercharged_jumps / combined.fsd_jumps) * 100)}% of FSD jumps` : null} />
              <StatCard label="Synthesis boosted" value={formatNumber(combined.synthesis_boosted_jumps)} />
              <StatCard label="Carrier jumps" value={formatNumber(combined.carrier_jumps)} detail={formatLightYears(combined.carrier_distance_ly)} />
              <StatCard label="Unique systems" value={formatNumber(combined.unique_systems)} detail={`Longest jump ${formatLightYears(combined.longest_fsd_jump_ly)}`} />
              <StatCard label="First visits" value={formatNumber(combined.first_visits)} tone="live" detail="jumps into a system for the first time" />
            </StatGrid>
            {commanderFilter === 'all' && perCommander.length > 1 && (
              <DataTable
                tableId="travel.byCommander"
                rowKey="commander_id"
                rows={perCommander}
                columns={[
                  { key: 'commander_name', label: 'Commander', render: (row) => `CMDR ${row.commander_name}` },
                  { key: 'total_jumps', label: 'Jumps', align: 'right' },
                  { key: 'normal_jumps', label: 'Normal', align: 'right' },
                  { key: 'supercharged_jumps', label: 'Supercharged', align: 'right' },
                  { key: 'synthesis_boosted_jumps', label: 'Synthesis', align: 'right' },
                  { key: 'carrier_jumps', label: 'Carrier', align: 'right' },
                  { key: 'total_distance_ly', label: 'Distance', align: 'right', render: (row) => formatLightYears(row.total_distance_ly) },
                  { key: 'unique_systems', label: 'Systems', align: 'right' },
                  { key: 'first_visits', label: 'First visits', align: 'right' },
                  { key: 'last_jump_at', label: 'Last jump', render: (row) => formatDateTime(row.last_jump_at) },
                ]}
              />
            )}
          </>
        )}
      </LoadingState>

      <div className="travel-history-header">
        <h3 id="travel-history" className="subheading">Jump history</h3>
        <button
          type="button"
          className={isMapShown ? 'travel-map-toggle travel-map-toggle-on' : 'travel-map-toggle'}
          aria-pressed={isMapShown}
          onClick={() => setIsMapShown(!isMapShown)}
          title="A 3D map of the jumps these filters pick, with a time-lapse replay"
        >
          <GalaxyIcon />
          {isMapShown ? 'Hide galaxy map' : 'Show galaxy map'}
        </button>
      </div>
      {isMapShown && (
        <Suspense fallback={<div className="galaxy-map"><div className="galaxy-message">Warming up the galaxy map…</div></div>}>
          <GalaxyMap params={filterParams} commanderFilter={commanderFilter} />
        </Suspense>
      )}
      <DataTable
        tableId="travel.jumps"
        isLoading={jumpsRequest.isLoading}
        rows={jumpsRequest.data?.rows ?? []}
        sorting={tableState.sorting}
        pagination={jumpsRequest.data && { ...jumpsRequest.data, onOffsetChange: tableState.onOffsetChange }}
        emptyMessage="No jumps match."
        columns={[
          { key: 'timestamp', label: 'Time', sortKey: 'timestamp', render: (row) => formatDateTime(row.timestamp) },
          ...(commanderFilter === 'all' ? [{ key: 'commander_name', label: 'Commander', render: (row) => `CMDR ${row.commander_name}` }] : []),
          { key: 'jump_type', label: 'Type', render: renderJumpType },
          { key: 'from_system', label: 'From', render: (row) => formatSystemName(row.from_system) ?? '—' },
          {
            key: 'star_system',
            label: 'To',
            sortKey: 'system',
            render: (row) => (
              <>
                {formatSystemName(row.star_system) ?? '—'}
                {Boolean(row.is_first_visit) && <span className="travel-first-visit" title="The commander’s first jump into this system">● new</span>}
              </>
            ),
          },
          { key: 'star_class', label: 'Star', sortKey: 'star', render: renderStar },
          { key: 'ship', label: 'Ship', sortKey: 'ship', render: renderShip },
          { key: 'security', label: 'Security', render: (row) => row.security ?? '—' },
          { key: 'jump_distance', label: 'Distance', align: 'right', sortKey: 'distance', render: (row) => formatLightYears(row.jump_distance) },
          { key: 'fuel_used', label: 'Fuel', align: 'right', sortKey: 'fuel', render: (row) => (row.fuel_used === null ? '—' : `${formatNumber(row.fuel_used)} t`) },
        ]}
      />
    </Section>
  );
}

function renderJumpType(jump) {
  if (jump.jump_type === 'carrier') return <Badge tone="info">Carrier</Badge>;
  if (jump.is_taxi) return <Badge tone="live">Taxi</Badge>;
  if (jump.is_multicrew) return <Badge tone="neutral">Multicrew</Badge>;
  if (jump.is_supercharged) return <Badge tone="accent">Supercharged</Badge>;
  if (jump.boost_used > 0) return <Badge tone="warning">Synthesis</Badge>;
  return <Badge>Normal</Badge>;
}

function renderStar(jump) {
  if (!jump.star_class) return <span className="muted">—</span>;
  const star = describeStarClass(jump.star_class);
  return (
    <span className="travel-star" title={star.isScoopable ? 'Fuel scoop works here' : undefined}>
      <span className="travel-star-dot" style={{ background: star.color, boxShadow: `0 0 6px ${star.color}` }} />
      {star.name}
    </span>
  );
}

function renderShip(jump) {
  if (!jump.ship_type_name) return <span className="muted">—</span>;
  return (
    <>
      {jump.ship_type_name}
      {jump.ship_name && <div className="muted small">{jump.ship_name}</div>}
    </>
  );
}

function GalaxyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M12 12c0-3 2.5-5 5.5-4.5M12 12c3 0 5 2.5 4.5 5.5M12 12c0 3-2.5 5-5.5 4.5M12 12c-3 0-5-2.5-4.5-5.5" />
      <path d="M17.5 7.5C20 9 21 12 20 15M16.5 17.5C15 20 12 21 9 20M6.5 16.5C4 15 3 12 4 9M7.5 6.5C9 4 12 3 15 4" opacity="0.6" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
    </svg>
  );
}
