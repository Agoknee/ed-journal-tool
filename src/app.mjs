import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ensureInaraAssets } from './assets/inara-assets.mjs';
import { appVersion, parseCommandLineOptions, projectRootPath } from './cli.mjs';
import { TickMonitor } from './bgs-ticks.mjs';
import { ClockMonitor } from './clock-check.mjs';
import { openDatabase } from './database/database.mjs';
import { clearDatabase, keepResetCopy } from './database/database-maintenance.mjs';
import { compactJournalEntries, vacuumIfDue } from './database/entry-compression.mjs';
import { ensureDataDirectory, inaraAssetDirectory } from './data-paths.mjs';
import { EventHub } from './events/event-hub.mjs';
import { JournalIngester } from './journals/journal-ingester.mjs';
import { SettingsStore } from './settings/settings-store.mjs';
import { defaultJournalDirectories, describeJournalSearch } from './journals/journal-locations.mjs';
import { JournalMonitor } from './journals/journal-monitor.mjs';
import { StatusMonitor } from './journals/status-monitor.mjs';
import { logger } from './logger.mjs';
import { createServer, serveBuiltClient } from './server/server.mjs';
import { serveClientWithVite } from './server/vite-dev-client.mjs';
import { statModules } from './stats/index.mjs';
import { StatsEngine } from './stats/stats-engine.mjs';
import { isBackgroundChild, launchInBackground, backgroundLogPath, openInBrowser, reportBackgroundReady } from './windows/background.mjs';
import { startTrayIcon } from './windows/tray.mjs';

const APP_NAME = 'ED Journal Tool';
/** How often to look again for a journal folder while there's none. */
const JOURNAL_SEARCH_INTERVAL_MS = 60 * 1000;

/** Starts the journal monitor, stats engine and web server. */
export async function startApp() {
  // Parsed first so --help and --version print only their own output.
  const options = parseCommandLineOptions();
  logger.setDebug(options.debug);
  // On a new system the data folder isn't there yet; the log, tray program, images and (by default)
  // the database all go in it.
  ensureDataDirectory();
  const dashboardUrl = `http://${options.bind === '0.0.0.0' ? 'localhost' : options.bind}:${options.port}`;

  // On Windows there's a tray icon (--no-tray turns it off), and the executable runs in the
  // background (no console window) unless started with --console; see windows/background.mjs.
  // Run with node (npm start) it stays in its console.
  const isPackaged = Boolean(process.pkg);
  const showsTray = process.platform === 'win32' && (options.tray ?? true);
  const isInBackground = isBackgroundChild();
  if (showsTray && isPackaged && !options.console && !isInBackground) {
    await launchInBackground({ port: options.port, bind: options.bind, dashboardUrl, appName: APP_NAME });
    return;
  }
  logger.info(`Starting ${APP_NAME} v${appVersion} - ${isInBackground ? 'quit it from its tray icon' : 'CTRL+C to exit'}...`);

  // A journal folder that isn't there (a synced folder not available yet, say) is warned about and
  // its journals left as they were. With none there at all, the app starts anyway (the dashboard
  // says so, and shows the journals already read) and keeps looking; see watchForJournalFolders.
  const missingDirectories = options.journaldir.filter((directory) => !existsSync(directory));
  const journalSearch = { status: null };
  let initialDirectories = options.journaldir;
  if (missingDirectories.length === options.journaldir.length) {
    initialDirectories = [];
    journalSearch.status = options.isJournalDirAutomatic
      ? { isWaiting: true, isAutomatic: true, lookedIn: describeJournalSearch() }
      : { isWaiting: true, isAutomatic: false, lookedIn: options.journaldir.map((directory) => `"${directory}"`).join(', ') };
    logger.warn(options.isJournalDirAutomatic
      ? `No Elite Dangerous journal folder found (looked in ${journalSearch.status.lookedIn}). It's looked for again every minute; if the game keeps its journals somewhere else, start with --journaldir to set the folder.`
      : `Journal ${options.journaldir.length === 1 ? 'folder' : 'folders'} not found: ${journalSearch.status.lookedIn}. They'll be read once they're there.`);
  } else {
    for (const directory of missingDirectories) logger.warn(`Journal directory not found: "${directory}"; it will be read once it's there.`);
  }

  const databasePath = path.resolve(options.database);
  logger.debug(`Opening database "${databasePath}"`);
  const database = openDatabase(databasePath);
  await compactJournalEntries(database);
  vacuumIfDue(database);

  const eventHub = new EventHub();
  const statsEngine = new StatsEngine({ database, statModules, eventHub });
  statsEngine.initialize();
  if (options.rebuildStats) {
    logger.info('Clearing all stats; they will be rebuilt from stored journal entries.');
    statsEngine.resetAllModules();
  }

  const ingester = new JournalIngester({ database, journalDirectories: initialDirectories });
  const journalMonitor = new JournalMonitor({ ingester, statsEngine, eventHub });
  const clockMonitor = new ClockMonitor({ eventHub });
  const tickMonitor = new TickMonitor({ database, eventHub });
  const statusMonitor = new StatusMonitor({ database, journalDirectories: ingester.journalDirectories, eventHub });

  const compression = createCompressionProgress(eventHub);
  const settings = new SettingsStore();
  const databaseReset = createDatabaseReset({ database, databasePath, statsEngine, journalMonitor, statusMonitor, eventHub, compression });

  const app = createServer({
    database,
    databasePath,
    statsEngine,
    journalMonitor,
    clockMonitor,
    statusMonitor,
    eventHub,
    journalDirectories: ingester.journalDirectories,
    journalSearch,
    compression,
    inaraAssetDirectory,
    settings,
    databaseReset,
  });

  const httpServer = http.createServer(app);
  const clientRootPath = path.join(projectRootPath, 'client');
  let viteServer = null;
  if (options.devClient) {
    try {
      viteServer = await serveClientWithVite(app, { clientRootPath, httpServer });
    } catch (error) {
      logger.error(`Could not start the Vite dev client: ${error.message}`);
      process.exit(1);
    }
  } else {
    serveBuiltClient(app, path.join(clientRootPath, 'dist'));
  }

  let journalSearchTimer = null;
  let isShuttingDown = false;
  async function shutDown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info('Shutting down...');
    clearInterval(journalSearchTimer);
    await journalMonitor.stop();
    clockMonitor.stop();
    tickMonitor.stop();
    statusMonitor.stop();
    await viteServer?.close();
    httpServer.closeAllConnections();
    httpServer.close();
    database.close();
    process.exit(0);
  }
  process.on('SIGINT', shutDown);
  process.on('SIGTERM', shutDown);

  httpServer.on('error', (error) => {
    logger.error(`Web server failed to start: ${error.message}`);
    process.exit(1);
  });
  httpServer.listen(options.port, options.bind, () => {
    logger.info(`Dashboard and API available at ${dashboardUrl} (bound to ${options.bind})`);
    if (options.bind !== '127.0.0.1' && options.bind !== 'localhost') {
      logger.info(settings.getInternal('passwordHash')
        ? 'Other devices log in with the password set in Settings.'
        : `Other devices can't use the dashboard until a password is set in Settings (at ${dashboardUrl}, on this computer).`);
    }
    reportBackgroundReady();
    if (showsTray) {
      startTrayIcon({
        title: APP_NAME,
        dashboardUrl,
        logPath: isInBackground ? backgroundLogPath : (options.logFile ? path.resolve(options.logFile) : null),
        iconPath: path.join(projectRootPath, 'packaging', 'edjt.ico'),
        notification: isInBackground ? `Running in the background. The dashboard is at ${dashboardUrl}.` : null,
        onQuit: shutDown,
        // Without its icon, a background copy would be out of sight: show the dashboard instead.
        onFailure: () => { if (isInBackground && !isShuttingDown) openInBrowser(dashboardUrl); },
      }).catch((error) => logger.warn(`Couldn't show the tray icon: ${error.message}`));
    }
  });

  clockMonitor.start();
  tickMonitor.start();
  // The rank, Powerplay and engineer images: downloaded the first time (and whenever some are
  // missing), in the background so it doesn't hold up reading the journals.
  if (options.downloadImages) {
    ensureInaraAssets({ directory: inaraAssetDirectory, log: logger })
      .catch((error) => logger.warn(`Couldn't download the Inara images: ${error.message}`));
  }
  await journalMonitor.scanJournalDirectory();
  // A new database gets its compression dictionary once the first scan has stored enough entries;
  // then all of them are compressed, which the dashboard shows.
  try {
    await compactJournalEntries(database, { onProgress: compression.onProgress });
  } finally {
    compression.finish();
  }
  journalMonitor.start();
  statusMonitor.start();
  databaseReset.markStarted();
  if (journalSearch.status) {
    journalSearchTimer = watchForJournalFolders({ options, journalSearch, journalMonitor, statusMonitor, eventHub });
  }
}

/**
 * Progress of compressing stored journal entries, for the dashboard: in `status` (for
 * /api/status), and sent as "compression" updates at most every second. Only once entries are
 * actually being compressed; checking entries that need nothing isn't shown.
 * @param {EventHub} eventHub
 */
function createCompressionProgress(eventHub) {
  const idle = { isCompressing: false, checkedCount: 0, totalCount: 0, percent: 100 };
  let lastPublishTime = 0;
  const progress = {
    status: idle,
    onProgress({ checkedCount, totalCount, compressedCount }) {
      if (compressedCount === 0) return;
      const isFirst = !progress.status.isCompressing;
      progress.status = { isCompressing: true, checkedCount, totalCount, percent: Math.min(99, Math.floor((100 * checkedCount) / totalCount)) };
      if (isFirst || Date.now() - lastPublishTime >= 1000) {
        lastPublishTime = Date.now();
        eventHub.publish('compression', progress.status);
      }
    },
    finish() {
      if (!progress.status.isCompressing) return;
      progress.status = idle;
      eventHub.publish('compression', idle);
    },
  };
  return progress;
}

/**
 * Resetting the database from the Settings page: everything in it is deleted, then the journals
 * still in the journal folders are read again from scratch, as on a new system.
 *
 * Done in place, with the app running: what reads or writes the database is paused first (the
 * journal watcher finishing any file it's reading, the stats engine any update), the tables are
 * emptied and the file shrunk (clearDatabase), what's remembered about the old data is forgotten
 * (the stat modules' processors, Status.json's commanders, the compression dictionaries), and the
 * journals are scanned again. Refused while the app is busy (starting, scanning, building stats,
 * compressing, or already resetting).
 */
function createDatabaseReset({ database, databasePath, statsEngine, journalMonitor, statusMonitor, eventHub, compression }) {
  let hasStarted = false;
  let isResetting = false;

  /** Why a reset can't be done now, or null. */
  function busyReason() {
    if (isResetting) return 'The database is being reset.';
    if (!hasStarted || journalMonitor.scanProgress.isScanning) return 'Journals are being scanned. Try again once that’s finished.';
    if (statsEngine.buildProgress.isBuilding) return 'Stats are being built. Try again once that’s finished.';
    if (compression.status.isCompressing) return 'Journal entries are being compressed. Try again once that’s finished.';
    return null;
  }

  /**
   * Empties the database (after keeping a copy of it, if asked), then reads the journals again in
   * the background. Resolves once it's empty, with the copy kept. If the copy can't be made,
   * nothing is deleted.
   * @param {{ keepCopy?: boolean }} [options]
   * @returns {Promise<{ copy: { path: string, bytes: number } | null }>}
   */
  async function reset({ keepCopy = false } = {}) {
    const reason = busyReason();
    if (reason) throw Object.assign(new Error(reason), { status: 409 });
    isResetting = true;
    let copy = null;
    try {
      logger.warn('Resetting the database (from the Settings page)...');
      statusMonitor.stop();
      await journalMonitor.pauseForReset();
      await statsEngine.runningUpdate;
      if (keepCopy) {
        try {
          copy = keepResetCopy(database, databasePath);
          logger.info(`Kept a copy of the database: "${copy.path}".`);
        } catch (error) {
          logger.warn(`Couldn't keep a copy of the database, so it wasn't reset: ${error.message}`);
          // Carries on as before (nothing was deleted), catching up on journal changes made while paused.
          journalMonitor.resumeAfterReset();
          journalMonitor.scanJournalDirectory()
            .catch((scanError) => logger.error('Reading the journals after the cancelled reset failed:', scanError))
            .finally(() => {
              journalMonitor.start();
              statusMonitor.start();
            });
          throw error;
        }
      }
      logger.warn('Deleting everything in the database...');
      clearDatabase(database);
      statsEngine.initialize();
      statusMonitor.forgetCommanders();
      logger.info('The database is empty; reading the journals again.');
      eventHub.publish('journals', { reason: 'database-reset' });
      eventHub.publish('stats', { modules: statsEngine.statModules.map((statModule) => statModule.name) });
    } catch (error) {
      isResetting = false;
      throw error;
    }

    // Reading everything again takes minutes; the dashboard shows the scan and the rest.
    (async () => {
      try {
        journalMonitor.resumeAfterReset();
        await journalMonitor.scanJournalDirectory();
        try {
          await compactJournalEntries(database, { onProgress: compression.onProgress });
        } finally {
          compression.finish();
        }
      } catch (error) {
        logger.error('Reading the journals again after the reset failed:', error);
      } finally {
        journalMonitor.start();
        statusMonitor.start();
        isResetting = false;
        eventHub.publish('journals', { reason: 'database-reset-done' });
      }
    })();
    return { copy };
  }

  return { busyReason, reset, markStarted: () => { hasStarted = true; } };
}

/**
 * While there's no journal folder, looks again every minute: for the given folders to appear, or
 * (with no --journaldir) searches the usual places again, so installing or first running the game
 * after starting the app needs no restart. Once one is there it's read, and the search stops.
 */
function watchForJournalFolders({ options, journalSearch, journalMonitor, statusMonitor, eventHub }) {
  let isChecking = false;
  const timer = setInterval(async () => {
    if (isChecking) return;
    isChecking = true;
    try {
      const directories = options.isJournalDirAutomatic
        ? defaultJournalDirectories()
        : options.journaldir.filter((directory) => existsSync(directory));
      if (directories.length === 0) return;
      clearInterval(timer);
      // Every given folder is watched once one of them is there, as when they're there at startup.
      const toRead = options.isJournalDirAutomatic ? directories : options.journaldir;
      logger.info(`Found the journal ${directories.length === 1 ? 'folder' : 'folders'}: ${directories.map((directory) => `"${directory}"`).join(', ')}`);
      journalSearch.status = null;
      statusMonitor.addJournalDirectories(toRead);
      await journalMonitor.addDirectories(toRead);
      eventHub.publish('journals', { reason: 'folders-found' });
    } catch (error) {
      logger.error('Reading the journal folder found failed:', error);
    } finally {
      isChecking = false;
    }
  }, JOURNAL_SEARCH_INTERVAL_MS);
  return timer;
}
