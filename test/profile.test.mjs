import assert from 'node:assert/strict';
import test from 'node:test';
import { getEngineerInfo } from '../src/game-data/engineers.mjs';
import { createFixture, event, sessionStart } from './helpers/journal-fixture.mjs';

const T = (minute) => `2026-01-01T00:${String(minute).padStart(2, '0')}:00Z`;

test('engineer data: systems and modifications, whatever the quote style', () => {
  assert.equal(getEngineerInfo('Felicity Farseer').system, 'Deciat');
  assert.equal(getEngineerInfo("Tod 'The Blaster' McQuinn").system, 'Wolf 397');
  assert.ok(getEngineerInfo('Felicity Farseer').modifications.some((modification) => modification.name === 'Frame Shift Drive'));
  assert.equal(getEngineerInfo('Nobody'), null);
});

test('commanders, reputation and engineers from one session', async () => {
  const fixture = await createFixture();
  try {
    fixture.writeJournal([
      ...sessionStart(),
      event('Rank', { Combat: 8, Trade: 13, Explore: 3, Soldier: 0, Exobiologist: 0, Empire: 0, Federation: 14, CQC: 0 }, T(1)),
      event('Progress', { Combat: 0, Trade: 100, Explore: 40, Soldier: 0, Exobiologist: 0, Empire: 0, Federation: 100, CQC: 0 }, T(1)),
      event('Reputation', { Empire: 10, Federation: 95, Independent: -50, Alliance: 0 }, T(1)),
      event('Powerplay', { Power: 'Aisling Duval', Rank: 50, Merits: 1000, TimePledged: 86400 }, T(2)),
      event('PowerplayMerits', { Power: 'Aisling Duval', MeritsGained: 25, TotalMerits: 1025 }, T(3)),
      event('FSDJump', { StarSystem: 'Sol', Factions: [
        { Name: 'Mother Gaia', MyReputation: 100, Allegiance: 'Federation', Government_Localised: 'Democracy' },
        { Name: 'Sol Workers', MyReputation: -95, Allegiance: 'Independent', Government: '$government_Cooperative;' },
      ] }, T(4)),
      event('EngineerProgress', { Engineers: [
        { Engineer: 'Felicity Farseer', EngineerID: 300100, Progress: 'Unlocked', Rank: 5, RankProgress: 0 },
        { Engineer: 'Elvira Martuuk', EngineerID: 300160, Progress: 'Invited' },
      ] }, T(5)),
      event('EngineerCraft', { Engineer: 'Felicity Farseer', EngineerID: 300100, BlueprintName: 'FSD_LongRange', Level: 5, Module: 'int_hyperdrive_size5_class5', ApplyExperimentalEffect: 'special_fsd_heavy', Ingredients: [] }, T(6)),
      event('EngineerCraft', { EngineerID: 399999, BlueprintName: 'FSD_LongRange', Level: 5, ApplyExperimentalEffect: 'special_fsd_heavy', Ingredients: [] }, T(7)),
      event('Loadout', { Ship: 'sidewinder', ShipID: 1, Modules: [{ Slot: 'FrameShiftDrive', Item: 'int_hyperdrive_size5_class5', On: true, Priority: 0, Health: 1, Engineering: { Engineer: 'Felicity Farseer', BlueprintName: 'FSD_LongRange', Level: 5, Quality: 1 } }] }, T(8)),
      event('Shutdown', {}, T(9)),
    ]);
    await fixture.build();
    const commanderId = fixture.commanderId();

    const profile = (await fixture.get(`/api/stats/commanders?commander=${commanderId}`)).body.commanders[0];
    assert.equal(profile.rank_names.Combat, 'Elite');
    assert.equal(profile.next_rank_names.Combat, 'Elite I');
    assert.equal(profile.rank_names.Trade, 'Elite V');
    assert.equal(profile.next_rank_names.Trade, null);
    assert.equal(profile.rank_names.Federation, 'Admiral');
    assert.equal(profile.reputation.Federation, 95);

    const reputation = (await fixture.get(`/api/stats/reputation?commander=${commanderId}`)).body;
    assert.equal(reputation.powerplay[0].power, 'Aisling Duval');
    assert.equal(reputation.powerplay[0].merits, 1025);
    assert.equal(reputation.powerplay[0].rank, 50);
    assert.deepEqual(reputation.factionCounts, { Allied: 1, Hostile: 1 });

    const factionsPage = (await fixture.get(`/api/stats/reputation/factions?commander=${commanderId}&limit=1`)).body;
    assert.equal(factionsPage.total, 2);
    assert.equal(factionsPage.rows.length, 1, 'paged on the server');
    assert.deepEqual(factionsPage.rows[0], { faction: 'Mother Gaia', reputation: 100, standing: 'Allied', allegiance: 'Federation', government: 'Democracy', starSystem: 'Sol', updatedAt: T(4) });
    const searched = (await fixture.get(`/api/stats/reputation/factions?commander=${commanderId}&search=workers`)).body;
    assert.deepEqual(searched.rows.map((row) => [row.faction, row.standing, row.government]), [['Sol Workers', 'Hostile', 'Cooperative']]);
    const ascending = (await fixture.get(`/api/stats/reputation/factions?commander=${commanderId}&sort=reputation&order=asc`)).body;
    assert.deepEqual(ascending.rows.map((row) => row.faction), ['Sol Workers', 'Mother Gaia']);
    assert.equal((await fixture.get('/api/stats/reputation/factions?commander=all')).status, 400);

    const engineers = (await fixture.get(`/api/stats/engineers?commander=${commanderId}`)).body.engineers;
    const byName = Object.fromEntries(engineers.map((engineer) => [engineer.engineer, engineer]));
    assert.equal(byName['Felicity Farseer'].progress, 'Unlocked');
    assert.equal(byName['Felicity Farseer'].system, 'Deciat');
    assert.equal(byName['Felicity Farseer'].craftCount, 1);
    assert.deepEqual(byName['Felicity Farseer'].blueprints.map((blueprint) => [blueprint.blueprint, blueprint.level, blueprint.experimentals]), [['Long Range', 5, 1]]);
    assert.equal(byName['Felicity Farseer'].modules.length, 1);
    assert.equal(byName['Felicity Farseer'].modules[0].slot, 'Frame Shift Drive');
    assert.equal(byName['Elvira Martuuk'].progress, 'Invited');
    assert.equal(byName['Remote Workshop'].isRemoteWorkshop, true);
  } finally {
    await fixture.close();
  }
});
