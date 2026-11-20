import { Router } from 'express';
import { defineStatModule } from '../define-stat-module.mjs';
import {
  SqlFilter, addStandardFilters, getCommanderIdFilter, getOrderByClause, getPagination, parseJsonColumns, runPaginatedQuery,
} from '../query-helpers.mjs';

/** FSDJump BoostUsed values: 1-3 are FSD injection (synthesis) boosts, 4+ are neutron/white dwarf supercharges. */
const SUPERCHARGED_BOOST_THRESHOLD = 4;

/**
 * Current commander location plus a log of every FSD and carrier jump.
 */
export default defineStatModule({
  name: 'travel',
  title: 'Travel',
  description: 'Current location and jump history (normal, supercharged, synthesis-boosted and carrier jumps).',
  version: 1,
  events: ['Location', 'FSDJump', 'CarrierJump', 'Docked', 'Undocked', 'SupercruiseEntry', 'SupercruiseExit', 'ApproachBody', 'LeaveBody'],
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
      is_supercharged  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_travel_jumps_commander_time ON travel_jumps(commander_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_travel_jumps_time ON travel_jumps(timestamp);
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
         jump_distance, fuel_used, boost_used, is_supercharged)
      VALUES (:commanderId, :entryId, :timestamp, :jumpType, :fromSystem, :starSystem, :systemAddress, :starPos,
         :jumpDistance, :fuelUsed, :boostUsed, :isSupercharged)
    `);

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

    return ({ id: entryId, commanderId, event, timestamp, data }) => {
      switch (event) {
        case 'Location':
          updateLocation(commanderId, timestamp, { ...getSystemLocation(data), ...getStationLocation(data) });
          break;

        case 'FSDJump': {
          const previousLocation = updateLocation(commanderId, timestamp, { ...getSystemLocation(data), ...getStationLocation({}) });
          const boostUsed = data.BoostUsed ?? 0;
          insertJump.run({
            commanderId, entryId, timestamp,
            jumpType: 'fsd',
            fromSystem: previousLocation?.star_system ?? null,
            starSystem: data.StarSystem ?? null,
            systemAddress: data.SystemAddress ?? null,
            starPos: data.StarPos ? JSON.stringify(data.StarPos) : null,
            jumpDistance: data.JumpDist ?? null,
            fuelUsed: data.FuelUsed ?? null,
            boostUsed,
            isSupercharged: Number(boostUsed >= SUPERCHARGED_BOOST_THRESHOLD),
          });
          break;
        }

        case 'CarrierJump': {
          const previousLocation = updateLocation(commanderId, timestamp, { ...getSystemLocation(data), ...getStationLocation(data) });
          insertJump.run({
            commanderId, entryId, timestamp,
            jumpType: 'carrier',
            fromSystem: previousLocation?.star_system ?? null,
            starSystem: data.StarSystem ?? null,
            systemAddress: data.SystemAddress ?? null,
            starPos: data.StarPos ? JSON.stringify(data.StarPos) : null,
            jumpDistance: calculateDistance(previousLocation?.star_pos, data.StarPos),
            fuelUsed: null,
            boostUsed: 0,
            isSupercharged: 0,
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

    // GET /api/stats/travel/summary?commander=&period=&from=&to=
    router.get('/summary', (request, response) => {
      const sqlFilter = addStandardFilters(new SqlFilter(), request.query, {
        commanderColumn: 'jumps.commander_id',
        timestampColumn: 'jumps.timestamp',
      });
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

    // GET /api/stats/travel/jumps?commander=&period=&from=&to=&search=&type=fsd|carrier|supercharged|synthesis&sort=&order=&limit=&offset=
    router.get('/jumps', (request, response) => {
      const sqlFilter = addStandardFilters(new SqlFilter(), request.query, {
        commanderColumn: 'jumps.commander_id',
        timestampColumn: 'jumps.timestamp',
        searchColumns: ['jumps.star_system', 'jumps.from_system'],
      });
      const jumpTypeConditions = {
        fsd: "jumps.jump_type = 'fsd'",
        carrier: "jumps.jump_type = 'carrier'",
        normal: "jumps.jump_type = 'fsd' AND jumps.is_supercharged = 0",
        supercharged: 'jumps.is_supercharged = 1',
        synthesis: "jumps.jump_type = 'fsd' AND jumps.is_supercharged = 0 AND jumps.boost_used > 0",
      };
      if (jumpTypeConditions[request.query.type]) sqlFilter.add(jumpTypeConditions[request.query.type]);

      const pageResult = runPaginatedQuery(database, {
        selectSql: `
          SELECT jumps.id, jumps.commander_id, commanders.name AS commander_name, jumps.timestamp, jumps.jump_type,
            jumps.from_system, jumps.star_system, jumps.jump_distance, jumps.fuel_used, jumps.boost_used, jumps.is_supercharged
          FROM travel_jumps AS jumps JOIN commanders ON commanders.id = jumps.commander_id
        `,
        sqlFilter,
        orderByClause: getOrderByClause(request.query, {
          timestamp: 'jumps.timestamp',
          distance: 'jumps.jump_distance',
          system: 'jumps.star_system',
        }, 'timestamp'),
        pagination: getPagination(request.query),
      });
      response.json(pageResult);
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

function calculateDistance(previousStarPosJson, currentStarPos) {
  if (!previousStarPosJson || !Array.isArray(currentStarPos)) return null;
  const previousStarPos = JSON.parse(previousStarPosJson);
  const squaredDistance = previousStarPos.reduce((total, coordinate, index) => total + (coordinate - currentStarPos[index]) ** 2, 0);
  return Math.round(Math.sqrt(squaredDistance) * 100) / 100;
}
