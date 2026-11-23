import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { coreSchemaSql } from './schema.mjs';

/**
 * Opens (and creates if needed) the application database.
 * @param {string} databasePath
 * @returns {DatabaseSync}
 */
export function openDatabase(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true });

  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  database.exec(coreSchemaSql);
  migrateDatabase(database);
  return database;
}

/**
 * Brings a database created by an older version up to date: columns added to existing tables
 * (CREATE TABLE IF NOT EXISTS leaves those alone).
 */
function migrateDatabase(database) {
  const journalFileColumns = new Set(database.prepare('PRAGMA table_info(journal_files)').all().map((column) => column.name));
  if (!journalFileColumns.has('is_missing')) database.exec('ALTER TABLE journal_files ADD COLUMN is_missing INTEGER NOT NULL DEFAULT 0;');
  // Filled in from each journal's stored first entry by the ingester.
  if (!journalFileColumns.has('header_hash')) database.exec('ALTER TABLE journal_files ADD COLUMN header_hash TEXT;');
  database.exec('CREATE INDEX IF NOT EXISTS idx_journal_files_header ON journal_files(header_hash);');
  if (!journalFileColumns.has('is_legacy')) {
    database.exec(`
      ALTER TABLE journal_files ADD COLUMN is_legacy INTEGER NOT NULL DEFAULT 0;
      UPDATE journal_files SET is_legacy = 1 WHERE game_version GLOB '[0-3].*';
    `);
  }

  // Event counts per file replaced the (commander, time) index on journal entries.
  const hasCommanderTimeIndex = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'idx_journal_entries_commander_time'").get();
  if (hasCommanderTimeIndex) {
    runInTransaction(database, () => {
      database.exec(`
        DELETE FROM journal_file_events;
        INSERT INTO journal_file_events (journal_file_id, event, entry_count)
          SELECT journal_file_id, event, COUNT(*) FROM journal_entries GROUP BY journal_file_id, event;
        DROP INDEX idx_journal_entries_commander_time;
      `);
    });
  }
}

/**
 * Opens a read-only connection, used for user-supplied raw SQL queries.
 * @param {string} databasePath
 * @returns {DatabaseSync}
 */
export function openReadOnlyDatabase(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec('PRAGMA busy_timeout = 5000;');
  return database;
}

/**
 * Runs a function inside a transaction, rolling back if it throws.
 * @template T
 * @param {DatabaseSync} database
 * @param {() => T} work
 * @returns {T}
 */
export function runInTransaction(database, work) {
  database.exec('BEGIN');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
