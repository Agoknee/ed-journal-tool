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
  return database;
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
