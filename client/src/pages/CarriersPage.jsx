import { useState } from 'react';
import DataTable from '../components/DataTable.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { useListFilters, useTableState } from '../hooks/use-list-filters.js';
import { Badge, KeyValueList, LoadingState, ProgressBar, Section, StatCard, StatGrid } from '../components/ui.jsx';
import { useApi } from '../hooks/use-api.js';
import { formatCredits, formatDateTime, formatFullCredits, formatNumber, formatRelativeTime } from '../format.js';

const MAX_CARRIER_FUEL = 1000;
const CARD_SORT_STORAGE_KEY = 'carriers.cardSort';

/** Card sort options. Carriers with an unknown age or activity time are listed last. */
const CARD_SORTS = {
  age: { label: 'Age (oldest first)', compare: (first, second) => compareTimestamps(first.acquired_at, second.acquired_at, 'asc') },
  name: { label: 'Name', compare: (first, second) => getCarrierLabel(first).localeCompare(getCarrierLabel(second), undefined, { sensitivity: 'base' }) },
  activity: { label: 'Activity (most recent first)', compare: (first, second) => compareTimestamps(first.updated_at, second.updated_at, 'desc') },
};

function compareTimestamps(first, second, order) {
  if (!first || !second) return Number(!first) - Number(!second);
  return order === 'asc' ? first.localeCompare(second) : second.localeCompare(first);
}

function getCarrierLabel(carrier) {
  return carrier.name ?? carrier.callsign ?? '';
}

function formatCarrierNames(carrierIds, carriers) {
  return carrierIds
    .map((carrierId) => carriers.find((carrier) => carrier.carrier_id === carrierId))
    .map((carrier) => `${carrier.name ?? 'Unnamed'} (${carrier.callsign ?? '?'})`)
    .join(', ') || '—';
}

function readStoredCardSort() {
  try {
    const storedSort = localStorage.getItem(CARD_SORT_STORAGE_KEY);
    return CARD_SORTS[storedSort] ? storedSort : 'age';
  } catch {
    return 'age';
  }
}

export default function CarriersPage({ commanderFilter }) {
  const carriersRequest = useApi('/api/stats/carriers', { commander: commanderFilter });
  const [cardSort, setCardSort] = useState(readStoredCardSort);

  const changeCardSort = (sortName) => {
    setCardSort(sortName);
    try {
      localStorage.setItem(CARD_SORT_STORAGE_KEY, sortName);
    } catch {
      // Storage may be unavailable; the choice still applies for this session.
    }
  };

  return (
    <>
      <LoadingState requestState={carriersRequest}>
        {({ carriers, commanderStatuses }) => {
          const activeCarriers = carriers.filter((carrier) => !carrier.is_decommissioned);
          const sortedCarriers = [...carriers].sort(CARD_SORTS[cardSort].compare);
          const totalBalance = activeCarriers.reduce((total, carrier) => total + (carrier.finance?.carrierBalance ?? 0), 0);
          return (
            <>
              <Section title="Overview">
                <StatGrid>
                  <StatCard label="Fleet carriers" value={activeCarriers.filter((carrier) => carrier.carrier_type === 'FleetCarrier').length} />
                  <StatCard label="Squadron carriers" value={activeCarriers.filter((carrier) => carrier.carrier_type === 'SquadronCarrier').length} />
                  <StatCard label="Combined balance" value={formatCredits(totalBalance)} />
                  <StatCard label="Commanders with carriers" value={`${commanderStatuses.filter((status) => status.carrierStatus !== 'None').length} / ${commanderStatuses.length}`} />
                </StatGrid>
                <DataTable
                  rowKey="commanderId"
                  rows={commanderStatuses}
                  columns={[
                    { key: 'commanderName', label: 'Commander', render: (status) => `CMDR ${status.commanderName}` },
                    { key: 'fleetCarrierIds', label: 'Fleet Carrier', render: (status) => formatCarrierNames(status.fleetCarrierIds, carriers) },
                    { key: 'squadronCarrierIds', label: 'Squadron Fleet Carrier', render: (status) => formatCarrierNames(status.squadronCarrierIds, carriers) },
                  ]}
                />
              </Section>

              <Section
                title="Carriers"
                actions={(
                  <select value={cardSort} onChange={(changeEvent) => changeCardSort(changeEvent.target.value)} aria-label="Sort carriers">
                    {Object.entries(CARD_SORTS).map(([sortName, sortOption]) => <option key={sortName} value={sortName}>Sort: {sortOption.label}</option>)}
                  </select>
                )}
              >
                {carriers.length === 0 ? <div className="notice">No carriers found.</div> : (
                  <div className="card-grid card-grid-wide">
                    {sortedCarriers.map((carrier) => <CarrierCard key={carrier.carrier_id} carrier={carrier} />)}
                  </div>
                )}
              </Section>
            </>
          );
        }}
      </LoadingState>

      <CarrierHistorySection commanderFilter={commanderFilter} />
    </>
  );
}

function CarrierCard({ carrier }) {
  const finance = carrier.finance ?? {};
  const spaceUsage = carrier.space_usage ?? {};
  const location = carrier.effective_location;
  const crewServices = Object.entries(carrier.crew_services ?? {}).filter(([role]) => role !== 'Captain');
  const tradeOrders = Object.values(carrier.trade_orders ?? {});

  return (
    <article className="card carrier-card">
      <header className="card-header">
        <div>
          <h3>{carrier.name ?? 'Unnamed carrier'}</h3>
          <div className="muted small">{carrier.callsign ?? '—'} · {carrier.commanders.map((link) => `CMDR ${link.commander_name} (${link.relationship})`).join(', ')}</div>
        </div>
        <div className="badge-row">
          <Badge tone="accent">{carrier.carrier_type_label ?? '?'}</Badge>
          {carrier.is_decommissioned && <Badge tone="danger">Decommissioned</Badge>}
          {!carrier.is_decommissioned && carrier.pending_decommission === 1 && <Badge tone="warning">Decommissioning</Badge>}
        </div>
      </header>

      <div className="carrier-columns">
        <KeyValueList items={[
          { label: 'Location', value: location?.starSystem ? `${location.starSystem}${location.isAssumed ? ' (jumped, unconfirmed)' : ''}` : null },
          { label: 'Location since', value: location?.since ? formatRelativeTime(location.since) : null },
          carrier.pending_jump && !location?.isAssumed && {
            label: 'Pending jump',
            value: `${carrier.pending_jump.body ?? carrier.pending_jump.starSystem} · departs ${formatDateTime(carrier.pending_jump.departureTime)}`,
          },
          { label: 'Docking', value: carrier.docking_access ? `${carrier.docking_access}${carrier.allow_notorious ? ' (notorious allowed)' : ''}` : null },
          { label: 'Jump range', value: carrier.jump_range_current ? `${formatNumber(carrier.jump_range_current)} / ${formatNumber(carrier.jump_range_max)} ly` : null },
          carrier.decommission_time && { label: 'Decommission at', value: formatDateTime(carrier.decommission_time) },
          { label: 'Stats updated', value: carrier.stats_updated_at ? formatRelativeTime(carrier.stats_updated_at) : null },
        ]} />

        <KeyValueList items={[
          { label: 'Balance', value: formatFullCredits(finance.carrierBalance) },
          { label: 'Available', value: formatFullCredits(finance.availableBalance) },
          { label: 'Reserve', value: finance.reserveBalance === undefined ? null : `${formatFullCredits(finance.reserveBalance)} (${finance.reservePercent ?? 0}%)` },
          finance.taxRates && { label: 'Tax rates', value: Object.entries(finance.taxRates).map(([service, rate]) => `${service} ${rate}%`).join(', ') },
          !carrier.purchase_price && carrier.acquired_at && { label: 'First seen', value: formatDateTime(carrier.acquired_at) },
          carrier.purchase_price && { label: 'Purchased', value: `${formatDateTime(carrier.bought_at)} for ${formatCredits(carrier.purchase_price)}` },
        ]} />
      </div>

      <div className="meter-row">
        <span className="meter-label">Fuel</span>
        <ProgressBar value={carrier.fuel_level ?? 0} max={MAX_CARRIER_FUEL} />
        <span className="meter-value">{formatNumber(carrier.fuel_level)} / {MAX_CARRIER_FUEL} t</span>
      </div>
      {spaceUsage.TotalCapacity > 0 && (
        <div className="meter-row">
          <span className="meter-label">Space</span>
          <ProgressBar value={spaceUsage.TotalCapacity - spaceUsage.FreeSpace} max={spaceUsage.TotalCapacity} />
          <span className="meter-value">{formatNumber(spaceUsage.FreeSpace)} t free · cargo {formatNumber(spaceUsage.Cargo)} t</span>
        </div>
      )}

      {crewServices.length > 0 && (
        <div className="service-list">
          {crewServices.map(([role, crewService]) => {
            const serviceState = !crewService.activated ? 'inactive' : crewService.enabled ? 'active' : 'paused';
            return (
              <span key={role} className={`service-chip service-${serviceState}`} title={crewService.crewName ?? serviceState}>
                {role.replace(/([a-z])([A-Z])/g, '$1 $2')}
              </span>
            );
          })}
        </div>
      )}

      {tradeOrders.length > 0 && (
        <details className="details">
          <summary>{tradeOrders.length} trade order{tradeOrders.length === 1 ? '' : 's'}</summary>
          <DataTable
            rowKey="commodity"
            rows={tradeOrders}
            columns={[
              { key: 'orderType', label: 'Order', render: (order) => <Badge tone={order.orderType === 'buy' ? 'info' : 'accent'}>{order.orderType}</Badge> },
              { key: 'commodity', label: 'Commodity' },
              { key: 'quantity', label: 'Quantity', align: 'right' },
              { key: 'price', label: 'Price', align: 'right', render: (order) => formatFullCredits(order.price) },
              { key: 'updatedAt', label: 'Set', render: (order) => formatRelativeTime(order.updatedAt) },
            ]}
          />
        </details>
      )}
    </article>
  );
}

function CarrierHistorySection({ commanderFilter }) {
  const { filters, updateFilter, queryParams } = useListFilters();
  const filterParams = { commander: commanderFilter, ...queryParams };
  const jumpTableState = useTableState({ defaultSort: 'timestamp', pageSize: 25, resetKey: JSON.stringify(filterParams) });
  const transactionTableState = useTableState({ defaultSort: 'timestamp', pageSize: 25, resetKey: JSON.stringify(filterParams) });

  const jumpsRequest = useApi('/api/stats/carriers/jumps', { ...filterParams, ...jumpTableState.queryParams });
  const transactionsRequest = useApi('/api/stats/carriers/transactions', { ...filterParams, ...transactionTableState.queryParams });

  return (
    <Section title="Carrier history">
      <FilterBar filters={filters} updateFilter={updateFilter} searchPlaceholder="Search carrier or system…" />
      <h3 className="subheading">Jumps</h3>
      <DataTable
        isLoading={jumpsRequest.isLoading}
        rows={jumpsRequest.data?.rows ?? []}
        sorting={jumpTableState.sorting}
        pagination={jumpsRequest.data && { ...jumpsRequest.data, onOffsetChange: jumpTableState.onOffsetChange }}
        columns={[
          { key: 'timestamp', label: 'Time', sortKey: 'timestamp', render: (jump) => formatDateTime(jump.timestamp) },
          { key: 'carrier_name', label: 'Carrier', render: (jump) => `${jump.carrier_name ?? '—'} (${jump.callsign ?? '?'})` },
          { key: 'jump_event', label: 'Event', render: (jump) => <Badge tone={{ requested: 'info', cancelled: 'warning', arrived: 'live' }[jump.jump_event]}>{jump.jump_event}</Badge> },
          { key: 'star_system', label: 'System', render: (jump) => jump.body ?? jump.star_system ?? '—' },
          { key: 'departure_time', label: 'Departure', render: (jump) => formatDateTime(jump.departure_time) },
          { key: 'commander_name', label: 'By' },
        ]}
      />
      <h3 className="subheading">Bank transfers</h3>
      <DataTable
        isLoading={transactionsRequest.isLoading}
        rows={transactionsRequest.data?.rows ?? []}
        sorting={transactionTableState.sorting}
        pagination={transactionsRequest.data && { ...transactionsRequest.data, onOffsetChange: transactionTableState.onOffsetChange }}
        columns={[
          { key: 'timestamp', label: 'Time', sortKey: 'timestamp', render: (transaction) => formatDateTime(transaction.timestamp) },
          { key: 'carrier_name', label: 'Carrier', render: (transaction) => `${transaction.carrier_name ?? '—'} (${transaction.callsign ?? '?'})` },
          { key: 'transaction_type', label: 'Type', render: (transaction) => <Badge tone={transaction.transaction_type === 'deposit' ? 'live' : 'warning'}>{transaction.transaction_type}</Badge> },
          { key: 'amount', label: 'Amount', align: 'right', sortKey: 'amount', render: (transaction) => formatFullCredits(transaction.amount) },
          { key: 'carrier_balance', label: 'Carrier balance', align: 'right', render: (transaction) => formatCredits(transaction.carrier_balance) },
          { key: 'commander_name', label: 'Commander' },
        ]}
      />
    </Section>
  );
}
