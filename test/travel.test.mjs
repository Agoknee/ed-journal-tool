import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture, event, sessionStart } from './helpers/journal-fixture.mjs';

const T = (hour, minute = 0) => `2026-01-01T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;

const SOL = { StarSystem: 'Sol', SystemAddress: 10477373803, StarPos: [0, 0, 0] };
const ALPHA = { StarSystem: 'Alpha Centauri', SystemAddress: 1458376315610, StarPos: [3.03125, -0.09375, 3.15625] };
const BARNARD = { StarSystem: "Barnard's Star", SystemAddress: 10477373804, StarPos: [-3.03125, 1.375, 4.9375] };

const systemDetails = (allegiance, economy, government, security) => ({
  SystemAllegiance: allegiance,
  SystemEconomy: '$economy_X;', SystemEconomy_Localised: economy,
  SystemGovernment: '$government_X;', SystemGovernment_Localised: government,
  SystemSecurity: '$SYSTEM_SECURITY_X;', SystemSecurity_Localised: security,
  Population: 1000,
});
const startJump = (system, starClass, at) => event('StartJump', { JumpType: 'Hyperspace', Taxi: false, StarSystem: system.StarSystem, SystemAddress: system.SystemAddress, StarClass: starClass }, at);
const fsdJump = (system, at, fields = {}) => event('FSDJump', {
  Taxi: false, Multicrew: false, ...system, ...systemDetails('Federation', 'High Tech', 'Democracy', 'High Security'),
  JumpDist: 4.38, FuelUsed: 0.5, ...fields,
}, at);

async function withTravel(events, check) {
  const fixture = await createFixture();
  try {
    fixture.writeJournal([
      ...sessionStart({ ship: 'anaconda' }),
      event('Loadout', { Ship: 'anaconda', ShipName: 'Big Stick', ShipID: 1, Modules: [] }, T(0)),
      event('Location', { ...SOL, Docked: false }, T(0, 1)),
      ...events,
    ]);
    await fixture.build();
    const get = async (path) => (await fixture.get(`/api/stats/travel${path}${path.includes('?') ? '&' : '?'}commander=${fixture.commanderId()}`)).body;
    await check(get, fixture);
  } finally {
    await fixture.close();
  }
}

test('travel: jumps record the ship, star class, system details and first visits', async () => {
  await withTravel([
    startJump(ALPHA, 'G', T(1)),
    fsdJump(ALPHA, T(1, 1)),
    startJump(SOL, 'G', T(2)),
    fsdJump(SOL, T(2, 1), { BoostUsed: 4, ...systemDetails('Federation', 'Refinery', 'Democracy', 'High Security') }),
    // A taxi ride isn't flown in the commander's own ship.
    startJump(BARNARD, 'M', T(3)),
    fsdJump(BARNARD, T(3, 1), { Taxi: true, ...systemDetails('', 'None', 'Anarchy', 'Anarchy') }),
    startJump(ALPHA, 'G', T(4)),
    fsdJump(ALPHA, T(4, 1)),
  ], async (get) => {
    const { rows, total } = await get('/jumps?sort=timestamp&order=asc');
    assert.equal(total, 4);
    const [toAlpha, toSol, taxi, backToAlpha] = rows;
    assert.equal(toAlpha.ship_type, 'anaconda');
    assert.equal(toAlpha.ship_type_name, 'Anaconda');
    assert.equal(toAlpha.ship_name, 'Big Stick');
    assert.equal(toAlpha.star_class, 'G');
    assert.equal(toAlpha.from_system, 'Sol');
    assert.equal(toAlpha.economy, 'High Tech');
    assert.equal(toAlpha.is_first_visit, 1);
    assert.equal(toSol.is_supercharged, 1);
    assert.equal(toSol.is_first_visit, 1, 'starting in Sol isn’t a jump into it');
    assert.equal(taxi.is_taxi, 1);
    assert.equal(taxi.ship_type, null);
    assert.equal(taxi.allegiance, null, 'an empty allegiance is none');
    assert.equal(taxi.economy, null, '"None" is no economy');
    assert.equal(taxi.security, 'Anarchy');
    assert.equal(taxi.star_class, 'M');
    assert.equal(backToAlpha.is_first_visit, 0);

    assert.equal((await get('/jumps?starClass=M')).total, 1);
    assert.equal((await get('/jumps?ship=anaconda')).total, 3);
    assert.equal((await get('/jumps?economy=Refinery')).total, 1);
    assert.equal((await get('/jumps?security=Anarchy')).total, 1);
    assert.equal((await get('/jumps?firstVisit=1')).total, 3);
    assert.equal((await get('/jumps?type=taxi')).total, 1);
    assert.equal((await get('/jumps?type=own')).total, 3);
    assert.equal((await get('/jumps?type=supercharged&firstVisit=1')).total, 1);
    assert.equal((await get('/jumps?period=custom&from=2026-01-01T02:30:00Z&to=2026-01-01T03:30:00Z')).total, 1);

    const summary = await get('/summary?ship=anaconda');
    assert.equal(summary.combined.total_jumps, 3);
    assert.equal(summary.combined.first_visits, 2);

    const filters = await get('/filters');
    assert.deepEqual(filters.ships, [{ value: 'anaconda', count: 3, label: 'Anaconda' }]);
    assert.deepEqual(filters.starClasses.map((choice) => [choice.value, choice.count]), [['G', 3], ['M', 1]]);
    assert.deepEqual(filters.securities.map((choice) => choice.value), ['Anarchy', 'High Security']);
  });
});

test('travel: the map lists each system once, with jumps from where they started, oldest first', async () => {
  await withTravel([
    startJump(ALPHA, 'G', T(1)),
    fsdJump(ALPHA, T(1, 1)),
    startJump(BARNARD, 'M', T(2)),
    fsdJump(BARNARD, T(2, 1), { BoostUsed: 2 }),
    startJump(ALPHA, 'G', T(3)),
    fsdJump(ALPHA, T(3, 1)),
    event('CarrierJump', { ...SOL, Docked: true, StationName: 'X1X-X1X', StationType: 'FleetCarrier', ...systemDetails('Federation', 'High Tech', 'Democracy', 'High Security') }, T(4)),
  ], async (get, fixture) => {
    const map = await get('/map');
    assert.equal(map.total, 4);
    assert.equal(map.isTruncated, false);
    assert.deepEqual(map.commanders, [{ id: fixture.commanderId(), name: 'TESTER' }]);
    const names = map.systems.map((system) => system.name);
    assert.deepEqual(names, ['Alpha Centauri', 'Sol', "Barnard's Star"]);
    const systemNamed = (name) => names.indexOf(name);
    assert.deepEqual(map.jumps.from, [systemNamed('Sol'), systemNamed('Alpha Centauri'), systemNamed("Barnard's Star"), systemNamed('Alpha Centauri')]);
    assert.deepEqual(map.jumps.to, [systemNamed('Alpha Centauri'), systemNamed("Barnard's Star"), systemNamed('Alpha Centauri'), systemNamed('Sol')]);
    assert.deepEqual(map.jumps.kind, [0, 2, 0, 3], 'normal, synthesis, normal, carrier');
    assert.deepEqual(map.jumps.firstVisit, [1, 1, 0, 1]);
    assert.equal(map.jumps.time[0], Date.parse(T(1, 1)) / 1000);
    assert.equal(map.systems[systemNamed('Alpha Centauri')].visits, 2);
    assert.equal(map.systems[systemNamed('Alpha Centauri')].starClass, 'G');

    const carrierOnly = await get('/map?type=carrier');
    assert.equal(carrierOnly.jumps.to.length, 1);
    assert.equal(carrierOnly.systems.length, 2, 'the jump’s start and end');
  });
});
