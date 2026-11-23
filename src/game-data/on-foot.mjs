import { tidyName } from './names.mjs';

/** Suit display names by the journal's internal suit type (without its class). */
const SUIT_NAMES = { flightsuit: 'Flight Suit', utilitysuit: 'Maverick Suit', explorationsuit: 'Artemis Suit', tacticalsuit: 'Dominator Suit' };

/** Suit and weapon modification names by their internal names. */
const MODIFICATION_NAMES = {
  suit_backpackcapacity: 'Extra Backpack Capacity', suit_increasedammoreserves: 'Extra Ammo Capacity',
  suit_increasedbatterycapacity: 'Improved Battery Capacity', suit_improvedjumpassist: 'Improved Jump Assist',
  suit_increasedmeleedamage: 'Added Melee Damage', suit_increasedo2capacity: 'Increased Air Reserves',
  suit_increasedshieldregen: 'Faster Shield Regen', suit_increasedsprintduration: 'Increased Sprint Duration',
  suit_improvedradar: 'Enhanced Tracking', suit_nightvision: 'Night Vision', suit_quieterfootsteps: 'Quieter Footsteps',
  suit_reducedtoolbatteryconsumption: 'Reduced Tool Battery Consumption', suit_improvedarmourrating: 'Damage Resistance',
  weapon_handling: 'Faster Handling', weapon_scope: 'Scope', weapon_stability: 'Stability', weapon_range: 'Greater Range',
  weapon_clipsize: 'Magazine Size', weapon_reloadspeed: 'Reload Speed', weapon_accuracy: 'Improved Hip Fire Accuracy',
  weapon_headshotdamage: 'Headshot Damage', weapon_suppression_unpressurised: 'Noise Suppressor', weapon_backpackreloading: 'Stowed Reloading',
};

/** "utilitysuit_class3" -> "Maverick Suit". */
export function getSuitName(item) {
  return SUIT_NAMES[item?.replace(/_class\d+$/, '')] ?? tidyName(item);
}

/** "suit_nightvision" -> "Night Vision". */
export function getModificationName(modification) {
  return MODIFICATION_NAMES[modification] ?? tidyName(String(modification).replace(/^(suit|weapon)_/, ''));
}
