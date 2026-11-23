import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture, event, sessionStart } from './helpers/journal-fixture.mjs';

const T = (minute) => `2026-01-01T00:${String(minute).padStart(2, '0')}:00Z`;

test('credits: balances, transactions by category and the carrier-trade filter', async () => {
  const fixture = await createFixture();
  try {
    fixture.writeJournal([
      ...sessionStart({ credits: 1_000_000 }),
      // Docked at a station: these trades count everywhere.
      event('Docked', { StationName: 'Station A', StationType: 'Coriolis', StarSystem: 'Sol', MarketID: 100 }, T(1)),
      event('MarketBuy', { MarketID: 100, Type: 'gold', Type_Localised: 'Gold', Count: 10, TotalCost: 50_000 }, T(2)),
      event('Undocked', { StationName: 'Station A', MarketID: 100 }, T(3)),
      // Docked at a fleet carrier: these are carrier trades.
      event('Docked', { StationName: 'ABC-123', StationType: 'FleetCarrier', StarSystem: 'Sol', MarketID: 200 }, T(4)),
      event('MarketSell', { MarketID: 200, Type: 'gold', Type_Localised: 'Gold', Count: 10, TotalSale: 80_000 }, T(5)),
      event('CarrierBankTransfer', { CarrierID: 200, Deposit: 500_000, PlayerBalance: 530_000, CarrierBalance: 500_000 }, T(6)),
      event('MissionCompleted', { Faction: 'Feds', Name: 'Mission_Courier', LocalisedName: 'Courier', MissionID: 1, Reward: 20_000 }, T(7)),
      event('RepairAll', { Cost: 1_234 }, T(8)),
      event('Shutdown', {}, T(9)),
    ]);
    await fixture.build();
    const commanderId = fixture.commanderId();

    const all = (await fixture.get(`/api/stats/credits?commander=${commanderId}`)).body;
    assert.deepEqual(all.balance, { timestamp: T(6), balance: 530_000, source: 'carrier transfer' });
    assert.equal(all.balanceHistory.length, 1, 'one reading per day');
    const byCategory = Object.fromEntries(all.categories.map((category) => [category.category, category.total]));
    assert.equal(byCategory['Commodity purchases'], -50_000);
    assert.equal(byCategory['Commodity sales'], 80_000);
    assert.equal(byCategory.Missions, 20_000);
    assert.equal(byCategory.Repairs, -1_234);
    assert.equal(byCategory['Carrier bank'], -500_000);
    // Carrier bank transfers only move credits, so they're not monthly income or spending.
    assert.deepEqual(all.monthly, [{ month: '2026-01', income: 100_000, spending: 51_234 }]);

    const withoutCarrier = (await fixture.get(`/api/stats/credits?commander=${commanderId}&excludeCarrier=true`)).body;
    const categories = withoutCarrier.categories.map((category) => category.category);
    assert.ok(!categories.includes('Commodity sales'), 'the carrier sale is left out');
    assert.ok(categories.includes('Commodity purchases'), 'the station purchase stays');
    assert.deepEqual(withoutCarrier.monthly, [{ month: '2026-01', income: 20_000, spending: 51_234 }]);
    assert.deepEqual(withoutCarrier.balance, all.balance, 'the balance is unaffected');

    assert.equal((await fixture.get('/api/stats/credits?commander=all')).status, 400);
  } finally {
    await fixture.close();
  }
});

test('stats leave out journals from the Legacy (3.x) game client', async () => {
  const fixture = await createFixture();
  try {
    fixture.writeJournal([...sessionStart({ credits: 9_000_000, at: T(0) }), event('Shutdown', {}, T(1))]);
    fixture.writeJournal([...sessionStart({ credits: 1_000, gameVersion: '3.8.0.1400', at: T(2) }), event('Shutdown', {}, T(3))],
      { fileName: 'Journal.260101000200.01.log' });
    await fixture.build();
    const commanderId = fixture.commanderId();
    const credits = (await fixture.get(`/api/stats/credits?commander=${commanderId}`)).body;
    assert.equal(credits.balance.balance, 9_000_000);
    const profile = (await fixture.get(`/api/stats/commanders?commander=${commanderId}`)).body.commanders[0];
    assert.equal(profile.summary.credits, 9_000_000);
    assert.equal(profile.summary.currentShip.shipId, 1, 'the Legacy session’s ship isn’t current');
  } finally {
    await fixture.close();
  }
});
