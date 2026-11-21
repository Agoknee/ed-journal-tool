/**
 * Per-table display settings (hidden columns, column order, sort, rows per page), saved in
 * localStorage under "table.<tableId>". Both DataTable (columns, client-side sort and paging) and
 * useTableState (server-side sort and paging) read and write the same entry.
 */
const STORAGE_PREFIX = 'table.';

export function readTableSettings(tableId) {
  if (!tableId) return {};
  try {
    const storedSettings = JSON.parse(localStorage.getItem(STORAGE_PREFIX + tableId));
    return storedSettings && typeof storedSettings === 'object' ? storedSettings : {};
  } catch {
    return {};
  }
}

/** Merges `changes` into the stored settings; a value of undefined removes that setting. */
export function updateTableSettings(tableId, changes) {
  if (!tableId) return;
  const nextSettings = { ...readTableSettings(tableId), ...changes };
  for (const settingName of Object.keys(nextSettings)) {
    if (nextSettings[settingName] === undefined) delete nextSettings[settingName];
  }
  try {
    if (Object.keys(nextSettings).length === 0) localStorage.removeItem(STORAGE_PREFIX + tableId);
    else localStorage.setItem(STORAGE_PREFIX + tableId, JSON.stringify(nextSettings));
  } catch {
    // Storage may be unavailable; the settings still apply until the page is reloaded.
  }
  // Lets other tables sharing this id (e.g. the trade orders on every carrier card) follow along.
  window.dispatchEvent(new CustomEvent(SETTINGS_CHANGE_EVENT, { detail: { tableId } }));
}

export const SETTINGS_CHANGE_EVENT = 'table-settings-change';

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
