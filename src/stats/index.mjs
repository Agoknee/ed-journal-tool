/**
 * Registry of stat modules. To add a stat, create a module with defineStatModule() and add it here;
 * it will build itself from the stored journal entries on next launch. To remove one, delete it from
 * this list and its tables are dropped on next launch.
 *
 * Modules run in this order, so list dependencies (e.g. "markets") first.
 */
import assetsModule from './modules/assets.mjs';
import bgsModule from './modules/bgs.mjs';
import carriersModule from './modules/carriers.mjs';
import chatModule from './modules/chat.mjs';
import combatModule from './modules/combat.mjs';
import commandersModule from './modules/commanders.mjs';
import commoditiesModule from './modules/commodities.mjs';
import fuelDepositsModule from './modules/fuel-deposits.mjs';
import marketsModule from './modules/markets.mjs';
import missionsModule from './modules/missions.mjs';
import travelModule from './modules/travel.mjs';

export const statModules = [
  marketsModule,
  commandersModule,
  travelModule,
  assetsModule,
  carriersModule,
  commoditiesModule,
  fuelDepositsModule,
  chatModule,
  bgsModule,
  missionsModule,
  combatModule,
];
