import { useEffect, useRef, useState } from 'react';
import { ColumnChart, LineChart } from '../../components/charts.jsx';
import DataTable from '../../components/DataTable.jsx';
import { LoadingState, Section, StatCard, StatGrid, Tabs } from '../../components/ui.jsx';
import { useApi } from '../../hooks/use-api.js';
import { formatCredits, formatDateTime, formatFullCredits, formatNumber } from '../../format.js';

const CATEGORY_PERIODS = [
  { id: 'all', label: 'All time', days: null },
  { id: '365', label: 'Year', days: 365 },
  { id: '90', label: '90 days', days: 90 },
  { id: '30', label: '30 days', days: 30 },
];
const MONTHLY_SERIES = [
  { key: 'income', label: 'Income', className: 'chart-series-income' },
  { key: 'spending', label: 'Spending', className: 'chart-series-spending' },
];
// The game's lifetime totals from Statistics, grouped as earnings and spending.
const LIFETIME_EARNINGS = [
  ['Trading', 'Market_Profits', 'Market trading profit'],
  ['Mining', 'Mining_Profits', 'Mining'],
  ['Smuggling', 'Black_Markets_Profits', 'Black markets'],
  ['Combat', 'Bounty_Hunting_Profit', 'Bounty hunting'],
  ['Combat', 'Combat_Bond_Profits', 'Combat bonds'],
  ['Combat', 'Assassination_Profits', 'Assassinations'],
  ['Combat', 'OnFoot_Combat_Bonds_Profits', 'On-foot combat bonds'],
  ['Exploration', 'Exploration_Profits', 'Exploration'],
  ['Exobiology', 'Organic_Data_Profits', 'Exobiology'],
  ['Search_And_Rescue', 'SearchRescue_Profit', 'Search & rescue'],
  ['Multicrew', 'Multicrew_Credits_Total', 'Multicrew'],
  ['FLEETCARRIER', 'FLEETCARRIER_TRADEPROFIT_TOTAL', 'Carrier market'],
  ['FLEETCARRIER', 'FLEETCARRIER_REFUEL_PROFIT', 'Carrier refuelling'],
  ['FLEETCARRIER', 'FLEETCARRIER_SHIPYARD_PROFIT', 'Carrier shipyard'],
  ['FLEETCARRIER', 'FLEETCARRIER_OUTFITTING_PROFIT', 'Carrier outfitting'],
];
const LIFETIME_SPENDING = [
  ['Bank_Account', 'Spent_On_Ships', 'Ships'],
  ['Bank_Account', 'Spent_On_Outfitting', 'Outfitting'],
  ['Bank_Account', 'Spent_On_Insurance', 'Insurance (rebuys)'],
  ['Bank_Account', 'Spent_On_Repairs', 'Repairs'],
  ['Bank_Account', 'Spent_On_Fuel', 'Fuel'],
  ['Bank_Account', 'Spent_On_Ammo_Consumables', 'Ammo & consumables'],
  ['Bank_Account', 'Spent_On_Suits', 'Suits'],
  ['Bank_Account', 'Spent_On_Weapons', 'Weapons'],
  ['Bank_Account', 'Spent_On_Suit_Consumables', 'Suit consumables'],
  ['Crime', 'Total_Fines', 'Fines'],
];

/** Balance over time, income and spending by month and category, the biggest transactions and lifetime totals. */
export default function CreditsSection({ commanderId, picker, focusRequest }) {
  const [periodId, setPeriodId] = useState('all');
  const [todayMs] = useState(() => Date.now());
  const period = CATEGORY_PERIODS.find((candidate) => candidate.id === periodId);
  const since = period.days ? new Date(todayMs - period.days * 86_400_000).toISOString().slice(0, 10) : '';
  const creditsRequest = useApi(commanderId ? '/api/stats/credits' : null, { commander: commanderId, since });

  // Asked to show a commander's credits (from their card): scroll here once their credits have loaded.
  const handledFocusRef = useRef(null);
  const isCreditsReady = Boolean(creditsRequest.data) && !creditsRequest.isLoading;
  useEffect(() => {
    if (focusRequest?.target !== 'credits' || focusRequest.commanderId !== commanderId || !isCreditsReady) return;
    if (handledFocusRef.current === focusRequest.nonce) return;
    handledFocusRef.current = focusRequest.nonce;
    requestAnimationFrame(() => document.getElementById('commanders-credits')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [focusRequest, commanderId, isCreditsReady]);

  return (
    <Section
      id="commanders-credits"
      title="Credits"
      description="The exact balance is only logged at login and on carrier transfers; between those, the transactions the journal logs show where credits came from and went."
      actions={picker}
    >
      <LoadingState requestState={creditsRequest}>
        {({ balance, balanceHistory, monthly, categories, largest, statistics }) => {
          const recentMonths = monthly.slice(-24);
          const lastMonth = monthly.at(-1);
          const income = categories.filter((category) => category.total > 0 && category.category !== 'Carrier bank');
          const spending = categories.filter((category) => category.total < 0 && category.category !== 'Carrier bank');
          const totalIncome = income.reduce((total, category) => total + category.total, 0);
          const totalSpending = -spending.reduce((total, category) => total + category.total, 0);
          return (
            <>
              <StatGrid>
                <StatCard label="Balance" value={formatCredits(balance?.balance)} tone="accent" detail={balance ? `at ${balance.source === 'login' ? 'login' : 'carrier transfer'}, ${formatDateTime(balance.timestamp)}` : null} />
                <StatCard label="Total wealth" value={formatCredits(statistics?.Bank_Account?.Current_Wealth)} detail="credits and assets, per the game" />
                <StatCard label={`Income · ${period.label.toLowerCase()}`} value={formatCredits(totalIncome)} />
                <StatCard label={`Spending · ${period.label.toLowerCase()}`} value={formatCredits(totalSpending)} />
                <StatCard label={`Net · ${period.label.toLowerCase()}`} value={`${totalIncome >= totalSpending ? '+' : '−'}${formatCredits(Math.abs(totalIncome - totalSpending))}`} detail={lastMonth ? `This month ${formatCredits(lastMonth.income - lastMonth.spending)}` : null} />
              </StatGrid>

              <div className="chart-card">
                <h3 className="subsection-title">Balance</h3>
                <p className="muted small">Credits at each login (one reading per day).</p>
                <LineChart
                  label="Credit balance over time"
                  points={balanceHistory.map((reading) => ({ time: Date.parse(reading.timestamp), value: reading.balance }))}
                  formatValue={(value, isFull) => (isFull ? formatFullCredits(value) : formatCredits(value))}
                  formatTime={(time) => new Date(time).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                />
              </div>

              <div className="chart-card">
                <h3 className="subsection-title">Income and spending by month</h3>
                <p className="muted small">The last {recentMonths.length} months. Carrier bank transfers aren’t counted, as they only move credits.</p>
                <ColumnChart
                  label="Income and spending by month"
                  series={MONTHLY_SERIES}
                  groups={recentMonths.map((month) => ({
                    key: month.month,
                    label: formatMonth(month.month, true),
                    fullLabel: formatMonth(month.month, false),
                    values: { income: month.income, spending: month.spending },
                  }))}
                  formatValue={(value, isFull) => (isFull ? formatFullCredits(value) : formatCredits(value))}
                />
              </div>

              <div className="section-toolbar">
                <h3 className="subsection-title">By category</h3>
                <Tabs tabs={CATEGORY_PERIODS} activeTab={periodId} onChange={setPeriodId} />
              </div>
              <div className="two-column">
                <CategoryTable tableId="commanders.creditIncome" title="Income" categories={income} total={totalIncome} className="chart-series-income" />
                <CategoryTable tableId="commanders.creditSpending" title="Spending" categories={spending} total={totalSpending} className="chart-series-spending" />
              </div>

              <h3 className="subsection-title">Largest transactions</h3>
              <DataTable
                tableId="commanders.largestTransactions"
                rowKey="key"
                rows={largest.map((transaction, index) => ({ ...transaction, key: index }))}
                emptyMessage="No transactions recorded."
                columns={[
                  { key: 'timestamp', label: 'Time', render: (transaction) => formatDateTime(transaction.timestamp) },
                  { key: 'category', label: 'Category' },
                  { key: 'description', label: 'Details', wrap: true, render: (transaction) => transaction.description ?? '—' },
                  { key: 'amount', label: 'Amount', align: 'right', sortValue: (transaction) => Math.abs(transaction.amount), render: (transaction) => <span title={formatFullCredits(transaction.amount)}>{transaction.amount > 0 ? '+' : '−'}{formatCredits(Math.abs(transaction.amount))}</span> },
                ]}
              />

              {statistics && (
                <>
                  <h3 className="subsection-title">Lifetime totals</h3>
                  <p className="muted small">From the game’s own statistics as of {formatDateTime(statistics.updatedAt)}, covering the commander’s whole career.</p>
                  <div className="two-column">
                    <LifetimeTable tableId="commanders.lifetimeEarnings" title="Earned" rows={LIFETIME_EARNINGS} statistics={statistics} />
                    <LifetimeTable tableId="commanders.lifetimeSpending" title="Spent" rows={LIFETIME_SPENDING} statistics={statistics} />
                  </div>
                </>
              )}
            </>
          );
        }}
      </LoadingState>
    </Section>
  );
}

function CategoryTable({ tableId, title, categories, total, className }) {
  const rows = categories.map((category) => ({ ...category, amount: Math.abs(category.total) }));
  return (
    <section>
      <h4 className="category-table-title">{title}</h4>
      <DataTable
        tableId={tableId}
        rowKey="category"
        rows={rows}
        emptyMessage="None in this period."
        columns={[
          { key: 'category', label: 'Category' },
          {
            key: 'amount',
            label: 'Amount',
            render: (category) => (
              <span className="category-amount" title={formatFullCredits(category.amount)}>
                <span className="category-bar-track"><span className={`category-bar ${className}`} style={{ width: `${total ? (category.amount / total) * 100 : 0}%` }} /></span>
                <span className="category-amount-value">{formatCredits(category.amount)}</span>
              </span>
            ),
          },
          { key: 'share', label: 'Share', align: 'right', sortValue: (category) => category.amount, render: (category) => `${total ? Math.round((category.amount / total) * 100) : 0}%` },
          { key: 'count', label: 'Count', align: 'right', render: (category) => formatNumber(category.count) },
        ]}
      />
    </section>
  );
}

function LifetimeTable({ tableId, title, rows, statistics }) {
  const values = rows
    .map(([section, key, label]) => ({ label, value: statistics[section]?.[key] }))
    .filter((row) => typeof row.value === 'number' && row.value !== 0);
  return (
    <section>
      <h4 className="category-table-title">{title}</h4>
      <DataTable
        tableId={tableId}
        rowKey="label"
        rows={values}
        emptyMessage="Nothing recorded."
        columns={[
          { key: 'label', label: 'Activity' },
          { key: 'value', label: 'Credits', align: 'right', render: (row) => <span title={formatFullCredits(row.value)}>{formatCredits(row.value)}</span> },
        ]}
      />
    </section>
  );
}

/** "2026-11" -> "Nov 26" (short) or "November 2026". */
function formatMonth(month, isShort) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleDateString(undefined, isShort ? { month: 'short', year: '2-digit', timeZone: 'UTC' } : { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
