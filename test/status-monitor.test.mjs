import assert from 'node:assert/strict';
import { utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { StatusMonitor } from '../src/journals/status-monitor.mjs';
import { createFixture, event, sessionStart } from './helpers/journal-fixture.mjs';

const MAIN_SHIP = 1 << 24;
const SHIELDS = 1 << 3;
const HARDPOINTS = 1 << 6;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('status monitor: matches Status.json writes to the right commander and settles flags', async () => {
  const fixture = await createFixture();
  try {
    // Two commanders playing: A has 1,000 cr and 60 t of fuel, B has 5,000 cr and 120 t.
    const fileA = fixture.writeJournal([...sessionStart({ commander: 'ALPHA', fid: 'F1', credits: 1000 }), event('ReservoirReplenished', { FuelMain: 60, FuelReservoir: 1 })]);
    const fileB = fixture.writeJournal([...sessionStart({ commander: 'BRAVO', fid: 'F2', credits: 5000 }), event('ReservoirReplenished', { FuelMain: 120, FuelReservoir: 1 })]);
    await fixture.build();
    fixture.database.exec('UPDATE journal_files SET is_active = 1');
    const alpha = fixture.commanderId('ALPHA');
    const bravo = fixture.commanderId('BRAVO');

    const published = [];
    const monitor = new StatusMonitor({ database: fixture.database, journalDirectory: fixture.journalDirectory, eventHub: { publish: (topic) => published.push(topic) } });
    const statusPath = path.join(fixture.journalDirectory, 'Status.json');
    let writeCount = 0;
    const writeStatus = async ({ balance, fuel, flags }) => {
      writeCount += 1;
      writeFileSync(statusPath, JSON.stringify({ timestamp: new Date(Date.UTC(2026, 0, 1, 1, 0, writeCount)).toISOString(), event: 'Status', Flags: flags, Balance: balance, Cargo: 0, Fuel: { FuelMain: fuel, FuelReservoir: 1 } }));
      const modified = new Date(Date.now() + writeCount * 1000);
      utimesSync(statusPath, modified, modified);
      await monitor.poll();
    };
    const hardpointsOf = () => Object.fromEntries(monitor.getStatus().commanders.map((status) => [status.commanderId, status.flags?.hardpointsDeployed ?? 'unsettled']));

    await writeStatus({ balance: 1000, fuel: 59.5, flags: MAIN_SHIP | SHIELDS | HARDPOINTS });
    await writeStatus({ balance: 5000, fuel: 119, flags: MAIN_SHIP | SHIELDS });
    assert.deepEqual(hardpointsOf(), { [alpha]: 'unsettled', [bravo]: 'unsettled' }, 'flags wait to settle');
    await wait(3100);
    await monitor.poll();
    assert.deepEqual(hardpointsOf(), { [alpha]: true, [bravo]: false });

    await writeStatus({ balance: 777, fuel: 80, flags: MAIN_SHIP });
    assert.deepEqual(hardpointsOf(), { [alpha]: true, [bravo]: false }, 'a write matching neither is ignored');

    await writeStatus({ balance: 1000, fuel: 59.4, flags: MAIN_SHIP | SHIELDS });
    await writeStatus({ balance: 1000, fuel: 59.4, flags: MAIN_SHIP | SHIELDS | HARDPOINTS });
    await wait(3100);
    await monitor.poll();
    assert.equal(hardpointsOf()[alpha], true, 'a blip that reverts within 3 seconds never shows');

    // A's balance changes (bounties redeemed) as A's journal is written: still A.
    const nowish = new Date(Date.now() + (writeCount + 1) * 1000);
    utimesSync(path.join(fixture.journalDirectory, fileA), nowish, nowish);
    await writeStatus({ balance: 2500, fuel: 59.3, flags: MAIN_SHIP | SHIELDS });
    await wait(3100);
    await monitor.poll();
    assert.equal(hardpointsOf()[alpha], false);
    assert.ok(published.includes('shipStatus'));

    // With one playing commander, every write is theirs.
    fixture.database.prepare('UPDATE journal_files SET is_active = 0 WHERE file_name = ?').run(fileB);
    await writeStatus({ balance: 1, fuel: 1, flags: MAIN_SHIP });
    const statuses = monitor.getStatus().commanders;
    assert.deepEqual(statuses.map((status) => [status.commanderId, status.matchedBy]), [[alpha, 'onlyClient']]);
  } finally {
    await fixture.close();
  }
});
