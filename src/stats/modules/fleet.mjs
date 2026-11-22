import { gzipSync } from 'node:zlib';
import { Router } from 'express';
import { appVersion } from '../../cli.mjs';
import { defineStatModule } from '../define-stat-module.mjs';
import { DOCKING_EVENTS, getDockedLocation, trackDockingState } from '../docking-state.mjs';
import { getCommanderIdFilter } from '../query-helpers.mjs';

/**
 * Each commander's ships, on-foot suits and weapons, suit loadouts and the SRVs and fighters
 * they've used.
 *
 * - A ship's full loadout (modules, engineering, values) is the last Loadout logged while flying
 *   it, so ships not flown since the journals began only have what StoredShips says (type, name,
 *   value and where it is).
 * - StoredShips (at a shipyard) lists every ship but the one being flown, so a ship missing from it
 *   has been sold or lost.
 * - There's no full list of suits and weapons in the journal: they're built from purchases, sales,
 *   upgrades and suit loadouts. Statistics gives how many of each are owned, to compare.
 * - Module and ship names come from the localised names the game logs (when modules are bought,
 *   stored and so on), falling back to the internal names tidied up.
 * - Each ship's last Loadout event is also kept as logged, for exporting to EDSY, Coriolis and SLEF.
 */
const SHIP_NAMES = {
  sidewinder: 'Sidewinder', eagle: 'Eagle', hauler: 'Hauler', adder: 'Adder', empire_eagle: 'Imperial Eagle',
  viper: 'Viper Mk III', cobramkiii: 'Cobra Mk III', viper_mkiv: 'Viper Mk IV', diamondback: 'Diamondback Scout',
  cobramkiv: 'Cobra Mk IV', cobramkv: 'Cobra Mk V', type6: 'Type-6 Transporter', dolphin: 'Dolphin',
  diamondbackxl: 'Diamondback Explorer', empire_courier: 'Imperial Courier', independant_trader: 'Keelback',
  asp_scout: 'Asp Scout', vulture: 'Vulture', asp: 'Asp Explorer', federation_dropship: 'Federal Dropship',
  type7: 'Type-7 Transporter', typex: 'Alliance Chieftain', federation_dropship_mkii: 'Federal Assault Ship',
  empire_trader: 'Imperial Clipper', typex_2: 'Alliance Crusader', typex_3: 'Alliance Challenger',
  federation_gunship: 'Federal Gunship', krait_light: 'Krait Phantom', krait_mkii: 'Krait Mk II', orca: 'Orca',
  ferdelance: 'Fer-de-Lance', mamba: 'Mamba', python: 'Python', python_nx: 'Python Mk II', type8: 'Type-8 Transporter',
  type9: 'Type-9 Heavy', belugaliner: 'Beluga Liner', type9_military: 'Type-10 Defender', anaconda: 'Anaconda',
  federation_corvette: 'Federal Corvette', cutter: 'Imperial Cutter', mandalay: 'Mandalay', panthermkii: 'Panther Clipper Mk II',
  corsair: 'Corsair', explorer_nx: 'Caspian Explorer', lakonminer: 'Type-11 Prospector',
};
const SUIT_NAMES = { flightsuit: 'Flight Suit', utilitysuit: 'Maverick Suit', explorationsuit: 'Artemis Suit', tacticalsuit: 'Dominator Suit' };
const CLASS_LETTERS = ['', 'E', 'D', 'C', 'B', 'A'];
const ARMOUR_NAMES = { grade1: 'Lightweight Alloy', grade2: 'Reinforced Alloy', grade3: 'Military Grade Composite', mirrored: 'Mirrored Surface Composite', reactive: 'Reactive Surface Composite' };
const HARDPOINT_SIZES = { small: 'Small', medium: 'Medium', large: 'Large', huge: 'Huge' };
const HARDPOINT_MOUNTS = { fixed: 'Fixed', gimbal: 'Gimballed', turret: 'Turreted' };
// Names for items the game doesn't always log a localised name for.
const ITEM_NAMES = {
  int_fighterbay: 'Fighter Hangar', int_fighterbaymk2: 'Fighter Hangar', int_buggybay: 'Planetary Vehicle Hangar',
  int_planetapproachsuite: 'Planetary Approach Suite', int_planetapproachsuite_advanced: 'Advanced Planetary Approach Suite',
};
const VEHICLE_NAMES = {
  independent_fighter: 'Taipan', federation_fighter: 'F63 Condor', empire_fighter: 'GU-97',
  gdn_hybrid_fighter_v1: 'Trident', gdn_hybrid_fighter_v2: 'Javelin', gdn_hybrid_fighter_v3: 'Lance',
  testbuggy: 'SRV Scarab', combat_multicrew_srv_01: 'SRV Scorpion',
};
// Cosmetic slots, left out of loadouts.
const COSMETIC_SLOT_PATTERN = /^(PaintJob|Decal\d|ShipName\d|ShipID\d|Bobble\d+|VesselVoice|WeaponColour|EngineColour|ShipKit|StringLights|ShipCockpit|CargoHatch$)/i;

export default defineStatModule({
  name: 'fleet',
  title: 'Fleet',
  description: 'Ships with their loadouts, suits, weapons, suit loadouts and vehicles.',
  version: 3,
  events: [
    'LoadGame', 'Loadout', 'StoredShips', 'ShipyardSwap', 'ShipyardNew', 'ShipyardBuy', 'ShipyardSell', 'ShipyardTransfer',
    'SellShipOnRebuy', 'SetUserShipName', 'ModuleBuy', 'ModuleSell', 'ModuleSellRemote', 'ModuleStore', 'ModuleRetrieve',
    'ModuleBuyAndStore', 'StoredModules', 'FetchRemoteModule', 'BuySuit', 'SellSuit', 'UpgradeSuit', 'BuyWeapon', 'SellWeapon',
    'UpgradeWeapon', 'SuitLoadout', 'CreateSuitLoadout', 'DeleteSuitLoadout', 'RenameSuitLoadout', 'LaunchSRV', 'LaunchFighter',
    'RestockVehicle', 'Statistics', ...DOCKING_EVENTS,
  ],
  ownedObjects: [
    { type: 'table', name: 'fleet_ships' },
    { type: 'table', name: 'fleet_current_ship' },
    { type: 'table', name: 'fleet_item_names' },
    { type: 'table', name: 'fleet_suits' },
    { type: 'table', name: 'fleet_weapons' },
    { type: 'table', name: 'fleet_suit_loadouts' },
    { type: 'table', name: 'fleet_vehicles' },
    { type: 'table', name: 'fleet_owned_counts' },
  ],
  schemaSql: `
    CREATE TABLE IF NOT EXISTS fleet_ships (
      commander_id    INTEGER NOT NULL REFERENCES commanders(id),
      ship_id         INTEGER NOT NULL,
      ship_type       TEXT,
      ship_name       TEXT,
      ship_ident      TEXT,
      hull_value      INTEGER,
      modules_value   INTEGER,
      stored_value    INTEGER,       -- the value StoredShips gives (hull and modules)
      rebuy           INTEGER,
      hull_health     REAL,
      max_jump_range  REAL,
      cargo_capacity  INTEGER,
      fuel_capacity   REAL,
      unladen_mass    REAL,
      modules         TEXT,          -- JSON, from the last Loadout
      raw_loadout     TEXT,          -- the last Loadout event as logged, for export
      loadout_at      TEXT,
      star_system     TEXT,
      station_name    TEXT,
      in_transit      INTEGER NOT NULL DEFAULT 0,
      is_hot          INTEGER NOT NULL DEFAULT 0,
      location_at     TEXT,
      first_seen_at   TEXT,
      sold_at         TEXT,          -- sold or lost; NULL while owned
      PRIMARY KEY (commander_id, ship_id)
    );
    CREATE TABLE IF NOT EXISTS fleet_current_ship (
      commander_id  INTEGER PRIMARY KEY REFERENCES commanders(id),
      ship_id       INTEGER
    );
    -- Localised names the game has logged for internal item names (ships and modules).
    CREATE TABLE IF NOT EXISTS fleet_item_names (
      item  TEXT PRIMARY KEY,
      name  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fleet_suits (
      commander_id  INTEGER NOT NULL REFERENCES commanders(id),
      suit_id       INTEGER NOT NULL,
      item          TEXT,
      class         INTEGER,
      mods          TEXT NOT NULL DEFAULT '[]',
      price         INTEGER,
      acquired_at   TEXT,
      sold_at       TEXT,
      PRIMARY KEY (commander_id, suit_id)
    );
    CREATE TABLE IF NOT EXISTS fleet_weapons (
      commander_id  INTEGER NOT NULL REFERENCES commanders(id),
      weapon_id     INTEGER NOT NULL,
      item          TEXT,
      name          TEXT,
      class         INTEGER,
      mods          TEXT NOT NULL DEFAULT '[]',
      price         INTEGER,
      acquired_at   TEXT,
      sold_at       TEXT,
      PRIMARY KEY (commander_id, weapon_id)
    );
    CREATE TABLE IF NOT EXISTS fleet_suit_loadouts (
      commander_id  INTEGER NOT NULL REFERENCES commanders(id),
      loadout_id    INTEGER NOT NULL,
      name          TEXT,
      suit_id       INTEGER,
      modules       TEXT NOT NULL DEFAULT '[]',
      updated_at    TEXT,
      PRIMARY KEY (commander_id, loadout_id)
    );
    CREATE TABLE IF NOT EXISTS fleet_vehicles (
      commander_id  INTEGER NOT NULL REFERENCES commanders(id),
      kind          TEXT NOT NULL,   -- srv | fighter
      type          TEXT NOT NULL,
      name          TEXT,
      loadout       TEXT NOT NULL DEFAULT '',
      use_count     INTEGER NOT NULL DEFAULT 0,
      last_used_at  TEXT,
      PRIMARY KEY (commander_id, kind, type, loadout)
    );
    CREATE TABLE IF NOT EXISTS fleet_owned_counts (
      commander_id  INTEGER PRIMARY KEY REFERENCES commanders(id),
      ships         INTEGER,
      suits         INTEGER,
      weapons       INTEGER,
      updated_at    TEXT
    );
  `,

  createProcessor(database) {
    const ensureShip = database.prepare(`
      INSERT INTO fleet_ships (commander_id, ship_id, ship_type, first_seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (commander_id, ship_id) DO UPDATE SET ship_type = COALESCE(excluded.ship_type, ship_type)
    `);
    const updateLoadout = database.prepare(`
      UPDATE fleet_ships SET ship_name = ?, ship_ident = ?, hull_value = ?, modules_value = ?, rebuy = ?, hull_health = ?,
        max_jump_range = ?, cargo_capacity = ?, fuel_capacity = ?, unladen_mass = ?, modules = ?, raw_loadout = ?, loadout_at = ?, sold_at = NULL
      WHERE commander_id = ? AND ship_id = ?
    `);
    const updateStored = database.prepare(`
      UPDATE fleet_ships SET ship_name = COALESCE(?, ship_name), stored_value = ?, star_system = ?, station_name = ?,
        in_transit = ?, is_hot = ?, location_at = ?, sold_at = NULL
      WHERE commander_id = ? AND ship_id = ?
    `);
    const updateLocation = database.prepare(`
      UPDATE fleet_ships SET star_system = ?, station_name = ?, in_transit = ?, location_at = ? WHERE commander_id = ? AND ship_id = ?
    `);
    const updateShipName = database.prepare('UPDATE fleet_ships SET ship_name = ?, ship_ident = ? WHERE commander_id = ? AND ship_id = ?');
    const markSold = database.prepare('UPDATE fleet_ships SET sold_at = ? WHERE commander_id = ? AND ship_id = ? AND sold_at IS NULL');
    const markUnlistedSold = database.prepare(`
      UPDATE fleet_ships SET sold_at = ? WHERE commander_id = ? AND sold_at IS NULL
        AND ship_id NOT IN (SELECT value FROM json_each(?))
    `);
    const setCurrentShip = database.prepare(`
      INSERT INTO fleet_current_ship (commander_id, ship_id) VALUES (?, ?)
      ON CONFLICT (commander_id) DO UPDATE SET ship_id = excluded.ship_id
    `);
    const selectCurrentShip = database.prepare('SELECT ship_id FROM fleet_current_ship WHERE commander_id = ?');
    const upsertName = database.prepare(`
      INSERT INTO fleet_item_names (item, name) VALUES (?, ?) ON CONFLICT (item) DO UPDATE SET name = excluded.name
    `);
    const upsertSuit = database.prepare(`
      INSERT INTO fleet_suits (commander_id, suit_id, item, class, mods, price, acquired_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (commander_id, suit_id) DO UPDATE SET item = excluded.item, class = excluded.class, mods = excluded.mods,
        price = COALESCE(excluded.price, price), acquired_at = COALESCE(acquired_at, excluded.acquired_at), sold_at = NULL
    `);
    const sellSuit = database.prepare('UPDATE fleet_suits SET sold_at = ? WHERE commander_id = ? AND suit_id = ?');
    const upgradeSuit = database.prepare('UPDATE fleet_suits SET class = ? WHERE commander_id = ? AND suit_id = ?');
    const upsertWeapon = database.prepare(`
      INSERT INTO fleet_weapons (commander_id, weapon_id, item, name, class, mods, price, acquired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (commander_id, weapon_id) DO UPDATE SET item = excluded.item, name = COALESCE(excluded.name, name),
        class = excluded.class, mods = excluded.mods, price = COALESCE(excluded.price, price),
        acquired_at = COALESCE(acquired_at, excluded.acquired_at), sold_at = NULL
    `);
    const sellWeapon = database.prepare('UPDATE fleet_weapons SET sold_at = ? WHERE commander_id = ? AND weapon_id = ?');
    const upgradeWeapon = database.prepare('UPDATE fleet_weapons SET class = ? WHERE commander_id = ? AND weapon_id = ?');
    const upsertSuitLoadout = database.prepare(`
      INSERT INTO fleet_suit_loadouts (commander_id, loadout_id, name, suit_id, modules, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (commander_id, loadout_id) DO UPDATE SET name = excluded.name, suit_id = excluded.suit_id,
        modules = excluded.modules, updated_at = excluded.updated_at
    `);
    const deleteSuitLoadout = database.prepare('DELETE FROM fleet_suit_loadouts WHERE commander_id = ? AND loadout_id = ?');
    const renameSuitLoadout = database.prepare('UPDATE fleet_suit_loadouts SET name = ? WHERE commander_id = ? AND loadout_id = ?');
    const useVehicle = database.prepare(`
      INSERT INTO fleet_vehicles (commander_id, kind, type, name, loadout, use_count, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (commander_id, kind, type, loadout) DO UPDATE SET name = COALESCE(excluded.name, name),
        use_count = use_count + excluded.use_count, last_used_at = excluded.last_used_at
    `);
    const updateOwnedCounts = database.prepare(`
      INSERT INTO fleet_owned_counts (commander_id, ships, suits, weapons, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (commander_id) DO UPDATE SET ships = excluded.ships, suits = excluded.suits, weapons = excluded.weapons, updated_at = excluded.updated_at
    `);

    const rememberName = (item, localisedName) => {
      const key = normalizeItem(item);
      if (key && localisedName && !localisedName.startsWith('$')) upsertName.run(key, localisedName);
    };

    return ({ commanderId, event, timestamp, data }, moduleState) => {
      if (trackDockingState(event, data, moduleState)) return;
      const touchShip = (shipId, shipType = null) => {
        if (Number.isInteger(shipId)) ensureShip.run(commanderId, shipId, shipType ? normalizeItem(shipType) : null, timestamp);
      };
      const becomeCurrent = (shipId, shipType) => {
        touchShip(shipId, shipType);
        if (Number.isInteger(shipId)) setCurrentShip.run(commanderId, shipId);
      };
      // A ship left at the station the commander is docked at.
      const storeHere = (shipId, shipType) => {
        if (!Number.isInteger(shipId)) return;
        touchShip(shipId, shipType);
        const docked = getDockedLocation(moduleState);
        updateLocation.run(docked?.starSystem ?? null, docked?.stationName ?? null, 0, timestamp, commanderId, shipId);
      };

      switch (event) {
        case 'LoadGame':
          rememberName(data.Ship, data.Ship_Localised);
          becomeCurrent(data.ShipID, data.Ship);
          if (data.ShipName !== undefined) updateShipName.run(data.ShipName.trim() || null, data.ShipIdent?.trim() || null, commanderId, data.ShipID);
          return;

        case 'Loadout':
          becomeCurrent(data.ShipID, data.Ship);
          updateLoadout.run(
            data.ShipName?.trim() || null, data.ShipIdent?.trim() || null, data.HullValue ?? null, data.ModulesValue ?? null,
            data.Rebuy ?? null, data.HullHealth ?? null, data.MaxJumpRange ?? null, data.CargoCapacity ?? null,
            data.FuelCapacity?.Main ?? null, data.UnladenMass ?? null, JSON.stringify((data.Modules ?? []).map(summarizeModule)),
            JSON.stringify(data), timestamp, commanderId, data.ShipID,
          );
          return;

        case 'StoredShips': {
          const listedIds = [];
          const store = (ship, isHere) => {
            if (!Number.isInteger(ship.ShipID)) return;
            rememberName(ship.ShipType, ship.ShipType_Localised);
            touchShip(ship.ShipID, ship.ShipType);
            listedIds.push(ship.ShipID);
            updateStored.run(
              ship.Name?.trim() || null, ship.Value ?? null,
              isHere ? data.StarSystem ?? null : ship.StarSystem ?? null, isHere ? data.StationName ?? null : null,
              ship.InTransit ? 1 : 0, ship.Hot ? 1 : 0, timestamp, commanderId, ship.ShipID,
            );
          };
          for (const ship of data.ShipsHere ?? []) store(ship, true);
          for (const ship of data.ShipsRemote ?? []) store(ship, false);
          const currentShipId = selectCurrentShip.get(commanderId)?.ship_id;
          if (Number.isInteger(currentShipId)) listedIds.push(currentShipId);
          markUnlistedSold.run(timestamp, commanderId, JSON.stringify(listedIds));
          return;
        }

        case 'ShipyardSwap':
          rememberName(data.ShipType, data.ShipType_Localised);
          if (Number.isInteger(data.SellShipID)) markSold.run(timestamp, commanderId, data.SellShipID);
          storeHere(data.StoreShipID, data.StoreOldShip);
          becomeCurrent(data.ShipID, data.ShipType);
          return;

        case 'ShipyardNew':
          rememberName(data.ShipType, data.ShipType_Localised);
          becomeCurrent(data.NewShipID, data.ShipType);
          return;

        case 'ShipyardBuy':
          rememberName(data.ShipType, data.ShipType_Localised);
          if (Number.isInteger(data.SellShipID)) markSold.run(timestamp, commanderId, data.SellShipID);
          storeHere(data.StoreShipID, data.StoreOldShip);
          return;

        case 'ShipyardSell':
          rememberName(data.ShipType, data.ShipType_Localised);
          markSold.run(timestamp, commanderId, data.SellShipID);
          return;

        case 'SellShipOnRebuy':
          markSold.run(timestamp, commanderId, data.SellShipId ?? data.SellShipID);
          return;

        case 'ShipyardTransfer': {
          rememberName(data.ShipType, data.ShipType_Localised);
          touchShip(data.ShipID, data.ShipType);
          const docked = getDockedLocation(moduleState);
          updateLocation.run(docked?.starSystem ?? null, docked?.stationName ?? null, 1, timestamp, commanderId, data.ShipID);
          return;
        }

        case 'SetUserShipName':
          touchShip(data.ShipID, data.Ship);
          updateShipName.run(data.UserShipName?.trim() || null, data.UserShipId?.trim() || null, commanderId, data.ShipID);
          return;

        case 'ModuleBuy':
          rememberName(data.BuyItem, data.BuyItem_Localised);
          rememberName(data.SellItem, data.SellItem_Localised);
          rememberName(data.StoredItem, data.StoredItem_Localised);
          return;
        case 'ModuleSell':
        case 'ModuleSellRemote':
          rememberName(data.SellItem, data.SellItem_Localised);
          return;
        case 'ModuleStore':
          rememberName(data.StoredItem, data.StoredItem_Localised);
          rememberName(data.ReplacementItem, data.ReplacementItem_Localised);
          return;
        case 'ModuleRetrieve':
          rememberName(data.RetrievedItem, data.RetrievedItem_Localised);
          rememberName(data.SwapOutItem, data.SwapOutItem_Localised);
          return;
        case 'ModuleBuyAndStore':
          rememberName(data.BuyItem, data.BuyItem_Localised);
          return;
        case 'FetchRemoteModule':
          rememberName(data.StoredItem, data.StoredItem_Localised);
          return;
        case 'StoredModules':
          for (const item of data.Items ?? []) rememberName(item.Name, item.Name_Localised);
          return;

        case 'BuySuit':
          upsertSuit.run(commanderId, data.SuitID, normalizeItem(data.Name), getItemClass(data.Name) ?? 1, JSON.stringify(data.SuitMods ?? []), data.Price ?? null, timestamp);
          return;
        case 'SellSuit':
          sellSuit.run(timestamp, commanderId, data.SuitID);
          return;
        case 'UpgradeSuit':
          if (Number.isInteger(data.Class)) upgradeSuit.run(data.Class, commanderId, data.SuitID);
          return;
        case 'BuyWeapon':
          upsertWeapon.run(commanderId, data.SuitModuleID, normalizeItem(data.Name), cleanLocalised(data.Name_Localised), data.Class ?? null, JSON.stringify(data.WeaponMods ?? []), data.Price ?? null, timestamp);
          return;
        case 'SellWeapon':
          sellWeapon.run(timestamp, commanderId, data.SuitModuleID);
          return;
        case 'UpgradeWeapon':
          if (Number.isInteger(data.Class)) upgradeWeapon.run(data.Class, commanderId, data.SuitModuleID);
          return;

        case 'SuitLoadout':
        case 'CreateSuitLoadout':
          if (Number.isInteger(data.SuitID)) {
            upsertSuit.run(commanderId, data.SuitID, normalizeItem(data.SuitName), getItemClass(data.SuitName) ?? 1, JSON.stringify(data.SuitMods ?? []), null, timestamp);
          }
          for (const weapon of data.Modules ?? []) {
            if (!Number.isInteger(weapon.SuitModuleID)) continue;
            upsertWeapon.run(commanderId, weapon.SuitModuleID, normalizeItem(weapon.ModuleName), cleanLocalised(weapon.ModuleName_Localised), weapon.Class ?? null, JSON.stringify(weapon.WeaponMods ?? []), null, timestamp);
          }
          if (Number.isInteger(data.LoadoutID)) {
            const modules = (data.Modules ?? []).map((weapon) => ({ slot: weapon.SlotName, weaponId: weapon.SuitModuleID }));
            upsertSuitLoadout.run(commanderId, data.LoadoutID, data.LoadoutName ?? null, data.SuitID ?? null, JSON.stringify(modules), timestamp);
          }
          return;
        case 'DeleteSuitLoadout':
          deleteSuitLoadout.run(commanderId, data.LoadoutID);
          return;
        case 'RenameSuitLoadout':
          renameSuitLoadout.run(data.LoadoutName ?? null, commanderId, data.LoadoutID);
          return;

        case 'LaunchSRV':
          if (data.SRVType) useVehicle.run(commanderId, 'srv', normalizeItem(data.SRVType), cleanLocalised(data.SRVType_Localised), data.Loadout ?? '', 1, timestamp);
          return;
        case 'LaunchFighter': {
          // The game logs the fighter type under an empty key ("": "independent_fighter", "_Localised": "Taipan").
          const fighterType = normalizeItem(data.Type ?? data['']) ?? 'fighter';
          useVehicle.run(commanderId, 'fighter', fighterType, cleanLocalised(data.Type_Localised ?? data._Localised), data.Loadout ?? '', 1, timestamp);
          return;
        }
        case 'RestockVehicle':
          if (data.Type) {
            const kind = /fighter/i.test(data.Type) ? 'fighter' : 'srv';
            useVehicle.run(commanderId, kind, normalizeItem(data.Type), cleanLocalised(data.Type_Localised), data.Loadout ?? '', 0, timestamp);
          }
          return;

        case 'Statistics':
          updateOwnedCounts.run(commanderId, data.Bank_Account?.Owned_Ship_Count ?? null, data.Bank_Account?.Suits_Owned ?? null, data.Bank_Account?.Weapons_Owned ?? null, timestamp);
          return;
      }
    };
  },

  createRouter(database) {
    const router = Router();
    const selectNames = database.prepare('SELECT item, name FROM fleet_item_names');
    const selectRawLoadout = database.prepare('SELECT ship_type, ship_name, raw_loadout FROM fleet_ships WHERE commander_id = ? AND ship_id = ?');
    const selectShips = database.prepare(`
      SELECT fleet_ships.*, fleet_current_ship.ship_id IS NOT NULL AS is_current
      FROM fleet_ships LEFT JOIN fleet_current_ship
        ON fleet_current_ship.commander_id = fleet_ships.commander_id AND fleet_current_ship.ship_id = fleet_ships.ship_id
      WHERE fleet_ships.commander_id = ? ORDER BY fleet_ships.sold_at IS NOT NULL, is_current DESC, fleet_ships.ship_id
    `);
    const selectSuits = database.prepare('SELECT * FROM fleet_suits WHERE commander_id = ? ORDER BY sold_at IS NOT NULL, acquired_at');
    const selectWeapons = database.prepare('SELECT * FROM fleet_weapons WHERE commander_id = ? ORDER BY sold_at IS NOT NULL, acquired_at');
    const selectSuitLoadouts = database.prepare('SELECT * FROM fleet_suit_loadouts WHERE commander_id = ? ORDER BY loadout_id');
    const selectVehicles = database.prepare('SELECT * FROM fleet_vehicles WHERE commander_id = ? ORDER BY kind, last_used_at DESC');
    const selectOwnedCounts = database.prepare('SELECT * FROM fleet_owned_counts WHERE commander_id = ?');

    // GET /api/stats/fleet?commander=<id> -> ships (with loadouts), suits, weapons, suit loadouts, vehicles
    router.get('/', (request, response) => {
      const commanderId = getCommanderIdFilter(request.query);
      if (commanderId === null) {
        response.status(400).json({ error: 'Choose a commander' });
        return;
      }
      const names = new Map(selectNames.all().map((row) => [row.item, row.name]));
      const ships = selectShips.all(commanderId).map((row) => {
        const modules = row.modules
          ? JSON.parse(row.modules).filter((module) => !COSMETIC_SLOT_PATTERN.test(module.slot ?? '')).map((module) => describeModule(module, names))
          : null;
        const loadoutValue = row.hull_value !== null ? (row.hull_value ?? 0) + (row.modules_value ?? 0) : null;
        return {
          shipId: row.ship_id,
          shipType: row.ship_type,
          shipTypeName: names.get(row.ship_type) ?? SHIP_NAMES[row.ship_type] ?? tidyName(row.ship_type),
          name: row.ship_name,
          ident: row.ship_ident,
          isCurrent: Boolean(row.is_current),
          isSold: Boolean(row.sold_at),
          soldAt: row.sold_at,
          value: row.stored_value ?? loadoutValue,
          hullValue: row.hull_value,
          modulesValue: row.modules_value,
          rebuy: row.rebuy,
          hullHealth: row.hull_health,
          maxJumpRange: row.max_jump_range,
          cargoCapacity: row.cargo_capacity,
          fuelCapacity: row.fuel_capacity,
          unladenMass: row.unladen_mass,
          loadoutAt: row.loadout_at,
          location: { starSystem: row.star_system, stationName: row.station_name, isInTransit: Boolean(row.in_transit), at: row.location_at },
          isHot: Boolean(row.is_hot),
          firstSeenAt: row.first_seen_at,
          modules,
          engineeredCount: modules?.filter((module) => module.engineering).length ?? 0,
        };
      });
      const weapons = selectWeapons.all(commanderId).map((row) => ({
        weaponId: row.weapon_id,
        name: row.name ?? tidyName(row.item),
        class: row.class,
        mods: JSON.parse(row.mods).map(describeOnFootMod),
        price: row.price,
        acquiredAt: row.acquired_at,
        isSold: Boolean(row.sold_at),
        soldAt: row.sold_at,
      }));
      const weaponsById = new Map(weapons.map((weapon) => [weapon.weaponId, weapon]));
      const suits = selectSuits.all(commanderId).map((row) => ({
        suitId: row.suit_id,
        name: SUIT_NAMES[row.item?.replace(/_class\d+$/, '')] ?? tidyName(row.item),
        class: row.class,
        mods: JSON.parse(row.mods).map(describeOnFootMod),
        price: row.price,
        acquiredAt: row.acquired_at,
        isSold: Boolean(row.sold_at),
        soldAt: row.sold_at,
      }));
      const suitsById = new Map(suits.map((suit) => [suit.suitId, suit]));
      const suitLoadouts = selectSuitLoadouts.all(commanderId).map((row) => ({
        loadoutId: row.loadout_id,
        name: row.name,
        suit: suitsById.get(row.suit_id) ?? null,
        weapons: JSON.parse(row.modules).map((slot) => ({ slot: tidySlot(slot.slot), weapon: weaponsById.get(slot.weaponId) ?? null })),
        updatedAt: row.updated_at,
      }));
      const vehicles = selectVehicles.all(commanderId).map((row) => ({
        kind: row.kind,
        name: row.name ?? VEHICLE_NAMES[row.type] ?? (row.type === 'fighter' ? 'Fighter' : tidyName(row.type)),
        loadout: row.loadout || null,
        useCount: row.use_count,
        lastUsedAt: row.last_used_at,
      }));
      const hangars = ships.filter((ship) => !ship.isSold).flatMap((ship) => (ship.modules ?? [])
        .filter((module) => /fighterbay|buggybay/.test(module.item))
        .map((module) => ({ shipId: ship.shipId, shipName: ship.name, shipTypeName: ship.shipTypeName, module: module.name, rating: module.rating })));
      const ownedCounts = selectOwnedCounts.get(commanderId) ?? null;
      response.json({ ships, suits, weapons, suitLoadouts, vehicles, hangars, ownedCounts });
    });

    // GET /api/stats/fleet/export?commander=<id>&ship=<ship id>
    // A ship's last loadout as EDSY and Coriolis import links and as SLEF (Ship Loadout Exchange
    // Format). The links carry the journal's Loadout event the way EDMarketConnector sends it:
    // compact JSON with sorted keys, gzipped, URL-safe base64 with "=" written as %3D.
    router.get('/export', (request, response) => {
      const commanderId = getCommanderIdFilter(request.query);
      const shipId = Number(request.query.ship);
      const row = commanderId === null || !Number.isInteger(shipId) ? null : selectRawLoadout.get(commanderId, shipId);
      if (!row?.raw_loadout) {
        response.status(404).json({ error: 'No loadout recorded for this ship' });
        return;
      }
      const loadout = JSON.parse(row.raw_loadout);
      const encoded = gzipSync(Buffer.from(stableStringify(loadout), 'utf8')).toString('base64url');
      // Buffer's base64url leaves out the padding; EDSY and Coriolis expect it (as %3D).
      const padded = encoded + '%3D'.repeat((4 - (encoded.length % 4)) % 4);
      response.json({
        fileName: `${[row.ship_name, getShipTypeName(row.ship_type)].filter(Boolean).join(' ')}`.replace(/[^\w -]+/g, '').trim() || 'ship',
        edsyUrl: `https://edsy.org/#/I=${padded}`,
        coriolisUrl: `https://coriolis.io/import?data=${padded}`,
        slef: [{ header: { appName: 'ED Journal Tool', appVersion }, data: loadout }],
      });
    });

    return router;
  },
});

/** JSON with object keys sorted at every level and no spaces, like Python's json.dumps(sort_keys=True). */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** "$int_cargorack_size6_class1_name;" and "Int_CargoRack_Size6_Class1" -> "int_cargorack_size6_class1". */
function normalizeItem(item) {
  if (!item) return null;
  return String(item).replace(/^\$/, '').replace(/_name;$/i, '').replace(/;$/, '').toLowerCase();
}

function cleanLocalised(name) {
  return name && !name.startsWith('$') ? name : null;
}

function getItemClass(item) {
  const match = /_class(\d+)/i.exec(item ?? '');
  return match ? Number(match[1]) : null;
}

function summarizeModule(module) {
  const engineering = module.Engineering;
  return {
    slot: module.Slot,
    item: normalizeItem(module.Item),
    on: module.On !== false,
    priority: module.Priority ?? null,
    health: module.Health ?? null,
    value: module.Value ?? null,
    ammo: module.AmmoInClip !== undefined ? { clip: module.AmmoInClip, hopper: module.AmmoInHopper ?? null } : null,
    engineering: engineering ? {
      engineer: engineering.Engineer ?? null,
      blueprint: engineering.BlueprintName ?? null,
      level: engineering.Level ?? null,
      quality: engineering.Quality ?? null,
      experimental: engineering.ExperimentalEffect_Localised ?? engineering.ExperimentalEffect ?? null,
      modifiers: (engineering.Modifiers ?? []).map((modifier) => ({
        label: modifier.Label,
        value: modifier.Value ?? modifier.ValueStr ?? null,
        originalValue: modifier.OriginalValue ?? null,
        lessIsGood: Boolean(modifier.LessIsGood),
      })),
    } : null,
  };
}

/**
 * A module with a display name ("Cargo Rack") and rating: "6E" for core and optional modules, the
 * size and mount for weapons ("Medium gimballed"). Slot and blueprint names are tidied too.
 */
function describeModule(module, names) {
  const item = module.item ?? '';
  const sizeMatch = /_size(\d+)_class(\d+)/.exec(item);
  const baseItem = item.replace(/_size\d+_class\d+.*$/, '');
  const armourMatch = /_armour_(\w+)$/.exec(item);
  const hardpointMatch = /^hpt_.*?_(fixed|gimbal|turret)_(small|medium|large|huge)/.exec(item);
  const localised = names.get(item) ?? ITEM_NAMES[baseItem] ?? [...names.entries()].find(([name]) => name.startsWith(`${baseItem}_size`))?.[1];
  const rating = sizeMatch ? `${sizeMatch[1]}${CLASS_LETTERS[Number(sizeMatch[2])] ?? ''}` : null;
  return {
    ...module,
    mount: hardpointMatch ? HARDPOINT_MOUNTS[hardpointMatch[1]] : null,
    hardpointSize: hardpointMatch ? Object.keys(HARDPOINT_SIZES).indexOf(hardpointMatch[2]) + 1 : null,
    slot: tidySlot(module.slot),
    slotKey: module.slot,
    name: armourMatch ? ARMOUR_NAMES[armourMatch[1]] ?? tidyName(armourMatch[1]) : localised ?? tidyModuleName(item),
    rating,
    engineering: module.engineering ? { ...module.engineering, blueprintName: tidyBlueprint(module.engineering.blueprint) } : null,
  };
}

function tidyModuleName(item) {
  if (!item) return '—';
  return tidyName(item.replace(/^(hpt|int|ext)_/, '').replace(/_size\d+_class\d+.*$/, '').replace(/_(fixed|gimbal|turret)?_?(tiny|small|medium|large|huge)$/, ''));
}

/** "Armour_HeavyDuty" -> "Heavy Duty"; "Misc_LightWeight" -> "Light Weight". */
function tidyBlueprint(blueprint) {
  if (!blueprint) return null;
  const withoutCategory = blueprint.includes('_') ? blueprint.slice(blueprint.indexOf('_') + 1) : blueprint;
  return withoutCategory.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
}

/** "Slot04_Size6" -> "Slot 4 (size 6)"; "TinyHardpoint3" -> "Utility 3"; "PrimaryWeapon1" -> "Primary 1". */
export function tidySlot(slot) {
  if (!slot) return null;
  const optional = /^Slot(\d+)_Size(\d+)$/.exec(slot);
  if (optional) return `Optional ${Number(optional[1])} (size ${optional[2]})`;
  const hardpoint = /^(Tiny|Small|Medium|Large|Huge)Hardpoint(\d+)$/.exec(slot);
  if (hardpoint) return hardpoint[1] === 'Tiny' ? `Utility ${hardpoint[2]}` : `${hardpoint[1]} hardpoint ${hardpoint[2]}`;
  const weapon = /^(Primary|Secondary)Weapon(\d*)$/.exec(slot);
  if (weapon) return `${weapon[1]}${weapon[2] ? ` ${weapon[2]}` : ''}`;
  return slot.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** A ship type's display name ("type9_military" -> "Type-10 Defender"). */
export function getShipTypeName(shipType) {
  const key = normalizeItem(shipType);
  return SHIP_NAMES[key] ?? tidyName(key);
}

function tidyName(name) {
  if (!name) return '—';
  return String(name).replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** "suit_increasedbatterycapacity" -> "Increased Battery Capacity". */
function describeOnFootMod(mod) {
  const known = {
    suit_backpackcapacity: 'Extra Backpack Capacity', suit_increasedammoreserves: 'Extra Ammo Capacity',
    suit_increasedbatterycapacity: 'Improved Battery Capacity', suit_improvedjumpassist: 'Improved Jump Assist',
    suit_increasedmeleedamage: 'Added Melee Damage', suit_increasedo2capacity: 'Increased Air Reserves',
    suit_increasedshieldregen: 'Faster Shield Regen', suit_increasedsprintduration: 'Increased Sprint Duration',
    suit_improvedradar: 'Enhanced Tracking', suit_nightvision: 'Night Vision', suit_quieterfootsteps: 'Quieter Footsteps',
    suit_reducedtoolbatteryconsumption: 'Reduced Tool Battery Consumption', suit_improvedarmourrating: 'Damage Resistance',
    weapon_handling: 'Faster Handling', weapon_scope: 'Scope', weapon_stability: 'Stability', weapon_range: 'Greater Range',
    weapon_clipsize: 'Magazine Size', weapon_reloadspeed: 'Reload Speed', weapon_accuracy: 'Improved Hip Fire Accuracy',
    weapon_headshotdamage: 'Headshot Damage', weapon_suppression_unpressurised: 'Noise Suppressor', weapon_backpackreloading: 'Stowed Reloading',
  };
  return known[mod] ?? tidyName(String(mod).replace(/^(suit|weapon)_/, ''));
}
