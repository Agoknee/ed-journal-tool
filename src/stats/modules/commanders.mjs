import { Router } from 'express';
import { defineStatModule } from '../define-stat-module.mjs';
import { describeRanks } from '../../game-data/ranks.mjs';
import { getCommanderIdFilter, parseJsonColumns, sumBy } from '../query-helpers.mjs';
import { getCreditSummaries } from './credits.mjs';
import { getFleetSummaries } from './fleet.mjs';
import { getInventoryCounts } from './inventory.mjs';

/**
 * Commander profile: game mode, ranks, reputation, squadron and time played. The API adds each
 * commander's summary from the modules that own it: the ship they're flying and their fleet
 * (fleet), credits (credits) and item counts (inventory), with totals across commanders.
 */
export default defineStatModule({
  name: 'commanders',
  title: 'Commanders',
  description: 'Commander profile details: game mode, ranks, reputation and squadron, with a summary of each commander.',
  version: 3,
  dependsOn: ['fleet', 'credits', 'inventory'],
  events: ['LoadGame', 'Rank', 'Progress', 'Promotion', 'Reputation', 'SquadronStartup', 'JoinedSquadron', 'LeftSquadron', 'Statistics'],
  ownedObjects: [{ type: 'table', name: 'commander_profiles' }],
  schemaSql: `
    CREATE TABLE IF NOT EXISTS commander_profiles (
      commander_id     INTEGER PRIMARY KEY REFERENCES commanders(id),
      game_mode        TEXT,
      game_group       TEXT,
      is_horizons      INTEGER,
      is_odyssey       INTEGER,
      ranks            TEXT NOT NULL DEFAULT '{}',
      rank_since       TEXT NOT NULL DEFAULT '{}',  -- per rank: { at, isExact } when it reached its current value
      rank_progress    TEXT NOT NULL DEFAULT '{}',
      reputation       TEXT NOT NULL DEFAULT '{}',
      squadron_name    TEXT,
      squadron_rank    TEXT,
      time_played_s    INTEGER,
      last_login       TEXT,
      updated_at       TEXT
    );
  `,

  createProcessor(database) {
    const ensureProfile = database.prepare('INSERT OR IGNORE INTO commander_profiles (commander_id) VALUES (?)');
    const selectProfile = database.prepare('SELECT ranks, rank_since, rank_progress FROM commander_profiles WHERE commander_id = ?');
    const updateLogin = database.prepare(`
      UPDATE commander_profiles SET game_mode = ?, game_group = ?, is_horizons = ?, is_odyssey = ?, last_login = ?, updated_at = ?
      WHERE commander_id = ?
    `);
    const updateRanks = database.prepare('UPDATE commander_profiles SET ranks = ?, rank_since = ?, updated_at = ? WHERE commander_id = ?');
    const updateRankProgress = database.prepare('UPDATE commander_profiles SET rank_progress = ?, updated_at = ? WHERE commander_id = ?');
    const updateReputation = database.prepare('UPDATE commander_profiles SET reputation = ?, updated_at = ? WHERE commander_id = ?');
    const updateSquadron = database.prepare('UPDATE commander_profiles SET squadron_name = ?, squadron_rank = ?, updated_at = ? WHERE commander_id = ?');
    const updateTimePlayed = database.prepare('UPDATE commander_profiles SET time_played_s = ?, updated_at = ? WHERE commander_id = ?');

    return ({ commanderId, event, timestamp, data }) => {
      ensureProfile.run(commanderId);

      switch (event) {
        case 'LoadGame':
          updateLogin.run(
            data.GameMode ?? null, data.Group ?? null,
            toNullableFlag(data.Horizons), toNullableFlag(data.Odyssey),
            timestamp, timestamp, commanderId,
          );
          break;

        case 'Rank':
        case 'Promotion': {
          const profile = selectProfile.get(commanderId);
          const existingRanks = JSON.parse(profile.ranks);
          const rankSince = JSON.parse(profile.rank_since);
          const newRanks = pickRankValues(data);
          // When each rank reached its current value: exact for a Promotion; otherwise (first seen,
          // or found changed at login) only that it was so by then.
          for (const [rankType, value] of Object.entries(newRanks)) {
            if (existingRanks[rankType] === value && rankSince[rankType]) continue;
            rankSince[rankType] = { at: timestamp, isExact: event === 'Promotion' && existingRanks[rankType] !== undefined && existingRanks[rankType] !== value };
          }
          updateRanks.run(JSON.stringify({ ...existingRanks, ...newRanks }), JSON.stringify(rankSince), timestamp, commanderId);
          break;
        }

        case 'Progress':
          updateRankProgress.run(JSON.stringify(pickRankValues(data)), timestamp, commanderId);
          break;

        case 'Reputation':
          updateReputation.run(JSON.stringify(pickRankValues(data)), timestamp, commanderId);
          break;

        case 'SquadronStartup':
          updateSquadron.run(data.SquadronName ?? null, data.CurrentRankName_Localised ?? data.CurrentRankName ?? null, timestamp, commanderId);
          break;

        case 'JoinedSquadron':
          updateSquadron.run(data.SquadronName ?? null, null, timestamp, commanderId);
          break;

        case 'LeftSquadron':
          updateSquadron.run(null, null, timestamp, commanderId);
          break;

        case 'Statistics':
          if (data.Exploration?.Time_Played) updateTimePlayed.run(data.Exploration.Time_Played, timestamp, commanderId);
          break;
      }
    };
  },

  createRouter(database) {
    const router = Router();
    const selectProfiles = database.prepare(`
      SELECT
        commanders.id, commanders.name, commanders.fid, commanders.first_seen, commanders.last_seen,
        profiles.game_mode, profiles.game_group, profiles.is_horizons, profiles.is_odyssey,
        profiles.ranks, profiles.rank_since, profiles.rank_progress, profiles.reputation,
        profiles.squadron_name, profiles.squadron_rank, profiles.time_played_s, profiles.last_login,
        (SELECT COUNT(*) FROM journal_files WHERE journal_files.commander_id = commanders.id) AS journal_file_count,
        (SELECT COUNT(*) FROM journal_files WHERE journal_files.commander_id = commanders.id AND is_active = 1) AS active_journal_count
      FROM commanders
      LEFT JOIN commander_profiles AS profiles ON profiles.commander_id = commanders.id
      WHERE (?1 IS NULL OR commanders.id = ?1)
      ORDER BY commanders.last_seen DESC
    `);

    // GET /api/stats/commanders?commander=<id|all>
    // Each commander's profile and summary (summary: credits, wealth, current ship, fleet, stored
    // modules and item counts), plus the summaries' totals across the commanders returned.
    router.get('/', (request, response) => {
      const commanderRows = selectProfiles.all(getCommanderIdFilter(request.query));
      const credits = getCreditSummaries(database);
      const fleets = getFleetSummaries(database);
      const inventories = getInventoryCounts(database);
      const profiles = parseJsonColumns(commanderRows, ['ranks', 'rank_since', 'rank_progress', 'reputation']).map((profile) => ({
        ...profile,
        rank_names: describeRanks(profile.ranks ?? {}),
        next_rank_names: describeRanks(profile.ranks ?? {}, 1),
        summary: {
          credits: credits.get(profile.id)?.credits ?? null,
          currentWealth: credits.get(profile.id)?.currentWealth ?? null,
          currentShip: fleets.get(profile.id)?.currentShip ?? null,
          shipCount: fleets.get(profile.id)?.shipCount ?? 0,
          fleetValue: fleets.get(profile.id)?.fleetValue ?? 0,
          storedModuleCount: fleets.get(profile.id)?.storedModuleCount ?? 0,
          materialCount: inventories.get(profile.id)?.materialCount ?? 0,
          shipLockerCount: inventories.get(profile.id)?.shipLockerCount ?? 0,
          cargoCount: inventories.get(profile.id)?.cargoCount ?? 0,
        },
      }));
      const summaries = profiles.map((profile) => profile.summary);
      const combined = Object.fromEntries(
        ['credits', 'currentWealth', 'shipCount', 'fleetValue', 'storedModuleCount', 'materialCount', 'shipLockerCount', 'cargoCount']
          .map((key) => [key, sumBy(summaries, key)]),
      );
      response.json({ commanders: profiles, combined });
    });

    return router;
  },
});

function pickRankValues(data) {
  const { timestamp, event, ...rankValues } = data;
  return rankValues;
}

function toNullableFlag(value) {
  return value === undefined ? null : Number(Boolean(value));
}
