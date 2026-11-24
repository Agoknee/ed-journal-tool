import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/database/database.mjs';
import { statModules } from '../src/stats/index.mjs';
import { StatsEngine } from '../src/stats/stats-engine.mjs';
import { createFixture, event, sessionStart } from './helpers/journal-fixture.mjs';

/** Ingests journals with the fixture's ingester, without building stats. */
async function ingest(fixture, events) {
  fixture.writeJournal(events);
  const listing = await fixture.ingester.listJournalFiles();
  for (const file of listing.files) await fixture.ingester.processFile(file.directory, file.fileName);
}

test('stats build progress: sent while building from many entries, not for small updates', async () => {
  const fixture = await createFixture();
  try {
    const jumps = Array.from({ length: 60 }, (unused, index) => event('FSDJump', { StarSystem: `System ${index}`, JumpDist: 10 }, `2026-01-01T01:${String(index).padStart(2, '0')}:00Z`));
    await ingest(fixture, [...sessionStart(), ...jumps]);

    const published = [];
    const eventHub = { publish: (topic, payload) => { if (topic === 'statsBuild') published.push(payload); } };
    // Chunks of 10 entries: the 63 entries are a large update for every module.
    const engine = new StatsEngine({ database: fixture.database, statModules, eventHub, entryChunkSize: 10 });
    engine.initialize();
    engine.resetAllModules();
    await engine.processNewEntries();

    assert.ok(published.length >= 3, `${published.length} progress updates`);
    assert.deepEqual(published[0], { isBuilding: true, totalModules: statModules.length, completedModules: 0, currentModule: null, percent: 0 });
    assert.equal(published[1].currentModule.name, statModules[0].name);
    assert.equal(published[1].currentModule.title, statModules[0].title);
    const building = published.filter((progress) => progress.isBuilding);
    for (let index = 1; index < building.length; index += 1) {
      assert.ok(building[index].percent >= building[index - 1].percent, 'the percentage only goes up');
      assert.ok(building[index].percent < 100, 'and stays under 100 until it\'s finished');
    }
    assert.equal(published.at(-1).isBuilding, false, 'it ends with the build finished');
    assert.equal(engine.buildProgress.isBuilding, false);

    // A few new entries, as while playing: no progress shown.
    published.length = 0;
    await ingest(fixture, [...sessionStart({ at: '2026-01-02T00:00:00Z' }), event('FSDJump', { StarSystem: 'Sol', JumpDist: 5 }, '2026-01-02T00:01:00Z')]);
    await engine.processNewEntries();
    assert.deepEqual(published, []);
  } finally {
    await fixture.close();
  }
});

test('stats updates name the changed modules and every module that reads from them', () => {
  const engine = new StatsEngine({ database: openDatabase(':memory:'), statModules, eventHub: { publish() {} } });
  assert.deepEqual(new Set(engine.withDependentModules(['fleet'])), new Set(['fleet', 'engineers', 'commanders', 'carriers', 'fuel-deposits']));
  assert.deepEqual(engine.withDependentModules(['chat']), ['chat']);
});

test('every module a stat module depends on exists', () => {
  const positions = new Map(statModules.map((statModule, index) => [statModule.name, index]));
  for (const statModule of statModules) {
    for (const dependencyName of statModule.dependsOn) {
      assert.ok(positions.has(dependencyName), `${statModule.name} depends on missing ${dependencyName}`);
    }
  }
});
