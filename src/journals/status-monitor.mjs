import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger.mjs';
import { getCreditSummaries } from '../stats/modules/credits.mjs';
import { normalizeJournalDirectories } from './journal-ingester.mjs';

/**
 * Reads the game's Status.json (read-only), which it rewrites about once a second while playing
 * with the ship's live state: hardpoints, shields, fuel and more. The journal doesn't log most of
 * this.
 *
 * Each journal folder has its own Status.json, read separately. Every game client using a folder
 * writes the same Status.json, and the file doesn't say which commander it's for, so each write is
 * matched to a commander playing from that folder (one whose active journal is in it):
 *
 * - With one active journal there, every write is that commander's.
 * - With more, each write is compared with what's known of each playing commander: the credit
 *   balance (exact), the fuel (it only falls slowly between writes, and matches the journal's
 *   ReservoirReplenished readings), the cargo tonnage, and whose journal was written in the same
 *   couple of seconds. A write goes to a commander only when it clearly fits them better than
 *   anyone else; ambiguous writes are ignored.
 *
 * Each commander's flags (hardpoints, shields and so on) only change once a new value has held
 * for FLAG_SETTLE_MS, so a stray write can't flash a false alarm.
 *
 * Changes are published on the "shipStatus" topic: when a commander's settled flags change, and at
 * most every FUEL_PUBLISH_INTERVAL_MS for fuel alone.
 */
const STATUS_FILE_NAME = 'Status.json';
const POLL_INTERVAL_MS = 1000;
const FUEL_PUBLISH_INTERVAL_MS = 30 * 1000;
const FLAG_SETTLE_MS = 3000;

// Matching a write to a commander: points per field that fits (or doesn't), how many a commander
// needs, and how far ahead of the next one they must be.
const SCORE = {
  balanceMatch: 3,
  balanceMismatch: -2,
  fuelMatch: 1,
  fuelMismatch: -2,
  cargoMatch: 1,
  cargoMismatch: -1,
  journalWritten: 2,
};
const MIN_SCORE = 1;
const MIN_SCORE_LEAD = 2;
// A journal write within this long of the Status.json write counts as "written together".
const JOURNAL_WRITE_WINDOW_MS = 2000;
// Fuel can't rise between writes (refuelling aside) and burns at most this fast (tonnes/hour),
// with a little slack for rounding.
const MAX_FUEL_BURN_PER_HOUR = 30;
const FUEL_SLACK = 0.05;

// Status.json "Flags" bits (see the game's journal manual).
const FLAG_BITS = {
  docked: 1 << 0,
  landed: 1 << 1,
  shieldsUp: 1 << 3,
  supercruise: 1 << 4,
  hardpointsDeployed: 1 << 6,
  lowFuel: 1 << 19,
  overheating: 1 << 20,
  isInDanger: 1 << 22,
  beingInterdicted: 1 << 23,
  inMainShip: 1 << 24,
  inFighter: 1 << 25,
  inSrv: 1 << 26,
};

export class StatusMonitor {
  /**
   * @param {{ database: import('node:sqlite').DatabaseSync, journalDirectories?: string[], journalDirectory?: string, eventHub: import('../events/event-hub.mjs').EventHub }} options
   */
  constructor({ database, journalDirectories, journalDirectory, eventHub }) {
    this.database = database;
    /** Each journal folder's Status.json, and when it was last read. */
    this.statusFiles = [];
    this.addJournalDirectories(journalDirectories ?? [journalDirectory]);
    this.eventHub = eventHub;
    this.timer = null;
    this.lastFuelPublishMs = 0;
    /**
     * Per commander id: the latest write matched to them and what it tells us about them.
     * @type {Map<number, { status: object, raw: object, matchedBy: string, receivedMs: number, hasSettled: boolean, settledFlags: object|null, pendingFlags: object|null, pendingSince: number }>}
     */
    this.commanders = new Map();
    this.selectPlayingCommanders = database.prepare(`
      SELECT commanders.id, commanders.name, journal_files.directory, journal_files.file_name FROM journal_files
      JOIN commanders ON commanders.id = journal_files.commander_id
      WHERE journal_files.is_active = 1 ORDER BY journal_files.modified_ms DESC
    `);
  }

  /** Also reads the Status.json in these journal folders. */
  addJournalDirectories(directories) {
    const known = this.statusFiles.map((statusFile) => statusFile.directory);
    for (const directory of normalizeJournalDirectories([...known, ...directories]).slice(known.length)) {
      this.statusFiles.push({ directory, statusPath: path.join(directory, STATUS_FILE_NAME), lastModifiedMs: 0 });
    }
  }

  start() {
    this.timer = setInterval(() => this.poll().catch((error) => logger.debug(`Status.json read failed: ${error.message}`)), POLL_INTERVAL_MS);
    this.poll().catch(() => {});
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async poll() {
    this.settleFlags();
    for (const statusFile of this.statusFiles) await this.pollStatusFile(statusFile);
  }

  /** Reads one journal folder's Status.json if it has been written since the last read. */
  async pollStatusFile(statusFile) {
    const fileStats = await stat(statusFile.statusPath).catch(() => null);
    if (!fileStats || fileStats.mtimeMs === statusFile.lastModifiedMs) return;
    let raw;
    try {
      // The game rewrites the file in place, so a read can catch it half-written; the next poll retries.
      raw = JSON.parse(await readFile(statusFile.statusPath, 'utf8'));
    } catch {
      return;
    }
    statusFile.lastModifiedMs = fileStats.mtimeMs;

    const match = await this.matchCommander(raw, fileStats.mtimeMs, statusFile.directory);
    if (!match) return;
    const status = decodeStatus(raw);
    const entry = this.commanders.get(match.commanderId) ?? { hasSettled: false, settledFlags: null, pendingFlags: null, pendingSince: 0 };
    Object.assign(entry, { status, raw, matchedBy: match.matchedBy, receivedMs: Date.now() });
    this.commanders.set(match.commanderId, entry);

    // A change of flags waits to settle; a write that agrees with the settled flags cancels it.
    const newFlagsKey = flagsKey(status.flags);
    if (entry.hasSettled && newFlagsKey === flagsKey(entry.settledFlags)) {
      entry.pendingSince = 0;
    } else if (!entry.pendingSince || newFlagsKey !== flagsKey(entry.pendingFlags)) {
      entry.pendingFlags = status.flags;
      entry.pendingSince = Date.now();
    }

    if (Date.now() - this.lastFuelPublishMs >= FUEL_PUBLISH_INTERVAL_MS) this.publish();
  }

  /** Makes pending flag changes that have held for FLAG_SETTLE_MS the settled ones. */
  settleFlags() {
    let hasChanged = false;
    for (const entry of this.commanders.values()) {
      if (!entry.pendingSince || Date.now() - entry.pendingSince < FLAG_SETTLE_MS) continue;
      if (!entry.hasSettled || flagsKey(entry.pendingFlags) !== flagsKey(entry.settledFlags)) hasChanged = true;
      entry.settledFlags = entry.pendingFlags;
      entry.hasSettled = true;
      entry.pendingSince = 0;
    }
    if (hasChanged) this.publish();
  }

  publish() {
    this.lastFuelPublishMs = Date.now();
    this.eventHub.publish('shipStatus', {});
  }

  /**
   * Which commander playing from a journal folder a Status.json write in that folder belongs to,
   * or null when it can't be told.
   * @returns {Promise<{ commanderId: number, matchedBy: 'onlyClient' | 'fingerprint' } | null>}
   */
  async matchCommander(raw, statusModifiedMs, directory) {
    const playing = this.getPlayingCommanders().filter((commander) => commander.directory === directory);
    if (playing.length === 0) return null;
    if (playing.length === 1) return { commanderId: playing[0].id, matchedBy: 'onlyClient' };

    const journalState = this.getJournalState();
    const scored = await Promise.all(playing.map(async (commander) => {
      const known = this.getKnownState(commander.id, journalState.get(commander.id));
      let score = 0;
      if (Number.isFinite(raw.Balance) && known.balance !== null) {
        score += raw.Balance === known.balance ? SCORE.balanceMatch : SCORE.balanceMismatch;
      }
      const fuelMain = raw.Fuel?.FuelMain;
      if (Number.isFinite(fuelMain) && known.fuel) {
        score += isFuelPlausible(fuelMain, known.fuel, statusModifiedMs) ? SCORE.fuelMatch : SCORE.fuelMismatch;
      }
      if (Number.isFinite(raw.Cargo) && known.cargo !== null) {
        score += Math.abs(raw.Cargo - known.cargo) < 0.5 ? SCORE.cargoMatch : SCORE.cargoMismatch;
      }
      const journalStats = await stat(path.join(commander.directory, commander.file_name)).catch(() => null);
      if (journalStats && Math.abs(journalStats.mtimeMs - statusModifiedMs) <= JOURNAL_WRITE_WINDOW_MS) score += SCORE.journalWritten;
      return { commanderId: commander.id, score };
    }));

    scored.sort((first, second) => second.score - first.score);
    const [best, runnerUp] = scored;
    if (best.score < MIN_SCORE || best.score - runnerUp.score < MIN_SCORE_LEAD) return null;
    return { commanderId: best.commanderId, matchedBy: 'fingerprint' };
  }

  /** Commanders with an active journal (one row each, with their newest active journal file). */
  getPlayingCommanders() {
    const seen = new Set();
    return this.selectPlayingCommanders.all().filter((row) => !seen.has(row.id) && seen.add(row.id));
  }

  /** What the journal says about each commander: balance at login and the last fuel reading. */
  getJournalState() {
    const state = new Map();
    const entry = (commanderId) => {
      if (!state.has(commanderId)) state.set(commanderId, { balance: null, balance_at: null, fuel_main: null, fuel_at: null });
      return state.get(commanderId);
    };
    try {
      // The latest balance, from a login or carrier transfer (credits module).
      for (const [commanderId, summary] of getCreditSummaries(this.database)) {
        Object.assign(entry(commanderId), { balance: summary.credits, balance_at: summary.balanceAt });
      }
      // The latest fuel reading (combat module).
      this.selectFuel ??= this.database.prepare('SELECT commander_id, fuel_main, fuel_at FROM combat_status');
      for (const row of this.selectFuel.all()) Object.assign(entry(row.commander_id), { fuel_main: row.fuel_main, fuel_at: row.fuel_at });
    } catch {
      // A module's table isn't there (module disabled); go on with what there is.
    }
    return state;
  }

  /**
   * The newest known balance, fuel and cargo for a commander: from their last matched write, or
   * from the journal when that's newer (a login or fuel reading since).
   */
  getKnownState(commanderId, journalRow) {
    const entry = this.commanders.get(commanderId);
    const statusMs = entry ? Date.parse(entry.status.updatedAt) || entry.receivedMs : 0;
    const isNewer = (timestamp) => timestamp && Date.parse(timestamp) > statusMs;

    let balance = Number.isFinite(entry?.raw.Balance) ? entry.raw.Balance : null;
    if (journalRow?.balance !== null && journalRow?.balance !== undefined && (balance === null || isNewer(journalRow.balance_at))) balance = journalRow.balance;

    let fuel = Number.isFinite(entry?.raw.Fuel?.FuelMain) ? { main: entry.raw.Fuel.FuelMain, atMs: statusMs } : null;
    if (Number.isFinite(journalRow?.fuel_main) && (!fuel || isNewer(journalRow.fuel_at))) fuel = { main: journalRow.fuel_main, atMs: Date.parse(journalRow.fuel_at) };

    const cargo = Number.isFinite(entry?.raw.Cargo) ? entry.raw.Cargo : null;
    return { balance, fuel, cargo };
  }

  /**
   * The live status of each playing commander whose Status.json writes have been recognised. The
   * flags are the settled ones (null until a value has held for a few seconds).
   */
  getStatus() {
    const playing = this.getPlayingCommanders();
    const playingIds = new Set(playing.map((commander) => commander.id));
    for (const commanderId of this.commanders.keys()) {
      if (!playingIds.has(commanderId)) this.commanders.delete(commanderId);
    }
    return {
      commanders: playing.filter((commander) => this.commanders.has(commander.id)).map((commander) => {
        const entry = this.commanders.get(commander.id);
        return {
          commanderId: commander.id,
          commanderName: commander.name,
          matchedBy: entry.matchedBy,
          updatedAt: entry.status.updatedAt,
          flags: entry.settledFlags,
          fuel: entry.status.fuel,
        };
      }),
    };
  }
}

/** Whether a Status.json fuel level could follow a known earlier one. */
function isFuelPlausible(fuelMain, knownFuel, statusModifiedMs) {
  const hours = Math.max(0, (statusModifiedMs - knownFuel.atMs) / 3_600_000);
  return fuelMain <= knownFuel.main + FUEL_SLACK && fuelMain >= knownFuel.main - FUEL_SLACK - hours * MAX_FUEL_BURN_PER_HOUR;
}

function flagsKey(flags) {
  return flags ? JSON.stringify(flags) : 'none';
}

function decodeStatus(status) {
  const flagBits = Number(status.Flags) || 0;
  // With no flags the commander is at the main menu or on foot; the ship's flags don't apply then.
  const flags = flagBits === 0 ? null : Object.fromEntries(Object.entries(FLAG_BITS).map(([name, bit]) => [name, (flagBits & bit) !== 0]));
  return {
    updatedAt: status.timestamp ?? null,
    flags,
    fuel: status.Fuel && Number.isFinite(status.Fuel.FuelMain)
      ? { main: status.Fuel.FuelMain, reservoir: status.Fuel.FuelReservoir ?? null }
      : null,
  };
}
