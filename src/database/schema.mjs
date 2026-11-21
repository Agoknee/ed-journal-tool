/**
 * Core tables: commanders -> journal files -> journal entries.
 * Stat modules create their own tables (see src/stats).
 */
export const coreSchemaSql = `
  CREATE TABLE IF NOT EXISTS commanders (
    id              INTEGER PRIMARY KEY,
    commander_key   TEXT NOT NULL UNIQUE,  -- FID when available, otherwise "name:<Name>"
    fid             TEXT,
    name            TEXT NOT NULL,
    first_seen      TEXT,
    last_seen       TEXT
  );

  CREATE TABLE IF NOT EXISTS journal_files (
    id                  INTEGER PRIMARY KEY,
    file_name           TEXT NOT NULL UNIQUE,
    sort_key            TEXT NOT NULL,          -- chronological key derived from the file name
    commander_id        INTEGER REFERENCES commanders(id),
    status              TEXT NOT NULL DEFAULT 'pending',  -- ok | pending | corrupt
    status_reason       TEXT,
    file_size           INTEGER NOT NULL DEFAULT 0,
    modified_ms         INTEGER NOT NULL DEFAULT 0,
    bytes_read          INTEGER NOT NULL DEFAULT 0,
    line_count          INTEGER NOT NULL DEFAULT 0,
    entry_count         INTEGER NOT NULL DEFAULT 0,
    skipped_line_count  INTEGER NOT NULL DEFAULT 0,
    first_timestamp     TEXT,
    last_timestamp      TEXT,
    game_version        TEXT,
    game_build          TEXT,
    file_part           INTEGER,
    is_odyssey          INTEGER,
    is_closed           INTEGER NOT NULL DEFAULT 0,  -- ended with Shutdown/Continued
    is_active           INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_journal_files_commander ON journal_files(commander_id);
  CREATE INDEX IF NOT EXISTS idx_journal_files_sort ON journal_files(sort_key);

  CREATE TABLE IF NOT EXISTS journal_entries (
    id               INTEGER PRIMARY KEY,
    journal_file_id  INTEGER NOT NULL REFERENCES journal_files(id) ON DELETE CASCADE,
    commander_id     INTEGER NOT NULL REFERENCES commanders(id),
    line_number      INTEGER NOT NULL,
    timestamp        TEXT,
    event            TEXT NOT NULL,
    data             TEXT NOT NULL,
    UNIQUE (journal_file_id, line_number)
  );
  CREATE INDEX IF NOT EXISTS idx_journal_entries_event ON journal_entries(event, id);
  CREATE INDEX IF NOT EXISTS idx_journal_entries_commander_time ON journal_entries(commander_id, timestamp);

  -- Progress tracking for stat modules (one cursor per module).
  CREATE TABLE IF NOT EXISTS stat_modules (
    name            TEXT PRIMARY KEY,
    version         INTEGER NOT NULL,
    last_entry_id   INTEGER NOT NULL DEFAULT 0,
    owned_objects   TEXT NOT NULL DEFAULT '[]',  -- JSON list of tables/views to drop if the module is removed
    updated_at      TEXT
  );

  -- Notes the user writes about carriers. User data, not stats: never cleared by stat rebuilds.
  CREATE TABLE IF NOT EXISTS carrier_notes (
    carrier_id   INTEGER PRIMARY KEY,   -- the carrier's market id
    note         TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  -- Notes the user writes about commanders (shown for commanders without a carrier).
  CREATE TABLE IF NOT EXISTS commander_notes (
    commander_id  INTEGER PRIMARY KEY REFERENCES commanders(id),
    note          TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  -- BGS ticks seen by the tick monitor. Not derivable from journals, so never cleared by stat rebuilds.
  CREATE TABLE IF NOT EXISTS bgs_ticks (
    tick_time      TEXT PRIMARY KEY,   -- journal-style UTC timestamp, e.g. 2026-11-20T16:52:46Z
    first_seen_at  TEXT NOT NULL
  );

  -- Small key/value store for stat modules that need to remember state between entries.
  CREATE TABLE IF NOT EXISTS stat_state (
    module_name    TEXT NOT NULL,
    commander_id   INTEGER NOT NULL,
    state_key      TEXT NOT NULL,
    state_value    TEXT,
    PRIMARY KEY (module_name, commander_id, state_key)
  );
`;
