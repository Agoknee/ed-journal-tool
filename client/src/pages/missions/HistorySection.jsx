import { useState } from 'react';
import DataTable from '../../components/DataTable.jsx';
import FilterBar from '../../components/FilterBar.jsx';
import { LoadingState, Section, StatCard, StatGrid } from '../../components/ui.jsx';
import { formatCredits, formatDateTime, formatDuration, formatFullCredits, formatNumber } from '../../format.js';
import { useApi } from '../../hooks/use-api.js';
import { useListFilters, useTableState } from '../../hooks/use-list-filters.js';
import { CATEGORY_LABELS, getCategoryLabel, renderExpiry, renderObjective, renderPlace, renderStatus } from './mission-display.jsx';
import { WingIcon } from './WingIcon.jsx';

const STATUS_OPTIONS = [
  { value: '', label: 'All Outcomes' },
  { value: 'open', label: 'Open' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'abandoned', label: 'Abandoned' },
  { value: 'expired', label: 'Expired' },
];

export function HistorySection({ commanderFilter }) {
  const { filters, updateFilter, queryParams } = useListFilters();
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const filterParams = { commander: commanderFilter, ...queryParams, status, category };
  const tableState = useTableState({ tableId: 'missions.history', defaultSort: 'accepted', resetKey: JSON.stringify(filterParams) });
  const missionsRequest = useApi('/api/stats/missions/missions', { ...filterParams, ...tableState.queryParams });
  const statsRequest = useApi('/api/stats/missions/history-stats', filterParams);

  return (
    <Section id="missions-history" title="Mission History" description="Every mission accepted, newest first.">
      <FilterBar filters={filters} updateFilter={updateFilter} searchPlaceholder="Search mission, faction, system…">
        <select value={status} onChange={(changeEvent) => setStatus(changeEvent.target.value)} aria-label="Outcome">
          {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select value={category} onChange={(changeEvent) => setCategory(changeEvent.target.value)} aria-label="Type">
          <option value="">All Types</option>
          {Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </FilterBar>
      <LoadingState requestState={statsRequest}>
        {(stats) => <HistoryStats stats={stats} />}
      </LoadingState>
      <DataTable
        tableId="missions.history"
        isLoading={missionsRequest.isLoading}
        rows={missionsRequest.data?.rows ?? []}
        sorting={tableState.sorting}
        pagination={missionsRequest.data && { ...missionsRequest.data, onOffsetChange: tableState.onOffsetChange }}
        emptyMessage="No missions match."
        columns={[
          { key: 'accepted_at', label: 'Accepted', sortKey: 'accepted', render: (row) => formatDateTime(row.accepted_at) },
          ...(commanderFilter === 'all' ? [{ key: 'commander_name', label: 'Commander', render: (row) => `CMDR ${row.commander_name}` }] : []),
          { key: 'category', label: 'Type', sortKey: 'category', render: (row) => getCategoryLabel(row.category) },
          {
            key: 'title',
            label: 'Mission',
            wrap: true,
            render: (row) => (
              <span title={row.name}>
                {Boolean(row.is_wing) && <WingIcon />}
                {row.title ?? row.name}
              </span>
            ),
          },
          { key: 'faction', label: 'Faction', sortKey: 'faction', wrap: true },
          { key: 'origin', label: 'From', render: (row) => renderPlace(row.origin_system, row.origin_station) },
          { key: 'destination', label: 'To', render: (row) => renderPlace(row.destination_system, row.destination_station ?? row.destination_settlement) },
          { key: 'objective', label: 'Objective', wrap: true, render: renderObjective },
          { key: 'influence', label: 'INF', render: (row) => row.influence || '—' },
          {
            key: 'reward',
            label: 'Reward',
            align: 'right',
            sortKey: 'reward',
            render: (row) => {
              const amount = row.status === 'completed' ? row.final_reward : row.reward;
              if (row.donation) return <span title="Donated">−{formatCredits(row.donation)}</span>;
              return amount ? <span title={formatFullCredits(amount)}>{formatCredits(amount)}</span> : <span className="muted">—</span>;
            },
          },
          { key: 'status', label: 'Outcome', render: renderStatus },
          {
            key: 'ended',
            label: 'Ended / Expires',
            sortKey: 'ended',
            render: (row) => (row.ended_at ? formatDateTime(row.ended_at) : renderExpiry(row)),
          },
        ]}
      />
    </Section>
  );
}

/** Overall numbers for the missions the history list shows (same filters). */
function HistoryStats({ stats: { totals, bestMission, topFaction, busiestDay } }) {
  if (!totals.total) return null;
  const finished = totals.completed + totals.unsuccessful;
  const averageReward = totals.completed ? totals.earned / totals.completed : 0;
  const deeds = [
    totals.kills && `${formatNumber(totals.kills)} kills`,
    totals.cargoDelivered && `${formatNumber(totals.cargoDelivered)} t delivered`,
    totals.passengers && `${formatNumber(totals.passengers)} passengers`,
  ].filter(Boolean);
  return (
    <StatGrid>
      <StatCard label="Missions" value={formatNumber(totals.total)}
        detail={[`${formatNumber(totals.completed)} completed`, totals.open && `${formatNumber(totals.open)} open`].filter(Boolean).join(' · ')} />
      <StatCard label="Total earned" tone="accent" value={<span title={formatFullCredits(totals.earned)}>{formatCredits(totals.earned)}</span>}
        detail={totals.donated ? `${formatCredits(totals.donated)} donated · ${formatCredits(totals.earned - totals.donated)} net` : null} />
      <StatCard label="Average payout" value={formatCredits(averageReward)}
        detail={totals.averageDurationMs ? `${formatDuration(totals.averageDurationMs / 1000)} average to complete` : null} />
      <StatCard label="Success rate" value={finished ? `${Math.round((totals.completed / finished) * 100)}%` : '—'}
        detail={totals.unsuccessful ? `${formatNumber(totals.unsuccessful)} failed, abandoned or expired` : null} />
      {bestMission && (
        <StatCard label="Best payout" value={<span title={formatFullCredits(bestMission.final_reward)}>{formatCredits(bestMission.final_reward)}</span>}
          detail={<span title={`${bestMission.faction} · ${formatDateTime(bestMission.ended_at)}`}>{bestMission.title ?? bestMission.name}</span>} />
      )}
      {busiestDay && (
        <StatCard label="Best day" value={formatCredits(busiestDay.earned)}
          detail={`${formatNumber(busiestDay.completed)} completed on ${new Date(`${busiestDay.day}T12:00:00Z`).toLocaleDateString()}`} />
      )}
      {topFaction && (
        <StatCard label="Top faction" value={<span className="stat-value-text" title={topFaction.faction}>{topFaction.faction}</span>}
          detail={`${formatNumber(topFaction.completed)} completed · ${formatCredits(topFaction.earned)}`} />
      )}
      <StatCard label="Influence earned" value={`+${formatNumber(totals.influence)}`}
        detail={[`${formatNumber(totals.factions)} factions`, ...deeds].join(' · ')} />
    </StatGrid>
  );
}
