import { getShipTypeName, VEHICLE_NAMES } from './ships.mjs';
import { normalizeItem } from './names.mjs';

/** Thargoid ship types as the journal logs them (Died KillerShip, Bounty Target). */
const THARGOID_NAMES = {
  thargon: 'Thargon', thargonswarm: 'Thargon swarm',
  // Four Scout ids, but which variant (Marauder, Berserker, Regenerator, Inciter) each one is isn't
  // documented, so they're kept apart by id rather than guessed.
  scout: 'Thargoid Scout', scout_q: 'Thargoid Scout (scout_q)', scout_nq: 'Thargoid Scout (scout_nq)', scout_hq: 'Thargoid Scout (scout_hq)',
  glaive: 'Glaive Hunter', scythe: 'Scythe Hunter',
  cyclops: 'Cyclops Interceptor', basilisk: 'Basilisk Interceptor', medusa: 'Medusa Interceptor', hydra: 'Hydra Interceptor',
  orthrus: 'Orthrus', revenant: 'Revenant', banshee: 'Banshee',
};

/** Stations, carriers and other structures whose defences can kill a ship. */
const STRUCTURE_PATTERNS = [
  [/^outpost/, 'Outpost defences'],
  [/^(coriolis|orbis|ocellus|bernal|dodec|asteroidbase|station)/, 'Station defences'],
  [/^megaship/, 'Megaship defences'],
  [/^carrierdock/, 'Fleet carrier defences'],
  [/^(planetaryport|surfacestation|installation|settlement)/, 'Settlement defences'],
];

const ON_FOOT_PATTERN = /suitai_/;

/** What kind of combatant a ship type is: ship | thargoid | structure | on_foot. */
export function getCombatantKind(shipType) {
  const key = normalizeItem(shipType);
  if (!key) return null;
  if (THARGOID_NAMES[key]) return 'thargoid';
  if (STRUCTURE_PATTERNS.some(([pattern]) => pattern.test(key))) return 'structure';
  if (ON_FOOT_PATTERN.test(key)) return 'on_foot';
  return 'ship';
}

/** The display name of a ship type a commander fought ("empire_eagle" -> "Imperial Eagle", "thargonswarm" -> "Thargon swarm"). */
export function getCombatantName(shipType) {
  const key = normalizeItem(shipType);
  if (!key) return null;
  if (THARGOID_NAMES[key]) return THARGOID_NAMES[key];
  const structure = STRUCTURE_PATTERNS.find(([pattern]) => pattern.test(key));
  if (structure) return structure[1];
  if (ON_FOOT_PATTERN.test(key)) return 'NPC soldier';
  if (VEHICLE_NAMES[key]) return VEHICLE_NAMES[key];
  return getShipTypeName(key);
}

/** Pilot combat ranks from lowest to highest, as ShipTargeted logs them. */
export const PILOT_RANKS = ['Harmless', 'Mostly Harmless', 'Novice', 'Competent', 'Expert', 'Master', 'Dangerous', 'Deadly', 'Elite'];
