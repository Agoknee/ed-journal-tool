import { Router } from 'express';
import { normalizeItem } from '../../game-data/names.mjs';
import { getShipTypeName, isOwnShip } from '../../game-data/ships.mjs';
import { defineStatModule } from '../define-stat-module.mjs';
import {
  SqlFilter, addStandardFilters, getCommanderIdFilter, getOrderByClause, getPagination, parseJsonColumns, runPaginatedQuery,
} from '../query-helpers.mjs';

/** FSDJump BoostUsed values: 1-3 are FSD injection (synthesis) boosts, 4+ are neutron/white dwarf supercharges. */
const SUPERCHARGED_BOOST_THRESHOLD = 4;

const SHIP_STATE_KEY = 'ship';
/** The star class StartJump announces for the system being jumped to; FSDJump doesn't log it. */
const PENDING_STAR_STATE_KEY = 'pendingStar';

/** SQL conditions for the jump type filter shared by the summary, jump list and map. */
const JUMP_TYPE_CONDITIONS = {
  fsd: "jumps.jump_type = 'fsd'",
  carrier: "jumps.jump_type = 'carrier'",
  normal: "jumps.jump_type = 'fsd' AND jumps.is_supercharged = 0",
  supercharged: 'jumps.is_supercharged = 1',
  synthesis: "jumps.jump_type = 'fsd' AND jumps.is_supercharged = 0 AND jumps.boost_used > 0",
  taxi: 'jumps.is_taxi = 1',
  multicrew: 'jumps.is_multicrew = 1',
  own: "jumps.jump_type = 'fsd' AND jumps.is_taxi = 0 AND jumps.is_multicrew = 0",
};

/** Filters that pick one value of a column, by query parameter. */
const CHOICE_FILTER_COLUMNS = {
  ship: 'jumps.ship_type',
  starClass: 'jumps.star_class',
  allegiance: 'jumps.allegiance',
  economy: 'jumps.economy',
  government: 'jumps.government',
  security: 'jumps.security',
};

/**
 * Every filter the jump list, summary and map share: commander, time range, search, jump type,
 * the column choices and first visits only.
 */
function getJumpFilter(query, { isSearchable = true } = {}) {
  const sqlFilter = addStandardFilters(new SqlFilter(), query, {
    commanderColumn: 'jumps.commander_id',
    timestampColumn: 'jumps.timestamp',
    searchColumns: isSearchable ? ['jumps.star_system', 'jumps.from_system'] : [],
  });
  if (JUMP_TYPE_CONDITIONS[query.type]) sqlFilter.add(JUMP_TYPE_CONDITIONS[query.type]);
  for (const [parameter, column] of Object.entries(CHOICE_FILTER_COLUMNS)) {
    if (query[parameter]) sqlFilter.add(`${column} = ?`, String(query[parameter]));
  }
  if (query.firstVisit === '1' || query.firstVisit === 'true') sqlFilter.add('jumps.is_first_visit = 1');
  return sqlFilter;
}

/** Most jumps the map gets in one response (the latest ones, when there are more). */
const MAX_MAP_JUMPS = 250_000;

/** Map jump kinds, as the client draws them. */
const MAP_JUMP_KINDS = { normal: 0, supercharged: 1, synthesis: 2, carrier: 3, taxi: 4 };

/**
 * Current commander location plus a log of every FSD and carrier jump: the ship flown, the star
 * jumped to and the system's allegiance, economy, government and security, for filtering and the map.
 */
export default defineStatModule({
  name: 'travel',
  title: 'Travel',
  description: 'Current location and jump history (normal, supercharged, synthesis-boosted, taxi and carrier jumps).',
  // 2: ship, star class, system details, taxi/multicrew, first visits and where each jump started.
  version: 2,
  events: [
    'LoadGame', 'Loadout', 'StartJump', 'Location', 'FSDJump', 'CarrierJump', 'Docked', 'Undocked',
    'SupercruiseEntry', 'SupercruiseExit', 'ApproachBody', 'LeaveBody',
  ],
  ownedObjects: [
    { type: 'table', name: 'travel_locations' },
    { type: 'table', name: 'travel_jumps' },
  ],
  schemaSql: `
    CREATE TABLE IF NOT EXISTS travel_locations (
      commander_id    INTEGER PRIMARY KEY REFERENCES commanders(id),
      star_system     TEXT,
      system_address  INTEGER,
      star_pos        TEXT,
      body            TEXT,
      body_type       TEXT,
      is_docked       INTEGER NOT NULL DEFAULT 0,
      station_name    TEXT,
      station_type    TEXT,
      market_id       INTEGER,
      updated_at      TEXT
    );

    CREATE TABLE IF NOT EXISTS travel_jumps (
      id               INTEGER PRIMARY KEY,
      commander_id     INTEGER NOT NULL REFERENCES commanders(id),
      entry_id         INTEGER NOT NULL,
      timestamp        TEXT NOT NULL,
      jump_type        TEXT NOT NULL,            -- fsd | carrier
      from_system      TEXT,
      star_system      TEXT,
      system_address   INTEGER,
      star_pos         TEXT,
      jump_distance    REAL,
      fuel_used        REAL,
      boost_used       INTEGER NOT NULL DEFAULT 0,
      is_supercharged  INTEGER NOT NULL DEFAULT 0,
      from_star_pos    TEXT,                     -- where the jump started (the system before), for the map
      ship_type        TEXT,                     -- the commander's own ship; null for taxi, multicrew and carrier jumps
      ship_name        TEXT,
      star_class       TEXT,                     -- the arrival star, from StartJump (or an earlier visit)
      allegiance       TEXT,
      economy          TEXT,
      government       TEXT,
      security         TEXT,
      population       INTEGER,
      is_taxi          INTEGER NOT NULL DEFAULT 0,
      is_multicrew     INTEGER NOT NULL DEFAULT 0,
      is_first_visit   INTEGER NOT NULL DEFAULT 0  -- the commander's first jump into this system in the journals
    );
    CREATE INDEX IF NOT EXISTS idx_travel_jumps_commander_time ON travel_jumps(commander_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_travel_jumps_time ON travel_jumps(timestamp);
    CREATE INDEX IF NOT EXISTS idx_travel_jumps_system ON travel_jumps(system_address, commander_id);
  `,

  createProcessor(database) {
    const selectLocation = database.prepare('SELECT * FROM travel_locations WHERE commander_id = ?');
    const upsertLocation = database.prepare(`
      INSERT INTO travel_locations
        (commander_id, star_system, system_address, star_pos, body, body_type, is_docked, station_name, station_type, market_id, updated_at)
      VALUES (:commanderId, :starSystem, :systemAddress, :starPos, :body, :bodyType, :isDocked, :stationName, :stationType, :marketId, :timestamp)
      ON CONFLICT (commander_id) DO UPDATE SET
        star_system = excluded.star_system, system_address = excluded.system_address, star_pos = excluded.star_pos,
        body = excluded.body, body_type = excluded.body_type, is_docked = excluded.is_docked,
        station_name = excluded.station_name, station_type = excluded.station_type, market_id = excluded.market_id,
        updated_at = excluded.updated_at
    `);
    const insertJump = database.prepare(`
      INSERT INTO travel_jumps
        (commander_id, entry_id, timestamp, jump_type, from_system, star_system, system_address, star_pos,
         jump_distance, fuel_used, boost_used, is_supercharged, from_star_pos, ship_type, ship_name, star_class,
         allegiance, economy, government, security, population, is_taxi, is_multicrew, is_first_visit)
      VALUES (:commanderId, :entryId, :timestamp, :jumpType, :fromSystem, :starSystem, :systemAddress, :starPos,
         :jumpDistance, :fuelUsed, :boostUsed, :isSupercharged, :fromStarPos, :shipType, :shipName, :starClass,
         :allegiance, :economy, :government, :security, :population, :isTaxi, :isMulticrew, :isFirstVisit)
    `);
    const selectEarlierVisit = database.prepare('SELECT 1 FROM travel_jumps WHERE system_address = ? AND commander_id = ? LIMIT 1');
    // Carrier jumps don't say what the star is; another jump into the same system may have.
    const selectKnownStarClass = database.prepare('SELECT star_class FROM travel_jumps WHERE system_address = ? AND star_class IS NOT NULL LIMIT 1');

    /** The columns both kinds of jump record from the arrival event and the location before it. */
    const getJumpDetails = (commanderId, data, previousLocation) => ({
      fromSystem: previousLocation?.star_system ?? null,
      fromStarPos: previousLocation?.star_pos ?? null,
      starSystem: data.StarSystem ?? null,
      systemAddress: data.SystemAddress ?? null,
      starPos: data.StarPos ? JSON.stringify(data.StarPos) : null,
      allegiance: data.SystemAllegiance || null,
      economy: cleanSystemValue(data.SystemEconomy_Localised),
      government: cleanSystemValue(data.SystemGovernment_Localised),
      security: cleanSystemValue(data.SystemSecurity_Localised),
      population: Number.isFinite(data.Population) ? data.Population : null,
      isFirstVisit: Number(data.SystemAddress !== undefined && !selectEarlierVisit.get(data.SystemAddress, commanderId)),
    });
    const findKnownStarClass = (systemAddress) => (systemAddress === undefined ? null : selectKnownStarClass.get(systemAddress)?.star_class ?? null);

    /** Applies changes on top of the commander's last known location. */
    const updateLocation = (commanderId, timestamp, locationChanges) => {
      const previousLocation = selectLocation.get(commanderId);
      upsertLocation.run({
        starSystem: previousLocation?.star_system ?? null,
        systemAddress: previousLocation?.system_address ?? null,
        starPos: previousLocation?.star_pos ?? null,
        body: previousLocation?.body ?? null,
        bodyType: previousLocation?.body_type ?? null,
        isDocked: previousLocation?.is_docked ?? 0,
        stationName: previousLocation?.station_name ?? null,
        stationType: previousLocation?.station_type ?? null,
        marketId: previousLocation?.market_id ?? null,
        ...locationChanges,
        commanderId,
        timestamp,
      });
      return previousLocation;
    };

    const getSystemLocation = (data) => ({
      starSystem: data.StarSystem ?? null,
      systemAddress: data.SystemAddress ?? null,
      starPos: data.StarPos ? JSON.stringify(data.StarPos) : null,
      body: data.Body ?? null,
      bodyType: data.BodyType ?? null,
    });

    const getStationLocation = (data) => (data.Docked || data.event === 'Docked'
      ? { isDocked: 1, stationName: data.StationName ?? null, stationType: data.StationType ?? null, marketId: data.MarketID ?? null }
      : { isDocked: 0, stationName: null, stationType: null, marketId: null });

    return ({ id: entryId, commanderId, event, timestamp, data }, moduleState) => {
      switch (event) {
        case 'LoadGame':
          // Logged in on foot or in an SRV: the ship they came in is still theirs.
          if (isOwnShip(data.Ship, data.ShipID)) moduleState.set(SHIP_STATE_KEY, { type: normalizeItem(data.Ship), name: data.ShipName ?? null });
          break;

        case 'Loadout':
          if (data.Ship) moduleState.set(SHIP_STATE_KEY, { type: normalizeItem(data.Ship), name: data.ShipName ?? null });
          break;

        case 'StartJump':
          if (data.JumpType === 'Hyperspace') {
            moduleState.set(PENDING_STAR_STATE_KEY, { systemAddress: data.SystemAddress ?? null, starClass: data.StarClass ?? null });
          }
          break;

        case 'Location':
          updateLocation(commanderId, timestamp, { ...getSystemLocation(data), ...getStationLocation(data) });
          break;

        case 'FSDJump': {
          const previousLocation = updateLocation(commanderId, timestamp, { ...getSystemLocation(data), ...getStationLocation({}) });
          const boostUsed = data.BoostUsed ?? 0;
          const isTaxi = data.Taxi === true;
          const isMulticrew = data.Multicrew === true;
          // Someone else's ship (a taxi or a multicrew session) isn't the commander's own.
          const ship = isTaxi || isMulticrew ? {} : moduleState.get(SHIP_STATE_KEY) ?? {};
          const pendingStar = moduleState.get(PENDING_STAR_STATE_KEY);
          moduleState.set(PENDING_STAR_STATE_KEY, null);
          const starClass = pendingStar && pendingStar.systemAddress === (data.SystemAddress ?? null) ? pendingStar.starClass : null;
          insertJump.run({
            commanderId, entryId, timestamp,
            ...getJumpDetails(commanderId, data, previousLocation),
            jumpType: 'fsd',
            jumpDistance: data.JumpDist ?? null,
            fuelUsed: data.FuelUsed ?? null,
            boostUsed,
            isSupercharged: Number(boostUsed >= SUPERCHARGED_BOOST_THRESHOLD),
            shipType: ship.type ?? null,
            shipName: ship.name ?? null,
            starClass: starClass ?? findKnownStarClass(data.SystemAddress),
            isTaxi: Number(isTaxi),
            isMulticrew: Number(isMulticrew),
          });
          break;
        }

        case 'CarrierJump': {
          const previousLocation = updateLocation(commanderId, timestamp, { ...getSystemLocation(data), ...getStationLocation(data) });
          insertJump.run({
            commanderId, entryId, timestamp,
            ...getJumpDetails(commanderId, data, previousLocation),
            jumpType: 'carrier',
            jumpDistance: calculateDistance(previousLocation?.star_pos, data.StarPos),
            fuelUsed: null,
            boostUsed: 0,
            isSupercharged: 0,
            shipType: null,
            shipName: null,
            starClass: findKnownStarClass(data.SystemAddress),
            isTaxi: 0,
            isMulticrew: 0,
          });
          break;
        }

        case 'Docked':
          updateLocation(commanderId, timestamp, {
            starSystem: data.StarSystem ?? null,
            systemAddress: data.SystemAddress ?? null,
            ...getStationLocation(data),
          });
          break;

        case 'Undocked':
          updateLocation(commanderId, timestamp, getStationLocation({}));
          break;

        case 'SupercruiseEntry':
          updateLocation(commanderId, timestamp, { body: null, bodyType: null, ...getStationLocation({}) });
          break;

        case 'SupercruiseExit':
        case 'ApproachBody':
          updateLocation(commanderId, timestamp, { body: data.Body ?? null, bodyType: data.BodyType ?? 'Planet' });
          break;

        case 'LeaveBody':
          updateLocation(commanderId, timestamp, { body: null, bodyType: null });
          break;
      }
    };
  },

  createRouter(database) {
    const router = Router();

    // GET /api/stats/travel/locations?commander=
    router.get('/locations', (request, response) => {
      const locationRows = database.prepare(`
        SELECT commanders.name AS commander_name, locations.*
        FROM travel_locations AS locations
        JOIN commanders ON commanders.id = locations.commander_id
        WHERE (?1 IS NULL OR locations.commander_id = ?1)
        ORDER BY locations.updated_at DESC
      `).all(getCommanderIdFilter(request.query));
      response.json({ locations: parseJsonColumns(locationRows, ['star_pos']) });
    });

    // GET /api/stats/travel/summary?<jump filters>
    router.get('/summary', (request, response) => {
      const sqlFilter = getJumpFilter(request.query);
      const summaryColumns = `
        COUNT(*) AS total_jumps,
        COALESCE(SUM(jump_type = 'fsd'), 0) AS fsd_jumps,
        COALESCE(SUM(jump_type = 'fsd' AND is_supercharged = 0), 0) AS normal_jumps,
        COALESCE(SUM(jump_type = 'fsd' AND is_supercharged = 1), 0) AS supercharged_jumps,
        COALESCE(SUM(jump_type = 'fsd' AND is_supercharged = 0 AND boost_used > 0), 0) AS synthesis_boosted_jumps,
        COALESCE(SUM(jump_type = 'carrier'), 0) AS carrier_jumps,
        COALESCE(SUM(jump_distance), 0) AS total_distance_ly,
        COALESCE(SUM(CASE WHEN jump_type = 'fsd' THEN jump_distance END), 0) AS fsd_distance_ly,
        COALESCE(SUM(CASE WHEN jump_type = 'carrier' THEN jump_distance END), 0) AS carrier_distance_ly,
        MAX(CASE WHEN jump_type = 'fsd' THEN jump_distance END) AS longest_fsd_jump_ly,
        COALESCE(SUM(fuel_used), 0) AS fuel_used_tonnes,
        COUNT(DISTINCT system_address) AS unique_systems,
        COALESCE(SUM(is_first_visit), 0) AS first_visits,
        COALESCE(SUM(is_taxi), 0) AS taxi_jumps,
        MIN(timestamp) AS first_jump_at,
        MAX(timestamp) AS last_jump_at
      `;

      const perCommander = database.prepare(`
        SELECT jumps.commander_id, commanders.name AS commander_name, ${summaryColumns}
        FROM travel_jumps AS jumps JOIN commanders ON commanders.id = jumps.commander_id
        ${sqlFilter.whereClause}
        GROUP BY jumps.commander_id
        ORDER BY total_jumps DESC
      `).all(...sqlFilter.parameters);

      const combined = database.prepare(`
        SELECT ${summaryColumns} FROM travel_jumps AS jumps ${sqlFilter.whereClause}
      `).get(...sqlFilter.parameters);

      response.json({ combined, perCommander });
    });

    // Jump filters, shared by the routes below: commander=&period=|from=&to=&search=
    //   &type=fsd|own|normal|supercharged|synthesis|taxi|multicrew|carrier
    //   &ship=&starClass=&allegiance=&economy=&government=&security=&firstVisit=1

    // GET /api/stats/travel/jumps?<jump filters>&sort=&order=&limit=&offset=
    router.get('/jumps', (request, response) => {
      const pageResult = runPaginatedQuery(database, {
        selectSql: `
          SELECT jumps.id, jumps.commander_id, commanders.name AS commander_name, jumps.timestamp, jumps.jump_type,
            jumps.from_system, jumps.star_system, jumps.jump_distance, jumps.fuel_used, jumps.boost_used, jumps.is_supercharged,
            jumps.ship_type, jumps.ship_name, jumps.star_class, jumps.allegiance, jumps.economy, jumps.government,
            jumps.security, jumps.population, jumps.is_taxi, jumps.is_multicrew, jumps.is_first_visit
          FROM travel_jumps AS jumps JOIN commanders ON commanders.id = jumps.commander_id
        `,
        sqlFilter: getJumpFilter(request.query),
        orderByClause: getOrderByClause(request.query, {
          timestamp: 'jumps.timestamp',
          distance: 'jumps.jump_distance',
          system: 'jumps.star_system',
          star: 'jumps.star_class',
          ship: 'jumps.ship_type',
          fuel: 'jumps.fuel_used',
        }, 'timestamp'),
        pagination: getPagination(request.query),
      });
      response.json({
        ...pageResult,
        rows: pageResult.rows.map((jump) => ({ ...jump, ship_type_name: jump.ship_type ? getShipTypeName(jump.ship_type) : null })),
      });
    });

    // GET /api/stats/travel/filters?commander=&period=|from=&to=
    // The choices for the jump list's filters, with how many jumps each has, in the time range.
    router.get('/filters', (request, response) => {
      const rangeFilter = addStandardFilters(new SqlFilter(), request.query, {
        commanderColumn: 'jumps.commander_id',
        timestampColumn: 'jumps.timestamp',
      });
      const choicesFor = (column) => database.prepare(`
        SELECT ${column} AS value, COUNT(*) AS count FROM travel_jumps AS jumps ${rangeFilter.whereClause}
        ${rangeFilter.whereClause ? 'AND' : 'WHERE'} ${column} IS NOT NULL GROUP BY ${column}
      `).all(...rangeFilter.parameters);
      const byLabel = (first, second) => first.label.localeCompare(second.label);
      const labelled = (column, getLabel = (value) => value) => choicesFor(column)
        .map((choice) => ({ ...choice, label: getLabel(choice.value) }))
        .sort(byLabel);
      response.json({
        ships: labelled('jumps.ship_type', getShipTypeName),
        // By how many jumps, so the common stars come first (the client names them).
        starClasses: choicesFor('jumps.star_class').map((choice) => ({ ...choice, label: choice.value })).sort((first, second) => second.count - first.count),
        allegiances: labelled('jumps.allegiance'),
        economies: labelled('jumps.economy'),
        governments: labelled('jumps.government'),
        securities: labelled('jumps.security'),
      });
    });

    // GET /api/stats/travel/map?<jump filters>
    // Every matching jump with a known position, oldest first, for the galaxy map and its replay.
    // Systems are listed once and jumps point at them, which keeps a long expedition's response small.
    router.get('/map', (request, response) => {
      const sqlFilter = getJumpFilter(request.query).add('jumps.star_pos IS NOT NULL');
      const { total } = database.prepare(`SELECT COUNT(*) AS total FROM travel_jumps AS jumps ${sqlFilter.whereClause}`).get(...sqlFilter.parameters);
      const jumpRows = database.prepare(`
        SELECT * FROM (
          SELECT jumps.id, jumps.commander_id, jumps.timestamp, jumps.jump_type, jumps.is_supercharged, jumps.boost_used,
            jumps.is_taxi, jumps.from_system, jumps.from_star_pos, jumps.star_system, jumps.star_pos, jumps.star_class,
            jumps.jump_distance, jumps.is_first_visit
          FROM travel_jumps AS jumps ${sqlFilter.whereClause}
          ORDER BY jumps.timestamp DESC, jumps.id DESC LIMIT ?
        ) ORDER BY timestamp, id
      `).all(...sqlFilter.parameters, MAX_MAP_JUMPS);

      const commanderIds = [...new Set(jumpRows.map((jump) => jump.commander_id))];
      const commanderNames = new Map(database.prepare('SELECT id, name FROM commanders').all().map((commander) => [commander.id, commander.name]));
      const commanderIndexes = new Map(commanderIds.map((commanderId, index) => [commanderId, index]));

      const systems = [];
      const systemIndexes = new Map();
      /** A system's index in the list, adding it the first time (by name and position). */
      const indexSystem = (name, starPosJson, starClass = null) => {
        if (!starPosJson) return -1;
        const key = `${name}|${starPosJson}`;
        let index = systemIndexes.get(key);
        if (index === undefined) {
          const [x, y, z] = JSON.parse(starPosJson);
          index = systems.length;
          systems.push({ name, x, y, z, starClass, visits: 0 });
          systemIndexes.set(key, index);
        }
        if (starClass && !systems[index].starClass) systems[index].starClass = starClass;
        return index;
      };

      const jumps = { time: [], commander: [], from: [], to: [], kind: [], distance: [], firstVisit: [] };
      for (const jump of jumpRows) {
        const toIndex = indexSystem(jump.star_system, jump.star_pos, jump.star_class);
        systems[toIndex].visits += 1;
        jumps.time.push(Math.round(Date.parse(jump.timestamp) / 1000));
        jumps.commander.push(commanderIndexes.get(jump.commander_id));
        jumps.from.push(indexSystem(jump.from_system, jump.from_star_pos));
        jumps.to.push(toIndex);
        jumps.kind.push(getMapJumpKind(jump));
        jumps.distance.push(jump.jump_distance);
        jumps.firstVisit.push(jump.is_first_visit);
      }

      response.json({
        commanders: commanderIds.map((commanderId) => ({ id: commanderId, name: commanderNames.get(commanderId) ?? '?' })),
        systems,
        jumps,
        total,
        isTruncated: total > jumpRows.length,
      });
    });

    // GET /api/stats/travel/top-systems?commander=&period=&limit=
    router.get('/top-systems', (request, response) => {
      const sqlFilter = addStandardFilters(new SqlFilter(), request.query, {
        commanderColumn: 'commander_id',
        timestampColumn: 'timestamp',
      });
      const { limit } = getPagination({ limit: request.query.limit ?? 20 });
      const systemRows = database.prepare(`
        SELECT star_system, COUNT(*) AS visit_count, MAX(timestamp) AS last_visit
        FROM travel_jumps ${sqlFilter.whereClause}
        GROUP BY system_address
        ORDER BY visit_count DESC
        LIMIT ?
      `).all(...sqlFilter.parameters, limit);
      response.json({ systems: systemRows });
    });

    return router;
  },
});

function getMapJumpKind(jump) {
  if (jump.jump_type === 'carrier') return MAP_JUMP_KINDS.carrier;
  if (jump.is_taxi) return MAP_JUMP_KINDS.taxi;
  if (jump.is_supercharged) return MAP_JUMP_KINDS.supercharged;
  if (jump.boost_used > 0) return MAP_JUMP_KINDS.synthesis;
  return MAP_JUMP_KINDS.normal;
}

/** The game logs "None" (or an untranslated key) where a system has no economy, government or security. */
function cleanSystemValue(value) {
  if (!value || value.startsWith('$') || value === 'None') return null;
  return value;
}

function calculateDistance(previousStarPosJson, currentStarPos) {
  if (!previousStarPosJson || !Array.isArray(currentStarPos)) return null;
  const previousStarPos = JSON.parse(previousStarPosJson);
  const squaredDistance = previousStarPos.reduce((total, coordinate, index) => total + (coordinate - currentStarPos[index]) ** 2, 0);
  return Math.round(Math.sqrt(squaredDistance) * 100) / 100;
}
