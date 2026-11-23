import { Router } from 'express';
import { defineStatModule } from '../define-stat-module.mjs';
import { describeMaterial } from '../../game-data/materials.mjs';
import { capitalizeName } from '../../game-data/names.mjs';
import { requireCommanderId } from '../query-helpers.mjs';

/**
 * Each commander's inventory: engineering materials, on-foot items in the ship locker and backpack,
 * and the ship's cargo (the latest snapshot of each).
 *
 * Materials are listed in full only at login; changes after that (collecting, discarding, trading,
 * crafting, synthesis, engineer unlocks, tech brokers and mission rewards) are applied to the
 * snapshot so the counts stay current, never above a grade's storage cap.
 */
const ON_FOOT_CATEGORIES = ['items', 'components', 'consumables', 'data'];
const MATERIAL_CATEGORIES = ['raw', 'manufactured', 'encoded'];

export default defineStatModule({
  name: 'inventory',
  title: 'Inventory',
  description: 'Materials, ship locker, backpack and cargo (latest snapshot of each).',
  version: 1,
  events: [
    'Materials', 'MaterialCollected', 'MaterialDiscarded', 'MaterialTrade', 'EngineerCraft', 'Synthesis', 'TechnologyBroker',
    'EngineerContribution', 'MissionCompleted', 'ShipLocker', 'Backpack', 'Cargo',
  ],
  ownedObjects: [{ type: 'table', name: 'inventory_snapshots' }],
  schemaSql: `
    CREATE TABLE IF NOT EXISTS inventory_snapshots (
      commander_id  INTEGER NOT NULL REFERENCES commanders(id),
      kind          TEXT NOT NULL,   -- materials | ship_locker | backpack | cargo
      data          TEXT NOT NULL,
      updated_at    TEXT,
      PRIMARY KEY (commander_id, kind)
    );
  `,

  createProcessor(database) {
    const selectSnapshot = database.prepare('SELECT data FROM inventory_snapshots WHERE commander_id = ? AND kind = ?');
    const upsertSnapshot = database.prepare(`
      INSERT INTO inventory_snapshots (commander_id, kind, data, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (commander_id, kind) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `);
    const saveSnapshot = (commanderId, kind, timestamp, snapshot) => upsertSnapshot.run(commanderId, kind, JSON.stringify(snapshot), timestamp);

    // Adds (or with a negative count, takes away) materials from the snapshot. Without a category,
    // the material is looked up in every category.
    const changeMaterials = (commanderId, timestamp, changes) => {
      const existingRow = selectSnapshot.get(commanderId, 'materials');
      if (!existingRow) return;
      const materials = JSON.parse(existingRow.data);
      for (const { name, localisedName, category, count } of changes) {
        const key = String(name ?? '').toLowerCase();
        if (!key || !Number.isFinite(count) || count === 0) continue;
        const categoryKey = toMaterialCategory(category);
        const categoryKeys = categoryKey ? [categoryKey] : MATERIAL_CATEGORIES;
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
      saveSnapshot(commanderId, 'materials', timestamp, materials);
    };

    return ({ commanderId, event, timestamp, data }) => {
      switch (event) {
        case 'Materials':
          saveSnapshot(commanderId, 'materials', timestamp, {
            raw: summarizeItems(data.Raw),
            manufactured: summarizeItems(data.Manufactured),
            encoded: summarizeItems(data.Encoded),
          });
          return;
        case 'MaterialCollected':
          changeMaterials(commanderId, timestamp, [{ name: data.Name, localisedName: data.Name_Localised, category: data.Category, count: data.Count ?? 0 }]);
          return;
        case 'MaterialDiscarded':
          changeMaterials(commanderId, timestamp, [{ name: data.Name, localisedName: data.Name_Localised, category: data.Category, count: -(data.Count ?? 0) }]);
          return;
        case 'MaterialTrade':
          changeMaterials(commanderId, timestamp, [
            { name: data.Paid?.Material, localisedName: data.Paid?.Material_Localised, category: data.Paid?.Category, count: -(data.Paid?.Quantity ?? 0) },
            { name: data.Received?.Material, localisedName: data.Received?.Material_Localised, category: data.Received?.Category, count: data.Received?.Quantity ?? 0 },
          ]);
          return;
        case 'EngineerCraft':
          changeMaterials(commanderId, timestamp, (data.Ingredients ?? []).map((item) => ({ name: item.Name, localisedName: item.Name_Localised, count: -(item.Count ?? 0) })));
          return;
        case 'Synthesis':
          changeMaterials(commanderId, timestamp, (data.Materials ?? []).map((item) => ({ name: item.Name, localisedName: item.Name_Localised, count: -(item.Count ?? 0) })));
          return;
        case 'TechnologyBroker':
          changeMaterials(commanderId, timestamp, (data.Materials ?? []).map((item) => ({ name: item.Name, localisedName: item.Name_Localised, category: item.Category, count: -(item.Count ?? 0) })));
          return;
        case 'EngineerContribution':
          if (data.Type === 'Materials') {
            changeMaterials(commanderId, timestamp, [{ name: data.Material, localisedName: data.Material_Localised, count: -(data.Quantity ?? 0) }]);
          }
          return;
        case 'MissionCompleted':
          if (Array.isArray(data.MaterialsReward)) {
            changeMaterials(commanderId, timestamp, data.MaterialsReward.map((item) => ({
              name: item.Name, localisedName: item.Name_Localised, category: item.Category_Localised ?? item.Category, count: item.Count ?? 0,
            })));
          }
          return;

        case 'ShipLocker':
        case 'Backpack':
          // Events without contents just point at ShipLocker.json/Backpack.json; ignore those.
          if (Array.isArray(data.Items)) {
            saveSnapshot(commanderId, event === 'Backpack' ? 'backpack' : 'ship_locker', timestamp, Object.fromEntries(
              ON_FOOT_CATEGORIES.map((category) => [category, summarizeItems(data[category.charAt(0).toUpperCase() + category.slice(1)])]),
            ));
          }
          return;

        case 'Cargo':
          if (data.Vessel === 'Ship' && Array.isArray(data.Inventory)) {
            saveSnapshot(commanderId, 'cargo', timestamp, {
              count: data.Count ?? 0,
              inventory: data.Inventory.map((cargoItem) => ({
                name: cargoItem.Name_Localised ?? cargoItem.Name,
                count: cargoItem.Count,
                stolen: cargoItem.Stolen ?? 0,
                missionId: cargoItem.MissionID ?? null,
              })),
            });
          }
          return;
      }
    };
  },

  createRouter(database) {
    const router = Router();
    const selectSnapshots = database.prepare('SELECT kind, data, updated_at FROM inventory_snapshots WHERE commander_id = ?');

    // GET /api/stats/inventory?commander=<id>
    // Materials (with grade, family and storage cap), ship locker, backpack and cargo, with display
    // names, and when each was last updated.
    router.get('/', (request, response) => {
      const commanderId = requireCommanderId(request, response);
      if (commanderId === null) return;
      const inventory = { materials: null, shipLocker: null, backpack: null, cargo: null, updatedAt: {} };
      for (const row of selectSnapshots.all(commanderId)) {
        const key = row.kind === 'ship_locker' ? 'shipLocker' : row.kind;
        inventory[key] = JSON.parse(row.data);
        inventory.updatedAt[key] = row.updated_at;
      }
      if (inventory.materials) {
        inventory.materials = Object.fromEntries(MATERIAL_CATEGORIES.map((category) => [
          category,
          (inventory.materials[category] ?? []).map((item) => {
            const info = describeMaterial(item.key);
            return { ...item, name: capitalizeName(item.name), grade: info?.grade ?? null, family: info?.family ?? guessSpecialFamily(item.key), maxCount: info?.maxCount ?? null };
          }),
        ]));
      }
      for (const key of ['shipLocker', 'backpack']) {
        if (!inventory[key]) continue;
        inventory[key] = Object.fromEntries(ON_FOOT_CATEGORIES.map((category) => [
          category, (inventory[key][category] ?? []).map((item) => ({ ...item, name: capitalizeName(item.name) })),
        ]));
      }
      if (inventory.cargo) {
        inventory.cargo = { ...inventory.cargo, inventory: inventory.cargo.inventory.map((item) => ({ ...item, name: capitalizeName(item.name) })) };
      }
      response.json(inventory);
    });

    return router;
  },
});

/**
 * Item totals per commander for the commander overview: materials, ship locker items and cargo
 * tonnes. Keyed by commander id.
 */
export function getInventoryCounts(database) {
  const counts = new Map();
  const countItems = (items) => (items ?? []).reduce((total, item) => total + (item.count ?? 0), 0);
  for (const row of database.prepare('SELECT commander_id, kind, data FROM inventory_snapshots').all()) {
    const entry = counts.get(row.commander_id) ?? { materialCount: 0, shipLockerCount: 0, cargoCount: 0 };
    const snapshot = JSON.parse(row.data);
    if (row.kind === 'materials') entry.materialCount = MATERIAL_CATEGORIES.reduce((total, category) => total + countItems(snapshot[category]), 0);
    if (row.kind === 'ship_locker') entry.shipLockerCount = ON_FOOT_CATEGORIES.reduce((total, category) => total + countItems(snapshot[category]), 0);
    if (row.kind === 'cargo') entry.cargoCount = snapshot.count ?? 0;
    counts.set(row.commander_id, entry);
  }
  return counts;
}

function summarizeItems(items) {
  return (items ?? []).map((item) => ({
    key: String(item.Name ?? '').toLowerCase(),
    name: item.Name_Localised ?? item.Name,
    count: item.Count,
  }));
}

/** "Raw", "$MICRORESOURCE_CATEGORY_Encoded;" -> "raw", "encoded"; null when it isn't a material category. */
function toMaterialCategory(category) {
  const match = /(raw|manufactured|encoded)/i.exec(category ?? '');
  return match ? match[1].toLowerCase() : null;
}

/** Guardian and Thargoid materials without a known grade still group with their kind. */
function guessSpecialFamily(key) {
  if (/^guardian_|^ancient/.test(key ?? '')) return 'Guardian';
  if (/^tg_|^unknown/.test(key ?? '')) return 'Thargoid';
  return 'Other';
}
