import { Router } from 'express';
import { defineStatModule } from '../define-stat-module.mjs';
import { getCommanderIdFilter } from '../query-helpers.mjs';

/**
 * Latest snapshot of each commander's assets: credits, ships, stored modules, materials,
 * on-foot inventory and cargo.
 */
export default defineStatModule({
  name: 'assets',
  title: 'Commander Assets',
  description: 'Credits, ships, stored modules, materials, ship locker and cargo (latest snapshot of each).',
  version: 1,
  events: ['LoadGame', 'Statistics', 'CarrierBankTransfer', 'Loadout', 'StoredShips', 'StoredModules', 'Materials', 'ShipLocker', 'Cargo'],
  ownedObjects: [{ type: 'table', name: 'commander_assets' }],
  schemaSql: `
    CREATE TABLE IF NOT EXISTS commander_assets (
      commander_id  INTEGER NOT NULL REFERENCES commanders(id),
      asset_type    TEXT NOT NULL,   -- balance | current_ship | stored_ships | stored_modules | materials | ship_locker | cargo
      data          TEXT NOT NULL,
      updated_at    TEXT,
      PRIMARY KEY (commander_id, asset_type)
    );
  `,

  createProcessor(database) {
    const selectAsset = database.prepare('SELECT data FROM commander_assets WHERE commander_id = ? AND asset_type = ?');
    const upsertAsset = database.prepare(`
      INSERT INTO commander_assets (commander_id, asset_type, data, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (commander_id, asset_type) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `);

    const saveAsset = (commanderId, assetType, timestamp, assetData) => {
      upsertAsset.run(commanderId, assetType, JSON.stringify(assetData), timestamp);
    };

    const mergeBalance = (commanderId, timestamp, balanceChanges) => {
      const existingRow = selectAsset.get(commanderId, 'balance');
      const existingBalance = existingRow ? JSON.parse(existingRow.data) : {};
      saveAsset(commanderId, 'balance', timestamp, { ...existingBalance, ...balanceChanges });
    };

    return ({ commanderId, event, timestamp, data }) => {
      switch (event) {
        case 'LoadGame':
          mergeBalance(commanderId, timestamp, { credits: data.Credits ?? null, loan: data.Loan ?? 0, creditsUpdatedAt: timestamp });
          break;

        case 'CarrierBankTransfer':
          if (data.PlayerBalance !== undefined) {
            mergeBalance(commanderId, timestamp, { credits: data.PlayerBalance, creditsUpdatedAt: timestamp });
          }
          break;

        case 'Statistics':
          if (data.Bank_Account) {
            mergeBalance(commanderId, timestamp, {
              currentWealth: data.Bank_Account.Current_Wealth ?? null,
              ownedShipCount: data.Bank_Account.Owned_Ship_Count ?? null,
              wealthUpdatedAt: timestamp,
            });
          }
          break;

        case 'Loadout':
          saveAsset(commanderId, 'current_ship', timestamp, {
            shipId: data.ShipID,
            shipType: data.Ship,
            shipName: data.ShipName || null,
            shipIdent: data.ShipIdent || null,
            hullValue: data.HullValue ?? null,
            modulesValue: data.ModulesValue ?? null,
            rebuy: data.Rebuy ?? null,
            maxJumpRange: data.MaxJumpRange ?? null,
            cargoCapacity: data.CargoCapacity ?? null,
            moduleCount: data.Modules?.length ?? 0,
          });
          break;

        case 'StoredShips':
          saveAsset(commanderId, 'stored_ships', timestamp, {
            stationName: data.StationName ?? null,
            starSystem: data.StarSystem ?? null,
            shipsHere: (data.ShipsHere ?? []).map((ship) => ({ ...summarizeStoredShip(ship), starSystem: data.StarSystem, stationName: data.StationName })),
            shipsRemote: (data.ShipsRemote ?? []).map(summarizeStoredShip),
          });
          break;

        case 'StoredModules':
          saveAsset(commanderId, 'stored_modules', timestamp, {
            items: (data.Items ?? []).map((storedModule) => ({
              name: storedModule.Name_Localised ?? storedModule.Name,
              slot: storedModule.StorageSlot,
              starSystem: storedModule.StarSystem ?? null,
              value: storedModule.BuyPrice ?? null,
              isHot: Boolean(storedModule.Hot),
              engineering: storedModule.EngineerModifications ?? null,
              engineeringLevel: storedModule.Level ?? null,
              inTransit: Boolean(storedModule.InTransit),
            })),
          });
          break;

        case 'Materials':
          saveAsset(commanderId, 'materials', timestamp, {
            raw: summarizeMaterials(data.Raw),
            manufactured: summarizeMaterials(data.Manufactured),
            encoded: summarizeMaterials(data.Encoded),
          });
          break;

        case 'ShipLocker':
          // ShipLocker events without contents just point at ShipLocker.json; ignore those.
          if (Array.isArray(data.Items)) {
            saveAsset(commanderId, 'ship_locker', timestamp, {
              items: summarizeMaterials(data.Items),
              components: summarizeMaterials(data.Components),
              consumables: summarizeMaterials(data.Consumables),
              data: summarizeMaterials(data.Data),
            });
          }
          break;

        case 'Cargo':
          if (data.Vessel === 'Ship' && Array.isArray(data.Inventory)) {
            saveAsset(commanderId, 'cargo', timestamp, {
              count: data.Count ?? 0,
              inventory: data.Inventory.map((cargoItem) => ({
                name: cargoItem.Name_Localised ?? cargoItem.Name,
                count: cargoItem.Count,
                stolen: cargoItem.Stolen ?? 0,
                missionId: cargoItem.MissionID ?? null,
              })),
            });
          }
          break;
      }
    };
  },

  createRouter(database) {
    const router = Router();
    const selectAssetRows = database.prepare(`
      SELECT commanders.id AS commander_id, commanders.name AS commander_name, assets.asset_type, assets.data, assets.updated_at
      FROM commanders
      LEFT JOIN commander_assets AS assets ON assets.commander_id = commanders.id
      WHERE (?1 IS NULL OR commanders.id = ?1)
      ORDER BY commanders.name
    `);

    const loadCommanderAssets = (commanderIdFilter) => {
      const assetsByCommander = new Map();
      for (const assetRow of selectAssetRows.all(commanderIdFilter)) {
        if (!assetsByCommander.has(assetRow.commander_id)) {
          assetsByCommander.set(assetRow.commander_id, { commanderId: assetRow.commander_id, commanderName: assetRow.commander_name, updatedAt: {} });
        }
        if (!assetRow.asset_type) continue;
        const commanderAssets = assetsByCommander.get(assetRow.commander_id);
        commanderAssets[toCamelCase(assetRow.asset_type)] = JSON.parse(assetRow.data);
        commanderAssets.updatedAt[toCamelCase(assetRow.asset_type)] = assetRow.updated_at;
      }
      return [...assetsByCommander.values()].map((commanderAssets) => ({ ...commanderAssets, fleet: buildFleet(commanderAssets) }));
    };

    // GET /api/stats/assets?commander= -> summary per commander plus combined totals
    router.get('/', (request, response) => {
      const commanderSummaries = loadCommanderAssets(getCommanderIdFilter(request.query)).map(summarizeCommanderAssets);
      const combined = {
        credits: sumBy(commanderSummaries, 'credits'),
        currentWealth: sumBy(commanderSummaries, 'currentWealth'),
        shipCount: sumBy(commanderSummaries, 'shipCount'),
        fleetValue: sumBy(commanderSummaries, 'fleetValue'),
        storedModuleCount: sumBy(commanderSummaries, 'storedModuleCount'),
        materialCount: sumBy(commanderSummaries, 'materialCount'),
        shipLockerCount: sumBy(commanderSummaries, 'shipLockerCount'),
        cargoCount: sumBy(commanderSummaries, 'cargoCount'),
      };
      response.json({ combined, perCommander: commanderSummaries });
    });

    // GET /api/stats/assets/:commanderId -> full asset details for one commander
    router.get('/:commanderId', (request, response) => {
      const [commanderAssets] = loadCommanderAssets(Number(request.params.commanderId));
      if (!commanderAssets) {
        response.status(404).json({ error: 'Commander not found' });
        return;
      }
      response.json(commanderAssets);
    });

    return router;
  },
});

function summarizeStoredShip(storedShip) {
  return {
    shipId: storedShip.ShipID,
    shipType: storedShip.ShipType_Localised ?? storedShip.ShipType,
    shipName: storedShip.Name || null,
    starSystem: storedShip.StarSystem ?? null,
    value: storedShip.Value ?? 0,
    isHot: Boolean(storedShip.Hot),
    inTransit: Boolean(storedShip.InTransit),
  };
}

function summarizeMaterials(materials) {
  return (materials ?? []).map((material) => ({
    name: material.Name_Localised ?? material.Name,
    count: material.Count,
  }));
}

/** Combines the current ship and stored ships into one fleet list. */
function buildFleet(commanderAssets) {
  const fleetByShipId = new Map();
  const storedShips = [...(commanderAssets.storedShips?.shipsHere ?? []), ...(commanderAssets.storedShips?.shipsRemote ?? [])];
  for (const storedShip of storedShips) fleetByShipId.set(storedShip.shipId, { ...storedShip, isCurrent: false });

  const currentShip = commanderAssets.currentShip;
  if (currentShip) {
    fleetByShipId.set(currentShip.shipId, {
      shipId: currentShip.shipId,
      shipType: currentShip.shipType,
      shipName: currentShip.shipName,
      starSystem: null,
      value: (currentShip.hullValue ?? 0) + (currentShip.modulesValue ?? 0),
      isHot: false,
      inTransit: false,
      isCurrent: true,
    });
  }

  return [...fleetByShipId.values()].sort((first, second) => second.value - first.value);
}

function summarizeCommanderAssets(commanderAssets) {
  const countItems = (items) => (items ?? []).reduce((total, item) => total + (item.count ?? 0), 0);
  const materials = commanderAssets.materials ?? {};
  const shipLocker = commanderAssets.shipLocker ?? {};
  return {
    commanderId: commanderAssets.commanderId,
    commanderName: commanderAssets.commanderName,
    credits: commanderAssets.balance?.credits ?? null,
    loan: commanderAssets.balance?.loan ?? 0,
    currentWealth: commanderAssets.balance?.currentWealth ?? null,
    currentShip: commanderAssets.currentShip ?? null,
    shipCount: commanderAssets.fleet.length,
    fleetValue: commanderAssets.fleet.reduce((total, ship) => total + (ship.value ?? 0), 0),
    storedModuleCount: commanderAssets.storedModules?.items.length ?? 0,
    materialCount: countItems(materials.raw) + countItems(materials.manufactured) + countItems(materials.encoded),
    shipLockerCount: countItems(shipLocker.items) + countItems(shipLocker.components) + countItems(shipLocker.consumables) + countItems(shipLocker.data),
    cargoCount: commanderAssets.cargo?.count ?? 0,
    updatedAt: commanderAssets.updatedAt,
  };
}

function sumBy(rows, propertyName) {
  return rows.reduce((total, row) => total + (row[propertyName] ?? 0), 0);
}

function toCamelCase(snakeCaseText) {
  return snakeCaseText.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
}
