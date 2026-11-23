import { Badge } from '../../components/ui.jsx';
import { formatDateTime, formatNumber, formatRelativeTime } from '../../format.js';
import { useNow } from '../../hooks/use-now.js';

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
export function CombatSessionPanel({ combat, shipStatus, targetFaction, killsRemaining }) {
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
