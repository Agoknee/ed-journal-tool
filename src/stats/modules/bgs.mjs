import { Router } from 'express';
import { defineStatModule } from '../define-stat-module.mjs';
import { getDockedLocation, trackDockingState } from '../docking-state.mjs';
import { getCommanderIdFilter } from '../query-helpers.mjs';

/**
 * Background simulation (BGS) activity, modelled on the BGS-Tally EDMC plugin: what each commander
 * did for or against each faction, per system, grouped by BGS tick on the dashboard.
 *
 * Every contributing action is stored as a row in bgs_activity:
 *   inf            mission influence; value = signed + count, detail = primary | secondary
 *   bounty         bounty vouchers redeemed (credits; halved at fleet carriers, as BGS-Tally does)
 *   combat_bond    combat bonds redeemed (credits)
 *   trade_buy      commodities bought (credits spent)
 *   trade_profit   commodities sold at a market (profit)
 *   black_market   commodities sold at a black market (profit)
 *   exploration    cartographic data sold (credits)
 *   organic        exobiology data sold (credits)
 *   murder         ships of the faction killed illegally (count)
 *   ground_murder  on-foot murders against the faction (count)
 *   mission_failed failed missions for the faction (count)
 *   space_cz       space conflict zones fought in; detail = l | m | h
 *   ground_cz      ground conflict zones fought in; detail = l | m | h
 *   space_cz_objective  space conflict zone objectives; detail = cs (capital ship) | so (spec ops wing)
 *                  | cp (captain) | pr (propagandist)
 *   search_rescue  search and rescue items handed in (count)
 *   scenario       in-space installation scenarios won (count); never tracked, only entered manually
 *
 * Activity at a station counts for the station's controlling faction in the current system, and
 * (like BGS-Tally) only for factions present in that system. Mission influence goes to the system
 * each influence effect names, which may not be where the mission was taken.
 *
 * bgs_system_states keeps each system's faction list and conflicts as seen on arrival, so the
 * dashboard can show War/Election influence labels and list factions in the game's order.
 */
const LOCATION_EVENTS = ['Location', 'FSDJump', 'CarrierJump'];
const SYSTEM_STATE_KEY = 'system';
const MISSIONS_STATE_KEY = 'missions';
const TARGETS_STATE_KEY = 'shipTargets';
const LAST_TARGET_STATE_KEY = 'lastShipTargeted';
const CONFLICT_ZONE_STATE_KEY = 'conflictZone';

const MISSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REMEMBERED_TARGETS = 50;
// A ground conflict zone counts once a kill bond arrives within this long of approaching the settlement.
const GROUND_CZ_WINDOW_MS = 5 * 60 * 1000;
// Ground conflict zone size from the kill bond reward, as BGS-Tally judges it.
const GROUND_CZ_LOW_MAX_REWARD = 5000;
const GROUND_CZ_MEDIUM_MAX_REWARD = 38000;
const SPACE_CZ_TYPES = { $warzone_pointrace_low: 'l', $warzone_pointrace_med: 'm', $warzone_pointrace_high: 'h' };
// Conflict zone objective ships, recognised by their pilot names (as BGS-Tally does).
const SPACE_CZ_OBJECTIVE_PILOTS = [
  ['cp', ['$LUASC_Scenario_Warzone_NPC_WarzoneGeneral_Emp;', '$LUASC_Scenario_Warzone_NPC_WarzoneGeneral_Fed;', '$LUASC_Scenario_Warzone_NPC_WarzoneGeneral_Ind;']],
  ['so', ['$LUASC_Scenario_Warzone_NPC_SpecOps_A;', '$LUASC_Scenario_Warzone_NPC_SpecOps_B;', '$LUASC_Scenario_Warzone_NPC_SpecOps_G;', '$LUASC_Scenario_Warzone_NPC_SpecOps_D;']],
  ['pr', ['$LUASC_Scenario_Warzone_NPC_WarzoneCorrespondent;']],
];
const IGNORED_FACTIONS = new Set(['', "Pilots' Federation Local Branch", 'FleetCarrier']);
const CONFLICT_STATES = { war: 'War', civilwar: 'CivilWar', election: 'Election' };

export default defineStatModule({
  name: 'bgs',
  title: 'BGS Activity',
  description: 'Background simulation contributions per system and faction: influence, bounties, combat bonds, trade, data sales, murders, failed missions and conflict zones.',
  version: 4,
  events: [
    ...LOCATION_EVENTS, 'Docked', 'Undocked',
    'MissionAccepted', 'MissionCompleted', 'MissionFailed',
    'RedeemVoucher', 'MarketBuy', 'MarketSell', 'SellExplorationData', 'MultiSellExplorationData', 'SellOrganicData',
    'ShipTargeted', 'CommitCrime', 'SupercruiseDestinationDrop', 'ApproachSettlement', 'FactionKillBond', 'CapShipBond',
    'SupercruiseEntry', 'SearchAndRescue',
  ],
  ownedObjects: [
    { type: 'table', name: 'bgs_activity' },
    { type: 'table', name: 'bgs_system_states' },
  ],
  schemaSql: `
    CREATE TABLE IF NOT EXISTS bgs_activity (
      id              INTEGER PRIMARY KEY,
      commander_id    INTEGER NOT NULL REFERENCES commanders(id),
      entry_id        INTEGER NOT NULL,
      timestamp       TEXT NOT NULL,
      system_address  INTEGER,
      star_system     TEXT,
      faction         TEXT NOT NULL,
      activity_type   TEXT NOT NULL,
      detail          TEXT,
      value           REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_bgs_activity_time ON bgs_activity(timestamp);

    CREATE TABLE IF NOT EXISTS bgs_system_states (
      id              INTEGER PRIMARY KEY,
      system_address  INTEGER NOT NULL,
      star_system     TEXT NOT NULL,
      timestamp       TEXT NOT NULL,
      factions        TEXT NOT NULL,   -- JSON [{ name, state }] in the game's order
      conflicts       TEXT NOT NULL    -- JSON [{ type, status, faction1, faction2 }]
    );
    CREATE INDEX IF NOT EXISTS idx_bgs_system_states_system ON bgs_system_states(system_address, timestamp);
  `,

  createProcessor(database) {
    const insertActivity = database.prepare(`
      INSERT INTO bgs_activity (commander_id, entry_id, timestamp, system_address, star_system, faction, activity_type, detail, value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const selectLatestSystemState = database.prepare(`
      SELECT factions, conflicts FROM bgs_system_states WHERE system_address = ? ORDER BY timestamp DESC LIMIT 1
    `);
    const insertSystemState = database.prepare(`
      INSERT INTO bgs_system_states (system_address, star_system, timestamp, factions, conflicts) VALUES (?, ?, ?, ?, ?)
    `);
    const selectSystemName = database.prepare(`
      SELECT star_system FROM bgs_system_states WHERE system_address = ? ORDER BY timestamp DESC LIMIT 1
    `);

    return ({ id: entryId, commanderId, event, timestamp, data }, moduleState) => {
      trackDockingState(event, data, moduleState);
      const currentSystem = moduleState.get(SYSTEM_STATE_KEY);

      /** Records activity in a known system (by default the current one). */
      const record = (faction, activityType, value, { detail = null, system = currentSystem } = {}) => {
        if (!system?.address || IGNORED_FACTIONS.has(faction ?? '')) return;
        insertActivity.run(commanderId, entryId, timestamp, system.address, system.name ?? null, faction, activityType, detail, value);
      };

      /** Station activity: for the docked station's faction, if it's one of the system's factions. */
      const recordForStationFaction = (activityType, value, detail) => {
        const docked = getDockedLocation(moduleState);
        if (!docked?.faction || !isSystemFaction(currentSystem, docked.faction)) return;
        record(docked.faction, activityType, value, { detail });
      };

      switch (event) {
        case 'Location':
        case 'FSDJump':
        case 'CarrierJump': {
          const system = { address: data.SystemAddress, name: data.StarSystem, factionNames: (data.Factions ?? []).map((faction) => faction.Name) };
          moduleState.set(SYSTEM_STATE_KEY, system);
          if (data.Factions?.length) saveSystemState(data, timestamp);
          break;
        }

        case 'MissionAccepted': {
          const missions = pruneMissions(moduleState.get(MISSIONS_STATE_KEY) ?? {}, timestamp);
          missions[data.MissionID] = {
            faction: data.Faction,
            systemAddress: currentSystem?.address ?? null,
            systemName: currentSystem?.name ?? null,
            acceptedAt: timestamp,
          };
          moduleState.set(MISSIONS_STATE_KEY, missions);
          break;
        }

        case 'MissionCompleted': {
          const missions = moduleState.get(MISSIONS_STATE_KEY) ?? {};
          const mission = missions[data.MissionID];
          recordMissionInfluence(data, mission);
          if (mission) {
            delete missions[data.MissionID];
            moduleState.set(MISSIONS_STATE_KEY, missions);
          }
          break;
        }

        case 'MissionFailed': {
          const missions = moduleState.get(MISSIONS_STATE_KEY) ?? {};
          const mission = missions[data.MissionID];
          if (mission?.systemAddress) {
            record(mission.faction, 'mission_failed', 1, { system: { address: mission.systemAddress, name: mission.systemName } });
          }
          if (mission) {
            delete missions[data.MissionID];
            moduleState.set(MISSIONS_STATE_KEY, missions);
          }
          break;
        }

        case 'RedeemVoucher': {
          const docked = getDockedLocation(moduleState);
          // BGS-Tally counts half of a bounty redeemed at a fleet carrier.
          const carrierShare = docked?.stationType === 'FleetCarrier' ? 0.5 : 1;
          if (data.Type === 'bounty') {
            for (const { Faction: faction, Amount: amount } of data.Factions ?? []) {
              if (isSystemFaction(currentSystem, faction)) record(faction, 'bounty', (amount ?? 0) * carrierShare);
            }
          } else if (data.Type === 'CombatBond' && isSystemFaction(currentSystem, data.Faction)) {
            record(data.Faction, 'combat_bond', data.Amount ?? 0);
          }
          break;
        }

        case 'MarketBuy':
          recordForStationFaction('trade_buy', data.TotalCost ?? 0);
          break;

        case 'MarketSell': {
          const profit = (data.TotalSale ?? 0) - (data.Count ?? 0) * (data.AvgPricePaid ?? 0);
          recordForStationFaction(data.BlackMarket ? 'black_market' : 'trade_profit', profit);
          break;
        }

        case 'SellExplorationData':
        case 'MultiSellExplorationData':
          recordForStationFaction('exploration', Math.max(data.TotalEarnings ?? 0, (data.BaseValue ?? 0) + (data.Bonus ?? 0)));
          break;

        case 'SellOrganicData':
          recordForStationFaction('organic', (data.BioData ?? []).reduce((total, sample) => total + (sample.Value ?? 0) + (sample.Bonus ?? 0), 0));
          break;

        case 'SearchAndRescue':
          recordForStationFaction('search_rescue', data.Count ?? 1);
          break;

        case 'ShipTargeted': {
          // Remember who scanned pilots fly for, so a later murder can be pinned on their faction.
          if (data.PilotName && data.Faction) moduleState.set(LAST_TARGET_STATE_KEY, { pilotName: data.PilotName, faction: data.Faction });
          const pilotName = data.PilotName_Localised ?? data.PilotName;
          if (data.ScanStage >= 3 && pilotName && data.Faction) {
            const targets = moduleState.get(TARGETS_STATE_KEY) ?? [];
            const nextTargets = [...targets.filter((target) => target.pilotName !== pilotName), { pilotName, faction: data.Faction }];
            moduleState.set(TARGETS_STATE_KEY, nextTargets.slice(-MAX_REMEMBERED_TARGETS));
          }
          break;
        }

        case 'CommitCrime':
          if (data.CrimeType === 'murder') {
            const targets = moduleState.get(TARGETS_STATE_KEY) ?? [];
            const victim = targets.findLast((target) => target.pilotName === data.Victim || target.pilotName === data.Victim_Localised);
            if (victim && isSystemFaction(currentSystem, victim.faction)) record(victim.faction, 'murder', 1);
          } else if (data.CrimeType === 'onFoot_murder' && isSystemFaction(currentSystem, data.Faction)) {
            record(data.Faction, 'ground_murder', 1);
          }
          break;

        case 'SupercruiseDestinationDrop': {
          // The journal capitalises these ("$Warzone_PointRace_High:#index=1;"), so compare case-insensitively.
          const dropType = (data.Type ?? '').toLowerCase();
          const zoneType = Object.entries(SPACE_CZ_TYPES).find(([typePrefix]) => dropType.startsWith(typePrefix))?.[1];
          moduleState.set(CONFLICT_ZONE_STATE_KEY, zoneType ? { kind: 'space', size: zoneType, enteredAt: timestamp, isCounted: false, objectives: [] } : null);
          // A ship targeted before this zone can't be one of its objectives.
          moduleState.set(LAST_TARGET_STATE_KEY, null);
          break;
        }

        case 'ApproachSettlement':
          moduleState.set(CONFLICT_ZONE_STATE_KEY, { kind: 'ground', enteredAt: timestamp, isCounted: false });
          break;

        case 'SupercruiseEntry':
          moduleState.set(CONFLICT_ZONE_STATE_KEY, null);
          break;

        case 'CapShipBond': {
          const conflictZone = moduleState.get(CONFLICT_ZONE_STATE_KEY);
          if (conflictZone?.kind === 'space' && isSystemFaction(currentSystem, data.AwardingFaction)) {
            record(data.AwardingFaction, 'space_cz_objective', 1, { detail: 'cs' });
          }
          break;
        }

        case 'FactionKillBond': {
          let conflictZone = moduleState.get(CONFLICT_ZONE_STATE_KEY);
          if (!conflictZone || !isSystemFaction(currentSystem, data.AwardingFaction)) break;
          if (conflictZone.kind === 'space') {
            // Captain, spec ops and propagandist: the kill of a targeted objective ship, once each per zone.
            const lastTarget = moduleState.get(LAST_TARGET_STATE_KEY);
            const objective = lastTarget?.faction === data.VictimFaction
              && SPACE_CZ_OBJECTIVE_PILOTS.find(([, pilotNames]) => pilotNames.includes(lastTarget.pilotName))?.[0];
            if (objective && !conflictZone.objectives?.includes(objective)) {
              record(data.AwardingFaction, 'space_cz_objective', 1, { detail: objective });
              conflictZone = { ...conflictZone, objectives: [...(conflictZone.objectives ?? []), objective] };
              moduleState.set(CONFLICT_ZONE_STATE_KEY, conflictZone);
            }
          }
          // The zone itself counts once, for the side whose bonds are earned, on the first kill.
          if (conflictZone.isCounted) break;
          if (conflictZone.kind === 'space') {
            record(data.AwardingFaction, 'space_cz', 1, { detail: conflictZone.size });
          } else {
            if (Date.parse(timestamp) - Date.parse(conflictZone.enteredAt) > GROUND_CZ_WINDOW_MS) break;
            const reward = data.Reward ?? 0;
            const size = reward < GROUND_CZ_LOW_MAX_REWARD ? 'l' : reward < GROUND_CZ_MEDIUM_MAX_REWARD ? 'm' : 'h';
            record(data.AwardingFaction, 'ground_cz', 1, { detail: size });
          }
          moduleState.set(CONFLICT_ZONE_STATE_KEY, { ...conflictZone, isCounted: true });
          break;
        }

        default:
          break;
      }

      /**
       * Mission influence: each faction effect lists the systems it changes and by how many "+".
       * Missions for factions in an election or war report no influence; BGS-Tally credits those
       * with +1 (election) or +2 (war) for the mission's faction.
       */
      function recordMissionInfluence(missionData, mission) {
        for (const factionEffect of missionData.FactionEffects ?? []) {
          const faction = factionEffect.Faction;
          const detail = faction === missionData.Faction ? 'primary' : 'secondary';
          for (const influence of factionEffect.Influence ?? []) {
            const points = (influence.Influence ?? '').length;
            if (!points || !influence.SystemAddress) continue;
            const sign = influence.Trend === 'UpGood' || influence.Trend === 'DownGood' ? 1 : -1;
            const system = { address: influence.SystemAddress, name: lookUpSystemName(influence.SystemAddress) };
            record(faction, 'inf', sign * points, { detail, system });
          }
          const hasInfluence = (factionEffect.Influence ?? []).some((influence) => influence.Influence);
          if (!hasInfluence && detail === 'primary' && mission?.systemAddress) {
            const conflictState = getFactionConflictState(mission.systemAddress, faction);
            const conflictPoints = { Election: 1, War: 2, CivilWar: 2 }[conflictState];
            if (conflictPoints) record(faction, 'inf', conflictPoints, { detail, system: { address: mission.systemAddress, name: mission.systemName } });
          }
        }
      }

      function lookUpSystemName(systemAddress) {
        if (systemAddress === currentSystem?.address) return currentSystem.name;
        return selectSystemName.get(systemAddress)?.star_system ?? null;
      }

      function getFactionConflictState(systemAddress, faction) {
        const systemState = selectLatestSystemState.get(systemAddress);
        if (!systemState) return null;
        return JSON.parse(systemState.factions).find((systemFaction) => systemFaction.name === faction)?.state ?? null;
      }

      /** Saves the system's factions and conflicts, unless they're unchanged since the last visit. */
      function saveSystemState(locationData, stateTimestamp) {
        const conflicts = (locationData.Conflicts ?? []).map((conflict) => ({
          type: conflict.WarType,
          status: conflict.Status,
          faction1: { name: conflict.Faction1?.Name, stake: conflict.Faction1?.Stake, wonDays: conflict.Faction1?.WonDays },
          faction2: { name: conflict.Faction2?.Name, stake: conflict.Faction2?.Stake, wonDays: conflict.Faction2?.WonDays },
        }));
        const factions = locationData.Factions
          .filter((faction) => !IGNORED_FACTIONS.has(faction.Name))
          .map((faction) => ({ name: faction.Name, state: getConflictState(conflicts, faction.Name), influence: faction.Influence ?? null }));
        const factionsJson = JSON.stringify(factions);
        const conflictsJson = JSON.stringify(conflicts);
        const latestState = selectLatestSystemState.get(locationData.SystemAddress);
        if (latestState?.factions === factionsJson && latestState?.conflicts === conflictsJson) return;
        insertSystemState.run(locationData.SystemAddress, locationData.StarSystem, stateTimestamp, factionsJson, conflictsJson);
      }
    };
  },

  createRouter(database) {
    const router = Router();

    // GET /api/stats/bgs/ticks -> saved BGS ticks, newest first
    router.get('/ticks', (request, response) => {
      const ticks = database.prepare('SELECT tick_time FROM bgs_ticks ORDER BY tick_time DESC LIMIT 200').all();
      response.json({ ticks: ticks.map((tick) => tick.tick_time) });
    });

    // GET /api/stats/bgs/activity?commander=&from=<timestamp>&to=<timestamp>
    // -> systems with activity in [from, to), each with its factions. A faction's totals include
    //    manual adjustments (bgs_adjustments); manual holds the adjustments alone, when there are any.
    router.get('/activity', (request, response) => {
      const conditions = [];
      const parameters = [];
      const commanderId = getCommanderIdFilter(request.query);
      if (commanderId !== null) {
        conditions.push('commander_id = ?');
        parameters.push(commanderId);
      }
      if (typeof request.query.from === 'string' && request.query.from) {
        conditions.push('timestamp >= ?');
        parameters.push(request.query.from);
      }
      if (typeof request.query.to === 'string' && request.query.to) {
        conditions.push('timestamp < ?');
        parameters.push(request.query.to);
      }
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Adjustments for systems typed in by name pick up the system's address once the app has seen it.
      const activityRows = database.prepare(`
        SELECT system_address, MAX(star_system) AS star_system, faction, activity_type, detail, is_manual,
          SUM(value) AS total_value, MAX(timestamp) AS last_activity_at
        FROM (
          SELECT commander_id, timestamp, system_address, star_system, faction, activity_type, detail, value, 0 AS is_manual
          FROM bgs_activity
          UNION ALL
          SELECT commander_id, timestamp,
            COALESCE(system_address, (
              SELECT states.system_address FROM bgs_system_states AS states
              WHERE states.star_system = bgs_adjustments.star_system COLLATE NOCASE LIMIT 1
            )),
            star_system, faction, activity_type, NULLIF(detail, ''), value, 1
          FROM bgs_adjustments
        ) ${whereClause}
        GROUP BY system_address, CASE WHEN system_address IS NULL THEN LOWER(star_system) END, faction, activity_type, detail, is_manual
      `).all(...parameters);

      const selectSystemState = database.prepare(`
        SELECT star_system, factions FROM bgs_system_states
        WHERE system_address = ? AND (? IS NULL OR timestamp < ?)
        ORDER BY timestamp DESC LIMIT 1
      `);
      const selectAnySystemState = database.prepare(`
        SELECT star_system, factions FROM bgs_system_states WHERE system_address = ? ORDER BY timestamp ASC LIMIT 1
      `);

      const systemsByAddress = new Map();
      for (const activityRow of activityRows) {
        // Systems known only by a typed-in name are keyed by that name.
        const systemKey = activityRow.system_address === null ? `name:${activityRow.star_system.toLowerCase()}` : String(activityRow.system_address);
        let system = systemsByAddress.get(systemKey);
        if (!system) {
          // The faction list as of the end of the period (or the earliest known, if visited only later).
          const toTimestamp = request.query.to || null;
          const systemState = selectSystemState.get(activityRow.system_address, toTimestamp, toTimestamp)
            ?? selectAnySystemState.get(activityRow.system_address);
          const knownFactions = systemState ? JSON.parse(systemState.factions) : [];
          system = {
            systemKey,
            systemAddress: activityRow.system_address,
            starSystem: activityRow.star_system ?? systemState?.star_system ?? null,
            lastActivityAt: activityRow.last_activity_at,
            factionOrder: knownFactions.map((faction) => faction.name),
            factionStates: Object.fromEntries(knownFactions.map((faction) => [faction.name, faction.state])),
            factions: new Map(),
          };
          systemsByAddress.set(systemKey, system);
        }
        if (activityRow.last_activity_at > system.lastActivityAt) system.lastActivityAt = activityRow.last_activity_at;
        system.starSystem ??= activityRow.star_system;

        let faction = system.factions.get(activityRow.faction);
        if (!faction) {
          faction = { name: activityRow.faction, state: system.factionStates[activityRow.faction] ?? null, totals: {} };
          system.factions.set(activityRow.faction, faction);
        }
        addToTotals(faction.totals, activityRow.activity_type, activityRow.detail, activityRow.total_value);
        if (activityRow.is_manual) addToTotals(faction.manual ??= {}, activityRow.activity_type, activityRow.detail, activityRow.total_value);
      }

      const systems = [...systemsByAddress.values()]
        .map((system) => ({
          systemKey: system.systemKey,
          systemAddress: system.systemAddress,
          starSystem: system.starSystem,
          lastActivityAt: system.lastActivityAt,
          factions: [...system.factions.values()].sort((first, second) => {
            const firstIndex = system.factionOrder.indexOf(first.name);
            const secondIndex = system.factionOrder.indexOf(second.name);
            return (firstIndex === -1 ? Infinity : firstIndex) - (secondIndex === -1 ? Infinity : secondIndex);
          }),
        }))
        .sort((first, second) => second.lastActivityAt.localeCompare(first.lastActivityAt));

      response.json({ systems });
    });

    return router;
  },
});

function isSystemFaction(system, faction) {
  return Boolean(faction) && Boolean(system?.factionNames?.includes(faction));
}

/** Drops remembered missions old enough that they can't still be open. */
function pruneMissions(missions, timestamp) {
  const cutoff = Date.parse(timestamp) - MISSION_RETENTION_MS;
  return Object.fromEntries(Object.entries(missions).filter(([, mission]) => Date.parse(mission.acceptedAt) >= cutoff));
}

/** The faction's state from an active conflict in the system: War, CivilWar, Election or null. */
function getConflictState(conflicts, factionName) {
  const conflict = conflicts.find((candidate) => candidate.status === 'active'
    && (candidate.faction1.name === factionName || candidate.faction2.name === factionName));
  return conflict ? CONFLICT_STATES[conflict.type] ?? null : null;
}

/** Folds one aggregated activity row into a faction's totals. */
function addToTotals(totals, activityType, detail, value) {
  switch (activityType) {
    case 'inf':
      totals[detail === 'secondary' ? 'infSecondary' : 'infPrimary'] = (totals[detail === 'secondary' ? 'infSecondary' : 'infPrimary'] ?? 0) + value;
      break;
    case 'space_cz':
    case 'ground_cz':
    case 'space_cz_objective': {
      const key = { space_cz: 'spaceCz', ground_cz: 'groundCz', space_cz_objective: 'spaceCzObjectives' }[activityType];
      totals[key] ??= {};
      totals[key][detail] = (totals[key][detail] ?? 0) + value;
      break;
    }
    default: {
      const key = {
        bounty: 'bounties', combat_bond: 'combatBonds', trade_buy: 'tradeBuy', trade_profit: 'tradeProfit',
        black_market: 'blackMarketProfit', exploration: 'exploration', organic: 'organic', murder: 'murders',
        ground_murder: 'groundMurders', mission_failed: 'missionsFailed', scenario: 'scenarios', search_rescue: 'searchAndRescue',
      }[activityType];
      if (key) totals[key] = (totals[key] ?? 0) + value;
    }
  }
}
