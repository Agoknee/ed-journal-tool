import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { runInTransaction } from '../database/database.mjs';
import { logger } from '../logger.mjs';

/** Journal entries are processed in id ranges of this size so the server stays responsive. */
const ENTRY_ID_CHUNK_SIZE = 25000;

/**
 * Bump to rebuild every module, for changes to which entries modules are given. It's added to each
 * module's own version in the stored record.
 * 1: journals from the Legacy (3.x) game client are left out.
 */
const DATA_REVISION = 1;
const DATA_REVISION_FACTOR = 100000;

/**
 * Journals written by the Legacy game client (Horizons 3.8, its own galaxy and commander saves)
 * have a 3.x (or older) game version in their Fileheader. Their entries would mix another save's
 * credits, ships and ranks into the live game's, so stat modules don't see them.
 */
const SELECT_LEGACY_FILE_IDS_SQL = "SELECT id FROM journal_files WHERE game_version GLOB '[0-3].*'";

/**
 * Runs stat modules over stored journal entries.
 *
 * Each module keeps a cursor (the last journal entry id it processed), so only new entries are
 * read on each update. Adding a module, or bumping its version, makes it rebuild from scratch.
 * Removing a module from the registry drops the tables it owned. Entries from Legacy game client
 * journals are skipped.
 */
export class StatsEngine {
  /**
   * @param {object} options
   * @param {import('node:sqlite').DatabaseSync} options.database
   * @param {import('./define-stat-module.mjs').StatModule[]} options.statModules
   * @param {import('../events/event-hub.mjs').EventHub} options.eventHub
   */
  constructor({ database, statModules, eventHub }) {
    this.database = database;
    this.statModules = statModules;
    this.eventHub = eventHub;
    this.processors = new Map();
    this.runningUpdate = null;
    this.hasQueuedUpdate = false;

    this.statements = {
      selectModuleRecord: database.prepare('SELECT * FROM stat_modules WHERE name = ?'),
      selectAllModuleRecords: database.prepare('SELECT * FROM stat_modules'),
      upsertModuleRecord: database.prepare(`
        INSERT INTO stat_modules (name, version, last_entry_id, owned_objects, updated_at)
        VALUES (?, ?, 0, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT (name) DO UPDATE SET version = excluded.version, last_entry_id = 0,
          owned_objects = excluded.owned_objects, updated_at = excluded.updated_at
      `),
      updateModuleCursor: database.prepare(`
        UPDATE stat_modules SET last_entry_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = ?
      `),
      deleteModuleRecord: database.prepare('DELETE FROM stat_modules WHERE name = ?'),
      deleteModuleState: database.prepare('DELETE FROM stat_state WHERE module_name = ?'),
      selectMaxEntryId: database.prepare('SELECT COALESCE(MAX(id), 0) AS maxEntryId FROM journal_entries'),
      selectState: database.prepare('SELECT state_value FROM stat_state WHERE module_name = ? AND commander_id = ? AND state_key = ?'),
      upsertState: database.prepare(`
        INSERT INTO stat_state (module_name, commander_id, state_key, state_value) VALUES (?, ?, ?, ?)
        ON CONFLICT (module_name, commander_id, state_key) DO UPDATE SET state_value = excluded.state_value
      `),
    };
  }

  /** Creates module tables, rebuilds changed modules and drops removed ones. */
  initialize() {
    validateModuleDependencies(this.statModules);
    const registeredModuleNames = new Set(this.statModules.map((statModule) => statModule.name));

    for (const moduleRecord of this.statements.selectAllModuleRecords.all()) {
      if (!registeredModuleNames.has(moduleRecord.name)) {
        logger.info(`Stat module "${moduleRecord.name}" was removed; dropping its tables.`);
        this.dropOwnedObjects(JSON.parse(moduleRecord.owned_objects));
        this.statements.deleteModuleState.run(moduleRecord.name);
        this.statements.deleteModuleRecord.run(moduleRecord.name);
      }
    }

    for (const statModule of this.statModules) {
      const moduleRecord = this.statements.selectModuleRecord.get(statModule.name);
      if (!moduleRecord || moduleRecord.version !== getStoredVersion(statModule)) {
        const reason = moduleRecord ? `version changed ${moduleRecord.version} -> ${getStoredVersion(statModule)}` : 'new module';
        logger.debug(`Stat module "${statModule.name}" will be built from scratch (${reason}).`);
        this.dropOwnedObjects(statModule.ownedObjects);
        this.database.exec(statModule.schemaSql);
        this.resetModule(statModule);
      } else {
        this.database.exec(statModule.schemaSql);
      }

      this.processors.set(statModule.name, statModule.createProcessor(this.database));
    }
  }

  resetModule(statModule) {
    runInTransaction(this.database, () => {
      for (const ownedObject of statModule.ownedObjects) {
        if (ownedObject.type === 'table') this.database.exec(`DELETE FROM ${ownedObject.name}`);
      }
      this.statements.deleteModuleState.run(statModule.name);
      this.statements.upsertModuleRecord.run(statModule.name, getStoredVersion(statModule), JSON.stringify(statModule.ownedObjects));
    });
  }

  resetAllModules() {
    for (const statModule of this.statModules) this.resetModule(statModule);
  }

  /** Clears a module's (or every module's) data and processes all entries again. */
  async rebuild(moduleName) {
    const modulesToRebuild = moduleName
      ? this.statModules.filter((statModule) => statModule.name === moduleName)
      : this.statModules;
    if (modulesToRebuild.length === 0) throw new Error(`Unknown stat module "${moduleName}"`);

    await this.runningUpdate;
    for (const statModule of modulesToRebuild) this.resetModule(statModule);
    await this.processNewEntries();
  }

  /**
   * Feeds journal entries added since the last run to every module.
   * Overlapping calls are merged so only one update runs at a time.
   */
  async processNewEntries() {
    if (this.runningUpdate) {
      this.hasQueuedUpdate = true;
      return this.runningUpdate;
    }

    this.runningUpdate = (async () => {
      do {
        this.hasQueuedUpdate = false;
        const changedModuleNames = await this.processAllModules();
        if (changedModuleNames.length > 0) this.eventHub.publish('stats', { modules: changedModuleNames });
      } while (this.hasQueuedUpdate);
    })();

    try {
      await this.runningUpdate;
    } finally {
      this.runningUpdate = null;
    }
  }

  async processAllModules() {
    const { maxEntryId } = this.statements.selectMaxEntryId.get();
    const changedModuleNames = [];

    for (const statModule of this.statModules) {
      const { last_entry_id: lastEntryId } = this.statements.selectModuleRecord.get(statModule.name);
      if (lastEntryId >= maxEntryId) continue;

      const isLargeUpdate = maxEntryId - lastEntryId > ENTRY_ID_CHUNK_SIZE;
      const startTime = Date.now();
      if (isLargeUpdate) logger.info(`Building "${statModule.name}" stats...`);

      const processedEntryCount = await this.processModuleEntries(statModule, lastEntryId, maxEntryId);
      if (processedEntryCount > 0) changedModuleNames.push(statModule.name);

      const logMessage = `Stat module "${statModule.name}" processed ${processedEntryCount.toLocaleString()} entries in ${Date.now() - startTime}ms`;
      if (isLargeUpdate) logger.info(logMessage);
      else logger.debug(logMessage);
    }

    return changedModuleNames;
  }

  async processModuleEntries(statModule, lastEntryId, maxEntryId) {
    const processEntry = this.processors.get(statModule.name);
    const eventPlaceholders = statModule.events.map(() => '?').join(', ');
    const selectEntries = this.database.prepare(`
      SELECT id, journal_file_id AS journalFileId, commander_id AS commanderId, timestamp, event, data
      FROM journal_entries
      WHERE id > ? AND id <= ? AND event IN (${eventPlaceholders})
      ORDER BY id
    `);

    const legacyFileIds = new Set(this.database.prepare(SELECT_LEGACY_FILE_IDS_SQL).all().map((row) => row.id));

    let processedEntryCount = 0;
    for (let chunkStartId = lastEntryId; chunkStartId < maxEntryId; chunkStartId += ENTRY_ID_CHUNK_SIZE) {
      const chunkEndId = Math.min(chunkStartId + ENTRY_ID_CHUNK_SIZE, maxEntryId);
      const journalEntries = selectEntries.all(chunkStartId, chunkEndId, ...statModule.events)
        .filter((journalEntry) => !legacyFileIds.has(journalEntry.journalFileId));

      runInTransaction(this.database, () => {
        for (const journalEntry of journalEntries) {
          const entryData = JSON.parse(journalEntry.data);
          const moduleState = this.createModuleState(statModule.name, journalEntry.commanderId);
          try {
            processEntry({ ...journalEntry, data: entryData }, moduleState);
          } catch (error) {
            logger.warn(`Stat module "${statModule.name}" failed on entry ${journalEntry.id} (${journalEntry.event}):`, error.message);
          }
        }
        this.statements.updateModuleCursor.run(chunkEndId, statModule.name);
      });

      processedEntryCount += journalEntries.length;
      await yieldToEventLoop();
    }

    return processedEntryCount;
  }

  /** Per-commander key/value state for modules that need to remember things between entries. */
  createModuleState(moduleName, commanderId) {
    const { selectState, upsertState } = this.statements;
    return {
      get(stateKey) {
        const stateRow = selectState.get(moduleName, commanderId, stateKey);
        return stateRow ? JSON.parse(stateRow.state_value) : undefined;
      },
      set(stateKey, stateValue) {
        upsertState.run(moduleName, commanderId, stateKey, JSON.stringify(stateValue));
      },
    };
  }

  dropOwnedObjects(ownedObjects) {
    for (const ownedObject of [...ownedObjects].reverse()) {
      const objectType = ownedObject.type === 'view' ? 'VIEW' : 'TABLE';
      this.database.exec(`DROP ${objectType} IF EXISTS ${ownedObject.name}`);
    }
  }

  getModuleSummaries() {
    const moduleRecordsByName = new Map(this.statements.selectAllModuleRecords.all().map((record) => [record.name, record]));
    return this.statModules.map((statModule) => ({
      name: statModule.name,
      title: statModule.title,
      description: statModule.description,
      version: statModule.version,
      events: statModule.events,
      dependsOn: statModule.dependsOn,
      lastEntryId: moduleRecordsByName.get(statModule.name)?.last_entry_id ?? 0,
      updatedAt: moduleRecordsByName.get(statModule.name)?.updated_at ?? null,
    }));
  }
}

function validateModuleDependencies(statModules) {
  const moduleNames = new Set(statModules.map((statModule) => statModule.name));
  for (const statModule of statModules) {
    for (const dependencyName of statModule.dependsOn) {
      if (!moduleNames.has(dependencyName)) {
        throw new Error(`Stat module "${statModule.name}" depends on missing module "${dependencyName}"`);
      }
    }
  }
}

/** The version stored for a module: its own version plus the engine's data revision. */
function getStoredVersion(statModule) {
  return DATA_REVISION * DATA_REVISION_FACTOR + statModule.version;
}
