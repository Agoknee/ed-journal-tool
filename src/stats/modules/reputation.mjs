import { Router } from 'express';
import { defineStatModule } from '../define-stat-module.mjs';
import { getCommanderIdFilter } from '../query-helpers.mjs';

/**
 * Powerplay standing and minor faction reputation. (Pilots' Federation ranks and major faction
 * reputation are in the commanders module.)
 *
 * - Powerplay: the pledged power, rank, merits and time pledged (Powerplay at login), kept up to
 *   date by PowerplayRank and PowerplayMerits; merits earned are also totalled per day.
 * - Minor factions: the commander's reputation with each faction is given for every faction in a
 *   system on arriving there (FSDJump, Location, CarrierJump), so it's only known for factions in
 *   systems they've visited, as of the last visit.
 */
export default defineStatModule({
  name: 'reputation',
  title: 'Reputation',
  description: 'Powerplay standing and merits, and reputation with minor factions.',
  version: 1,
  events: ['Powerplay', 'PowerplayRank', 'PowerplayMerits', 'PowerplayJoin', 'PowerplayLeave', 'PowerplayDefect', 'FSDJump', 'Location', 'CarrierJump'],
  ownedObjects: [
    { type: 'table', name: 'powerplay_status' },
    { type: 'table', name: 'powerplay_merits_daily' },
    { type: 'table', name: 'faction_reputation' },
  ],
  schemaSql: `
    CREATE TABLE IF NOT EXISTS powerplay_status (
      commander_id      INTEGER PRIMARY KEY REFERENCES commanders(id),
      power             TEXT,
      rank              INTEGER,
      merits            INTEGER,
      time_pledged_s    INTEGER,
      time_pledged_at   TEXT,      -- when time_pledged_s was reported
      joined_at         TEXT,
      updated_at        TEXT
    );
    CREATE TABLE IF NOT EXISTS powerplay_merits_daily (
      commander_id  INTEGER NOT NULL REFERENCES commanders(id),
      day           TEXT NOT NULL,   -- YYYY-MM-DD (UTC)
      power         TEXT,
      merits        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (commander_id, day)
    );
    CREATE TABLE IF NOT EXISTS faction_reputation (
      commander_id  INTEGER NOT NULL REFERENCES commanders(id),
      faction       TEXT NOT NULL,
      reputation    REAL NOT NULL,   -- -100 to 100
      allegiance    TEXT,
      government    TEXT,
      star_system   TEXT,
      updated_at    TEXT,
      PRIMARY KEY (commander_id, faction)
    );
  `,

  createProcessor(database) {
    const ensureStatus = database.prepare('INSERT OR IGNORE INTO powerplay_status (commander_id) VALUES (?)');
    const setPowerplay = database.prepare(`
      UPDATE powerplay_status SET power = ?, rank = ?, merits = ?, time_pledged_s = ?, time_pledged_at = ?, updated_at = ? WHERE commander_id = ?
    `);
    const setRank = database.prepare('UPDATE powerplay_status SET power = COALESCE(?, power), rank = ?, updated_at = ? WHERE commander_id = ?');
    const setMerits = database.prepare('UPDATE powerplay_status SET power = COALESCE(?, power), merits = ?, updated_at = ? WHERE commander_id = ?');
    const joinPower = database.prepare(`
      UPDATE powerplay_status SET power = ?, rank = 1, merits = 0, time_pledged_s = 0, time_pledged_at = ?, joined_at = ?, updated_at = ? WHERE commander_id = ?
    `);
    const leavePower = database.prepare(`
      UPDATE powerplay_status SET power = NULL, rank = NULL, merits = NULL, time_pledged_s = NULL, time_pledged_at = NULL, joined_at = NULL, updated_at = ? WHERE commander_id = ?
    `);
    const addDailyMerits = database.prepare(`
      INSERT INTO powerplay_merits_daily (commander_id, day, power, merits) VALUES (?, ?, ?, ?)
      ON CONFLICT (commander_id, day) DO UPDATE SET merits = merits + excluded.merits, power = COALESCE(excluded.power, power)
    `);
    const upsertFaction = database.prepare(`
      INSERT INTO faction_reputation (commander_id, faction, reputation, allegiance, government, star_system, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (commander_id, faction) DO UPDATE SET reputation = excluded.reputation, allegiance = excluded.allegiance,
        government = excluded.government, star_system = excluded.star_system, updated_at = excluded.updated_at
    `);

    return ({ commanderId, event, timestamp, data }) => {
      switch (event) {
        case 'Powerplay':
          ensureStatus.run(commanderId);
          setPowerplay.run(data.Power ?? null, data.Rank ?? null, data.Merits ?? null, data.TimePledged ?? null, timestamp, timestamp, commanderId);
          return;
        case 'PowerplayRank':
          ensureStatus.run(commanderId);
          setRank.run(data.Power ?? null, data.Rank ?? null, timestamp, commanderId);
          return;
        case 'PowerplayMerits':
          ensureStatus.run(commanderId);
          if (Number.isFinite(data.TotalMerits)) setMerits.run(data.Power ?? null, data.TotalMerits, timestamp, commanderId);
          if (Number.isFinite(data.MeritsGained) && data.MeritsGained > 0) addDailyMerits.run(commanderId, timestamp.slice(0, 10), data.Power ?? null, data.MeritsGained);
          return;
        case 'PowerplayJoin':
          ensureStatus.run(commanderId);
          joinPower.run(data.Power ?? null, timestamp, timestamp, timestamp, commanderId);
          return;
        case 'PowerplayDefect':
          ensureStatus.run(commanderId);
          joinPower.run(data.ToPower ?? null, timestamp, timestamp, timestamp, commanderId);
          return;
        case 'PowerplayLeave':
          ensureStatus.run(commanderId);
          leavePower.run(timestamp, commanderId);
          return;

        case 'FSDJump':
        case 'Location':
        case 'CarrierJump':
          for (const faction of data.Factions ?? []) {
            if (!faction.Name || !Number.isFinite(faction.MyReputation)) continue;
            upsertFaction.run(
              commanderId, faction.Name, faction.MyReputation, faction.Allegiance ?? null, faction.Government_Localised ?? faction.Government ?? null,
              data.StarSystem ?? null, timestamp,
            );
          }
          return;
      }
    };
  },

  createRouter(database) {
    const router = Router();
    const selectPowerplay = database.prepare(`
      SELECT powerplay_status.*, commanders.name AS commander_name FROM powerplay_status
      JOIN commanders ON commanders.id = powerplay_status.commander_id
      WHERE (?1 IS NULL OR powerplay_status.commander_id = ?1)
    `);
    const selectDailyMerits = database.prepare(`
      SELECT day, merits FROM powerplay_merits_daily WHERE commander_id = ? AND day >= ? ORDER BY day
    `);
    const selectFactions = database.prepare(`
      SELECT faction, reputation, allegiance, government, star_system, updated_at FROM faction_reputation
      WHERE commander_id = ? ORDER BY reputation DESC, faction
    `);

    // GET /api/stats/reputation?commander=<id|all>
    // Powerplay per commander (with the last 90 days of merits); minor factions when one commander is chosen.
    router.get('/', (request, response) => {
      const commanderId = getCommanderIdFilter(request.query);
      const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
      const powerplay = selectPowerplay.all(commanderId).map((row) => {
        // Time pledged keeps running since it was last reported.
        const pledgedSeconds = row.time_pledged_s === null ? null
          : row.time_pledged_s + Math.max(0, (Date.now() - Date.parse(row.time_pledged_at)) / 1000);
        return {
          commanderId: row.commander_id,
          commanderName: row.commander_name,
          power: row.power,
          rank: row.rank,
          merits: row.merits,
          timePledgedSeconds: pledgedSeconds,
          updatedAt: row.updated_at,
          dailyMerits: selectDailyMerits.all(row.commander_id, since),
        };
      });
      const factions = commanderId === null ? null : selectFactions.all(commanderId).map((row) => ({
        faction: row.faction,
        reputation: row.reputation,
        allegiance: row.allegiance,
        government: row.government?.replace(/^\$government_(.*);$/i, '$1') ?? null,
        starSystem: row.star_system,
        updatedAt: row.updated_at,
      }));
      response.json({ powerplay, factions });
    });

    return router;
  },
});
