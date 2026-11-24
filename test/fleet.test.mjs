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
    // Bought pre-engineered: the game logs EngineerID 399999 and no engineer.
    {
      Slot: 'Slot01_Size4', Item: 'int_cargorack_size4_class1', On: true, Priority: 1, Health: 1,
      Engineering: { EngineerID: 399999, BlueprintID: 129036395, BlueprintName: 'CargoRack_IncreasedCapacity', Level: 5, Quality: 1, Modifiers: [] },
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
    assert.equal(modules.FrameShiftDrive.engineering.isPreEngineered, false);
    assert.equal(modules.Slot01_Size4.engineering.isPreEngineered, true);
    assert.equal(modules.Slot01_Size4.engineering.engineer, null);
    assert.equal(ship(1).engineeredCount, 2);

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
    assert.deepEqual(commanders[0].summary.currentShip, { shipId: 1, shipTypeName: 'Sidewinder', name: 'Little One', ident: 'AB-01', cargoCapacity: 4, loadoutAt: T(1) });
    assert.equal(combined.shipCount, 2);
  } finally {
    await fixture.close();
  }
});

test('fleet: when each ship was last flown', async () => {
  const fixture = await createFixture();
  try {
    fixture.writeJournal([
      ...sessionStart({ shipId: 1 }),
      event('Docked', { StationName: 'Home', StationType: 'Coriolis', StarSystem: 'Sol', MarketID: 10 }, T(5)),
      // Swapping to ship 2 leaves ship 1 flown until the swap.
      event('ShipyardSwap', { ShipType: 'cobramkiii', ShipID: 2, StoreOldShip: 'sidewinder', StoreShipID: 1, MarketID: 10 }, T(10)),
      event('StoredShips', {
        StationName: 'Home', MarketID: 10, StarSystem: 'Sol',
        ShipsHere: [{ ShipID: 1, ShipType: 'sidewinder', Value: 1000, Hot: false }],
        ShipsRemote: [{ ShipID: 3, ShipType: 'python', StarSystem: 'Lave', Value: 50000000, Hot: false }],
      }, T(11)),
      // The ship being flown counts as used up to the commander's latest entry.
      event('Music', { MusicTrack: 'Exploration' }, T(40)),
    ]);
    await fixture.build();
    const fleet = (await fixture.get(`/api/stats/fleet?commander=${fixture.commanderId()}`)).body;
    const lastFlown = Object.fromEntries(fleet.ships.map((ship) => [ship.shipId, ship.lastFlownAt]));
    assert.deepEqual(lastFlown, { 1: T(10), 2: T(40), 3: null }, 'a ship never flown since the journals began has no time');
  } finally {
    await fixture.close();
  }
});

test('fleet: pre-engineered modules stay marked in storage, and the counts say how many there are', async () => {
  const fixture = await createFixture();
  try {
    const storedListing = (items, minute) => event('StoredModules', {
      MarketID: 10, StationName: 'Home', StarSystem: 'Sol',
      Items: items.map(([name, blueprint], index) => ({
        Name: `$${name}_name;`, StorageSlot: index + 1, StarSystem: 'Sol', MarketID: 10, TransferCost: 0, TransferTime: 0, BuyPrice: 1000, Hot: false,
        EngineerModifications: blueprint, Level: 5, Quality: 1,
      })),
    }, T(minute));
    fixture.writeJournal([
      ...sessionStart(),
      LOADOUT,
      // The pre-engineered cargo rack and the engineer-made FSD both go into storage.
      event('ModuleStore', { MarketID: 10, Slot: 'Slot01_Size4', StoredItem: '$int_cargorack_size4_class1_name;', Ship: 'sidewinder', ShipID: 1, Hot: false, EngineerModifications: 'CargoRack_IncreasedCapacity', Level: 5, Quality: 1 }, T(2)),
      event('ModuleStore', { MarketID: 10, Slot: 'FrameShiftDrive', StoredItem: '$int_hyperdrive_size2_class5_name;', Ship: 'sidewinder', ShipID: 1, Hot: false, EngineerModifications: 'FSD_LongRange', Level: 5, Quality: 1 }, T(3)),
      // A second rack with the same blueprint, never seen on a ship (bought straight into storage, say): unknown, so not marked.
      storedListing([['int_cargorack_size4_class1', 'CargoRack_IncreasedCapacity'], ['int_hyperdrive_size2_class5', 'FSD_LongRange'], ['int_cargorack_size4_class1', 'CargoRack_IncreasedCapacity']], 4),
    ]);
    await fixture.build();
    const commanderId = fixture.commanderId();
    const fleet = (await fixture.get(`/api/stats/fleet?commander=${commanderId}`)).body;
    assert.deepEqual(fleet.storedModules.items.map((item) => item.engineering.isPreEngineered), [true, false, false]);
    const ship = fleet.ships.find((candidate) => candidate.shipId === 1);
    assert.equal(ship.engineeredCount, 2);
    assert.equal(ship.preEngineeredCount, 1);
    const engineers = (await fixture.get(`/api/stats/engineers?commander=${commanderId}`)).body;
    assert.equal(engineers.preEngineeredModuleCount, 1);
  } finally {
    await fixture.close();
  }
});

test('fleet: a pre-engineered module taken back out of storage is no longer marked there', async () => {
  const fixture = await createFixture();
  try {
    const rackListing = (count, minute) => event('StoredModules', {
      MarketID: 10, StationName: 'Home', StarSystem: 'Sol',
      Items: Array.from({ length: count }, (unused, index) => ({
        Name: '$int_cargorack_size4_class1_name;', StorageSlot: index + 1, StarSystem: 'Sol', MarketID: 10, BuyPrice: 1000, Hot: false,
        EngineerModifications: 'CargoRack_IncreasedCapacity', Level: 5, Quality: 1,
      })),
    }, T(minute));
    fixture.writeJournal([
      ...sessionStart(),
      LOADOUT,
      event('ModuleStore', { MarketID: 10, Slot: 'Slot01_Size4', StoredItem: '$int_cargorack_size4_class1_name;', Ship: 'sidewinder', ShipID: 1, Hot: false, EngineerModifications: 'CargoRack_IncreasedCapacity', Level: 5, Quality: 1 }, T(2)),
      rackListing(1, 3),
      event('ModuleRetrieve', { MarketID: 10, Slot: 'Slot01_Size4', RetrievedItem: '$int_cargorack_size4_class1_name;', Ship: 'sidewinder', ShipID: 1, Hot: false, EngineerModifications: 'CargoRack_IncreasedCapacity', Level: 5, Quality: 1 }, T(4)),
      // Another rack with the same blueprint turns up in storage: it isn't the one taken out.
      rackListing(1, 5),
    ]);
    await fixture.build();
    const fleet = (await fixture.get(`/api/stats/fleet?commander=${fixture.commanderId()}`)).body;
    assert.deepEqual(fleet.storedModules.items.map((item) => item.engineering.isPreEngineered), [false]);
  } finally {
    await fixture.close();
  }
});

test('fleet: logging in on foot, in an SRV or on a transport doesn\'t add a ship or change the current one', async () => {
  const fixture = await createFixture();
  try {
    const login = (ship, shipId, localised, minute) => event('LoadGame', { FID: 'F1', Commander: 'TESTER', Ship: ship, Ship_Localised: localised, ShipID: shipId, Credits: 1000, GameMode: 'Solo' }, T(minute));
    fixture.writeJournal([
      ...sessionStart(),
      LOADOUT,
      login('TestBuggy', 4, 'SRV Scarab', 2),
      login('UtilitySuit_Class1', 4293000001, 'Maverick Suit', 3),
      login('FlightSuit', 4293000000, 'Flight Suit', 4),
      login('Lander01', 36, 'Nomad', 5),
      // A shipyard listing later: the vehicles aren't in it, which mustn't make them "sold or lost" ships.
      event('Docked', { StationName: 'Home', StationType: 'Coriolis', StarSystem: 'Sol', MarketID: 10 }, T(6)),
      event('StoredShips', { StationName: 'Home', MarketID: 10, StarSystem: 'Sol', ShipsHere: [], ShipsRemote: [] }, T(7)),
    ]);
    await fixture.build();
    const fleet = (await fixture.get(`/api/stats/fleet?commander=${fixture.commanderId()}`)).body;
    assert.deepEqual(fleet.ships.map((ship) => [ship.shipId, ship.shipTypeName, ship.isCurrent, ship.isSold]), [[1, 'Sidewinder', true, false]]);
  } finally {
    await fixture.close();
  }
});

test('fleet: a sold ship stays listed when the game gives its ID to the next ship bought', async () => {
  const fixture = await createFixture();
  try {
    fixture.writeJournal([
      ...sessionStart(),
      LOADOUT,
      event('Docked', { StationName: 'Home', StationType: 'Coriolis', StarSystem: 'Sol', MarketID: 10 }, T(2)),
      event('ShipyardBuy', { ShipType: 'anaconda', ShipPrice: 1000, StoreOldShip: 'sidewinder', StoreShipID: 1, MarketID: 10 }, T(3)),
      event('ShipyardNew', { ShipType: 'anaconda', NewShipID: 2 }, T(3)),
      event('ShipyardSell', { ShipType: 'anaconda', SellShipID: 2, ShipPrice: 900, MarketID: 10 }, T(4)),
      event('ShipyardSwap', { ShipType: 'sidewinder', ShipID: 1, StoreOldShip: 'anaconda', StoreShipID: 2, MarketID: 10 }, T(4)),
      // The next ship bought gets ID 2 again.
      event('ShipyardBuy', { ShipType: 'python', ShipPrice: 1000, StoreOldShip: 'sidewinder', StoreShipID: 1, MarketID: 10 }, T(5)),
      event('ShipyardNew', { ShipType: 'python', NewShipID: 2 }, T(5)),
      event('Loadout', { Ship: 'python', ShipID: 2, ShipName: 'New Snake', Modules: [] }, T(6)),
    ]);
    await fixture.build();
    const fleet = (await fixture.get(`/api/stats/fleet?commander=${fixture.commanderId()}`)).body;
    const ships = fleet.ships.map((ship) => [ship.shipId, ship.shipTypeName, ship.isCurrent, ship.isSold]);
    assert.deepEqual(ships, [[2, 'Python', true, false], [1, 'Sidewinder', false, false], [-1, 'Anaconda', false, true]]);
    assert.equal(fleet.ships.find((ship) => ship.shipId === -1).soldAt, T(4), 'sold when it was sold, not when its ID was reused');
  } finally {
    await fixture.close();
  }
});
