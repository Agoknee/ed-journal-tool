import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/database/database.mjs';
import { coreSchemaSql } from '../src/database/schema.mjs';
import { isLegacyGameVersion } from '../src/journals/journal-files.mjs';
import { createFixture, event, sessionStart } from './helpers/journal-fixture.mjs';

test('Legacy game versions', () => {
  assert.equal(isLegacyGameVersion('3.8.0.1400'), true);
  assert.equal(isLegacyGameVersion('4.2.1.0'), false);
  assert.equal(isLegacyGameVersion(null), false);
});

test('Legacy journals are flagged and never count as the game being played', async () => {
  const fixture = await createFixture();
  try {
    const liveFile = fixture.writeJournal([...sessionStart({ at: '2026-01-01T00:00:00Z' }), event('Music', { MusicTrack: 'Exploration' })]);
    const legacyFile = fixture.writeJournal([...sessionStart({ gameVersion: '3.8.0.1400', at: '2026-01-01T00:05:00Z' }), event('Music', { MusicTrack: 'Exploration' })]);
    await fixture.build();
    // Both being written right now.
    const now = new Date();
    for (const fileName of [liveFile, legacyFile]) {
      utimesSync(path.join(fixture.journalDirectory, fileName), now, now);
      await fixture.ingester.processFile(fileName);
    }
    fixture.ingester.refreshActiveFiles();
    const files = Object.fromEntries(fixture.database.prepare('SELECT file_name, is_legacy, is_active FROM journal_files').all().map((row) => [row.file_name, row]));
    assert.equal(files[legacyFile].is_legacy, 1);
    assert.equal(files[liveFile].is_legacy, 0);
    assert.equal(files[liveFile].is_active, 1);
    assert.equal(files[legacyFile].is_active, 0, 'a running Legacy client isn’t the live game');
  } finally {
    await fixture.close();
  }
});

test('opening an older database adds and fills in the Legacy flag', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'edjt-migrate-'));
  const databasePath = path.join(directory, 'old.db');
  let database = null;
  try {
    // The schema as it was before journal files had the flag.
    const old = new DatabaseSync(databasePath);
    old.exec(coreSchemaSql.replace(/^\s*is_legacy[^\n]*\n/m, ''));
    assert.ok(!old.prepare('PRAGMA table_info(journal_files)').all().some((column) => column.name === 'is_legacy'));
    old.exec(`INSERT INTO journal_files (file_name, sort_key, game_version) VALUES ('a', 'a', '3.8.0.1400'), ('b', 'b', '4.1.0.0'), ('c', 'c', NULL);`);
    old.close();
    database = openDatabase(databasePath);
    const flags = database.prepare('SELECT file_name, is_legacy FROM journal_files ORDER BY file_name').all().map((row) => [row.file_name, row.is_legacy]);
    assert.deepEqual(flags, [['a', 1], ['b', 0], ['c', 0]]);
  } finally {
    database?.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
