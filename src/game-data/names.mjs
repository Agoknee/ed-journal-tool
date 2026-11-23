/**
 * Helpers for the game's internal names, as the journal logs them, and their display forms.
 */

/** "$int_cargorack_size6_class1_name;" and "Int_CargoRack_Size6_Class1" -> "int_cargorack_size6_class1". */
export function normalizeItem(item) {
  if (!item) return null;
  return String(item).replace(/^\$/, '').replace(/_name;$/i, '').replace(/;$/, '').toLowerCase();
}

/** A localised name, or null when the game logged its untranslated "$..._name;" key instead. */
export function cleanLocalised(name) {
  return name && !name.startsWith('$') ? name : null;
}

/** The class number in an item name ("utilitysuit_class3" -> 3), or null. */
export function getItemClass(item) {
  const match = /_class(\d+)/i.exec(item ?? '');
  return match ? Number(match[1]) : null;
}

/** "planet_approach_suite" -> "Planet Approach Suite". */
export function tidyName(name) {
  if (!name) return '—';
  return String(name).replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** "Armour_HeavyDuty" -> "Heavy Duty"; "Misc_LightWeight" -> "Light Weight". */
export function tidyBlueprint(blueprint) {
  if (!blueprint) return null;
  const withoutCategory = blueprint.includes('_') ? blueprint.slice(blueprint.indexOf('_') + 1) : blueprint;
  return withoutCategory.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
}

/** Internal names like "ruthenium" or "chemicalprocessors" read better capitalised; proper names are kept. */
export function capitalizeName(name) {
  if (!name) return name;
  return /[A-Z ]/.test(name) ? name : name.charAt(0).toUpperCase() + name.slice(1);
}
