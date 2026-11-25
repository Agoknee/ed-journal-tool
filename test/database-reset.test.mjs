import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { clearDatabase, getDatabaseStats, keepResetCopy, listResetCopies } from '../src/database/database-maintenance.mjs';
import { openReadOnlyDatabase } from '../src/database/database.mjs';
import { compactJournalEntries, exposeEntryTextInSql, getEntryCodec } from '../src/database/entry-compression.mjs';
import { statModules } from '../src/stats/index.mjs';
import { StatsEngine } from '../src/stats/stats-engine.mjs';
import { createFixture, event, sessionStart } from './helpers/journal-fixture.mjs';

const jumps = (count, day) => Array.from({ length: count }, (unused, index) => event('FSDJump', { StarSystem: `System ${day}-${index}`, JumpDist: 10 }, `2026-01-0${day}T01:${String(index % 60).padStart(2, '0')}:00Z`));

test('database reset: everything goes, ids start over, and journals read afterwards compress and decode', async () => {
  const fixture = await createFixture();
  const readOnly = openReadOnlyDatabase(fixture.databasePath);
  try {
    fixture.writeJournal([...sessionStart(), ...jumps(150, 1)]);
    await fixture.build();
    await compactJournalEntries(fixture.database, { minTrainingEntryCount: 1 });
    fixture.database.prepare('INSERT INTO carrier_notes (carrier_id, note, updated_at) VALUES (1, ?, ?)').run('my note', '2026-01-01T00:00:00Z');
    // The SQL tool's own connection has loaded the first dictionary.
    exposeEntryTextInSql(readOnly);
    assert.ok(readOnly.prepare('SELECT data FROM journal_entries LIMIT 1').get().data.includes('Fileheader'));

    const before = getDatabaseStats(fixture.database, fixture.databasePath);
    assert.equal(before.entryCount, 153);
    assert.equal(before.journalFiles.total, 1);
    assert.equal(before.commanderCount, 1);
    assert.equal(before.noteCount, 1);
    assert.ok(before.sizeOnDisk.totalBytes > 0);

    // A copy kept first: a whole database beside it, listed in the stats.
    const copy = keepResetCopy(fixture.database, fixture.databasePath);
    assert.ok(copy.path.startsWith(fixture.databasePath.replace(/\.db$/, '.before-reset-')) && copy.bytes > 0);
    const copied = new DatabaseSync(copy.path, { readOnly: true });
    assert.equal(copied.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, 153);
    assert.equal(copied.prepare('SELECT note FROM carrier_notes').get().note, 'my note');
    copied.close();
    assert.deepEqual(listResetCopies(fixture.databasePath), [copy]);

    clearDatabase(fixture.database);
    const after = getDatabaseStats(fixture.database, fixture.databasePath);
    assert.deepEqual(after.resetCopies, [copy], 'the copy is left alone');
    assert.deepEqual(
      { entries: after.entryCount, files: after.journalFiles.total, commanders: after.commanderCount, notes: after.noteCount },
      { entries: 0, files: 0, commanders: 0, notes: 0 },
    );
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM entry_dictionaries').get().n, 0);
    assert.ok(after.sizeOnDisk.totalBytes < before.sizeOnDisk.totalBytes, `it shrinks (${before.sizeOnDisk.totalBytes} -> ${after.sizeOnDisk.totalBytes} bytes)`);
    assert.equal(after.sizeOnDisk.freeBytes, 0, 'with no free space left inside');
    assert.equal(after.sizeOnDisk.walBytes > 0 ? fixture.database.prepare('PRAGMA wal_checkpoint').get().log : 0, 0, 'and the write-ahead log emptied');
    assert.equal(getEntryCodec(fixture.database).dictionaryId, 0, 'the old dictionary is forgotten');

    // Started over, as after a reset: a new commander, new journals, a new dictionary reusing id 1.
    const engine = new StatsEngine({ database: fixture.database, statModules, eventHub: { publish() {} } });
    engine.initialize();
    fixture.writeJournal([...sessionStart({ commander: 'SECOND', fid: 'F2', at: '2026-01-02T00:00:00Z' }), ...jumps(150, 2)]);
    fixture.statsEngine.initialize();
    await fixture.build();
    await compactJournalEntries(fixture.database, { minTrainingEntryCount: 1 });
    assert.equal(fixture.database.prepare('SELECT MIN(id) AS id FROM journal_entries').get().id, 1, 'ids start over');
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM commanders').get().n, 2, 'both journals were read again');
    assert.equal(getEntryCodec(fixture.database).dictionaryId, 1);
    // Both connections decode the new entries with the new dictionary, not the one they had before.
    const codec = getEntryCodec(fixture.database);
    for (const row of fixture.database.prepare('SELECT data FROM journal_entries').all()) JSON.parse(codec.decode(row.data));
    const sqlRows = readOnly.prepare("SELECT data FROM journal_entries WHERE event = 'FSDJump'").all();
    assert.ok(sqlRows.length > 0);
    for (const row of sqlRows) assert.ok(JSON.parse(row.data).StarSystem.startsWith('System'));
  } finally {
    readOnly.close();
    await fixture.close();
  }
});
