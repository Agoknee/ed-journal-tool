import { Router } from 'express';
import { defineStatModule } from '../define-stat-module.mjs';
import { SqlFilter, addStandardFilters, getOrderByClause, getPagination, runPaginatedQuery } from '../query-helpers.mjs';

const CARRIER_STATION_TYPES = new Set(['FleetCarrier', 'SquadronCarrier']);
const CALLSIGN_PATTERN = /^(?:[A-Z0-9]{3}-[A-Z0-9]{3}|[A-Z0-9]{4})$/;

/**
 * Directory of every station/carrier market seen in the journals, so other stats can
 * show names for market and carrier ids. Carrier names come from carrier management,
 * supercruise drops and FSS signals.
 */
export default defineStatModule({
  name: 'markets',
  title: 'Market Directory',
  description: 'Stations and carriers seen in journals, used to resolve market/carrier ids to names.',
  version: 2,
  events: [
    'Docked', 'Location', 'CarrierJump', 'Market', 'CarrierStats', 'CarrierBuy', 'CarrierNameChange',
    'CarrierLocation', 'SupercruiseDestinationDrop', 'FSSSignalDiscovered',
  ],
  ownedObjects: [
    { type: 'table', name: 'market_directory_entries' },
    { type: 'table', name: 'carrier_signal_names' },
    { type: 'view', name: 'market_directory' },
  ],
  schemaSql: `
    CREATE TABLE IF NOT EXISTS market_directory_entries (
      market_id         INTEGER PRIMARY KEY,
      station_name      TEXT,
      station_type      TEXT,
      star_system       TEXT,
      system_address    INTEGER,
      carrier_callsign  TEXT,
      carrier_name      TEXT,
      carrier_type      TEXT,
      last_seen         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_market_directory_callsign ON market_directory_entries(carrier_callsign);

    CREATE TABLE IF NOT EXISTS carrier_signal_names (
      callsign      TEXT PRIMARY KEY,
      carrier_name  TEXT NOT NULL,
      last_seen     TEXT
    );

    CREATE VIEW IF NOT EXISTS market_directory AS
    SELECT
      entries.market_id,
      entries.station_name,
      entries.station_type,
      entries.star_system,
      entries.system_address,
      entries.carrier_callsign AS callsign,
      COALESCE(entries.carrier_name, signals.carrier_name) AS carrier_name,
      entries.carrier_type,
      entries.carrier_callsign IS NOT NULL AS is_carrier,
      CASE
        WHEN entries.carrier_callsign IS NULL THEN entries.station_name
        WHEN COALESCE(entries.carrier_name, signals.carrier_name) IS NULL THEN entries.carrier_callsign
        ELSE COALESCE(entries.carrier_name, signals.carrier_name) || ' (' || entries.carrier_callsign || ')'
      END AS display_name,
      entries.last_seen
    FROM market_directory_entries AS entries
    LEFT JOIN carrier_signal_names AS signals ON signals.callsign = entries.carrier_callsign;
  `,

  createProcessor(database) {
    const upsertMarket = database.prepare(`
      INSERT INTO market_directory_entries
        (market_id, station_name, station_type, star_system, system_address, carrier_callsign, carrier_name, carrier_type, last_seen)
      VALUES (:marketId, :stationName, :stationType, :starSystem, :systemAddress, :carrierCallsign, :carrierName, :carrierType, :timestamp)
      ON CONFLICT (market_id) DO UPDATE SET
        station_name     = COALESCE(excluded.station_name, station_name),
        station_type     = COALESCE(excluded.station_type, station_type),
        star_system      = COALESCE(excluded.star_system, star_system),
        system_address   = COALESCE(excluded.system_address, system_address),
        carrier_callsign = COALESCE(excluded.carrier_callsign, carrier_callsign),
        carrier_name     = COALESCE(excluded.carrier_name, carrier_name),
        carrier_type     = COALESCE(excluded.carrier_type, carrier_type),
        last_seen        = MAX(COALESCE(excluded.last_seen, ''), COALESCE(last_seen, ''))
    `);
    const upsertSignalName = database.prepare(`
      INSERT INTO carrier_signal_names (callsign, carrier_name, last_seen) VALUES (?, ?, ?)
      ON CONFLICT (callsign) DO UPDATE SET carrier_name = excluded.carrier_name, last_seen = excluded.last_seen
    `);

    const saveMarket = (timestamp, marketDetails) => {
      // The game sometimes reports MarketID 2^64-1 as a placeholder for "no market".
      if (!Number.isSafeInteger(marketDetails.marketId)) return;
      upsertMarket.run({
        stationName: null, stationType: null, starSystem: null, systemAddress: null,
        carrierCallsign: null, carrierName: null, carrierType: null,
        ...marketDetails,
        timestamp,
      });
    };

    const saveStation = (timestamp, data) => {
      const isCarrier = CARRIER_STATION_TYPES.has(data.StationType);
      saveMarket(timestamp, {
        marketId: data.MarketID,
        stationName: data.StationName ?? null,
        stationType: data.StationType ?? null,
        starSystem: data.StarSystem ?? null,
        systemAddress: data.SystemAddress ?? null,
        carrierCallsign: isCarrier ? data.StationName : null,
      });
    };

    return ({ event, timestamp, data }) => {
      switch (event) {
        case 'Docked':
        case 'Market':
          saveStation(timestamp, data);
          break;

        case 'Location':
        case 'CarrierJump':
          if (data.Docked) saveStation(timestamp, data);
          break;

        case 'CarrierStats':
        case 'CarrierBuy':
        case 'CarrierNameChange':
          saveMarket(timestamp, {
            marketId: data.CarrierID,
            carrierCallsign: data.Callsign ?? null,
            carrierName: data.Name ?? null,
            carrierType: data.CarrierType ?? null,
            stationName: data.Callsign ?? null,
            stationType: data.CarrierType ?? null,
          });
          break;

        case 'CarrierLocation':
          saveMarket(timestamp, {
            marketId: data.CarrierID,
            carrierType: data.CarrierType ?? null,
            starSystem: data.StarSystem ?? null,
            systemAddress: data.SystemAddress ?? null,
          });
          break;

        case 'SupercruiseDestinationDrop': {
          const carrierSignal = parseCarrierSignalName(data.Type);
          if (data.MarketID && carrierSignal) {
            saveMarket(timestamp, {
              marketId: data.MarketID,
              carrierCallsign: carrierSignal.callsign,
              carrierName: carrierSignal.carrierName,
            });
          }
          break;
        }

        case 'FSSSignalDiscovered': {
          if (data.SignalType !== 'FleetCarrier') break;
          const carrierSignal = parseCarrierSignalName(data.SignalName);
          if (carrierSignal?.carrierName) upsertSignalName.run(carrierSignal.callsign, carrierSignal.carrierName, timestamp);
          break;
        }
      }
    };
  },

  createRouter(database) {
    const router = Router();

    // GET /api/stats/markets?search=&carriersOnly=true&limit=&offset=
    router.get('/', (request, response) => {
      const sqlFilter = addStandardFilters(new SqlFilter(), request.query, {
        searchColumns: ['display_name', 'station_name', 'carrier_name', 'callsign', 'star_system'],
      });
      if (request.query.carriersOnly === 'true') sqlFilter.add('is_carrier = 1');

      response.json(runPaginatedQuery(database, {
        selectSql: 'SELECT * FROM market_directory',
        sqlFilter,
        orderByClause: getOrderByClause(request.query, { lastSeen: 'last_seen', name: 'display_name' }, 'lastSeen'),
        pagination: getPagination(request.query),
      }));
    });

    return router;
  },
});

/** Splits a carrier signal like "P.T.N Mt. Ashigara N7N-65B" into name and callsign. */
function parseCarrierSignalName(signalName) {
  if (typeof signalName !== 'string') return null;
  const nameParts = signalName.trim().split(/\s+/);
  const callsign = nameParts.at(-1);
  if (!CALLSIGN_PATTERN.test(callsign)) return null;
  // Squadron carrier signals separate the name and callsign with "|", e.g. "P.T.N. NIGHT FEVER | PDNS".
  const carrierName = nameParts.slice(0, -1).join(' ').replace(/\s*\|$/, '') || null;
  return { callsign, carrierName };
}
