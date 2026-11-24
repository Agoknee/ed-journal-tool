import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ensureInaraAssets } from './assets/inara-assets.mjs';
import { appVersion, parseCommandLineOptions, projectRootPath } from './cli.mjs';
import { TickMonitor } from './bgs-ticks.mjs';
import { ClockMonitor } from './clock-check.mjs';
import { openDatabase } from './database/database.mjs';
import { compactJournalEntries, vacuumIfDue } from './database/entry-compression.mjs';
import { inaraAssetDirectory } from './data-paths.mjs';
import { EventHub } from './events/event-hub.mjs';
import { JournalIngester } from './journals/journal-ingester.mjs';
import { defaultJournalDirectories, describeJournalSearch } from './journals/journal-locations.mjs';
import { JournalMonitor } from './journals/journal-monitor.mjs';
import { StatusMonitor } from './journals/status-monitor.mjs';
import { logger } from './logger.mjs';
import { createServer, serveBuiltClient } from './server/server.mjs';
import { serveClientWithVite } from './server/vite-dev-client.mjs';
import { statModules } from './stats/index.mjs';
import { StatsEngine } from './stats/stats-engine.mjs';

/** How often to look again for a journal folder while there's none. */
const JOURNAL_SEARCH_INTERVAL_MS = 60 * 1000;

/** Starts the journal monitor, stats engine and web server. */
export async function startApp() {
  // Parsed first so --help and --version print only their own output.
  const options = parseCommandLineOptions();
  logger.setDebug(options.debug);
  logger.info(`Starting ED Journal Tool v${appVersion} - CTRL+C to exit...`);

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
    inaraAssetDirectory,
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

  httpServer.on('error', (error) => {
    logger.error(`Web server failed to start: ${error.message}`);
    process.exit(1);
  });
  httpServer.listen(options.port, options.bind, () => {
    const displayHost = options.bind === '0.0.0.0' ? 'localhost' : options.bind;
    logger.info(`Dashboard and API available at http://${displayHost}:${options.port} (bound to ${options.bind})`);
  });

  clockMonitor.start();
  tickMonitor.start();
  // The rank, Powerplay and engineer images: downloaded the first time (and whenever some are
  // missing), in the background so it doesn't hold up reading the journals.
  ensureInaraAssets({ directory: inaraAssetDirectory, log: logger })
    .catch((error) => logger.warn(`Couldn't download the Inara images: ${error.message}`));
  await journalMonitor.scanJournalDirectory();
  // A new database gets its compression dictionary once the first scan has stored enough entries.
  await compactJournalEntries(database);
  journalMonitor.start();
  statusMonitor.start();
  const journalSearchTimer = journalSearch.status
    ? watchForJournalFolders({ options, journalSearch, journalMonitor, statusMonitor, eventHub })
    : null;

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
