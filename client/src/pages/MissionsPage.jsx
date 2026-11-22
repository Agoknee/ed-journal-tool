import { useEffect, useState } from 'react';
import { copyToClipboard } from '../clipboard.js';
import DataTable from '../components/DataTable.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { Badge, LoadingState, ProgressBar, Section, StatCard, StatGrid } from '../components/ui.jsx';
import { useApi } from '../hooks/use-api.js';
import { useListFilters, useTableState } from '../hooks/use-list-filters.js';
import { formatCredits, formatDateTime, formatDuration, formatFullCredits, formatNumber, formatRelativeTime, formatSystemName } from '../format.js';

const CATEGORY_LABELS = {
  massacre: 'Massacre',
  mining: 'Mining',
  courier: 'Courier',
  delivery: 'Delivery',
  source: 'Source',
  donation: 'Donation',
  passenger: 'Passenger',
  assassination: 'Assassination',
  salvage: 'Salvage & Rescue',
  smuggling: 'Smuggling',
  combat: 'Combat',
  on_foot: 'On Foot',
  other: 'Other',
};

const STATUS_BADGES = {
  active: { tone: 'live', label: 'Active' },
  redirected: { tone: 'accent', label: 'Turn In', title: 'Objective complete; return to hand in' },
  completed: { tone: 'info', label: 'Completed' },
  failed: { tone: 'danger', label: 'Failed' },
  abandoned: { tone: 'warning', label: 'Abandoned' },
  expired: { tone: 'neutral', label: 'Expired', title: 'Expired, or no longer in the game’s mission list' },
};

const PERIOD_OPTIONS = [
  { value: '', label: 'All Time' },
  { value: '24h', label: 'Last 24 Hours' },
  { value: '7d', label: 'Last 7 Days' },
  { value: '30d', label: 'Last 30 Days' },
  { value: '90d', label: 'Last 90 Days' },
  { value: '1y', label: 'Last Year' },
];

const STATUS_OPTIONS = [
  { value: '', label: 'All Outcomes' },
  { value: 'open', label: 'Open' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'abandoned', label: 'Abandoned' },
  { value: 'expired', label: 'Expired' },
];

const MINUTE_MS = 60 * 1000;

export default function MissionsPage({ commanderFilter }) {
  useMinuteTicker();
  return (
    <>
      <OverviewSection commanderFilter={commanderFilter} />
      <MassacreSection commanderFilter={commanderFilter} />
      <CargoSection commanderFilter={commanderFilter} />
      <HistorySection commanderFilter={commanderFilter} />
    </>
  );
}

/** Re-renders every minute so expiry countdowns stay current. */
function useMinuteTicker() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
}

function OverviewSection({ commanderFilter }) {
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

function MassacreSection({ commanderFilter }) {
  const massacreRequest = useApi('/api/stats/missions/massacre', { commander: commanderFilter });
  const combatRequest = useApi('/api/stats/combat/status', { commander: commanderFilter });
  const combatByCommander = new Map((combatRequest.data?.commanders ?? []).map((combat) => [combat.commanderId, combat]));
  const shipStatusRequest = useApi('/api/ship-status', {}, ['shipStatus', 'journals']);
  const shipStatusByCommander = new Map((shipStatusRequest.data?.commanders ?? []).map((status) => [status.commanderId, status]));
  return (
    <Section
      id="missions-massacre"
      title="Massacre Stacks"
      description="Open massacre missions grouped by target. Each kill counts for one mission from every issuing faction at once, so a stack needs as many kills as its largest faction. Not all kills are logged in your journal, so the tracked count can lag until the game marks a mission complete."
    >
      <LoadingState requestState={massacreRequest}>
        {({ stacks }) => (stacks.length === 0
          ? <div className="notice">No open massacre missions.</div>
          : stacks.map((stack) => (
            <MassacreStack
              key={stack.key}
              stack={stack}
              combat={combatByCommander.get(stack.commanderId)}
              shipStatus={shipStatusByCommander.get(stack.commanderId) ?? null}
              showCommander={commanderFilter === 'all'}
            />
          )))}
      </LoadingState>
    </Section>
  );
}

function MassacreStack({ stack, combat, shipStatus, showCommander }) {
  const { totals } = stack;
  const stationNames = getStationNames(stack.missions);
  const targetLabel = [stack.targetType, stack.isOnFoot ? '(on foot)' : null].filter(Boolean).join(' ');
  return (
    <div className="card mission-stack">
      <header className="mission-stack-header">
        <div>
          <h3>{stack.targetFaction}</h3>
          <div className="muted small">
            {[targetLabel, stack.targetSystem && `in ${formatSystemName(stack.targetSystem)}`, showCommander && `CMDR ${stack.commanderName}`].filter(Boolean).join(' · ')}
          </div>
          {stack.currentSystem && stack.factions.some((faction) => faction.isPresent) && (
            <div className="small">
              <span className="mission-faction-present">Highlighted</span>
              <span className="muted"> factions are present in {formatSystemName(stack.currentSystem)}, where you are now.</span>
            </div>
          )}
        </div>
        <div className="mission-stack-progress">
          <span className="mission-stack-kills">
            <strong>{formatNumber(totals.kills)}</strong> / {formatNumber(totals.killsRequired)} kills
          </span>
          <ProgressBar value={totals.kills} max={totals.killsRequired} />
          <span className="muted small">{formatNumber(totals.killsRemaining)} remaining</span>
        </div>
      </header>

      {isCombatForStack(combat, stack) && <CombatSessionPanel combat={combat} shipStatus={shipStatus} targetFaction={stack.targetFaction} killsRemaining={totals.killsRemaining} />}

      <StatGrid>
        <StackRewardCard stack={stack} />
        <StatCard label="Per kill" value={formatCredits(totals.rewardPerKill)} />
        <StatCard label="Per mission" value={formatCredits(totals.missionCount ? totals.reward / totals.missionCount : 0)} />
        <StatCard label="Missions" value={formatNumber(totals.missionCount)}
          detail={(
            <>
              <span title="Objective complete; return to the issuing station to hand in">{formatNumber(totals.redirectedCount)} complete</span>
              {' · '}
              <span title={stationNames.join(', ')}>{formatNumber(stationNames.length)} {stationNames.length === 1 ? 'station' : 'stations'}</span>
            </>
          )} />
        <StatCard label="Stack ratio" value={`${totals.killRatio.toFixed(2)}×`} detail={`${formatNumber(totals.totalKillCount)} kills across missions`} />
        <StatCard label="Next expiry" value={totals.nextExpiry ? formatRelativeTime(totals.nextExpiry) : '—'}
          detail={totals.nextExpiry ? formatDateTime(totals.nextExpiry) : null} />
      </StatGrid>

      <DataTable
        tableId="missions.massacreFactions"
        rowKey="faction"
        rows={stack.factions}
        columns={[
          {
            key: 'faction',
            label: 'Issuing Faction',
            wrap: true,
            render: (row) => renderFactionName(row.faction, row.isPresent, stack.currentSystem),
          },
          { key: 'missionCount', label: 'Missions', align: 'right', render: (row) => (row.redirectedCount ? `${row.missionCount} (${row.redirectedCount} done)` : row.missionCount) },
          {
            key: 'progress',
            label: 'Kills',
            sortValue: (row) => row.kills / (row.killsRequired || 1),
            render: (row) => (
              <span className="mission-progress-cell">
                <ProgressBar value={row.kills} max={row.killsRequired} />
                <span>{formatNumber(row.kills)} / {formatNumber(row.killsRequired)}</span>
              </span>
            ),
          },
          { key: 'remaining', label: 'Remaining', align: 'right', render: (row) => formatNumber(row.remaining) },
          {
            key: 'difference',
            label: 'Difference',
            align: 'right',
            render: (row) => (row.difference ? <span title="Kills fewer than the largest faction; room to stack more missions">−{formatNumber(row.difference)}</span> : <span className="muted">—</span>),
          },
          { key: 'reward', label: 'Reward', align: 'right', render: (row) => <span title={formatFullCredits(row.reward)}>{formatCredits(row.reward)}</span> },
          { key: 'stations', label: 'Stations', wrap: true, sortValue: (row) => row.stations.join(', '), render: (row) => row.stations.join(', ') || '—' },
        ]}
      />

      <details className="details">
        <summary>Show {totals.missionCount} {totals.missionCount === 1 ? 'mission' : 'missions'}</summary>
        <DataTable
          tableId="missions.massacreMissions"
          rows={stack.missions}
          columns={[
            { key: 'faction', label: 'Faction', wrap: true, render: renderMissionFaction },
            { key: 'origin_station', label: 'Station', render: (row) => row.origin_station ?? '—' },
            { key: 'kill_count', label: 'Kills', sortValue: (row) => row.kills / (row.kill_count || 1), render: (row) => `${formatNumber(Math.min(row.kills, row.kill_count))} / ${formatNumber(row.kill_count)}` },
            { key: 'reward', label: 'Reward', align: 'right', render: (row) => <span title={formatFullCredits(row.reward)}>{formatCredits(row.reward)}</span> },
            { key: 'status', label: 'Status', render: renderStatus },
            { key: 'expiry', label: 'Expires', render: renderExpiry },
            { key: 'accepted_at', label: 'Accepted', render: (row) => formatDateTime(row.accepted_at) },
          ]}
        />
      </details>
    </div>
  );
}

// Warning levels, as in ED AFK Monitor: no kill for 20 minutes, fuel under 20% (10% critical).
// Hull warns once the game reports it under 40% (20% critical).
const NO_KILL_WARNING_S = 20 * 60;
const FUEL_LOW_RATIO = 0.2;
const FUEL_CRITICAL_RATIO = 0.1;
const HULL_LOW_RATIO = 0.4;
const HULL_CRITICAL_RATIO = 0.2;
const HULL_NOTE = 'The game only logs hull damage as it falls past 80%, 60%, 40% and 20%, so this is the last level it reported.';

const FIGHTER_STATUS = {
  deployed: { tone: 'live', label: 'Fighter deployed' },
  destroyed: { tone: 'danger', label: 'Fighter destroyed', alert: 'Your fighter was destroyed. Launch a new one once it’s rebuilt.' },
  ready: { tone: 'warning', label: 'Fighter not deployed', alert: 'Your fighter has been rebuilt but isn’t deployed.' },
  docked: { tone: 'warning', label: 'Fighter not deployed', alert: 'Your fighter is docked. Launch it to keep it fighting.' },
  none: { tone: 'warning', label: 'Fighter not deployed', alert: 'No fighter is deployed.' },
};

/**
 * The commander's current combat session, for watching an AFK massacre run: kill and scan rates,
 * time since the last kill, fuel, the fighter, hardpoints and shields. Kills count only the stack's
 * target faction. Shields come from the commander's journal. shipStatus is the live state from the
 * game's Status.json, when the server has matched it to this commander; it gives up-to-the-second
 * fuel and the hardpoints.
 */
function CombatSessionPanel({ combat, shipStatus, targetFaction, killsRemaining }) {
  const now = useNow(1000);
  const { session, fighter } = combat;
  const liveFlags = session.isActive && shipStatus?.flags?.inMainShip ? shipStatus.flags : null;
  const fuel = combat.fuel && shipStatus?.fuel
    ? { ...combat.fuel, main: shipStatus.fuel.main, at: shipStatus.updatedAt, isLive: true }
    : combat.fuel;
  const endMs = session.isActive ? now : Date.parse(session.endedAt);
  const sessionSeconds = Math.max(0, (endMs - Date.parse(session.startedAt)) / 1000);
  const hasRate = sessionSeconds >= 60;
  const factionKills = combat.kills.byFaction.find((faction) => faction.faction === targetFaction) ?? { count: 0, lastAt: null };
  const killsPerHour = hasRate ? factionKills.count / (sessionSeconds / 3600) : null;
  const scansPerHour = hasRate ? combat.scans.total / (sessionSeconds / 3600) : null;
  // Like the AFK Monitor, time without a kill counts from the session start until the first one.
  const sinceKillSeconds = Math.max(0, (endMs - Date.parse(factionKills.lastAt ?? session.startedAt)) / 1000);

  const fuelRatio = fuel?.capacity ? fuel.main / fuel.capacity : null;
  const fuelHoursLeft = fuel?.perHour ? fuel.main / fuel.perHour : null;
  const fuelTone = fuelRatio === null ? undefined : fuelRatio < FUEL_CRITICAL_RATIO ? 'danger' : fuelRatio < FUEL_LOW_RATIO ? 'warning' : undefined;

  const shipHull = combat.hull?.health ?? null;
  const fighterHull = fighter.state === 'deployed' ? combat.fighterHull?.health ?? null : null;
  const shipHullTone = getHullTone(shipHull);
  const fighterHullTone = getHullTone(fighterHull);

  const fighterStatus = fighter.hasBay === false ? { tone: 'neutral', label: 'No fighter bay' } : FIGHTER_STATUS[fighter.state] ?? FIGHTER_STATUS.none;
  const otherKills = combat.kills.total - factionKills.count;
  // Time to finish the stack's remaining kills at this session's rate, and whether fuel lasts that long.
  const finishSeconds = session.isActive && killsPerHour > 0 && killsRemaining > 0 ? (killsRemaining / killsPerHour) * 3600 : null;
  const isFuelShort = finishSeconds !== null && fuelHoursLeft !== null && fuelHoursLeft * 3600 < finishSeconds;

  // Status badges, and a warning line for each problem while the session is under way.
  const badges = [];
  const alerts = [];
  if (session.isActive) {
    // Unknown (no ShieldState since logging in) counts as up.
    const areShieldsDown = combat.shields?.isUp === false;
    const shieldsTitle = combat.shields?.changedAt && combat.shields.isUp !== null ? `Since ${formatDateTime(combat.shields.changedAt)}` : undefined;
    badges.push(areShieldsDown ? { tone: 'danger', label: 'Shields down', title: shieldsTitle } : { tone: 'live', label: 'Shields up', title: shieldsTitle });
    if (areShieldsDown) alerts.push({ tone: 'danger', text: 'Your shields are down.' });
  }
  if (liveFlags) {
    badges.push(liveFlags.hardpointsDeployed ? { tone: 'live', label: 'Hardpoints deployed' } : { tone: 'warning', label: 'Hardpoints retracted' });
    if (!liveFlags.hardpointsDeployed) alerts.push({ tone: 'warning', text: 'Your hardpoints are retracted, so your ship won’t fire back.' });
  }
  badges.push({ ...fighterStatus, tone: session.isActive ? fighterStatus.tone : 'neutral', title: fighter.changedAt ? `Since ${formatDateTime(fighter.changedAt)}` : undefined });
  if (session.isActive && fighter.hasBay !== false && fighterStatus.alert) alerts.push({ tone: fighterStatus.tone, text: fighterStatus.alert });
  if (session.isActive && shipHullTone) alerts.push({ tone: shipHullTone, text: `Your ship’s hull is down to ${formatPercent(shipHull)}.` });
  if (session.isActive && fighterHullTone) alerts.push({ tone: fighterHullTone, text: `Your fighter’s hull is down to ${formatPercent(fighterHull)}.` });
  const alertTone = alerts.some((alert) => alert.tone === 'danger') ? 'danger' : alerts.length ? 'warning' : null;

  return (
    <div className={['combat-panel', !session.isActive && 'combat-panel-ended', alertTone && `combat-panel-alert-${alertTone}`].filter(Boolean).join(' ')}>
      <div className="combat-panel-header">
        <span className="combat-panel-status">
          <span className={`combat-status-dot ${session.isActive ? 'combat-status-dot-live' : ''}`} aria-hidden="true" />
          <strong>{session.isActive ? 'In combat' : 'Last session'}</strong>
          <span className="muted">
            {[
              session.location,
              session.isActive ? `${formatElapsed(sessionSeconds)} so far` : `${formatElapsed(sessionSeconds)}, ended ${formatRelativeTime(session.endedAt)}`,
            ].filter(Boolean).join(' · ')}
          </span>
        </span>
        <span className="combat-panel-badges">
          {badges.map((badge) => <Badge key={badge.label} tone={badge.tone} title={badge.title}>{badge.label}</Badge>)}
        </span>
      </div>

      {alerts.map((alert) => (
        <div key={alert.text} className={`combat-panel-alert combat-panel-alert-text-${alert.tone}`}>⚠ {alert.text}</div>
      ))}

      <div className="combat-metrics">
        <CombatMetric
          label="Kills / hour"
          value={killsPerHour === null ? '—' : killsPerHour.toFixed(1)}
          detail={`${formatNumber(factionKills.count)} ${factionKills.count === 1 ? 'kill' : 'kills'}${otherKills ? ` (+${formatNumber(otherKills)} other)` : ''}`}
          title={`Kills of ${targetFaction} this session${otherKills ? `; ${otherKills} kills of other factions don’t count toward this stack` : ''}`}
        />
        <CombatMetric
          label="Scans / hour"
          value={scansPerHour === null ? '—' : scansPerHour.toFixed(1)}
          detail={`${formatNumber(combat.scans.total)} cargo ${combat.scans.total === 1 ? 'scan' : 'scans'}`}
          title="Pirates scanning your cargo this session (repeat scans by the same pirate count once)"
        />
        <CombatMetric
          label={factionKills.lastAt ? 'Since last kill' : 'No kills yet'}
          value={formatElapsed(sinceKillSeconds)}
          tone={session.isActive && sinceKillSeconds >= NO_KILL_WARNING_S ? 'warning' : undefined}
          detail={factionKills.lastAt ? `at ${new Date(factionKills.lastAt).toLocaleTimeString()}` : 'since the session started'}
        />
        <CombatMetric
          label="Time to finish"
          value={killsRemaining === 0 ? 'Done' : finishSeconds === null ? '—' : formatEstimate(finishSeconds)}
          tone={isFuelShort ? 'warning' : undefined}
          detail={killsRemaining === 0
            ? 'all kills done'
            : finishSeconds === null
              ? `${formatNumber(killsRemaining)} kills left`
              : isFuelShort ? 'fuel runs out first' : `${formatNumber(killsRemaining)} kills, done ${formatClockTime(now + finishSeconds * 1000)}`}
          title={`${formatNumber(killsRemaining)} kills left in this stack at this session’s kill rate${killsPerHour ? ` (${killsPerHour.toFixed(1)}/h)` : ''}. Kills by wingmates aren’t in your journal, so it may finish sooner.`}
        />
        <CombatMetric
          label="Fuel"
          value={fuelRatio === null ? '—' : `${Math.round(fuelRatio * 100)}%`}
          tone={fuelTone}
          detail={fuel ? [
            `${fuel.main.toFixed(1)} t`,
            fuelHoursLeft !== null ? `${formatEstimate(fuelHoursLeft * 3600)} left` : session.isActive && 'time left pending',
          ].filter(Boolean).join(' · ') : null}
          title={fuel ? [
            `As of ${formatDateTime(fuel.at)}${fuel.isLive ? '' : ' (the journal reports fuel every few minutes)'}.`,
            fuel.perHour
              ? `Burning ${fuel.perHour.toFixed(2)} t/h, from the last two fuel transfers this session.`
              : 'Time left is worked out from the fuel used between two fuel transfers in this session.',
          ].join('\n') : undefined}
        />
        <CombatMetric
          label="Hull"
          value={shipHull === null ? '—' : formatPercent(shipHull)}
          tone={shipHullTone}
          detail={fighter.state === 'deployed'
            ? `Fighter ${fighterHull === null ? '—' : formatPercent(fighterHull)}`
            : shipHull === null ? 'unknown since repairs' : 'ship'}
          title={[
            shipHull === null ? 'Ship hull unknown: repair limpets don’t report how much of the hull they restored.' : `Ship hull as of ${formatDateTime(combat.hull.changedAt)}.`,
            fighter.state === 'deployed' && fighterHull !== null && `Fighter hull as of ${formatDateTime(combat.fighterHull.changedAt)}.`,
            HULL_NOTE,
          ].filter(Boolean).join('\n')}
        />
      </div>
    </div>
  );
}

/**
 * The combat panel is for the commander playing right now in the stack's target system: their
 * journal is active, they're in that system, and their latest session was there.
 */
function isCombatForStack(combat, stack) {
  if (!combat?.isJournalActive || !stack.targetSystem) return false;
  const targetSystem = stack.targetSystem.toLowerCase();
  return combat.currentSystem?.toLowerCase() === targetSystem && combat.session.system?.toLowerCase() === targetSystem;
}

function getHullTone(health) {
  if (health === null) return undefined;
  return health < HULL_CRITICAL_RATIO ? 'danger' : health < HULL_LOW_RATIO ? 'warning' : undefined;
}

function formatPercent(ratio) {
  return `${Math.round(ratio * 100)}%`;
}

function CombatMetric({ label, value, detail, tone, title }) {
  return (
    <div className={`combat-metric ${tone ? `combat-metric-${tone}` : ''}`} title={title}>
      <span className="combat-metric-label">{label}</span>
      <span className="combat-metric-value">{value}</span>
      {detail && <span className="combat-metric-detail">{detail}</span>}
    </div>
  );
}

/** A future time of day, e.g. "3:45 AM", with the weekday when it's a day or more away. */
function formatClockTime(timeMs) {
  const date = new Date(timeMs);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return timeMs - Date.now() < 24 * 3600 * 1000 ? time : `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** An estimated duration, to the minute: "~45m", "~3h 04m". */
function formatEstimate(totalSeconds) {
  const minutes = Math.max(1, Math.round(totalSeconds / 60));
  return minutes < 60 ? `~${minutes}m` : `~${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Elapsed time as "45s", "12m 05s" or "3h 04m". */
function formatElapsed(totalSeconds) {
  const seconds = Math.floor(totalSeconds);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** The current time, updated every intervalMs. */
function useNow(intervalMs) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const COPIED_MESSAGE_MS = 1500;

/** The distinct stations the missions were taken at (the system, when no station was recorded). */
function getStationNames(missions) {
  return [...new Set(missions.map((mission) => mission.origin_station ?? mission.origin_system).filter(Boolean))].sort();
}

/**
 * The stack's reward. With wing missions in the stack, clicking copies the wing-shareable amount
 * and how many stations those missions came from, e.g. "286.17M cr (2 stations)".
 */
function StackRewardCard({ stack }) {
  const { totals } = stack;
  const [copyStatus, setCopyStatus] = useState(null); // null | 'copied' | 'failed'
  useEffect(() => {
    if (!copyStatus) return undefined;
    const resetTimer = setTimeout(() => setCopyStatus(null), COPIED_MESSAGE_MS);
    return () => clearTimeout(resetTimer);
  }, [copyStatus]);

  if (!totals.wingReward) return <StatCard label="Reward" value={formatCredits(totals.reward)} tone="accent" />;

  const wingStationCount = getStationNames(stack.missions.filter((mission) => mission.is_wing)).length;
  const copyText = `${formatCredits(totals.wingReward)} (${wingStationCount} ${wingStationCount === 1 ? 'station' : 'stations'})`;
  const copy = async () => setCopyStatus((await copyToClipboard(copyText)) ? 'copied' : 'failed');
  return (
    <button type="button" className="stat-card stat-card-accent stat-card-button" onClick={copy} title={`Click to copy the wing-shareable reward (${formatFullCredits(totals.wingReward)}): ${copyText}`}>
      <div className="stat-label">Reward</div>
      <div className="stat-value">{formatCredits(totals.reward)}</div>
      <div className="stat-detail">
        {copyStatus
          ? <span className={`copy-status-text-${copyStatus}`}>{copyStatus === 'copied' ? `Copied ${copyText}` : 'Copy failed'}</span>
          : renderWingReward(totals.wingReward)}
      </div>
    </button>
  );
}

function CargoSection({ commanderFilter }) {
  const [showAllTypes, setShowAllTypes] = useState(false);
  const cargoRequest = useApi('/api/stats/missions/cargo', { commander: commanderFilter });
  const showCommander = commanderFilter === 'all';

  return (
    <Section
      id="missions-cargo"
      title="Mining & Cargo"
      description="Open missions that need a commodity, with what’s been delivered and what’s already in the hold (from the latest cargo update)."
      actions={(
        <label className="checkbox">
          <input type="checkbox" checked={showAllTypes} onChange={(changeEvent) => setShowAllTypes(changeEvent.target.checked)} />
          Include Delivery and Source Missions
        </label>
      )}
    >
      <LoadingState requestState={cargoRequest}>
        {({ missions: allMissions }) => {
          const missions = showAllTypes ? allMissions : allMissions.filter((mission) => mission.category === 'mining');
          if (missions.length === 0) {
            return <div className="notice">{showAllTypes ? 'No open cargo missions.' : 'No open mining missions.'}</div>;
          }
          const commodities = summarizeCommodities(missions, cargoRequest.data.commodities);
          return (
            <>
              <DataTable
                tableId="missions.cargoCommodities"
                rowKey="key"
                rows={commodities}
                columns={[
                  { key: 'commodityName', label: 'Commodity' },
                  ...(showCommander ? [{ key: 'commanderName', label: 'Commander', render: (row) => `CMDR ${row.commanderName}` }] : []),
                  { key: 'missionCount', label: 'Missions', align: 'right' },
                  {
                    key: 'progress',
                    label: 'Delivered',
                    sortValue: (row) => row.delivered / (row.required || 1),
                    render: (row) => (
                      <span className="mission-progress-cell">
                        <ProgressBar value={row.delivered} max={row.required} />
                        <span>{formatNumber(row.delivered)} / {formatNumber(row.required)} t</span>
                      </span>
                    ),
                  },
                  { key: 'remaining', label: 'Remaining', align: 'right', render: (row) => `${formatNumber(row.remaining)} t` },
                  { key: 'inCargo', label: 'In Hold', align: 'right', render: (row) => (row.inCargo ? `${formatNumber(row.inCargo)} t` : <span className="muted">—</span>) },
                  {
                    key: 'stillToFind',
                    label: 'Still Needed',
                    align: 'right',
                    render: (row) => (row.stillToFind ? <strong>{formatNumber(row.stillToFind)} t</strong> : <Badge tone="live">Have enough</Badge>),
                  },
                  { key: 'reward', label: 'Reward', align: 'right', render: (row) => <span title={formatFullCredits(row.reward)}>{formatCredits(row.reward)}</span> },
                ]}
              />
              <h3 className="subheading">Missions</h3>
              <DataTable
                tableId="missions.cargoMissions"
                rows={missions}
                columns={[
                  { key: 'category', label: 'Type', render: (row) => getCategoryLabel(row.category) },
                  ...(showCommander ? [{ key: 'commander_name', label: 'Commander', render: (row) => `CMDR ${row.commander_name}` }] : []),
                  { key: 'commodity_name', label: 'Commodity' },
                  {
                    key: 'progress',
                    label: 'Delivered',
                    sortValue: (row) => row.delivered / (row.commodity_count || 1),
                    render: (row) => (
                      <span className="mission-progress-cell">
                        <ProgressBar value={row.delivered} max={row.commodity_count} />
                        <span>{formatNumber(row.delivered)} / {formatNumber(row.commodity_count)} t</span>
                      </span>
                    ),
                  },
                  { key: 'faction', label: 'Faction', wrap: true, render: renderMissionFaction },
                  {
                    key: 'destination',
                    label: 'Deliver To',
                    sortValue: getDestinationText,
                    render: (row) => renderPlace(row.destination_system, row.destination_station),
                  },
                  { key: 'reward', label: 'Reward', align: 'right', render: (row) => <span title={formatFullCredits(row.reward)}>{formatCredits(row.reward)}</span> },
                  { key: 'status', label: 'Status', render: renderStatus },
                  { key: 'expiry', label: 'Expires', render: renderExpiry },
                ]}
              />
            </>
          );
        }}
      </LoadingState>
    </Section>
  );
}

/** The server's commodity totals, limited to the commodities of the missions shown. */
function summarizeCommodities(missions, allCommodities) {
  const totalsByKey = new Map();
  for (const mission of missions) {
    const key = `${mission.commander_id}|${mission.commodity}`;
    const totals = totalsByKey.get(key) ?? { missionCount: 0, required: 0, delivered: 0, remaining: 0, reward: 0 };
    totals.missionCount += 1;
    totals.required += mission.commodity_count;
    totals.delivered += mission.delivered;
    totals.remaining += mission.remaining;
    totals.reward += mission.reward ?? 0;
    totalsByKey.set(key, totals);
  }
  return allCommodities
    .filter((commodity) => totalsByKey.has(commodity.key))
    .map((commodity) => {
      const totals = totalsByKey.get(commodity.key);
      return { ...commodity, ...totals, stillToFind: Math.max(0, totals.remaining - commodity.inCargo) };
    });
}

function HistorySection({ commanderFilter }) {
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

/** Wing mission marker after the game's: a blue ring with a dark core and three blue circles centred on the ring. */
function WingIcon() {
  return (
    <svg className="mission-wing-icon" viewBox="0 0 24 24" role="img" aria-label="Wing mission">
      <title>Wing mission</title>
      <circle className="mission-wing-icon-outline" cx="12" cy="13" r="9.1" />
      <circle className="mission-wing-icon-ring" cx="12" cy="13" r="7.7" />
      <circle className="mission-wing-icon-core" cx="12" cy="13" r="5" />
      <circle className="mission-wing-icon-ship" cx="12" cy="5.3" r="4" />
      <circle className="mission-wing-icon-ship" cx="5.33" cy="16.85" r="4" />
      <circle className="mission-wing-icon-ship" cx="18.67" cy="16.85" r="4" />
    </svg>
  );
}

/** A stat card note for the reward that can be shared with a wing; kept to one line. */
function renderWingReward(amount) {
  if (!amount) return null;
  return (
    <span className="mission-wing-reward" title={`${formatFullCredits(amount)} from wing missions, shareable with your wing`}>
      <WingIcon />{formatCredits(amount)}
    </span>
  );
}

/** A faction name, highlighted when the faction is present in the commander's current system. */
function renderFactionName(faction, isPresent, currentSystem) {
  if (!isPresent) return faction;
  const where = currentSystem ? formatSystemName(currentSystem) : 'your current system';
  return <span className="mission-faction-present" title={`Present in ${where}`}>{faction}</span>;
}

/** The issuing faction, marked when the mission can be shared with a wing. */
function renderMissionFaction(mission) {
  return (
    <>
      {Boolean(mission.is_wing) && <WingIcon />}
      {renderFactionName(mission.faction, mission.is_faction_present)}
    </>
  );
}

function renderObjective(mission) {
  if (mission.kill_count) {
    const target = [mission.target_type, mission.target_faction && `of ${mission.target_faction}`].filter(Boolean).join(' ');
    return `Kill ${formatNumber(mission.kill_count)} ${target}`.trim();
  }
  if (mission.commodity_count && mission.commodity_name) return `${formatNumber(mission.commodity_count)} t ${mission.commodity_name}`;
  if (mission.passenger_count) return `${formatNumber(mission.passenger_count)} ${mission.passenger_type ?? 'passengers'}`;
  if (mission.target) return mission.target;
  if (mission.target_faction) return mission.target_faction;
  return <span className="muted">—</span>;
}

/** A station (or the system without one), with the full location on hover. */
function renderPlace(system, station) {
  if (!system && !station) return <span className="muted">—</span>;
  return <span title={[formatSystemName(system), station].filter(Boolean).join(' · ')}>{station ?? formatSystemName(system)}</span>;
}

function getDestinationText(mission) {
  return [formatSystemName(mission.destination_system), mission.destination_station ?? mission.destination_settlement].filter(Boolean).join(' · ') || '—';
}

function renderStatus(mission) {
  const badge = STATUS_BADGES[mission.status] ?? { tone: 'neutral', label: mission.status };
  return <Badge tone={badge.tone} title={badge.title}>{badge.label}</Badge>;
}

function renderExpiry(mission) {
  if (!mission.expiry) return <span className="muted">—</span>;
  const isSoon = Date.parse(mission.expiry) - Date.now() < 60 * MINUTE_MS && Date.parse(mission.expiry) > Date.now();
  return <span className={isSoon ? 'mission-expiring' : undefined} title={formatDateTime(mission.expiry)}>{formatRelativeTime(mission.expiry)}</span>;
}

function getCategoryLabel(category) {
  return CATEGORY_LABELS[category] ?? category;
}
