import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(path.resolve(import.meta.dirname, '../journals.db'));

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS app_logs (
    id INTEGER PRIMARY KEY,
    timestamp REAL,
    level INTEGER,
    message TEXT
  ) STRICT
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cmdrs (
    id INTEGER PRIMARY KEY,
    cmdr_name TEXT UNIQUE
  ) STRICT
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS journal_files (
    id INTEGER PRIMARY KEY,
    filepath TEXT UNIQUE,
    last_read_date REAL,
    last_read_size REAL,
    journal_start_date REAL,
    cmdr_id INTEGER,
    closed INTEGER,
    corrupt INTEGER
  ) STRICT
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS journal_entries (
    id INTEGER PRIMARY KEY,
    journal_id INTEGER NOT NULL,
    entry_date REAL,
    processed INTEGER DEFAULT 0,
    entry_json TEXT,
    FOREIGN KEY(journal_id) REFERENCES journal_files(id)
  ) STRICT
`);

export { db };