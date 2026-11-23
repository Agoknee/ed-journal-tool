import path from 'node:path';
import chokidar from 'chokidar';
import { logger } from '../logger.mjs';
import { compareJournalFileNames, isJournalFileName } from './journal-files.mjs';

const FILE_CHANGE_DEBOUNCE_MS = 250;
const UNPARSEABLE_LINE_RETRY_MS = 1000;
const MAX_UNPARSEABLE_LINE_RETRIES = 5;
/** Windows may delay change notifications for files held open by the game, so active files are also polled. */
const ACTIVE_FILE_POLL_MS = 2000;
const ACTIVE_STATUS_REFRESH_MS = 30 * 1000;
const PROGRESS_LOG_INTERVAL_MS = 5000;

/**
 * Coordinates scanning and watching the journal directory, feeding changes to the ingester
 * and triggering stats updates.
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

    this.queuedFileNames = new Set();
    this.debounceTimers = new Map();
    this.retryCounts = new Map();
    this.isProcessingQueue = false;
    this.needsStatsRebuild = false;
    this.activeFileIdsSignature = '';
    this.timers = [];
    this.watcher = null;

    this.scanProgress = { isScanning: false, totalFiles: 0, processedFiles: 0, newEntries: 0 };
  }

  /** Reads every journal file that changed since the last run. */
  async scanJournalDirectory() {
    const journalFileNames = await this.ingester.listJournalFileNames();
    this.ingester.markMissingFiles(journalFileNames);
    this.scanProgress = { isScanning: true, totalFiles: journalFileNames.length, processedFiles: 0, newEntries: 0 };
    logger.info(`Scanning ${journalFileNames.length} journal files in "${this.ingester.journalDirectory}"...`);
    this.eventHub.publish('scan', this.scanProgress);

    let lastProgressLogTime = Date.now();
    let changedFileCount = 0;
    for (const fileName of journalFileNames) {
      const processResult = await this.processFileSafely(fileName, { skipUnparseable: false });
      if (processResult?.hasChanged) changedFileCount += 1;
      if (processResult?.needsRetry) this.scheduleRetry(fileName);
      this.scanProgress.processedFiles += 1;
      this.scanProgress.newEntries += processResult?.newEntryCount ?? 0;

      if (Date.now() - lastProgressLogTime > PROGRESS_LOG_INTERVAL_MS) {
        lastProgressLogTime = Date.now();
        logger.info(`  ...scanned ${this.scanProgress.processedFiles}/${journalFileNames.length} files (${this.scanProgress.newEntries.toLocaleString()} new entries)`);
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

  /** Starts watching the journal directory for new and changed journal files. */
  start() {
    const journalDirectory = this.ingester.journalDirectory;

    this.watcher = chokidar.watch(journalDirectory, {
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
    logger.info(`Watching for journal changes in "${journalDirectory}"`);
  }

  async stop() {
    for (const timer of this.timers) clearInterval(timer);
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.timers = [];
    await this.watcher?.close();
  }

  handleFileEvent(changeType, filePath) {
    const fileName = path.basename(filePath);
    if (!isJournalFileName(fileName)) return;
    logger.debug(`Journal file ${changeType}: ${fileName}`);
    this.queueFile(fileName);
  }

  handleFileRemoved(filePath) {
    const fileName = path.basename(filePath);
    if (!isJournalFileName(fileName) || !this.ingester.markFileMissing(fileName)) return;
    logger.info(`Journal file "${fileName}" was removed from the journal folder; its entries are kept.`);
    this.refreshActiveFiles();
    this.eventHub.publish('journals', { reason: 'files-updated' });
  }

  pollActiveFiles() {
    for (const fileName of this.ingester.getActiveFileNames()) this.queueFile(fileName);
  }

  /** Queues a file for processing, debouncing rapid successive changes. */
  queueFile(fileName, delayMs = FILE_CHANGE_DEBOUNCE_MS) {
    clearTimeout(this.debounceTimers.get(fileName));
    this.debounceTimers.set(fileName, setTimeout(() => {
      this.debounceTimers.delete(fileName);
      this.queuedFileNames.add(fileName);
      this.processQueue();
    }, delayMs));
  }

  scheduleRetry(fileName) {
    const retryCount = (this.retryCounts.get(fileName) ?? 0) + 1;
    this.retryCounts.set(fileName, retryCount);
    logger.debug(`Unparseable line in "${fileName}", retry ${retryCount}/${MAX_UNPARSEABLE_LINE_RETRIES}`);
    this.queueFile(fileName, UNPARSEABLE_LINE_RETRY_MS);
  }

  async processQueue() {
    if (this.isProcessingQueue || this.scanProgress.isScanning) return;
    this.isProcessingQueue = true;

    try {
      let hasAnyChanges = false;
      while (this.queuedFileNames.size > 0) {
        const nextFileNames = [...this.queuedFileNames].sort(compareJournalFileNames);
        this.queuedFileNames.clear();

        for (const fileName of nextFileNames) {
          const retryCount = this.retryCounts.get(fileName) ?? 0;
          const skipUnparseable = retryCount >= MAX_UNPARSEABLE_LINE_RETRIES;
          const processResult = await this.processFileSafely(fileName, { skipUnparseable });
          if (!processResult) continue;

          if (processResult.needsRetry && !skipUnparseable) {
            this.scheduleRetry(fileName);
          } else {
            if (skipUnparseable) logger.warn(`Skipped an unparseable line in "${fileName}" after ${retryCount} retries.`);
            this.retryCounts.delete(fileName);
          }

          if (processResult.hasChanged) {
            hasAnyChanges = true;
            if (processResult.newEntryCount > 0) logger.debug(`Read ${processResult.newEntryCount} new entries from ${fileName}`);
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
    if (this.queuedFileNames.size > 0) this.processQueue();
  }

  async processFileSafely(fileName, options) {
    try {
      const processResult = await this.ingester.processFile(fileName, options);
      if (processResult.requiresStatsRebuild) this.needsStatsRebuild = true;
      return processResult;
    } catch (error) {
      logger.error(`Failed to process journal file "${fileName}":`, error);
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
    const { activeFileIds, staleFileNames } = this.ingester.refreshActiveFiles();
    for (const fileName of staleFileNames) this.queueFile(fileName);

    const activeFileIdsSignature = activeFileIds.join(',');
    if (activeFileIdsSignature !== this.activeFileIdsSignature) {
      this.activeFileIdsSignature = activeFileIdsSignature;
      logger.debug(`Active journal files: ${this.ingester.getActiveFileNames().join(', ') || 'none'}`);
      this.eventHub.publish('journals', { reason: 'active-files-changed' });
    }
  }
}
