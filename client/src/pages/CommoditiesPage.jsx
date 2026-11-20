import { useState } from 'react';
import DataTable from '../components/DataTable.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { useListFilters, useTableState } from '../hooks/use-list-filters.js';
import { Badge, LoadingState, Section, StatCard, StatGrid } from '../components/ui.jsx';
import { useApi } from '../hooks/use-api.js';
import { formatCredits, formatDateTime, formatFullCredits, formatNumber } from '../format.js';

export default function CommoditiesPage({ commanderFilter }) {
  const { filters, updateFilter, queryParams } = useListFilters();
  const [tradeType, setTradeType] = useState('');
  const [commodity, setCommodity] = useState('');
  const [isCarriersOnly, setIsCarriersOnly] = useState(false);

  const filterParams = { commander: commanderFilter, ...queryParams, type: tradeType, commodity, carriersOnly: isCarriersOnly };
  const tableState = useTableState({ defaultSort: 'timestamp', resetKey: JSON.stringify(filterParams) });

  const commodityListRequest = useApi('/api/stats/commodities/list');
  const totalsRequest = useApi('/api/stats/commodities/totals', filterParams);
  const tradesRequest = useApi('/api/stats/commodities/trades', { ...filterParams, ...tableState.queryParams });

  return (
    <>
      <Section title="Filters">
        <FilterBar filters={filters} updateFilter={updateFilter} searchPlaceholder="Search carrier, station or commodity…">
          <select value={tradeType} onChange={(changeEvent) => setTradeType(changeEvent.target.value)}>
            <option value="">Purchases &amp; sales</option>
            <option value="buy">Purchases only</option>
            <option value="sell">Sales only</option>
          </select>
          <select value={commodity} onChange={(changeEvent) => setCommodity(changeEvent.target.value)}>
            <option value="">All commodities</option>
            {(commodityListRequest.data?.commodities ?? []).map((commodityOption) => (
              <option key={commodityOption.commodity} value={commodityOption.commodity}>{commodityOption.commodity_name}</option>
            ))}
          </select>
          <label className="checkbox">
            <input type="checkbox" checked={isCarriersOnly} onChange={(changeEvent) => setIsCarriersOnly(changeEvent.target.checked)} />
            Carriers only
          </label>
        </FilterBar>
      </Section>

      <LoadingState requestState={totalsRequest}>
        {({ combined, perCommander, byCommodity, byMarket }) => (
          <>
            <Section title="Totals">
              <StatGrid>
                <StatCard label="Purchases" value={formatNumber(combined.purchase_count)} detail={`${formatNumber(combined.units_bought)} t`} />
                <StatCard label="Spent" value={formatCredits(combined.total_spent)} />
                <StatCard label="Sales" value={formatNumber(combined.sale_count)} detail={`${formatNumber(combined.units_sold)} t`} />
                <StatCard label="Earned" value={formatCredits(combined.total_earned)} />
                <StatCard label="Profit" value={formatCredits(combined.total_profit)} tone="accent" detail="Sale price minus average price paid" />
              </StatGrid>
              {commanderFilter === 'all' && perCommander.length > 1 && (
                <DataTable rowKey="commander_id" rows={perCommander} columns={[
                  { key: 'commander_name', label: 'Commander', render: (row) => `CMDR ${row.commander_name}` },
                  ...totalsColumns,
                ]} />
              )}
            </Section>
            <div className="two-column">
              <Section title="By commodity">
                <DataTable rowKey="commodity" rows={byCommodity} columns={[{ key: 'commodity_name', label: 'Commodity' }, ...totalsColumns]} />
              </Section>
              <Section title="By market / carrier" description="Top 100 by volume">
                <DataTable rowKey="market_id" rows={byMarket} columns={[
                  { key: 'market_name', label: 'Market', render: (row) => <>{row.market_name ?? `Market #${row.market_id}`} {row.is_carrier === 1 && <Badge tone="info">Carrier</Badge>}</> },
                  ...totalsColumns,
                ]} />
              </Section>
            </div>
          </>
        )}
      </LoadingState>

      <Section title="Trades">
        <DataTable
          isLoading={tradesRequest.isLoading}
          rows={tradesRequest.data?.rows ?? []}
          sorting={tableState.sorting}
          pagination={tradesRequest.data && { ...tradesRequest.data, onOffsetChange: tableState.onOffsetChange }}
          columns={[
            { key: 'timestamp', label: 'Time', sortKey: 'timestamp', render: (trade) => formatDateTime(trade.timestamp) },
            { key: 'commander_name', label: 'Commander' },
            { key: 'trade_type', label: 'Type', render: (trade) => <Badge tone={trade.trade_type === 'buy' ? 'info' : 'accent'}>{trade.trade_type}</Badge> },
            { key: 'commodity_name', label: 'Commodity', sortKey: 'commodity' },
            { key: 'quantity', label: 'Qty', align: 'right', sortKey: 'quantity' },
            { key: 'unit_price', label: 'Unit price', align: 'right', render: (trade) => formatFullCredits(trade.unit_price) },
            { key: 'total_value', label: 'Total', align: 'right', sortKey: 'value', render: (trade) => formatCredits(trade.total_value) },
            { key: 'profit', label: 'Profit', align: 'right', sortKey: 'profit', render: (trade) => (trade.profit === null ? '—' : formatCredits(trade.profit)) },
            { key: 'market_name', label: 'Market', sortKey: 'market', render: (trade) => <>{trade.market_name ?? `#${trade.market_id}`} {trade.is_carrier === 1 && <Badge tone="info">FC</Badge>}</> },
            { key: 'star_system', label: 'System' },
          ]}
        />
      </Section>
    </>
  );
}

const totalsColumns = [
  { key: 'units_bought', label: 'Bought (t)', align: 'right', render: (row) => formatNumber(row.units_bought) },
  { key: 'total_spent', label: 'Spent', align: 'right', render: (row) => formatCredits(row.total_spent) },
  { key: 'units_sold', label: 'Sold (t)', align: 'right', render: (row) => formatNumber(row.units_sold) },
  { key: 'total_earned', label: 'Earned', align: 'right', render: (row) => formatCredits(row.total_earned) },
  { key: 'total_profit', label: 'Profit', align: 'right', render: (row) => formatCredits(row.total_profit) },
];
