import { Router } from 'express';
import { defineStatModule } from '../define-stat-module.mjs';
import { describeMaterial } from '../material-data.mjs';
import { getCommanderIdFilter } from '../query-helpers.mjs';

/**
 * Latest snapshot of each commander's assets: credits, ships, stored modules, materials,
 * on-foot inventory and cargo.
 *
 * Materials are listed in full only at login; changes after that (collecting, discarding, trading,
 * crafting, synthesis, engineer unlocks, tech brokers and mission rewards) are applied to the
 * snapshot so the counts stay current.
 */
export default defineStatModule({
  name: 'assets',
  title: 'Commander Assets',
  description: 'Credits, ships, stored modules, materials, ship locker and cargo (latest snapshot of each).',
  version: 3,
  events: [
    'LoadGame', 'Statistics', 'CarrierBankTransfer', 'Loadout', 'StoredShips', 'StoredModules', 'Materials', 'ShipLocker', 'Cargo',
    'Backpack', 'MaterialCollected', 'MaterialDiscarded', 'MaterialTrade', 'EngineerCraft', 'Synthesis', 'TechnologyBroker',
    'EngineerContribution', 'MissionCompleted',
  ],
  ownedObjects: [{ type: 'table', name: 'commander_assets' }],
  schemaSql: `
    CREATE TABLE IF NOT EXISTS commander_assets (
      commander_id  INTEGER NOT NULL REFERENCES commanders(id),
      asset_type    TEXT NOT NULL,   -- balance | current_ship | stored_ships | stored_modules | materials | ship_locker | backpack | cargo
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

    // Adds (or with a negative count, takes away) materials from the snapshot. Without a category,
    // the material is looked up in every category.
    const changeMaterials = (commanderId, timestamp, changes) => {
      const existingRow = selectAsset.get(commanderId, 'materials');
      if (!existingRow) return;
      const materials = JSON.parse(existingRow.data);
      for (const { name, localisedName, category, count } of changes) {
        const key = String(name ?? '').toLowerCase();
        if (!key || !Number.isFinite(count) || count === 0) continue;
        const categoryKey = toMaterialCategory(category);
        const categoryKeys = categoryKey ? [categoryKey] : ['raw', 'manufactured', 'encoded'];
        let material = categoryKeys.flatMap((candidate) => materials[candidate] ?? []).find((item) => item.key === key);
        if (!material && categoryKey && count > 0) {
          material = { key, name: localisedName ?? name, count: 0 };
          materials[categoryKey] = [...(materials[categoryKey] ?? []), material];
        }
        if (!material) continue;
        // The game won't hold more than the grade's cap.
        const maxCount = describeMaterial(key)?.maxCount ?? Infinity;
        material.count = Math.min(maxCount, Math.max(0, material.count + count));
        if (localisedName && material.name === material.key) material.name = localisedName;
      }
      saveAsset(commanderId, 'materials', timestamp, materials);
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
        case 'Backpack':
          // Events without contents just point at ShipLocker.json/Backpack.json; ignore those.
          if (Array.isArray(data.Items)) {
            saveAsset(commanderId, event === 'Backpack' ? 'backpack' : 'ship_locker', timestamp, {
              items: summarizeMaterials(data.Items),
              components: summarizeMaterials(data.Components),
              consumables: summarizeMaterials(data.Consumables),
              data: summarizeMaterials(data.Data),
            });
          }
          break;

        case 'MaterialCollected':
          changeMaterials(commanderId, timestamp, [{ name: data.Name, localisedName: data.Name_Localised, category: data.Category, count: data.Count ?? 0 }]);
          break;
        case 'MaterialDiscarded':
          changeMaterials(commanderId, timestamp, [{ name: data.Name, localisedName: data.Name_Localised, category: data.Category, count: -(data.Count ?? 0) }]);
          break;
        case 'MaterialTrade':
          changeMaterials(commanderId, timestamp, [
            { name: data.Paid?.Material, localisedName: data.Paid?.Material_Localised, category: data.Paid?.Category, count: -(data.Paid?.Quantity ?? 0) },
            { name: data.Received?.Material, localisedName: data.Received?.Material_Localised, category: data.Received?.Category, count: data.Received?.Quantity ?? 0 },
          ]);
          break;
        case 'EngineerCraft':
          changeMaterials(commanderId, timestamp, (data.Ingredients ?? []).map((item) => ({ name: item.Name, localisedName: item.Name_Localised, count: -(item.Count ?? 0) })));
          break;
        case 'Synthesis':
          changeMaterials(commanderId, timestamp, (data.Materials ?? []).map((item) => ({ name: item.Name, localisedName: item.Name_Localised, count: -(item.Count ?? 0) })));
          break;
        case 'TechnologyBroker':
          changeMaterials(commanderId, timestamp, (data.Materials ?? []).map((item) => ({ name: item.Name, localisedName: item.Name_Localised, category: item.Category, count: -(item.Count ?? 0) })));
          break;
        case 'EngineerContribution':
          if (data.Type === 'Materials') {
            changeMaterials(commanderId, timestamp, [{ name: data.Material, localisedName: data.Material_Localised, count: -(data.Quantity ?? 0) }]);
          }
          break;
        case 'MissionCompleted':
          if (Array.isArray(data.MaterialsReward)) {
            changeMaterials(commanderId, timestamp, data.MaterialsReward.map((item) => ({
              name: item.Name, localisedName: item.Name_Localised, category: item.Category_Localised ?? item.Category, count: item.Count ?? 0,
            })));
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
      if (commanderAssets.materials) {
        // Each material with its grade, family (material trader group) and storage cap.
        commanderAssets.materials = Object.fromEntries(Object.entries(commanderAssets.materials).map(([category, items]) => [
          category,
          items.map((item) => {
            const info = describeMaterial(item.key);
            return { ...item, grade: info?.grade ?? null, family: info?.family ?? guessSpecialFamily(item.key), maxCount: info?.maxCount ?? null };
          }),
        ]));
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
    key: String(material.Name ?? '').toLowerCase(),
    name: material.Name_Localised ?? material.Name,
    count: material.Count,
  }));
}

/** "Raw", "$MICRORESOURCE_CATEGORY_Encoded;" -> "raw", "encoded"; null when it isn't a material category. */
function toMaterialCategory(category) {
  const match = /(raw|manufactured|encoded)/i.exec(category ?? '');
  return match ? match[1].toLowerCase() : null;
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

/** Guardian and Thargoid materials without a known grade still group with their kind. */
function guessSpecialFamily(key) {
  if (/^guardian_|^ancient/.test(key ?? '')) return 'Guardian';
  if (/^tg_|^unknown/.test(key ?? '')) return 'Thargoid';
  return 'Other';
}

function toCamelCase(snakeCaseText) {
  return snakeCaseText.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
}
