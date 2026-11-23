import assert from 'node:assert/strict';
import test from 'node:test';
import { describeMaterial, MAX_BY_GRADE } from '../src/game-data/materials.mjs';
import { createFixture, event, sessionStart } from './helpers/journal-fixture.mjs';

const T = (minute) => `2026-01-01T00:${String(minute).padStart(2, '0')}:00Z`;

test('material data: grades, families and caps', () => {
  assert.deepEqual(describeMaterial('Carbon'), { category: 'raw', family: 'Raw 1', grade: 1, maxCount: 300 });
  assert.deepEqual(describeMaterial('imperialshielding'), { category: 'manufactured', family: 'Shielding', grade: 5, maxCount: 100 });
  assert.equal(describeMaterial('guardian_powercell').family, 'Guardian');
  assert.equal(describeMaterial('nonexistent'), null);
  assert.deepEqual(MAX_BY_GRADE, { 1: 300, 2: 250, 3: 200, 4: 150, 5: 100 });
});

test('inventory: materials stay current between logins, capped by grade', async () => {
  const fixture = await createFixture();
  try {
    fixture.writeJournal([
      ...sessionStart(),
      event('Materials', {
        Raw: [{ Name: 'carbon', Count: 295 }, { Name: 'yttrium', Count: 10 }],
        Manufactured: [{ Name: 'shieldemitters', Name_Localised: 'Shield Emitters', Count: 20 }],
        Encoded: [{ Name: 'bulkscandata', Name_Localised: 'Anomalous Bulk Scan Data', Count: 5 }],
      }, T(1)),
      event('MaterialCollected', { Category: 'Raw', Name: 'carbon', Count: 9 }, T(2)),
      event('MaterialCollected', { Category: 'Raw', Name: 'iron', Count: 3 }, T(3)),
      event('MaterialTrade', {
        MarketID: 1, TraderType: 'manufactured',
        Paid: { Material: 'shieldemitters', Category: 'Manufactured', Quantity: 6 },
        Received: { Material: 'wornshieldemitters', Material_Localised: 'Worn Shield Emitters', Category: 'Manufactured', Quantity: 18 },
      }, T(4)),
      event('EngineerCraft', { Engineer: 'Felicity Farseer', EngineerID: 300100, BlueprintName: 'FSD_LongRange', Level: 1, Ingredients: [{ Name: 'yttrium', Count: 4 }] }, T(5)),
      event('ShipLocker', { Items: [{ Name: 'healthmonitor', Name_Localised: 'Health Monitor', Count: 2 }], Components: [{ Name: 'aerogel', Name_Localised: 'Aerogel', Count: 7 }], Consumables: [], Data: [] }, T(6)),
      event('ShipLocker', {}, T(7)),
      event('Backpack', { Items: [], Components: [], Consumables: [{ Name: 'healthpack', Name_Localised: 'Medkit', Count: 1 }], Data: [] }, T(8)),
      event('Cargo', { Vessel: 'Ship', Count: 4, Inventory: [{ Name: 'gold', Name_Localised: 'Gold', Count: 4, Stolen: 0 }] }, T(9)),
      event('Shutdown', {}, T(10)),
    ]);
    await fixture.build();
    const commanderId = fixture.commanderId();
    const assets = (await fixture.get(`/api/stats/inventory?commander=${commanderId}`)).body;
    assert.equal((await fixture.get('/api/stats/inventory?commander=all')).status, 400);

    const find = (category, key) => assets.materials[category].find((material) => material.key === key);
    assert.equal(find('raw', 'carbon').count, 300, 'carbon is capped at its grade-1 limit');
    assert.equal(find('raw', 'carbon').maxCount, 300);
    assert.equal(find('raw', 'carbon').name, 'Carbon', 'internal names are capitalised for display');
    assert.equal(find('raw', 'iron').count, 3, 'a new material is added to its category');
    assert.equal(find('raw', 'yttrium').count, 6, 'engineering ingredients are taken away');
    assert.equal(find('raw', 'yttrium').grade, 4);
    assert.equal(find('manufactured', 'shieldemitters').count, 14);
    assert.equal(find('manufactured', 'wornshieldemitters').count, 18);
    assert.equal(find('manufactured', 'wornshieldemitters').family, 'Shielding');

    assert.deepEqual(assets.shipLocker.components, [{ key: 'aerogel', name: 'Aerogel', count: 7 }], 'a ShipLocker event without contents is ignored');
    assert.deepEqual(assets.backpack.consumables, [{ key: 'healthpack', name: 'Medkit', count: 1 }]);
    assert.equal(assets.cargo.count, 4);
    assert.equal(assets.cargo.inventory[0].name, 'Gold');
    assert.equal(assets.updatedAt.cargo, T(9));

    const summary = (await fixture.get(`/api/stats/commanders?commander=${commanderId}`)).body.commanders[0].summary;
    assert.equal(summary.materialCount, 300 + 3 + 6 + 14 + 18 + 5);
    assert.equal(summary.shipLockerCount, 9);
    assert.equal(summary.cargoCount, 4);
  } finally {
    await fixture.close();
  }
});
