import path from 'node:path';
import chokidar from 'chokidar';
import { logger } from '../logger.mjs';
import { fileKey } from './journal-ingester.mjs';
import { compareJournalFileNames, isJournalFileName } from './journal-files.mjs';

const FILE_CHANGE_DEBOUNCE_MS = 250;
const UNPARSEABLE_LINE_RETRY_MS = 1000;
const MAX_UNPARSEABLE_LINE_RETRIES = 5;
/** Windows may delay change notifications for files held open by the game, so active files are also polled. */
const ACTIVE_FILE_POLL_MS = 2000;
const ACTIVE_STATUS_REFRESH_MS = 30 * 1000;
const PROGRESS_LOG_INTERVAL_MS = 5000;

/**
 * Coordinates scanning and watching the journal folders, feeding changes to the ingester
 * and triggering stats updates. Files are tracked by folder and name.
 */
export class JournalMonitor {
  /**
   * @param {object} options
   * @param {import('./journal-ingester.mjs').JournalIngester} options.ingester
   * @param {import('../stats/stats-engine.mjs').StatsEngine} options.statsEngine
   * @param {import('../events/event-hub.mjs').EventHub} options.eventHub
   */
  constructor({ ingester, statsEngine, eventHub }) {
    this.ingester = ingester;
    this.statsEngine = statsEngine;
    this.eventHub = eventHub;

    /** Files waiting to be read, by fileKey(). */
    this.queuedFiles = new Map();
    this.debounceTimers = new Map();
    this.retryCounts = new Map();
    this.isProcessingQueue = false;
    this.needsStatsRebuild = false;
    this.activeFileIdsSignature = '';
    this.timers = [];
    this.watcher = null;

    this.scanProgress = { isScanning: false, totalFiles: 0, processedFiles: 0, newEntries: 0 };
  }

  /** The journal folders, for log messages. */
  describeDirectories() {
    const directories = this.ingester.journalDirectories;
    if (directories.length === 0) return 'no folders';
    return directories.length === 1 ? `"${directories[0]}"` : `${directories.length} folders (${directories.map((directory) => `"${directory}"`).join(', ')})`;
  }

  /** Reads every journal file that changed since the last run. */
  async scanJournalDirectory() {
    // With no folder yet, nothing is read, and the journals already stored aren't marked missing.
    if (this.ingester.journalDirectories.length === 0) return;
    const listing = await this.ingester.listJournalFiles();
    const journalFiles = listing.files;
    this.ingester.markMissingFiles(listing);
    this.scanProgress = { isScanning: true, totalFiles: journalFiles.length, processedFiles: 0, newEntries: 0 };
    logger.info(`Scanning ${journalFiles.length} journal files in ${this.describeDirectories()}...`);
    this.eventHub.publish('scan', this.scanProgress);

    let lastProgressLogTime = Date.now();
    let changedFileCount = 0;
    for (const file of journalFiles) {
      const processResult = await this.processFileSafely(file, { skipUnparseable: false });
      if (processResult?.hasChanged) changedFileCount += 1;
      if (processResult?.needsRetry) this.scheduleRetry(file);
      this.scanProgress.processedFiles += 1;
      this.scanProgress.newEntries += processResult?.newEntryCount ?? 0;

      if (Date.now() - lastProgressLogTime > PROGRESS_LOG_INTERVAL_MS) {
        lastProgressLogTime = Date.now();
        logger.info(`  ...scanned ${this.scanProgress.processedFiles}/${journalFiles.length} files (${this.scanProgress.newEntries.toLocaleString()} new entries)`);
        this.eventHub.publish('scan', this.scanProgress);
      }
    }

    this.scanProgress.isScanning = false;
    logger.info(`Scan complete: ${changedFileCount} changed files, ${this.scanProgress.newEntries.toLocaleString()} new entries.`);
    this.eventHub.publish('scan', this.scanProgress);

    this.refreshActiveFiles();
    await this.updateStats();

    // Process anything (such as retries) that queued up during the scan.
    this.processQueue();
  }

  /** Starts watching the journal folders for new and changed journal files. */
  start() {
    const journalDirectories = this.ingester.journalDirectories;

    this.watcher = chokidar.watch(journalDirectories, {
      depth: 0,
      ignoreInitial: true,
      ignored: (watchedPath, pathStats) => pathStats?.isFile() === true && !isJournalFileName(path.basename(watchedPath)),
    });
    this.watcher
      .on('add', (filePath) => this.handleFileEvent('added', filePath))
      .on('change', (filePath) => this.handleFileEvent('changed', filePath))
      .on('unlink', (filePath) => this.handleFileRemoved(filePath))
      .on('error', (error) => logger.error('Journal watcher error:', error));

    this.timers.push(setInterval(() => this.pollActiveFiles(), ACTIVE_FILE_POLL_MS));
    this.timers.push(setInterval(() => this.refreshActiveFiles(), ACTIVE_STATUS_REFRESH_MS));
    if (journalDirectories.length > 0) logger.info(`Watching for journal changes in ${this.describeDirectories()}`);
  }

  /** Starts reading journal folders found after starting (the game installed since, say). */
  async addDirectories(directories) {
    const added = this.ingester.addJournalDirectories(directories);
    if (added.length === 0) return added;
    this.watcher?.add(added);
    await this.scanJournalDirectory();
    logger.info(`Watching for journal changes in ${this.describeDirectories()}`);
    return added;
  }

  async stop() {
    for (const timer of this.timers) clearInterval(timer);
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.timers = [];
    await this.watcher?.close();
  }

  /** The journal folder and file name a watched path belongs to, or null if it's not a journal in one of them. */
  toJournalFile(filePath) {
    const fileName = path.basename(filePath);
    if (!isJournalFileName(fileName)) return null;
    const parent = path.resolve(path.dirname(filePath));
    const isSameFolder = (directory) => (process.platform === 'win32' ? directory.toLowerCase() === parent.toLowerCase() : directory === parent);
    const directory = this.ingester.journalDirectories.find(isSameFolder);
    return directory ? { directory, fileName } : null;
  }

  handleFileEvent(changeType, filePath) {
    const file = this.toJournalFile(filePath);
    if (!file) return;
    logger.debug(`Journal file ${changeType}: ${this.ingester.describeFile(file.directory, file.fileName)}`);
    this.queueFile(file);
  }

  handleFileRemoved(filePath) {
    const file = this.toJournalFile(filePath);
    if (!file || !this.ingester.markFileMissing(file.directory, file.fileName)) return;
    logger.info(`Journal file "${this.ingester.describeFile(file.directory, file.fileName)}" was removed from its journal folder; its entries are kept.`);
    this.refreshActiveFiles();
    this.eventHub.publish('journals', { reason: 'files-updated' });
  }

  pollActiveFiles() {
    for (const file of this.ingester.getActiveFiles()) this.queueFile(file);
  }

  /** Queues a file for processing, debouncing rapid successive changes. */
  queueFile(file, delayMs = FILE_CHANGE_DEBOUNCE_MS) {
    const key = fileKey(file.directory, file.fileName);
    clearTimeout(this.debounceTimers.get(key));
    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key);
      this.queuedFiles.set(key, file);
      this.processQueue();
    }, delayMs));
  }

  scheduleRetry(file) {
    const key = fileKey(file.directory, file.fileName);
    const retryCount = (this.retryCounts.get(key) ?? 0) + 1;
    this.retryCounts.set(key, retryCount);
    logger.debug(`Unparseable line in "${this.ingester.describeFile(file.directory, file.fileName)}", retry ${retryCount}/${MAX_UNPARSEABLE_LINE_RETRIES}`);
    this.queueFile(file, UNPARSEABLE_LINE_RETRY_MS);
  }

  async processQueue() {
    if (this.isProcessingQueue || this.scanProgress.isScanning) return;
    this.isProcessingQueue = true;

    try {
      let hasAnyChanges = false;
      while (this.queuedFiles.size > 0) {
        const nextFiles = [...this.queuedFiles.values()].sort((first, second) => compareJournalFileNames(first.fileName, second.fileName));
        this.queuedFiles.clear();

        for (const file of nextFiles) {
          const key = fileKey(file.directory, file.fileName);
          const label = this.ingester.describeFile(file.directory, file.fileName);
          const retryCount = this.retryCounts.get(key) ?? 0;
          const skipUnparseable = retryCount >= MAX_UNPARSEABLE_LINE_RETRIES;
          const processResult = await this.processFileSafely(file, { skipUnparseable });
          if (!processResult) continue;

          if (processResult.needsRetry && !skipUnparseable) {
            this.scheduleRetry(file);
          } else {
            if (skipUnparseable) logger.warn(`Skipped an unparseable line in "${label}" after ${retryCount} retries.`);
            this.retryCounts.delete(key);
          }

          if (processResult.hasChanged) {
            hasAnyChanges = true;
            if (processResult.newEntryCount > 0) logger.debug(`Read ${processResult.newEntryCount} new entries from ${label}`);
          }
        }
      }

      if (hasAnyChanges) {
        this.refreshActiveFiles();
        await this.updateStats();
        this.eventHub.publish('journals', { reason: 'files-updated' });
      }
    } finally {
      this.isProcessingQueue = false;
    }

    // Changes may have queued while stats were updating.
    if (this.queuedFiles.size > 0) this.processQueue();
  }

  async processFileSafely(file, options) {
    try {
      const processResult = await this.ingester.processFile(file.directory, file.fileName, options);
      if (processResult.requiresStatsRebuild) this.needsStatsRebuild = true;
      return processResult;
    } catch (error) {
      logger.error(`Failed to process journal file "${this.ingester.describeFile(file.directory, file.fileName)}":`, error);
      return null;
    }
  }

  async updateStats() {
    if (this.ingester.restoreEntryOrderIfNeeded()) this.needsStatsRebuild = true;
    if (this.needsStatsRebuild) {
      this.needsStatsRebuild = false;
      logger.info('Stored journal entries were replaced or reordered; rebuilding all stats.');
      this.statsEngine.resetAllModules();
    }
    await this.statsEngine.processNewEntries();
  }

  refreshActiveFiles() {
    const { activeFileIds, staleFiles } = this.ingester.refreshActiveFiles();
    for (const file of staleFiles) this.queueFile(file);

    const activeFileIdsSignature = activeFileIds.join(',');
    if (activeFileIdsSignature !== this.activeFileIdsSignature) {
      this.activeFileIdsSignature = activeFileIdsSignature;
      const activeLabels = this.ingester.getActiveFiles().map((file) => this.ingester.describeFile(file.directory, file.fileName));
      logger.debug(`Active journal files: ${activeLabels.join(', ') || 'none'}`);
      this.eventHub.publish('journals', { reason: 'active-files-changed' });
    }
  }
}
