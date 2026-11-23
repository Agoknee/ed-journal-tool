/**
 * Events used to keep track of where a commander is docked, so trades, deposits, missions and BGS
 * activity can be stamped with the station they happened at. (FSDJump also clears it when a module
 * receives it, but it isn't needed: you can't jump while docked.)
 */
export const DOCKING_EVENTS = ['Docked', 'Undocked', 'Location', 'CarrierJump'];

const DOCKED_AT_STATE_KEY = 'dockedAt';

/**
 * Updates the commander's docked location from a docking-related event.
 * @param {string} event
 * @param {object} data
 * @param {import('./define-stat-module.mjs').ModuleState} moduleState
 * @returns {boolean} true if the event was a docking event
 */
export function trackDockingState(event, data, moduleState) {
  switch (event) {
    case 'Docked':
      moduleState.set(DOCKED_AT_STATE_KEY, toDockedLocation(data));
      return true;
    case 'Location':
    case 'CarrierJump':
      moduleState.set(DOCKED_AT_STATE_KEY, data.Docked ? toDockedLocation(data) : null);
      return true;
    case 'Undocked':
    case 'FSDJump':
      moduleState.set(DOCKED_AT_STATE_KEY, null);
      return true;
    default:
      return false;
  }
}

/**
 * Returns the station/system the commander is docked at, if it matches the given market id.
 * @returns {{ marketId: number, stationName: string, stationType: string, starSystem: string, faction: string | null } | null}
 */
export function getDockedLocation(moduleState, marketId) {
  const dockedLocation = moduleState.get(DOCKED_AT_STATE_KEY);
  if (!dockedLocation) return null;
  return marketId === undefined || dockedLocation.marketId === marketId ? dockedLocation : null;
}

function toDockedLocation(data) {
  return {
    marketId: data.MarketID ?? null,
    stationName: data.StationName_Localised ?? data.StationName ?? null,
    stationType: data.StationType ?? null,
    starSystem: data.StarSystem ?? null,
    faction: data.StationFaction?.Name ?? null,
  };
}
