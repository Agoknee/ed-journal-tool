/**
 * Commodity display names. Journals include a localised name (e.g. "Type_Localised":"Fruit and Vegetables")
 * for most commodities, but only the lowercase internal name for some (e.g. "gold", "water", "wine").
 * @param {string | undefined} localisedName
 * @param {string | undefined} internalName
 */
export function getCommodityDisplayName(localisedName, internalName = '') {
  const name = localisedName || internalName;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
