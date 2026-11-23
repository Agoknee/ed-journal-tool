import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createFixture, event, sessionStart } from './helpers/journal-fixture.mjs';

const T = (minute) => `2026-01-01T00:${String(minute).padStart(2, '0')}:00Z`;

const LOADOUT = event('Loadout', {
  Ship: 'sidewinder', ShipID: 1, ShipName: 'Little One', ShipIdent: 'AB-01', HullValue: 4000, ModulesValue: 6000, HullHealth: 0.9,
  Rebuy: 500, MaxJumpRange: 9.5, CargoCapacity: 4, FuelCapacity: { Main: 2, Reserve: 0.3 }, UnladenMass: 30,
  Modules: [
    { Slot: 'SmallHardpoint1', Item: 'hpt_pulselaser_gimbal_small', On: true, Priority: 0, Health: 1, Value: 6600 },
    { Slot: 'Armour', Item: 'sidewinder_armour_grade3', On: true, Priority: 1, Health: 1 },
    {
      Slot: 'FrameShiftDrive', Item: 'int_hyperdrive_size2_class5', On: true, Priority: 0, Health: 0.95, Value: 160000,
      Engineering: { Engineer: 'Felicity Farseer', EngineerID: 300100, BlueprintName: 'FSD_LongRange', Level: 5, Quality: 1, ExperimentalEffect_Localised: 'Mass Manager', Modifiers: [{ Label: 'FSDOptimalMass', Value: 90, OriginalValue: 50, LessIsGood: 0 }] },
    },
    { Slot: 'PaintJob', Item: 'paintjob_sidewinder_default_01', On: true, Priority: 1, Health: 1 },
  ],
}, T(1));

test('fleet: ships, loadouts, sales, suits, weapons, vehicles and export', async () => {
  const fixture = await createFixture();
  try {
    fixture.writeJournal([
      ...sessionStart(),
      event('ModuleBuy', { Slot: 'FrameShiftDrive', BuyItem: '$int_hyperdrive_size2_class5_name;', BuyItem_Localised: 'Frame Shift Drive', BuyPrice: 1, Ship: 'sidewinder', ShipID: 1 }, T(1)),
      LOADOUT,
      event('Docked', { StationName: 'Home', StationType: 'Coriolis', StarSystem: 'Sol', MarketID: 10 }, T(2)),
      event('StoredShips', {
        StationName: 'Home', MarketID: 10, StarSystem: 'Sol',
        ShipsHere: [{ ShipID: 2, ShipType: 'cobramkiii', ShipType_Localised: 'Cobra Mk III', Name: 'Snake', Value: 300000, Hot: false }],
        ShipsRemote: [
          { ShipID: 3, ShipType: 'python', StarSystem: 'Lave', Value: 50000000, Hot: false },
          { ShipID: 4, ShipType: 'hauler', StarSystem: 'Lave', Value: 50000, InTransit: true, Hot: false },
        ],
      }, T(3)),
      event('ShipyardSell', { ShipType: 'python', SellShipID: 3, ShipPrice: 45000000, MarketID: 10 }, T(4)),
      event('StoredShips', { StationName: 'Home', MarketID: 10, StarSystem: 'Sol', ShipsHere: [{ ShipID: 2, ShipType: 'cobramkiii', Value: 300000, Hot: false }], ShipsRemote: [] }, T(5)),
      event('StoredModules', { MarketID: 10, StationName: 'Home', StarSystem: 'Sol', Items: [
        { Name: '$int_cargorack_size4_class1_name;', Name_Localised: 'Cargo Rack', StorageSlot: 1, StarSystem: 'Sol', MarketID: 10, BuyPrice: 34000, Hot: false, EngineerModifications: 'CargoRack_IncreasedCapacity', Level: 5, Quality: 1 },
        { Name: '$int_shieldgenerator_size3_class5_name;', StorageSlot: 2, InTransit: true, BuyPrice: 500000, Hot: false },
      ] }, T(5)),
      event('BuySuit', { Name: 'UtilitySuit_Class1', Name_Localised: 'Maverick Suit', Price: 150000, SuitID: 77, SuitMods: [] }, T(6)),
      event('BuySuit', { Name: 'TacticalSuit_Class1', Price: 150000, SuitID: 78, SuitMods: [] }, T(6)),
      event('SellSuit', { SuitID: 78, Name: 'tacticalsuit_class1', Price: 90000 }, T(7)),
      event('BuyWeapon', { Name: 'Wpn_M_AssaultRifle_Kinetic_FAuto', Name_Localised: 'Karma AR-50', Class: 1, Price: 50000, SuitModuleID: 501, WeaponMods: ['weapon_range'] }, T(7)),
      event('SuitLoadout', { SuitID: 77, SuitName: 'utilitysuit_class2', SuitMods: ['suit_nightvision'], LoadoutID: 9, LoadoutName: 'Work', Modules: [{ SlotName: 'PrimaryWeapon1', SuitModuleID: 501, ModuleName: 'wpn_m_assaultrifle_kinetic_fauto', ModuleName_Localised: 'Karma AR-50', Class: 2, WeaponMods: ['weapon_range'] }] }, T(8)),
      event('LaunchFighter', { '': 'independent_fighter', _Localised: 'Taipan', Loadout: 'one', ID: 13, PlayerControlled: false }, T(9)),
      event('LaunchSRV', { SRVType: 'testbuggy', SRVType_Localised: 'SRV Scarab', Loadout: 'starter', ID: 10, PlayerControlled: true }, T(10)),
      event('Statistics', { Bank_Account: { Owned_Ship_Count: 2, Suits_Owned: 1, Weapons_Owned: 1, Current_Wealth: 1 } }, T(11)),
      event('Shutdown', {}, T(12)),
    ]);
    await fixture.build();
    const commanderId = fixture.commanderId();
    const fleet = (await fixture.get(`/api/stats/fleet?commander=${commanderId}`)).body;

    const ship = (shipId) => fleet.ships.find((candidate) => candidate.shipId === shipId);
    assert.deepEqual(fleet.ships.filter((candidate) => !candidate.isSold).map((candidate) => candidate.shipId).sort(), [1, 2]);
    assert.ok(ship(3).isSold, 'the sold ship is marked');
    assert.ok(ship(4).isSold, 'a ship missing from StoredShips is gone');
    assert.equal(ship(1).isCurrent, true);
    assert.equal(ship(1).name, 'Little One');
    assert.equal(ship(2).shipTypeName, 'Cobra Mk III');
    assert.equal(ship(2).location.starSystem, 'Sol');

    assert.equal(ship(1).modules, undefined, 'the ship list leaves loadouts out');
    assert.equal(ship(1).hasLoadout, true);
    assert.equal(ship(2).hasLoadout, false);
    const loadout = (await fixture.get(`/api/stats/fleet/ship?commander=${commanderId}&ship=1`)).body;
    assert.equal(loadout.shipId, 1);
    assert.equal((await fixture.get(`/api/stats/fleet/ship?commander=${commanderId}&ship=99`)).status, 404);
    assert.equal((await fixture.get(`/api/stats/fleet/ship?commander=${commanderId}&ship=2`)).body.modules, null, 'an unflown ship has no loadout');
    const modules = Object.fromEntries(loadout.modules.map((module) => [module.slotKey, module]));
    assert.equal(modules.PaintJob, undefined, 'cosmetic slots are left out');
    assert.equal(modules.Armour.name, 'Military Grade Composite');
    assert.equal(modules.SmallHardpoint1.mount, 'Gimballed');
    assert.equal(modules.SmallHardpoint1.hardpointSize, 1);
    assert.equal(modules.FrameShiftDrive.name, 'Frame Shift Drive');
    assert.equal(modules.FrameShiftDrive.rating, '2A');
    assert.equal(modules.FrameShiftDrive.engineering.blueprintName, 'Long Range');
    assert.equal(modules.FrameShiftDrive.engineering.modifiers[0].name, 'FSD optimal mass');
    assert.equal(ship(1).engineeredCount, 1);

    assert.deepEqual(fleet.suits.filter((suit) => !suit.isSold).map((suit) => [suit.name, suit.class]), [['Maverick Suit', 2]]);
    assert.deepEqual(fleet.weapons.map((weapon) => [weapon.name, weapon.class, weapon.mods]), [['Karma AR-50', 2, ['Greater Range']]]);
    assert.equal(fleet.suitLoadouts[0].weapons[0].weapon.name, 'Karma AR-50');
    assert.deepEqual(fleet.vehicles.map((vehicle) => `${vehicle.kind}:${vehicle.name}`).sort(), ['fighter:Taipan', 'srv:SRV Scarab']);
    assert.equal(fleet.ownedCounts.ships, 2);

    // The export links carry the Loadout event exactly as logged (sorted keys, gzipped, base64url).
    const exported = (await fixture.get(`/api/stats/fleet/export?commander=${commanderId}&ship=1`)).body;
    assert.ok(exported.edsyUrl.startsWith('https://edsy.org/#/I='));
    assert.ok(exported.coriolisUrl.startsWith('https://coriolis.io/import?data='));
    const encoded = exported.edsyUrl.split('#/I=')[1].replace(/%3D/g, '=');
    const decoded = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64url')).toString());
    assert.deepEqual(decoded, LOADOUT);
    assert.deepEqual(exported.slef[0].data, LOADOUT);
    assert.equal(exported.slef[0].header.appName, 'ED Journal Tool');
    assert.equal((await fixture.get(`/api/stats/fleet/export?commander=${commanderId}&ship=2`)).status, 404, 'no loadout for an unflown ship');

    assert.equal(fleet.storedModules.updatedAt, T(5));
    assert.deepEqual(fleet.storedModules.items.map((item) => [item.name, item.rating, item.engineering?.blueprintName ?? null, item.inTransit]),
      [['Cargo Rack', '4E', 'Increased Capacity', false], ['Shieldgenerator', '3A', null, true]]);

    // The current ship's value is its loadout's (flown after it was last listed at a shipyard).
    assert.equal(ship(1).value, 10000);
    assert.equal(ship(2).value, 300000);

    // The commander overview agrees with the fleet.
    const { commanders, combined } = (await fixture.get(`/api/stats/commanders?commander=${commanderId}`)).body;
    assert.deepEqual(
      { shipCount: commanders[0].summary.shipCount, fleetValue: commanders[0].summary.fleetValue, storedModuleCount: commanders[0].summary.storedModuleCount },
      { shipCount: 2, fleetValue: 310000, storedModuleCount: 2 },
    );
    assert.deepEqual(commanders[0].summary.currentShip, { shipId: 1, shipTypeName: 'Sidewinder', name: 'Little One', ident: 'AB-01', cargoCapacity: 4 });
    assert.equal(combined.shipCount, 2);
  } finally {
    await fixture.close();
  }
});
