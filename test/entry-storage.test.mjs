import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { openDatabase } from '../src/database/database.mjs';
import { compactJournalEntries, getEntryCodec, vacuumIfDue } from '../src/database/entry-compression.mjs';
import { coreSchemaSql } from '../src/database/schema.mjs';
import { createJournalRoutes } from '../src/server/routes/journal-routes.mjs';
import { createSqlRoutes } from '../src/server/routes/sql-routes.mjs';
import { createFixture, event, sessionStart } from './helpers/journal-fixture.mjs';

/** A varied play session, including text that only round-trips if stored byte for byte. */
function playSession(at, count) {
  const events = [...sessionStart({ credits: 50_000, at })];
  for (let index = 0; index < count; index += 1) {
    events.push(event('Bounty', { Target: 'pirate', TotalReward: 1000 + index, VictimFaction: 'Ünïcødé Brothers 🚀' }, at));
    events.push(event('ReceiveText', { From: 'CMDR Zoë', Message: `o7 «${index}» 日本語`, Channel: 'local' }, at));
    events.push(event('MarketSell', { MarketID: 1, Type: 'gold', Count: 2, SellPrice: 500, TotalSale: 1000, AvgPricePaid: 400 }, at));
  }
  events.push(event('Shutdown', {}, at));
  return events;
}

async function serve(fixture) {
  const app = express();
  app.use(express.json());
  app.use('/api', createJournalRoutes(fixture.database));
  const sqlRoutes = createSqlRoutes(fixture.databasePath, fixture.database);
  app.use('/api/sql', sqlRoutes);
  const server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: async (apiPath) => (await fetch(base + apiPath)).json(),
    sql: async (query) => (await fetch(`${base}/api/sql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) })).json(),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      sqlRoutes.closeDatabase();
    },
  };
}

function withoutTiming({ elapsedMs: _elapsedMs, ...result }) {
  return result;
}

/** Everything a user can see that comes from stored entries. */
async function captureViews(fixture, api) {
  const commanderId = fixture.commanderId();
  const stats = {};
  for (const statPath of ['credits', 'commodities/trades', 'commodities/totals', 'combat/status', 'chat/messages', 'chat/totals', 'commanders']) {
    const { status, body } = await fixture.get(`/api/stats/${statPath}?commander=${commanderId}`);
    assert.equal(status, 200, statPath);
    stats[statPath] = body;
  }
  const fileIds = fixture.database.prepare('SELECT id FROM journal_files ORDER BY id').all().map((row) => row.id);
  const entries = [];
  for (const fileId of fileIds) entries.push(await api.get(`/api/journals/${fileId}/entries?limit=1000&order=asc`));
  return {
    stats,
    entries,
    summary: (await api.get(`/api/journals/summary?commander=${commanderId}`)).topEvents,
    allSummary: (await api.get('/api/journals/summary')).topEvents,
    sql: withoutTiming(await api.sql("SELECT COUNT(*) AS bounties, SUM(json_extract(data, '$.TotalReward')) AS reward, MAX(data) AS last FROM journal_entries WHERE event = 'Bounty'")),
  };
}

/** Each stored entry, decoded, next to the exact line in its journal file. */
function assertEntriesMatchFiles(fixture) {
  const codec = getEntryCodec(fixture.database);
  const files = fixture.database.prepare('SELECT id, file_name FROM journal_files').all();
  let checkedCount = 0;
  for (const file of files) {
    const lines = readFileSync(path.join(fixture.journalDirectory, file.file_name), 'utf8').split('\r\n');
    for (const entry of fixture.database.prepare('SELECT line_number, data FROM journal_entries WHERE journal_file_id = ?').all(file.id)) {
      assert.equal(codec.decode(entry.data), lines[entry.line_number - 1]);
      checkedCount += 1;
    }
  }
  return checkedCount;
}

test('entry codec: lossless with and without a dictionary, and never changes text it can’t store exactly', async () => {
  const fixture = await createFixture();
  try {
    const codec = getEntryCodec(fixture.database);
    const line = JSON.stringify(event('ReceiveText', { Message: 'Zoë 🚀 日本語' }));
    const plain = codec.encode(line);
    assert.equal(plain[0], 0);
    assert.equal(codec.decode(plain), line);
    assert.equal(codec.decode(line), line, 'old uncompressed entries read as they are');
    const broken = '{"Message":"\uD800"}';
    assert.equal(codec.encode(broken), broken);
  } finally {
    await fixture.close();
  }
});

test('compacting entries keeps every stored line, stat and query result exactly the same', async () => {
  const fixture = await createFixture();
  const api = await serve(fixture);
  try {
    fixture.writeJournal(playSession('2026-01-01T00:00:00Z', 150));
    fixture.writeJournal(playSession('2026-01-02T00:00:00Z', 150));
    await fixture.build();
    const before = await captureViews(fixture, api);
    assert.equal(before.sql.rows[0][0], 300);
    assert.equal(before.summary.find((row) => row.event === 'Bounty').entry_count, 300);

    // In chunks of 100, so progress is reported along the way.
    const progress = [];
    const result = await compactJournalEntries(fixture.database, { minTrainingEntryCount: 1, chunkSize: 100, onProgress: (update) => progress.push(update) });
    const entryCount = fixture.database.prepare('SELECT COUNT(*) AS entryCount FROM journal_entries').get().entryCount;
    assert.equal(result.compressedCount, entryCount);
    assert.ok(progress.length >= 3, `${progress.length} progress updates`);
    assert.ok(progress.every((update, index) => index === 0 || update.checkedCount > progress[index - 1].checkedCount), 'progress only goes up');
    assert.deepEqual(progress.at(-1), { checkedCount: progress.at(-1).totalCount, totalCount: progress.at(-1).totalCount, compressedCount: entryCount });
    assert.equal(result.keptCount, 0);
    const storedKinds = fixture.database.prepare('SELECT typeof(data) AS kind, unicode(data) AS dictionaryId, COUNT(*) AS entryCount FROM journal_entries GROUP BY 1, 2').all();
    assert.deepEqual(storedKinds.map((row) => ({ ...row })), [{ kind: 'blob', dictionaryId: 1, entryCount }]);
    assert.equal(assertEntriesMatchFiles(fixture), entryCount);

    // Rebuilding every stat from the compressed entries gives the same results.
    fixture.statsEngine.resetAllModules();
    await fixture.statsEngine.processNewEntries();
    assert.deepEqual(await captureViews(fixture, api), before);

    // Running again has nothing to do; new entries use the dictionary straight away.
    assert.deepEqual(await compactJournalEntries(fixture.database, { minTrainingEntryCount: 1 }), { compressedCount: 0, keptCount: 0 });
    fixture.writeJournal(playSession('2026-01-03T00:00:00Z', 5));
    await fixture.build();
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE typeof(data) != \'blob\' OR unicode(data) != 1').get().n, 0);
    assertEntriesMatchFiles(fixture);
    assert.equal((await api.get('/api/journals/summary')).topEvents.find((row) => row.event === 'Bounty').entry_count, 305);

    // Reprocessing a file replaces its event counts rather than adding to them.
    fixture.ingester.resetFile(1);
    await fixture.build();
    assert.equal((await api.get('/api/journals/summary')).topEvents.find((row) => row.event === 'Bounty').entry_count, 305);
  } finally {
    await api.close();
    await fixture.close();
  }
});

test('an older database is migrated: event counts replace the index, entries are compressed and the file shrinks', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'edjt-compress-'));
  const databasePath = path.join(directory, 'old.db');
  let database = null;
  try {
    const old = new DatabaseSync(databasePath);
    old.exec(coreSchemaSql
      .replace('data             BLOB NOT NULL', 'data             TEXT NOT NULL')
      .replace(/CREATE TABLE IF NOT EXISTS (entry_dictionaries|journal_file_events|storage_state) \([\s\S]*?\)( WITHOUT ROWID)?;/g, ''));
    old.exec('CREATE INDEX idx_journal_entries_commander_time ON journal_entries(commander_id, timestamp);');
    old.exec("INSERT INTO commanders (id, commander_key, name) VALUES (1, 'F1', 'TESTER'); INSERT INTO journal_files (id, file_name, sort_key, commander_id) VALUES (1, 'a', 'a', 1), (2, 'b', 'b', 1);");
    const insert = old.prepare('INSERT INTO journal_entries (journal_file_id, commander_id, line_number, timestamp, event, data) VALUES (?, 1, ?, ?, ?, ?)');
    const originals = new Map();
    old.exec('BEGIN');
    for (let index = 1; index <= 30_000; index += 1) {
      const entry = event(index % 3 ? 'Music' : 'Bounty', { MusicTrack: `Track ${index % 7}`, TotalReward: index, Text: 'Zoë 🚀' });
      const text = JSON.stringify(entry);
      insert.run(index % 2 ? 1 : 2, index, entry.timestamp, entry.event, text);
      originals.set(index, text);
    }
    old.exec('COMMIT');
    old.close();

    database = openDatabase(databasePath);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'idx_journal_entries_commander_time'").get().n, 0);
    const counts = database.prepare('SELECT journal_file_id, event, entry_count FROM journal_file_events ORDER BY 1, 2').all().map((row) => ({ ...row }));
    assert.deepEqual(counts, [
      { journal_file_id: 1, event: 'Bounty', entry_count: 5000 },
      { journal_file_id: 1, event: 'Music', entry_count: 10000 },
      { journal_file_id: 2, event: 'Bounty', entry_count: 5000 },
      { journal_file_id: 2, event: 'Music', entry_count: 10000 },
    ]);

    const result = await compactJournalEntries(database);
    assert.equal(result.compressedCount, 30_000);
    const codec = getEntryCodec(database);
    for (const row of database.prepare('SELECT id, data FROM journal_entries').all()) {
      assert.equal(typeof row.data, 'object');
      assert.equal(codec.decode(row.data), originals.get(row.id));
    }
    const sizeBefore = database.prepare('PRAGMA page_count').get().page_count;
    assert.equal(vacuumIfDue(database), true);
    assert.ok(database.prepare('PRAGMA page_count').get().page_count < sizeBefore / 2);
    for (const row of database.prepare('SELECT id, data FROM journal_entries').all()) assert.equal(codec.decode(row.data), originals.get(row.id));
  } finally {
    database?.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
