import { Badge } from '../../components/ui.jsx';
import { formatCredits, formatDateTime, formatFullCredits, formatNumber, formatRelativeTime, formatSystemName } from '../../format.js';
import { WingIcon } from './WingIcon.jsx';

/**
 * Shared display helpers for missions: category and status labels, faction and objective cells,
 * expiry countdowns and wing-mission rewards.
 */

export const CATEGORY_LABELS = {
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

export const MINUTE_MS = 60 * 1000;

/** The distinct stations the missions were taken at (the system, when no station was recorded). */
export function getStationNames(missions) {
  return [...new Set(missions.map((mission) => mission.origin_station ?? mission.origin_system).filter(Boolean))].sort();
}

/** A stat card note for the reward that can be shared with a wing; kept to one line. */
export function renderWingReward(amount) {
  if (!amount) return null;
  return (
    <span className="mission-wing-reward" title={`${formatFullCredits(amount)} from wing missions, shareable with your wing`}>
      <WingIcon />{formatCredits(amount)}
    </span>
  );
}

/** A faction name, highlighted when the faction is present in the commander's current system. */
export function renderFactionName(faction, isPresent, currentSystem) {
  if (!isPresent) return faction;
  const where = currentSystem ? formatSystemName(currentSystem) : 'your current system';
  return <span className="mission-faction-present" title={`Present in ${where}`}>{faction}</span>;
}

/** The issuing faction, marked when the mission can be shared with a wing. */
export function renderMissionFaction(mission) {
  return (
    <>
      {Boolean(mission.is_wing) && <WingIcon />}
      {renderFactionName(mission.faction, mission.is_faction_present)}
    </>
  );
}

export function renderObjective(mission) {
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
export function renderPlace(system, station) {
  if (!system && !station) return <span className="muted">—</span>;
  return <span title={[formatSystemName(system), station].filter(Boolean).join(' · ')}>{station ?? formatSystemName(system)}</span>;
}

export function getDestinationText(mission) {
  return [formatSystemName(mission.destination_system), mission.destination_station ?? mission.destination_settlement].filter(Boolean).join(' · ') || '—';
}

export function renderStatus(mission) {
  const badge = STATUS_BADGES[mission.status] ?? { tone: 'neutral', label: mission.status };
  return <Badge tone={badge.tone} title={badge.title}>{badge.label}</Badge>;
}

export function renderExpiry(mission) {
  if (!mission.expiry) return <span className="muted">—</span>;
  const isSoon = Date.parse(mission.expiry) - Date.now() < 60 * MINUTE_MS && Date.parse(mission.expiry) > Date.now();
  return <span className={isSoon ? 'mission-expiring' : undefined} title={formatDateTime(mission.expiry)}>{formatRelativeTime(mission.expiry)}</span>;
}

export function getCategoryLabel(category) {
  return CATEGORY_LABELS[category] ?? category;
}
