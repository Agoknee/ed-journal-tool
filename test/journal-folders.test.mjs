import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import express from 'express';
import { splitJournalDirectories } from '../src/cli.mjs';
import { openDatabase } from '../src/database/database.mjs';
import { coreSchemaSql } from '../src/database/schema.mjs';
import { JournalIngester } from '../src/journals/journal-ingester.mjs';
import { createJournalRoutes } from '../src/server/routes/journal-routes.mjs';
import { createFixture, event, sessionStart } from './helpers/journal-fixture.mjs';

const count = (fixture, sql, ...parameters) => fixture.database.prepare(sql).get(...parameters).n;
const fileRows = (fixture) => fixture.database.prepare('SELECT * FROM journal_files ORDER BY directory, file_name').all();
const session = (options) => [...sessionStart(options), event('Music', { MusicTrack: 'Exploration' }, options.at)];

async function serveJournalRoutes(fixture, journalDirectories = fixture.journalDirectories) {
  const app = express();
  app.use('/api', createJournalRoutes(fixture.database, { journalDirectories }));
  const server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  return {
    get: async (apiPath) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${apiPath}`);
      return { status: response.status, body: await response.json() };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('journal folders: -j takes several folders, repeated or separated by ";", without repeats', () => {
  // Absolute paths for this system: a drive letter on Windows, none elsewhere.
  const [a, b, c] = ['games/one', 'games/two', 'games/three'].map((folder) => path.resolve(folder));
  assert.deepEqual(splitJournalDirectories([a]), [a]);
  assert.deepEqual(splitJournalDirectories([a, `${b}; ${c} `]), [a, b, c]);
  assert.deepEqual(splitJournalDirectories([`${a};${a}`, b]), [a, b]);
  assert.deepEqual(splitJournalDirectories(['games/one']), [a], 'relative folders are made absolute');
  assert.throws(() => splitJournalDirectories([';']), /No journal folder/);
});

test('journal folders: ":" separates folders too, except on Windows (where it\'s in drive letters)', () => {
  if (process.platform === 'win32') {
    assert.deepEqual(splitJournalDirectories(['C:/Games/One']), [path.resolve('C:/Games/One')]);
  } else {
    assert.deepEqual(splitJournalDirectories(['/games/one:/games/two']), ['/games/one', '/games/two']);
  }
});

test('journal folders: every folder is read, and journals are told apart by folder and name', async () => {
  const fixture = await createFixture({ folderCount: 2 });
  const [home, synced] = fixture.journalDirectories;
  try {
    fixture.writeJournal(session({ commander: 'ALPHA', fid: 'F1', at: '2026-06-01T10:00:00Z' }), { fileName: 'Journal.2026-06-01T100000.01.log', directory: home });
    fixture.writeJournal(session({ commander: 'BRAVO', fid: 'F2', at: '2026-06-01T11:00:00Z' }), { fileName: 'Journal.2026-06-01T110000.01.log', directory: synced });
    // The same file name in both folders, holding different journals (two clients started in the same second).
    fixture.writeJournal(session({ commander: 'ALPHA', fid: 'F1', at: '2026-06-01T12:00:00Z' }), { fileName: 'Journal.2026-06-01T120000.01.log', directory: home });
    fixture.writeJournal(session({ commander: 'BRAVO', fid: 'F2', at: '2026-06-01T12:00:00Z' }), { fileName: 'Journal.2026-06-01T120000.01.log', directory: synced });
    await fixture.build();

    const rows = fileRows(fixture);
    assert.deepEqual(rows.map((row) => [path.basename(row.directory), row.file_name, row.status]), [
      ['journals', 'Journal.2026-06-01T100000.01.log', 'ok'],
      ['journals', 'Journal.2026-06-01T120000.01.log', 'ok'],
      ['journals-2', 'Journal.2026-06-01T110000.01.log', 'ok'],
      ['journals-2', 'Journal.2026-06-01T120000.01.log', 'ok'],
    ]);
    assert.equal(count(fixture, 'SELECT COUNT(*) AS n FROM commanders'), 2);
    assert.equal(count(fixture, 'SELECT COUNT(*) AS n FROM journal_entries'), 16);

    const api = await serveJournalRoutes(fixture);
    try {
      const { body } = await api.get('/api/journals/summary');
      assert.deepEqual(body.folders.map((folder) => [path.basename(folder.directory), folder.fileCount]), [['journals', 2], ['journals-2', 2]]);
      assert.equal(body.unplacedFileCount, 0);
      const inSynced = (await api.get(`/api/journals?folder=${encodeURIComponent(synced)}`)).body;
      assert.equal(inSynced.total, 2);
    } finally {
      await api.close();
    }
  } finally {
    await fixture.close();
  }
});

test('journal folders: a synced copy of a journal already read is a copy, not read twice', async () => {
  const fixture = await createFixture({ folderCount: 2 });
  const [home, synced] = fixture.journalDirectories;
  try {
    const fileName = fixture.writeJournal(session({ at: '2026-06-01T10:00:00Z' }), { directory: home });
    await fixture.build();
    copyFileSync(path.join(home, fileName), path.join(synced, fileName));
    await fixture.build();

    const copy = fixture.database.prepare('SELECT status, status_reason FROM journal_files WHERE directory = ?').get(synced);
    assert.equal(copy.status, 'duplicate');
    assert.equal(copy.status_reason, `Same journal as ${fileName} (in ${home})`);
    assert.equal(count(fixture, 'SELECT COUNT(*) AS n FROM journal_entries'), 4, 'entries stored once');
  } finally {
    await fixture.close();
  }
});

test('journal folders: "no longer in the folder" is per folder, and an unreadable folder changes nothing', async () => {
  const fixture = await createFixture({ folderCount: 2 });
  const [home, synced] = fixture.journalDirectories;
  try {
    const homeFile = fixture.writeJournal(session({ at: '2026-06-01T10:00:00Z' }), { directory: home });
    const syncedFile = fixture.writeJournal(session({ commander: 'BRAVO', fid: 'F2', at: '2026-06-01T11:00:00Z' }), { directory: synced });
    await fixture.build();

    rmSync(path.join(synced, syncedFile));
    await fixture.build();
    const missing = () => Object.fromEntries(fileRows(fixture).map((row) => [row.file_name, row.is_missing]));
    assert.deepEqual(missing(), { [homeFile]: 0, [syncedFile]: 1 });

    // The whole home folder going away (a disconnected drive) leaves its journals as they were.
    const parked = `${home}-parked`;
    renameSync(home, parked);
    await fixture.build();
    assert.deepEqual(missing(), { [homeFile]: 0, [syncedFile]: 1 });
    renameSync(parked, home);
    assert.equal(count(fixture, 'SELECT COUNT(*) AS n FROM journal_entries'), 8, 'entries are kept throughout');
  } finally {
    await fixture.close();
  }
});

test('journal folders: the raw view reads a journal from its own folder, and only from configured folders', async () => {
  const fixture = await createFixture({ folderCount: 2 });
  const [, synced] = fixture.journalDirectories;
  try {
    const fileName = fixture.writeJournal([event('Fileheader', { part: 1 }, '2026-06-01T00:00:00Z')], { directory: synced });
    await fixture.build();
    const fileId = fixture.database.prepare('SELECT id FROM journal_files WHERE file_name = ?').get(fileName).id;

    const both = await serveJournalRoutes(fixture);
    try {
      const raw = await both.get(`/api/journals/${fileId}/raw`);
      assert.equal(raw.status, 200);
      assert.equal(raw.body.lineCount, 1);
    } finally {
      await both.close();
    }
    // Served with only the first folder configured, the second folder's journal isn't read.
    const onlyFirst = await serveJournalRoutes(fixture, [fixture.journalDirectory]);
    try {
      const raw = await onlyFirst.get(`/api/journals/${fileId}/raw`);
      assert.equal(raw.status, 404);
      assert.equal(raw.body.error, 'The file is no longer in any of the journal folders.');
    } finally {
      await onlyFirst.close();
    }
  } finally {
    await fixture.close();
  }
});

test('journal folders: an older database keeps its journals, which are claimed by the folder holding them', async () => {
  const fixture = await createFixture();
  const directory = mkdtempSync(path.join(tmpdir(), 'edjt-folders-'));
  const databasePath = path.join(directory, 'old.db');
  let database = null;
  try {
    const keptName = fixture.writeJournal(session({ at: '2026-06-01T10:00:00Z' }));
    await fixture.build();
    const entryCount = count(fixture, 'SELECT COUNT(*) AS n FROM journal_entries');

    // The schema before journal folders were recorded: file names unique on their own.
    const old = new DatabaseSync(databasePath);
    old.exec(coreSchemaSql
      .replace(/^\s*directory[^\n]*\n/m, '')
      .replace(/file_name(\s+)TEXT NOT NULL,/, 'file_name$1TEXT NOT NULL UNIQUE,')
      .replace(/,\s*UNIQUE \(directory, file_name\)/, ''));
    assert.ok(!old.prepare('PRAGMA table_info(journal_files)').all().some((column) => column.name === 'directory'));
    old.exec('ATTACH DATABASE ? AS current'.replace('?', `'${fixture.databasePath.replace(/'/g, "''")}'`));
    old.exec(`
      INSERT INTO commanders SELECT * FROM current.commanders;
      INSERT INTO journal_files (id, file_name, sort_key, commander_id, status, file_size, modified_ms, bytes_read, line_count, entry_count,
          first_timestamp, last_timestamp, game_version, is_closed, header_hash)
        SELECT id, file_name, sort_key, commander_id, status, file_size, modified_ms, bytes_read, line_count, entry_count,
          first_timestamp, last_timestamp, game_version, is_closed, header_hash FROM current.journal_files;
      INSERT INTO journal_files (file_name, sort_key, status) VALUES ('Journal.2025-01-01T000000.01.log', '2025', 'ok');
      INSERT INTO journal_entries SELECT * FROM current.journal_entries;
      INSERT INTO entry_dictionaries SELECT * FROM current.entry_dictionaries;
    `);
    old.exec('DETACH DATABASE current');
    old.close();

    database = openDatabase(databasePath);
    const columns = database.prepare('PRAGMA table_info(journal_files)').all().map((column) => column.name);
    assert.ok(columns.includes('directory'));
    assert.deepEqual(database.prepare('SELECT directory, file_name FROM journal_files ORDER BY id').all().map((row) => ({ ...row })), [
      { directory: '', file_name: keptName },
      { directory: '', file_name: 'Journal.2025-01-01T000000.01.log' },
    ]);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, entryCount, 'entries kept');
    assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);

    // Read with the folder that holds the first journal: it's claimed, not read again.
    const ingester = new JournalIngester({ database, journalDirectory: fixture.journalDirectory });
    const listing = await ingester.listJournalFiles();
    ingester.markMissingFiles(listing);
    for (const file of listing.files) await ingester.processFile(file.directory, file.fileName);
    const rows = database.prepare('SELECT directory, file_name, is_missing, entry_count FROM journal_files ORDER BY id').all().map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { directory: fixture.journalDirectory, file_name: keptName, is_missing: 0, entry_count: entryCount },
      { directory: '', file_name: 'Journal.2025-01-01T000000.01.log', is_missing: 1, entry_count: 0 },
    ]);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, entryCount, 'nothing read twice');
  } finally {
    database?.close();
    rmSync(directory, { recursive: true, force: true });
    await fixture.close();
  }
});

test('journal folders: a renamed folder is a move: journals keep their records and new lines are read', async () => {
  const fixture = await createFixture();
  const oldFolder = fixture.journalDirectory;
  const newFolder = `${oldFolder}-renamed`;
  try {
    fixture.writeJournal([...sessionStart({ at: '2026-06-01T10:00:00Z' }), event('Shutdown', {}, '2026-06-01T10:30:00Z')]);
    const live = fixture.writeJournal(session({ at: '2026-06-01T11:00:00Z' }));
    await fixture.build();
    const idsBefore = fileRows(fixture).map((row) => row.id);

    renameSync(oldFolder, newFolder);
    // The game carries on writing the live journal in the renamed folder.
    appendFileSync(path.join(newFolder, live), `${JSON.stringify(event('Music', { MusicTrack: 'Combat' }, '2026-06-01T11:10:00Z'))}\r\n`);
    const ingester = new JournalIngester({ database: fixture.database, journalDirectories: [newFolder] });
    const listing = await ingester.listJournalFiles();
    ingester.markMissingFiles(listing);
    for (const file of listing.files) await ingester.processFile(file.directory, file.fileName);

    const rows = fileRows(fixture);
    assert.deepEqual(rows.map((row) => [row.id, row.directory, row.status, row.is_missing]), idsBefore.map((id) => [id, ingester.journalDirectories[0], 'ok', 0]),
      'the same records, now in the renamed folder: no copies, nothing missing');
    assert.equal(count(fixture, 'SELECT COUNT(*) AS n FROM journal_entries'), 9, 'the new line is stored, nothing twice');
    assert.equal(count(fixture, "SELECT COUNT(*) AS n FROM journal_entries WHERE timestamp = '2026-06-01T11:10:00Z'"), 1);
  } finally {
    if (existsSync(newFolder)) renameSync(newFolder, oldFolder);
    await fixture.close();
  }
});

test('journal folders: a journal renamed in its folder is a move, while a copy beside its original stays a copy', async () => {
  const fixture = await createFixture();
  try {
    const original = fixture.writeJournal(session({ at: '2026-06-01T10:00:00Z' }), { fileName: 'Journal.2026-06-01T100000.01.log' });
    await fixture.build();
    const { id } = fileRows(fixture)[0];

    // Renamed: the original's record follows it (with the sort key of its new name).
    const renamed = 'Journal.2026-06-01T100001.01.log';
    renameSync(path.join(fixture.journalDirectory, original), path.join(fixture.journalDirectory, renamed));
    await fixture.build();
    assert.deepEqual(fileRows(fixture).map((row) => [row.id, row.file_name, row.status, row.sort_key.endsWith('100001.01')]), [[id, renamed, 'ok', true]]);

    // Copied alongside: still a copy, as the original is right there.
    const copy = 'Journal.2026-06-01T100002.01.log';
    copyFileSync(path.join(fixture.journalDirectory, renamed), path.join(fixture.journalDirectory, copy));
    await fixture.build();
    assert.deepEqual(fileRows(fixture).map((row) => [row.file_name, row.status]), [[renamed, 'ok'], [copy, 'duplicate']]);
    assert.equal(count(fixture, 'SELECT COUNT(*) AS n FROM journal_entries'), 4);

    // The original then goes: the copy was the one to keep, so it takes over the original's record.
    rmSync(path.join(fixture.journalDirectory, renamed));
    await fixture.build();
    assert.deepEqual(fileRows(fixture).map((row) => [row.id, row.file_name, row.status, row.is_missing]), [[id, copy, 'ok', 0]]);
    assert.equal(count(fixture, 'SELECT COUNT(*) AS n FROM journal_entries'), 4);
  } finally {
    await fixture.close();
  }
});
