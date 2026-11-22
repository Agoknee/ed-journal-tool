import { Router } from 'express';
import { defineStatModule } from '../define-stat-module.mjs';
import { getCommanderIdFilter, parseJsonColumns } from '../query-helpers.mjs';

const RANK_NAMES = {
  Combat: ['Harmless', 'Mostly Harmless', 'Novice', 'Competent', 'Expert', 'Master', 'Dangerous', 'Deadly', 'Elite', 'Elite I', 'Elite II', 'Elite III', 'Elite IV', 'Elite V'],
  Trade: ['Penniless', 'Mostly Penniless', 'Peddler', 'Dealer', 'Merchant', 'Broker', 'Entrepreneur', 'Tycoon', 'Elite', 'Elite I', 'Elite II', 'Elite III', 'Elite IV', 'Elite V'],
  Explore: ['Aimless', 'Mostly Aimless', 'Scout', 'Surveyor', 'Trailblazer', 'Pathfinder', 'Ranger', 'Pioneer', 'Elite', 'Elite I', 'Elite II', 'Elite III', 'Elite IV', 'Elite V'],
  Soldier: ['Defenceless', 'Mostly Defenceless', 'Rookie', 'Soldier', 'Gunslinger', 'Warrior', 'Gladiator', 'Deadeye', 'Elite', 'Elite I', 'Elite II', 'Elite III', 'Elite IV', 'Elite V'],
  Exobiologist: ['Directionless', 'Mostly Directionless', 'Compiler', 'Collector', 'Cataloguer', 'Taxonomist', 'Ecologist', 'Geneticist', 'Elite', 'Elite I', 'Elite II', 'Elite III', 'Elite IV', 'Elite V'],
  CQC: ['Helpless', 'Mostly Helpless', 'Amateur', 'Semi Professional', 'Professional', 'Champion', 'Hero', 'Legend', 'Elite', 'Elite I', 'Elite II', 'Elite III', 'Elite IV', 'Elite V'],
  Federation: ['None', 'Recruit', 'Cadet', 'Midshipman', 'Petty Officer', 'Chief Petty Officer', 'Warrant Officer', 'Ensign', 'Lieutenant', 'Lieutenant Commander', 'Post Commander', 'Post Captain', 'Rear Admiral', 'Vice Admiral', 'Admiral'],
  Empire: ['None', 'Outsider', 'Serf', 'Master', 'Squire', 'Knight', 'Lord', 'Baron', 'Viscount', 'Count', 'Earl', 'Marquis', 'Duke', 'Prince', 'King'],
};

/**
 * Commander profile: current ship, game mode, ranks, reputation and squadron.
 */
export default defineStatModule({
  name: 'commanders',
  title: 'Commanders',
  description: 'Commander profile details: ship, game mode, ranks, reputation and squadron.',
  version: 1,
  events: ['LoadGame', 'Rank', 'Progress', 'Promotion', 'Reputation', 'SquadronStartup', 'JoinedSquadron', 'LeftSquadron', 'Loadout', 'Statistics'],
  ownedObjects: [{ type: 'table', name: 'commander_profiles' }],
  schemaSql: `
    CREATE TABLE IF NOT EXISTS commander_profiles (
      commander_id     INTEGER PRIMARY KEY REFERENCES commanders(id),
      game_mode        TEXT,
      game_group       TEXT,
      is_horizons      INTEGER,
      is_odyssey       INTEGER,
      ship_type        TEXT,
      ship_type_name   TEXT,
      ship_name        TEXT,
      ship_ident       TEXT,
      ranks            TEXT NOT NULL DEFAULT '{}',
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
    const selectProfile = database.prepare('SELECT ranks, rank_progress FROM commander_profiles WHERE commander_id = ?');
    const updateLogin = database.prepare(`
      UPDATE commander_profiles SET game_mode = ?, game_group = ?, is_horizons = ?, is_odyssey = ?,
        ship_type = ?, ship_type_name = ?, ship_name = ?, ship_ident = ?, last_login = ?, updated_at = ?
      WHERE commander_id = ?
    `);
    const updateShip = database.prepare(`
      UPDATE commander_profiles SET ship_type = ?, ship_name = ?, ship_ident = ?, updated_at = ? WHERE commander_id = ?
    `);
    const updateRanks = database.prepare('UPDATE commander_profiles SET ranks = ?, updated_at = ? WHERE commander_id = ?');
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
            data.Ship ?? null, data.Ship_Localised ?? null, data.ShipName || null, data.ShipIdent || null,
            timestamp, timestamp, commanderId,
          );
          break;

        case 'Loadout':
          updateShip.run(data.Ship ?? null, data.ShipName || null, data.ShipIdent || null, timestamp, commanderId);
          break;

        case 'Rank':
        case 'Promotion': {
          const existingRanks = JSON.parse(selectProfile.get(commanderId).ranks);
          updateRanks.run(JSON.stringify({ ...existingRanks, ...pickRankValues(data) }), timestamp, commanderId);
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
        profiles.ship_type, profiles.ship_type_name, profiles.ship_name, profiles.ship_ident,
        profiles.ranks, profiles.rank_progress, profiles.reputation,
        profiles.squadron_name, profiles.squadron_rank, profiles.time_played_s, profiles.last_login,
        (SELECT COUNT(*) FROM journal_files WHERE journal_files.commander_id = commanders.id) AS journal_file_count,
        (SELECT COUNT(*) FROM journal_files WHERE journal_files.commander_id = commanders.id AND is_active = 1) AS active_journal_count
      FROM commanders
      LEFT JOIN commander_profiles AS profiles ON profiles.commander_id = commanders.id
      WHERE (?1 IS NULL OR commanders.id = ?1)
      ORDER BY commanders.last_seen DESC
    `);

    // GET /api/stats/commanders?commander=<id|all>
    router.get('/', (request, response) => {
      const commanderRows = selectProfiles.all(getCommanderIdFilter(request.query));
      const profiles = parseJsonColumns(commanderRows, ['ranks', 'rank_progress', 'reputation']).map((profile) => ({
        ...profile,
        rank_names: describeRanks(profile.ranks ?? {}),
        next_rank_names: describeRanks(profile.ranks ?? {}, 1),
      }));
      response.json({ commanders: profiles });
    });

    return router;
  },
});

function pickRankValues(data) {
  const { timestamp, event, ...rankValues } = data;
  return rankValues;
}

/** Rank names by type; with an offset of 1, the next rank's name (null at the top rank). */
function describeRanks(ranks, offset = 0) {
  return Object.fromEntries(
    Object.entries(ranks).map(([rankType, rankValue]) => {
      const names = RANK_NAMES[rankType];
      if (offset) return [rankType, names?.[rankValue + offset] ?? null];
      return [rankType, names?.[rankValue] ?? String(rankValue)];
    }),
  );
}

function toNullableFlag(value) {
  return value === undefined ? null : Number(Boolean(value));
}
