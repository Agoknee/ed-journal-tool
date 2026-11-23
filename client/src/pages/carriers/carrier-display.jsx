import CopyableText from '../../components/CopyableText.jsx';
import { formatSystemName } from '../../format.js';

/**
 * Carrier display helpers: labels, jump countdowns, and the overview rows (one per owned carrier,
 * or per commander without one).
 */

export const CARRIER_TYPE_BADGE_TONES = { FleetCarrier: 'fleet-carrier', SquadronCarrier: 'squadron-carrier' };

// The journal's lowercase DockingAccess values and TaxRate_* service names, for display.
const DOCKING_ACCESS_LABELS = { squadronfriends: 'Squadron & Friends' };

const TAX_SERVICE_LABELS = { pioneersupplies: 'Pioneer Supplies' };

export function toTitleCase(text) {
  return text.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

export function formatDockingAccess(dockingAccess) {
  return DOCKING_ACCESS_LABELS[dockingAccess] ?? toTitleCase(dockingAccess);
}

export function formatTaxService(service) {
  return TAX_SERVICE_LABELS[service] ?? toTitleCase(service);
}

export function compareTimestamps(first, second, order) {
  if (!first || !second) return Number(!first) - Number(!second);
  return order === 'asc' ? first.localeCompare(second) : second.localeCompare(first);
}

export function getCarrierLabel(carrier) {
  return carrier.name ?? carrier.callsign ?? '';
}

/**
 * One overview row per owned carrier, oldest purchase first (first seen when the purchase isn't in the
 * journals), then one row per commander without a carrier.
 */
export function buildOverviewRows(commanderStatuses, carriers) {
  return commanderStatuses
    .flatMap((status) => {
      const ownedCarriers = [...status.fleetCarrierIds, ...status.squadronCarrierIds]
        .map((carrierId) => carriers.find((carrier) => carrier.carrier_id === carrierId));
      if (ownedCarriers.length === 0) {
        return [{ rowKey: `${status.commanderId}`, status, carrier: null }];
      }
      return ownedCarriers.map((carrier) => ({ rowKey: `${status.commanderId}-${carrier.carrier_id}`, status, carrier }));
    })
    .sort((first, second) => compareTimestamps(first.carrier?.acquired_at, second.carrier?.acquired_at, 'asc'));
}

/**
 * The carrier's jump state, with the time its countdown runs to:
 * - scheduled: a requested jump that hasn't departed (the destination is pending_jump)
 * - cooldown: 4:50 after a jump departs, 1 minute after one is cancelled
 */
export function getJumpState(carrier, now) {
  const pendingJump = carrier?.pending_jump;
  if (pendingJump?.departureTime && Date.parse(pendingJump.departureTime) > now) {
    return { kind: 'scheduled', jump: pendingJump, endsAt: pendingJump.departureTime };
  }
  if (carrier?.cooldown_ends_at && Date.parse(carrier.cooldown_starts_at) <= now && Date.parse(carrier.cooldown_ends_at) > now) {
    return { kind: 'cooldown', endsAt: carrier.cooldown_ends_at };
  }
  return null;
}

/** Lock stages before a jump departs, as the game shows them (most restrictive first). */
const JUMP_LOCK_STAGES = [
  { label: 'Pad Locked', beforeDepartureMs: (3 * 60 + 20) * 1000 },
  { label: 'Jump Locked', beforeDepartureMs: 10 * 60 * 1000 },
];

export function getJumpLockLabel(departureTime, now) {
  const msUntilDeparture = Date.parse(departureTime) - now;
  return JUMP_LOCK_STAGES.find((stage) => msUntilDeparture <= stage.beforeDepartureMs)?.label ?? null;
}

/** Whole seconds remaining, rounded up like the game's timers. */
export function formatCountdown(targetTimestamp, now) {
  const totalSeconds = Math.max(0, Math.ceil((Date.parse(targetTimestamp) - now) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** The squadron ID (e.g. PBNS), copied on click; the full name shows on hover. "?" when the squadron's carrier hasn't been seen. */
export function renderSquadronId(squadronId, squadronName) {
  if (!squadronName) return '—';
  if (!squadronId) return <span title={squadronName}>?</span>;
  return <CopyableText copyText={squadronId} title={squadronName}>{squadronId}</CopyableText>;
}

/**
 * System and (if any) body. Body names usually start with the system name ("Synuefe NL-N c23-4 A"),
 * so only the remaining part is shown; a body named exactly like the system is its main star.
 * Clicking copies only the system name.
 */
export function renderSystemAndBody(starSystem, body) {
  if (!starSystem) return '—';
  const bodySuffix = body === starSystem ? 'Star'
    : body?.startsWith(starSystem) ? body.slice(starSystem.length).trim() : body;
  return (
    <CopyableText copyText={starSystem}>
      {formatSystemName(starSystem)}
      {bodySuffix && <span className="muted small"> · {bodySuffix}</span>}
    </CopyableText>
  );
}
