import DataTable from '../components/DataTable.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { useListFilters, useTableState } from '../hooks/use-list-filters.js';
import { LoadingState, Section, StatCard, StatGrid } from '../components/ui.jsx';
import { useApi } from '../hooks/use-api.js';
import { STORED_BOOLEAN, useStoredState } from '../hooks/use-stored-state.js';
import { formatDateTime, formatNumber, formatSystemName } from '../format.js';

const CARRIERS_PER_PAGE = 10;
const EXCLUDE_OWNED_STORAGE_KEY = 'depots.excludeOwned';

export default function DepotsPage({ commanderFilter }) {
  const { filters, updateFilter, queryParams } = useListFilters();
  const [isOwnedExcluded, setIsOwnedExcluded] = useStoredState(EXCLUDE_OWNED_STORAGE_KEY, false, STORED_BOOLEAN);
  const filterParams = { commander: commanderFilter, ...queryParams, excludeOwned: isOwnedExcluded };
  const tableState = useTableState({ tableId: 'depots.deposits', defaultSort: 'timestamp', resetKey: JSON.stringify(filterParams) });

  const totalsRequest = useApi('/api/stats/fuel-deposits/totals', filterParams);
  const depositsRequest = useApi('/api/stats/fuel-deposits/deposits', { ...filterParams, ...tableState.queryParams });

  return (
    <>
      <Section title="Depot fuel deposits" description="Tritium deposited into carrier fuel depots.">
        <FilterBar filters={filters} updateFilter={updateFilter} searchPlaceholder="Search carrier name, callsign or system…">
          <label className="checkbox" title="Hide deposits to fleet carriers owned by any of your commanders">
            <input type="checkbox" checked={isOwnedExcluded} onChange={(changeEvent) => setIsOwnedExcluded(changeEvent.target.checked)} />
            Exclude Owned Carriers
          </label>
        </FilterBar>
        <LoadingState requestState={totalsRequest}>
          {({ combined, perCommander, byCarrier }) => (
            <>
              <StatGrid>
                <StatCard label="Tritium deposited" value={`${formatNumber(combined.total_amount)} t`} tone="accent" />
                <StatCard label="Deposits" value={formatNumber(combined.deposit_count)} />
                <StatCard label="Carriers fuelled" value={formatNumber(byCarrier.length)} />
                <StatCard label="Average deposit" value={combined.deposit_count ? `${formatNumber(Math.round(combined.total_amount / combined.deposit_count))} t` : '—'} />
                <StatCard label="Last deposit" value={formatDateTime(combined.last_deposit_at)} />
              </StatGrid>
              <div className="two-column">
                <Section title="By Carrier">
                  <DataTable
                    tableId="depots.byCarrier"
                    rowKey="carrier_id"
                    rows={byCarrier}
                    pageSize={CARRIERS_PER_PAGE}
                    pageResetKey={JSON.stringify(filterParams)}
                    columns={[
                      { key: 'carrier_name', label: 'Carrier' },
                      { key: 'deposit_count', label: 'Deposits', align: 'right' },
                      { key: 'total_amount', label: 'Tritium (t)', align: 'right' },
                      { key: 'last_deposit_at', label: 'Last deposit', render: (row) => formatDateTime(row.last_deposit_at) },
                    ]}
                  />
                </Section>
                {commanderFilter === 'all' && (
                  <Section title="By Commander">
                    <DataTable tableId="depots.byCommander" rowKey="commander_id" rows={perCommander} columns={[
                      { key: 'commander_name', label: 'Commander', render: (row) => `CMDR ${row.commander_name}` },
                      { key: 'deposit_count', label: 'Deposits', align: 'right' },
                      { key: 'total_amount', label: 'Tritium (t)', align: 'right' },
                      { key: 'last_deposit_at', label: 'Last deposit', render: (row) => formatDateTime(row.last_deposit_at) },
                    ]} />
                  </Section>
                )}
              </div>
            </>
          )}
        </LoadingState>
      </Section>

      <Section id="depot-history" title="Deposits">
        <DataTable
          tableId="depots.deposits"
          isLoading={depositsRequest.isLoading}
          rows={depositsRequest.data?.rows ?? []}
          sorting={tableState.sorting}
          pagination={depositsRequest.data && { ...depositsRequest.data, onOffsetChange: tableState.onOffsetChange }}
          columns={[
            { key: 'timestamp', label: 'Time', sortKey: 'timestamp', render: (deposit) => formatDateTime(deposit.timestamp) },
            { key: 'commander_name', label: 'Commander' },
            {
              key: 'carrier_name',
              label: 'Carrier',
              sortKey: 'carrier',
              render: (deposit) => (
                <button
                  type="button"
                  className="link-button link-button-plain"
                  title="Search for this carrier"
                  onClick={() => updateFilter('search', deposit.carrier_name)}
                >
                  {deposit.carrier_name}
                </button>
              ),
            },
            {
              key: 'star_system',
              label: 'System',
              render: (deposit) => deposit.star_system ? (
                <button
                  type="button"
                  className="link-button link-button-plain"
                  title="Search for this system"
                  onClick={() => updateFilter('search', deposit.star_system)}
                >
                  {formatSystemName(deposit.star_system)}
                </button>
              ) : '—',
            },
            { key: 'amount', label: 'Amount (t)', align: 'right', sortKey: 'amount' },
            { key: 'carrier_fuel_total', label: 'Depot total (t)', align: 'right' },
          ]}
        />
      </Section>
    </>
  );
}
