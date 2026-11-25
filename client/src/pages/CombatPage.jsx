import { useState } from 'react';
import { ColumnChart, HeatmapChart, ScatterChart } from '../components/charts.jsx';
import ChoiceSelect from '../components/ChoiceSelect.jsx';
import DataTable from '../components/DataTable.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { Badge, LoadingState, Section, StatCard, StatGrid } from '../components/ui.jsx';
import { useApi } from '../hooks/use-api.js';
import { useListFilters, useTableState } from '../hooks/use-list-filters.js';
import { formatCredits, formatDateTime, formatDuration, formatFullCredits, formatNumber, formatSystemName } from '../format.js';
import './combat/combat.css';

const KILL_SERIES = [
  { key: 'bounty', label: 'Bounties', className: 'chart-series-1' },
  { key: 'bond', label: 'Combat bonds', className: 'chart-series-2' },
];
// Three ships get their own colour on the session chart; the rest are "Other".
const SCATTER_SHIP_SLOTS = ['chart-series-1', 'chart-series-2', 'chart-series-3'];
const WEEKDAYS = [
  { key: 1, label: 'Mon', name: 'Monday' }, { key: 2, label: 'Tue', name: 'Tuesday' }, { key: 3, label: 'Wed', name: 'Wednesday' },
  { key: 4, label: 'Thu', name: 'Thursday' }, { key: 5, label: 'Fri', name: 'Friday' }, { key: 6, label: 'Sat', name: 'Saturday' },
  { key: 0, label: 'Sun', name: 'Sunday' },
];
const HOURS = Array.from({ length: 24 }, (_, hour) => ({ key: hour, label: hour % 3 === 0 ? String(hour).padStart(2, '0') : null }));
const DEATH_CAUSES = {
  player: { label: 'Commander', tone: 'danger', title: 'Killed by another player' },
  thargoid: { label: 'Thargoid', tone: 'accent' },
  structure: { label: 'Station defences', tone: 'warning', title: 'Shot down by a station, carrier, megaship or settlement' },
  npc: { label: 'NPC ship', tone: 'neutral' },
  on_foot: { label: 'On foot', tone: 'info', title: 'Killed by an NPC soldier' },
  self_destruct: { label: 'Self-destruct', tone: 'neutral' },
  heat: { label: 'Overheated', tone: 'warning', title: 'Heat damage just before' },
  unknown: { label: 'No killer logged', tone: 'neutral', title: 'A crash, the environment or something else the journal doesn’t name' },
};
const END_REASONS = {
  supercruise: 'Supercruise', jump: 'Jumped', docked: 'Docked', died: 'Died', quit: 'Quit', crash: 'Game closed',
};
const LOST_VOUCHERS_NOTE = 'Bounties and combat bonds earned since the last hand-in, at face value (hand-ins often pay a bonus on top). Thargoid bonds aren’t lost on death, so they aren’t counted.';

export default function CombatPage({ commanderFilter }) {
  const { filters, updateFilter, queryParams } = useListFilters();
  const [utcOffset] = useState(() => -new Date().getTimezoneOffset());
  const rangeParams = { commander: commanderFilter, period: queryParams.period, from: queryParams.from, to: queryParams.to };
  const listParams = { ...rangeParams, search: queryParams.search };

  return (
    <>
      <Section title="Combat" description="Kills, sessions and deaths from every journal. A session runs from dropping into a combat zone, ring or extraction site (or the first kill) until leaving it.">
        <FilterBar filters={filters} updateFilter={updateFilter} searchPlaceholder="Search sessions and deaths…" />
        <SummaryCards rangeParams={rangeParams} />
      </Section>
      <TimelineSection rangeParams={rangeParams} utcOffset={utcOffset} />
      <HeatmapSection rangeParams={rangeParams} utcOffset={utcOffset} />
      <SessionsSection rangeParams={rangeParams} listParams={listParams} commanderFilter={commanderFilter} />
      <DeathsSection listParams={listParams} commanderFilter={commanderFilter} />
      <VictimsSection rangeParams={rangeParams} />
    </>
  );
}

function SummaryCards({ rangeParams }) {
  const summaryRequest = useApi('/api/stats/combat-history/summary', rangeParams);
  return (
    <LoadingState requestState={summaryRequest}>
      {({ kills, sessions, deaths, interdictions }) => {
        const hours = sessions.seconds / 3600;
        const interdictionCount = (outcome) => interdictions.filter((row) => row.outcome === outcome).reduce((total, row) => total + row.count, 0);
        const totalInterdictions = interdictions.reduce((total, row) => total + row.count, 0);
        const byPlayers = interdictions.filter((row) => row.isPlayer).reduce((total, row) => total + row.count, 0);
        return (
          <StatGrid>
            <StatCard label="Kills" value={formatNumber(kills.kills)} tone="accent" detail={`${formatNumber(kills.bountyKills)} bounties · ${formatNumber(kills.bondKills)} bonds`} />
            <StatCard
              label="Earned"
              value={formatCredits(kills.bountyCredits + kills.bondCredits)}
              detail={`Bounties ${formatCredits(kills.bountyCredits)} · bonds ${formatCredits(kills.bondCredits)}`}
              title="Face value of the bounties and bonds; hand-ins often pay a bonus on top"
            />
            <StatCard label="Time in combat" value={formatDuration(sessions.seconds)} detail={`${formatNumber(sessions.sessions)} sessions`} />
            <StatCard
              label="Kills per hour"
              value={hours > 0 ? formatNumber(Math.round((kills.kills / hours) * 10) / 10) : '—'}
              detail={sessions.bestKillsPerHour ? `Best session ${formatNumber(Math.round(sessions.bestKillsPerHour))}/h` : null}
              title="Across all sessions; the best is from sessions of 15 minutes or more"
            />
            <StatCard
              label="Deaths"
              value={formatNumber(deaths.deaths)}
              tone={deaths.deaths > 0 ? 'danger' : undefined}
              detail={deaths.deaths > 0 ? `${formatNumber(Math.round(kills.kills / deaths.deaths))} kills per death` : null}
            />
            <StatCard label="Vouchers lost" value={formatCredits(deaths.vouchersLost)} tone={deaths.vouchersLost > 0 ? 'warning' : undefined} detail="unclaimed at death" title={LOST_VOUCHERS_NOTE} />
            <StatCard
              label="Interdicted"
              value={formatNumber(totalInterdictions)}
              detail={`${formatNumber(interdictionCount('escaped'))} escaped · ${formatNumber(interdictionCount('submitted'))} submitted`}
              title={`${formatNumber(interdictionCount('pulled_out'))} lost the fight to escape; ${formatNumber(byPlayers)} by other commanders`}
            />
          </StatGrid>
        );
      }}
    </LoadingState>
  );
}

function TimelineSection({ rangeParams, utcOffset }) {
  const timelineRequest = useApi('/api/stats/combat-history/timeline', { ...rangeParams, utcOffset });
  return (
    <Section id="combat-timeline" title="Kills Over Time">
      <LoadingState requestState={timelineRequest}>
        {({ bucket, periods }) => {
          if (periods.length === 0) return null;
          const toGroups = (bountyKey, bondKey) => periods.map((period) => ({
            key: period.period,
            label: formatPeriod(period.period, bucket, true),
            fullLabel: formatPeriod(period.period, bucket, false),
            values: { bounty: period[bountyKey], bond: period[bondKey] },
          }));
          const per = { day: 'day', week: 'week', month: 'month' }[bucket];
          return (
            <>
              <div className="chart-card">
                <h3 className="subheading">Kills per {per}</h3>
                <ColumnChart isStacked label={`Kills per ${per}`} series={KILL_SERIES} groups={toGroups('bountyKills', 'bondKills')} formatValue={(value) => formatNumber(value)} />
              </div>
              <div className="chart-card">
                <h3 className="subheading">Credits earned per {per}</h3>
                <p className="muted small">Face value of the bounties and bonds, before any hand-in bonus.</p>
                <ColumnChart
                  isStacked
                  label={`Credits earned per ${per}`}
                  series={KILL_SERIES}
                  groups={toGroups('bountyCredits', 'bondCredits')}
                  formatValue={(value, isFull) => (isFull ? formatFullCredits(value) : formatCredits(value))}
                />
              </div>
            </>
          );
        }}
      </LoadingState>
    </Section>
  );
}

function HeatmapSection({ rangeParams, utcOffset }) {
  const heatmapRequest = useApi('/api/stats/combat-history/heatmap', { ...rangeParams, utcOffset });
  return (
    <Section id="combat-heatmap" title="When You Fight" description="Kills by day of the week and hour, in your time zone.">
      <LoadingState requestState={heatmapRequest}>
        {({ cells }) => {
          const kills = new Map(cells.map((cell) => [`${cell.weekday}:${cell.hour}`, cell.kills]));
          const total = cells.reduce((sum, cell) => sum + cell.kills, 0);
          return (
            <HeatmapChart
              label="Kills by weekday and hour"
              rows={WEEKDAYS}
              columns={HOURS}
              getValue={(weekday, hour) => kills.get(`${weekday}:${hour}`) ?? 0}
              formatValue={(value) => formatNumber(value)}
              renderTooltip={(weekday, hour, value) => (
                <>
                  <div className="muted">{WEEKDAYS.find((day) => day.key === weekday).name} {formatHour(hour)}–{formatHour((hour + 1) % 24)}</div>
                  <strong>{formatNumber(value)} kills</strong>
                  {total > 0 && <span className="muted"> · {Math.round((value / total) * 1000) / 10}%</span>}
                </>
              )}
            />
          );
        }}
      </LoadingState>
    </Section>
  );
}

function SessionsSection({ rangeParams, listParams, commanderFilter }) {
  const [sessionFilters, setSessionFilters] = useState({ system: '', ship: '' });
  const filterParams = { ...listParams, ...sessionFilters };
  const tableState = useTableState({ tableId: 'combat.sessions', defaultSort: 'started_at', pageSize: 10, resetKey: JSON.stringify(filterParams) });
  const pointsRequest = useApi('/api/stats/combat-history/session-points', rangeParams);
  const choicesRequest = useApi('/api/stats/combat-history/filters', rangeParams);
  const sessionsRequest = useApi('/api/stats/combat-history/sessions', { ...filterParams, ...tableState.queryParams });
  const updateSessionFilter = (name, value) => setSessionFilters((current) => ({ ...current, [name]: value }));
  return (
    <Section id="combat-sessions" title="Sessions">
      <div className="chart-card">
        <h3 className="subheading">Session length and kill rate</h3>
        <p className="muted small">One dot per session of 5 minutes or more with a kill, coloured by ship.</p>
        <LoadingState requestState={pointsRequest}>
          {({ sessions }) => <SessionScatter sessions={sessions} />}
        </LoadingState>
      </div>

      <div className="combat-table-filters">
        <ChoiceSelect label="All Systems" value={sessionFilters.system} choices={choicesRequest.data?.sessions.systems} onChange={(value) => updateSessionFilter('system', value)} formatLabel={formatSystemName} />
        <ChoiceSelect label="All Ships" value={sessionFilters.ship} choices={choicesRequest.data?.sessions.ships} onChange={(value) => updateSessionFilter('ship', value)} />
      </div>
      <DataTable
        tableId="combat.sessions"
        isLoading={sessionsRequest.isLoading}
        rows={sessionsRequest.data?.rows ?? []}
        sorting={tableState.sorting}
        pagination={sessionsRequest.data && { ...sessionsRequest.data, onOffsetChange: tableState.onOffsetChange }}
        emptyMessage="No combat sessions."
        columns={[
          { key: 'started_at', label: 'Started', sortKey: 'started_at', render: (session) => formatDateTime(session.started_at) },
          ...(commanderFilter === 'all' ? [{ key: 'commander_name', label: 'Commander' }] : []),
          { key: 'location', label: 'Where', wrap: true, render: (session) => <SessionPlace session={session} /> },
          { key: 'ship', label: 'Ship', render: renderShip },
          { key: 'duration_s', label: 'Length', align: 'right', sortKey: 'duration', render: (session) => formatSessionLength(session.duration_s) },
          { key: 'kills', label: 'Kills', align: 'right', sortKey: 'kills', render: (session) => formatNumber(session.kills) },
          { key: 'kills_per_hour', label: 'Per hour', align: 'right', sortKey: 'kills_per_hour', render: (session) => (session.duration_s >= 300 ? formatNumber(Math.round(session.kills_per_hour)) : '—') },
          { key: 'credits', label: 'Earned', align: 'right', sortKey: 'credits', render: (session) => <span title={formatFullCredits(session.credits)}>{formatCredits(session.credits)}</span> },
          { key: 'shields_down', label: 'Shields lost', align: 'right', render: (session) => formatNumber(session.shields_down) },
          { key: 'lowest_hull', label: 'Lowest hull', align: 'right', sortKey: 'lowest_hull', render: renderHull },
          { key: 'fighters_lost', label: 'Fighters lost', align: 'right', render: (session) => formatNumber(session.fighters_lost) },
          { key: 'end_reason', label: 'Ended', render: renderSessionEnd },
        ]}
      />
    </Section>
  );
}

function SessionScatter({ sessions }) {
  // The three ships with the most sessions get a colour each; the rest fold into "Other".
  const sessionsByShip = new Map();
  for (const session of sessions) {
    const ship = session.ship_type_name ?? 'Unknown';
    sessionsByShip.set(ship, (sessionsByShip.get(ship) ?? 0) + 1);
  }
  const rankedShips = [...sessionsByShip].sort((first, second) => second[1] - first[1]).map(([ship]) => ship);
  const namedShips = rankedShips.slice(0, SCATTER_SHIP_SLOTS.length);
  const series = [
    ...namedShips.map((ship, index) => ({ key: ship, label: ship, className: SCATTER_SHIP_SLOTS[index] })),
    ...(rankedShips.length > namedShips.length ? [{ key: 'other', label: 'Other ships', className: 'chart-series-other' }] : []),
  ];
  const points = sessions.map((session) => ({
    key: session.id,
    x: session.duration_s / 3600,
    y: session.kills_per_hour,
    seriesKey: namedShips.includes(session.ship_type_name ?? 'Unknown') ? session.ship_type_name ?? 'Unknown' : 'other',
    session,
  }));
  return (
    <ScatterChart
      label="Sessions by length and kills per hour"
      points={points}
      series={series}
      xLabel="Session length (hours)"
      yLabel="Kills per hour"
      formatX={(value) => `${formatNumber(value)}h`}
      formatY={(value) => formatNumber(value)}
      renderTooltip={({ session }) => (
        <>
          <div className="muted">{formatDateTime(session.started_at)}</div>
          <div>{[session.location, formatSystemName(session.star_system)].filter(Boolean).join(' · ') || 'Unknown location'}</div>
          <div className="muted">{session.ship_name ? `${session.ship_name} (${session.ship_type_name})` : session.ship_type_name}</div>
          <strong>{formatNumber(session.kills)} kills in {formatSessionLength(session.duration_s)} · {formatNumber(Math.round(session.kills_per_hour))}/h</strong>
          <div className="muted">{formatCredits(session.credits)} earned</div>
        </>
      )}
    />
  );
}

function DeathsSection({ listParams, commanderFilter }) {
  const [deathFilters, setDeathFilters] = useState({ cause: '', killer: '', system: '' });
  const filterParams = { ...listParams, ...deathFilters };
  const tableState = useTableState({ tableId: 'combat.deaths', defaultSort: 'timestamp', pageSize: 10, resetKey: JSON.stringify(filterParams) });
  const deathsRequest = useApi('/api/stats/combat-history/deaths', { ...filterParams, ...tableState.queryParams });
  const rangeParams = { commander: listParams.commander, period: listParams.period, from: listParams.from, to: listParams.to };
  const summaryRequest = useApi('/api/stats/combat-history/summary', rangeParams);
  const choicesRequest = useApi('/api/stats/combat-history/filters', rangeParams);
  const causes = summaryRequest.data?.deaths.byCause ?? [];
  const updateDeathFilter = (name, value) => setDeathFilters((current) => ({ ...current, [name]: value }));
  const causeChoices = choicesRequest.data?.deaths.causes
    .map((choice) => ({ ...choice, label: (DEATH_CAUSES[choice.value] ?? DEATH_CAUSES.unknown).label }))
    .sort((first, second) => first.label.localeCompare(second.label));
  return (
    <Section id="combat-deaths" title="Deaths" description={`Vouchers lost: ${LOST_VOUCHERS_NOTE.charAt(0).toLowerCase()}${LOST_VOUCHERS_NOTE.slice(1)}`}>
      {causes.length > 0 && (
        <div className="combat-causes">
          {causes.map((cause) => {
            const display = DEATH_CAUSES[cause.cause] ?? DEATH_CAUSES.unknown;
            const isSelected = deathFilters.cause === cause.cause;
            return (
              <button
                key={cause.cause}
                type="button"
                className={isSelected ? 'combat-cause combat-cause-selected' : 'combat-cause'}
                title={`${display.title ? `${display.title}. ` : ''}${isSelected ? 'Click to show every cause' : 'Click to show only these'}`}
                aria-pressed={isSelected}
                onClick={() => updateDeathFilter('cause', isSelected ? '' : cause.cause)}
              >
                <Badge tone={display.tone}>{display.label}</Badge>
                <strong>{formatNumber(cause.count)}</strong>
                {cause.vouchersLost > 0 && <span className="muted small">{formatCredits(cause.vouchersLost)} lost</span>}
              </button>
            );
          })}
        </div>
      )}
      <div className="combat-table-filters">
        <ChoiceSelect label="All Causes" value={deathFilters.cause} choices={causeChoices} onChange={(value) => updateDeathFilter('cause', value)} />
        <ChoiceSelect label="All Killers" value={deathFilters.killer} choices={choicesRequest.data?.deaths.killers} onChange={(value) => updateDeathFilter('killer', value)} />
        <ChoiceSelect label="All Systems" value={deathFilters.system} choices={choicesRequest.data?.deaths.systems} onChange={(value) => updateDeathFilter('system', value)} formatLabel={formatSystemName} />
      </div>
      <DataTable
        tableId="combat.deaths"
        isLoading={deathsRequest.isLoading}
        rows={deathsRequest.data?.rows ?? []}
        sorting={tableState.sorting}
        pagination={deathsRequest.data && { ...deathsRequest.data, onOffsetChange: tableState.onOffsetChange }}
        emptyMessage="No deaths. Fly safe!"
        columns={[
          { key: 'timestamp', label: 'Time', sortKey: 'timestamp', render: (death) => formatDateTime(death.timestamp) },
          ...(commanderFilter === 'all' ? [{ key: 'commander_name', label: 'Commander' }] : []),
          { key: 'cause', label: 'Cause', sortKey: 'cause', render: renderDeathCause },
          { key: 'killer_name', label: 'Killer', sortKey: 'killer', wrap: true, render: renderKiller },
          { key: 'killer_ship_name', label: 'Killer’s ship', render: (death) => death.killer_ship_name ?? '—' },
          { key: 'ship', label: 'Your ship', render: renderShip },
          { key: 'star_system', label: 'System', sortKey: 'system', render: (death) => formatSystemName(death.star_system) ?? '—' },
          { key: 'vouchers_lost', label: 'Vouchers lost', align: 'right', sortKey: 'vouchers_lost', render: (death) => (death.vouchers_lost > 0 ? <span title={formatFullCredits(death.vouchers_lost)}>{formatCredits(death.vouchers_lost)}</span> : '—') },
        ]}
      />
    </Section>
  );
}

function VictimsSection({ rangeParams }) {
  const victimsRequest = useApi('/api/stats/combat-history/victims', rangeParams);
  return (
    <Section id="combat-victims" title="Victims" description="Bounty kills by the victim’s ship and pilot rank (known when the pilot was fully scanned first), and kills by faction.">
      <LoadingState requestState={victimsRequest}>
        {({ byShip, byRank, byFaction }) => {
          const bountyKills = byShip.reduce((total, row) => total + row.kills, 0);
          const allKills = byFaction.reduce((total, row) => total + row.kills, 0);
          return (
            <div className="combat-victims">
              <ShareTable tableId="combat.victimShips" title="Ship" rows={byShip.map((row) => ({ key: row.name, label: row.name, kills: row.kills, credits: row.credits }))} total={bountyKills} />
              <ShareTable
                tableId="combat.victimRanks"
                title="Pilot rank"
                rows={byRank.filter((row) => row.kills > 0).map((row) => ({ key: row.rank ?? 'unknown', label: row.rank ?? 'Not scanned', kills: row.kills }))}
                total={bountyKills}
                isOrdered
              />
              <ShareTable tableId="combat.victimFactions" title="Faction" rows={byFaction.map((row) => ({ key: row.faction ?? '?', label: row.faction ?? 'Unknown', kills: row.kills, credits: row.credits }))} total={allKills} />
            </div>
          );
        }}
      </LoadingState>
    </Section>
  );
}

/** A table of kills with a share bar; isOrdered keeps the given order (ranks) instead of sorting by kills. */
function ShareTable({ tableId, title, rows, total, isOrdered = false }) {
  const hasCredits = rows.some((row) => row.credits !== undefined);
  // Bars are scaled to the largest row so they stay readable; the share of all kills is in the tooltip.
  const maxKills = Math.max(1, ...rows.map((row) => row.kills));
  return (
    <section>
      <h4 className="category-table-title">{title}</h4>
      <DataTable
        tableId={tableId}
        rowKey="key"
        rows={isOrdered ? rows : [...rows].sort((first, second) => second.kills - first.kills)}
        pageSize={10}
        emptyMessage="No kills."
        columns={[
          { key: 'label', label: title },
          {
            key: 'kills',
            label: 'Kills',
            render: (row) => (
              <span className="category-amount" title={`${total ? Math.round((row.kills / total) * 1000) / 10 : 0}%`}>
                <span className="category-bar-track"><span className="category-bar chart-series-1" style={{ width: `${(row.kills / maxKills) * 100}%` }} /></span>
                <span className="category-amount-value">{formatNumber(row.kills)}</span>
              </span>
            ),
          },
          ...(hasCredits ? [{ key: 'credits', label: 'Earned', align: 'right', render: (row) => <span title={formatFullCredits(row.credits)}>{formatCredits(row.credits)}</span> }] : []),
        ]}
      />
    </section>
  );
}

function SessionPlace({ session }) {
  const system = formatSystemName(session.star_system);
  if (!session.location) return system ?? '—';
  return (
    <>
      {session.location}
      {system && <div className="muted small">{system}</div>}
    </>
  );
}

/** The ship type, with the commander's name for it underneath. */
function renderShip(row) {
  if (!row.ship_type_name) return row.ship_name || '—';
  return (
    <>
      {row.ship_type_name}
      {row.ship_name && <div className="muted small">{row.ship_name}</div>}
    </>
  );
}

function renderHull(session) {
  if (session.lowest_hull === null) return <span className="muted" title="The hull never fell below 80%">—</span>;
  const percent = Math.round(session.lowest_hull * 100);
  return <span className={percent < 40 ? 'combat-hull-low' : undefined}>{percent}%</span>;
}

function renderSessionEnd(session) {
  if (session.is_open) return <Badge tone="live">Under way</Badge>;
  if (session.died) return <Badge tone="danger">Died</Badge>;
  return END_REASONS[session.end_reason] ?? '—';
}

function renderDeathCause(death) {
  const display = DEATH_CAUSES[death.cause] ?? DEATH_CAUSES.unknown;
  return <Badge tone={display.tone} title={display.title}>{display.label}</Badge>;
}

function renderKiller(death) {
  if (!death.killer_name) return death.killer_count > 1 ? `${death.killer_count} attackers` : '—';
  const name = death.cause === 'player' ? `CMDR ${death.killer_name}` : death.killer_name;
  return (
    <>
      {name}
      {death.killer_count > 1 && <span className="muted"> and {death.killer_count - 1} more</span>}
      {death.killer_rank && <div className="muted small">{death.killer_rank}</div>}
    </>
  );
}

/** Hours and minutes: "3h 12m", or "12m" under an hour. */
function formatSessionLength(seconds) {
  if (!(seconds > 0)) return '—';
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  return hours > 0 ? `${hours}h ${totalMinutes % 60}m` : `${totalMinutes}m`;
}

function formatHour(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** A timeline period ("2026-11-03" day or week start, "2026-11" month) as a short axis label or a full one. */
function formatPeriod(period, bucket, isShort) {
  if (bucket === 'month') {
    const [year, month] = period.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, isShort ? { month: 'short', year: '2-digit', timeZone: 'UTC' } : { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  const date = new Date(`${period}T00:00:00Z`);
  if (isShort) return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const full = date.toLocaleDateString(undefined, { weekday: bucket === 'day' ? 'short' : undefined, year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return bucket === 'week' ? `Week of ${full}` : full;
}
