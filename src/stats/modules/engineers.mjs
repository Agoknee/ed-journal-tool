import { Router } from 'express';
import { defineStatModule } from '../define-stat-module.mjs';
import { requireCommanderId } from '../query-helpers.mjs';
import { getEngineerInfo } from '../../game-data/engineers.mjs';
import { tidySlot } from '../../game-data/modules.mjs';
import { tidyBlueprint } from '../../game-data/names.mjs';
import { getShipTypeName } from '../../game-data/ships.mjs';

/**
 * Each commander's standing with the engineers (EngineerProgress: known, invited, acquainted,
 * unlocked or barred, with rank and progress to the next), every blueprint they've had crafted,
 * and the engineered modules on their ships (from the fleet module).
 *
 * Pinned blueprints aren't in the journal, so they can't be shown.
 */
// Crafts done remotely (experimental effects applied away from an engineer) use this id, with no name.
const REMOTE_WORKSHOP_ID = 399999;
// On-foot (Odyssey) engineers upgrade suits and weapons rather than ship modules.
const ON_FOOT_ENGINEER_IDS = new Set([400001, 400002, 400003, 400004, 400005, 400006, 400007, 400008, 400009, 400010, 400011, 400012, 400013]);

export default defineStatModule({
  name: 'engineers',
  title: 'Engineers',
  description: 'Engineer unlocks and ranks, blueprints crafted and engineered modules.',
  version: 2,
  dependsOn: ['fleet'],
  events: ['EngineerProgress', 'EngineerCraft'],
  ownedObjects: [
    { type: 'table', name: 'engineer_progress' },
    { type: 'table', name: 'engineer_crafts' },
  ],
  schemaSql: `
    CREATE TABLE IF NOT EXISTS engineer_progress (
      commander_id   INTEGER NOT NULL REFERENCES commanders(id),
      engineer_id    INTEGER NOT NULL,
      engineer       TEXT NOT NULL,
      progress       TEXT,          -- Known | Invited | Acquainted | Unlocked | Barred
      rank           INTEGER,
      rank_progress  INTEGER,       -- percent towards the next rank
      unlocked_at    TEXT,
      updated_at     TEXT,
      PRIMARY KEY (commander_id, engineer_id)
    );
    CREATE TABLE IF NOT EXISTS engineer_crafts (
      commander_id  INTEGER NOT NULL REFERENCES commanders(id),
      engineer_id   INTEGER NOT NULL,
      blueprint     TEXT NOT NULL,
      level         INTEGER NOT NULL,
      craft_count   INTEGER NOT NULL DEFAULT 0,
      experimentals INTEGER NOT NULL DEFAULT 0,
      last_module   TEXT,
      last_at       TEXT,
      PRIMARY KEY (commander_id, engineer_id, blueprint, level)
    );
  `,

  createProcessor(database) {
    const upsertProgress = database.prepare(`
      INSERT INTO engineer_progress (commander_id, engineer_id, engineer, progress, rank, rank_progress, unlocked_at, updated_at)
      VALUES (:commanderId, :engineerId, :engineer, :progress, :rank, :rankProgress, CASE WHEN :progress = 'Unlocked' THEN :at END, :at)
      ON CONFLICT (commander_id, engineer_id) DO UPDATE SET engineer = excluded.engineer, progress = excluded.progress,
        rank = COALESCE(excluded.rank, rank), rank_progress = COALESCE(excluded.rank_progress, rank_progress),
        unlocked_at = COALESCE(unlocked_at, excluded.unlocked_at), updated_at = excluded.updated_at
    `);
    const addCraft = database.prepare(`
      INSERT INTO engineer_crafts (commander_id, engineer_id, blueprint, level, craft_count, experimentals, last_module, last_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (commander_id, engineer_id, blueprint, level) DO UPDATE SET craft_count = craft_count + excluded.craft_count,
        experimentals = experimentals + excluded.experimentals, last_module = excluded.last_module, last_at = excluded.last_at
    `);

    const saveProgress = (commanderId, timestamp, engineer) => {
      if (!Number.isInteger(engineer.EngineerID)) return;
      upsertProgress.run({
        commanderId,
        engineerId: engineer.EngineerID,
        engineer: engineer.Engineer ?? (engineer.EngineerID === REMOTE_WORKSHOP_ID ? 'Remote Workshop' : String(engineer.EngineerID)),
        progress: engineer.Progress ?? null,
        rank: engineer.Rank ?? null,
        rankProgress: engineer.RankProgress ?? null,
        at: timestamp,
      });
    };

    return ({ commanderId, event, timestamp, data }) => {
      switch (event) {
        case 'EngineerProgress':
          // Either the full list (at login) or one engineer whose standing changed.
          if (Array.isArray(data.Engineers)) for (const engineer of data.Engineers) saveProgress(commanderId, timestamp, engineer);
          else saveProgress(commanderId, timestamp, data);
          return;
        case 'EngineerCraft':
          if (!Number.isInteger(data.EngineerID) || !data.BlueprintName) return;
          addCraft.run(
            commanderId, data.EngineerID, data.BlueprintName, data.Level ?? 0, 1,
            data.ApplyExperimentalEffect ? 1 : 0, data.Module ?? null, timestamp,
          );
          // A craft means the engineer is unlocked, if the progress event hasn't said so yet.
          saveProgress(commanderId, timestamp, { EngineerID: data.EngineerID, Engineer: data.Engineer, Progress: 'Unlocked' });
          return;
      }
    };
  },

  createRouter(database) {
    const router = Router();
    const selectProgress = database.prepare('SELECT * FROM engineer_progress WHERE commander_id = ? ORDER BY engineer');
    const selectCrafts = database.prepare('SELECT * FROM engineer_crafts WHERE commander_id = ? ORDER BY last_at DESC');
    const selectShipModules = database.prepare(`
      SELECT ship_id, ship_type, ship_name, modules FROM fleet_ships WHERE commander_id = ? AND sold_at IS NULL AND modules IS NOT NULL
    `);

    // GET /api/stats/engineers?commander=<id>
    router.get('/', (request, response) => {
      const commanderId = requireCommanderId(request, response);
      if (commanderId === null) return;
      const crafts = selectCrafts.all(commanderId);
      // Engineered modules on the ships the commander still owns, by engineer name. Pre-engineered
      // ones have no engineer; they're only counted.
      const modulesByEngineer = new Map();
      let preEngineeredModuleCount = 0;
      for (const ship of selectShipModules.all(commanderId)) {
        for (const module of JSON.parse(ship.modules)) {
          if (module.engineering?.isPreEngineered) preEngineeredModuleCount += 1;
          const engineer = module.engineering?.engineer;
          if (!engineer) continue;
          if (!modulesByEngineer.has(engineer)) modulesByEngineer.set(engineer, []);
          modulesByEngineer.get(engineer).push({
            shipId: ship.ship_id, shipName: ship.ship_name, shipType: getShipTypeName(ship.ship_type), slot: tidySlot(module.slot), item: module.item,
            blueprint: tidyBlueprint(module.engineering.blueprint), level: module.engineering.level, experimental: module.engineering.experimental,
          });
        }
      }
      const engineers = selectProgress.all(commanderId).map((row) => {
        const engineerCrafts = crafts.filter((craft) => craft.engineer_id === row.engineer_id);
        const info = getEngineerInfo(row.engineer);
        return {
          engineerId: row.engineer_id,
          engineer: row.engineer,
          system: info?.system ?? null,
          imageId: info?.imageId ?? null,
          modifications: info?.modifications ?? [],
          isOnFoot: ON_FOOT_ENGINEER_IDS.has(row.engineer_id),
          isRemoteWorkshop: row.engineer_id === REMOTE_WORKSHOP_ID,
          progress: row.progress,
          rank: row.rank,
          rankProgress: row.rank_progress,
          unlockedAt: row.unlocked_at,
          updatedAt: row.updated_at,
          craftCount: engineerCrafts.reduce((total, craft) => total + craft.craft_count, 0),
          lastCraftAt: engineerCrafts[0]?.last_at ?? null,
          blueprints: engineerCrafts.map((craft) => ({
            blueprint: tidyBlueprint(craft.blueprint), level: craft.level, craftCount: craft.craft_count, experimentals: craft.experimentals, lastAt: craft.last_at,
          })),
          modules: modulesByEngineer.get(row.engineer) ?? [],
        };
      });
      response.json({ engineers, preEngineeredModuleCount, pinnedBlueprints: null });
    });

    return router;
  },
});
