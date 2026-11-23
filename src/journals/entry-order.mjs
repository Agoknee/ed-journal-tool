import { runInTransaction } from '../database/database.mjs';
import { logger } from '../logger.mjs';

/**
 * Stat modules read journal entries in id order, which is the order they were stored. That's the
 * order things happened, except when an older journal turns up after newer ones were read (restored
 * from a backup or copied from another PC): its entries are stored last, so its old ship, location
 * and inventory would look like the latest. This puts the entries back in time order by giving the
 * affected entries new ids after the current last one.
 *
 * Entries are merged by timestamp, never reordered within their own file, and only entries from the
 * first one newer than the late journal onwards are moved.
 */

/**
 * Whether a journal that has just been read is older than journals already stored: another journal
 * started after this one's last entry. (Journals written at the same time, by two commanders
 * playing at once, overlap instead and are already stored in the order things happened.)
 * @param {import('node:sqlite').DatabaseSync} database
 * @param {number} fileId
 */
export function isStoredOutOfOrder(database, fileId) {
  const file = database.prepare('SELECT first_timestamp, last_timestamp, is_legacy FROM journal_files WHERE id = ?').get(fileId);
  if (!file?.last_timestamp || file.is_legacy) return false;
  return Boolean(database.prepare(`
    SELECT 1 FROM journal_files
    WHERE id != ? AND status = 'ok' AND entry_count > 0 AND first_timestamp > ?
    LIMIT 1
  `).get(fileId, file.last_timestamp));
}

/**
 * Restores time order for entries from the given timestamp onwards.
 * @param {import('node:sqlite').DatabaseSync} database
 * @param {string} fromTimestamp  the first entry timestamp of the earliest late journal
 * @returns {number} how many entries were given new ids
 */
export function restoreEntryOrder(database, fromTimestamp) {
  const startTime = Date.now();
  const firstAffected = database.prepare('SELECT MIN(id) AS id FROM journal_entries WHERE timestamp >= ?').get(fromTimestamp);
  if (firstAffected?.id == null) return 0;

  const entries = database.prepare('SELECT id, journal_file_id AS fileId, timestamp FROM journal_entries WHERE id >= ? ORDER BY id').all(firstAffected.id);

  // Within a file, an entry never sorts before the one above it (even if its clock went backwards,
  // or it has no timestamp).
  const latestTimestampByFile = new Map();
  for (const entry of entries) {
    const previousTimestamp = latestTimestampByFile.get(entry.fileId) ?? '';
    entry.sortTimestamp = entry.timestamp && entry.timestamp > previousTimestamp ? entry.timestamp : previousTimestamp;
    latestTimestampByFile.set(entry.fileId, entry.sortTimestamp);
  }
  const ordered = [...entries].sort((first, second) => (
    first.sortTimestamp < second.sortTimestamp ? -1 : first.sortTimestamp > second.sortTimestamp ? 1 : first.id - second.id
  ));

  // Entries already in place keep their ids; everything from the first one out of place moves.
  let firstMovedIndex = 0;
  while (firstMovedIndex < ordered.length && ordered[firstMovedIndex].id === entries[firstMovedIndex].id) firstMovedIndex += 1;
  if (firstMovedIndex === ordered.length) return 0;

  const movedCount = ordered.length - firstMovedIndex;
  logger.info(`Putting ${movedCount.toLocaleString()} journal entries back in time order (journals were read out of order)...`);
  const { maxEntryId } = database.prepare('SELECT MAX(id) AS maxEntryId FROM journal_entries').get();
  const updateEntryId = database.prepare('UPDATE journal_entries SET id = ? WHERE id = ?');
  runInTransaction(database, () => {
    let nextEntryId = maxEntryId + 1;
    for (let index = firstMovedIndex; index < ordered.length; index += 1) {
      updateEntryId.run(nextEntryId, ordered[index].id);
      nextEntryId += 1;
    }
  });
  logger.info(`Journal entries are back in time order (${((Date.now() - startTime) / 1000).toFixed(1)}s).`);
  return movedCount;
}

const LATE_JOURNALS_FROM_KEY = 'late_journals_from';

/**
 * Remembers that a journal was stored after newer ones (kept in the database, so a restart before
 * the order is restored doesn't lose it).
 * @param {import('node:sqlite').DatabaseSync} database
 * @param {string} firstTimestamp  the late journal's first entry timestamp
 */
export function noteLateJournal(database, firstTimestamp) {
  database.prepare(`
    INSERT INTO storage_state (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = MIN(value, excluded.value)
  `).run(LATE_JOURNALS_FROM_KEY, firstTimestamp);
}

/**
 * Restores time order if late journals were noted.
 * @param {import('node:sqlite').DatabaseSync} database
 * @returns {boolean} whether any entries moved (all stats then need rebuilding)
 */
export function restoreEntryOrderIfNeeded(database) {
  const fromTimestamp = database.prepare('SELECT value FROM storage_state WHERE key = ?').get(LATE_JOURNALS_FROM_KEY)?.value;
  if (!fromTimestamp) return false;
  const movedCount = restoreEntryOrder(database, fromTimestamp);
  database.prepare('DELETE FROM storage_state WHERE key = ?').run(LATE_JOURNALS_FROM_KEY);
  return movedCount > 0;
}

const STORED_ORDER_CHECKED_KEY = 'entry_order_checked';

/**
 * Checks once whether journals already stored are out of time order (they can be when journal file
 * names were written in different time zones, so name order isn't time order) and notes them so
 * the next update restores the order.
 * @param {import('node:sqlite').DatabaseSync} database
 * @returns {number} how many stored journals are late
 */
export function checkStoredEntryOrderOnce(database) {
  if (database.prepare('SELECT 1 FROM storage_state WHERE key = ?').get(STORED_ORDER_CHECKED_KEY)) return 0;
  const firstEntryIds = new Map(database.prepare('SELECT journal_file_id AS fileId, MIN(id) AS firstEntryId FROM journal_entries GROUP BY journal_file_id').all()
    .map((row) => [row.fileId, row.firstEntryId]));
  const files = database.prepare("SELECT id, first_timestamp, last_timestamp FROM journal_files WHERE status = 'ok' AND is_legacy = 0 AND last_timestamp IS NOT NULL").all()
    .filter((file) => firstEntryIds.has(file.id))
    .sort((first, second) => firstEntryIds.get(first.id) - firstEntryIds.get(second.id));

  // In stored order, a journal is late when one stored before it started after it ended.
  let latestStartSoFar = '';
  let lateCount = 0;
  let earliestLateStart = null;
  for (const file of files) {
    if (latestStartSoFar > file.last_timestamp) {
      lateCount += 1;
      if (!earliestLateStart || file.first_timestamp < earliestLateStart) earliestLateStart = file.first_timestamp;
    }
    if (file.first_timestamp > latestStartSoFar) latestStartSoFar = file.first_timestamp;
  }
  if (earliestLateStart) {
    logger.info(`${lateCount.toLocaleString()} stored journals are out of time order; their entries will be put back in order.`);
    noteLateJournal(database, earliestLateStart);
  }
  database.prepare('INSERT INTO storage_state (key, value) VALUES (?, ?)').run(STORED_ORDER_CHECKED_KEY, new Date().toISOString());
  return lateCount;
}
