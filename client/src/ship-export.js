import { fetchJson } from './api.js';

/** A ship's last loadout as EDSY/Coriolis links and SLEF, fetched once per loadout and reused. */
const exportRequests = new Map();
export function fetchShipExport(commanderId, { shipId, loadoutAt }) {
  const key = `${commanderId}:${shipId}:${loadoutAt}`;
  if (!exportRequests.has(key)) {
    exportRequests.set(key, fetchJson(`/api/stats/fleet/export?commander=${commanderId}&ship=${shipId}`).catch((error) => {
      exportRequests.delete(key);
      throw error;
    }));
  }
  return exportRequests.get(key);
}
