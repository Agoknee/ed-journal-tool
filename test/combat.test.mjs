import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture, event, sessionStart } from './helpers/journal-fixture.mjs';

const T = (minute, second = 0) => `2026-01-01T00:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`;

const FIGHTER_SHIP = event('Loadout', {
  Ship: 'anaconda', ShipID: 1, HullHealth: 1, FuelCapacity: { Main: 32, Reserve: 1 },
  Modules: [{ Slot: 'Slot01_Size6', Item: 'int_fighterbay_size6_class1', On: true, Priority: 0, Health: 1 }],
}, T(1));

async function combatFor(events) {
  const fixture = await createFixture();
  try {
    fixture.writeJournal([...sessionStart({ ship: 'anaconda' }), FIGHTER_SHIP, ...events]);
    await fixture.build();
    return (await fixture.get(`/api/stats/combat/status?commander=${fixture.commanderId()}`)).body.commanders[0];
  } finally {
    await fixture.close();
  }
}

test('combat: a session in a RES with kills, scans, fuel, fighter, shields and hull', async () => {
  const combat = await combatFor([
    event('Location', { StarSystem: 'Anana' }, T(2)),
    event('SupercruiseDestinationDrop', { Type: '$MULTIPLAYER_SCENARIO79_TITLE;', Type_Localised: 'Resource Extraction Site [High]' }, T(3)),
    event('LaunchFighter', { Loadout: 'one', ID: 1, PlayerControlled: false }, T(4)),
    event('Bounty', { VictimFaction: 'Pirates', TotalReward: 1000 }, T(10)),
    event('Bounty', { VictimFaction: 'Pirates', TotalReward: 1000 }, T(20)),
    event('ReceiveText', { From: 'Pirate', Message: '$Pirate_OnStartScanCargo07;', Channel: 'npc' }, T(21)),
    event('ReceiveText', { From: 'Pirate', Message: '$Pirate_OnStartScanCargo07;', Channel: 'npc' }, T(22)),
    event('ReservoirReplenished', { FuelMain: 30, FuelReservoir: 1 }, T(10)),
    event('ReservoirReplenished', { FuelMain: 29, FuelReservoir: 1 }, T(40)),
    event('ShieldState', { ShieldsUp: false }, T(41)),
    event('HullDamage', { Health: 0.6, PlayerPilot: true, Fighter: false }, T(42)),
    event('HullDamage', { Health: 0.5, PlayerPilot: false, Fighter: true }, T(43)),
    event('HullDamage', { Health: 0.4, PlayerPilot: true, Fighter: true }, T(44)),
    event('Shutdown', {}, T(45)),
  ]);
  assert.equal(combat.session.location, 'Resource Extraction Site [High]');
  assert.equal(combat.session.system, 'Anana');
  assert.equal(combat.session.isActive, false, 'not under way: the journal isn’t active');
  assert.equal(combat.kills.total, 2);
  assert.deepEqual(combat.kills.byFaction.map((faction) => [faction.faction, faction.count]), [['Pirates', 2]]);
  assert.equal(combat.scans.total, 1, 'repeat scans by the same pirate count once');
  assert.equal(combat.fuel.main, 29);
  assert.equal(combat.fuel.capacity, 32);
  assert.ok(Math.abs(combat.fuel.perHour - 2) < 1e-9, '1 t over 30 minutes');
  assert.equal(combat.fighter.hasBay, true);
  assert.equal(combat.fighter.state, 'deployed', 'logging out leaves the fighter out');
  assert.equal(combat.shields.isUp, false);
  assert.equal(combat.hull.health, 0.6);
  assert.equal(combat.fighterHull.health, 0.5, 'damage while flying the fighter yourself is ignored');
});

test('combat: a fighter lost to a jump isn’t "destroyed"; a real loss is', async () => {
  const launched = [
    event('SupercruiseDestinationDrop', { Type: '$MULTIPLAYER_SCENARIO79_TITLE;' }, T(3)),
    event('LaunchFighter', { Loadout: 'one', ID: 1, PlayerControlled: false }, T(4)),
  ];
  const jumped = await combatFor([...launched, event('StartJump', { JumpType: 'Supercruise' }, T(10)), event('FighterDestroyed', { ID: 1 }, T(10, 1)), event('Shutdown', {}, T(11))]);
  assert.equal(jumped.fighter.state, 'none');
  const shot = await combatFor([...launched, event('FighterDestroyed', { ID: 1 }, T(10)), event('Shutdown', {}, T(11))]);
  assert.equal(shot.fighter.state, 'destroyed');
  const playerLaunch = await combatFor([...launched.slice(0, 1), event('LaunchFighter', { Loadout: 'one', ID: 1, PlayerControlled: true }, T(4)), event('Shutdown', {}, T(5))]);
  assert.equal(playerLaunch.fighter.state, 'none', 'a fighter the commander flies isn’t the AFK fighter');
});

test('combat: shields reset to unknown when a new session starts', async () => {
  const combat = await combatFor([
    event('SupercruiseDestinationDrop', { Type: '$MULTIPLAYER_SCENARIO79_TITLE;' }, T(3)),
    event('ShieldState', { ShieldsUp: false }, T(4)),
    event('SupercruiseEntry', { StarSystem: 'Anana' }, T(5)),
    event('SupercruiseDestinationDrop', { Type: '$Warzone_PointRace_Low;' }, T(6)),
    event('Shutdown', {}, T(7)),
  ]);
  assert.equal(combat.shields.isUp, null);
});
