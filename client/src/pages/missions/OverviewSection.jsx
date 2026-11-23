import { useState } from 'react';
import DataTable from '../../components/DataTable.jsx';
import { LoadingState, Section, StatCard, StatGrid } from '../../components/ui.jsx';
import { formatCredits, formatDateTime, formatFullCredits, formatNumber, formatRelativeTime } from '../../format.js';
import { useApi } from '../../hooks/use-api.js';
import { getCategoryLabel, renderWingReward } from './mission-display.jsx';

const PERIOD_OPTIONS = [
  { value: '', label: 'All Time' },
  { value: '24h', label: 'Last 24 Hours' },
  { value: '7d', label: 'Last 7 Days' },
  { value: '30d', label: 'Last 30 Days' },
  { value: '90d', label: 'Last 90 Days' },
  { value: '1y', label: 'Last Year' },
];

export function OverviewSection({ commanderFilter }) {
  const [period, setPeriod] = useState('30d');
  const summaryRequest = useApi('/api/stats/missions/summary', { commander: commanderFilter, period });
  const periodLabel = PERIOD_OPTIONS.find((option) => option.value === period).label;

  return (
    <Section
      title="Overview"
      description="Open missions right now, and how the missions accepted in the chosen period turned out."
      actions={(
        <select value={period} onChange={(changeEvent) => setPeriod(changeEvent.target.value)} aria-label="Period">
          {PERIOD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      )}
    >
      <LoadingState requestState={summaryRequest}>
        {({ open, byCategory, totals }) => {
          const finished = totals.completed + totals.failed + totals.abandoned + totals.expired;
          return (
            <>
              <StatGrid>
                <StatCard label="Open missions" value={formatNumber(open.count)} tone={open.count ? 'live' : undefined}
                  detail={open.redirected ? `${formatNumber(open.redirected)} ready to turn in` : null} />
                <StatCard label="Open value" value={formatCredits(open.reward)}
                  detail={renderWingReward(open.wingReward)} />
                <StatCard label="Next expiry" value={open.nextExpiry ? formatRelativeTime(open.nextExpiry) : '—'}
                  detail={open.nextExpiry ? formatDateTime(open.nextExpiry) : null} />
                <StatCard label="Earned" value={formatCredits(totals.earned)} tone="accent"
                  detail={`${formatNumber(totals.completed)} completed · ${periodLabel}`} />
                <StatCard label="Accepted" value={formatNumber(totals.accepted)}
                  detail={finished ? `${Math.round((totals.completed / finished) * 100)}% success` : null} />
                <StatCard label="Failed / Abandoned" value={`${formatNumber(totals.failed)} / ${formatNumber(totals.abandoned)}`}
                  tone={totals.failed ? 'danger' : undefined} detail={totals.expired ? `${formatNumber(totals.expired)} expired` : null} />
              </StatGrid>
              <DataTable
                tableId="missions.byCategory"
                rowKey="category"
                rows={byCategory}
                emptyMessage="No missions accepted in this period."
                columns={[
                  { key: 'category', label: 'Type', sortValue: (row) => getCategoryLabel(row.category), render: (row) => getCategoryLabel(row.category) },
                  { key: 'accepted', label: 'Accepted', align: 'right', render: (row) => formatNumber(row.accepted) },
                  { key: 'completed', label: 'Completed', align: 'right', render: (row) => formatNumber(row.completed) },
                  { key: 'failed', label: 'Failed', align: 'right', render: (row) => formatNumber(row.failed) },
                  { key: 'abandoned', label: 'Abandoned', align: 'right', render: (row) => formatNumber(row.abandoned) },
                  { key: 'expired', label: 'Expired', align: 'right', render: (row) => formatNumber(row.expired) },
                  { key: 'earned', label: 'Earned', align: 'right', render: (row) => <span title={formatFullCredits(row.earned)}>{formatCredits(row.earned)}</span> },
                  { key: 'donated', label: 'Donated', align: 'right', render: (row) => (row.donated ? formatCredits(row.donated) : '—') },
                ]}
              />
            </>
          );
        }}
      </LoadingState>
    </Section>
  );
}
