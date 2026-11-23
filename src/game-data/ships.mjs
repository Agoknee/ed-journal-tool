import { normalizeItem, tidyName } from './names.mjs';

/** Ship display names by the journal's internal ship type. */
export const SHIP_NAMES = {
  sidewinder: 'Sidewinder', eagle: 'Eagle', hauler: 'Hauler', adder: 'Adder', empire_eagle: 'Imperial Eagle',
  viper: 'Viper Mk III', cobramkiii: 'Cobra Mk III', viper_mkiv: 'Viper Mk IV', diamondback: 'Diamondback Scout',
  cobramkiv: 'Cobra Mk IV', cobramkv: 'Cobra Mk V', type6: 'Type-6 Transporter', dolphin: 'Dolphin',
  diamondbackxl: 'Diamondback Explorer', empire_courier: 'Imperial Courier', independant_trader: 'Keelback',
  asp_scout: 'Asp Scout', vulture: 'Vulture', asp: 'Asp Explorer', federation_dropship: 'Federal Dropship',
  type7: 'Type-7 Transporter', typex: 'Alliance Chieftain', federation_dropship_mkii: 'Federal Assault Ship',
  empire_trader: 'Imperial Clipper', typex_2: 'Alliance Crusader', typex_3: 'Alliance Challenger',
  federation_gunship: 'Federal Gunship', krait_light: 'Krait Phantom', krait_mkii: 'Krait Mk II', orca: 'Orca',
  ferdelance: 'Fer-de-Lance', mamba: 'Mamba', python: 'Python', python_nx: 'Python Mk II', type8: 'Type-8 Transporter',
  type9: 'Type-9 Heavy', belugaliner: 'Beluga Liner', type9_military: 'Type-10 Defender', anaconda: 'Anaconda',
  federation_corvette: 'Federal Corvette', cutter: 'Imperial Cutter', mandalay: 'Mandalay', panthermkii: 'Panther Clipper Mk II',
  corsair: 'Corsair', explorer_nx: 'Caspian Explorer', lakonminer: 'Type-11 Prospector', smallcombat01_nx: 'Kestrel Mk II',
  mediumtransport01: 'Lynx Highliner',
};

/** Fighter and SRV display names by the journal's internal type. */
export const VEHICLE_NAMES = {
  independent_fighter: 'Taipan', federation_fighter: 'F63 Condor', empire_fighter: 'GU-97',
  gdn_hybrid_fighter_v1: 'Trident', gdn_hybrid_fighter_v2: 'Javelin', gdn_hybrid_fighter_v3: 'Lance',
  testbuggy: 'SRV Scarab', combat_multicrew_srv_01: 'SRV Scorpion',
};

/** A ship type's display name ("type9_military" -> "Type-10 Defender"). */
export function getShipTypeName(shipType) {
  const key = normalizeItem(shipType);
  return SHIP_NAMES[key] ?? tidyName(key);
}

/**
 * What LoadGame reports as the "ship" when the commander logs in somewhere other than their own
 * ship: on foot (a suit), in an SRV or fighter, or riding a transport such as the Nomad (lander01).
 * Suits also have IDs from 4293000000 up.
 */
const NON_SHIP_TYPE_PATTERN = /suit($|_)|^testbuggy$|_srv_|_fighter($|_)|^lander\d|taxi/;
const FIRST_SUIT_ID = 4293000000;

/** Whether a LoadGame-style Ship/ShipID is one of the commander's own ships. */
export function isOwnShip(shipType, shipId) {
  const key = normalizeItem(shipType);
  if (!key || NON_SHIP_TYPE_PATTERN.test(key)) return false;
  return !(Number.isInteger(shipId) && shipId >= FIRST_SUIT_ID);
}
