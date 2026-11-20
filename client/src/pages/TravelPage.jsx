import { useState } from 'react';
import DataTable from '../components/DataTable.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { Badge, LoadingState, Section, StatCard, StatGrid } from '../components/ui.jsx';
import { useApi } from '../hooks/use-api.js';
import { useListFilters, useTableState } from '../hooks/use-list-filters.js';
import { formatDateTime, formatLightYears, formatNumber } from '../format.js';

const JUMP_TYPE_OPTIONS = [
  { value: '', label: 'All jumps' },
  { value: 'normal', label: 'Normal FSD jumps' },
  { value: 'supercharged', label: 'Supercharged jumps' },
  { value: 'synthesis', label: 'Synthesis-boosted jumps' },
  { value: 'carrier', label: 'Carrier jumps' },
];

export default function TravelPage({ commanderFilter }) {
  const { filters, updateFilter, queryParams } = useListFilters();
  const [jumpType, setJumpType] = useState('');
  const filterParams = { commander: commanderFilter, ...queryParams };
  const tableState = useTableState({ defaultSort: 'timestamp', resetKey: JSON.stringify({ ...filterParams, jumpType }) });

  const summaryRequest = useApi('/api/stats/travel/summary', filterParams);
  const jumpsRequest = useApi('/api/stats/travel/jumps', { ...filterParams, type: jumpType, ...tableState.queryParams });

  return (
    <Section title="Jumps" description="Supercharged jumps use a neutron star or white dwarf FSD boost. Synthesis-boosted jumps used FSD injection.">
      <FilterBar filters={filters} updateFilter={updateFilter} searchPlaceholder="Search system…">
        <select value={jumpType} onChange={(changeEvent) => setJumpType(changeEvent.target.value)}>
          {JUMP_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </FilterBar>

      <LoadingState requestState={summaryRequest}>
        {({ combined, perCommander }) => (
          <>
            <StatGrid>
              <StatCard label="Total jumps" value={formatNumber(combined.total_jumps)} detail={formatLightYears(combined.total_distance_ly)} />
              <StatCard label="Normal jumps" value={formatNumber(combined.normal_jumps)} />
              <StatCard label="Supercharged" value={formatNumber(combined.supercharged_jumps)} tone="accent"
                detail={combined.fsd_jumps ? `${Math.round((combined.supercharged_jumps / combined.fsd_jumps) * 100)}% of FSD jumps` : null} />
              <StatCard label="Synthesis boosted" value={formatNumber(combined.synthesis_boosted_jumps)} />
              <StatCard label="Carrier jumps" value={formatNumber(combined.carrier_jumps)} detail={formatLightYears(combined.carrier_distance_ly)} />
              <StatCard label="Unique systems" value={formatNumber(combined.unique_systems)} detail={`Longest jump ${formatLightYears(combined.longest_fsd_jump_ly)}`} />
            </StatGrid>
            {commanderFilter === 'all' && perCommander.length > 1 && (
              <DataTable
                rowKey="commander_id"
                rows={perCommander}
                columns={[
                  { key: 'commander_name', label: 'Commander', render: (row) => `CMDR ${row.commander_name}` },
                  { key: 'normal_jumps', label: 'Normal', align: 'right' },
                  { key: 'supercharged_jumps', label: 'Supercharged', align: 'right' },
                  { key: 'synthesis_boosted_jumps', label: 'Synthesis', align: 'right' },
                  { key: 'carrier_jumps', label: 'Carrier', align: 'right' },
                  { key: 'total_distance_ly', label: 'Distance', align: 'right', render: (row) => formatLightYears(row.total_distance_ly) },
                  { key: 'unique_systems', label: 'Systems', align: 'right' },
                  { key: 'last_jump_at', label: 'Last jump', render: (row) => formatDateTime(row.last_jump_at) },
                ]}
              />
            )}
          </>
        )}
      </LoadingState>

      <h3 className="subheading">Jump history</h3>
      <DataTable
        isLoading={jumpsRequest.isLoading}
        rows={jumpsRequest.data?.rows ?? []}
        sorting={tableState.sorting}
        pagination={jumpsRequest.data && { ...jumpsRequest.data, onOffsetChange: tableState.onOffsetChange }}
        columns={[
          { key: 'timestamp', label: 'Time', sortKey: 'timestamp', render: (row) => formatDateTime(row.timestamp) },
          { key: 'commander_name', label: 'Commander' },
          { key: 'jump_type', label: 'Type', render: renderJumpType },
          { key: 'from_system', label: 'From' },
          { key: 'star_system', label: 'To', sortKey: 'system' },
          { key: 'jump_distance', label: 'Distance', align: 'right', sortKey: 'distance', render: (row) => formatLightYears(row.jump_distance) },
          { key: 'fuel_used', label: 'Fuel', align: 'right', render: (row) => (row.fuel_used === null ? '—' : `${formatNumber(row.fuel_used)} t`) },
        ]}
      />
    </Section>
  );
}

function renderJumpType(jump) {
  if (jump.jump_type === 'carrier') return <Badge tone="info">Carrier</Badge>;
  if (jump.is_supercharged) return <Badge tone="accent">Supercharged</Badge>;
  if (jump.boost_used > 0) return <Badge tone="warning">Synthesis</Badge>;
  return <Badge>Normal</Badge>;
}
