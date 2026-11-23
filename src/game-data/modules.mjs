import { tidyBlueprint, tidyName } from './names.mjs';

/**
 * Ship modules: display names, ratings and slot names for what the journal's Loadout logs.
 */
const CLASS_LETTERS = ['', 'E', 'D', 'C', 'B', 'A'];
const ARMOUR_NAMES = { grade1: 'Lightweight Alloy', grade2: 'Reinforced Alloy', grade3: 'Military Grade Composite', mirrored: 'Mirrored Surface Composite', reactive: 'Reactive Surface Composite' };
const HARDPOINT_SIZES = ['small', 'medium', 'large', 'huge'];
const HARDPOINT_MOUNTS = { fixed: 'Fixed', gimbal: 'Gimballed', turret: 'Turreted' };
// Names for items the game doesn't always log a localised name for.
const ITEM_NAMES = {
  int_fighterbay: 'Fighter Hangar', int_fighterbaymk2: 'Fighter Hangar', int_buggybay: 'Planetary Vehicle Hangar',
  int_planetapproachsuite: 'Planetary Approach Suite', int_planetapproachsuite_advanced: 'Advanced Planetary Approach Suite',
};
// Cosmetic slots, left out of loadouts.
const COSMETIC_SLOT_PATTERN = /^(PaintJob|Decal\d|ShipName\d|ShipID\d|Bobble\d+|VesselVoice|WeaponColour|EngineColour|ShipKit|StringLights|ShipCockpit|CargoHatch$)/i;
const SIZED_ITEM_PATTERN = /_size(\d+)_class(\d+)/;

export function isCosmeticSlot(slot) {
  return COSMETIC_SLOT_PATTERN.test(slot ?? '');
}

/** "Slot04_Size6" -> "Optional 4 (size 6)"; "TinyHardpoint3" -> "Utility 3"; "PrimaryWeapon1" -> "Primary 1". */
export function tidySlot(slot) {
  if (!slot) return null;
  const optional = /^Slot(\d+)_Size(\d+)$/.exec(slot);
  if (optional) return `Optional ${Number(optional[1])} (size ${optional[2]})`;
  const hardpoint = /^(Tiny|Small|Medium|Large|Huge)Hardpoint(\d+)$/.exec(slot);
  if (hardpoint) return hardpoint[1] === 'Tiny' ? `Utility ${hardpoint[2]}` : `${hardpoint[1]} hardpoint ${hardpoint[2]}`;
  const weapon = /^(Primary|Secondary)Weapon(\d*)$/.exec(slot);
  if (weapon) return `${weapon[1]}${weapon[2] ? ` ${weapon[2]}` : ''}`;
  return slot.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** "MaxFuelPerJump" -> "Max fuel per jump"; acronyms stay ("FSDOptimalMass" -> "FSD optimal mass"). */
export function tidyStatLabel(label) {
  const words = String(label).replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/\s+/);
  const sentence = words.map((word, index) => (/^[A-Z]{2,}$/.test(word) || index === 0 ? word : word.toLowerCase())).join(' ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function tidyModuleName(item) {
  if (!item) return '—';
  return tidyName(item.replace(/^(hpt|int|ext)_/, '').replace(/_size\d+_class\d+.*$/, '').replace(/_(fixed|gimbal|turret)?_?(tiny|small|medium|large|huge)$/, ''));
}

/**
 * A describer for modules, given the localised names the game has logged (item -> name). A
 * localised name for one size of a module names the others too ("Cargo Rack" for every rack).
 * @param {Map<string, string>} localisedNames
 */
export function createModuleDescriber(localisedNames) {
  const namesByBaseItem = new Map();
  for (const [item, name] of localisedNames) {
    // The first name logged for any size of the module, as the names come in.
    const baseItem = item.replace(/_size\d+_class\d+.*$/, '');
    if (baseItem !== item && !namesByBaseItem.has(baseItem)) namesByBaseItem.set(baseItem, name);
  }

  /**
   * A module (from the stored loadout summary) with a display name ("Cargo Rack") and rating: "6E"
   * for core and optional modules; weapons get their mount and hardpoint size instead. Slot and
   * blueprint names are tidied too.
   */
  return function describeModule(module) {
    const item = module.item ?? '';
    const sizeMatch = SIZED_ITEM_PATTERN.exec(item);
    const baseItem = item.replace(/_size\d+_class\d+.*$/, '');
    const armourMatch = /_armour_(\w+)$/.exec(item);
    const hardpointMatch = /^hpt_.*?_(fixed|gimbal|turret)_(small|medium|large|huge)/.exec(item);
    const localised = localisedNames.get(item) ?? ITEM_NAMES[baseItem] ?? namesByBaseItem.get(baseItem);
    return {
      ...module,
      mount: hardpointMatch ? HARDPOINT_MOUNTS[hardpointMatch[1]] : null,
      hardpointSize: hardpointMatch ? HARDPOINT_SIZES.indexOf(hardpointMatch[2]) + 1 : null,
      slot: tidySlot(module.slot),
      slotKey: module.slot,
      name: armourMatch ? ARMOUR_NAMES[armourMatch[1]] ?? tidyName(armourMatch[1]) : localised ?? tidyModuleName(item),
      rating: sizeMatch ? `${sizeMatch[1]}${CLASS_LETTERS[Number(sizeMatch[2])] ?? ''}` : null,
      engineering: module.engineering ? {
        ...module.engineering,
        blueprintName: tidyBlueprint(module.engineering.blueprint),
        modifiers: (module.engineering.modifiers ?? []).map((modifier) => ({ ...modifier, name: tidyStatLabel(modifier.label) })),
      } : null,
    };
  };
}
