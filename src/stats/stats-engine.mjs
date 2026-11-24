import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { runInTransaction } from '../database/database.mjs';
import { getEntryCodec } from '../database/entry-compression.mjs';
import { logger } from '../logger.mjs';

/** Journal entries are processed in id ranges of this size so the server stays responsive. */
const ENTRY_ID_CHUNK_SIZE = 25000;

/** How often, at most, build progress is sent to the dashboard. */
const BUILD_PROGRESS_INTERVAL_MS = 1000;

/** Progress while no large build is running. */
const IDLE_BUILD_PROGRESS = Object.freeze({ isBuilding: false, totalModules: 0, completedModules: 0, currentModule: null, percent: 100 });

/**
 * Bump to rebuild every module, for changes to which entries modules are given. It's added to each
 * module's own version in the stored record.
 * 1: journals from the Legacy (3.x) game client are left out.
 * 2: every module tracks where the commander is docked with the shared docking state.
 */
const DATA_REVISION = 2;
const DATA_REVISION_FACTOR = 100000;

/**
 * Journals written by the Legacy game client (flagged by the ingester from their game version)
 * would mix another save's credits, ships and ranks into the live game's, so stat modules don't
 * see them.
 */
const SELECT_LEGACY_FILE_IDS_SQL = 'SELECT id FROM journal_files WHERE is_legacy = 1';

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
   * @param {number} [options.entryChunkSize]  entries per chunk; a module with more than one chunk
   *   to catch up on is a large update, shown as build progress
   */
  constructor({ database, statModules, eventHub, entryChunkSize = ENTRY_ID_CHUNK_SIZE }) {
    this.database = database;
    this.statModules = statModules;
    this.eventHub = eventHub;
    this.entryChunkSize = entryChunkSize;
    this.processors = new Map();
    this.runningUpdate = null;
    this.hasQueuedUpdate = false;
    /**
     * While stats are built or rebuilt from many entries (startup after a scan, a new or changed
     * module, a rebuild), which module is being built and how far along it all is; sent to the
     * dashboard as "statsBuild" updates. Small updates (new entries while playing) don't count.
     */
    this.buildProgress = IDLE_BUILD_PROGRESS;

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
        if (changedModuleNames.length > 0) this.eventHub.publish('stats', { modules: this.withDependentModules(changedModuleNames) });
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
    const lastEntryIds = new Map(this.statModules.map((statModule) => [statModule.name, this.statements.selectModuleRecord.get(statModule.name).last_entry_id]));
    const isLargeUpdate = (statModule) => maxEntryId - lastEntryIds.get(statModule.name) > this.entryChunkSize;
    const largeUpdateCount = this.statModules.filter(isLargeUpdate).length;
    if (largeUpdateCount > 0) this.startBuildProgress(largeUpdateCount);

    try {
      for (const statModule of this.statModules) {
        const lastEntryId = lastEntryIds.get(statModule.name);
        if (lastEntryId >= maxEntryId) continue;

        const isLarge = isLargeUpdate(statModule);
        const startTime = Date.now();
        if (isLarge) {
          logger.info(`Building "${statModule.name}" stats...`);
          this.updateBuildProgress({ currentModule: { name: statModule.name, title: statModule.title }, moduleFraction: 0 }, { isForced: true });
        }

        const onChunk = isLarge ? (moduleFraction) => this.updateBuildProgress({ moduleFraction }) : undefined;
        const processedEntryCount = await this.processModuleEntries(statModule, lastEntryId, maxEntryId, onChunk);
        if (processedEntryCount > 0) changedModuleNames.push(statModule.name);

        const logMessage = `Stat module "${statModule.name}" processed ${processedEntryCount.toLocaleString()} entries in ${Date.now() - startTime}ms`;
        if (isLarge) {
          logger.info(logMessage);
          this.updateBuildProgress({ completedModules: this.buildProgress.completedModules + 1, moduleFraction: 0 });
        } else {
          logger.debug(logMessage);
        }
      }
    } finally {
      if (largeUpdateCount > 0) this.finishBuildProgress();
    }

    return changedModuleNames;
  }

  startBuildProgress(totalModules) {
    this.buildModuleFraction = 0;
    this.lastBuildProgressTime = 0;
    this.buildProgress = { isBuilding: true, totalModules, completedModules: 0, currentModule: null, percent: 0 };
    this.publishBuildProgress();
  }

  /** Updates the build progress, sending it at most every BUILD_PROGRESS_INTERVAL_MS unless forced. */
  updateBuildProgress({ moduleFraction, ...changes }, { isForced = false } = {}) {
    if (moduleFraction !== undefined) this.buildModuleFraction = moduleFraction;
    const progress = { ...this.buildProgress, ...changes };
    progress.percent = Math.min(99, Math.floor((100 * (progress.completedModules + this.buildModuleFraction)) / progress.totalModules));
    this.buildProgress = progress;
    if (isForced || Date.now() - this.lastBuildProgressTime >= BUILD_PROGRESS_INTERVAL_MS) this.publishBuildProgress();
  }

  finishBuildProgress() {
    this.buildProgress = IDLE_BUILD_PROGRESS;
    this.publishBuildProgress();
  }

  publishBuildProgress() {
    this.lastBuildProgressTime = Date.now();
    this.eventHub.publish('statsBuild', this.buildProgress);
  }

  /**
   * @param {(moduleFraction: number) => void} [onChunk]  called after each chunk with how much of
   *   this module's entries are done (0 to 1)
   */
  async processModuleEntries(statModule, lastEntryId, maxEntryId, onChunk) {
    const processEntry = this.processors.get(statModule.name);
    const eventPlaceholders = statModule.events.map(() => '?').join(', ');
    const selectEntries = this.database.prepare(`
      SELECT id, journal_file_id AS journalFileId, commander_id AS commanderId, timestamp, event, data
      FROM journal_entries
      WHERE id > ? AND id <= ? AND event IN (${eventPlaceholders})
      ORDER BY id
    `);

    const legacyFileIds = new Set(this.database.prepare(SELECT_LEGACY_FILE_IDS_SQL).all().map((row) => row.id));
    const entryCodec = getEntryCodec(this.database);

    let processedEntryCount = 0;
    for (let chunkStartId = lastEntryId; chunkStartId < maxEntryId; chunkStartId += this.entryChunkSize) {
      const chunkEndId = Math.min(chunkStartId + this.entryChunkSize, maxEntryId);
      const journalEntries = selectEntries.all(chunkStartId, chunkEndId, ...statModule.events)
        .filter((journalEntry) => !legacyFileIds.has(journalEntry.journalFileId));

      runInTransaction(this.database, () => {
        for (const journalEntry of journalEntries) {
          const entryData = JSON.parse(entryCodec.decode(journalEntry.data));
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
      onChunk?.((chunkEndId - lastEntryId) / (maxEntryId - lastEntryId));
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

  /**
   * The changed modules plus every module that reads from them (directly or through another, by
   * dependsOn), so the dashboard refreshes everything whose data could have changed.
   */
  withDependentModules(changedModuleNames) {
    const affected = new Set(changedModuleNames);
    let hasGrown = true;
    while (hasGrown) {
      hasGrown = false;
      for (const statModule of this.statModules) {
        if (!affected.has(statModule.name) && statModule.dependsOn.some((dependencyName) => affected.has(dependencyName))) {
          affected.add(statModule.name);
          hasGrown = true;
        }
      }
    }
    return [...affected];
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
