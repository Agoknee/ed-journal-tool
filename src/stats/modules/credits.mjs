import { Router } from 'express';
import { defineStatModule } from '../define-stat-module.mjs';
import { DOCKING_EVENTS, getDockedLocation, trackDockingState } from '../docking-state.mjs';
import { getCommanderIdFilter } from '../query-helpers.mjs';

/**
 * Each commander's credits: their balance over time, every credit transaction the journal logs
 * (income and spending, by category) and the game's own lifetime totals from Statistics.
 *
 * - The exact balance is only logged at login (LoadGame) and on carrier bank transfers, so the
 *   balance history is those readings. Between them, the transactions show where the money went.
 * - Transactions are the events that state an amount: sales, purchases, mission rewards, vouchers,
 *   data sales, repairs, fuel, rebuys, fines and so on. Kills earn vouchers, which count when they're
 *   redeemed. Crew wages are a share of earnings the game pays out separately.
 * - Commodity trades at a fleet carrier's market are marked, so they can be left out (they're often
 *   large transfers between your own carriers and ships rather than earnings).
 */
const STATISTICS_SECTIONS = {
  Bank_Account: ['Current_Wealth', 'Spent_On_Ships', 'Spent_On_Outfitting', 'Spent_On_Repairs', 'Spent_On_Fuel', 'Spent_On_Ammo_Consumables', 'Spent_On_Insurance', 'Insurance_Claims', 'Spent_On_Suits', 'Spent_On_Weapons', 'Spent_On_Suit_Consumables'],
  Combat: ['Bounty_Hunting_Profit', 'Bounties_Claimed', 'Combat_Bond_Profits', 'Combat_Bonds', 'Assassination_Profits', 'Highest_Single_Reward', 'OnFoot_Combat_Bonds_Profits'],
  Crime: ['Total_Fines', 'Total_Bounties'],
  Trading: ['Market_Profits', 'Markets_Traded_With', 'Average_Profit', 'Highest_Single_Transaction', 'Data_Sold', 'Goods_Sold', 'Assets_Sold'],
  Smuggling: ['Black_Markets_Profits', 'Highest_Single_Transaction'],
  Mining: ['Mining_Profits', 'Quantity_Mined'],
  Exploration: ['Exploration_Profits', 'Highest_Payout'],
  Exobiology: ['Organic_Data_Profits', 'First_Logged_Profits'],
  Search_And_Rescue: ['SearchRescue_Profit'],
  Passengers: ['Passengers_Missions_Delivered'],
  Multicrew: ['Multicrew_Credits_Total'],
  FLEETCARRIER: ['FLEETCARRIER_TRADEPROFIT_TOTAL', 'FLEETCARRIER_REFUEL_PROFIT', 'FLEETCARRIER_SHIPYARD_PROFIT', 'FLEETCARRIER_OUTFITTING_PROFIT', 'FLEETCARRIER_VOUCHERS_PROFIT'],
};
const VOUCHER_CATEGORIES = { bounty: 'Bounties', CombatBond: 'Combat bonds', trade: 'Trade vouchers', settlement: 'Settlement vouchers', scannable: 'Data vouchers', codex: 'Codex vouchers' };

export default defineStatModule({
  name: 'credits',
  title: 'Credits',
  description: 'Credit balance over time, income and spending by category, and lifetime totals.',
  version: 2,
  events: [
    'LoadGame', 'CarrierBankTransfer', 'Statistics', 'MarketSell', 'MarketBuy', 'MissionCompleted', 'RedeemVoucher',
    'SellExplorationData', 'MultiSellExplorationData', 'SellOrganicData', 'CommunityGoalReward', 'SearchAndRescue',
    'ShipyardSell', 'ShipyardBuy', 'ShipyardTransfer', 'ModuleSell', 'ModuleSellRemote', 'ModuleBuy', 'ModuleBuyAndStore',
    'FetchRemoteModule', 'SellSuit', 'SellWeapon', 'BuySuit', 'BuyWeapon', 'UpgradeSuit', 'UpgradeWeapon', 'BuyMicroResources',
    'SellMicroResources', 'SellDrones', 'BuyDrones', 'BuyAmmo', 'RefuelAll', 'RefuelPartial', 'RestockVehicle', 'Repair',
    'RepairAll', 'Resurrect', 'PayFines', 'PayBounties', 'PayLegacyFines', 'NpcCrewPaidWage', 'CrewHire', 'BuyExplorationData',
    'BuyTradeData', 'CarrierBuy', 'EngineerContribution', 'PowerplaySalary', 'PowerplayFastTrack', ...DOCKING_EVENTS,
  ],
  ownedObjects: [
    { type: 'table', name: 'credit_balances' },
    { type: 'table', name: 'credit_transactions' },
    { type: 'table', name: 'credit_statistics' },
  ],
  schemaSql: `
    CREATE TABLE IF NOT EXISTS credit_balances (
      commander_id  INTEGER NOT NULL REFERENCES commanders(id),
      timestamp     TEXT NOT NULL,
      balance       INTEGER NOT NULL,
      source        TEXT NOT NULL      -- login | carrier transfer
    );
    CREATE INDEX IF NOT EXISTS idx_credit_balances ON credit_balances(commander_id, timestamp);

    CREATE TABLE IF NOT EXISTS credit_transactions (
      id            INTEGER PRIMARY KEY,
      commander_id  INTEGER NOT NULL REFERENCES commanders(id),
      timestamp     TEXT NOT NULL,
      category      TEXT NOT NULL,
      amount        INTEGER NOT NULL,  -- positive income, negative spending
      description   TEXT,
      is_carrier    INTEGER NOT NULL DEFAULT 0  -- a commodity trade at a fleet carrier's market
    );
    CREATE INDEX IF NOT EXISTS idx_credit_transactions ON credit_transactions(commander_id, timestamp);

    CREATE TABLE IF NOT EXISTS credit_statistics (
      commander_id  INTEGER PRIMARY KEY REFERENCES commanders(id),
      data          TEXT NOT NULL,
      updated_at    TEXT
    );
  `,

  createProcessor(database) {
    const insertBalance = database.prepare('INSERT INTO credit_balances (commander_id, timestamp, balance, source) VALUES (?, ?, ?, ?)');
    const insertTransaction = database.prepare('INSERT INTO credit_transactions (commander_id, timestamp, category, amount, description, is_carrier) VALUES (?, ?, ?, ?, ?, ?)');
    const upsertStatistics = database.prepare(`
      INSERT INTO credit_statistics (commander_id, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (commander_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `);

    return ({ commanderId, event, timestamp, data }, moduleState) => {
      if (trackDockingState(event, data, moduleState)) return;
      const add = (category, amount, description = null, isCarrier = false) => {
        if (Number.isFinite(amount) && amount !== 0) insertTransaction.run(commanderId, timestamp, category, Math.round(amount), description, isCarrier ? 1 : 0);
      };
      const earn = (category, amount, description, isCarrier) => add(category, Math.abs(amount ?? 0), description, isCarrier);
      const spend = (category, amount, description, isCarrier) => add(category, -Math.abs(amount ?? 0), description, isCarrier);
      // Whether this market is a fleet carrier's (the station the commander is docked at).
      const isCarrierMarket = () => getDockedLocation(moduleState, data.MarketID)?.stationType === 'FleetCarrier';

      switch (event) {
        case 'LoadGame':
          if (Number.isFinite(data.Credits)) insertBalance.run(commanderId, timestamp, data.Credits, 'login');
          return;
        case 'CarrierBankTransfer':
          if (Number.isFinite(data.PlayerBalance)) insertBalance.run(commanderId, timestamp, data.PlayerBalance, 'carrier transfer');
          if (data.Deposit) spend('Carrier bank', data.Deposit, 'Deposited to carrier');
          if (data.Withdraw) earn('Carrier bank', data.Withdraw, 'Withdrawn from carrier');
          return;
        case 'Statistics': {
          const picked = Object.fromEntries(Object.entries(STATISTICS_SECTIONS)
            .filter(([section]) => data[section])
            .map(([section, keys]) => [section, Object.fromEntries(keys.filter((key) => data[section][key] !== undefined).map((key) => [key, data[section][key]]))]));
          upsertStatistics.run(commanderId, JSON.stringify(picked), timestamp);
          return;
        }

        case 'MarketSell':
          earn(data.BlackMarket ? 'Black market' : 'Commodity sales', data.TotalSale, `${data.Count ?? ''} × ${data.Type_Localised ?? data.Type ?? 'cargo'}`.trim(), isCarrierMarket());
          return;
        case 'MarketBuy':
          spend('Commodity purchases', data.TotalCost, `${data.Count ?? ''} × ${data.Type_Localised ?? data.Type ?? 'cargo'}`.trim(), isCarrierMarket());
          return;
        case 'MissionCompleted':
          earn('Missions', data.Reward, data.LocalisedName ?? data.Name ?? null);
          if (data.Donated ?? data.Donation) spend('Donations', Number(data.Donated ?? data.Donation), data.LocalisedName ?? null);
          return;
        case 'RedeemVoucher':
          earn(VOUCHER_CATEGORIES[data.Type] ?? 'Vouchers', data.Amount, data.Faction ?? ((data.Factions ?? []).map((faction) => faction.Faction).filter(Boolean).join(', ') || null));
          return;
        case 'SellExplorationData':
        case 'MultiSellExplorationData':
          earn('Exploration data', data.TotalEarnings, null);
          return;
        case 'SellOrganicData':
          earn('Exobiology', (data.BioData ?? []).reduce((total, item) => total + (item.Value ?? 0) + (item.Bonus ?? 0), 0), `${(data.BioData ?? []).length} samples`);
          return;
        case 'CommunityGoalReward':
          earn('Community goals', data.Reward, data.Name ?? null);
          return;
        case 'SearchAndRescue':
          earn('Search & rescue', data.Reward, data.Name_Localised ?? data.Name ?? null);
          return;
        case 'PowerplaySalary':
          earn('Powerplay', data.Amount, data.Power ?? null);
          return;

        case 'ShipyardSell':
          earn('Ship sales', data.ShipPrice, data.ShipType_Localised ?? data.ShipType ?? null);
          return;
        case 'ShipyardBuy':
          spend('Ships', data.ShipPrice, data.ShipType_Localised ?? data.ShipType ?? null);
          if (data.SellPrice) earn('Ship sales', data.SellPrice, data.SellOldShip ?? null);
          return;
        case 'ShipyardTransfer':
          spend('Transfers', data.TransferPrice, `${data.ShipType_Localised ?? data.ShipType ?? 'Ship'} from ${data.System ?? 'elsewhere'}`);
          return;
        case 'ModuleBuy':
          spend('Outfitting', data.BuyPrice, data.BuyItem_Localised ?? null);
          if (data.SellPrice) earn('Module sales', data.SellPrice, data.SellItem_Localised ?? null);
          return;
        case 'ModuleBuyAndStore':
          spend('Outfitting', data.BuyPrice, data.BuyItem_Localised ?? null);
          return;
        case 'ModuleSell':
        case 'ModuleSellRemote':
          earn('Module sales', data.SellPrice, data.SellItem_Localised ?? null);
          return;
        case 'FetchRemoteModule':
          spend('Transfers', data.TransferCost, data.StoredItem_Localised ?? null);
          return;

        case 'BuySuit':
        case 'BuyWeapon':
          spend('Suits & weapons', data.Price, data.Name_Localised ?? null);
          return;
        case 'UpgradeSuit':
        case 'UpgradeWeapon':
          spend('Suits & weapons', data.Cost, data.Name_Localised ?? null);
          return;
        case 'SellSuit':
        case 'SellWeapon':
          earn('Suit & weapon sales', data.Price, data.Name_Localised ?? null);
          return;
        case 'BuyMicroResources':
          spend('Micro-resources', data.TotalPrice ?? data.Price, data.Name_Localised ?? null);
          return;
        case 'SellMicroResources':
          earn('Micro-resource sales', data.Price, null);
          return;

        case 'SellDrones':
          earn('Commodity sales', data.TotalSale, `${data.Count ?? ''} × limpets`.trim());
          return;
        case 'BuyDrones':
          spend('Ammo & limpets', data.TotalCost, `${data.Count ?? ''} × limpets`.trim());
          return;
        case 'BuyAmmo':
          spend('Ammo & limpets', data.Cost, 'Ammo');
          return;
        case 'RestockVehicle':
          spend('Ammo & limpets', data.Cost, data.Type_Localised ?? data.Type ?? 'Vehicle');
          return;
        case 'RefuelAll':
        case 'RefuelPartial':
          spend('Fuel', data.Cost, null);
          return;
        case 'Repair':
        case 'RepairAll':
          spend('Repairs', data.Cost, null);
          return;
        case 'Resurrect':
          spend('Rebuys', data.Cost, data.Option ?? null);
          return;
        case 'PayFines':
        case 'PayBounties':
        case 'PayLegacyFines':
          spend('Fines & bounties', data.Amount, data.Faction_Localised ?? data.Faction ?? null);
          return;
        case 'NpcCrewPaidWage':
          spend('Crew wages', data.Amount, data.NpcCrewName ?? null);
          return;
        case 'CrewHire':
          spend('Crew wages', data.Cost, data.Name ? `Hired ${data.Name}` : null);
          return;
        case 'BuyExplorationData':
        case 'BuyTradeData':
          spend('Data', data.Cost, data.System ?? null);
          return;
        case 'CarrierBuy':
          spend('Fleet carrier', data.Price, data.Callsign ?? null);
          return;
        case 'EngineerContribution':
          if (data.Type === 'Credits') spend('Engineers', data.Quantity, data.Engineer ?? null);
          return;
        case 'PowerplayFastTrack':
          spend('Powerplay', data.Cost, data.Power ?? null);
          return;
      }
    };
  },

  createRouter(database) {
    const router = Router();
    const selectBalances = database.prepare('SELECT timestamp, balance, source FROM credit_balances WHERE commander_id = ? ORDER BY timestamp');
    const selectMonthly = database.prepare(`
      SELECT substr(timestamp, 1, 7) AS month,
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
        SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS spending
      FROM credit_transactions WHERE commander_id = ? AND category != 'Carrier bank' AND is_carrier <= ?
      GROUP BY month ORDER BY month
    `);
    const selectCategories = database.prepare(`
      SELECT category, SUM(amount) AS total, COUNT(*) AS count, MAX(ABS(amount)) AS largest
      FROM credit_transactions WHERE commander_id = ? AND timestamp >= ? AND is_carrier <= ?
      GROUP BY category ORDER BY ABS(SUM(amount)) DESC
    `);
    const selectLargest = database.prepare(`
      SELECT timestamp, category, amount, description FROM credit_transactions
      WHERE commander_id = ? AND category != 'Carrier bank' AND is_carrier <= ? ORDER BY ABS(amount) DESC LIMIT 10
    `);
    const selectStatistics = database.prepare('SELECT data, updated_at FROM credit_statistics WHERE commander_id = ?');

    // GET /api/stats/credits?commander=<id>&since=<ISO date, for the categories>&excludeCarrier=true
    // excludeCarrier leaves out commodity trades at fleet carrier markets (not the balance history).
    router.get('/', (request, response) => {
      const commanderId = getCommanderIdFilter(request.query);
      if (commanderId === null) {
        response.status(400).json({ error: 'Choose a commander' });
        return;
      }
      const since = typeof request.query.since === 'string' && request.query.since ? request.query.since : '0000';
      // is_carrier <= 0 keeps only non-carrier trades; <= 1 keeps everything.
      const maxCarrierFlag = request.query.excludeCarrier === 'true' ? 0 : 1;
      const balances = selectBalances.all(commanderId);
      const statistics = selectStatistics.get(commanderId);
      response.json({
        balance: balances.at(-1) ?? null,
        balanceHistory: thinBalances(balances),
        monthly: selectMonthly.all(commanderId, maxCarrierFlag),
        categories: selectCategories.all(commanderId, since, maxCarrierFlag),
        largest: selectLargest.all(commanderId, maxCarrierFlag),
        statistics: statistics ? { ...JSON.parse(statistics.data), updatedAt: statistics.updated_at } : null,
      });
    });

    return router;
  },
});

/** One reading per day (the day's last), to keep the chart light over years of logins. */
function thinBalances(balances) {
  const byDay = new Map();
  for (const reading of balances) byDay.set(reading.timestamp.slice(0, 10), reading);
  return [...byDay.values()];
}
