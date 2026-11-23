import DataTable from '../../components/DataTable.jsx';
import FilterBar from '../../components/FilterBar.jsx';
import { Badge, Section } from '../../components/ui.jsx';
import { formatCredits, formatDateTime, formatFullCredits, formatSystemName } from '../../format.js';
import { useApi } from '../../hooks/use-api.js';
import { useListFilters, useTableState } from '../../hooks/use-list-filters.js';

export function CarrierHistorySection({ commanderFilter }) {
  const { filters, updateFilter, queryParams } = useListFilters();
  const filterParams = { commander: commanderFilter, ...queryParams };
  const jumpTableState = useTableState({ tableId: 'carriers.jumps', defaultSort: 'timestamp', pageSize: 25, resetKey: JSON.stringify(filterParams) });
  const transactionTableState = useTableState({ tableId: 'carriers.bankTransfers', defaultSort: 'timestamp', pageSize: 25, resetKey: JSON.stringify(filterParams) });

  const jumpsRequest = useApi('/api/stats/carriers/jumps', { ...filterParams, ...jumpTableState.queryParams });
  const transactionsRequest = useApi('/api/stats/carriers/transactions', { ...filterParams, ...transactionTableState.queryParams });

  return (
    <Section title="Carrier History">
      <FilterBar filters={filters} updateFilter={updateFilter} searchPlaceholder="Search carrier or system…" />
      <h3 id="carrier-jump-history" className="subheading">Jumps</h3>
      <DataTable
        tableId="carriers.jumps"
        isLoading={jumpsRequest.isLoading}
        rows={jumpsRequest.data?.rows ?? []}
        sorting={jumpTableState.sorting}
        pagination={jumpsRequest.data && { ...jumpsRequest.data, onOffsetChange: jumpTableState.onOffsetChange }}
        columns={[
          { key: 'timestamp', label: 'Time', sortKey: 'timestamp', render: (jump) => formatDateTime(jump.timestamp) },
          { key: 'carrier_name', label: 'Carrier', render: (jump) => `${jump.carrier_name ?? '—'} (${jump.callsign ?? '?'})` },
          { key: 'jump_event', label: 'Event', render: (jump) => <Badge tone={{ requested: 'info', cancelled: 'warning', arrived: 'live' }[jump.jump_event]}>{jump.jump_event}</Badge> },
          { key: 'star_system', label: 'System', render: (jump) => formatSystemName(jump.body ?? jump.star_system) ?? '—' },
          { key: 'departure_time', label: 'Departure', render: (jump) => formatDateTime(jump.departure_time) },
          { key: 'commander_name', label: 'By' },
        ]}
      />
      <h3 id="carrier-bank-history" className="subheading">Bank transfers</h3>
      <DataTable
        tableId="carriers.bankTransfers"
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
