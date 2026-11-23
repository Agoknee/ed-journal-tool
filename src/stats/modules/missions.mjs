import { Router } from 'express';
import { defineStatModule } from '../define-stat-module.mjs';
import { getDockedLocation, trackDockingState } from '../docking-state.mjs';
import { getCommodityDisplayName } from '../commodity-names.mjs';
import { SqlFilter, addStandardFilters, getCommanderIdFilter, getOrderByClause, getPagination, runPaginatedQuery, sumBy } from '../query-helpers.mjs';

/**
 * Every mission a commander has taken, from MissionAccepted to its outcome, with extra tracking for
 * massacre and cargo (mining, delivery, source) missions. Approach based on ODEliteTracker and the
 * Elite Dangerous Massacre Tracker.
 *
 * status: active | redirected (objective done, return to hand in) | completed | failed | abandoned
 *         | removed (missing from the game's mission list at login, e.g. expired while offline).
 * Active or redirected missions past their expiry are reported as "expired" by the API.
 *
 * Massacre kills are counted from Bounty and FactionKillBond events against the target faction, in
 * the target system. As in game, a kill counts once per issuing faction: toward the oldest of that
 * faction's unfinished missions against the target. Kills by wingmates can't be seen, so the count
 * is set to the full kill count whenever the game redirects or completes a mission.
 *
 * Cargo missions take their progress from CargoDepot events. The ship's current cargo (Cargo
 * events) is kept so the dashboard can show how much of each commodity is already in the hold.
 */
const LOCATION_EVENTS = ['Location', 'FSDJump', 'CarrierJump'];
const SYSTEM_STATE_KEY = 'system';
const ODYSSEY_STATE_KEY = 'odyssey';
const ON_FOOT_STATE_KEY = 'onFoot';
// Kills of ships or people that belong to no minor faction can't count toward a massacre.
const NON_FACTION_VICTIMS = new Set(['', '$faction_none;', '$faction_Pirate;', 'faction_none', 'faction_Pirate']);

/** Mission categories, from the start of the mission's internal name. First match wins. */
const CATEGORY_PATTERNS = [
  ['massacre', /^Mission_(OnFoot_)?Massacre/i],
  ['mining', /^Mission_Mining/i],
  ['courier', /^Mission_Courier/i],
  ['delivery', /^Mission_Delivery/i],
  ['source', /^Mission_Collect/i],
  ['donation', /^Mission_Altruism/i],
  ['passenger', /^Mission_(Passenger|Sightseeing|LongDistanceExpedition)/i],
  ['assassination', /^Mission_(OnFoot_)?Assassinat/i],
  ['salvage', /^Mission_(Salvage|Rescue|OnFoot_Salvage|OnFoot_Collect)/i],
  ['smuggling', /^Mission_Smuggle/i],
  ['on_foot', /^Mission_OnFoot/i],
  ['combat', /^Mission_(Disable|Hack|Scan|Sabotage|Piracy|Wing_Assassinate|Assassinate)/i],
];

export default defineStatModule({
  name: 'missions',
  title: 'Missions',
  description: 'Every mission taken, with its outcome, plus massacre kill tracking and cargo mission progress.',
  version: 4,
  events: [
    'LoadGame', ...LOCATION_EVENTS, 'Docked', 'Undocked', 'Embark', 'Disembark',
    'MissionAccepted', 'MissionRedirected', 'MissionCompleted', 'MissionFailed', 'MissionAbandoned', 'Missions',
    'Bounty', 'FactionKillBond', 'CargoDepot', 'Cargo',
  ],
  ownedObjects: [
    { type: 'table', name: 'missions' },
    { type: 'table', name: 'mission_cargo' },
    { type: 'table', name: 'mission_locations' },
  ],
  schemaSql: `
    CREATE TABLE IF NOT EXISTS missions (
      id                     INTEGER PRIMARY KEY,
      commander_id           INTEGER NOT NULL REFERENCES commanders(id),
      mission_id             INTEGER NOT NULL,     -- the game's MissionID
      entry_id               INTEGER NOT NULL,
      accepted_at            TEXT NOT NULL,
      name                   TEXT NOT NULL,        -- internal name, e.g. Mission_MassacreWing
      title                  TEXT,                 -- localised name
      category               TEXT NOT NULL,
      faction                TEXT,                 -- issuing faction
      origin_system          TEXT,
      origin_system_address  INTEGER,
      origin_station         TEXT,
      origin_market_id       INTEGER,
      destination_system     TEXT,                 -- where to go now: the turn-in system once redirected
      target_system          TEXT,                 -- the destination when accepted (a massacre's target system)
      destination_station    TEXT,
      destination_settlement TEXT,
      target_faction         TEXT,
      target_type            TEXT,                 -- localised, e.g. Pirates
      target                 TEXT,                 -- assassination target name
      kill_count             INTEGER,
      kills                  INTEGER NOT NULL DEFAULT 0,
      is_on_foot             INTEGER NOT NULL DEFAULT 0,
      commodity              TEXT,                 -- internal key, e.g. indite
      commodity_name         TEXT,
      commodity_count        INTEGER,
      items_collected        INTEGER,
      items_delivered        INTEGER,
      passenger_count        INTEGER,
      passenger_type         TEXT,
      influence              TEXT,
      reputation             TEXT,
      reward                 INTEGER,              -- offered when accepted
      final_reward           INTEGER,              -- paid on completion
      donation               INTEGER,
      is_wing                INTEGER NOT NULL DEFAULT 0,
      is_odyssey             INTEGER,
      expiry                 TEXT,
      status                 TEXT NOT NULL,
      redirected_at          TEXT,
      ended_at               TEXT,
      UNIQUE (commander_id, mission_id)
    );
    CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status, category);
    CREATE INDEX IF NOT EXISTS idx_missions_accepted ON missions(accepted_at);
    CREATE INDEX IF NOT EXISTS idx_missions_target ON missions(commander_id, target_faction);

    CREATE TABLE IF NOT EXISTS mission_cargo (
      commander_id  INTEGER NOT NULL REFERENCES commanders(id),
      commodity     TEXT NOT NULL,   -- internal key, as in missions.commodity
      count         INTEGER NOT NULL,
      updated_at    TEXT NOT NULL,
      PRIMARY KEY (commander_id, commodity)
    );

    -- Each commander's current system and the factions present there, to show which issuing
    -- factions can be handed missions without travelling.
    CREATE TABLE IF NOT EXISTS mission_locations (
      commander_id    INTEGER PRIMARY KEY REFERENCES commanders(id),
      star_system     TEXT,
      system_address  INTEGER,
      factions        TEXT NOT NULL,   -- JSON array of faction names
      updated_at      TEXT NOT NULL
    );
  `,

  createProcessor(database) {
    const insertMission = database.prepare(`
      INSERT OR IGNORE INTO missions (
        commander_id, mission_id, entry_id, accepted_at, name, title, category, faction,
        origin_system, origin_system_address, origin_station, origin_market_id,
        destination_system, destination_station, destination_settlement, target_system,
        target_faction, target_type, target, kill_count, is_on_foot,
        commodity, commodity_name, commodity_count, passenger_count, passenger_type,
        influence, reputation, reward, is_wing, is_odyssey, expiry, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `);
    const redirectMission = database.prepare(`
      UPDATE missions SET status = 'redirected', redirected_at = ?,
        destination_system = COALESCE(NULLIF(?, ''), destination_system),
        destination_station = COALESCE(NULLIF(?, ''), destination_station),
        kills = COALESCE(kill_count, kills)
      WHERE commander_id = ? AND mission_id = ? AND status IN ('active', 'redirected', 'removed')
    `);
    const completeMission = database.prepare(`
      UPDATE missions SET status = 'completed', ended_at = ?, final_reward = ?, donation = ?,
        kills = COALESCE(kill_count, kills),
        items_delivered = CASE WHEN commodity_count IS NOT NULL AND category <> 'donation' THEN commodity_count ELSE items_delivered END
      WHERE commander_id = ? AND mission_id = ?
    `);
    const endMission = database.prepare(`
      UPDATE missions SET status = ?, ended_at = ? WHERE commander_id = ? AND mission_id = ? AND status IN ('active', 'redirected', 'removed')
    `);
    const updateCargoProgress = database.prepare(`
      UPDATE missions SET items_collected = ?, items_delivered = ? WHERE commander_id = ? AND mission_id = ?
    `);
    const selectOpenMissions = database.prepare(`
      SELECT mission_id, is_odyssey FROM missions WHERE commander_id = ? AND status IN ('active', 'redirected')
    `);
    // Unfinished massacre missions against a faction, oldest first.
    const selectMassacreCandidates = database.prepare(`
      SELECT id, faction, target_system FROM missions
      WHERE commander_id = ? AND category = 'massacre' AND status = 'active' AND target_faction = ?
        AND is_on_foot = ? AND kills < kill_count
      ORDER BY accepted_at, id
    `);
    const addKill = database.prepare('UPDATE missions SET kills = kills + 1 WHERE id = ?');
    const upsertLocation = database.prepare(`
      INSERT INTO mission_locations (commander_id, star_system, system_address, factions, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (commander_id) DO UPDATE SET star_system = excluded.star_system, system_address = excluded.system_address,
        factions = excluded.factions, updated_at = excluded.updated_at
    `);
    const deleteCargo = database.prepare('DELETE FROM mission_cargo WHERE commander_id = ?');
    const insertCargo = database.prepare(`
      INSERT INTO mission_cargo (commander_id, commodity, count, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (commander_id, commodity) DO UPDATE SET count = count + excluded.count
    `);

    return ({ id: entryId, commanderId, event, timestamp, data }, moduleState) => {
      trackDockingState(event, data, moduleState);
      switch (event) {
        case 'LoadGame':
          moduleState.set(ODYSSEY_STATE_KEY, Boolean(data.Odyssey));
          moduleState.set(ON_FOOT_STATE_KEY, false);
          return;

        case 'Location':
        case 'FSDJump':
        case 'CarrierJump':
          moduleState.set(SYSTEM_STATE_KEY, { name: data.StarSystem ?? null, address: data.SystemAddress ?? null });
          upsertLocation.run(commanderId, data.StarSystem ?? null, data.SystemAddress ?? null,
            JSON.stringify((data.Factions ?? []).map((faction) => faction.Name).filter(Boolean)), timestamp);
          if (event === 'Location') moduleState.set(ON_FOOT_STATE_KEY, Boolean(data.OnFoot));
          return;

        case 'Docked':
          moduleState.set(SYSTEM_STATE_KEY, { name: data.StarSystem ?? null, address: data.SystemAddress ?? null });
          return;

        case 'Embark':
        case 'Disembark':
          moduleState.set(ON_FOOT_STATE_KEY, event === 'Disembark');
          return;

        case 'MissionAccepted': {
          if (!data.MissionID || !data.Name) return;
          const system = moduleState.get(SYSTEM_STATE_KEY);
          const docked = getDockedLocation(moduleState);
          const category = getCategory(data.Name);
          const commodity = data.Commodity ? getCommodityKey(data.Commodity) : null;
          insertMission.run(
            commanderId, data.MissionID, entryId, timestamp, stripNameSuffix(data.Name), data.LocalisedName ?? null, category, data.Faction ?? null,
            system?.name ?? null, system?.address ?? null, docked?.stationName ?? null, docked?.marketId ?? null,
            data.DestinationSystem ?? null, data.DestinationStation ?? null, data.DestinationSettlement ?? null, data.DestinationSystem ?? null,
            data.TargetFaction ?? null, data.TargetType_Localised ?? cleanTag(data.TargetType), data.Target_Localised ?? data.Target ?? null,
            data.KillCount ?? null, /OnFoot/i.test(data.Name) ? 1 : 0,
            commodity, commodity ? getCommodityDisplayName(data.Commodity_Localised, commodity) : null, data.Count ?? null,
            data.PassengerCount ?? null, data.PassengerType ?? null,
            data.Influence ?? null, data.Reputation ?? null, data.Reward ?? null, data.Wing ? 1 : 0,
            moduleState.get(ODYSSEY_STATE_KEY) === undefined ? null : (moduleState.get(ODYSSEY_STATE_KEY) ? 1 : 0),
            data.Expiry ?? null,
          );
          return;
        }

        case 'MissionRedirected':
          redirectMission.run(timestamp, data.NewDestinationSystem ?? '', data.NewDestinationStation ?? '', commanderId, data.MissionID);
          return;

        case 'MissionCompleted':
          completeMission.run(timestamp, data.Reward ?? 0, data.Donated ?? null, commanderId, data.MissionID);
          return;

        case 'MissionFailed':
          endMission.run('failed', timestamp, commanderId, data.MissionID);
          return;

        case 'MissionAbandoned':
          endMission.run('abandoned', timestamp, commanderId, data.MissionID);
          return;

        case 'Missions':
          reconcileMissionList(data, timestamp);
          return;

        case 'Bounty':
        case 'FactionKillBond':
          countMassacreKill(data);
          return;

        case 'CargoDepot':
          if (data.MissionID && Number.isFinite(data.ItemsDelivered)) {
            updateCargoProgress.run(data.ItemsCollected ?? null, data.ItemsDelivered, commanderId, data.MissionID);
          }
          return;

        case 'Cargo':
          // Without an inventory, Cargo just points at Cargo.json; the SRV's cargo isn't the ship's.
          if (data.Vessel !== 'Ship' || !Array.isArray(data.Inventory)) return;
          deleteCargo.run(commanderId);
          for (const item of data.Inventory) {
            if (item.Name && item.Count > 0) insertCargo.run(commanderId, getCommodityKey(item.Name), item.Count, timestamp);
          }
          return;
      }

      /**
       * The Missions event at login lists every mission the game still has. Open missions it leaves
       * out are gone (usually expired while offline); ones it lists as failed have failed. Missions
       * from the other game mode (Horizons vs Odyssey) are left alone, since each mode keeps its own.
       */
      function reconcileMissionList(missionList, eventTimestamp) {
        const active = missionList.Active ?? [];
        const failed = missionList.Failed ?? [];
        const complete = missionList.Complete ?? [];
        // An empty list counts too: it's how missions the journal never closes (e.g. permit
        // missions, which have no expiry or completion event) drop off.
        const listedIds = new Set([...active, ...complete].map((mission) => mission.MissionID));
        const failedIds = new Set(failed.map((mission) => mission.MissionID));
        const odyssey = moduleState.get(ODYSSEY_STATE_KEY);
        for (const mission of selectOpenMissions.all(commanderId)) {
          if (failedIds.has(mission.mission_id)) {
            endMission.run('failed', eventTimestamp, commanderId, mission.mission_id);
          } else if (!listedIds.has(mission.mission_id) && isSameGameMode(mission.is_odyssey, odyssey)) {
            endMission.run('removed', eventTimestamp, commanderId, mission.mission_id);
          }
        }
      }

      function countMassacreKill(killData) {
        const victimFaction = killData.VictimFaction ?? '';
        if (NON_FACTION_VICTIMS.has(victimFaction)) return;
        const reward = killData.TotalReward ?? killData.Reward ?? 0;
        if (reward <= 0) return;
        // On-foot kills only count for on-foot massacres, and ship kills only for ship ones.
        const isOnFootKill = event === 'Bounty' ? /^suit/i.test(killData.Target ?? '') : Boolean(moduleState.get(ON_FOOT_STATE_KEY));
        const systemName = moduleState.get(SYSTEM_STATE_KEY)?.name?.toLowerCase() ?? null;

        const creditedFactions = new Set();
        for (const mission of selectMassacreCandidates.all(commanderId, victimFaction, isOnFootKill ? 1 : 0)) {
          if (creditedFactions.has(mission.faction)) continue;
          const isInTargetSystem = !mission.target_system || !systemName || mission.target_system.toLowerCase() === systemName;
          if (!isInTargetSystem) continue;
          addKill.run(mission.id);
          creditedFactions.add(mission.faction);
        }
      }
    };
  },

  createRouter(database) {
    const router = Router();
    // Journal-style "now", so it compares with the journal timestamps stored as text.
    const nowSql = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";
    // Open missions past their expiry are reported as expired.
    const isExpiredSql = `(missions.status = 'removed' OR (missions.status IN ('active', 'redirected') AND missions.expiry < ${nowSql}))`;
    const effectiveStatusSql = `CASE WHEN ${isExpiredSql} THEN 'expired' ELSE missions.status END`;
    const openMissionsSql = `missions.status IN ('active', 'redirected') AND (missions.expiry IS NULL OR missions.expiry >= ${nowSql})`;
    const missionColumnsSql = `
      missions.id, missions.commander_id, commanders.name AS commander_name, missions.mission_id, missions.accepted_at,
      missions.name, missions.title, missions.category, missions.faction,
      missions.origin_system, missions.origin_station, missions.destination_system, missions.destination_station, missions.destination_settlement, missions.target_system,
      missions.target_faction, missions.target_type, missions.target, missions.kill_count, missions.kills, missions.is_on_foot,
      missions.commodity, missions.commodity_name, missions.commodity_count, missions.items_collected, missions.items_delivered,
      missions.passenger_count, missions.passenger_type, missions.influence, missions.reputation,
      missions.reward, missions.final_reward, missions.donation, missions.is_wing, missions.expiry,
      missions.redirected_at, missions.ended_at, missions.status AS recorded_status, ${effectiveStatusSql} AS status
    `;
    const missionsFromSql = 'FROM missions JOIN commanders ON commanders.id = missions.commander_id';

    const selectOpenMissions = (query, extraCondition = '') => {
      const commanderId = getCommanderIdFilter(query);
      return database.prepare(`
        SELECT ${missionColumnsSql} ${missionsFromSql}
        WHERE ${openMissionsSql} AND (? IS NULL OR missions.commander_id = ?) ${extraCondition}
        ORDER BY missions.accepted_at, missions.id
      `).all(commanderId, commanderId);
    };

    // GET /api/stats/missions/summary?commander=&period=&from=&to=
    // Open missions now, and outcomes of missions accepted in the period.
    router.get('/summary', (request, response) => {
      const open = selectOpenMissions(request.query);
      const sqlFilter = addStandardFilters(new SqlFilter(), request.query, { commanderColumn: 'missions.commander_id', timestampColumn: 'missions.accepted_at' });
      const byCategory = database.prepare(`
        SELECT missions.category, COUNT(*) AS accepted,
          SUM(missions.status = 'completed') AS completed,
          SUM(missions.status = 'failed') AS failed,
          SUM(missions.status = 'abandoned') AS abandoned,
          SUM(${isExpiredSql}) AS expired,
          COALESCE(SUM(CASE WHEN missions.status = 'completed' THEN missions.final_reward END), 0) AS earned,
          COALESCE(SUM(missions.donation), 0) AS donated
        ${missionsFromSql} ${sqlFilter.whereClause}
        GROUP BY missions.category ORDER BY accepted DESC
      `).all(...sqlFilter.parameters);

      response.json({
        open: {
          count: open.length,
          redirected: open.filter((mission) => mission.status === 'redirected').length,
          reward: sumBy(open, 'reward'),
          wingReward: sumBy(open.filter((mission) => mission.is_wing), 'reward'),
          nextExpiry: open.map((mission) => mission.expiry).filter(Boolean).sort()[0] ?? null,
        },
        byCategory,
        totals: {
          accepted: sumBy(byCategory, 'accepted'),
          completed: sumBy(byCategory, 'completed'),
          failed: sumBy(byCategory, 'failed'),
          abandoned: sumBy(byCategory, 'abandoned'),
          expired: sumBy(byCategory, 'expired'),
          earned: sumBy(byCategory, 'earned'),
          donated: sumBy(byCategory, 'donated'),
        },
      });
    });

    // Each commander's current system and the factions present there.
    const selectLocations = database.prepare('SELECT commander_id, star_system, factions FROM mission_locations');
    const getCurrentLocations = () => new Map(selectLocations.all().map((row) => [
      row.commander_id,
      { starSystem: row.star_system, factions: new Set(JSON.parse(row.factions)) },
    ]));
    // Marks missions whose issuing faction is present in the commander's current system.
    const markPresentFactions = (missions) => {
      const locations = getCurrentLocations();
      return missions.map((mission) => ({
        ...mission,
        is_faction_present: Boolean(locations.get(mission.commander_id)?.factions.has(mission.faction)),
      }));
    };

    // GET /api/stats/missions/massacre?commander=
    // Open massacre missions as stacks: one per commander, target faction and target system, each
    // split by issuing faction (kills count for every issuing faction at once).
    router.get('/massacre', (request, response) => {
      const missions = markPresentFactions(selectOpenMissions(request.query, "AND missions.category = 'massacre'"));
      const locations = getCurrentLocations();
      const stacks = new Map();
      for (const mission of missions) {
        // Grouped by the target system from when the mission was accepted: a redirect points the
        // mission at its turn-in station, but it still belongs to the same stack.
        const stackKey = [mission.commander_id, mission.target_faction, mission.target_system, mission.is_on_foot].join('|');
        if (!stacks.has(stackKey)) {
          stacks.set(stackKey, {
            key: stackKey,
            commanderId: mission.commander_id,
            commanderName: mission.commander_name,
            targetFaction: mission.target_faction,
            targetSystem: mission.target_system,
            targetType: mission.target_type,
            isOnFoot: Boolean(mission.is_on_foot),
            currentSystem: locations.get(mission.commander_id)?.starSystem ?? null,
            missions: [],
          });
        }
        stacks.get(stackKey).missions.push(mission);
      }
      response.json({ stacks: [...stacks.values()].map(summarizeStack) });
    });

    // GET /api/stats/missions/cargo?commander=
    // Open missions that need a commodity (mining, delivery, source), with progress and cargo on hand.
    router.get('/cargo', (request, response) => {
      const missions = markPresentFactions(selectOpenMissions(request.query, 'AND missions.commodity IS NOT NULL AND missions.commodity_count > 0')).map((mission) => {
        // Donation missions take credits; their "count" is not cargo.
        const delivered = Math.min(mission.items_delivered ?? 0, mission.commodity_count);
        return { ...mission, delivered, remaining: mission.status === 'redirected' ? 0 : mission.commodity_count - delivered };
      }).filter((mission) => mission.category !== 'donation');

      const commanderId = getCommanderIdFilter(request.query);
      const cargoRows = database.prepare('SELECT commander_id, commodity, count FROM mission_cargo WHERE (? IS NULL OR commander_id = ?)').all(commanderId, commanderId);
      const cargoByKey = new Map();
      for (const row of cargoRows) {
        const key = `${row.commander_id}|${row.commodity}`;
        cargoByKey.set(key, (cargoByKey.get(key) ?? 0) + row.count);
      }

      const commodities = new Map();
      for (const mission of missions) {
        const key = `${mission.commander_id}|${mission.commodity}`;
        if (!commodities.has(key)) {
          commodities.set(key, {
            key,
            commanderId: mission.commander_id,
            commanderName: mission.commander_name,
            commodity: mission.commodity,
            commodityName: mission.commodity_name,
            categories: new Set(),
            missionCount: 0,
            required: 0,
            delivered: 0,
            remaining: 0,
            inCargo: cargoByKey.get(key) ?? 0,
            reward: 0,
          });
        }
        const commodity = commodities.get(key);
        commodity.categories.add(mission.category);
        commodity.missionCount += 1;
        commodity.required += mission.commodity_count;
        commodity.delivered += mission.delivered;
        commodity.remaining += mission.remaining;
        commodity.reward += mission.reward ?? 0;
      }

      response.json({
        missions,
        commodities: [...commodities.values()]
          .map((commodity) => ({ ...commodity, categories: [...commodity.categories], stillToFind: Math.max(0, commodity.remaining - commodity.inCargo) }))
          .sort((first, second) => second.remaining - first.remaining),
      });
    });

    // The Mission History filters, shared by its list and its statistics.
    const getHistoryFilter = (query) => {
      const sqlFilter = addStandardFilters(new SqlFilter(), query, {
        commanderColumn: 'missions.commander_id',
        timestampColumn: 'missions.accepted_at',
        searchColumns: ['missions.title', 'missions.faction', 'missions.target_faction', 'missions.origin_system', 'missions.origin_station',
          'missions.destination_system', 'missions.destination_station', 'missions.commodity_name', 'missions.target'],
      });
      if (query.category) sqlFilter.add('missions.category = ?', String(query.category));
      const status = String(query.status ?? '');
      if (status === 'open') sqlFilter.add(openMissionsSql);
      else if (status === 'expired') sqlFilter.add(isExpiredSql);
      else if (['completed', 'failed', 'abandoned'].includes(status)) sqlFilter.add('missions.status = ?', status);
      return sqlFilter;
    };

    // GET /api/stats/missions/history-stats?<same filters as /missions>
    // Overall statistics for the missions the history list shows.
    router.get('/history-stats', (request, response) => {
      const sqlFilter = getHistoryFilter(request.query);
      const run = (sql) => database.prepare(sql);
      const completedFilter = `${sqlFilter.whereClause ? `${sqlFilter.whereClause} AND` : 'WHERE'} missions.status = 'completed'`;

      const totals = run(`
        SELECT COUNT(*) AS total,
          COALESCE(SUM(missions.status = 'completed'), 0) AS completed,
          COALESCE(SUM(missions.status IN ('failed', 'abandoned') OR ${isExpiredSql}), 0) AS unsuccessful,
          COALESCE(SUM(${openMissionsSql}), 0) AS open,
          COALESCE(SUM(CASE WHEN missions.status = 'completed' THEN missions.final_reward END), 0) AS earned,
          COALESCE(SUM(missions.donation), 0) AS donated,
          COALESCE(SUM(missions.status = 'completed' AND missions.is_wing), 0) AS wingCompleted,
          COALESCE(SUM(CASE WHEN missions.status = 'completed' AND missions.influence <> 'None' THEN length(missions.influence) END), 0) AS influence,
          COALESCE(SUM(CASE WHEN missions.status = 'completed' AND missions.category = 'massacre' THEN missions.kill_count END), 0) AS kills,
          COALESCE(SUM(CASE WHEN missions.status = 'completed' AND missions.category <> 'donation' THEN missions.items_delivered END), 0) AS cargoDelivered,
          COALESCE(SUM(CASE WHEN missions.status = 'completed' THEN missions.passenger_count END), 0) AS passengers,
          COUNT(DISTINCT missions.faction) AS factions,
          COUNT(DISTINCT missions.origin_system) AS originSystems,
          AVG(CASE WHEN missions.status = 'completed' AND missions.ended_at IS NOT NULL
            THEN (julianday(missions.ended_at) - julianday(missions.accepted_at)) * 86400000 END) AS averageDurationMs,
          MIN(missions.accepted_at) AS firstAcceptedAt
        ${missionsFromSql} ${sqlFilter.whereClause}
      `).get(...sqlFilter.parameters);

      const bestMission = run(`
        SELECT missions.title, missions.name, missions.faction, missions.final_reward, missions.ended_at, missions.category
        ${missionsFromSql} ${completedFilter}
        ORDER BY missions.final_reward DESC LIMIT 1
      `).get(...sqlFilter.parameters) ?? null;

      const topFaction = run(`
        SELECT missions.faction, COUNT(*) AS completed, COALESCE(SUM(missions.final_reward), 0) AS earned
        ${missionsFromSql} ${completedFilter}
        GROUP BY missions.faction ORDER BY earned DESC, completed DESC LIMIT 1
      `).get(...sqlFilter.parameters) ?? null;

      const busiestDay = run(`
        SELECT substr(missions.ended_at, 1, 10) AS day, COUNT(*) AS completed, COALESCE(SUM(missions.final_reward), 0) AS earned
        ${missionsFromSql} ${completedFilter} AND missions.ended_at IS NOT NULL
        GROUP BY day ORDER BY earned DESC LIMIT 1
      `).get(...sqlFilter.parameters) ?? null;

      response.json({ totals, bestMission, topFaction, busiestDay });
    });

    // GET /api/stats/missions/missions?commander=&status=&category=&search=&period=&from=&to=&sort=&order=&limit=&offset=
    router.get('/missions', (request, response) => {
      const sqlFilter = getHistoryFilter(request.query);
      const result = runPaginatedQuery(database, {
        selectSql: `SELECT ${missionColumnsSql} ${missionsFromSql}`,
        sqlFilter,
        orderByClause: getOrderByClause(request.query, {
          accepted: 'missions.accepted_at',
          ended: 'COALESCE(missions.ended_at, missions.redirected_at)',
          expiry: 'missions.expiry',
          reward: 'COALESCE(missions.final_reward, missions.reward)',
          faction: 'missions.faction',
          category: 'missions.category',
        }, 'accepted'),
        pagination: getPagination(request.query),
      });
      response.json(result);
    });

    return router;
  },
});

/** Totals for one massacre stack, and for each issuing faction in it. */
function summarizeStack(stack) {
  const factions = new Map();
  for (const mission of stack.missions) {
    if (!factions.has(mission.faction)) {
      factions.set(mission.faction, { faction: mission.faction, isPresent: mission.is_faction_present, missionCount: 0, redirectedCount: 0, killsRequired: 0, kills: 0, reward: 0, wingReward: 0, stations: new Set() });
    }
    const faction = factions.get(mission.faction);
    faction.missionCount += 1;
    if (mission.status === 'redirected') faction.redirectedCount += 1;
    faction.killsRequired += mission.kill_count ?? 0;
    faction.kills += Math.min(mission.kills, mission.kill_count ?? 0);
    faction.reward += mission.reward ?? 0;
    if (mission.is_wing) faction.wingReward += mission.reward ?? 0;
    if (mission.origin_station) faction.stations.add(mission.origin_station);
  }

  const factionList = [...factions.values()].map((faction) => ({ ...faction, stations: [...faction.stations], remaining: faction.killsRequired - faction.kills }));
  const maxKillsRequired = Math.max(0, ...factionList.map((faction) => faction.killsRequired));
  for (const faction of factionList) faction.difference = maxKillsRequired - faction.killsRequired;
  factionList.sort((first, second) => second.killsRequired - first.killsRequired || first.faction.localeCompare(second.faction));

  const totalKillCount = sumBy(stack.missions, 'kill_count');
  const reward = sumBy(stack.missions, 'reward');
  const killsRemaining = Math.max(0, ...factionList.map((faction) => faction.remaining));
  return {
    ...stack,
    factions: factionList,
    totals: {
      missionCount: stack.missions.length,
      redirectedCount: stack.missions.filter((mission) => mission.status === 'redirected').length,
      // Kills count for every issuing faction at once, so the stack takes as many as its largest faction.
      killsRequired: maxKillsRequired,
      killsRemaining,
      kills: maxKillsRequired - killsRemaining,
      totalKillCount,
      killRatio: maxKillsRequired > 0 ? totalKillCount / maxKillsRequired : 0,
      reward,
      wingReward: sumBy(stack.missions.filter((mission) => mission.is_wing), 'reward'),
      rewardPerKill: maxKillsRequired > 0 ? reward / maxKillsRequired : 0,
      nextExpiry: stack.missions.map((mission) => mission.expiry).filter(Boolean).sort()[0] ?? null,
    },
  };
}

function getCategory(name) {
  return CATEGORY_PATTERNS.find(([, pattern]) => pattern.test(name))?.[0] ?? 'other';
}

/** Completion events add "_name" to the internal name; accepted ones don't. */
function stripNameSuffix(name) {
  return name.replace(/_name$/i, '');
}

/** "$Indite_Name;" or "indite" -> "indite", to match mission commodities with cargo. */
function getCommodityKey(commodity) {
  return commodity.replace(/^\$/, '').replace(/_name;$/i, '').toLowerCase();
}

/** "$MissionUtil_FactionTag_Pirate;" -> "Pirate", for target types without a localised name. */
function cleanTag(tag) {
  if (!tag) return null;
  return tag.replace(/^\$/, '').replace(/;$/, '').replace(/^MissionUtil_FactionTag_/i, '');
}

function isSameGameMode(missionOdyssey, currentOdyssey) {
  if (missionOdyssey === null || currentOdyssey === undefined) return true;
  return Boolean(missionOdyssey) === Boolean(currentOdyssey);
}

