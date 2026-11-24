import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { JournalIngester } from '../src/journals/journal-ingester.mjs';
import { JournalMonitor } from '../src/journals/journal-monitor.mjs';
import { createFixture, event, sessionStart } from './helpers/journal-fixture.mjs';

const count = (fixture, sql) => fixture.database.prepare(sql).get().n;

test('journal folder search: started with no folder, nothing is marked missing, and a folder found later is read', async () => {
  const fixture = await createFixture();
  try {
    fixture.writeJournal([...sessionStart({ at: '2026-11-01T10:00:00Z' }), event('Music', { MusicTrack: 'Exploration' }, '2026-11-01T10:01:00Z')]);
    await fixture.build();
    assert.equal(count(fixture, 'SELECT COUNT(*) AS n FROM journal_files WHERE is_missing = 0'), 1);

    // As the app starts when no journal folder is found: no folders at all.
    const published = [];
    const ingester = new JournalIngester({ database: fixture.database, journalDirectories: [] });
    const monitor = new JournalMonitor({ ingester, statsEngine: fixture.statsEngine, eventHub: { publish: (topic) => published.push(topic) } });
    await monitor.scanJournalDirectory();
    assert.equal(count(fixture, 'SELECT COUNT(*) AS n FROM journal_files WHERE is_missing = 1'), 0, 'stored journals stay as they were');
    assert.deepEqual(published, []);

    // The game is installed (or first run) afterwards: a new folder with a journal in it.
    const newFolder = path.join(path.dirname(fixture.journalDirectory), 'found-later');
    mkdirSync(newFolder);
    fixture.writeJournal([...sessionStart({ at: '2026-11-02T10:00:00Z' }), event('Music', { MusicTrack: 'Exploration' }, '2026-11-02T10:01:00Z')], { directory: newFolder });
    const added = await monitor.addDirectories([newFolder, newFolder]);
    assert.deepEqual(added, [path.resolve(newFolder)]);
    assert.deepEqual(ingester.journalDirectories, [path.resolve(newFolder)]);
    assert.equal(count(fixture, `SELECT COUNT(*) AS n FROM journal_files WHERE directory = '${path.resolve(newFolder).replace(/'/g, "''")}'`), 1);
    assert.ok(published.includes('scan'));
    assert.deepEqual(await monitor.addDirectories([newFolder]), [], 'a folder already read is not added again');
    await monitor.stop();
  } finally {
    await fixture.close();
  }
});
