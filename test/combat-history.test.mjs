import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture, event, sessionStart } from './helpers/journal-fixture.mjs';

const T = (hour, minute = 0, second = 0) => `2026-01-01T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`;
const RES_DROP = { Type: '$MULTIPLAYER_SCENARIO79_TITLE;', Type_Localised: 'Resource Extraction Site [High]' };
const bounty = (at, { reward = 100_000, faction = 'Earls of Anana', target = 'empire_eagle', pilot = 'Vigus' } = {}) => event('Bounty', {
  Rewards: [{ Faction: faction, Reward: reward }], PilotName: `$npc_name_decorate:#name=${pilot};`, PilotName_Localised: pilot,
  Target: target, TotalReward: reward, VictimFaction: 'Anana Brotherhood',
}, at);

async function withCombatHistory(events, check) {
  const fixture = await createFixture();
  try {
    fixture.writeJournal([...sessionStart({ ship: 'anaconda' }), event('Loadout', { Ship: 'anaconda', ShipName: 'Big Stick', ShipID: 1, Modules: [] }, T(0)), ...events]);
    await fixture.build();
    const get = async (path) => (await fixture.get(`/api/stats/combat-history${path}${path.includes('?') ? '&' : '?'}commander=${fixture.commanderId()}`)).body;
    await check(get, fixture);
  } finally {
    await fixture.close();
  }
}

test('combat history: sessions with their kills, ship, place, rate and how they ended', async () => {
  await withCombatHistory([
    event('Location', { StarSystem: 'Anana' }, T(0, 1)),
    event('SupercruiseDestinationDrop', RES_DROP, T(1)),
    event('ShipTargeted', { TargetLocked: true, ScanStage: 3, PilotName_Localised: 'Vigus', PilotRank: 'Deadly', Ship: 'empire_eagle' }, T(1, 5)),
    bounty(T(1, 10)),
    bounty(T(1, 20), { pilot: 'Unscanned', target: 'thargon' }),
    event('ShieldState', { ShieldsUp: false }, T(1, 25)),
    event('HullDamage', { Health: 0.6, PlayerPilot: true, Fighter: false }, T(1, 26)),
    event('HullDamage', { Health: 0.2, PlayerPilot: false, Fighter: true }, T(1, 27)),
    event('StartJump', { JumpType: 'Supercruise' }, T(1, 59, 50)),
    event('FighterDestroyed', { ID: 1 }, T(1, 59, 55)),
    event('SupercruiseEntry', { StarSystem: 'Anana' }, T(2)),
    // A drop with no kills isn't a session worth keeping.
    event('SupercruiseDestinationDrop', RES_DROP, T(2, 10)),
    event('SupercruiseEntry', { StarSystem: 'Anana' }, T(2, 20)),
    // A kill outside a session starts one, backdated a minute; the game then closes without a Shutdown.
    bounty(T(3)),
    bounty(T(3, 30)),
    ...sessionStart({ ship: 'anaconda', at: T(9) }),
  ], async (get) => {
    const { rows, total } = await get('/sessions?sort=started_at&order=asc');
    assert.equal(total, 2);
    const [res, crashed] = rows;
    assert.equal(res.location, 'Resource Extraction Site [High]');
    assert.equal(res.star_system, 'Anana');
    assert.equal(res.ship_name, 'Big Stick');
    assert.equal(res.ship_type_name, 'Anaconda');
    assert.equal(res.kills, 2);
    assert.equal(res.duration_s, 3600);
    assert.equal(res.kills_per_hour, 2);
    assert.equal(res.credits, 200_000);
    assert.equal(res.shields_down, 1);
    assert.equal(res.lowest_hull, 0.6, 'only the ship’s own hull, not the fighter’s');
    assert.equal(res.fighters_lost, 0, 'a fighter lost to the jump isn’t shot down');
    assert.equal(res.end_reason, 'supercruise');
    assert.equal(crashed.started_at, T(2, 59));
    assert.equal(crashed.ended_at, T(3, 30), 'a session cut short by the game closing ends at its last kill, not the next login');
    assert.equal(crashed.end_reason, 'crash');

    // Filtering sessions by system and ship, with the choices to filter by.
    assert.equal((await get('/sessions?system=Anana&ship=anaconda')).total, 2);
    assert.equal((await get('/sessions?system=Sol')).total, 0);
    const choices = await get('/filters');
    assert.deepEqual(choices.sessions.systems, [{ value: 'Anana', count: 2, label: 'Anana' }]);
    assert.deepEqual(choices.sessions.ships, [{ value: 'anaconda', count: 2, label: 'Anaconda' }]);

    const victims = await get('/victims');
    assert.deepEqual(victims.byShip.map((row) => [row.name, row.kills]), [['Imperial Eagle', 3], ['Thargon', 1]]);
    assert.equal(victims.byRank.find((row) => row.rank === 'Deadly').kills, 3, 'the scanned pilot’s rank, for each of their kills');
    assert.equal(victims.byRank.find((row) => row.rank === null).kills, 1);

    const summary = await get('/summary');
    assert.equal(summary.kills.kills, 4);
    assert.equal(summary.sessions.sessions, 2);
  });
});

test('combat history: dying forfeits unclaimed bounties and bonds, but not Thargoid bonds', async () => {
  await withCombatHistory([
    event('SupercruiseDestinationDrop', RES_DROP, T(1)),
    bounty(T(1, 1), { reward: 1_000, faction: 'Earls of Anana' }),
    bounty(T(1, 2), { reward: 2_000, faction: 'Other Faction' }),
    event('SupercruiseEntry', {}, T(1, 3)),
    // Hand-ins pay a bonus on top; what was paid doesn't matter, only which factions were claimed.
    event('RedeemVoucher', { Type: 'bounty', Amount: 1_400, Factions: [{ Faction: 'Earls of Anana', Amount: 1_400 }] }, T(1, 4)),
    event('FactionKillBond', { Reward: 60_000_000, AwardingFaction: '$faction_PilotsFederation;', AwardingFaction_Localised: 'Pilots\' Federation', VictimFaction: '$faction_Thargoid;', VictimFaction_Localised: 'Thargoids' }, T(1, 5)),
    event('FactionKillBond', { Reward: 5_000, AwardingFaction: 'Kumo Council', VictimFaction: 'Youbee Dominion' }, T(1, 6)),
    event('Died', { KillerName: 'Cmdr Frank', KillerShip: 'corsair', KillerRank: 'Elite' }, T(1, 7)),
    // After death: nothing is owed, so an empty-faction hand-in later clears new vouchers only.
    event('Resurrect', { Option: 'rebuy', Cost: 100, Bankrupt: false }, T(1, 8)),
    bounty(T(1, 10), { reward: 7_000 }),
    event('RedeemVoucher', { Type: 'bounty', Amount: 9_800, Factions: [{ Faction: '', Amount: 9_800 }] }, T(1, 11)),
    bounty(T(1, 12), { reward: 500 }),
    event('SelfDestruct', {}, T(1, 13)),
    event('Died', {}, T(1, 13, 20)),
  ], async (get) => {
    const { rows } = await get('/deaths?sort=timestamp&order=asc');
    assert.equal(rows.length, 2);
    const [byPlayer, selfDestruct] = rows;
    assert.equal(byPlayer.cause, 'player');
    assert.equal(byPlayer.killer_name, 'Frank');
    assert.equal(byPlayer.killer_ship_name, 'Corsair');
    assert.equal(byPlayer.vouchers_lost, 2_000 + 5_000, 'the unclaimed faction’s bounty and the ordinary bond, not the Thargoid bond');
    assert.equal(byPlayer.ship_name, 'Big Stick');
    assert.equal(selfDestruct.cause, 'self_destruct');
    assert.equal(selfDestruct.vouchers_lost, 500);
    const summary = await get('/summary');
    assert.equal(summary.deaths.vouchersLost, 7_500);
    assert.deepEqual(summary.deaths.byCause.map((cause) => cause.cause).sort(), ['player', 'self_destruct']);
  });
});

test('combat history: death causes, interdictions, the timeline and heatmap', async () => {
  await withCombatHistory([
    event('Died', { KillerName: 'Rackham\'s Peak', KillerShip: 'outpostcivilian' }, T(1)),
    event('Died', { KillerShip: 'thargon' }, T(2)),
    event('Died', { Killers: [{ Name: 'Pirate One', Ship: 'viper', Rank: 'Expert' }, { Name: 'Pirate Two', Ship: 'eagle', Rank: 'Novice' }] }, T(3)),
    event('Died', { KillerName: 'Megan Hays', KillerShip: 'heavysuitai_class3', KillerRank: 'Dangerous' }, T(4)),
    event('HeatDamage', {}, T(4, 59, 50)),
    event('Died', {}, T(5)),
    event('Interdicted', { Submitted: true, Interdictor: 'Pirate', IsPlayer: false }, T(6)),
    event('Interdicted', { Submitted: false, Interdictor: 'Frank', IsPlayer: true, CombatRank: 9 }, T(6, 10)),
    event('EscapeInterdiction', { Interdictor: 'Pirate', IsPlayer: false }, T(6, 20)),
    bounty(T(23, 30)),
  ], async (get) => {
    const { rows } = await get('/deaths?sort=timestamp&order=asc');
    assert.deepEqual(rows.map((death) => [death.cause, death.killer_ship_name]), [
      ['structure', 'Outpost defences'],
      ['thargoid', 'Thargon'],
      ['npc', 'Viper Mk III'],
      ['on_foot', 'NPC soldier'],
      ['heat', null],
    ]);
    assert.equal(rows[2].killer_count, 2);

    // Filtering by cause and killer, and sorting by killer (deaths with no killer last either way).
    assert.deepEqual((await get('/deaths?cause=npc')).rows.map((death) => death.killer_name), ['Pirate One']);
    assert.deepEqual((await get('/deaths?killer=Megan%20Hays')).rows.map((death) => death.cause), ['on_foot']);
    const killerNames = async (order) => (await get(`/deaths?sort=killer&order=${order}`)).rows.map((death) => death.killer_name);
    assert.deepEqual(await killerNames('asc'), ['Megan Hays', 'Pirate One', 'Rackham\'s Peak', null, null]);
    assert.deepEqual(await killerNames('desc'), ['Rackham\'s Peak', 'Pirate One', 'Megan Hays', null, null]);
    const choices = await get('/filters');
    assert.deepEqual(choices.deaths.killers.map((choice) => [choice.value, choice.count]), [['Megan Hays', 1], ['Pirate One', 1], ['Rackham\'s Peak', 1]]);
    assert.equal(choices.deaths.causes.length, 5);

    const summary = await get('/summary');
    const interdictions = Object.fromEntries(summary.interdictions.map((row) => [`${row.outcome}${row.isPlayer ? ' (player)' : ''}`, row.count]));
    assert.deepEqual(interdictions, { submitted: 1, 'pulled_out (player)': 1, escaped: 1 });

    // In UTC+1 the 23:30 kill falls on Friday 2 January at 00:30.
    const { cells } = await get('/heatmap?utcOffset=60');
    assert.deepEqual(cells, [{ weekday: 5, hour: 0, kills: 1 }]);
    const timeline = await get('/timeline?utcOffset=60');
    assert.equal(timeline.bucket, 'day');
    assert.deepEqual(timeline.periods.map((period) => [period.period, period.bountyKills]), [['2026-01-02', 1]]);
  });
});
