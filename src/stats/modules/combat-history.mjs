import { Router } from 'express';
import { getCombatantKind, getCombatantName, PILOT_RANKS } from '../../game-data/combatants.mjs';
import { normalizeItem } from '../../game-data/names.mjs';
import { getShipTypeName, isOwnShip } from '../../game-data/ships.mjs';
import { defineStatModule } from '../define-stat-module.mjs';
import {
  SqlFilter, addStandardFilters, getOrderByClause, getPagination, getTimeRangeFilter, runPaginatedQuery,
} from '../query-helpers.mjs';
import { COMBAT_DROP_PATTERN, JUMP_FIGHTER_LOSS_WINDOW_S, KILL_SESSION_BACKDATE_S } from './combat.mjs';

/**
 * Every combat session, kill, death and interdiction, for the Combat page's history and charts.
 * The live Combat Session panel (the "combat" module) only keeps the current session; this keeps
 * them all, using the same rules for when a session starts and ends:
 *
 * - A session starts on dropping into a combat instance (a Resource Extraction Site, nav beacon or
 *   conflict zone), arriving in a planetary ring, or the first kill outside a session (backdated a
 *   little). It ends on supercruise, a jump, docking, death or quitting.
 * - A session cut short by the game closing without a Shutdown (a crash) ends at its last
 *   activity, not at the next login. Sessions with no kills and no death aren't kept.
 * - Vouchers: bounties and combat bonds earned are tracked per faction until handed in. A hand-in
 *   (RedeemVoucher) claims everything owed by the factions it names, or everything of that kind
 *   when it names none (the game often logs an empty faction). The amount paid isn't subtracted:
 *   hand-ins can include a bonus (often 20% or 40%) that depends on things the journal doesn't
 *   log, so the paid amount can't be matched to the vouchers it covered. Dying forfeits whatever is unclaimed,
 *   recorded with the death (at face value, before any bonus). Thargoid bonds (from the Pilots'
 *   Federation) aren't counted: they survive death, as real journals show them handed in for
 *   far more than was earned since the last death.
 * - Deaths are classed by killer: a commander (player), a Thargoid, a station or other
 *   structure's defences, an NPC soldier on foot, an NPC ship, self-destruct (a SelfDestruct
 *   just before), heat (heat damage just before) or none logged.
 * - Victims' pilot ranks come from the last full scan (ShipTargeted ScanStage 3) of a pilot by
 *   that name, since Bounty doesn't log the rank.
 */
const SESSION_STATE_KEY = 'session';
const SHIP_STATE_KEY = 'ship';
const SYSTEM_STATE_KEY = 'system';
const VOUCHERS_STATE_KEY = 'vouchers';
const SCANNED_PILOTS_STATE_KEY = 'scannedPilots';
const JUMP_STARTED_STATE_KEY = 'jumpStartedAt';
const SELF_DESTRUCT_STATE_KEY = 'selfDestructAt';
const HEAT_DAMAGE_STATE_KEY = 'heatDamageAt';
const SCANNED_PILOT_COUNT = 40;
// A SelfDestruct or HeatDamage this soon before Died is taken as the cause.
const SELF_DESTRUCT_WINDOW_S = 60;
const HEAT_DEATH_WINDOW_S = 20;
const SESSION_END_EVENTS = new Set(['SupercruiseEntry', 'FSDJump', 'CarrierJump', 'Docked', 'Died', 'Shutdown']);
const PLAYER_NAME_PATTERN = /^cmdr\s/i;

/** Lower-case letters and digits only, so "$faction_PilotsFederation;" matches "Pilots' Federation". */
function factionKey(name) {
  return String(name ?? '').replace(/^\$faction_/i, '').replace(/;$/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function secondsBetween(earlier, later) {
  return (Date.parse(later) - Date.parse(earlier)) / 1000;
}

// Thargoid kill bonds are awarded by the Pilots' Federation and aren't lost on death.
const DEATH_SAFE_BOND_FACTIONS = new Set(['pilotsfederation']);

function sumValues(byFaction) {
  return Object.values(byFaction ?? {}).reduce((total, value) => total + value, 0);
}

/** How a commander died, from the Died event's killer(s) and what happened just before. */
function classifyDeath(data, { selfDestructAt, heatDamageAt, timestamp }) {
  const killers = Array.isArray(data.Killers) && data.Killers.length > 0
    ? data.Killers.map((killer) => ({ name: killer.Name_Localised ?? killer.Name, ship: killer.Ship, rank: killer.Rank }))
    : data.KillerName || data.KillerShip
      ? [{ name: data.KillerName_Localised ?? data.KillerName, ship: data.KillerShip, rank: data.KillerRank }]
      : [];
  const killer = killers.find((candidate) => PLAYER_NAME_PATTERN.test(candidate.name ?? '')) ?? killers[0] ?? null;
  let cause;
  if (killers.some((candidate) => PLAYER_NAME_PATTERN.test(candidate.name ?? ''))) cause = 'player';
  else if (killers.some((candidate) => getCombatantKind(candidate.ship) === 'thargoid')) cause = 'thargoid';
  else if (killers.some((candidate) => getCombatantKind(candidate.ship) === 'structure')) cause = 'structure';
  else if (killers.some((candidate) => getCombatantKind(candidate.ship) === 'on_foot')) cause = 'on_foot';
  else if (killers.length > 0) cause = 'npc';
  else if (selfDestructAt && secondsBetween(selfDestructAt, timestamp) <= SELF_DESTRUCT_WINDOW_S) cause = 'self_destruct';
  else if (heatDamageAt && secondsBetween(heatDamageAt, timestamp) <= HEAT_DEATH_WINDOW_S) cause = 'heat';
  else cause = 'unknown';
  return {
    cause,
    killerName: killer?.name ? String(killer.name).replace(PLAYER_NAME_PATTERN, '') : null,
    killerShip: killer?.ship ?? null,
    killerRank: killer?.rank ?? null,
    killerCount: killers.length,
  };
}

export default defineStatModule({
  name: 'combat-history',
  title: 'Combat History',
  description: 'Every combat session, kill, death and interdiction: kill rates, earnings, what killed you and what it cost.',
  version: 2,
  events: [
    'LoadGame', 'Loadout', 'Location', 'FSDJump', 'CarrierJump', 'SupercruiseDestinationDrop', 'SupercruiseEntry', 'Docked',
    'Died', 'Shutdown', 'Music', 'Bounty', 'FactionKillBond', 'CapShipBond', 'RedeemVoucher', 'ShipTargeted',
    'ShieldState', 'HullDamage', 'FighterDestroyed', 'StartJump', 'SelfDestruct', 'HeatDamage', 'Interdicted', 'EscapeInterdiction',
  ],
  ownedObjects: [
    { type: 'table', name: 'combat_sessions' },
    { type: 'table', name: 'combat_kills' },
    { type: 'table', name: 'combat_deaths' },
    { type: 'table', name: 'combat_interdictions' },
  ],
  schemaSql: `
    CREATE TABLE IF NOT EXISTS combat_sessions (
      id                INTEGER PRIMARY KEY,
      commander_id      INTEGER NOT NULL REFERENCES commanders(id),
      started_at        TEXT NOT NULL,
      ended_at          TEXT,             -- NULL while under way (or the journal ends mid-session)
      last_activity_at  TEXT NOT NULL,
      end_reason        TEXT,             -- supercruise | jump | docked | died | quit | crash
      location          TEXT,             -- e.g. "Resource Extraction Site [High]"
      star_system       TEXT,
      ship_type         TEXT,
      ship_name         TEXT,
      kills             INTEGER NOT NULL DEFAULT 0,
      bond_kills        INTEGER NOT NULL DEFAULT 0,
      bounty_credits    INTEGER NOT NULL DEFAULT 0,
      bond_credits      INTEGER NOT NULL DEFAULT 0,
      shields_down      INTEGER NOT NULL DEFAULT 0,
      lowest_hull       REAL,             -- 0-1, the lowest HullDamage level reported
      fighters_lost     INTEGER NOT NULL DEFAULT 0,
      died              INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_combat_sessions_commander ON combat_sessions(commander_id, started_at);

    CREATE TABLE IF NOT EXISTS combat_kills (
      id              INTEGER PRIMARY KEY,
      commander_id    INTEGER NOT NULL REFERENCES commanders(id),
      session_id      INTEGER,            -- combat_sessions.id
      timestamp       TEXT NOT NULL,
      kind            TEXT NOT NULL,      -- bounty | bond | capship
      reward          INTEGER NOT NULL DEFAULT 0,
      target_type     TEXT,               -- the victim's ship type (bounties only)
      pilot_name      TEXT,
      pilot_rank      TEXT,               -- from the last full scan of that pilot, when there was one
      victim_faction  TEXT,
      ship_type       TEXT                -- the commander's own ship
    );
    CREATE INDEX IF NOT EXISTS idx_combat_kills_commander ON combat_kills(commander_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_combat_kills_time ON combat_kills(timestamp);

    CREATE TABLE IF NOT EXISTS combat_deaths (
      id              INTEGER PRIMARY KEY,
      commander_id    INTEGER NOT NULL REFERENCES commanders(id),
      session_id      INTEGER,            -- combat_sessions.id
      timestamp       TEXT NOT NULL,
      cause           TEXT NOT NULL,      -- player | thargoid | structure | on_foot | npc | self_destruct | heat | unknown
      killer_name     TEXT,
      killer_ship     TEXT,
      killer_rank     TEXT,
      killer_count    INTEGER NOT NULL DEFAULT 0,
      ship_type       TEXT,
      ship_name       TEXT,
      star_system     TEXT,
      vouchers_lost   INTEGER NOT NULL DEFAULT 0   -- unredeemed bounties and bonds, estimated
    );
    CREATE INDEX IF NOT EXISTS idx_combat_deaths_commander ON combat_deaths(commander_id, timestamp);

    CREATE TABLE IF NOT EXISTS combat_interdictions (
      id            INTEGER PRIMARY KEY,
      commander_id  INTEGER NOT NULL REFERENCES commanders(id),
      timestamp     TEXT NOT NULL,
      outcome       TEXT NOT NULL,        -- submitted | escaped | pulled_out (fought it and lost)
      is_player     INTEGER NOT NULL DEFAULT 0,
      interdictor   TEXT,
      star_system   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_combat_interdictions_commander ON combat_interdictions(commander_id, timestamp);
  `,

  createProcessor(database) {
    const insertSession = database.prepare(`
      INSERT INTO combat_sessions (commander_id, started_at, last_activity_at, location, star_system, ship_type, ship_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const touchSession = database.prepare('UPDATE combat_sessions SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?');
    const closeSession = database.prepare('UPDATE combat_sessions SET ended_at = ?, end_reason = ?, last_activity_at = MAX(last_activity_at, ?) WHERE id = ?');
    const selectSession = database.prepare('SELECT kills, died, last_activity_at FROM combat_sessions WHERE id = ?');
    const deleteSession = database.prepare('DELETE FROM combat_sessions WHERE id = ?');
    const addKillToSession = database.prepare(`
      UPDATE combat_sessions SET kills = kills + 1, bond_kills = bond_kills + ?, bounty_credits = bounty_credits + ?, bond_credits = bond_credits + ?,
        last_activity_at = MAX(last_activity_at, ?)
      WHERE id = ?
    `);
    const addShieldsDown = database.prepare('UPDATE combat_sessions SET shields_down = shields_down + 1, last_activity_at = MAX(last_activity_at, ?) WHERE id = ?');
    const updateLowestHull = database.prepare('UPDATE combat_sessions SET lowest_hull = MIN(COALESCE(lowest_hull, 1), ?), last_activity_at = MAX(last_activity_at, ?) WHERE id = ?');
    const addFighterLost = database.prepare('UPDATE combat_sessions SET fighters_lost = fighters_lost + 1, last_activity_at = MAX(last_activity_at, ?) WHERE id = ?');
    const markDied = database.prepare('UPDATE combat_sessions SET died = 1 WHERE id = ?');
    const insertKill = database.prepare(`
      INSERT INTO combat_kills (commander_id, session_id, timestamp, kind, reward, target_type, pilot_name, pilot_rank, victim_faction, ship_type)
      VALUES (:commanderId, :sessionId, :timestamp, :kind, :reward, :targetType, :pilotName, :pilotRank, :victimFaction, :shipType)
    `);
    const insertDeath = database.prepare(`
      INSERT INTO combat_deaths (commander_id, session_id, timestamp, cause, killer_name, killer_ship, killer_rank, killer_count, ship_type, ship_name, star_system, vouchers_lost)
      VALUES (:commanderId, :sessionId, :timestamp, :cause, :killerName, :killerShip, :killerRank, :killerCount, :shipType, :shipName, :starSystem, :vouchersLost)
    `);
    const insertInterdiction = database.prepare(`
      INSERT INTO combat_interdictions (commander_id, timestamp, outcome, is_player, interdictor, star_system) VALUES (?, ?, ?, ?, ?, ?)
    `);

    return ({ commanderId, event, timestamp, data }, moduleState) => {
      const ship = () => moduleState.get(SHIP_STATE_KEY) ?? {};
      const openSessionId = () => moduleState.get(SESSION_STATE_KEY) ?? null;

      /** Ends the open session; one with nothing in it is dropped. */
      const endSession = (endedAt, reason) => {
        const sessionId = openSessionId();
        if (!sessionId) return;
        moduleState.set(SESSION_STATE_KEY, null);
        const session = selectSession.get(sessionId);
        if (!session) return;
        if (session.kills === 0 && !session.died) {
          deleteSession.run(sessionId);
          return;
        }
        // The game closed without saying so: the session ended when the commander last did something.
        const isCrash = reason === 'crash';
        closeSession.run(isCrash ? session.last_activity_at : endedAt, reason, isCrash ? session.last_activity_at : endedAt, sessionId);
      };
      const beginSession = (startedAt, location) => {
        endSession(startedAt, 'supercruise');
        const { lastInsertRowid } = insertSession.run(
          commanderId, startedAt, startedAt, location, moduleState.get(SYSTEM_STATE_KEY) ?? null, ship().type ?? null, ship().name ?? null,
        );
        moduleState.set(SESSION_STATE_KEY, Number(lastInsertRowid));
        return Number(lastInsertRowid);
      };
      const ensureSession = () => openSessionId()
        ?? beginSession(new Date(Date.parse(timestamp) - KILL_SESSION_BACKDATE_S * 1000).toISOString().replace(/\.\d+Z$/, 'Z'), null);

      const vouchers = () => moduleState.get(VOUCHERS_STATE_KEY) ?? { bounty: {}, bond: {} };
      const addVoucher = (type, faction, amount) => {
        if (!(amount > 0)) return;
        const current = vouchers();
        const key = factionKey(faction) || '?';
        if (type === 'bond' && DEATH_SAFE_BOND_FACTIONS.has(key)) return;
        current[type][key] = (current[type][key] ?? 0) + amount;
        moduleState.set(VOUCHERS_STATE_KEY, current);
      };

      const recordKill = ({ kind, reward, targetType = null, pilotName = null, victimFaction }) => {
        const sessionId = ensureSession();
        const scannedPilots = moduleState.get(SCANNED_PILOTS_STATE_KEY) ?? [];
        const pilotRank = pilotName ? scannedPilots.findLast((pilot) => pilot.name === pilotName)?.rank ?? null : null;
        insertKill.run({
          commanderId, sessionId, timestamp, kind, reward, targetType, pilotName, pilotRank,
          victimFaction: victimFaction ?? null, shipType: ship().type ?? null,
        });
        addKillToSession.run(kind === 'bounty' ? 0 : 1, kind === 'bounty' ? reward : 0, kind === 'bounty' ? 0 : reward, timestamp, sessionId);
      };

      switch (event) {
        case 'LoadGame':
          // A session still open at login was cut short by the game closing without a Shutdown.
          endSession(timestamp, 'crash');
          // Logged in on foot or in an SRV: the ship they came in is still theirs.
          if (isOwnShip(data.Ship, data.ShipID)) moduleState.set(SHIP_STATE_KEY, { type: normalizeItem(data.Ship), name: data.ShipName ?? null });
          return;

        case 'Loadout':
          if (data.Ship) moduleState.set(SHIP_STATE_KEY, { type: normalizeItem(data.Ship), name: data.ShipName ?? null });
          return;

        case 'Location':
          if (data.StarSystem) moduleState.set(SYSTEM_STATE_KEY, data.StarSystem);
          if (data.BodyType === 'PlanetaryRing' && !openSessionId()) beginSession(timestamp, data.Body ?? 'Planetary ring');
          return;

        case 'SupercruiseDestinationDrop':
          if (COMBAT_DROP_PATTERN.test(data.Type ?? '')) beginSession(timestamp, data.Type_Localised ?? null);
          return;

        case 'Music':
          if (data.MusicTrack === 'MainMenu') endSession(timestamp, 'quit');
          return;

        case 'Bounty': {
          const rewards = Array.isArray(data.Rewards) && data.Rewards.length > 0
            ? data.Rewards
            : [{ Faction: data.Faction, Reward: data.Reward ?? data.TotalReward ?? 0 }];
          for (const reward of rewards) addVoucher('bounty', reward.Faction, reward.Reward ?? 0);
          recordKill({
            kind: 'bounty',
            reward: data.TotalReward ?? rewards.reduce((total, reward) => total + (reward.Reward ?? 0), 0),
            targetType: data.Target ?? null,
            pilotName: data.PilotName_Localised ?? null,
            victimFaction: data.VictimFaction_Localised ?? data.VictimFaction,
          });
          return;
        }

        case 'FactionKillBond':
        case 'CapShipBond':
          addVoucher('bond', data.AwardingFaction_Localised ?? data.AwardingFaction, data.Reward ?? 0);
          recordKill({
            kind: event === 'CapShipBond' ? 'capship' : 'bond',
            reward: data.Reward ?? 0,
            victimFaction: data.VictimFaction_Localised ?? data.VictimFaction,
          });
          return;

        case 'RedeemVoucher': {
          const type = data.Type === 'bounty' ? 'bounty' : data.Type === 'CombatBond' ? 'bond' : null;
          if (!type) return;
          const current = vouchers();
          const factionKeys = (Array.isArray(data.Factions) && data.Factions.length > 0 ? data.Factions.map((part) => part.Faction) : [data.Faction])
            .map(factionKey);
          if (factionKeys.some((key) => !key)) current[type] = {};
          else for (const key of factionKeys) delete current[type][key];
          moduleState.set(VOUCHERS_STATE_KEY, current);
          return;
        }

        case 'ShipTargeted': {
          if (data.ScanStage !== 3 || !data.PilotName_Localised || !data.PilotRank) return;
          const scannedPilots = (moduleState.get(SCANNED_PILOTS_STATE_KEY) ?? []).filter((pilot) => pilot.name !== data.PilotName_Localised);
          moduleState.set(SCANNED_PILOTS_STATE_KEY, [...scannedPilots, { name: data.PilotName_Localised, rank: data.PilotRank }].slice(-SCANNED_PILOT_COUNT));
          return;
        }

        case 'ShieldState':
          if (data.ShieldsUp === false && openSessionId()) addShieldsDown.run(timestamp, openSessionId());
          return;

        case 'HullDamage':
          if (openSessionId() && data.PlayerPilot && !data.Fighter && Number.isFinite(data.Health)) updateLowestHull.run(data.Health, timestamp, openSessionId());
          return;

        case 'StartJump':
          moduleState.set(JUMP_STARTED_STATE_KEY, timestamp);
          return;

        case 'FighterDestroyed': {
          const jumpStartedAt = moduleState.get(JUMP_STARTED_STATE_KEY);
          const isJumpLoss = jumpStartedAt && secondsBetween(jumpStartedAt, timestamp) <= JUMP_FIGHTER_LOSS_WINDOW_S;
          if (!isJumpLoss && openSessionId()) addFighterLost.run(timestamp, openSessionId());
          return;
        }

        case 'SelfDestruct':
          moduleState.set(SELF_DESTRUCT_STATE_KEY, timestamp);
          return;

        case 'HeatDamage':
          moduleState.set(HEAT_DAMAGE_STATE_KEY, timestamp);
          return;

        case 'Interdicted':
        case 'EscapeInterdiction': {
          const outcome = event === 'EscapeInterdiction' ? 'escaped' : data.Submitted ? 'submitted' : 'pulled_out';
          const interdictor = data.Interdictor_Localised ?? data.Interdictor ?? null;
          insertInterdiction.run(commanderId, timestamp, outcome, data.IsPlayer ? 1 : 0, interdictor, moduleState.get(SYSTEM_STATE_KEY) ?? null);
          return;
        }

        case 'Died': {
          const sessionId = openSessionId();
          const current = vouchers();
          const death = classifyDeath(data, {
            selfDestructAt: moduleState.get(SELF_DESTRUCT_STATE_KEY),
            heatDamageAt: moduleState.get(HEAT_DAMAGE_STATE_KEY),
            timestamp,
          });
          insertDeath.run({
            commanderId, sessionId, timestamp, ...death,
            shipType: ship().type ?? null, shipName: ship().name ?? null,
            starSystem: moduleState.get(SYSTEM_STATE_KEY) ?? null,
            vouchersLost: Math.round(sumValues(current.bounty) + sumValues(current.bond)),
          });
          moduleState.set(VOUCHERS_STATE_KEY, { bounty: {}, bond: {} });
          if (sessionId) {
            markDied.run(sessionId);
            touchSession.run(timestamp, sessionId);
          }
          endSession(timestamp, 'died');
          return;
        }
      }

      if (SESSION_END_EVENTS.has(event)) {
        if (data.StarSystem) moduleState.set(SYSTEM_STATE_KEY, data.StarSystem);
        const reason = { SupercruiseEntry: 'supercruise', FSDJump: 'jump', CarrierJump: 'jump', Docked: 'docked', Shutdown: 'quit' }[event];
        endSession(timestamp, reason);
      }
    };
  },

  createRouter(database) {
    const router = Router();

    /** Commander and time range conditions for one of this module's tables. */
    const filterFor = (query, { commanderColumn = 'commander_id', timestampColumn = 'timestamp', searchColumns = [] } = {}) => addStandardFilters(new SqlFilter(), query, {
      commanderColumn, timestampColumn, searchColumns,
    });
    const sessionDuration = "(unixepoch(COALESCE(ended_at, last_activity_at)) - unixepoch(started_at))";

    // GET /api/stats/combat-history/summary?commander=&period=|from=&to=
    router.get('/summary', (request, response) => {
      const killFilter = filterFor(request.query);
      const kills = database.prepare(`
        SELECT COUNT(*) AS kills,
          SUM(kind = 'bounty') AS bountyKills, SUM(kind <> 'bounty') AS bondKills,
          COALESCE(SUM(CASE WHEN kind = 'bounty' THEN reward END), 0) AS bountyCredits,
          COALESCE(SUM(CASE WHEN kind <> 'bounty' THEN reward END), 0) AS bondCredits,
          MAX(CASE WHEN kind = 'bounty' THEN reward END) AS largestBounty,
          MIN(timestamp) AS firstKillAt, MAX(timestamp) AS lastKillAt
        FROM combat_kills ${killFilter.whereClause}
      `).get(...killFilter.parameters);
      const sessionFilter = filterFor(request.query, { timestampColumn: 'started_at' });
      const sessions = database.prepare(`
        SELECT COUNT(*) AS sessions, COALESCE(SUM(${sessionDuration}), 0) AS seconds,
          MAX(CASE WHEN ${sessionDuration} >= 900 AND kills > 0 THEN kills * 3600.0 / (${sessionDuration}) END) AS bestKillsPerHour
        FROM combat_sessions ${sessionFilter.whereClause}
      `).get(...sessionFilter.parameters);
      const deathFilter = filterFor(request.query);
      const deaths = database.prepare(`
        SELECT COUNT(*) AS deaths, COALESCE(SUM(vouchers_lost), 0) AS vouchersLost FROM combat_deaths ${deathFilter.whereClause}
      `).get(...deathFilter.parameters);
      const deathCauses = database.prepare(`
        SELECT cause, COUNT(*) AS count, COALESCE(SUM(vouchers_lost), 0) AS vouchersLost FROM combat_deaths ${deathFilter.whereClause}
        GROUP BY cause ORDER BY count DESC
      `).all(...deathFilter.parameters);
      const interdictionFilter = filterFor(request.query);
      const interdictions = database.prepare(`
        SELECT outcome, is_player AS isPlayer, COUNT(*) AS count FROM combat_interdictions ${interdictionFilter.whereClause} GROUP BY outcome, is_player
      `).all(...interdictionFilter.parameters).map((row) => ({ ...row, isPlayer: Boolean(row.isPlayer) }));
      response.json({
        kills: { ...kills, bountyKills: kills.bountyKills ?? 0, bondKills: kills.bondKills ?? 0 },
        sessions,
        deaths: { ...deaths, byCause: deathCauses },
        interdictions,
      });
    });

    // GET /api/stats/combat-history/timeline?commander=&period=|from=&to=&utcOffset=
    // Kills and credits per day, week (from Monday) or month, chosen from the span covered.
    router.get('/timeline', (request, response) => {
      const offsetModifier = getOffsetModifier(request.query.utcOffset);
      const killFilter = filterFor(request.query);
      const span = database.prepare(`SELECT MIN(timestamp) AS firstAt, MAX(timestamp) AS lastAt FROM combat_kills ${killFilter.whereClause}`).get(...killFilter.parameters);
      const { fromTimestamp } = getTimeRangeFilter(request.query);
      const spanDays = span.firstAt ? (Date.parse(span.lastAt) - Date.parse(fromTimestamp ?? span.firstAt)) / 86_400_000 : 0;
      const bucket = spanDays <= 92 ? 'day' : spanDays <= 2 * 366 ? 'week' : 'month';
      const bucketExpression = {
        day: `date(timestamp, '${offsetModifier}')`,
        week: `date(timestamp, '${offsetModifier}', '-6 days', 'weekday 1')`,
        month: `strftime('%Y-%m', timestamp, '${offsetModifier}')`,
      }[bucket];
      const rows = database.prepare(`
        SELECT ${bucketExpression} AS period,
          SUM(kind = 'bounty') AS bountyKills, SUM(kind <> 'bounty') AS bondKills,
          COALESCE(SUM(CASE WHEN kind = 'bounty' THEN reward END), 0) AS bountyCredits,
          COALESCE(SUM(CASE WHEN kind <> 'bounty' THEN reward END), 0) AS bondCredits
        FROM combat_kills ${killFilter.whereClause}
        GROUP BY period ORDER BY period
      `).all(...killFilter.parameters);
      response.json({ bucket, periods: fillPeriods(rows, bucket) });
    });

    // GET /api/stats/combat-history/heatmap?commander=&period=|from=&to=&utcOffset=
    // Kills by weekday (0 = Sunday) and hour, in the viewer's time zone.
    router.get('/heatmap', (request, response) => {
      const offsetModifier = getOffsetModifier(request.query.utcOffset);
      const killFilter = filterFor(request.query);
      const cells = database.prepare(`
        SELECT CAST(strftime('%w', timestamp, '${offsetModifier}') AS INTEGER) AS weekday,
          CAST(strftime('%H', timestamp, '${offsetModifier}') AS INTEGER) AS hour, COUNT(*) AS kills
        FROM combat_kills ${killFilter.whereClause} GROUP BY weekday, hour
      `).all(...killFilter.parameters);
      response.json({ cells });
    });

    const sessionColumns = `
      combat_sessions.id, combat_sessions.commander_id, commanders.name AS commander_name, started_at,
      COALESCE(ended_at, last_activity_at) AS ended_at, ended_at IS NULL AS is_open, end_reason, location, star_system, ship_type, ship_name,
      kills, bond_kills, bounty_credits, bond_credits, bounty_credits + bond_credits AS credits,
      shields_down, lowest_hull, fighters_lost, died,
      ${sessionDuration} AS duration_s,
      CASE WHEN ${sessionDuration} > 0 THEN kills * 3600.0 / (${sessionDuration}) END AS kills_per_hour
    `;

    // GET /api/stats/combat-history/filters?commander=&period=|from=&to=
    // The choices for the session and death filters, with how many of each, in the time range.
    router.get('/filters', (request, response) => {
      const sessionFilter = filterFor(request.query, { timestampColumn: 'started_at' });
      const sessionChoices = (column) => database.prepare(`
        SELECT ${column} AS value, COUNT(*) AS count FROM combat_sessions ${sessionFilter.whereClause}
        ${sessionFilter.whereClause ? 'AND' : 'WHERE'} ${column} IS NOT NULL GROUP BY ${column}
      `).all(...sessionFilter.parameters);
      const deathFilter = filterFor(request.query);
      const deathChoices = (column) => database.prepare(`
        SELECT ${column} AS value, COUNT(*) AS count FROM combat_deaths ${deathFilter.whereClause}
        ${deathFilter.whereClause ? 'AND' : 'WHERE'} ${column} IS NOT NULL GROUP BY ${column}
      `).all(...deathFilter.parameters);
      const byLabel = (first, second) => first.label.localeCompare(second.label);
      response.json({
        sessions: {
          systems: sessionChoices('star_system').map((choice) => ({ ...choice, label: choice.value })).sort(byLabel),
          ships: sessionChoices('ship_type').map((choice) => ({ ...choice, label: getShipTypeName(choice.value) })).sort(byLabel),
        },
        deaths: {
          causes: deathChoices('cause').map((choice) => ({ ...choice, label: choice.value })),
          killers: deathChoices('killer_name').map((choice) => ({ ...choice, label: choice.value })).sort(byLabel),
          systems: deathChoices('star_system').map((choice) => ({ ...choice, label: choice.value })).sort(byLabel),
        },
      });
    });

    // GET /api/stats/combat-history/sessions?commander=&period=&search=&system=&ship=&sort=&order=&limit=&offset=
    router.get('/sessions', (request, response) => {
      const sqlFilter = filterFor(request.query, { timestampColumn: 'started_at', searchColumns: ['location', 'star_system', 'ship_type', 'ship_name'] });
      if (request.query.system) sqlFilter.add('star_system = ?', String(request.query.system));
      if (request.query.ship) sqlFilter.add('ship_type = ?', String(request.query.ship));
      const result = runPaginatedQuery(database, {
        selectSql: `SELECT ${sessionColumns} FROM combat_sessions JOIN commanders ON commanders.id = combat_sessions.commander_id`,
        sqlFilter,
        orderByClause: getOrderByClause(request.query, {
          started_at: 'started_at', duration: 'duration_s', kills: 'kills', kills_per_hour: 'kills_per_hour', credits: 'credits',
          lowest_hull: 'COALESCE(lowest_hull, 1)',
        }, 'started_at'),
        pagination: getPagination(request.query),
      });
      response.json({ ...result, rows: result.rows.map(describeSession) });
    });

    // GET /api/stats/combat-history/session-points?commander=&period=
    // Sessions long enough for a fair rate (5 minutes or more, with a kill), for the scatter chart.
    router.get('/session-points', (request, response) => {
      const sqlFilter = filterFor(request.query, { timestampColumn: 'started_at' }).add(`kills > 0 AND ${sessionDuration} >= 300`);
      const rows = database.prepare(`
        SELECT ${sessionColumns} FROM combat_sessions JOIN commanders ON commanders.id = combat_sessions.commander_id
        ${sqlFilter.whereClause} ORDER BY started_at DESC LIMIT 5000
      `).all(...sqlFilter.parameters);
      response.json({ sessions: rows.map(describeSession) });
    });

    // GET /api/stats/combat-history/deaths?commander=&period=&search=&cause=&killer=&system=&sort=&order=&limit=&offset=
    router.get('/deaths', (request, response) => {
      const sqlFilter = filterFor(request.query, {
        commanderColumn: 'combat_deaths.commander_id',
        timestampColumn: 'combat_deaths.timestamp',
        searchColumns: ['killer_name', 'killer_ship', 'combat_deaths.star_system', 'combat_deaths.ship_type', 'combat_deaths.ship_name'],
      });
      if (request.query.cause) sqlFilter.add('cause = ?', String(request.query.cause));
      if (request.query.killer) sqlFilter.add('killer_name = ?', String(request.query.killer));
      if (request.query.system) sqlFilter.add('combat_deaths.star_system = ?', String(request.query.system));
      const result = runPaginatedQuery(database, {
        selectSql: `
          SELECT combat_deaths.*, commanders.name AS commander_name, combat_sessions.location AS session_location
          FROM combat_deaths JOIN commanders ON commanders.id = combat_deaths.commander_id
          LEFT JOIN combat_sessions ON combat_sessions.id = combat_deaths.session_id
        `,
        sqlFilter,
        // Deaths with no killer or system sort after the named ones either way; ties go newest first.
        orderByClause: `${getOrderByClause(request.query, {
          timestamp: 'combat_deaths.timestamp',
          vouchers_lost: 'vouchers_lost',
          cause: 'cause',
          killer: 'killer_name IS NULL, killer_name COLLATE NOCASE',
          system: 'combat_deaths.star_system IS NULL, combat_deaths.star_system COLLATE NOCASE',
        }, 'timestamp')}, combat_deaths.timestamp DESC`,
        pagination: getPagination(request.query),
      });
      response.json({
        ...result,
        rows: result.rows.map((death) => ({
          ...death,
          killer_ship_name: getCombatantName(death.killer_ship),
          ship_type_name: death.ship_type ? getShipTypeName(death.ship_type) : null,
        })),
      });
    });

    // GET /api/stats/combat-history/victims?commander=&period=
    // Bounty kills by the victim's ship type and pilot rank, and kills by victim faction.
    router.get('/victims', (request, response) => {
      const bountyFilter = filterFor(request.query).add("kind = 'bounty'");
      const byShipType = database.prepare(`
        SELECT target_type AS type, COUNT(*) AS kills, SUM(reward) AS credits FROM combat_kills ${bountyFilter.whereClause} GROUP BY target_type
      `).all(...bountyFilter.parameters);
      // Several internal types can share a display name; merge them.
      const ships = new Map();
      for (const row of byShipType) {
        const name = getCombatantName(row.type) ?? 'Unknown';
        const merged = ships.get(name) ?? { name, kills: 0, credits: 0 };
        merged.kills += row.kills;
        merged.credits += row.credits;
        ships.set(name, merged);
      }
      const byRank = database.prepare(`
        SELECT pilot_rank AS rank, COUNT(*) AS kills FROM combat_kills ${bountyFilter.whereClause} GROUP BY pilot_rank
      `).all(...bountyFilter.parameters);
      const killFilter = filterFor(request.query);
      const byFaction = database.prepare(`
        SELECT victim_faction AS faction, COUNT(*) AS kills, SUM(reward) AS credits FROM combat_kills ${killFilter.whereClause}
        GROUP BY victim_faction ORDER BY kills DESC LIMIT 25
      `).all(...killFilter.parameters);
      response.json({
        byShip: [...ships.values()].sort((first, second) => second.kills - first.kills),
        byRank: [
          ...PILOT_RANKS.map((rank) => ({ rank, kills: byRank.find((row) => row.rank === rank)?.kills ?? 0 })),
          { rank: null, kills: byRank.filter((row) => !PILOT_RANKS.includes(row.rank)).reduce((total, row) => total + row.kills, 0) },
        ],
        byFaction,
      });
    });

    return router;
  },
});

/** A whole-minute SQLite date modifier for the viewer's UTC offset (?utcOffset=<minutes east of UTC>). */
function getOffsetModifier(utcOffset) {
  const minutes = Number.parseInt(utcOffset, 10);
  const clamped = Number.isFinite(minutes) ? Math.max(-14 * 60, Math.min(14 * 60, minutes)) : 0;
  return `${clamped >= 0 ? '+' : ''}${clamped} minutes`;
}

/** The periods between the first and last with kills, including the empty ones, so gaps show. */
function fillPeriods(rows, bucket) {
  if (rows.length === 0) return [];
  const byPeriod = new Map(rows.map((row) => [row.period, row]));
  const periods = [];
  const cursor = new Date(`${rows[0].period}${bucket === 'month' ? '-01' : ''}T00:00:00Z`);
  const last = rows.at(-1).period;
  for (let guard = 0; guard < 5000; guard++) {
    const period = bucket === 'month' ? cursor.toISOString().slice(0, 7) : cursor.toISOString().slice(0, 10);
    if (period > last) break;
    periods.push(byPeriod.get(period) ?? { period, bountyKills: 0, bondKills: 0, bountyCredits: 0, bondCredits: 0 });
    if (bucket === 'month') cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + (bucket === 'week' ? 7 : 1));
  }
  return periods;
}

function describeSession(session) {
  return {
    ...session,
    is_open: Boolean(session.is_open),
    died: Boolean(session.died),
    ship_type_name: session.ship_type ? getShipTypeName(session.ship_type) : null,
  };
}
