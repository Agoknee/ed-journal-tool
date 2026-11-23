import { gzipSync } from 'node:zlib';
import { Router } from 'express';
import { appVersion } from '../../cli.mjs';
import { defineStatModule } from '../define-stat-module.mjs';
import { DOCKING_EVENTS, getDockedLocation, trackDockingState } from '../docking-state.mjs';
import { createModuleDescriber, isCosmeticSlot, tidySlot } from '../../game-data/modules.mjs';
import { cleanLocalised, getItemClass, normalizeItem, tidyBlueprint, tidyName } from '../../game-data/names.mjs';
import { getModificationName, getSuitName } from '../../game-data/on-foot.mjs';
import { getShipTypeName, isOwnShip, VEHICLE_NAMES } from '../../game-data/ships.mjs';
import { getCommanderIdFilter, requireCommanderId } from '../query-helpers.mjs';

/**
 * Each commander's ships, on-foot suits and weapons, suit loadouts and the SRVs and fighters
 * they've used.
 *
 * - A ship's full loadout (modules, engineering, values) is the last Loadout logged while flying
 *   it, so ships not flown since the journals began only have what StoredShips says (type, name,
 *   value and where it is).
 * - StoredShips (at a shipyard) lists every ship but the one being flown, so a ship missing from it
 *   has been sold or lost.
 * - The game reuses a sold ship's ID for the next ship bought; the sold ship's record then moves to
 *   a negative archive ID so both are kept.
 * - There's no full list of suits and weapons in the journal: they're built from purchases, sales,
 *   upgrades and suit loadouts. Statistics gives how many of each are owned, to compare.
 * - Module and ship names come from the localised names the game logs (when modules are bought,
 *   stored and so on), falling back to the internal names tidied up.
 * - Each ship's last Loadout event is also kept as logged, for exporting to EDSY, Coriolis and SLEF.
 * - A ship's value is from whichever is newer: its loadout (hull + modules) or the shipyard listing.
 * - Stored modules are the latest StoredModules listing (logged at outfitting). The listing doesn't say
 *   whether a module is pre-engineered; that's remembered when one goes from a ship into storage
 *   (so not for modules bought straight into storage, nor stored before the journals began).
 */
export default defineStatModule({
  name: 'fleet',
  title: 'Fleet',
  description: 'Ships with their loadouts, suits, weapons, suit loadouts and vehicles.',
  version: 9,
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
    { type: 'table', name: 'fleet_stored_modules' },
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
      last_flown_at   TEXT,          -- when the commander last left it (or boarded it, for the ship being flown)
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
    -- The latest StoredModules listing per commander (JSON list of modules).
    CREATE TABLE IF NOT EXISTS fleet_stored_modules (
      commander_id  INTEGER PRIMARY KEY REFERENCES commanders(id),
      modules       TEXT NOT NULL,
      updated_at    TEXT
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
    // The game gives a sold ship's ID to the next ship bought. The old ship's record moves to an
    // archive ID (negative, so it never clashes with a game ID) and stays as sold or lost.
    const selectShipExists = database.prepare('SELECT 1 FROM fleet_ships WHERE commander_id = ? AND ship_id = ?');
    const selectLowestArchiveId = database.prepare('SELECT MIN(ship_id) AS id FROM fleet_ships WHERE commander_id = ? AND ship_id < 0');
    const archiveShip = database.prepare('UPDATE fleet_ships SET ship_id = ?, sold_at = COALESCE(sold_at, ?) WHERE commander_id = ? AND ship_id = ?');
    const retireReusedShipId = (commanderId, shipId, timestamp) => {
      if (!Number.isInteger(shipId) || !selectShipExists.get(commanderId, shipId)) return;
      const archiveId = Math.min(0, selectLowestArchiveId.get(commanderId)?.id ?? 0) - 1;
      archiveShip.run(archiveId, timestamp, commanderId, shipId);
    };
    const markUnlistedSold = database.prepare(`
      UPDATE fleet_ships SET sold_at = ? WHERE commander_id = ? AND sold_at IS NULL
        AND ship_id NOT IN (SELECT value FROM json_each(?))
    `);
    const setCurrentShip = database.prepare(`
      INSERT INTO fleet_current_ship (commander_id, ship_id) VALUES (?, ?)
      ON CONFLICT (commander_id) DO UPDATE SET ship_id = excluded.ship_id
    `);
    const selectCurrentShip = database.prepare('SELECT ship_id FROM fleet_current_ship WHERE commander_id = ?');
    const markFlown = database.prepare(`
      UPDATE fleet_ships SET last_flown_at = ?1 WHERE commander_id = ?2 AND ship_id = ?3 AND (last_flown_at IS NULL OR last_flown_at < ?1)
    `);
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
    const upsertStoredModules = database.prepare(`
      INSERT INTO fleet_stored_modules (commander_id, modules, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (commander_id) DO UPDATE SET modules = excluded.modules, updated_at = excluded.updated_at
    `);
    const updateOwnedCounts = database.prepare(`
      INSERT INTO fleet_owned_counts (commander_id, ships, suits, weapons, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (commander_id) DO UPDATE SET ships = excluded.ships, suits = excluded.suits, weapons = excluded.weapons, updated_at = excluded.updated_at
    `);

    const rememberName = (item, localisedName) => {
      const key = normalizeItem(item);
      if (key && localisedName && !localisedName.startsWith('$')) upsertName.run(key, localisedName);
    };

    // Storage listings don't say whether a module is pre-engineered (no EngineerID), so it's
    // remembered when one leaves a ship for storage, from that ship's last loadout.
    const selectShipModulesForStorage = database.prepare('SELECT modules FROM fleet_ships WHERE commander_id = ? AND ship_id = ?');
    const notePreEngineeredStored = (commanderId, shipId, slot, moduleState) => {
      const shipRow = selectShipModulesForStorage.get(commanderId, shipId);
      const module = shipRow?.modules ? JSON.parse(shipRow.modules).find((candidate) => candidate.slot === slot) : null;
      if (!module?.engineering?.isPreEngineered) return;
      const signature = storedSignature(module.item, module.engineering.blueprint, module.engineering.level);
      moduleState.set(PRE_ENGINEERED_STORED_STATE_KEY, [...(moduleState.get(PRE_ENGINEERED_STORED_STATE_KEY) ?? []), signature]);
    };
    const takePreEngineeredStored = (signature, moduleState) => {
      const stored = [...(moduleState.get(PRE_ENGINEERED_STORED_STATE_KEY) ?? [])];
      const index = signature ? stored.indexOf(signature) : -1;
      if (index < 0) return;
      stored.splice(index, 1);
      moduleState.set(PRE_ENGINEERED_STORED_STATE_KEY, stored);
    };

    return ({ commanderId, event, timestamp, data }, moduleState) => {
      if (trackDockingState(event, data, moduleState)) return;
      const touchShip = (shipId, shipType = null) => {
        if (Number.isInteger(shipId)) ensureShip.run(commanderId, shipId, shipType ? normalizeItem(shipType) : null, timestamp);
      };
      // Boarding a ship marks it flown now, and the ship left behind as flown until now.
      const becomeCurrent = (shipId, shipType) => {
        touchShip(shipId, shipType);
        if (!Number.isInteger(shipId)) return;
        const previousShipId = selectCurrentShip.get(commanderId)?.ship_id;
        if (Number.isInteger(previousShipId) && previousShipId !== shipId) markFlown.run(timestamp, commanderId, previousShipId);
        markFlown.run(timestamp, commanderId, shipId);
        setCurrentShip.run(commanderId, shipId);
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
          // Logged in on foot, in an SRV or on a transport: that's not a ship of theirs, and the
          // ship they came in stays their current one.
          if (!isOwnShip(data.Ship, data.ShipID)) return;
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
          // A brand-new ship: anything already recorded under its ID was an earlier ship, since sold.
          retireReusedShipId(commanderId, data.NewShipID, timestamp);
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
          // Buying can send the module that was in the slot to storage.
          if (data.StoredItem) notePreEngineeredStored(commanderId, data.ShipID, data.Slot, moduleState);
          return;
        case 'ModuleSell':
        case 'ModuleSellRemote':
          rememberName(data.SellItem, data.SellItem_Localised);
          return;
        case 'ModuleStore':
          rememberName(data.StoredItem, data.StoredItem_Localised);
          rememberName(data.ReplacementItem, data.ReplacementItem_Localised);
          notePreEngineeredStored(commanderId, data.ShipID, data.Slot, moduleState);
          return;
        case 'ModuleRetrieve':
          rememberName(data.RetrievedItem, data.RetrievedItem_Localised);
          rememberName(data.SwapOutItem, data.SwapOutItem_Localised);
          // The module taken out goes onto the ship (its next Loadout shows it); the one it replaces goes to storage.
          if (data.SwapOutItem) notePreEngineeredStored(commanderId, data.ShipID, data.Slot, moduleState);
          takePreEngineeredStored(storedSignature(data.RetrievedItem, data.EngineerModifications, data.Level), moduleState);
          return;
        case 'ModuleBuyAndStore':
          rememberName(data.BuyItem, data.BuyItem_Localised);
          return;
        case 'FetchRemoteModule':
          rememberName(data.StoredItem, data.StoredItem_Localised);
          return;
        case 'StoredModules': {
          for (const item of data.Items ?? []) rememberName(item.Name, item.Name_Localised);
          // Match the listing against the pre-engineered modules seen going into storage. Ones no
          // longer listed (sold from storage, say) are forgotten.
          const unmatched = [...(moduleState.get(PRE_ENGINEERED_STORED_STATE_KEY) ?? [])];
          const matched = [];
          const items = (data.Items ?? []).map((item) => {
            const signature = storedSignature(item.Name, item.EngineerModifications, item.Level);
            const matchIndex = signature ? unmatched.indexOf(signature) : -1;
            if (matchIndex >= 0) matched.push(...unmatched.splice(matchIndex, 1));
            return {
              item: normalizeItem(item.Name),
              name: cleanLocalised(item.Name_Localised),
              starSystem: item.StarSystem ?? null,
              value: item.BuyPrice ?? null,
              isHot: Boolean(item.Hot),
              inTransit: Boolean(item.InTransit),
              blueprint: item.EngineerModifications ?? null,
              level: item.Level ?? null,
              isPreEngineered: matchIndex >= 0,
            };
          });
          moduleState.set(PRE_ENGINEERED_STORED_STATE_KEY, matched);
          upsertStoredModules.run(commanderId, JSON.stringify(items), timestamp);
          return;
        }

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
      SELECT fleet_ships.*, fleet_current_ship.ship_id IS NOT NULL AS is_current, commanders.last_seen AS commander_last_seen
      FROM fleet_ships LEFT JOIN fleet_current_ship
        ON fleet_current_ship.commander_id = fleet_ships.commander_id AND fleet_current_ship.ship_id = fleet_ships.ship_id
      JOIN commanders ON commanders.id = fleet_ships.commander_id
      WHERE fleet_ships.commander_id = ? ORDER BY fleet_ships.sold_at IS NOT NULL, is_current DESC, fleet_ships.ship_id
    `);
    const selectSuits = database.prepare('SELECT * FROM fleet_suits WHERE commander_id = ? ORDER BY sold_at IS NOT NULL, acquired_at');
    const selectWeapons = database.prepare('SELECT * FROM fleet_weapons WHERE commander_id = ? ORDER BY sold_at IS NOT NULL, acquired_at');
    const selectSuitLoadouts = database.prepare('SELECT * FROM fleet_suit_loadouts WHERE commander_id = ? ORDER BY loadout_id');
    const selectVehicles = database.prepare('SELECT * FROM fleet_vehicles WHERE commander_id = ? ORDER BY kind, last_used_at DESC');
    const selectOwnedCounts = database.prepare('SELECT * FROM fleet_owned_counts WHERE commander_id = ?');
    const selectStoredModules = database.prepare('SELECT modules, updated_at FROM fleet_stored_modules WHERE commander_id = ?');

    const selectShipModules = database.prepare('SELECT modules FROM fleet_ships WHERE commander_id = ? AND ship_id = ?');
    /** A ship's last loadout with display names, cosmetic slots left out; null when it hasn't been flown. */
    const describeLoadout = (modulesJson, describeModule) => (modulesJson
      ? JSON.parse(modulesJson).filter((module) => !isCosmeticSlot(module.slot)).map(describeModule)
      : null);

    // GET /api/stats/fleet?commander=<id>
    // Ships (without their loadouts: see /ship), stored modules, suits, weapons, suit loadouts and vehicles.
    router.get('/', (request, response) => {
      const commanderId = requireCommanderId(request, response);
      if (commanderId === null) return;
      const names = new Map(selectNames.all().map((row) => [row.item, row.name]));
      const describeModule = createModuleDescriber(names);
      const ships = selectShips.all(commanderId).map((row) => {
        const modules = describeLoadout(row.modules, describeModule);
        const value = getShipValue(row);
        return {
          shipId: row.ship_id,
          shipType: row.ship_type,
          shipTypeName: names.get(row.ship_type) ?? getShipTypeName(row.ship_type),
          name: row.ship_name,
          ident: row.ship_ident,
          isCurrent: Boolean(row.is_current),
          isSold: Boolean(row.sold_at),
          soldAt: row.sold_at,
          value,
          hullValue: row.hull_value,
          modulesValue: row.modules_value,
          rebuy: row.rebuy,
          hullHealth: row.hull_health,
          maxJumpRange: row.max_jump_range,
          cargoCapacity: row.cargo_capacity,
          fuelCapacity: row.fuel_capacity,
          unladenMass: row.unladen_mass,
          loadoutAt: row.loadout_at,
          // The ship being flown was in use up to the commander's latest journal entry.
          lastFlownAt: row.is_current ? latest(row.last_flown_at, row.commander_last_seen) : row.last_flown_at,
          location: { starSystem: row.star_system, stationName: row.station_name, isInTransit: Boolean(row.in_transit), at: row.location_at },
          isHot: Boolean(row.is_hot),
          firstSeenAt: row.first_seen_at,
          hasLoadout: modules !== null,
          engineeredCount: modules?.filter((module) => module.engineering).length ?? 0,
          preEngineeredCount: modules?.filter((module) => module.engineering?.isPreEngineered).length ?? 0,
          // Only used here, for the hangars; the loadout itself is fetched per ship.
          modules,
        };
      });
      const weapons = selectWeapons.all(commanderId).map((row) => ({
        weaponId: row.weapon_id,
        name: row.name ?? tidyName(row.item),
        class: row.class,
        mods: JSON.parse(row.mods).map(getModificationName),
        price: row.price,
        acquiredAt: row.acquired_at,
        isSold: Boolean(row.sold_at),
        soldAt: row.sold_at,
      }));
      const weaponsById = new Map(weapons.map((weapon) => [weapon.weaponId, weapon]));
      const suits = selectSuits.all(commanderId).map((row) => ({
        suitId: row.suit_id,
        name: getSuitName(row.item),
        class: row.class,
        mods: JSON.parse(row.mods).map(getModificationName),
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
      const storedModulesRow = selectStoredModules.get(commanderId);
      const storedModules = {
        items: storedModulesRow ? JSON.parse(storedModulesRow.modules).map((storedModule) => {
          const described = describeModule({ item: storedModule.item });
          return {
            name: storedModule.name ?? described.name,
            rating: described.rating,
            starSystem: storedModule.starSystem,
            value: storedModule.value,
            isHot: storedModule.isHot,
            inTransit: storedModule.inTransit,
            engineering: storedModule.blueprint
              ? { blueprintName: tidyBlueprint(storedModule.blueprint), level: storedModule.level, isPreEngineered: Boolean(storedModule.isPreEngineered) }
              : null,
          };
        }) : [],
        updatedAt: storedModulesRow?.updated_at ?? null,
      };
      response.json({ ships: ships.map(({ modules, ...ship }) => ship), suits, weapons, suitLoadouts, vehicles, hangars, ownedCounts, storedModules });
    });

    // GET /api/stats/fleet/ship?commander=<id>&ship=<ship id> -> { shipId, modules }
    // One ship's loadout: each module with its name, rating, slot and engineering.
    router.get('/ship', (request, response) => {
      const commanderId = requireCommanderId(request, response);
      if (commanderId === null) return;
      const shipId = Number(request.query.ship);
      const row = Number.isInteger(shipId) ? selectShipModules.get(commanderId, shipId) : null;
      if (!row) {
        response.status(404).json({ error: 'Ship not found' });
        return;
      }
      const describeModule = createModuleDescriber(new Map(selectNames.all().map((nameRow) => [nameRow.item, nameRow.name])));
      response.json({ shipId, modules: describeLoadout(row.modules, describeModule) });
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

/**
 * Fleet totals per commander for the commander overview: ships owned, their value, stored modules
 * and the ship being flown. Keyed by commander id.
 */
export function getFleetSummaries(database) {
  const summaries = new Map();
  const shipRows = database.prepare(`
    SELECT fleet_ships.*, fleet_current_ship.ship_id IS NOT NULL AS is_current, fleet_item_names.name AS localised_type
    FROM fleet_ships
    LEFT JOIN fleet_current_ship ON fleet_current_ship.commander_id = fleet_ships.commander_id AND fleet_current_ship.ship_id = fleet_ships.ship_id
    LEFT JOIN fleet_item_names ON fleet_item_names.item = fleet_ships.ship_type
    WHERE fleet_ships.sold_at IS NULL
  `).all();
  for (const row of shipRows) {
    const summary = summaries.get(row.commander_id) ?? { shipCount: 0, fleetValue: 0, storedModuleCount: 0, currentShip: null };
    summary.shipCount += 1;
    summary.fleetValue += getShipValue(row) ?? 0;
    if (row.is_current) {
      summary.currentShip = {
        shipId: row.ship_id,
        shipTypeName: row.localised_type ?? getShipTypeName(row.ship_type),
        name: row.ship_name,
        ident: row.ship_ident,
        cargoCapacity: row.cargo_capacity,
      };
    }
    summaries.set(row.commander_id, summary);
  }
  for (const row of database.prepare('SELECT commander_id, json_array_length(modules) AS count FROM fleet_stored_modules').all()) {
    const summary = summaries.get(row.commander_id) ?? { shipCount: 0, fleetValue: 0, storedModuleCount: 0, currentShip: null };
    summary.storedModuleCount = row.count;
    summaries.set(row.commander_id, summary);
  }
  return summaries;
}

/** A ship's value: its loadout's (hull + modules) or the shipyard listing's, whichever is newer. */
/** The later of two ISO timestamps, either of which may be missing. */
function latest(first, second) {
  if (!first || !second) return first ?? second ?? null;
  return first > second ? first : second;
}

function getShipValue(row) {
  const loadoutValue = row.hull_value !== null && row.hull_value !== undefined ? row.hull_value + (row.modules_value ?? 0) : null;
  if (loadoutValue === null) return row.stored_value ?? null;
  if (row.stored_value === null || row.stored_value === undefined) return loadoutValue;
  return (row.loadout_at ?? '') >= (row.location_at ?? '') ? loadoutValue : row.stored_value;
}

/** JSON with object keys sorted at every level and no spaces, like Python's json.dumps(sort_keys=True). */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Modules bought already engineered (such as the SCO frame shift drives sold pre-engineered with
 * Increased Range) carry EngineerID 399999 and no engineer's name. Experimental effects added to
 * them later through the Remote Workshop keep it that way.
 */
const NO_ENGINEER_ID = 399999;
function isPreEngineered(engineering) {
  return engineering.EngineerID === NO_ENGINEER_ID && !engineering.Engineer;
}

/** Pre-engineered modules put into storage and not yet taken back out, as storedSignature()s. */
const PRE_ENGINEERED_STORED_STATE_KEY = 'preEngineeredStored';

/** What identifies an engineered module in storage: its item, blueprint and grade. */
function storedSignature(item, blueprint, level) {
  const key = normalizeItem(item);
  return key && blueprint ? `${key}|${blueprint}|${level ?? ''}` : null;
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
      isPreEngineered: isPreEngineered(engineering),
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

