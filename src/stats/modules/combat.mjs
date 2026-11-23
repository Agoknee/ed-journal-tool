import { Router } from 'express';
import { defineStatModule } from '../define-stat-module.mjs';
import { getCommanderIdFilter } from '../query-helpers.mjs';

/**
 * The current (or most recent) combat session for each commander, for watching an AFK massacre
 * run: kills and pirate cargo scans with their times, fuel left and the fighter's state. Session
 * rules follow ED AFK Monitor (github.com/PsiPab/ED-AFK-Monitor):
 *
 * - A session starts on dropping into a combat instance (a Resource Extraction Site or conflict
 *   zone), arriving in a planetary ring, or the first kill or pirate scan outside a session
 *   (backdated a little, as the fight began before it).
 * - It ends on supercruise, a jump, death or quitting to the main menu.
 * - Pirate scans are the "scanning your cargo" messages; repeats from the last few pirates are one scan.
 * - The fuel burn rate is the fuel used between the last two ReservoirReplenished events of the
 *   session over the time between them. Burn depends on the ship's power draw, so only readings
 *   from the current session count: each session starts the measurement afresh.
 * - A fighter that was out when the game closed is taken to still be out (it is after logging back
 *   in); it's only cleared by leaving the instance, docking or dying. Only NPC-crewed fighters
 *   count: one the commander launches to fly themselves isn't tracked. Supercruise or a jump
 *   destroys a fighter that's out, but that's logged as FighterDestroyed just after StartJump and
 *   isn't treated as the fighter being shot down.
 * - Hull health (0-1) for the ship and the NPC fighter comes from HullDamage, which the game only
 *   logs as the hull falls past 80%, 60%, 40% and 20%, so it's the last level reported. The ship's
 *   hull is set by Loadout and full repairs; repair limpets report hull points rather than a share
 *   of the hull, so after one the ship's hull is unknown until the next reading.
 * - Shields come from the journal's ShieldState events, which are the commander's own (Status.json
 *   is shared by every game client on the machine). They're reset to unknown (counted as up) on
 *   login, death, respawn and at the start of each session, as a "down" isn't always followed by
 *   an "up" event (after a respawn, say).
 */
const RECENT_SCANNERS_STATE_KEY = 'recentScanners';
const RECENT_SCANNER_COUNT = 5;
const JUMP_STARTED_STATE_KEY = 'jumpStartedAt';
// A FighterDestroyed this soon after StartJump is the jump taking the fighter, not a kill.
export const JUMP_FIGHTER_LOSS_WINDOW_S = 10;
export const KILL_SESSION_BACKDATE_S = 60;
const SCAN_SESSION_BACKDATE_S = 30;
// Drop types for combat instances: "$MULTIPLAYER_SCENARIO..." (RES) and "$Warzone_..." (conflict zones).
export const COMBAT_DROP_PATTERN = /\$MULTIPLAYER|\$Warzone/i;

export default defineStatModule({
  name: 'combat',
  title: 'Combat Session',
  description: 'The current combat session for each commander: kill and scan rates, fuel and fighter state.',
  version: 7,
  events: [
    'LoadGame', 'Loadout', 'Location', 'SupercruiseDestinationDrop', 'SupercruiseEntry', 'FSDJump', 'CarrierJump',
    'Docked', 'Died', 'Music', 'Shutdown', 'Bounty', 'FactionKillBond', 'ReceiveText', 'ReservoirReplenished',
    'RefuelAll', 'RefuelPartial', 'LaunchFighter', 'DockFighter', 'FighterDestroyed', 'FighterRebuilt', 'ShieldState', 'Resurrect',
    'StartJump', 'HullDamage', 'RepairAll', 'Repair', 'RepairDrone',
  ],
  ownedObjects: [
    { type: 'table', name: 'combat_status' },
    { type: 'table', name: 'combat_events' },
  ],
  schemaSql: `
    CREATE TABLE IF NOT EXISTS combat_status (
      commander_id        INTEGER PRIMARY KEY REFERENCES commanders(id),
      current_system      TEXT,
      session_started_at  TEXT,
      session_ended_at    TEXT,       -- NULL while the session is under way
      session_location    TEXT,       -- e.g. "Resource Extraction Site [Low]"
      session_system      TEXT,
      fuel_main           REAL,
      fuel_capacity       REAL,
      fuel_at             TEXT,
      previous_fuel_main  REAL,       -- the reading before, to work out the burn rate
      previous_fuel_at    TEXT,
      has_fighter_bay     INTEGER,
      fighter_state       TEXT,       -- none | deployed | docked | destroyed | ready (rebuilt in the hangar)
      fighter_changed_at  TEXT,
      shields_up          INTEGER,    -- from ShieldState; NULL when unknown (since login)
      shields_changed_at  TEXT,
      hull_health         REAL,       -- 0-1; NULL when unknown
      hull_changed_at     TEXT,
      fighter_hull        REAL,       -- 0-1, the NPC fighter that's out; NULL when none or unknown
      fighter_hull_changed_at TEXT
    );

    -- Kills and pirate scans in each commander's latest session (cleared when a new one starts).
    CREATE TABLE IF NOT EXISTS combat_events (
      id            INTEGER PRIMARY KEY,
      commander_id  INTEGER NOT NULL REFERENCES commanders(id),
      timestamp     TEXT NOT NULL,
      type          TEXT NOT NULL,    -- kill | scan
      faction       TEXT              -- the victim's faction, for kills
    );
    CREATE INDEX IF NOT EXISTS idx_combat_events_commander ON combat_events(commander_id, type, timestamp);
  `,

  createProcessor(database) {
    const ensureStatus = database.prepare('INSERT OR IGNORE INTO combat_status (commander_id) VALUES (?)');
    const selectSession = database.prepare('SELECT session_started_at, session_ended_at FROM combat_status WHERE commander_id = ?');
    const startSession = database.prepare(`
      UPDATE combat_status SET session_started_at = ?, session_ended_at = NULL, session_location = ?, session_system = current_system
      WHERE commander_id = ?
    `);
    const endSession = database.prepare(`
      UPDATE combat_status SET session_ended_at = ? WHERE commander_id = ? AND session_started_at IS NOT NULL AND session_ended_at IS NULL
    `);
    const clearEvents = database.prepare('DELETE FROM combat_events WHERE commander_id = ?');
    const insertEvent = database.prepare('INSERT INTO combat_events (commander_id, timestamp, type, faction) VALUES (?, ?, ?, ?)');
    const updateShip = database.prepare(`
      UPDATE combat_status SET fuel_capacity = COALESCE(?, fuel_capacity), has_fighter_bay = COALESCE(?, has_fighter_bay)
      WHERE commander_id = ?
    `);
    // A ReservoirReplenished reading. The last reading becomes the previous one (for the burn
    // rate) only if it's from the session under way, as in ED AFK Monitor; a higher reading
    // (refuelled) doesn't count either.
    const isLastReadingInSession = `fuel_main IS NOT NULL AND :fuel <= fuel_main AND :at > fuel_at
      AND session_started_at IS NOT NULL AND session_ended_at IS NULL AND fuel_at >= session_started_at`;
    const addFuelReading = database.prepare(`
      UPDATE combat_status SET
        previous_fuel_main = CASE WHEN ${isLastReadingInSession} THEN fuel_main END,
        previous_fuel_at = CASE WHEN ${isLastReadingInSession} THEN fuel_at END,
        fuel_main = :fuel, fuel_at = :at
      WHERE commander_id = :commanderId
    `);
    // A fuel level from outside combat (at login): kept for display, but it starts no burn rate.
    const setFuelLevel = database.prepare(`
      UPDATE combat_status SET fuel_main = ?, fuel_at = ?, previous_fuel_main = NULL, previous_fuel_at = NULL WHERE commander_id = ?
    `);
    const updateSystem = database.prepare('UPDATE combat_status SET current_system = ? WHERE commander_id = ?');
    const clearFuelHistory = database.prepare('UPDATE combat_status SET previous_fuel_main = NULL, previous_fuel_at = NULL WHERE commander_id = ?');
    const updateFighter = database.prepare('UPDATE combat_status SET fighter_state = ?, fighter_changed_at = ? WHERE commander_id = ?');
    const updateShields = database.prepare('UPDATE combat_status SET shields_up = ?, shields_changed_at = ? WHERE commander_id = ?');
    const updateHull = database.prepare('UPDATE combat_status SET hull_health = ?, hull_changed_at = ? WHERE commander_id = ?');
    const updateFighterHull = database.prepare('UPDATE combat_status SET fighter_hull = ?, fighter_hull_changed_at = ? WHERE commander_id = ?');

    return ({ commanderId, event, timestamp, data }, moduleState) => {
      ensureStatus.run(commanderId);

      const isInSession = () => {
        const session = selectSession.get(commanderId);
        return Boolean(session?.session_started_at && !session.session_ended_at);
      };
      const beginSession = (startedAt, location) => {
        startSession.run(startedAt, location, commanderId);
        clearEvents.run(commanderId);
        clearFuelHistory.run(commanderId);
        updateShields.run(null, startedAt, commanderId);
        moduleState.set(RECENT_SCANNERS_STATE_KEY, []);
      };
      const ensureSession = (backdateSeconds) => {
        if (!isInSession()) beginSession(new Date(Date.parse(timestamp) - backdateSeconds * 1000).toISOString().replace(/\.\d+Z$/, 'Z'), null);
      };
      const setFighter = (state) => {
        updateFighter.run(state, timestamp, commanderId);
        if (state !== 'deployed') updateFighterHull.run(null, timestamp, commanderId);
      };

      switch (event) {
        case 'LoadGame':
          endSession.run(timestamp, commanderId);
          updateShip.run(data.FuelCapacity ?? null, null, commanderId);
          if (Number.isFinite(data.FuelLevel)) setFuelLevel.run(data.FuelLevel, timestamp, commanderId);
          updateShields.run(null, timestamp, commanderId);
          return;

        case 'Loadout': {
          const modules = Array.isArray(data.Modules) ? data.Modules : [];
          const hasFighterBay = modules.some((module) => /fighterbay/i.test(module.Item ?? ''));
          updateShip.run(data.FuelCapacity?.Main ?? null, hasFighterBay ? 1 : 0, commanderId);
          if (Number.isFinite(data.HullHealth)) updateHull.run(data.HullHealth, timestamp, commanderId);
          return;
        }

        case 'SupercruiseDestinationDrop':
          if (COMBAT_DROP_PATTERN.test(data.Type ?? '')) beginSession(timestamp, data.Type_Localised ?? null);
          return;

        case 'Location':
          updateSystem.run(data.StarSystem ?? null, commanderId);
          if (data.BodyType === 'PlanetaryRing' && !isInSession()) beginSession(timestamp, data.Body ?? 'Planetary ring');
          return;

        case 'SupercruiseEntry':
        case 'FSDJump':
        case 'CarrierJump':
        case 'Docked':
        case 'Died':
          if (data.StarSystem) updateSystem.run(data.StarSystem, commanderId);
          endSession.run(timestamp, commanderId);
          // The fighter is recalled (or lost) when the ship leaves; Docked/Died leave none out either.
          setFighter('none');
          if (event === 'Died') {
            updateShields.run(null, timestamp, commanderId);
            updateHull.run(null, timestamp, commanderId);
          }
          return;

        case 'Shutdown':
          endSession.run(timestamp, commanderId);
          return;

        case 'Music':
          if (data.MusicTrack === 'MainMenu') endSession.run(timestamp, commanderId);
          return;

        case 'Bounty':
        case 'FactionKillBond':
          ensureSession(KILL_SESSION_BACKDATE_S);
          insertEvent.run(commanderId, timestamp, 'kill', data.VictimFaction_Localised ?? data.VictimFaction ?? null);
          return;

        case 'ReceiveText': {
          if (data.Channel !== 'npc' || !String(data.Message ?? '').includes('$Pirate_OnStartScanCargo')) return;
          const pirateName = data.From_Localised ?? data.From ?? '';
          const recentScanners = moduleState.get(RECENT_SCANNERS_STATE_KEY) ?? [];
          if (pirateName && recentScanners.includes(pirateName)) return;
          ensureSession(SCAN_SESSION_BACKDATE_S);
          insertEvent.run(commanderId, timestamp, 'scan', null);
          moduleState.set(RECENT_SCANNERS_STATE_KEY, [...(moduleState.get(RECENT_SCANNERS_STATE_KEY) ?? []), pirateName].slice(-RECENT_SCANNER_COUNT));
          return;
        }

        case 'ReservoirReplenished':
          if (Number.isFinite(data.FuelMain)) addFuelReading.run({ fuel: data.FuelMain, at: timestamp, commanderId });
          return;

        case 'RefuelAll':
        case 'RefuelPartial':
          // The new level isn't given; drop the burn-rate history so it isn't measured across a refuel.
          clearFuelHistory.run(commanderId);
          return;

        case 'LaunchFighter':
          if (data.PlayerControlled) return;
          setFighter('deployed');
          updateFighterHull.run(1, timestamp, commanderId);
          return;
        case 'DockFighter':
          setFighter('docked');
          return;
        case 'FighterDestroyed': {
          const jumpStartedAt = moduleState.get(JUMP_STARTED_STATE_KEY);
          const isJumpLoss = jumpStartedAt && Date.parse(timestamp) - Date.parse(jumpStartedAt) <= JUMP_FIGHTER_LOSS_WINDOW_S * 1000;
          setFighter(isJumpLoss ? 'none' : 'destroyed');
          return;
        }

        case 'StartJump':
          moduleState.set(JUMP_STARTED_STATE_KEY, timestamp);
          return;

        case 'HullDamage':
          if (!Number.isFinite(data.Health)) return;
          if (data.PlayerPilot && !data.Fighter) updateHull.run(data.Health, timestamp, commanderId);
          else if (data.Fighter && !data.PlayerPilot) updateFighterHull.run(data.Health, timestamp, commanderId);
          return;

        case 'RepairAll':
          updateHull.run(1, timestamp, commanderId);
          return;

        case 'Repair': {
          const items = Array.isArray(data.Items) ? data.Items : [data.Item];
          if (items.some((item) => /^(hull|all)$/i.test(String(item ?? '')))) updateHull.run(1, timestamp, commanderId);
          return;
        }

        case 'RepairDrone':
          if (data.HullRepaired > 0) updateHull.run(null, timestamp, commanderId);
          return;
        case 'FighterRebuilt':
          setFighter('ready');
          return;

        case 'ShieldState':
          updateShields.run(data.ShieldsUp ? 1 : 0, timestamp, commanderId);
          return;

        case 'Resurrect':
          updateShields.run(null, timestamp, commanderId);
          return;
      }
    };
  },

  createRouter(database) {
    const router = Router();
    const selectStatus = database.prepare(`
      SELECT combat_status.*, commanders.name AS commander_name,
        EXISTS (SELECT 1 FROM journal_files WHERE journal_files.commander_id = combat_status.commander_id AND journal_files.is_active = 1) AS is_journal_active
      FROM combat_status JOIN commanders ON commanders.id = combat_status.commander_id
      WHERE session_started_at IS NOT NULL AND (? IS NULL OR combat_status.commander_id = ?)
    `);
    const selectKillsByFaction = database.prepare(`
      SELECT faction, COUNT(*) AS count, MAX(timestamp) AS lastAt FROM combat_events
      WHERE commander_id = ? AND type = 'kill' GROUP BY faction
    `);
    const selectScans = database.prepare(`
      SELECT COUNT(*) AS count, MAX(timestamp) AS lastAt FROM combat_events WHERE commander_id = ? AND type = 'scan'
    `);

    // GET /api/stats/combat/status?commander=
    // Each commander's current or latest combat session, with kills per victim faction. A session
    // only counts as under way while the commander's journal is active (the game is running).
    router.get('/status', (request, response) => {
      const commanderId = getCommanderIdFilter(request.query);
      const commanders = selectStatus.all(commanderId, commanderId).map((row) => {
        const kills = selectKillsByFaction.all(row.commander_id);
        const scans = selectScans.get(row.commander_id);
        const fuelHours = row.previous_fuel_at ? (Date.parse(row.fuel_at) - Date.parse(row.previous_fuel_at)) / 3_600_000 : 0;
        const fuelPerHour = fuelHours > 0 && row.previous_fuel_main > row.fuel_main ? (row.previous_fuel_main - row.fuel_main) / fuelHours : null;
        return {
          commanderId: row.commander_id,
          commanderName: row.commander_name,
          isJournalActive: Boolean(row.is_journal_active),
          currentSystem: row.current_system,
          session: {
            startedAt: row.session_started_at,
            endedAt: row.session_ended_at,
            isActive: !row.session_ended_at && Boolean(row.is_journal_active),
            location: row.session_location,
            system: row.session_system,
          },
          kills: {
            total: kills.reduce((total, faction) => total + faction.count, 0),
            lastAt: kills.map((faction) => faction.lastAt).sort().at(-1) ?? null,
            byFaction: kills,
          },
          scans: { total: scans.count, lastAt: scans.lastAt },
          fuel: row.fuel_main === null ? null : {
            main: row.fuel_main,
            capacity: row.fuel_capacity,
            at: row.fuel_at,
            perHour: fuelPerHour,
          },
          fighter: {
            hasBay: row.has_fighter_bay === null ? null : Boolean(row.has_fighter_bay),
            state: row.fighter_state ?? 'none',
            changedAt: row.fighter_changed_at,
          },
          shields: {
            isUp: row.shields_up === null ? null : Boolean(row.shields_up),
            changedAt: row.shields_changed_at,
          },
          hull: { health: row.hull_health, changedAt: row.hull_changed_at },
          fighterHull: { health: row.fighter_hull, changedAt: row.fighter_hull_changed_at },
        };
      });
      response.json({ commanders });
    });

    return router;
  },
});
