import assert from 'node:assert/strict';
import { copyFileSync, rmSync, utimesSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { JournalIngester } from '../src/journals/journal-ingester.mjs';
import { createFixture, event, sessionStart } from './helpers/journal-fixture.mjs';

const count = (fixture, sql, ...parameters) => fixture.database.prepare(sql).get(...parameters).n;
const fileRow = (fixture, fileName) => fixture.database.prepare('SELECT * FROM journal_files WHERE file_name = ?').get(fileName);

/** A session that sells cargo (a credit transaction and a trade) and ends. */
function tradingSession({ at, credits = 1000, ship = 'sidewinder', shipId = 1, commander = 'TESTER', fid = 'F1' }) {
  return [
    ...sessionStart({ at, credits, ship, shipId, commander, fid }),
    event('MarketSell', { MarketID: 1, Type: 'gold', Count: 1, SellPrice: 100, TotalSale: 100, AvgPricePaid: 50 }, at),
    event('Shutdown', {}, at),
  ];
}

async function currentShip(fixture, commander = 'TESTER') {
  const { body } = await fixture.get('/api/stats/commanders');
  return body.commanders.find((profile) => profile.name === commander).summary.currentShip?.shipTypeName;
}

/** Entry ids follow timestamps, and each file's lines stay in order. */
function assertTimeOrdered(fixture) {
  const entries = fixture.database.prepare('SELECT journal_file_id, line_number, timestamp FROM journal_entries ORDER BY id').all();
  const lastLineByFile = new Map();
  let lastTimestamp = '';
  for (const entry of entries) {
    assert.ok(entry.timestamp >= lastTimestamp, `${entry.timestamp} stored after ${lastTimestamp}`);
    lastTimestamp = entry.timestamp;
    assert.ok(entry.line_number > (lastLineByFile.get(entry.journal_file_id) ?? 0));
    lastLineByFile.set(entry.journal_file_id, entry.line_number);
  }
}

test('a journal already read, copied in under another name, is skipped as a copy', async () => {
  const fixture = await createFixture();
  try {
    const original = fixture.writeJournal(tradingSession({ at: '2026-03-01T10:00:00Z' }), { fileName: 'Journal.2026-03-01T100000.01.log' });
    await fixture.build();
    const entryCount = count(fixture, 'SELECT COUNT(*) AS n FROM journal_entries');
    const copyName = 'Journal.2026-03-02T100000.01.log';
    copyFileSync(path.join(fixture.journalDirectory, original), path.join(fixture.journalDirectory, copyName));
    await fixture.build();

    const copy = fileRow(fixture, copyName);
    assert.equal(copy.status, 'duplicate');
    assert.equal(copy.status_reason, `Same journal as ${original}`);
    assert.equal(count(fixture, 'SELECT COUNT(*) AS n FROM journal_entries'), entryCount);
    assert.equal(count(fixture, 'SELECT COUNT(*) AS n FROM credit_transactions'), 1);
    assert.equal(count(fixture, 'SELECT COUNT(*) AS n FROM commodity_trades'), 1);

    // Another commander's journal started the same second is not a copy.
    fixture.writeJournal(tradingSession({ at: '2026-03-01T10:00:00Z', commander: 'OTHER', fid: 'F2' }), { fileName: 'Journal.2026-03-01T100000.02.log' });
    await fixture.build();
    assert.equal(fileRow(fixture, 'Journal.2026-03-01T100000.02.log').status, 'ok');
  } finally {
    await fixture.close();
  }
});

test('a different journal saved over one already read is re-read from the start', async () => {
  const fixture = await createFixture();
  try {
    const fileName = 'Journal.2026-03-01T100000.01.log';
    fixture.writeJournal(tradingSession({ at: '2026-03-01T10:00:00Z', ship: 'python', shipId: 5 }), { fileName });
    await fixture.build();
    assert.equal(await currentShip(fixture), 'Python');

    fixture.writeJournal([
      ...sessionStart({ at: '2026-03-01T10:00:09Z', ship: 'anaconda', shipId: 6 }),
      event('Music', { MusicTrack: 'Exploration' }, '2026-03-01T10:00:10Z'),
      event('Shutdown', {}, '2026-03-01T10:00:11Z'),
    ], { fileName });
    await fixture.build();
    assert.equal(fileRow(fixture, fileName).entry_count, 5);
    assert.equal(count(fixture, 'SELECT COUNT(*) AS n FROM journal_entries'), 5);
    assert.equal(count(fixture, 'SELECT COUNT(*) AS n FROM credit_transactions'), 0, 'the replaced journal’s sale is gone');
    assert.equal(await currentShip(fixture), 'Anaconda');
  } finally {
    await fixture.close();
  }
});

test('an older journal read after newer ones is put back in time order', async () => {
  const fixture = await createFixture();
  try {
    fixture.writeJournal(tradingSession({ at: '2026-06-01T00:00:00Z', ship: 'python', shipId: 5, credits: 9_000_000 }), { fileName: 'Journal.2026-06-01T000000.01.log' });
    fixture.writeJournal(tradingSession({ at: '2026-07-01T00:00:00Z', ship: 'python', shipId: 5, credits: 9_100_000 }), { fileName: 'Journal.2026-07-01T000000.01.log' });
    await fixture.build();
    assert.equal(await currentShip(fixture), 'Python');
    const balanceBefore = (await fixture.get(`/api/stats/credits?commander=${fixture.commanderId()}`)).body.balance;

    fixture.writeJournal(tradingSession({ at: '2026-06-15T00:00:00Z', ship: 'sidewinder', shipId: 1, credits: 1000 }), { fileName: 'Journal.2026-06-15T000000.01.log' });
    await fixture.build();
    assertTimeOrdered(fixture);
    assert.equal(await currentShip(fixture), 'Python');
    assert.equal(count(fixture, 'SELECT COUNT(*) AS n FROM credit_transactions'), 3, 'nothing lost or counted twice');
    const { body } = await fixture.get(`/api/stats/credits?commander=${fixture.commanderId()}`);
    assert.deepEqual(body.balance, balanceBefore);

    // Stats rebuilt from scratch agree.
    fixture.statsEngine.resetAllModules();
    await fixture.statsEngine.processNewEntries();
    assert.equal(await currentShip(fixture), 'Python');
    assert.equal(count(fixture, "SELECT COUNT(*) AS n FROM storage_state WHERE key = 'late_journals_from'"), 0);
  } finally {
    await fixture.close();
  }
});

test('reordering merges by time but never reorders lines within a journal', async () => {
  const fixture = await createFixture();
  try {
    fixture.writeJournal([
      ...sessionStart({ at: '2026-06-01T00:00:00Z' }),
      event('Music', { MusicTrack: 'A' }, '2026-06-01T00:00:10Z'),
      event('Music', { MusicTrack: 'B' }, '2026-06-01T00:00:05Z'), // the clock went backwards
      event('Shutdown', {}, '2026-06-01T00:00:20Z'),
    ], { fileName: 'Journal.2026-06-01T000000.01.log' });
    fixture.writeJournal(tradingSession({ at: '2026-06-02T00:00:00Z' }), { fileName: 'Journal.2026-06-02T000000.01.log' });
    await fixture.build();
    // Another commander's journal from the same time, copied in from another PC.
    fixture.writeJournal([
      ...sessionStart({ at: '2026-06-01T00:00:07Z', commander: 'OTHER', fid: 'F2' }),
      event('Shutdown', {}, '2026-06-01T00:00:15Z'),
    ], { fileName: 'Journal.2026-06-01T000007.01.log' });
    await fixture.build();

    const order = fixture.database.prepare(`
      SELECT commanders.name, journal_entries.event, journal_entries.timestamp FROM journal_entries
      JOIN commanders ON commanders.id = journal_entries.commander_id ORDER BY journal_entries.id
    `).all().map((row) => `${row.name} ${row.event} ${row.timestamp.slice(11, 19)}`);
    assert.deepEqual(order, [
      'TESTER Fileheader 00:00:00', 'TESTER Commander 00:00:00', 'TESTER LoadGame 00:00:00',
      'OTHER Fileheader 00:00:07', 'OTHER Commander 00:00:07', 'OTHER LoadGame 00:00:07',
      'TESTER Music 00:00:10', 'TESTER Music 00:00:05',
      'OTHER Shutdown 00:00:15',
      'TESTER Shutdown 00:00:20',
      'TESTER Fileheader 00:00:00', 'TESTER Commander 00:00:00', 'TESTER LoadGame 00:00:00', 'TESTER MarketSell 00:00:00', 'TESTER Shutdown 00:00:00',
    ]);
  } finally {
    await fixture.close();
  }
});

test('two commanders playing at once don’t count as journals out of order', async () => {
  const fixture = await createFixture();
  try {
    // ALPHA's journal is created first but only names the commander after BRAVO's journal is read.
    const alpha = fixture.writeJournal([event('Fileheader', { part: 1, Odyssey: true, gameversion: '4.2.0.0', build: 'r1' }, '2026-06-01T00:00:00Z')], { fileName: 'Journal.2026-06-01T000000.01.log' });
    fixture.writeJournal([...sessionStart({ at: '2026-06-01T00:00:05Z', commander: 'BRAVO', fid: 'F2' }), event('Music', { MusicTrack: 'A' }, '2026-06-01T00:00:06Z')], { fileName: 'Journal.2026-06-01T000005.01.log' });
    const markWritingNow = (fileName) => { const now = new Date(); utimesSync(path.join(fixture.journalDirectory, fileName), now, now); };
    markWritingNow(alpha);
    await fixture.build();
    assert.equal(fileRow(fixture, alpha).status, 'pending');
    const idsBefore = fixture.database.prepare('SELECT id FROM journal_entries ORDER BY id').all().map((row) => row.id);

    fixture.writeJournal([
      event('Fileheader', { part: 1, Odyssey: true, gameversion: '4.2.0.0', build: 'r1' }, '2026-06-01T00:00:00Z'),
      event('Commander', { FID: 'F1', Name: 'ALPHA' }, '2026-06-01T00:00:08Z'),
      event('LoadGame', { FID: 'F1', Commander: 'ALPHA', Ship: 'sidewinder', ShipID: 1, Credits: 10, GameMode: 'Solo' }, '2026-06-01T00:00:08Z'),
    ], { fileName: alpha });
    markWritingNow(alpha);
    await fixture.build();
    assert.equal(fileRow(fixture, alpha).status, 'ok');
    assert.equal(count(fixture, "SELECT COUNT(*) AS n FROM storage_state WHERE key = 'late_journals_from'"), 0);
    const idsAfter = fixture.database.prepare('SELECT id FROM journal_entries WHERE journal_file_id != ? ORDER BY id').all(fileRow(fixture, alpha).id).map((row) => row.id);
    assert.deepEqual(idsAfter, idsBefore, 'nothing was moved');
  } finally {
    await fixture.close();
  }
});

test('a removed journal keeps its entries, stops being active, and is unflagged when it’s back', async () => {
  const fixture = await createFixture();
  try {
    const fileName = fixture.writeJournal([...sessionStart({ at: '2026-06-01T00:00:00Z' }), event('Music', { MusicTrack: 'A' }, '2026-06-01T00:00:01Z')]);
    const filePath = path.join(fixture.journalDirectory, fileName);
    const now = new Date();
    utimesSync(filePath, now, now); // being written now
    await fixture.build();
    fixture.ingester.refreshActiveFiles();
    assert.equal(fileRow(fixture, fileName).is_active, 1);

    copyFileSync(filePath, `${filePath}.bak`);
    rmSync(filePath);
    assert.equal(fixture.ingester.markFileMissing(fileName), true);
    fixture.ingester.refreshActiveFiles();
    assert.equal(fileRow(fixture, fileName).is_missing, 1);
    assert.equal(fileRow(fixture, fileName).is_active, 0);
    assert.equal(count(fixture, 'SELECT COUNT(*) AS n FROM journal_entries'), 4);

    // A scan finds the same thing, and finds it again once the file is back.
    fixture.ingester.markMissingFiles(await fixture.ingester.listJournalFileNames());
    assert.equal(fileRow(fixture, fileName).is_missing, 1);
    copyFileSync(`${filePath}.bak`, filePath);
    utimesSync(filePath, now, now);
    rmSync(`${filePath}.bak`);
    fixture.ingester.markMissingFiles(await fixture.ingester.listJournalFileNames());
    assert.equal(fileRow(fixture, fileName).is_missing, 0);
    await fixture.build();
    assert.equal(count(fixture, 'SELECT COUNT(*) AS n FROM journal_entries'), 4, 'nothing read twice');
  } finally {
    await fixture.close();
  }
});

test('journals read before fingerprints existed get one from their stored first entry', async () => {
  const fixture = await createFixture();
  try {
    const original = fixture.writeJournal(tradingSession({ at: '2026-03-01T10:00:00Z' }));
    await fixture.build();
    const { header_hash: expected } = fileRow(fixture, original);
    assert.match(expected, /^[0-9a-f]{40}$/);
    fixture.database.exec('UPDATE journal_files SET header_hash = NULL');
    fixture.ingester.backfillHeaderHashes();
    assert.equal(fileRow(fixture, original).header_hash, expected);
  } finally {
    await fixture.close();
  }
});

test('journals named in different time zones are stored in time order, and stored ones are checked once', async () => {
  const fixture = await createFixture();
  try {
    // Name order (local time) differs from time order (UTC entries).
    fixture.writeJournal(tradingSession({ at: '2026-06-01T19:25:00Z', commander: 'BRAVO', fid: 'F2' }), { fileName: 'Journal.2026-06-01T122500.01.log' });
    fixture.writeJournal(tradingSession({ at: '2026-06-01T19:15:00Z' }), { fileName: 'Journal.2026-06-01T151500.01.log' });
    await fixture.build();
    assertTimeOrdered(fixture);

    // A database stored out of order before this check existed.
    const earlierFileId = fileRow(fixture, 'Journal.2026-06-01T151500.01.log').id;
    fixture.database.prepare('UPDATE journal_entries SET id = id + 1000 WHERE journal_file_id = ?').run(earlierFileId);
    fixture.database.exec("DELETE FROM storage_state WHERE key = 'entry_order_checked'");
    const ingester = new JournalIngester({ database: fixture.database, journalDirectory: fixture.journalDirectory });
    assert.equal(ingester.restoreEntryOrderIfNeeded(), true);
    assertTimeOrdered(fixture);

    // Only once.
    fixture.database.prepare('UPDATE journal_entries SET id = id + 1000 WHERE journal_file_id = ?').run(earlierFileId);
    assert.equal(new JournalIngester({ database: fixture.database, journalDirectory: fixture.journalDirectory }).restoreEntryOrderIfNeeded(), false);
  } finally {
    await fixture.close();
  }
});
