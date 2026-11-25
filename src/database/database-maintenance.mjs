/**
 * The database's statistics for the Settings page, and for a reset: keeping a copy of it, and
 * emptying it (see createDatabaseReset in app.mjs for the rest: pausing what uses it, then reading
 * the journals again).
 */
import { existsSync, readdirSync, statfsSync, statSync } from 'node:fs';
import path from 'node:path';
import { runInTransaction } from './database.mjs';
import { forgetEntryDictionaries } from './entry-compression.mjs';

/** Copies kept on reset sit beside the database: journals.before-reset-2026-11-24T19-12-48.db (local time). */
function copyPrefix(databasePath) {
  const { name } = path.parse(databasePath);
  return `${name}.before-reset-`;
}

/** The copies kept on earlier resets, newest first. */
export function listResetCopies(databasePath) {
  const directory = path.dirname(databasePath);
  const prefix = copyPrefix(databasePath);
  let names = [];
  try {
    names = readdirSync(directory).filter((name) => name.startsWith(prefix) && name.endsWith('.db'));
  } catch {
    // No folder yet.
  }
  return names.sort().reverse().map((name) => ({ path: path.join(directory, name), bytes: fileSize(path.join(directory, name)) }));
}

/**
 * Writes a copy of the database beside it (with VACUUM INTO: consistent while the connection is
 * open, and compacted), before a reset. Refused, before writing anything, when the disk hasn't
 * room for it.
 * @returns {{ path: string, bytes: number }}
 */
export function keepResetCopy(database, databasePath) {
  // Local time, as people will look for it: 2026-11-24T19-12-48.
  const now = new Date();
  const twoDigits = (value) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}T${twoDigits(now.getHours())}-${twoDigits(now.getMinutes())}-${twoDigits(now.getSeconds())}`;
  const copyPath = path.join(path.dirname(databasePath), `${copyPrefix(databasePath)}${stamp}.db`);
  if (existsSync(copyPath)) throw Object.assign(new Error('A copy was just made; try again in a moment.'), { status: 409 });

  const { page_size: pageSize } = database.prepare('PRAGMA page_size').get();
  const { page_count: pageCount } = database.prepare('PRAGMA page_count').get();
  const { freelist_count: freePages } = database.prepare('PRAGMA freelist_count').get();
  const neededBytes = (pageCount - freePages) * pageSize;
  const disk = statfsSync(path.dirname(databasePath));
  const availableBytes = Number(disk.bavail) * Number(disk.bsize);
  // Some room to spare, so the copy doesn't leave the disk full.
  if (availableBytes < neededBytes * 1.1 + 100 * 1024 * 1024) {
    const toMegabytes = (bytes) => `${Math.ceil(bytes / 1024 / 1024).toLocaleString()} MB`;
    throw Object.assign(new Error(`There isn't room on the disk for a copy (it needs about ${toMegabytes(neededBytes)}; ${toMegabytes(availableBytes)} is free). Nothing was deleted.`), { status: 507 });
  }
  database.prepare('VACUUM INTO ?').run(copyPath);
  return { path: copyPath, bytes: fileSize(copyPath) };
}

function fileSize(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Sizes on disk (the database and its write-ahead log), free space inside it, and what it holds.
 * @param {import('node:sqlite').DatabaseSync} database
 * @param {string} databasePath
 */
export function getDatabaseStats(database, databasePath) {
  const single = (sql) => database.prepare(sql).get();
  const databaseBytes = fileSize(databasePath);
  const walBytes = fileSize(`${databasePath}-wal`) + fileSize(`${databasePath}-shm`);
  const { page_size: pageSize } = single('PRAGMA page_size');
  const { freelist_count: freePages } = single('PRAGMA freelist_count');
  const journalFiles = single(`
    SELECT COUNT(*) AS total,
      COALESCE(SUM(status = 'corrupt'), 0) AS corrupt,
      COALESCE(SUM(is_missing = 1), 0) AS missing
    FROM journal_files
  `);
  const firstEntry = single('SELECT timestamp FROM journal_entries ORDER BY id LIMIT 1');
  const lastEntry = single('SELECT timestamp FROM journal_entries ORDER BY id DESC LIMIT 1');
  return {
    path: databasePath,
    sizeOnDisk: { totalBytes: databaseBytes + walBytes, databaseBytes, walBytes, freeBytes: freePages * pageSize },
    entryCount: single('SELECT COUNT(*) AS count FROM journal_entries').count,
    journalFiles,
    commanderCount: single('SELECT COUNT(*) AS count FROM commanders').count,
    firstEntryAt: firstEntry?.timestamp ?? null,
    lastEntryAt: lastEntry?.timestamp ?? null,
    noteCount: single('SELECT (SELECT COUNT(*) FROM carrier_notes) + (SELECT COUNT(*) FROM commander_notes) AS count').count,
    bgsAdjustmentCount: single('SELECT COUNT(*) AS count FROM bgs_adjustments').count,
    tickCount: single('SELECT COUNT(*) AS count FROM bgs_ticks').count,
    resetCopies: listResetCopies(databasePath),
  };
}

/**
 * Deletes everything in every table (keeping the tables), restarts their ids, and shrinks the file
 * to match. The connection stays open, so whatever has it carries on with an empty database.
 * @param {import('node:sqlite').DatabaseSync} database
 */
export function clearDatabase(database) {
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
  // Off while deleting, so the order tables are emptied in doesn't matter (it can't change inside a transaction).
  database.exec('PRAGMA foreign_keys = OFF;');
  try {
    runInTransaction(database, () => {
      for (const table of tables) database.exec(`DELETE FROM "${table.replaceAll('"', '""')}"`);
      if (database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'").get()) database.exec('DELETE FROM sqlite_sequence');
    });
  } finally {
    database.exec('PRAGMA foreign_keys = ON;');
  }
  forgetEntryDictionaries();
  database.exec('VACUUM');
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}
