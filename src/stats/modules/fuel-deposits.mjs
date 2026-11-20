import { Router } from 'express';
import { defineStatModule } from '../define-stat-module.mjs';
import { DOCKING_EVENTS, getDockedLocation, trackDockingState } from '../docking-state.mjs';
import { SqlFilter, addStandardFilters, getOrderByClause, getPagination, runPaginatedQuery } from '../query-helpers.mjs';

const DEPOSIT_FROM_SQL = `
  FROM fuel_deposits AS deposits
  JOIN commanders ON commanders.id = deposits.commander_id
  LEFT JOIN market_directory AS directory ON directory.market_id = deposits.carrier_id
`;

/**
 * Tritium deposited into carrier fuel depots (CarrierDepositFuel).
 */
export default defineStatModule({
  name: 'fuel-deposits',
  title: 'Depot Fuel Deposits',
  description: 'Tritium deposited into carrier fuel depots, searchable by carrier name and filterable by time.',
  version: 1,
  dependsOn: ['markets', 'carriers'],
  events: ['CarrierDepositFuel', ...DOCKING_EVENTS],
  ownedObjects: [{ type: 'table', name: 'fuel_deposits' }],
  schemaSql: `
    CREATE TABLE IF NOT EXISTS fuel_deposits (
      id                   INTEGER PRIMARY KEY,
      commander_id         INTEGER NOT NULL REFERENCES commanders(id),
      entry_id             INTEGER NOT NULL,
      timestamp            TEXT NOT NULL,
      carrier_id           INTEGER NOT NULL,
      amount               INTEGER NOT NULL,
      carrier_fuel_total   INTEGER,
      carrier_callsign     TEXT,
      star_system          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fuel_deposits_time ON fuel_deposits(timestamp);
    CREATE INDEX IF NOT EXISTS idx_fuel_deposits_carrier ON fuel_deposits(carrier_id);
  `,

  createProcessor(database) {
    const insertDeposit = database.prepare(`
      INSERT INTO fuel_deposits (commander_id, entry_id, timestamp, carrier_id, amount, carrier_fuel_total, carrier_callsign, star_system)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    return ({ id: entryId, commanderId, event, timestamp, data }, moduleState) => {
      if (trackDockingState(event, data, moduleState)) return;

      const dockedLocation = getDockedLocation(moduleState, data.CarrierID);
      insertDeposit.run(
        commanderId, entryId, timestamp, data.CarrierID, data.Amount ?? 0, data.Total ?? null,
        dockedLocation?.stationName ?? null, dockedLocation?.starSystem ?? null,
      );
    };
  },

  createRouter(database) {
    const router = Router();

    const buildDepositFilter = (query) => {
      const sqlFilter = addStandardFilters(new SqlFilter(), query, {
        commanderColumn: 'deposits.commander_id',
        timestampColumn: 'deposits.timestamp',
        searchColumns: ['directory.display_name', 'directory.carrier_name', 'directory.callsign', 'deposits.carrier_callsign', 'deposits.star_system'],
      });
      if (query.carrier) sqlFilter.add('deposits.carrier_id = ?', Number(query.carrier));
      // Exclude carriers owned by any commander we have journals for (owner links come from the carriers module).
      if (query.excludeOwned === 'true') {
        sqlFilter.add("deposits.carrier_id NOT IN (SELECT carrier_id FROM carrier_commanders WHERE relationship = 'owner')");
      }
      return sqlFilter;
    };

    const carrierNameSql = "COALESCE(directory.display_name, deposits.carrier_callsign, 'Carrier #' || deposits.carrier_id)";

    // GET /api/stats/fuel-deposits/deposits?commander=&carrier=&excludeOwned=true&search=&period=&from=&to=&sort=&order=&limit=&offset=
    router.get('/deposits', (request, response) => {
      response.json(runPaginatedQuery(database, {
        selectSql: `
          SELECT deposits.id, deposits.commander_id, commanders.name AS commander_name, deposits.timestamp,
            deposits.carrier_id, ${carrierNameSql} AS carrier_name, directory.callsign,
            COALESCE(deposits.star_system, directory.star_system) AS star_system,
            deposits.amount, deposits.carrier_fuel_total
          ${DEPOSIT_FROM_SQL}
        `,
        sqlFilter: buildDepositFilter(request.query),
        orderByClause: getOrderByClause(request.query, {
          timestamp: 'deposits.timestamp',
          amount: 'deposits.amount',
          carrier: 'carrier_name',
        }, 'timestamp'),
        pagination: getPagination(request.query),
      }));
    });

    // GET /api/stats/fuel-deposits/totals (same filters as /deposits)
    router.get('/totals', (request, response) => {
      const sqlFilter = buildDepositFilter(request.query);
      const totalsColumns = `
        COUNT(*) AS deposit_count,
        COALESCE(SUM(deposits.amount), 0) AS total_amount,
        MIN(deposits.timestamp) AS first_deposit_at,
        MAX(deposits.timestamp) AS last_deposit_at
      `;
      const runTotalsQuery = (selectColumns, groupAndOrder = '') => database
        .prepare(`SELECT ${selectColumns} ${totalsColumns} ${DEPOSIT_FROM_SQL} ${sqlFilter.whereClause} ${groupAndOrder}`)
        .all(...sqlFilter.parameters);

      response.json({
        combined: runTotalsQuery('')[0],
        perCommander: runTotalsQuery('deposits.commander_id, commanders.name AS commander_name,', 'GROUP BY deposits.commander_id ORDER BY total_amount DESC'),
        byCarrier: runTotalsQuery(`deposits.carrier_id, MAX(${carrierNameSql}) AS carrier_name,`, 'GROUP BY deposits.carrier_id ORDER BY total_amount DESC'),
      });
    });

    return router;
  },
});
