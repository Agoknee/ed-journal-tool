import { Router } from 'express';
import { defineStatModule } from '../define-stat-module.mjs';
import { DOCKING_EVENTS, getDockedLocation, trackDockingState } from '../docking-state.mjs';
import { SqlFilter, addStandardFilters, getOrderByClause, getPagination, runPaginatedQuery } from '../query-helpers.mjs';

const TRADE_SELECT_SQL = `
  SELECT
    trades.id, trades.commander_id, commanders.name AS commander_name, trades.timestamp, trades.trade_type,
    trades.market_id, COALESCE(directory.display_name, trades.station_name) AS market_name,
    directory.carrier_name, directory.callsign, COALESCE(directory.is_carrier, 0) AS is_carrier,
    COALESCE(trades.star_system, directory.star_system) AS star_system,
    trades.commodity, trades.commodity_name, trades.quantity, trades.unit_price, trades.total_value,
    trades.avg_price_paid, trades.profit, trades.is_black_market, trades.is_stolen
  FROM commodity_trades AS trades
  JOIN commanders ON commanders.id = trades.commander_id
  LEFT JOIN market_directory AS directory ON directory.market_id = trades.market_id
`;

const TRADE_SEARCH_COLUMNS = [
  'directory.display_name', 'directory.carrier_name', 'directory.callsign', 'trades.station_name', 'trades.commodity_name', 'trades.star_system',
];

/**
 * Every commodity purchase and sale, with the market/carrier it happened at.
 */
export default defineStatModule({
  name: 'commodities',
  title: 'Commodity Trades',
  description: 'Commodity purchases and sales, searchable by carrier/station name and filterable by time.',
  version: 1,
  dependsOn: ['markets'],
  events: ['MarketBuy', 'MarketSell', ...DOCKING_EVENTS],
  ownedObjects: [{ type: 'table', name: 'commodity_trades' }],
  schemaSql: `
    CREATE TABLE IF NOT EXISTS commodity_trades (
      id               INTEGER PRIMARY KEY,
      commander_id     INTEGER NOT NULL REFERENCES commanders(id),
      entry_id         INTEGER NOT NULL,
      timestamp        TEXT NOT NULL,
      trade_type       TEXT NOT NULL,   -- buy | sell
      market_id        INTEGER,
      station_name     TEXT,
      star_system      TEXT,
      commodity        TEXT NOT NULL,
      commodity_name   TEXT NOT NULL,
      quantity         INTEGER NOT NULL,
      unit_price       INTEGER,
      total_value      INTEGER NOT NULL,
      avg_price_paid   INTEGER,
      profit           INTEGER,
      is_black_market  INTEGER NOT NULL DEFAULT 0,
      is_stolen        INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_commodity_trades_time ON commodity_trades(timestamp);
    CREATE INDEX IF NOT EXISTS idx_commodity_trades_commander ON commodity_trades(commander_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_commodity_trades_market ON commodity_trades(market_id);
  `,

  createProcessor(database) {
    const insertTrade = database.prepare(`
      INSERT INTO commodity_trades
        (commander_id, entry_id, timestamp, trade_type, market_id, station_name, star_system, commodity, commodity_name,
         quantity, unit_price, total_value, avg_price_paid, profit, is_black_market, is_stolen)
      VALUES (:commanderId, :entryId, :timestamp, :tradeType, :marketId, :stationName, :starSystem, :commodity, :commodityName,
         :quantity, :unitPrice, :totalValue, :avgPricePaid, :profit, :isBlackMarket, :isStolen)
    `);

    return ({ id: entryId, commanderId, event, timestamp, data }, moduleState) => {
      if (trackDockingState(event, data, moduleState)) return;

      const isPurchase = event === 'MarketBuy';
      const dockedLocation = getDockedLocation(moduleState, data.MarketID);
      const quantity = data.Count ?? 0;
      const unitPrice = isPurchase ? data.BuyPrice : data.SellPrice;
      const avgPricePaid = isPurchase ? null : data.AvgPricePaid ?? null;

      insertTrade.run({
        commanderId,
        entryId,
        timestamp,
        tradeType: isPurchase ? 'buy' : 'sell',
        marketId: data.MarketID ?? null,
        stationName: dockedLocation?.stationName ?? null,
        starSystem: dockedLocation?.starSystem ?? null,
        commodity: data.Type,
        commodityName: data.Type_Localised ?? toDisplayName(data.Type),
        quantity,
        unitPrice: unitPrice ?? null,
        totalValue: (isPurchase ? data.TotalCost : data.TotalSale) ?? 0,
        avgPricePaid,
        profit: avgPricePaid === null || unitPrice === undefined ? null : (unitPrice - avgPricePaid) * quantity,
        isBlackMarket: Number(Boolean(data.BlackMarket)),
        isStolen: Number(Boolean(data.StolenGoods)),
      });
    };
  },

  createRouter(database) {
    const router = Router();

    const buildTradeFilter = (query) => {
      const sqlFilter = addStandardFilters(new SqlFilter(), query, {
        commanderColumn: 'trades.commander_id',
        timestampColumn: 'trades.timestamp',
        searchColumns: TRADE_SEARCH_COLUMNS,
      });
      if (query.type === 'buy' || query.type === 'sell') sqlFilter.add('trades.trade_type = ?', query.type);
      if (query.commodity) sqlFilter.add('trades.commodity = ?', String(query.commodity));
      if (query.market) sqlFilter.add('trades.market_id = ?', Number(query.market));
      if (query.carriersOnly === 'true') sqlFilter.add('directory.is_carrier = 1');
      return sqlFilter;
    };

    // GET /api/stats/commodities/trades?commander=&type=buy|sell&commodity=&market=&carriersOnly=&search=&period=&from=&to=&sort=&order=&limit=&offset=
    router.get('/trades', (request, response) => {
      response.json(runPaginatedQuery(database, {
        selectSql: TRADE_SELECT_SQL,
        sqlFilter: buildTradeFilter(request.query),
        orderByClause: getOrderByClause(request.query, {
          timestamp: 'trades.timestamp',
          quantity: 'trades.quantity',
          value: 'trades.total_value',
          profit: 'trades.profit',
          commodity: 'trades.commodity_name',
          market: 'market_name',
        }, 'timestamp'),
        pagination: getPagination(request.query),
      }));
    });

    // GET /api/stats/commodities/totals (same filters as /trades)
    router.get('/totals', (request, response) => {
      const sqlFilter = buildTradeFilter(request.query);
      const totalsColumns = `
        COALESCE(SUM(trades.trade_type = 'buy'), 0) AS purchase_count,
        COALESCE(SUM(CASE WHEN trades.trade_type = 'buy' THEN trades.quantity END), 0) AS units_bought,
        COALESCE(SUM(CASE WHEN trades.trade_type = 'buy' THEN trades.total_value END), 0) AS total_spent,
        COALESCE(SUM(trades.trade_type = 'sell'), 0) AS sale_count,
        COALESCE(SUM(CASE WHEN trades.trade_type = 'sell' THEN trades.quantity END), 0) AS units_sold,
        COALESCE(SUM(CASE WHEN trades.trade_type = 'sell' THEN trades.total_value END), 0) AS total_earned,
        COALESCE(SUM(trades.profit), 0) AS total_profit
      `;
      const fromClause = `
        FROM commodity_trades AS trades
        JOIN commanders ON commanders.id = trades.commander_id
        LEFT JOIN market_directory AS directory ON directory.market_id = trades.market_id
        ${sqlFilter.whereClause}
      `;
      const runTotalsQuery = (selectColumns, groupAndOrder = '') => database
        .prepare(`SELECT ${selectColumns}, ${totalsColumns} ${fromClause} ${groupAndOrder}`)
        .all(...sqlFilter.parameters);

      response.json({
        combined: runTotalsQuery('COUNT(*) AS trade_count')[0],
        perCommander: runTotalsQuery('trades.commander_id, commanders.name AS commander_name', 'GROUP BY trades.commander_id ORDER BY commanders.name'),
        byCommodity: runTotalsQuery('trades.commodity, MAX(trades.commodity_name) AS commodity_name', 'GROUP BY trades.commodity ORDER BY units_bought + units_sold DESC'),
        byMarket: runTotalsQuery(
          'trades.market_id, COALESCE(MAX(directory.display_name), MAX(trades.station_name)) AS market_name, MAX(directory.is_carrier) AS is_carrier',
          'GROUP BY trades.market_id ORDER BY units_bought + units_sold DESC LIMIT 100',
        ),
      });
    });

    // GET /api/stats/commodities/list -> commodities that have been traded (for filter dropdowns)
    router.get('/list', (request, response) => {
      const commodityRows = database.prepare(`
        SELECT commodity, MAX(commodity_name) AS commodity_name, COUNT(*) AS trade_count
        FROM commodity_trades GROUP BY commodity ORDER BY commodity_name
      `).all();
      response.json({ commodities: commodityRows });
    });

    return router;
  },
});

function toDisplayName(internalName = '') {
  return internalName.charAt(0).toUpperCase() + internalName.slice(1);
}
